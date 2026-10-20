use anyhow::{Context, Result, bail};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::sync::Mutex;
mod market_context;
mod rate_limit;

/// Contract metadata changes only when the venue lists or delists a symbol, but the payload is
/// roughly 900KB and measures ~7s to fetch on this link. Fetching it per call was the dominant
/// cost of closing a position and of every account sweep, so it is cached per environment.
const EXCHANGE_INFO_TTL_MS: i64 = 600_000;
fn info_cache() -> &'static Mutex<BTreeMap<String, (i64, BTreeMap<String, Value>)>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, (i64, BTreeMap<String, Value>)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[derive(Clone)]
pub struct Exchange {
    client: reqwest::Client,
    retry_client: reqwest::Client,
    budget: Arc<Mutex<rate_limit::Budget>>,
    base: String,
    key: String,
    secret: String,
    pub demo: bool,
    /// (fetched_at, offset_ms) shared per venue; see `shared_offset`.
    offset: Arc<Mutex<Option<(i64, i64)>>>,
    market_cache: market_context::Cache,
}
/// Connection pools, the calibrated server clock and the market-context cache describe the
/// venue, not a request. `Exchange::new` runs per close, per sweep order and per API call, so
/// per-instance transport made every one of them pay a TLS handshake plus a redundant
/// `/fapi/v1/time` before the first signed request. On this link a demo round trip measures
/// ~0.44s on a reused connection versus ~1.6s on a cold one.
fn shared_client(demo: bool) -> &'static reqwest::Client {
    static DEMO: OnceLock<reqwest::Client> = OnceLock::new();
    static LIVE: OnceLock<reqwest::Client> = OnceLock::new();
    (if demo { &DEMO } else { &LIVE })
        .get_or_init(|| http_client(true).expect("Binance client must build"))
}
fn shared_retry_client(demo: bool) -> &'static reqwest::Client {
    static DEMO: OnceLock<reqwest::Client> = OnceLock::new();
    static LIVE: OnceLock<reqwest::Client> = OnceLock::new();
    (if demo { &DEMO } else { &LIVE })
        .get_or_init(|| http_client(false).expect("Binance retry client must build"))
}
fn shared_market_cache(demo: bool) -> &'static market_context::Cache {
    static DEMO: OnceLock<market_context::Cache> = OnceLock::new();
    static LIVE: OnceLock<market_context::Cache> = OnceLock::new();
    (if demo { &DEMO } else { &LIVE }).get_or_init(Default::default)
}
/// A clock can drift over a long-running process, so the offset is re-calibrated at most this
/// often; ordinary calls never pay for the round trip.
const SERVER_OFFSET_MAX_AGE_MS: i64 = 600_000;
fn shared_offset(demo: bool) -> &'static Arc<Mutex<Option<(i64, i64)>>> {
    static DEMO: OnceLock<Arc<Mutex<Option<(i64, i64)>>>> = OnceLock::new();
    static LIVE: OnceLock<Arc<Mutex<Option<(i64, i64)>>>> = OnceLock::new();
    (if demo { &DEMO } else { &LIVE }).get_or_init(Default::default)
}
/// Hedge/one-way position mode changes are rare and user-initiated. A short TTL keeps close
/// and sweep paths from paying a round trip for it on every call; a stale value can only make
/// Binance reject a mismatched order, never mis-fill one.
const POSITION_MODE_TTL_MS: i64 = 60_000;
fn position_mode_cache() -> &'static Mutex<BTreeMap<String, (i64, bool)>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, (i64, bool)>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
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
    pub fn base(&self) -> &str {
        &self.base
    }
    /// Per-contract metadata, served from a shared per-environment cache.
    pub async fn info(&self, symbol: &str) -> Result<Value> {
        let base = self.base.clone();
        let now = crate::now_ms();
        {
            let cache = info_cache().lock().await;
            if let Some((at, contracts)) = cache.get(&base) {
                if now.saturating_sub(*at) < EXCHANGE_INFO_TTL_MS {
                    // A full listing without this symbol is authoritative: refetching would only
                    // re-download 900KB to learn the same thing.
                    return contracts
                        .get(symbol)
                        .cloned()
                        .context("目标交易环境不支持该合约");
                }
            }
        }
        let started = tokio::time::Instant::now();
        let raw = self
            .public_request("/fapi/v1/exchangeInfo", &json!({}))
            .await?;
        let mut contracts = BTreeMap::new();
        for row in raw["symbols"].as_array().context("合约信息格式错误")? {
            if let Some(name) = row["symbol"].as_str() {
                contracts.insert(name.to_owned(), row.clone());
            }
        }
        // Only logged on a miss, so the log also proves the cache is doing its job.
        tracing::info!(
            base = %base,
            ms = started.elapsed().as_millis() as i64,
            symbols = contracts.len(),
            "Fetched exchange contract metadata"
        );
        let mut cache = info_cache().lock().await;
        cache.insert(base, (now, contracts.clone()));
        contracts.remove(symbol).context("目标交易环境不支持该合约")
    }
    /// Hedge/one-way position mode, cached per venue for `POSITION_MODE_TTL_MS`. Every close
    /// and every strategy-exit sync needs it to address the position side; querying it per
    /// call added a full round trip to each of them.
    pub async fn position_mode(&self) -> Result<bool> {
        let now = crate::now_ms();
        {
            let cache = position_mode_cache().lock().await;
            if let Some((at, dual)) = cache.get(&self.base)
                && now.saturating_sub(*at) < POSITION_MODE_TTL_MS
            {
                return Ok(*dual);
            }
        }
        let mode = self
            .signed("GET", "/fapi/v1/positionSide/dual", &json!({}))
            .await?;
        let dual = mode["dualSidePosition"]
            .as_bool()
            .context("未能确认持仓模式，暂缓执行")?;
        position_mode_cache()
            .lock()
            .await
            .insert(self.base.clone(), (now, dual));
        Ok(dual)
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
            client: shared_client(demo).clone(),
            retry_client: shared_retry_client(demo).clone(),
            budget: rate_limit::shared(demo),
            base: futures_base(demo, std::env::var("BINANCE_FUTURES_BASE").ok().as_deref()),
            key: credential("apiKey"),
            secret: credential("secretKey"),
            demo,
            offset: Arc::clone(shared_offset(demo)),
            market_cache: Arc::clone(shared_market_cache(demo)),
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
        let mut state = self.offset.lock().await;
        let stale = state
            .as_ref()
            .is_none_or(|(at, _)| crate::now_ms().saturating_sub(*at) > SERVER_OFFSET_MAX_AGE_MS);
        if refresh || stale {
            let time = self.public_request("/fapi/v1/time", &json!({})).await?;
            let server = time["serverTime"]
                .as_i64()
                .filter(|t| *t > 0)
                .context("Binance 未返回有效服务器时间")?;
            // Queueing, retries and proxy latency must not push timestamps ahead of the server.
            // Anchor to receipt rather than the midpoint of the entire public request.
            let at = crate::now_ms();
            *state = Some((at, server - at - 500));
        }
        Ok(state.map(|(_, offset)| offset).unwrap_or(0))
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
        let mut rows:Vec<Value>=data["symbols"].as_array().context("合约列表格式错误")?.iter().filter(|s|s["status"]=="TRADING"&&s["contractType"]=="PERPETUAL"&&s["quoteAsset"]=="USDT"&&s["marginAsset"]=="USDT").map(|s|json!({"symbol":s["symbol"],"baseCoin":s["baseAsset"],"quoteCoin":s["quoteAsset"],"filters":s["filters"],"onboardDate":s["onboardDate"],"maxLeverage":s["filters"].as_array().and_then(|f|f.iter().find(|f|f["filterType"]=="LEVERAGE_FILTER")).map(|f|crate::number(&f["maxLeverage"],0.)),"marketProvider":"binance"})).collect();
        rows.sort_by(|a, b| a["symbol"].as_str().cmp(&b["symbol"].as_str()));
        Ok(rows)
    }
    pub async fn opportunity_context(&self, symbol: &str) -> Value {
        self.market_context(symbol, &Value::Null, false).await
    }
}
/// Proxy support is opt-in through `NOFX_HTTP_PROXY` and nothing else.
///
/// Ambient `HTTP_PROXY` / `HTTPS_PROXY` describe the shell that happened to launch the process
/// (IDE sandboxes, CI agents, terminal wrappers), not this service's network policy. Honouring
/// them means a proxy that dies with that shell silently takes every exchange call down with
/// `tunnel error ... os error 10061`, while a direct connection is perfectly healthy.
fn explicit_proxy() -> Option<String> {
    proxy_choice(std::env::var("NOFX_HTTP_PROXY").ok().as_deref())
}
/// Blank is treated as "no proxy" so an empty default in a process manager cannot be mistaken
/// for a configured proxy.
fn proxy_choice(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn note_ignored_proxy() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            let Ok(value) = std::env::var(key) else {
                continue;
            };
            if value.trim().is_empty() {
                continue;
            }
            tracing::warn!(
                variable = key,
                %value,
                "Ignoring inherited proxy; set NOFX_HTTP_PROXY to opt in"
            );
        }
    });
}
fn http_client(reuse_idle_connections: bool) -> Result<reqwest::Client> {
    note_ignored_proxy();
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(8))
        .pool_idle_timeout(Duration::from_secs(15))
        .user_agent("NOFX-Rust/0.1");
    if !reuse_idle_connections {
        builder = builder.pool_max_idle_per_host(0);
    }
    builder = match explicit_proxy() {
        Some(proxy) => builder.proxy(reqwest::Proxy::all(proxy)?),
        None => builder.no_proxy(),
    };
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
