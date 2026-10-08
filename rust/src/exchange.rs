use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;
mod market_context;
mod rate_limit;

#[derive(Clone)]
pub struct Exchange {
    client: reqwest::Client,
    retry_client: reqwest::Client,
    budget: Arc<Mutex<rate_limit::Budget>>,
    base: String,
    key: String,
    secret: String,
    pub demo: bool,
    offset: Arc<Mutex<Option<i64>>>,
    market_cache: market_context::Cache,
}
impl Exchange {
    #[cfg(test)]
    pub(crate) fn test_endpoint(base: &str) -> Self {
        Self {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            retry_client: reqwest::Client::builder()
                .no_proxy()
                .pool_max_idle_per_host(0)
                .build()
                .unwrap(),
            base: base.into(),
            budget: Arc::new(Mutex::new(rate_limit::Budget::default())),
            key: "test-key".into(),
            secret: "test-secret".into(),
            demo: false,
            offset: Arc::new(Mutex::new(None)),
            market_cache: Default::default(),
        }
    }
    pub fn public() -> Result<Self> {
        Self::new(&json!({"binance":{"demo":false}}), "live")
    }
    pub fn new(config: &Value, environment: &str) -> Result<Self> {
        let b = &config["binance"];
        let demo = environment == "demo";
        let selected = is_demo(b) == demo;
        let credential = |name: &str| {
            let named = format!(
                "{environment}{}",
                if name == "apiKey" {
                    "ApiKey"
                } else {
                    "SecretKey"
                }
            );
            b[&named]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| if selected { b[name].as_str() } else { None })
                .unwrap_or("")
                .trim()
                .to_owned()
        };
        Ok(Self {
            client: http_client(true)?,
            retry_client: http_client(false)?,
            budget: rate_limit::shared(demo),
            base: futures_base(demo, std::env::var("BINANCE_FUTURES_BASE").ok().as_deref()),
            key: credential("apiKey"),
            secret: credential("secretKey"),
            demo,
            offset: Arc::new(Mutex::new(None)),
            market_cache: Default::default(),
        })
    }
    pub fn credentials(&self) -> bool {
        !self.key.is_empty() && !self.secret.is_empty()
    }
    pub async fn depth(&self, symbol: &str, levels: usize) -> Result<Value> {
        valid_symbol(symbol)?;
        let limit = [5_usize, 10, 20, 50, 100, 500, 1000]
            .into_iter()
            .find(|limit| *limit >= levels)
            .context("Binance 盘口最多支持 1000 档")?;
        self.public_request("/fapi/v1/depth", &json!({"symbol":symbol,"limit":limit}))
            .await
    }
    pub fn account_key(&self) -> String {
        hex::encode(Sha256::digest(self.key.as_bytes()))
    }
    pub async fn public_request(&self, path: &str, params: &Value) -> Result<Value> {
        let query = query_string(params);
        let url = format!(
            "{}{}{}{}",
            self.base,
            path,
            if query.is_empty() { "" } else { "?" },
            query
        );
        for attempt in 0..3 {
            loop {
                let delay = self
                    .budget
                    .lock()
                    .await
                    .reserve(path, params, crate::now_ms())?;
                if delay == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            }
            let sent = crate::now_ms();
            // Retry with a separate pool that cannot reuse an interrupted or stale connection.
            let request = if attempt == 0 {
                self.client.get(&url)
            } else {
                self.retry_client
                    .get(&url)
                    .header(reqwest::header::CONNECTION, "close")
            };
            let (result, retryable) = match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    let headers = response.headers().clone();
                    self.budget
                        .lock()
                        .await
                        .observe_headers(&headers, sent, crate::now_ms());
                    match response.text().await {
                        Ok(body) => {
                            self.budget.lock().await.observe_rejection(
                                status.as_u16(),
                                &headers,
                                &body,
                                crate::now_ms(),
                            );
                            let result = parse_response(status.as_u16(), &body);
                            let retryable = status.as_u16() == 429
                                || status.is_server_error()
                                || (status.is_success()
                                    && result.as_ref().is_err_and(|error| {
                                        error.downcast_ref::<serde_json::Error>().is_some()
                                    }));
                            (result, retryable)
                        }
                        Err(error) => {
                            self.budget.lock().await.observe_rejection(
                                status.as_u16(),
                                &headers,
                                "",
                                crate::now_ms(),
                            );
                            (
                                Err(anyhow::Error::new(error)
                                    .context(format!("读取 Binance 响应体失败 (HTTP {status})"))),
                                status.is_success()
                                    || status.as_u16() == 429
                                    || status.is_server_error(),
                            )
                        }
                    }
                }
                Err(error) => (Err(error.into()), true),
            };
            match result {
                Ok(data) => {
                    if attempt > 0 {
                        tracing::info!(%url, attempts = attempt + 1, "Public market request recovered after retry");
                    }
                    return Ok(data);
                }
                Err(error) if retryable && attempt < 2 => {
                    tracing::warn!(error = %format!("{error:#}"), %url, attempt = attempt + 1, "Retrying public market request");
                    tokio::time::sleep(Duration::from_millis(350_u64 << attempt)).await;
                }
                Err(error) => {
                    bail!(
                        "Binance public GET {url} failed after {} attempt(s): {error:#}",
                        attempt + 1
                    );
                }
            }
        }
        unreachable!()
    }
    pub async fn signed(&self, method: &str, path: &str, params: &Value) -> Result<Value> {
        if !self.credentials() {
            bail!("请先配置该环境的 Binance API Key / Secret Key。");
        }
        for attempt in 0..2 {
            let skew = self.server_offset(attempt > 0).await?;
            let mut fields = params.clone();
            fields["timestamp"] = json!(crate::now_ms() + skew);
            fields["recvWindow"] = json!(5000);
            let query = query_string(&fields);
            let signature = sign(&self.secret, &query);
            let url = format!("{}{}?{}&signature={}", self.base, path, query, signature);
            // Transport failures remain ambiguous: never replay them, even for invalid JSON.
            let response = self
                .client
                .request(reqwest::Method::from_bytes(method.as_bytes())?, url)
                .header("X-MBX-APIKEY", &self.key)
                .send()
                .await?;
            let status = response.status().as_u16();
            let text = response.text().await?;
            // -1021 is an explicit rejection before execution, so one corrected send is safe.
            if attempt == 0
                && status == 400
                && serde_json::from_str::<Value>(&text)
                    .ok()
                    .is_some_and(|v| v["code"] == -1021)
            {
                tracing::warn!(
                    method,
                    path,
                    "Binance rejected timestamp; recalibrating server clock"
                );
                continue;
            }
            return parse_response(status, &text);
        }
        unreachable!()
    }
    async fn server_offset(&self, refresh: bool) -> Result<i64> {
        let mut offset = self.offset.lock().await;
        if refresh || offset.is_none() {
            let time = self.public_request("/fapi/v1/time", &json!({})).await?;
            let server = time["serverTime"]
                .as_i64()
                .filter(|t| *t > 0)
                .context("Binance 未返回有效服务器时间")?;
            // Queueing, retries and proxy latency must not push timestamps ahead of the server.
            // Anchor to receipt rather than the midpoint of the entire public request.
            *offset = Some(server - crate::now_ms() - 500);
        }
        Ok(offset.unwrap_or(0))
    }
    pub async fn spot_signed(&self, path: &str, params: &Value) -> Result<Value> {
        if !self.demo {
            bail!("现货 Demo 接口仅支持 Demo 环境。");
        }
        if !self.credentials() {
            bail!("请配置 Binance Demo API Key / Secret Key。");
        }
        let mut p = params.clone();
        p["timestamp"] = json!(crate::now_ms());
        p["recvWindow"] = json!(5000);
        let query = query_string(&p);
        let url = format!(
            "https://demo-api.binance.com{path}?{query}&signature={}",
            sign(&self.secret, &query)
        );
        let res = self
            .client
            .get(url)
            .header("X-MBX-APIKEY", &self.key)
            .send()
            .await?;
        let status = res.status().as_u16();
        parse_response(status, &res.text().await?)
    }
    pub async fn spot_public(&self, path: &str, params: &Value) -> Result<Value> {
        let mut client = self.clone();
        client.base = "https://demo-api.binance.com".to_owned();
        client.public_request(path, params).await
    }
    pub async fn klines(
        &self,
        symbol: &str,
        interval: &str,
        limit: usize,
        start: Option<i64>,
        end: Option<i64>,
    ) -> Result<Vec<Value>> {
        valid_symbol(symbol)?;
        let duration = crate::interval_ms(interval).context("不支持的周期")?;
        let raw=self.public_request("/fapi/v1/klines",&json!({"symbol":symbol,"interval":interval,"limit":limit.clamp(1,1000),"startTime":start,"endTime":end})).await?;
        let rows = raw.as_array().context("Binance K线返回格式错误")?;
        Ok(rows.iter().map(|r|{let t=crate::number(&r[0],0.)as i64;json!({"openTime":t,"open":crate::number(&r[1],0.),"high":crate::number(&r[2],0.),"low":crate::number(&r[3],0.),"close":crate::number(&r[4],0.),"volume":crate::number(&r[5],0.),"closeTime":crate::number(&r[6],0.)as i64,"quoteVolume":crate::number(&r[7],0.),"tradeCount":crate::number(&r[8],0.)as i64,"takerBuyVolume":r.get(9).map(|v|crate::number(v,0.)),"takerBuyQuoteVolume":r.get(10).map(|v|crate::number(v,0.)),"confirmed":t+duration<=crate::now_ms()})}).collect())
    }
    pub async fn contracts(&self) -> Result<Vec<Value>> {
        let data = self
            .public_request("/fapi/v1/exchangeInfo", &json!({}))
            .await?;
        let mut rows:Vec<Value>=data["symbols"].as_array().context("合约列表格式错误")?.iter().filter(|s|s["status"]=="TRADING"&&s["contractType"]=="PERPETUAL"&&s["quoteAsset"]=="USDT"&&s["marginAsset"]=="USDT").map(|s|json!({"symbol":s["symbol"],"baseCoin":s["baseAsset"],"quoteCoin":s["quoteAsset"],"filters":s["filters"],"maxLeverage":s["filters"].as_array().and_then(|f|f.iter().find(|f|f["filterType"]=="LEVERAGE_FILTER")).map(|f|crate::number(&f["maxLeverage"],0.)),"marketProvider":"binance"})).collect();
        rows.sort_by(|a, b| a["symbol"].as_str().cmp(&b["symbol"].as_str()));
        Ok(rows)
    }
    pub async fn opportunity_context(&self, symbol: &str) -> Value {
        self.market_context(symbol, &Value::Null, false).await
    }
}
fn http_client(reuse_idle_connections: bool) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(8))
        .pool_idle_timeout(Duration::from_secs(15))
        .user_agent("NOFX-Rust/0.1");
    if !reuse_idle_connections {
        builder = builder.pool_max_idle_per_host(0);
    }
    if let Some(proxy) = std::env::var("HTTPS_PROXY")
        .ok()
        .or_else(|| std::env::var("HTTP_PROXY").ok())
        .filter(|s| !s.is_empty())
    {
        builder = builder.proxy(reqwest::Proxy::all(proxy)?);
    }
    Ok(builder.build()?)
}
fn futures_base(demo: bool, live_override: Option<&str>) -> String {
    if demo {
        "https://demo-fapi.binance.com".to_owned()
    } else {
        live_override
            .map(str::trim)
            .filter(|base| !base.is_empty())
            .unwrap_or("https://fapi.binance.com")
            .trim_end_matches('/')
            .to_owned()
    }
}
pub fn is_demo(b: &Value) -> bool {
    b.get("demo")
        .map(|v| v == true)
        .unwrap_or(b["testnet"] != false)
}
pub fn valid_symbol(symbol: &str) -> Result<()> {
    if symbol.len() < 5
        || symbol.len() > 30
        || !symbol.ends_with("USDT")
        || !symbol.chars().all(|c| c.is_alphanumeric())
    {
        bail!("非法 USDT 合约：{symbol}");
    }
    Ok(())
}
pub fn storage_symbol(symbol: &str, provider: &str) -> Result<String> {
    match provider {
        "binance" => Ok(format!("BINANCE_{}", strip_symbol(symbol))),
        "okx" => Ok(format!("OKX_PUBLIC_{}", strip_symbol(symbol))),
        _ => bail!("未知行情来源：{provider}"),
    }
}
pub fn strip_symbol(symbol: &str) -> &str {
    for prefix in ["BINANCE_", "OKX_PUBLIC_", "BYBIT_", "OKX_"] {
        if let Some(s) = symbol.strip_prefix(prefix) {
            return s;
        }
    }
    symbol
}
pub fn client_id(kind: &str, parts: &[&str]) -> String {
    let digest = hex::encode(Sha256::digest(
        format!("{kind}|{}", parts.join("|")).as_bytes(),
    ));
    format!(
        "nofx_{}_{}",
        kind.chars()
            .take(9)
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            })
            .collect::<String>(),
        &digest[..24]
    )
    .chars()
    .take(36)
    .collect()
}
fn sign(secret: &str, query: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(query.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}
fn query_string(params: &Value) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    if let Some(obj) = params.as_object() {
        for (k, v) in obj {
            if v.is_null() {
                continue;
            }
            let s = v
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string());
            if !s.is_empty() {
                q.append_pair(k, &s);
            }
        }
    }
    q.finish()
}
fn parse_response(status: u16, text: &str) -> Result<Value> {
    let data: Value = serde_json::from_str(text)
        .with_context(|| format!("Binance 返回非 JSON (HTTP {status})"))?;
    if !(200..300).contains(&status) || data["code"].as_i64().is_some_and(|c| c < 0) {
        bail!(
            "Binance HTTP {status}: {} (code {})",
            data["msg"].as_str().unwrap_or("Request rejected"),
            data["code"]
        );
    }
    Ok(data)
}
#[cfg(test)]
#[path = "exchange/request_tests.rs"]
mod request_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signing_and_namespace() {
        assert_eq!(
            sign("key", "The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
        assert_eq!(
            storage_symbol("BINANCE_BTCUSDT", "binance").unwrap(),
            "BINANCE_BTCUSDT"
        );
        assert!(valid_symbol("BTCUSDT&side=BUY").is_err());
    }
    #[test]
    fn credentials_never_cross_environments() {
        let config = json!({"binance":{"demo":true,"apiKey":"demo","secretKey":"secret"}});
        assert!(!Exchange::new(&config, "live").unwrap().credentials());
        assert!(Exchange::new(&config, "demo").unwrap().credentials());
    }
}
