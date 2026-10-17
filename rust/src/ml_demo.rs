//! Bounded, rotating Demo scan using the existing account, order and exit engine.
use crate::{
    automation::{self, Automation},
    iso, ml_edge,
    ml_execution::{self, STRATEGY_ID},
    ml_gateway::Gateway,
    now_ms, number, paper, research, strategies,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub async fn scan(automation: &Automation, token: u64, config: &Value) -> Result<Value> {
    ml_execution::validate_config(config)?;
    let registry = strategies::list(config, &automation.store.read("strategies").await?);
    let strategy = registry["strategies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == STRATEGY_ID)
        .context("模型策略未注册")?
        .clone();
    if strategy["enabled"] != true {
        return Ok(json!({"paused":true,"reason":"模型策略未启用"}));
    }
    {
        let mut status = automation.state.lock().await;
        if !status["ml"].is_object() {
            status["ml"] = json!({});
        }
        status["ml"]["mode"] = json!("demo_auto");
        status["analysisMeta"] = json!({"phase":"syncing","startedAt":iso(now_ms()),"enabledStrategies":1,"analyzed":0,"engine":"monthly-ml"});
    }
    let gateway = Gateway::from_env()?;
    let (status, models) = gateway.request("GET", "/api/ml/models", &json!({})).await;
    ensure!(status.is_success(), "模型服务未就绪：{}", models["error"]);
    ensure!(
        models["data_mode"] == "live_public",
        "Demo 自动交易拒绝冻结模型服务"
    );
    let trained: BTreeSet<&str> = models["manifest"]["symbols"]
        .as_array()
        .context("模型币种清单缺失")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let empty_params = json!({});
    let (contracts, tickers) = tokio::try_join!(
        automation.market.contracts(),
        automation
            .market
            .public_request("/fapi/v1/ticker/24hr", &empty_params)
    )?;
    let ticker_map: BTreeMap<String, Value> = tickers
        .as_array()
        .context("24h 行情无效")?
        .iter()
        .filter_map(|t| Some((t["symbol"].as_str()?.to_owned(), t.clone())))
        .collect();
    let universe = research::symbols(&json!({"symbolsText":config["marketSync"]["symbolsText"]}));
    let entries = research::symbols(&json!({"symbolsText":config["trader"]["entrySymbolsText"]}));
    // Newly listed micro caps are where the measured losses concentrate: the five
    // worst fills were all fresh listings losing 8-13% of notional in one trade.
    // A 5M quote-volume floor let almost every new contract through, so require
    // real turnover and a listing history long enough to have a distribution.
    let minimum =
        crate::automation_guards::env_num("NOFX_MIN_QUOTE_VOL_24H", 50_000_000., 0., f64::MAX);
    let min_listed_days =
        crate::automation_guards::env_num("NOFX_MIN_LISTING_DAYS", 30., 0., 3650.);
    let listed_cutoff = now_ms() - (min_listed_days * 86_400_000.) as i64;
    let onboard: BTreeMap<&str, i64> = contracts
        .iter()
        .filter_map(|c| Some((c["symbol"].as_str()?, number(&c["onboardDate"], 0.) as i64)))
        .collect();
    let mut symbols: Vec<String> = contracts
        .iter()
        .filter_map(|c| c["symbol"].as_str())
        .filter(|s| trained.contains(s))
        .filter(|s| universe.is_empty() || universe.iter().any(|u| u == "ALL" || u == s))
        .filter(|s| entries.is_empty() || entries.iter().any(|u| u == "ALL" || u == s))
        .filter(|s| {
            number(
                &ticker_map.get(*s).unwrap_or(&Value::Null)["quoteVolume"],
                0.,
            ) >= minimum
        })
        .filter(|s| {
            // Missing onboardDate is treated as unknown, not as "listed long ago".
            onboard
                .get(*s)
                .is_some_and(|listed| *listed > 0 && *listed <= listed_cutoff)
        })
        .map(str::to_owned)
        .collect();
    symbols.sort_by(|a, b| {
        number(&ticker_map[b]["quoteVolume"], 0.)
            .total_cmp(&number(&ticker_map[a]["quoteVolume"], 0.))
    });
    ensure!(
        !symbols.is_empty(),
        "当前没有满足模型全集及流动性条件的币种"
    );
    let (cursor, batch) = {
        let s = automation.state.lock().await;
        (
            s["ml"]["cursor"].as_u64().unwrap_or(0) as usize,
            number(&config["ml"]["scanBatchSize"], 20.).clamp(1., 50.) as usize,
        )
    };
    let targets: Vec<_> = (0..batch.min(symbols.len()))
        .map(|i| symbols[(cursor + i) % symbols.len()].clone())
        .collect();
    let mut errors = vec![];
    if let Err(error) = automation
        .db
        .mutate_account_light(|state| ml_execution::observe_account(state, config, now_ms()))
        .await
    {
        errors.push(format!("账户风控等待：{error:#}"));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let maximum = number(&config["trader"]["maxNewEntriesPerCycle"], 1.).clamp(1., 20.) as usize;
    let mut analyzed = 0;
    let mut created = 0;
    let mut submitted = 0;
    let mut cards: Vec<Value> = vec![];
    let mut card_symbols: Vec<String> = vec![];
    let mut outcomes = vec![];
    // Pass one analyses every symbol in the batch but submits nothing: the batch is
    // ranked, and only the best `maxNewEntriesPerCycle` scores get the risk budget.
    // Submitting inside the scan loop meant the slot went to whichever symbol the
    // rotation cursor reached first, which is not a decision about quality.
    let mut ready: Vec<(Value, usize)> = vec![];
    for symbol in &targets {
        if !automation.token_matches(token) {
            break;
        }
        let (status, mut prediction) = gateway
            .request("POST", "/api/ml/pipeline", &json!({"symbol":symbol}))
            .await;
        if !status.is_success() {
            errors.push(format!("{symbol}: {}", prediction["error"]));
            continue;
        }
        analyzed += 1;
        let account = automation.db.account(true, None).await?;
        ml_execution::describe(
            &mut prediction,
            &account,
            config,
            now_ms(),
            automation.active(),
        );
        {
            let mut state = automation.state.lock().await;
            state["analysisMeta"]["phase"] = json!("analyzing");
            state["analysisMeta"]["analyzed"] = json!(analyzed);
            state["ml"]["lastSymbol"] = json!(symbol);
            state["ml"]["lastSignal"] = prediction.clone();
        }
        if prediction["risk_management"]["plan_valid"] != true {
            continue;
        }
        let market =
            match research::fresh_market(&automation.db, &automation.market, symbol, "1h", 256)
                .await
            {
                Ok(market) => market,
                Err(error) => {
                    errors.push(format!("{symbol}: {error:#}"));
                    continue;
                }
            };
        let mut signal = match ml_execution::signal(&prediction, &market, now_ms()) {
            Ok(signal) => signal,
            Err(error) => {
                errors.push(format!("{symbol}: {error:#}"));
                continue;
            }
        };
        if signal["eligible"] != true {
            continue;
        }
        let confirmation = automation
            .market
            .confirmation_context(symbol, &ticker_map[symbol])
            .await;
        signal["opportunityReport"] =
            strategies::opportunity_report(&signal, &market, &confirmation, &strategy, now_ms());
        let mut card = signal["opportunityReport"].clone();
        card["execution"] = json!({"status":"skipped","reason":"Demo 账户或模型开仓条件未满足"});
        let index = cards.len();
        cards.push(card);
        card_symbols.push(symbol.clone());
        if prediction["risk_management"]["entry_permitted"] == true {
            ready.push((
                json!({"symbol":symbol,"signal":signal,"strategy":strategy,"market":market,"prediction":prediction}),
                index,
            ));
        } else if let Some(reason) = prediction["risk_management"]["blocked_reasons"]
            .as_array()
            .and_then(|r| r.first())
        {
            cards[index]["execution"]["reason"] = reason.clone();
        }
    }
    let ranked = ready.len();
    ready.sort_by(|a, b| {
        automation::score(&b.0)
            .total_cmp(&automation::score(&a.0))
            .then_with(|| {
                number(&b.0["signal"]["confidence"], 0.)
                    .total_cmp(&number(&a.0["signal"]["confidence"], 0.))
            })
            .then_with(|| a.0["symbol"].as_str().cmp(&b.0["symbol"].as_str()))
    });
    for (rank, (candidate, index)) in ready.into_iter().enumerate() {
        if !automation.token_matches(token) {
            break;
        }
        if created >= maximum {
            cards[index]["execution"] = json!({"status":"skipped","reason":format!("评分第 {} 位，本轮 {} 个开仓名额已用完", rank + 1, maximum)});
            continue;
        }
        let current = automation.db.account(true, None).await?;
        if let Some(reason) = automation::entry_guard_at(&current, &candidate, config, now_ms()) {
            cards[index]["execution"]["reason"] = json!(reason);
            continue;
        }
        // Same cap the execution boundary applies, derived from the forward window
        // so the order that leaves here is sized by the policy that is running.
        let cap = crate::ml_edge::margin_cap(
            current["orders"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            STRATEGY_ID,
            ml_execution::forward_epoch_ms(),
        );
        let result = submit_candidate(
            automation,
            config,
            &strategy,
            &candidate["signal"],
            &candidate["market"],
            &candidate["prediction"],
            cap,
            (&run_id, token),
        )
        .await;
        match result {
            Ok(order) => {
                created += 1;
                let confirmed = matches!(
                    order["exchangeSync"]["demo"]["status"].as_str(),
                    Some("submitted" | "new" | "partially_filled" | "filled")
                );
                if confirmed {
                    submitted += 1;
                }
                cards[index]["execution"] = json!({"status":if confirmed{"submitted"}else{"created"},"environment":"demo","orderId":order["id"],"exchangeStatus":order["exchangeSync"]["demo"]["status"],"rank":rank+1,"reason":order["exchangeSync"]["demo"]["lastError"]});
            }
            Err(error) => {
                errors.push(format!("{} 开仓：{error:#}", candidate["symbol"]));
                cards[index]["execution"]["reason"] = json!(format!("{error:#}"));
            }
        }
    }
    for (index, symbol) in card_symbols.iter().enumerate() {
        outcomes.push(json!({"symbol":symbol,"execution":cards[index]["execution"]}));
    }
    let forward = {
        let account = automation.db.account(true, None).await?;
        let orders = account["orders"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        ml_edge::forward(orders, STRATEGY_ID, ml_execution::forward_epoch_ms())
    };
    let summary = json!({"mode":"demo_auto","universe":symbols.len(),"batch":targets.len(),"analyzed":analyzed,"ranked":ranked,"created":created,"submitted":submitted,"forward":forward,"execution":outcomes,"failed":errors.len(),"errors":errors,"runId":run_id});
    let mut state = automation.state.lock().await;
    state["ml"]["cursor"] = json!((cursor + targets.len()) % symbols.len());
    state["ml"]["lastRun"] = json!(iso(now_ms()));
    state["ml"]["summary"] = summary.clone();
    state["opportunities"] = json!(cards);
    state["opportunitiesAt"] = json!(iso(now_ms()));
    state["analysisMeta"]["symbols"] = json!(symbols.len());
    state["analysisMeta"]["phase"] = json!("ready");
    state["stats"]["totalAnalyzed"] =
        json!(number(&state["stats"]["totalAnalyzed"], 0.) + analyzed as f64);
    state["stats"]["totalOrders"] =
        json!(number(&state["stats"]["totalOrders"], 0.) + submitted as f64);
    Ok(summary)
}

async fn submit_candidate(
    automation: &Automation,
    config: &Value,
    strategy: &Value,
    signal: &Value,
    market: &Value,
    prediction: &Value,
    margin_cap: f64,
    (run_id, token): (&str, u64),
) -> Result<Value> {
    let now = now_ms();
    let symbol = signal["symbol"].as_str().context("模型币种缺失")?;
    let size = &prediction["risk_management"]["position_size"];
    let margin = number(&size["margin_usdt"], 0.).min(margin_cap);
    let info = automation
        .market
        .contracts()
        .await?
        .into_iter()
        .find(|info| info["symbol"] == symbol)
        .context("合约过滤器缺失")?;
    let price = number(&signal["opportunityReport"]["current"]["price"], 0.);
    ensure!(
        margin >= number(&config["trader"]["minOrderMargin"], 5.),
        "模型仓位低于配置最小保证金"
    );
    ensure!(
        margin >= paper::minimum_entry_notional(&info, price, true)?,
        "模型 50 USDT 上限不能满足交易所最小成交额"
    );
    let book_params = json!({"symbol":symbol});
    let (book, depth) = tokio::try_join!(
        automation
            .market
            .public_request("/fapi/v1/ticker/bookTicker", &book_params),
        automation.market.depth(symbol, 5)
    )?;
    crate::automation_guards::book_check(&book, &depth, margin)?;
    let legacy = json!({"interval":"1h","klineLimit":256,"symbols":[symbol]});
    let mut record = research::create_record(
        config,
        &legacy,
        &[market.clone()],
        &[signal.clone()],
        &json!({"interval":"1h","engine":"monthly-ml"}),
        "automation",
        now,
        Some(strategy),
        &[],
    );
    record["researchOnly"] = json!(false);
    record["executionEnvironment"] = json!("demo");
    record["analysisEngine"] = json!("monthly-ml");
    record["automationRunId"] = json!(run_id);
    record["snapshot"]["model"] = prediction["model_variant"].clone();
    record["snapshot"]["modelFingerprint"] = prediction["model_fingerprint"].clone();
    automation.db.save_record(&record).await?;
    ensure!(
        automation.active() && automation.token_matches(token),
        "自动任务已停止或切换"
    );
    paper::submit(&automation.db,&automation.store,&json!({"recordId":record["id"],"symbol":symbol,"strategyId":STRATEGY_ID,"automatic":true,"margin":margin,"leverage":1,"executionPlan":strategies::execution_plan(signal)})).await
}
