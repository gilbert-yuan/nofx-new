//! Cost-adjusted, weekly-refitted offline research; never an execution service.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    chronos, ml_features,
    ml_intraday_data::{self, IntradayPreparationConfig},
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmRegressor, LightGbmRuntime},
    ml_portfolio::{PortfolioConfig, replay_portfolio},
    ml_profit_data::{ProfitData, ProfitRecord, load_profit_data},
    ml_profit_policy::{
        DAY, DirectionCalibration, ResidualObservation, calibrate_side, decide, weekly_boundaries,
    },
    ml_replay::{ReplayConfig, ReplaySignal},
    ml_training_data, timestamp,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const HOUR: i64 = 3_600_000;
const EDGES: [f64; 4] = [0., 0.001, 0.0025, 0.005];

#[derive(Parser)]
#[command(
    about = "Train separate cost-adjusted long/short models with causal weekly refits and shared-account replay"
)]
struct Args {
    #[arg(long, default_value = "output/ml-rolling-20261016")]
    previous_run: PathBuf,
    #[arg(long, default_value = "data/ml/expanded-archive-20261016")]
    data_dir: PathBuf,
    #[arg(
        long,
        default_value = "data/ml/expanded-archive-20261016/execution-feature-cache-v1"
    )]
    cache_dir: PathBuf,
    #[arg(long, default_value = "output/ml-profit-train-20261016")]
    output_dir: PathBuf,
    #[arg(long, default_value=DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long, default_value_t = 2)]
    threads: usize,
    #[arg(long, default_value_t = 4)]
    evaluation_weeks: usize,
    #[arg(long, default_value_t = 120)]
    max_iterations: usize,
    /// Native candle interval. 15m never upsamples hourly archives.
    #[arg(long, default_value = "1h")]
    interval: String,
    #[arg(long, default_value = "data/chronos/chronos-bolt-tiny.onnx")]
    forecast_model: PathBuf,
    #[arg(
        long,
        default_value = "data/chronos/model-toolchain/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"
    )]
    forecast_runtime: PathBuf,
    #[arg(long, default_value_t = 50)]
    top_n: usize,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long)]
    resume: bool,
}

struct Protocol {
    interval: String,
    candle_ms: i64,
    maturity_ms: i64,
}

impl Args {
    fn protocol(&self) -> Result<Protocol> {
        ensure!(
            self.interval == "1h" || self.interval == "15m",
            "Candle interval must be 1h or 15m"
        );
        let candle_ms = chronos::interval_ms(&self.interval)?;
        Ok(Protocol {
            interval: self.interval.clone(),
            candle_ms,
            maturity_ms: 48 * candle_ms,
        })
    }
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
            "Immutable checkpoint changed: {}",
            path.display()
        );
        return Ok(());
    }
    fs::create_dir_all(path.parent().context("Missing parent")?)?;
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
            ensure!(fs::read(path)? == bytes, "Concurrent checkpoint differs");
            Ok(())
        }
        Err(e) => Err(e.into()),
    };
    let _ = fs::remove_file(temporary);
    published
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_exact(path, &serde_json::to_vec_pretty(value)?)
}
fn status(output: &Path, phase: &str, detail: Value) -> Result<()> {
    let path = output.join("training-status.json");
    let temporary = output.join(format!("status.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(
            &json!({"phase":phase,"detail":detail,"process_id":std::process::id(),"updated_at_utc":chrono::Utc::now(),"orders_enabled":false,"deployment_approved":false}),
        )?,
    )?;
    fs::rename(&temporary, &path).or_else(|_| {
        if path.exists() {
            fs::remove_file(&path)?;
        }
        fs::rename(&temporary, &path)
    })?;
    println!("{}", json!({"stage":phase,"detail":detail}));
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Variant {
    id: String,
    training_days: usize,
    chronos: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Prediction {
    index: usize,
    symbol: String,
    origin_ms: i64,
    model_asof_ms: i64,
    long: f64,
    short: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Policy {
    asof_ms: i64,
    calibration_start_ms: i64,
    calibration_end_ms: i64,
    validation_start_ms: i64,
    validation_end_ms: i64,
    long: DirectionCalibration,
    short: DirectionCalibration,
    min_edge: Option<f64>,
    trials: Vec<Value>,
}

fn parameters(threads: usize) -> String {
    format!(
        "boosting=gbdt device_type=cpu objective=regression metric=l2 deterministic=true force_col_wise=true num_threads={threads} num_leaves=15 min_data_in_leaf=160 lambda_l1=1 lambda_l2=20 learning_rate=0.05 max_depth=4 seed=42 feature_fraction_seed=42 bagging_seed=42 data_random_seed=42 feature_fraction=1 bagging_fraction=1 bagging_freq=0 verbosity=-1"
    )
}
fn feature(row: &ProfitRecord, chronos: bool) -> Result<Vec<f64>> {
    let mut x = row.record.base.clone();
    if chronos {
        x.extend(ml_features::chronos_features(&row.record.forecast)?);
    }
    ensure!(x.iter().all(|v| v.is_finite()), "Invalid causal features");
    Ok(x)
}
fn target(row: &ProfitRecord, long: bool) -> Option<f64> {
    if long {
        row.long_target
    } else {
        row.short_target
    }
}
fn indexes(data: &ProfitData, start: i64, end: i64, mature_at: i64, long: bool) -> Vec<usize> {
    data.records
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            (r.record.origin_ms >= start
                && r.record.origin_ms < end
                && r.record.mature_by_ms <= mature_at
                && target(r, long).is_some())
            .then_some(i)
        })
        .collect()
}
fn xy(
    data: &ProfitData,
    indexes: &[usize],
    variant: &Variant,
    long: bool,
) -> Result<(Vec<Vec<f64>>, Vec<f64>)> {
    let x = indexes
        .iter()
        .map(|&i| feature(&data.records[i], variant.chronos))
        .collect::<Result<Vec<_>>>()?;
    let y = indexes
        .iter()
        .map(|&i| target(&data.records[i], long).context("Missing selected net target"))
        .collect::<Result<Vec<_>>>()?;
    Ok((x, y))
}

fn fit_side(
    args: &Args,
    data: &ProfitData,
    variant: &Variant,
    asof: i64,
    long: bool,
    directory: &Path,
    runtime: Arc<LightGbmRuntime>,
) -> Result<LightGbmRegressor> {
    let name = if long { "long" } else { "short" };
    let model_path = directory.join(format!("{name}.txt"));
    let meta_path = directory.join(format!("{name}-fit.json"));
    if meta_path.exists() {
        let meta = read_json(&meta_path)?;
        ensure!(
            meta["model_asof_ms"] == asof && meta["model_sha256"] == sha(&fs::read(&model_path)?),
            "Model checkpoint identity mismatch"
        );
        return LightGbmRegressor::load(runtime, &model_path);
    }
    status(
        &args.output_dir,
        "fit",
        json!({"variant":variant.id,"asof_ms":asof,"side":name}),
    )?;
    let start = asof - variant.training_days as i64 * DAY;
    let split = asof - 7 * DAY;
    let train = indexes(data, start, split, split, long);
    let validation = indexes(data, split, asof, asof, long);
    ensure!(
        train.len() >= 90 && validation.len() >= 30,
        "Insufficient mature {name} training/early-stop rows at {asof}"
    );
    let (x, y) = xy(data, &train, variant, long)?;
    let (vx, vy) = xy(data, &validation, variant, long)?;
    let probe = LightGbmRegressor::train_config_with_validation(
        runtime.clone(),
        &x,
        &y,
        &parameters(args.threads),
        args.max_iterations,
        &vx,
        &vy,
        25,
        5,
    )?;
    let stopping = serde_json::to_value(probe.early_stopping_summary())?;
    let iterations = probe.summary().iterations;
    drop(probe);
    drop(x);
    drop(y);
    drop(vx);
    drop(vy);
    // Refit only after freezing the boosting count. Calibration later uses OOF
    // predictions from older weekly models, never this refit's in-sample outputs.
    let full = indexes(data, start, asof, asof, long);
    let (x, y) = xy(data, &full, variant, long)?;
    let model =
        LightGbmRegressor::train_config(runtime, &x, &y, &parameters(args.threads), iterations)?;
    let last_origin = full
        .iter()
        .map(|&i| data.records[i].record.origin_ms)
        .max()
        .context("No mature refit rows")?;
    let protocol = args.protocol()?;
    ensure!(
        last_origin + protocol.maturity_ms <= asof,
        "Label horizon leaked into refit"
    );
    write_exact(&model_path, model.model_text()?.as_bytes())?;
    write_json(
        &meta_path,
        &json!({"model_asof_ms":asof,"training_start_ms":start,"early_stop_split_ms":split,"training_rows":full.len(),"early_stop_rows":validation.len(),"latest_training_origin_ms":last_origin,"label_maturity_ms":protocol.maturity_ms,"label_maturity_hours":protocol.maturity_ms as f64 / HOUR as f64,"interval":protocol.interval,"early_stopping":stopping,"refit_iterations":iterations,"model_sha256":sha(&fs::read(&model_path)?),"target":"shared paper net USDT / fixed 50-USDT nominal budget","future_features":false}),
    )?;
    Ok(model)
}

fn predict_week(
    args: &Args,
    data: &ProfitData,
    variant: &Variant,
    asof: i64,
    end: i64,
    runtime: Arc<LightGbmRuntime>,
) -> Result<Vec<Prediction>> {
    let directory = args
        .output_dir
        .join(&variant.id)
        .join(format!("asof-{asof}"));
    let checkpoint = directory.join("predictions.json");
    if checkpoint.exists() && directory.join("predictions-proof.json").exists() {
        let points: Vec<Prediction> = serde_json::from_slice(&fs::read(&checkpoint)?)?;
        let expected: BTreeSet<_> = data
            .records
            .iter()
            .enumerate()
            .filter_map(|(i, r)| {
                (r.record.origin_ms >= asof && r.record.origin_ms < end).then_some(i)
            })
            .collect();
        let mut seen = BTreeSet::new();
        for p in &points {
            let row = data.records.get(p.index).context("Bad prediction index")?;
            ensure!(
                p.model_asof_ms == asof
                    && p.origin_ms == row.record.origin_ms
                    && p.symbol == row.record.symbol
                    && p.long.is_finite()
                    && p.short.is_finite()
                    && seen.insert(p.index),
                "Invalid prediction checkpoint"
            );
        }
        ensure!(seen == expected, "Prediction population changed");
        let proof = read_json(&directory.join("predictions-proof.json"))?;
        ensure!(
            proof["sha256"] == sha(&fs::read(&checkpoint)?),
            "Prediction checksum mismatch"
        );
        return Ok(points);
    }
    let mut long = fit_side(args, data, variant, asof, true, &directory, runtime.clone())?;
    let mut short = fit_side(args, data, variant, asof, false, &directory, runtime)?;
    let indices: Vec<_> = data
        .records
        .iter()
        .enumerate()
        .filter_map(|(i, r)| (r.record.origin_ms >= asof && r.record.origin_ms < end).then_some(i))
        .collect();
    let mut predictions = Vec::new();
    for chunk in indices.chunks(4096) {
        let x = chunk
            .iter()
            .map(|&i| feature(&data.records[i], variant.chronos))
            .collect::<Result<Vec<_>>>()?;
        let lp = long.predict(&x)?;
        let sp = short.predict(&x)?;
        ensure!(
            lp.len() == chunk.len() && sp.len() == chunk.len(),
            "Wrong prediction coverage"
        );
        for ((&index, l), s) in chunk.iter().zip(lp).zip(sp) {
            let r = &data.records[index].record;
            ensure!(l.is_finite() && s.is_finite(), "Nonfinite model output");
            predictions.push(Prediction {
                index,
                symbol: r.symbol.clone(),
                origin_ms: r.origin_ms,
                model_asof_ms: asof,
                long: l,
                short: s,
            });
        }
    }
    write_json(&checkpoint, &predictions)?;
    write_json(
        &directory.join("predictions-proof.json"),
        &json!({"sha256":sha(&fs::read(&checkpoint)?),"rows":predictions.len(),"model_asof_ms":asof,"targets_in_features":false}),
    )?;
    Ok(predictions)
}

fn calibration(
    data: &ProfitData,
    points: &[Prediction],
    start: i64,
    end: i64,
    long: bool,
) -> Result<DirectionCalibration> {
    let mut observations = Vec::new();
    for p in points {
        ensure!(
            p.model_asof_ms <= p.origin_ms,
            "In-sample prediction in OOF calibration"
        );
        let row = &data.records[p.index];
        if let Some(y) = target(row, long) {
            observations.push(ResidualObservation {
                origin_ms: p.origin_ms,
                mature_by_ms: row.record.mature_by_ms,
                prediction: if long { p.long } else { p.short },
                target: y,
            });
        }
    }
    calibrate_side(&observations, start, end)
}
fn signals(
    points: &[Prediction],
    start: i64,
    end: i64,
    policy: &Policy,
) -> Result<BTreeMap<String, Vec<ReplaySignal>>> {
    let mut result: BTreeMap<String, Vec<ReplaySignal>> = BTreeMap::new();
    for p in points
        .iter()
        .filter(|p| p.origin_ms >= start && p.origin_ms < end)
    {
        let decision = decide(
            p.long,
            p.short,
            &policy.long,
            &policy.short,
            policy.min_edge,
        )?;
        result.entry(p.symbol.clone()).or_default().push(ReplaySignal {origin_ms:p.origin_ms,decision,probabilities:Value::Null,metadata:json!({"variant":"cost_adjusted_regression","model_asof_ms":p.model_asof_ms,"policy_asof_ms":policy.asof_ms,"long_prediction":p.long,"short_prediction":p.short,"long_score":policy.long.score(p.long),"short_score":policy.short.score(p.short),"edge_threshold":policy.min_edge,"target_unit":"net / fixed nominal budget","scores_are_probabilities":false}),plan:None});
    }
    for rows in result.values_mut() {
        rows.sort_by_key(|r| r.origin_ms);
    }
    Ok(result)
}
fn portfolio_config(args: &Args, start: i64, end: i64) -> Result<PortfolioConfig> {
    let protocol = args.protocol()?;
    Ok(PortfolioConfig {
        replay: ReplayConfig {
            candle_interval_ms: protocol.candle_ms,
            start_ms: start,
            end_ms: end,
            ..ReplayConfig::default()
        },
        ..PortfolioConfig::default()
    })
}
fn metric(replay: &Value, key: &str) -> Result<f64> {
    replay["metrics"][key]
        .as_f64()
        .filter(|v| v.is_finite())
        .with_context(|| format!("Missing finite portfolio {key}"))
}
fn completed(replay: &Value) -> bool {
    replay["metrics"]["comparison_complete"] == true && replay["metrics"]["unresolved_orders"] == 0
}

fn select_policy(
    args: &Args,
    data: &ProfitData,
    points: &[Prediction],
    markets: &BTreeMap<String, Vec<Value>>,
    variant: &Variant,
    asof: i64,
) -> Result<Policy> {
    let path = args
        .output_dir
        .join(&variant.id)
        .join(format!("asof-{asof}/policy.json"));
    let start = asof - 14 * DAY;
    let end = asof - 7 * DAY;
    let mut p = Policy {
        asof_ms: asof,
        calibration_start_ms: asof - 21 * DAY,
        calibration_end_ms: start,
        validation_start_ms: start,
        validation_end_ms: end + args.protocol()?.maturity_ms,
        long: calibration(data, points, asof - 21 * DAY, start, true)?,
        short: calibration(data, points, asof - 21 * DAY, start, false)?,
        min_edge: None,
        trials: Vec::new(),
    };
    ensure!(
        p.validation_end_ms < asof,
        "Policy selection saw future outcomes"
    );
    // The explicit no-trade baseline wins unless a completed candidate has
    // positive net PnL and sufficient trading evidence on this older slice.
    let mut best = 0.;
    for edge in EDGES {
        status(
            &args.output_dir,
            "policy_validation",
            json!({"variant":variant.id,"asof_ms":asof,"edge":edge}),
        )?;
        let trial_dir = args
            .output_dir
            .join(&variant.id)
            .join(format!("asof-{asof}/policy-{edge:.4}.json"));
        let replay = if trial_dir.exists() {
            read_json(&trial_dir)?
        } else {
            let mut candidate = p.clone();
            candidate.min_edge = Some(edge);
            let result = replay_portfolio(
                markets,
                &signals(points, start, end, &candidate)?,
                &portfolio_config(args, start, end + args.protocol()?.maturity_ms)?,
            )?;
            write_json(&trial_dir, &result)?;
            result
        };
        let net = metric(&replay, "net_pnl_usdt")?;
        let trades = metric(&replay, "closed_trades")?;
        let eligible =
            completed(&replay) && trades >= 10. && metric(&replay, "max_drawdown_percent")? <= 10.;
        p.trials
            .push(json!({"min_edge":edge,"metrics":replay["metrics"],"eligible":eligible}));
        if eligible && net > best {
            best = net;
            p.min_edge = Some(edge);
        }
    }
    write_json(&path, &p)?;
    Ok(p)
}

fn market_data(
    args: &Args,
    data: &ProfitData,
    start: i64,
    end: i64,
) -> Result<BTreeMap<String, Vec<Value>>> {
    status(
        &args.output_dir,
        "load_shared_market",
        json!({"symbols":data.symbols.len(),"start_ms":start,"end_ms":end,"interval":args.interval}),
    )?;
    if args.interval == "15m" {
        let markets = ml_intraday_data::replay_markets(&args.data_dir, data, start, end)?;
        write_json(
            &args.output_dir.join("market-coverage.json"),
            &json!({"selected_training_symbols":data.symbols.len(),"replay_markets":markets.len(),"interval":"15m","reason":"Native 15m compact candles for the union of causally selected replay symbols"}),
        )?;
        return Ok(markets);
    }
    let mut markets = BTreeMap::new();
    let mut uncovered = Vec::new();
    for (i, symbol) in data.symbols.iter().enumerate() {
        let rows = ml_training_data::load_training_source(&args.data_dir, symbol)?;
        let mut compact = Vec::new();
        for row in rows {
            let at = timestamp(&row["openTime"]).context("Missing source candle time")?;
            if at + HOUR < start - 256 * HOUR || at + HOUR > end {
                continue;
            }
            let mut candle = json!({"openTime":at,"confirmed":true});
            for key in ["open", "high", "low", "close", "volume", "quoteVolume"] {
                if let Some(v) = row.get(key) {
                    candle[key] = v.clone();
                }
            }
            compact.push(candle);
        }
        if compact.is_empty() {
            ensure!(
                !data.records.iter().any(|r| r.record.symbol == *symbol
                    && r.record.origin_ms >= start
                    && r.record.origin_ms < end),
                "Forecast origins lack any market coverage for {symbol}"
            );
            uncovered.push(symbol.clone());
        } else {
            markets.insert(symbol.clone(), compact);
        }
        if (i + 1) % 50 == 0 {
            println!(
                "{}",
                json!({"stage":"load_shared_market","symbols_completed":i+1,"symbols":data.symbols.len()})
            );
        }
    }
    write_json(
        &args.output_dir.join("market-coverage.json"),
        &json!({"selected_training_symbols":data.symbols.len(),"replay_markets":markets.len(),"no_overlap_symbols":uncovered,"reason":"No candles or inference origins in this replay window; historical training rows are retained"}),
    )?;
    Ok(markets)
}

fn run(args: &Args) -> Result<()> {
    ensure!(
        (1..=4).contains(&args.threads) && (5..=300).contains(&args.max_iterations),
        "Invalid CPU/iteration budget"
    );
    let protocol = args.protocol()?;
    ensure!((1..=50).contains(&args.top_n), "top_n must be 1..=50");
    let exit_rules = nofx_core::strategies::ml_horizon_exit_rules();
    let historical_end = if protocol.interval == "15m" {
        let manifest = read_json(&args.data_dir.join("manifest.json"))?;
        ensure!(
            manifest["interval"] == "15m" && manifest["interval_ms"] == protocol.candle_ms,
            "15m training requires a native 15m archive manifest"
        );
        manifest["end_ms"]
            .as_i64()
            .context("15m archive lacks end_ms")?
    } else {
        let previous = read_json(&args.previous_run.join("report.json"))?;
        let previous_config = read_json(&args.previous_run.join("run-config.json"))?;
        ensure!(
            previous_config["exit_rules"] == exit_rules,
            "Exit-rule environment differs from cached trade targets"
        );
        previous["plan"]["data"]["end_ms"]
            .as_i64()
            .context("Previous run lacks its historical end")?
    };
    let boundaries = weekly_boundaries(historical_end, args.evaluation_weeks)?;
    let start = boundaries[3];
    let end = *boundaries.last().unwrap();
    if args.output_dir.exists() {
        ensure!(args.resume, "Existing run requires --resume");
    } else {
        fs::create_dir_all(&args.output_dir)?;
    }
    let _lock = nofx_core::ml_dataset::collector_lock(&args.output_dir)?;
    let mut identity = json!({
        "schema_version":1,
        "interval":protocol.interval,
        "candle_interval_ms":protocol.candle_ms,
        "data_manifest_sha256":sha(&fs::read(args.data_dir.join("manifest.json"))?),
        "runtime_sha256":sha(&fs::read(&args.runtime)?),
        "code_sha256":if protocol.interval == "15m" {
            sha(&[include_bytes!("nofx-ml-profit-train.rs").as_slice(),include_bytes!("../ml_profit_data.rs").as_slice(),include_bytes!("../ml_intraday_data.rs").as_slice(),include_bytes!("../ml_portfolio.rs").as_slice(),include_bytes!("../ml_profit_policy.rs").as_slice(),include_bytes!("../ml_lightgbm.rs").as_slice(),include_bytes!("../../../Cargo.lock").as_slice()].concat())
        } else {
            sha(&[include_bytes!("nofx-ml-profit-train.rs").as_slice(),include_bytes!("../ml_profit_data.rs").as_slice(),include_bytes!("../ml_portfolio.rs").as_slice(),include_bytes!("../ml_profit_policy.rs").as_slice(),include_bytes!("../ml_lightgbm.rs").as_slice(),include_bytes!("../../../Cargo.lock").as_slice()].concat())
        },
        "executable_sha256":sha(&fs::read(std::env::current_exe()?)?),
        "symbols":args.symbols,
        "threads":args.threads,
        "max_iterations":args.max_iterations,
        "evaluation_weeks":args.evaluation_weeks,
        "top_n":args.top_n,
        "boundaries":boundaries,
        "primary_variant":"90d-with-chronos",
        "model_parameters":parameters(args.threads),
        "edge_candidates":EDGES,
        "costs":nofx_core::research::costs(),
        "portfolio":portfolio_config(args, start, end)?,
        "label_maturity_ms":protocol.maturity_ms,
        "label_maturity_hours":protocol.maturity_ms as f64 / HOUR as f64,
        "calibration":"older OOF week; global bias with UTC-day clustered heuristic mean-error allowance",
        "policy_validation":"next disjoint OOF week, known settlement tail of 48 source candles; HOLD baseline; >=10 closed trades",
        "deployment_approved":false
    });
    identity["exit_rules"] = exit_rules;
    if protocol.interval == "15m" {
        identity["forecast_model_sha256"] = json!(sha(&fs::read(&args.forecast_model)?));
        identity["forecast_runtime_sha256"] = json!(sha(&fs::read(&args.forecast_runtime)?));
        identity["chronos_weights_updated"] = json!(false);
        identity["upsample_hourly"] = json!(false);
    } else {
        identity["previous_report_sha256"] =
            json!(sha(&fs::read(args.previous_run.join("report.json"))?));
        identity["cache_preparation_sha256"] =
            json!(sha(&fs::read(args.cache_dir.join("preparation.json"))?));
    }
    let config_path = args.output_dir.join("run-config.json");
    if config_path.exists() {
        ensure!(
            read_json(&config_path)?["identity"] == identity,
            "Run identity changed; use a fresh output directory"
        );
    } else {
        write_json(
            &config_path,
            &json!({"identity":identity,"protocol_locked_at_utc":chrono::Utc::now(),"future_forward_validation_required":true}),
        )?;
    }
    if args.output_dir.join("report.json").exists() {
        println!("already_complete");
        return Ok(());
    }
    let timer = Instant::now();
    let data = if protocol.interval == "15m" {
        status(
            &args.output_dir,
            "prepare_intraday_targets",
            json!({"data_dir":args.data_dir,"recompute_chronos":true,"interval":"15m"}),
        )?;
        let manifest = read_json(&args.data_dir.join("manifest.json"))?;
        let archive_start = manifest["start_ms"]
            .as_i64()
            .context("15m archive lacks start_ms")?;
        let archive_end = manifest["end_ms"]
            .as_i64()
            .context("15m archive lacks end_ms")?;
        ensure!(
            archive_end == end && archive_start <= boundaries[0] - 90 * DAY,
            "15m collection does not cover frozen weekly protocol"
        );
        ml_intraday_data::prepare_intraday(&IntradayPreparationConfig {
            data_dir: args.data_dir.clone(),
            cache_dir: args.cache_dir.clone(),
            forecast_model: args.forecast_model.clone(),
            forecast_runtime: args.forecast_runtime.clone(),
            threads: args.threads,
            symbols: args.symbols.clone(),
            start_ms: archive_start,
            end_ms: archive_end,
            top_n: args.top_n,
        })?
    } else {
        status(
            &args.output_dir,
            "verify_cached_targets",
            json!({"previous_run":args.previous_run,"recompute_chronos":false}),
        )?;
        load_profit_data(
            &args.previous_run,
            &args.data_dir,
            &args.cache_dir,
            &args.symbols,
        )?
    };
    ensure!(
        data.end_ms == end && boundaries[0] - 90 * DAY >= data.start_ms,
        "Data does not cover frozen weekly protocol"
    );
    write_json(
        &args.output_dir.join("data-provenance.json"),
        &data.provenance,
    )?;
    let markets = market_data(args, &data, boundaries[0], end)?;
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut results = Vec::new();
    for (days, chronos) in [(90, true), (90, false), (60, true), (60, false)] {
        let variant = Variant {
            id: format!(
                "{days}d-{}chronos",
                if chronos { "with-" } else { "without-" }
            ),
            training_days: days,
            chronos,
        };
        let report_path = args.output_dir.join(&variant.id).join("report.json");
        if report_path.exists() {
            results.push(read_json(&report_path)?);
            continue;
        }
        let mut points = Vec::new();
        let mut all_signals: BTreeMap<String, Vec<ReplaySignal>> = BTreeMap::new();
        let mut policies = Vec::new();
        for (week, pair) in boundaries.windows(2).enumerate() {
            let asof = pair[0];
            let policy = if week >= 3 {
                Some(select_policy(
                    args, &data, &points, &markets, &variant, asof,
                )?)
            } else {
                None
            };
            status(
                &args.output_dir,
                "weekly_refit",
                json!({"variant":variant.id,"week":week+1,"total_weeks":boundaries.len()-1,"asof_ms":asof,"warmup_oof":week<3}),
            )?;
            let current = predict_week(args, &data, &variant, asof, pair[1], runtime.clone())?;
            if let Some(policy) = policy {
                // Keep one continuous account across weekly model updates. The
                // immutable cache has no valid inference in its final 48h tail.
                let week_signals = signals(
                    &current,
                    asof,
                    pair[1].min(end - protocol.maturity_ms),
                    &policy,
                )?;
                for (symbol, s) in week_signals {
                    all_signals.entry(symbol).or_default().extend(s);
                }
                policies.push(policy);
            }
            points.extend(current);
        }
        status(
            &args.output_dir,
            "shared_portfolio_evaluation",
            json!({"variant":variant.id,"start_ms":start,"end_ms":end}),
        )?;
        let replay_path = args.output_dir.join(&variant.id).join("shared-replay.json");
        let replay = if replay_path.exists() {
            read_json(&replay_path)?
        } else {
            let r = replay_portfolio(&markets, &all_signals, &portfolio_config(args, start, end)?)?;
            write_json(&replay_path, &r)?;
            r
        };
        let latest_policy = select_policy(args, &data, &points, &markets, &variant, end)?;
        let latest_dir = args
            .output_dir
            .join(&variant.id)
            .join(format!("asof-{end}"));
        drop(fit_side(
            args,
            &data,
            &variant,
            end,
            true,
            &latest_dir,
            runtime.clone(),
        )?);
        drop(fit_side(
            args,
            &data,
            &variant,
            end,
            false,
            &latest_dir,
            runtime.clone(),
        )?);
        let result = json!({"variant":variant,"primary":variant.id=="90d-with-chronos","historical_research_only":true,"evaluation_start_ms":start,"evaluation_end_ms":end,"metrics":replay["metrics"],"historical_positive":completed(&replay)&&metric(&replay,"net_pnl_usdt")?>0.,"policies":policies,"latest_policy":latest_policy,"latest_models_asof_ms":end,"deployment_approved":false});
        write_json(&report_path, &result)?;
        results.push(result);
    }
    let limitations = if protocol.interval == "15m" {
        json!([
            "All historical dates were previously observed; this is research, not a new blind test.",
            "Native 15m paper replay shares production fills, costs and risk primitives; immediate Demo scheduling, intra-bar scan order and historical order books are not reconstructed.",
            "Chronos horizon is 12 quarter-hour steps (3h); label maturity is 48 bars (12h); max hold remains 11 source candles.",
            "Causal universe is point-in-time top-N by preceding continuous 24h quote volume; no fill or PnL filter.",
            "Net targets are independent counterfactual trades normalized by a fixed 50-USDT notional budget; actual sized notional can be smaller.",
            "Weekly OOF bias calibration is transported to a newly refitted weekly model. Its UTC-day mean-error allowance is a heuristic, not a per-trade confidence bound.",
            "The predeclared primary is not reselected on historical evaluation returns; all four variants remain research candidates."
        ])
    } else {
        json!([
            "All historical dates were previously observed; this is research, not a new blind test.",
            "Hourly paper replay shares production fills, costs and risk primitives; immediate Demo scheduling, intrahour scan order and historical order books are not reconstructed.",
            "Cached origins use six-hour cadence and omit the last immature 48 hours, including delisting tails; labels are not used to filter causal inference rows.",
            "Net targets are independent counterfactual trades normalized by a fixed 50-USDT notional budget; actual sized notional can be smaller.",
            "Weekly OOF bias calibration is transported to a newly refitted weekly model. Its UTC-day mean-error allowance is a heuristic, not a per-trade confidence bound.",
            "The predeclared primary is not reselected on historical evaluation returns; all four variants remain research candidates."
        ])
    };
    let report = json!({"schema_version":1,"status":"completed","interval":protocol.interval,"elapsed_seconds":timer.elapsed().as_secs_f64(),"variants":results,"primary_variant":"90d-with-chronos","selected_symbols":data.symbols.len(),"inference_records":data.records.len(),"future_forward_validation_required":true,"deployment_approved":false,"runtime_modified":false,"orders_enabled":false,"chronos_weights_updated":false,"limitations":limitations});
    write_json(&args.output_dir.join("report.json"), &report)?;
    status(
        &args.output_dir,
        "completed",
        json!({"report":args.output_dir.join("report.json"),"deployment_approved":false}),
    )?;
    Ok(())
}
fn main() -> Result<()> {
    run(&Args::parse())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profit_policy_uses_oof_calibration_without_future_reselection() {
        let c = DirectionCalibration {
            bias: 0.,
            uncertainty_allowance: 0.,
            observations: 100,
            days: 5,
            usable: true,
        };
        let p = Policy {
            asof_ms: 20 * DAY,
            calibration_start_ms: 0,
            calibration_end_ms: 7 * DAY,
            validation_start_ms: 7 * DAY,
            validation_end_ms: 16 * DAY,
            long: c.clone(),
            short: c,
            min_edge: Some(0.001),
            trials: vec![],
        };
        let points = vec![
            Prediction {
                index: 0,
                symbol: "BTCUSDT".into(),
                origin_ms: 20 * DAY,
                model_asof_ms: 20 * DAY,
                long: 0.003,
                short: -0.002,
            },
            Prediction {
                index: 1,
                symbol: "BTCUSDT".into(),
                origin_ms: 21 * DAY,
                model_asof_ms: 20 * DAY,
                long: -0.001,
                short: -0.002,
            },
        ];
        let s = signals(&points, 20 * DAY, 22 * DAY, &p).unwrap();
        assert_eq!(s["BTCUSDT"][0].decision, "BUY");
        assert_eq!(s["BTCUSDT"][1].decision, "HOLD");
        assert!(s["BTCUSDT"][0].probabilities.is_null());
        let mut hold = p;
        hold.min_edge = None;
        assert!(
            signals(&points, 20 * DAY, 22 * DAY, &hold).unwrap()["BTCUSDT"]
                .iter()
                .all(|s| s.decision == "HOLD")
        );
    }
}
