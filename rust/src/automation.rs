use crate::{
    db::Db, exchange::Exchange, interval_ms, iso, now_ms, number, research, store::Store,
    strategies, timestamp,
};
use anyhow::{Context, Result, bail};
use futures::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore};

const SYNC_INTERVALS: [&str; 6] = ["1m", "5m", "15m", "1h", "4h", "1d"];

fn sync_windows(config: &Value, enabled: &[Value]) -> Result<BTreeMap<String, usize>> {
    let limit = number(&config["marketSync"]["limit"], 80.).clamp(80., 1000.) as usize;
    let mut windows: BTreeMap<String, usize> = SYNC_INTERVALS
        .iter()
        .map(|interval| ((*interval).to_owned(), limit))
        .collect();
    let configured = config["marketSync"]["interval"].as_str().unwrap_or("15m");
    interval_ms(configured).context("不支持的同步周期")?;
    windows.insert(configured.to_owned(), limit);
    for strategy in enabled {
        for interval in strategy["needsAux"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .chain(strategy["planInterval"].as_str())
        {
            interval_ms(interval).context("不支持的策略周期")?;
            let window =
                number(&strategy["marketWindows"][interval], 80.).clamp(30., 1000.) as usize;
            windows
                .entry(interval.to_owned())
                .and_modify(|current| *current = (*current).max(window))
                .or_insert(window);
        }
    }
    Ok(windows)
}

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
                json!({"tasks":{"klineSync":{"enabled":true,"interval":6000,"lastRun":null,"running":false},"positionReview":{"enabled":true,"interval":1000,"lastRun":null,"running":false}},"stats":{"totalAnalyzed":0,"totalOrders":0,"totalReviews":0,"errors":[]},"opportunities":[],"opportunitiesAt":null,"analysisMeta":{"phase":"idle","asOf":null,"analyzed":0},"yaoCoins":[],"yaoCoinsAt":null,"yaoCoinError":""}),
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
        let data_only = self.store.read("config").await?["marketSync"]["dataOnly"] == true;
        if self.active.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let token = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        for kind in ["klineSync", "positionReview"] {
            if data_only && kind == "positionReview" {
                self.state.lock().await["tasks"][kind]["enabled"] = json!(false);
                continue;
            }
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
        if !data_only {
            let this = self.clone();
            tokio::spawn(async move {
                while this.active() && this.generation.load(Ordering::SeqCst) == token {
                    if let Err(error) = crate::paper::exchange_refresh(&this.db, &this.store).await
                    {
                        tracing::warn!(%error,"Exchange account synchronization deferred");
                    }
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            });
        }
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
        state["executionStatus"] = execution_status(
            &self.store.read("config").await?,
            &state["account"],
            self.active(),
        );
        state["uptime"] = json!(self.started.elapsed().as_secs_f64());
        state["yaoCoinMeta"] = json!({"targetAmplitudePct":50,"asOf":state["yaoCoinsAt"],"total":state["yaoCoins"].as_array().map(Vec::len).unwrap_or(0),"evaluated":state["analysisMeta"]["marketReady"],"error":state["yaoCoinError"]});
        Ok(state)
    }
    pub async fn sync_status(&self) -> Result<Value> {
        let state = self.state.lock().await.clone();
        let task = &state["tasks"]["klineSync"];
        Ok(
            json!({"running":self.active()&&task["enabled"]!=false,"busy":task["running"],"lastRunAt":task["lastRun"],"nextRunAt":task["nextRunAt"],"lastError":task["error"].as_str().unwrap_or(""),"progress":task["progress"],"interval":"1m","intervals":SYNC_INTERVALS,"intervalSeconds":number(&task["interval"],6000.)/1000.,"provider":"binance","states":self.db.sync_states().await?,"managedBy":"globalAutomation"}),
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
            if kind == "klineSync" {
                state["analysisMeta"]["phase"] = json!(match &result {
                    Ok(summary) if summary["cancelled"] == true => "cancelled",
                    Ok(_) => "ready",
                    Err(_) => "error",
                });
                state["analysisMeta"]["error"] = state["tasks"][kind]["error"].clone();
            }
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
        {
            let mut state = self.state.lock().await;
            state["tasks"]["klineSync"]["running"] = json!(true);
            state["tasks"]["klineSync"]["startedAt"] = json!(iso(now_ms()));
            state["tasks"]["klineSync"]["progress"] =
                json!({"total":symbols.len(),"completed":0,"failed":0,"intervals":[interval]});
        }
        let result = self.fetch_symbols(&symbols, interval, limit).await;
        let mut state = self.state.lock().await;
        let task = &mut state["tasks"]["klineSync"];
        task["running"] = json!(false);
        task["lastRun"] = json!(iso(now_ms()));
        task["error"] = json!(
            result
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default()
        );
        if let Ok(summary) = &result {
            task["summary"] = summary.clone();
        }
        result
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
                    if closed.is_empty() {
                        Err(anyhow::anyhow!("没有已收盘K线"))
                    } else {
                        self.db
                            .save_klines(&key, interval, &closed)
                            .await
                            .map(|n| (n, closed.last().and_then(|r| r["openTime"].as_i64())))
                    }
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
            let mut state = self.state.lock().await;
            let progress = &mut state["tasks"]["klineSync"]["progress"];
            let field = if result.is_ok() {
                "completed"
            } else {
                "failed"
            };
            progress[field] = json!(progress[field].as_u64().unwrap_or(0) + 1);
            (symbol.clone(), result)
        }));
        let results = jobs.buffer_unordered(concurrency).collect::<Vec<_>>().await;
        let mut saved = 0;
        let mut errors = vec![];
        let mut datasets = vec![];
        for (symbol, r) in results {
            match r {
                Ok((n, last)) => {
                    saved += n;
                    datasets.push(
                        json!({"symbol":symbol,"interval":interval,"saved":n,"lastOpenTime":last}),
                    );
                }
                Err(e) => {
                    datasets
                        .push(json!({"symbol":symbol,"interval":interval,"error":e.to_string()}));
                    errors.push(format!("{symbol}: {e}"));
                }
            }
        }
        Ok(
            json!({"source":"binance","symbols":symbols,"interval":interval,"datasets":datasets,"total":symbols.len(),"completed":symbols.len()-errors.len(),"failed":errors.len(),"saved":saved,"errors":errors,"at":iso(now_ms())}),
        )
    }
    async fn sync_universe(
        &self,
        symbols: &[String],
        windows: &BTreeMap<String, usize>,
        token: u64,
    ) -> Value {
        self.state.lock().await["tasks"]["klineSync"]["progress"] = json!({"total":symbols.len(),"completed":0,"failed":0,"intervals":windows.keys().collect::<Vec<_>>()});
        let concurrency = env_num("NOFX_KLINE_SYNC_CONCURRENCY", 12.).clamp(1., 24.) as usize;
        let jobs = futures::stream::iter(symbols.iter().cloned().map(|symbol| async move {
            let mut errors = vec![];
            for (interval, limit) in windows {
                if self.generation.load(Ordering::SeqCst) != token {
                    return errors;
                }
                let result =
                    research::sync_candles(&self.db, &self.market, &symbol, interval, *limit).await;
                let error = result
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .unwrap_or_default();
                let last = result
                    .as_ref()
                    .ok()
                    .and_then(|rows| rows.last())
                    .and_then(|r| r["openTime"].as_i64());
                if let Err(e) = self
                    .db
                    .sync_state(
                        &format!("BINANCE_{symbol}"),
                        interval,
                        last,
                        if result.is_ok() { "ok" } else { "error" },
                        &error,
                    )
                    .await
                {
                    errors.push(format!("{symbol}/{interval} 同步状态：{e}"));
                }
                if let Err(e) = result {
                    errors.push(format!("{symbol}/{interval}: {e}"));
                }
            }
            let mut state = self.state.lock().await;
            let progress = &mut state["tasks"]["klineSync"]["progress"];
            let field = if errors.is_empty() {
                "completed"
            } else {
                "failed"
            };
            progress[field] = json!(progress[field].as_u64().unwrap_or(0) + 1);
            errors
        }));
        let results = jobs.buffer_unordered(concurrency).collect::<Vec<_>>().await;
        let progress = self.state.lock().await["tasks"]["klineSync"]["progress"].clone();
        let errors: Vec<String> = results.into_iter().flatten().collect();
        json!({"total":symbols.len(),"completed":progress["completed"],"failed":progress["failed"],"intervals":progress["intervals"],"errors":errors})
    }
    async fn scan(&self, token: u64) -> Result<Value> {
        let config = self.store.read("config").await?;
        let data_only = config["marketSync"]["dataOnly"] == true;
        let registry = strategies::list(&config, &self.store.read("strategies").await?);
        let enabled: Vec<Value> = registry["strategies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s["enabled"] == true)
            .cloned()
            .collect();
        {
            let mut status = self.state.lock().await;
            status["analysisMeta"] = json!({"phase":"syncing","startedAt":iso(now_ms()),"asOf":status["opportunitiesAt"],"readOnly":data_only,"enabledStrategies":enabled.len(),"analyzed":0,"processedSymbols":0,"marketReady":0,"error":""});
        }
        let contracts = match self.market.contracts().await {
            Ok(contracts) => contracts,
            Err(error) if data_only => {
                self.state.lock().await["analysisMeta"]["marketWarning"] = json!(format!(
                    "合约列表不可用，按本地已同步币种生成只读分析：{error:#}"
                ));
                self.db
                    .sync_states()
                    .await?
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s["symbol"].as_str())
                    .filter_map(|s| s.strip_prefix("BINANCE_"))
                    .filter(|s| s.ends_with("USDT"))
                    .map(str::to_owned)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .map(|s| json!({"symbol":s}))
                    .collect()
            }
            Err(error) => return Err(error),
        };
        let mut symbols: Vec<String> = contracts
            .iter()
            .filter_map(|s| s["symbol"].as_str().map(str::to_owned))
            .collect();
        let universe =
            research::symbols(&json!({"symbolsText":config["marketSync"]["symbolsText"]}));
        if !universe.is_empty() && !universe.iter().any(|s| s == "ALL") {
            symbols.retain(|s| universe.contains(s));
        }
        // Persist every selected contract and timeframe before applying trading screens.
        let sync = self
            .sync_universe(&symbols, &sync_windows(&config, &enabled)?, token)
            .await;
        if self.generation.load(Ordering::SeqCst) != token {
            return Ok(json!({"cancelled":true,"sync":sync}));
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
        let tickers = match self
            .market
            .public_request("/fapi/v1/ticker/24hr", &json!({}))
            .await
        {
            Ok(tickers) => tickers,
            Err(error) if data_only => {
                self.state.lock().await["analysisMeta"]["marketWarning"] = json!(format!(
                    "24h 行情不可用，仅按缓存 K 线展示，等待实时数据恢复：{error:#}"
                ));
                json!([])
            }
            Err(error) => return Err(error),
        };
        let ticker_available = tickers.as_array().is_some_and(|t| !t.is_empty());
        if env_bool("NOFX_LIQUIDITY_SCREEN", true) && (!data_only || ticker_available) {
            let minimum = env_num("NOFX_MIN_QUOTE_VOL_24H", 5_000_000.);
            symbols.retain(|s| {
                tickers
                    .as_array()
                    .and_then(|a| a.iter().find(|t| t["symbol"] == s.as_str()))
                    .is_some_and(|t| number(&t["quoteVolume"], -1.) >= minimum)
            });
        }
        {
            let mut status = self.state.lock().await;
            status["analysisMeta"]["phase"] = json!("analyzing");
            status["analysisMeta"]["symbols"] = json!(symbols.len());
            status["tasks"]["klineSync"]["progress"]["stage"] = json!("生成机会分析与妖币预测");
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let mut candidates = vec![];
        let mut errors: Vec<String> = sync["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let mut analyzed = 0;
        let concurrency = env_num("NOFX_KLINE_SYNC_CONCURRENCY", 12.).clamp(1., 24.) as usize;
        let jobs = futures::stream::iter(symbols.iter().cloned().map(|symbol| async move {
            let result =
                research::display_market(&self.db, &self.market, &symbol, "1m", 80, data_only)
                    .await;
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
            let mut predictions = strategies::yao_predictions(
                &symbols.iter().map(|s| json!(s)).collect::<Vec<_>>(),
                &prepared,
                &ticker_map,
                now_ms(),
                &json!({}),
            );
            for prediction in predictions.as_array_mut().into_iter().flatten() {
                let symbol = prediction["symbol"].as_str().unwrap_or("").to_owned();
                let market = &prepared[&symbol];
                prediction["dataAsOf"] = market["dataAsOf"].clone();
                prediction["cacheOnly"] = json!(
                    market["cacheOnly"] == true
                        || !ticker_available
                        || timestamp(&market["dataAsOf"])
                            != Some(research::candle_open(now_ms(), "1m")?)
                );
                prediction["indicators"] = crate::market_indicators::summarize(
                    &json!({"symbol":symbol}),
                    market,
                    now_ms(),
                );
            }
            let mut status = self.state.lock().await;
            status["yaoCoins"] = predictions;
            status["yaoCoinsAt"] = json!(iso(now_ms()));
            status["yaoCoinError"] = json!("");
            status["analysisMeta"]["marketReady"] = json!(prepared.as_object().unwrap().len());
        }
        for (index, (symbol, main)) in markets.into_iter().enumerate() {
            if self.generation.load(Ordering::SeqCst) != token {
                break;
            }
            {
                let mut status = self.state.lock().await;
                status["analysisMeta"]["processedSymbols"] = json!(index + 1);
                status["analysisMeta"]["symbol"] = json!(symbol);
            }
            let market = match main {
                Ok(m) => m,
                Err(e) => {
                    errors.push(format!("{symbol}: {e}"));
                    continue;
                }
            };
            if (!data_only || ticker_available)
                && crate::automation_guards::enabled("NOFX_LIQUIDITY_SCREEN", true)
                && !crate::automation_guards::screen(&ticker_map[&symbol], Some(&market))
            {
                continue;
            }
            let mut aux = BTreeMap::new();
            let mut shared_confirmation = None;
            let mut shared_indicators = None;
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
                        match research::display_market(
                            &self.db,
                            &self.market,
                            &symbol,
                            interval,
                            window,
                            data_only,
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
                            match research::display_market(
                                &self.db,
                                &self.market,
                                &symbol,
                                tf,
                                count,
                                data_only,
                            )
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
                context["deferMarketFilters"] = json!(true);
                let mut raw = match strategies::analyze(id, &market, &context) {
                    Ok(r) => r,
                    Err(e) => {
                        errors.push(format!("{symbol}/{id}: {e}"));
                        continue;
                    }
                };
                if matches!(raw["action"].as_str(), Some("BUY" | "SELL"))
                    && crate::market_filters::enabled(&strategy["params"])
                {
                    if crate::market_filters::needs_remote(&strategy["params"])
                        && shared_indicators.is_none()
                    {
                        let collected = self
                            .market
                            .indicator_context(&symbol, &ticker_map[&symbol])
                            .await;
                        self.db
                            .save_indicator_samples(
                                &symbol,
                                &crate::indicator_history::samples(&collected),
                            )
                            .await?;
                        shared_indicators = Some(collected);
                    }
                    context["marketContext"] = shared_indicators.clone().unwrap_or(json!({}));
                    context["evaluationAt"] = json!(iso(now_ms()));
                    crate::market_filters::apply(&mut raw, &market, &context);
                }
                analyzed += 1;
                self.state.lock().await["analysisMeta"]["analyzed"] = json!(analyzed);
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
                // Display historical observations at their actual data time; execution still requires now.
                let plan_time = if data_only {
                    timestamp(&plan_market["dataAsOf"]).unwrap_or(now)
                } else {
                    now
                };
                let cache_only = market["cacheOnly"] == true
                    || !ticker_available
                    || aux.values().any(|m| m["cacheOnly"] == true)
                    || timestamp(&market["dataAsOf"]) != Some(research::candle_open(now, "1m")?);
                let mut signal = research::normalize_plan(&raw, &plan_market, plan_time);
                signal["cacheOnly"] = json!(data_only && cache_only);
                signal["strategyId"] = json!(id);
                signal["analysisEngine"] = strategy["engine"].clone();
                signal["confidenceType"] = json!("rule_strength");
                if signal["eligible"] != true {
                    continue;
                }
                if !data_only {
                    if shared_confirmation.is_none() {
                        shared_confirmation = Some(
                            self.market
                                .confirmation_context(&symbol, &ticker_map[&symbol])
                                .await,
                        );
                    }
                    signal["opportunityReport"] = strategies::opportunity_report(
                        &signal,
                        &plan_market,
                        shared_confirmation.as_ref().unwrap(),
                        strategy,
                        now,
                    );
                }
                let record = if data_only {
                    json!({"id":null,"at":iso(now)})
                } else {
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
                    record
                };
                candidates.push(json!({"symbol":symbol,"signal":signal,"record":record,"strategy":strategy,"market":plan_market}));
            }
        }
        if self.generation.load(Ordering::SeqCst) != token {
            return Ok(json!({"cancelled":true,"sync":sync}));
        }
        let mut selected = select_candidates(&candidates);
        selected.sort_by(compare_candidates);
        // Only the selected display cards need the extra confirmation requests.
        if data_only {
            for candidate in selected.iter_mut().take(50) {
                if self.generation.load(Ordering::SeqCst) != token {
                    return Ok(json!({"cancelled":true,"sync":sync}));
                }
                let symbol = candidate["symbol"].as_str().unwrap_or("");
                let context = if candidate["signal"]["cacheOnly"] == true {
                    json!({"errors":{"market":"缓存行情，仅供观察，等待实时数据恢复"}})
                } else {
                    self.market.opportunity_context(symbol).await
                };
                let mut report = strategies::opportunity_report(
                    &candidate["signal"],
                    &candidate["market"],
                    &context,
                    &candidate["strategy"],
                    now_ms(),
                );
                if report.is_object() {
                    mark_display_report(
                        &mut report,
                        candidate["signal"]["cacheOnly"] == true,
                        context["errors"].as_object().is_some_and(|e| !e.is_empty()),
                    );
                }
                candidate["signal"]["opportunityReport"] = report;
            }
        }
        // Collect extended metrics for a bounded union of opportunity and prediction candidates.
        // Baseline confirmation and execution guards continue to cover every eligible candidate.
        let predictions = self.state.lock().await["yaoCoins"].clone();
        let indicator_limit =
            env_num("NOFX_INDICATOR_SYMBOLS_PER_CYCLE", 30.).clamp(0., 50.) as usize;
        let targets = indicator_symbols(&selected, &predictions, indicator_limit);
        {
            let mut status = self.state.lock().await;
            status["analysisMeta"]["phase"] = json!("enriching");
            status["tasks"]["klineSync"]["progress"]["stage"] =
                json!("补齐免费持仓、资金费与成交指标");
        }
        let jobs = futures::stream::iter(targets.iter().cloned().map(|symbol| {
            let ticker = &ticker_map[&symbol];
            async move {
                (
                    symbol.clone(),
                    self.market.indicator_context(&symbol, ticker).await,
                )
            }
        }));
        let mut jobs = jobs.buffer_unordered(3);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut contexts = BTreeMap::new();
        while let Ok(Some((symbol, context))) = tokio::time::timeout_at(deadline, jobs.next()).await
        {
            contexts.insert(symbol, context);
        }
        drop(jobs);
        if self.generation.load(Ordering::SeqCst) != token {
            return Ok(json!({"cancelled":true,"sync":sync}));
        }
        for candidate in &mut selected {
            let symbol = candidate["symbol"].as_str().unwrap_or("");
            if let Some(raw) = contexts.get(symbol) {
                self.db
                    .save_indicator_samples(symbol, &crate::indicator_history::samples(raw))
                    .await?;
                let indicators =
                    crate::market_indicators::summarize(raw, &prepared[symbol], now_ms());
                let long = candidate["signal"]["action"] == "BUY";
                let evidence = crate::market_indicators::evidence(&indicators, long);
                let report = &mut candidate["signal"]["opportunityReport"];
                if report.is_object() {
                    report["indicators"] = indicators;
                    report["evidence"] = json!(evidence);
                }
                if !data_only && let Some(id) = candidate["record"]["id"].as_str() {
                    self.db
                        .record_market_context(id, &candidate["signal"], raw)
                        .await?;
                }
            }
        }
        {
            let mut status = self.state.lock().await;
            for prediction in status["yaoCoins"].as_array_mut().into_iter().flatten() {
                let symbol = prediction["symbol"].as_str().unwrap_or("").to_owned();
                if let Some(raw) = contexts.get(&symbol) {
                    let indicators =
                        crate::market_indicators::summarize(raw, &prepared[&symbol], now_ms());
                    prediction["evidence"] = json!(crate::market_indicators::evidence(
                        &indicators,
                        prediction["direction"] == "UP"
                    ));
                    prediction["indicators"] = indicators;
                }
            }
            status["analysisMeta"]["indicators"] = json!({"requested":targets.len(),"collected":contexts.len(),"symbolLimit":indicator_limit,"timeLimitSeconds":15,"mode":"advisory","asOf":iso(now_ms())});
        }
        // Also retain prediction-only samples, with their actual availability times.
        for (symbol, raw) in &contexts {
            self.db
                .save_indicator_samples(symbol, &crate::indicator_history::samples(raw))
                .await?;
        }
        let opportunities: Vec<Value> = selected
            .iter()
            .filter_map(opportunity_card)
            .take(50)
            .collect();
        {
            let mut status = self.state.lock().await;
            status["opportunities"] = json!(opportunities);
            status["opportunitiesAt"] = json!(iso(now_ms()));
            status["analysisMeta"]["asOf"] = status["opportunitiesAt"].clone();
            status["analysisMeta"]["opportunityCount"] = json!(opportunities.len());
            status["analysisMeta"]["failed"] = json!(errors.len());
            status["stats"]["totalAnalyzed"] =
                json!(number(&status["stats"]["totalAnalyzed"], 0.) + analyzed as f64);
        }
        // Read-only market reports end here, before any order submission or exchange mutation.
        if data_only {
            return Ok(
                json!({"dataOnly":true,"reportsOnly":true,"analyzed":analyzed,"eligible":selected.len(),"submitted":0,"failed":errors.len(),"errors":errors,"runId":run_id,"sync":sync}),
            );
        }
        let mut submitted = 0;
        let mut created = 0;
        let maximum_entries =
            number(&config["trader"]["maxNewEntriesPerCycle"], 1.).max(0.) as usize;
        let mut execution = vec![];
        // Cooldown, available equity and symbol conflicts are rechecked per submission.
        for c in &selected {
            if self.generation.load(Ordering::SeqCst) != token {
                break;
            }
            let current = self.db.account(true, None).await?;
            if let Some(reason) = entry_guard(&current, c, &config) {
                execution.push(execution_skip(c, &reason));
                continue;
            }
            if created >= maximum_entries {
                execution.push(execution_skip(c, "达到每轮新增订单上限"));
                continue;
            }
            let signal = &c["signal"];
            let adaptive = crate::analytics::adaptive_config(&current["adaptiveConfig"]);
            use chrono::Timelike;
            let hour = chrono::Utc::now().hour();
            let history = crate::analytics::closed_orders(&current);
            let adaptive_check = crate::analytics::should_open_position(
                c["symbol"].as_str().unwrap_or(""),
                Some(hour),
                &history,
                &adaptive,
            );
            if adaptive_check["shouldOpen"] != true {
                let reason = adaptive_check["reasons"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("；");
                execution.push(execution_skip(
                    c,
                    if reason.is_empty() {
                        "自适应历史表现或时段规则暂不允许开仓"
                    } else {
                        &reason
                    },
                ));
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
                    execution.push(execution_skip(c, "评分仓位规则暂不允许开仓"));
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
            let available = if !current["fusedPoolStartedAt"].is_null() {
                if funds["canOpen"] != true {
                    let reason = funds["warnings"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("；");
                    execution.push(execution_skip(
                        c,
                        if reason.is_empty() {
                            "资金池暂不允许开仓"
                        } else {
                            &reason
                        },
                    ));
                    continue;
                }
                Some(number(&funds["available"], 0.))
            } else {
                None
            };
            let symbol = c["symbol"].as_str().unwrap_or("");
            let market_entry = signal["plan"]["entryStyle"] == "market";
            let price = if market_entry {
                number(&signal["opportunityReport"]["current"]["price"], 0.)
            } else {
                number(&signal["plan"]["entryLimit"], 0.)
            };
            let minimum_notional = match contracts.iter().find(|info| info["symbol"] == symbol) {
                Some(info) => crate::paper::minimum_entry_notional(info, price, market_entry),
                None => Err(anyhow::anyhow!("合约数量过滤器未就绪")),
            };
            let minimum_notional = match minimum_notional {
                Ok(value) => value,
                Err(error) => {
                    execution.push(execution_skip(c, &format!("最小下单规模：{error}")));
                    continue;
                }
            };
            let Some((leverage, margin)) = crate::automation_guards::entry_size(
                equity,
                margin_pct,
                leverage,
                min_margin,
                number(&config["trader"]["maxPositionNotionalPct"], 0.),
                available,
                minimum_notional,
            ) else {
                execution.push(execution_skip(
                    c,
                    "资金或名义仓位上限不足以满足最小下单规模",
                ));
                continue;
            };
            if crate::automation_guards::enabled("NOFX_LIQUIDITY_SCREEN", true) {
                let symbol = c["symbol"].as_str().unwrap_or("");
                let params = json!({"symbol":symbol});
                let levels =
                    crate::automation_guards::env_num("NOFX_BOOK_LEVELS", 5., 1., 50.) as usize;
                let (book, depth) = tokio::join!(
                    self.market
                        .public_request("/fapi/v1/ticker/bookTicker", &params),
                    self.market.depth(symbol, levels)
                );
                match (book, depth) {
                    (Ok(book), Ok(depth)) => {
                        if let Err(error) =
                            crate::automation_guards::book_check(&book, &depth, margin * leverage)
                        {
                            errors.push(format!("{symbol} 盘口：{error}"));
                            execution.push(execution_skip(c, &format!("盘口风控：{error}")));
                            continue;
                        }
                    }
                    (book, depth) => {
                        let detail = [("买卖报价", book), ("盘口深度", depth)]
                            .into_iter()
                            .filter_map(|(name, result)| {
                                result.err().map(|error| format!("{name}：{error:#}"))
                            })
                            .collect::<Vec<_>>()
                            .join("；");
                        let reason = format!("盘口数据不可用，跳过开仓：{detail}");
                        errors.push(format!("{symbol} {reason}"));
                        execution.push(execution_skip(c, &reason));
                        continue;
                    }
                }
            }
            let input = json!({"recordId":c["record"]["id"],"symbol":c["symbol"],"strategyId":c["strategy"]["id"],"automatic":true,"margin":margin,"autoMarginPct":margin_pct,"leverage":leverage,"executionPlan":strategies::execution_plan(signal)});
            match crate::paper::submit(&self.db, &self.store, &input).await {
                Ok(order) => {
                    created += 1;
                    let mut result = execution_outcome(&order, &config);
                    result["strategyId"] = c["strategy"]["id"].clone();
                    if result["status"] == "submitted" || result["status"] == "paper_created" {
                        submitted += 1;
                    } else if result["status"] == "execution_failed" {
                        errors.push(format!(
                            "{}: {}",
                            c["symbol"].as_str().unwrap_or(""),
                            result["reason"].as_str().unwrap_or("交易所执行失败")
                        ));
                    }
                    execution.push(result);
                }
                Err(e) => {
                    errors.push(format!("{}: {e}", c["symbol"]));
                    execution.push(execution_skip(c, &e.to_string()));
                }
            }
        }
        let mut s = self.state.lock().await;
        for card in s["opportunities"].as_array_mut().into_iter().flatten() {
            if let Some(result) = execution.iter().find(|r| r["symbol"] == card["symbol"]) {
                card["execution"] = result.clone();
            }
        }
        s["stats"]["totalOrders"] =
            json!(number(&s["stats"]["totalOrders"], 0.) + submitted as f64);
        Ok(
            json!({"analyzed":analyzed,"eligible":selected.len(),"created":created,"submitted":submitted,"execution":execution,"failed":errors.len(),"errors":errors,"runId":run_id,"sync":sync}),
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
            if order["status"] == "pending"
                && crate::market_filters::needs_remote(&context["params"])
            {
                context["marketContext"] = self.market.indicator_context(symbol, &json!({})).await;
                context["evaluationAt"] = json!(iso(now));
            }
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
fn trading_mode_block(config: &Value) -> Option<&'static str> {
    if config["marketSync"]["dataOnly"] == true {
        return Some("采集与分析展示模式，自动下单关闭");
    }
    if config["trader"]["enabled"] != true {
        return Some("自动交易未开启");
    }
    if config["trader"]["dryRun"] == true {
        return Some("试运行模式，不提交订单");
    }
    if config["trader"]["allowEntryOrders"] != true {
        return Some("新增订单开关未开启");
    }
    None
}
fn execution_status(config: &Value, account: &Value, active: bool) -> Value {
    let block = trading_mode_block(config);
    let targets = ["demo", "live"]
        .into_iter()
        .filter(|env| {
            config["trader"][if *env == "demo" {
                "syncPaperOrdersToDemo"
            } else {
                "syncPaperOrdersToLive"
            }] == true
        })
        .collect::<Vec<_>>();
    let reason = if let Some(reason) = block {
        reason.to_owned()
    } else if !active {
        "自动任务已停止".into()
    } else if account["canOpen"] == false {
        let warnings = account["warnings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("；");
        if warnings.is_empty() {
            "资金池暂不允许开仓".into()
        } else {
            warnings
        }
    } else {
        String::new()
    };
    json!({"readOnly":config["marketSync"]["dataOnly"]==true,"enabled":block.is_none(),"ready":reason.is_empty(),"mode":if targets.is_empty(){"paper".to_owned()}else{targets.join("+")},"reason":reason})
}
fn execution_skip(candidate: &Value, reason: &str) -> Value {
    json!({"symbol":candidate["symbol"],"strategyId":candidate["strategy"]["id"],"status":"skipped","reason":reason})
}
fn execution_outcome(order: &Value, config: &Value) -> Value {
    let targets: Vec<Value> = ["demo", "live"].into_iter()
        .filter(|env| config["trader"][if *env == "demo" { "syncPaperOrdersToDemo" } else { "syncPaperOrdersToLive" }] == true)
        .map(|env| { let link = &order["exchangeSync"][env]; json!({"environment":env,"status":link["status"],"orderId":link["orderId"],"lastError":link["lastError"]}) }).collect();
    let accepted = targets.iter().any(|t| {
        !t["orderId"].is_null()
            && matches!(
                t["status"].as_str(),
                Some("new" | "partially_filled" | "filled" | "submitted")
            )
    });
    let status = if targets.is_empty() {
        "paper_created"
    } else if accepted {
        "submitted"
    } else if targets
        .iter()
        .any(|t| t["status"] == "unknown" || t["status"] == "submitting")
    {
        "reconciling"
    } else {
        "execution_failed"
    };
    let reason = match status {
        "paper_created" => "模拟订单已创建".to_owned(),
        "submitted" => "交易所已确认接收订单".to_owned(),
        "reconciling" => "订单执行结果待对账，不重复发送".to_owned(),
        _ => targets
            .iter()
            .map(|t| {
                format!(
                    "{}：{}",
                    t["environment"].as_str().unwrap_or(""),
                    t["lastError"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or(t["status"].as_str())
                        .unwrap_or("交易所未确认订单")
                )
            })
            .collect::<Vec<_>>()
            .join("；"),
    };
    json!({"symbol":order["symbol"],"orderId":order["id"],"status":status,"reason":reason,"targets":targets})
}
fn mark_display_report(report: &mut Value, cache_only: bool, context_missing: bool) {
    report["readOnly"] = json!(true);
    report["cacheOnly"] = json!(cache_only);
    if cache_only || context_missing {
        let reason = if cache_only {
            "缓存行情仅供观察，请核对数据时间并等待实时行情恢复。"
        } else {
            "确认数据暂时不完整，等待实时确认数据恢复。"
        };
        report["canProceed"] = json!(false);
        report["recommendation"] = json!("HOLD");
        report["decision"] = json!({"code":"WAIT_FRESH_DATA","label":"等待实时数据确认","canProceed":false,"reason":reason});
        report["summary"] = json!(format!(
            "{}；数据时间 {}。{}",
            report["symbol"].as_str().unwrap_or(""),
            report["dataAsOf"].as_str().unwrap_or("未知"),
            reason
        ));
        if let Some(warnings) = report["warnings"].as_array_mut() {
            warnings.insert(0, json!(reason));
        }
    }
}

fn opportunity_card(candidate: &Value) -> Option<Value> {
    let mut report = candidate["signal"]["opportunityReport"].clone();
    if !report.is_object() {
        return None;
    }
    report["recordId"] = candidate["record"]["id"].clone();
    report["at"] = candidate["record"]["at"].clone();
    Some(report)
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
fn indicator_symbols(selected: &[Value], predictions: &Value, limit: usize) -> Vec<String> {
    if limit == 0 {
        return vec![];
    }
    let mut symbols = vec![];
    for candidate in selected
        .iter()
        .filter(|c| c["signal"]["cacheOnly"] != true)
        .take((limit * 2 / 3).max(1))
    {
        if let Some(symbol) = candidate["symbol"].as_str() {
            symbols.push(symbol.to_owned());
        }
    }
    for prediction in predictions
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["cacheOnly"] != true)
    {
        if symbols.len() >= limit {
            break;
        }
        if let Some(symbol) = prediction["symbol"].as_str()
            && !symbols.iter().any(|s| s == symbol)
        {
            symbols.push(symbol.to_owned());
        }
    }
    symbols
}
fn entry_guard(state: &Value, c: &Value, config: &Value) -> Option<String> {
    entry_guard_at(state, c, config, now_ms())
}
pub fn entry_guard_at(state: &Value, c: &Value, config: &Value, now: i64) -> Option<String> {
    if let Some(reason) = trading_mode_block(config) {
        return Some(reason.into());
    }
    if number(&c["signal"]["confidence"], 0.) < number(&config["trader"]["minConfidence"], 0.45) {
        return Some("信号置信度低于开仓门槛".into());
    }
    if (c["signal"]["plan"]["entryStyle"] == "market"
        || number(&c["signal"]["plan"]["entryLimit"], 0.) <= 0.)
        && c["signal"]["opportunityReport"]["canProceed"] != true
    {
        return Some(
            c["signal"]["opportunityReport"]["decision"]["reason"]
                .as_str()
                .unwrap_or("市价入场尚未通过确认")
                .into(),
        );
    }
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
    if let Some(previous) = closed.iter().find(|o| o["symbol"] == c["symbol"]) {
        let minutes = if previous["reason"].as_str().unwrap_or("").contains("stop") {
            env_num("NOFX_STOP_COOLDOWN_MIN", 60.)
        } else {
            env_num("NOFX_SYMBOL_COOLDOWN_MIN", 30.)
        };
        if now - timestamp(&previous["exitAt"]).unwrap_or(0) < (minutes * 60000.) as i64 {
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
#[path = "automation/sync_tests.rs"]
mod sync_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entry_confidence_uses_the_lower_default_threshold() {
        let mut config = crate::store::default_config();
        config["trader"]["enabled"] = json!(true);
        config["trader"]["dryRun"] = json!(false);
        config["trader"]["allowEntryOrders"] = json!(true);
        assert_eq!(config["trader"]["minConfidence"], 0.45);
        let account = json!({"orders":[]});
        let mut candidate = json!({"symbol":"TESTUSDT","strategy":{"id":"test"},"signal":{"confidence":0.45,"plan":{"entryLimit":100}}});
        assert_eq!(entry_guard_at(&account, &candidate, &config, 0), None);
        config["trader"]
            .as_object_mut()
            .unwrap()
            .remove("minConfidence");
        assert_eq!(entry_guard_at(&account, &candidate, &config, 0), None);
        candidate["signal"]["confidence"] = json!(0.449);
        assert_eq!(
            entry_guard_at(&account, &candidate, &config, 0).as_deref(),
            Some("信号置信度低于开仓门槛")
        );
        config["trader"]["minConfidence"] = json!(0.6);
        candidate["signal"]["confidence"] = json!(0.5);
        assert_eq!(
            entry_guard_at(&account, &candidate, &config, 0).as_deref(),
            Some("信号置信度低于开仓门槛")
        );
    }
    #[test]
    fn losing_history_allows_entries_and_keeps_symbol_cooldowns() {
        let config = json!({"trader":{"enabled":true,"dryRun":false,"allowEntryOrders":true,"minConfidence":0.45}});
        let now = 1_800_000_000_000_i64;
        let mut account = json!({"orders":(0..5).map(|i|json!({"symbol":format!("LOSS{i}USDT"),"status":"closed","net":-1,"exitAt":iso(now-60_000*(i+1)),"reason":"stop_loss"})).collect::<Vec<_>>()});
        let mut candidate = json!({"symbol":"TESTUSDT","strategy":{"id":"test"},"signal":{"confidence":0.45,"plan":{"entryLimit":100}}});
        assert_eq!(entry_guard_at(&account, &candidate, &config, now), None);
        candidate["symbol"] = json!("LOSS0USDT");
        assert_eq!(
            entry_guard_at(&account, &candidate, &config, now).as_deref(),
            Some("币种平仓冷却")
        );
        account["orders"][0]["status"] = json!("open");
        assert_eq!(
            entry_guard_at(&account, &candidate, &config, now).as_deref(),
            Some("币种已有活动订单")
        );
    }
    #[test]
    fn execution_requires_trading_mode_and_keeps_limit_waiting_separate() {
        let mut config = json!({"marketSync":{"dataOnly":true},"trader":{"enabled":true,"dryRun":false,"allowEntryOrders":true,"minConfidence":0.65,"syncPaperOrdersToDemo":true}});
        let account = json!({"orders":[],"canOpen":true});
        let mut candidate = json!({"symbol":"TESTUSDT","strategy":{"id":"test"},"signal":{"confidence":0.9,"plan":{"entryLimit":100},"opportunityReport":{"canProceed":false}}});
        assert!(
            entry_guard(&account, &candidate, &config)
                .unwrap()
                .contains("自动下单关闭")
        );
        assert_eq!(execution_status(&config, &account, true)["ready"], false);
        config["marketSync"]["dataOnly"] = json!(false);
        assert!(entry_guard(&account, &candidate, &config).is_none());
        candidate["signal"]["plan"]["entryLimit"] = json!(0);
        assert!(entry_guard(&account, &candidate, &config).is_some());
        candidate["signal"]["opportunityReport"]["canProceed"] = json!(true);
        assert!(entry_guard(&account, &candidate, &config).is_none());
        config["trader"]["dryRun"] = json!(true);
        assert!(
            entry_guard(&account, &candidate, &config)
                .unwrap()
                .contains("试运行")
        );
    }
    #[test]
    fn saved_local_order_does_not_count_as_confirmed_exchange_submission() {
        let config = json!({"trader":{"syncPaperOrdersToDemo":true}});
        let mut order = json!({"id":"local-1","symbol":"TESTUSDT","exchangeSync":{"demo":{"status":"rejected","orderId":null,"lastError":"计划价格已被穿越"}}});
        let failed = execution_outcome(&order, &config);
        assert_eq!(failed["status"], "execution_failed");
        assert!(
            failed["reason"]
                .as_str()
                .unwrap()
                .contains("计划价格已被穿越")
        );
        order["exchangeSync"]["demo"]["status"] = json!("unknown");
        assert_eq!(execution_outcome(&order, &config)["status"], "reconciling");
        order["exchangeSync"]["demo"]["status"] = json!("new");
        order["exchangeSync"]["demo"]["orderId"] = json!(123);
        assert_eq!(execution_outcome(&order, &config)["status"], "submitted");
    }
    #[test]
    fn opportunity_cards_expose_confirmation_fields_to_the_frontend() {
        let now = now_ms();
        let strategy = json!({"id":"enhanced-trend-v1","name":"增强趋势 v1"});
        let market = json!({"symbol":"TESTUSDT","interval":"1m","klines":[{"close":100.}],"dataAsOf":iso(now)});
        let signal = json!({"symbol":"TESTUSDT","action":"BUY","strategyId":"enhanced-trend-v1","confidence":0.8,"plan":{"entryMin":99.,"entryMax":101.,"entryLimit":100.,"stopLoss":95.,"takeProfit":110.}});
        let report = strategies::opportunity_report(&signal, &market, &json!({}), &strategy, now);
        let card = opportunity_card(&json!({"signal":{"opportunityReport":report},"record":{"id":"record-1","at":iso(now)}})).unwrap();
        assert_eq!(card["symbol"], "TESTUSDT");
        assert_eq!(card["current"]["price"], 100.);
        assert_eq!(card["levels"]["entryRange"]["min"], 99.);
        assert_eq!(card["levels"]["stopLoss"], 95.);
        assert_eq!(card["decision"]["code"], "BUY_NOW");
        assert_eq!(card["recordId"], "record-1");
        assert!(card["generatedAt"].is_string());
        assert!(opportunity_card(&json!({"signal":{"opportunityReport":null}})).is_none());
    }
    #[test]
    fn auxiliary_collection_is_bounded_deduplicated_and_skips_cached_signals() {
        let selected = vec![
            json!({"symbol":"AUSDT"}),
            json!({"symbol":"BUSDT"}),
            json!({"symbol":"CUSDT","signal":{"cacheOnly":true}}),
        ];
        let predictions = json!([{"symbol":"AUSDT"},{"symbol":"DUSDT","cacheOnly":true},{"symbol":"EUSDT"},{"symbol":"FUSDT"}]);
        assert_eq!(
            indicator_symbols(&selected, &predictions, 3),
            vec!["AUSDT", "BUSDT", "EUSDT"]
        );
        assert!(indicator_symbols(&selected, &predictions, 0).is_empty());
        assert_eq!(indicator_symbols(&selected, &predictions, 1), vec!["AUSDT"]);
    }
    #[test]
    fn sync_covers_standard_intervals_without_enabled_strategies() {
        let windows =
            sync_windows(&json!({"marketSync":{"interval":"1w","limit":100}}), &[]).unwrap();
        for interval in SYNC_INTERVALS.into_iter().chain(["1w"]) {
            assert_eq!(windows[interval], 100);
        }
        assert!(sync_windows(&json!({"marketSync":{"interval":"invalid"}}), &[]).is_err());
    }
    #[test]
    fn sync_uses_largest_strategy_window_for_every_contract() {
        let strategies = vec![
            json!({"needsAux":["15m","4h"],"marketWindows":{"15m":200,"4h":300}}),
            json!({"needsAux":["15m","1h"],"marketWindows":{"15m":500,"1h":500},"planInterval":"4h"}),
        ];
        let windows = sync_windows(&json!({}), &strategies).unwrap();
        assert_eq!(windows["15m"], 500);
        assert_eq!(windows["1h"], 500);
        assert_eq!(windows["4h"], 300);
        assert_eq!(windows["5m"], 80);
    }
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
#[test]
fn cached_display_reports_cannot_recommend_execution() {
    let mut report = json!({"symbol":"BTCUSDT","dataAsOf":"2026-10-08T01:00:00Z","canProceed":true,"recommendation":"BUY","decision":{"code":"BUY_NOW"},"warnings":[]});
    mark_display_report(&mut report, true, false);
    assert_eq!(report["readOnly"], true);
    assert_eq!(report["cacheOnly"], true);
    assert_eq!(report["canProceed"], false);
    assert_eq!(report["recommendation"], "HOLD");
    assert_eq!(report["decision"]["code"], "WAIT_FRESH_DATA");
    assert!(
        report["summary"]
            .as_str()
            .unwrap()
            .contains("2026-10-08T01:00:00Z")
    );
}
