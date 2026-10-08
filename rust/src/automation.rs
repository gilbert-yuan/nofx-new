use crate::{
    db::Db, exchange::Exchange, interval_ms, iso, now_ms, number, research, store::Store,
    strategies, timestamp,
};
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore};

pub struct Automation {
    pub db: Db,
    pub store: Store,
    pub market: Exchange,
    active: AtomicBool,
    generation: AtomicU64,
    pub state: Mutex<Value>,
    sync_gate: Semaphore,
    review_gate: Semaphore,
    started: std::time::Instant,
}
impl Automation {
    pub fn new(db: Db, store: Store, market: Exchange) -> Arc<Self> {
        Arc::new(Self {
            db,
            store,
            market,
            active: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            state: Mutex::new(
                json!({"tasks":{"klineSync":{"enabled":true,"interval":6000,"lastRun":null,"running":false},"positionReview":{"enabled":true,"interval":1000,"lastRun":null,"running":false}},"stats":{"totalAnalyzed":0,"totalOrders":0,"totalReviews":0,"errors":[]},"opportunities":[],"yaoCoins":[],"yaoCoinsAt":null,"yaoCoinError":""}),
            ),
            sync_gate: Semaphore::new(1),
            review_gate: Semaphore::new(1),
            started: std::time::Instant::now(),
        })
    }
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        if self.active.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let token = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        for kind in ["klineSync", "positionReview"] {
            let this = self.clone();
            tokio::spawn(async move {
                while this.active() && this.generation.load(Ordering::SeqCst) == token {
                    let (enabled, interval) = {
                        let state = this.state.lock().await;
                        (
                            state["tasks"][kind]["enabled"] != false,
                            number(&state["tasks"][kind]["interval"], 1000.).max(1000.) as u64,
                        )
                    };
                    if enabled && let Err(error) = this.execute(kind).await {
                        tracing::error!(%error,kind,"Automation task failed");
                    }
                    tokio::time::sleep(Duration::from_millis(interval)).await;
                }
            });
        }
        let this = self.clone();
        tokio::spawn(async move {
            while this.active() && this.generation.load(Ordering::SeqCst) == token {
                if let Err(error) = crate::paper::exchange_refresh(&this.db, &this.store).await {
                    tracing::warn!(%error,"Exchange account synchronization deferred");
                }
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
        Ok(())
    }
    pub fn stop(&self) {
        self.active.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub async fn configure(&self, kind: &str, input: &Value) -> Result<Value> {
        if !matches!(kind, "klineSync" | "positionReview") {
            bail!("未知自动任务");
        }
        if let Some(n) = input.get("interval") {
            let interval = number(n, f64::NAN);
            if !interval.is_finite() || interval < 1000. {
                bail!("任务间隔至少为 1000ms");
            }
        }
        let mut state = self.state.lock().await;
        if input["enabled"].is_boolean() {
            state["tasks"][kind]["enabled"] = input["enabled"].clone();
        }
        if input.get("interval").is_some() {
            state["tasks"][kind]["interval"] = input["interval"].clone();
        }
        Ok(state["tasks"][kind].clone())
    }
    pub async fn trigger(self: &Arc<Self>, kind: &str) -> Result<()> {
        if !matches!(kind, "klineSync" | "positionReview") {
            bail!("未知自动任务");
        }
        let this = self.clone();
        let kind = kind.to_owned();
        tokio::spawn(async move {
            if let Err(e) = this.execute(&kind).await {
                tracing::error!(%e,"Triggered task failed");
            }
        });
        Ok(())
    }
    pub async fn status(&self) -> Result<Value> {
        let mut state = self.state.lock().await.clone();
        state["active"] = json!(self.active());
        state["account"] = crate::paper::status(&self.db).await?;
        state["uptime"] = json!(self.started.elapsed().as_secs_f64());
        state["yaoCoinMeta"] = json!({"targetAmplitudePct":50,"asOf":state["yaoCoinsAt"],"total":state["yaoCoins"].as_array().map(Vec::len).unwrap_or(0),"error":state["yaoCoinError"]});
        Ok(state)
    }
    pub async fn sync_status(&self) -> Result<Value> {
        let state = self.state.lock().await;
        let task = &state["tasks"]["klineSync"];
        Ok(
            json!({"running":self.active()&&task["enabled"]!=false,"busy":task["running"],"lastRunAt":task["lastRun"],"nextRunAt":task["nextRunAt"],"lastError":task["error"].as_str().unwrap_or(""),"progress":task["progress"],"interval":"1m","intervalSeconds":number(&task["interval"],6000.)/1000.,"provider":"binance","states":[],"managedBy":"globalAutomation"}),
        )
    }
    pub async fn execute(&self, kind: &str) -> Result<Value> {
        let gate = if kind == "klineSync" {
            &self.sync_gate
        } else {
            &self.review_gate
        };
        let Ok(_permit) = gate.try_acquire() else {
            return Ok(json!({"skipped":true,"reason":"任务已在运行"}));
        };
        {
            let mut state = self.state.lock().await;
            state["tasks"][kind]["running"] = json!(true);
            state["tasks"][kind]["startedAt"] = json!(iso(now_ms()));
        }
        let result = if kind == "klineSync" {
            self.scan(self.generation.load(Ordering::SeqCst)).await
        } else {
            self.review().await
        };
        {
            let mut state = self.state.lock().await;
            state["tasks"][kind]["running"] = json!(false);
            state["tasks"][kind]["lastRun"] = json!(iso(now_ms()));
            state["tasks"][kind]["error"] = json!(
                result
                    .as_ref()
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_default()
            );
            if let Ok(summary) = &result {
                state["tasks"][kind]["summary"] = summary.clone();
            } else if let Err(e) = &result {
                let errors = state["stats"]["errors"].as_array_mut().unwrap();
                errors.push(json!({"at":iso(now_ms()),"task":kind,"error":e.to_string()}));
                if errors.len() > 50 {
                    errors.drain(..errors.len() - 50);
                }
            }
        }
        result
    }
    pub async fn fetch_history(&self, input: &Value) -> Result<Value> {
        let _permit = self
            .sync_gate
            .try_acquire()
            .context("K线正在同步，请稍后重试")?;
        let interval = input["interval"].as_str().unwrap_or("15m");
        interval_ms(interval).context("不支持的周期")?;
        let limit = number(&input["limit"], 80.).clamp(1., 1000.) as usize;
        let mut symbols = research::symbols(input);
        if symbols.is_empty() || symbols.iter().any(|s| s == "ALL") {
            symbols = self
                .market
                .contracts()
                .await?
                .iter()
                .filter_map(|s| s["symbol"].as_str().map(str::to_owned))
                .collect();
        }
        self.fetch_symbols(&symbols, interval, limit).await
    }
    async fn fetch_symbols(
        &self,
        symbols: &[String],
        interval: &str,
        limit: usize,
    ) -> Result<Value> {
        let concurrency = env_num("NOFX_KLINE_SYNC_CONCURRENCY", 12.).clamp(1., 24.) as usize;
        let jobs = futures::stream::iter(symbols.iter().cloned().map(|symbol| async move {
            let result = self
                .market
                .klines(&symbol, interval, limit, None, None)
                .await;
            let key = format!("BINANCE_{symbol}");
            let result = match result {
                Ok(rows) => {
                    let closed: Vec<Value> = rows
                        .into_iter()
                        .filter(|r| r["confirmed"] != false)
                        .collect();
                    self.db
                        .save_klines(&key, interval, &closed)
                        .await
                        .map(|n| (n, closed.last().and_then(|r| r["openTime"].as_i64())))
                }
                Err(e) => Err(e),
            };
            let _ = self
                .db
                .sync_state(
                    &key,
                    interval,
                    result.as_ref().ok().and_then(|(_, t)| *t),
                    if result.is_ok() { "ok" } else { "error" },
                    &result
                        .as_ref()
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_default(),
                )
                .await;
            (symbol.clone(), result)
        }));
        let results = jobs.buffer_unordered(concurrency).collect::<Vec<_>>().await;
        let mut saved = 0;
        let mut errors = vec![];
        for (symbol, r) in results {
            match r {
                Ok((n, _)) => saved += n,
                Err(e) => errors.push(format!("{symbol}: {e}")),
            }
        }
        Ok(
            json!({"source":"binance","total":symbols.len(),"completed":symbols.len()-errors.len(),"failed":errors.len(),"saved":saved,"errors":errors,"at":iso(now_ms())}),
        )
    }
    async fn scan(&self, token: u64) -> Result<Value> {
        let config = self.store.read("config").await?;
        let registry = strategies::list(&config, &self.store.read("strategies").await?);
        let enabled: Vec<Value> = registry["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["enabled"] == true)
            .cloned()
            .collect();
        let contracts = self.market.contracts().await?;
        let mut symbols: Vec<String> = contracts
            .iter()
            .filter_map(|s| s["symbol"].as_str().map(str::to_owned))
            .collect();
        let universe =
            research::symbols(&json!({"symbolsText":config["marketSync"]["symbolsText"]}));
        if !universe.is_empty() && !universe.iter().any(|s| s == "ALL") {
            symbols.retain(|s| universe.contains(s));
        }
        let state = self.db.account(true, None).await?;
        let mut query = HashMap::new();
        query.insert("symbols".to_owned(), symbols.join(","));
        if let Ok(filter) =
            crate::analytics::adaptive("/api/adaptive/symbol-filter", &state, &query)
            && let Some(filtered) = filter["filtered"].as_array()
        {
            let keep: Vec<&str> = filtered.iter().filter_map(Value::as_str).collect();
            symbols.retain(|s| keep.contains(&s.as_str()));
        }
        let tickers = self
            .market
            .public_request("/fapi/v1/ticker/24hr", &json!({}))
            .await?;
        if env_bool("NOFX_LIQUIDITY_SCREEN", true) {
            let minimum = env_num("NOFX_MIN_QUOTE_VOL_24H", 5_000_000.);
            symbols.retain(|s| {
                tickers
                    .as_array()
                    .and_then(|a| a.iter().find(|t| t["symbol"] == s.as_str()))
                    .is_some_and(|t| number(&t["quoteVolume"], -1.) >= minimum)
            });
        }
        {
            self.state.lock().await["tasks"]["klineSync"]["progress"] =
                json!({"total":symbols.len(),"completed":0,"failed":0});
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let mut candidates = vec![];
        let mut errors = vec![];
        let mut analyzed = 0;
        let concurrency = env_num("NOFX_KLINE_SYNC_CONCURRENCY", 12.).clamp(1., 24.) as usize;
        let jobs = futures::stream::iter(symbols.iter().cloned().map(|symbol| async move {
            let result = research::fresh_market(&self.db, &self.market, &symbol, "1m", 80).await;
            (symbol.clone(), result)
        }));
        let markets = jobs.buffer_unordered(concurrency).collect::<Vec<_>>().await;
        let mut ticker_map = json!({});
        for ticker in tickers.as_array().into_iter().flatten() {
            if let Some(symbol) = ticker["symbol"].as_str() {
                ticker_map[symbol] = ticker.clone();
            }
        }
        let mut prepared = json!({});
        for (symbol, result) in &markets {
            if let Ok(market) = result {
                prepared[symbol] = market.clone();
            }
        }
        {
            let predictions = strategies::yao_predictions(
                &symbols.iter().map(|s| json!(s)).collect::<Vec<_>>(),
                &prepared,
                &ticker_map,
                now_ms(),
                &json!({}),
            );
            let mut status = self.state.lock().await;
            status["yaoCoins"] = predictions;
            status["yaoCoinsAt"] = json!(iso(now_ms()));
            status["yaoCoinError"] = json!("");
        }
        for (symbol, main) in markets {
            if self.generation.load(Ordering::SeqCst) != token {
                break;
            }
            let market = match main {
                Ok(m) => m,
                Err(e) => {
                    errors.push(format!("{symbol}: {e}"));
                    continue;
                }
            };
            if crate::automation_guards::enabled("NOFX_LIQUIDITY_SCREEN", true)
                && !crate::automation_guards::screen(&ticker_map[&symbol], Some(&market))
            {
                continue;
            }
            let mut aux = BTreeMap::new();
            for strategy in &enabled {
                let id = strategy["id"].as_str().unwrap();
                let config = self.store.read("config").await?;
                let mut context = json!({"params":strategy["params"],"config":config,"state":state,"costs":research::costs(),"auxMarkets":{},"planInterval":strategy["planInterval"],"skillContext":{"requireFiveMinute":strategy["marketContext"]["requireFiveMinute"]}});
                let mut incomplete = false;
                for interval in strategy["needsAux"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    let window = number(&strategy["marketWindows"][interval], 80.).clamp(30., 1000.)
                        as usize;
                    if aux.get(interval).is_none_or(|m: &Value| {
                        m["klines"]
                            .as_array()
                            .is_none_or(|rows| rows.len() < window)
                    }) {
                        match research::fresh_market(
                            &self.db,
                            &self.market,
                            &symbol,
                            interval,
                            window,
                        )
                        .await
                        {
                            Ok(m) => {
                                aux.insert(interval.to_owned(), m);
                            }
                            Err(e) => {
                                errors.push(format!("{symbol}/{interval}: {e}"));
                                incomplete = true;
                            }
                        }
                    }
                    if let Some(m) = aux.get(interval) {
                        context["auxMarkets"][interval] = m.clone();
                    }
                }
                if incomplete {
                    continue;
                }
                match crate::automation_guards::entry_filter(&self.store, &config, strategy).await {
                    Ok(Some(filter)) => {
                        let tf = filter["featureConfig"]["interval"].as_str().unwrap();
                        let count = number(&filter["featureConfig"]["lookbackBars"], 72.) as usize;
                        let cached = if tf == "1m" {
                            Some(&market)
                        } else {
                            aux.get(tf)
                        };
                        let feature_market = if cached.is_some_and(|m| {
                            m["klines"].as_array().is_some_and(|r| r.len() >= count)
                        }) {
                            cached.unwrap().clone()
                        } else {
                            match research::fresh_market(&self.db, &self.market, &symbol, tf, count)
                                .await
                            {
                                Ok(m) => m,
                                Err(error) => {
                                    errors.push(format!("{symbol}/{id} 特征数据：{error}"));
                                    continue;
                                }
                            }
                        };
                        let features = strategies::kline_features(
                            feature_market["klines"].as_array().unwrap(),
                            &filter["featureConfig"],
                        )
                        .unwrap_or(Value::Null);
                        match strategies::match_feature_rules(
                            &features,
                            &filter["rules"],
                            filter["missing"].as_str().unwrap_or("reject"),
                        ) {
                            Ok(verdict) if verdict["passed"] == true => {}
                            Ok(_) => continue,
                            Err(error) => {
                                errors.push(format!("{symbol}/{id} 特征筛选：{error}"));
                                continue;
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        errors.push(format!("{symbol}/{id} 特征配置：{error}"));
                        continue;
                    }
                }
                let mut raw = match strategies::analyze(id, &market, &context) {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("{symbol}/{id}: {e}"));
                        continue;
                    }
                };
                analyzed += 1;
                raw["maxHoldBarsLimit"] = strategy["params"]["maxHoldBars"].clone();
                let plan_interval = strategy["planInterval"].as_str().unwrap_or("1m");
                let mut plan_market = market.clone();
                if plan_interval != "1m" {
                    if let Some(m) = aux.get(plan_interval) {
                        plan_market = m.clone();
                    } else {
                        errors.push(format!("{symbol}/{id}: 缺少计划周期行情"));
                        continue;
                    }
                }
                let now = now_ms();
                let mut signal = research::normalize_plan(&raw, &plan_market, now);
                signal["strategyId"] = json!(id);
                signal["analysisEngine"] = strategy["engine"].clone();
                signal["confidenceType"] = json!("rule_strength");
                if signal["eligible"] != true {
                    continue;
                }
                let opportunity_context = self.market.opportunity_context(&symbol).await;
                signal["opportunityReport"] = strategies::opportunity_report(
                    &signal,
                    &plan_market,
                    &opportunity_context,
                    strategy,
                    now,
                );
                let scope =
                    json!({"interval":plan_interval,"limit":80,"engine":strategy["engine"]});
                let mut legacy = self.store.read("strategy").await?;
                legacy["interval"] = json!(plan_interval);
                let mut record = research::create_record(
                    &config,
                    &legacy,
                    &[plan_market.clone()],
                    &[signal.clone()],
                    &scope,
                    "automation",
                    now,
                    Some(strategy),
                    &[],
                );
                record["automationRunId"] = json!(run_id);
                record["analysisEngine"] = strategy["engine"].clone();
                self.db.save_record(&record).await?;
                candidates.push(json!({"symbol":symbol,"signal":signal,"record":record,"strategy":strategy,"market":plan_market}));
            }
            let mut s = self.state.lock().await;
            let progress = &mut s["tasks"]["klineSync"]["progress"];
            progress["completed"] = json!(number(&progress["completed"], 0.) + 1.);
        }
        let mut selected = select_candidates(&candidates);
        selected.sort_by(compare_candidates);
        let opportunities: Vec<Value> = selected
            .iter()
            .map(|c| {
                let mut s = c["signal"].clone();
                s["recordId"] = c["record"]["id"].clone();
                s["strategyName"] = c["strategy"]["name"].clone();
                s["at"] = c["record"]["at"].clone();
                s
            })
            .take(50)
            .collect();
        let mut submitted = 0;
        // Circuit, cooldown, available equity and symbol conflicts are rechecked per submission.
        for c in &selected {
            if self.generation.load(Ordering::SeqCst) != token {
                break;
            }
            let current = self.db.account(true, None).await?;
            if entry_guard(&current, c, &config).is_some() {
                continue;
            }
            let signal = &c["signal"];
            let adaptive = crate::analytics::adaptive_config(&current["adaptiveConfig"]);
            use chrono::Timelike;
            let hour = chrono::Utc::now().hour();
            let history = crate::analytics::closed_orders(&current);
            if crate::analytics::should_open_position(
                c["symbol"].as_str().unwrap_or(""),
                Some(hour),
                &history,
                &adaptive,
            )["shouldOpen"]
                != true
            {
                continue;
            }
            let mut margin_pct = number(
                &signal["plan"]["autoMarginPct"],
                env_num("NOFX_AUTO_MARGIN_PCT", 0.05),
            )
            .clamp(0.01, 1.);
            let funds = crate::paper::account_summary(&current, now_ms());
            let equity = number(&funds["equity"], number(&funds["initialBalance"], 0.));
            let cap = number(
                &config["trader"]["maxLeverage"],
                env_num("NOFX_MAX_LEVERAGE", 5.),
            )
            .floor()
            .clamp(1., env_num("NOFX_MAX_LEVERAGE", 5.).max(1.));
            let mut leverage = number(&signal["recommendedLeverage"], 1.)
                .floor()
                .clamp(1., cap);
            if crate::automation_guards::enabled("NOFX_SCORE_SIZING", false) {
                let Some((sized_lev, sized_margin)) = crate::automation_guards::score_size(
                    signal,
                    number(&funds["openCount"], 0.) as usize,
                ) else {
                    continue;
                };
                leverage = sized_lev.clamp(1., cap);
                margin_pct = sized_margin;
            }
            let min_margin = if config["trader"]["exchange"] == "binance" {
                number(&config["trader"]["minOrderMargin"], 5.).max(5.)
            } else {
                0.
            };
            let mut margin = (equity * margin_pct).max(min_margin);
            let cap = number(&config["trader"]["maxPositionNotionalPct"], 0.);
            if cap > 0. && cap <= 1. {
                margin = margin.min(equity * cap / leverage);
            }
            if !current["fusedPoolStartedAt"].is_null() {
                if funds["canOpen"] != true {
                    continue;
                }
                margin =
                    margin.min(number(&funds["available"], 0.) / (1. + leverage * 12. / 10000.));
            }
            margin = (margin * 100.).floor() / 100.;
            if margin < min_margin.max(1.) {
                continue;
            }
            if crate::automation_guards::enabled("NOFX_LIQUIDITY_SCREEN", true) {
                let symbol = c["symbol"].as_str().unwrap_or("");
                let params = json!({"symbol":symbol});
                let depth_params = json!({"symbol":symbol,"limit":crate::automation_guards::env_num("NOFX_BOOK_LEVELS",5.,1.,50.)});
                let (book, depth) = tokio::join!(
                    self.market
                        .public_request("/fapi/v1/ticker/bookTicker", &params),
                    self.market.public_request("/fapi/v1/depth", &depth_params)
                );
                match (book, depth) {
                    (Ok(book), Ok(depth)) => {
                        if let Err(error) =
                            crate::automation_guards::book_check(&book, &depth, margin * leverage)
                        {
                            errors.push(format!("{symbol} 盘口：{error}"));
                            continue;
                        }
                    }
                    _ => {
                        errors.push(format!("{symbol} 盘口数据不可用，跳过开仓"));
                        continue;
                    }
                }
            }
            let input = json!({"recordId":c["record"]["id"],"symbol":c["symbol"],"strategyId":c["strategy"]["id"],"automatic":true,"margin":margin,"autoMarginPct":margin_pct,"leverage":leverage,"executionPlan":strategies::execution_plan(signal)});
            match crate::paper::submit(&self.db, &self.store, &input).await {
                Ok(_) => submitted += 1,
                Err(e) => errors.push(format!("{}: {e}", c["symbol"])),
            }
        }
        let mut s = self.state.lock().await;
        s["opportunities"] = json!(opportunities);
        s["stats"]["totalAnalyzed"] =
            json!(number(&s["stats"]["totalAnalyzed"], 0.) + analyzed as f64);
        s["stats"]["totalOrders"] =
            json!(number(&s["stats"]["totalOrders"], 0.) + submitted as f64);
        Ok(
            json!({"analyzed":analyzed,"eligible":selected.len(),"submitted":submitted,"failed":errors.len(),"errors":errors,"runId":run_id}),
        )
    }
    async fn review(&self) -> Result<Value> {
        crate::paper::refresh(&self.db, &self.store).await?;
        let snapshot = self.db.account(true, None).await?;
        let orders = snapshot["orders"].as_array().unwrap();
        let mut reviewed = 0;
        let mut errors = vec![];
        for order in orders
            .iter()
            .filter(|o| o["status"] == "pending" || o["status"] == "open")
        {
            let id = order["id"].as_str().unwrap();
            let symbol = order["symbol"].as_str().unwrap_or("");
            let interval = order["interval"].as_str().unwrap_or("1m");
            let strategy_id = order["analysisContext"]["strategyId"]
                .as_str()
                .or(order["strategyId"].as_str())
                .unwrap_or("enhanced-trend-v1");
            let Some(def) = strategies::definition(strategy_id) else {
                errors.push(format!("{symbol}: 未知订单策略 {strategy_id}"));
                continue;
            };
            let market =
                match research::fresh_market(&self.db, &self.market, symbol, interval, 80).await {
                    Ok(m) => m,
                    Err(e) => {
                        errors.push(format!("{symbol}: {e}"));
                        continue;
                    }
                };
            let mut context = json!({"params":order["analysisContext"]["strategyParams"],"auxMarkets":{},"costs":order["costs"]});
            context["planInterval"] = def["planInterval"].clone();
            context["skillContext"] =
                json!({"requireFiveMinute":def["marketContext"]["requireFiveMinute"]});
            let mut incomplete = false;
            for aux in def["needsAux"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                match research::fresh_market(
                    &self.db,
                    &self.market,
                    symbol,
                    aux,
                    number(&def["marketWindows"][aux], 80.).clamp(30., 1000.) as usize,
                )
                .await
                {
                    Ok(m) => context["auxMarkets"][aux] = m,
                    Err(error) => {
                        errors.push(format!("{symbol}/{aux}: {error}"));
                        incomplete = true;
                    }
                }
            }
            if incomplete {
                continue;
            }
            let now = now_ms();
            let proposal = if order["status"] == "pending" {
                match strategies::analyze(strategy_id, &market, &context) {
                    Ok(raw) => research::normalize_plan(&raw, &market, now),
                    Err(e) => {
                        errors.push(e.to_string());
                        continue;
                    }
                }
            } else {
                match strategies::review(strategy_id, order, &market, &context) {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(e.to_string());
                        continue;
                    }
                }
            };
            if proposal["action"] == "CLOSE" && order["status"] == "open" {
                if let Err(e) = crate::paper::close(&self.db, &self.store, id).await {
                    errors.push(format!("{symbol}: {e}"));
                } else {
                    reviewed += 1;
                }
                continue;
            }
            self.db
                .mutate_account_light(|state| {
                    if let Some(o) = state["orders"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|o| o["id"] == id)
                    {
                        if o["status"] == "pending" {
                            apply_pending(o, &proposal, now)?;
                        } else if o["status"] == "open" {
                            apply_protection(o, &proposal, &market, now)?;
                        }
                    }
                    Ok(json!({"ok":true}))
                })
                .await?;
            reviewed += 1;
        }
        let mut s = self.state.lock().await;
        s["stats"]["totalReviews"] =
            json!(number(&s["stats"]["totalReviews"], 0.) + reviewed as f64);
        Ok(json!({"reviewed":reviewed,"failed":errors.len(),"errors":errors}))
    }
}
fn env_num(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(fallback)
}
fn env_bool(name: &str, fallback: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(fallback)
}
fn score(c: &Value) -> f64 {
    for v in [
        &c["signal"]["plan"]["trendStrengthScore"],
        &c["signal"]["score"],
        &c["signal"]["entryQuality"],
    ] {
        if let Some(n) = v.as_f64() {
            return n;
        }
    }
    number(&c["signal"]["confidence"], 0.) * 100.
}
fn compare_candidates(a: &Value, b: &Value) -> std::cmp::Ordering {
    score(b)
        .total_cmp(&score(a))
        .then_with(|| {
            number(
                &b["signal"]["plan"]["netRr"],
                number(&b["signal"]["plan"]["netRewardRisk"], 0.),
            )
            .total_cmp(&number(
                &a["signal"]["plan"]["netRr"],
                number(&a["signal"]["plan"]["netRewardRisk"], 0.),
            ))
        })
        .then_with(|| {
            number(&a["strategy"]["priority"], 1e9)
                .total_cmp(&number(&b["strategy"]["priority"], 1e9))
        })
        .then_with(|| a["symbol"].as_str().cmp(&b["symbol"].as_str()))
}
fn select_candidates(candidates: &[Value]) -> Vec<Value> {
    let mut selected: BTreeMap<String, Value> = BTreeMap::new();
    for c in candidates {
        let symbol = c["symbol"].as_str().unwrap_or("").to_owned();
        let replace = selected.get(&symbol).is_none_or(|old| {
            let priority = number(&c["strategy"]["priority"], 1e9);
            let prior = number(&old["strategy"]["priority"], 1e9);
            priority < prior || priority == prior && compare_candidates(c, old).is_lt()
        });
        if replace {
            selected.insert(symbol, c.clone());
        }
    }
    selected.into_values().collect()
}
fn entry_guard(state: &Value, c: &Value, _config: &Value) -> Option<String> {
    if state["entriesPaused"] == true {
        return Some("开仓已暂停".into());
    }
    let orders = state["orders"].as_array()?;
    let active: Vec<&Value> = orders
        .iter()
        .filter(|o| o["status"] == "pending" || o["status"] == "open")
        .collect();
    if active.len() as f64 >= env_num("NOFX_MAX_POSITIONS", 10.) {
        return Some("达到持仓上限".into());
    }
    let maximum = number(&c["signal"]["plan"]["maxPositions"], f64::INFINITY);
    if active
        .iter()
        .filter(|o| o["analysisContext"]["strategyId"] == c["strategy"]["id"])
        .count() as f64
        >= maximum
    {
        return Some("达到策略持仓上限".into());
    }
    if active.iter().any(|o| o["symbol"] == c["symbol"]) {
        return Some("币种已有活动订单".into());
    }
    let mut closed: Vec<&Value> = orders.iter().filter(|o| o["status"] == "closed").collect();
    closed.sort_by_key(|o| std::cmp::Reverse(timestamp(&o["exitAt"]).unwrap_or(0)));
    let loss_streak = closed
        .iter()
        .take(env_num("NOFX_CONSECUTIVE_LOSS_LOOKBACK", 20.) as usize)
        .take_while(|o| number(&o["net"], 0.) <= 0.)
        .count();
    if loss_streak as f64 >= env_num("NOFX_CONSECUTIVE_LOSS_HALT", 4.) {
        return Some("连续亏损熔断".into());
    }
    if let Some(previous) = closed.iter().find(|o| o["symbol"] == c["symbol"]) {
        let minutes = if previous["reason"].as_str().unwrap_or("").contains("stop") {
            env_num("NOFX_STOP_COOLDOWN_MIN", 60.)
        } else {
            env_num("NOFX_SYMBOL_COOLDOWN_MIN", 30.)
        };
        if now_ms() - timestamp(&previous["exitAt"]).unwrap_or(0) < (minutes * 60000.) as i64 {
            return Some("币种平仓冷却".into());
        }
    }
    None
}
fn history(order: &mut Value, report: Value) {
    if !order["reviewHistory"].is_array() {
        order["reviewHistory"] = json!([]);
    }
    let list = order["reviewHistory"].as_array_mut().unwrap();
    list.push(report);
    if list.len() > 50 {
        list.drain(..list.len() - 50);
    }
}
pub fn apply_pending(order: &mut Value, signal: &Value, now: i64) -> Result<()> {
    let interval = order["interval"].as_str().unwrap_or("1m");
    let open = research::candle_open(now, interval)?;
    let mut report = json!({"at":iso(now),"action":"held","reason":signal["reason"]});
    if !order["error"].as_str().unwrap_or("").is_empty()
        || (number(&order["nextTime"], 0.) as i64) < open
        || timestamp(&signal["dataAsOf"]) != Some(open)
        || signal["validationIssues"]
            .as_array()
            .is_some_and(|i| !i.is_empty())
    {
        report["reason"] = json!("行情或分析尚未就绪，保留原挂单");
        history(order, report);
        return Ok(());
    }
    let recommendation = signal["positionRecommendation"].as_str().unwrap_or("WAIT");
    let reversal = recommendation.starts_with("OPEN_")
        && signal["positionRecommendation"] != order["direction"]
        && env_bool("NOFX_PENDING_CANCEL_ON_REVERSAL", true);
    let mut cancel = reversal;
    if signal["eligible"] != true && !reversal {
        let rounds = number(&order["ineligibleRounds"], 0.) + 1.;
        let since = number(&order["ineligibleSince"], now as f64);
        order["ineligibleRounds"] = json!(rounds);
        order["ineligibleSince"] = json!(since);
        cancel = rounds >= env_num("NOFX_PENDING_GRACE_ROUNDS", 240.)
            || (now as f64 - since) >= env_num("NOFX_PENDING_GRACE_MIN", 30.) * 60000.;
        report["action"] = json!("held_ineligible");
    } else if !reversal {
        order["ineligibleRounds"] = json!(0);
        order["ineligibleSince"] = Value::Null;
    }
    if cancel {
        order["status"] = json!("cancelled");
        order["reason"] = json!("strategy_cancelled");
        order["cancelledAt"] = json!(iso(now));
        report["action"] = json!("cancelled");
        report["reason"] = json!(if reversal {
            "策略方向反转，取消原挂单"
        } else {
            "不合格信号达到宽限上限，取消挂单"
        });
    }
    history(order, report);
    Ok(())
}
pub fn apply_protection(
    order: &mut Value,
    proposal: &Value,
    market: &Value,
    now: i64,
) -> Result<()> {
    let mut report = proposal.clone();
    report["at"] = json!(iso(now));
    if proposal["action"] == "UPDATE_PROTECTION" {
        let long = order["direction"] == "OPEN_LONG";
        let price = market["klines"]
            .as_array()
            .and_then(|r| r.last())
            .map(|r| number(&r["close"], 0.))
            .unwrap_or(0.);
        let stop = number(&proposal["stopLoss"], 0.);
        let tp = number(&proposal["takeProfit"], 0.);
        let old = strategies::tightest_stop(order, long);
        if stop <= 0.
            || tp <= 0.
            || if long {
                !(stop >= old && stop < price && tp > price)
            } else {
                !(stop <= old && stop > price && tp < price)
            }
        {
            report["action"] = json!("HOLD");
            report["reason"] = json!("保护价格无效或止损松动，保留当前保护价");
        } else {
            let interval = order["interval"].as_str().unwrap_or("1m");
            let effective = research::candle_open(now, interval)?
                + interval_ms(interval).context("无效周期")?;
            report["previous"] = json!({"stopLoss":order["plan"]["stopLoss"],"takeProfit":order["plan"]["takeProfit"]});
            report["effectiveFrom"] = json!(effective);
            order["plan"]["stopLoss"] = json!(stop);
            order["plan"]["takeProfit"] = json!(tp);
            if !order["protectionRevisions"].is_array() {
                order["protectionRevisions"] = json!([]);
            }
            order["protectionRevisions"].as_array_mut().unwrap().push(
                json!({"at":iso(now),"stopLoss":stop,"takeProfit":tp,"effectiveFrom":effective}),
            );
        }
    }
    history(order, report);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn priority_wins_within_symbol() {
        let a = json!({"symbol":"BTCUSDT","strategy":{"priority":1},"signal":{"score":30}});
        let b = json!({"symbol":"BTCUSDT","strategy":{"priority":2},"signal":{"score":90}});
        assert_eq!(select_candidates(&[a.clone(), b]), vec![a]);
    }
    #[test]
    fn protection_cannot_loosen_stop() {
        let mut order = json!({"direction":"OPEN_LONG","interval":"1m","plan":{"stopLoss":99,"takeProfit":110},"initialPlan":{"stopLoss":95},"protectionRevisions":[{"stopLoss":100}]});
        apply_protection(
            &mut order,
            &json!({"action":"UPDATE_PROTECTION","stopLoss":98,"takeProfit":115}),
            &json!({"klines":[{"close":105}]}),
            120000,
        )
        .unwrap();
        assert_eq!(order["plan"]["stopLoss"], 99);
    }
}
