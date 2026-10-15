use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use clap::Parser;
use nofx_core::chronos::{
    CONTEXT_LENGTH, ChronosModel, ContextRecord, ForecastDocument, ForecastRecord, HORIZON_HOURS,
    InputDocument, MODEL_ID, latency_summary, live_context,
};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Parser)]
#[command(about = "Run Chronos-Bolt-Tiny on the local CPU; emit 12 hourly forecast intervals")]
struct Args {
    #[arg(long, default_value = "data/chronos/chronos-bolt-tiny.onnx")]
    model: PathBuf,
    #[arg(
        long,
        default_value = "data/chronos/model-toolchain/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"
    )]
    runtime: PathBuf,
    #[arg(long, default_value_t = 4)]
    threads: usize,
    #[arg(long, conflicts_with_all = ["serve", "live_symbol"])]
    inputs: Option<PathBuf>,
    #[arg(long, required_unless_present = "serve")]
    output: Option<PathBuf>,
    #[arg(long, conflicts_with = "serve")]
    live_symbol: Vec<String>,
    #[arg(long, default_value_t = 3)]
    warmup_runs: usize,
    #[arg(long)]
    serve: bool,
    #[arg(long, default_value_t = 18081)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(args.warmup_runs <= 100, "warmup-runs must be at most 100");
    let started = Instant::now();
    let mut model = ChronosModel::load(&args.model, &args.runtime, args.threads)?;
    if args.serve {
        let state = Arc::new(Mutex::new(model));
        let app = Router::new()
            .route("/health", get(health))
            .route("/forecast", post(forecast))
            .with_state(state);
        let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), args.port);
        let listener = tokio::net::TcpListener::bind(address).await?;
        println!(
            "{}",
            json!({"status":"ready","url":format!("http://{address}"),"model":MODEL_ID,"device":"cpu","threads":args.threads})
        );
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
        return Ok(());
    }
    let (contexts, holdout_start_ms) = if let Some(path) = args.inputs {
        let document: InputDocument = serde_json::from_slice(&std::fs::read(&path)?)
            .with_context(|| format!("Read input document {}", path.display()))?;
        ensure!(
            document.schema_version == 1,
            "Unsupported input schema_version"
        );
        (document.records, document.holdout_start_ms)
    } else {
        ensure!(
            !args.live_symbol.is_empty(),
            "Specify --inputs or --live-symbol"
        );
        let mut contexts = Vec::with_capacity(args.live_symbol.len());
        for symbol in &args.live_symbol {
            contexts.push(live_context(&symbol.to_ascii_uppercase()).await?);
        }
        (contexts, None)
    };
    ensure!(!contexts.is_empty(), "Input records must not be empty");
    // Validate the complete document before producing any partial result.
    for record in &contexts {
        record.validate()?;
    }
    for _ in 0..args.warmup_runs {
        model.forecast(&contexts[0])?;
    }
    let mut records = Vec::with_capacity(contexts.len());
    for (index, record) in contexts.iter().enumerate() {
        records.push(
            model
                .forecast(record)
                .with_context(|| format!("Forecast {} at {}", record.symbol, record.origin_ms))?,
        );
        if (index + 1) % 100 == 0 {
            eprintln!("forecasted {}/{} records", index + 1, contexts.len());
        }
    }
    let document = ForecastDocument {
        schema_version: 1,
        model: MODEL_ID.into(),
        interval: "1h".into(),
        context_length: CONTEXT_LENGTH,
        horizon_hours: HORIZON_HOURS,
        holdout_start_ms,
        model_load_ms: model.model_load_ms,
        total_ms: started.elapsed().as_secs_f64() * 1000.0,
        inference_summary: latency_summary(&records),
        records,
    };
    let output = args.output.context("Missing output path")?;
    write_json(&output, &document)?;
    println!(
        "{}",
        json!({"output":output,"model":document.model,"records":document.records.len(),"model_load_ms":document.model_load_ms,"inference":document.inference_summary,"total_ms":document.total_ms})
    );
    Ok(())
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

type ModelState = Arc<Mutex<ChronosModel>>;
type ApiError = (StatusCode, Json<Value>);

async fn health() -> Json<Value> {
    Json(
        json!({"status":"ok","model":MODEL_ID,"device":"cpu","context_length":CONTEXT_LENGTH,"interval":"1h","horizon_hours":HORIZON_HOURS}),
    )
}

async fn forecast(
    State(model): State<ModelState>,
    Json(record): Json<ContextRecord>,
) -> std::result::Result<Json<ForecastRecord>, ApiError> {
    record.validate().map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":error.to_string()})),
        )
    })?;
    ensure_closed_live_request(&record)?;
    tokio::task::spawn_blocking(move || {
        let mut model = model
            .lock()
            .map_err(|_| anyhow::anyhow!("Model lock poisoned"))?;
        model.forecast(&record)
    })
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":error.to_string()})),
        )
    })?
    .map(Json)
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":error.to_string()})),
        )
    })
}

fn ensure_closed_live_request(record: &ContextRecord) -> std::result::Result<(), ApiError> {
    if record.origin_ms > nofx_core::now_ms() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                json!({"error":"Context must contain only closed hourly candles; origin_ms is in the future"}),
            ),
        ));
    }
    Ok(())
}
