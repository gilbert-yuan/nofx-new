use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{fs, sync::Mutex};

#[derive(Clone)]
pub struct Store {
    pub dir: PathBuf,
    lock: Arc<Mutex<()>>,
}
impl Store {
    pub async fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir).await?;
        let this = Self {
            dir,
            lock: Arc::new(Mutex::new(())),
        };
        for (name, value) in [
            ("config", default_config()),
            ("strategy", default_strategy()),
            (
                "state",
                json!({"running":false,"lastRunAt":null,"lastError":"","decisions":[]}),
            ),
            (
                "strategies",
                json!({"version":2,"initialized":false,"strategies":{},"updatedAt":null}),
            ),
        ] {
            if !this.path(name).exists() {
                this.write(name, &value).await?;
            }
        }
        Ok(this)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(format!("{name}.json"))
    }
    pub async fn read(&self, name: &str) -> Result<Value> {
        read_json(&self.path(name)).await
    }
    pub async fn write(&self, name: &str, value: &Value) -> Result<()> {
        let _guard = self.lock.lock().await;
        write_json(&self.path(name), value).await
    }
    pub async fn update<F>(&self, name: &str, f: F) -> Result<Value>
    where
        F: FnOnce(&mut Value) -> Result<()>,
    {
        let _guard = self.lock.lock().await;
        let mut value = read_json(&self.path(name)).await?;
        f(&mut value)?;
        write_json(&self.path(name), &value).await?;
        Ok(value)
    }
}
async fn read_json(path: &Path) -> Result<Value> {
    let data = fs::read_to_string(path)
        .await
        .with_context(|| format!("Cannot read {}", path.display()))?;
    serde_json::from_str(data.trim_start_matches('\u{feff}'))
        .with_context(|| format!("Invalid JSON in {}", path.display()))
}
async fn write_json(path: &Path, value: &Value) -> Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let bytes = format!("{}\n", serde_json::to_string_pretty(value)?);
    fs::write(&tmp, bytes).await?;
    // Windows rename replaces regular files atomically through MoveFileEx.
    fs::rename(&tmp, path)
        .await
        .with_context(|| format!("Cannot replace {}", path.display()))?;
    Ok(())
}
pub fn default_config() -> Value {
    json!({
        "binance":{"apiKey":"","secretKey":"","demoApiKey":"","demoSecretKey":"","liveApiKey":"","liveSecretKey":"","demo":true,"testnet":true},
        "okx":{"apiKey":"","secretKey":"","passphrase":"","demo":true,"tdMode":"isolated"},
        "model":{"enabled":false,"apiKey":"","baseUrl":"https://api.openai.com/v1","model":"gpt-4o-mini","maxConcurrentRequests":5},
        "trader":{"exchange":"binance","enabled":false,"dryRun":true,"scanIntervalSeconds":900,"quoteAsset":"USDT","maxLeverage":5,"maxPositionNotionalPct":0.25,"maxTotalNotionalPct":1.25,"minOrderMargin":5,"minConfidence":0.45,"allowEntryOrders":false,"allowCloseOrders":false,"allowProtectionUpdates":true,"syncPaperOrdersToDemo":false,"syncPaperOrdersToLive":false,"entrySymbolsText":"","maxNewEntriesPerCycle":1,"maxPositionsToReview":10,"minProtectionMoveBps":25},
        "marketSync":{"enabled":true,"symbolsText":"ALL","interval":"15m","intervalSeconds":60,"limit":80},
        "tradeSync":{"enabled":false,"symbolsText":"BTCUSDT, ETHUSDT","intervalSeconds":300,"limit":500,"initialLookbackDays":30},"analysis":{"engine":"local"}
    })
}
pub fn default_strategy() -> Value {
    json!({"name":"Binance USDT perpetual contracts, 15-minute research","symbols":["ALL"],"interval":"15m","klineLimit":80,"systemPrompt":"You are a cautious crypto futures market analyst. Analyze every symbol independently and return strict JSON only. This is research, not an order.","rules":"Use the configured candle interval and supplied OHLCV data. Give BUY, SELL, or HOLD research suggestions with confidence, reasons, risks, and invalidation conditions. Prefer HOLD when evidence is weak. Never promise returns."})
}
pub fn merge(current: &Value, patch: &Value) -> Value {
    let mut next = current.clone();
    if let Some(obj) = patch.as_object() {
        for (key, value) in obj {
            if let Some(fields) = value.as_object() {
                if !next[key].is_object() {
                    next[key] = json!({});
                }
                for (name, v) in fields {
                    let secret = matches!(
                        name.as_str(),
                        "apiKey"
                            | "secretKey"
                            | "demoApiKey"
                            | "demoSecretKey"
                            | "liveApiKey"
                            | "liveSecretKey"
                            | "passphrase"
                    );
                    if secret
                        && v.as_str()
                            .is_some_and(|s| s.contains("...") || s == "********")
                    {
                        continue;
                    }
                    next[key][name] = v.clone();
                }
            } else {
                next[key] = value.clone();
            }
        }
    }
    let b = if patch["binance"].get("demo").is_some() || patch["binance"].get("testnet").is_some() {
        &patch["binance"]
    } else {
        &next["binance"]
    };
    let demo = b
        .get("demo")
        .map(|v| v == true)
        .unwrap_or(b["testnet"] != false);
    next["binance"]["demo"] = json!(demo);
    next["binance"]["testnet"] = json!(demo);
    next["model"]["maxConcurrentRequests"] = json!(
        crate::number(&next["model"]["maxConcurrentRequests"], 5.)
            .floor()
            .clamp(1., 20.)
    );
    next
}
pub fn masked(config: &Value) -> Value {
    let mut v = config.clone();
    for section in ["binance", "okx", "model"] {
        for key in [
            "apiKey",
            "secretKey",
            "demoApiKey",
            "demoSecretKey",
            "liveApiKey",
            "liveSecretKey",
            "passphrase",
        ] {
            if let Some(s) = config[section][key].as_str() {
                let chars: Vec<char> = s.chars().collect();
                v[section][key] = json!(if chars.is_empty() {
                    String::new()
                } else if s.contains("...") {
                    s.to_owned()
                } else if chars.len() <= 8 {
                    "********".to_owned()
                } else {
                    format!(
                        "{}...{}",
                        chars[..4].iter().collect::<String>(),
                        chars[chars.len() - 4..].iter().collect::<String>()
                    )
                });
            }
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_and_environment_survive_patch() {
        let mut c = default_config();
        c["binance"]["apiKey"] = json!("a-secret-value");
        let n = merge(
            &c,
            &json!({"binance":{"apiKey":"a-se...alue","testnet":false}}),
        );
        assert_eq!(n["binance"]["apiKey"], "a-secret-value");
        assert_eq!(n["binance"]["demo"], false);
        assert_ne!(masked(&n)["binance"]["apiKey"], n["binance"]["apiKey"]);
    }
    #[tokio::test]
    async fn updates_are_serialized() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_owned()).await.unwrap();
        let mut tasks = vec![];
        for _ in 0..20 {
            let s = store.clone();
            tasks.push(tokio::spawn(async move {
                s.update("state", |v| {
                    v["count"] = json!(v["count"].as_u64().unwrap_or(0) + 1);
                    Ok(())
                })
                .await
                .unwrap();
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(store.read("state").await.unwrap()["count"], 20);
    }
}
