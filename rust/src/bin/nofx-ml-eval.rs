//! Purged walk-forward classifier comparison using the production Rust simulator.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    chronos::{ChronosModel, ContextRecord},
    iso,
    ml_features::{self, BASE_FEATURE_NAMES, CHRONOS_FEATURE_NAMES, CONTEXT, HORIZON, HOUR},
    ml_lightgbm::{DEFAULT_RUNTIME_PATH, LightGbmModel, LightGbmRuntime, TRAIN_PARAMETERS},
    ml_replay::{self, ReplayConfig, ReplaySignal},
    number, timestamp,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

const DAY: i64 = 86_400_000;
const SETTLEMENT_HOURS: i64 = 36;
#[derive(Parser)]
#[command(
    about = "CPU LightGBM vs Chronos features; no randomized split, optimization or live orders"
)]
struct Args {
    #[arg(long, default_value = "data/ml-market-20261014")]
    data_dir: PathBuf,
    #[arg(long, default_value = "output/ml-baseline-20261014")]
    output_dir: PathBuf,
    #[arg(long, value_delimiter = ',', default_value = "BTCUSDT,ETHUSDT")]
    symbols: Vec<String>,
    #[arg(long,default_value=DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long, default_value = "data/chronos/chronos-bolt-tiny.onnx")]
    forecast_model: PathBuf,
    #[arg(
        long,
        default_value = "data/chronos/model-toolchain/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"
    )]
    forecast_runtime: PathBuf,
    #[arg(long, default_value_t = 30)]
    test_days: i64,
    #[arg(long, default_value_t = 90)]
    train_days: i64,
    #[arg(long, default_value_t = 7)]
    fold_days: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FeatureRecord {
    end: usize,
    origin_ms: i64,
    base: Vec<f64>,
    augmented: Vec<f64>,
    label: Option<usize>,
}
#[derive(Serialize, Deserialize)]
struct FeatureCache {
    source_sha256: String,
    forecast_sha256: String,
    feature_schema_sha256: String,
    records: Vec<FeatureRecord>,
    compute_ms: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Fold {
    index: usize,
    start: i64,
    end: i64,
    train_start: i64,
    label_available_by: i64,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn folds(start: i64, end: i64, train_days: i64, fold_days: i64) -> Result<Vec<Fold>> {
    ensure!(
        start < end && train_days >= 30 && fold_days > 0,
        "Invalid chronological split"
    );
    let mut output = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let stop = (cursor + fold_days * DAY).min(end);
        output.push(Fold {
            index: output.len(),
            start: cursor,
            end: stop,
            train_start: cursor - train_days * DAY,
            label_available_by: cursor,
        });
        cursor = stop;
    }
    Ok(output)
}
fn training<'a>(records: &'a [FeatureRecord], fold: &Fold) -> Vec<&'a FeatureRecord> {
    records
        .iter()
        .filter(|r| {
            r.origin_ms >= fold.train_start
                && r.origin_ms + HORIZON as i64 * HOUR <= fold.label_available_by
                && r.label.is_some()
        })
        .collect()
}
fn features(
    symbol: &str,
    rows: &[Value],
    source_sha: &str,
    args: &Args,
    chronos: &mut ChronosModel,
) -> Result<FeatureCache> {
    let path = args
        .output_dir
        .join("features")
        .join(format!("{symbol}.json"));
    let forecast_sha = digest(&fs::read(&args.forecast_model)?);
    let schema_sha = digest(
        &[
            include_bytes!("../ml_features.rs").as_slice(),
            include_bytes!("../chronos.rs").as_slice(),
            include_bytes!("nofx-ml-eval.rs").as_slice(),
        ]
        .concat(),
    );
    if path.exists() {
        let cached: FeatureCache = serde_json::from_slice(&fs::read(&path)?)?;
        ensure!(
            cached.source_sha256 == source_sha
                && cached.forecast_sha256 == forecast_sha
                && cached.feature_schema_sha256 == schema_sha,
            "Feature cache fingerprint changed; use a fresh output directory"
        );
        return Ok(cached);
    }
    let started = Instant::now();
    let mut records = Vec::new();
    for end in CONTEXT..=rows.len() {
        let origin = timestamp(&rows[end - 1]["openTime"]).context("Invalid openTime")? + HOUR;
        let prefix = &rows[end - CONTEXT..end];
        let input = ContextRecord {
            symbol: symbol.into(),
            origin_ms: origin,
            context_end_open_ms: origin - HOUR,
            context: prefix
                .iter()
                .map(|r| number(&r["close"], f64::NAN) as f32)
                .collect(),
            context_open_ms: Some(
                prefix
                    .iter()
                    .map(|r| timestamp(&r["openTime"]).unwrap())
                    .collect(),
            ),
            history_sha256: Some(digest(&serde_json::to_vec(prefix)?)),
        };
        let forecast = chronos.forecast(&input)?;
        let base = ml_features::base_features(rows, end)?;
        let mut augmented = base.clone();
        augmented.extend(ml_features::chronos_features(&forecast)?);
        records.push(FeatureRecord {
            end,
            origin_ms: origin,
            base,
            augmented,
            label: ml_features::label(rows, end),
        });
        if records.len() % 500 == 0 {
            eprintln!("{symbol}: {} closed-prefix feature rows", records.len());
        }
    }
    let cache = FeatureCache {
        source_sha256: source_sha.into(),
        forecast_sha256: forecast_sha,
        feature_schema_sha256: schema_sha,
        records,
        compute_ms: started.elapsed().as_secs_f64() * 1000.0,
    };
    write_json(&path, &cache)?;
    Ok(cache)
}
fn matrix(records: &[&FeatureRecord], augmented: bool) -> Vec<Vec<f64>> {
    records
        .iter()
        .map(|r| {
            if augmented {
                r.augmented.clone()
            } else {
                r.base.clone()
            }
        })
        .collect()
}
fn train_model(
    runtime: &std::sync::Arc<LightGbmRuntime>,
    train: &[&FeatureRecord],
    augmented: bool,
) -> Result<LightGbmModel> {
    let labels: Vec<usize> = train.iter().map(|r| r.label.unwrap()).collect();
    let mut counts = [0; 3];
    for l in &labels {
        counts[*l] += 1;
    }
    ensure!(
        counts.iter().all(|n| *n >= 30),
        "Insufficient per-class training observations: {counts:?}"
    );
    LightGbmModel::train(runtime.clone(), &matrix(train, augmented), &labels)
}
fn class_index(decision: &str) -> usize {
    match decision {
        "SELL" => 0,
        "BUY" => 2,
        _ => 1,
    }
}
fn classification(records: &[&FeatureRecord], probabilities: &[[f64; 3]]) -> Value {
    let mut confusion = [[0usize; 3]; 3];
    let mut evaluated = 0usize;
    let mut loss = 0.0;
    let mut argmax_hits = 0usize;
    let mut policy_hits = 0usize;
    for (row, p) in records.iter().zip(probabilities) {
        if let Some(actual) = row.label {
            let predicted = (0..3).max_by(|a, b| p[*a].total_cmp(&p[*b])).unwrap();
            let policy = class_index(ml_features::decide(p));
            confusion[actual][policy] += 1;
            evaluated += 1;
            loss -= p[actual].max(1e-15).ln();
            argmax_hits += usize::from(predicted == actual);
            policy_hits += usize::from(policy == actual);
        }
    }
    json!({"classes":["SELL","HOLD","BUY"],"evaluated_targets":evaluated,"missing_future_targets":records.len()-evaluated,"policy_confusion_actual_rows_predicted_cols":confusion,
        "argmax_accuracy_percent":(evaluated>0).then(||argmax_hits as f64/evaluated as f64*100.0),"policy_accuracy_percent":(evaluated>0).then(||policy_hits as f64/evaluated as f64*100.0),"log_loss":(evaluated>0).then(||loss/evaluated as f64),"overlapping_12h_labels":true})
}
fn replay_signal(
    row: &FeatureRecord,
    p: &[f64; 3],
    fold: &Fold,
    variant: &str,
    cutoff: i64,
) -> ReplaySignal {
    let raw = ml_features::decide(p);
    let tail = row.origin_ms >= cutoff;
    ReplaySignal {
        origin_ms: row.origin_ms,
        decision: if tail { "HOLD" } else { raw }.into(),
        probabilities: ml_features::probabilities_json(p),
        plan: None,
        metadata: json!({"variant":variant,"fold":fold.index,"trained_before_ms":fold.start,"training_label_available_by_ms":fold.label_available_by,
            "raw_model_decision":raw,"settlement_tail":tail,"feature_values":if variant=="base"{&row.base}else{&row.augmented}}),
    }
}
fn curve_segment(report: &Value, fold: &Fold) -> Value {
    let points = report["equity_curve"].as_array().unwrap();
    let before = points
        .iter()
        .rev()
        .find(|p| timestamp(&p["time_ms"]).unwrap_or(0) <= fold.start)
        .or(points.first())
        .unwrap();
    let after = points
        .iter()
        .rev()
        .find(|p| timestamp(&p["time_ms"]).unwrap_or(0) <= fold.end)
        .unwrap();
    let start_equity = number(&before["equity"], f64::NAN);
    let stop_equity = number(&after["equity"], f64::NAN);
    let mut peak = start_equity;
    let mut dd: f64 = 0.0;
    for p in points.iter().filter(|p| {
        let t = timestamp(&p["time_ms"]).unwrap_or(0);
        t >= fold.start && t <= fold.end
    }) {
        let e = number(&p["equity"], f64::NAN);
        peak = peak.max(e);
        dd = dd.max((peak - e) / peak);
    }
    json!({"fold":fold.index,"start_ms":fold.start,"end_ms":fold.end,"net_equity_change_usdt":stop_equity-start_equity,"drawdown_percent_from_segment_peak":dd*100.0,
        "scope":"Continuous month account, positions can cross weekly retraining boundaries"})
}
fn retention(base: &Value, aug: &Value, fold_results: &[(Value, Value)], initial: f64) -> Value {
    let b = &base["metrics"];
    let a = &aug["metrics"];
    let complete = b["comparison_complete"] == true && a["comparison_complete"] == true;
    let sufficient =
        number(&b["closed_trades"], 0.0) >= 10.0 && number(&a["closed_trades"], 0.0) >= 10.0;
    let net_delta =
        number(&a["net_pnl_usdt"], f64::NEG_INFINITY) - number(&b["net_pnl_usdt"], f64::INFINITY);
    let dd_delta = number(&b["max_drawdown_percent"], f64::NEG_INFINITY)
        - number(&a["max_drawdown_percent"], f64::INFINITY);
    let min_net = initial * 0.001;
    let min_dd = 0.10;
    let consistent = fold_results
        .iter()
        .filter(|(base, aug)| {
            number(&aug["net_equity_change_usdt"], 0.0)
                > number(&base["net_equity_change_usdt"], 0.0) + 0.01
                || number(&aug["drawdown_percent_from_segment_peak"], 0.0) + 0.01
                    < number(&base["drawdown_percent_from_segment_peak"], 0.0)
        })
        .count();
    let majority = consistent * 2 > fold_results.len();
    let improvement = (net_delta >= min_net && dd_delta >= -min_dd)
        || (dd_delta >= min_dd && net_delta >= -min_net);
    let retained = complete && sufficient && majority && improvement;
    json!({"retained":retained,"comparison_complete":complete,"minimum_ten_closed_trades_each":sufficient,
        "net_pnl_delta_usdt":net_delta,"drawdown_reduction_percentage_points":dd_delta,"minimum_net_improvement_usdt":min_net,
        "minimum_drawdown_reduction_percentage_points":min_dd,"improved_fold_count":consistent,"fold_count":fold_results.len(),"majority_folds_improved":majority,
        "meaningful_improvement_with_bounded_tradeoff":improvement,"rule":"Complete and sufficient; majority weekly segments improve; net improves >=0.1% initial without DD worsening >0.1pp OR DD improves >=0.1pp without net worsening >0.1% initial. Frozen before outcomes; no significance claim."})
}
fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        args.test_days == 30 && args.train_days >= 30 && args.fold_days > 0,
        "First study uses exactly thirty test days"
    );
    ensure!(
        !args.output_dir.join("summary.json").exists(),
        "A completed study is immutable; use a fresh output directory"
    );
    fs::create_dir_all(&args.output_dir)?;
    let began = Instant::now();
    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut chronos = ChronosModel::load(&args.forecast_model, &args.forecast_runtime, 4)?;
    let mut histories = BTreeMap::new();
    let mut sources = serde_json::Map::new();
    let mut end = i64::MAX;
    for symbol in &args.symbols {
        let path = args.data_dir.join(format!("{symbol}.json"));
        let bytes = fs::read(&path)?;
        let data: Value = serde_json::from_slice(&bytes)?;
        let rows = data["datasets"]["1h"]
            .as_array()
            .context("Missing frozen hourly data")?
            .clone();
        ml_features::validate_hourly(&rows)?;
        let boundary = timestamp(&rows.last().unwrap()["openTime"]).unwrap() + HOUR;
        end = end.min(boundary);
        sources.insert(
            symbol.clone(),
            json!({"path":path,"sha256":digest(&bytes),"metadata":data["metadata"]}),
        );
        histories.insert(symbol.clone(), rows);
    }
    let start = end - args.test_days * DAY;
    let cutoff = end - SETTLEMENT_HOURS * HOUR;
    let splits = folds(start, end, args.train_days, args.fold_days)?;
    let settings = json!({"test_start_ms":start,"test_end_ms":end,"test_start":iso(start),"test_end":iso(end),"train_days":args.train_days,"fold_days":args.fold_days,
        "purge_hours":HORIZON,"settlement_tail_hours":SETTLEMENT_HOURS,"new_entry_cutoff_ms":cutoff,"label_threshold":ml_features::label_threshold(),
        "probability_threshold":ml_features::PROBABILITY_THRESHOLD,"probability_margin":ml_features::PROBABILITY_MARGIN,"parameters":TRAIN_PARAMETERS,
        "base_features":BASE_FEATURE_NAMES,"chronos_extra_features":CHRONOS_FEATURE_NAMES,"class_order":["SELL","HOLD","BUY"],"execution":"BUY opens long; SELL opens short; HOLD never disables protection"});
    let source_manifest = json!({"schema_version":1,"settings":settings,"sources":sources,"folds":splits,"feature_code_sha256":digest(include_bytes!("../ml_features.rs")),"replay_code_sha256":digest(include_bytes!("../ml_replay.rs")),"runner_code_sha256":digest(include_bytes!("nofx-ml-eval.rs"))});
    write_json(&args.output_dir.join("manifest.json"), &source_manifest)?;
    let deployment = args.output_dir.join("models/deployment");
    fs::create_dir_all(&deployment)?;
    let mut deployment_symbols = serde_json::Map::new();
    let mut reports = serde_json::Map::new();
    let mut any_retained = false;
    for symbol in &args.symbols {
        let rows = &histories[symbol];
        ensure!(
            timestamp(&rows[CONTEXT - 1]["openTime"]).unwrap() + HOUR
                <= start - args.train_days * DAY,
            "Insufficient training warmup"
        );
        let source_sha = source_manifest["sources"][symbol]["sha256"]
            .as_str()
            .unwrap();
        let cache = features(symbol, rows, source_sha, &args, &mut chronos)?;
        let mut base_signals = Vec::new();
        let mut augmented_signals = Vec::new();
        let mut fold_reports = Vec::new();
        for fold in &splits {
            let train = training(&cache.records, fold);
            let test: Vec<_> = cache
                .records
                .iter()
                .filter(|r| r.origin_ms >= fold.start && r.origin_ms < fold.end)
                .collect();
            ensure!(!test.is_empty(), "Empty test fold");
            let labels: Vec<_> = train.iter().map(|r| r.label.unwrap()).collect();
            ensure!(!labels.is_empty(), "Empty train fold");
            eprintln!(
                "{symbol} fold {} train={} test={} cutoff={}",
                fold.index,
                train.len(),
                test.len(),
                iso(fold.start)
            );
            let mut base = train_model(&runtime, &train, false)?;
            let mut augmented = train_model(&runtime, &train, true)?;
            let base_prob = base.predict(&matrix(&test, false))?;
            let augmented_prob = augmented.predict(&matrix(&test, true))?;
            let fold_dir = args
                .output_dir
                .join("models")
                .join(symbol)
                .join(format!("fold-{}", fold.index));
            fs::create_dir_all(&fold_dir)?;
            base.save(&fold_dir.join("base.txt"))?;
            augmented.save(&fold_dir.join("chronos.txt"))?;
            fold_reports.push(json!({"fold":fold,"base_training":base.summary(),"augmented_training":augmented.summary(),
                "latest_training_origin_ms":train.last().unwrap().origin_ms,"latest_training_target_closed_ms":train.last().unwrap().origin_ms+HORIZON as i64*HOUR,
                "base_classification":classification(&test,&base_prob),"augmented_classification":classification(&test,&augmented_prob)}));
            for ((r, b), a) in test.iter().zip(&base_prob).zip(&augmented_prob) {
                base_signals.push(replay_signal(r, b, fold, "base", cutoff));
                augmented_signals.push(replay_signal(r, a, fold, "chronos", cutoff));
            }
        }
        let config = ReplayConfig {
            start_ms: start,
            end_ms: end,
            ..Default::default()
        };
        let base_report = ml_replay::replay(symbol, rows, &base_signals, &config)?;
        let aug_report = ml_replay::replay(symbol, rows, &augmented_signals, &config)?;
        write_json(
            &args.output_dir.join(format!("{symbol}-base.json")),
            &base_report,
        )?;
        write_json(
            &args.output_dir.join(format!("{symbol}-chronos.json")),
            &aug_report,
        )?;
        let segments: Vec<_> = splits
            .iter()
            .map(|f| {
                (
                    curve_segment(&base_report, f),
                    curve_segment(&aug_report, f),
                )
            })
            .collect();
        let gate = retention(&base_report, &aug_report, &segments, config.starting_equity);
        let retained = gate["retained"] == true;
        any_retained |= retained;
        let final_fold = Fold {
            index: splits.len(),
            start: end,
            end: end,
            train_start: end - args.train_days * DAY,
            label_available_by: end,
        };
        let train = training(&cache.records, &final_fold);
        let base = train_model(&runtime, &train, false)?;
        let augmented = train_model(&runtime, &train, true)?;
        let base_name = format!("{symbol}-base.txt");
        let augmented_name = format!("{symbol}-chronos.txt");
        base.save(&deployment.join(&base_name))?;
        augmented.save(&deployment.join(&augmented_name))?;
        let all_names: Vec<_> = BASE_FEATURE_NAMES
            .iter()
            .chain(CHRONOS_FEATURE_NAMES)
            .copied()
            .collect();
        deployment_symbols.insert(symbol.clone(),json!({"base_path":base_name,"augmented_path":augmented_name,"selected_variant":if retained{"chronos"}else{"base"},"trained_before_ms":end,
            "base_feature_count":BASE_FEATURE_NAMES.len(),"augmented_feature_count":all_names.len(),"base_feature_names":BASE_FEATURE_NAMES,"chronos_feature_names":all_names,"feature_names":if retained{all_names}else{BASE_FEATURE_NAMES.to_vec()},
            "base_sha256":digest(&fs::read(deployment.join(&base_name))?),"augmented_sha256":digest(&fs::read(deployment.join(&augmented_name))?)}));
        reports.insert(symbol.clone(),json!({"base_metrics":base_report["metrics"],"augmented_metrics":aug_report["metrics"],"retention_gate":gate,"folds":fold_reports,"weekly_equity_segments":segments,
            "feature_records":cache.records.len(),"feature_compute_ms":cache.compute_ms,"deployment_training":base.summary(),"deployment_augmented_training":augmented.summary()}));
    }
    let selection_gate = json!({"symbols":reports.iter().map(|(s,r)|(s.clone(),r["retention_gate"].clone())).collect::<serde_json::Map<_,_>>(),"not_a_live_funding_approval":true});
    let deploy_manifest = json!({"schema_version":1,"symbols":deployment_symbols,"chronos_retained":any_retained,"selection_gate":selection_gate,
        "evaluation_cycle_days":30,"settlement_tail_hours":SETTLEMENT_HOURS,"forecast_model_path":fs::canonicalize(&args.forecast_model)?,"runtime_path":fs::canonicalize(&args.forecast_runtime)?,
        "feature_schema_sha256":digest(include_bytes!("../ml_features.rs")),"risk":ReplayConfig::default(),"source_study":args.output_dir,"real_trading_enabled":false});
    write_json(&deployment.join("manifest.json"), &deploy_manifest)?;
    let summary = json!({"schema_version":1,"computed_at":iso(nofx_core::now_ms()),"settings":settings,"symbols":reports,"deployment_manifest":deployment.join("manifest.json"),
        "chronos_retained_for_any_symbol":any_retained,"total_compute_ms":began.elapsed().as_secs_f64()*1000.0,"research_only":true,"real_trading_enabled":false,
        "limitations":["One recent month, two assets, and overlapping 12-hour classification labels; no statistical significance claim",
            "Weekly retraining uses only earlier matured labels; no shuffled split or parameter search",
            "Independent 1000 USDT account per symbol; aggregate is not a joint portfolio",
            "Last 36 hours log classifications but suppress new entries for shared-engine settlement",
            "Older project experiments overlap part of this month; continuous future paper testing is still required"]});
    write_json(&args.output_dir.join("summary.json"), &summary)?;
    println!(
        "{}",
        json!({"summary":args.output_dir.join("summary.json"),"test_start":iso(start),"test_end":iso(end),"chronos_retained":any_retained,"symbols":summary["symbols"].as_object().unwrap().iter().map(|(s,r)|(s.clone(),json!({"base":r["base_metrics"],"chronos":r["augmented_metrics"],"gate":r["retention_gate"]}))).collect::<serde_json::Map<_,_>>() })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(origin: i64) -> FeatureRecord {
        FeatureRecord {
            end: 0,
            origin_ms: origin,
            base: vec![1.0],
            augmented: vec![1.0],
            label: Some(2),
        }
    }
    #[test]
    fn training_purges_every_unmatured_future_label() {
        let f = Fold {
            index: 0,
            start: 100 * HOUR,
            end: 200 * HOUR,
            train_start: 0,
            label_available_by: 100 * HOUR,
        };
        let records = vec![record(88 * HOUR), record(89 * HOUR), record(100 * HOUR)];
        let used = training(&records, &f);
        assert_eq!(used.len(), 1);
        assert_eq!(used[0].origin_ms, 88 * HOUR);
    }
    #[test]
    fn settlement_tail_records_raw_class_but_stops_new_orders() {
        let f = Fold {
            index: 0,
            start: 0,
            end: 300 * HOUR,
            train_start: 0,
            label_available_by: 0,
        };
        let r = record(264 * HOUR);
        let s = replay_signal(&r, &[0.1, 0.1, 0.8], &f, "base", 264 * HOUR);
        assert_eq!(s.decision, "HOLD");
        assert_eq!(s.metadata["raw_model_decision"], "BUY");
    }
    #[test]
    fn gain_without_complete_settlement_cannot_retain_forecaster() {
        let b = json!({"metrics":{"comparison_complete":true,"closed_trades":20,"net_pnl_usdt":2.0,"max_drawdown_percent":1.0}});
        let a = json!({"metrics":{"comparison_complete":false,"closed_trades":20,"net_pnl_usdt":10.0,"max_drawdown_percent":0.5}});
        let segments = vec![(
            json!({"net_equity_change_usdt":1.0}),
            json!({"net_equity_change_usdt":2.0}),
        )];
        assert_eq!(retention(&b, &a, &segments, 1000.0)["retained"], false);
    }
}
