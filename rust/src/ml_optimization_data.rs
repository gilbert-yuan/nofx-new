//! Verified, read-only reconstruction of frozen model probabilities for optimization.
//! Cached labels, realized returns, and cached feature vectors are deliberately not read.
use crate::{
    chronos::{CONTEXT_LENGTH, ForecastRecord},
    ml_features,
    ml_lightgbm::{LightGbmModel, LightGbmRuntime},
    ml_monthly::{self, MonthlyManifest},
    ml_optimization::{ProbabilityPoint, SymbolData},
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
struct CollectorManifest {
    schema_version: u32,
    status: String,
    train_ready: bool,
    history_complete: bool,
    start_ms: i64,
    end_ms: i64,
    end_exclusive_ms: i64,
    lookback_start_ms: i64,
    symbols: Vec<CollectorEntry>,
}

#[derive(Clone, Deserialize)]
struct CollectorEntry {
    symbol: String,
    #[serde(default)]
    training_eligible: bool,
    path: Option<String>,
    sha256: Option<String>,
    history_path: Option<String>,
    history_sha256: Option<String>,
}

/// Only these fields participate in inference; serde ignores labels and outcomes.
#[derive(Deserialize)]
struct CachedForecast {
    symbol: String,
    end: usize,
    origin_ms: i64,
    forecast: ForecastRecord,
}

#[derive(Deserialize)]
struct ForecastCache {
    source_sha256: String,
    forecast_sha256: String,
    schema_sha256: String,
    stride_hours: usize,
    records: Vec<CachedForecast>,
}

pub struct DataLoader {
    manifest: MonthlyManifest,
    model: LightGbmModel,
    data_dir: PathBuf,
    cache_dir: PathBuf,
    entries: BTreeMap<String, CollectorEntry>,
    collector_start_ms: i64,
    collector_end_ms: i64,
    lookback_start_ms: i64,
    btc_rows: Vec<Value>,
    eth_rows: Vec<Value>,
    model_manifest_sha256: String,
    runtime_sha256: String,
    loaded_cache_sha256: BTreeMap<String, String>,
}

impl DataLoader {
    pub fn open(
        model_dir: &Path,
        data_dir: &Path,
        cache_dir: &Path,
        runtime_path: &Path,
    ) -> Result<Self> {
        let model_dir = model_dir
            .canonicalize()
            .context("Model directory missing")?;
        let data_dir = data_dir
            .canonicalize()
            .context("Collector directory missing")?;
        let cache_dir = cache_dir
            .canonicalize()
            .context("Forecast cache directory missing")?;
        let manifest_bytes = fs::read(confined_path(&model_dir, "manifest.json")?)?;
        let manifest: MonthlyManifest = serde_json::from_slice(&manifest_bytes)
            .context("Invalid typed monthly model manifest")?;
        ml_monthly::validate_manifest(&manifest)?;
        let mut seen = BTreeSet::new();
        for symbol in &manifest.symbols {
            crate::exchange::valid_symbol(symbol)?;
            ensure!(seen.insert(symbol), "Duplicate trained symbol: {symbol}");
        }
        let model_bytes = verified_bytes(
            &confined_path(&model_dir, &manifest.model.path)?,
            &manifest.model.sha256,
        )?;
        verified_bytes(
            &confined_path(&model_dir, &manifest.baseline.path)?,
            &manifest.baseline.sha256,
        )?;
        // Existing trained manifests explicitly name an absolute ONNX artifact.
        // Verify its bytes without loading the Chronos runtime or invoking it.
        let forecast_path = Path::new(&manifest.forecast.path);
        let forecast_path = if forecast_path.is_absolute() {
            forecast_path
                .canonicalize()
                .context("Chronos artifact missing")?
        } else {
            confined_path(&model_dir, &manifest.forecast.path)?
        };
        verified_bytes(&forecast_path, &manifest.forecast.sha256)?;
        let collection_bytes = verified_bytes(
            &confined_path(&data_dir, "manifest.json")?,
            &manifest.source_manifest_sha256,
        )?;
        let collection: CollectorManifest = serde_json::from_slice(&collection_bytes)
            .context("Invalid typed collector manifest")?;
        validate_collection(&collection, &manifest)?;
        let mut entries = BTreeMap::new();
        for entry in collection.symbols {
            crate::exchange::valid_symbol(&entry.symbol)?;
            ensure!(
                entries.insert(entry.symbol.clone(), entry).is_none(),
                "Duplicate collector symbol"
            );
        }
        for symbol in manifest
            .symbols
            .iter()
            .map(String::as_str)
            .chain(["BTCUSDT", "ETHUSDT"])
        {
            let entry = entries
                .get(symbol)
                .with_context(|| format!("Collector lacks {symbol}"))?;
            ensure!(
                entry.training_eligible,
                "Ineligible collector symbol: {symbol}"
            );
            required(&entry.path, "candle path")?;
            valid_sha256(required(&entry.sha256, "candle SHA-256")?)?;
            required(&entry.history_path, "history path")?;
            valid_sha256(required(&entry.history_sha256, "history SHA-256")?)?;
        }
        // Both references go through the same source and history checks as targets.
        let btc_rows = read_source(
            &data_dir,
            &entries["BTCUSDT"],
            collection.start_ms,
            collection.end_ms,
            collection.lookback_start_ms,
        )?
        .0;
        let eth_rows = read_source(
            &data_dir,
            &entries["ETHUSDT"],
            collection.start_ms,
            collection.end_ms,
            collection.lookback_start_ms,
        )?
        .0;
        let runtime_path = runtime_path
            .canonicalize()
            .context("LightGBM runtime missing")?;
        let runtime_sha256 = digest(&fs::read(&runtime_path)?);
        let runtime = LightGbmRuntime::load(&runtime_path)?;
        let model = LightGbmModel::load(runtime, std::str::from_utf8(&model_bytes)?)?;
        ensure!(
            model.summary().feature_count == manifest.model.feature_count,
            "Native model feature count differs from manifest"
        );
        Ok(Self {
            manifest,
            model,
            data_dir,
            cache_dir,
            entries,
            collector_start_ms: collection.start_ms,
            collector_end_ms: collection.end_ms,
            lookback_start_ms: collection.lookback_start_ms,
            btc_rows,
            eth_rows,
            model_manifest_sha256: digest(&manifest_bytes),
            runtime_sha256,
            loaded_cache_sha256: BTreeMap::new(),
        })
    }

    pub fn symbols(&self) -> &[String] {
        &self.manifest.symbols
    }

    pub fn manifest(&self) -> &MonthlyManifest {
        &self.manifest
    }

    pub fn provenance(&self) -> Value {
        json!({
            "model_manifest_sha256": self.model_manifest_sha256,
            "model_sha256": self.manifest.model.sha256,
            "forecast_sha256": self.manifest.forecast.sha256,
            "source_manifest_sha256": self.manifest.source_manifest_sha256,
            "feature_schema_sha256": self.manifest.feature_schema_sha256,
            "lightgbm_runtime_sha256": self.runtime_sha256,
            "stride_hours": self.manifest.stride_hours,
            "prediction_start_ms": self.manifest.split.validation_end_ms,
            "source_end_exclusive_ms": self.collector_end_ms,
            "loaded_cache_sha256": self.loaded_cache_sha256,
            "feature_source": "Reconstructed closed-prefix public monthly feature functions; cached labels, outcomes and feature vectors excluded",
            "forecast_source": "Existing trusted frozen Chronos forecast cache with source, model, schema, stride and context SHA-256 checks",
            "evaluation_status": "Previously observed historical test window, not unseen out-of-sample data",
            "chronos_invoked": false,
            "model_weights_updated": false,
            "account_credentials_loaded": false,
            "orders_enabled": false
        })
    }

    pub fn load(&mut self, symbol: &str) -> Result<SymbolData> {
        crate::exchange::valid_symbol(symbol)?;
        ensure!(
            self.manifest.symbols.iter().any(|s| s == symbol),
            "Symbol outside trained universe"
        );
        let entry = self
            .entries
            .get(symbol)
            .context("Missing trained collector entry")?;
        let (rows, history) = read_source(
            &self.data_dir,
            entry,
            self.collector_start_ms,
            self.collector_end_ms,
            self.lookback_start_ms,
        )?;
        let cache_path = confined_path(&self.cache_dir, &format!("{symbol}.json"))?;
        let cache_bytes = fs::read(&cache_path).context("Read frozen forecast cache")?;
        let cache: ForecastCache =
            serde_json::from_slice(&cache_bytes).context("Decode forecast-only cache")?;
        validate_cache_fingerprint(&cache, entry, &self.manifest)?;
        let mut origins = Vec::new();
        let mut features = Vec::new();
        let mut previous = None;
        for record in &cache.records {
            ensure!(
                previous.is_none_or(|prior| record.origin_ms > prior),
                "Unsorted or duplicate cached origins"
            );
            previous = Some(record.origin_ms);
            validate_record(record, symbol, &rows, &self.manifest, self.collector_end_ms)?;
            if record.origin_ms < self.manifest.split.validation_end_ms {
                continue;
            }
            // Pass only the closed prefix, even though the full rows remain available for replay.
            let prefix = &rows[..record.end];
            let btc_end = closed_boundary(&self.btc_rows, record.origin_ms);
            let eth_end = closed_boundary(&self.eth_rows, record.origin_ms);
            features.push(ml_monthly::combined_features_with_market(
                prefix,
                prefix.len(),
                &history,
                &record.forecast,
                &self.manifest.calibration,
                &self.btc_rows[..btc_end],
                &self.eth_rows[..eth_end],
            )?);
            origins.push(record.origin_ms);
        }
        let probabilities = self.model.predict(&features)?;
        ensure!(
            probabilities.len() == origins.len(),
            "Native prediction count mismatch"
        );
        let predictions = origins
            .into_iter()
            .zip(probabilities)
            .map(|(origin_ms, probabilities)| ProbabilityPoint {
                origin_ms,
                probabilities,
            })
            .collect();
        self.loaded_cache_sha256
            .insert(symbol.to_owned(), digest(&cache_bytes));
        Ok(SymbolData {
            symbol: symbol.to_owned(),
            rows,
            predictions,
        })
    }
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn required<'a>(value: &'a Option<String>, field: &str) -> Result<&'a str> {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("Missing {field}"))
}

fn valid_sha256(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid SHA-256"
    );
    Ok(())
}

fn verified_bytes(path: &Path, expected: &str) -> Result<Vec<u8>> {
    valid_sha256(expected)?;
    let bytes =
        fs::read(path).with_context(|| format!("Read verified artifact {}", path.display()))?;
    ensure!(
        digest(&bytes).eq_ignore_ascii_case(expected),
        "Artifact SHA-256 mismatch: {}",
        path.display()
    );
    Ok(bytes)
}

fn confined_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    ensure!(
        !relative.as_os_str().is_empty()
            && !relative.is_absolute()
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Artifact path must be a normal relative path"
    );
    let root = root.canonicalize()?;
    let resolved = root.join(relative).canonicalize()?;
    ensure!(
        resolved.starts_with(root) && resolved.is_file(),
        "Artifact resolved outside its directory or is not a file"
    );
    Ok(resolved)
}

fn validate_collection(collection: &CollectorManifest, model: &MonthlyManifest) -> Result<()> {
    ensure!(
        collection.schema_version == 1
            && collection.train_ready
            && collection.history_complete
            && matches!(
                collection.status.as_str(),
                "complete" | "complete_with_errors"
            ),
        "Collector manifest incomplete or unsupported"
    );
    ensure!(
        collection.start_ms == model.split.start_ms
            && collection.end_ms == model.split.test_end_ms
            && collection.end_exclusive_ms == collection.end_ms
            && collection.lookback_start_ms >= 0
            && collection.lookback_start_ms <= collection.start_ms
            && collection.lookback_start_ms % ml_features::HOUR == 0
            && collection.end_ms <= crate::now_ms(),
        "Collector and model window boundaries differ"
    );
    Ok(())
}

fn read_source(
    data_dir: &Path,
    entry: &CollectorEntry,
    start_ms: i64,
    end_ms: i64,
    lookback_start_ms: i64,
) -> Result<(Vec<Value>, Value)> {
    ensure!(entry.training_eligible, "Source is not training eligible");
    let candle_bytes = verified_bytes(
        &confined_path(data_dir, required(&entry.path, "candle path")?)?,
        required(&entry.sha256, "candle SHA-256")?,
    )?;
    let document: Value = serde_json::from_slice(&candle_bytes)?;
    ensure!(
        document["symbol"] == entry.symbol
            && document["metadata"]["end_exclusive_ms"] == end_ms
            && document["metadata"]["training_start_ms"] == start_ms
            && document["metadata"]["lookback_start_ms"] == lookback_start_ms,
        "Candle source identity or boundaries differ"
    );
    let rows = document["datasets"]["1h"]
        .as_array()
        .context("Missing hourly candle source")?
        .clone();
    ml_features::validate_hourly(&rows)?;
    ensure!(
        rows.len() > CONTEXT_LENGTH + ml_features::HORIZON,
        "Insufficient frozen source context"
    );
    for row in &rows {
        let open = row["openTime"]
            .as_i64()
            .context("Noninteger candle open time")?;
        ensure!(
            row["confirmed"] == true
                && open >= lookback_start_ms
                && open
                    .checked_add(ml_features::HOUR)
                    .is_some_and(|close| close <= end_ms),
            "Unclosed or out-of-bounds source candle"
        );
    }
    ensure!(
        rows.last().unwrap()["openTime"]
            .as_i64()
            .and_then(|open| open.checked_add(ml_features::HOUR))
            == Some(end_ms),
        "Source does not reach the frozen cutoff"
    );
    let history_bytes = verified_bytes(
        &confined_path(data_dir, required(&entry.history_path, "history path")?)?,
        required(&entry.history_sha256, "history SHA-256")?,
    )?;
    let history: Value = serde_json::from_slice(&history_bytes)?;
    ensure!(
        history["symbol"] == entry.symbol
            && history["start_ms"] == start_ms
            && history["end_exclusive_ms"] == end_ms
            && history["datasets"].is_object(),
        "Historical source identity or boundaries differ"
    );
    Ok((rows, history))
}

fn validate_cache_fingerprint(
    cache: &ForecastCache,
    entry: &CollectorEntry,
    manifest: &MonthlyManifest,
) -> Result<()> {
    ensure!(
        cache.source_sha256 == required(&entry.sha256, "candle SHA-256")?
            && cache.forecast_sha256 == manifest.forecast.sha256
            && cache.schema_sha256 == manifest.feature_schema_sha256
            && cache.stride_hours == manifest.stride_hours,
        "Forecast cache source/model/schema/stride fingerprint mismatch"
    );
    Ok(())
}

fn closed_boundary(rows: &[Value], origin_ms: i64) -> usize {
    rows.partition_point(|row| {
        row["openTime"]
            .as_i64()
            .and_then(|open| open.checked_add(ml_features::HOUR))
            .is_some_and(|close| close <= origin_ms)
    })
}

fn forecast_price_matches_input(source_price: f64, forecast_price: f64) -> bool {
    // Chronos ContextRecord stores f32 closes. decode_forecast deliberately
    // exposes the last input widened back to f64, not the original source f64.
    let input_price = source_price as f32;
    source_price.is_finite()
        && source_price > 0.
        && input_price.is_finite()
        && input_price > 0.
        && forecast_price == f64::from(input_price)
}

fn validate_record(
    record: &CachedForecast,
    symbol: &str,
    rows: &[Value],
    manifest: &MonthlyManifest,
    end_ms: i64,
) -> Result<()> {
    ensure!(
        record.symbol == symbol
            && record.end >= CONTEXT_LENGTH
            && record.end <= rows.len()
            && manifest.split.part(record.origin_ms).is_some()
            && (record.origin_ms - manifest.split.start_ms)
                .rem_euclid(manifest.stride_hours as i64 * ml_features::HOUR)
                == 0
            && record
                .origin_ms
                .checked_add(ml_features::HORIZON as i64 * ml_features::HOUR)
                .is_some_and(|matured| matured <= end_ms),
        "Invalid or immature cached forecast origin"
    );
    let prefix = &rows[record.end - CONTEXT_LENGTH..record.end];
    let forecast = &record.forecast;
    ensure!(
        prefix.last().unwrap()["openTime"]
            .as_i64()
            .and_then(|open| open.checked_add(ml_features::HOUR))
            == Some(record.origin_ms)
            && forecast.symbol == symbol
            && forecast.origin_ms == record.origin_ms
            && forecast.context_end_open_ms.checked_add(ml_features::HOUR)
                == Some(record.origin_ms)
            && forecast.interval == "1h"
            && forecast_price_matches_input(
                crate::number(&prefix.last().unwrap()["close"], f64::NAN),
                forecast.current_price,
            ),
        "Forecast does not match its closed source prefix"
    );
    let expected = forecast
        .history_sha256
        .as_deref()
        .context("Cached forecast context SHA-256 missing")?;
    valid_sha256(expected)?;
    ensure!(
        digest(&serde_json::to_vec(prefix)?) == expected,
        "Forecast context SHA-256 mismatch"
    );
    ml_features::chronos_features(forecast)?;
    ensure!(
        forecast
            .q10
            .iter()
            .zip(&forecast.q50)
            .zip(&forecast.q90)
            .all(|((low, median), high)| {
                low.is_finite()
                    && median.is_finite()
                    && high.is_finite()
                    && *low > 0.
                    && low <= median
                    && median <= high
            }),
        "Invalid cached forecast quantiles"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_current_price_matches_exact_chronos_f32_input() {
        // Values observed in the frozen BTC/ETH caches: avoid a tolerance that
        // would also accept a modified forecast price.
        assert!(forecast_price_matches_input(77745.8, 77745.796875));
        assert!(forecast_price_matches_input(2475.48, 2475.47998046875));
        assert!(!forecast_price_matches_input(77745.8, 77745.8));
        assert!(!forecast_price_matches_input(
            2475.48,
            2475.47998046875 + 1e-8
        ));
        assert!(!forecast_price_matches_input(f64::NAN, 100.));
        assert!(!forecast_price_matches_input(f64::MAX, f64::INFINITY));
        assert!(!forecast_price_matches_input(-1., -1.));
    }

    #[test]
    fn paths_reject_parent_absolute_and_nonfiles() {
        let directory = tempfile::tempdir().unwrap();
        let child = directory.path().join("child");
        fs::create_dir(&child).unwrap();
        fs::write(directory.path().join("outside.json"), b"{}").unwrap();
        fs::write(child.join("inside.json"), b"{}").unwrap();
        assert!(confined_path(&child, "inside.json").is_ok());
        assert!(confined_path(&child, "../outside.json").is_err());
        assert!(
            confined_path(
                &child,
                directory.path().join("outside.json").to_str().unwrap()
            )
            .is_err()
        );
        assert!(confined_path(&child, "").is_err());
        assert!(confined_path(directory.path(), "child").is_err());
    }

    #[test]
    fn checksum_verification_rejects_changed_or_malformed_artifacts() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("source.json");
        fs::write(&file, b"frozen").unwrap();
        let expected = digest(b"frozen");
        assert!(verified_bytes(&file, &expected).is_ok());
        assert!(verified_bytes(&file, "bad-hash").is_err());
        fs::write(&file, b"changed").unwrap();
        assert!(verified_bytes(&file, &expected).is_err());
    }

    #[test]
    fn closed_reference_prefix_excludes_future_rows() {
        let rows = vec![
            json!({"openTime":0}),
            json!({"openTime":ml_features::HOUR}),
            json!({"openTime":2*ml_features::HOUR}),
        ];
        assert_eq!(closed_boundary(&rows, 0), 0);
        assert_eq!(closed_boundary(&rows, ml_features::HOUR), 1);
        assert_eq!(closed_boundary(&rows, 2 * ml_features::HOUR), 2);
    }

    #[test]
    fn source_requires_verified_history_and_matching_closed_bounds() {
        let directory = tempfile::tempdir().unwrap();
        let end = 270 * ml_features::HOUR;
        let rows: Vec<_> = (0..270)
            .map(|index| {
                json!({
                    "openTime":index*ml_features::HOUR,"open":100.,"high":101.,
                    "low":99.,"close":100.,"volume":1.,"confirmed":true
                })
            })
            .collect();
        let candle = json!({"symbol":"BTCUSDT","metadata":{
            "end_exclusive_ms":end,"training_start_ms":0,"lookback_start_ms":0
        },"datasets":{"1h":rows}});
        let history = json!({"symbol":"BTCUSDT","start_ms":0,
            "end_exclusive_ms":end,"datasets":{}});
        let candle_bytes = serde_json::to_vec(&candle).unwrap();
        let history_bytes = serde_json::to_vec(&history).unwrap();
        fs::write(directory.path().join("candles.json"), &candle_bytes).unwrap();
        fs::write(directory.path().join("history.json"), &history_bytes).unwrap();
        let mut entry = CollectorEntry {
            symbol: "BTCUSDT".into(),
            training_eligible: true,
            path: Some("candles.json".into()),
            sha256: Some(digest(&candle_bytes)),
            history_path: Some("history.json".into()),
            history_sha256: Some(digest(&history_bytes)),
        };
        assert!(read_source(directory.path(), &entry, 0, end, 0).is_ok());
        assert!(read_source(directory.path(), &entry, 0, end + ml_features::HOUR, 0).is_err());
        let wrong_history = serde_json::to_vec(&json!({"symbol":"ETHUSDT", "start_ms":0,
            "end_exclusive_ms":end,"datasets":{}}))
        .unwrap();
        fs::write(directory.path().join("history.json"), &wrong_history).unwrap();
        assert!(read_source(directory.path(), &entry, 0, end, 0).is_err());
        entry.history_sha256 = Some(digest(&wrong_history));
        assert!(read_source(directory.path(), &entry, 0, end, 0).is_err());
    }

    #[test]
    fn cache_decoder_does_not_accept_outcomes_as_prediction_inputs() {
        let value = json!({
            "symbol":"BTCUSDT", "end":256, "origin_ms":256*ml_features::HOUR,
            "base":{"malicious":"not a numeric feature vector"},
            "label":{"malicious":"not a label"}, "realized_returns":"unread future outcomes",
            "forecast":{
                "symbol":"BTCUSDT", "origin_ms":256*ml_features::HOUR,
                "context_end_open_ms":255*ml_features::HOUR,"current_price":100.,
                "interval":"1h","horizon_hours":12,
                "q10":vec![99.;12],"q50":vec![100.;12],"q90":vec![101.;12],
                "quantile_crossings":0,"inference_ms":1.
            }
        });
        let record: CachedForecast = serde_json::from_value(value).unwrap();
        assert_eq!(record.forecast.current_price, 100.);
    }
}
