//! CLI and loopback HTTP access to a trained monthly research candidate.
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
    exchange::Exchange,
    ml_lightgbm::DEFAULT_RUNTIME_PATH,
    ml_monthly_inference::{
        MarketContext, MonthlyPredictor, SignalRequest, fetch_live_candles_for_interval,
        fetch_live_history, request_origin_for_interval,
    },
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

#[derive(Parser)]
#[command(about = "Read-only Chronos-Bolt-Tiny + global LightGBM candidate inference")]
struct Args {
    #[arg(long)]
    model_dir: PathBuf,
    /// Review the model's verified frozen collector snapshot, without live REST calls.
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long,default_value=DEFAULT_RUNTIME_PATH)]
    lightgbm_runtime: PathBuf,
    #[arg(long, default_value_t = 4)]
    threads: usize,
    /// Serve /health, /models, /signal and /pipeline on loopback only.
    #[arg(long)]
    serve: bool,
    #[arg(long, default_value_t = 18084)]
    port: u16,
    #[arg(long, required_unless_present = "serve")]
    symbol: Option<String>,
    /// Collector symbol document; omitted to collect latest public market inputs.
    #[arg(long)]
    input: Option<PathBuf>,
    /// Collector history/<symbol>.json for offline inference.
    #[arg(long)]
    history: Option<PathBuf>,
    /// Collector symbols directory containing BTCUSDT.json and ETHUSDT.json.
    #[arg(long)]
    market_data_dir: Option<PathBuf>,
    #[arg(long)]
    origin_ms: Option<i64>,
    #[arg(long)]
    output: Option<PathBuf>,
}

struct App {
    predictor: Mutex<MonthlyPredictor>,
    exchange: Exchange,
    budget: Arc<Semaphore>,
    started_at_ms: i64,
}
struct ApiError(anyhow::Error);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"error":format!("{:#}",self.0),"advisory_only":true,"orders_enabled":false,"real_trading_enabled":false}))).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}

fn load_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path)?)
        .with_context(|| format!("Read JSON {}", path.display()))
}
fn closed_prefix(document: &Value, origin: Option<i64>, interval: &str) -> Result<Vec<Value>> {
    let step_ms = nofx_core::chronos::interval_ms(interval)?;
    let all = document["datasets"][interval]
        .as_array()
        .or_else(|| {
            document["datasets"]["1h"]
                .as_array()
                .filter(|_| interval == "1h")
        })
        .or_else(|| document.as_array())
        .with_context(|| format!("Input requires datasets.{interval} or a candle array"))?;
    let mut rows: Vec<Value> = all
        .iter()
        .filter(|row| {
            origin.is_none_or(|at| {
                row["openTime"]
                    .as_i64()
                    .is_some_and(|open| open + step_ms <= at)
            })
        })
        .cloned()
        .collect();
    if rows.len() > 256 {
        rows.drain(..rows.len() - 256);
    }
    Ok(rows)
}

async fn run_request(app: Arc<App>, request: SignalRequest) -> Result<Value> {
    // Keep collection and CPU work bounded together; no unbounded queue of public calls.
    let _permit = app
        .budget
        .clone()
        .try_acquire_owned()
        .context("Candidate inference busy; retry after the current request")?;
    ensure!(
        app.predictor
            .lock()
            .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
            .supports(&request.symbol),
        "Symbol is outside the trained universe"
    );
    let frozen_origin = app
        .predictor
        .lock()
        .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
        .frozen_origin();
    if let Some(origin) = frozen_origin {
        ensure!(
            request.candles.is_none() && request.history.is_none() && request.market.is_none(),
            "Frozen snapshot mode accepts only a symbol, without external data overrides"
        );
        ensure!(
            request.origin_ms.is_none_or(|value| value == origin),
            "Frozen snapshot origin is fixed by the verified collector manifest"
        );
        let symbol = request.symbol;
        return tokio::task::spawn_blocking(move || {
            app.predictor
                .lock()
                .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
                .infer_frozen(&symbol, nofx_core::now_ms())
        })
        .await
        .context("Frozen candidate inference task failed")?;
    }
    let interval = app
        .predictor
        .lock()
        .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
        .interval()
        .to_owned();
    let step_ms = nofx_core::chronos::interval_ms(&interval)?;
    let origin = request_origin_for_interval(&request, nofx_core::now_ms(), &interval)?;
    let live_input = request.candles.is_none();
    let (rows, history, market) = if let Some(rows) = request.candles {
        (
            rows,
            request.history.unwrap_or(Value::Null),
            request.market.unwrap_or_default(),
        )
    } else {
        let (rows, history, btc, eth) = tokio::join!(
            fetch_live_candles_for_interval(&app.exchange, &request.symbol, origin, &interval),
            fetch_live_history(&app.exchange, &request.symbol, origin),
            fetch_live_candles_for_interval(&app.exchange, "BTCUSDT", origin, &interval),
            fetch_live_candles_for_interval(&app.exchange, "ETHUSDT", origin, &interval)
        );
        ensure!(
            origin == nofx_core::now_ms().div_euclid(step_ms) * step_ms,
            "Collection crossed a {interval} boundary; retry with new closed inputs"
        );
        (
            rows?,
            history?,
            MarketContext {
                btc: btc?,
                eth: eth?,
            },
        )
    };
    let symbol = request.symbol;
    tokio::task::spawn_blocking(move || {
        let mut output = app
            .predictor
            .lock()
            .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
            .infer(
                &symbol,
                &rows,
                &history,
                &market,
                origin,
                nofx_core::now_ms(),
            )?;
        if live_input {
            output["data_mode"] = json!("live_public");
        }
        Ok(output)
    })
    .await
    .context("Candidate inference task failed")?
}
async fn health(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    let mut info = app
        .predictor
        .lock()
        .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
        .info();
    info.as_object_mut().unwrap().remove("manifest");
    info["status"] = json!("ok");
    info["started_at_ms"] = json!(app.started_at_ms);
    Ok(Json(info))
}
async fn models(State(app): State<Arc<App>>) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        app.predictor
            .lock()
            .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
            .info(),
    ))
}
async fn signal(
    State(app): State<Arc<App>>,
    Json(request): Json<SignalRequest>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(run_request(app, request).await?))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(args.port > 0, "Port must be positive");
    let mut predictor =
        MonthlyPredictor::load(&args.model_dir, &args.lightgbm_runtime, args.threads)?;
    if let Some(directory) = &args.data_dir {
        ensure!(
            args.input.is_none() && args.history.is_none() && args.market_data_dir.is_none(),
            "--data-dir verifies a complete frozen source; external input/history/market overrides are forbidden"
        );
        predictor.configure_frozen_source(directory)?;
    }
    let app = Arc::new(App {
        predictor: Mutex::new(predictor),
        exchange: Exchange::public()?,
        budget: Arc::new(Semaphore::new(1)),
        started_at_ms: nofx_core::now_ms(),
    });
    if args.serve {
        ensure!(
            args.input.is_none()
                && args.history.is_none()
                && args.market_data_dir.is_none()
                && args.origin_ms.is_none()
                && args.output.is_none(),
            "Server mode does not use offline CLI input/output flags"
        );
        let router = Router::new()
            .route("/health", get(health))
            .route("/models", get(models))
            .route("/signal", post(signal))
            .route("/pipeline", post(signal))
            .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
            .with_state(app);
        let listener =
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, args.port)).await?;
        println!(
            "Monthly research candidate on http://127.0.0.1:{}; advisory only; orders disabled",
            args.port
        );
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
        return Ok(());
    }
    let symbol = args
        .symbol
        .context("--symbol required for CLI prediction")?;
    let interval = app
        .predictor
        .lock()
        .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?
        .interval()
        .to_owned();
    let step_ms = nofx_core::chronos::interval_ms(&interval)?;
    let candles = args
        .input
        .as_ref()
        .map(|path| {
            load_json(path).and_then(|document| closed_prefix(&document, args.origin_ms, &interval))
        })
        .transpose()?;
    ensure!(
        args.input.is_some() || (args.history.is_none() && args.market_data_dir.is_none()),
        "Offline history/market inputs require --input"
    );
    let history = args
        .history
        .as_ref()
        .map(|path| load_json(path))
        .transpose()?;
    let inferred = candles
        .as_ref()
        .and_then(|rows| rows.last())
        .and_then(|row| row["openTime"].as_i64())
        .map(|time| time + step_ms);
    let origin = args.origin_ms.or(inferred);
    let market = args
        .market_data_dir
        .as_ref()
        .map(|directory| -> Result<MarketContext> {
            Ok(MarketContext {
                btc: closed_prefix(
                    &load_json(&directory.join("BTCUSDT.json"))?,
                    origin,
                    &interval,
                )?,
                eth: closed_prefix(
                    &load_json(&directory.join("ETHUSDT.json"))?,
                    origin,
                    &interval,
                )?,
            })
        })
        .transpose()?;
    let result = run_request(
        app,
        SignalRequest {
            symbol,
            candles,
            history,
            origin_ms: args.origin_ms,
            market,
        },
    )
    .await?;
    let bytes = serde_json::to_vec_pretty(&result)?;
    if let Some(path) = args.output {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .with_context(|| {
                format!(
                    "Output already exists or cannot be created: {}",
                    path.display()
                )
            })?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        println!("{}", path.display());
    } else {
        println!("{}", std::str::from_utf8(&bytes)?);
    }
    Ok(())
}
