//! Immutable public-data preparation for execution-aware model optimization.
//!
//! The only future fields retained in `TrainingRecord` are explicit supervised
//! targets. Features are rebuilt from a closed 256-hour prefix, historical
//! observations available by its origin, and matching BTC/ETH prefixes. No
//! account credentials, exchange order clients or runtime configuration are used.
use crate::{
    chronos::{CONTEXT_LENGTH, ChronosModel, ContextRecord, ForecastRecord},
    ml_features::{self, HORIZON, HOUR},
    ml_monthly::{self, Calibration},
    ml_trade_labels::{self, TradeLabel, TradeLabelConfig},
    number, research,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

const CACHE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationConfig {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub forecast_model: PathBuf,
    pub forecast_runtime: PathBuf,
    pub threads: usize,
    pub stride_hours: usize,
    /// Empty means every eligible symbol in this immutable collection.
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingRecord {
    pub symbol: String,
    pub origin_ms: i64,
    pub mature_by_ms: i64,
    /// Execution-aware target in the existing [SELL, HOLD, BUY] ordering.
    /// Excluded counterfactual outcomes remain inference rows with no target.
    pub label: Option<usize>,
    /// Legacy 12h terminal-price target, retained solely for an ablation.
    pub terminal_label: usize,
    /// Current monthly schema with its FINAL Chronos features removed (63 now).
    pub base: Vec<f64>,
    /// Original, uncalibrated Chronos q10/q50/q90 predictions for twelve hours.
    pub forecast: ForecastRecord,
    /// Future twelve-hour close returns; calibration targets, never features.
    pub realized_returns: Vec<f64>,
}

#[derive(Debug)]
pub struct TrainingData {
    pub records: Vec<TrainingRecord>,
    pub symbols: Vec<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub provenance: Value,
}

#[derive(Debug, Clone, Deserialize)]
struct Collection {
    schema_version: u32,
    provider: String,
    status: String,
    #[serde(default)]
    history_complete: bool,
    #[serde(default)]
    history_all_available: bool,
    #[serde(default)]
    restricted_symbols: bool,
    #[serde(default)]
    include_inactive: bool,
    start_ms: i64,
    end_ms: i64,
    end_exclusive_ms: i64,
    lookback_start_ms: i64,
    symbols: Vec<Entry>,
}

#[derive(Debug, Clone, Deserialize)]
struct Entry {
    symbol: String,
    status: String,
    #[serde(default)]
    training_eligible: bool,
    #[serde(default)]
    historical_training_eligible: bool,
    rows: Option<usize>,
    path: Option<String>,
    sha256: Option<String>,
    history_path: Option<String>,
    history_sha256: Option<String>,
    history_status: Option<String>,
    available_end_exclusive_ms: Option<i64>,
}

impl Entry {
    fn eligible(&self) -> bool {
        self.exclusion_reason().is_none()
    }

    fn exclusion_reason(&self) -> Option<&'static str> {
        if !(self.training_eligible || self.historical_training_eligible) {
            Some("collector_ineligible")
        } else if !matches!(
            self.status.as_str(),
            "complete" | "candles_complete" | "historical_inactive"
        ) {
            Some("collector_candles_incomplete")
        } else if self.rows.is_none() {
            Some("collector_row_count_missing")
        } else if self.rows.unwrap() < CONTEXT_LENGTH + 48 {
            Some("insufficient_256h_context_plus_48h_observation")
        } else {
            None
        }
    }
}

struct Source {
    rows: Vec<Value>,
    history: Value,
    available_end_ms: i64,
    descriptor: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuditedOrigin {
    origin_ms: i64,
    /// The full, current shared-engine result is retained for exclusions too.
    trade_label: TradeLabel,
    record: Option<TrainingRecord>,
    forecast_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct SymbolCache {
    schema_version: u32,
    fingerprint: Value,
    origins_sha256: String,
    origins: Vec<AuditedOrigin>,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn value_digest(value: &impl Serialize) -> Result<String> {
    Ok(digest(&serde_json::to_vec(value)?))
}

fn valid_sha(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid SHA-256"
    );
    Ok(())
}

fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str> {
    value.as_deref().with_context(|| format!("Missing {name}"))
}

fn confined(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(
        !relative.is_empty()
            && !relative.contains('\\')
            && !relative.contains(':')
            && Path::new(relative)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Unsafe relative data path"
    );
    let root = root.canonicalize()?;
    let resolved = root.join(relative).canonicalize()?;
    ensure!(
        resolved.is_file() && resolved.starts_with(&root),
        "Data path escapes immutable collection"
    );
    Ok(resolved)
}

fn verified_bytes(path: &Path, expected: &str) -> Result<Vec<u8>> {
    valid_sha(expected)?;
    let bytes = fs::read(path).with_context(|| format!("Read {}", path.display()))?;
    ensure!(
        digest(&bytes) == expected,
        "Immutable checksum mismatch: {}",
        path.display()
    );
    Ok(bytes)
}

fn write_new_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("Missing cache parent")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        drop(file);
        // An atomic new name, never a replace of an existing immutable cache.
        fs::hard_link(&temporary, path)
            .with_context(|| format!("Publish immutable {}", path.display()))?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn validate_collection(collection: &Collection) -> Result<()> {
    ensure!(
        collection.schema_version == 1
            && collection.provider == "Binance Public Data archives"
            && collection.history_complete
            && matches!(
                collection.status.as_str(),
                "complete"
                    | "complete_with_errors"
                    | "candles_complete"
                    | "candles_complete_with_errors"
            ),
        "Collection or historical collection is incomplete/unsupported"
    );
    ensure!(
        collection.lookback_start_ms >= 0
            && collection.lookback_start_ms <= collection.start_ms
            && collection.start_ms < collection.end_ms
            && collection.end_ms == collection.end_exclusive_ms
            && collection.end_ms <= crate::now_ms()
            && [
                collection.lookback_start_ms,
                collection.start_ms,
                collection.end_ms
            ]
            .iter()
            .all(|time| time.rem_euclid(HOUR) == 0),
        "Invalid immutable collection boundaries"
    );
    Ok(())
}

fn select_entries(
    collection: &Collection,
    requested: &[String],
) -> Result<(Vec<String>, BTreeMap<String, Entry>)> {
    let mut entries = BTreeMap::new();
    for entry in &collection.symbols {
        crate::exchange::valid_symbol(&entry.symbol)?;
        ensure!(
            entries
                .insert(entry.symbol.clone(), entry.clone())
                .is_none(),
            "Duplicate collection symbol"
        );
    }
    let symbols: Vec<String> = if requested.is_empty() {
        entries
            .values()
            .filter(|entry| entry.eligible())
            .map(|entry| entry.symbol.clone())
            .collect()
    } else {
        let mut unique = BTreeSet::new();
        for symbol in requested {
            crate::exchange::valid_symbol(symbol)?;
            ensure!(unique.insert(symbol.clone()), "Duplicate requested symbol");
            ensure!(
                entries.get(symbol).is_some_and(Entry::eligible),
                "Requested symbol is absent/ineligible: {symbol}; reason={}",
                entries
                    .get(symbol)
                    .and_then(Entry::exclusion_reason)
                    .unwrap_or("symbol_absent")
            );
        }
        unique.into_iter().collect()
    };
    ensure!(!symbols.is_empty(), "No eligible training symbols");
    for reference in ["BTCUSDT", "ETHUSDT"] {
        ensure!(
            entries.get(reference).is_some_and(Entry::eligible),
            "Missing eligible market reference {reference}"
        );
    }
    Ok((symbols, entries))
}

/// Recheck publisher CHECKSUM files and raw bytes. No raw artifact is written,
/// repaired or downloaded during training preparation.
fn verify_raw_sources(
    root: &Path,
    sources: &Value,
    seen: &mut BTreeMap<String, (String, String)>,
) -> Result<Value> {
    let sources = sources
        .as_array()
        .context("Missing immutable raw sources")?;
    let mut verified = BTreeMap::<String, Value>::new();
    for source in sources {
        let relative = source["zip_path"]
            .as_str()
            .context("Missing raw ZIP path")?;
        ensure!(
            relative.starts_with("raw/data/futures/um/") && relative.ends_with(".zip"),
            "Unsupported raw source path"
        );
        let checksum_relative = source["checksum_path"]
            .as_str()
            .context("Missing raw CHECKSUM path")?;
        ensure!(
            checksum_relative == format!("{relative}.CHECKSUM"),
            "Raw checksum does not match its ZIP"
        );
        let expected = source["sha256"].as_str().context("Missing raw SHA-256")?;
        valid_sha(expected)?;
        let url = format!(
            "https://data.binance.vision/{}",
            relative.strip_prefix("raw/").unwrap()
        );
        ensure!(source["url"] == url, "Unexpected raw archive URL");
        let pair = if let Some(existing) = seen.get(relative) {
            ensure!(existing.0 == expected, "Conflicting raw checksums");
            existing.clone()
        } else {
            let zip_path = confined(root, relative)?;
            let bytes = verified_bytes(&zip_path, expected)?;
            ensure!(
                bytes.len() <= crate::ml_archive::MAX_ZIP_BYTES,
                "Raw ZIP exceeds verified archive size limit"
            );
            let check = fs::read(confined(root, checksum_relative)?)?;
            ensure!(check.len() <= 4096, "Raw checksum is too large");
            let text = std::str::from_utf8(&check)?;
            let tokens: Vec<_> = text.split_whitespace().collect();
            let filename = Path::new(relative)
                .file_name()
                .and_then(|name| name.to_str())
                .context("Invalid raw filename")?;
            ensure!(
                tokens.len() == 2
                    && tokens[0] == expected
                    && tokens[1].trim_start_matches('*') == filename,
                "Publisher CHECKSUM hash or exact filename mismatch"
            );
            let pair = (expected.to_owned(), digest(&check));
            seen.insert(relative.to_owned(), pair.clone());
            pair
        };
        verified.insert(
            relative.into(),
            json!({"zip_sha256":pair.0,"checksum_sha256":pair.1}),
        );
    }
    Ok(serde_json::to_value(verified)?)
}

fn validate_history(history: &Value, entry: &Entry, collection: &Collection) -> Result<()> {
    ensure!(
        history["symbol"] == entry.symbol
            && history["start_ms"] == collection.start_ms
            && history["end_exclusive_ms"] == collection.end_ms
            && matches!(
                history["status"].as_str(),
                Some("complete" | "partial" | "unavailable")
            )
            && entry.history_status.as_deref() == history["status"].as_str()
            && history["datasets"].is_object(),
        "Historical source identity, collection state or boundaries differ"
    );
    ensure!(
        history["content_sha256"] == value_digest(&history["datasets"])?,
        "Historical internal content checksum mismatch"
    );
    for (dataset, values) in history["datasets"].as_object().unwrap() {
        let mut previous = None;
        for row in values
            .as_array()
            .context("Historical dataset must be an array")?
        {
            let available = row["available_at_ms"]
                .as_i64()
                .context("History lacks publisher availability")?;
            let source_time = if dataset == "funding" {
                row["fundingTime"].as_i64()
            } else {
                row["openTime"]
                    .as_i64()
                    .or_else(|| row["timestamp"].as_i64())
            }
            .context("History lacks event timestamp")?;
            let earliest = source_time
                .checked_add(if dataset == "funding" { 0 } else { HOUR })
                .context("History timestamp overflow")?;
            ensure!(
                source_time >= collection.start_ms
                    && source_time < collection.end_ms
                    && available >= earliest
                    && available <= collection.end_ms
                    && previous.is_none_or(|prior| available > prior),
                "Historical observations violate causal availability or ordering"
            );
            previous = Some(available);
        }
    }
    Ok(())
}

fn read_source(root: &Path, entry: &Entry, collection: &Collection) -> Result<Source> {
    ensure!(entry.eligible(), "Ineligible source {}", entry.symbol);
    let candle_hash = required(&entry.sha256, "candle checksum")?;
    let candle_path = confined(root, required(&entry.path, "candle path")?)?;
    let document: Value = serde_json::from_slice(&verified_bytes(&candle_path, candle_hash)?)?;
    ensure!(
        document["symbol"] == entry.symbol
            && document["metadata"]["training_start_ms"] == collection.start_ms
            && document["metadata"]["lookback_start_ms"] == collection.lookback_start_ms
            && document["metadata"]["end_exclusive_ms"] == collection.end_ms
            && document["metadata"]["closed_only"] == true
            && document["metadata"]["immutable"] == true
            && document["metadata"]["content_sha256"] == value_digest(&document["datasets"])?,
        "Candle source identity, bounds or internal checksum differ"
    );
    let rows = document["datasets"]["1h"]
        .as_array()
        .context("Missing real hourly candles")?
        .clone();
    ml_features::validate_hourly(&rows)?;
    ensure!(
        rows.len() >= CONTEXT_LENGTH + 48,
        "Insufficient real hourly context and settlement observations"
    );
    ensure!(
        entry.rows == Some(rows.len()),
        "Collector/source row count mismatch"
    );
    for row in &rows {
        let open = row["openTime"]
            .as_i64()
            .context("Noninteger source timestamp")?;
        ensure!(
            row["confirmed"] == true
                && open >= collection.lookback_start_ms
                && open
                    .checked_add(HOUR)
                    .is_some_and(|close| close <= collection.end_ms),
            "Unclosed or out-of-bounds source candle"
        );
    }
    let available_end_ms = rows.last().unwrap()["openTime"].as_i64().unwrap() + HOUR;
    if entry.status == "historical_inactive" {
        ensure!(
            entry.historical_training_eligible
                && !entry.training_eligible
                && available_end_ms < collection.end_ms
                && entry.available_end_exclusive_ms == Some(available_end_ms)
                && document["metadata"]["available_end_exclusive_ms"] == available_end_ms
                && document["metadata"]["historical_coverage"]["complete"] == true,
            "Inactive source lacks a verified, continuous real-history endpoint"
        );
    } else {
        ensure!(
            available_end_ms == collection.end_ms,
            "Active source does not reach the collection cutoff"
        );
    }
    let history_hash = required(&entry.history_sha256, "history checksum")?;
    let history_path = confined(root, required(&entry.history_path, "history path")?)?;
    let history: Value = serde_json::from_slice(&verified_bytes(&history_path, history_hash)?)?;
    validate_history(&history, entry, collection)?;
    let descriptor = json!({"symbol":entry.symbol,"status":entry.status,"candle_path":entry.path,
        "candle_sha256":candle_hash,"history_path":entry.history_path,"history_sha256":history_hash,
        "history_status":entry.history_status,"history_coverage":history["coverage"],
        "first_open_ms":rows[0]["openTime"],"available_end_exclusive_ms":available_end_ms,
        "rows":rows.len(),"candle_raw_sources":document["metadata"]["sources"],
        "history_raw_sources":history["sources"]});
    Ok(Source {
        rows,
        history,
        available_end_ms,
        descriptor,
    })
}

fn software_sha256() -> String {
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

fn candidate_ends(source: &Source, collection: &Collection, stride_hours: usize) -> Vec<usize> {
    (CONTEXT_LENGTH..=source.rows.len())
        .filter(|end| {
            let origin = source.rows[*end - 1]["openTime"].as_i64().unwrap() + HOUR;
            origin >= collection.start_ms
                && origin < collection.end_ms
                && origin.rem_euclid(stride_hours as i64 * HOUR) == 0
        })
        .collect()
}

fn current_label(source: &Source, symbol: &str, end: usize) -> Result<TradeLabel> {
    let config = TradeLabelConfig::default();
    let origin = source.rows[end - 1]["openTime"].as_i64().unwrap() + HOUR;
    let tail_end = (end + config.observation_hours).min(source.rows.len());
    ml_trade_labels::label_origin(
        symbol,
        &source.rows[end - CONTEXT_LENGTH..tail_end],
        origin,
        source
            .available_end_ms
            .min(origin + config.observation_hours as i64 * HOUR),
        &config,
    )
}

fn context_record(symbol: &str, rows: &[Value], end: usize) -> Result<ContextRecord> {
    let prefix = &rows[end - CONTEXT_LENGTH..end];
    let origin = prefix.last().unwrap()["openTime"].as_i64().unwrap() + HOUR;
    let record = ContextRecord {
        symbol: symbol.into(),
        origin_ms: origin,
        context_end_open_ms: origin - HOUR,
        context: prefix
            .iter()
            .map(|row| number(&row["close"], f64::NAN) as f32)
            .collect(),
        context_open_ms: Some(
            prefix
                .iter()
                .map(|row| row["openTime"].as_i64().unwrap())
                .collect(),
        ),
        history_sha256: Some(value_digest(&prefix)?),
    };
    record.validate()?;
    Ok(record)
}

fn validate_forecast(forecast: &ForecastRecord, context: &ContextRecord) -> Result<()> {
    ensure!(
        forecast.symbol == context.symbol
            && forecast.origin_ms == context.origin_ms
            && forecast.context_end_open_ms == context.context_end_open_ms
            && forecast.history_sha256 == context.history_sha256
            && forecast.current_price == f64::from(*context.context.last().unwrap())
            && forecast.interval == "1h"
            && forecast.inference_ms.is_finite()
            && forecast.inference_ms >= 0.,
        "Forecast does not match its exact f32 closed context"
    );
    ml_features::chronos_features(forecast)?;
    ensure!(
        forecast
            .q10
            .iter()
            .zip(&forecast.q50)
            .zip(&forecast.q90)
            .all(|((low, median), high)| low.is_finite()
                && median.is_finite()
                && high.is_finite()
                && *low > 0.
                && low <= median
                && median <= high),
        "Invalid raw forecast quantiles"
    );
    Ok(())
}

fn make_record(
    source: &Source,
    symbol: &str,
    end: usize,
    label: &TradeLabel,
    forecast: ForecastRecord,
    btc: &[Value],
    eth: &[Value],
) -> Result<TrainingRecord> {
    ensure!(
        label.mature_by_ms <= source.available_end_ms && end + 48 <= source.rows.len(),
        "Inference/calibration row needs a complete observation window"
    );
    let context = context_record(symbol, &source.rows, end)?;
    validate_forecast(&forecast, &context)?;
    // The combined implementation owns field ordering. Remove its entire final
    // Chronos block rather than relying on a hard-coded base-feature count.
    let mut base = ml_monthly::combined_features_with_market(
        &source.rows,
        end,
        &source.history,
        &forecast,
        &Calibration::default(),
        btc,
        eth,
    )?;
    base.truncate(
        base.len()
            .checked_sub(ml_features::CHRONOS_FEATURE_NAMES.len())
            .context("Missing Chronos feature block")?,
    );
    let current = number(&source.rows[end - 1]["close"], f64::NAN);
    let realized_returns: Vec<_> = source.rows[end..end + HORIZON]
        .iter()
        .map(|row| number(&row["close"], f64::NAN) / current - 1.)
        .collect();
    ensure!(
        realized_returns.len() == HORIZON && realized_returns.iter().all(|value| value.is_finite()),
        "Invalid calibration targets"
    );
    Ok(TrainingRecord {
        symbol: symbol.into(),
        origin_ms: context.origin_ms,
        mature_by_ms: label.mature_by_ms,
        label: label.class_index,
        terminal_label: ml_features::label(&source.rows, end)
            .context("Unmatured terminal target")?,
        base,
        forecast,
        realized_returns,
    })
}

fn compare_cached_origin(cached: &AuditedOrigin, current: &TradeLabel) -> Result<()> {
    ensure!(
        cached.origin_ms == current.origin_ms
            && serde_json::to_value(&cached.trade_label)? == serde_json::to_value(current)?,
        "Cached label no longer equals the current shared execution engine"
    );
    let mature = current.label_observed_through_ms >= current.mature_by_ms;
    ensure!(
        mature || (cached.record.is_none() && cached.forecast_error.is_none()),
        "Immature origin must not carry an inference row or forecast error"
    );
    ensure!(
        !mature || (cached.record.is_some() ^ cached.forecast_error.is_some()),
        "Every mature origin must carry an inference row or explicit forecast exclusion"
    );
    Ok(())
}

fn validate_cached_origin(
    cached: &AuditedOrigin,
    source: &Source,
    symbol: &str,
    end: usize,
) -> Result<()> {
    let origin = source.rows[end - 1]["openTime"].as_i64().unwrap() + HOUR;
    let expected_maturity = origin + 48 * HOUR;
    let label = &cached.trade_label;
    ensure!(
        cached.origin_ms == origin
            && label.origin_ms == origin
            && label.feature_cutoff_ms == origin
            && label.symbol == symbol
            && label.schema_version == ml_trade_labels::LABEL_SCHEMA_VERSION
            && label.mature_by_ms == expected_maturity
            && label.label_observed_through_ms == source.available_end_ms.min(expected_maturity)
            && serde_json::to_value(&label.config)?
                == serde_json::to_value(TradeLabelConfig::default())?
            && label.class_index.is_none_or(|class| class < 3)
            && label.eligible == label.class_index.is_some(),
        "Cached origin, label class, maturity or configuration mismatch"
    );
    // Normal resume checks structural/source invariants after the independent
    // byte SHA and software fingerprint have been checked. It does not pretend
    // to compare this cached label with a freshly recomputed execution outcome.
    let mature = label.label_observed_through_ms >= label.mature_by_ms;
    ensure!(
        mature || (cached.record.is_none() && cached.forecast_error.is_none()),
        "Immature origin must not carry an inference row or forecast error"
    );
    ensure!(
        !mature || (cached.record.is_some() ^ cached.forecast_error.is_some()),
        "Every mature origin must carry an inference row or explicit forecast exclusion"
    );
    ensure!(
        label.long.mature_by_ms == expected_maturity
            && label.short.mature_by_ms == expected_maturity,
        "Counterfactual maturity differs from its label"
    );
    if label.eligible {
        ensure!(
            label.long.entered
                && label.short.entered
                && label.long.status == "closed"
                && label.short.status == "closed"
                && label.long.settled
                && label.short.settled
                && label.exclusion_reason.is_none(),
            "Eligible cached label lacks both closed executions"
        );
    }
    if let Some(record) = &cached.record {
        ensure!(
            record.symbol == symbol
                && record.origin_ms == origin
                && record.mature_by_ms == expected_maturity
                && record.label == label.class_index
                && record.terminal_label < 3
                && record.realized_returns.len() == HORIZON
                && record
                    .realized_returns
                    .iter()
                    .all(|value| value.is_finite())
                && record.base.len() + ml_features::CHRONOS_FEATURE_NAMES.len()
                    == ml_monthly::feature_names().len()
                && record.base.iter().all(|value| value.is_finite()),
            "Cached inference row identity, dimensions or targets differ"
        );
        validate_forecast(
            &record.forecast,
            &context_record(symbol, &source.rows, end)?,
        )?;
    }
    Ok(())
}

fn load_symbol_cache(
    path: &Path,
    checksum_path: &Path,
    fingerprint: &Value,
    source: &Source,
    symbol: &str,
    ends: &[usize],
    btc: &[Value],
    eth: &[Value],
) -> Result<SymbolCache> {
    let bytes = fs::read(path)?;
    let recovering = !checksum_path.exists();
    if !recovering {
        let checkpoint: Value = serde_json::from_slice(&fs::read(checksum_path)?)?;
        ensure!(
            checkpoint["fingerprint_sha256"] == value_digest(fingerprint)?,
            "Symbol cache checksum checkpoint identity changed"
        );
        let expected = checkpoint["sha256"]
            .as_str()
            .context("Missing cache byte checksum")?;
        valid_sha(expected)?;
        ensure!(
            digest(&bytes) == expected,
            "Immutable symbol cache byte checksum mismatch"
        );
    }
    let cache: SymbolCache = serde_json::from_slice(&bytes)?;
    ensure!(
        cache.schema_version == CACHE_SCHEMA_VERSION
            && &cache.fingerprint == fingerprint
            && cache.origins_sha256 == value_digest(&cache.origins)?
            && cache.origins.len() == ends.len(),
        "Symbol cache fingerprint, content checksum or coverage changed"
    );
    for (cached, end) in cache.origins.iter().zip(ends) {
        validate_cached_origin(cached, source, symbol, *end)?;
        if recovering {
            // A crash may have published JSON just before its byte-SHA sidecar.
            // Deep-audit only this orphaned symbol: derive labels and all target
            // and feature fields again from verified immutable sources. Ordinary
            // checkpoints never repeat the potentially large execution replay.
            let fresh = current_label(source, symbol, *end)?;
            compare_cached_origin(cached, &fresh)?;
            if let Some(record) = &cached.record {
                let rebuilt = make_record(
                    source,
                    symbol,
                    *end,
                    &fresh,
                    record.forecast.clone(),
                    btc,
                    eth,
                )?;
                ensure!(
                    serde_json::to_value(&rebuilt)? == serde_json::to_value(record)?,
                    "Orphan cache source-derived features or targets changed"
                );
            }
        }
    }
    if recovering {
        write_new_json(
            checksum_path,
            &json!({"sha256":digest(&bytes),
            "fingerprint_sha256":value_digest(fingerprint)?}),
        )?;
        eprintln!("Recovered fully audited orphan cache checkpoint for {symbol}");
    }
    Ok(cache)
}

/// Reload exactly the same real, continuous source used by training. No prices
/// are extended across listing/delisting boundaries. Raw checksums are audited
/// by `prepare_data`; this read-only helper rechecks the source/history SHA and
/// immutable metadata for later shared-engine replay.
pub fn load_training_source(data_dir: &Path, symbol: &str) -> Result<Vec<Value>> {
    crate::exchange::valid_symbol(symbol)?;
    let root = data_dir.canonicalize()?;
    let bytes = fs::read(confined(&root, "manifest.json")?)?;
    let collection: Collection = serde_json::from_slice(&bytes)?;
    validate_collection(&collection)?;
    let matching: Vec<_> = collection
        .symbols
        .iter()
        .filter(|entry| entry.symbol == symbol)
        .collect();
    ensure!(
        matching.len() == 1,
        "Replay symbol absent or duplicated in collection"
    );
    Ok(read_source(&root, matching[0], &collection)?.rows)
}

/// Verify all selected sources before any forecast, then prepare each symbol in
/// a bounded-memory pass. Existing caches are read-only and require exact byte
/// checksums, code/source/model/runtime/cost fingerprints, class/maturity/schema
/// checks and exact context provenance. Labels from the old terminal-only monthly
/// trainer are never accepted. Default resume does not repeat shared execution.
pub fn prepare_data(config: &PreparationConfig) -> Result<TrainingData> {
    ensure!(
        (1..=12).contains(&config.threads),
        "Chronos CPU threads must be 1..=12"
    );
    ensure!(
        (1..=24).contains(&config.stride_hours) && 24 % config.stride_hours == 0,
        "Stride must be a whole-hour divisor of one UTC day"
    );
    let data_dir = config
        .data_dir
        .canonicalize()
        .context("Missing collection directory")?;
    fs::create_dir_all(&config.cache_dir)?;
    let cache_dir = config.cache_dir.canonicalize()?;
    ensure!(
        cache_dir != data_dir
            && !cache_dir.starts_with(data_dir.join("raw"))
            && !cache_dir.starts_with(data_dir.join("symbols"))
            && !cache_dir.starts_with(data_dir.join("history")),
        "Training cache must not replace collection sources"
    );
    let _writer = crate::ml_dataset::collector_lock(&cache_dir)?;
    let manifest_path = confined(&data_dir, "manifest.json")?;
    let manifest_bytes = fs::read(&manifest_path)?;
    let manifest_sha = digest(&manifest_bytes);
    let collection: Collection = serde_json::from_slice(&manifest_bytes)?;
    validate_collection(&collection)?;
    let (symbols, entries) = select_entries(&collection, &config.symbols)?;
    let model_path = config
        .forecast_model
        .canonicalize()
        .context("Missing Chronos model")?;
    let runtime_path = config
        .forecast_runtime
        .canonicalize()
        .context("Missing Chronos runtime")?;
    let model_sha = digest(&fs::read(&model_path)?);
    let runtime_sha = digest(&fs::read(&runtime_path)?);
    let required_symbols: BTreeSet<_> = symbols
        .iter()
        .cloned()
        .chain(["BTCUSDT".into(), "ETHUSDT".into()])
        .collect();
    let mut sources = BTreeMap::new();
    let mut raw_seen = BTreeMap::new();
    let mut btc_rows = Vec::new();
    let mut eth_rows = Vec::new();
    for symbol in &required_symbols {
        let source = read_source(&data_dir, &entries[symbol], &collection)
            .with_context(|| format!("Verify immutable source {symbol}"))?;
        let candle_raw = verify_raw_sources(
            &data_dir,
            &source.descriptor["candle_raw_sources"],
            &mut raw_seen,
        )?;
        ensure!(
            !candle_raw.as_object().unwrap().is_empty(),
            "Hourly source lacks original archive checksums"
        );
        let history_raw = verify_raw_sources(
            &data_dir,
            &source.descriptor["history_raw_sources"],
            &mut raw_seen,
        )?;
        let mut descriptor = source.descriptor.clone();
        descriptor["verified_candle_raw_sha256"] = json!(value_digest(&candle_raw)?);
        descriptor["verified_history_raw_sha256"] = json!(value_digest(&history_raw)?);
        // Paths and hashes suffice in the global provenance; raw detail remains
        // in the immutable collection's individually verified source documents.
        descriptor
            .as_object_mut()
            .unwrap()
            .remove("candle_raw_sources");
        descriptor
            .as_object_mut()
            .unwrap()
            .remove("history_raw_sources");
        sources.insert(symbol.clone(), descriptor);
        if symbol == "BTCUSDT" {
            btc_rows = source.rows;
        } else if symbol == "ETHUSDT" {
            eth_rows = source.rows;
        }
        eprintln!(
            "Verified training source {symbol} ({}/{})",
            sources.len(),
            required_symbols.len()
        );
    }
    let base_names: Vec<_> = ml_monthly::feature_names()
        .into_iter()
        .take(ml_monthly::feature_names().len() - ml_features::CHRONOS_FEATURE_NAMES.len())
        .collect();
    let restricted = !config.symbols.is_empty() || collection.restricted_symbols;
    let collection_selection_exclusions: BTreeMap<_, _> = entries
        .iter()
        .filter_map(|(symbol, entry)| {
            entry
                .exclusion_reason()
                .map(|reason| (symbol.clone(), reason))
        })
        .collect();
    let identity = json!({"schema_version":CACHE_SCHEMA_VERSION,"source_manifest_sha256":manifest_sha,
        "start_ms":collection.start_ms,"end_exclusive_ms":collection.end_ms,
        "symbols":symbols,"restricted_symbols":restricted,"include_inactive":collection.include_inactive,
        "selection_exclusions":collection_selection_exclusions,
        "sources":sources,"forecast_model_sha256":model_sha,"forecast_runtime_sha256":runtime_sha,
        "feature_schema_sha256":ml_monthly::schema_sha256(),"base_feature_names":base_names,
        "preparation_and_execution_code_sha256":software_sha256(),"costs":research::costs(),
        "costs_sha256":value_digest(&research::costs())?,"trade_label_config":TradeLabelConfig::default(),
        "stride_hours":config.stride_hours,"stride_alignment":"origin_ms modulo stride_hours in UTC",
        "forecast_input":"exact256 f32 hourly close prices; all feature timestamps <= origin",
        "label_schema_version":ml_trade_labels::LABEL_SCHEMA_VERSION});
    let identity_path = cache_dir.join("preparation.json");
    if identity_path.exists() {
        let saved: Value = serde_json::from_slice(&fs::read(&identity_path)?)?;
        ensure!(
            saved == identity,
            "Training preparation fingerprint changed; use a fresh cache directory"
        );
    } else {
        write_new_json(&identity_path, &identity)?;
    }
    let identity_sha = value_digest(&identity)?;
    let mut chronos = None;
    let mut records = Vec::new();
    let mut per_symbol = BTreeMap::new();
    let mut cache_hashes = BTreeMap::new();
    let mut total_origins = 0_usize;
    let mut total_excluded = 0_usize;
    let mut total_forecast_exclusions = 0_usize;
    for symbol in &symbols {
        let source = read_source(&data_dir, &entries[symbol], &collection)?;
        let ends = candidate_ends(&source, &collection, config.stride_hours);
        let path = cache_dir.join(format!("{symbol}.json"));
        let checksum_path = cache_dir.join(format!("{symbol}.json.sha256.json"));
        let fingerprint =
            json!({"preparation_sha256":identity_sha,"symbol":symbol,"source":sources[symbol]});
        let existing: Option<SymbolCache> = if path.exists() {
            Some(load_symbol_cache(
                &path,
                &checksum_path,
                &fingerprint,
                &source,
                symbol,
                &ends,
                &btc_rows,
                &eth_rows,
            )?)
        } else {
            None
        };
        let mut audit = Vec::with_capacity(ends.len());
        let mut exclusion_counts = BTreeMap::<String, usize>::new();
        let mut label_counts = [0_usize; 3];
        let mut symbol_forecast_exclusions = 0_usize;
        let mut inference_only_rows = 0_usize;
        for (position, end) in ends.iter().copied().enumerate() {
            let row = if let Some(cache) = &existing {
                let cached = &cache.origins[position];
                cached.clone()
            } else {
                let label = current_label(&source, symbol, end)?;
                let origin = label.origin_ms;
                if label.label_observed_through_ms < label.mature_by_ms {
                    audit.push(AuditedOrigin {
                        origin_ms: origin,
                        trade_label: label,
                        record: None,
                        forecast_error: None,
                    });
                    *exclusion_counts
                        .entry("observation_incomplete".into())
                        .or_default() += 1;
                    continue;
                }
                if chronos.is_none() {
                    chronos = Some(ChronosModel::load(
                        &model_path,
                        &runtime_path,
                        config.threads,
                    )?);
                }
                let context = context_record(symbol, &source.rows, end)?;
                match chronos
                    .as_mut()
                    .unwrap()
                    .forecast(&context)
                    .and_then(|forecast| {
                        validate_forecast(&forecast, &context)?;
                        make_record(&source, symbol, end, &label, forecast, &btc_rows, &eth_rows)
                    }) {
                    Ok(record) => AuditedOrigin {
                        origin_ms: origin,
                        trade_label: label,
                        record: Some(record),
                        forecast_error: None,
                    },
                    Err(error) => AuditedOrigin {
                        origin_ms: origin,
                        trade_label: label,
                        record: None,
                        forecast_error: Some(format!("{error:#}")),
                    },
                }
            };
            if let Some(record) = &row.record {
                if let Some(class) = record.label {
                    label_counts[class] += 1;
                } else {
                    inference_only_rows += 1;
                }
                records.push(record.clone());
            }
            if row.forecast_error.is_some() {
                symbol_forecast_exclusions += 1;
            }
            if !row.trade_label.eligible {
                *exclusion_counts
                    .entry(
                        row.trade_label
                            .exclusion_reason
                            .clone()
                            .unwrap_or_else(|| "excluded".into()),
                    )
                    .or_default() += 1;
            }
            audit.push(row);
        }
        if existing.is_none() {
            let cache = SymbolCache {
                schema_version: CACHE_SCHEMA_VERSION,
                fingerprint,
                origins_sha256: value_digest(&audit)?,
                origins: audit,
            };
            write_new_json(&path, &cache)?;
            write_new_json(
                &checksum_path,
                &json!({"sha256":digest(&fs::read(&path)?),
                "fingerprint_sha256":value_digest(&cache.fingerprint)?}),
            )?;
        }
        total_origins += ends.len();
        total_excluded += exclusion_counts.values().sum::<usize>();
        total_forecast_exclusions += symbol_forecast_exclusions;
        cache_hashes.insert(symbol.clone(), digest(&fs::read(&path)?));
        per_symbol.insert(
            symbol.clone(),
            json!({"candidate_origins":ends.len(),"class_counts":label_counts,
            "label_exclusions":exclusion_counts,"forecast_exclusions":symbol_forecast_exclusions,
            "inference_only_rows":inference_only_rows}),
        );
        eprintln!(
            "Prepared {symbol}: {} supervised rows, {inference_only_rows} inference-only rows, {} label exclusions, {symbol_forecast_exclusions} forecast exclusions",
            label_counts.iter().sum::<usize>(),
            exclusion_counts.values().sum::<usize>()
        );
    }
    ensure!(
        digest(&fs::read(&manifest_path)?) == manifest_sha,
        "Collection manifest changed during preparation"
    );
    ensure!(
        digest(&fs::read(&model_path)?) == model_sha
            && digest(&fs::read(&runtime_path)?) == runtime_sha,
        "Forecast model/runtime changed during preparation"
    );
    records.sort_by(|a, b| {
        a.origin_ms
            .cmp(&b.origin_ms)
            .then_with(|| a.symbol.cmp(&b.symbol))
    });
    ensure!(
        !records.is_empty(),
        "No mature-window, forecast-valid inference records"
    );
    let provenance = json!({"preparation":identity,"preparation_sha256":identity_sha,
        "cache_sha256":cache_hashes,"per_symbol":per_symbol,"records":records.len(),
        "candidate_origins":total_origins,"label_exclusions":total_excluded,"forecast_exclusions":total_forecast_exclusions,
        "restricted_symbols":restricted,"selected_symbols":symbols.len(),
        "collection_eligible_symbols":entries.values().filter(|entry|entry.eligible()).count(),
        "scope":if restricted {"Explicit restricted symbol subset; not an all-symbol training result"}
            else {"Every eligible symbol in this immutable collection; not every coin worldwide"},
        "history_collection_complete":collection.history_complete,"history_all_available":collection.history_all_available,
        "historical_missing_values":"Preserved as causal availability masks; never forward/backfilled",
        "raw_source_files_verified":raw_seen.len(),"label_execution":"Shared hourly paper replay; Demo scheduling parity not established",
        "future_fields":"label, terminal_label, realized_returns and audit trade outcomes; never included in base",
        "inference_population":"All valid forecasts with a full 48h observation window, including label=None; never filtered by future fills or PnL",
        "class_order":["SELL","HOLD","BUY"],"first_record_origin_ms":records.first().map(|record|record.origin_ms),
        "last_record_origin_ms":records.last().map(|record|record.origin_ms),
        "account_credentials_loaded":false,"orders_enabled":false,"runtime_configuration_modified":false});
    Ok(TrainingData {
        records,
        symbols,
        start_ms: collection.start_ms,
        end_ms: collection.end_ms,
        provenance,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("nofx-training-data-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn confined_sources_reject_parent_absolute_and_windows_drive_paths() {
        let root = directory();
        fs::write(root.join("data.json"), b"{}").unwrap();
        assert!(confined(&root, "data.json").is_ok());
        for path in [
            "../data.json",
            "/data.json",
            "C:/data.json",
            "nested\\data.json",
            "",
        ] {
            assert!(confined(&root, path).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn raw_validation_is_read_only_and_requires_publisher_hash_and_exact_filename() {
        let root = directory();
        let relative = "raw/data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-10-01.zip";
        let zip = root.join(relative);
        fs::create_dir_all(zip.parent().unwrap()).unwrap();
        let bytes = b"PKimmutable checksum fixture";
        let sha = digest(bytes);
        fs::write(&zip, bytes).unwrap();
        let checksum = format!("{sha}  BTCUSDT-1h-2026-10-01.zip\n");
        let check = root.join(format!("{relative}.CHECKSUM"));
        fs::write(&check, &checksum).unwrap();
        let sources = json!([{"zip_path":relative,"checksum_path":format!("{relative}.CHECKSUM"),
            "sha256":sha,"url":format!("https://data.binance.vision/{}",relative.strip_prefix("raw/").unwrap())}]);
        assert!(verify_raw_sources(&root, &sources, &mut BTreeMap::new()).is_ok());
        assert_eq!(fs::read(&zip).unwrap(), bytes);
        fs::write(&check, checksum.replace("BTCUSDT", "ETHUSDT")).unwrap();
        assert!(verify_raw_sources(&root, &sources, &mut BTreeMap::new()).is_err());
        fs::write(&check, &checksum).unwrap();
        fs::write(&zip, b"changed").unwrap();
        assert!(verify_raw_sources(&root, &sources, &mut BTreeMap::new()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_292_hour_eligibility_is_excluded_before_full_source_preparation() {
        let collection:Collection=serde_json::from_value(json!({
            "schema_version":1,"provider":"Binance Public Data archives","status":"complete",
            "history_complete":true,"start_ms":0,"lookback_start_ms":0,
            "end_ms":310*HOUR,"end_exclusive_ms":310*HOUR,
            "symbols":[
                {"symbol":"BTCUSDT","status":"complete","training_eligible":true,"rows":310},
                {"symbol":"ETHUSDT","status":"complete","training_eligible":true,"rows":310},
                {"symbol":"OLDUSDT","status":"historical_inactive","historical_training_eligible":true,"rows":292}
            ]})).unwrap();
        let (symbols, entries) = select_entries(&collection, &[]).unwrap();
        assert_eq!(symbols, vec!["BTCUSDT", "ETHUSDT"]);
        assert_eq!(
            entries["OLDUSDT"].exclusion_reason(),
            Some("insufficient_256h_context_plus_48h_observation")
        );
        let explicit = select_entries(&collection, &["OLDUSDT".into()])
            .unwrap_err()
            .to_string();
        assert!(explicit.contains("insufficient_256h_context_plus_48h_observation"));
    }

    fn source() -> Source {
        let rows = (0..310)
            .map(|hour| {
                json!({"openTime":hour*HOUR,"open":100.,"high":101.,
            "low":99.,"close":100.,"volume":10.,"quoteVolume":1000.,"tradeCount":20,
            "takerBuyVolume":6.,"confirmed":true})
            })
            .collect();
        Source {
            rows,
            history: json!({"datasets":{}}),
            available_end_ms: 310 * HOUR,
            descriptor: Value::Null,
        }
    }

    fn forecast(source: &Source) -> ForecastRecord {
        let context = context_record("BTCUSDT", &source.rows, 256).unwrap();
        ForecastRecord {
            symbol: context.symbol,
            origin_ms: context.origin_ms,
            context_end_open_ms: context.context_end_open_ms,
            history_sha256: context.history_sha256,
            current_price: 100.,
            interval: "1h".into(),
            horizon_hours: 12,
            q10: vec![99.; 12],
            q50: vec![100.; 12],
            q90: vec![101.; 12],
            quantile_crossings: 0,
            inference_ms: 1.,
        }
    }

    #[test]
    fn base_excludes_future_targets_and_keeps_current_schema_order() {
        let mut original = source();
        let label = current_label(&original, "BTCUSDT", 256).unwrap();
        let forecast = forecast(&original);
        let first = make_record(
            &original,
            "BTCUSDT",
            256,
            &label,
            forecast.clone(),
            &original.rows,
            &original.rows,
        )
        .unwrap();
        for row in &mut original.rows[256..] {
            row["close"] = json!(100.5);
            row["high"] = json!(102.);
        }
        original.history =
            json!({"datasets":{"funding":[{"available_at_ms":257*HOUR,"fundingRate":999.}]}});
        let second = make_record(
            &original,
            "BTCUSDT",
            256,
            &label,
            forecast,
            &original.rows,
            &original.rows,
        )
        .unwrap();
        assert_eq!(first.base, second.base);
        assert_ne!(first.realized_returns, second.realized_returns);
        assert_eq!(
            first.base.len() + ml_features::CHRONOS_FEATURE_NAMES.len(),
            ml_monthly::feature_names().len()
        );
    }

    #[test]
    fn cached_targets_are_compared_with_fresh_shared_engine_outcomes() {
        let original = source();
        let label = current_label(&original, "BTCUSDT", 256).unwrap();
        let record = make_record(
            &original,
            "BTCUSDT",
            256,
            &label,
            forecast(&original),
            &original.rows,
            &original.rows,
        )
        .unwrap();
        let mut cached = AuditedOrigin {
            origin_ms: label.origin_ms,
            trade_label: label.clone(),
            record: Some(record),
            forecast_error: None,
        };
        assert!(compare_cached_origin(&cached, &label).is_ok());
        cached.trade_label.class_index = Some(2);
        assert!(compare_cached_origin(&cached, &label).is_err());
        let immature = current_label(&original, "BTCUSDT", 306).unwrap();
        assert!(!immature.eligible);
        let mut excluded = AuditedOrigin {
            origin_ms: immature.origin_ms,
            trade_label: immature.clone(),
            record: None,
            forecast_error: None,
        };
        assert!(compare_cached_origin(&excluded, &immature).is_ok());
        excluded.record = cached.record;
        assert!(compare_cached_origin(&excluded, &immature).is_err());
    }

    #[test]
    fn complete_but_unfilled_future_keeps_an_inference_row_without_a_training_label() {
        let mut original = source();
        for row in &mut original.rows[256..] {
            row["open"] = json!(120.);
            row["high"] = json!(121.);
            row["low"] = json!(119.);
            row["close"] = json!(120.);
        }
        let label = current_label(&original, "BTCUSDT", 256).unwrap();
        assert!(!label.eligible && label.class_index.is_none());
        assert_eq!(label.long.status, "expired");
        let record = make_record(
            &original,
            "BTCUSDT",
            256,
            &label,
            forecast(&original),
            &original.rows,
            &original.rows,
        )
        .unwrap();
        assert_eq!(record.label, None);
        let cached = AuditedOrigin {
            origin_ms: label.origin_ms,
            trade_label: label,
            record: Some(record),
            forecast_error: None,
        };
        validate_cached_origin(&cached, &original, "BTCUSDT", 256).unwrap();
    }

    #[test]
    fn missing_sidecar_recovers_only_after_source_audit_and_existing_wrong_sha_is_rejected() {
        let root = directory();
        let original = source();
        let label = current_label(&original, "BTCUSDT", 256).unwrap();
        let record = make_record(
            &original,
            "BTCUSDT",
            256,
            &label,
            forecast(&original),
            &original.rows,
            &original.rows,
        )
        .unwrap();
        let fingerprint = json!({"preparation_sha256":digest(b"frozen code model costs identity"),
            "source_sha256":value_digest(&original.rows).unwrap()});
        let origins = vec![AuditedOrigin {
            origin_ms: label.origin_ms,
            trade_label: label,
            record: Some(record),
            forecast_error: None,
        }];
        let mut cache = SymbolCache {
            schema_version: CACHE_SCHEMA_VERSION,
            fingerprint: fingerprint.clone(),
            origins_sha256: value_digest(&origins).unwrap(),
            origins,
        };
        let path = root.join("BTCUSDT.json");
        let sidecar = root.join("BTCUSDT.json.sha256.json");
        write_new_json(&path, &cache).unwrap();
        let original_bytes = fs::read(&path).unwrap();
        assert!(!sidecar.exists());
        load_symbol_cache(
            &path,
            &sidecar,
            &fingerprint,
            &original,
            "BTCUSDT",
            &[256],
            &original.rows,
            &original.rows,
        )
        .unwrap();
        assert!(sidecar.exists());
        assert_eq!(fs::read(&path).unwrap(), original_bytes);

        fs::write(
            &sidecar,
            serde_json::to_vec(&json!({"sha256":"0".repeat(64),
            "fingerprint_sha256":value_digest(&fingerprint).unwrap()}))
            .unwrap(),
        )
        .unwrap();
        assert!(
            load_symbol_cache(
                &path,
                &sidecar,
                &fingerprint,
                &original,
                "BTCUSDT",
                &[256],
                &original.rows,
                &original.rows
            )
            .is_err()
        );

        fs::remove_file(&sidecar).unwrap();
        cache.origins[0].record.as_mut().unwrap().base[0] += 1.;
        cache.origins_sha256 = value_digest(&cache.origins).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&cache).unwrap()).unwrap();
        assert!(
            load_symbol_cache(
                &path,
                &sidecar,
                &fingerprint,
                &original,
                "BTCUSDT",
                &[256],
                &original.rows,
                &original.rows
            )
            .is_err()
        );
        assert!(!sidecar.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn forecast_current_price_must_equal_exact_f32_context_without_tolerance() {
        let mut original = source();
        original.rows[255]["close"] = json!(100.1);
        let context = context_record("BTCUSDT", &original.rows, 256).unwrap();
        let mut raw = forecast(&original);
        raw.current_price = f64::from(100.1_f32);
        assert!(validate_forecast(&raw, &context).is_ok());
        raw.current_price = 100.1;
        assert!(validate_forecast(&raw, &context).is_err());
    }
}
