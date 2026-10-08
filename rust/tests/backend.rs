//! Opt-in PostgreSQL and HTTP verification. Always provisions its own disposable database.
use anyhow::{Context, Result, bail};
use futures::FutureExt;
use nofx_core::{db::Db, iso, now_ms};
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
async fn run(options: &PgConnectOptions) -> Result<()> {
    let root = tempfile::tempdir()?;
    std::fs::create_dir(root.path().join("dist"))?;
    std::fs::write(
        root.path().join("dist/index.html"),
        "<!doctype html><title>Rust isolation test</title>",
    )?;
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = socket.local_addr()?.port();
    drop(socket);
    let log = std::fs::File::create(root.path().join("server.log"))?;
    let mut server = Server(
        Command::new(env!("CARGO_BIN_EXE_nofx-server"))
            .arg("--root")
            .arg(root.path())
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .env("DATABASE_URL", options.to_url_lossy().as_str())
            .env("DATA_DIR", root.path().join("data"))
            .env("NOFX_AUTOSTART", "0")
            .env("NOFX_LONG_ONLY", "false")
            .env("RUST_LOG", "warn")
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?,
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(8))
        .no_proxy()
        .build()?;
    let base = format!("http://127.0.0.1:{port}");
    let mut ready = false;
    for _ in 0..120 {
        if client
            .get(format!("{base}/api/health"))
            .send()
            .await
            .is_ok()
        {
            ready = true;
            break;
        }
        if server.0.try_wait()?.is_some() {
            bail!(
                "isolated server exited: {}",
                std::fs::read_to_string(root.path().join("server.log"))?
            );
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if !ready {
        bail!("isolated Rust API did not become ready");
    }
    let health = request(&client, &base, "GET", "/api/health", None, 200).await?;
    assert_eq!(health["runtime"], "rust");
    let db = Db {
        pool: sqlx::PgPool::connect_with(options.clone()).await?,
    };
    let initial = db.account(false, None).await?;
    assert!(!initial["fusedPoolStartedAt"].is_null());
    assert_eq!(initial["unlimitedCapital"], false);
    let config=request(&client,&base,"PUT","/api/config",Some(json!({"model":{"apiKey":"test-secret"},"trader":{"syncPaperOrdersToDemo":false,"syncPaperOrdersToLive":false}})),200).await?;
    assert!(!config.to_string().contains("test-secret"));
    let strategies = request(&client, &base, "GET", "/api/strategies", None, 200).await?;
    assert_eq!(strategies["strategies"].as_array().unwrap().len(), 7);
    for path in [
        "/api/paper/account",
        "/api/paper/statistics",
        "/api/paper/daily-trend",
        "/api/strategy-stats",
        "/api/automation/status",
        "/api/automation/opportunities",
        "/api/automation/yao-coins",
        "/api/history/summary",
        "/api/analyses",
        "/api/adaptive/config",
    ] {
        request(&client, &base, "GET", path, None, 200).await?;
    }
    request(&client, &base, "GET", "/api/not-a-route", None, 404).await?;
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
        "/api/market/flow-analysis",
        Some(json!({"datasets":{"1h":"bad"}})),
        400,
    )
    .await?;
    request(
        &client,
        &base,
        "POST",
        "/api/market/flow-analysis",
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
    let record = json!({"id":"rust-http-record","at":iso(now),"marketProvider":"binance","strategyId":"enhanced-trend-v1","strategyVersion":"test-native","analysisEngine":"local","scope":{"interval":"1m"},"snapshot":{"costs":{"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3}},"analyses":[{"symbol":"BTCUSDT","interval":"1m","marketProvider":"binance","strategyId":"enhanced-trend-v1","positionRecommendation":"OPEN_LONG","eligible":true,"firstEntryAt":iso((now.div_euclid(60000)+1)*60000),"expiresAt":iso(now+86400000),"confidence":0.8,"plan":{"entryMin":99,"entryMax":100,"entryLimit":99.5,"stopLoss":90,"takeProfit":110,"maxHoldBars":30}}]});
    db.save_record(&record).await?;
    let order=request(&client,&base,"POST","/api/paper/orders",Some(json!({"recordId":"rust-http-record","symbol":"BTCUSDT","strategyId":"enhanced-trend-v1","margin":10,"leverage":2})),200).await?;
    assert_eq!(order["status"], "pending");
    let same=request(&client,&base,"POST","/api/paper/orders",Some(json!({"recordId":"rust-http-record","symbol":"BTCUSDT","strategyId":"enhanced-trend-v1","margin":10,"leverage":2})),200).await?;
    assert_eq!(order["id"], same["id"]);
    db.mutate_account(|state| {
        let o = state["orders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|o| o["id"] == order["id"])
            .unwrap();
        o["nativeTestExtension"] = json!({"array":[1,null,true,{"value":"nested"}],"unknown":null});
        Ok(Value::Null)
    })
    .await?;
    let stored = db.account(false, None).await?;
    assert_eq!(
        stored["orders"][0]["nativeTestExtension"],
        json!({"array":[1,null,true,{"value":"nested"}],"unknown":null})
    );
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
    assert!(stats.to_string().contains("enhanced-trend-v1"));
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
    db.pool.close().await;
    drop(server);
    Ok(())
}
