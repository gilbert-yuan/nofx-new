use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Mock {
    exchange: Exchange,
    requests: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn response(status: u16, body: &str, truncated: bool) -> String {
    let length = body.len() + if truncated { 100 } else { 0 };
    format!("HTTP/1.1 {status} Test\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}")
}

async fn mock(responses: Vec<String>) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let exchange = Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
    let requests = Arc::new(AtomicUsize::new(0));
    let counter = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            let index = counter.fetch_add(1, Ordering::SeqCst);
            let reply = &responses[index.min(responses.len() - 1)];
            let _ = socket.write_all(reply.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });
    Mock {
        exchange,
        requests,
        task,
    }
}

#[tokio::test]
async fn public_request_retries_truncated_body() {
    let mock = mock(vec![
        response(200, "{\"ok\":true}", true),
        response(200, "{\"ok\":true}", false),
    ])
    .await;
    let data = mock
        .exchange
        .public_request("/fapi/v1/klines", &json!({"symbol":"1000CHEEMSUSDT"}))
        .await
        .unwrap();
    assert_eq!(data["ok"], true);
    assert_eq!(mock.requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn depth_uses_integer_supported_limits_and_keeps_book_guard() {
    use axum::{Json, Router, extract::Query, routing::get};
    use std::collections::HashMap;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let exchange = Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
    let app = Router::new().route(
        "/fapi/v1/depth",
        get(|Query(query): Query<HashMap<String, String>>| async move {
            assert_eq!(query["symbol"], "BTCUSDT");
            let limit: usize = query["limit"].parse().expect("limit must be an integer");
            assert!([5, 10, 20, 50, 100, 500, 1000].contains(&limit));
            Json(json!({"limit":limit,"bids":[["100","10"]],"asks":[["100.01","10"]]}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for (levels, limit) in [(1, 5), (5, 5), (7, 10), (15, 20), (30, 50), (50, 50)] {
        let depth = exchange.depth("BTCUSDT", levels).await.unwrap();
        assert_eq!(depth["limit"], limit);
        crate::automation_guards::book_check(
            &json!({"bidPrice":"100","askPrice":"100.01"}),
            &depth,
            10.,
        )
        .unwrap();
    }
    assert!(exchange.depth("BTCUSDT", 1001).await.is_err());
    server.abort();
}

#[tokio::test]
async fn public_request_reports_body_failure_after_three_attempts() {
    let mock = mock(vec![response(200, "{}", true)]).await;
    let error = mock
        .exchange
        .public_request("/fapi/v1/exchangeInfo", &json!({}))
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(mock.requests.load(Ordering::SeqCst), 3);
    assert!(error.contains("/fapi/v1/exchangeInfo"), "{error}");
    assert!(error.contains("3 attempt(s)"), "{error}");
    assert!(error.contains("读取 Binance 响应体失败"), "{error}");
    assert!(error.contains("error decoding response body"), "{error}");
}

#[tokio::test]
async fn public_request_retries_incomplete_headers_and_invalid_json() {
    let mock = mock(vec![
        "HTTP/1.1".into(),
        response(200, "{\"symbols\":", false),
        response(200, "{\"symbols\":[]}", false),
    ])
    .await;
    let data = mock
        .exchange
        .public_request("/fapi/v1/exchangeInfo", &json!({}))
        .await
        .unwrap();
    assert_eq!(data["symbols"], json!([]));
    assert_eq!(mock.requests.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn public_request_retries_rate_limit_and_server_failure() {
    let mock = mock(vec![
        response(429, "{\"code\":-1003,\"msg\":\"Too many requests\"}", false).replacen(
            "Content-Length:",
            "Retry-After: 0\r\nContent-Length:",
            1,
        ),
        response(502, "Bad Gateway", false),
        response(200, "{\"ok\":true}", false),
    ])
    .await;
    mock.exchange
        .public_request("/fapi/v1/klines", &json!({}))
        .await
        .unwrap();
    assert_eq!(mock.requests.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn public_request_does_not_retry_permanent_rejection() {
    for status in [200, 400, 418] {
        let mock = mock(vec![response(
            status,
            "{\"code\":-1121,\"msg\":\"Invalid symbol\"}",
            false,
        )])
        .await;
        let error = mock
            .exchange
            .public_request("/fapi/v1/klines", &json!({"symbol":"INVALIDUSDT"}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("Invalid symbol"), "{error}");
        assert!(error.contains("symbol=INVALIDUSDT"), "{error}");
        assert_eq!(mock.requests.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn public_ip_ban_stops_subsequent_requests_across_clones() {
    let until = crate::now_ms() + 120_000;
    let mock = mock(vec![response(
        418,
        &json!({"code":-1003,"msg":format!("IP banned until {until}.")}).to_string(),
        false,
    )])
    .await;
    assert!(
        mock.exchange
            .public_request("/fapi/v1/exchangeInfo", &json!({}))
            .await
            .is_err()
    );
    let error = mock
        .exchange
        .clone()
        .public_request("/fapi/v1/klines", &json!({"limit":3}))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("冷却中"), "{error}");
    assert_eq!(mock.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn signed_mutation_does_not_retry_truncated_body() {
    let mock = mock(vec![
        response(
            200,
            &json!({"serverTime":crate::now_ms()}).to_string(),
            false,
        ),
        response(200, "{\"orderId\":123}", true),
        response(200, "{\"orderId\":123}", false),
    ])
    .await;
    assert!(
        mock.exchange
            .signed("POST", "/fapi/v1/order", &json!({"symbol":"BTCUSDT"}))
            .await
            .is_err()
    );
    // One server-time GET and one mutation POST; the failed POST is never replayed.
    assert_eq!(mock.requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn signed_request_recalibrates_only_an_explicit_timestamp_rejection() {
    let mock = mock(vec![
        response(
            200,
            &json!({"serverTime":crate::now_ms()}).to_string(),
            false,
        ),
        response(400, "{\"code\":-1021,\"msg\":\"Timestamp ahead\"}", false),
        response(
            200,
            &json!({"serverTime":crate::now_ms()}).to_string(),
            false,
        ),
        response(200, "{\"orderId\":123}", false),
    ])
    .await;
    let order = mock
        .exchange
        .signed("POST", "/fapi/v1/order", &json!({"symbol":"BTCUSDT"}))
        .await
        .unwrap();
    assert_eq!(order["orderId"], 123);
    assert_eq!(mock.requests.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn delayed_clock_response_does_not_make_signed_timestamp_ahead() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let exchange = Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
        for step in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let count = socket.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..count]);
            }
            let body = if step == 0 {
                tokio::time::sleep(Duration::from_millis(2200)).await;
                json!({"serverTime":crate::now_ms()})
            } else {
                let request = String::from_utf8(request).unwrap();
                let timestamp = request
                    .split("timestamp=")
                    .nth(1)
                    .unwrap()
                    .split(['&', ' '])
                    .next()
                    .unwrap()
                    .parse::<i64>()
                    .unwrap();
                let age = crate::now_ms() - timestamp;
                assert!(
                    (400..5000).contains(&age),
                    "signed timestamp must stay behind: {age}ms"
                );
                json!({"orderId":123})
            };
            socket
                .write_all(response(200, &body.to_string(), false).as_bytes())
                .await
                .unwrap();
        }
    });
    let order = exchange
        .signed("POST", "/fapi/v1/order", &json!({"symbol":"BTCUSDT"}))
        .await
        .unwrap();
    server.await.unwrap();
    assert_eq!(order["orderId"], 123);
}

#[test]
fn futures_hosts_keep_demo_and_live_overrides_separate() {
    assert_eq!(futures_base(false, None), "https://fapi.binance.com");
    assert_eq!(futures_base(false, Some("  ")), "https://fapi.binance.com");
    assert_eq!(
        futures_base(false, Some(" https://custom.example/ ")),
        "https://custom.example"
    );
    assert_eq!(
        futures_base(true, Some("https://custom.example")),
        "https://demo-fapi.binance.com"
    );
}

#[tokio::test]
async fn retry_opens_new_connection_after_invalid_keepalive_response() {
    async fn headers(socket: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0, "connection ended before request headers");
            request.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8(request).unwrap().to_ascii_lowercase()
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let exchange = Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        assert!(!headers(&mut first).await.contains("connection: close"));
        // The body is invalid JSON but correctly framed, so the first connection stays pooled.
        first
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nConnection: keep-alive\r\n\r\n{")
            .await
            .unwrap();
        let (mut second, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .expect("retry must open a fresh TCP connection")
            .unwrap();
        assert!(headers(&mut second).await.contains("connection: close"));
        second
            .write_all(response(200, "{\"ok\":true}", false).as_bytes())
            .await
            .unwrap();
    });
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        exchange.public_request("/fapi/v1/klines", &json!({})),
    )
    .await;
    server.await.unwrap();
    assert_eq!(result.unwrap().unwrap()["ok"], true);
}

#[tokio::test]
#[ignore = "reads Binance public market data; requires external access and optional HTTPS_PROXY"]
async fn live_public_klines_decode_through_configured_transport() -> Result<()> {
    let exchange = Exchange::public()?;
    for (symbol, interval) in [
        ("MELANIAUSDT", "5m"),
        ("MONUSDT", "1m"),
        ("MORPHOUSDT", "1m"),
        ("METUSDT", "5m"),
    ] {
        let bars = exchange.klines(symbol, interval, 82, None, None).await?;
        assert_eq!(bars.len(), 82, "{symbol}/{interval}");
        assert!(bars.iter().all(|bar| bar["openTime"].as_i64().unwrap() > 0));
        println!("{symbol}/{interval}: {} decoded candles", bars.len());
    }
    Ok(())
}
