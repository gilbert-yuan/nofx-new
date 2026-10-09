//! Compare engine revisions against a frozen research snapshot, without a DB or exchange.
use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use nofx_core::{backtest, campaign, exchange::valid_symbol, iso, number, optimizer, research};
use serde_json::json;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Phase {
    Training,
    Validation,
}

#[derive(Parser)]
#[command(about = "用冻结月度数据复核策略代码；仅训练/验证，不访问最终测试区间")]
struct Args {
    #[arg(long, default_value = "output/monthly-enabled")]
    research: PathBuf,
    #[arg(long, required = true)]
    symbol: Vec<String>,
    #[arg(long, required = true)]
    strategy: Vec<String>,
    #[arg(long, value_enum, default_value = "validation")]
    phase: Phase,
    /// Optionally replay only the last N hours of the chosen split.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    hours: Option<u32>,
    /// A fresh directory; existing results are never overwritten.
    #[arg(long)]
    output: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let manifest = campaign::read_json(&args.research.join("manifest.json"))?;
    if args.output.exists() {
        bail!("输出目录已存在，请为本次对照指定新目录");
    }
    for symbol in &args.symbol {
        valid_symbol(symbol)?;
        if !manifest["symbols"]
            .as_array()
            .is_some_and(|s| s.contains(&json!(symbol)))
        {
            bail!("{symbol} 不在冻结研究中");
        }
    }
    for id in &args.strategy {
        if !manifest["strategies"][id]["params"].is_object() {
            bail!("{id} 不在冻结研究中");
        }
    }
    if manifest["costs"] != research::costs() {
        bail!("共享成本模型已变化，不能按此快照对照");
    }
    // This executable is single-threaded. Reproduce the saved public guard settings.
    for (key, _) in campaign::environment_snapshot() {
        unsafe { std::env::remove_var(key) };
    }
    for (key, value) in manifest["environment"]
        .as_object()
        .context("缺少风控环境快照")?
    {
        if key.starts_with("NOFX_") {
            unsafe {
                std::env::set_var(key, value.as_str().context("环境值必须为字符串")?)
            };
        }
    }
    let split = optimizer::split_range(
        manifest["startTime"].as_i64().context("缺少开始时间")?,
        manifest["endTime"].as_i64().context("缺少结束时间")?,
        &manifest["settings"]["optimization"],
    )?;
    let (mut start, end) = match args.phase {
        Phase::Training => (split.train_start, split.train_end),
        Phase::Validation => (split.train_end, split.validation_end),
    };
    if let Some(hours) = args.hours {
        start = start.max(end - i64::from(hours) * 3_600_000);
    }
    let metadata = json!({
        "source":args.research, "sourceEngineVersion":manifest["engineVersion"],
        "engineVersion":campaign::engine_version(), "phase":format!("{:?}",args.phase),
        "startTime":iso(start), "endTime":iso(end), "hours":args.hours,
        "symbols":args.symbol, "strategies":args.strategy,
        "config":manifest["config"], "environment":manifest["environment"],
        "costs":research::costs(), "researchOnly":true, "holdoutAccessed":false
    });
    campaign::write_json(&args.output.join("manifest.json"), &metadata)?;
    for symbol in &args.symbol {
        let history: backtest::History = serde_json::from_value(campaign::read_json(
            &args.research.join("data").join(format!("{symbol}.json")),
        )?)?;
        for id in &args.strategy {
            let params = &manifest["strategies"][id]["params"];
            println!("回放 {symbol}/{id} {} → {}", iso(start), iso(end));
            let result = backtest::replay(
                symbol,
                id,
                params,
                &history.datasets,
                &history.samples,
                &manifest["config"],
                start,
                end,
                number(&manifest["settings"]["initialBalance"], 10000.),
                &manifest["adaptive"],
            )?;
            campaign::write_json(
                &args.output.join(format!("{id}-{symbol}.json")),
                &json!({"symbol":symbol,"strategyId":id,"params":params,"result":result}),
            )?;
            println!(
                "已平仓 {}，收益 {}%，最大回撤 {}%",
                result["closedTrades"], result["returnPct"], result["maxDrawdownPct"]
            );
        }
    }
    Ok(())
}
