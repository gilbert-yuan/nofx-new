//! Independent stage-one CPU LightGBM training/deployment. This executable does
//! not open Chronos weights, load ONNX Runtime, evaluate strategies, or place orders.
//! Deployment refitting is separate from the purged out-of-sample benchmark.

use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    iso,
    ml_features::{BASE_FEATURE_NAMES, CONTEXT, HORIZON, HOUR, base_features, label},
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmModel, LightGbmRuntime, TRAIN_PARAMETERS},
    ml_replay::ReplayConfig,
    number, simulator,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const DAY: i64 = 86_400_000;
const MIN_CLASS_ROWS: usize = 30;

#[derive(Parser)]
#[command(
    about = "Train independent CPU LightGBM classifiers from frozen hourly data; no Chronos or trading APIs"
)]
struct Args {
    #[arg(long, default_value = "data/ml-market-20261014")]
    data_dir: PathBuf,
    #[arg(
        long,
        default_value = "output/ml-lightgbm-only-20261014/models/deployment"
    )]
    output_dir: PathBuf,
    #[arg(long, value_delimiter = ',', default_value = "BTCUSDT,ETHUSDT")]
    symbols: Vec<String>,
    #[arg(long, default_value_t = 90)]
    train_days: i64,
    #[arg(long, default_value = DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
}

struct HourlySource {
    symbol: String,
    path: PathBuf,
    file_sha256: String,
    hourly_sha256: String,
    content_sha256: String,
    metadata: Value,
    first_open_ms: i64,
    end_ms: i64,
    rows: Vec<Value>,
}

#[derive(Clone, Copy)]
struct TrainingWindow {
    start_ms: i64,
    frozen_end_ms: i64,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn digest_json(value: &impl Serialize) -> Result<String> {
    Ok(digest(&serde_json::to_vec(value)?))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("Create new immutable artifact {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_new_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_new(path, &bytes)
}

fn training_window(frozen_end_ms: i64, days: i64) -> Result<TrainingWindow> {
    ensure!(
        (1..=3650).contains(&days),
        "train-days must be between 1 and 3650"
    );
    ensure!(
        frozen_end_ms > 0 && frozen_end_ms % HOUR == 0,
        "Frozen training cutoff must be hourly aligned"
    );
    let start_ms = frozen_end_ms
        .checked_sub(days.checked_mul(DAY).context("Training window overflow")?)
        .context("Training start overflow")?;
    ensure!(
        start_ms > 0,
        "Training window precedes valid market timestamps"
    );
    Ok(TrainingWindow {
        start_ms,
        frozen_end_ms,
    })
}

fn training_origin(origin_ms: i64, window: TrainingWindow) -> bool {
    origin_ms >= window.start_ms
        && origin_ms % HOUR == 0
        && origin_ms
            .checked_add(HORIZON as i64 * HOUR)
            .is_some_and(|available| available <= window.frozen_end_ms)
}

fn read_source(directory: &Path, symbol: &str) -> Result<HourlySource> {
    let path = directory.join(format!("{symbol}.json"));
    let bytes =
        fs::read(&path).with_context(|| format!("Read frozen source {}", path.display()))?;
    let file_sha256 = digest(&bytes);
    let document: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        document["symbol"] == symbol,
        "Frozen source symbol mismatch for {symbol}"
    );
    let metadata = &document["metadata"];
    ensure!(
        metadata["schema_version"] == 1 && metadata["immutable"] == true,
        "Require the immutable schema-one market collector output"
    );
    ensure!(
        metadata["orders_enabled"] == false && metadata["account_credentials_used"] == false,
        "Market sources must use public data without trading credentials"
    );
    ensure!(
        document["samples"].as_array().is_some_and(Vec::is_empty),
        "Frozen source must not contain fabricated indicator samples"
    );
    let end_ms = metadata["end_exclusive_ms"]
        .as_i64()
        .context("Frozen source has no end_exclusive_ms")?;
    ensure!(
        metadata["as_of_ms"] == end_ms
            && end_ms > 0
            && end_ms % HOUR == 0
            && end_ms <= nofx_core::now_ms(),
        "Frozen market cutoff is inconsistent, unaligned, or in the future"
    );
    let rows = document["datasets"]["1h"]
        .as_array()
        .context("Frozen source has no hourly dataset")?;
    ensure!(
        rows.len() > CONTEXT + HORIZON,
        "Insufficient closed hourly market history"
    );
    let first_open_ms = rows[0]["openTime"]
        .as_i64()
        .context("Invalid first hourly timestamp")?;
    ensure!(
        first_open_ms >= 0 && first_open_ms % HOUR == 0,
        "First hourly candle must be aligned"
    );
    for (index, row) in rows.iter().enumerate() {
        let expected = first_open_ms
            .checked_add(index as i64 * HOUR)
            .context("Hourly timestamp overflow")?;
        ensure!(
            row["openTime"].as_i64() == Some(expected) && expected + HOUR <= end_ms,
            "Hourly source has a missing, duplicate, or future candle at {index}"
        );
        ensure!(
            row["confirmed"] == true && simulator::valid_candle(row),
            "Invalid or unclosed OHLC candle at {index}"
        );
        let volume = number(&row["volume"], f64::NAN);
        ensure!(
            volume.is_finite() && volume >= 0.,
            "Invalid hourly volume at {index}"
        );
    }
    ensure!(
        rows.last().unwrap()["openTime"]
            .as_i64()
            .and_then(|open| open.checked_add(HOUR))
            == Some(end_ms),
        "Hourly history must reach the frozen cutoff exactly"
    );
    let hourly_sha256 = digest_json(rows)?;
    ensure!(
        metadata["timeframes"]["1h"]["sha256"] == hourly_sha256
            && metadata["timeframes"]["1h"]["end_exclusive_ms"] == end_ms,
        "Frozen hourly checksum or boundary mismatch"
    );
    // The collector hashes sorted JSON keys: datasets precedes symbol. Serialize
    // borrowed fields directly to avoid cloning the large minute-candle dataset.
    #[derive(Serialize)]
    struct Content<'a> {
        datasets: &'a Value,
        symbol: &'a str,
    }
    let content_sha256 = digest_json(&Content {
        datasets: &document["datasets"],
        symbol,
    })?;
    ensure!(
        metadata["content_sha256"] == content_sha256,
        "Frozen source content checksum mismatch"
    );
    Ok(HourlySource {
        symbol: symbol.into(),
        path: path.canonicalize()?,
        file_sha256,
        hourly_sha256,
        content_sha256,
        metadata: metadata.clone(),
        first_open_ms,
        end_ms,
        rows: rows.clone(),
    })
}

fn main() -> Result<()> {
    let args = Args::parse();
    let started = Instant::now();
    ensure!(
        !args.output_dir.exists(),
        "Output directory already exists; use a new directory to preserve completed or partial artifacts"
    );
    ensure!(!args.symbols.is_empty(), "At least one symbol is required");
    let mut unique = BTreeSet::new();
    let mut sources = Vec::new();
    for symbol in &args.symbols {
        ensure!(
            matches!(symbol.as_str(), "BTCUSDT" | "ETHUSDT"),
            "Only BTCUSDT and ETHUSDT are supported"
        );
        ensure!(
            unique.insert(symbol.clone()),
            "Duplicate training symbol {symbol}"
        );
        let source = read_source(&args.data_dir, symbol)?;
        let window = training_window(source.end_ms, args.train_days)?;
        ensure!(
            source.first_open_ms <= window.start_ms - CONTEXT as i64 * HOUR,
            "{symbol} source lacks the 256-hour warmup preceding the complete requested training window"
        );
        if let Some(prior) = sources.first() {
            let prior: &HourlySource = prior;
            ensure!(
                source.end_ms == prior.end_ms,
                "All symbols must share one frozen training cutoff"
            );
        }
        sources.push(source);
    }
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    if let Some(parent) = args
        .output_dir
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    // An exclusive directory claim prevents another trainer from overwriting us.
    fs::create_dir(&args.output_dir).context("Claim new deployment output directory")?;
    let mut models = serde_json::Map::new();
    let mut reports = serde_json::Map::new();
    let mut source_reports = serde_json::Map::new();
    for source in sources {
        let window = training_window(source.end_ms, args.train_days)?;
        let feature_started = Instant::now();
        let mut features = Vec::new();
        let mut labels = Vec::new();
        let mut origins = Vec::new();
        let mut class_counts = [0_usize; 3];
        for end in CONTEXT..=source.rows.len() {
            let origin = source.rows[end - 1]["openTime"].as_i64().unwrap() + HOUR;
            if !training_origin(origin, window) {
                continue;
            }
            let class = label(&source.rows, end)
                .context("Matured training origin lacks a complete label")?;
            let row = base_features(&source.rows, end)?;
            ensure!(
                row.len() == BASE_FEATURE_NAMES.len(),
                "Base feature schema mismatch"
            );
            class_counts[class] += 1;
            features.push(row);
            labels.push(class);
            origins.push(origin);
        }
        ensure!(
            class_counts.iter().all(|count| *count >= MIN_CLASS_ROWS),
            "{} requires at least {MIN_CLASS_ROWS} observations per SELL/HOLD/BUY class; got {class_counts:?}",
            source.symbol
        );
        let feature_ms = feature_started.elapsed().as_secs_f64() * 1000.;
        let model = LightGbmModel::train(runtime.clone(), &features, &labels)?;
        let filename = format!("{}-base.txt", source.symbol);
        let model_text = model.model_text()?;
        write_new(&args.output_dir.join(&filename), model_text.as_bytes())?;
        let model_sha256 = digest(model_text.as_bytes());
        models.insert(source.symbol.clone(),json!({
            "base_path":filename,"augmented_path":Value::Null,"selected_variant":"base","trained_before_ms":source.end_ms,
            "base_feature_count":BASE_FEATURE_NAMES.len(),"augmented_feature_count":Value::Null,
            "base_feature_names":BASE_FEATURE_NAMES,"chronos_feature_names":[],"feature_names":BASE_FEATURE_NAMES,
            "base_sha256":model_sha256,"augmented_sha256":Value::Null
        }));
        reports.insert(source.symbol.clone(),json!({
            "training":model.summary(),"feature_compute_ms":feature_ms,"train_days":args.train_days,
            "requested_training_start_ms":window.start_ms,"requested_training_start":iso(window.start_ms),
            "first_training_origin_ms":origins.first(),"last_training_origin_ms":origins.last(),
            "latest_training_label_available_ms":origins.last().map(|origin|origin+HORIZON as i64*HOUR),
            "frozen_end_ms":source.end_ms,"frozen_end":iso(source.end_ms),"base_sha256":model_sha256,
            "class_order":["SELL","HOLD","BUY"],"out_of_sample_evaluated":false
        }));
        source_reports.insert(source.symbol.clone(),json!({
            "path":source.path,"file_sha256":source.file_sha256,"hourly_sha256":source.hourly_sha256,"content_sha256":source.content_sha256,
            "first_open_ms":source.first_open_ms,"first_open":iso(source.first_open_ms),"end_exclusive_ms":source.end_ms,"end_exclusive":iso(source.end_ms),
            "hourly_rows":source.rows.len(),"metadata":source.metadata
        }));
        println!(
            "{}",
            json!({"symbol":source.symbol,"training_rows":features.len(),"class_counts":class_counts,"iterations":model.summary().iterations,
            "training_ms":model.summary().training_ms,"feature_ms":feature_ms,"base_sha256":model_sha256,"chronos_loaded":false,"onnx_runtime_loaded":false})
        );
    }
    let created_at_ms = nofx_core::now_ms();
    let selection_gate = json!({"status":"training_only","out_of_sample_evaluated":false,"chronos_evaluated":false,
        "not_a_live_funding_approval":true,"notice":"This command refits a base classifier for independent stage-one JSON/paper deployment. It does not replace the purged rolling out-of-sample benchmark or approve real trading."});
    let report = json!({"schema_version":1,"status":"completed","created_at_ms":created_at_ms,"created_at":iso(created_at_ms),"train_days":args.train_days,
        "sources":source_reports,"symbols":reports,"parameters":TRAIN_PARAMETERS,"feature_names":BASE_FEATURE_NAMES,
        "label_horizon_hours":HORIZON,"feature_context_hours":CONTEXT,"selection_gate":selection_gate,
        "total_ms":started.elapsed().as_secs_f64()*1000.,"chronos_loaded":false,"onnx_runtime_loaded":false,"real_trading_enabled":false});
    write_new_json(&args.output_dir.join("training-report.json"), &report)?;
    let manifest = json!({"schema_version":1,"symbols":models,"chronos_retained":false,"selection_gate":selection_gate,
        "evaluation_cycle_days":30,"settlement_tail_hours":36,"forecast_model_path":Value::Null,"runtime_path":Value::Null,
        "feature_schema_sha256":digest(include_bytes!("../ml_features.rs")),"training_code_sha256":digest(include_bytes!("nofx-ml-train.rs")),
        "risk":ReplayConfig::default(),"sources":source_reports,"created_at_ms":created_at_ms,"source_training_report":"training-report.json",
        "chronos_loaded":false,"onnx_runtime_loaded":false,"real_trading_enabled":false});
    // Publish the manifest only after every model and its metadata is complete.
    write_new_json(&args.output_dir.join("manifest.json"), &manifest)?;
    println!(
        "{}",
        json!({"deployment_manifest":args.output_dir.join("manifest.json"),"total_ms":started.elapsed().as_secs_f64()*1000.,
        "stage":"lightgbm_only","out_of_sample_evaluated":false,"real_trading_enabled":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn training_includes_exact_matured_cutoff_and_excludes_unavailable_future_labels() {
        let frozen_end = 1000 * DAY;
        let window = training_window(frozen_end, 90).unwrap();
        assert!(training_origin(window.start_ms, window));
        assert!(!training_origin(window.start_ms - HOUR, window));
        assert!(training_origin(frozen_end - HORIZON as i64 * HOUR, window));
        assert!(!training_origin(
            frozen_end - (HORIZON as i64 - 1) * HOUR,
            window
        ));
        assert!(!training_origin(frozen_end, window));
        assert!(!training_origin(window.start_ms + 1, window));
    }

    #[test]
    fn invalid_or_overflowing_windows_fail_before_training() {
        assert!(training_window(1000 * DAY, 0).is_err());
        assert!(training_window(1000 * DAY, i64::MAX).is_err());
        assert!(training_window(1000 * DAY + 1, 90).is_err());
        assert!(training_window(DAY, 90).is_err());
        let window = TrainingWindow {
            start_ms: 0,
            frozen_end_ms: i64::MAX,
        };
        assert!(!training_origin(
            i64::MAX - i64::MAX.rem_euclid(HOUR),
            window
        ));
    }
}
