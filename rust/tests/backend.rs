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
    let db = Db {
        pool: sqlx::PgPool::connect_with(options.clone()).await?,
    };
    let initial = db.account(false, None).await?;
    // Historical research must never modify the real simulated account.
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
    let empty=request(&client,&base,"POST",api["research"]["backtest"].as_str().unwrap(),Some(json!({"symbol":"BTCUSDT","strategyId":"enhanced-trend-v1","startTime":time,"endTime":time+3_600_000})),400).await?;
    assert!(empty["error"].as_str().unwrap().contains("历史"));
    for tf in ["1m", "15m"] {
        let dt = if tf == "1m" { 60_000 } else { 900_000 };
        let start = time.div_euclid(dt) * dt;
        let rows:Vec<_>=(-1600..120).map(|i|json!({"openTime":start+i*dt,"open":100.,"high":101.,"low":99.,"close":100.,"volume":1000.,"quoteVolume":100000.,"tradeCount":100,"takerBuyQuoteVolume":60000.,"closeTime":start+(i+1)*dt-1})).collect();
        db.save_klines("BINANCE_BTCUSDT", tf, &rows).await?;
    }
    let replay=request(&client,&base,"POST",api["research"]["backtest"].as_str().unwrap(),Some(json!({"symbol":"BTCUSDT","strategyId":"enhanced-trend-v1","startTime":time,"endTime":time+3_600_000,"grid":{"marketFlowEnabled":[false,true]}})),200).await?;
    assert_eq!(replay["researchOnly"], true);
    assert_eq!(replay["combinations"].as_array().unwrap().len(), 2);
    assert!(replay["baseline"]["training"]["analyzed"].as_u64().unwrap() > 0);
    assert_eq!(initial, db.account(false, None).await?);
    verify_campaign_resume(options, &db, time).await?;
    assert_eq!(initial, db.account(false, None).await?);
    assert!(!initial["fusedPoolStartedAt"].is_null());
    assert_eq!(initial["unlimitedCapital"], false);
    let config=request(&client,&base,"PUT",api["config"]["put"].as_str().unwrap(),Some(json!({"model":{"apiKey":"test-secret"},"trader":{"syncPaperOrdersToDemo":false,"syncPaperOrdersToLive":false}})),200).await?;
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
    assert_eq!(strategies["strategies"].as_array().unwrap().len(), 7);
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
    let predictions = request(
        &client,
        &base,
        "GET",
        "/api/automation/yao-coins",
        None,
        200,
    )
    .await?;
    assert!(predictions["asOf"].is_null());
    assert_eq!(predictions["analysis"]["phase"], "idle");
    for path in [
        "/api/paper/account",
        "/api/paper/statistics",
        api["paper"]["dailyTrend"].as_str().unwrap(),
        api["stats"]["base"].as_str().unwrap(),
        api["binance"]["status"].as_str().unwrap(),
        api["config"]["get"].as_str().unwrap(),
        api["strategy"]["get"].as_str().unwrap(),
        api["market"]["status"].as_str().unwrap(),
        "/api/automation/status",
        "/api/automation/opportunities",
        "/api/automation/yao-coins",
        api["history"]["summary"].as_str().unwrap(),
        api["history"]["syncStatus"].as_str().unwrap(),
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
    let record = json!({"id":"rust-http-record","at":iso(now),"marketProvider":"binance","strategyId":"enhanced-trend-v1","strategyVersion":"test-native","analysisEngine":"local","scope":{"interval":"1m"},"snapshot":{"costs":{"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3}},"analyses":[{"symbol":"BTCUSDT","interval":"1m","marketProvider":"binance","strategyId":"enhanced-trend-v1","positionRecommendation":"OPEN_LONG","eligible":true,"firstEntryAt":iso((now.div_euclid(60000)+1)*60000),"expiresAt":iso(now+86400000),"confidence":0.8,"plan":{"entryMin":99,"entryMax":100,"entryLimit":99.5,"stopLoss":90,"takeProfit":110,"maxHoldBars":30}}]});
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
    db.pool.close().await;
    drop(server);
    Ok(())
}

async fn verify_campaign_resume(options: &PgConnectOptions, db: &Db, start: i64) -> Result<()> {
    use nofx_core::{backtest, campaign, strategies};
    let root = tempfile::tempdir()?;
    let directory = root.path().join("research");
    let id = "enhanced-trend-v1";
    let base = strategies::defaults(id);
    let settings = json!({"maxTrials":2,"seed":7,"initialBalance":1000,
        "optimization":{"minTrades":10,"minValidationTrades":5,"minTradingSymbols":1}});
    campaign::write_json(&root.path().join("settings.json"), &settings)?;
    campaign::write_json(
        &root.path().join("ecosystem.config.json"),
        &json!({"apps":[{"env":{}}]}),
    )?;
    let manifest = json!({"startTime":start,"endTime":start+3_600_000,
        "engineVersion":campaign::engine_version(),"environment":campaign::environment_snapshot(),
        "strategies":{id:{"params":base,"space":campaign::search_space(id,&base)?}},
        "symbols":["BTCUSDT"],"config":{"trader":{"minConfidence":0.65,"maxLeverage":5}},
        "adaptive":{},"settings":settings});
    campaign::write_json(&directory.join("manifest.json"), &manifest)?;
    let history = backtest::load_history(db, "BTCUSDT", id, start, start + 3_600_000).await?;
    campaign::write_json(
        &directory.join("data/BTCUSDT.json"),
        &serde_json::to_value(history)?,
    )?;
    let command = || -> Result<()> {
        let result = Command::new(env!("CARGO_BIN_EXE_nofx-campaign"))
            .args([
                "--root",
                root.path().to_str().unwrap(),
                "--campaign",
                "settings.json",
                "--output",
                "research",
                "--max-units",
                "1",
            ])
            .env("DATABASE_URL", options.to_url_lossy().as_str())
            .output()?;
        if !result.status.success() {
            bail!(
                "campaign CLI failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        Ok(())
    };
    command()?;
    let first = directory.join("trials/0000-enhanced-trend-v1-BTCUSDT.json");
    let before = std::fs::read(&first)?;
    assert_eq!(
        campaign::read_json(&directory.join("summary.json"))?["completedUnits"],
        1
    );
    command()?;
    assert_eq!(
        std::fs::read(&first)?,
        before,
        "resume must never replace completed trials"
    );
    assert_eq!(
        campaign::read_json(&directory.join("summary.json"))?["completedUnits"],
        2
    );
    Ok(())
}
