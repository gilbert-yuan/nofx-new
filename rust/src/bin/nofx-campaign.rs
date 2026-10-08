use anyhow::{Context, Result};
use clap::Parser;
use nofx_core::campaign;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "最近一个月全部启用策略：公共历史补齐、跨币种搜索与断点续跑")]
struct Args {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "configs/monthly-enabled.campaign.json")]
    campaign: PathBuf,
    #[arg(long, default_value = "output/monthly-enabled")]
    output: PathBuf,
    /// 完成 N 个策略/参数/币种试验后退出；0 表示持续完成队列。
    #[arg(long, default_value_t = 0)]
    max_units: usize,
    /// 处理队列后继续守候，失败的数据会在下一轮重试。
    #[arg(long)]
    watch: bool,
    /// 只读取本地状态与汇总，不连接数据库或请求行情。
    #[arg(long)]
    status: bool,
    /// 打印当前可执行文件的回放版本摘要，不连接数据库。
    #[arg(long)]
    engine_version: bool,
}
fn main() -> Result<()> {
    let args = Args::parse();
    if args.engine_version {
        println!("{}", campaign::engine_version());
        return Ok(());
    }
    let root = args.root.canonicalize()?;
    let output = if args.output.is_absolute() {
        args.output.clone()
    } else {
        root.join(&args.output)
    };
    if args.status {
        for name in ["status.json", "summary.json"] {
            let path = output.join(name);
            if path.exists() {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&campaign::read_json(&path)?)?
                );
            }
        }
        return Ok(());
    }
    let _ = dotenvy::from_path(root.join(".env"));
    // Apply the same public proxy and NOFX execution guards before Tokio starts threads.
    let ecosystem: Value = campaign::read_json(&root.join("ecosystem.config.json"))?;
    if let Some(env) = ecosystem["apps"][0]["env"].as_object() {
        for (key, value) in env {
            if key.starts_with("NOFX_") || ["HTTP_PROXY", "HTTPS_PROXY"].contains(&key.as_str()) {
                let value = value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string());
                // SAFETY: main is single-threaded and no runtime/workers exist yet.
                unsafe {
                    std::env::set_var(key, value);
                }
            }
        }
    }
    tracing_subscriber::fmt()
        .with_env_filter("nofx_core=warn")
        .init();
    let settings = campaign::read_json(&if args.campaign.is_absolute() {
        args.campaign
    } else {
        root.join(args.campaign)
    })?;
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .context("无法创建 Rust runtime")?
        .block_on(campaign::run(
            &root,
            &output,
            &settings,
            args.max_units,
            args.watch,
        ))
}
