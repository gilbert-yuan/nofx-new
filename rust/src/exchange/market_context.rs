use super::{Exchange, valid_symbol};
use crate::{iso, now_ms};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;

type Entry = Arc<Mutex<Option<Cached>>>;
pub(super) type Cache = Arc<Mutex<BTreeMap<String, Entry>>>;

pub(super) struct Cached {
    data: Value,
    error: Option<String>,
    fetched_at: i64,
    expires_at: i64,
}

impl Exchange {
    // The entry lock coalesces simultaneous requests; the map lock never covers network I/O.
    async fn cached_market_request(&self, path: &str, params: &Value, ttl: i64) -> Value {
        let cache_key = format!("{}:{path}:{}", self.base, super::query_string(params));
        let entry = {
            let mut cache = self.market_cache.lock().await;
            if let Some(entry) = cache.get(&cache_key) {
                entry.clone()
            } else {
                if cache.len() >= 2048 {
                    let evict = cache.iter().find_map(|(key, entry)| {
                        (Arc::strong_count(entry) == 1).then(|| key.clone())
                    });
                    if let Some(key) = evict {
                        cache.remove(&key);
                    }
                }
                let entry = Arc::new(Mutex::new(None));
                if cache.len() < 2048 {
                    cache.insert(cache_key, entry.clone());
                }
                entry
            }
        };
        let mut cached = entry.lock().await;
        let cache_hit = cached.as_ref().is_some_and(|v| v.expires_at > now_ms());
        if !cache_hit {
            // Auxiliary collection must not wait through an entire IP-budget window or TLS outage.
            let result =
                tokio::time::timeout(Duration::from_secs(10), self.public_request(path, params))
                    .await;
            let (data, error) = match result {
                Ok(Ok(data)) => (data, None),
                Ok(Err(error)) => (Value::Null, Some(format!("{error:#}"))),
                Err(_) => (Value::Null, Some("辅助行情请求超过 10 秒，稍后重试".into())),
            };
            let fetched_at = now_ms();
            let expires_at = fetched_at + if error.is_some() { 30_000 } else { ttl };
            *cached = Some(Cached {
                data,
                error,
                fetched_at,
                expires_at,
            });
        }
        let cached = cached.as_ref().unwrap();
        json!({"data":cached.data,"error":cached.error,"meta":{"source":"binance","endpoint":path,"fetchedAt":iso(cached.fetched_at),"cacheHit":cache_hit,"status":if cached.error.is_some(){"unavailable"}else{"available"}}})
    }

    pub async fn indicator_context(&self, symbol: &str, ticker: &Value) -> Value {
        self.market_context(symbol, ticker, true).await
    }
    pub async fn confirmation_context(&self, symbol: &str, ticker: &Value) -> Value {
        self.market_context(symbol, ticker, false).await
    }

    pub(super) async fn market_context(
        &self,
        symbol: &str,
        ticker: &Value,
        extended: bool,
    ) -> Value {
        let mut context = json!({"symbol":symbol,"source":"binance","collectedAt":iso(now_ms()),"errors":{},"meta":{}});
        if let Err(error) = valid_symbol(symbol) {
            context["errors"]["symbol"] = json!(error.to_string());
            return context;
        }
        let mut calls = vec![
            (
                "premium",
                "/fapi/v1/premiumIndex",
                json!({"symbol":symbol}),
                30_000,
            ),
            (
                "funding",
                "/fapi/v1/fundingRate",
                json!({"symbol":symbol,"limit":1}),
                600_000,
            ),
            (
                "oi",
                "/futures/data/openInterestHist",
                json!({"symbol":symbol,"period":"15m","limit":2}),
                300_000,
            ),
        ];
        if ticker["symbol"] == symbol && !ticker["lastPrice"].is_null() {
            context["ticker24h"] = ticker.clone();
            context["meta"]["ticker24h"] = json!({"source":"binance","endpoint":"/fapi/v1/ticker/24hr","fetchedAt":iso(now_ms()),"cacheHit":true,"status":"available","reusedScan":true});
        } else {
            calls.push((
                "ticker24h",
                "/fapi/v1/ticker/24hr",
                json!({"symbol":symbol}),
                30_000,
            ));
        }
        if extended {
            calls.extend([
                (
                    "oi5m",
                    "/futures/data/openInterestHist",
                    json!({"symbol":symbol,"period":"5m","limit":13}),
                    300_000,
                ),
                (
                    "globalRatio",
                    "/futures/data/globalLongShortAccountRatio",
                    json!({"symbol":symbol,"period":"5m","limit":2}),
                    300_000,
                ),
                (
                    "topPositionRatio",
                    "/futures/data/topLongShortPositionRatio",
                    json!({"symbol":symbol,"period":"5m","limit":2}),
                    300_000,
                ),
                (
                    "depth",
                    "/fapi/v1/depth",
                    json!({"symbol":symbol,"limit":20}),
                    15_000,
                ),
                ("fundingInfo", "/fapi/v1/fundingInfo", json!({}), 3_600_000),
            ]);
        }
        let results =
            futures::future::join_all(calls.iter().map(|(key, path, params, ttl)| async move {
                (*key, self.cached_market_request(path, params, *ttl).await)
            }))
            .await;
        for (key, result) in results {
            context[key] = result["data"].clone();
            context["meta"][key] = result["meta"].clone();
            if !result["error"].is_null() {
                context["errors"][key] = result["error"].clone();
            }
        }
        context["collectedAt"] = json!(iso(now_ms()));
        context
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::{OriginalUri, Query, State},
        routing::get,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn response(
        State(counter): State<Arc<AtomicUsize>>,
        OriginalUri(uri): OriginalUri,
        Query(query): Query<BTreeMap<String, String>>,
    ) -> (axum::http::StatusCode, Json<Value>) {
        counter.fetch_add(1, Ordering::SeqCst);
        let data = match uri.path() {
            "/fapi/v1/premiumIndex" => {
                json!({"symbol":"BTCUSDT","markPrice":"100","time":now_ms()})
            }
            "/fapi/v1/fundingInfo" => json!([]),
            "/fapi/v1/fundingRate" => json!([]),
            "/futures/data/openInterestHist" => {
                assert!(query["limit"] == "2" || query["limit"] == "13");
                json!([{"symbol":"BTCUSDT","sumOpenInterest":"1","timestamp":now_ms()}])
            }
            "/futures/data/globalLongShortAccountRatio" => json!([]),
            "/fapi/v1/depth" => {
                assert_eq!(query["limit"], "20");
                json!({"bids":[["100","1"]],"asks":[["101","1"]],"T":now_ms()})
            }
            _ => {
                return (
                    axum::http::StatusCode::UNAUTHORIZED,
                    Json(json!({"code":-2015,"msg":"API key required"})),
                );
            }
        };
        (axum::http::StatusCode::OK, Json(data))
    }

    #[tokio::test]
    async fn collection_coalesces_requests_and_isolates_failed_sources() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let exchange =
            Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
        let count = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/{*path}", get(response))
            .with_state(count.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let ticker = json!({"symbol":"BTCUSDT","lastPrice":"100"});
        let (a, b) = tokio::join!(
            exchange.indicator_context("BTCUSDT", &ticker),
            exchange.indicator_context("BTCUSDT", &ticker)
        );
        assert_eq!(count.load(Ordering::SeqCst), 8);
        assert_eq!(a["premium"]["markPrice"], "100");
        assert!(a["errors"]["topPositionRatio"].is_string());
        assert!(a["topPositionRatio"].is_null());
        assert_eq!(b["meta"]["ticker24h"]["reusedScan"], true);
        let c = exchange.indicator_context("BTCUSDT", &ticker).await;
        assert_eq!(count.load(Ordering::SeqCst), 8);
        assert_eq!(c["meta"]["premium"]["cacheHit"], true);
        assert_eq!(c["meta"]["topPositionRatio"]["cacheHit"], true);
        assert_eq!(
            a["meta"]["premium"]["fetchedAt"],
            c["meta"]["premium"]["fetchedAt"]
        );
        // An expired failed refresh must not replay its old success as current data.
        for entry in exchange.market_cache.lock().await.values() {
            let mut guard = entry.lock().await;
            if let Some(cached) = guard.as_mut() {
                cached.expires_at = 0;
            }
        }
        exchange.indicator_context("BTCUSDT", &ticker).await;
        assert_eq!(count.load(Ordering::SeqCst), 16);
        let invalid = exchange.indicator_context("BTCUSDT&evil=1", &ticker).await;
        assert!(invalid["errors"]["symbol"].is_string());
        assert_eq!(count.load(Ordering::SeqCst), 16);
        server.abort();
    }
    #[tokio::test]
    async fn failed_refresh_discards_expired_values() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let exchange =
            Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
        let count = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/fapi/v1/premiumIndex",
                get(|State(count): State<Arc<AtomicUsize>>| async move {
                    if count.fetch_add(1, Ordering::SeqCst) == 0 {
                        (axum::http::StatusCode::OK, Json(json!({"markPrice":"100"})))
                    } else {
                        (
                            axum::http::StatusCode::BAD_REQUEST,
                            Json(json!({"code":-1,"msg":"unavailable"})),
                        )
                    }
                }),
            )
            .with_state(count.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let params = json!({"symbol":"BTCUSDT"});
        assert_eq!(
            exchange
                .cached_market_request("/fapi/v1/premiumIndex", &params, 30_000)
                .await["data"]["markPrice"],
            "100"
        );
        for entry in exchange.market_cache.lock().await.values() {
            entry.lock().await.as_mut().unwrap().expires_at = 0;
        }
        let failed = exchange
            .cached_market_request("/fapi/v1/premiumIndex", &params, 30_000)
            .await;
        assert!(failed["data"].is_null());
        assert_eq!(failed["meta"]["status"], "unavailable");
        assert!(failed["error"].is_string());
        exchange
            .cached_market_request("/fapi/v1/premiumIndex", &params, 30_000)
            .await;
        assert_eq!(count.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
