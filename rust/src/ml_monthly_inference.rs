//! Read-only inference for the monthly global Chronos/LightGBM candidate.
//! This module has no account state, credentials, order routing or paper mutation.
use crate::{
    chronos::{CONTEXT_LENGTH, ChronosModel, ContextRecord, HOUR_MS, MODEL_ID},
    exchange::{Exchange, valid_symbol},
    ml_lightgbm::{LightGbmModel, LightGbmRuntime},
    ml_monthly::{self, Calibration, DecisionPolicy},
    simulator,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};

const MAX_INPUT_ROWS: usize = 24 * 45;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignalRequest {
    pub symbol: String,
    #[serde(default)]
    pub candles: Option<Vec<Value>>,
    #[serde(default)]
    pub history: Option<Value>,
    #[serde(default)]
    pub origin_ms: Option<i64>,
    #[serde(default)]
    pub market: Option<MarketContext>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MarketContext {
    pub btc: Vec<Value>,
    pub eth: Vec<Value>,
}

pub struct MonthlyPredictor {
    manifest: Value,
    fingerprint: String,
    symbols: BTreeSet<String>,
    model: LightGbmModel,
    chronos: ChronosModel,
    calibration: Calibration,
    policy: DecisionPolicy,
    earliest_origin_ms: i64,
    historical_features_used: bool,
    market_features_used: bool,
    interval: String,
    frozen: Option<FrozenSource>,
}

/// Trusted only after the complete collector manifest matches the model's
/// training-source fingerprint. Requests cannot choose files in this directory.
struct FrozenSource {
    directory: PathBuf,
    manifest_sha256: String,
    origin_ms: i64,
    interval: String,
    manifest: Value,
}

impl FrozenSource {
    fn load(
        directory: &Path,
        expected_sha256: &str,
        model_symbols: &BTreeSet<String>,
        interval: &str,
    ) -> Result<Self> {
        let directory = directory
            .canonicalize()
            .context("Frozen data directory missing")?;
        let manifest_path = model_path(&directory, "manifest.json")?;
        let bytes = verified_bytes(&manifest_path, expected_sha256)?;
        let manifest: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            manifest["schema_version"] == 1
                && manifest["train_ready"] == true
                && manifest["history_complete"] == true,
            "Frozen collector manifest is incomplete or unsupported"
        );
        let origin_ms = manifest["end_exclusive_ms"]
            .as_i64()
            .or_else(|| manifest["end_ms"].as_i64())
            .context("Frozen collector cutoff missing")?;
        let step_ms = crate::chronos::interval_ms(interval)?;
        ensure!(
            origin_ms > 0 && origin_ms % step_ms == 0,
            "Invalid frozen collector cutoff"
        );
        let items = manifest["symbols"]
            .as_array()
            .context("Frozen collector symbol universe missing")?;
        let mut seen = BTreeSet::new();
        for item in items {
            let symbol = required_string(item, "symbol")?;
            valid_symbol(symbol)?;
            ensure!(
                seen.insert(symbol.to_owned()),
                "Duplicate frozen collector symbol"
            );
        }
        for symbol in model_symbols
            .iter()
            .chain(["BTCUSDT".to_owned(), "ETHUSDT".to_owned()].iter())
        {
            ensure!(
                items
                    .iter()
                    .any(|item| item["symbol"] == *symbol && item["training_eligible"] == true),
                "Frozen data lacks a trained/market reference symbol: {symbol}"
            );
        }
        Ok(Self {
            directory,
            manifest_sha256: digest(&bytes),
            origin_ms,
            interval: interval.to_owned(),
            manifest,
        })
    }

    fn document(&self, symbol: &str, history: bool) -> Result<Value> {
        valid_symbol(symbol)?;
        let item = self.manifest["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["symbol"] == symbol && item["training_eligible"] == true)
            .context("Symbol is not eligible in the frozen collector manifest")?;
        let path = model_path(
            &self.directory,
            required_string(item, if history { "history_path" } else { "path" })?,
        )?;
        let bytes = verified_bytes(
            &path,
            required_string(item, if history { "history_sha256" } else { "sha256" })?,
        )?;
        let document: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            document["symbol"] == symbol,
            "Frozen document has a different symbol"
        );
        Ok(document)
    }

    fn candles(&self, symbol: &str, now_ms: i64) -> Result<Vec<Value>> {
        let document = self.document(symbol, false)?;
        let rows = document["datasets"][&self.interval]
            .as_array()
            .with_context(|| format!("Frozen document lacks {} candles", self.interval))?;
        ensure!(
            rows.len() >= CONTEXT_LENGTH,
            "Frozen symbol lacks Chronos context"
        );
        let prefix = rows[rows.len() - CONTEXT_LENGTH..].to_vec();
        validate_candles_for_interval(symbol, &prefix, self.origin_ms, now_ms, &self.interval)?;
        Ok(prefix)
    }

    fn info(&self, now_ms: i64) -> Value {
        let step_ms = crate::chronos::interval_ms(&self.interval).unwrap_or(HOUR_MS);
        let target_end = self.origin_ms + crate::ml_features::HORIZON as i64 * step_ms;
        json!({"manifest_sha256":self.manifest_sha256,"origin_ms":self.origin_ms,"observed_at_ms":now_ms,"interval":self.interval,
            "provider":self.manifest["provider"],"status":self.manifest["status"],"history_all_available":self.manifest["history_all_available"],
            "stale":self.origin_ms<now_ms.div_euclid(step_ms)*step_ms,"forecast_target_end_ms":target_end,"forecast_target_still_future":target_end>now_ms,
            "live_eligible":false,"notice":"Verified frozen historical snapshot review; this is not a current-market signal"})
    }
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn required_string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("Missing manifest {name}"))
}

fn verified_bytes(path: &Path, expected: &str) -> Result<Vec<u8>> {
    ensure!(
        expected.len() == 64 && expected.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid artifact SHA-256"
    );
    let bytes = fs::read(path).with_context(|| format!("Read artifact {}", path.display()))?;
    ensure!(
        digest(&bytes) == expected,
        "Artifact SHA-256 mismatch: {}",
        path.display()
    );
    Ok(bytes)
}

fn model_path(directory: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Model path must stay within the candidate directory"
    );
    let resolved = directory.join(relative).canonicalize()?;
    ensure!(
        resolved.starts_with(directory),
        "Model resolved outside the candidate directory"
    );
    Ok(resolved)
}

fn manifest_symbols(manifest: &Value) -> Result<BTreeSet<String>> {
    let interval = manifest_interval(manifest)?;
    if interval == "1h" {
        let typed: ml_monthly::MonthlyManifest = serde_json::from_value(manifest.clone())?;
        ml_monthly::validate_manifest(&typed)?;
    } else {
        ensure!(
            manifest["schema_version"] == 2
                && manifest["pipeline"] == "chronos-bolt-tiny-lightgbm-monthly",
            "Unsupported monthly candidate schema"
        );
        ensure!(
            manifest["chronos_retained"] == true
                && manifest["forecast"]["weights_updated"] == false,
            "Monthly model must retain unmodified Chronos-Bolt-Tiny"
        );
        ensure!(
            manifest["feature_schema_sha256"] == ml_monthly::schema_sha256_for_interval(interval)?,
            "Monthly feature code differs from the trained artifact"
        );
    }
    ensure!(
        manifest["selection_gate"]["status"] == "research_only"
            && manifest["selection_gate"]["real_trading_enabled"] == false,
        "Only a research-only monthly candidate is accepted"
    );
    let array = manifest["symbols"]
        .as_array()
        .context("Candidate has no symbol universe")?;
    ensure!(!array.is_empty(), "Candidate universe is empty");
    let mut symbols = BTreeSet::new();
    for symbol in array {
        let symbol = symbol.as_str().context("Invalid universe symbol")?;
        valid_symbol(symbol)?;
        ensure!(
            symbol.ends_with("USDT") && symbols.insert(symbol.into()),
            "Duplicate or unsupported universe symbol"
        );
    }
    let names: Vec<String> = serde_json::from_value(manifest["model"]["feature_names"].clone())?;
    ensure!(
        names == ml_monthly::feature_names_for_interval(interval)?,
        "Candidate feature names/order differ from this build"
    );
    ensure!(
        manifest["model"]["feature_count"].as_u64() == Some(names.len() as u64),
        "Candidate feature count differs from its feature names"
    );
    ensure!(
        manifest["forecast"]["model_id"] == MODEL_ID,
        "Monthly forecast must use Chronos-Bolt-Tiny"
    );
    Ok(symbols)
}

fn manifest_interval(manifest: &Value) -> Result<&str> {
    let interval = manifest["interval"].as_str().unwrap_or("1h");
    crate::chronos::interval_ms(interval)?;
    Ok(interval)
}

pub fn validate_candles(symbol: &str, rows: &[Value], origin_ms: i64, now_ms: i64) -> Result<()> {
    validate_candles_for_interval(symbol, rows, origin_ms, now_ms, "1h")
}

pub fn validate_candles_for_interval(
    symbol: &str,
    rows: &[Value],
    origin_ms: i64,
    now_ms: i64,
    interval: &str,
) -> Result<()> {
    valid_symbol(symbol)?;
    let step_ms = crate::chronos::interval_ms(interval)?;
    ensure!(
        (CONTEXT_LENGTH..=MAX_INPUT_ROWS).contains(&rows.len()),
        "Require 256 to 1080 closed {interval} candles"
    );
    ensure!(
        origin_ms > 0
            && origin_ms % step_ms == 0
            && origin_ms <= now_ms.div_euclid(step_ms) * step_ms,
        "origin_ms must be a past or current closed {interval} boundary"
    );
    let first = origin_ms
        .checked_sub(rows.len() as i64 * step_ms)
        .context("Candle time overflow")?;
    for (index, row) in rows.iter().enumerate() {
        let open = first + index as i64 * step_ms;
        ensure!(
            open >= 0 && row["openTime"].as_i64() == Some(open),
            "Candles must be consecutive and end at origin_ms"
        );
        ensure!(
            row["confirmed"] == true,
            "Only explicitly confirmed closed candles are accepted"
        );
        ensure!(
            row["closeTime"].as_i64() == Some(open + step_ms - 1),
            "Candle closeTime differs from the {interval} boundary"
        );
        ensure!(
            simulator::valid_candle(row),
            "Invalid candle OHLCV at row {index}"
        );
        ensure!(
            row["symbol"]
                .as_str()
                .is_none_or(|name| crate::exchange::strip_symbol(name) == symbol),
            "Candle has a different symbol"
        );
        for field in [
            "volume",
            "quoteVolume",
            "tradeCount",
            "takerBuyVolume",
            "takerBuyQuoteVolume",
        ] {
            let value = crate::number(&row[field], f64::NAN);
            ensure!(
                value.is_finite() && value >= 0.0,
                "Invalid/missing {field} at row {index}"
            );
        }
        let volume = crate::number(&row["volume"], f64::NAN);
        let quote = crate::number(&row["quoteVolume"], f64::NAN);
        ensure!(
            crate::number(&row["takerBuyVolume"], f64::NAN) <= volume * (1.0 + 1e-8),
            "Taker volume exceeds total volume"
        );
        ensure!(
            crate::number(&row["takerBuyQuoteVolume"], f64::NAN) <= quote * (1.0 + 1e-8),
            "Taker quote volume exceeds total quote volume"
        );
    }
    Ok(())
}

pub fn request_origin(request: &SignalRequest, now_ms: i64) -> Result<i64> {
    request_origin_for_interval(request, now_ms, "1h")
}

pub fn request_origin_for_interval(
    request: &SignalRequest,
    now_ms: i64,
    interval: &str,
) -> Result<i64> {
    let step_ms = crate::chronos::interval_ms(interval)?;
    let current = now_ms.div_euclid(step_ms) * step_ms;
    if let Some(rows) = &request.candles {
        let inferred = rows
            .last()
            .and_then(|row| row["openTime"].as_i64())
            .and_then(|time| time.checked_add(step_ms))
            .with_context(|| format!("Provided candles lack a final {interval} boundary"))?;
        let origin = request.origin_ms.unwrap_or(inferred);
        validate_candles_for_interval(&request.symbol, rows, origin, now_ms, interval)?;
        Ok(origin)
    } else {
        ensure!(
            request.origin_ms.is_none_or(|origin| origin == current),
            "Symbol-only inference requires the latest closed {interval} boundary"
        );
        Ok(current)
    }
}

impl MonthlyPredictor {
    pub fn load(directory: &Path, lightgbm_runtime: &Path, threads: usize) -> Result<Self> {
        let directory = directory
            .canonicalize()
            .context("Candidate directory missing")?;
        let bytes = fs::read(directory.join("manifest.json"))?;
        let manifest: Value = serde_json::from_slice(&bytes)?;
        let symbols = manifest_symbols(&manifest)?;
        let model_meta = &manifest["model"];
        let path = model_path(&directory, required_string(model_meta, "path")?)?;
        let model_bytes = verified_bytes(&path, required_string(model_meta, "sha256")?)?;
        let baseline_meta = &manifest["baseline"];
        let baseline_path = model_path(&directory, required_string(baseline_meta, "path")?)?;
        verified_bytes(&baseline_path, required_string(baseline_meta, "sha256")?)?;
        let runtime = LightGbmRuntime::load(lightgbm_runtime)?;
        let interval = manifest_interval(&manifest)?.to_owned();
        let names = ml_monthly::feature_names_for_interval(&interval)?;
        let model = LightGbmModel::load(runtime, std::str::from_utf8(&model_bytes)?)?;
        ensure!(
            model.summary().feature_count == names.len(),
            "Native LightGBM feature count mismatch"
        );
        let forecast = &manifest["forecast"];
        let forecast_path = PathBuf::from(required_string(forecast, "path")?);
        let forecast_bytes = verified_bytes(&forecast_path, required_string(forecast, "sha256")?)?;
        let chronos = ChronosModel::load(
            &forecast_path,
            Path::new(required_string(forecast, "runtime_path")?),
            threads,
        )?;
        let calibration = serde_json::from_value(manifest["calibration"].clone())?;
        let policy = serde_json::from_value(manifest["policy"].clone())?;
        let calibration: Calibration = calibration;
        let policy: DecisionPolicy = policy;
        calibration.validate()?;
        policy.validate()?;
        let earliest_origin_ms = manifest["split"]["validation_end_ms"]
            .as_i64()
            .context("Missing validation cutoff")?;
        let step_ms = crate::chronos::interval_ms(&interval)?;
        ensure!(
            earliest_origin_ms > 0 && earliest_origin_ms % step_ms == 0,
            "Validation cutoff must be a closed {interval} boundary"
        );
        let historical_features_used = manifest["historical_features_used"]
            .as_bool()
            .context("Missing historical feature availability policy")?;
        let market_features_used = manifest["market_features_used"]
            .as_bool()
            .context("Missing market feature availability policy")?;
        let fingerprint = digest(&[bytes, model_bytes, forecast_bytes].concat());
        Ok(Self {
            manifest,
            fingerprint,
            symbols,
            model,
            chronos,
            calibration,
            policy,
            earliest_origin_ms,
            historical_features_used,
            market_features_used,
            interval,
            frozen: None,
        })
    }

    pub fn interval(&self) -> &str {
        &self.interval
    }

    pub fn supports(&self, symbol: &str) -> bool {
        self.symbols.contains(symbol)
    }

    pub fn configure_frozen_source(&mut self, directory: &Path) -> Result<()> {
        self.frozen = Some(FrozenSource::load(
            directory,
            required_string(&self.manifest, "source_manifest_sha256")?,
            &self.symbols,
            &self.interval,
        )?);
        Ok(())
    }

    pub fn frozen_origin(&self) -> Option<i64> {
        self.frozen.as_ref().map(|source| source.origin_ms)
    }

    pub fn infer_frozen(&mut self, symbol: &str, now_ms: i64) -> Result<Value> {
        ensure!(
            self.supports(symbol),
            "Symbol is outside the trained universe"
        );
        let source = self
            .frozen
            .as_ref()
            .context("No verified frozen source configured")?;
        let rows = source.candles(symbol, now_ms)?;
        let history = source.document(symbol, true)?;
        let market = MarketContext {
            btc: source.candles("BTCUSDT", now_ms)?,
            eth: source.candles("ETHUSDT", now_ms)?,
        };
        let origin = source.origin_ms;
        let source_info = source.info(now_ms);
        let mut output =
            self.infer_inner(symbol, &rows, &history, &market, origin, now_ms, true)?;
        output["data_mode"] = json!("frozen_snapshot");
        output["source"] = source_info;
        output["live_eligible"] = json!(false);
        Ok(output)
    }

    pub fn info(&self) -> Value {
        json!({"schema_version":2,"service":"nofx-ml-monthly-candidate","manifest":self.manifest,"model_fingerprint":self.fingerprint,"candidate_status":"research_only","advisory_only":true,"real_trading_enabled":false,"account_credentials_loaded":false,"trade_execution_permitted":false,"orders_enabled":false,
            "data_mode":if self.frozen.is_some(){"frozen_snapshot"}else{"live_public"},"source":self.frozen.as_ref().map(|source|source.info(crate::now_ms())),"live_eligible":false})
    }

    pub fn infer(
        &mut self,
        symbol: &str,
        rows: &[Value],
        history: &Value,
        market: &MarketContext,
        origin_ms: i64,
        now_ms: i64,
    ) -> Result<Value> {
        self.infer_inner(symbol, rows, history, market, origin_ms, now_ms, false)
    }

    fn infer_inner(
        &mut self,
        symbol: &str,
        rows: &[Value],
        history: &Value,
        market: &MarketContext,
        origin_ms: i64,
        now_ms: i64,
        verified_frozen: bool,
    ) -> Result<Value> {
        ensure!(
            self.supports(symbol),
            "Symbol is outside the trained universe"
        );
        validate_candles_for_interval(symbol, rows, origin_ms, now_ms, &self.interval)?;
        ensure!(
            origin_ms >= self.earliest_origin_ms,
            "Inference predates the calibration/policy validation cutoff and would leak future information"
        );
        ensure!(
            !self.historical_features_used || !history.is_null(),
            "This candidate requires historical auxiliary data; supply collector-format history or use live public collection"
        );
        if let Some(name) = history["symbol"].as_str() {
            ensure!(name == symbol, "Historical context has a different symbol");
        }
        let historical = ml_monthly::historical_features(history, origin_ms);
        ensure!(
            verified_frozen
                || !self.historical_features_used
                || historical.iter().skip(10).any(|mask| *mask > 0.0),
            "All trained historical auxiliary data are missing or stale at the requested origin"
        );
        if self.market_features_used {
            validate_candles_for_interval(
                "BTCUSDT",
                &market.btc,
                origin_ms,
                now_ms,
                &self.interval,
            )?;
            validate_candles_for_interval(
                "ETHUSDT",
                &market.eth,
                origin_ms,
                now_ms,
                &self.interval,
            )?;
        }
        let step_ms = crate::chronos::interval_ms(&self.interval)?;
        let recent = &rows[rows.len() - CONTEXT_LENGTH..];
        let input = ContextRecord {
            symbol: symbol.into(),
            origin_ms,
            context_end_open_ms: origin_ms - step_ms,
            context: recent
                .iter()
                .map(|row| crate::number(&row["close"], f64::NAN) as f32)
                .collect(),
            context_open_ms: Some(
                recent
                    .iter()
                    .map(|row| row["openTime"].as_i64().unwrap())
                    .collect(),
            ),
            history_sha256: Some(digest(&serde_json::to_vec(recent)?)),
        };
        let raw = self.chronos.forecast_for_interval(&input, &self.interval)?;
        let forecast = ml_monthly::calibrate_forecast(&raw, &self.calibration)?;
        let features = ml_monthly::combined_features_with_market_for_interval(
            rows,
            rows.len(),
            history,
            &raw,
            &self.calibration,
            &market.btc,
            &market.eth,
            &self.interval,
        )?;
        let probabilities = self.model.predict(&[features.clone()])?[0];
        let action = ml_monthly::decide(&probabilities, &self.policy);
        let target_end = origin_ms
            .checked_add(crate::ml_features::HORIZON as i64 * step_ms)
            .context("Forecast target time overflow")?;
        let mut output = json!({"schema_version":2,"symbol":symbol,"interval":self.interval,"origin_ms":origin_ms,"data_as_of_ms":origin_ms,"observed_at_ms":now_ms,
            "model_fingerprint":self.fingerprint,"model_variant":"chronos-bolt-tiny-lightgbm-global-calibrated","candidate_status":"research_only",
            "trained_before_ms":self.earliest_origin_ms,"evaluation_end_ms":self.manifest["split"]["test_end_ms"],
            "action":action,"probabilities":{"SELL":probabilities[0],"HOLD":probabilities[1],"BUY":probabilities[2]},
            "feature_names":ml_monthly::feature_names_for_interval(&self.interval)?,"features":features,"forecast":forecast,"raw_forecast":raw,"calibration":self.calibration,"policy":self.policy,
            "historical_source_errors":history["errors"],"historical_available_feature_count":historical.iter().skip(10).filter(|mask| **mask > 0.0).count(),
            "data_mode":"provided_closed_candles","stale":origin_ms<now_ms.div_euclid(step_ms)*step_ms,"forecast_target_end_ms":target_end,"forecast_target_still_future":target_end>now_ms,"live_eligible":false,
            "decision_semantics":{"BUY":"OPEN_LONG candidate","SELL":"OPEN_SHORT candidate","HOLD":"no new order candidate"},
            "advisory_only":true,"real_trading_enabled":false,"account_credentials_loaded":false,"trade_execution_permitted":false,"orders_enabled":false});
        let risk = serde_json::from_value(self.manifest["risk"].clone())
            .context("Invalid model risk configuration")?;
        crate::ml_pipeline::attach(&mut output, rows, &risk);
        Ok(output)
    }
}

pub async fn fetch_live_candles(
    exchange: &Exchange,
    symbol: &str,
    origin_ms: i64,
) -> Result<Vec<Value>> {
    fetch_live_candles_for_interval(exchange, symbol, origin_ms, "1h").await
}

pub async fn fetch_live_candles_for_interval(
    exchange: &Exchange,
    symbol: &str,
    origin_ms: i64,
    interval: &str,
) -> Result<Vec<Value>> {
    let step_ms = crate::chronos::interval_ms(interval)?;
    let start = origin_ms - CONTEXT_LENGTH as i64 * step_ms;
    let rows = exchange
        .klines(
            symbol,
            interval,
            CONTEXT_LENGTH,
            Some(start),
            Some(origin_ms - 1),
        )
        .await?;
    validate_candles_for_interval(symbol, &rows, origin_ms, crate::now_ms(), interval)?;
    Ok(rows)
}

/// Same dataset keys and conservative availability times as the offline collector.
/// Failed public sources remain explicit missing features with error evidence.
pub async fn fetch_live_history(
    exchange: &Exchange,
    symbol: &str,
    origin_ms: i64,
) -> Result<Value> {
    valid_symbol(symbol)?;
    let start = origin_ms - 32 * HOUR_MS;
    let stats = |path: &str| {
        (
            path.to_owned(),
            json!({"symbol":symbol,"period":"1h","startTime":start,"endTime":origin_ms-1,"limit":40}),
            false,
        )
    };
    let candles = |path: &str, pair: bool| {
        let mut params = json!({"interval":"1h","startTime":origin_ms-6*HOUR_MS,"endTime":origin_ms-1,"limit":6});
        params[if pair { "pair" } else { "symbol" }] = json!(symbol);
        (path.to_owned(), params, true)
    };
    let sources = [
        (
            "funding",
            (
                "/fapi/v1/fundingRate".into(),
                json!({"symbol":symbol,"startTime":start,"endTime":origin_ms,"limit":100}),
                false,
            ),
        ),
        ("open_interest", stats("/futures/data/openInterestHist")),
        (
            "global_long_short",
            stats("/futures/data/globalLongShortAccountRatio"),
        ),
        (
            "top_account_long_short",
            stats("/futures/data/topLongShortAccountRatio"),
        ),
        (
            "top_position_long_short",
            stats("/futures/data/topLongShortPositionRatio"),
        ),
        (
            "taker_long_short",
            stats("/futures/data/takerlongshortRatio"),
        ),
        (
            "basis",
            (
                "/futures/data/basis".into(),
                json!({"pair":symbol,"contractType":"PERPETUAL","period":"1h","startTime":start,"endTime":origin_ms-1,"limit":40}),
                false,
            ),
        ),
        ("mark_price_1h", candles("/fapi/v1/markPriceKlines", false)),
        ("index_price_1h", candles("/fapi/v1/indexPriceKlines", true)),
        (
            "premium_index_1h",
            candles("/fapi/v1/premiumIndexKlines", false),
        ),
    ];
    let results = futures::future::join_all(
        sources
            .iter()
            .map(|(_, (path, params, _))| exchange.public_request(path, params)),
    )
    .await;
    let mut datasets = serde_json::Map::new();
    let mut errors = serde_json::Map::new();
    for ((dataset, (_, _, is_candle)), result) in sources.into_iter().zip(results) {
        match result.and_then(|raw| normalize_history(&raw, dataset, is_candle, origin_ms)) {
            Ok(rows) => {
                datasets.insert(dataset.into(), json!(rows));
            }
            Err(error) => {
                datasets.insert(dataset.into(), json!([]));
                errors.insert(dataset.into(), json!(format!("{error:#}")));
            }
        }
    }
    Ok(
        json!({"schema_version":2,"symbol":symbol,"as_of_ms":origin_ms,"datasets":datasets,"errors":errors,"availability_policy":"fundingTime; statistic timestamp+1h; candle openTime+1h"}),
    )
}

fn normalize_history(
    raw: &Value,
    dataset: &str,
    is_candle: bool,
    origin: i64,
) -> Result<Vec<Value>> {
    let rows = raw
        .as_array()
        .context("Public historical source is not an array")?;
    let mut output = Vec::new();
    for row in rows {
        let mut normalized = if is_candle {
            let open = crate::number(&row[0], f64::NAN);
            ensure!(
                open.is_finite() && open >= 0.0 && open.fract() == 0.0,
                "Invalid historical candle time"
            );
            let open = open as i64;
            json!({"openTime":open,"closeTime":open+HOUR_MS-1,"open":crate::number(&row[1],f64::NAN),"high":crate::number(&row[2],f64::NAN),"low":crate::number(&row[3],f64::NAN),"close":crate::number(&row[4],f64::NAN),"confirmed":true,"available_at_ms":open+HOUR_MS})
        } else {
            ensure!(row.is_object(), "Historical statistic is not an object");
            let mut value = row.clone();
            let stamp = row[if dataset == "funding" {
                "fundingTime"
            } else {
                "timestamp"
            }]
            .as_i64()
            .context("Historical statistic lacks timestamp")?;
            let available = if dataset == "funding" {
                stamp
            } else {
                stamp
                    .checked_add(HOUR_MS)
                    .context("Availability overflow")?
            };
            value["available_at_ms"] = json!(available);
            value
        };
        let available = normalized["available_at_ms"]
            .as_i64()
            .context("Historical availability missing")?;
        if available <= origin {
            normalized["observed_at_ms"] = json!(crate::now_ms());
            output.push(normalized);
        }
    }
    output.sort_by_key(|row| row["available_at_ms"].as_i64());
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rows(origin: i64) -> Vec<Value> {
        (0..CONTEXT_LENGTH).map(|index| { let time=origin-(CONTEXT_LENGTH-index) as i64*HOUR_MS; json!({"openTime":time,"closeTime":time+HOUR_MS-1,"confirmed":true,"open":10.0,"high":11.0,"low":9.0,"close":10.0,"volume":20.0,"quoteVolume":200.0,"tradeCount":4,"takerBuyVolume":10.0,"takerBuyQuoteVolume":100.0}) }).collect()
    }
    #[test]
    fn input_rejects_future_gaps_unclosed_mismatched_and_invalid_flow() {
        let origin = 300 * HOUR_MS;
        let valid = rows(origin);
        validate_candles("BTCUSDT", &valid, origin, origin).unwrap();
        assert!(validate_candles("BTCUSDT", &valid, origin, origin - 1).is_err());
        for (field, value) in [
            ("openTime", json!(origin)),
            ("confirmed", json!(false)),
            ("closeTime", json!(origin)),
            ("symbol", json!("ETHUSDT")),
            ("takerBuyVolume", json!(21.0)),
        ] {
            let mut changed = valid.clone();
            changed[10][field] = value;
            assert!(
                validate_candles("BTCUSDT", &changed, origin, origin).is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn rejects_execution_request_fields_and_stale_symbol_only_origin() {
        assert!(
            serde_json::from_value::<SignalRequest>(json!({"symbol":"BTCUSDT","action":"BUY"}))
                .is_err()
        );
        let request: SignalRequest =
            serde_json::from_value(json!({"symbol":"BTCUSDT","origin_ms":299*HOUR_MS})).unwrap();
        assert!(request_origin(&request, 300 * HOUR_MS).is_err());
    }
    #[test]
    fn artifacts_cannot_escape_and_checksums_are_enforced() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("model.txt"), b"model").unwrap();
        let root = directory.path().canonicalize().unwrap();
        assert!(model_path(&root, "../model.txt").is_err());
        assert!(model_path(&root, "/model.txt").is_err());
        let path = model_path(&root, "model.txt").unwrap();
        verified_bytes(&path, &digest(b"model")).unwrap();
        assert!(verified_bytes(&path, &digest(b"different")).is_err());
    }
    #[test]
    fn frozen_source_binds_training_manifest_files_cutoff_and_staleness() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("symbols")).unwrap();
        fs::create_dir(directory.path().join("history")).unwrap();
        let origin = 300 * HOUR_MS;
        let mut symbols = Vec::new();
        for symbol in ["BTCUSDT", "ETHUSDT"] {
            let path = format!("symbols/{symbol}.json");
            let history_path = format!("history/{symbol}.json");
            let document =
                serde_json::to_vec(&json!({"symbol":symbol,"datasets":{"1h":rows(origin)}}))
                    .unwrap();
            let history = serde_json::to_vec(
                &json!({"symbol":symbol,"datasets":{},"errors":["unavailable source"]}),
            )
            .unwrap();
            fs::write(directory.path().join(&path), &document).unwrap();
            fs::write(directory.path().join(&history_path), &history).unwrap();
            symbols.push(json!({"symbol":symbol,"training_eligible":true,"path":path,"sha256":digest(&document),"history_path":history_path,"history_sha256":digest(&history)}));
        }
        let manifest=serde_json::to_vec(&json!({"schema_version":1,"train_ready":true,"history_complete":true,"end_exclusive_ms":origin,"symbols":symbols,"history_all_available":false,"status":"complete_with_errors"})).unwrap();
        fs::write(directory.path().join("manifest.json"), &manifest).unwrap();
        let universe = BTreeSet::from(["BTCUSDT".to_owned()]);
        let mut source =
            FrozenSource::load(directory.path(), &digest(&manifest), &universe, "1h").unwrap();
        assert_eq!(
            source
                .candles("BTCUSDT", origin + 13 * HOUR_MS)
                .unwrap()
                .len(),
            256
        );
        let info = source.info(origin + 13 * HOUR_MS);
        assert_eq!(info["stale"], true);
        assert_eq!(info["forecast_target_still_future"], false);
        assert_eq!(info["live_eligible"], false);
        assert!(source.document("DOGEUSDT", false).is_err());
        assert!(
            FrozenSource::load(directory.path(), &digest(b"wrong source"), &universe, "1h")
                .is_err()
        );
        assert!(source.candles("BTCUSDT", origin - HOUR_MS).is_err());
        fs::write(directory.path().join("symbols/BTCUSDT.json"), b"tampered").unwrap();
        assert!(source.candles("BTCUSDT", origin).is_err());
        source.manifest["symbols"][0]["path"] = json!("../outside.json");
        assert!(source.document("BTCUSDT", false).is_err());
    }
    #[test]
    fn historical_availability_matches_collector_and_excludes_future_rows() {
        let origin = 300 * HOUR_MS;
        let funding = json!([{"fundingTime":origin,"fundingRate":"0.001"},{"fundingTime":origin+1,"fundingRate":"0.1"}]);
        let rows = normalize_history(&funding, "funding", false, origin).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["available_at_ms"], origin);
        let interest = json!([{"timestamp":origin-HOUR_MS,"sumOpenInterest":"100"},{"timestamp":origin,"sumOpenInterest":"999"}]);
        let rows = normalize_history(&interest, "open_interest", false, origin).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["available_at_ms"], origin);
        let candle = json!([
            [origin - HOUR_MS, "10", "11", "9", "10"],
            [origin, "10", "11", "9", "10"]
        ]);
        let rows = normalize_history(&candle, "mark_price_1h", true, origin).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["confirmed"], true);
        assert_eq!(rows[0]["available_at_ms"], origin);
    }
    #[test]
    fn manifest_rejects_schema_drift_live_flags_duplicates_and_bad_calibration() {
        let artifact = json!({"path":"model.txt","sha256":digest(b"model"),"feature_names":ml_monthly::feature_names(),"feature_count":ml_monthly::feature_names().len(),"parameters":"seed=42","iterations":100});
        let valid = json!({"schema_version":2,"pipeline":"chronos-bolt-tiny-lightgbm-monthly","symbols":["BTCUSDT"],"model":artifact,"baseline":artifact,
            "forecast":{"model_id":MODEL_ID,"path":"forecast.onnx","sha256":digest(b"forecast"),"runtime_path":"runtime.dll","weights_updated":false},
            "calibration":Calibration::default(),"policy":DecisionPolicy::default(),
            "split":{"start_ms":100*HOUR_MS,"train_end_ms":200*HOUR_MS,"validation_end_ms":250*HOUR_MS,"test_end_ms":300*HOUR_MS,"embargo_hours":12},
            "feature_schema_sha256":ml_monthly::schema_sha256(),"historical_features_used":true,"market_features_used":true,"chronos_retained":true,"stride_hours":6,"source_manifest_sha256":digest(b"source"),
            "selection_gate":{"status":"research_only","real_trading_enabled":false},"risk":{},"created_at_ms":300*HOUR_MS,"source_training_report":"training-report.json"});
        manifest_symbols(&valid).unwrap();
        let mut changed = valid.clone();
        changed["feature_schema_sha256"] = json!(digest(b"stale schema"));
        assert!(manifest_symbols(&changed).is_err());
        let mut changed = valid.clone();
        changed["model"]["feature_names"][0] = json!("drift");
        assert!(manifest_symbols(&changed).is_err());
        let mut changed = valid.clone();
        changed["selection_gate"]["real_trading_enabled"] = json!(true);
        assert!(manifest_symbols(&changed).is_err());
        let mut changed = valid.clone();
        changed["symbols"] = json!(["BTCUSDT", "BTCUSDT"]);
        assert!(manifest_symbols(&changed).is_err());
        let mut changed = valid.clone();
        changed["forecast"]["weights_updated"] = json!(true);
        assert!(manifest_symbols(&changed).is_err());
        let mut changed = valid;
        changed["calibration"]["bias_by_hour"] = json!([]);
        assert!(manifest_symbols(&changed).is_err());
    }
}
