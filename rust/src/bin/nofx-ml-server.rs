//! Local, read-only inference and finite-capital paper trading. No exchange
//! credentials, database, live mode, or real-order API is reachable here.

use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use clap::Parser;
use nofx_core::{
    chronos::{CONTEXT_LENGTH, ChronosModel, ContextRecord, HOUR_MS},
    exchange::Exchange,
    ml_features::{
        BASE_FEATURE_NAMES, CHRONOS_FEATURE_NAMES, base_features, chronos_features, decide,
    },
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmModel, LightGbmRuntime},
    ml_replay::{self, ReplayConfig, ReplaySignal},
    number, simulator,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;

const PAPER_DAYS: i64 = 30;
const SETTLEMENT_TAIL_HOURS: i64 = 36;
const DAY_MS: i64 = 86_400_000;
const MAX_CONTEXT_ROWS: usize = CONTEXT_LENGTH;
const EXECUTION_ENVIRONMENT_KEYS: &[&str] = &[
    "NOFX_PARTIAL_TP",
    "NOFX_TP1_R",
    "NOFX_TP2_R",
    "NOFX_TP1_CLOSE_PCT",
    "NOFX_TP2_CLOSE_PCT",
    "NOFX_TP_BREAKEVEN",
    "NOFX_TRAIL_BREAKEVEN_BUFFER_BPS",
    "NOFX_SMART_MA_ATR",
    "NOFX_SMART_MA_EXIT_MAX_R",
    "NOFX_SMART_MIN_HOLD",
];
const EXECUTION_SOURCES: &[(&str, &[u8])] = &[
    ("ml_replay.rs", include_bytes!("../ml_replay.rs")),
    ("simulator.rs", include_bytes!("../simulator.rs")),
    ("paper.rs", include_bytes!("../paper.rs")),
    ("research.rs", include_bytes!("../research.rs")),
    ("strategies.rs", include_bytes!("../strategies.rs")),
    (
        "strategies/indicators.rs",
        include_bytes!("../strategies/indicators.rs"),
    ),
    ("lib.rs", include_bytes!("../lib.rs")),
    ("nofx-ml-server.rs", include_bytes!("nofx-ml-server.rs")),
    ("Cargo.lock", include_bytes!("../../../Cargo.lock")),
];

#[derive(Parser)]
#[command(about = "CPU classification JSON and isolated paper trading on localhost")]
struct Args {
    #[arg(long, default_value = "output/ml-baseline-20261014/models/deployment")]
    model_dir: PathBuf,
    #[arg(long, default_value = DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long, default_value_t = 18082)]
    port: u16,
    #[arg(long, default_value = "output/ml-paper-20261014")]
    paper_dir: PathBuf,
    /// Zero disables automatic collection; HTTP paper/step remains available.
    #[arg(long, default_value_t = 60)]
    poll_seconds: u64,
    /// Explicit one-time upgrade only for provably untouched all-HOLD accounts.
    #[arg(long)]
    adopt_zero_hold_legacy_paper: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SymbolManifest {
    base_path: String,
    #[serde(default)]
    augmented_path: Option<String>,
    selected_variant: String,
    trained_before_ms: i64,
    feature_names: Vec<String>,
    #[serde(default)]
    base_feature_names: Vec<String>,
    #[serde(default)]
    chronos_feature_names: Vec<String>,
    #[serde(default)]
    base_feature_count: Option<usize>,
    #[serde(default)]
    augmented_feature_count: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Manifest {
    #[serde(default = "schema_one")]
    schema_version: u32,
    symbols: BTreeMap<String, SymbolManifest>,
    chronos_retained: bool,
    selection_gate: Value,
    feature_schema_sha256: String,
    #[serde(default = "settlement_tail_hours")]
    settlement_tail_hours: i64,
    #[serde(default = "evaluation_cycle_days")]
    evaluation_cycle_days: i64,
    #[serde(default)]
    forecast_model_path: Option<PathBuf>,
    #[serde(default)]
    runtime_path: Option<PathBuf>,
}

fn schema_one() -> u32 {
    1
}

fn settlement_tail_hours() -> i64 {
    SETTLEMENT_TAIL_HOURS
}
fn evaluation_cycle_days() -> i64 {
    PAPER_DAYS
}

struct SymbolModel {
    base: LightGbmModel,
    augmented: Option<LightGbmModel>,
}

struct Models {
    symbols: BTreeMap<String, SymbolModel>,
    chronos: Option<ChronosModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PaperState {
    schema_version: u32,
    symbol: String,
    model_fingerprint: String,
    // Missing legacy values fail closed unless the narrow CLI adoption is enabled.
    #[serde(default)]
    execution_fingerprint: String,
    started_at_ms: i64,
    start_ms: i64,
    deadline_ms: i64,
    last_origin_ms: i64,
    completed: bool,
    config: ReplayConfig,
    // First 256 hours are only warmup, except the first signal at start_ms.
    candles: Vec<Value>,
    signals: Vec<ReplaySignal>,
    report: Value,
}

struct App {
    manifest: Manifest,
    model_fingerprint: String,
    execution_fingerprint: String,
    execution_environment: BTreeMap<String, Option<String>>,
    models: Mutex<Models>,
    exchange: Exchange,
    papers: AsyncMutex<BTreeMap<String, PaperState>>,
    events: AsyncMutex<Vec<Value>>,
    paper_dir: PathBuf,
    started_at_ms: i64,
    poll_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SignalRequest {
    symbol: String,
    #[serde(default)]
    candles: Option<Vec<Value>>,
    #[serde(default)]
    origin_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PaperRequest {
    symbol: String,
}

struct ApiError(anyhow::Error);

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":self.0.to_string(),"real_trading_enabled":false})),
        )
            .into_response()
    }
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("State path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .context("Invalid state name")?
            .to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
            .with_context(|| format!("Atomically replace {}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn child_model_path(directory: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Model filename must stay inside deployment directory"
    );
    let canonical = directory.join(relative).canonicalize()?;
    ensure!(
        canonical.starts_with(directory),
        "Model resolved outside deployment directory"
    );
    Ok(canonical)
}

fn validate_feature_schema_hash(hash: &str) -> Result<()> {
    let current = hex::encode(Sha256::digest(include_bytes!("../ml_features.rs")));
    ensure!(
        hash == current,
        "Deployment feature code differs from this server build; retrain/evaluate with the matching feature schema"
    );
    Ok(())
}

fn validate_feature_names(meta: &SymbolManifest) -> Result<()> {
    let expected: Vec<&str> = match meta.selected_variant.as_str() {
        "base" => BASE_FEATURE_NAMES.to_vec(),
        "chronos" => BASE_FEATURE_NAMES
            .iter()
            .chain(CHRONOS_FEATURE_NAMES)
            .copied()
            .collect(),
        _ => anyhow::bail!("Unknown selected model variant"),
    };
    ensure!(
        meta.feature_names
            .iter()
            .map(String::as_str)
            .eq(expected.iter().copied()),
        "Selected model feature names/order differ from this server build"
    );
    ensure!(
        meta.base_feature_names.is_empty()
            || meta
                .base_feature_names
                .iter()
                .map(String::as_str)
                .eq(BASE_FEATURE_NAMES.iter().copied()),
        "Base model feature names/order differ from this server build"
    );
    Ok(())
}

fn execution_environment() -> BTreeMap<String, Option<String>> {
    EXECUTION_ENVIRONMENT_KEYS
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                std::env::var_os(name).map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

fn execution_digest(
    sources: &[(&str, &[u8])],
    environment: &BTreeMap<String, Option<String>>,
) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(b"nofx-paper-execution-v1");
    for (name, bytes) in sources {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.update(serde_json::to_vec(environment)?);
    Ok(hex::encode(hash.finalize()))
}

fn load_models(args: &Args) -> Result<(Manifest, Models, String)> {
    let directory = args
        .model_dir
        .canonicalize()
        .context("Deployment model directory missing")?;
    let manifest_bytes = fs::read(directory.join("manifest.json"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
    ensure!(
        manifest.schema_version == 1 && !manifest.symbols.is_empty(),
        "Invalid deployment manifest schema"
    );
    ensure!(
        manifest.settlement_tail_hours == SETTLEMENT_TAIL_HOURS
            && manifest.evaluation_cycle_days == PAPER_DAYS,
        "Deployment paper policy must use a 30-day cycle and 36-hour settlement tail"
    );
    validate_feature_schema_hash(&manifest.feature_schema_sha256)?;
    for meta in manifest.symbols.values() {
        validate_feature_names(meta)?;
    }
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut digest = Sha256::new();
    digest.update(&manifest_bytes);
    let mut symbols = BTreeMap::new();
    let mut needs_chronos = false;
    for (symbol, meta) in &manifest.symbols {
        ensure!(
            matches!(symbol.as_str(), "BTCUSDT" | "ETHUSDT"),
            "Only BTCUSDT and ETHUSDT deployment models are allowed"
        );
        ensure!(
            meta.trained_before_ms > 0 && meta.trained_before_ms % HOUR_MS == 0,
            "Deployment training cutoff must be a closed hour"
        );
        ensure!(
            matches!(meta.selected_variant.as_str(), "base" | "chronos"),
            "Unknown selected model variant"
        );
        let base_path = child_model_path(&directory, &meta.base_path)?;
        let text = fs::read_to_string(&base_path)?;
        digest.update(symbol.as_bytes());
        digest.update(text.as_bytes());
        let base = LightGbmModel::load(runtime.clone(), &text)?;
        if let Some(count) = meta.base_feature_count {
            ensure!(
                count == base.summary().feature_count,
                "Base model feature count mismatch for {symbol}"
            );
        }
        if !meta.base_feature_names.is_empty() {
            ensure!(
                meta.base_feature_names.len() == base.summary().feature_count,
                "Base model feature names mismatch for {symbol}"
            );
        }
        let augmented = if meta.selected_variant == "chronos" {
            ensure!(
                manifest.chronos_retained,
                "Chronos deployment must pass the stored retention gate"
            );
            needs_chronos = true;
            let path = child_model_path(
                &directory,
                meta.augmented_path
                    .as_deref()
                    .context("Missing augmented model path")?,
            )?;
            let text = fs::read_to_string(path)?;
            digest.update(text.as_bytes());
            let model = LightGbmModel::load(runtime.clone(), &text)?;
            if let Some(count) = meta.augmented_feature_count {
                ensure!(
                    count == model.summary().feature_count,
                    "Augmented model feature count mismatch for {symbol}"
                );
            }
            ensure!(
                meta.feature_names.len() == model.summary().feature_count,
                "Selected model feature names mismatch for {symbol}"
            );
            Some(model)
        } else {
            ensure!(
                meta.feature_names.len() == base.summary().feature_count,
                "Selected model feature names mismatch for {symbol}"
            );
            None
        };
        symbols.insert(symbol.clone(), SymbolModel { base, augmented });
    }
    let chronos = if needs_chronos {
        let model_path = manifest
            .forecast_model_path
            .as_ref()
            .context("Missing forecast_model_path")?;
        let runtime_path = manifest
            .runtime_path
            .as_ref()
            .context("Missing Chronos runtime_path")?;
        digest.update(fs::read(model_path)?);
        Some(ChronosModel::load(model_path, runtime_path, 4)?)
    } else {
        None
    };
    Ok((
        manifest,
        Models { symbols, chronos },
        hex::encode(digest.finalize()),
    ))
}

fn validate_rows(rows: &[Value], origin: i64, now: i64) -> Result<()> {
    ensure!(
        rows.len() >= MAX_CONTEXT_ROWS,
        "At least 256 closed hourly candles are required"
    );
    ensure!(
        rows.len() <= MAX_CONTEXT_ROWS + PAPER_DAYS as usize * 24,
        "Hourly history exceeds the fixed 30-day paper round plus warmup"
    );
    ensure!(
        origin > 0 && origin % HOUR_MS == 0 && origin <= now.div_euclid(HOUR_MS) * HOUR_MS,
        "origin_ms must be a past or current closed hourly boundary"
    );
    let start = origin
        .checked_sub(rows.len() as i64 * HOUR_MS)
        .context("Hourly history time overflow")?;
    for (index, row) in rows.iter().enumerate() {
        ensure!(
            simulator::valid_candle(row),
            "Invalid OHLC candle at row {index}"
        );
        let expected = start + index as i64 * HOUR_MS;
        ensure!(
            expected >= 0 && row["openTime"].as_i64() == Some(expected),
            "Candle rows must be consecutive and end exactly at origin_ms"
        );
        ensure!(row["confirmed"] != false, "Unclosed candle is forbidden");
        let volume = number(&row["volume"], f64::NAN);
        ensure!(
            volume.is_finite() && volume >= 0.,
            "Invalid candle volume at row {index}"
        );
        if let Some(close_time) = row["closeTime"].as_i64() {
            ensure!(
                (expected..expected + HOUR_MS).contains(&close_time),
                "Candle closeTime disagrees with its hourly interval"
            );
        }
    }
    Ok(())
}

fn context_record(symbol: &str, rows: &[Value], origin: i64) -> Result<ContextRecord> {
    let recent = &rows[rows.len() - CONTEXT_LENGTH..];
    let record = ContextRecord {
        symbol: symbol.to_owned(),
        origin_ms: origin,
        context_end_open_ms: origin - HOUR_MS,
        context: recent
            .iter()
            .map(|row| number(&row["close"], f64::NAN) as f32)
            .collect(),
        context_open_ms: Some(
            recent
                .iter()
                .map(|row| row["openTime"].as_i64().unwrap())
                .collect(),
        ),
        history_sha256: Some(hex::encode(Sha256::digest(serde_json::to_vec(recent)?))),
    };
    record.validate()?;
    Ok(record)
}

fn infer(app: &App, symbol: &str, rows: &[Value], origin: i64) -> Result<Value> {
    let meta = app
        .manifest
        .symbols
        .get(symbol)
        .context("Symbol has no deployment model")?;
    ensure!(
        origin >= meta.trained_before_ms,
        "Requested origin predates model training cutoff; historical deployment-model evaluation would leak future data"
    );
    let mut models = app
        .models
        .lock()
        .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?;
    let base_values = base_features(rows, rows.len())?;
    let base_prob = models
        .symbols
        .get_mut(symbol)
        .unwrap()
        .base
        .predict(&[base_values.clone()])?[0];
    let (features, probabilities, forecast) = if meta.selected_variant == "chronos" {
        let forecast = models
            .chronos
            .as_mut()
            .context("Chronos runtime unavailable")?
            .forecast(&context_record(symbol, rows, origin)?)?;
        let mut augmented_values = base_values.clone();
        augmented_values.extend(chronos_features(&forecast)?);
        let probability = models
            .symbols
            .get_mut(symbol)
            .unwrap()
            .augmented
            .as_mut()
            .context("Augmented classifier unavailable")?
            .predict(&[augmented_values.clone()])?[0];
        (augmented_values, probability, Some(forecast))
    } else {
        (base_values, base_prob, None)
    };
    let action = decide(&probabilities);
    let probability_json =
        json!({"SELL":probabilities[0],"HOLD":probabilities[1],"BUY":probabilities[2]});
    let signal = ReplaySignal {
        origin_ms: origin,
        decision: action.into(),
        probabilities: probability_json.clone(),
        metadata: json!({"model_fingerprint":app.model_fingerprint,"model_variant":meta.selected_variant}),
        plan: None,
    };
    let risk_preview = match ml_replay::normalize_signal(symbol, rows, &signal) {
        Ok(normalized) => {
            let sizing = if normalized["eligible"] == true {
                ml_replay::position_size(&normalized, 1000., &ReplayConfig::default()).ok()
            } else {
                None
            };
            json!({"normalized_signal":normalized,"size_at_initial_equity":sizing,"equity_assumption_usdt":1000.,"advisory_only":true})
        }
        Err(error) => json!({"eligible":false,"error":error.to_string(),"advisory_only":true}),
    };
    Ok(
        json!({"schema_version":1,"symbol":symbol,"interval":"1h","origin_ms":origin,"data_as_of_ms":origin,"observed_at_ms":nofx_core::now_ms(),
        "trained_before_ms":meta.trained_before_ms,"model_fingerprint":app.model_fingerprint,"model_variant":meta.selected_variant,
        "action":action,"probabilities":probability_json,"base_probabilities":{"SELL":base_prob[0],"HOLD":base_prob[1],"BUY":base_prob[2]},
        "feature_names":meta.feature_names,"features":features,"forecast":forecast,"risk_preview":risk_preview,
        "decision_semantics":{"BUY":"OPEN_LONG","SELL":"OPEN_SHORT","HOLD":"no new order"},"real_trading_enabled":false}),
    )
}

async fn infer_async(
    app: Arc<App>,
    symbol: String,
    rows: Vec<Value>,
    origin: i64,
) -> Result<Value> {
    tokio::task::spawn_blocking(move || infer(&app, &symbol, &rows, origin))
        .await
        .context("Classification task panicked")?
}

async fn public_rows(
    app: &App,
    symbol: &str,
    origin: i64,
    start: Option<i64>,
) -> Result<Vec<Value>> {
    let limit = if start.is_some() {
        1000
    } else {
        CONTEXT_LENGTH + 4
    };
    let mut rows = app
        .exchange
        .klines(symbol, "1h", limit, start, Some(origin - 1))
        .await?;
    rows.retain(|row| {
        row["confirmed"] == true
            && row["openTime"]
                .as_i64()
                .is_some_and(|open| open >= 0 && open + HOUR_MS <= origin)
    });
    rows.sort_by_key(|row| row["openTime"].as_i64().unwrap());
    rows.dedup_by_key(|row| row["openTime"].as_i64().unwrap());
    if start.is_none() {
        ensure!(
            rows.len() >= CONTEXT_LENGTH,
            "Public hourly market history is incomplete"
        );
        rows = rows.split_off(rows.len() - CONTEXT_LENGTH);
        validate_rows(&rows, origin, nofx_core::now_ms())?;
    } else {
        ensure!(!rows.is_empty(), "Public hourly market update is empty");
        ensure!(
            rows.last().unwrap()["openTime"].as_i64() == Some(origin - HOUR_MS),
            "Public hourly market update is stale"
        );
        for pair in rows.windows(2) {
            ensure!(
                pair[1]["openTime"].as_i64()
                    == pair[0]["openTime"].as_i64().map(|time| time + HOUR_MS),
                "Public hourly market update has a gap"
            );
        }
    }
    Ok(rows)
}

fn merge_rows(existing: &[Value], added: &[Value]) -> Result<Vec<Value>> {
    let mut rows = existing.to_vec();
    for row in added {
        let open = row["openTime"]
            .as_i64()
            .context("Invalid public candle time")?;
        if let Some(prior) = existing
            .iter()
            .find(|prior| prior["openTime"].as_i64() == Some(open))
        {
            for field in ["open", "high", "low", "close", "volume"] {
                ensure!(
                    number(&prior[field], f64::NAN) == number(&row[field], f64::NAN),
                    "A previously published closed candle changed ({open}, {field}); paper history stays frozen"
                );
            }
        } else {
            if let Some(last) = rows.last() {
                ensure!(
                    last["openTime"]
                        .as_i64()
                        .and_then(|time| time.checked_add(HOUR_MS))
                        == Some(open),
                    "New public history cannot bridge a missing hour"
                );
            }
            rows.push(row.clone());
        }
    }
    Ok(rows)
}

fn expected_config(start: i64, end: i64) -> ReplayConfig {
    ReplayConfig {
        start_ms: start,
        end_ms: end,
        ..ReplayConfig::default()
    }
}

fn paper_decision<'a>(raw: &'a str, start: i64, origin: i64) -> &'a str {
    if origin >= start + PAPER_DAYS * DAY_MS - SETTLEMENT_TAIL_HOURS * HOUR_MS {
        "HOLD"
    } else {
        raw
    }
}

fn verify_paper_structure(state: &PaperState, symbol: &str, fingerprint: &str) -> Result<()> {
    ensure!(
        state.schema_version == 1 && state.symbol == symbol,
        "Paper state schema/symbol mismatch"
    );
    ensure!(
        state.model_fingerprint == fingerprint,
        "Paper state belongs to a different deployment model; existing account cannot be reset or silently migrated"
    );
    ensure!(
        state.start_ms > 0
            && state.start_ms % HOUR_MS == 0
            && state.deadline_ms == state.start_ms + PAPER_DAYS * DAY_MS,
        "Paper round boundary was altered"
    );
    ensure!(
        state.last_origin_ms >= state.start_ms && state.last_origin_ms <= state.deadline_ms,
        "Invalid paper round progress"
    );
    ensure!(
        serde_json::to_value(&state.config)?
            == serde_json::to_value(expected_config(state.start_ms, state.last_origin_ms))?,
        "Paper account capital or fixed risk configuration changed"
    );
    validate_rows(&state.candles, state.last_origin_ms, nofx_core::now_ms())?;
    ensure!(
        state.candles.first().unwrap()["openTime"].as_i64()
            == Some(state.start_ms - CONTEXT_LENGTH as i64 * HOUR_MS),
        "Paper warmup boundary changed"
    );
    let mut prior = None;
    for signal in &state.signals {
        ensure!(
            signal.origin_ms >= state.start_ms
                && signal.origin_ms <= state.last_origin_ms
                && signal.origin_ms < state.deadline_ms,
            "Paper signal is outside its fixed round"
        );
        ensure!(
            prior.is_none_or(|time| signal.origin_ms > time),
            "Paper signal timestamps must be unique and increasing"
        );
        ensure!(
            signal.metadata["model_fingerprint"] == fingerprint,
            "Paper signal used a different model version"
        );
        let raw = signal.metadata["raw_model_decision"]
            .as_str()
            .context("Paper signal has no original classifier action")?;
        ensure!(
            matches!(raw, "BUY" | "SELL" | "HOLD")
                && signal.decision == paper_decision(raw, state.start_ms, signal.origin_ms),
            "Paper signal bypassed the fixed settlement-tail policy"
        );
        prior = Some(signal.origin_ms);
    }
    ensure!(
        state.completed == (state.last_origin_ms == state.deadline_ms),
        "Paper completion boundary mismatch"
    );
    Ok(())
}

fn verify_execution_identity(state: &PaperState, expected: &str) -> Result<()> {
    ensure!(
        !state.execution_fingerprint.is_empty(),
        "Legacy paper state lacks an execution fingerprint; strict recovery refused. --adopt-zero-hold-legacy-paper is only available for untouched all-HOLD ledgers"
    );
    ensure!(
        state.execution_fingerprint == expected,
        "Paper execution sources or protection environment changed; cannot replay historical fills or reset drawdown risk under different rules"
    );
    Ok(())
}

fn verify_paper(state: &PaperState, symbol: &str, model: &str, execution: &str) -> Result<()> {
    verify_paper_structure(state, symbol, model)?;
    verify_execution_identity(state, execution)
}

fn prove_zero_hold_legacy(state: &PaperState) -> Result<()> {
    ensure!(
        !state.signals.is_empty()
            && state.signals.iter().all(|signal| signal.decision == "HOLD"
                && signal.metadata["action"] == "HOLD"
                && signal.metadata["raw_model_decision"] == "HOLD"
                && signal.metadata["effective_paper_decision"] == "HOLD"),
        "Legacy adoption requires every original and effective classifier signal to be HOLD"
    );
    let report = &state.report;
    ensure!(
        report["orders"].as_array().is_some_and(Vec::is_empty),
        "Legacy adoption requires a proven empty order ledger"
    );
    let metrics = &report["metrics"];
    for field in [
        "submitted_orders",
        "entered_trades",
        "closed_trades",
        "expired_orders",
        "unresolved_orders",
        "wins",
        "losses",
        "fees_usdt",
        "funding_usdt",
        "slippage_usdt",
        "net_pnl_usdt",
        "settled_net_usdt",
        "return_percent",
        "max_drawdown_percent",
        "daily_pause_days",
    ] {
        ensure!(
            metrics[field].as_f64() == Some(0.),
            "Legacy adoption requires zero {field}"
        );
    }
    ensure!(
        metrics["drawdown_halted_at_ms"].is_null()
            && metrics["comparison_complete"] == true
            && metrics["final_equity"].as_f64() == Some(state.config.starting_equity)
            && metrics["signals"].as_u64() == Some(state.signals.len() as u64)
            && metrics["decisions"]["BUY"] == 0
            && metrics["decisions"]["SELL"] == 0,
        "Legacy adoption requires unchanged capital and no historical risk halt"
    );
    let account = &report["final_account"];
    ensure!(
        account["unlimitedCapital"] == false,
        "Legacy account must use finite capital"
    );
    for field in ["equity", "balance", "available", "initialBalance"] {
        ensure!(
            account[field].as_f64() == Some(state.config.starting_equity),
            "Legacy adoption requires unchanged account {field}"
        );
    }
    for field in [
        "openCount",
        "usedMargin",
        "investedMargin",
        "feeReserve",
        "entryFees",
        "net",
        "realized",
        "unrealized",
    ] {
        ensure!(
            account[field].as_f64() == Some(0.),
            "Legacy adoption requires zero account {field}"
        );
    }
    let curve = report["equity_curve"]
        .as_array()
        .context("Legacy adoption requires an audited equity curve")?;
    ensure!(!curve.is_empty(), "Legacy equity curve cannot be empty");
    for point in curve {
        ensure!(
            point["equity"].as_f64() == Some(state.config.starting_equity)
                && point["balance"].as_f64() == Some(state.config.starting_equity)
                && point["daily_paused"] == false
                && point["drawdown_halted"] == false,
            "Legacy adoption requires constant capital and no historical pause or halt"
        );
        for field in [
            "net",
            "realized",
            "unrealized",
            "used_margin",
            "fee_reserve",
            "open_orders",
            "drawdown_percent",
            "daily_loss_percent",
        ] {
            ensure!(
                point[field].as_f64() == Some(0.),
                "Legacy equity curve has nonzero {field}"
            );
        }
    }
    let log = report["signal_log"]
        .as_array()
        .context("Legacy signal audit log missing")?;
    ensure!(
        log.len() == state.signals.len()
            && log.iter().all(|item| item["decision"] == "HOLD"
                && item["outcome"] == "hold"
                && item["order_id"].is_null()),
        "Legacy adoption requires a complete all-HOLD signal audit log"
    );
    Ok(())
}

/// Only the new identity field changes; original timestamps, signals, risk and
/// budget remain exact. An existing different fingerprint is never migratable.
fn bind_execution_identity(
    state: &mut PaperState,
    expected: &str,
    allow_legacy: bool,
) -> Result<bool> {
    if !state.execution_fingerprint.is_empty() {
        verify_execution_identity(state, expected)?;
        return Ok(false);
    }
    ensure!(
        allow_legacy,
        "Paper state has no execution fingerprint; strict recovery refused (legacy opt-in was not provided)"
    );
    prove_zero_hold_legacy(state)?;
    state.execution_fingerprint = expected.to_owned();
    Ok(true)
}

fn paper_report(state: &PaperState) -> Value {
    json!({"symbol":state.symbol,"started_at_ms":state.started_at_ms,"start_ms":state.start_ms,"last_origin_ms":state.last_origin_ms,"deadline_ms":state.deadline_ms,
        "round_days":PAPER_DAYS,"completed":state.completed,"automatic_round_stopped":state.completed,"model_fingerprint":state.model_fingerprint,"execution_fingerprint":state.execution_fingerprint,
        "settlement_tail_hours":SETTLEMENT_TAIL_HOURS,"new_entry_cutoff_ms":state.deadline_ms-SETTLEMENT_TAIL_HOURS*HOUR_MS,
        "starting_equity_usdt":state.config.starting_equity,"recorded_signals":state.signals.len(),"warmup_hours":CONTEXT_LENGTH,
        "report":state.report,"real_trading_enabled":false,
        "notice":if state.completed {"The 30-day evaluation round has stopped. History and risk remain frozen; a new round requires a separate explicit decision."} else {"Continuous paper validation has only started. Existing protection and shared simulator costs apply; no real orders."}})
}

async fn record_event(app: &App, symbol: &str, kind: &str, error: &str) -> Result<()> {
    let mut events = app.events.lock().await;
    let mut next = events.clone();
    next.push(json!({"time_ms":nofx_core::now_ms(),"symbol":symbol,"kind":kind,"error":error,"account_step_applied":false,"real_trading_enabled":false}));
    atomic_json(&app.paper_dir.join("events.json"), &next)?;
    *events = next;
    Ok(())
}

async fn paper_step(app: Arc<App>, symbol: &str) -> Result<Value> {
    ensure!(
        execution_digest(EXECUTION_SOURCES, &execution_environment())? == app.execution_fingerprint,
        "Protection environment changed after startup; paper replay refused before applying any account step"
    );
    ensure!(
        app.manifest.symbols.contains_key(symbol),
        "Symbol has no deployment model"
    );
    let current = nofx_core::now_ms().div_euclid(HOUR_MS) * HOUR_MS;
    let prior = app.papers.lock().await.get(symbol).cloned();
    if let Some(state) = &prior {
        if state.completed || state.last_origin_ms == current {
            let mut output = paper_report(state);
            output["already_processed"] = json!(true);
            return Ok(output);
        }
        ensure!(
            current > state.last_origin_ms,
            "Current clock precedes the persisted paper account"
        );
    }
    let origin = prior
        .as_ref()
        .map_or(current, |state| current.min(state.deadline_ms));
    let start = prior.as_ref().map(|state| state.last_origin_ms - HOUR_MS);
    let fetched = public_rows(&app, symbol, origin, start).await?;
    if origin == current {
        ensure!(
            current == nofx_core::now_ms().div_euclid(HOUR_MS) * HOUR_MS,
            "Public collection crossed the hour; retry with fresh market context"
        );
    }
    let mut papers = app.papers.lock().await;
    // Another manual/poll request could have completed while collection awaited.
    if let Some(state) = papers.get(symbol) {
        if state.completed || state.last_origin_ms >= origin {
            let mut output = paper_report(state);
            output["already_processed"] = json!(true);
            return Ok(output);
        }
    }
    let mut next = if let Some(state) = papers.get(symbol) {
        let mut state = state.clone();
        state.candles = merge_rows(&state.candles, &fetched)?;
        state
    } else {
        PaperState {
            schema_version: 1,
            symbol: symbol.into(),
            model_fingerprint: app.model_fingerprint.clone(),
            execution_fingerprint: app.execution_fingerprint.clone(),
            started_at_ms: nofx_core::now_ms(),
            start_ms: origin,
            deadline_ms: origin + PAPER_DAYS * DAY_MS,
            last_origin_ms: origin,
            completed: false,
            config: expected_config(origin, origin),
            candles: fetched,
            signals: Vec::new(),
            report: Value::Null,
        }
    };
    validate_rows(&next.candles, origin, nofx_core::now_ms())?;
    let missing_signal_hours = if next.last_origin_ms < origin {
        (origin - next.last_origin_ms) / HOUR_MS - 1
    } else {
        0
    };
    if origin < next.deadline_ms {
        let mut response =
            infer_async(app.clone(), symbol.into(), next.candles.clone(), origin).await?;
        let raw_decision = response["action"]
            .as_str()
            .context("Missing classifier action")?
            .to_owned();
        let effective_decision = paper_decision(&raw_decision, next.start_ms, origin).to_owned();
        response["raw_model_decision"] = json!(raw_decision);
        response["settlement_tail"] =
            json!(origin >= next.deadline_ms - SETTLEMENT_TAIL_HOURS * HOUR_MS);
        response["effective_paper_decision"] = json!(effective_decision);
        next.signals.push(ReplaySignal {
            origin_ms: origin,
            decision: effective_decision,
            probabilities: response["probabilities"].clone(),
            metadata: response,
            plan: None,
        });
    }
    next.last_origin_ms = origin;
    next.completed = origin == next.deadline_ms;
    next.config = expected_config(next.start_ms, origin);
    // Bind execution identity before invoking the historical simulator, not after
    // potentially recomputing fills or a drawdown halt under different rules.
    verify_paper(
        &next,
        symbol,
        &app.model_fingerprint,
        &app.execution_fingerprint,
    )?;
    let replay_symbol = symbol.to_owned();
    let candles = next.candles.clone();
    let signals = next.signals.clone();
    let config = next.config.clone();
    next.report = tokio::task::spawn_blocking(move || {
        ml_replay::replay(&replay_symbol, &candles, &signals, &config)
    })
    .await
    .context("Paper replay task panicked")??;
    atomic_json(&app.paper_dir.join(format!("{symbol}-state.json")), &next)?;
    let mut response = paper_report(&next);
    response["already_processed"] = json!(false);
    response["missed_signal_hours_not_backfilled"] = json!(missing_signal_hours.max(0));
    papers.insert(symbol.to_owned(), next);
    Ok(response)
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    Json(
        json!({"status":"ok","service":"nofx-ml-rust","started_at_ms":app.started_at_ms,"model_fingerprint":app.model_fingerprint,
        "symbols":app.manifest.symbols.keys().collect::<Vec<_>>(),"chronos_retained":app.manifest.chronos_retained,
        "poll_seconds":app.poll_seconds,"execution_fingerprint":app.execution_fingerprint,"execution_environment":app.execution_environment,
        "real_trading_enabled":false,"account_credentials_loaded":false}),
    )
}

async fn model_info(State(app): State<Arc<App>>) -> Json<Value> {
    Json(
        json!({"manifest":app.manifest,"model_fingerprint":app.model_fingerprint,"execution_fingerprint":app.execution_fingerprint,"real_trading_enabled":false}),
    )
}

async fn signal_handler(
    State(app): State<Arc<App>>,
    Json(request): Json<SignalRequest>,
) -> std::result::Result<Json<Value>, ApiError> {
    let result = async {
        ensure!(
            app.manifest.symbols.contains_key(&request.symbol),
            "Symbol has no deployment model"
        );
        let now = nofx_core::now_ms();
        let current = now.div_euclid(HOUR_MS) * HOUR_MS;
        let (rows, origin) = if let Some(rows) = request.candles {
            let inferred = rows
                .last()
                .and_then(|row| row["openTime"].as_i64())
                .and_then(|open| open.checked_add(HOUR_MS))
                .context("Provided candles have no valid final hourly boundary")?;
            let origin = request.origin_ms.unwrap_or(inferred);
            validate_rows(&rows, origin, now)?;
            (rows, origin)
        } else {
            ensure!(
                request.origin_ms.is_none_or(|origin| origin == current),
                "Symbol-only requests must use the latest closed hour"
            );
            let rows = public_rows(&app, &request.symbol, current, None).await?;
            ensure!(
                current == nofx_core::now_ms().div_euclid(HOUR_MS) * HOUR_MS,
                "Market collection crossed an hour; retry"
            );
            (rows, current)
        };
        infer_async(app.clone(), request.symbol.clone(), rows, origin).await
    }
    .await;
    match result {
        Ok(response) => Ok(Json(response)),
        Err(error) => {
            if let Err(event_error) = record_event(
                &app,
                &request.symbol,
                "inference_failed",
                &error.to_string(),
            )
            .await
            {
                return Err(ApiError(error.context(format!(
                    "Failure event could not persist: {event_error}"
                ))));
            }
            Err(ApiError(error))
        }
    }
}

async fn paper_handler(
    State(app): State<Arc<App>>,
    Json(request): Json<PaperRequest>,
) -> std::result::Result<Json<Value>, ApiError> {
    match paper_step(app.clone(), &request.symbol).await {
        Ok(response) => Ok(Json(response)),
        Err(error) => {
            if let Err(event_error) = record_event(
                &app,
                &request.symbol,
                "paper_step_failed",
                &error.to_string(),
            )
            .await
            {
                return Err(ApiError(error.context(format!(
                    "Failure event could not persist: {event_error}"
                ))));
            }
            Err(ApiError(error))
        }
    }
}

async fn paper_info(State(app): State<Arc<App>>) -> Json<Value> {
    let papers = app.papers.lock().await;
    let reports: BTreeMap<_, _> = papers
        .iter()
        .map(|(symbol, state)| (symbol.clone(), paper_report(state)))
        .collect();
    Json(
        json!({"accounts":reports,"events":*app.events.lock().await,"round_days":PAPER_DAYS,"real_trading_enabled":false}),
    )
}

async fn automatic_paper(app: Arc<App>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(app.poll_seconds));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        for symbol in app.manifest.symbols.keys() {
            if let Err(error) = paper_step(app.clone(), symbol).await {
                eprintln!("Paper {symbol}: {error:#}");
                if let Err(event_error) = record_event(
                    &app,
                    symbol,
                    "automatic_paper_step_failed",
                    &error.to_string(),
                )
                .await
                {
                    eprintln!("Paper event persistence failed: {event_error:#}");
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(args.port > 0, "Port must be positive");
    fs::create_dir_all(&args.paper_dir)?;
    // The OS lock is held for the process lifetime. Atomic writes alone cannot
    // prevent two servers from racing to replace the same finite-capital account.
    let paper_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(args.paper_dir.join("process.lock"))?;
    paper_lock.try_lock().map_err(|error| {
        anyhow::anyhow!("Paper directory is already owned by another process: {error:?}")
    })?;
    let (manifest, models, fingerprint) = load_models(&args)?;
    let environment = execution_environment();
    let execution_fingerprint = execution_digest(EXECUTION_SOURCES, &environment)?;
    let mut papers = BTreeMap::new();
    let mut adopted_paths = Vec::new();
    for symbol in manifest.symbols.keys() {
        let path = args.paper_dir.join(format!("{symbol}-state.json"));
        if path.is_file() {
            let mut state: PaperState = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("Restore paper account {}", path.display()))?;
            verify_paper_structure(&state, symbol, &fingerprint)?;
            let adopted = bind_execution_identity(
                &mut state,
                &execution_fingerprint,
                args.adopt_zero_hold_legacy_paper,
            )?;
            verify_paper(&state, symbol, &fingerprint, &execution_fingerprint)?;
            // Reports are derived state. Rebuild rather than trusting persisted P&L.
            state.report =
                ml_replay::replay(symbol, &state.candles, &state.signals, &state.config)?;
            if adopted {
                adopted_paths.push((path, symbol.clone()));
            }
            papers.insert(symbol.clone(), state);
        }
    }
    let event_path = args.paper_dir.join("events.json");
    let events = if event_path.is_file() {
        serde_json::from_slice(&fs::read(event_path)?)?
    } else {
        Vec::new()
    };
    // Validate every account before writing any one-time migration. The directory
    // process lock prevents old/new servers from modifying these together.
    for (path, symbol) in adopted_paths {
        atomic_json(&path, papers.get(&symbol).unwrap())?;
        eprintln!(
            "Adopted execution fingerprint for untouched all-HOLD legacy paper account {symbol}; original round and capital preserved"
        );
    }
    let app = Arc::new(App {
        manifest,
        model_fingerprint: fingerprint,
        execution_fingerprint,
        execution_environment: environment,
        models: Mutex::new(models),
        exchange: Exchange::public()?,
        papers: AsyncMutex::new(papers),
        events: AsyncMutex::new(events),
        paper_dir: args.paper_dir,
        started_at_ms: nofx_core::now_ms(),
        poll_seconds: args.poll_seconds,
    });
    let router = Router::new()
        .route("/health", get(health))
        .route("/models", get(model_info))
        .route("/signal", post(signal_handler))
        .route("/paper/step", post(paper_handler))
        .route("/paper", get(paper_info))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(app.clone());
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, args.port)).await?;
    println!(
        "nofx-ml CPU JSON on http://127.0.0.1:{}; real trading disabled",
        args.port
    );
    let poll = (args.poll_seconds > 0).then(|| tokio::spawn(automatic_paper(app)));
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    if let Some(poll) = poll {
        poll.abort();
    }
    result?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(origin: i64) -> Vec<Value> {
        (0..CONTEXT_LENGTH).map(|i|json!({"openTime":origin-(CONTEXT_LENGTH-i)as i64*HOUR_MS,"open":100.,"high":101.,"low":99.,"close":100.,"volume":1.,"confirmed":true})).collect()
    }

    #[test]
    fn refuses_future_gaps_unclosed_and_bad_ohlc() {
        let origin = 300 * HOUR_MS;
        let good = candles(origin);
        validate_rows(&good, origin, origin).unwrap();
        assert!(validate_rows(&good, origin, origin - HOUR_MS).is_err());
        let mut bad = good.clone();
        bad[10]["openTime"] = json!(origin);
        assert!(validate_rows(&bad, origin, origin).is_err());
        bad = good.clone();
        bad[10]["confirmed"] = json!(false);
        assert!(validate_rows(&bad, origin, origin).is_err());
        bad = good;
        bad[10]["close"] = json!(200.);
        assert!(validate_rows(&bad, origin, origin).is_err());
    }

    #[test]
    fn forbids_live_capital_risk_and_external_decision_request_fields() {
        for field in [
            "mode",
            "live",
            "margin",
            "leverage",
            "decision",
            "risk_fraction",
            "starting_equity",
        ] {
            let mut request = json!({"symbol":"BTCUSDT"});
            request[field] = json!("live");
            assert!(serde_json::from_value::<PaperRequest>(request.clone()).is_err());
            assert!(serde_json::from_value::<SignalRequest>(request).is_err());
        }
    }

    #[test]
    fn merging_deduplicates_and_preserves_published_history() {
        let origin = 300 * HOUR_MS;
        let good = candles(origin);
        assert_eq!(merge_rows(&good, &good[250..]).unwrap(), good);
        let mut changed = good[250..].to_vec();
        changed[0]["volume"] = json!(2.);
        assert!(merge_rows(&good, &changed).is_err());
        let mut next = good.last().unwrap().clone();
        next["openTime"] = json!(origin);
        assert_eq!(
            merge_rows(&good, &[next.clone()]).unwrap().len(),
            CONTEXT_LENGTH + 1
        );
        next["openTime"] = json!(origin + HOUR_MS);
        assert!(merge_rows(&good, &[next]).is_err());
    }

    #[test]
    fn atomic_state_replacement_keeps_valid_json_and_no_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("state.json");
        atomic_json(&file, &json!({"step":1})).unwrap();
        atomic_json(&file, &json!({"step":2})).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap()["step"],
            2
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn settlement_tail_preserves_raw_class_but_blocks_new_entries_at_exact_boundary() {
        let start = 300 * HOUR_MS;
        let cutoff = start + PAPER_DAYS * DAY_MS - SETTLEMENT_TAIL_HOURS * HOUR_MS;
        assert_eq!(paper_decision("BUY", start, cutoff - HOUR_MS), "BUY");
        assert_eq!(paper_decision("SELL", start, cutoff), "HOLD");
        assert_eq!(paper_decision("BUY", start, cutoff + HOUR_MS), "HOLD");
        assert_eq!(paper_decision("HOLD", start, cutoff - HOUR_MS), "HOLD");
    }

    #[test]
    fn old_feature_code_and_name_reordering_are_rejected_before_model_loading() {
        let current = hex::encode(Sha256::digest(include_bytes!("../ml_features.rs")));
        validate_feature_schema_hash(&current).unwrap();
        assert!(validate_feature_schema_hash(&"0".repeat(64)).is_err());
        let mut meta = SymbolManifest {
            base_path: "BTCUSDT-base.txt".into(),
            augmented_path: None,
            selected_variant: "base".into(),
            trained_before_ms: HOUR_MS,
            feature_names: BASE_FEATURE_NAMES
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
            base_feature_names: BASE_FEATURE_NAMES
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
            chronos_feature_names: Vec::new(),
            base_feature_count: Some(BASE_FEATURE_NAMES.len()),
            augmented_feature_count: None,
        };
        validate_feature_names(&meta).unwrap();
        meta.feature_names.swap(0, 1);
        assert!(validate_feature_names(&meta).is_err());
        meta.feature_names.swap(0, 1);
        meta.base_feature_names.swap(0, 1);
        assert!(validate_feature_names(&meta).is_err());
        meta.base_feature_names.swap(0, 1);
        meta.selected_variant = "chronos".into();
        assert!(validate_feature_names(&meta).is_err());
        meta.feature_names
            .extend(CHRONOS_FEATURE_NAMES.iter().map(|name| (*name).to_owned()));
        validate_feature_names(&meta).unwrap();
    }

    fn zero_hold_legacy() -> PaperState {
        let origin = 300 * HOUR_MS;
        let rows = candles(origin);
        let signals = vec![ReplaySignal {
            origin_ms: origin,
            decision: "HOLD".into(),
            probabilities: json!({"SELL":0.2,"HOLD":0.6,"BUY":0.2}),
            metadata: json!({"model_fingerprint":"model","action":"HOLD","raw_model_decision":"HOLD","effective_paper_decision":"HOLD"}),
            plan: None,
        }];
        let config = expected_config(origin, origin);
        let report = ml_replay::replay("BTCUSDT", &rows, &signals, &config).unwrap();
        PaperState {
            schema_version: 1,
            symbol: "BTCUSDT".into(),
            model_fingerprint: "model".into(),
            execution_fingerprint: String::new(),
            started_at_ms: origin + 100,
            start_ms: origin,
            deadline_ms: origin + PAPER_DAYS * DAY_MS,
            last_origin_ms: origin,
            completed: false,
            config,
            candles: rows,
            signals,
            report,
        }
    }

    #[test]
    fn changed_execution_environment_or_source_refuses_recovery_even_with_legacy_flag() {
        let environment: BTreeMap<String, Option<String>> = EXECUTION_ENVIRONMENT_KEYS
            .iter()
            .map(|key| ((*key).into(), None))
            .collect();
        let first = execution_digest(
            &[("simulator.rs", b"compiled-engine-version-1")],
            &environment,
        )
        .unwrap();
        let mut changed_environment = environment.clone();
        changed_environment.insert("NOFX_PARTIAL_TP".into(), Some("false".into()));
        let env_fingerprint = execution_digest(
            &[("simulator.rs", b"compiled-engine-version-1")],
            &changed_environment,
        )
        .unwrap();
        let source_fingerprint = execution_digest(
            &[("simulator.rs", b"compiled-engine-version-2")],
            &environment,
        )
        .unwrap();
        assert_ne!(first, env_fingerprint);
        assert_ne!(first, source_fingerprint);
        let mut state = zero_hold_legacy();
        assert!(bind_execution_identity(&mut state, &first, true).unwrap());
        let original = serde_json::to_value(&state).unwrap();
        for changed in [env_fingerprint, source_fingerprint] {
            assert!(verify_paper(&state, "BTCUSDT", "model", &changed).is_err());
            assert!(bind_execution_identity(&mut state, &changed, true).is_err());
            assert_eq!(original, serde_json::to_value(&state).unwrap());
        }
    }

    #[test]
    fn missing_execution_fingerprint_is_strict_and_narrow_adoption_preserves_entire_round() {
        let expected = "a".repeat(64);
        let state = zero_hold_legacy();
        let mut old_json = serde_json::to_value(&state).unwrap();
        old_json
            .as_object_mut()
            .unwrap()
            .remove("execution_fingerprint");
        let mut restored: PaperState = serde_json::from_value(old_json).unwrap();
        assert!(restored.execution_fingerprint.is_empty());
        let original = serde_json::to_value(&restored).unwrap();
        assert!(verify_paper(&restored, "BTCUSDT", "model", &expected).is_err());
        assert!(bind_execution_identity(&mut restored, &expected, false).is_err());
        assert_eq!(original, serde_json::to_value(&restored).unwrap());
        assert!(bind_execution_identity(&mut restored, &expected, true).unwrap());
        verify_paper(&restored, "BTCUSDT", "model", &expected).unwrap();
        let mut adopted = serde_json::to_value(&restored).unwrap();
        adopted["execution_fingerprint"] = json!("");
        assert_eq!(
            adopted, original,
            "Migration changed something besides the new execution fingerprint"
        );
        assert!(!bind_execution_identity(&mut restored, &expected, false).unwrap());
    }

    #[test]
    fn legacy_adoption_rejects_orders_classifications_costs_losses_and_historical_halts() {
        let original = zero_hold_legacy();
        let mut unsafe_states = Vec::new();
        let mut state = original.clone();
        state.signals[0].decision = "BUY".into();
        unsafe_states.push(state);
        state = original.clone();
        state.signals[0].metadata["raw_model_decision"] = json!("BUY");
        unsafe_states.push(state);
        state = original.clone();
        state.report["orders"] = json!([{"status":"pending"}]);
        unsafe_states.push(state);
        for (field, value) in [
            ("fees_usdt", json!(0.1)),
            ("net_pnl_usdt", json!(-1.)),
            ("max_drawdown_percent", json!(1.)),
            ("daily_pause_days", json!(1)),
            ("drawdown_halted_at_ms", json!(original.start_ms)),
        ] {
            state = original.clone();
            state.report["metrics"][field] = value;
            unsafe_states.push(state);
        }
        state = original.clone();
        state.report["equity_curve"][0]["drawdown_halted"] = json!(true);
        unsafe_states.push(state);
        state = original.clone();
        state.report["equity_curve"][0]["daily_paused"] = json!(true);
        unsafe_states.push(state);
        state = original.clone();
        state.report["final_account"]["balance"] = json!(999.);
        unsafe_states.push(state);
        for mut state in unsafe_states {
            let before = serde_json::to_value(&state).unwrap();
            assert!(bind_execution_identity(&mut state, &"a".repeat(64), true).is_err());
            assert_eq!(before, serde_json::to_value(state).unwrap());
        }
    }
}
