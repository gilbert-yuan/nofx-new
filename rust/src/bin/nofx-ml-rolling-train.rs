//! Chronological execution-label research. No exchange/account/order APIs.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    ml_features,
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmModel, LightGbmRuntime},
    ml_optimization::{self, ProbabilityPoint, StrategyParameters, SymbolData},
    ml_optimization_metrics::{Aggregate, compare, profitable_upgrade},
    ml_replay::ReplayConfig,
    ml_rolling::{
        self, Fold, ProbabilityObservation, QuantileCalibration, RollingPlan,
        TemperatureCalibration, TimeRange,
    },
    ml_training_data::{self, PreparationConfig, TrainingData, TrainingRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

#[derive(Parser)]
#[command(
    about = "Prepare execution labels, tune CPU LightGBM and evaluate chronological folds offline"
)]
struct Args {
    #[arg(long, default_value = "data/ml/expanded-archive-20261016")]
    data_dir: PathBuf,
    #[arg(long, default_value = "output/ml-rolling-20261016")]
    output_dir: PathBuf,
    #[arg(long)]
    cache_dir: Option<PathBuf>,
    #[arg(long, default_value = "data/chronos/chronos-bolt-tiny.onnx")]
    forecast_model: PathBuf,
    #[arg(
        long,
        default_value = "data/chronos/model-toolchain/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"
    )]
    forecast_runtime: PathBuf,
    #[arg(long, default_value=DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long, default_value_t = 6)]
    stride_hours: usize,
    #[arg(long, default_value_t = 4)]
    threads: usize,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long)]
    prepare_only: bool,
    #[arg(long)]
    resume: bool,
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(
        &fs::read(path).with_context(|| format!("Read {}", path.display()))?,
    )?)
}
fn write_exact(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        ensure!(
            fs::read(path)? == bytes,
            "Immutable artifact differs: {}",
            path.display()
        );
        return Ok(());
    }
    fs::create_dir_all(path.parent().context("Missing output parent")?)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    let published = match fs::hard_link(&temporary, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            ensure!(
                fs::read(path)? == bytes,
                "Concurrent artifact differs: {}",
                path.display()
            );
            Ok(())
        }
        Err(error) => Err(error.into()),
    };
    let _ = fs::remove_file(&temporary);
    published
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_exact(path, &serde_json::to_vec_pretty(value)?)
}

fn indices(records: &[TrainingRecord], range: TimeRange, supervised: bool) -> Vec<usize> {
    records
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            (range.contains_mature_origin(r.origin_ms)
                && r.mature_by_ms <= range.end_ms
                && (!supervised || r.label.is_some()))
            .then_some(i)
        })
        .collect()
}
fn feature(
    row: &TrainingRecord,
    calibration: &QuantileCalibration,
    augmented: bool,
) -> Result<Vec<f64>> {
    let mut values = row.base.clone();
    if augmented {
        values.extend(ml_features::chronos_features(
            &ml_rolling::apply_quantile_calibration(&row.forecast, calibration)?,
        )?);
    }
    ensure!(
        values.iter().all(|x| x.is_finite()),
        "Nonfinite causal features"
    );
    Ok(values)
}
fn matrix(
    records: &[TrainingRecord],
    indexes: &[usize],
    calibration: &QuantileCalibration,
    augmented: bool,
) -> Result<Vec<Vec<f64>>> {
    indexes
        .iter()
        .map(|&i| feature(&records[i], calibration, augmented))
        .collect()
}
fn observations(
    records: &[TrainingRecord],
    indexes: &[usize],
    probabilities: &[[f64; 3]],
) -> Result<Vec<ProbabilityObservation>> {
    ensure!(
        indexes.len() == probabilities.len(),
        "Prediction coverage differs"
    );
    indexes
        .iter()
        .zip(probabilities)
        .filter_map(|(&i, &p)| {
            records[i].label.map(|label| ProbabilityObservation {
                symbol: records[i].symbol.clone(),
                origin_ms: records[i].origin_ms,
                label,
                probabilities: p,
            })
        })
        .map(Ok)
        .collect()
}
fn probability_points(
    records: &[TrainingRecord],
    indexes: &[usize],
    probabilities: &[[f64; 3]],
    temperature: &TemperatureCalibration,
) -> Result<BTreeMap<String, Vec<ProbabilityPoint>>> {
    ensure!(
        indexes.len() == probabilities.len(),
        "Prediction coverage differs"
    );
    let mut grouped: BTreeMap<String, Vec<ProbabilityPoint>> = BTreeMap::new();
    // Intentionally do not filter label=None: future non-fills cannot select signals.
    for (&i, p) in indexes.iter().zip(probabilities) {
        let row = &records[i];
        grouped
            .entry(row.symbol.clone())
            .or_default()
            .push(ProbabilityPoint {
                origin_ms: row.origin_ms,
                probabilities: temperature.apply(p)?,
            });
    }
    for points in grouped.values_mut() {
        points.sort_by_key(|p| p.origin_ms);
    }
    Ok(grouped)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ReplaySummary {
    aggregate: Aggregate,
    covered_symbols: usize,
    uncovered_symbols: Vec<String>,
    prediction_count: usize,
}

fn evaluate_partition(
    args: &Args,
    data: &TrainingData,
    indexes: &[usize],
    probabilities: &[[f64; 3]],
    temperature: &TemperatureCalibration,
    range: TimeRange,
    directory: &Path,
) -> Result<ReplaySummary> {
    let grouped = probability_points(&data.records, indexes, probabilities, temperature)?;
    let prediction_count = grouped.values().map(Vec::len).sum::<usize>();
    ensure!(
        prediction_count == indexes.len(),
        "Not all causal predictions reached replay"
    );
    let mut aggregate = Aggregate::default();
    let mut uncovered = Vec::new();
    for (n, symbol) in data.symbols.iter().enumerate() {
        let rows = ml_training_data::load_training_source(&args.data_dir, symbol)?;
        let first = rows
            .first()
            .and_then(|r| r["openTime"].as_i64())
            .context("Missing first source bar")?
            + ml_features::HOUR;
        let last = rows
            .last()
            .and_then(|r| r["openTime"].as_i64())
            .context("Missing final source bar")?
            + ml_features::HOUR;
        let actual = TimeRange {
            start_ms: range.start_ms.max(first),
            end_ms: range.end_ms.min(last),
        };
        let points = grouped.get(symbol).cloned().unwrap_or_default();
        if actual.end_ms <= actual.start_ms {
            ensure!(points.is_empty(), "Predictions outside listed history");
            uncovered.push(symbol.clone());
            continue;
        }
        let fingerprint = sha(&serde_json::to_vec(
            &json!({"symbol":symbol,"range":actual,"source_rows_sha256":sha(&serde_json::to_vec(&rows)?),"points":points,"parameters":StrategyParameters::default()}),
        )?);
        let path = directory.join(format!("{symbol}.json"));
        let saved = if path.exists() {
            ensure!(args.resume, "Existing replay requires --resume");
            let saved = read_json(&path)?;
            ensure!(saved["fingerprint"] == fingerprint, "Changed replay inputs");
            saved
        } else {
            let result = ml_optimization::evaluate(
                &SymbolData {
                    symbol: symbol.clone(),
                    rows,
                    predictions: points,
                },
                &StrategyParameters::default(),
                &ReplayConfig {
                    start_ms: actual.start_ms,
                    end_ms: actual.end_ms,
                    ..Default::default()
                },
            )?;
            let saved = json!({"fingerprint":fingerprint,"requested_range":range,"listed_range":actual,"replay":result});
            write_json(&path, &saved)?;
            saved
        };
        aggregate.add(&saved["replay"])?;
        if (n + 1) % 50 == 0 || n + 1 == data.symbols.len() {
            println!(
                "{}",
                json!({"stage":"shared_replay","path":directory,"symbols_completed":n+1,"symbols":data.symbols.len(),"net_usdt":aggregate.net_pnl_usdt})
            );
        }
    }
    Ok(ReplaySummary {
        covered_symbols: aggregate.symbols,
        aggregate,
        uncovered_symbols: uncovered,
        prediction_count,
    })
}

#[derive(Clone, Serialize, Deserialize)]
struct Trial {
    index: usize,
    validation_log_loss: f64,
    model_sha256: String,
    validation_metrics: Value,
    effective_iterations: usize,
    training_summary: Value,
    early_stopping: Value,
}
fn check_classes(labels: &[usize]) -> Result<[usize; 3]> {
    let mut counts = [0; 3];
    for &label in labels {
        ensure!(label < 3, "Invalid label");
        counts[label] += 1;
    }
    ensure!(
        counts.iter().all(|&n| n >= 30),
        "Need at least 30 mature training samples per class: {counts:?}"
    );
    Ok(counts)
}

fn tune_fold(
    args: &Args,
    data: &TrainingData,
    fold: &Fold,
    runtime: Arc<LightGbmRuntime>,
) -> Result<Value> {
    let directory = args.output_dir.join(format!("fold-{}", fold.index));
    fs::create_dir_all(&directory)?;
    let forecast_rows: Vec<_> = data
        .records
        .iter()
        .filter(|r| {
            fold.train.contains_mature_origin(r.origin_ms)
                || fold.validation.contains_mature_origin(r.origin_ms)
        })
        .map(|r| ml_rolling::ForecastObservation {
            forecast: r.forecast.clone(),
            realized_returns: r.realized_returns.clone(),
        })
        .collect();
    let quantile_fit =
        ml_rolling::fit_quantile_calibration(&forecast_rows, fold.train, fold.validation)?;
    drop(forecast_rows);
    write_json(&directory.join("forecast-calibration.json"), &quantile_fit)?;
    let calibration = &quantile_fit.selected;
    let train = indices(&data.records, fold.train, true);
    let validation = indices(&data.records, fold.validation, false);
    let probability_calibration = indices(&data.records, fold.calibration, false);
    let confirmation = indices(&data.records, fold.confirmation, false);
    ensure!(
        !validation.is_empty() && !probability_calibration.is_empty() && !confirmation.is_empty(),
        "Empty fold coverage"
    );
    let labels: Vec<_> = train
        .iter()
        .map(|&i| data.records[i].label.unwrap())
        .collect();
    let counts = check_classes(&labels)?;
    let train_matrix = matrix(&data.records, &train, calibration, true)?;
    let validation_matrix = matrix(&data.records, &validation, calibration, true)?;
    let validation_supervised = indices(&data.records, fold.validation, true);
    let validation_labels: Vec<_> = validation_supervised
        .iter()
        .map(|&i| data.records[i].label.unwrap())
        .collect();
    let validation_label_matrix = matrix(&data.records, &validation_supervised, calibration, true)?;
    let candidates = ml_rolling::controlled_candidates(args.threads)?;
    let mut trials = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let model_path = directory
            .join("models")
            .join(format!("candidate-{index:02}.txt"));
        let trial_path = directory
            .join("trials")
            .join(format!("candidate-{index:02}.json"));
        let trial = if trial_path.exists() {
            ensure!(args.resume, "Existing trial requires --resume");
            let trial: Trial = serde_json::from_value(read_json(&trial_path)?)?;
            ensure!(
                trial.index == index && trial.model_sha256 == sha(&fs::read(&model_path)?),
                "Changed candidate artifact"
            );
            trial
        } else {
            let mut model = LightGbmModel::train_config_with_validation(
                runtime.clone(),
                &train_matrix,
                &labels,
                &candidate.parameters,
                candidate.iterations,
                &validation_label_matrix,
                &validation_labels,
                30,
                5,
            )?;
            let probabilities = model.predict(&validation_matrix)?;
            let metrics = ml_rolling::classification_metrics(
                &observations(&data.records, &validation, &probabilities)?,
                None,
            )?;
            let text = model.model_text()?;
            write_exact(&model_path, text.as_bytes())?;
            let trial = Trial {
                index,
                validation_log_loss: metrics.log_loss,
                model_sha256: sha(text.as_bytes()),
                validation_metrics: serde_json::to_value(&metrics)?,
                effective_iterations: model.summary().iterations,
                training_summary: serde_json::to_value(model.summary())?,
                early_stopping: serde_json::to_value(model.early_stopping_summary())?,
            };
            write_json(&trial_path, &trial)?;
            trial
        };
        println!(
            "{}",
            json!({"stage":"lightgbm_candidate","fold":fold.index,"candidate":index,"train_class_counts":counts,"validation_log_loss":trial.validation_log_loss})
        );
        trials.push(trial);
    }
    drop(train_matrix);
    drop(validation_label_matrix);
    let mut ranking: Vec<_> = (0..trials.len()).collect();
    ranking.sort_by(|&a, &b| {
        trials[a]
            .validation_log_loss
            .total_cmp(&trials[b].validation_log_loss)
            .then(a.cmp(&b))
    });
    let mut comparisons = Vec::new();
    for &index in ranking.iter().take(3) {
        let mut model = LightGbmModel::load_file(
            runtime.clone(),
            &directory
                .join("models")
                .join(format!("candidate-{index:02}.txt")),
        )?;
        let probabilities = model.predict(&validation_matrix)?;
        let result = evaluate_partition(
            args,
            data,
            &validation,
            &probabilities,
            &TemperatureCalibration::default(),
            fold.validation,
            &directory
                .join("validation")
                .join(format!("candidate-{index:02}")),
        )?;
        comparisons.push((index, result));
    }
    comparisons.sort_by(|a, b| {
        let eligible = |x: &ReplaySummary| x.aggregate.eligible(50, 10, 10.);
        eligible(&b.1)
            .cmp(&eligible(&a.1))
            .then_with(|| compare(&b.1.aggregate, &a.1.aggregate))
            .then_with(|| a.0.cmp(&b.0))
    });
    let selected = comparisons.first().context("No preselected candidates")?.0;
    let selection = json!({"fold":fold,"selected_index":selected,"candidate":candidates[selected],"model_sha256":trials[selected].model_sha256,
        "selection_method":"Top 3 of 16 by mature validation log loss; highest eligible shared-replay validation net PnL; diagnostic fallback if none eligible",
        "validation_trade_eligible":comparisons[0].1.aggregate.eligible(50,10,10.),"validation_candidates":comparisons,"trials":trials,
        "forecast_calibration_sha256":sha(&fs::read(directory.join("forecast-calibration.json"))?),"deployment_approved":false});
    // Candidate is immutable before probabilities are fitted on calibration or confirmation evaluated.
    write_json(&directory.join("selected-policy.json"), &selection)?;
    drop(validation_matrix);
    let mut selected_model = LightGbmModel::load_file(
        runtime.clone(),
        &directory
            .join("models")
            .join(format!("candidate-{selected:02}.txt")),
    )?;
    let cal_matrix = matrix(&data.records, &probability_calibration, calibration, true)?;
    let temperature = ml_rolling::fit_temperature(
        &observations(
            &data.records,
            &probability_calibration,
            &selected_model.predict(&cal_matrix)?,
        )?,
        fold.calibration,
    )?;
    write_json(
        &directory.join("probability-calibration.json"),
        &temperature,
    )?;
    drop(cal_matrix);
    // Controlled ablation: identical selected hyperparameters, labels and time ranges.
    // No earlier-date evaluation of the existing October-trained production model.
    let ablation_path = directory.join("models").join("without-chronos.txt");
    let mut baseline = if ablation_path.exists() {
        ensure!(args.resume, "Existing ablation requires --resume");
        LightGbmModel::load_file(runtime.clone(), &ablation_path)?
    } else {
        let values = matrix(&data.records, &train, calibration, false)?;
        let candidate = &candidates[selected];
        let model = LightGbmModel::train_config(
            runtime.clone(),
            &values,
            &labels,
            &candidate.parameters,
            trials[selected].effective_iterations.max(1),
        )?;
        write_exact(&ablation_path, model.model_text()?.as_bytes())?;
        drop(model);
        LightGbmModel::load_file(runtime.clone(), &ablation_path)?
    };
    let cal_base = matrix(&data.records, &probability_calibration, calibration, false)?;
    let base_temperature = ml_rolling::fit_temperature(
        &observations(
            &data.records,
            &probability_calibration,
            &baseline.predict(&cal_base)?,
        )?,
        fold.calibration,
    )?;
    write_json(
        &directory.join("ablation-probability-calibration.json"),
        &base_temperature,
    )?;
    drop(cal_base);
    write_json(
        &directory.join("confirmation-policy.json"),
        &json!({"selected_model_sha256":trials[selected].model_sha256,"ablation_model_sha256":sha(&fs::read(&ablation_path)?),"temperature":temperature.selected,"ablation_temperature":base_temperature.selected,"confirmation":fold.confirmation,"parameters":StrategyParameters::default(),"deployment_approved":false}),
    )?;
    let confirm_matrix = matrix(&data.records, &confirmation, calibration, true)?;
    let probabilities = selected_model.predict(&confirm_matrix)?;
    drop(confirm_matrix);
    let with_observations = observations(&data.records, &confirmation, &probabilities)?;
    let with_replay = evaluate_partition(
        args,
        data,
        &confirmation,
        &probabilities,
        &temperature.selected,
        fold.confirmation,
        &directory.join("confirmation/with-chronos"),
    )?;
    let confirm_base = matrix(&data.records, &confirmation, calibration, false)?;
    let base_probabilities = baseline.predict(&confirm_base)?;
    drop(confirm_base);
    let base_observations = observations(&data.records, &confirmation, &base_probabilities)?;
    let base_replay = evaluate_partition(
        args,
        data,
        &confirmation,
        &base_probabilities,
        &base_temperature.selected,
        fold.confirmation,
        &directory.join("confirmation/without-chronos"),
    )?;
    let ablation = ml_rolling::ablation_metrics(
        &with_observations,
        &base_observations,
        Some(&temperature.selected),
        Some(&base_temperature.selected),
    )?;
    let validation_pass = comparisons[0].1.aggregate.eligible(50, 10, 10.)
        && comparisons[0].1.aggregate.net_pnl_usdt > 0.;
    let confirmation_pass =
        profitable_upgrade(&with_replay.aggregate, &base_replay.aggregate, 50, 10);
    let report = json!({"fold":fold,"selection":selection,"quantile_calibration":quantile_fit,"temperature":temperature,"ablation_temperature":base_temperature,
        "confirmation_with_chronos":with_replay,"confirmation_without_chronos":base_replay,"classification_ablation":ablation,
        "validation_profitable":validation_pass,"confirmation_profitable_upgrade":confirmation_pass,"historical_pass":validation_pass&&confirmation_pass,
        "ablation_design":"Same selected hyperparameters and execution labels; baseline omits only Chronos features. Baseline is not independently hyperparameter-optimized.",
        "early_stopping_implemented":true,"early_stopping":{"validation_partition":"purged validation labels only","check_every":5,"patience_rounds":30,"selected_iterations":trials[selected].effective_iterations},"deployment_approved":false});
    write_json(&directory.join("report.json"), &report)?;
    Ok(report)
}

fn evaluate_holdout(
    args: &Args,
    data: &TrainingData,
    plan: &RollingPlan,
    runtime: Arc<LightGbmRuntime>,
) -> Result<Value> {
    // Predeclared choice: reuse the last rolling fold's frozen models; do not choose on confirmations.
    let directory = args.output_dir.join("fold-2");
    let policy = read_json(&directory.join("selected-policy.json"))?;
    let index = policy["selected_index"]
        .as_u64()
        .context("No selected last-fold model")?;
    let qfit: ml_rolling::QuantileCalibrationFit =
        serde_json::from_value(read_json(&directory.join("forecast-calibration.json"))?)?;
    let temp: ml_rolling::TemperatureFit =
        serde_json::from_value(read_json(&directory.join("probability-calibration.json"))?)?;
    let btemp: ml_rolling::TemperatureFit = serde_json::from_value(read_json(
        &directory.join("ablation-probability-calibration.json"),
    )?)?;
    let selected_path = directory
        .join("models")
        .join(format!("candidate-{index:02}.txt"));
    let ablation_path = directory.join("models/without-chronos.txt");
    write_json(
        &args.output_dir.join("holdout-policy.json"),
        &json!({"selection_method":"Predeclared last fold, no selection on confirmation/holdout outcomes","selected_model_sha256":sha(&fs::read(&selected_path)?),"ablation_model_sha256":sha(&fs::read(&ablation_path)?),"range":plan.historical_holdout,"forecast_calibration":qfit.selected,"temperature":temp.selected,"ablation_temperature":btemp.selected,"historical_already_observed":true,"deployment_approved":false}),
    )?;
    let indexes = indices(&data.records, plan.historical_holdout, false);
    ensure!(!indexes.is_empty(), "No holdout prediction coverage");
    let mut model = LightGbmModel::load_file(runtime.clone(), &selected_path)?;
    let values = matrix(&data.records, &indexes, &qfit.selected, true)?;
    let p = model.predict(&values)?;
    drop(values);
    let with = evaluate_partition(
        args,
        data,
        &indexes,
        &p,
        &temp.selected,
        plan.historical_holdout,
        &args.output_dir.join("holdout/with-chronos"),
    )?;
    let mut base = LightGbmModel::load_file(runtime, &ablation_path)?;
    let values = matrix(&data.records, &indexes, &qfit.selected, false)?;
    let bp = base.predict(&values)?;
    drop(values);
    let without = evaluate_partition(
        args,
        data,
        &indexes,
        &bp,
        &btemp.selected,
        plan.historical_holdout,
        &args.output_dir.join("holdout/without-chronos"),
    )?;
    let metrics = ml_rolling::ablation_metrics(
        &observations(&data.records, &indexes, &p)?,
        &observations(&data.records, &indexes, &bp)?,
        Some(&temp.selected),
        Some(&btemp.selected),
    )?;
    let report = json!({"range":plan.historical_holdout,"with_chronos":with,"without_chronos":without,"classification_ablation":metrics,"historical_profitable_upgrade":profitable_upgrade(&with.aggregate,&without.aggregate,50,10),"new_blind_test":false,"deployment_approved":false});
    write_json(&args.output_dir.join("holdout-report.json"), &report)?;
    Ok(report)
}

fn main() -> Result<()> {
    let args = Args::parse();
    let began = Instant::now();
    ensure!((1..=12).contains(&args.threads), "Threads must be 1..12");
    ensure!(
        !args.output_dir.exists() || args.resume,
        "Use a fresh output directory or --resume"
    );
    let manifest = read_json(&args.data_dir.join("manifest.json"))?;
    let plan = RollingPlan::expanding_180d(
        manifest["start_ms"]
            .as_i64()
            .context("Missing dataset start")?,
        manifest["end_ms"].as_i64().context("Missing dataset end")?,
    )?;
    fs::create_dir_all(&args.output_dir)?;
    let _writer = nofx_core::ml_dataset::collector_lock(&args.output_dir)?;
    let identity = json!({"schema_version":1,"data_manifest_sha256":sha(&fs::read(args.data_dir.join("manifest.json"))?),"plan":plan,
        "forecast_model_sha256":sha(&fs::read(&args.forecast_model)?),"forecast_runtime_sha256":sha(&fs::read(&args.forecast_runtime)?),"lightgbm_runtime_sha256":sha(&fs::read(&args.runtime)?),
        "software_sha256":sha(concat!(include_str!("nofx-ml-rolling-train.rs"),include_str!("../ml_training_data.rs"),include_str!("../ml_trade_labels.rs"),include_str!("../ml_rolling.rs"),include_str!("../ml_lightgbm.rs"),include_str!("../ml_features.rs"),include_str!("../ml_monthly.rs"),include_str!("../ml_optimization.rs"),include_str!("../ml_optimization_metrics.rs"),include_str!("../ml_replay.rs"),include_str!("../paper.rs"),include_str!("../simulator.rs"),include_str!("../strategies.rs"),include_str!("../research.rs")).as_bytes()),
        "executable_sha256":sha(&fs::read(std::env::current_exe()?)?),"cargo_lock_sha256":sha(include_bytes!("../../../Cargo.lock")),
        "stride_hours":args.stride_hours,"threads":args.threads,"restricted_symbols":args.symbols,"candidates":ml_rolling::controlled_candidates(args.threads)?,"early_stopping":{"check_every":5,"patience_rounds":30},"parameters":StrategyParameters::default(),"costs":nofx_core::research::costs(),"exit_rules":nofx_core::strategies::ml_horizon_exit_rules(),"deployment_approved":false,"runtime_modified":false});
    write_json(&args.output_dir.join("run-config.json"), &identity)?;
    if args.resume && args.output_dir.join("report.json").exists() {
        ensure!(
            args.output_dir.join("report.md").exists(),
            "Missing required report"
        );
        println!(
            "{}",
            json!({"stage":"already_complete","output":args.output_dir})
        );
        return Ok(());
    }
    let data = ml_training_data::prepare_data(&PreparationConfig {
        data_dir: args.data_dir.clone(),
        cache_dir: args
            .cache_dir
            .clone()
            .unwrap_or_else(|| args.data_dir.join("execution-feature-cache-v1")),
        forecast_model: args.forecast_model.clone(),
        forecast_runtime: args.forecast_runtime.clone(),
        threads: args.threads,
        stride_hours: args.stride_hours,
        symbols: args.symbols.clone(),
    })?;
    ensure!(
        data.start_ms == plan.data.start_ms && data.end_ms == plan.data.end_ms,
        "Prepared data window changed"
    );
    write_json(
        &args.output_dir.join("preparation.json"),
        &json!({"provenance":data.provenance,"records":data.records.len(),"supervised":data.records.iter().filter(|r|r.label.is_some()).count(),"symbols":data.symbols}),
    )?;
    if args.prepare_only {
        println!(
            "{}",
            json!({"stage":"prepared","records":data.records.len(),"symbols":data.symbols.len()})
        );
        return Ok(());
    }
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut folds = Vec::new();
    for fold in &plan.folds {
        let report = tune_fold(&args, &data, fold, runtime.clone())?;
        println!(
            "{}",
            json!({"stage":"fold_completed","fold":fold.index,"historical_pass":report["historical_pass"],"elapsed_seconds":began.elapsed().as_secs_f64()})
        );
        folds.push(report);
    }
    let holdout = evaluate_holdout(&args, &data, &plan, runtime)?;
    let historical_pass = folds.iter().all(|r| r["historical_pass"] == true)
        && holdout["historical_profitable_upgrade"] == true;
    let report = json!({"schema_version":1,"status":"completed","run_config_sha256":sha(&serde_json::to_vec(&identity)?),"plan":plan,"provenance":data.provenance,"folds":folds,"historical_holdout":holdout,"historical_profitable_upgrade":historical_pass,
        "chronos_weights_updated":false,"chronos_weight_finetune_status":if historical_pass {"requires_separate_Rust_training_and_export_implementation"} else {"not_started_incremental_trading_benefit_gate_not_passed"},
        "runtime_modified":false,"deployment_approved":false,"real_trading_enabled":false,"elapsed_seconds":began.elapsed().as_secs_f64(),
        "limitations":["Historical end-date universe includes archived inactive symbols when available, not all global assets.","Label eligibility is used only in supervised training and classification metrics; trading predicts all causal origins including label=None.","Models and thresholds are never selected on calibration/confirmation/holdout trading returns.","The final historical holdout includes previously observed October dates and is not a new blind test.","Independent 1000-USDT symbol accounts are not a shared-capital Demo portfolio.","Shared paper replay entry delay/expiry differs from immediate Demo order scheduling; no runtime deployment is approved.","Chronos calibration is post-processing, not neural weight fine-tuning.","Six-hour signals and overlapping 48-hour labels are dependent; reported row count is not independent sample count. Each symbol excludes its final 48 hours, so delisting-tail risk is not reconstructed as a forward execution scenario."]});
    let text = format!(
        "# Chronos + LightGBM 滚动优化\n\n完成 {} 个历史合约、3个扩展训练窗口、每窗口16组LightGBM候选及独立概率校准。\n\n历史盈利升级条件：{}。原Demo配置未修改；Chronos仅优化预测校准，权重未更新。\n\n| 时间段 | 加Chronos净收益USDT | 无Chronos对照USDT | 已平仓 |\n| --- | ---: | ---: | ---: |\n{}| 最后20天历史保留段 | {:.6} | {:.6} | {} |\n\n金额为每币独立1000 USDT账户合计，不能视为Demo共享组合收益。所有收益来自Rust共享引擎，参数/成本/退出规则冻结。未成熟及无有效监督标签的样本不进入训练，但它们的因果信号仍参与回放，避免按未来是否成交筛选信号。历史保留段此前已有观察，不称新盲测；候选轮数是上限，验证早停恢复最佳轮次。模型替换还需对齐Demo时序和新的前向数据验证。\n\n详见report.json、各fold冻结策略、逐币回放与preparation.json。\n",
        data.symbols.len(),
        historical_pass,
        folds
            .iter()
            .map(|r| format!(
                "| 窗口{} | {:.6} | {:.6} | {} |\n",
                r["fold"]["index"],
                r["confirmation_with_chronos"]["aggregate"]["net_pnl_usdt"]
                    .as_f64()
                    .unwrap_or(0.),
                r["confirmation_without_chronos"]["aggregate"]["net_pnl_usdt"]
                    .as_f64()
                    .unwrap_or(0.),
                r["confirmation_with_chronos"]["aggregate"]["closed_trades"]
            ))
            .collect::<String>(),
        holdout["with_chronos"]["aggregate"]["net_pnl_usdt"]
            .as_f64()
            .unwrap_or(0.),
        holdout["without_chronos"]["aggregate"]["net_pnl_usdt"]
            .as_f64()
            .unwrap_or(0.),
        holdout["with_chronos"]["aggregate"]["closed_trades"]
    );
    write_exact(&args.output_dir.join("report.md"), text.as_bytes())?;
    write_json(&args.output_dir.join("report.json"), &report)?;
    println!(
        "{}",
        json!({"stage":"completed","historical_profitable_upgrade":historical_pass,"output":args.output_dir,"elapsed_seconds":began.elapsed().as_secs_f64(),"runtime_modified":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prediction_packaging_preserves_unlabelled_origins_and_maturity_purge() {
        let forecast = nofx_core::chronos::ForecastRecord {
            symbol: "BTCUSDT".into(),
            origin_ms: 100 * ml_features::HOUR,
            context_end_open_ms: 99 * ml_features::HOUR,
            history_sha256: None,
            current_price: 100.,
            interval: "1h".into(),
            horizon_hours: 12,
            q10: vec![99.; 12],
            q50: vec![100.; 12],
            q90: vec![101.; 12],
            quantile_crossings: 0,
            inference_ms: 0.,
        };
        let mut records = vec![TrainingRecord {
            symbol: "BTCUSDT".into(),
            origin_ms: 100 * ml_features::HOUR,
            mature_by_ms: 148 * ml_features::HOUR,
            label: None,
            terminal_label: 1,
            base: vec![],
            forecast,
            realized_returns: vec![0.; 12],
        }];
        let range = TimeRange {
            start_ms: 100 * ml_features::HOUR,
            end_ms: 148 * ml_features::HOUR,
        };
        assert_eq!(indices(&records, range, false), vec![0]);
        assert!(indices(&records, range, true).is_empty());
        let packed = probability_points(
            &records,
            &[0],
            &[[0.1, 0.2, 0.7]],
            &TemperatureCalibration::default(),
        )
        .unwrap();
        assert_eq!(packed["BTCUSDT"].len(), 1);
        for (actual, expected) in packed["BTCUSDT"][0]
            .probabilities
            .iter()
            .zip([0.1, 0.2, 0.7])
        {
            assert!((actual - expected).abs() < 1e-14);
        }
        records[0].mature_by_ms += ml_features::HOUR;
        assert!(indices(&records, range, false).is_empty());
    }
}
