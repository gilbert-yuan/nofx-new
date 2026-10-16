//! Bounded, offline policy search over frozen model predictions. No account or
//! exchange client is created; all trading outcomes come from ml_replay.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    iso,
    ml_lightgbm::DEFAULT_RUNTIME_PATH,
    ml_optimization::{self, StrategyParameters},
    ml_optimization_data::DataLoader,
    ml_optimization_metrics::{Aggregate, compare, profitable_upgrade},
    ml_replay::ReplayConfig,
    now_ms,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const HOUR: i64 = 3_600_000;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "output/ml-monthly-20261014")]
    model_dir: PathBuf,
    #[arg(long, default_value = "data/ml/monthly-archive-20261014")]
    data_dir: PathBuf,
    #[arg(long)]
    cache_dir: Option<PathBuf>,
    #[arg(long, default_value=DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    #[arg(long)]
    output_dir: PathBuf,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long, default_value_t = 50)]
    min_trades: usize,
    #[arg(long, default_value_t = 10)]
    min_symbols: usize,
    #[arg(long, default_value_t = 4)]
    workers: usize,
    #[arg(long)]
    resume: bool,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path)?).with_context(|| format!("Read {}", path.display()))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing output parent")?)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("Preserve existing output {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    if path.exists() {
        ensure!(
            read_json(path)? == *value,
            "Existing checkpoint differs: {}",
            path.display()
        );
        return Ok(());
    }
    write_new(path, &serde_json::to_vec_pretty(value)?)
}

fn daily_net(replay: &Value) -> Result<BTreeMap<String, f64>> {
    let curve = replay["equity_curve"]
        .as_array()
        .context("Missing shared equity curve")?;
    let mut days = BTreeMap::new();
    for pair in curve.windows(2) {
        let end = pair[1]["time_ms"].as_i64().context("Missing curve time")?;
        let before = pair[0]["equity"].as_f64().context("Missing curve equity")?;
        let after = pair[1]["equity"].as_f64().context("Missing curve equity")?;
        let day = iso(end - 1)[..10].to_owned();
        *days.entry(day).or_insert(0.) += after - before;
    }
    Ok(days)
}

fn add_days(total: &mut BTreeMap<String, f64>, value: &Value) -> Result<()> {
    for (date, net) in value.as_object().context("Missing daily results")? {
        let net = net
            .as_f64()
            .filter(|n| n.is_finite())
            .context("Invalid daily result")?;
        *total.entry(date.clone()).or_insert(0.) += net;
    }
    Ok(())
}

fn summary(replay: &Value) -> Result<Value> {
    Ok(json!({"metrics":replay["metrics"],"daily_net_usdt":daily_net(replay)?}))
}

fn evaluate_grid(
    source: &ml_optimization::SymbolData,
    parameters: &[StrategyParameters],
    config: &ReplayConfig,
    workers: usize,
) -> Result<Vec<Value>> {
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        let workers = workers.min(parameters.len()).max(1);
        for worker in 0..workers {
            handles.push(scope.spawn(move || -> Result<Vec<(usize, Value)>> {
                let mut values = Vec::new();
                for index in (worker..parameters.len()).step_by(workers) {
                    let replay = ml_optimization::evaluate(source, &parameters[index], config)
                        .with_context(|| {
                            format!("Development {} candidate {index}", source.symbol)
                        })?;
                    values.push((index, summary(&replay)?));
                }
                Ok(values)
            }));
        }
        let mut ordered = vec![Value::Null; parameters.len()];
        for handle in handles {
            let values = handle
                .join()
                .map_err(|_| anyhow::anyhow!("Optimization worker panicked"))??;
            for (index, value) in values {
                ordered[index] = value;
            }
        }
        ensure!(
            ordered.iter().all(Value::is_object),
            "Missing candidate result"
        );
        Ok(ordered)
    })
}

fn verify_original_probabilities(
    source: &ml_optimization::SymbolData,
    original: &Value,
) -> Result<()> {
    let log = original["signal_log"]
        .as_array()
        .context("Original signal log missing")?;
    ensure!(
        log.len() == source.predictions.len(),
        "Original prediction coverage changed for {}",
        source.symbol
    );
    for (point, recorded) in source.predictions.iter().zip(log) {
        ensure!(
            recorded["origin_ms"] == point.origin_ms,
            "Original prediction origin changed"
        );
        for (column, name) in ["SELL", "HOLD", "BUY"].iter().enumerate() {
            let expected = recorded["probabilities"][*name]
                .as_f64()
                .context("Original probability missing")?;
            ensure!(
                (expected - point.probabilities[column]).abs() <= 1e-10,
                "Reconstructed model probability differs for {} at {}",
                source.symbol,
                point.origin_ms
            );
        }
    }
    Ok(())
}

fn reproduce_original(
    source: &ml_optimization::SymbolData,
    config: &ReplayConfig,
    policy: &nofx_core::ml_monthly::DecisionPolicy,
) -> Result<Value> {
    let signals: Vec<_> = source
        .predictions
        .iter()
        .map(|point| {
            let decision = if point.origin_ms >= config.end_ms - 36 * HOUR {
                "HOLD"
            } else {
                nofx_core::ml_monthly::decide(&point.probabilities, policy)
            };
            nofx_core::ml_replay::ReplaySignal {
                origin_ms: point.origin_ms,
                decision: decision.into(),
                probabilities: nofx_core::ml_features::probabilities_json(&point.probabilities),
                metadata: json!({"variant":"original_trainer_reproduction"}),
                plan: None,
            }
        })
        .collect();
    nofx_core::ml_replay::replay(&source.symbol, &source.rows, &signals, config)
}

fn main() -> Result<()> {
    let args = Args::parse();
    ensure!((1..=16).contains(&args.workers), "Workers must be 1..=16");
    ensure!(
        args.min_trades > 0 && args.min_symbols > 0,
        "Minimum evidence must be positive"
    );
    ensure!(
        !args.output_dir.exists() || args.resume,
        "Use a fresh --output-dir or --resume"
    );
    let cache = args
        .cache_dir
        .clone()
        .unwrap_or_else(|| args.data_dir.join("feature-cache-v3"));
    let mut data = DataLoader::open(&args.model_dir, &args.data_dir, &cache, &args.runtime)?;
    let manifest = data.manifest().clone();
    let universe: BTreeSet<_> = data.symbols().iter().cloned().collect();
    let symbols: Vec<_> = if args.symbols.is_empty() {
        universe.iter().cloned().collect()
    } else {
        let chosen: BTreeSet<_> = args.symbols.iter().map(|s| s.to_uppercase()).collect();
        ensure!(
            chosen.is_subset(&universe),
            "Requested symbol is outside frozen model universe"
        );
        chosen.into_iter().collect()
    };
    ensure!(!symbols.is_empty(), "Empty optimization universe");
    let start = manifest.split.validation_end_ms;
    let end = manifest.split.test_end_ms;
    let middle = ((start + (end - start) / 2) / HOUR) * HOUR;
    ensure!(
        middle - start > 36 * HOUR && end - middle > 36 * HOUR,
        "Historical windows lack settlement space"
    );
    let development = ReplayConfig {
        start_ms: start,
        end_ms: middle,
        ..Default::default()
    };
    let confirmation = ReplayConfig {
        start_ms: middle,
        end_ms: end,
        ..Default::default()
    };
    let candidates = ml_optimization::candidate_grid();
    let baseline_index = candidates
        .iter()
        .position(|p| *p == StrategyParameters::default())
        .context("Grid lacks baseline")?;
    let software = digest(
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
    let identity = json!({"schema_version":1,"model_manifest_sha256":digest(&fs::read(args.model_dir.join("manifest.json"))?),
        "data_manifest_sha256":digest(&fs::read(args.data_dir.join("manifest.json"))?),"software_sha256":software,
        "executable_sha256":digest(&fs::read(std::env::current_exe()?)?),
        "lightgbm_runtime_sha256":data.provenance()["lightgbm_runtime_sha256"],
        "execution_defaults":nofx_core::strategies::exit_rules_for(&json!({})),
        "original_training_report_sha256":digest(&fs::read(args.model_dir.join("training-report.json"))?),
        "symbols":symbols,"candidates":candidates,"baseline_index":baseline_index,"development":development,
        "confirmation":confirmation,"costs":nofx_core::research::costs(),"min_trades":args.min_trades,"min_symbols":args.min_symbols,"workers":args.workers,
        "scope":"Independent 1000 USDT accounts per symbol; frozen 6-hour signals; not a shared Demo portfolio",
        "prior_test_already_observed":true,"runtime_modified":false,"real_trading_enabled":false});
    fs::create_dir_all(&args.output_dir)?;
    write_json(&args.output_dir.join("run-config.json"), &identity)?;
    if args.resume && args.output_dir.join("report.json").exists() {
        ensure!(
            args.output_dir.join("report.md").is_file(),
            "Completed report is missing its Markdown artifact"
        );
        println!(
            "{}",
            json!({"stage":"already_complete","report":args.output_dir.join("report.json")})
        );
        return Ok(());
    }
    let began = Instant::now();
    let full_window = ReplayConfig {
        start_ms: start,
        end_ms: end,
        ..Default::default()
    };
    let mut original_total = Aggregate::default();
    let mut reconstructed_total = Aggregate::default();
    let mut prediction_count = 0_usize;
    for (number, symbol) in symbols.iter().enumerate() {
        let source = data.load(symbol)?;
        let original_path = args
            .model_dir
            .join("replay")
            .join(format!("{symbol}-augmented.json"));
        let original = read_json(&original_path)?;
        verify_original_probabilities(&source, &original)?;
        prediction_count += source.predictions.len();
        let path = args
            .output_dir
            .join("preflight")
            .join(format!("{symbol}.json"));
        let source_hash = digest(&serde_json::to_vec(&source.predictions)?);
        let original_hash = digest(&fs::read(original_path)?);
        let replay = if path.exists() {
            ensure!(args.resume, "Unexpected preflight checkpoint");
            let value = read_json(&path)?;
            ensure!(
                value["probabilities_sha256"] == source_hash
                    && value["original_replay_sha256"] == original_hash,
                "Preflight source changed"
            );
            value
        } else {
            // Reproduce the original trainer's implicit exits, separately from
            // current-pipeline candidates with explicit exit-rule snapshots.
            let result = reproduce_original(&source, &full_window, &manifest.policy)?;
            let value = json!({"metrics":result["metrics"],"probabilities_sha256":source_hash,"original_replay_sha256":original_hash});
            write_json(&path, &value)?;
            value
        };
        let actual = &replay["metrics"];
        let expected = &original["metrics"];
        for name in ["closed_trades", "unresolved_orders", "signals"] {
            ensure!(
                actual[name] == expected[name],
                "Preflight {symbol}: original {name} differs"
            );
        }
        ensure!(
            (actual["net_pnl_usdt"].as_f64().context("Missing net")?
                - expected["net_pnl_usdt"]
                    .as_f64()
                    .context("Missing original net")?)
            .abs()
                <= 1e-7,
            "Preflight {symbol}: original net PnL differs"
        );
        original_total.add(&original)?;
        reconstructed_total.add(&replay)?;
        if (number + 1) % 25 == 0 || number + 1 == symbols.len() {
            println!(
                "{}",
                json!({"stage":"preflight","completed":number+1,"symbols":symbols.len(),"predictions":prediction_count,"elapsed_seconds":began.elapsed().as_secs_f64()})
            );
        }
    }
    if symbols.len() == universe.len() {
        let original_report = read_json(&args.model_dir.join("training-report.json"))?;
        ensure!(
            original_report["test_rows"] == prediction_count,
            "Original total prediction coverage changed"
        );
        ensure!(
            original_report["shared_engine_replay"]["closed_trades"]
                == reconstructed_total.closed_trades,
            "Original aggregate trade count differs"
        );
        ensure!(
            (original_report["shared_engine_replay"]["sum_test_net_usdt"]
                .as_f64()
                .context("Missing original aggregate net")?
                - reconstructed_total.net_pnl_usdt)
                .abs()
                <= 1e-6,
            "Original aggregate net differs"
        );
    }
    let preflight = json!({"passed":true,"prediction_count":prediction_count,"original":original_total,"reconstructed":reconstructed_total,
        "probability_tolerance":1e-10,"net_tolerance_per_symbol_usdt":1e-7,
        "exit_contract":"Original trainer plan=None; search uses current explicit production exit rules"});
    write_json(&args.output_dir.join("preflight.json"), &preflight)?;
    let mut totals = vec![Aggregate::default(); candidates.len()];
    let mut days = vec![BTreeMap::new(); candidates.len()];
    for (number, symbol) in symbols.iter().enumerate() {
        let source = data
            .load(symbol)
            .with_context(|| format!("Load development {symbol}"))?;
        let source_hash = digest(&serde_json::to_vec(&source.predictions)?);
        let path = args
            .output_dir
            .join("development")
            .join(format!("{symbol}.json"));
        let checkpoint = if path.exists() {
            ensure!(args.resume, "Unexpected existing checkpoint");
            let existing = read_json(&path)?;
            ensure!(
                existing["probabilities_sha256"] == source_hash,
                "Changed model probabilities for {symbol}"
            );
            existing
        } else {
            let evaluations = evaluate_grid(&source, &candidates, &development, args.workers)?;
            let value = json!({"symbol":symbol,"probabilities_sha256":source_hash,"evaluations":evaluations});
            write_json(&path, &value)?;
            value
        };
        let values = checkpoint["evaluations"]
            .as_array()
            .context("Missing candidate metrics")?;
        ensure!(
            values.len() == candidates.len(),
            "Candidate checkpoint length mismatch"
        );
        for (index, replay) in values.iter().enumerate() {
            totals[index].add(replay)?;
            add_days(&mut days[index], &replay["daily_net_usdt"])?;
        }
        println!(
            "{}",
            json!({"stage":"development","completed":number+1,"symbols":symbols.len(),
            "symbol":symbol,"elapsed_seconds":began.elapsed().as_secs_f64(),"baseline_net_usdt":totals[baseline_index].net_pnl_usdt})
        );
    }
    let mut ranking: Vec<_> = (0..candidates.len()).collect();
    ranking.sort_by(|a, b| {
        let allowed = |i: usize| totals[i].eligible(args.min_trades, args.min_symbols, 10.);
        allowed(*b)
            .cmp(&allowed(*a))
            .then_with(|| compare(&totals[*b], &totals[*a]))
            .then_with(|| a.cmp(b))
    });
    let selected = ranking
        .iter()
        .copied()
        .find(|i| totals[*i].eligible(args.min_trades, args.min_symbols, 10.));
    let rankings:Vec<_>=ranking.iter().map(|&i|json!({"index":i,"parameters":candidates[i],"metrics":totals[i],
        "eligible":totals[i].eligible(args.min_trades,args.min_symbols,10.),"daily_net_usdt":days[i]})).collect();
    let frozen = json!({"selection_method":"Maximum development net PnL after production costs among eligible candidates; no confirmation reselection",
        "selected_index":selected,"selected_parameters":selected.map(|i|&candidates[i]),"run_config_sha256":digest(&serde_json::to_vec(&identity)?),
        "development_end_ms":middle,"confirmation_start_ms":middle,"rankings":rankings,
        "status":"historical_candidate_only","deployment_approved":false,"runtime_modified":false});
    // Freeze before evaluating candidate confirmation; preflight only audited
    // the already-published legacy baseline, not candidate rankings there.
    write_json(&args.output_dir.join("selected-policy.json"), &frozen)?;
    println!(
        "{}",
        json!({"stage":"selection_frozen","selected":selected,"parameters":selected.map(|i|&candidates[i])})
    );
    let chosen = selected.unwrap_or(baseline_index);
    let mut confirm_baseline = Aggregate::default();
    let mut confirm_chosen = Aggregate::default();
    let mut confirm_days = [BTreeMap::new(), BTreeMap::new()];
    let mut per_symbol = Vec::new();
    for (number, symbol) in symbols.iter().enumerate() {
        let source = data
            .load(symbol)
            .with_context(|| format!("Load confirmation {symbol}"))?;
        let source_hash = digest(&serde_json::to_vec(&source.predictions)?);
        let path = args
            .output_dir
            .join("confirmation")
            .join(format!("{symbol}.json"));
        let saved = if path.exists() {
            ensure!(args.resume, "Unexpected existing confirmation");
            let existing = read_json(&path)?;
            ensure!(
                existing["probabilities_sha256"] == source_hash,
                "Changed confirmation probabilities"
            );
            existing
        } else {
            let baseline =
                ml_optimization::evaluate(&source, &candidates[baseline_index], &confirmation)?;
            let candidate = if chosen == baseline_index {
                baseline.clone()
            } else {
                ml_optimization::evaluate(&source, &candidates[chosen], &confirmation)?
            };
            // Detailed orders, equity and signal logs allow independent auditing.
            let value = json!({"symbol":symbol,"probabilities_sha256":source_hash,"baseline":baseline,"candidate":candidate});
            write_json(&path, &value)?;
            value
        };
        confirm_baseline.add(&saved["baseline"])?;
        confirm_chosen.add(&saved["candidate"])?;
        for (index, variant) in ["baseline", "candidate"].iter().enumerate() {
            add_days(
                &mut confirm_days[index],
                &serde_json::to_value(daily_net(&saved[*variant])?)?,
            )?;
        }
        per_symbol.push(json!({"symbol":symbol,"baseline":saved["baseline"]["metrics"],"candidate":saved["candidate"]["metrics"]}));
        if (number + 1) % 25 == 0 || number + 1 == symbols.len() {
            println!(
                "{}",
                json!({"stage":"confirmation","completed":number+1,"symbols":symbols.len(),"elapsed_seconds":began.elapsed().as_secs_f64()})
            );
        }
    }
    let development_pass = selected.is_some()
        && profitable_upgrade(
            &totals[chosen],
            &totals[baseline_index],
            args.min_trades,
            args.min_symbols,
        );
    let confirmation_pass = selected.is_some()
        && profitable_upgrade(
            &confirm_chosen,
            &confirm_baseline,
            args.min_trades,
            args.min_symbols,
        );
    let historical_pass = development_pass && confirmation_pass;
    let report = json!({"schema_version":1,"finished_at":iso(now_ms()),"elapsed_seconds":began.elapsed().as_secs_f64(),"run":identity,
        "selection":frozen,"development_baseline":totals[baseline_index],"development_candidate":totals[chosen],
        "confirmation_baseline":confirm_baseline,"confirmation_candidate":confirm_chosen,"confirmation_daily_net_usdt":{"baseline":confirm_days[0],"candidate":confirm_days[1]},
        "confirmation_symbols":per_symbol,"provenance":data.provenance(),"preflight":preflight,"historical_profitable_upgrade":historical_pass,
        "development_profitable_upgrade":development_pass,"confirmation_profitable_upgrade":confirmation_pass,
        "cash_benchmark":{"net_pnl_usdt":0.,"trades":0},"deployment_approved":false,"runtime_modified":false,"real_trading_enabled":false,
        "limitations":["Both dates belong to the prior observed test period; confirmation is historical, not a new blind holdout.",
        "Signals are sampled every six hours; current Demo scans hourly and uses a shared account, exchange filters and liquidity limits.",
        "Profit is the sum of independent symbol accounts; worst symbol drawdown is not portfolio drawdown.",
        "Each 72-hour segment has a common 36-hour no-new-entry tail; intervals have limited trading opportunities.",
        "Funding and slippage use the production shared assumptions, not reconstructed historical order books or actual funding.",
        "The paper engine delays entry by one hour and has a 24-hour pending TTL; Demo routes eligible orders immediately with a two-hour first-send signal-age check.",
        "A policy must be frozen and validated on sufficiently long new forward data before changing Demo execution."]});
    let parameters = &candidates[chosen];
    let markdown = format!(
        "# Chronos + LightGBM 参数搜索\n\n范围：{} 个币种、{} 个预先固定候选。现有模型权重不变。\n\n开发窗口：{} 至 {}；确认窗口：{} 至 {}。两段均保留36小时结算尾段；历史此前已观察，不是新盲测。\n\n选择参数：概率门槛 {}，概率差 {}，止损 {} ATR，止盈 {} ATR，持有 {} 根小时K线，另有1根入场延迟。\n\n| 指标 | 原参数 | 选中参数 |\n| --- | ---: | ---: |\n| 开发段净收益合计 USDT | {:.6} | {:.6} |\n| 确认段净收益合计 USDT | {:.6} | {:.6} |\n| 确认段已平仓交易 | {} | {} |\n| 确认段最大单币回撤 % | {:.6} | {:.6} |\n| 确认段手续费 USDT | {:.6} | {:.6} |\n\n两段盈利升级条件：{}。当前运行参数未修改，等待足量新数据的前向验证。\n\n上述金额为每币独立1000 USDT账户结果加总，采用6小时间隔信号，不代表当前Demo共享资金账户收益。资金上限保持每笔50 USDT、1倍杠杆、1%风险预算、3%日损和10%最大回撤；费用、滑点、资金成本和出场来自共享Rust引擎。零交易、未结算或证据不足的候选不能胜出。全部排名、逐币确认订单、来源哈希和限制见 report.json 与 selected-policy.json。\n",
        symbols.len(),
        candidates.len(),
        iso(start),
        iso(middle),
        iso(middle),
        iso(end),
        parameters.probability_threshold,
        parameters.probability_margin,
        parameters.stop_atr,
        parameters.target_atr,
        parameters.max_hold_bars,
        totals[baseline_index].net_pnl_usdt,
        totals[chosen].net_pnl_usdt,
        confirm_baseline.net_pnl_usdt,
        confirm_chosen.net_pnl_usdt,
        confirm_baseline.closed_trades,
        confirm_chosen.closed_trades,
        confirm_baseline.max_symbol_drawdown_percent,
        confirm_chosen.max_symbol_drawdown_percent,
        confirm_baseline.fees_usdt,
        confirm_chosen.fees_usdt,
        if historical_pass {
            "通过历史条件，仍未获得前向验证"
        } else {
            "未通过"
        }
    );
    let markdown_path = args.output_dir.join("report.md");
    if markdown_path.exists() {
        ensure!(
            fs::read(&markdown_path)? == markdown.as_bytes(),
            "Existing Markdown report differs"
        );
    } else {
        write_new(&markdown_path, markdown.as_bytes())?;
    }
    // This is the completion marker; resumable checkpoints precede both reports.
    write_json(&args.output_dir.join("report.json"), &report)?;
    println!(
        "{}",
        json!({"stage":"complete","output_dir":args.output_dir,"selected_parameters":parameters,
        "development_baseline":totals[baseline_index],"development_candidate":totals[chosen],"confirmation_baseline":confirm_baseline,
        "confirmation_candidate":confirm_chosen,"historical_profitable_upgrade":historical_pass,"deployment_approved":false})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ml_optimization::{ProbabilityPoint, SymbolData};

    #[test]
    fn original_audit_rejects_missing_samples_and_changed_probabilities() {
        let source = SymbolData {
            symbol: "BTCUSDT".into(),
            rows: vec![],
            predictions: vec![ProbabilityPoint {
                origin_ms: 100 * HOUR,
                probabilities: [0.1, 0.2, 0.7],
            }],
        };
        let original = json!({"signal_log":[{"origin_ms":100*HOUR,"probabilities":{"SELL":0.1,"HOLD":0.2,"BUY":0.7}}]});
        assert!(verify_original_probabilities(&source, &original).is_ok());
        let mut changed = original.clone();
        changed["signal_log"][0]["probabilities"]["BUY"] = json!(0.71);
        assert!(verify_original_probabilities(&source, &changed).is_err());
        assert!(verify_original_probabilities(&source, &json!({"signal_log":[]})).is_err());
        changed = original;
        changed["signal_log"][0]["origin_ms"] = json!(101 * HOUR);
        assert!(verify_original_probabilities(&source, &changed).is_err());
    }

    #[test]
    fn daily_summary_uses_shared_equity_deltas_and_utc_close_boundary() {
        let midnight = 86_400_000_i64;
        let result = daily_net(&json!({"equity_curve":[
            {"time_ms":midnight-HOUR,"equity":1000.},
            {"time_ms":midnight,"equity":1002.},
            {"time_ms":midnight+HOUR,"equity":1001.}]}))
        .unwrap();
        assert_eq!(result["1970-01-01"], 2.);
        assert_eq!(result["1970-01-02"], -1.);
    }

    #[test]
    fn worker_count_preserves_ordered_shared_engine_metrics() {
        let source=SymbolData {symbol:"BTCUSDT".into(),rows:(0..96).map(|i|json!({"openTime":i*HOUR,"open":100.,"close":100.,"low":99.,"high":101.,"volume":10.,"confirmed":true})).collect(),
            predictions:vec![ProbabilityPoint {origin_ms:24*HOUR,probabilities:[0.1,0.1,0.8]}]};
        let config = ReplayConfig {
            start_ms: 24 * HOUR,
            end_ms: 96 * HOUR,
            ..Default::default()
        };
        let parameters = ml_optimization::candidate_grid()[..3].to_vec();
        assert_eq!(
            evaluate_grid(&source, &parameters, &config, 1).unwrap(),
            evaluate_grid(&source, &parameters, &config, 3).unwrap()
        );
    }
}
