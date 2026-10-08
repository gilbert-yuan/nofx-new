use super::*;
use axum::{Json, Router, extract::Query, http::StatusCode, routing::get};
use futures::FutureExt;
use sqlx::{Connection, PgConnection, postgres::PgConnectOptions};
use std::str::FromStr;

async fn exchange_info() -> Json<Value> {
    Json(
        json!({"symbols":(["LOWUSDT","NORMALUSDT","NEWUSDT","BROKENUSDT"].map(|symbol|json!({
            "symbol":symbol,"status":"TRADING","contractType":"PERPETUAL",
            "baseAsset":symbol.trim_end_matches("USDT"),"quoteAsset":"USDT","marginAsset":"USDT","filters":[]
        })))}),
    )
}

async fn klines(Query(query): Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    if query["symbol"] == "INCREMENTALUSDT" {
        assert_eq!(
            query["limit"], "3",
            "one missing bar only needs an incremental request"
        );
    }
    if query["symbol"] == "BROKENUSDT" {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"msg":"fixture unavailable"})),
        );
    }
    let interval = &query["interval"];
    let duration = interval_ms(interval).unwrap();
    let current = research::candle_open(now_ms(), interval).unwrap();
    let count = if query["symbol"] == "NEWUSDT" {
        4
    } else {
        query["limit"].parse::<usize>().unwrap()
    };
    let rows: Vec<Value> = (0..count)
        .map(|i| {
            let open = current - (count - i - 1) as i64 * duration;
            json!([
                open,
                "100",
                "101",
                "99",
                "100",
                "10",
                open + duration - 1,
                "1000",
                2,
                "5",
                "500"
            ])
        })
        .collect();
    (StatusCode::OK, Json(json!(rows)))
}

async fn low_volume_tickers() -> Json<Value> {
    Json(json!(
        ["LOWUSDT", "NORMALUSDT", "NEWUSDT", "BROKENUSDT"]
            .map(|symbol| if symbol == "NORMALUSDT" {
                json!({"symbol":symbol,"quoteVolume":"100000000","lastPrice":"160","openPrice":"100","highPrice":"180","lowPrice":"98","priceChangePercent":"60"})
            } else {
                json!({"symbol":symbol,"quoteVolume":"0"})
            })
    ))
}

#[tokio::test]
#[ignore = "requires local PostgreSQL; creates a disposable database and uses a fake exchange"]
async fn all_timeframes_persist_before_trading_filters() -> Result<()> {
    let _ = dotenvy::from_path(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
    let options = if let Ok(url) = std::env::var("DATABASE_URL") {
        PgConnectOptions::from_str(&url)?
    } else {
        PgConnectOptions::new()
            .host(&std::env::var("PGHOST").unwrap_or("127.0.0.1".into()))
            .port(
                std::env::var("PGPORT")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(5432),
            )
            .database(&std::env::var("PGDATABASE").unwrap_or("nofx_lite".into()))
            .username(&std::env::var("PGUSER").unwrap_or("postgres".into()))
            .password(&std::env::var("PGPASSWORD").unwrap_or_default())
    };
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("nofx_rust_test_{}", uuid::Uuid::new_v4().simple());
    assert!(
        name.starts_with("nofx_rust_test_")
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    );
    sqlx::query(&format!("CREATE DATABASE \"{name}\""))
        .execute(&mut admin)
        .await?;
    let db = Db {
        pool: sqlx::PgPool::connect_with(options.database(&name)).await?,
    };
    let result = std::panic::AssertUnwindSafe(run(&db)).catch_unwind().await;
    db.pool.close().await;
    sqlx::query(&format!("DROP DATABASE \"{name}\" WITH (FORCE)"))
        .execute(&mut admin)
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn run(db: &Db) -> Result<()> {
    db.init().await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let router = Router::new()
        .route("/fapi/v1/exchangeInfo", get(exchange_info))
        .route("/fapi/v1/klines", get(klines))
        .route("/fapi/v1/ticker/24hr", get(low_volume_tickers));
    let mock = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let root = tempfile::tempdir()?;
    let store = Store::new(root.path().join("data")).await?;
    store
        .write("strategies", &json!({"initialized":true,"strategies":{}}))
        .await?;
    let automation = Automation::new(db.clone(), store, Exchange::test_endpoint(&base));
    let result = automation.execute("klineSync").await?;
    assert_eq!(result["sync"]["total"], 4);
    assert_eq!(result["sync"]["completed"], 3);
    assert_eq!(result["sync"]["failed"], 1);
    assert_eq!(result["submitted"], 0);
    for symbol in ["LOWUSDT", "NORMALUSDT", "NEWUSDT"] {
        for interval in SYNC_INTERVALS {
            let rows = db
                .candles(&format!("BINANCE_{symbol}"), interval, 1000, None, None)
                .await?;
            assert!(
                !rows.is_empty(),
                "{symbol}/{interval} must be persisted even when excluded from trading"
            );
            assert!(rows.iter().all(|r| r["openTime"].as_i64().unwrap()
                < research::candle_open(now_ms(), interval).unwrap()));
            if symbol == "NEWUSDT" {
                assert_eq!(rows.len(), 3);
            }
        }
    }
    assert!(
        research::fresh_market(db, &automation.market, "NEWUSDT", "15m", 80)
            .await
            .is_err()
    );
    assert_eq!(
        db.candles("BINANCE_NEWUSDT", "15m", 1000, None, None)
            .await?
            .len(),
        3
    );
    let status = automation.sync_status().await?;
    assert_eq!(status["busy"], false);
    assert_eq!(status["progress"]["completed"], 3);
    assert_eq!(status["progress"]["failed"], 1);
    let states = status["states"].as_array().unwrap();
    assert_eq!(states.len(), 24);
    assert_eq!(
        states.iter().filter(|s| s["lastStatus"] == "error").count(),
        6
    );
    let history = db
        .candles("BINANCE_NORMALUSDT", "1m", 80, None, None)
        .await?;
    let older: Vec<Value> = history
        .iter()
        .cloned()
        .map(|mut candle| {
            candle["openTime"] = json!(candle["openTime"].as_i64().unwrap() - 60_000);
            candle
        })
        .collect();
    db.save_klines("BINANCE_INCREMENTALUSDT", "1m", &older)
        .await?;
    let incremental =
        research::fresh_market(db, &automation.market, "INCREMENTALUSDT", "1m", 80).await?;
    assert_eq!(incremental["klines"].as_array().unwrap().len(), 80);
    assert_eq!(
        timestamp(&incremental["dataAsOf"]),
        Some(research::candle_open(now_ms(), "1m")?)
    );
    assert!(
        db.account(true, None).await?["orders"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    automation
        .store
        .update("config", |config| {
            config["marketSync"]["dataOnly"] = json!(true);
            config["trader"]["enabled"] = json!(true);
            config["trader"]["dryRun"] = json!(false);
            config["trader"]["allowEntryOrders"] = json!(true);
            config["trader"]["syncPaperOrdersToDemo"] = json!(true);
            Ok(())
        })
        .await?;
    automation
        .store
        .write("strategies", &json!({"initialized":false}))
        .await?;
    let data_only = automation.execute("klineSync").await?;
    assert_eq!(data_only["dataOnly"], true);
    assert_eq!(data_only["reportsOnly"], true);
    assert!(data_only["analyzed"].as_u64().unwrap() > 0);
    assert_eq!(data_only["submitted"], 0);
    let reports = automation.status().await?;
    assert_eq!(reports["analysisMeta"]["phase"], "ready");
    assert_eq!(reports["analysisMeta"]["readOnly"], true);
    assert!(reports["opportunitiesAt"].is_string());
    assert!(reports["yaoCoinsAt"].is_string());
    assert_eq!(reports["yaoCoins"][0]["symbol"], "NORMALUSDT");
    assert_eq!(reports["yaoCoins"][0]["stage"], "TRIGGERED");
    assert!(reports["yaoCoins"][0]["current"]["price"].as_f64().unwrap() > 0.);
    assert_eq!(reports["stats"]["totalOrders"], 0.);
    assert!(
        db.account(true, None).await?["orders"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(db.records("", "", 100, 0, false).await?.is_empty());
    mock.abort();
    // A fresh cache remains usable when the exchange goes offline.
    research::fresh_market(db, &automation.market, "NORMALUSDT", "1d", 80).await?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let banned_router = Router::new().fallback(|| async {
        (
            StatusCode::IM_A_TEAPOT,
            Json(json!({"code":-1003,"msg":format!("IP banned until {}.", now_ms() + 120_000)})),
        )
    });
    let banned_mock = tokio::spawn(async move {
        axum::serve(listener, banned_router).await.unwrap();
    });
    let cached_automation = Automation::new(
        db.clone(),
        Store::new(root.path().join("data")).await?,
        Exchange::test_endpoint(&base),
    );
    sqlx::query("DELETE FROM market_klines WHERE symbol='BINANCE_NORMALUSDT' AND interval='1m' AND open_time=(SELECT MAX(open_time) FROM market_klines WHERE symbol='BINANCE_NORMALUSDT' AND interval='1m')").execute(&db.pool).await?;
    assert!(
        research::display_market(db, &cached_automation.market, "NORMALUSDT", "1m", 80, false)
            .await
            .is_err()
    );
    let display =
        research::display_market(db, &cached_automation.market, "NORMALUSDT", "1m", 80, true)
            .await?;
    assert_eq!(display["cacheOnly"], true);
    assert!(timestamp(&display["dataAsOf"]).unwrap() < research::candle_open(now_ms(), "1m")?);
    let fallback = cached_automation.execute("klineSync").await?;
    assert_eq!(fallback["reportsOnly"], true);
    assert_eq!(fallback["submitted"], 0);
    let reports = cached_automation.status().await?;
    assert_eq!(reports["analysisMeta"]["phase"], "ready");
    assert!(reports["analysisMeta"]["marketReady"].as_u64().unwrap() > 0);
    assert!(
        reports["analysisMeta"]["marketWarning"]
            .as_str()
            .unwrap()
            .contains("不可用")
    );
    assert!(db.records("", "", 100, 0, false).await?.is_empty());
    assert!(
        db.account(true, None).await?["orders"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    banned_mock.abort();
    Ok(())
}
