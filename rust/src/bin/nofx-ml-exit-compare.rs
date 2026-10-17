//! Offline comparison of the previous 0-bar MA exit against the short-horizon
//! ML snapshot. Frozen monthly predictions and the shared paper engine only.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    iso,
    ml_lightgbm::DEFAULT_RUNTIME_PATH,
    ml_optimization::{self, StrategyParameters},
    ml_optimization_data::DataLoader,
    ml_optimization_metrics::{Aggregate, profitable_upgrade},
    ml_replay::ReplayConfig,
    strategies,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};

const HOUR: i64 = 3_600_000;

#[derive(Parser)]
#[command(about = "Compare legacy 0-bar MA exits with short-horizon ML exits on frozen signals")]
struct Args {
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
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long, default_value_t = 50)]
    min_trades: usize,
    #[arg(long, default_value_t = 10)]
    min_symbols: usize,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
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
    write_new(path, &serde_json::to_vec_pretty(value)?)
}

fn reasons(replay: &Value) -> Result<Value> {
    let mut counts = serde_json::Map::new();
    let mut nets = serde_json::Map::new();
    for order in replay["orders"]
        .as_array()
        .context("Missing orders")?
        .iter()
        .filter(|order| order["status"] == "closed")
    {
        let reason = order["reason"].as_str().unwrap_or("unknown").to_owned();
        let count = counts.get(&reason).and_then(Value::as_u64).unwrap_or(0) + 1;
        counts.insert(reason.clone(), json!(count));
        let net = order["net"].as_f64().unwrap_or(0.);
        let total = nets.get(&reason).and_then(Value::as_f64).unwrap_or(0.) + net;
        nets.insert(reason, json!(total));
    }
    Ok(json!({"count":counts,"net_usdt":nets}))
}

fn evaluate(
    source: &ml_optimization::SymbolData,
    parameters: &StrategyParameters,
    config: &ReplayConfig,
    exits: &Value,
) -> Result<Value> {
    let mut replay = ml_optimization::evaluate_with_exits(source, parameters, config, exits)?;
    replay["exit_reason_summary"] = reasons(&replay)?;
    Ok(replay)
}

fn add_reasons(total: &mut Value, replay: &Value) {
    let summary = &replay["exit_reason_summary"];
    for key in ["count", "net_usdt"] {
        let Some(map) = summary[key].as_object() else {
            continue;
        };
        for (reason, value) in map {
            let current = total[key][reason].as_f64().unwrap_or(0.);
            total[key][reason] = json!(current + value.as_f64().unwrap_or(0.));
        }
    }
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
    let cache = args
        .cache_dir
        .clone()
        .unwrap_or_else(|| args.data_dir.join("feature-cache-v3"));
    let mut data = DataLoader::open(&args.model_dir, &args.data_dir, &cache, &args.runtime)?;
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
    ensure!(!symbols.is_empty(), "Empty comparison universe");
    let start = data.manifest().split.validation_end_ms;
    let end = data.manifest().split.test_end_ms;
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
    let parameters = StrategyParameters::default();
    let legacy_exits = strategies::exit_rules_for(&json!({}));
    let horizon_exits = strategies::ml_horizon_exit_rules();
    let identity = json!({
        "schema_version":1,"tool":"nofx-ml-exit-compare","created_at_ms":nofx_core::now_ms(),
        "model_manifest_sha256":digest(&fs::read(args.model_dir.join("manifest.json"))?),
        "data_manifest_sha256":digest(&fs::read(args.data_dir.join("manifest.json"))?),
        "software_sha256":digest(concat!(include_str!("nofx-ml-exit-compare.rs"),include_str!("../ml_optimization.rs"),include_str!("../ml_replay.rs"),include_str!("../strategies.rs"),include_str!("../simulator.rs"),include_str!("../paper.rs")).as_bytes()),
        "executable_sha256":digest(&fs::read(std::env::current_exe()?)?),
        "lightgbm_runtime_sha256":data.provenance()["lightgbm_runtime_sha256"],
        "symbols":symbols,"parameters":parameters,"development":development,"confirmation":confirmation,
        "legacy_exit_rules":legacy_exits,"horizon_exit_rules":horizon_exits,
        "costs":nofx_core::research::costs(),"min_trades":args.min_trades,"min_symbols":args.min_symbols,
        "scope":"Independent 1000 USDT accounts per symbol; frozen 6-hour signals; not a shared Demo portfolio",
        "prior_test_already_observed":true,"runtime_modified":false,"deployment_approved":false,"real_trading_enabled":false
    });
    fs::create_dir(&args.output_dir)?;
    write_json(&args.output_dir.join("run-config.json"), &identity)?;
    let mut development_legacy = Aggregate::default();
    let mut development_horizon = Aggregate::default();
    let mut confirmation_legacy = Aggregate::default();
    let mut confirmation_horizon = Aggregate::default();
    let mut development_legacy_reasons = json!({"count":{},"net_usdt":{}});
    let mut development_horizon_reasons = json!({"count":{},"net_usdt":{}});
    let mut confirmation_legacy_reasons = json!({"count":{},"net_usdt":{}});
    let mut confirmation_horizon_reasons = json!({"count":{},"net_usdt":{}});
    let mut per_symbol = Vec::with_capacity(symbols.len());
    for (number, symbol) in symbols.iter().enumerate() {
        let source = data.load(symbol)?;
        let d_legacy = evaluate(&source, &parameters, &development, &legacy_exits)?;
        let d_horizon = evaluate(&source, &parameters, &development, &horizon_exits)?;
        let c_legacy = evaluate(&source, &parameters, &confirmation, &legacy_exits)?;
        let c_horizon = evaluate(&source, &parameters, &confirmation, &horizon_exits)?;
        development_legacy.add(&d_legacy)?;
        development_horizon.add(&d_horizon)?;
        confirmation_legacy.add(&c_legacy)?;
        confirmation_horizon.add(&c_horizon)?;
        add_reasons(&mut development_legacy_reasons, &d_legacy);
        add_reasons(&mut development_horizon_reasons, &d_horizon);
        add_reasons(&mut confirmation_legacy_reasons, &c_legacy);
        add_reasons(&mut confirmation_horizon_reasons, &c_horizon);
        per_symbol.push(json!({
            "symbol":symbol,
            "development":{"legacy":d_legacy["metrics"],"horizon":d_horizon["metrics"]},
            "confirmation":{"legacy":c_legacy["metrics"],"horizon":c_horizon["metrics"]}
        }));
        if (number + 1) % 25 == 0 || number + 1 == symbols.len() {
            println!(
                "{}",
                json!({"stage":"exit_compare","completed":number+1,"symbols":symbols.len(),"elapsed_seconds":began.elapsed().as_secs_f64()})
            );
        }
    }
    let development_pass = profitable_upgrade(
        &development_horizon,
        &development_legacy,
        args.min_trades,
        args.min_symbols,
    );
    let confirmation_pass = profitable_upgrade(
        &confirmation_horizon,
        &confirmation_legacy,
        args.min_trades,
        args.min_symbols,
    );
    let report = json!({
        "schema_version":1,"status":"completed","created_at_ms":nofx_core::now_ms(),
        "run_config_sha256":digest(&serde_json::to_vec(&identity)?),
        "parameters":parameters,"development_legacy":development_legacy,"development_horizon":development_horizon,
        "confirmation_legacy":confirmation_legacy,"confirmation_horizon":confirmation_horizon,
        "development_legacy_exits":development_legacy_reasons,"development_horizon_exits":development_horizon_reasons,
        "confirmation_legacy_exits":confirmation_legacy_reasons,"confirmation_horizon_exits":confirmation_horizon_reasons,
        "development_profitable_upgrade":development_pass,"confirmation_profitable_upgrade":confirmation_pass,
        "historical_profitable_upgrade":development_pass && confirmation_pass,
        "symbols":per_symbol,"provenance":data.provenance(),
        "prior_test_already_observed":true,"orders_enabled":false,"deployment_approved":false,
        "runtime_modified":false,"real_trading_enabled":false,
        "limitations":[
            "Both windows are previously observed monthly-test history, not a new blind test.",
            "Net PnL is the sum of independent 1000-USDT symbol accounts, not shared Demo capital.",
            "Signals use the frozen six-hour stride; production can observe hourly origins.",
            "A reduction in losses is not a profitable upgrade; promotion still requires positive net PnL."
        ]
    });
    let markdown = format!(
        "# Chronos + LightGBM 短持仓出场对照\n\n冻结现役月度分类模型与默认门槛（概率 0.45 / 差值 0.05 / 止损 2 ATR / 止盈 5 ATR / 持有 11 根）。对照仅改变出场快照：旧规则继承增强趋势 0 根均线智能退出；新规则关闭该均线退出，保留分批止盈与移动止损。\n\n开发段 {} 至 {} UTC；确认段 {} 至 {} UTC。金额为每币独立 1,000 USDT 账户合计，已计入共享引擎成本。\n\n| 窗口 | 旧出场净收益 USDT | 新出场净收益 USDT | 旧平仓 | 新平仓 |\n| --- | ---: | ---: | ---: | ---: |\n| 开发 | {:.6} | {:.6} | {} | {} |\n| 确认 | {:.6} | {:.6} | {} | {} |\n\n开发段盈利升级：{development_pass}。确认段盈利升级：{confirmation_pass}。历史盈利升级：{}。减亏不等于盈利；零交易不作为盈利证据。未自动部署。\n",
        iso(start),
        iso(middle),
        iso(middle),
        iso(end),
        development_legacy.net_pnl_usdt,
        development_horizon.net_pnl_usdt,
        development_legacy.closed_trades,
        development_horizon.closed_trades,
        confirmation_legacy.net_pnl_usdt,
        confirmation_horizon.net_pnl_usdt,
        confirmation_legacy.closed_trades,
        confirmation_horizon.closed_trades,
        development_pass && confirmation_pass
    );
    write_new(&args.output_dir.join("report.md"), markdown.as_bytes())?;
    write_json(&args.output_dir.join("report.json"), &report)?;
    println!(
        "{}",
        json!({"stage":"completed","development_legacy_net_usdt":development_legacy.net_pnl_usdt,
            "development_horizon_net_usdt":development_horizon.net_pnl_usdt,
            "confirmation_legacy_net_usdt":confirmation_legacy.net_pnl_usdt,
            "confirmation_horizon_net_usdt":confirmation_horizon.net_pnl_usdt,
            "historical_profitable_upgrade":development_pass && confirmation_pass,
            "elapsed_seconds":began.elapsed().as_secs_f64(),"runtime_modified":false})
    );
    Ok(())
}
