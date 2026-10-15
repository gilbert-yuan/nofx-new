//! Export per-order flat fills from a frozen research snapshot.
//!
//! Reuses the shared `backtest::replay`, so fills reconcile with the aggregate
//! `closedTrades` / `net` produced by the same replay. Read-only: no database,
//! no exchange, and the final test split is refused.
use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use nofx_core::{backtest, campaign, iso, number, optimizer, research};
use serde_json::json;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Phase {
    Training,
    Validation,
}

#[derive(Parser)]
#[command(about = "导出逐笔订单明细用于订单层取证；仅训练/验证分段")]
struct Args {
    #[arg(long, default_value = "output/monthly-enabled")]
    research: PathBuf,
    #[arg(long, required = true)]
    symbol: Vec<String>,
    #[arg(long, required = true)]
    strategy: Vec<String>,
    #[arg(long, value_enum, default_value = "training")]
    phase: Phase,
    /// A fresh directory; existing results are never overwritten.
    #[arg(long)]
    output: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let manifest = campaign::read_json(&args.research.join("manifest.json"))?;
    if args.output.exists() {
        bail!("输出目录已存在，请为本次导出指定新目录");
    }
    for symbol in &args.symbol {
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
        bail!("共享成本模型已变化，不能按此快照导出");
    }
    // Single-threaded. Reproduce the saved public guard settings.
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
    let (start, end) = match args.phase {
        Phase::Training => (split.train_start, split.train_end),
        Phase::Validation => (split.train_end, split.validation_end),
    };
    let metadata = json!({
        "source":args.research,
        "sourceEngineVersion":manifest["engineVersion"],
        "engineVersion":campaign::engine_version(),
        "phase":format!("{:?}",args.phase),
        "startTime":iso(start),"endTime":iso(end),
        "symbols":args.symbol,"strategies":args.strategy,
        "costs":research::costs(),"researchOnly":true,"holdoutAccessed":false
    });
    campaign::write_json(&args.output.join("manifest.json"), &metadata)?;
    let mut all = Vec::new();
    for symbol in &args.symbol {
        let history: backtest::History = serde_json::from_value(campaign::read_json(
            &args.research.join("data").join(format!("{symbol}.json")),
        )?)?;
        for id in &args.strategy {
            let params = &manifest["strategies"][id]["params"];
            println!("导出 {symbol}/{id} {} → {}", iso(start), iso(end));
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
            let fills = result["orderFills"].clone();
            let closed = fills.as_array().map(Vec::len).unwrap_or(0);
            let sum: f64 = fills
                .as_array()
                .map(|rows| rows.iter().map(|r| number(&r["net"], 0.)).sum())
                .unwrap_or(0.);
            campaign::write_json(
                &args.output.join(format!("{id}-{symbol}.json")),
                &json!({
                    "symbol":symbol,"strategyId":id,"params":params,
                    "closedTrades":result["closedTrades"],"net":result["net"],
                    "returnPct":result["returnPct"],"winRatePct":result["winRatePct"],
                    "maxDrawdownPct":result["maxDrawdownPct"],"blocked":result["blocked"],
                    "fillsNetSum":sum,"fills":fills
                }),
            )?;
            if let Some(rows) = fills.as_array() {
                for row in rows {
                    let mut tagged = row.clone();
                    tagged["symbol"] = json!(symbol);
                    tagged["strategyId"] = json!(id);
                    all.push(tagged);
                }
            }
            println!("  已平仓 {closed}，逐笔净额合计 {sum:.4} U");
        }
    }
    campaign::write_json(
        &args.output.join("order-fills.json"),
        &json!({"count":all.len(),"fills":all}),
    )?;
    println!("合计导出 {} 笔逐笔订单", all.len());
    Ok(())
}
