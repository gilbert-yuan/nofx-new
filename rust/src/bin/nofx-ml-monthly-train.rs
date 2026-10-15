//! Frozen multicoin monthly training, validation tuning, and shared-engine test replay.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    chronos::{ChronosModel, ContextRecord, ForecastRecord},
    iso,
    ml_features::{self, CONTEXT, HORIZON, HOUR},
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmModel, LightGbmRuntime, TRAIN_PARAMETERS},
    ml_monthly::{
        self, Calibration, DecisionPolicy, ForecastArtifact, ModelArtifact, MonthlyManifest, Split,
    },
    ml_replay::{self, ReplayConfig, ReplaySignal},
    number,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};
const SETTLEMENT_TAIL_HOURS: i64 = 36;

#[derive(Parser)]
#[command(
    about = "Train CPU Chronos-Bolt-Tiny calibrated forecasts + global LightGBM from immutable monthly public market data"
)]
struct Args {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
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
    #[arg(long)]
    prepare_only: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    symbol: String,
    end: usize,
    origin_ms: i64,
    base: Vec<f64>,
    forecast: ForecastRecord,
    label: usize,
    realized_returns: Vec<f64>,
}
#[derive(Serialize, Deserialize)]
struct FeatureCache {
    source_sha256: String,
    forecast_sha256: String,
    schema_sha256: String,
    stride_hours: usize,
    records: Vec<Record>,
    skipped_invalid_forecasts: usize,
}
struct Source {
    symbol: String,
    path: PathBuf,
    sha256: String,
    rows: Vec<Value>,
    history: Value,
    history_sha256: Option<String>,
}
#[derive(Clone)]
struct Sample {
    symbol: String,
    origin_ms: i64,
    label: usize,
    base: Vec<f64>,
    augmented: Vec<f64>,
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("Create immutable {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_new(path, &serde_json::to_vec_pretty(value)?)
}
fn confined(directory: &Path, relative: &str) -> Result<PathBuf> {
    let root = directory.canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    ensure!(
        path.starts_with(&root),
        "Dataset path escapes collection directory"
    );
    Ok(path)
}
fn source(directory: &Path, item: &Value, end_ms: i64) -> Result<Source> {
    let symbol = item["symbol"]
        .as_str()
        .context("Missing symbol")?
        .to_owned();
    nofx_core::exchange::valid_symbol(&symbol)?;
    let path = confined(
        directory,
        item["path"].as_str().context("Missing candle path")?,
    )?;
    let bytes = fs::read(&path)?;
    let sha256 = digest(&bytes);
    ensure!(
        item["sha256"] == sha256,
        "Candle source checksum changed for {symbol}"
    );
    let doc: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        doc["symbol"] == symbol && doc["metadata"]["end_exclusive_ms"] == end_ms,
        "Candle source identity/boundary mismatch"
    );
    let rows = doc["datasets"]["1h"]
        .as_array()
        .context("No hourly candles")?
        .clone();
    ml_features::validate_hourly(&rows)?;
    ensure!(
        rows.len() > CONTEXT + HORIZON,
        "Insufficient monthly candles"
    );
    for row in &rows {
        ensure!(
            row["confirmed"] == true
                && row["openTime"].as_i64().is_some_and(|t| t + HOUR <= end_ms),
            "Unclosed or future source row"
        );
    }
    let (history, history_sha256) = if let Some(relative) = item["history_path"].as_str() {
        let path = confined(directory, relative)?;
        let bytes = fs::read(path)?;
        let hash = digest(&bytes);
        let doc: Value = serde_json::from_slice(&bytes)?;
        ensure!(doc["symbol"] == symbol, "Historical source symbol mismatch");
        if let Some(expected) = item["history_sha256"].as_str() {
            ensure!(expected == hash, "Historical source checksum mismatch");
        }
        (doc, Some(hash))
    } else {
        (Value::Null, None)
    };
    Ok(Source {
        symbol,
        path,
        sha256,
        rows,
        history,
        history_sha256,
    })
}
fn prepare(
    source: &Source,
    args: &Args,
    split: &Split,
    model: &mut ChronosModel,
    forecast_sha: &str,
    cache_dir: &Path,
) -> Result<FeatureCache> {
    let path = cache_dir.join(format!("{}.json", source.symbol));
    if path.exists() {
        let cache: FeatureCache = serde_json::from_slice(&fs::read(&path)?)?;
        ensure!(
            cache.source_sha256 == source.sha256
                && cache.forecast_sha256 == forecast_sha
                && cache.schema_sha256 == ml_monthly::schema_sha256()
                && cache.stride_hours == args.stride_hours,
            "Feature cache fingerprint changed; use fresh --cache-dir"
        );
        return Ok(cache);
    }
    let mut records = Vec::new();
    let mut skipped = 0;
    for end in CONTEXT..=source.rows.len() - HORIZON {
        let origin = source.rows[end - 1]["openTime"].as_i64().unwrap() + HOUR;
        if split.part(origin).is_none()
            || (origin - split.start_ms).rem_euclid(args.stride_hours as i64 * HOUR) != 0
        {
            continue;
        }
        let prefix = &source.rows[end - CONTEXT..end];
        let input = ContextRecord {
            symbol: source.symbol.clone(),
            origin_ms: origin,
            context_end_open_ms: origin - HOUR,
            context: prefix
                .iter()
                .map(|r| number(&r["close"], f64::NAN) as f32)
                .collect(),
            context_open_ms: Some(
                prefix
                    .iter()
                    .map(|r| r["openTime"].as_i64().unwrap())
                    .collect(),
            ),
            history_sha256: Some(digest(&serde_json::to_vec(prefix)?)),
        };
        let forecast = match model.forecast(&input).and_then(|forecast| {
            ml_features::chronos_features(&forecast)?;
            Ok(forecast)
        }) {
            Ok(forecast) => forecast,
            Err(error) => {
                skipped += 1;
                eprintln!(
                    "{} {origin}: excluded invalid forecast: {error}",
                    source.symbol
                );
                continue;
            }
        };
        let current = number(&source.rows[end - 1]["close"], f64::NAN);
        records.push(Record {
            symbol: source.symbol.clone(),
            end,
            origin_ms: origin,
            base: ml_monthly::extended_features(&source.rows, end)?,
            forecast,
            label: ml_features::label(&source.rows, end).context("Unmatured label")?,
            realized_returns: source.rows[end..end + HORIZON]
                .iter()
                .map(|r| number(&r["close"], f64::NAN) / current - 1.)
                .collect(),
        });
    }
    let cache = FeatureCache {
        source_sha256: source.sha256.clone(),
        forecast_sha256: forecast_sha.into(),
        schema_sha256: ml_monthly::schema_sha256(),
        stride_hours: args.stride_hours,
        records,
        skipped_invalid_forecasts: skipped,
    };
    write_json(&path, &cache)?;
    Ok(cache)
}
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.
    }
}
fn pinball(records: &[&Record], calibration: &Calibration) -> Result<f64> {
    ensure!(!records.is_empty(), "Empty forecast evaluation partition");
    let mut total = 0.;
    for row in records {
        let forecast = ml_monthly::calibrate_forecast(&row.forecast, calibration)?;
        for (quantile, prices) in [
            (0.1, &forecast.q10),
            (0.5, &forecast.q50),
            (0.9, &forecast.q90),
        ] {
            for (hour, price) in prices.iter().enumerate() {
                let error = row.realized_returns[hour] - (price / forecast.current_price - 1.);
                total += if error >= 0. {
                    quantile * error
                } else {
                    (quantile - 1.) * error
                };
            }
        }
    }
    Ok(total / (records.len() * 3 * HORIZON) as f64)
}
fn forecast_metrics(records: &[&Record], calibration: &Calibration) -> Result<Value> {
    ensure!(!records.is_empty(), "Empty forecast evaluation partition");
    let mut endpoint_mae = 0.;
    let mut direction_count = 0usize;
    let mut direction_hits = 0usize;
    let mut endpoint_coverage = 0usize;
    let mut coverage = 0usize;
    let mut width = 0.;
    for row in records {
        ensure!(
            row.realized_returns.len() == HORIZON
                && row.realized_returns.iter().all(|x| x.is_finite()),
            "Invalid realized forecast targets"
        );
        let forecast = ml_monthly::calibrate_forecast(&row.forecast, calibration)?;
        for hour in 0..HORIZON {
            let actual = row.realized_returns[hour];
            let lower = forecast.q10[hour] / forecast.current_price - 1.;
            let upper = forecast.q90[hour] / forecast.current_price - 1.;
            let hit = lower <= actual && actual <= upper;
            coverage += usize::from(hit);
            width += upper - lower;
            if hour == HORIZON - 1 {
                let predicted = forecast.q50[hour] / forecast.current_price - 1.;
                endpoint_mae += (actual - predicted).abs();
                endpoint_coverage += usize::from(hit);
                if actual != 0. {
                    direction_count += 1;
                    direction_hits +=
                        usize::from(predicted != 0. && predicted.signum() == actual.signum());
                }
            }
        }
    }
    Ok(
        json!({"rows":records.len(),"pinball_return_loss":pinball(records,calibration)?,
        "endpoint_mae_return_fraction":endpoint_mae/records.len() as f64,
        "endpoint_directional_accuracy_percent":(direction_count>0).then(||direction_hits as f64/direction_count as f64*100.),
        "endpoint_direction_evaluated_rows":direction_count,"flat_actual_returns_excluded":records.len()-direction_count,
        "endpoint_interval_coverage_percent":endpoint_coverage as f64/records.len() as f64*100.,
        "all_hours_interval_coverage_percent":coverage as f64/(records.len()*HORIZON) as f64*100.,
        "mean_interval_width_return_fraction":width/(records.len()*HORIZON) as f64,"interval_nominal_coverage_percent":80.}),
    )
}
fn calibrate(records: &[Record], split: &Split) -> Result<(Calibration, Value)> {
    let train: Vec<_> = records
        .iter()
        .filter(|r| split.part(r.origin_ms) == Some("train"))
        .collect();
    let validation: Vec<_> = records
        .iter()
        .filter(|r| split.part(r.origin_ms) == Some("validation"))
        .collect();
    ensure!(
        !train.is_empty() && !validation.is_empty(),
        "Insufficient forecast train/validation rows"
    );
    let mut candidates = vec![Calibration::default()];
    for shrink in [0.25, 0.5, 0.75, 1.] {
        let bias = (0..HORIZON)
            .map(|hour| {
                median(
                    train
                        .iter()
                        .map(|r| {
                            r.realized_returns[hour]
                                - (r.forecast.q50[hour] / r.forecast.current_price - 1.) * shrink
                        })
                        .collect(),
                )
                .clamp(-0.5, 0.5)
            })
            .collect();
        candidates.push(Calibration {
            bias_by_hour: bias,
            shrink,
        });
    }
    let mut best = 0;
    let mut score = f64::INFINITY;
    let mut trials = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let loss = pinball(&validation, candidate)?;
        trials.push(json!({"calibration":candidate,"validation_pinball_return_loss":loss}));
        if loss < score {
            best = index;
            score = loss;
        }
    }
    Ok((
        candidates[best].clone(),
        json!({"method":"train-fitted median fractional residual per forecast hour; validation-selected shrink; ONNX weights unchanged","train_rows":train.len(),"validation_rows":validation.len(),"selected_trial":best,"trials":trials}),
    ))
}
fn matrix(samples: &[&Sample], augmented: bool) -> Vec<Vec<f64>> {
    samples
        .iter()
        .map(|r| {
            if augmented {
                r.augmented.clone()
            } else {
                r.base.clone()
            }
        })
        .collect()
}
fn class_for_decision(decision: &str) -> usize {
    match decision {
        "SELL" => 0,
        "BUY" => 2,
        _ => 1,
    }
}
fn metrics(samples: &[&Sample], probabilities: &[[f64; 3]], policy: &DecisionPolicy) -> Value {
    let mut confusion = [[0usize; 3]; 3];
    let mut policy_confusion = [[0usize; 3]; 3];
    let mut loss = 0.;
    let mut per_symbol: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for (row, p) in samples.iter().zip(probabilities) {
        let predicted = (0..3).max_by(|a, b| p[*a].total_cmp(&p[*b])).unwrap();
        confusion[row.label][predicted] += 1;
        policy_confusion[row.label][class_for_decision(ml_monthly::decide(p, policy))] += 1;
        loss -= p[row.label].clamp(1e-15, 1.).ln();
        let item = per_symbol.entry(&row.symbol).or_default();
        item.0 += usize::from(predicted == row.label);
        item.1 += 1;
    }
    let recalls = |matrix: &[[usize; 3]; 3]| {
        let present: Vec<_> = (0..3)
            .filter_map(|class| {
                let total = matrix[class].iter().sum::<usize>();
                (total > 0).then(|| matrix[class][class] as f64 / total as f64)
            })
            .collect();
        present.iter().sum::<f64>() / present.len() as f64
    };
    let n = samples.len().max(1) as f64;
    let directional = confusion[0].iter().sum::<usize>() + confusion[2].iter().sum::<usize>();
    json!({"rows":samples.len(),"symbols":per_symbol.len(),"accuracy_percent":(0..3).map(|i|confusion[i][i]).sum::<usize>() as f64/n*100.,
        "balanced_accuracy_percent":recalls(&confusion)*100.,"macro_symbol_accuracy_percent":per_symbol.values().map(|(hits,count)|*hits as f64/ *count as f64*100.).sum::<f64>()/per_symbol.len().max(1) as f64,
        "directional_class_accuracy_percent":(directional>0).then(||(confusion[0][0]+confusion[2][2]) as f64/directional as f64*100.),
        "log_loss":loss/n,"policy_accuracy_percent":(0..3).map(|i|policy_confusion[i][i]).sum::<usize>() as f64/n*100.,"policy_balanced_accuracy_percent":recalls(&policy_confusion)*100.,
        "class_order":["SELL","HOLD","BUY"],"confusion":confusion,"policy_confusion":policy_confusion,"overlapping_12h_labels":true})
}
fn select_policy(
    validation: &[&Sample],
    probabilities: &[[f64; 3]],
) -> (DecisionPolicy, Vec<Value>) {
    let mut selected = DecisionPolicy::default();
    let mut best = f64::NEG_INFINITY;
    let mut trials = Vec::new();
    for threshold in [0.45, 0.55, 0.65] {
        for margin in [0.05, 0.10, 0.15] {
            let policy = DecisionPolicy {
                probability_threshold: threshold,
                probability_margin: margin,
            };
            let report = metrics(validation, probabilities, &policy);
            let score = report["policy_balanced_accuracy_percent"].as_f64().unwrap();
            trials.push(json!({"policy":policy,"validation":report}));
            if score > best {
                selected = policy;
                best = score;
            }
        }
    }
    (selected, trials)
}
fn main() -> Result<()> {
    let args = Args::parse();
    let started = Instant::now();
    ensure!(
        (1..=24).contains(&args.stride_hours),
        "Stride must be 1..24 hours"
    );
    let manifest_bytes = fs::read(args.data_dir.join("manifest.json"))?;
    let collection: Value = serde_json::from_slice(&manifest_bytes)?;
    ensure!(
        collection["schema_version"] == 1 && collection["train_ready"] == true,
        "Monthly collector has not published eligible frozen data"
    );
    if args.prepare_only {
        ensure!(
            matches!(
                collection["status"].as_str(),
                Some(
                    "candles_complete"
                        | "candles_complete_with_errors"
                        | "complete"
                        | "complete_with_errors"
                )
            ),
            "Finish hourly collection before forecast preparation"
        );
    } else {
        ensure!(
            collection["history_complete"] == true
                && matches!(
                    collection["status"].as_str(),
                    Some("complete" | "complete_with_errors")
                ),
            "Finish historical collection before final training"
        );
    }
    let start = collection["start_ms"]
        .as_i64()
        .context("Missing training start")?;
    let end = collection["end_ms"]
        .as_i64()
        .or_else(|| collection["end_exclusive_ms"].as_i64())
        .context("Missing frozen end")?;
    ensure!(
        end <= nofx_core::now_ms()
            && start % HOUR == 0
            && end % HOUR == 0
            && end - start >= 20 * 24 * HOUR,
        "Invalid/monthly insufficient frozen window"
    );
    let hours = (end - start) / HOUR;
    let split = Split {
        start_ms: start,
        train_end_ms: start + hours * 6 / 10 * HOUR,
        validation_end_ms: start + hours * 8 / 10 * HOUR,
        test_end_ms: end,
        embargo_hours: HORIZON,
    };
    let items: Vec<Value> = collection["symbols"]
        .as_array()
        .context("Missing symbol manifest")?
        .iter()
        .filter(|r| r["training_eligible"] == true)
        .cloned()
        .collect();
    ensure!(!items.is_empty(), "No eligible symbols collected");
    let forecast_sha = digest(&fs::read(&args.forecast_model)?);
    let mut chronos =
        ChronosModel::load(&args.forecast_model, &args.forecast_runtime, args.threads)?;
    let cache_dir = args
        .cache_dir
        .clone()
        .unwrap_or_else(|| args.data_dir.join("feature-cache"));
    fs::create_dir_all(&cache_dir)?;
    let mut records = Vec::new();
    let mut skipped = 0;
    let mut source_reports = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let source = source(&args.data_dir, item, end)?;
        let cache = prepare(
            &source,
            &args,
            &split,
            &mut chronos,
            &forecast_sha,
            &cache_dir,
        )?;
        skipped += cache.skipped_invalid_forecasts;
        source_reports.push(json!({"symbol":source.symbol,"path":source.path,"sha256":source.sha256,"history_sha256":source.history_sha256,"feature_rows":cache.records.len(),"invalid_forecasts":cache.skipped_invalid_forecasts}));
        records.extend(cache.records);
        println!(
            "{}",
            json!({"stage":"forecast_cache","completed_symbols":index+1,"total_symbols":items.len(),"symbol":source.symbol,"total_forecasts":records.len(),"elapsed_seconds":started.elapsed().as_secs()})
        );
    }
    if args.prepare_only {
        println!(
            "{}",
            json!({"status":"forecast_cache_completed","cache_dir":cache_dir,"records":records.len(),"invalid_forecasts":skipped})
        );
        return Ok(());
    }
    ensure!(
        !args.output_dir.exists(),
        "Preserve immutable trained artifacts: use a fresh --output-dir"
    );
    fs::create_dir_all(&args.output_dir)?;
    let (calibration, calibration_report) = calibrate(&records, &split)?;
    let references = |symbol: &str| -> Result<Vec<Value>> {
        if let Some(item) = items.iter().find(|r| r["symbol"] == symbol) {
            Ok(source(&args.data_dir, item, end)?.rows)
        } else {
            Ok(vec![])
        }
    };
    let btc = references("BTCUSDT")?;
    let eth = references("ETHUSDT")?;
    let market_features_used = !btc.is_empty() || !eth.is_empty();
    let mut historical_features_used = false;
    let mut samples = Vec::new();
    for item in &items {
        let source = source(&args.data_dir, item, end)?;
        for row in records.iter().filter(|r| r.symbol == source.symbol) {
            let mut base = row.base.clone();
            let history = ml_monthly::historical_features(&source.history, row.origin_ms);
            if split.part(row.origin_ms) == Some("train") && history[10..].iter().any(|v| *v == 1.)
            {
                historical_features_used = true;
            }
            base.extend(history);
            base.extend(ml_monthly::market_features(
                &source.rows,
                row.end,
                &btc,
                &eth,
            ));
            let mut augmented = base.clone();
            augmented.extend(ml_features::chronos_features(
                &ml_monthly::calibrate_forecast(&row.forecast, &calibration)?,
            )?);
            ensure!(
                augmented.len() == ml_monthly::feature_names().len(),
                "Monthly training schema mismatch"
            );
            samples.push(Sample {
                symbol: row.symbol.clone(),
                origin_ms: row.origin_ms,
                label: row.label,
                base,
                augmented,
            });
        }
    }
    let train: Vec<_> = samples
        .iter()
        .filter(|r| split.part(r.origin_ms) == Some("train"))
        .collect();
    let validation: Vec<_> = samples
        .iter()
        .filter(|r| split.part(r.origin_ms) == Some("validation"))
        .collect();
    let test: Vec<_> = samples
        .iter()
        .filter(|r| split.part(r.origin_ms) == Some("test"))
        .collect();
    let labels: Vec<_> = train.iter().map(|r| r.label).collect();
    let mut class_counts = [0; 3];
    for label in &labels {
        class_counts[*label] += 1;
    }
    ensure!(
        class_counts.iter().all(|n| *n >= 30) && validation.len() >= 90 && test.len() >= 90,
        "Insufficient global split/class data"
    );
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let default_policy = DecisionPolicy::default();
    let configs = [
        (TRAIN_PARAMETERS.to_owned(), 100),
        (
            TRAIN_PARAMETERS
                .replace("num_leaves=15", "num_leaves=7")
                .replace("max_depth=5", "max_depth=3")
                .replace("min_data_in_leaf=30", "min_data_in_leaf=80"),
            80,
        ),
        (
            TRAIN_PARAMETERS
                .replace("num_leaves=15", "num_leaves=31")
                .replace("max_depth=5", "max_depth=6")
                .replace("min_data_in_leaf=30", "min_data_in_leaf=100"),
            150,
        ),
    ];
    let train_aug = matrix(&train, true);
    let val_aug = matrix(&validation, true);
    let mut trials = Vec::new();
    let mut selected = None;
    let mut best_loss = f64::INFINITY;
    for (index, (parameters, iterations)) in configs.iter().enumerate() {
        let mut model = LightGbmModel::train_config(
            runtime.clone(),
            &train_aug,
            &labels,
            parameters,
            *iterations,
        )?;
        let probabilities = model.predict(&val_aug)?;
        let report = metrics(&validation, &probabilities, &default_policy);
        let loss = report["log_loss"].as_f64().unwrap();
        trials.push(json!({"index":index,"parameters":parameters,"iterations":iterations,"training":model.summary(),"validation":report}));
        println!(
            "{}",
            json!({"stage":"lightgbm_tuning","candidate":index,"validation":report})
        );
        if loss < best_loss {
            best_loss = loss;
            selected = Some((model, index, probabilities));
        }
    }
    let (mut model, selected_trial, val_probabilities) = selected.context("No model selected")?;
    let (policy, policy_trials) = select_policy(&validation, &val_probabilities);
    let train_base = matrix(&train, false);
    let val_base_matrix = matrix(&validation, false);
    let mut baseline_trials = Vec::new();
    let mut baseline_selected = None;
    let mut baseline_best_loss = f64::INFINITY;
    for (index, (parameters, iterations)) in configs.iter().enumerate() {
        let mut candidate = LightGbmModel::train_config(
            runtime.clone(),
            &train_base,
            &labels,
            parameters,
            *iterations,
        )?;
        let probabilities = candidate.predict(&val_base_matrix)?;
        let report = metrics(&validation, &probabilities, &default_policy);
        let loss = report["log_loss"].as_f64().unwrap();
        baseline_trials
            .push(json!({"index":index,"training":candidate.summary(),"validation":report}));
        if loss < baseline_best_loss {
            baseline_best_loss = loss;
            baseline_selected = Some((candidate, index, probabilities));
        }
    }
    let (mut baseline, baseline_selected_trial, val_base) =
        baseline_selected.context("No ablation baseline selected")?;
    let (baseline_policy, baseline_policy_trials) = select_policy(&validation, &val_base);
    let test_base = baseline.predict(&matrix(&test, false))?;
    let test_aug = model.predict(&matrix(&test, true))?;
    let artifact =
        |model: &LightGbmModel, path: &str, names: Vec<String>| -> Result<ModelArtifact> {
            let text = model.model_text()?;
            write_new(&args.output_dir.join(path), text.as_bytes())?;
            Ok(ModelArtifact {
                path: path.into(),
                sha256: digest(text.as_bytes()),
                feature_count: names.len(),
                feature_names: names,
                parameters: model.summary().parameters.clone(),
                iterations: model.summary().iterations,
            })
        };
    let model_artifact = artifact(&model, "global-augmented.txt", ml_monthly::feature_names())?;
    let names = ml_monthly::feature_names();
    let baseline_artifact = artifact(
        &baseline,
        "global-base.txt",
        names[..names.len() - ml_features::CHRONOS_FEATURE_NAMES.len()].to_vec(),
    )?;
    let mut replays = Vec::new();
    let mut total_net = 0.;
    let mut baseline_net = 0.;
    let mut trades = 0usize;
    let mut unresolved = 0usize;
    for item in &items {
        let source = source(&args.data_dir, item, end)?;
        let indices: Vec<_> = test
            .iter()
            .enumerate()
            .filter(|(_, r)| r.symbol == source.symbol)
            .map(|(index, _)| index)
            .collect();
        if indices.is_empty() {
            continue;
        }
        let signals = |probabilities: &[[f64; 3]], policy: &DecisionPolicy| {
            indices.iter().map(|&i| {
                let raw=ml_monthly::decide(&probabilities[i],policy);
                let tail=test[i].origin_ms>=end-SETTLEMENT_TAIL_HOURS*HOUR;
                ReplaySignal {origin_ms:test[i].origin_ms,decision:if tail {"HOLD"} else {raw}.into(),probabilities:ml_features::probabilities_json(&probabilities[i]),plan:None,
                    metadata:json!({"variant":"monthly_test","trained_before_ms":split.train_end_ms,"validation_selected_before_ms":split.validation_end_ms,"raw_model_decision":raw,"settlement_tail":tail,"settlement_tail_hours":SETTLEMENT_TAIL_HOURS})}
            }).collect::<Vec<_>>()
        };
        let risk = ReplayConfig {
            start_ms: split
                .validation_end_ms
                .max(source.rows[0]["openTime"].as_i64().unwrap() + HOUR),
            end_ms: end,
            ..ReplayConfig::default()
        };
        let augmented = ml_replay::replay(
            &source.symbol,
            &source.rows,
            &signals(&test_aug, &policy),
            &risk,
        )?;
        let base = ml_replay::replay(
            &source.symbol,
            &source.rows,
            &signals(&test_base, &baseline_policy),
            &risk,
        )?;
        total_net += number(&augmented["metrics"]["net_pnl_usdt"], 0.);
        baseline_net += number(&base["metrics"]["net_pnl_usdt"], 0.);
        trades += augmented["metrics"]["closed_trades"].as_u64().unwrap_or(0) as usize;
        unresolved += augmented["metrics"]["unresolved_orders"]
            .as_u64()
            .unwrap_or(0) as usize;
        replays.push(json!({"symbol":source.symbol,"augmented":augmented["metrics"],"baseline":base["metrics"]}));
        write_json(
            &args
                .output_dir
                .join("replay")
                .join(format!("{}-augmented.json", source.symbol)),
            &augmented,
        )?;
        write_json(
            &args
                .output_dir
                .join("replay")
                .join(format!("{}-base.json", source.symbol)),
            &base,
        )?;
    }
    let test_forecasts: Vec<_> = records
        .iter()
        .filter(|r| split.part(r.origin_ms) == Some("test"))
        .collect();
    let gate = json!({"status":"research_only","real_trading_enabled":false,"not_a_live_funding_approval":true,"reason":"One monthly global split is insufficient evidence for live rollout; Chronos retained per requested architecture, with ablation reported.","test_shared_engine_net_usdt":total_net,"baseline_shared_engine_net_usdt":baseline_net,"closed_trades":trades,"unresolved_orders":unresolved});
    let test_metrics = metrics(&test, &test_aug, &policy);
    let baseline_test_metrics = metrics(&test, &test_base, &baseline_policy);
    let report = json!({"schema_version":2,"status":"completed","created_at_ms":nofx_core::now_ms(),"split":split,"split_dates":{"start":iso(start),"train_end":iso(split.train_end_ms),"validation_end":iso(split.validation_end_ms),"test_end":iso(end)},"stride_hours":args.stride_hours,"feature_cache_dir":cache_dir.canonicalize()?,
        "symbols":items.len(),"sources":source_reports,"source_manifest_sha256":digest(&manifest_bytes),"training_code_sha256":digest(include_bytes!("nofx-ml-monthly-train.rs")),"train_rows":train.len(),"validation_rows":validation.len(),"test_rows":test.len(),"train_class_counts":class_counts,"invalid_forecasts":skipped,
        "forecast_calibration":calibration_report,"forecast_test":{"raw_pinball_return_loss":pinball(&test_forecasts,&Calibration::default())?,"calibrated_pinball_return_loss":pinball(&test_forecasts,&calibration)?,"raw":forecast_metrics(&test_forecasts,&Calibration::default())?,"calibrated":forecast_metrics(&test_forecasts,&calibration)?},
        "lightgbm_trials":trials,"selected_trial":selected_trial,"policy_trials":policy_trials,"selected_policy":policy,"validation_augmented":metrics(&validation,&val_probabilities,&policy),"validation_baseline":metrics(&validation,&val_base,&baseline_policy),
        "baseline_trials":baseline_trials,"baseline_selected_trial":baseline_selected_trial,"baseline_policy_trials":baseline_policy_trials,"baseline_selected_policy":baseline_policy,
        "test_augmented":test_metrics,"test_baseline":baseline_test_metrics,"historical_features_used":historical_features_used,"market_features_used":market_features_used,"feature_names":ml_monthly::feature_names(),
        "shared_engine_replay":{"scope":"One independent 1000-USDT finite-capital account per symbol, not a shared portfolio; fees/slippage/funding from production simulator","settlement_tail_hours":SETTLEMENT_TAIL_HOURS,"sum_test_net_usdt":total_net,"sum_baseline_net_usdt":baseline_net,"closed_trades":trades,"unresolved_orders":unresolved,"symbols":replays},
        "selection_gate":gate,"limitations":["30-day sample and current tradable universe carry short-history and survivor selection limits","Labels overlap at a 6-hour stride and are dependent","Final test is untouched by this training process; earlier project research has observed BTC/ETH dates in this month","Historical source availability uses conservative collection timestamps; later revisions cannot be reconstructed","Chronos ONNX weights are unchanged: training fits LightGBM plus a validation-selected forecast calibration"],"elapsed_seconds":started.elapsed().as_secs(),"real_trading_enabled":false});
    write_json(&args.output_dir.join("training-report.json"), &report)?;
    let manifest = MonthlyManifest {
        schema_version: 2,
        pipeline: "chronos-bolt-tiny-lightgbm-monthly".into(),
        symbols: items
            .iter()
            .map(|r| r["symbol"].as_str().unwrap().to_owned())
            .collect(),
        model: model_artifact,
        baseline: baseline_artifact,
        forecast: ForecastArtifact {
            model_id: nofx_core::chronos::MODEL_ID.into(),
            path: args.forecast_model.canonicalize()?.to_string_lossy().into(),
            sha256: forecast_sha,
            runtime_path: args
                .forecast_runtime
                .canonicalize()?
                .to_string_lossy()
                .into(),
            weights_updated: false,
        },
        calibration,
        policy,
        split,
        feature_schema_sha256: ml_monthly::schema_sha256(),
        historical_features_used,
        market_features_used,
        chronos_retained: true,
        stride_hours: args.stride_hours,
        source_manifest_sha256: digest(&manifest_bytes),
        training_code_sha256: digest(include_bytes!("nofx-ml-monthly-train.rs")),
        selection_gate: gate,
        risk: serde_json::to_value(ReplayConfig::default())?,
        created_at_ms: nofx_core::now_ms(),
        source_training_report: "training-report.json".into(),
    };
    ml_monthly::validate_manifest(&manifest)?;
    write_json(&args.output_dir.join("manifest.json"), &manifest)?;
    println!(
        "{}",
        json!({"status":"completed","manifest":args.output_dir.join("manifest.json"),"test_augmented":test_metrics,"test_baseline":baseline_test_metrics,"sum_test_net_usdt":total_net,"sum_baseline_net_usdt":baseline_net,"closed_trades":trades,"elapsed_seconds":started.elapsed().as_secs(),"real_trading_enabled":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metrics_expose_minority_class_failure_despite_high_raw_accuracy() {
        let rows: Vec<Sample> = (0..10)
            .map(|i| Sample {
                symbol: "BTCUSDT".into(),
                origin_ms: 0,
                label: if i < 8 { 1 } else { 2 },
                base: vec![],
                augmented: vec![],
            })
            .collect();
        let refs: Vec<_> = rows.iter().collect();
        let p = vec![[0.05, 0.9, 0.05]; 10];
        let result = metrics(&refs, &p, &DecisionPolicy::default());
        assert_eq!(result["accuracy_percent"], 80.);
        assert_eq!(result["balanced_accuracy_percent"], 50.);
        assert_eq!(result["directional_class_accuracy_percent"], 0.);
    }
    #[test]
    fn calibration_median_is_robust_to_extreme_tail() {
        assert_eq!(median(vec![0.01, 0.02, 9.]), 0.02);
        assert_eq!(median(vec![0.01, 0.03]), 0.02);
    }
    #[test]
    fn forecast_metrics_count_flat_forecasts_as_direction_misses_and_report_coverage() {
        let row = Record {
            symbol: "BTCUSDT".into(),
            end: 256,
            origin_ms: 256 * HOUR,
            base: vec![],
            label: 2,
            realized_returns: vec![0.02; HORIZON],
            forecast: ForecastRecord {
                symbol: "BTCUSDT".into(),
                origin_ms: 256 * HOUR,
                context_end_open_ms: 255 * HOUR,
                history_sha256: None,
                current_price: 100.,
                interval: "1h".into(),
                horizon_hours: HORIZON,
                q10: vec![97.; HORIZON],
                q50: vec![100.; HORIZON],
                q90: vec![103.; HORIZON],
                quantile_crossings: 0,
                inference_ms: 0.,
            },
        };
        let report = forecast_metrics(&[&row], &Calibration::default()).unwrap();
        assert_eq!(report["endpoint_directional_accuracy_percent"], 0.);
        assert_eq!(report["endpoint_interval_coverage_percent"], 100.);
        assert_eq!(report["endpoint_mae_return_fraction"], 0.02);
        assert!(
            (report["mean_interval_width_return_fraction"]
                .as_f64()
                .unwrap()
                - 0.06)
                .abs()
                < 1e-12
        );
        let mut flat = row.clone();
        flat.realized_returns = vec![0.; HORIZON];
        assert!(forecast_metrics(&[&flat],&Calibration::default()).unwrap()["endpoint_directional_accuracy_percent"].is_null());
    }
}
