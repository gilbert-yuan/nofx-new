//! Opt-in PostgreSQL and HTTP verification. Always provisions its own disposable database.
use anyhow::{Context, Result, bail};
use futures::FutureExt;
use nofx_core::{
    db::{Db, PoolConfig},
    iso, now_ms,
};
use reqwest::Client;
use serde_json::{Value, json};
use sqlx::{ConnectOptions, Connection, PgConnection, postgres::PgConnectOptions};
use std::{
    process::{Child, Command, Stdio},
    str::FromStr,
    time::Duration,
};

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn options() -> Result<PgConnectOptions> {
    let _ = dotenvy::from_path(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
    if let Ok(url) = std::env::var("DATABASE_URL") {
        return Ok(PgConnectOptions::from_str(&url)?);
    }
    Ok(PgConnectOptions::new()
        .host(&std::env::var("PGHOST").unwrap_or("127.0.0.1".into()))
        .port(
            std::env::var("PGPORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5432),
        )
        .database(&std::env::var("PGDATABASE").unwrap_or("nofx_lite".into()))
        .username(&std::env::var("PGUSER").unwrap_or("postgres".into()))
        .password(&std::env::var("PGPASSWORD").unwrap_or_default()))
}
async fn request(
    client: &Client,
    base: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
    expected: u16,
) -> Result<Value> {
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes())?,
        format!("{base}{path}"),
    );
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await?;
    let status = response.status().as_u16();
    let body: Value = response.json().await?;
    if status != expected {
        bail!("{method} {path}: expected {expected}, got {status}: {body}");
    }
    Ok(body)
}
#[tokio::test]
#[ignore = "requires local PostgreSQL; creates and removes a dedicated test database"]
async fn isolated_database_and_http_contract() -> Result<()> {
    let options = options()?;
    let mut admin = PgConnection::connect_with(&options)
        .await
        .context("local PostgreSQL connection failed")?;
    let old_columns: Vec<(String,String)> = sqlx::query_as("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'simulated_%'").fetch_all(&mut admin).await?;
    let name = format!("nofx_rust_test_{}", uuid::Uuid::new_v4().simple());
    assert!(
        name.starts_with("nofx_rust_test_")
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    );
    sqlx::query(&format!("CREATE DATABASE \"{name}\""))
        .execute(&mut admin)
        .await?;
    let isolated_options = options.clone().database(&name);
    let result = std::panic::AssertUnwindSafe(async {
        run(&isolated_options).await?;
        let mut native = PgConnection::connect_with(&isolated_options).await?;
        let new_columns: Vec<(String,String)> = sqlx::query_as("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'simulated_%'").fetch_all(&mut native).await?;
        for (table,column) in new_columns {
            if old_columns.iter().any(|(existing,_)|existing==&table) {
                assert!(old_columns.contains(&(table.clone(),column.clone())), "existing table {table} lacks required column {column}");
            }
        }
        Ok::<(),anyhow::Error>(())
    })
        .catch_unwind()
        .await;
    // The target comes only from the generated, validated name. Never drop the configured database.
    sqlx::query(&format!("DROP DATABASE \"{name}\" WITH (FORCE)"))
        .execute(&mut admin)
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
fn spawn_server(root: &std::path::Path, options: &PgConnectOptions, port: u16) -> Result<Server> {
    let log = std::fs::File::create(root.join("server.log"))?;
    Ok(Server(
        Command::new(env!("CARGO_BIN_EXE_nofx-server"))
            .arg("--root")
            .arg(root)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env("DATABASE_URL", options.to_url_lossy().as_str())
            .env("DATA_DIR", root.join("data"))
            .env("NOFX_AUTOSTART", "0")
            .env("NOFX_DB_POOL_MAX_CONNECTIONS", "4")
            .env("NOFX_DB_POOL_MIN_CONNECTIONS", "1")
            .env("NOFX_DB_POOL_ACQUIRE_TIMEOUT_MS", "5000")
            .env("NOFX_DB_POOL_IDLE_TIMEOUT_MS", "0")
            .env("NOFX_DB_POOL_MAX_LIFETIME_MS", "0")
            .env("NOFX_DB_POOL_TEST_BEFORE_ACQUIRE", "true")
            .env("NOFX_DB_LOCK_TIMEOUT_MS", "150")
            .env("NOFX_LONG_ONLY", "false")
            .env("RUST_LOG", "warn")
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?,
    ))
}
async fn wait_ready(
    server: &mut Server,
    client: &Client,
    base: &str,
    root: &std::path::Path,
) -> Result<()> {
    for _ in 0..120 {
        if client
            .get(format!("{base}/api/health"))
            .send()
            .await
            .is_ok()
        {
            return Ok(());
        }
        if server.0.try_wait()?.is_some() {
            bail!(
                "isolated server exited: {}",
                std::fs::read_to_string(root.join("server.log"))?
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    bail!("isolated Rust API did not become ready")
}
async fn verify_pool_contract(options: &PgConnectOptions) -> Result<()> {
    let db = Db::connect_with(
        options.clone(),
        PoolConfig {
            max_connections: 4,
            min_connections: 1,
            acquire_timeout_ms: 1500,
            idle_timeout_ms: 0,
            max_lifetime_ms: 0,
            lock_timeout_ms: 150,
            ..PoolConfig::default()
        },
    )
    .await
    .context("create test database pool")?;
    assert!(db.pool.size() >= 1);
    let mut held = vec![];
    let mut backend_ids = vec![];
    for _ in 0..4 {
        let mut connection = db.pool.acquire().await.context("fill pool to capacity")?;
        let timeout: String = sqlx::query_scalar("SHOW lock_timeout")
            .fetch_one(&mut *connection)
            .await?;
        assert_eq!(timeout, "150ms");
        backend_ids.push(
            sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()")
                .fetch_one(&mut *connection)
                .await?,
        );
        held.push(connection);
    }
    assert_eq!(db.pool_status()["inUse"], 4);
    assert_eq!(db.pool_status()["idle"], 0);
    assert_eq!(db.pool_status()["availableCapacity"], 0);
    let exhausted = tokio::time::timeout(Duration::from_secs(5), db.pool.acquire()).await?;
    assert!(matches!(exhausted, Err(sqlx::Error::PoolTimedOut)));
    let returned_pid = backend_ids.pop().unwrap();
    drop(held.pop());
    let mut reused = db
        .pool
        .acquire()
        .await
        .context("reuse returned connection")?;
    let reused_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *reused)
        .await?;
    assert_eq!(reused_pid, returned_pid);
    backend_ids.push(reused_pid);
    drop(reused);
    drop(held);
    // Only terminate connections obtained from this pool, in the disposable database.
    let mut admin = PgConnection::connect_with(options).await?;
    for pid in &backend_ids {
        sqlx::query("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .execute(&mut admin)
            .await?;
    }
    let mut recovered = db
        .pool
        .acquire()
        .await
        .context("replace terminated connections")?;
    let recovered_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *recovered)
        .await?;
    assert!(!backend_ids.contains(&recovered_pid));
    assert!(db.pool.size() <= 4);
    drop(recovered);
    db.pool.close().await;
    assert_eq!(db.pool_status()["closed"], true);
    assert!(matches!(
        db.pool.acquire().await,
        Err(sqlx::Error::PoolClosed)
    ));
    Ok(())
}

/// The close path reconciles durable execution intents through targeted prefix reads and
/// writes; verify they round-trip exactly like the whole-account path writes them, that a
/// replace fully overwrites, and that neighboring intents stay independent.
async fn verify_manual_execution_round_trip(options: &PgConnectOptions) -> Result<()> {
    let db = Db::connect_with(
        options.clone(),
        PoolConfig {
            max_connections: 4,
            min_connections: 1,
            ..PoolConfig::default()
        },
    )
    .await
    .context("create round-trip test pool")?;
    let key = "nofx-execution:demo:ROUNDTRIPUSDT:BOTH";
    assert!(
        db.manual_execution(key).await?.is_null(),
        "an absent intent must read as null"
    );
    let intent = json!({
        "key": key,
        "id": "action-1",
        "accountKey": "abc",
        "status": "submitting",
        "quantity": 12.5,
        "remainingBefore": 12.5,
        "clientOrderId": "cid-1",
        "createdAt": iso(now_ms()),
        "nested": {"deep": [1, 2, {"flag": true}]}
    });
    db.put_manual_execution(key, &intent).await?;
    let stored = db.manual_execution(key).await?;
    assert_eq!(stored["id"], "action-1");
    assert_eq!(stored["status"], "submitting");
    assert_eq!(stored["quantity"], 12.5);
    assert_eq!(stored["clientOrderId"], "cid-1");
    assert_eq!(stored["nested"]["deep"][2]["flag"], true);
    // A replace must fully overwrite the previous intent, not merge into it.
    let updated = json!({
        "key": key,
        "id": "action-1",
        "accountKey": "abc",
        "status": "filled",
        "executedQty": 12.5,
        "avgPrice": 1.25
    });
    db.put_manual_execution(key, &updated).await?;
    let replaced = db.manual_execution(key).await?;
    assert_eq!(replaced["status"], "filled");
    assert_eq!(replaced["executedQty"], 12.5);
    assert!(
        replaced["clientOrderId"].is_null(),
        "stale fields must not survive a replace: {replaced}"
    );
    // The full-account read must observe the same rows the targeted write produced.
    let state = db.account(true, None).await?;
    assert_eq!(state["manualExecutions"][key]["status"], "filled");
    assert_eq!(state["manualExecutions"][key]["avgPrice"], 1.25);
    // A neighboring intent must coexist without disturbing this one.
    let other = format!("{key}-2");
    db.put_manual_execution(&other, &json!({"key": other, "status": "submitting"}))
        .await?;
    assert_eq!(db.manual_execution(key).await?["status"], "filled");
    assert_eq!(db.manual_execution(&other).await?["status"], "submitting");
    // Exact-path snapshot reads decode the two fields the close validates without
    // hydrating the ~22k accumulated metric rows the full environment subtree carries.
    let before = db.account(false, None).await?;
    let previous = before["exchangeAccounts"].get("demo").cloned();
    db.mutate_account_light(|state| {
        state["exchangeAccounts"]["demo"]["enabled"] = json!(true);
        state["exchangeAccounts"]["demo"]["accountKey"] = json!("probe-account-key");
        Ok(Value::Null)
    })
    .await?;
    let (enabled, key) = db.exchange_snapshot_key("demo").await?;
    assert!(enabled);
    assert_eq!(key, "probe-account-key");
    // Restore the environment: this helper runs before the HTTP contract checks against
    // the same database, and leaving an enabled exchange descendant with no credentials
    // drops syncReady, which makes every later order creation fail with 422.
    db.mutate_account_light(|state| {
        match previous.as_ref().and_then(Value::as_object) {
            Some(previous) => {
                let demo = state["exchangeAccounts"]["demo"]
                    .as_object_mut()
                    .expect("demo subtree");
                for field in ["enabled", "accountKey"] {
                    if let Some(value) = previous.get(field) {
                        demo.insert((*field).to_owned(), value.clone());
                    } else {
                        demo.remove(field);
                    }
                }
            }
            None => {
                state["exchangeAccounts"]
                    .as_object_mut()
                    .expect("exchange subtree")
                    .remove("demo");
            }
        }
        Ok(Value::Null)
    })
    .await?;
    let restored = db.account(false, None).await?;
    for field in ["enabled", "accountKey"] {
        assert_eq!(
            restored["exchangeAccounts"]["demo"][field], before["exchangeAccounts"]["demo"][field],
            "{field} residue would change later contract checks"
        );
    }
    db.pool.close().await;
    Ok(())
}

/// An order-scoped mutate that changes a mapped field must not renumber the archive:
/// project() derives order_position from the hydrated array index, which is 0 for a
/// single-order read, so the persisted positions have to be restored before the diff.
async fn verify_order_scoped_writes(db: &Db) -> Result<()> {
    db.mutate_account(|state| {
        state["orders"] = json!([
            {"id": "probe-order-a", "symbol": "PROBEUSDT", "status": "open"},
            {"id": "probe-order-b", "symbol": "PROBEUSDT", "status": "open"}
        ]);
        Ok(Value::Null)
    })
    .await?;
    db.mutate_order("probe-order-b", |state| {
        state["orders"][0]["error"] = json!("probe");
        Ok(Value::Null)
    })
    .await?;
    let positions: Vec<(String, i32)> = sqlx::query_as(
        "SELECT order_id,order_position FROM simulated_orders WHERE account_id=1 ORDER BY order_position",
    )
    .fetch_all(&db.pool)
    .await?;
    assert_eq!(
        positions,
        vec![
            ("probe-order-a".to_owned(), 0),
            ("probe-order-b".to_owned(), 1)
        ]
    );
    let stored = db.account(false, None).await?;
    assert_eq!(stored["orders"][1]["error"], "probe");
    Ok(())
}

async fn run(options: &PgConnectOptions) -> Result<()> {
    verify_pool_contract(options).await?;
    let root = tempfile::tempdir()?;
    std::fs::create_dir(root.path().join("dist"))?;
    std::fs::write(
        root.path().join("dist/index.html"),
        "<!doctype html><title>Rust isolation test</title>",
    )?;
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = socket.local_addr()?.port();
    drop(socket);
    let mut server = spawn_server(root.path(), options, port)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .no_proxy()
        .build()?;
    let base = format!("http://127.0.0.1:{port}");
    wait_ready(&mut server, &client, &base, root.path()).await?;
    let api: Value = serde_json::from_str(include_str!("../../src/api/contract.json"))?;
    let health = request(
        &client,
        &base,
        "GET",
        api["health"].as_str().unwrap(),
        None,
        200,
    )
    .await?;
    assert_eq!(health["runtime"], "rust");
    assert_eq!(health["databasePool"]["config"]["maxConnections"], 4);
    verify_manual_execution_round_trip(options).await?;
    let pool = request(
        &client,
        &base,
        "GET",
        api["database"]["pool"].as_str().unwrap(),
        None,
        200,
    )
    .await?;
    assert_eq!(pool["config"]["minConnections"], 1);
    assert!(pool["size"].as_u64().unwrap() <= 4);
    assert_eq!(pool["closed"], false);
    let db = Db::from_pool(sqlx::PgPool::connect_with(options.clone()).await?);
    let initial = db.account(false, None).await?;
    let mut blocking = db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(790217)")
        .execute(&mut *blocking)
        .await?;
    let busy = request(
        &client,
        &base,
        "PUT",
        "/api/paper/capital",
        Some(json!({"initialBalance":1234})),
        503,
    )
    .await?;
    assert!(busy["error"].as_str().unwrap().contains("锁等待超时"));
    request(&client, &base, "GET", "/api/database/pool", None, 200).await?;
    request(
        &client,
        &base,
        "POST",
        "/api/automation/tasks/positionReview/trigger",
        Some(json!({})),
        202,
    )
    .await?;
    let mut deferred = false;
    for _ in 0..40 {
        let status = request(&client, &base, "GET", "/api/automation/status", None, 200).await?;
        let task = &status["tasks"]["positionReview"];
        if task["warning"]
            .as_str()
            .is_some_and(|warning| warning.contains("下一轮重试"))
        {
            assert_eq!(task["running"], false);
            assert_eq!(task["error"], "");
            assert!(status["stats"]["errors"].as_array().unwrap().is_empty());
            deferred = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        deferred,
        "transient PostgreSQL lock conflict must defer automation"
    );
    blocking.rollback().await?;
    assert_eq!(initial, db.account(false, None).await?);
    let extension_probe = json!({"emptyObject":{},"emptyArray":[],"list":[true,false,null,"汉字",15,-17,0.125,9007199254740991u64,{},[],"x","y"],"null":null});
    db.mutate_account(|state| {
        state["poolExtensionProbe"] = extension_probe.clone();
        Ok(Value::Null)
    })
    .await?;
    assert_eq!(
        db.account(false, None).await?["poolExtensionProbe"],
        extension_probe
    );
    db.mutate_account_light(|state| {
        state.as_object_mut().unwrap().remove("poolExtensionProbe");
        Ok(Value::Null)
    })
    .await?;
    assert_eq!(initial, db.account(false, None).await?);
    // Public indicator persistence remains causal and never modifies the account.
    let time = (now_ms() - 5 * 86_400_000).div_euclid(60_000) * 60_000;
    let history_samples = vec![nofx_core::indicator_history::Sample {
        kind: "oi5m".into(),
        observed_at: time,
        available_at: time + 300_000,
        origin: "historical-rest".into(),
        data: json!({"timestamp":time,"sumOpenInterest":"100","sumOpenInterestValue":"10000"}),
    }];
    assert_eq!(
        db.save_indicator_samples("BTCUSDT", &history_samples)
            .await?,
        1
    );
    assert_eq!(
        db.save_indicator_samples("BTCUSDT", &history_samples)
            .await?,
        0
    );
    let loaded = db
        .indicator_samples("BTCUSDT", time - 1, time + 600_000)
        .await?;
    assert_eq!(loaded.len(), 1);
    assert!(
        nofx_core::indicator_history::context("BTCUSDT", &loaded, time + 60_000)["oi5m"].is_null()
    );
    assert_eq!(initial, db.account(false, None).await?);
    assert!(!initial["fusedPoolStartedAt"].is_null());
    assert_eq!(initial["unlimitedCapital"], false);
    let config=request(&client,&base,"PUT",api["config"]["put"].as_str().unwrap(),Some(json!({"binance":{"apiKey":"test-secret","apiSecret":"test-secret"},"trader":{"syncPaperOrdersToDemo":false,"syncPaperOrdersToLive":false}})),200).await?;
    assert!(!config.to_string().contains("test-secret"));
    let strategies = request(
        &client,
        &base,
        "GET",
        api["strategies"]["base"].as_str().unwrap(),
        None,
        200,
    )
    .await?;
    assert_eq!(strategies["strategies"].as_array().unwrap().len(), 1);
    assert_eq!(
        strategies["strategies"][0]["id"],
        "altcoin-trend-breakout-live-v1"
    );
    let current = request(
        &client,
        &base,
        "GET",
        "/api/strategies/altcoin-trend-breakout-live-v1",
        None,
        200,
    )
    .await?;
    assert_eq!(current["id"], "altcoin-trend-breakout-live-v1");
    assert_eq!(current["params"]["emaFast"], 25);
    assert_eq!(current["params"]["emaSlow"], 75);
    assert_eq!(current["params"]["channelPeriod"], 8);
    let updated = request(
        &client,
        &base,
        "PUT",
        "/api/strategies/altcoin-trend-breakout-live-v1",
        Some(
            json!({"enabled":false,"params":{"emaFast":26},"notes":"native strategy persistence"}),
        ),
        200,
    )
    .await?;
    assert_eq!(updated["params"]["emaFast"], 26);
    assert_eq!(updated["params"]["emaSlow"], 75);
    assert_eq!(updated["enabled"], false);
    let persisted_strategy = request(
        &client,
        &base,
        "GET",
        "/api/strategies/altcoin-trend-breakout-live-v1",
        None,
        200,
    )
    .await?;
    assert_eq!(persisted_strategy["params"], updated["params"]);
    assert_eq!(persisted_strategy["notes"], "native strategy persistence");
    let opportunities = request(
        &client,
        &base,
        "GET",
        "/api/automation/opportunities",
        None,
        200,
    )
    .await?;
    assert!(opportunities["asOf"].is_null());
    assert_eq!(opportunities["analysis"]["phase"], "idle");
    for path in [
        "/api/paper/account",
        "/api/paper/statistics",
        api["paper"]["dailyTrend"].as_str().unwrap(),
        api["stats"]["base"].as_str().unwrap(),
        api["binance"]["status"].as_str().unwrap(),
        api["config"]["get"].as_str().unwrap(),
        api["market"]["status"].as_str().unwrap(),
        "/api/automation/status",
        "/api/automation/opportunities",
        api["history"]["summary"].as_str().unwrap(),
        api["history"]["syncStatus"].as_str().unwrap(),
        "/api/analyses",
        "/api/adaptive/config",
    ] {
        request(&client, &base, "GET", path, None, 200).await?;
    }
    request(&client, &base, "GET", "/api/not-a-route", None, 404).await?;
    for (method, path) in [
        ("GET", "/api/strategy"),
        ("PUT", "/api/strategy"),
        ("POST", "/api/research/backtest"),
        ("GET", "/api/ml/health"),
        ("GET", "/api/ml/models"),
        ("POST", "/api/ml/signal"),
        ("POST", "/api/ml/pipeline"),
        ("GET", "/api/automation/yao-coins"),
        ("GET", "/api/strategies/martin-luk-pullback-v1"),
    ] {
        request(&client, &base, method, path, Some(json!({})), 404).await?;
    }
    request(
        &client,
        &base,
        "PUT",
        "/api/adaptive/config",
        Some(json!({"symbolFilter":{"minWinRate":2}})),
        422,
    )
    .await?;
    request(
        &client,
        &base,
        "POST",
        api["market"]["flowAnalysis"].as_str().unwrap(),
        Some(json!({"datasets":{"1h":"bad"}})),
        400,
    )
    .await?;
    request(
        &client,
        &base,
        "POST",
        api["market"]["flowAnalysis"].as_str().unwrap(),
        Some(json!({"symbol":"TEST","datasets":{"1h":[]}})),
        200,
    )
    .await?;
    request(
        &client,
        &base,
        "PUT",
        "/api/paper/capital",
        Some(json!({"initialBalance":1000})),
        200,
    )
    .await?;
    let now = now_ms();
    // A manually frozen plan exercises generic order persistence without running signal analysis.
    let record = json!({"id":"rust-http-record","at":iso(now),"marketProvider":"binance","strategyId":"altcoin-trend-breakout-live-v1","strategyVersion":"test-native","analysisEngine":"manual_frozen_fixture","scope":{"interval":"1m"},"snapshot":{"costs":{"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3}},"analyses":[{"symbol":"BTCUSDT","interval":"1m","marketProvider":"binance","strategyId":"altcoin-trend-breakout-live-v1","positionRecommendation":"OPEN_LONG","eligible":true,"firstEntryAt":iso((now.div_euclid(60000)+1)*60000),"expiresAt":iso(now+86400000),"confidence":0.8,"plan":{"entryMin":99,"entryMax":100,"entryLimit":99.5,"stopLoss":90,"takeProfit":110,"maxHoldBars":30}}]});
    db.save_record(&record).await?;
    let original_persisted = db.record("rust-http-record").await?.unwrap();
    let mut enriched = record["analyses"][0].clone();
    enriched["opportunityReport"] = json!({"indicators":{"mode":"advisory","source":"binance"}});
    let market_context =
        json!({"symbol":"BTCUSDT","collectedAt":iso(now),"premium":{"time":now},"errors":{}});
    db.record_market_context("rust-http-record", &enriched, &market_context)
        .await?;
    let persisted = db.record("rust-http-record").await?.unwrap();
    assert_eq!(persisted["at"], record["at"]);
    assert_eq!(persisted["snapshot"], original_persisted["snapshot"]);
    assert_eq!(persisted["analyses"][0]["eligible"], true);
    assert_eq!(persisted["marketContext"], market_context);
    assert_eq!(
        persisted["analyses"][0]["opportunityReport"]["indicators"]["mode"],
        "advisory"
    );
    request(
        &client,
        &base,
        "GET",
        "/api/market/indicators?symbol=INVALID",
        None,
        400,
    )
    .await?;
    request(
        &client,
        &base,
        "GET",
        "/api/market/indicators?symbol=BTCUSDT&interval=bad",
        None,
        400,
    )
    .await?;
    let order=request(&client,&base,"POST","/api/paper/orders",Some(json!({"recordId":"rust-http-record","symbol":"BTCUSDT","strategyId":"altcoin-trend-breakout-live-v1","margin":10,"leverage":2})),200).await?;
    assert_eq!(order["status"], "pending");
    let probe_id = order["id"].as_str().unwrap();
    db.mutate_order(probe_id, |state| {
        state["orders"][0]["poolExtensionProbe"] = extension_probe.clone();
        Ok(Value::Null)
    })
    .await?;
    assert_eq!(
        db.account(false, Some(probe_id)).await?["orders"][0]["poolExtensionProbe"],
        extension_probe
    );
    let same=request(&client,&base,"POST","/api/paper/orders",Some(json!({"recordId":"rust-http-record","symbol":"BTCUSDT","strategyId":"altcoin-trend-breakout-live-v1","margin":10,"leverage":2})),200).await?;
    assert_eq!(order["id"], same["id"]);
    db.mutate_account(|state| {
        let o = state["orders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|o| o["id"] == order["id"])
            .unwrap();
        o["nativeTestExtension"] = json!({"array":[1,null,true,{"value":"nested"}],"emptyArray":[],"emptyObject":{},"indices":(0..12).map(|i|json!({"value":i})).collect::<Vec<_>>(),"unknown":null});
        Ok(Value::Null)
    })
    .await?;
    let stored = db.account(false, None).await?;
    let extension = &stored["orders"][0]["nativeTestExtension"];
    assert_eq!(
        extension["array"],
        json!([1, null, true, {"value":"nested"}])
    );
    assert_eq!(extension["emptyArray"], json!([]));
    assert_eq!(extension["emptyObject"], json!({}));
    for i in 0..12 {
        assert_eq!(extension["indices"][i]["value"], json!(i));
    }
    request(
        &client,
        &base,
        "POST",
        &format!("/api/paper/orders/{}/close", order["id"].as_str().unwrap()),
        Some(json!({})),
        200,
    )
    .await?;
    assert_eq!(
        db.account(false, None).await?["orders"][0]["status"],
        "cancelled"
    );
    let mut closed = order.clone();
    closed["id"] = json!("rust-closed-record");
    closed["status"] = json!("closed");
    closed["createdAt"] = json!("2026-10-07T15:55:00.000Z");
    closed["entryAt"] = json!("2026-10-07T16:00:00.000Z");
    closed["exitAt"] = json!("2026-10-07T16:10:00.000Z");
    closed["net"] = json!(5.);
    closed["gross"] = json!(6.);
    closed["fees"] = json!(0.8);
    closed["funding"] = json!(0.2);
    closed["reason"] = json!("trailing_stop");
    db.mutate_account(|state| {
        state["orders"].as_array_mut().unwrap().push(closed);
        Ok(Value::Null)
    })
    .await?;
    let trend = request(&client, &base, "GET", "/api/paper/daily-trend", None, 200).await?;
    assert!(trend.to_string().contains("2026-10-08"));
    let stats = request(&client, &base, "GET", "/api/strategy-stats", None, 200).await?;
    assert!(stats.to_string().contains("altcoin-trend-breakout-live-v1"));
    let static_response = client
        .get(format!("{base}/nested/frontend/route"))
        .send()
        .await?;
    assert_eq!(static_response.status(), 200);
    assert!(
        static_response
            .text()
            .await?
            .contains("Rust isolation test")
    );
    // Restart initialization must preserve historical orders and the existing pool timestamp.
    db.mutate_account_light(|state| {
        state["unlimitedCapital"] = json!(true);
        Ok(Value::Null)
    })
    .await?;
    let mut expected = db.account(false, None).await?;
    expected["unlimitedCapital"] = json!(false);
    drop(server);
    server = spawn_server(root.path(), options, port)?;
    wait_ready(&mut server, &client, &base, root.path()).await?;
    assert_eq!(db.account(false, None).await?, expected);

    // A legacy null timestamp is filled once without changing nested order extensions.
    sqlx::query("UPDATE simulated_account_extensions SET value_kind='null',text_value=NULL WHERE account_id=1 AND path=ARRAY['fusedPoolStartedAt']::text[]")
        .execute(&db.pool)
        .await?;
    drop(server);
    server = spawn_server(root.path(), options, port)?;
    wait_ready(&mut server, &client, &base, root.path()).await?;
    let initialized = db.account(false, None).await?;
    assert!(initialized["fusedPoolStartedAt"].is_string());
    expected["fusedPoolStartedAt"] = initialized["fusedPoolStartedAt"].clone();
    assert_eq!(initialized, expected);
    verify_order_scoped_writes(&db).await?;
    db.pool.close().await;
    drop(server);
    Ok(())
}
