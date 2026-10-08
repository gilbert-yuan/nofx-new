use crate::{
    automation::Automation,
    db::Db,
    exchange::{Exchange, is_demo, storage_symbol, strip_symbol},
    interval_ms, iso, now_ms, number, research,
    store::{Store, masked, merge},
    strategies, timestamp,
};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::{Mutex, Semaphore};
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

struct App {
    db: Db,
    store: Store,
    market: Exchange,
    automation: Arc<Automation>,
    contracts: Mutex<(i64, Vec<Value>, String)>,
    analysis_gate: Semaphore,
    performance_gate: Semaphore,
}
pub async fn serve(root: PathBuf, host: String, port: u16) -> Result<()> {
    let data = std::env::var("DATA_DIR").unwrap_or("data".into());
    let store = Store::new(root.join(data)).await?;
    let db = Db::connect().await?;
    let market = Exchange::public()?;
    let automation = Automation::new(db.clone(), store.clone(), market.clone());
    let app = Arc::new(App {
        db,
        store,
        market,
        automation: automation.clone(),
        contracts: Mutex::new((0, vec![], String::new())),
        analysis_gate: Semaphore::new(1),
        performance_gate: Semaphore::new(1),
    });
    let cors = if let Ok(origin) = std::env::var("CORS_ORIGIN") {
        CorsLayer::new()
            .allow_origin(origin.parse::<axum::http::HeaderValue>()?)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        CorsLayer::new()
            .allow_origin("http://127.0.0.1:5173".parse::<axum::http::HeaderValue>()?)
            .allow_methods(Any)
            .allow_headers(Any)
    };
    let router = Router::new()
        .route("/api/{*path}", any(handle))
        .route("/api", any(handle))
        .fallback_service(
            ServeDir::new(root.join("dist")).fallback(ServeFile::new(root.join("dist/index.html"))),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(app);
    let autostart = std::env::var("NOFX_AUTOSTART")
        .map(|s| !matches!(s.to_lowercase().as_str(), "0" | "false" | "no"))
        .unwrap_or(true);
    if autostart {
        let a = automation.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if let Err(e) = a.start().await {
                tracing::error!(%e,"Automation startup failed");
            }
        });
    }
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    tracing::info!(%host,port,"NOFX native Rust API ready");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            automation.stop();
        })
        .await?;
    Ok(())
}
async fn handle(
    State(app): State<Arc<App>>,
    method: Method,
    uri: Uri,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let input: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"请求体必须是有效 JSON"})),
                )
                    .into_response();
            }
        }
    };
    if !input.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"请求体必须是 JSON 对象"})),
        )
            .into_response();
    }
    match dispatch(&app, method.as_str(), uri.path(), &query, &input).await {
        Ok((status, value)) => (status, Json(value)).into_response(),
        Err(error) => {
            let detail = error.to_string();
            let status = if detail.starts_with("404:") {
                StatusCode::NOT_FOUND
            } else if detail.starts_with("409:") {
                StatusCode::CONFLICT
            } else if detail.starts_with("400:") {
                StatusCode::BAD_REQUEST
            } else if detail.contains("Binance HTTP")
                || detail.contains("error sending request")
                || detail.contains("无法取得行情")
            {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::UNPROCESSABLE_ENTITY
            };
            tracing::warn!(path=uri.path(),%detail,"API request failed");
            (status,Json(json!({"error":detail.trim_start_matches("404:").trim_start_matches("409:").trim_start_matches("400:")}))).into_response()
        }
    }
}
fn q<'a>(query: &'a HashMap<String, String>, key: &str, fallback: &'a str) -> &'a str {
    query.get(key).map(String::as_str).unwrap_or(fallback)
}
fn qn(query: &HashMap<String, String>, key: &str, fallback: f64, min: f64, max: f64) -> f64 {
    query
        .get(key)
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
        .floor()
        .clamp(min, max)
}
fn ok(value: Value) -> Result<(StatusCode, Value)> {
    Ok((StatusCode::OK, value))
}
async fn dispatch(
    app: &Arc<App>,
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    input: &Value,
) -> Result<(StatusCode, Value)> {
    match (method, path) {
        ("GET", "/api/health") => {
            return ok(
                json!({"ok":true,"name":"nofx-lite","runtime":"rust","version":env!("CARGO_PKG_VERSION")}),
            );
        }
        ("GET", "/api/config") => return ok(masked(&app.store.read("config").await?)),
        ("PUT", "/api/config") => {
            let next = app
                .store
                .update("config", |c| {
                    *c = merge(c, input);
                    Ok(())
                })
                .await?;
            if input["marketSync"].is_object() {
                app.automation.configure("klineSync",&json!({"enabled":next["marketSync"]["enabled"]!=false,"interval":number(&next["marketSync"]["intervalSeconds"],60.).max(30.)*1000.})).await?;
            }
            return ok(masked(&next));
        }
        ("GET", "/api/strategy") => return ok(app.store.read("strategy").await?),
        ("PUT", "/api/strategy") => {
            let interval = input["interval"].as_str().unwrap_or("15m");
            interval_ms(interval).context("不支持的周期")?;
            let symbols = research::symbols(input);
            let strategy = json!({"name":input["name"].as_str().unwrap_or("Binance strategy"),"symbols":if symbols.is_empty(){vec!["BTCUSDT".to_owned(),"ETHUSDT".to_owned()]}else{symbols},"interval":interval,"klineLimit":number(&input["klineLimit"],80.).clamp(20.,1000.),"systemPrompt":input["systemPrompt"].as_str().or(input["systemPrompt"]["content"].as_str()).unwrap_or(""),"rules":input["rules"].as_str().or(input["rules"]["content"].as_str()).or(input["rules"]["rules"].as_str()).unwrap_or("")});
            app.store.write("strategy", &strategy).await?;
            return ok(strategy);
        }
        ("GET", "/api/strategies") => {
            return ok(strategies::list(
                &app.store.read("config").await?,
                &app.store.read("strategies").await?,
            ));
        }
        ("GET", "/api/market/symbols") => {
            let contracts = contracts(app, false).await?;
            let search = q(query, "search", "").trim().to_uppercase();
            return ok(json!(
                contracts
                    .into_iter()
                    .filter(|s| s["symbol"].as_str().unwrap_or("").contains(&search)
                        || s["baseCoin"].as_str().unwrap_or("").contains(&search))
                    .take(qn(query, "limit", 2000., 1., 2000.) as usize)
                    .collect::<Vec<_>>()
            ));
        }
        ("POST", "/api/market/symbols/refresh") => {
            let symbols = contracts(app, true).await?;
            let mut status = market_status(app).await;
            status["symbols"] = json!(symbols);
            return ok(status);
        }
        ("GET", "/api/market/symbols/status") => return ok(market_status(app).await),
        ("GET", "/api/market/klines") => {
            let symbol = strip_symbol(q(query, "symbol", "BTCUSDT")).to_uppercase();
            let interval = q(query, "interval", "15m");
            let end = query
                .get("endTime")
                .map(|s| s.parse::<i64>())
                .transpose()
                .context("400: 请选择有效日期")?;
            if end.is_some_and(|t| t < 0 || t > now_ms()) {
                bail!("400: 请选择不晚于当前时间的有效日期");
            }
            let rows = app
                .market
                .klines(
                    &symbol,
                    interval,
                    qn(query, "limit", 80., 20., 200.) as usize,
                    None,
                    end,
                )
                .await?;
            app.db
                .save_klines(
                    &storage_symbol(&symbol, "binance")?,
                    interval,
                    &rows
                        .iter()
                        .filter(|r| r["confirmed"] != false)
                        .cloned()
                        .collect::<Vec<_>>(),
                )
                .await?;
            return ok(
                json!({"symbol":symbol,"interval":interval,"rows":rows,"provider":"binance"}),
            );
        }
        ("GET", "/api/history/klines") => {
            let symbol = q(query, "symbol", "BTCUSDT").to_uppercase();
            let interval = q(query, "interval", "15m");
            let rows = app
                .db
                .candles(
                    &storage_symbol(&symbol, "binance")?,
                    interval,
                    qn(query, "limit", 300., 1., 1000.) as i64,
                    None,
                    None,
                )
                .await?;
            return ok(json!({"symbol":symbol,"interval":interval,"rows":rows}));
        }
        ("GET", "/api/history/summary") => return ok(app.db.summary().await?),
        ("POST", "/api/history/fetch") => return ok(app.automation.fetch_history(input).await?),
        ("GET", "/api/history/sync/status") => return ok(app.automation.sync_status().await?),
        ("POST", "/api/history/sync/start") | ("POST", "/api/history/sync/stop") => {
            let on = path.ends_with("start");
            app.store
                .update("config", |c| {
                    c["marketSync"]["enabled"] = json!(on);
                    Ok(())
                })
                .await?;
            app.automation
                .configure("klineSync", &json!({"enabled":on}))
                .await?;
            if on {
                app.automation.start().await?;
            }
            return ok(app.automation.sync_status().await?);
        }
        ("GET", "/api/market/flow-analysis") => return ok(flow_live(app, query).await?),
        ("POST", "/api/market/flow-analysis") => {
            let mut flow = input.clone();
            if !flow["datasets"].is_object() {
                bail!("400: 请提供按周期分组的 K线数据");
            }
            let mut valid = false;
            for interval in ["1m", "5m", "1h", "1d"] {
                if let Some(rows) = flow["datasets"].get(interval) {
                    if !rows.is_array() || rows.as_array().unwrap().len() > 500 {
                        bail!("400: {interval} 数据必须是最多500根的K线数组");
                    }
                    valid = true;
                }
            }
            if !valid {
                bail!("400: 导入数据需要包含1m、5m、1h或1d周期");
            }
            flow["source"] = json!({"kind":"import","assetClass":input["assetClass"].as_str().unwrap_or("other"),"label":"导入历史行情"});
            return ok(crate::flow::analyze(&flow));
        }
        ("POST", "/api/market/analyze")
        | ("POST", "/api/market/analyze-range")
        | ("POST", "/api/market/analyze-all") => {
            let _permit = app
                .analysis_gate
                .try_acquire()
                .context("409: 已有分析任务运行")?;
            let kind = if path.ends_with("analyze-all") {
                "all"
            } else if path.ends_with("analyze-range") {
                "range"
            } else {
                "single"
            };
            return ok(research::analyze(&app.db, &app.store, &app.market, kind, input).await?);
        }
        ("GET", "/api/analyses") => {
            return ok(json!(
                app.db
                    .records(
                        q(query, "date", ""),
                        q(query, "symbol", ""),
                        qn(query, "limit", 100., 1., 100.) as i64,
                        qn(query, "offset", 0., 0., 10_000_000.) as i64,
                        false
                    )
                    .await?
            ));
        }
        ("GET", "/api/research/performance") | ("POST", "/api/research/performance/refresh") => {
            let _permit = app
                .performance_gate
                .try_acquire()
                .context("409: 模拟行情正在同步")?;
            return ok(performance(app, query, method == "POST").await?);
        }
        ("GET", "/api/automation/status") => return ok(app.automation.status().await?),
        ("GET", "/api/automation/opportunities") => {
            let state = app.automation.state.lock().await;
            return ok(
                json!({"asOf":iso(now_ms()),"opportunities":state["opportunities"].as_array().unwrap().iter().take(qn(query,"limit",20.,1.,50.)as usize).collect::<Vec<_>>()}),
            );
        }
        ("GET", "/api/automation/yao-coins") => {
            let state = app.automation.state.lock().await;
            return ok(
                json!({"asOf":state["yaoCoinsAt"],"targetAmplitudePct":50,"candidates":state["yaoCoins"].as_array().unwrap().iter().take(qn(query,"limit",20.,1.,50.)as usize).collect::<Vec<_>>(),"error":state["yaoCoinError"]}),
            );
        }
        ("POST", "/api/automation/start") => {
            app.automation.start().await?;
            return ok(json!({"message":"全局自动化系统已启动"}));
        }
        ("POST", "/api/automation/stop") => {
            app.automation.stop();
            return ok(json!({"message":"全局自动化系统已停止"}));
        }
        ("GET", "/api/paper/account") => return ok(crate::paper::status(&app.db).await?),
        ("GET", "/api/paper/plans") => {
            let records = app.db.records("", "", 100, 0, false).await?;
            return ok(json!(
                records
                    .iter()
                    .flat_map(|r| r["analyses"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|s| s["eligible"] == true && s["marketProvider"] == "binance")
                        .map(|s| {
                            let mut v = s.clone();
                            v["recordId"] = r["id"].clone();
                            v["at"] = r["at"].clone();
                            v
                        }))
                    .collect::<Vec<_>>()
            ));
        }
        ("POST", "/api/paper/orders") => {
            return ok(crate::paper::submit(&app.db, &app.store, input).await?);
        }
        ("POST", "/api/paper/refresh") => {
            return ok(crate::paper::refresh(&app.db, &app.store).await?);
        }
        ("POST", "/api/paper/exchange-refresh") => {
            return ok(crate::paper::exchange_refresh(&app.db, &app.store).await?);
        }
        ("POST", "/api/paper/close-all") => {
            return ok(crate::paper::close_all(&app.db, &app.store).await?);
        }
        ("PUT", "/api/paper/capital") => {
            let capital = number(&input["initialBalance"], f64::NAN);
            if !capital.is_finite() || !(1. ..=1_000_000.).contains(&capital) {
                bail!("初始金额须为1～1000000 USDT");
            }
            app.db
                .mutate_account(|s| {
                    s["initialBalance"] = json!(capital);
                    s["unlimitedCapital"] = json!(
                        input["unlimitedCapital"] == true && s["fusedPoolStartedAt"].is_null()
                    );
                    Ok(json!({"initialBalance":capital,"unlimitedCapital":s["unlimitedCapital"]}))
                })
                .await?;
            return ok(crate::paper::status(&app.db).await?);
        }
        ("PUT", "/api/paper/entries-paused") => {
            let paused = input["paused"].as_bool().context("paused 必须是布尔值")?;
            app.db
                .mutate_account(|s| {
                    s["entriesPaused"] = json!(paused);
                    Ok(json!({"entriesPaused":paused}))
                })
                .await?;
            return ok(crate::paper::status(&app.db).await?);
        }
        ("GET", "/api/paper/statistics") => {
            return ok(crate::analytics::statistics(
                &app.db.account(false, None).await?,
            ));
        }
        ("GET", "/api/paper/daily-trend") | ("POST", "/api/paper/daily-trend") => {
            let mut result: Value = sqlx::query_scalar(include_str!("../sql/daily_trend.sql"))
                .fetch_one(&app.db.pool)
                .await?;
            result["generatedAt"] = json!(iso(now_ms()));
            result["source"] = json!("sql");
            return ok(result);
        }
        ("GET", "/api/strategy-stats") => {
            return ok(strategy_stats(app, q(query, "granularity", "day")).await?);
        }
        ("GET", "/api/binance/status") => {
            let config = app.store.read("config").await?;
            let demo = is_demo(&config["binance"]);
            return ok(
                json!({"enabled":config["trader"]["enabled"],"busy":false,"lastRunAt":app.store.read("state").await?["lastRunAt"],"lastError":"","demo":demo,"testnet":demo,"environment":if demo{"demo"}else{"live"}}),
            );
        }
        ("POST", "/api/binance/test") => {
            let client = trade_client(app, None).await?;
            let empty = json!({});
            let (account, positions, mode) = tokio::try_join!(
                client.signed("GET", "/fapi/v2/account", &empty),
                client.signed("GET", "/fapi/v2/positionRisk", &empty),
                client.signed("GET", "/fapi/v1/positionSide/dual", &empty)
            )?;
            return ok(
                json!({"ok":true,"demo":client.demo,"testnet":client.demo,"environment":if client.demo{"demo"}else{"live"},"totalEquity":number(&account["totalWalletBalance"],0.),"activePositions":positions.as_array().context("持仓返回格式错误")?.iter().filter(|p|number(&p["positionAmt"],0.).abs()>0.).count(),"positionMode":if mode["dualSidePosition"]==true{"hedge"}else{"one-way"}}),
            );
        }
        ("POST", "/api/binance/review") => {
            return ok(app.automation.execute("positionReview").await?);
        }
        ("GET", "/api/binance/openOrders") => {
            let client = trade_client(app, None).await?;
            return ok(
                json!({"ok":true,"orders":client.signed("GET","/fapi/v1/openOrders",&json!({"symbol":query.get("symbol")})).await?}),
            );
        }
        ("GET", "/api/binance/positions") => {
            let client = trade_client(app, None).await?;
            let params = json!({"symbol":query.get("symbol")});
            let empty = json!({});
            let (positions, mode) = tokio::try_join!(
                client.signed("GET", "/fapi/v2/positionRisk", &params),
                client.signed("GET", "/fapi/v1/positionSide/dual", &empty)
            )?;
            return ok(
                json!({"ok":true,"positions":positions.as_array().context("持仓返回格式错误")?.iter().filter(|p|number(&p["positionAmt"],0.).abs()>0.).collect::<Vec<_>>(),"positionMode":if mode["dualSidePosition"]==true{"hedge"}else{"one-way"}}),
            );
        }
        ("GET", "/api/binance/orderDetail") => {
            let env = q(query, "environment", "");
            if !matches!(env, "demo" | "live") {
                bail!("environment 必须为demo或live");
            }
            let symbol = q(query, "symbol", "");
            crate::exchange::valid_symbol(symbol)?;
            if query.get("orderId").is_none() && query.get("clientOrderId").is_none() {
                bail!("必须提供 orderId 或 clientOrderId");
            }
            let client = trade_client(app, Some(env)).await?;
            let remote=client.signed("GET","/fapi/v1/order",&json!({"symbol":symbol,"orderId":query.get("orderId"),"origClientOrderId":query.get("clientOrderId")})).await?;
            return ok(json!({"ok":true,"environment":env,"order":remote}));
        }
        ("POST", "/api/binance/order") => {
            return ok(crate::paper::place_exchange_order(&app.db, &app.store, input).await?);
        }
        ("DELETE", "/api/binance/order") => {
            return ok(crate::paper::cancel_exchange_order(&app.db, &app.store, input).await?);
        }
        ("GET", "/api/binance/trades") => return ok(trades(app, query).await?),
        ("GET", "/api/binance/spot-demo/orders") => return ok(spot_orders(app, query).await?),
        ("POST", "/api/binance/smoke") => return ok(smoke(app, input).await?),
        _ => {}
    }
    if path.starts_with("/api/paper/automation") {
        return Ok((
            StatusCode::GONE,
            json!({"error":"Use /api/automation/tasks/klineSync or /api/automation/tasks/positionReview."}),
        ));
    }
    if let Some(tail) = path.strip_prefix("/api/strategies/") {
        let reset = tail.ends_with("/reset");
        let id = tail.trim_end_matches("/reset");
        let all = strategies::list(
            &app.store.read("config").await?,
            &app.store.read("strategies").await?,
        );
        let current = all["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .context("404: 策略不存在")?
            .clone();
        if method == "GET" && !reset {
            return ok(current);
        }
        if method == "PUT" || method == "POST" && reset {
            if input.get("expectedParams").is_some() && input["expectedParams"] != current["params"]
            {
                bail!("409: 策略参数已变更，请重新验证后再应用");
            }
            if !reset
                && !input["enabled"].is_boolean()
                && !input["params"].is_object()
                && !input["notes"].is_string()
                && input.get("notes") != Some(&Value::Null)
            {
                bail!("400: 请求体需包含 enabled、params 或 notes");
            }
            let resolution = if reset {
                json!({"params":strategies::defaults(id),"rejected":[]})
            } else {
                let mut overrides = current["params"].clone();
                if let Some(params) = input["params"].as_object() {
                    overrides.as_object_mut().unwrap().extend(params.clone());
                }
                strategies::resolve_params(id, &overrides)?
            };
            let stored=app.store.update("strategies",|s|{if !s["strategies"].is_object(){s["strategies"]=json!({});}s["initialized"]=json!(true);let mut item=json!({"enabled":input["enabled"].as_bool().unwrap_or(current["enabled"]==true),"params":resolution["params"],"notes":input["notes"].as_str().unwrap_or(current["notes"].as_str().unwrap_or(""))});if input.get("notes")==Some(&Value::Null){item["notes"]=json!("");}s["strategies"][id]=item;s["updatedAt"]=json!(iso(now_ms()));Ok(())}).await?;
            let list = strategies::list(&app.store.read("config").await?, &stored);
            let mut item = list["strategies"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == id)
                .unwrap()
                .clone();
            item["rejected"] = resolution["rejected"].clone();
            return ok(item);
        }
    }
    if method == "GET"
        && let Some(id) = path.strip_prefix("/api/analyses/")
    {
        return ok(app.db.record(id).await?.context("404: 未找到该分析记录")?);
    }
    if let Some(tail) = path.strip_prefix("/api/automation/tasks/") {
        let kind = tail.trim_end_matches("/trigger");
        if method == "PUT" && !tail.ends_with("/trigger") {
            return ok(app.automation.configure(kind, input).await?);
        }
        if method == "POST" && tail.ends_with("/trigger") {
            app.automation.trigger(kind).await?;
            return Ok((
                StatusCode::ACCEPTED,
                json!({"message":"任务已提交","task":kind}),
            ));
        }
    }
    if let Some(tail) = path.strip_prefix("/api/paper/orders/") {
        if method == "POST" && tail.ends_with("/close") {
            return ok(
                crate::paper::close(&app.db, &app.store, tail.trim_end_matches("/close")).await?,
            );
        }
        if method == "GET" {
            let id = tail.trim_end_matches("/replay");
            let state = app.db.account(false, Some(id)).await?;
            let order = state["orders"]
                .as_array()
                .and_then(|s| s.first())
                .context("404: 订单不存在")?;
            if tail.ends_with("/replay") {
                return ok(replay(app, order).await?);
            }
            return ok(order.clone());
        }
    }
    if let Some(tail) = path.strip_prefix("/api/paper/activity/")
        && method == "POST"
        && tail.ends_with("/close")
    {
        return ok(
            crate::paper::close(&app.db, &app.store, tail.trim_end_matches("/close")).await?,
        );
    }
    if path.starts_with("/api/adaptive/") {
        return adaptive(app, method, path, query, input).await;
    }
    if matches!(
        path,
        "/api/paper/optimize"
            | "/api/paper/strategy/optimize"
            | "/api/paper/strategy/apply-optimization"
            | "/api/paper/orders/replay-batch"
    ) {
        return optimization(app, method, path, query, input).await;
    }
    bail!("404: API接口不存在")
}
async fn contracts(app: &App, refresh: bool) -> Result<Vec<Value>> {
    let current = app.contracts.lock().await.clone();
    if !refresh && !current.1.is_empty() && now_ms() - current.0 < 3_600_000 {
        return Ok(current.1);
    }
    match app.market.contracts().await {
        Ok(rows) => {
            *app.contracts.lock().await = (now_ms(), rows.clone(), String::new());
            Ok(rows)
        }
        Err(e) => {
            app.contracts.lock().await.2 = e.to_string();
            Err(e)
        }
    }
}
async fn market_status(app: &App) -> Value {
    let cache = app.contracts.lock().await;
    json!({"provider":"binance","marketType":"futures","count":cache.1.len(),"updatedAt":if cache.0>0{Some(iso(cache.0))}else{None},"busy":false,"lastError":cache.2})
}
async fn trade_client(app: &App, env: Option<&str>) -> Result<Exchange> {
    let config = app.store.read("config").await?;
    let environment = env.unwrap_or(if is_demo(&config["binance"]) {
        "demo"
    } else {
        "live"
    });
    let client = Exchange::new(&config, environment)?;
    if !client.credentials() {
        bail!("请先配置 Binance {environment} API Key / Secret Key");
    }
    Ok(client)
}
async fn flow_live(app: &App, query: &HashMap<String, String>) -> Result<Value> {
    let symbol = q(query, "symbol", "BTCUSDT").to_uppercase();
    let limit = qn(query, "limit", 200., 30., 500.) as usize;
    let params = query
        .get("params")
        .map(|v| serde_json::from_str::<Value>(v))
        .transpose()
        .context("400: 分析参数格式无效")?
        .unwrap_or(json!({}));
    let mut datasets = json!({});
    let mut warnings = vec![];
    let futures = ["1m", "5m", "1h", "1d"].map(|interval| {
        let symbol = &symbol;
        async move {
            (
                interval,
                app.market.klines(symbol, interval, limit, None, None).await,
            )
        }
    });
    for (interval, result) in futures::future::join_all(futures).await {
        match result {
            Ok(rows) => datasets[interval] = json!(rows),
            Err(e) => warnings.push(format!("{interval} 数据不可用：{e}")),
        }
    }
    if datasets.as_object().unwrap().is_empty() {
        bail!("无法取得行情数据");
    }
    Ok(crate::flow::analyze(
        &json!({"symbol":symbol,"primaryInterval":q(query,"interval","1h"),"datasets":datasets,"params":params,"source":{"kind":"live","provider":"binance","marketType":"futures","label":"币安U本位永续"},"dataWarnings":warnings}),
    ))
}
async fn performance(app: &App, query: &HashMap<String, String>, refresh: bool) -> Result<Value> {
    let records = app
        .db
        .records(q(query, "date", ""), q(query, "symbol", ""), 501, 0, true)
        .await?;
    let mut items = vec![];
    let mut errors = vec![];
    let mut excluded = 0;
    let now = now_ms();
    for record in records.iter().take(500) {
        for signal in record["analyses"].as_array().into_iter().flatten() {
            if !q(query, "symbol", "").is_empty() && signal["symbol"] != q(query, "symbol", "") {
                continue;
            }
            if signal["eligible"] != true
                || !record["snapshot"]["costs"].is_object()
                || record["snapshot"]["exchange"] != "binance"
            {
                excluded += 1;
                continue;
            }
            let symbol = signal["symbol"].as_str().unwrap_or("");
            let interval = signal["interval"].as_str().unwrap_or("15m");
            let provider = record["snapshot"]["marketProvider"]
                .as_str()
                .unwrap_or("binance");
            let start = timestamp(&signal["firstEntryAt"]).unwrap_or(now);
            if refresh
                && provider == "binance"
                && let Err(e) = fetch_continuous(app, symbol, interval, start, now).await
            {
                errors.push(format!("{symbol}: {e}"));
            }
            let rows = app
                .db
                .candles(
                    &storage_symbol(symbol, provider)?,
                    interval,
                    10_000_000,
                    Some(start),
                    Some(now),
                )
                .await?;
            let mut input = signal.clone();
            input["costs"] = record["snapshot"]["costs"].clone();
            let evaluation = crate::simulator::evaluate(&input, &rows, now, &json!({}))?;
            items.push(json!({"id":format!("{}:{symbol}",record["id"].as_str().unwrap_or("")),"recordId":record["id"],"symbol":symbol,"interval":interval,"direction":signal["positionRecommendation"],"strategyVersion":record["strategyVersion"],"at":record["at"],"confidence":signal["confidence"],"costs":record["snapshot"]["costs"],"evaluation":evaluation}));
        }
    }
    let summary = performance_summary(&items);
    let group = |field: &str| {
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for i in &items {
            groups
                .entry(i[field].as_str().unwrap_or("unknown").to_owned())
                .or_default()
                .push(i.clone());
        }
        groups
            .into_iter()
            .map(|(key, rows)| {
                let mut s = performance_summary(&rows);
                s["key"] = json!(key);
                s
            })
            .collect::<Vec<_>>()
    };
    Ok(
        json!({"asOf":iso(now),"records":records.len().min(500),"truncated":records.len()>500,"excluded":excluded,"summary":summary,"byStrategy":group("strategyVersion"),"bySymbol":group("symbol"),"byDirection":group("direction"),"items":items,"errors":errors}),
    )
}
fn performance_summary(items: &[Value]) -> Value {
    let closed: Vec<&Value> = items
        .iter()
        .filter(|i| i["evaluation"]["status"] == "closed")
        .collect();
    let wins = closed
        .iter()
        .filter(|i| number(&i["evaluation"]["net"], 0.) > 0.)
        .count();
    let net = closed
        .iter()
        .map(|i| number(&i["evaluation"]["net"], 0.))
        .sum::<f64>();
    json!({"total":items.len(),"closed":closed.len(),"wins":wins,"winRate":if closed.is_empty(){0.}else{wins as f64/closed.len()as f64},"net":net,"fees":closed.iter().map(|i|number(&i["evaluation"]["fees"],0.)).sum::<f64>(),"funding":closed.iter().map(|i|number(&i["evaluation"]["funding"],0.)).sum::<f64>(),"open":items.iter().filter(|i|i["evaluation"]["status"]=="open").count(),"pending":items.iter().filter(|i|i["evaluation"]["status"]=="pending").count(),"dataGap":items.iter().filter(|i|i["evaluation"]["status"]=="data_gap").count()})
}
async fn fetch_continuous(
    app: &App,
    symbol: &str,
    interval: &str,
    start: i64,
    end: i64,
) -> Result<()> {
    let duration = interval_ms(interval).context("不支持的周期")?;
    let mut cursor = start;
    while cursor < end {
        let rows = app
            .market
            .klines(symbol, interval, 1000, Some(cursor), Some(end))
            .await?;
        let closed: Vec<Value> = rows
            .into_iter()
            .filter(|r| r["confirmed"] != false)
            .collect();
        if closed.is_empty() {
            break;
        }
        let next = number(&closed.last().unwrap()["openTime"], 0.) as i64 + duration;
        if next <= cursor {
            bail!("行情分页未推进");
        }
        app.db
            .save_klines(&storage_symbol(symbol, "binance")?, interval, &closed)
            .await?;
        cursor = next;
    }
    Ok(())
}
async fn strategy_stats(app: &App, gran: &str) -> Result<Value> {
    let gran = if gran == "hour" { "hour" } else { "day" };
    let summary=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('id',COALESCE(rr.record->>'strategyId','unknown'),'name',COALESCE(rr.record->>'strategyName','(未知)'),'orders',COUNT(*),'closed',COUNT(*)FILTER(WHERE o.status='closed'),'profit',COUNT(*)FILTER(WHERE o.net>0),'net',ROUND(COALESCE(SUM(o.net),0)::numeric,2))FROM simulated_orders o LEFT JOIN research_records rr ON rr.id=o.record_id GROUP BY rr.record->>'strategyId',rr.record->>'strategyName' ORDER BY COUNT(*)DESC").fetch_all(&app.db.pool).await?;
    let bucket = if gran == "hour" {
        "EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'UTC'+INTERVAL '8 hours')::int::text"
    } else {
        "(o.created_at AT TIME ZONE 'UTC'+INTERVAL '8 hours')::date::text"
    };
    let timeline=sqlx::query_scalar::<_,Value>(&format!("SELECT jsonb_build_object('bucket',{bucket},'sid',COALESCE(rr.record->>'strategyId','unknown'),'orders',COUNT(*),'closed',COUNT(*)FILTER(WHERE o.status='closed'),'profit',COUNT(*)FILTER(WHERE o.net>0),'net',ROUND(COALESCE(SUM(o.net),0)::numeric,2))FROM simulated_orders o LEFT JOIN research_records rr ON rr.id=o.record_id GROUP BY {bucket},rr.record->>'strategyId' ORDER BY {bucket}")).fetch_all(&app.db.pool).await?;
    let mut by = summary;
    let mut overview = json!({"orders":0,"closed":0,"profit":0,"net":0});
    for s in &mut by {
        let closed = number(&s["closed"], 0.);
        s["winRate"] = json!(if closed > 0. {
            number(&s["profit"], 0.) / closed
        } else {
            0.
        });
        for k in ["orders", "closed", "profit", "net"] {
            overview[k] = json!(number(&overview[k], 0.) + number(&s[k], 0.));
        }
    }
    overview["winRate"] = json!(if number(&overview["closed"], 0.) > 0. {
        number(&overview["profit"], 0.) / number(&overview["closed"], 0.)
    } else {
        0.
    });
    let mut buckets: BTreeMap<String, Value> = BTreeMap::new();
    for r in timeline {
        let b=buckets.entry(r["bucket"].as_str().unwrap_or("").to_owned()).or_insert(json!({"bucket":r["bucket"],"total":0,"closed":0,"profit":0,"net":0,"byStrategy":{}}));
        for (k, s) in [
            ("total", "orders"),
            ("closed", "closed"),
            ("profit", "profit"),
            ("net", "net"),
        ] {
            b[k] = json!(number(&b[k], 0.) + number(&r[s], 0.));
        }
        b["byStrategy"][r["sid"].as_str().unwrap_or("unknown")] =
            json!({"orders":r["orders"],"closed":r["closed"],"profit":r["profit"],"net":r["net"]});
    }
    let mut buckets = buckets.into_values().collect::<Vec<_>>();
    if gran == "hour" {
        buckets.sort_by_key(|b| {
            b["bucket"]
                .as_str()
                .unwrap_or("0")
                .parse::<u32>()
                .unwrap_or(0)
        });
    }
    Ok(
        json!({"generatedAt":iso(now_ms()),"filters":{"granularity":gran},"overview":overview,"byStrategy":by,"timeline":{"granularity":gran,"buckets":buckets}}),
    )
}
async fn adaptive(
    app: &App,
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    input: &Value,
) -> Result<(StatusCode, Value)> {
    if method == "GET" {
        return ok(crate::analytics::adaptive(
            path,
            &app.db.account(false, None).await?,
            query,
        )?);
    }
    if method == "PUT" && path == "/api/adaptive/config" {
        let config = crate::analytics::adaptive_config(input);
        for (section, key) in [
            ("symbolFilter", "minWinRate"),
            ("hourFilter", "minWinRate"),
            ("holdingPeriodOptimization", "autoApplyThreshold"),
        ] {
            let n = number(&config[section][key], f64::NAN);
            if !n.is_finite() || !(0. ..=1.).contains(&n) {
                bail!("配置验证失败: {section}.{key} 必须在0～1之间");
            }
        }
        app.db
            .mutate_account(|s| {
                s["adaptiveConfig"] = config.clone();
                Ok(json!({"success":true,"config":config}))
            })
            .await?;
        return ok(json!({"success":true,"config":config}));
    }
    if method == "POST" && path == "/api/adaptive/reset-overrides" {
        app.db
            .mutate_account(|s| {
                s.as_object_mut().unwrap().remove("adaptiveOverrides");
                Ok(json!({"success":true}))
            })
            .await?;
        return ok(json!({"success":true,"message":"已重置为默认参数","timestamp":iso(now_ms())}));
    }
    if method == "POST" && path == "/api/adaptive/apply-optimization" {
        let mut updates = json!({});
        for (key, min, max) in [
            ("maxHoldBars", 10., 200.),
            ("stopLossATR", 1., 5.),
            ("takeProfitATR", 1.5, 10.),
        ] {
            let n = number(&input[key], f64::NAN);
            if n.is_finite() && (min..=max).contains(&n) {
                updates[key] = json!(n);
            }
        }
        if updates.as_object().unwrap().is_empty() {
            bail!("无有效优化参数");
        }
        app.db
            .mutate_account(|s| {
                if !s["adaptiveOverrides"].is_object() {
                    s["adaptiveOverrides"] = json!({});
                }
                s["adaptiveOverrides"]
                    .as_object_mut()
                    .unwrap()
                    .extend(updates.as_object().unwrap().clone());
                Ok(json!({"success":true}))
            })
            .await?;
        return ok(
            json!({"success":true,"applied":updates,"message":"优化参数已保存，将在下次扫描时生效","timestamp":iso(now_ms())}),
        );
    }
    bail!("404: API接口不存在")
}
async fn replay(app: &App, order: &Value) -> Result<Value> {
    let interval = order["interval"].as_str().unwrap_or("1m");
    let duration = interval_ms(interval).context("无效周期")?;
    let entry = timestamp(&order["entryAt"]).context("订单未入场，无法复盘")?;
    let exit = timestamp(&order["exitAt"]).unwrap_or(now_ms());
    let provider = order["marketProvider"].as_str().unwrap_or("binance");
    let rows = app
        .db
        .candles(
            &storage_symbol(order["symbol"].as_str().unwrap_or(""), provider)?,
            interval,
            10_000_000,
            Some(entry - 20 * duration),
            Some((exit + 5 * duration).min(now_ms())),
        )
        .await?;
    Ok(crate::analytics::replay(order, &rows))
}
async fn optimization(
    app: &App,
    method: &str,
    path: &str,
    query: &HashMap<String, String>,
    input: &Value,
) -> Result<(StatusCode, Value)> {
    let state = app.db.account(false, None).await?;
    match (method, path) {
        ("GET", "/api/paper/optimize") => ok(crate::analytics::optimize_orders(
            &crate::analytics::orders(&state),
        )),
        ("GET", "/api/paper/strategy/optimize") => ok(crate::analytics::optimize_strategy(
            &crate::analytics::orders(&state),
            qn(query, "maxHoldBars", 30., 1., 10000.),
        )),
        ("POST", "/api/paper/strategy/apply-optimization") => {
            let updates = input["params"]
                .as_object()
                .context("请提供优化参数")?
                .clone();
            app.db
                .mutate_account(|s| {
                    if !s["adaptiveOverrides"].is_object() {
                        s["adaptiveOverrides"] = json!({});
                    }
                    s["adaptiveOverrides"]
                        .as_object_mut()
                        .unwrap()
                        .extend(updates);
                    Ok(json!({"success":true}))
                })
                .await?;
            ok(json!({"success":true,"applied":input["params"],"message":"优化参数已保存"}))
        }
        ("POST", "/api/paper/orders/replay-batch") => {
            let ids = input["orderIds"].as_array();
            let mut results = vec![];
            for o in state["orders"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|o| o["status"] == "closed" && ids.is_none_or(|ids| ids.contains(&o["id"])))
                .take(200)
            {
                results.push(
                    replay(app, o)
                        .await
                        .unwrap_or_else(|e| json!({"id":o["id"],"error":e.to_string()})),
                );
            }
            ok(json!({"results":results,"total":results.len(),"timestamp":iso(now_ms())}))
        }
        _ => bail!("404: API接口不存在"),
    }
}
async fn trades(app: &App, query: &HashMap<String, String>) -> Result<Value> {
    let config = app.store.read("config").await?;
    let client = trade_client(app, None).await?;
    let symbols = q(
        query,
        "symbols",
        config["tradeSync"]["symbolsText"]
            .as_str()
            .unwrap_or("BTCUSDT"),
    )
    .split(',')
    .map(|s| s.trim().to_uppercase())
    .filter(|s| !s.is_empty())
    .take(20)
    .collect::<Vec<_>>();
    let start = date_query(query, "from", false)?;
    let end = date_query(query, "to", true)?;
    let mut trades = vec![];
    for symbol in &symbols {
        crate::exchange::valid_symbol(symbol)?;
        let rows=client.signed("GET","/fapi/v1/userTrades",&json!({"symbol":symbol,"limit":qn(query,"limit",500.,1.,1000.),"startTime":start,"endTime":end})).await?;
        for r in rows.as_array().context("成交返回格式错误")? {
            let price = number(&r["price"], 0.);
            let quantity = number(&r["qty"], 0.);
            trades.push(json!({"symbol":symbol,"tradeId":r["id"],"orderId":r["orderId"],"time":r["time"],"side":r["side"],"price":price,"quantity":quantity,"quoteQuantity":number(&r["quoteQty"],price*quantity),"realizedPnl":number(&r["realizedPnl"],0.),"commission":number(&r["commission"],0.),"commissionAsset":r["commissionAsset"],"positionSide":r["positionSide"],"maker":r["maker"]}));
        }
    }
    trades.sort_by_key(|t| number(&t["time"], 0.) as i64);
    let (orders, summary) = trade_report(&trades);
    Ok(
        json!({"ok":true,"demo":client.demo,"testnet":client.demo,"symbols":symbols,"syncedAt":iso(now_ms()),"trades":trades,"orders":orders,"summary":summary}),
    )
}
fn date_query(query: &HashMap<String, String>, key: &str, end: bool) -> Result<Option<i64>> {
    let Some(date) = query.get(key).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let parsed = timestamp(&json!(date))
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
        })
        .context("日期格式无效")?;
    Ok(Some(parsed + if end { 86_399_999 } else { 0 }))
}
fn trade_report(trades: &[Value]) -> (Vec<Value>, Value) {
    let mut groups: BTreeMap<String, Value> = BTreeMap::new();
    for t in trades {
        let key = format!("{}:{}", t["symbol"].as_str().unwrap_or(""), t["orderId"]);
        let o=groups.entry(key.clone()).or_insert(json!({"id":key,"symbol":t["symbol"],"orderId":t["orderId"],"buyQty":0,"sellQty":0,"buyQuote":0,"sellQuote":0,"fees":0,"realizedPnl":0,"firstTime":t["time"],"lastTime":t["time"],"fills":0}));
        let (qty, quote) = if t["side"] == "BUY" {
            ("buyQty", "buyQuote")
        } else {
            ("sellQty", "sellQuote")
        };
        o[qty] = json!(number(&o[qty], 0.) + number(&t["quantity"], 0.));
        o[quote] = json!(number(&o[quote], 0.) + number(&t["quoteQuantity"], 0.));
        o["fees"] = json!(number(&o["fees"], 0.) + number(&t["commission"], 0.));
        o["realizedPnl"] = json!(number(&o["realizedPnl"], 0.) + number(&t["realizedPnl"], 0.));
        o["firstTime"] = json!(number(&o["firstTime"], 0.).min(number(&t["time"], 0.)));
        o["lastTime"] = json!(number(&o["lastTime"], 0.).max(number(&t["time"], 0.)));
        o["fills"] = json!(number(&o["fills"], 0.) + 1.);
    }
    let mut summary = json!({"orders":groups.len(),"closed":0,"fees":0,"realizedPnl":0,"netPnl":0,"buyQuote":0,"sellQuote":0,"totalQuote":0});
    let mut orders = groups.into_values().collect::<Vec<_>>();
    for o in &mut orders {
        let b = number(&o["buyQty"], 0.);
        let s = number(&o["sellQty"], 0.);
        o["buyPrice"] = json!(if b > 0. {
            Some(number(&o["buyQuote"], 0.) / b)
        } else {
            None
        });
        o["sellPrice"] = json!(if s > 0. {
            Some(number(&o["sellQuote"], 0.) / s)
        } else {
            None
        });
        o["netPnl"] = json!(number(&o["realizedPnl"], 0.) - number(&o["fees"], 0.));
        o["status"] = json!(if b > 0. && s > 0. { "closed" } else { "filled" });
        if o["status"] == "closed" {
            summary["closed"] = json!(number(&summary["closed"], 0.) + 1.);
        }
        for k in ["fees", "realizedPnl", "netPnl", "buyQuote", "sellQuote"] {
            summary[k] = json!(number(&summary[k], 0.) + number(&o[k], 0.));
        }
    }
    summary["totalQuote"] =
        json!(number(&summary["buyQuote"], 0.) + number(&summary["sellQuote"], 0.));
    orders.sort_by_key(|o| std::cmp::Reverse(number(&o["lastTime"], 0.) as i64));
    (orders, summary)
}
async fn spot_orders(app: &App, query: &HashMap<String, String>) -> Result<Value> {
    crate::spot::orders(
        &app.store,
        query,
        date_query(query, "from", false)?,
        date_query(query, "to", true)?,
    )
    .await
}
async fn smoke(app: &App, input: &Value) -> Result<Value> {
    let client = trade_client(app, None).await?;
    if !client.demo {
        bail!("冒烟测试仅允许 Binance Demo");
    }
    let symbol = input["symbol"].as_str().unwrap_or("BTCUSDT");
    crate::exchange::valid_symbol(symbol)?;
    let info = client
        .public_request("/fapi/v1/exchangeInfo", &json!({}))
        .await?;
    let contract = info["symbols"]
        .as_array()
        .and_then(|s| s.iter().find(|s| s["symbol"] == symbol))
        .context("Demo没有该合约")?;
    let price = number(
        &client
            .public_request("/fapi/v1/ticker/price", &json!({"symbol":symbol}))
            .await?["price"],
        0.,
    );
    let filter = |kind: &str| {
        contract["filters"]
            .as_array()
            .and_then(|f| f.iter().find(|f| f["filterType"] == kind))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let tick = number(&filter("PRICE_FILTER")["tickSize"], 0.);
    let lot = filter("LOT_SIZE");
    let step = number(&lot["stepSize"], 0.);
    let min = number(&lot["minQty"], 0.);
    if tick <= 0. || step <= 0. || price <= 0. {
        bail!("Demo合约价格或数量过滤器无效");
    }
    let far = (price * 0.5 / tick).floor() * tick;
    let minimum = number(&filter("MIN_NOTIONAL")["notional"], 5.);
    let qty = (min.max(minimum / far) / step).ceil() * step;
    let mode = client
        .signed("GET", "/fapi/v1/positionSide/dual", &json!({}))
        .await?;
    let mut args = json!({"symbol":symbol,"side":"BUY","type":"LIMIT","quantity":qty,"price":far,"timeInForce":"GTC","newClientOrderId":crate::exchange::client_id("smoke",&[&uuid::Uuid::new_v4().to_string()])});
    if mode["dualSidePosition"] == true {
        args["positionSide"] = json!("LONG");
    }
    let placed = client.signed("POST", "/fapi/v1/order", &args).await?;
    let order_id = placed["orderId"].clone();
    let params = json!({"symbol":symbol,"orderId":order_id});
    let checked = client.signed("GET", "/fapi/v1/order", &params).await;
    let cancel = client.signed("DELETE", "/fapi/v1/order", &params).await;
    let remote = checked?;
    let cancelled = cancel?;
    let remaining = client
        .signed("GET", "/fapi/v1/openOrders", &json!({"symbol":symbol}))
        .await?;
    if remaining
        .as_array()
        .is_some_and(|r| r.iter().any(|o| o["orderId"] == order_id))
    {
        bail!("Demo冒烟撤单后订单仍在挂单列表：{order_id}");
    }
    Ok(
        json!({"ok":true,"demo":true,"testnet":true,"environment":"demo","symbol":symbol,"orderId":order_id,"steps":[{"name":"查规则与价格","ok":true},{"name":"远价挂单","ok":true,"detail":placed},{"name":"查询挂单","ok":true,"detail":remote},{"name":"撤单","ok":true,"detail":cancelled},{"name":"复核撤单","ok":true}]}),
    )
}
