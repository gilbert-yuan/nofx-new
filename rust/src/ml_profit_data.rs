//! Read-only economic targets from an already completed and audited rolling run.
//!
//! The old report, rather than a cache's editable checksum sidecar, anchors every
//! cache byte hash. No raw archives, model runtimes, forecasts or trading engines
//! are executed here. Future outcomes stay separate from the causal input row.
use crate::{
    chronos::CONTEXT_LENGTH,
    ml_dataset,
    ml_features::{self, HORIZON, HOUR},
    ml_monthly,
    ml_trade_labels::{self, DirectionOutcome, TradeLabel, TradeLabelConfig},
    ml_training_data::TrainingRecord,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
};

const MAX_JSON_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ProfitRecord {
    pub record: TrainingRecord,
    /// Shared-engine net USDT divided by the frozen notional ceiling. This is
    /// not a return on actual fill notional, which may be risk-budget limited.
    pub long_target: Option<f64>,
    pub short_target: Option<f64>,
}

#[derive(Debug)]
pub struct ProfitData {
    pub records: Vec<ProfitRecord>,
    pub symbols: Vec<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub provenance: Value,
}

// Field order matches the immutable original's serialization/content digest.
#[derive(Deserialize, Serialize)]
struct AuditedOrigin {
    origin_ms: i64,
    trade_label: TradeLabel,
    record: Option<TrainingRecord>,
    forecast_error: Option<String>,
}

#[derive(Deserialize)]
struct SymbolCache {
    schema_version: u32,
    fingerprint: Value,
    origins_sha256: String,
    origins: Vec<AuditedOrigin>,
}

struct Source {
    rows: Vec<Value>,
    available_end_ms: i64,
    hashes: Value,
}

struct HashingReader<R> {
    inner: R,
    hash: Sha256,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hash.update(&buffer[..read]);
        Ok(read)
    }
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn value_sha(value: &impl Serialize) -> Result<String> {
    Ok(sha(&serde_json::to_vec(value)?))
}

fn valid_sha(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid SHA-256"
    );
    Ok(())
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("Missing string {key}"))
}

fn integer(value: &Value, key: &str) -> Result<i64> {
    value[key]
        .as_i64()
        .with_context(|| format!("Missing integer {key}"))
}

fn confined_file(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(
        !relative.is_empty()
            && !relative.contains('\\')
            && !relative.contains(':')
            && Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Unsafe immutable relative path"
    );
    let path = root.join(relative).canonicalize()?;
    ensure!(
        path.starts_with(root) && path.is_file(),
        "Immutable file escapes its dataset root"
    );
    Ok(path)
}

/// Hash the same byte stream being parsed, without keeping a second raw JSON
/// buffer in memory. The result cannot escape before its external hash matches.
fn verified_json<T: DeserializeOwned>(path: &Path, expected: &str) -> Result<T> {
    valid_sha(expected)?;
    ensure!(
        fs::metadata(path)?.len() <= MAX_JSON_BYTES,
        "Immutable JSON exceeds size limit"
    );
    // Buffer outside the hashing adapter: serde's byte-at-a-time parser then
    // updates SHA only once per block instead of once per JSON byte.
    let mut reader = BufReader::with_capacity(
        128 * 1024,
        HashingReader {
            inner: File::open(path)?,
            hash: Sha256::new(),
        },
    );
    let value = serde_json::from_reader(&mut reader)
        .with_context(|| format!("Parse immutable {}", path.display()))?;
    ensure!(
        hex::encode(reader.into_inner().hash.finalize()) == expected,
        "Original-run byte SHA mismatch: {}",
        path.display()
    );
    Ok(value)
}

fn read_anchor(path: &Path) -> Result<(Value, String)> {
    ensure!(
        fs::metadata(path)?.len() <= MAX_JSON_BYTES,
        "Anchor JSON exceeds size limit"
    );
    let bytes = fs::read(path)?;
    Ok((serde_json::from_slice(&bytes)?, sha(&bytes)))
}

/// Reproduce the old preparation's fingerprint exactly without changing any
/// file whose bytes were incorporated into that fingerprint.
fn original_preparation_code_sha256() -> String {
    let mut hash = Sha256::new();
    hash.update(b"execution-aware-training-data:exact-f64:v1");
    for bytes in [
        include_bytes!("ml_training_data.rs").as_slice(),
        include_bytes!("ml_trade_labels.rs").as_slice(),
        include_bytes!("ml_replay.rs").as_slice(),
        include_bytes!("paper.rs").as_slice(),
        include_bytes!("simulator.rs").as_slice(),
        include_bytes!("strategies.rs").as_slice(),
        include_bytes!("research.rs").as_slice(),
    ] {
        hash.update(bytes);
    }
    hex::encode(hash.finalize())
}

fn strings(value: &Value) -> Result<Vec<String>> {
    value
        .as_array()
        .context("Expected symbol array")?
        .iter()
        .map(|item| Ok(item.as_str().context("Expected symbol string")?.to_owned()))
        .collect()
}

fn selected_symbols(original: &[String], requested: &[String]) -> Result<Vec<String>> {
    let all: BTreeSet<_> = original.iter().cloned().collect();
    ensure!(
        !original.is_empty() && all.len() == original.len(),
        "Original source universe is empty or duplicated"
    );
    for symbol in &all {
        crate::exchange::valid_symbol(symbol)?;
    }
    if requested.is_empty() {
        return Ok(all.into_iter().collect());
    }
    let mut chosen = BTreeSet::new();
    for symbol in requested {
        let normalized = symbol.trim().to_ascii_uppercase();
        crate::exchange::valid_symbol(&normalized)?;
        ensure!(
            all.contains(&normalized) && chosen.insert(normalized),
            "Duplicate or absent original-run symbol {symbol}"
        );
    }
    Ok(chosen.into_iter().collect())
}

fn verify_source(
    root: &Path,
    symbol: &str,
    descriptor: &Value,
    manifest_entry: &Value,
    manifest: &Value,
) -> Result<Source> {
    ensure!(
        descriptor["symbol"] == symbol
            && manifest_entry["symbol"] == symbol
            && descriptor["candle_path"] == manifest_entry["path"]
            && descriptor["candle_sha256"] == manifest_entry["sha256"]
            && descriptor["history_path"] == manifest_entry["history_path"]
            && descriptor["history_sha256"] == manifest_entry["history_sha256"]
            && descriptor["status"] == manifest_entry["status"]
            && descriptor["rows"] == manifest_entry["rows"],
        "Original source descriptor differs from manifest for {symbol}"
    );
    let candle_relative = text(descriptor, "candle_path")?;
    let history_relative = text(descriptor, "history_path")?;
    ensure!(
        candle_relative.starts_with("symbols/") && history_relative.starts_with("history/"),
        "Unexpected normalized source namespace"
    );
    let candle_hash = text(descriptor, "candle_sha256")?;
    let history_hash = text(descriptor, "history_sha256")?;
    let mut candles: Value = verified_json(&confined_file(root, candle_relative)?, candle_hash)?;
    ensure!(
        candles["symbol"] == symbol
            && candles["metadata"]["training_start_ms"] == manifest["start_ms"]
            && candles["metadata"]["lookback_start_ms"] == manifest["lookback_start_ms"]
            && candles["metadata"]["end_exclusive_ms"] == manifest["end_ms"]
            && candles["metadata"]["closed_only"] == true
            && candles["metadata"]["immutable"] == true
            && candles["metadata"]["content_sha256"] == value_sha(&candles["datasets"])?,
        "Normalized candle source identity/content mismatch for {symbol}"
    );
    let rows: Vec<Value> = serde_json::from_value(candles["datasets"]["1h"].take())?;
    ensure!(
        rows.len() >= CONTEXT_LENGTH + 48 && Some(rows.len() as u64) == descriptor["rows"].as_u64(),
        "Normalized candle count mismatch"
    );
    let first = rows.first().context("Missing source candles")?["openTime"]
        .as_i64()
        .context("Invalid first source time")?;
    let available_end_ms = rows.last().unwrap()["openTime"]
        .as_i64()
        .context("Invalid final source time")?
        .checked_add(HOUR)
        .context("Source time overflow")?;
    ensure!(
        descriptor["first_open_ms"] == first
            && descriptor["available_end_exclusive_ms"] == available_end_ms
            && first >= integer(manifest, "lookback_start_ms")?
            && available_end_ms <= integer(manifest, "end_ms")?
            && ml_dataset::candle_coverage(&rows, first, available_end_ms)?.complete,
        "Normalized source has gaps or changed listing boundaries"
    );
    if manifest_entry["status"] == "historical_inactive" {
        ensure!(
            manifest_entry["historical_training_eligible"] == true
                && manifest_entry["training_eligible"] == false
                && available_end_ms < integer(manifest, "end_ms")?
                && manifest_entry["available_end_exclusive_ms"] == available_end_ms
                && candles["metadata"]["available_end_exclusive_ms"] == available_end_ms
                && candles["metadata"]["historical_coverage"]["complete"] == true,
            "Inactive source endpoint no longer agrees with original audit"
        );
    } else {
        ensure!(
            available_end_ms == integer(manifest, "end_ms")?,
            "Active source does not reach the frozen cutoff"
        );
    }
    let history: Value = verified_json(&confined_file(root, history_relative)?, history_hash)?;
    ensure!(
        history["symbol"] == symbol
            && history["start_ms"] == manifest["start_ms"]
            && history["end_exclusive_ms"] == manifest["end_ms"]
            && history["status"] == manifest_entry["history_status"]
            && history["status"] == descriptor["history_status"]
            && history["coverage"] == descriptor["history_coverage"]
            && history["datasets"].is_object()
            && history["content_sha256"] == value_sha(&history["datasets"])?,
        "Normalized history identity/content mismatch for {symbol}"
    );
    // These values were previously audited and are already embedded in causal
    // cached features. Verify availability again without recomputing features.
    for (name, values) in history["datasets"].as_object().unwrap() {
        let mut previous = None;
        for row in values.as_array().context("Nonarray history dataset")? {
            let event = if name == "funding" {
                row["fundingTime"].as_i64()
            } else {
                row["openTime"]
                    .as_i64()
                    .or_else(|| row["timestamp"].as_i64())
            }
            .context("Missing history event time")?;
            let available = integer(row, "available_at_ms")?;
            let earliest = event
                .checked_add(if name == "funding" { 0 } else { HOUR })
                .context("History availability overflow")?;
            ensure!(
                event >= integer(manifest, "start_ms")?
                    && event < integer(manifest, "end_ms")?
                    && available >= earliest
                    && available <= integer(manifest, "end_ms")?
                    && previous.is_none_or(|prior| available > prior),
                "History availability or ordering mismatch"
            );
            previous = Some(available);
        }
    }
    Ok(Source {
        rows,
        available_end_ms,
        hashes: json!({"candle_path":candle_relative,"candle_sha256":candle_hash,
            "history_path":history_relative,"history_sha256":history_hash,
            "verified_candle_raw_sha256":descriptor["verified_candle_raw_sha256"],
            "verified_history_raw_sha256":descriptor["verified_history_raw_sha256"]}),
    })
}

fn validate_optional_amount(value: Option<f64>) -> Result<()> {
    ensure!(
        value.is_none_or(f64::is_finite),
        "Nonfinite direction outcome amount"
    );
    Ok(())
}

/// Outcomes of each side are independently usable, even when the old three-way
/// label was None because the other side never filled. A settled unfilled
/// expiry economically returns zero; an unresolved/missing outcome is not zero.
fn direction_target(
    label: &TradeLabel,
    outcome: &DirectionOutcome,
    decision: &str,
    denominator: f64,
) -> Result<(Option<f64>, &'static str)> {
    ensure!(
        denominator.is_finite()
            && denominator > 0.
            && outcome.decision == decision
            && outcome.mature_by_ms == label.mature_by_ms,
        "Direction target identity or denominator mismatch"
    );
    for amount in [
        outcome.net_usdt,
        outcome.gross_usdt,
        outcome.fees_usdt,
        outcome.funding_usdt,
        outcome.slippage_usdt,
    ] {
        validate_optional_amount(amount)?;
    }
    for amount in [
        outcome.fees_usdt,
        outcome.funding_usdt,
        outcome.slippage_usdt,
    ] {
        ensure!(
            amount.is_none_or(|amount| amount >= 0.),
            "Negative frozen replay cost"
        );
    }
    ensure!(
        outcome.settled == matches!(outcome.status.as_str(), "closed" | "expired"),
        "Terminal outcome and settled flag disagree"
    );
    ensure!(
        outcome.entered == outcome.entry_at_ms.is_some()
            && (!outcome.entered || outcome.submitted)
            && (!outcome.settled || (outcome.submitted && outcome.resolved_at_ms.is_some())),
        "Direction execution flags and timestamps disagree"
    );
    if let Some(entry) = outcome.entry_at_ms {
        ensure!(
            outcome.entered
                && outcome.submitted
                && entry >= label.origin_ms
                && entry <= label.label_observed_through_ms,
            "Invalid direction entry timestamp"
        );
    }
    if let Some(exit) = outcome.exit_at_ms {
        ensure!(
            outcome.entered
                && outcome.entry_at_ms.is_some_and(|entry| exit >= entry)
                && exit <= label.label_observed_through_ms,
            "Invalid direction exit timestamp"
        );
    }
    if let Some(resolved) = outcome.resolved_at_ms {
        ensure!(
            outcome.settled
                && resolved >= label.origin_ms
                && resolved <= label.label_observed_through_ms,
            "Invalid direction resolution timestamp"
        );
    }
    if outcome.status == "closed" {
        ensure!(
            outcome.submitted
                && outcome.entered
                && outcome.settled
                && outcome.entry_at_ms.is_some()
                && outcome.exit_at_ms.is_some()
                && outcome.resolved_at_ms == outcome.exit_at_ms
                && outcome.net_usdt.is_some()
                && outcome.gross_usdt.is_some(),
            "Closed direction lacks complete execution amounts/times"
        );
    }
    if outcome.status == "expired" {
        ensure!(
            outcome.submitted
                && !outcome.entered
                && outcome.settled
                && outcome.entry_at_ms.is_none()
                && outcome.exit_at_ms.is_none()
                && outcome.resolved_at_ms.is_some(),
            "Expired direction is not a settled unfilled order"
        );
        ensure!(
            [
                outcome.net_usdt,
                outcome.gross_usdt,
                outcome.fees_usdt,
                outcome.funding_usdt,
                outcome.slippage_usdt
            ]
            .iter()
            .all(|amount| amount.is_none_or(|amount| amount == 0.)),
            "Unfilled expiry unexpectedly incurred economic amounts"
        );
    }
    if label.label_observed_through_ms < label.mature_by_ms {
        return Ok((None, "observation_incomplete"));
    }
    if outcome.status == "closed" {
        let target = outcome.net_usdt.unwrap() / denominator;
        ensure!(target.is_finite(), "Nonfinite normalized target");
        return Ok((Some(target), "closed_net"));
    }
    if outcome.status == "expired" {
        return Ok((Some(0.), "settled_unfilled_zero"));
    }
    Ok((None, "unresolved_or_unavailable"))
}

fn validate_record(record: &TrainingRecord, label: &TradeLabel, source: &Source) -> Result<()> {
    ensure!(
        record.symbol == label.symbol
            && record.origin_ms == label.origin_ms
            && record.mature_by_ms == label.mature_by_ms
            && label.label_observed_through_ms >= label.mature_by_ms
            && record.label == label.class_index
            && record.label.is_none_or(|class| class < 3)
            && record.terminal_label < 3
            && record.base.len() + ml_features::CHRONOS_FEATURE_NAMES.len()
                == ml_monthly::feature_names().len()
            && record.base.iter().all(|value| value.is_finite())
            && record.realized_returns.len() == HORIZON
            && record
                .realized_returns
                .iter()
                .all(|value| value.is_finite() && *value > -1.),
        "Cached causal row dimensions, targets or maturity differ"
    );
    let origin_index = source
        .rows
        .binary_search_by_key(&label.origin_ms, |row| {
            row["openTime"].as_i64().unwrap() + HOUR
        })
        .map_err(|_| anyhow::anyhow!("Inference origin lacks closed source prefix"))?;
    ensure!(
        origin_index + 1 >= CONTEXT_LENGTH,
        "Inference context is too short"
    );
    let forecast = &record.forecast;
    ensure!(
        forecast.symbol == record.symbol
            && forecast.origin_ms == record.origin_ms
            && forecast.context_end_open_ms == record.origin_ms - HOUR
            && forecast.current_price
                == f64::from(
                    source.rows[origin_index]["close"]
                        .as_f64()
                        .context("Missing source close")? as f32
                )
            && forecast.current_price.is_finite()
            && forecast.current_price > 0.
            && forecast.interval == "1h"
            && forecast.horizon_hours == HORIZON
            && forecast.inference_ms.is_finite()
            && forecast.inference_ms >= 0.,
        "Cached forecast no longer matches the exact closed f32 source context"
    );
    valid_sha(
        forecast
            .history_sha256
            .as_deref()
            .context("Missing audited context SHA")?,
    )?;
    ml_features::chronos_features(forecast)?;
    ensure!(
        forecast
            .q10
            .iter()
            .zip(&forecast.q50)
            .zip(&forecast.q90)
            .all(|((lower, median), upper)| lower.is_finite()
                && median.is_finite()
                && upper.is_finite()
                && *lower > 0.
                && lower <= median
                && median <= upper),
        "Invalid audited forecast quantiles"
    );
    Ok(())
}

/// Reuse mature audited outcomes, not twelve-hour terminal returns, as economic
/// targets. All previously forecast-valid records survive, including label=None.
pub fn load_profit_data(
    previous_run: &Path,
    data_dir: &Path,
    cache_dir: &Path,
    symbols: &[String],
) -> Result<ProfitData> {
    let previous_run = previous_run
        .canonicalize()
        .context("Missing completed previous run")?;
    let data_dir = data_dir
        .canonicalize()
        .context("Missing immutable source dataset")?;
    let cache_dir = cache_dir
        .canonicalize()
        .context("Missing immutable forecast cache")?;
    let report_path = confined_file(&previous_run, "report.json")?;
    let run_path = confined_file(&previous_run, "run-config.json")?;
    let summary_path = confined_file(&previous_run, "preparation.json")?;
    let preparation_path = confined_file(&cache_dir, "preparation.json")?;
    let (report, report_sha) = read_anchor(&report_path)?;
    let (run, run_sha) = read_anchor(&run_path)?;
    let (summary, summary_sha) = read_anchor(&summary_path)?;
    let (preparation, preparation_byte_sha) = read_anchor(&preparation_path)?;
    ensure!(
        report["schema_version"] == 1
            && report["status"] == "completed"
            && report["run_config_sha256"] == value_sha(&run)?,
        "Previous rolling run is not a completed matching run"
    );
    let original = &report["provenance"];
    let preparation_sha = value_sha(&preparation)?;
    ensure!(
        original["preparation"] == preparation
            && original["preparation_sha256"] == preparation_sha
            && summary["provenance"] == *original
            && preparation["schema_version"] == 1
            && preparation["preparation_and_execution_code_sha256"]
                == original_preparation_code_sha256()
            && preparation["feature_schema_sha256"] == ml_monthly::schema_sha256()
            && preparation["label_schema_version"] == ml_trade_labels::LABEL_SCHEMA_VERSION
            && preparation["costs"] == crate::research::costs()
            && preparation["costs"] == run["costs"]
            && preparation["forecast_model_sha256"] == run["forecast_model_sha256"]
            && preparation["forecast_runtime_sha256"] == run["forecast_runtime_sha256"]
            && preparation["costs_sha256"] == value_sha(&preparation["costs"])?,
        "Previous preparation/code/feature/cost identity changed; do not reuse old targets"
    );
    let label_config: TradeLabelConfig =
        serde_json::from_value(preparation["trade_label_config"].clone())?;
    ensure!(
        serde_json::to_value(&label_config)? == serde_json::to_value(TradeLabelConfig::default())?
            && label_config.observation_hours == 48,
        "Profit reuse requires the original frozen 48h label contract"
    );
    let denominator = label_config.replay.max_notional_usdt;
    ensure!(
        denominator.is_finite() && denominator > 0. && denominator <= 50.,
        "Unsafe target notional ceiling"
    );
    let manifest_path = confined_file(&data_dir, "manifest.json")?;
    let manifest_sha = text(&preparation, "source_manifest_sha256")?;
    ensure!(
        run["data_manifest_sha256"] == manifest_sha,
        "Original run/preparation dataset hashes differ"
    );
    let manifest: Value = verified_json(&manifest_path, manifest_sha)?;
    let start_ms = integer(&preparation, "start_ms")?;
    let end_ms = integer(&preparation, "end_exclusive_ms")?;
    ensure!(
        start_ms > 0
            && start_ms < end_ms
            && start_ms % HOUR == 0
            && end_ms % HOUR == 0
            && manifest["schema_version"] == 1
            && manifest["provider"] == "Binance Public Data archives"
            && manifest["history_complete"] == true
            && manifest["start_ms"] == start_ms
            && manifest["end_ms"] == end_ms
            && manifest["end_exclusive_ms"] == end_ms,
        "Original immutable dataset is incomplete or has changed bounds"
    );
    let original_symbols = strings(&preparation["symbols"])?;
    ensure!(
        summary["symbols"] == preparation["symbols"],
        "Previous preparation summary universe changed"
    );
    let chosen = selected_symbols(&original_symbols, symbols)?;
    let mut entries = BTreeMap::new();
    for entry in manifest["symbols"]
        .as_array()
        .context("Missing manifest universe")?
    {
        let symbol = text(entry, "symbol")?;
        ensure!(
            entries.insert(symbol.to_owned(), entry).is_none(),
            "Duplicate manifest symbol"
        );
    }
    let stride = preparation["stride_hours"]
        .as_u64()
        .context("Missing original stride")? as i64;
    ensure!(
        (1..=24).contains(&stride) && 24 % stride == 0 && run["stride_hours"] == stride,
        "Original causal stride changed"
    );
    let required: BTreeSet<_> = chosen
        .iter()
        .cloned()
        .chain(["BTCUSDT".to_owned(), "ETHUSDT".to_owned()])
        .collect();
    let descriptors = preparation["sources"]
        .as_object()
        .context("Missing original source descriptors")?;
    let anchors = original["cache_sha256"]
        .as_object()
        .context("Missing original-report cache hashes")?;
    let mut source_hashes = BTreeMap::new();
    // Verify market references even in a selected-symbol run: their old prefixes
    // contributed to the frozen cached base features.
    for reference in ["BTCUSDT", "ETHUSDT"] {
        if !chosen.iter().any(|symbol| symbol == reference) {
            let source = verify_source(
                &data_dir,
                reference,
                descriptors
                    .get(reference)
                    .context("Missing market source descriptor")?,
                entries
                    .get(reference)
                    .context("Missing market source entry")?,
                &manifest,
            )?;
            source_hashes.insert(reference.to_owned(), source.hashes);
        }
    }
    let mut records = Vec::new();
    let mut per_symbol = BTreeMap::new();
    let mut cache_hashes = BTreeMap::new();
    let mut sidecar_hashes = BTreeMap::new();
    let mut target_counts = BTreeMap::<String, usize>::new();
    let mut unlabelled_records = 0usize;
    for (index, symbol) in chosen.iter().enumerate() {
        let descriptor = descriptors
            .get(symbol)
            .with_context(|| format!("No original descriptor {symbol}"))?;
        let source = verify_source(
            &data_dir,
            symbol,
            descriptor,
            entries.get(symbol).context("Missing manifest source")?,
            &manifest,
        )?;
        source_hashes.insert(symbol.clone(), source.hashes.clone());
        let expected = anchors
            .get(symbol)
            .and_then(Value::as_str)
            .context("Original report lacks cache byte SHA")?;
        let cache_path = confined_file(&cache_dir, &format!("{symbol}.json"))?;
        let sidecar_path = confined_file(&cache_dir, &format!("{symbol}.json.sha256.json"))?;
        let (sidecar, sidecar_sha) = read_anchor(&sidecar_path)?;
        let fingerprint =
            json!({"preparation_sha256":preparation_sha,"symbol":symbol,"source":descriptor});
        ensure!(
            sidecar["sha256"] == expected
                && sidecar["fingerprint_sha256"] == value_sha(&fingerprint)?,
            "Cache sidecar does not match the completed report anchor"
        );
        let cache: SymbolCache = verified_json(&cache_path, expected)?;
        ensure!(
            cache.schema_version == 1
                && cache.fingerprint == fingerprint
                && cache.origins_sha256 == value_sha(&cache.origins)?,
            "Cache fingerprint or internal origin digest differs"
        );
        let expected_origins: Vec<_> = source
            .rows
            .iter()
            .enumerate()
            .filter_map(|(position, row)| {
                let origin = row["openTime"].as_i64().unwrap() + HOUR;
                (position + 1 >= CONTEXT_LENGTH
                    && origin >= start_ms
                    && origin < end_ms
                    && origin % (stride * HOUR) == 0)
                    .then_some(origin)
            })
            .collect();
        ensure!(
            expected_origins.len() == cache.origins.len(),
            "Original cache origin coverage changed"
        );
        let mut inference = 0usize;
        let mut none_labels = 0usize;
        let mut missing_forecasts = 0usize;
        for (mut origin, expected_origin) in cache.origins.into_iter().zip(expected_origins) {
            let label = &origin.trade_label;
            let maturity = expected_origin
                .checked_add(48 * HOUR)
                .context("Target maturity overflow")?;
            ensure!(
                origin.origin_ms == expected_origin
                    && label.origin_ms == expected_origin
                    && label.symbol == *symbol
                    && label.feature_cutoff_ms == expected_origin
                    && label.schema_version == ml_trade_labels::LABEL_SCHEMA_VERSION
                    && label.mature_by_ms == maturity
                    && label.label_observed_through_ms == source.available_end_ms.min(maturity)
                    && label.eligible == label.class_index.is_some()
                    && label.class_index.is_none_or(|class| class < 3)
                    && serde_json::to_value(&label.config)? == preparation["trade_label_config"],
                "Cached target origin/schema/maturity identity changed for {symbol}"
            );
            let (long_target, long_reason) =
                direction_target(label, &label.long, "BUY", denominator)?;
            let (short_target, short_reason) =
                direction_target(label, &label.short, "SELL", denominator)?;
            let mature = label.label_observed_through_ms >= label.mature_by_ms;
            ensure!(
                (mature && (origin.record.is_some() ^ origin.forecast_error.is_some()))
                    || (!mature && origin.record.is_none() && origin.forecast_error.is_none()),
                "Mature origin must have a record or explicit forecast exclusion"
            );
            if let Some(record) = origin.record.take() {
                validate_record(&record, label, &source)?;
                inference += 1;
                if record.label.is_none() {
                    none_labels += 1;
                    unlabelled_records += 1;
                }
                *target_counts
                    .entry(format!("long:{long_reason}"))
                    .or_default() += 1;
                *target_counts
                    .entry(format!("short:{short_reason}"))
                    .or_default() += 1;
                records.push(ProfitRecord {
                    record,
                    long_target,
                    short_target,
                });
            } else if origin.forecast_error.is_some() {
                missing_forecasts += 1;
            }
        }
        let old_counts = &original["per_symbol"][symbol];
        let supervised: usize = old_counts["class_counts"]
            .as_array()
            .context("Missing original class counts")?
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .context("Invalid original class count")
                    .map(|value| value as usize)
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .sum();
        ensure!(
            old_counts["candidate_origins"].as_u64()
                == Some(
                    source
                        .rows
                        .iter()
                        .enumerate()
                        .filter(|(position, row)| {
                            let origin = row["openTime"].as_i64().unwrap() + HOUR;
                            position + 1 >= CONTEXT_LENGTH
                                && origin >= start_ms
                                && origin < end_ms
                                && origin % (stride * HOUR) == 0
                        })
                        .count() as u64
                )
                && old_counts["inference_only_rows"].as_u64() == Some(none_labels as u64)
                && old_counts["forecast_exclusions"].as_u64() == Some(missing_forecasts as u64)
                && supervised + none_labels == inference,
            "Original-run record counts no longer reconcile"
        );
        cache_hashes.insert(symbol.clone(), expected.to_owned());
        sidecar_hashes.insert(symbol.clone(), sidecar_sha);
        per_symbol.insert(symbol.clone(),json!({"inference_rows":inference,"old_label_none_rows":none_labels,
            "forecast_exclusions":missing_forecasts,"available_end_exclusive_ms":source.available_end_ms}));
        eprintln!(
            "Loaded economic targets {symbol} ({}/{}) records={inference} original_label_none={none_labels}",
            index + 1,
            chosen.len()
        );
    }
    ensure!(
        source_hashes.len() == required.len(),
        "Not every causal source/reference was reverified"
    );
    records.sort_by(|a, b| {
        a.record
            .origin_ms
            .cmp(&b.record.origin_ms)
            .then_with(|| a.record.symbol.cmp(&b.record.symbol))
    });
    ensure!(!records.is_empty(), "No original causal inference records");
    if symbols.is_empty() {
        ensure!(
            original["records"].as_u64() == Some(records.len() as u64),
            "Full original inference population changed"
        );
    }
    for (path, expected) in [
        (&report_path, report_sha.as_str()),
        (&run_path, run_sha.as_str()),
        (&summary_path, summary_sha.as_str()),
        (&preparation_path, preparation_byte_sha.as_str()),
        (&manifest_path, manifest_sha),
    ] {
        ensure!(
            ml_dataset::file_digest(path)? == expected,
            "Immutable anchor changed during profit loading"
        );
    }
    let provenance = json!({"schema_version":1,"source_run":previous_run,"source_report_sha256":report_sha,
        "source_run_config_sha256":run_sha,"source_preparation_summary_sha256":summary_sha,
        "source_cache_preparation_byte_sha256":preparation_byte_sha,"source_preparation_sha256":preparation_sha,
        "source_manifest_sha256":manifest_sha,"preparation_and_execution_code_sha256":original_preparation_code_sha256(),
        "profit_loader_code_sha256":sha(include_bytes!("ml_profit_data.rs")),
        "feature_schema_sha256":ml_monthly::schema_sha256(),"cache_sha256":cache_hashes,"sidecar_sha256":sidecar_hashes,
        "normalized_sources":source_hashes,"per_symbol":per_symbol,"records":records.len(),"symbols":chosen,
        "start_ms":start_ms,"end_exclusive_ms":end_ms,"stride_hours":stride,"restricted_symbols":!symbols.is_empty(),
        "target":"shared-engine net_usdt divided by frozen max_notional_usdt ceiling",
        "target_denominator_usdt":denominator,"target_is_actual_fill_notional_return":false,
        "target_counts":target_counts,"old_label_none_rows_retained":unlabelled_records,
        "settled_unfilled_expiry_target":0,"unresolved_or_unavailable_target":Value::Null,
        "feature_inputs":"TrainingRecord.base and independently calibrated raw forecast only",
        "future_fields_excluded_from_features":["long_target","short_target","label","terminal_label","realized_returns","trade_label"],
        "target_maturity_hours":48,"chronos_inference_repeated":false,"labels_replayed":false,
        "raw_archives_reaudited":false,"raw_audit_inherited_from_completed_run":original["raw_source_files_verified"],
        "limitations":["Each cached inference origin requires a complete 48-hour observed tail. The final 48 hours of each symbol are unavailable for prediction replay, including delisting tails; this is not a forward reconstruction of delisting risk.",
            "Original label=None records remain inference records. Each economic direction is supervised independently; unresolved or unavailable outcomes are excluded only for that target, never by removing the inference record.",
            "Targets use independent counterfactual symbol accounts and shared paper entry timing. They do not prove shared-capital portfolio performance or immediate Demo execution parity.",
            "All input dates have already been observed historically. Any next evaluation remains historical research until a separately frozen future test.",
            "Raw archive bytes are not reaudited. Completed-run source/cache hashes anchor the reused audit; normalized candle and history files are independently rehashed during this load."],
        "network_requests":false,"account_credentials_used":false,"runtime_modified":false,"orders_enabled":false});
    Ok(ProfitData {
        records,
        symbols: chosen,
        start_ms,
        end_ms,
        provenance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direction(decision: &str, status: &str) -> DirectionOutcome {
        let closed = status == "closed";
        DirectionOutcome {
            decision: decision.into(),
            submitted: true,
            entered: closed,
            settled: true,
            status: status.into(),
            reason: Some(if closed { "timeout" } else { "pending_expired" }.into()),
            net_usdt: closed.then_some(-2.5),
            gross_usdt: closed.then_some(-2.0),
            fees_usdt: Some(if closed { 0.4 } else { 0. }),
            funding_usdt: Some(if closed { 0.1 } else { 0. }),
            slippage_usdt: Some(if closed { 0.2 } else { 0. }),
            entry_at_ms: closed.then_some(101 * HOUR),
            exit_at_ms: closed.then_some(110 * HOUR),
            resolved_at_ms: Some(if closed { 110 * HOUR } else { 124 * HOUR }),
            mature_by_ms: 148 * HOUR,
            exclusion_reason: (!closed).then(|| "not_entered".into()),
            plan: json!({}),
        }
    }

    fn label() -> TradeLabel {
        TradeLabel {
            schema_version: ml_trade_labels::LABEL_SCHEMA_VERSION,
            symbol: "BTCUSDT".into(),
            execution_scope: "paper_hourly_replay".into(),
            origin_ms: 100 * HOUR,
            feature_cutoff_ms: 100 * HOUR,
            mature_by_ms: 148 * HOUR,
            label_observed_through_ms: 148 * HOUR,
            eligible: false,
            class_index: None,
            decision: None,
            exclusion_reason: Some("both_directions_must_enter_and_settle".into()),
            config: TradeLabelConfig::default(),
            long: direction("BUY", "closed"),
            short: direction("SELL", "expired"),
        }
    }

    #[test]
    fn economic_sides_are_independent_and_expiry_zero_does_not_require_old_class_label() {
        let row = label();
        assert_eq!(row.class_index, None);
        assert_eq!(
            direction_target(&row, &row.long, "BUY", 50.).unwrap(),
            (Some(-0.05), "closed_net")
        );
        assert_eq!(
            direction_target(&row, &row.short, "SELL", 50.).unwrap(),
            (Some(0.), "settled_unfilled_zero")
        );
        let mut unresolved = row.short.clone();
        unresolved.status = "pending".into();
        unresolved.settled = false;
        unresolved.resolved_at_ms = None;
        assert_eq!(
            direction_target(&row, &unresolved, "SELL", 50.).unwrap(),
            (None, "unresolved_or_unavailable")
        );
        assert!(direction_target(&row, &row.long, "SELL", 50.).is_err());
    }

    #[test]
    fn early_exit_cannot_shortcut_maturity_or_turn_invalid_expiry_into_zero() {
        let mut row = label();
        row.label_observed_through_ms = 130 * HOUR;
        assert_eq!(
            direction_target(&row, &row.long, "BUY", 50.).unwrap().0,
            None
        );
        row.label_observed_through_ms = 148 * HOUR;
        row.short.net_usdt = Some(1.);
        assert!(direction_target(&row, &row.short, "SELL", 50.).is_err());
        row.short = direction("SELL", "expired");
        row.short.resolved_at_ms = Some(149 * HOUR);
        assert!(direction_target(&row, &row.short, "SELL", 50.).is_err());
        row.long.net_usdt = Some(f64::NAN);
        assert!(direction_target(&row, &row.long, "BUY", 50.).is_err());
    }

    #[test]
    fn byte_anchor_rejects_self_consistent_mutation_instead_of_trusting_sidecar() {
        let root =
            std::env::temp_dir().join(format!("nofx-profit-anchor-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("cache.json");
        let original = br#"{"net":1.0}"#;
        fs::write(&path, original).unwrap();
        let anchor = sha(original);
        assert_eq!(verified_json::<Value>(&path, &anchor).unwrap()["net"], 1.);
        fs::write(&path, br#"{"net":100.0}"#).unwrap();
        assert!(verified_json::<Value>(&path, &anchor).is_err());
        assert!(confined_file(&root, "../outside.json").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn symbol_subset_cannot_silently_duplicate_or_add_unseen_coins() {
        let original = vec!["BTCUSDT".into(), "ETHUSDT".into()];
        assert_eq!(
            selected_symbols(&original, &["ethusdt".into()]).unwrap(),
            vec!["ETHUSDT"]
        );
        assert!(selected_symbols(&original, &["ETHUSDT".into(), "ethusdt".into()]).is_err());
        assert!(selected_symbols(&original, &["SOLUSDT".into()]).is_err());
    }
}
