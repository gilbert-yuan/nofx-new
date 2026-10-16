//! CPU LightGBM training and prediction through the official C API.
//!
//! The DLL can come from the official Python wheel, but no Python process is
//! involved in training or prediction. Labels and probability columns are
//! always `SELL = 0`, `HOLD = 1`, `BUY = 2`. This module cannot place orders.
//! ABI reference: https://github.com/microsoft/LightGBM/blob/v4.6.0/include/LightGBM/c_api.h

use anyhow::{Context, Result, bail, ensure};
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    cell::Cell,
    ffi::{CStr, CString, c_char, c_int, c_void},
    marker::PhantomData,
    mem::ManuallyDrop,
    path::Path,
    ptr,
    sync::Arc,
    time::Instant,
};

pub const DEFAULT_RUNTIME_PATH: &str =
    "data/ml/runtime/Lib/site-packages/lightgbm/bin/lib_lightgbm.dll";
pub const SELL: usize = 0;
pub const HOLD: usize = 1;
pub const BUY: usize = 2;
pub const NUM_CLASSES: usize = 3;
pub const MIN_TRAIN_ROWS: usize = 90;
pub const TRAIN_ITERATIONS: usize = 100;
pub const TRAIN_PARAMETERS: &str = "boosting=gbdt device_type=cpu objective=multiclass num_class=3 metric=multi_logloss deterministic=true force_col_wise=true num_threads=4 num_leaves=15 min_data_in_leaf=30 lambda_l2=5 learning_rate=0.05 max_depth=5 seed=42 feature_fraction_seed=42 bagging_seed=42 data_random_seed=42 feature_fraction=1 bagging_fraction=1 bagging_freq=0 verbosity=-1";
const FLOAT32: c_int = 0;
const FLOAT64: c_int = 1;
const PREDICT_NORMAL: c_int = 0;
const MAX_MODEL_TEXT_BYTES: usize = 64 * 1024 * 1024;
type Handle = *mut c_void;
type GetLastError = unsafe extern "C" fn() -> *const c_char;
type DatasetCreate = unsafe extern "C" fn(
    *const c_void,
    c_int,
    i32,
    i32,
    c_int,
    *const c_char,
    Handle,
    *mut Handle,
) -> c_int;
type DatasetSetField =
    unsafe extern "C" fn(Handle, *const c_char, *const c_void, c_int, c_int) -> c_int;
type Free = unsafe extern "C" fn(Handle) -> c_int;
type BoosterCreate = unsafe extern "C" fn(Handle, *const c_char, *mut Handle) -> c_int;
type BoosterLoad = unsafe extern "C" fn(*const c_char, *mut c_int, *mut Handle) -> c_int;
type BoosterInt = unsafe extern "C" fn(Handle, *mut c_int) -> c_int;
type BoosterPredict = unsafe extern "C" fn(
    Handle,
    *const c_void,
    c_int,
    i32,
    i32,
    c_int,
    c_int,
    c_int,
    c_int,
    *const c_char,
    *mut i64,
    *mut f64,
) -> c_int;
type BoosterSave =
    unsafe extern "C" fn(Handle, c_int, c_int, c_int, i64, *mut i64, *mut c_char) -> c_int;

/// Loaded CPU C API. Share the runtime across models to keep the DLL alive.
/// Its native library stays resident until process exit: the Windows wheel's
/// OpenMP/CRT thread cleanup can outlive the last Dataset or Booster handle.
/// Explicit DLL unloading after a completed evaluation caused a shutdown access
/// violation on this host (Windows Event 1000: `VCOMP140.DLL_unloaded`). This
/// intentional process-lifetime library reference
/// avoids callbacks into unloaded code; datasets and boosters still use RAII.
pub struct LightGbmRuntime {
    // Do not call FreeLibrary/dlclose when the final Rust runtime owner drops.
    // The OS releases the module when the process terminates. Microsoft explains
    // the thread/FLS callback hazard of premature native-library unloading here:
    // https://learn.microsoft.com/en-us/troubleshoot/developer/visualstudio/cpp/libraries/fatal-error-thread-exit-fls-callback
    _library: ManuallyDrop<Library>,
    last_error: GetLastError,
    dataset_create: DatasetCreate,
    dataset_set_field: DatasetSetField,
    dataset_free: Free,
    booster_create: BoosterCreate,
    booster_load: BoosterLoad,
    booster_update: BoosterInt,
    booster_classes: BoosterInt,
    booster_features: BoosterInt,
    booster_iteration: BoosterInt,
    booster_predict: BoosterPredict,
    booster_save: BoosterSave,
    booster_free: Free,
}

impl LightGbmRuntime {
    /// Load the installed native library; does not import Python or download it.
    pub fn load(path: &Path) -> Result<Arc<Self>> {
        ensure!(
            path.is_file(),
            "LightGBM runtime missing: {}",
            path.display()
        );
        // SAFETY: this caller-selected native runtime is trusted code. Symbol
        // signatures below match the official stable LightGBM C API.
        let library = ManuallyDrop::new(
            unsafe { Library::new(path) }
                .with_context(|| format!("Load LightGBM CPU runtime {}", path.display()))?,
        );
        unsafe {
            let api = Self {
                last_error: *library.get(b"LGBM_GetLastError\0")?,
                dataset_create: *library.get(b"LGBM_DatasetCreateFromMat\0")?,
                dataset_set_field: *library.get(b"LGBM_DatasetSetField\0")?,
                dataset_free: *library.get(b"LGBM_DatasetFree\0")?,
                booster_create: *library.get(b"LGBM_BoosterCreate\0")?,
                booster_load: *library.get(b"LGBM_BoosterLoadModelFromString\0")?,
                booster_update: *library.get(b"LGBM_BoosterUpdateOneIter\0")?,
                booster_classes: *library.get(b"LGBM_BoosterGetNumClasses\0")?,
                booster_features: *library.get(b"LGBM_BoosterGetNumFeature\0")?,
                booster_iteration: *library.get(b"LGBM_BoosterGetCurrentIteration\0")?,
                booster_predict: *library.get(b"LGBM_BoosterPredictForMat\0")?,
                booster_save: *library.get(b"LGBM_BoosterSaveModelToString\0")?,
                booster_free: *library.get(b"LGBM_BoosterFree\0")?,
                _library: library,
            };
            Ok(Arc::new(api))
        }
    }

    fn check(&self, status: c_int, operation: &str) -> Result<()> {
        if status == 0 {
            return Ok(());
        }
        // LightGBM owns this null-terminated thread-local error message.
        let error = unsafe { (self.last_error)() };
        let message = if error.is_null() {
            "unspecified native error".to_owned()
        } else {
            unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned()
        };
        bail!("LightGBM {operation}: {message}")
    }
}

struct Dataset {
    handle: Handle,
    runtime: Arc<LightGbmRuntime>,
}

impl Drop for Dataset {
    fn drop(&mut self) {
        // SAFETY: this owns one live handle; its runtime is still loaded.
        unsafe { (self.runtime.dataset_free)(self.handle) };
    }
}

/// Training metadata, also persisted alongside the model by callers.
/// A model loaded from text has `train_rows = 0` and `class_counts = [0; 3]`;
/// the original dataset statistics cannot be recovered from tree text alone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingSummary {
    pub train_rows: usize,
    pub feature_count: usize,
    pub class_counts: [usize; NUM_CLASSES],
    pub requested_iterations: usize,
    pub iterations: usize,
    pub training_ms: f64,
    pub parameters: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationCheckpoint {
    pub iteration: usize,
    pub log_loss: f64,
    pub improved: bool,
}

/// Validation-only model selection metadata, separate from the stable training
/// summary. Direct model-text loads do not reconstruct this training history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EarlyStoppingSummary {
    pub validation_rows: usize,
    pub patience_rounds: usize,
    pub check_every: usize,
    pub rounds_executed: usize,
    pub trained_iterations: usize,
    pub best_iteration: usize,
    pub best_validation_log_loss: f64,
    pub stopped_early: bool,
    pub patience_exhausted: bool,
    pub stop_reason: String,
    pub validation_checkpoints: Vec<ValidationCheckpoint>,
}

#[derive(Clone, Copy)]
struct ValidationInputs<'a> {
    features: &'a [Vec<f64>],
    labels: &'a [usize],
    patience_rounds: usize,
    check_every: usize,
}

struct EarlyStoppingState {
    best_iteration: usize,
    best_loss: f64,
    checkpoints: Vec<ValidationCheckpoint>,
}
impl EarlyStoppingState {
    fn new() -> Self {
        Self {
            best_iteration: 0,
            best_loss: f64::INFINITY,
            checkpoints: Vec::new(),
        }
    }

    fn record(&mut self, iteration: usize, loss: f64) -> Result<bool> {
        ensure!(
            loss.is_finite() && loss >= 0.,
            "Invalid validation log loss"
        );
        let improved = loss < self.best_loss;
        if improved {
            self.best_iteration = iteration;
            self.best_loss = loss;
        }
        self.checkpoints.push(ValidationCheckpoint {
            iteration,
            log_loss: loss,
            improved,
        });
        Ok(improved)
    }

    fn patience_exhausted(&self, iteration: usize, patience: usize) -> bool {
        !self.checkpoints.is_empty() && iteration.saturating_sub(self.best_iteration) >= patience
    }
}

/// One owned multiclass CPU model. Keep external access behind a Mutex when
/// serving requests; prediction requires mutable access and is never parallel
/// on the same handle. Distinct independently owned models may train in parallel.
pub struct LightGbmModel {
    handle: Handle,
    runtime: Arc<LightGbmRuntime>,
    // Training datasets must outlive their booster, including save/predict.
    _dataset: Option<Dataset>,
    summary: TrainingSummary,
    early_stopping: Option<EarlyStoppingSummary>,
    _not_sync: PhantomData<Cell<()>>,
}

// SAFETY: ownership of a handle and its dataset moves together. LightGBM C API
// handles are not thread-affine. The !Sync marker and &mut prediction prevent
// simultaneous access to this booster; no borrowed native pointer is exposed.
unsafe impl Send for LightGbmModel {}

impl Drop for LightGbmModel {
    fn drop(&mut self) {
        // Drop runs before fields: free booster first, dataset second, runtime last.
        unsafe { (self.runtime.booster_free)(self.handle) };
    }
}

impl LightGbmModel {
    /// Train fixed deterministic 100-iteration multiclass GBDT on CPU (4 threads).
    /// `features[row][column]` must be rectangular and finite; labels 0..=2.
    /// Requires 90 rows. The caller controls per-class adequacy and chronological
    /// embargoes; this low-level module does not perform splitting or tune models.
    pub fn train(
        runtime: Arc<LightGbmRuntime>,
        features: &[Vec<f64>],
        labels: &[usize],
    ) -> Result<Self> {
        Self::train_config(
            runtime,
            features,
            labels,
            TRAIN_PARAMETERS,
            TRAIN_ITERATIONS,
        )
    }

    /// Train a CPU candidate using parameters chosen on an earlier validation
    /// period. Splitting, embargoes and candidate selection remain the caller's job.
    pub fn train_config(
        runtime: Arc<LightGbmRuntime>,
        features: &[Vec<f64>],
        labels: &[usize],
        parameters: &str,
        iterations: usize,
    ) -> Result<Self> {
        Self::train_impl(runtime, features, labels, parameters, iterations, None)
    }

    /// Select boosting iterations using only the caller-supplied independent
    /// validation slice. The caller must purge all label horizons beforehand;
    /// calibration, confirmation and holdout rows must never be passed here.
    /// Patience counts native boosting rounds, not validation checkpoints.
    #[allow(clippy::too_many_arguments)]
    pub fn train_config_with_validation(
        runtime: Arc<LightGbmRuntime>,
        features: &[Vec<f64>],
        labels: &[usize],
        parameters: &str,
        max_iterations: usize,
        validation_features: &[Vec<f64>],
        validation_labels: &[usize],
        patience_rounds: usize,
        check_every: usize,
    ) -> Result<Self> {
        Self::train_impl(
            runtime,
            features,
            labels,
            parameters,
            max_iterations,
            Some(ValidationInputs {
                features: validation_features,
                labels: validation_labels,
                patience_rounds,
                check_every,
            }),
        )
    }

    fn train_impl(
        runtime: Arc<LightGbmRuntime>,
        features: &[Vec<f64>],
        labels: &[usize],
        parameters: &str,
        iterations: usize,
        validation: Option<ValidationInputs<'_>>,
    ) -> Result<Self> {
        validate_training_config(parameters, iterations)?;
        let (rows, cols, values, class_counts) = prepare_training(features, labels)?;
        if let Some(validation) = validation {
            validate_validation_inputs(validation, cols)?;
        }
        let native_parameters = CString::new(parameters)?;
        let started = Instant::now();
        let mut dataset_handle = ptr::null_mut();
        // SAFETY: contiguous row-major float64 matrix remains alive throughout
        // this synchronous call; sizes were checked against i32 and its buffer.
        runtime.check(
            unsafe {
                (runtime.dataset_create)(
                    values.as_ptr().cast(),
                    FLOAT64,
                    rows as i32,
                    cols as i32,
                    1,
                    native_parameters.as_ptr(),
                    ptr::null_mut(),
                    &mut dataset_handle,
                )
            },
            "create training dataset",
        )?;
        ensure!(
            !dataset_handle.is_null(),
            "LightGBM returned a null dataset"
        );
        let dataset = Dataset {
            handle: dataset_handle,
            runtime: runtime.clone(),
        };
        // Per C API, label fields specifically require float32, not float64.
        let native_labels: Vec<f32> = labels.iter().map(|label| *label as f32).collect();
        let label_field = CString::new("label")?;
        runtime.check(
            unsafe {
                (runtime.dataset_set_field)(
                    dataset.handle,
                    label_field.as_ptr(),
                    native_labels.as_ptr().cast(),
                    rows as c_int,
                    FLOAT32,
                )
            },
            "set training labels",
        )?;
        let mut handle = ptr::null_mut();
        runtime.check(
            unsafe {
                (runtime.booster_create)(dataset.handle, native_parameters.as_ptr(), &mut handle)
            },
            "create booster",
        )?;
        ensure!(!handle.is_null(), "LightGBM returned a null booster");
        let mut model = Self {
            handle,
            runtime,
            _dataset: Some(dataset),
            summary: TrainingSummary {
                train_rows: rows,
                feature_count: cols,
                class_counts,
                requested_iterations: iterations,
                iterations: 0,
                training_ms: 0.0,
                parameters: parameters.to_owned(),
            },
            early_stopping: None,
            _not_sync: PhantomData,
        };
        let mut stopping = validation.map(|_| EarlyStoppingState::new());
        let mut best_text = None;
        let mut rounds_executed = 0;
        let mut stop_reason = "maximum_iterations";
        for round in 1..=iterations {
            let mut finished = 0;
            model.runtime.check(
                unsafe { (model.runtime.booster_update)(model.handle, &mut finished) },
                "update boosting iteration",
            )?;
            rounds_executed = round;
            if let Some(validation) = validation
                && (round % validation.check_every == 0 || round == iterations || finished != 0)
            {
                let (_, native_iteration) = model.native_dimensions()?;
                let loss =
                    multiclass_log_loss(&model.predict(validation.features)?, validation.labels)?;
                let state = stopping.as_mut().expect("Validation stopping state exists");
                if state.record(native_iteration, loss)? {
                    best_text = Some(model.model_text()?);
                }
                if finished == 0
                    && round < iterations
                    && state.patience_exhausted(native_iteration, validation.patience_rounds)
                {
                    stop_reason = "validation_patience";
                    break;
                }
            }
            // Native LightGBM may stop when no further split is possible.
            if finished != 0 {
                stop_reason = "native_finished";
                break;
            }
        }
        let (native_features, iterations) = model.native_dimensions()?;
        ensure!(
            native_features == cols,
            "LightGBM trained feature count mismatch"
        );
        model.summary.iterations = iterations;
        model.summary.training_ms = started.elapsed().as_secs_f64() * 1000.0;
        if let (Some(validation), Some(state)) = (validation, stopping) {
            let text = best_text.context("No validation checkpoint produced a best model")?;
            let mut summary = model.summary.clone();
            let runtime = model.runtime.clone();
            // Release the training booster/dataset before loading the snapshot.
            // The returned model owns only the best trees, not the later rounds.
            drop(model);
            let mut restored = Self::load(runtime, &text)?;
            ensure!(
                restored.summary.feature_count == cols
                    && restored.summary.iterations == state.best_iteration,
                "Best validation snapshot dimensions changed during restoration"
            );
            summary.iterations = state.best_iteration;
            summary.training_ms = started.elapsed().as_secs_f64() * 1000.0;
            let requested_iterations = summary.requested_iterations;
            restored.summary = summary;
            restored.early_stopping = Some(EarlyStoppingSummary {
                validation_rows: validation.features.len(),
                patience_rounds: validation.patience_rounds,
                check_every: validation.check_every,
                rounds_executed,
                trained_iterations: iterations,
                best_iteration: state.best_iteration,
                best_validation_log_loss: state.best_loss,
                stopped_early: rounds_executed < requested_iterations,
                patience_exhausted: stop_reason == "validation_patience",
                stop_reason: stop_reason.to_owned(),
                validation_checkpoints: state.checkpoints,
            });
            return Ok(restored);
        }
        Ok(model)
    }

    /// Load model text without file-path encoding through the C API. Only the
    /// three-class softmax objective is accepted, excluding multiclass-OVA scores.
    pub fn load(runtime: Arc<LightGbmRuntime>, text: &str) -> Result<Self> {
        ensure!(
            !text.is_empty() && text.len() <= MAX_MODEL_TEXT_BYTES,
            "LightGBM model text must be between 1 byte and 64 MiB"
        );
        ensure!(
            text.lines()
                .any(|line| { line.split_whitespace().next() == Some("objective=multiclass") }),
            "LightGBM model must use the multiclass softmax objective"
        );
        let text = CString::new(text).context("LightGBM model text contains NUL")?;
        let mut iterations = 0;
        let mut handle = ptr::null_mut();
        runtime.check(
            unsafe { (runtime.booster_load)(text.as_ptr(), &mut iterations, &mut handle) },
            "load model text",
        )?;
        ensure!(!handle.is_null(), "LightGBM returned a null loaded booster");
        let mut model = Self {
            handle,
            runtime,
            _dataset: None,
            summary: TrainingSummary {
                train_rows: 0,
                feature_count: 0,
                class_counts: [0; NUM_CLASSES],
                requested_iterations: 0,
                iterations: 0,
                training_ms: 0.0,
                parameters: String::new(),
            },
            early_stopping: None,
            _not_sync: PhantomData,
        };
        let (features, actual_iterations) = model.native_dimensions()?;
        ensure!(iterations >= 0, "Invalid loaded LightGBM iteration count");
        model.summary.feature_count = features;
        model.summary.iterations = actual_iterations;
        Ok(model)
    }

    pub fn load_file(runtime: Arc<LightGbmRuntime>, path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("Read LightGBM model {}", path.display()))?;
        Self::load(runtime, &text)
    }

    pub fn summary(&self) -> &TrainingSummary {
        &self.summary
    }

    pub fn early_stopping_summary(&self) -> Option<&EarlyStoppingSummary> {
        self.early_stopping.as_ref()
    }

    fn native_dimensions(&self) -> Result<(usize, usize)> {
        let mut classes = 0;
        self.runtime.check(
            unsafe { (self.runtime.booster_classes)(self.handle, &mut classes) },
            "get class count",
        )?;
        ensure!(
            classes == NUM_CLASSES as c_int,
            "LightGBM model must have three classes"
        );
        let mut features = 0;
        self.runtime.check(
            unsafe { (self.runtime.booster_features)(self.handle, &mut features) },
            "get feature count",
        )?;
        let mut iterations = 0;
        self.runtime.check(
            unsafe { (self.runtime.booster_iteration)(self.handle, &mut iterations) },
            "get iteration count",
        )?;
        ensure!(
            features > 0 && iterations >= 0,
            "Invalid LightGBM model dimensions"
        );
        Ok((features as usize, iterations as usize))
    }

    /// Row-major probabilities in [SELL, HOLD, BUY] order. Every probability
    /// is finite, bounded and sums to one. The empty batch returns an empty Vec.
    pub fn predict(&mut self, features: &[Vec<f64>]) -> Result<Vec<[f64; NUM_CLASSES]>> {
        if features.is_empty() {
            return Ok(Vec::new());
        }
        let (rows, cols, values) = flatten_features(features)?;
        ensure!(
            cols == self.summary.feature_count,
            "LightGBM prediction feature count mismatch"
        );
        let mut output = vec![
            0.0;
            rows.checked_mul(NUM_CLASSES)
                .context("Prediction size overflow")?
        ];
        let mut output_len = 0;
        let parameters = CString::new("num_threads=4")?;
        // SAFETY: input/output buffers match C API dimensions; model class
        // count was verified before allocating the 3 * rows result buffer.
        self.runtime.check(
            unsafe {
                (self.runtime.booster_predict)(
                    self.handle,
                    values.as_ptr().cast(),
                    FLOAT64,
                    rows as i32,
                    cols as i32,
                    1,
                    PREDICT_NORMAL,
                    0,
                    -1,
                    parameters.as_ptr(),
                    &mut output_len,
                    output.as_mut_ptr(),
                )
            },
            "predict probabilities",
        )?;
        ensure!(
            output_len == output.len() as i64,
            "LightGBM probability output size mismatch"
        );
        decode_probabilities(&output)
    }

    /// Export every trained tree as LightGBM text. Uses bounded Rust buffers,
    /// including a retry if the native required length exceeds the first buffer.
    pub fn model_text(&self) -> Result<String> {
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let mut needed = 0;
            self.runtime.check(
                unsafe {
                    (self.runtime.booster_save)(
                        self.handle,
                        0,
                        -1,
                        0,
                        buffer.len() as i64,
                        &mut needed,
                        buffer.as_mut_ptr().cast(),
                    )
                },
                "export model text",
            )?;
            ensure!(
                needed > 0 && needed <= MAX_MODEL_TEXT_BYTES as i64,
                "Invalid LightGBM model text size"
            );
            if needed as usize > buffer.len() {
                buffer.resize(needed as usize, 0);
                continue;
            }
            let text = CStr::from_bytes_until_nul(&buffer[..needed as usize])
                .context("LightGBM model text was not terminated")?;
            return Ok(text
                .to_str()
                .context("LightGBM model text is not UTF-8")?
                .to_owned());
        }
    }

    /// Write UTF-8 model text via Rust so Windows Unicode paths work normally.
    pub fn save(&self, path: &Path) -> Result<()> {
        std::fs::write(path, self.model_text()?)
            .with_context(|| format!("Write LightGBM model {}", path.display()))
    }
}

fn validate_validation_inputs(
    validation: ValidationInputs<'_>,
    expected_cols: usize,
) -> Result<()> {
    ensure!(
        (1..=1000).contains(&validation.patience_rounds)
            && (1..=1000).contains(&validation.check_every)
            && validation.check_every <= validation.patience_rounds,
        "Validation check interval and patience must be in 1..=1000 with check interval <= patience"
    );
    ensure!(
        !validation.features.is_empty() && validation.features.len() == validation.labels.len(),
        "Validation feature/label rows must be nonempty and equal"
    );
    let (_, cols, _) = flatten_features(validation.features)?;
    ensure!(
        cols == expected_cols,
        "Validation feature count differs from training"
    );
    ensure!(
        validation.labels.iter().all(|label| *label < NUM_CLASSES),
        "Validation labels must be SELL=0,HOLD=1,BUY=2"
    );
    Ok(())
}

fn multiclass_log_loss(probabilities: &[[f64; NUM_CLASSES]], labels: &[usize]) -> Result<f64> {
    ensure!(
        !labels.is_empty() && probabilities.len() == labels.len(),
        "Validation prediction/label count mismatch"
    );
    let mut loss = 0.;
    for (probabilities, label) in probabilities.iter().zip(labels) {
        ensure!(*label < NUM_CLASSES, "Invalid validation class");
        ensure!(
            probabilities
                .iter()
                .all(|value| value.is_finite() && (0. ..=1.).contains(value))
                && (probabilities.iter().sum::<f64>() - 1.).abs() <= 1e-8,
            "Invalid validation probabilities"
        );
        loss -= probabilities[*label].max(1e-15).ln();
    }
    Ok(loss / labels.len() as f64)
}

fn validate_training_config(parameters: &str, iterations: usize) -> Result<()> {
    ensure!(
        (1..=1000).contains(&iterations),
        "LightGBM iterations must be 1..=1000"
    );
    ensure!(
        parameters.len() <= 16_384 && !parameters.contains('\0'),
        "Invalid LightGBM parameters"
    );
    let mut values = std::collections::BTreeMap::new();
    for parameter in parameters.split_whitespace() {
        let (key, value) = parameter
            .split_once('=')
            .context("LightGBM parameters must be key=value")?;
        ensure!(
            !key.is_empty() && !value.is_empty(),
            "Empty LightGBM parameter"
        );
        ensure!(
            values.insert(key, value).is_none(),
            "Duplicate LightGBM parameter {key}"
        );
        ensure!(
            !matches!(
                key,
                "application"
                    | "app"
                    | "loss"
                    | "num_class"
                    | "num_classes"
                    | "device"
                    | "device_type"
            ) || matches!(key, "num_class" | "device_type"),
            "Use canonical LightGBM objective/class/device parameter names"
        );
    }
    for (key, expected) in [
        ("objective", "multiclass"),
        ("num_class", "3"),
        ("device_type", "cpu"),
    ] {
        ensure!(
            values.get(key) == Some(&expected),
            "LightGBM requires {key}={expected}"
        );
    }
    Ok(())
}

fn flatten_features(features: &[Vec<f64>]) -> Result<(usize, usize, Vec<f64>)> {
    let rows = features.len();
    ensure!(
        rows > 0 && rows <= i32::MAX as usize,
        "LightGBM requires 1..=i32::MAX feature rows"
    );
    let cols = features[0].len();
    ensure!(
        cols > 0 && cols <= i32::MAX as usize,
        "LightGBM requires 1..=i32::MAX feature columns"
    );
    let count = rows
        .checked_mul(cols)
        .context("LightGBM feature matrix size overflow")?;
    let mut values = Vec::with_capacity(count);
    for (index, row) in features.iter().enumerate() {
        ensure!(
            row.len() == cols,
            "LightGBM feature row {index} has a different length"
        );
        ensure!(
            row.iter().all(|value| value.is_finite()),
            "LightGBM feature row {index} contains non-finite values"
        );
        values.extend_from_slice(row);
    }
    Ok((rows, cols, values))
}

fn prepare_training(
    features: &[Vec<f64>],
    labels: &[usize],
) -> Result<(usize, usize, Vec<f64>, [usize; NUM_CLASSES])> {
    ensure!(
        features.len() >= MIN_TRAIN_ROWS,
        "LightGBM training requires at least {MIN_TRAIN_ROWS} rows"
    );
    ensure!(
        features.len() == labels.len(),
        "LightGBM feature/label row count mismatch"
    );
    let (rows, cols, values) = flatten_features(features)?;
    let mut counts = [0; NUM_CLASSES];
    for (index, label) in labels.iter().enumerate() {
        ensure!(
            *label < NUM_CLASSES,
            "LightGBM label row {index} must be SELL=0, HOLD=1 or BUY=2"
        );
        counts[*label] += 1;
    }
    Ok((rows, cols, values, counts))
}

fn decode_probabilities(values: &[f64]) -> Result<Vec<[f64; NUM_CLASSES]>> {
    ensure!(
        values.len().is_multiple_of(NUM_CLASSES),
        "LightGBM probability vector has invalid length"
    );
    values
        .chunks_exact(NUM_CLASSES)
        .enumerate()
        .map(|(index, row)| {
            ensure!(
                row.iter()
                    .all(|value| value.is_finite() && (0.0..=1.0).contains(value)),
                "LightGBM probability row {index} is invalid"
            );
            ensure!(
                (row.iter().sum::<f64>() - 1.0).abs() <= 1e-8,
                "LightGBM probability row {index} does not sum to one"
            );
            Ok([row[SELL], row[HOLD], row[BUY]])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configurable_training_preserves_cpu_three_class_contract() {
        validate_training_config(TRAIN_PARAMETERS, TRAIN_ITERATIONS).unwrap();
        for parameters in [
            "objective=regression num_class=3 device_type=cpu",
            "objective=multiclass num_class=2 device_type=cpu",
            "objective=multiclass num_class=3 device_type=gpu",
            "objective=multiclass num_class=3 device_type=cpu num_class=4",
            "objective=multiclass num_class=3 device_type=cpu application=regression",
        ] {
            assert!(validate_training_config(parameters, 100).is_err());
        }
        assert!(validate_training_config(TRAIN_PARAMETERS, 0).is_err());
        assert!(validate_training_config(TRAIN_PARAMETERS, 1001).is_err());
    }

    #[test]
    fn refuses_invalid_training_shapes_values_and_labels() {
        let valid = vec![vec![1.0, 2.0]; MIN_TRAIN_ROWS];
        let labels = vec![HOLD; MIN_TRAIN_ROWS];
        assert!(
            prepare_training(&valid[..MIN_TRAIN_ROWS - 1], &labels[..MIN_TRAIN_ROWS - 1]).is_err()
        );
        assert!(prepare_training(&valid, &labels[..MIN_TRAIN_ROWS - 1]).is_err());
        let mut ragged = valid.clone();
        ragged[3].pop();
        assert!(prepare_training(&ragged, &labels).is_err());
        let mut invalid = valid.clone();
        invalid[1][0] = f64::NAN;
        assert!(prepare_training(&invalid, &labels).is_err());
        invalid[1][0] = f64::INFINITY;
        assert!(prepare_training(&invalid, &labels).is_err());
        let mut bad_labels = labels.clone();
        bad_labels[2] = NUM_CLASSES;
        assert!(prepare_training(&valid, &bad_labels).is_err());
        let (_, cols, _, counts) = prepare_training(&valid, &labels).unwrap();
        assert_eq!(cols, 2);
        assert_eq!(counts, [0, MIN_TRAIN_ROWS, 0]);
    }

    #[test]
    fn validation_refuses_invalid_shapes_labels_and_early_stopping_parameters() {
        let features = vec![vec![1., 2.], vec![3., 4.]];
        let labels = vec![SELL, BUY];
        let valid = ValidationInputs {
            features: &features,
            labels: &labels,
            patience_rounds: 20,
            check_every: 5,
        };
        validate_validation_inputs(valid, 2).unwrap();
        assert!(validate_validation_inputs(valid, 3).is_err());
        for (patience_rounds, check_every) in [(0, 5), (20, 0), (4, 5), (1001, 5), (20, 1001)] {
            assert!(
                validate_validation_inputs(
                    ValidationInputs {
                        patience_rounds,
                        check_every,
                        ..valid
                    },
                    2
                )
                .is_err()
            );
        }
        assert!(
            validate_validation_inputs(
                ValidationInputs {
                    features: &[],
                    labels: &[],
                    ..valid
                },
                2
            )
            .is_err()
        );
        assert!(
            validate_validation_inputs(
                ValidationInputs {
                    labels: &labels[..1],
                    ..valid
                },
                2
            )
            .is_err()
        );
        assert!(
            validate_validation_inputs(
                ValidationInputs {
                    labels: &[SELL, NUM_CLASSES],
                    ..valid
                },
                2
            )
            .is_err()
        );
        let ragged = vec![vec![1., 2.], vec![3.]];
        assert!(
            validate_validation_inputs(
                ValidationInputs {
                    features: &ragged,
                    ..valid
                },
                2
            )
            .is_err()
        );
        let nonfinite = vec![vec![1., 2.], vec![3., f64::INFINITY]];
        assert!(
            validate_validation_inputs(
                ValidationInputs {
                    features: &nonfinite,
                    ..valid
                },
                2
            )
            .is_err()
        );
    }

    #[test]
    fn validation_patience_counts_rounds_and_equal_loss_does_not_reset_it() {
        let mut state = EarlyStoppingState::new();
        assert!(state.record(5, 0.8).unwrap());
        assert!(state.record(10, 0.7).unwrap());
        assert!(!state.record(15, 0.7).unwrap());
        assert!(!state.patience_exhausted(29, 20));
        assert!(state.patience_exhausted(30, 20));
        assert_eq!(state.best_iteration, 10);
        assert!(state.record(30, 0.6).unwrap());
        assert!(!state.patience_exhausted(30, 20));
        assert_eq!(state.best_iteration, 30);
        assert!(state.record(35, f64::NAN).is_err());
        assert!(state.record(35, -0.1).is_err());
        let loss = multiclass_log_loss(&[[0.8, 0.1, 0.1], [0.1, 0.1, 0.8]], &[SELL, BUY]).unwrap();
        assert!((loss + 0.8_f64.ln()).abs() < 1e-12);
        assert!(multiclass_log_loss(&[[0.1, 0.2, 0.3]], &[HOLD]).is_err());
        assert!(multiclass_log_loss(&[], &[]).is_err());
        assert!(multiclass_log_loss(&[[0.8, 0.1, 0.1]], &[NUM_CLASSES]).is_err());
    }

    #[test]
    fn probability_decoder_rejects_invalid_outputs_and_preserves_class_order() {
        assert_eq!(
            decode_probabilities(&[0.1, 0.2, 0.7]).unwrap(),
            vec![[0.1, 0.2, 0.7]]
        );
        for invalid in [
            vec![0.1, 0.2],
            vec![0.1, 0.2, 0.3],
            vec![0.0, 0.0, f64::NAN],
            vec![-0.1, 0.5, 0.6],
        ] {
            assert!(decode_probabilities(&invalid).is_err());
        }
    }

    #[test]
    #[ignore = "requires installed CPU LightGBM native runtime"]
    fn native_training_roundtrip_is_deterministic_and_keeps_class_order() {
        let path = std::env::var_os("NOFX_LIGHTGBM_LIBRARY")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| DEFAULT_RUNTIME_PATH.into());
        let runtime = LightGbmRuntime::load(&path).unwrap();
        let mut features = Vec::new();
        let mut labels = Vec::new();
        // Disjoint, adequately populated classes catch both class-major decoding
        // errors and an incorrect float type in DatasetSetField(label).
        for class in 0..NUM_CLASSES {
            for index in 0..120 {
                features.push(vec![
                    class as f64 * 10.0 + index as f64 / 120.0,
                    index as f64 / 120.0,
                ]);
                labels.push(class);
            }
        }
        let mut first = LightGbmModel::train(runtime.clone(), &features, &labels).unwrap();
        let mut second = LightGbmModel::train(runtime.clone(), &features, &labels).unwrap();
        assert!(first.summary().iterations > 0);
        assert_eq!(first.summary().feature_count, 2);
        assert_eq!(first.summary().class_counts, [120; NUM_CLASSES]);
        let probes = vec![vec![0.5, 0.5], vec![10.5, 0.5], vec![20.5, 0.5]];
        let predicted = first.predict(&probes).unwrap();
        assert_eq!(predicted, second.predict(&probes).unwrap());
        for (class, row) in predicted.iter().enumerate() {
            assert!(row[class] > 0.8, "Wrong class probability: {row:?}");
        }
        let text = first.model_text().unwrap();
        let mut loaded = LightGbmModel::load(runtime.clone(), &text).unwrap();
        assert_eq!(loaded.predict(&probes).unwrap(), predicted);
        assert!(loaded.predict(&[vec![0.0]]).is_err());
        assert!(loaded.predict(&[vec![f64::NAN, 0.0]]).is_err());
        assert!(LightGbmModel::load(runtime, "objective=binary\n").is_err());
        // Move across a thread boundary and predict after the original datasets
        // and sibling models have been dropped, exercising ownership lifetimes.
        drop(first);
        drop(second);
        let moved = std::thread::spawn(move || loaded.predict(&probes).unwrap())
            .join()
            .unwrap();
        assert_eq!(moved, predicted);
    }

    #[test]
    #[ignore = "requires installed CPU LightGBM native runtime"]
    fn native_validation_stops_overfit_and_restores_best_snapshot_with_training_metadata() {
        let path = std::env::var_os("NOFX_LIGHTGBM_LIBRARY")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| DEFAULT_RUNTIME_PATH.into());
        let runtime = LightGbmRuntime::load(&path).unwrap();
        let mut features = Vec::new();
        let mut labels = Vec::new();
        let mut validation_features = Vec::new();
        let mut validation_labels = Vec::new();
        for class in 0..NUM_CLASSES {
            for index in 0..120 {
                features.push(vec![
                    class as f64 * 10. + index as f64 / 120.,
                    index as f64 / 120.,
                ]);
                validation_features.push(vec![
                    class as f64 * 10. + (index as f64 + 0.5) / 120.,
                    (index as f64 + 0.5) / 120.,
                ]);
                labels.push(class);
                // A deterministic distribution shift exposes later overfitting:
                // confidence in the training class worsens validation log loss.
                validation_labels.push((class + 1) % NUM_CLASSES);
            }
        }
        let parameters = TRAIN_PARAMETERS.replace("learning_rate=0.05", "learning_rate=0.2");
        let mut model = LightGbmModel::train_config_with_validation(
            runtime.clone(),
            &features,
            &labels,
            &parameters,
            200,
            &validation_features,
            &validation_labels,
            20,
            5,
        )
        .unwrap();
        let stopping = model.early_stopping_summary().unwrap().clone();
        assert!(
            stopping.patience_exhausted,
            "Unexpected stopping history: {stopping:?}"
        );
        assert!(stopping.stopped_early && stopping.rounds_executed < 200);
        assert_eq!(stopping.best_iteration, 5);
        assert_eq!(stopping.trained_iterations, 25);
        assert_eq!(model.summary().iterations, stopping.best_iteration);
        assert_eq!(model.summary().requested_iterations, 200);
        assert_eq!(model.summary().train_rows, 360);
        assert_eq!(model.summary().class_counts, [120; NUM_CLASSES]);
        assert_eq!(model.summary().parameters, parameters);
        assert!(
            stopping
                .validation_checkpoints
                .iter()
                .skip(1)
                .all(|checkpoint| checkpoint.log_loss > stopping.best_validation_log_loss)
        );
        let probabilities = model.predict(&features).unwrap();
        assert!(
            (multiclass_log_loss(
                &model.predict(&validation_features).unwrap(),
                &validation_labels,
            )
            .unwrap()
                - stopping.best_validation_log_loss)
                .abs()
                < 1e-12
        );
        let text = model.model_text().unwrap();
        let mut loaded = LightGbmModel::load(runtime.clone(), &text).unwrap();
        assert_eq!(loaded.summary().iterations, stopping.best_iteration);
        assert_eq!(loaded.predict(&features).unwrap(), probabilities);
        assert!(loaded.early_stopping_summary().is_none());
        let mut exact_best = LightGbmModel::train_config(
            runtime,
            &features,
            &labels,
            &parameters,
            stopping.best_iteration,
        )
        .unwrap();
        assert_eq!(exact_best.predict(&features).unwrap(), probabilities);
        assert!(exact_best.early_stopping_summary().is_none());
        let encoded = serde_json::to_vec(&stopping).unwrap();
        let decoded: EarlyStoppingSummary = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.best_iteration, stopping.best_iteration);
        assert_eq!(
            decoded.validation_checkpoints.len(),
            stopping.validation_checkpoints.len()
        );
    }
}
