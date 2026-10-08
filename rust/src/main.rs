use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(version, about = "NOFX native Rust API server")]
struct Args {
    /// Project root containing .env, data/ and dist/.
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long)]
    host: Option<String>,
    #[arg(long)]
    port: Option<u16>,
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
    let host = args
        .host
        .or_else(|| std::env::var("HOST").ok())
        .unwrap_or_else(|| "127.0.0.1".to_owned());
    let port = args
        .port
        .or_else(|| std::env::var("PORT").ok().and_then(|v| v.parse().ok()))
        .unwrap_or(3100);
    nofx_core::api::serve(root, host, port).await
}
