//! Read-only replacement for the former Node HTTP/PM2 diagnostic scripts.
use anyhow::{Context, Result, bail};
use clap::Parser;
use nofx_core::exchange::{Exchange, is_demo};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

#[derive(Parser)]
#[command(version, about = "Read-only NOFX runtime diagnostics")]
struct Args {
    #[arg(long, default_value = ".")]
    root: PathBuf,
    #[arg(long, default_value = "http://127.0.0.1:3100")]
    base: String,
    /// Include the saved PM2 dump; this is a snapshot, not live process status.
    #[arg(long)]
    pm2: bool,
}

fn select(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| ((*key).to_owned(), value[*key].clone()))
            .collect(),
    )
}

fn config_summary(config: &Value) -> Result<Value> {
    Ok(json!({
        "environment":if is_demo(&config["binance"]){"demo"}else{"live"},
        "credentialsPresent":{
            "demo":Exchange::new(config,"demo")?.credentials(),
            "live":Exchange::new(config,"live")?.credentials()
        },
        "marketSync":select(&config["marketSync"],&["enabled","dataOnly","interval","intervalSeconds","symbolsText","limit"]),
        "trader":select(&config["trader"],&["enabled","dryRun","allowEntryOrders","allowCloseOrders","syncPaperOrdersToDemo","syncPaperOrdersToLive","maxLeverage","minOrderMargin"]),
        "analysis":select(&config["analysis"],&["engine"])
    }))
}

fn automation_summary(status: &Value) -> Value {
    let mut tasks = json!({});
    for kind in ["klineSync", "positionReview"] {
        let task = &status["tasks"][kind];
        tasks[kind] = select(
            task,
            &[
                "enabled", "running", "interval", "lastRun", "error", "progress",
            ],
        );
        tasks[kind]["summary"] = select(
            &task["summary"],
            &[
                "dataOnly",
                "reportsOnly",
                "analyzed",
                "eligible",
                "submitted",
                "failed",
            ],
        );
        tasks[kind]["summary"]["sync"] = select(
            &task["summary"]["sync"],
            &["total", "completed", "failed", "intervals"],
        );
    }
    json!({
        "active":status["active"],"uptime":status["uptime"],"tasks":tasks,
        "analysis":select(&status["analysisMeta"],&["phase","asOf","readOnly","symbols","marketReady","processedSymbols","enabledStrategies","analyzed","opportunityCount","failed","error","marketWarning"]),
        "stats":select(&status["stats"],&["totalAnalyzed","totalOrders","totalReviews"]),
        "account":select(&status["account"],&["equity","available","entriesPaused","syncReady","canOpen","accountingComplete","activityCounts","warnings"])
    })
}

fn pm2_summary(dump: &Value) -> Value {
    json!(
        dump.as_array()
            .into_iter()
            .flatten()
            .map(|entry| {
                let env = entry.get("pm2_env").unwrap_or(entry);
                json!({
                    "name":entry["name"],"savedStatus":env["status"],
                    "script":env["pm_exec_path"],"restarts":env["restart_time"],
                    "environment":select(env,&["PORT","NOFX_AUTOSTART","NOFX_MIN_TREND_SCORE","NOFX_LONG_ONLY","NOFX_AUTO_MARGIN_PCT","NOFX_KLINE_SYNC_CONCURRENCY"])
                })
            })
            .collect::<Vec<_>>()
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let paths: Value = serde_json::from_str(include_str!("../../../src/api/contract.json"))?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(15))
        .build()?;
    let mut report = json!({"checkedAt":nofx_core::iso(nofx_core::now_ms()),"base":args.base});
    let mut failed = false;
    let requests = [
        ("health", paths["health"].as_str().unwrap()),
        ("config", paths["config"]["get"].as_str().unwrap()),
        ("automation", "/api/automation/status"),
    ];
    let client = &client;
    let base = args.base.trim_end_matches('/');
    let results = futures::future::join_all(requests.iter().map(|&(name, path)| async move {
        let result = async {
            let value = client
                .get(format!("{base}{path}"))
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            Ok::<_, anyhow::Error>(match name {
                "config" => config_summary(&value)?,
                "automation" => automation_summary(&value),
                _ => select(&value, &["ok", "name", "runtime", "version"]),
            })
        }
        .await;
        (name, result)
    }))
    .await;
    for (name, result) in results {
        report[name] = match result {
            Ok(value) => json!({"ok":true,"data":value}),
            Err(error) => {
                failed = true;
                json!({"ok":false,"error":format!("{error:#}")})
            }
        };
    }
    if args.pm2 {
        let directory = std::env::var_os("PM2_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| args.root.join(".pm2"));
        let path = directory.join("dump.pm2");
        let dump: Value = serde_json::from_str(
            &std::fs::read_to_string(&path).context("Cannot read saved PM2 dump")?,
        )?;
        report["pm2Snapshot"] = json!({"path":path,"processes":pm2_summary(&dump)});
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    if failed {
        bail!("One or more read-only API checks failed; see the report above.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_exclude_credentials_and_full_account_history() {
        let config = json!({"binance":{"demo":true,"demoApiKey":"private-key","demoSecretKey":"private-secret"},"model":{"apiKey":"private-model-key"},"trader":{"syncPaperOrdersToDemo":false},"marketSync":{"dataOnly":true}});
        let summary = config_summary(&config).unwrap();
        assert_eq!(summary["credentialsPresent"]["demo"], true);
        assert_eq!(summary["credentialsPresent"]["live"], false);
        assert!(!summary.to_string().contains("private-"));
        let status = json!({"account":{"orders":[{"id":"private-history"}],"exchangeAccounts":{"demo":{"accountKey":"private-account"}},"syncReady":false,"canOpen":false}});
        let summary = automation_summary(&status);
        assert_eq!(summary["account"]["canOpen"], false);
        assert!(!summary.to_string().contains("private-"));
    }

    #[test]
    fn pm2_report_selects_runtime_knobs_without_dumping_environment() {
        let dump = json!([{"name":"nofx-api","pm2_env":{"status":"online","NOFX_LONG_ONLY":"true","DATABASE_URL":"private-database","API_KEY":"private-key"}}]);
        let summary = pm2_summary(&dump);
        assert_eq!(summary[0]["environment"]["NOFX_LONG_ONLY"], "true");
        assert_eq!(summary[0]["savedStatus"], "online");
        assert!(!summary.to_string().contains("private-"));
    }
}
