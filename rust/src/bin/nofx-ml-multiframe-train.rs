//! Offline 1h vs 1h+causal-4h LightGBM comparison on frozen cost-adjusted labels.
//! Chronos weights are not updated. 1m/5m/15m are not upsampled.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    ml_features,
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmRegressor, LightGbmRuntime},
    ml_multiframe,
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
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

const HOUR: i64 = 3_600_000;
const EDGES: [f64; 4] = [0., 0.001, 0.0025, 0.005];

#[derive(Parser)]
#[command(about = "Compare frozen 1h LightGBM features against causal 4h aggregates")]
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
    #[arg(long, default_value = "output/ml-multiframe-20261017")]
    output_dir: PathBuf,
    #[arg(long, default_value = DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long, default_value_t = 2)]
    threads: usize,
    #[arg(long, default_value_t = 120)]
    max_iterations: usize,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
}

#[derive(Clone, Copy)]
enum FrameSet {
    Hourly,
    HourlyPlus4h,
}

impl FrameSet {
    fn id(self) -> &'static str {
        match self {
            Self::Hourly => "1h",
            Self::HourlyPlus4h => "1h+4h",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Prediction {
    index: usize,
    symbol: String,
    origin_ms: i64,
    long: f64,
    short: f64,
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing parent")?)?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}
fn parameters(threads: usize) -> String {
    format!(
        "boosting=gbdt device_type=cpu objective=regression metric=l2 deterministic=true force_col_wise=true num_threads={threads} num_leaves=15 min_data_in_leaf=160 lambda_l1=1 lambda_l2=20 learning_rate=0.05 max_depth=4 seed=42 feature_fraction_seed=42 bagging_seed=42 data_random_seed=42 feature_fraction=1 bagging_fraction=1 bagging_freq=0 verbosity=-1"
    )
}
fn target(row: &ProfitRecord, long: bool) -> Option<f64> {
    if long {
        row.long_target
    } else {
        row.short_target
    }
}
fn feature(row: &ProfitRecord, frames: FrameSet, extra: Option<&[f64]>) -> Result<Vec<f64>> {
    let mut x = row.record.base.clone();
    x.extend(ml_features::chronos_features(&row.record.forecast)?);
    if matches!(frames, FrameSet::HourlyPlus4h) {
        let extra = extra.context("Missing 4h features")?;
        ensure!(
            extra.len() == ml_multiframe::FEATURE_NAMES.len(),
            "4h width"
        );
        x.extend(extra);
    }
    ensure!(x.iter().all(|v| v.is_finite()), "Nonfinite features");
    Ok(x)
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

fn extra_map(
    data: &ProfitData,
    markets: &BTreeMap<String, Vec<Value>>,
    frames: FrameSet,
) -> Result<Vec<Option<Vec<f64>>>> {
    if matches!(frames, FrameSet::Hourly) {
        return Ok(vec![None; data.records.len()]);
    }
    let mut extras = Vec::with_capacity(data.records.len());
    for row in &data.records {
        let market = markets
            .get(&row.record.symbol)
            .with_context(|| format!("Missing market {}", row.record.symbol))?;
        extras.push(Some(ml_multiframe::four_hour_features(
            market,
            row.record.origin_ms,
        )?));
    }
    Ok(extras)
}

fn xy(
    data: &ProfitData,
    extras: &[Option<Vec<f64>>],
    indexes: &[usize],
    frames: FrameSet,
    long: bool,
) -> Result<(Vec<Vec<f64>>, Vec<f64>)> {
    let x = indexes
        .iter()
        .map(|&i| feature(&data.records[i], frames, extras[i].as_deref()))
        .collect::<Result<Vec<_>>>()?;
    let y = indexes
        .iter()
        .map(|&i| target(&data.records[i], long).context("Missing target"))
        .collect::<Result<Vec<_>>>()?;
    Ok((x, y))
}

fn fit(
    runtime: Arc<LightGbmRuntime>,
    data: &ProfitData,
    extras: &[Option<Vec<f64>>],
    frames: FrameSet,
    asof: i64,
    long: bool,
    threads: usize,
    max_iterations: usize,
) -> Result<LightGbmRegressor> {
    let start = asof - 90 * DAY;
    let split = asof - 7 * DAY;
    let train = indexes(data, start, split, split, long);
    let validation = indexes(data, split, asof, asof, long);
    ensure!(
        train.len() >= 90 && validation.len() >= 30,
        "Insufficient mature rows"
    );
    let (x, y) = xy(data, extras, &train, frames, long)?;
    let (vx, vy) = xy(data, extras, &validation, frames, long)?;
    LightGbmRegressor::train_config_with_validation(
        runtime,
        &x,
        &y,
        &parameters(threads),
        max_iterations,
        &vx,
        &vy,
        30,
        5,
    )
}

fn predict_all(
    data: &ProfitData,
    extras: &[Option<Vec<f64>>],
    frames: FrameSet,
    long_model: &mut LightGbmRegressor,
    short_model: &mut LightGbmRegressor,
    start: i64,
    end: i64,
) -> Result<Vec<Prediction>> {
    let mut points = Vec::new();
    let mut batch_index = Vec::new();
    let mut batch_x = Vec::new();
    for (index, row) in data.records.iter().enumerate() {
        if row.record.origin_ms < start || row.record.origin_ms >= end {
            continue;
        }
        batch_index.push(index);
        batch_x.push(feature(row, frames, extras[index].as_deref())?);
    }
    if batch_x.is_empty() {
        return Ok(points);
    }
    let long = long_model.predict(&batch_x)?;
    let short = short_model.predict(&batch_x)?;
    for (i, index) in batch_index.into_iter().enumerate() {
        points.push(Prediction {
            index,
            symbol: data.records[index].record.symbol.clone(),
            origin_ms: data.records[index].record.origin_ms,
            long: long[i],
            short: short[i],
        });
    }
    Ok(points)
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
    long_c: &DirectionCalibration,
    short_c: &DirectionCalibration,
    edge: Option<f64>,
) -> Result<BTreeMap<String, Vec<ReplaySignal>>> {
    let mut result: BTreeMap<String, Vec<ReplaySignal>> = BTreeMap::new();
    for p in points
        .iter()
        .filter(|p| p.origin_ms >= start && p.origin_ms < end)
    {
        let decision = decide(p.long, p.short, long_c, short_c, edge)?;
        result
            .entry(p.symbol.clone())
            .or_default()
            .push(ReplaySignal {
                origin_ms: p.origin_ms,
                decision,
                probabilities: Value::Null,
                metadata: json!({"variant":"multiframe","long":p.long,"short":p.short,"edge":edge}),
                plan: None,
            });
    }
    Ok(result)
}

fn compact_market(rows: Vec<Value>, start: i64, end: i64) -> Result<Vec<Value>> {
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
    Ok(compact)
}

fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(!args.output_dir.exists(), "Use a fresh --output-dir");
    ensure!((1..=4).contains(&args.threads), "threads 1..=4");
    let data = load_profit_data(
        &args.previous_run,
        &args.data_dir,
        &args.cache_dir,
        &args.symbols,
    )?;
    let end = data.end_ms;
    let boundaries = weekly_boundaries(end, 4)?;
    let eval_start = boundaries[3];
    let eval_end = *boundaries.last().unwrap();
    fs::create_dir_all(&args.output_dir)?;
    let identity = json!({
        "schema_version":1,"tool":"nofx-ml-multiframe-train","created_at_ms":nofx_core::now_ms(),
        "symbols":data.symbols,"end_ms":end,"eval_start_ms":eval_start,"eval_end_ms":eval_end,
        "chronos_weights_updated":false,"upsample_intraday":false,
        "frames":["1h","1h+4h"],"4h_source":"contiguous closed 1h groups whose 4h close <= origin",
        "missing_frames":["1m","5m","15m"],"reason_missing":"Native archives are hourly; upsampling is forbidden",
        "costs":nofx_core::research::costs(),"exit_rules":nofx_core::strategies::ml_horizon_exit_rules(),
        "code_sha256":sha(&[include_bytes!("nofx-ml-multiframe-train.rs").as_slice(),include_bytes!("../ml_multiframe.rs").as_slice()].concat()),
        "deployment_approved":false,"orders_enabled":false
    });
    write_json(&args.output_dir.join("run-config.json"), &identity)?;
    let mut markets = BTreeMap::new();
    for symbol in &data.symbols {
        let rows = ml_training_data::load_training_source(&args.data_dir, symbol)?;
        markets.insert(
            symbol.clone(),
            compact_market(rows, eval_start - 90 * DAY, eval_end)?,
        );
    }
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut summaries = Vec::new();
    for frames in [FrameSet::Hourly, FrameSet::HourlyPlus4h] {
        let extras = extra_map(&data, &markets, frames)?;
        let asof = eval_start;
        let mut long_model = fit(
            runtime.clone(),
            &data,
            &extras,
            frames,
            asof,
            true,
            args.threads,
            args.max_iterations,
        )?;
        let mut short_model = fit(
            runtime.clone(),
            &data,
            &extras,
            frames,
            asof,
            false,
            args.threads,
            args.max_iterations,
        )?;
        let points = predict_all(
            &data,
            &extras,
            frames,
            &mut long_model,
            &mut short_model,
            eval_start - 21 * DAY,
            eval_end,
        )?;
        let long_c = calibration(
            &data,
            &points,
            eval_start - 21 * DAY,
            eval_start - 7 * DAY,
            true,
        )?;
        let short_c = calibration(
            &data,
            &points,
            eval_start - 21 * DAY,
            eval_start - 7 * DAY,
            false,
        )?;
        let mut best_edge = None;
        let mut best_net = 0.;
        let mut trials = Vec::new();
        let validate_start = eval_start - 14 * DAY;
        let validate_end = eval_start - 7 * DAY;
        for edge in EDGES {
            let replay = replay_portfolio(
                &markets,
                &signals(
                    &points,
                    validate_start,
                    validate_end,
                    &long_c,
                    &short_c,
                    Some(edge),
                )?,
                &PortfolioConfig {
                    replay: ReplayConfig {
                        start_ms: validate_start,
                        end_ms: validate_end + 48 * HOUR,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )?;
            let net = replay["metrics"]["net_pnl_usdt"].as_f64().unwrap_or(0.);
            let trades = replay["metrics"]["closed_trades"].as_f64().unwrap_or(0.);
            let eligible =
                replay["metrics"]["comparison_complete"] == true && trades >= 10. && net > 0.;
            trials.push(json!({"edge":edge,"metrics":replay["metrics"],"eligible":eligible}));
            if eligible && net > best_net {
                best_net = net;
                best_edge = Some(edge);
            }
        }
        let eval = replay_portfolio(
            &markets,
            &signals(&points, eval_start, eval_end, &long_c, &short_c, best_edge)?,
            &PortfolioConfig {
                replay: ReplayConfig {
                    start_ms: eval_start,
                    end_ms: eval_end,
                    ..Default::default()
                },
                ..Default::default()
            },
        )?;
        let summary = json!({
            "frames":frames.id(),"selected_edge":best_edge,"policy_trials":trials,
            "evaluation":eval["metrics"],"available_4h_rows":extras.iter().filter(|v| v.as_ref().is_some_and(|x| x[12]==1.)).count(),
            "feature_width":if matches!(frames, FrameSet::HourlyPlus4h) { data.records[0].record.base.len()+6+ml_multiframe::FEATURE_NAMES.len() } else { data.records[0].record.base.len()+6 }
        });
        write_json(
            &args
                .output_dir
                .join(format!("{}.json", frames.id().replace('+', "-"))),
            &summary,
        )?;
        summaries.push(summary);
        println!(
            "{}",
            json!({"stage":"evaluated","frames":frames.id(),"metrics":eval["metrics"]})
        );
    }
    let report = json!({"schema_version":1,"status":"completed","identity":identity,"variants":summaries,"chronos_weights_updated":false,"deployment_approved":false});
    write_json(&args.output_dir.join("report.json"), &report)?;
    Ok(())
}
