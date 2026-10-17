//! Bounded directional follow-up to the frozen historical monthly policy search.
//! Restricts permitted directions; never reverses model predictions or routes orders.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    ml_lightgbm::DEFAULT_RUNTIME_PATH,
    ml_optimization::{self, StrategyParameters},
    ml_optimization_data::DataLoader,
    ml_optimization_metrics::{Aggregate, compare, profitable_upgrade},
    ml_replay::ReplayConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const DEVELOPMENT_START: i64 = 1_791_417_600_000;
const CONFIRMATION_START: i64 = 1_791_676_800_000;
const CONFIRMATION_END: i64 = 1_791_936_000_000;

#[derive(Parser)]
#[command(about = "Check four frozen long-only/short-only monthly model candidates offline")]
struct Args {
    #[arg(
        long,
        default_value = "output/ml-optimization-20261016/selected-policy.json"
    )]
    selection_file: PathBuf,
    #[arg(long, default_value = "output/ml-monthly-20261014")]
    model_dir: PathBuf,
    #[arg(long, default_value = "data/ml/monthly-archive-20261014")]
    data_dir: PathBuf,
    #[arg(long)]
    cache_dir: Option<PathBuf>,
    #[arg(long, default_value = DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long)]
    output_dir: PathBuf,
    #[arg(long, default_value_t = 50)]
    min_trades: usize,
    #[arg(long, default_value_t = 10)]
    min_symbols: usize,
}

#[derive(Clone, Serialize)]
struct Candidate {
    parameter_source: &'static str,
    parameters: StrategyParameters,
    direction: &'static str,
    allow_buy: bool,
    allow_sell: bool,
}

impl Candidate {
    fn config(&self, base: &ReplayConfig) -> ReplayConfig {
        ReplayConfig {
            allow_buy: self.allow_buy,
            allow_sell: self.allow_sell,
            ..base.clone()
        }
    }
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path)?).with_context(|| format!("Read {}", path.display()))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing output parent")?)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    write_new(path, &serde_json::to_vec_pretty(value)?)
}

fn verify_predictions(source: &ml_optimization::SymbolData, checkpoint: &Value) -> Result<String> {
    let actual = digest(&serde_json::to_vec(&source.predictions)?);
    ensure!(
        checkpoint["probabilities_sha256"] == json!(actual),
        "Prediction probabilities, origins or coverage changed since main preflight for {}",
        source.symbol
    );
    Ok(actual)
}

// Read the existing public summary without changing the metrics module, whose
// source participates in the already-frozen parent run's software fingerprint.
#[derive(Deserialize)]
#[serde(remote = "Aggregate")]
struct AggregateSnapshot {
    symbols: usize,
    net_pnl_usdt: f64,
    closed_trades: usize,
    wins: usize,
    losses: usize,
    fees_usdt: f64,
    funding_usdt: f64,
    slippage_usdt: f64,
    max_symbol_drawdown_percent: f64,
    unresolved_orders: usize,
    profitable_symbols: usize,
    losing_symbols: usize,
    flat_symbols: usize,
}

#[derive(Deserialize)]
struct SavedAggregate {
    #[serde(with = "AggregateSnapshot")]
    value: Aggregate,
}

fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        !args.output_dir.exists(),
        "A fresh --output-dir is required"
    );
    ensure!(
        args.min_trades > 0 && args.min_symbols > 0,
        "Minimum evidence must be positive"
    );
    let began = Instant::now();
    let selection_bytes = fs::read(&args.selection_file)?;
    let selection: Value = serde_json::from_slice(&selection_bytes)?;
    let original_dir = args
        .selection_file
        .parent()
        .context("Selection parent missing")?;
    let run = read_json(&original_dir.join("run-config.json"))?;
    let preflight_bytes = fs::read(original_dir.join("preflight.json"))?;
    let preflight: Value = serde_json::from_slice(&preflight_bytes)?;
    ensure!(
        preflight["passed"] == true,
        "Source preflight has not passed"
    );
    ensure!(
        selection["run_config_sha256"] == json!(digest(&serde_json::to_vec(&run)?)),
        "Selection does not match its source run-config"
    );
    let source_software = digest(
        concat!(
            include_str!("../ml_optimization.rs"),
            include_str!("../ml_optimization_data.rs"),
            include_str!("../ml_optimization_metrics.rs"),
            include_str!("../ml_replay.rs"),
            include_str!("../paper.rs"),
            include_str!("../simulator.rs"),
            include_str!("../ml_monthly.rs"),
            include_str!("../research.rs"),
            include_str!("nofx-ml-optimize.rs")
        )
        .as_bytes(),
    );
    ensure!(
        run["software_sha256"] == json!(source_software),
        "Main search software fingerprint differs"
    );
    let cache = args
        .cache_dir
        .clone()
        .unwrap_or_else(|| args.data_dir.join("feature-cache-v3"));
    let mut data = DataLoader::open(&args.model_dir, &args.data_dir, &cache, &args.runtime)?;
    for (key, path) in [
        (
            "model_manifest_sha256",
            args.model_dir.join("manifest.json"),
        ),
        ("data_manifest_sha256", args.data_dir.join("manifest.json")),
    ] {
        ensure!(
            run[key] == json!(digest(&fs::read(path)?)),
            "Source {key} differs"
        );
    }
    ensure!(
        run["lightgbm_runtime_sha256"] == data.provenance()["lightgbm_runtime_sha256"],
        "Source LightGBM runtime differs"
    );
    ensure!(
        run["costs"] == nofx_core::research::costs(),
        "Source cost model differs"
    );
    ensure!(
        run["execution_defaults"] == nofx_core::strategies::ml_horizon_exit_rules(),
        "Source frozen protection defaults differ"
    );
    let development = ReplayConfig {
        start_ms: DEVELOPMENT_START,
        end_ms: CONFIRMATION_START,
        ..Default::default()
    };
    let confirmation = ReplayConfig {
        start_ms: CONFIRMATION_START,
        end_ms: CONFIRMATION_END,
        ..Default::default()
    };
    ensure!(
        run["development"] == serde_json::to_value(&development)?,
        "Source development window or risk differs"
    );
    ensure!(
        run["confirmation"] == serde_json::to_value(&confirmation)?,
        "Source confirmation window or risk differs"
    );
    ensure!(
        data.manifest().stride_hours == 6,
        "Frozen predictions must use the six-hour stride"
    );
    let symbols: BTreeSet<_> = data.symbols().iter().cloned().collect();
    let source_symbols: BTreeSet<String> = serde_json::from_value(run["symbols"].clone())?;
    ensure!(
        symbols.len() == 869 && symbols == source_symbols,
        "Expected the complete source universe of 869 trained symbols"
    );
    ensure!(
        preflight["original"]["symbols"] == json!(symbols.len()),
        "Source preflight universe is incomplete"
    );
    let symbols: Vec<_> = symbols.into_iter().collect();
    let mut prediction_checkpoints = BTreeMap::new();
    for symbol in &symbols {
        let checkpoint = read_json(
            &original_dir
                .join("preflight")
                .join(format!("{symbol}.json")),
        )?;
        ensure!(
            checkpoint["probabilities_sha256"].as_str().is_some_and(
                |sha| sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
            ),
            "Missing or invalid source prediction digest for {symbol}"
        );
        prediction_checkpoints.insert(symbol.clone(), checkpoint);
    }
    let selected_parameters: StrategyParameters =
        serde_json::from_value(selection["selected_parameters"].clone())?;
    let source_index = selection["selected_index"]
        .as_u64()
        .context("Source lacks selected index")? as usize;
    ensure!(
        run["candidates"][source_index] == serde_json::to_value(&selected_parameters)?,
        "Source selected parameters differ from fixed grid"
    );
    let source_best = selection["rankings"]
        .as_array()
        .context("Source rankings missing")?
        .iter()
        .find(|row| row["index"] == json!(source_index))
        .context("Source selected ranking missing")?;
    ensure!(
        source_best["eligible"] == true,
        "Source selected candidate was not eligible"
    );
    let source_best_net = source_best["metrics"]["net_pnl_usdt"]
        .as_f64()
        .filter(|n| n.is_finite())
        .context("Invalid source selected development net")?;
    let baseline_index = run["baseline_index"]
        .as_u64()
        .context("Source baseline index missing")? as usize;
    ensure!(
        run["candidates"][baseline_index] == serde_json::to_value(StrategyParameters::default())?,
        "Source baseline does not use current default parameters"
    );
    let baseline_row = selection["rankings"]
        .as_array()
        .context("Source rankings missing")?
        .iter()
        .find(|row| row["index"] == json!(baseline_index))
        .context("Source development baseline missing")?;
    let development_baseline =
        serde_json::from_value::<SavedAggregate>(json!({"value":baseline_row["metrics"]}))?.value;
    ensure!(
        development_baseline.symbols == symbols.len()
            && development_baseline.unresolved_orders == 0,
        "Source development baseline is incomplete"
    );
    let mut candidates = Vec::with_capacity(4);
    for (parameter_source, parameters) in [
        ("current_default", StrategyParameters::default()),
        ("source_development_selected", selected_parameters),
    ] {
        for (direction, allow_buy, allow_sell) in
            [("long_only", true, false), ("short_only", false, true)]
        {
            candidates.push(Candidate {
                parameter_source,
                parameters: parameters.clone(),
                direction,
                allow_buy,
                allow_sell,
            });
        }
    }
    let identity = json!({
        "schema_version":1,"tool":"nofx-ml-direction-check","created_at_ms":nofx_core::now_ms(),
        "selection_file":args.selection_file.canonicalize()?,"selection_file_sha256":digest(&selection_bytes),
        "source_run_config_sha256":selection["run_config_sha256"],"source_preflight_sha256":digest(&preflight_bytes),
        "source_prediction_checkpoints_sha256":digest(&serde_json::to_vec(&prediction_checkpoints)?),
        "source_preflight_passed":true,"source_bidirectional_development_best_net_usdt":source_best_net,
        "model_manifest_sha256":run["model_manifest_sha256"],"data_manifest_sha256":run["data_manifest_sha256"],
        "lightgbm_runtime_sha256":run["lightgbm_runtime_sha256"],"source_software_sha256":run["software_sha256"],
        "software_sha256":digest(concat!(include_str!("nofx-ml-direction-check.rs"),include_str!("../ml_optimization.rs"),include_str!("../ml_optimization_data.rs"),include_str!("../ml_optimization_metrics.rs"),include_str!("../ml_replay.rs"),include_str!("../paper.rs"),include_str!("../simulator.rs")).as_bytes()),
        "executable_sha256":digest(&fs::read(std::env::current_exe()?)?),
        "symbols":symbols,"candidates":candidates,"development":development,"confirmation":confirmation,
        "costs":run["costs"],"execution_defaults":run["execution_defaults"],
        "min_trades":args.min_trades,"min_symbols":args.min_symbols,
        "selection_scope":"Four additional directional candidates after observing the prior 48-candidate development search",
        "prior_test_already_observed":true,"signal_stride_hours":6,"settlement_tail_hours":36,
        "scope":"Independent 1000 USDT accounts per symbol; not shared Demo capital",
        "demo_entry_timing_reproduced":false,"runtime_modified":false,"deployment_approved":false,"real_trading_enabled":false
    });
    fs::create_dir(&args.output_dir)?;
    write_json(&args.output_dir.join("run-config.json"), &identity)?;
    let mut totals = vec![Aggregate::default(); 4];
    for (number, symbol) in symbols.iter().enumerate() {
        let source = data.load(symbol)?;
        let predictions_sha256 = verify_predictions(&source, &prediction_checkpoints[symbol])?;
        let mut results = Vec::with_capacity(4);
        for (index, candidate) in candidates.iter().enumerate() {
            let replay = ml_optimization::evaluate(
                &source,
                &candidate.parameters,
                &candidate.config(&development),
            )
            .with_context(|| format!("Development {symbol} candidate {index}"))?;
            totals[index].add(&replay)?;
            results.push(json!({"index":index,"candidate":candidate,"metrics":replay["metrics"],
                "effective_parameters":replay["effective_parameters"],"risk_policy":replay["risk_policy"],"execution_scope":replay["execution_scope"]}));
        }
        write_json(
            &args
                .output_dir
                .join("development")
                .join(format!("{symbol}.json")),
            &json!({"symbol":symbol,"probabilities_sha256":predictions_sha256,"candidates":results}),
        )?;
        if (number + 1) % 25 == 0 || number + 1 == symbols.len() {
            println!(
                "{}",
                json!({"stage":"direction_development","completed":number+1,"symbols":symbols.len(),"elapsed_seconds":began.elapsed().as_secs_f64()})
            );
        }
    }
    let mut ranking: Vec<_> = (0..4).collect();
    ranking.sort_by(|a, b| {
        let eligible = |i: usize| totals[i].eligible(args.min_trades, args.min_symbols, 10.);
        eligible(*b)
            .cmp(&eligible(*a))
            .then_with(|| compare(&totals[*b], &totals[*a]))
            .then_with(|| a.cmp(b))
    });
    let selected = ranking
        .iter()
        .copied()
        .find(|&i| totals[i].eligible(args.min_trades, args.min_symbols, 10.));
    let improves_source = selected.is_some_and(|i| totals[i].net_pnl_usdt > source_best_net);
    let rankings: Vec<_> = ranking.iter().map(|&i| json!({"index":i,"candidate":candidates[i],"metrics":totals[i],"eligible":totals[i].eligible(args.min_trades,args.min_symbols,10.)})).collect();
    let frozen = json!({"selection_method":"Maximum development net PnL among four eligible directional candidates; frozen before directional confirmation; no confirmation reselection",
        "selected_index":selected,"selected_candidate":selected.map(|i|&candidates[i]),"rankings":rankings,
        "source_bidirectional_development_best_net_usdt":source_best_net,"improves_source_bidirectional_development_best":improves_source,
        "no_direction_candidate_improves_source":!improves_source,"run_config_sha256":digest(&serde_json::to_vec(&identity)?),
        "development_end_ms":CONFIRMATION_START,"confirmation_start_ms":CONFIRMATION_START,
        "status":"observed_historical_candidate_only","deployment_approved":false,"runtime_modified":false});
    write_json(&args.output_dir.join("selected-policy.json"), &frozen)?;
    println!(
        "{}",
        json!({"stage":"direction_selection_frozen","selected":selected,"improves_source_development_best":improves_source})
    );
    let mut baseline_total = Aggregate::default();
    let mut candidate_total = Aggregate::default();
    let mut per_symbol = Vec::with_capacity(symbols.len());
    for (number, symbol) in symbols.iter().enumerate() {
        let source = data.load(symbol)?;
        let predictions_sha256 = verify_predictions(&source, &prediction_checkpoints[symbol])?;
        let baseline =
            ml_optimization::evaluate(&source, &StrategyParameters::default(), &confirmation)
                .with_context(|| format!("Confirmation baseline {symbol}"))?;
        baseline_total.add(&baseline)?;
        write_json(
            &args
                .output_dir
                .join("confirmation")
                .join(format!("{symbol}-baseline.json")),
            &baseline,
        )?;
        let selected_metrics = if let Some(index) = selected {
            let candidate = &candidates[index];
            let replay = ml_optimization::evaluate(
                &source,
                &candidate.parameters,
                &candidate.config(&confirmation),
            )
            .with_context(|| format!("Confirmation selected {symbol}"))?;
            candidate_total.add(&replay)?;
            write_json(
                &args
                    .output_dir
                    .join("confirmation")
                    .join(format!("{symbol}-selected.json")),
                &replay,
            )?;
            replay["metrics"].clone()
        } else {
            Value::Null
        };
        per_symbol.push(
            json!({"symbol":symbol,"probabilities_sha256":predictions_sha256,"baseline":baseline["metrics"],"selected":selected_metrics}),
        );
        if (number + 1) % 25 == 0 || number + 1 == symbols.len() {
            println!(
                "{}",
                json!({"stage":"direction_confirmation","completed":number+1,"symbols":symbols.len(),"elapsed_seconds":began.elapsed().as_secs_f64()})
            );
        }
    }
    let development_pass = selected.is_some_and(|index| {
        profitable_upgrade(
            &totals[index],
            &development_baseline,
            args.min_trades,
            args.min_symbols,
        )
    });
    let historical_pass = development_pass
        && improves_source
        && profitable_upgrade(
            &candidate_total,
            &baseline_total,
            args.min_trades,
            args.min_symbols,
        );
    let report = json!({"schema_version":1,"status":"completed","created_at_ms":nofx_core::now_ms(),
        "run_config_sha256":digest(&serde_json::to_vec(&identity)?),"selection":frozen,
        "confirmation_baseline_parameters":StrategyParameters::default(),"confirmation_baseline_direction":"bidirectional",
        "confirmation_baseline":baseline_total,"confirmation_selected":selected.map(|_|&candidate_total),
        "source_development_baseline":development_baseline,"development_profitable_upgrade":development_pass,
        "confirmation_symbols":per_symbol,"provenance":data.provenance(),
        "historical_profitable_upgrade":historical_pass,"source_bidirectional_development_best_net_usdt":source_best_net,
        "improves_source_bidirectional_development_best":improves_source,"prior_test_already_observed":true,
        "orders_enabled":false,"deployment_approved":false,"runtime_modified":false,"real_trading_enabled":false,
        "limitations":["Four extra candidates were added after prior historical development results were observed; this expands retrospective model selection.",
            "Both windows were previously observed history, not a new blind test or forward validation.",
            "Net PnL is the sum of independent 1000-USDT symbol accounts, not a shared-capital portfolio.",
            "Signals use the frozen six-hour stride; production scans can observe hourly origins.",
            "Shared paper replay delays entry and expires pending orders after 24h; Demo routes eligible MARKET/LIMIT requests immediately and permits first send only while model age is below 2h."]});
    let selected_label = selected
        .map(|index| {
            format!(
                "{} / {}",
                candidates[index].parameter_source, candidates[index].direction
            )
        })
        .unwrap_or_else(|| "无候选满足证据门槛".into());
    let development_net = selected
        .map(|i| format!("{:.6}", totals[i].net_pnl_usdt))
        .unwrap_or_else(|| "未选择".into());
    let confirmation_net = selected
        .map(|_| format!("{:.6}", candidate_total.net_pnl_usdt))
        .unwrap_or_else(|| "未评估".into());
    let markdown = format!(
        "# Chronos + LightGBM 方向检查\n\n869币、4个有限候选：当前默认参数和主搜索选中参数分别限制为只多或只空，不反转预测方向。\n\n开发窗口：2026-10-08至10-11 UTC；确认窗口：10-11至10-14 UTC，均保留36小时结算尾段。选择先冻结，再只确认该候选及当前双向默认基线。\n\n选择：{selected_label}。\n\n| 指标 | 数值 |\n| --- | ---: |\n| 主双向开发最优净收益 USDT | {source_best_net:.6} |\n| 方向候选开发净收益 USDT | {development_net} |\n| 方向候选确认净收益 USDT | {confirmation_net} |\n| 当前双向默认确认净收益 USDT | {:.6} |\n\n方向候选是否超过主双向开发最优：{improves_source}。历史盈利升级条件：{historical_pass}。未超过时，四个方向候选未提供更优开发结果。\n\n历史此前已被观察，本轮是在已知结果后增加的方向检查，不能称新盲测。金额为每币独立1000 USDT账户结果合计；信号间隔6小时，不等于Demo共享账户。费用、滑点、资金成本和出场均复用Rust共享引擎，风险上限未放宽。Demo首次发单时序与离线回放不同，详见report.json。未自动部署，当前运行配置未修改。\n",
        baseline_total.net_pnl_usdt
    );
    write_new(&args.output_dir.join("report.md"), markdown.as_bytes())?;
    // The final completion marker follows every required report artifact.
    write_json(&args.output_dir.join("report.json"), &report)?;
    println!(
        "{}",
        json!({"stage":"completed","selected":selected,"development_net_usdt":selected.map(|i|totals[i].net_pnl_usdt),
        "confirmation_net_usdt":selected.map(|_|candidate_total.net_pnl_usdt),"improves_source_development_best":improves_source,
        "historical_profitable_upgrade":historical_pass,"elapsed_seconds":began.elapsed().as_secs_f64(),"runtime_modified":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ml_optimization::{ProbabilityPoint, SymbolData};

    fn source() -> SymbolData {
        const HOUR: i64 = 3_600_000;
        SymbolData {
            symbol: "BTCUSDT".into(),
            rows: (0..96).map(|i| json!({"openTime":i * HOUR,"open":100.,"high":101.,"low":99.,"close":100.,"volume":100.,"confirmed":true})).collect(),
            predictions: vec![
                ProbabilityPoint { origin_ms:24 * HOUR, probabilities:[0.05,0.05,0.90] },
                ProbabilityPoint { origin_ms:40 * HOUR, probabilities:[0.90,0.05,0.05] },
            ],
        }
    }

    #[test]
    fn frozen_main_preflight_rejects_changed_probabilities_origins_and_coverage() {
        let original = source();
        let checkpoint = json!({"probabilities_sha256":digest(&serde_json::to_vec(&original.predictions).unwrap())});
        assert!(verify_predictions(&original, &checkpoint).is_ok());
        let mut changed = original.clone();
        // Still normalized, but a different model forecast must be rejected.
        changed.predictions[0].probabilities = [0.05, 0.10, 0.85];
        assert!(verify_predictions(&changed, &checkpoint).is_err());
        changed = original.clone();
        changed.predictions[0].origin_ms += 3_600_000;
        assert!(verify_predictions(&changed, &checkpoint).is_err());
        changed = original;
        changed.predictions.pop();
        assert!(verify_predictions(&changed, &checkpoint).is_err());
    }

    #[test]
    fn direction_filters_skip_opposite_signals_without_reversing_them() {
        let source = source();
        let config = ReplayConfig {
            start_ms: 24 * 3_600_000,
            end_ms: 96 * 3_600_000,
            ..Default::default()
        };
        let baseline =
            ml_optimization::evaluate(&source, &StrategyParameters::default(), &config).unwrap();
        assert_eq!(baseline["metrics"]["closed_trades"], 2);
        for (direction, allow_buy, allow_sell, disabled, actual_direction) in [
            ("long_only", true, false, 1, "OPEN_LONG"),
            ("short_only", false, true, 0, "OPEN_SHORT"),
        ] {
            let candidate = Candidate {
                parameter_source: "current_default",
                parameters: StrategyParameters::default(),
                direction,
                allow_buy,
                allow_sell,
            };
            let replay = ml_optimization::evaluate(
                &source,
                &candidate.parameters,
                &candidate.config(&config),
            )
            .unwrap();
            assert_eq!(replay["signal_log"][0]["decision"], "BUY");
            assert_eq!(replay["signal_log"][1]["decision"], "SELL");
            assert_eq!(
                replay["signal_log"][disabled]["outcome"],
                "direction_disabled"
            );
            assert_eq!(replay["metrics"]["closed_trades"], 1);
            assert_eq!(replay["metrics"]["comparison_complete"], true);
            assert_eq!(replay["orders"][0]["direction"], actual_direction);
            assert_eq!(replay["orders"][0]["leverage"], 1.);
            assert!(replay["metrics"]["fees_usdt"].as_f64().unwrap() > 0.);
        }
    }
}
