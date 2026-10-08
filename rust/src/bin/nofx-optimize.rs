//! Offline adaptive search over strategy parameters. Reuses the production
//! replay, costs, and entry/exit engine; never invents a second backtest.
use anyhow::{Context, Result, bail};
use clap::Parser;
use nofx_core::{
    backtest, db::Db, exchange::valid_symbol, iso, number, optimizer, store::Store, strategies,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Parser, Debug)]
#[command(
    version,
    about = "持续优化策略指标参数（默认增强趋势 v1，可换任意已注册策略）"
)]
struct Args {
    /// 项目根目录，含 .env / data / configs。
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// campaign JSON。默认 configs/crypto-backtest.campaign.json。
    #[arg(long)]
    campaign: Option<PathBuf>,
    /// 策略 ID。可多次传入；默认 enhanced-trend-v1。
    #[arg(long)]
    strategy: Vec<String>,
    /// 币种，逗号分隔。默认 BTCUSDT。
    #[arg(long, default_value = "BTCUSDT")]
    symbols: String,
    /// 加入 schema 指标周期（均线/MACD/RSI 等）到搜索维。默认开启。
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    indicators: bool,
    /// 覆盖训练轮数。
    #[arg(long)]
    rounds: Option<u32>,
    /// 覆盖每轮试验数。
    #[arg(long)]
    trials: Option<u32>,
    /// 覆盖随机种子。
    #[arg(long)]
    seed: Option<u64>,
    /// 覆盖输出目录。
    #[arg(long)]
    output: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let root = args.root.canonicalize().context("无法读取项目根目录")?;
    let _ = dotenvy::from_path(root.join(".env"));
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nofx_core=info,nofx_rust=info".into()),
        )
        .init();

    let campaign_path = args
        .campaign
        .unwrap_or_else(|| root.join("configs").join("crypto-backtest.campaign.json"));
    let campaign: Value = serde_json::from_str(
        &fs::read_to_string(&campaign_path)
            .with_context(|| format!("无法读取 {}", campaign_path.display()))?,
    )?;
    let campaign = optimizer::load_campaign(&campaign)?;
    let mut opt = campaign["optimization"].clone();
    if let Some(n) = args.rounds {
        opt["maxRounds"] = json!(n);
    }
    if let Some(n) = args.trials {
        opt["trialsPerRound"] = json!(n);
    }
    if let Some(n) = args.seed {
        opt["seed"] = json!(n);
    }

    let ids = if args.strategy.is_empty() {
        vec!["enhanced-trend-v1".to_owned()]
    } else {
        args.strategy.clone()
    };
    for id in &ids {
        strategies::definition(id).with_context(|| format!("未知策略：{id}"))?;
    }

    let symbols: Vec<String> = args
        .symbols
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|s| s.trim().to_uppercase())
        .collect();
    if symbols.is_empty() {
        bail!("至少指定一个币种");
    }
    for symbol in &symbols {
        valid_symbol(symbol)?;
    }

    let (from, to, warmup) = optimizer::period_bounds(&campaign)?;
    let split = optimizer::split_range(from, to, &opt)?;
    let initial = optimizer::initial_balance(&campaign);
    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into());
    let store = Store::new(root.join(data_dir)).await?;
    let fallback = store.read("config").await.unwrap_or_else(|_| json!({}));
    let config = optimizer::execution_config(&campaign, &fallback);
    let adaptive = json!({});
    let db = Db::connect().await?;

    let out_dir = args.output.unwrap_or_else(|| {
        campaign["output"]["directory"]
            .as_str()
            .map(|s| {
                let p = PathBuf::from(s);
                if p.is_absolute() { p } else { root.join(p) }
            })
            .unwrap_or_else(|| root.join("output").join("strategy-optimize"))
    });
    fs::create_dir_all(&out_dir)?;

    let mut reports = vec![];
    for id in &ids {
        let spec = optimizer::search_spec(id, &campaign, args.indicators)?;
        println!(
            "策略 {id}：{} 个搜索维 {}",
            spec.dims.len(),
            spec.dims
                .iter()
                .map(|d| d.key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        for symbol in &symbols {
            let load_from = optimizer::warmup_start(from, warmup, id);
            println!("加载 {symbol}/{id}  {} → {}", iso(load_from), iso(to));
            let history = backtest::load_history(&db, symbol, id, load_from, to).await?;
            let report = tokio::task::spawn_blocking({
                let symbol = symbol.clone();
                let spec = spec.clone();
                let config = config.clone();
                let adaptive = adaptive.clone();
                let opt = opt.clone();
                move || {
                    optimizer::optimize_symbol(
                        &symbol, &spec, &history, &config, &adaptive, &split, &opt, initial,
                    )
                }
            })
            .await??;
            let path = write_report(&out_dir, &report)?;
            println!(
                "{symbol}/{id} 训练收益 {:.2}% 回撤 {:.2}% 成交 {} → 测试收益 {}  写入 {}",
                number(&report["best"]["training"]["returnPct"], 0.),
                number(&report["best"]["training"]["maxDrawdownPct"], 0.),
                report["best"]["training"]["closedTrades"],
                report["holdout"]["returnPct"],
                path.display()
            );
            reports.push(report);
        }
    }

    let summary = json!({
        "at":iso(nofx_core::now_ms()),
        "campaign":campaign_path.display().to_string(),
        "strategies":ids,
        "symbols":symbols,
        "split":{
            "trainStart":iso(split.train_start),
            "trainEnd":iso(split.train_end),
            "validationEnd":iso(split.validation_end),
            "testEnd":iso(split.test_end)
        },
        "indicators":args.indicators,
        "reports":reports.iter().map(|r|json!({
            "symbol":r["symbol"],
            "strategyId":r["strategyId"],
            "bestParams":optimizer::summarize_params(&r["best"]["params"], &search_dims_from_report(r)),
            "trainReturnPct":r["best"]["training"]["returnPct"],
            "trainDrawdownPct":r["best"]["training"]["maxDrawdownPct"],
            "validationReturnPct":r["best"]["validation"]["returnPct"],
            "holdoutReturnPct":r["holdout"]["returnPct"],
            "closedTrades":r["best"]["training"]["closedTrades"],
            "score":r["best"]["score"]
        })).collect::<Vec<_>>()
    });
    let summary_path = out_dir.join("summary.json");
    fs::write(
        &summary_path,
        format!("{}\n", serde_json::to_string_pretty(&summary)?),
    )?;
    println!("汇总 {}", summary_path.display());
    Ok(())
}

fn search_dims_from_report(report: &Value) -> Vec<optimizer::SearchDim> {
    report["dims"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            Some(optimizer::SearchDim {
                key: d["key"].as_str()?.to_owned(),
                values: d["values"].as_array()?.clone(),
            })
        })
        .collect()
}

fn write_report(dir: &Path, report: &Value) -> Result<PathBuf> {
    let name = format!(
        "{}-{}.json",
        report["strategyId"].as_str().unwrap_or("strategy"),
        report["symbol"].as_str().unwrap_or("symbol")
    );
    let path = dir.join(name);
    fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(report)?),
    )?;
    Ok(path)
}
