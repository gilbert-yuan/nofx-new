use super::*;
use axum::{
    Json, Router,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    routing::any,
};
use futures::FutureExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::{
    Connection, PgConnection,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{
    str::FromStr,
    sync::{Arc, Mutex},
};

struct Remote {
    quantity: f64,
    mark: f64,
    fail_next: bool,
    requests: Vec<(String, String, Value)>,
    orders: BTreeMap<String, Value>,
    algos: Vec<Value>,
}
struct Mock {
    state: Arc<Mutex<Remote>>,
    client: Exchange,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn mock() -> Mock {
    let state = Arc::new(Mutex::new(Remote {
        quantity: 20.,
        mark: 100.,
        fail_next: true,
        requests: vec![],
        orders: BTreeMap::new(),
        algos: vec![],
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = Exchange::test_endpoint(&format!("http://{}", listener.local_addr().unwrap()));
    let app = Router::new()
        .route("/{*path}", any(handle))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Mock {
        state,
        client,
        task,
    }
}
async fn handle(
    State(state): State<Arc<Mutex<Remote>>>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let raw = uri.query().unwrap_or("");
    let params: serde_json::Map<String, Value> = url::form_urlencoded::parse(raw.as_bytes())
        .map(|(k, v)| (k.into_owned(), json!(v)))
        .collect();
    let p = Value::Object(params);
    if raw.contains("signature=") {
        let (query, signature) = raw.rsplit_once("&signature=").unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(b"test-secret").unwrap();
        mac.update(query.as_bytes());
        assert_eq!(signature, hex::encode(mac.finalize().into_bytes()));
        assert_eq!(headers["x-mbx-apikey"], "test-key");
        assert_eq!(p["recvWindow"], "5000");
    }
    let mut r = state.lock().unwrap();
    r.requests
        .push((method.to_string(), uri.path().to_owned(), p.clone()));
    let mut status = StatusCode::OK;
    let body = match (method.as_str(), uri.path()) {
        ("GET", "/fapi/v1/time") => json!({"serverTime":now_ms()}),
        ("GET", "/fapi/v1/positionSide/dual") => json!({"dualSidePosition":false}),
        ("GET", "/fapi/v1/positionRisk" | "/fapi/v2/positionRisk") => {
            json!([{"symbol":"BTCUSDT","positionSide":"BOTH","positionAmt":r.quantity,"markPrice":r.mark,"entryPrice":100.,"leverage":2}])
        }
        ("GET", "/fapi/v1/exchangeInfo") => {
            json!({"symbols":[{"symbol":"BTCUSDT","status":"TRADING","contractType":"PERPETUAL","quoteAsset":"USDT","filters":[{"filterType":"LOT_SIZE","stepSize":"0.01","minQty":"0.01","maxQty":"100"},{"filterType":"MARKET_LOT_SIZE","stepSize":"0.01","minQty":"0.01","maxQty":"100"},{"filterType":"PRICE_FILTER","tickSize":"0.01","minPrice":"0.01","maxPrice":"1000000"}]}]})
        }
        ("GET", "/fapi/v1/openOrders") => json!([]),
        ("GET", "/fapi/v1/openAlgoOrders") => json!(r.algos),
        ("POST", "/fapi/v1/algoOrder") => {
            let mut algo = p.clone();
            algo["algoId"] = json!(r.algos.len() + 1);
            r.algos.push(algo.clone());
            algo
        }
        ("DELETE", "/fapi/v1/algoOrder") => {
            r.algos
                .retain(|a| numeric_id(&a["algoId"]) != numeric_id(&p["algoId"]));
            json!({"code":200})
        }
        ("GET", "/fapi/v1/order") => r
            .orders
            .get(p["origClientOrderId"].as_str().unwrap_or(""))
            .cloned()
            .unwrap_or_else(|| {
                status = StatusCode::BAD_REQUEST;
                json!({"code":-2013,"msg":"Order does not exist"})
            }),
        ("POST", "/fapi/v1/order") => {
            assert_eq!(p["reduceOnly"], "true");
            assert_eq!(p["side"], "SELL");
            let qty = n(&p, "quantity", 0.);
            assert!(qty > 0. && qty <= r.quantity);
            r.quantity -= qty;
            let response = json!({"status":"FILLED","orderId":r.orders.len()+1,"clientOrderId":p["newClientOrderId"],"executedQty":qty,"avgPrice":r.mark});
            r.orders.insert(
                p["newClientOrderId"].as_str().unwrap().into(),
                response.clone(),
            );
            if r.fail_next {
                r.fail_next = false;
                status = StatusCode::INTERNAL_SERVER_ERROR;
                json!({"code":-1007,"msg":"accepted but response timed out"})
            } else {
                response
            }
        }
        _ => {
            status = StatusCode::NOT_FOUND;
            json!({"code":-1,"msg":"Unexpected test endpoint"})
        }
    };
    (status, Json(body))
}
#[tokio::test]
async fn signed_mutation_is_sent_once_and_reconciled() {
    let m = mock().await;
    let p = json!({"symbol":"BTCUSDT","side":"SELL","type":"MARKET","quantity":"2","reduceOnly":true,"newClientOrderId":"stable-request"});
    assert!(m.client.signed("POST", "/fapi/v1/order", &p).await.is_err());
    let observed = m
        .client
        .signed(
            "GET",
            "/fapi/v1/order",
            &json!({"symbol":"BTCUSDT","origClientOrderId":"stable-request"}),
        )
        .await
        .unwrap();
    assert_eq!(observed["executedQty"], 2.);
    assert_eq!(
        m.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(verb, path, _)| verb == "POST" && path == "/fapi/v1/order")
            .count(),
        1
    );
}
#[test]
fn partial_exit_owns_only_its_entry_quantity() {
    let link = json!({"executedQty":10.});
    let mut order = json!({"status":"open","quantity":6.,"realizedQty":4.});
    assert_eq!(desired_exit_quantity(&order, &link, false), 4.);
    order["status"] = json!("closed");
    assert_eq!(desired_exit_quantity(&order, &link, false), 10.);
    order["exchangeSync"] =
        json!({"live":{"status":"filled","executedQty":10.,"closeOrders":[{"executedQty":10.}]}});
    assert!(!needs_exchange_sync(&order, "live"));
    order["exchangeSync"]["live"]["closeOrders"] = json!([]);
    assert!(needs_exchange_sync(&order, "live"));
}
#[tokio::test]
#[ignore = "requires local PostgreSQL; uses a new disposable database and fake exchange only"]
async fn durable_partial_exit_and_protection() -> Result<()> {
    let _ = dotenvy::from_path(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
    let options = if let Ok(url) = std::env::var("DATABASE_URL") {
        PgConnectOptions::from_str(&url)?
    } else {
        PgConnectOptions::new()
            .host(&std::env::var("PGHOST").unwrap_or("127.0.0.1".into()))
            .port(
                std::env::var("PGPORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(5432),
            )
            .database(&std::env::var("PGDATABASE").unwrap_or("nofx_lite".into()))
            .username(&std::env::var("PGUSER").unwrap_or("postgres".into()))
            .password(&std::env::var("PGPASSWORD").unwrap_or_default())
    };
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("nofx_rust_test_{}", uuid::Uuid::new_v4().simple());
    assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    sqlx::query(&format!("CREATE DATABASE \"{name}\""))
        .execute(&mut admin)
        .await?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.database(&name))
        .await?;
    let db = Db { pool };
    let result = std::panic::AssertUnwindSafe(run_execution(&db))
        .catch_unwind()
        .await;
    db.pool.close().await;
    sqlx::query(&format!("DROP DATABASE \"{name}\" WITH (FORCE)"))
        .execute(&mut admin)
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
async fn run_execution(db: &Db) -> Result<()> {
    db.init().await?;
    let m = mock().await;
    let mut order = json!({"id":"native-execution","recordId":"test","symbol":"BTCUSDT","interval":"1m","status":"open","direction":"OPEN_LONG","marketProvider":"binance","entry":100.,"quantity":6.,"realizedQty":4.,"margin":500.,"notional":1000.,"leverage":2.,"createdAt":iso(now_ms()),"entryAt":iso(now_ms()),"plan":{"stopLoss":90.,"takeProfit":110.}});
    ensure_links(&mut order);
    order["exchangeSync"]["live"] =
        json!({"executedQty":10.,"status":"filled","clientOrderId":"entry","closeOrders":[]});
    db.mutate_account(|s| {
        s["orders"] = json!([order.clone()]);
        Ok(Value::Null)
    })
    .await?;
    let first = lock_execution(db, "live", "BTCUSDT", "BOTH").await?;
    assert!(lock_execution(db, "live", "BTCUSDT", "BOTH").await.is_err());
    drop(first);
    assert!(
        sync_strategy_exit(db, &m.client, "live", &order, false)
            .await
            .is_err()
    );
    assert_eq!(m.state.lock().unwrap().quantity, 16.);
    sync_strategy_exit(db, &m.client, "live", &order, false).await?;
    sync_strategy_exit(db, &m.client, "live", &order, false).await?;
    assert_eq!(m.state.lock().unwrap().orders.len(), 1);
    // Another strategy still owns ten units. Closing this strategy consumes only its six remaining units.
    order["status"] = json!("closed");
    db.mutate_account(|s| {
        s["orders"][0]["status"] = json!("closed");
        Ok(Value::Null)
    })
    .await?;
    sync_strategy_exit(db, &m.client, "live", &order, false).await?;
    assert_eq!(m.state.lock().unwrap().quantity, 10.);
    sync_strategy_exit(db, &m.client, "live", &order, false).await?;
    assert_eq!(m.state.lock().unwrap().orders.len(), 2);
    db.mutate_order("native-execution", |state| {
        state["orders"][0]["unknownHistory"] = json!({"deep":[1,null,{"original":true}]});
        Ok(Value::Null)
    })
    .await?;
    db.mutate_account_light(|state| {
        state["entriesPaused"] = json!(true);
        Ok(Value::Null)
    })
    .await?;
    assert_eq!(
        db.account(false, Some("native-execution")).await?["orders"][0]["unknownHistory"],
        json!({"deep":[1,null,{"original":true}]})
    );
    // Protection replacement is accepted before deleting the prior working stop.
    let mut second = order.clone();
    second["id"] = json!("native-protection");
    second["status"] = json!("open");
    second["quantity"] = json!(10.);
    second["realizedQty"] = json!(0.);
    second["exchangeSync"]["live"]["closeOrders"] = json!([]);
    db.mutate_account(|s| {
        s["orders"].as_array_mut().unwrap().push(second.clone());
        Ok(Value::Null)
    })
    .await?;
    m.state.lock().unwrap().algos = vec![
        json!({"symbol":"BTCUSDT","positionSide":"BOTH","type":"STOP_MARKET","side":"SELL","triggerPrice":"85","clientAlgoId":"nofx_old","algoId":99}),
    ];
    sync_protection(db, &m.client, "live", &second).await?;
    {
        let r = m.state.lock().unwrap();
        let accepted = r
            .requests
            .iter()
            .position(|(verb, path, _)| verb == "POST" && path == "/fapi/v1/algoOrder")
            .unwrap();
        let cancelled = r
            .requests
            .iter()
            .position(|(verb, path, _)| verb == "DELETE" && path == "/fapi/v1/algoOrder")
            .unwrap();
        assert!(accepted < cancelled);
    }
    m.state.lock().unwrap().mark = 89.;
    sync_protection(db, &m.client, "live", &second).await?;
    assert_eq!(m.state.lock().unwrap().quantity, 0.);
    Ok(())
}
