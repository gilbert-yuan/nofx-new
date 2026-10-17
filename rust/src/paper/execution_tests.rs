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
    /// Scripted rejections for POST /fapi/v1/algoOrder, consumed front to back. Anything
    /// left over after the script is empty is accepted normally.
    algo_reject: Vec<(StatusCode, Value)>,
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
        algo_reject: vec![],
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
            if r.algo_reject.is_empty() {
                let mut algo = p.clone();
                algo["algoId"] = json!(r.algos.len() + 1);
                r.algos.push(algo.clone());
                algo
            } else {
                let (code, body) = r.algo_reject.remove(0);
                status = code;
                body
            }
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
    let db = Db::from_pool(pool);
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
    assert!(
        try_lock_execution(db, "live", "BTCUSDT", "BOTH")
            .await?
            .is_none(),
        "a held slot must report as unavailable rather than error out"
    );
    // A user-initiated close waits for the slot instead of returning 409 straight away, but the
    // wait must still be bounded so a stuck holder cannot hang the request forever.
    assert!(
        lock_execution_wait(
            db,
            "live",
            "BTCUSDT",
            "BOTH",
            std::time::Duration::from_millis(400)
        )
        .await
        .is_err(),
        "waiting must time out while the holder keeps the slot"
    );
    drop(first);
    let handed_over = lock_execution_wait(
        db,
        "live",
        "BTCUSDT",
        "BOTH",
        std::time::Duration::from_millis(400),
    )
    .await;
    assert!(
        handed_over.is_ok(),
        "the slot must be handed over once the previous holder releases it"
    );
    drop(handed_over);
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

    // A clientAlgoId the exchange still reserves must not block protection forever.
    let mut fallback = json!({"id":"native-fallback","recordId":"test","symbol":"BTCUSDT","interval":"1m","status":"open","direction":"OPEN_LONG","marketProvider":"binance","entry":100.,"quantity":10.,"realizedQty":0.,"margin":500.,"notional":1000.,"leverage":2.,"createdAt":iso(now_ms()),"entryAt":iso(now_ms()),"plan":{"stopLoss":90.,"takeProfit":110.}});
    ensure_links(&mut fallback);
    fallback["exchangeSync"]["live"] =
        json!({"executedQty":10.,"status":"filled","clientOrderId":"entry","closeOrders":[]});
    db.mutate_account(|s| {
        s["orders"].as_array_mut().unwrap().push(fallback.clone());
        Ok(Value::Null)
    })
    .await?;
    let base = client_id("protect", &["live", "native-fallback", "stopLoss", "90"]);
    {
        let mut r = m.state.lock().unwrap();
        r.quantity = 10.;
        r.mark = 100.;
        r.algos.clear();
        r.algo_reject = vec![(
            StatusCode::BAD_REQUEST,
            json!({"code":-4116,"msg":"ClientOrderId is duplicated."}),
        )];
    }
    let before = m.state.lock().unwrap().requests.len();
    sync_protection(db, &m.client, "live", &fallback).await?;
    let attempts: Vec<String> = {
        let r = m.state.lock().unwrap();
        r.requests[before..]
            .iter()
            .filter(|(verb, path, p)| {
                verb == "POST" && path == "/fapi/v1/algoOrder" && p["type"] == "STOP_MARKET"
            })
            .map(|(_, _, p)| p["clientAlgoId"].as_str().unwrap_or("").to_owned())
            .collect()
    };
    assert_eq!(
        attempts.len(),
        2,
        "a duplicate must be retried exactly once, never looped"
    );
    assert_eq!(attempts[0], base);
    assert_ne!(
        attempts[1], base,
        "a burned client ID must be rotated so the replacement can land"
    );
    let stored = db.account(false, Some("native-fallback")).await?;
    assert_eq!(
        stored["orders"][0]["exchangeSync"]["live"]["protection"]["stopLoss"]["status"],
        json!("submitted"),
        "rotation must leave a real exchange-side stop, not a silent fallback"
    );

    // An exhausted conditional-order quota degrades to the in-process stop, not a hard error.
    let mut quota = fallback.clone();
    quota["id"] = json!("native-quota");
    db.mutate_account(|s| {
        s["orders"].as_array_mut().unwrap().push(quota.clone());
        Ok(Value::Null)
    })
    .await?;
    {
        let mut r = m.state.lock().unwrap();
        r.quantity = 10.;
        r.mark = 100.;
        r.algos.clear();
        r.algo_reject = vec![
            (
                StatusCode::BAD_REQUEST,
                json!({"code":-4045,"msg":"Reach max stop order limit."}),
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({"code":-4045,"msg":"Reach max stop order limit."}),
            ),
        ];
    }
    sync_protection(db, &m.client, "live", &quota).await?;
    let stored = db.account(false, Some("native-quota")).await?;
    let protection = &stored["orders"][0]["exchangeSync"]["live"]["protection"];
    assert_eq!(protection["stopLoss"]["status"], json!("local"));
    assert_eq!(protection["takeProfit"]["status"], json!("local"));
    assert_eq!(
        stored["orders"][0]["exchangeSync"]["live"]["protectionError"],
        json!(""),
        "a documented fallback must not keep reporting as a hard error"
    );
    assert_eq!(
        m.state.lock().unwrap().quantity,
        10.,
        "degrading protection must never touch the position"
    );
    Ok(())
}

#[test]
fn unaccepted_entries_release_their_reservation_after_the_ttl() {
    let created = 1_700_000_000_000i64;
    let order = json!({"status":"open","createdAt":iso(created),"entry":0.,
        "exchange":{"status":"not_submitted"}});
    assert!(!abandon_stale_entry(&order, created + 60 * 60_000));
    assert!(abandon_stale_entry(&order, created + 121 * 60_000));

    let ghost = json!({"status":"open","createdAt":iso(created),"entry":100.,
        "exchange":{"status":"not_submitted","executedQty":0.}});
    assert!(
        abandon_stale_entry(&ghost, created + 10 * 60 * 60_000),
        "a local fill without exchange execution is a ghost reservation"
    );

    let executed = json!({"status":"open","createdAt":iso(created),"entry":100.,
        "exchange":{"status":"not_submitted","executedQty":10.}});
    assert!(
        !abandon_stale_entry(&executed, created + 10 * 60 * 60_000),
        "an order the exchange actually filled must keep its reservation"
    );

    let working = json!({"status":"open","createdAt":iso(created),"entry":0.,
        "exchange":{"status":"new"}});
    assert!(
        !abandon_stale_entry(&working, created + 10 * 60 * 60_000),
        "an order still pending at the exchange must keep its reservation"
    );
}

// These strings are copied verbatim from rows that failed in production, so the
// classifiers are pinned to what Binance actually returned rather than to a guess.
fn binance(message: &str) -> anyhow::Error {
    anyhow::anyhow!("{}", message)
}
#[test]
fn vanished_orders_count_as_already_cancelled() {
    // -2011 arrives as plain text with no numeric code, which is exactly why matching on
    // the code alone let every one of the 45 historical cancels abort the close.
    assert!(missing_order(&binance("Binance 400: Unknown order sent.")));
    assert!(missing_order(&binance(
        "Binance 400: Unknown order sent. (code -2011)"
    )));
    assert!(missing_order(&binance(
        "Binance HTTP 400: Order does not exist. (code -2013)"
    )));
    assert!(!missing_order(&binance(
        "Binance HTTP 400: Invalid symbol. (code -1121)"
    )));
    assert!(!missing_order(&binance(
        "error sending request for url (https://demo-fapi.binance.com)"
    )));
}
#[test]
fn duplicate_protection_ids_are_adopted_not_failed() {
    assert!(duplicate_order(&binance(
        "Binance HTTP 400: ClientOrderId is duplicated. (code -4116)"
    )));
    assert!(!duplicate_order(&binance(
        "Binance 400: Unknown order sent."
    )));
    assert!(!duplicate_order(&binance(
        "Binance HTTP 400: Reach max stop order limit. (code -4045)"
    )));
}
#[test]
fn exhausted_protection_quota_degrades_to_local_instead_of_failing() {
    assert!(protection_quota_exhausted(&binance(
        "Binance HTTP 400: Reach max stop order limit. (code -4045)"
    )));
    assert!(!protection_quota_exhausted(&binance(
        "Binance HTTP 400: ClientOrderId is duplicated. (code -4116)"
    )));
}
#[test]
fn retry_backoff_starts_on_the_next_sweep_and_caps_at_five_minutes() {
    let now = 1_700_000_000_000_i64;
    let mut link = json!({});
    let mut delays = vec![];
    for _ in 0..8 {
        let patch = retry_patch(&link, now);
        let at = timestamp(&patch["retryAt"]).expect("retryAt must be an ISO timestamp");
        delays.push(at - now);
        // The window must actually hold the order back, then release it exactly on time.
        assert!(
            !retry_due(&patch, now),
            "a fresh failure must not retry instantly"
        );
        assert!(!retry_due(&patch, now + delays[delays.len() - 1] - 1));
        assert!(retry_due(&patch, now + delays[delays.len() - 1]));
        link = patch;
    }
    assert_eq!(
        delays,
        vec![
            15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000
        ],
        "first retry must stay on the next 15s sweep so recovery never slows down, then decay"
    );
    assert_eq!(n(&link, "retryCount", 0.), 8.);
    assert!(
        retry_due(&json!({}), now),
        "a never-failed order is always due"
    );
    assert!(retry_due(&json!({"retryAt":null}), now));
}
#[test]
fn refresh_freshness_window_expires() {
    LAST_REFRESH_AT.store(0, Ordering::Relaxed);
    assert!(
        !refresh_recent(),
        "a process that has never refreshed must not look fresh"
    );
    LAST_REFRESH_AT.store(now_ms(), Ordering::Relaxed);
    assert!(refresh_recent(), "a just-finished refresh is fresh");
    LAST_REFRESH_AT.store(now_ms() - REFRESH_MAX_AGE_MS - 1, Ordering::Relaxed);
    assert!(
        !refresh_recent(),
        "an aged snapshot must force the next user request to refresh for real"
    );
    LAST_REFRESH_AT.store(0, Ordering::Relaxed);
}
