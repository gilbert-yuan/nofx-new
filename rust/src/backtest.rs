//! Chronological, single-symbol replay through the production strategy and paper engine.
use crate::{
    automation, automation_guards,
    db::Db,
    exchange::storage_symbol,
    indicator_history::{self, Sample, Timeline},
    interval_ms, iso, number, paper, research, simulator, strategies, timestamp,
};
use anyhow::{Context, Result, bail};
use chrono::Timelike;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn combinations(id: &str, base: &Value, grid: &Value) -> Result<Vec<Value>> {
    let def = strategies::definition(id).context("400: 未知策略")?;
    let resolved = strategies::resolve_params(id, base)?;
    if resolved["rejected"]
        .as_array()
        .is_some_and(|r| !r.is_empty())
    {
        bail!("400: 回测参数越界：{}", resolved["rejected"]);
    }
    let mut combinations = vec![resolved["params"].clone()];
    if !grid.is_null() && !grid.is_object() {
        bail!("400: grid 必须是参数名到候选数组的 JSON 对象");
    }
    for (key, values) in grid.as_object().into_iter().flatten() {
        if !def["paramSchema"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["key"] == key.as_str())
        {
            bail!("400: 未知网格参数 {key}");
        }
        let values = values
            .as_array()
            .filter(|v| !v.is_empty())
            .context("400: 网格候选必须是非空数组")?;
        if combinations.len() * values.len() > 64 {
            bail!("400: 网格最多 64 个参数组合");
        }
        let mut next = vec![];
        for params in &combinations {
            for value in values {
                let mut override_params = params.clone();
                override_params[key] = value.clone();
                let resolved = strategies::resolve_params(id, &override_params)?;
                if !resolved["rejected"].as_array().unwrap().is_empty() {
                    bail!("400: {key} 的候选值越界或类型无效");
                }
                next.push(resolved["params"].clone());
            }
        }
        combinations = next;
    }
    Ok(combinations)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct History {
    pub datasets: BTreeMap<String, Vec<Value>>,
    pub samples: Vec<Sample>,
}

pub fn trading_config(config: &Value) -> Value {
    let mut local = config.clone();
    if !local.is_object() {
        local = json!({});
    }
    local["marketSync"]["dataOnly"] = json!(false);
    local["trader"]["enabled"] = json!(true);
    local["trader"]["dryRun"] = json!(false);
    local["trader"]["allowEntryOrders"] = json!(true);
    local
}

pub async fn load_history(
    db: &Db,
    symbol: &str,
    id: &str,
    start: i64,
    end: i64,
) -> Result<History> {
    let def = strategies::definition(id).context("未知策略")?;
    let mut intervals = BTreeMap::from([("1m".to_string(), 1520_usize)]);
    for tf in def["needsAux"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        intervals.insert(tf.into(), number(&def["marketWindows"][tf], 200.) as usize);
    }
    if let Some(tf) = def["planInterval"].as_str() {
        intervals.entry(tf.into()).or_insert(200);
    }
    let mut datasets = BTreeMap::new();
    for (tf, window) in intervals {
        let dt = interval_ms(&tf).context("周期无效")?;
        let rows = db
            .candles(
                &storage_symbol(symbol, "binance")?,
                &tf,
                10_000_000,
                Some(start - (window as i64 + 2) * dt),
                Some(end),
            )
            .await?;
        if rows.is_empty() {
            bail!("400: {symbol}/{tf} 无历史，请先补历史数据");
        }
        datasets.insert(tf, rows);
    }
    let samples = db
        .indicator_samples(symbol, start - 2 * 86_400_000, end)
        .await?;
    Ok(History { datasets, samples })
}

fn market_at(symbol: &str, tf: &str, rows: &[Value], window: usize, now: i64) -> Result<Value> {
    let dt = interval_ms(tf).context("无效周期")?;
    let end = rows.partition_point(|r| timestamp(&r["openTime"]).unwrap_or(i64::MAX) + dt <= now);
    research::prepare_market(
        symbol,
        tf,
        &rows[end.saturating_sub(window)..end],
        window,
        now,
    )
}
fn ticker_at(symbol: &str, rows: &[Value], now: i64) -> Value {
    let end =
        rows.partition_point(|r| timestamp(&r["openTime"]).unwrap_or(i64::MAX) + 60_000 <= now);
    let rows = &rows[end.saturating_sub(1440)..end];
    let first = rows.first().map(|r| number(&r["open"], 0.)).unwrap_or(0.);
    let last = rows.last().map(|r| number(&r["close"], 0.)).unwrap_or(0.);
    let complete = rows.len() == 1440
        && rows.windows(2).all(|r| {
            timestamp(&r[1]["openTime"]).unwrap_or(0) - timestamp(&r[0]["openTime"]).unwrap_or(0)
                == 60_000
        });
    json!({"symbol":symbol,"lastPrice":last,"closeTime":now,"priceChangePercent":if complete && first>0.{json!((last/first-1.)*100.)}else{Value::Null},"quoteVolume":if complete{json!(rows.iter().map(|r|number(&r["quoteVolume"],0.)).sum::<f64>())}else{Value::Null},"origin":"closed_1m_24h_window"})
}

#[expect(
    clippy::too_many_arguments,
    reason = "explicit immutable replay inputs avoid account or exchange side effects"
)]
pub fn replay(
    symbol: &str,
    id: &str,
    params: &Value,
    datasets: &BTreeMap<String, Vec<Value>>,
    samples: &[Sample],
    config: &Value,
    start: i64,
    end: i64,
    initial: f64,
    adaptive: &Value,
) -> Result<Value> {
    let mut def = strategies::definition(id).context("未知策略")?;
    def["params"] = params.clone();
    let main = datasets
        .get("1m")
        .context("400: 没有主周期历史 K 线，请先补历史数据")?;
    let mut timeline = Timeline::new(samples);
    let mut state = json!({"initialBalance":initial,"unlimitedCapital":false,"orders":[]});
    let mut peak = initial;
    let mut drawdown: f64 = 0.;
    let mut missing = BTreeMap::<String, usize>::new();
    let mut blocked = BTreeMap::<String, usize>::new();
    let mut raw_entries = 0;
    let mut filtered = 0;
    let mut analyzed = 0;
    let mut market_gaps = 0;
    let mut submitted = 0;
    let plan_tf = def["planInterval"].as_str().unwrap_or("1m");
    for row in main {
        let now = timestamp(&row["openTime"]).context("K 线时间无效")? + 60_000;
        if now < start || now > end {
            continue;
        }
        // Advance only already-closed bars. A new signal can never fill in its own signal bar.
        for order in state["orders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .filter(|o| matches!(o["status"].as_str(), Some("open" | "pending")))
        {
            let tf = order["interval"].as_str().unwrap_or("1m").to_owned();
            let rows = datasets.get(&tf).context("缺少计划周期 K 线")?;
            let dt = interval_ms(&tf).context("无效计划周期")?;
            let upto =
                rows.partition_point(|r| timestamp(&r["openTime"]).unwrap_or(i64::MAX) + dt <= now);
            let next = timestamp(&order["nextTime"]).unwrap_or(now);
            let from = rows
                .partition_point(|r| timestamp(&r["openTime"]).unwrap_or(i64::MAX) < next)
                .min(upto.saturating_sub(200));
            paper::advance_paper_order(order, &rows[from..upto], now)?;
            if !order["error"].as_str().unwrap_or("").is_empty() {
                bail!("400: 成交回放有 K 线断档：{}", order["error"]);
            }
            if order["status"] == "open" && now % dt == 0 {
                let market = market_at(symbol, &tf, rows, 80, now)?;
                let review = strategies::review(
                    id,
                    order,
                    &market,
                    &json!({"params":params,"costs":order["costs"]}),
                )?;
                if review["action"] == "CLOSE" {
                    let close = number(
                        &market["klines"].as_array().unwrap().last().unwrap()["close"],
                        0.,
                    );
                    let result = simulator::close_order(
                        order,
                        close,
                        now,
                        "strategy_close",
                        &json!({"mode":"account"}),
                    )?;
                    order
                        .as_object_mut()
                        .unwrap()
                        .extend(result.as_object().unwrap().clone());
                } else {
                    automation::apply_protection(order, &review, &market, now)?;
                }
            }
        }
        let funds = paper::account_summary(&state, now);
        let equity = number(&funds["equity"], initial);
        peak = peak.max(equity);
        if peak > 0. {
            drawdown = drawdown.max((peak - equity) / peak);
        }
        if now == end {
            break;
        }
        let market = match market_at(symbol, "1m", main, 80, now) {
            Ok(m) => m,
            Err(_) => {
                market_gaps += 1;
                continue;
            }
        };
        let mut ctx = json!({"params":params,"state":state,"costs":research::costs(),"auxMarkets":{},"planInterval":def["planInterval"],"skillContext":{"requireFiveMinute":def["marketContext"]["requireFiveMinute"]},"evaluationAt":iso(now)});
        let mut incomplete = false;
        for tf in def["needsAux"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let rows = datasets
                .get(tf)
                .context("400: 缺少辅助周期历史，请先补历史数据")?;
            match market_at(
                symbol,
                tf,
                rows,
                number(&def["marketWindows"][tf], 80.) as usize,
                now,
            ) {
                Ok(m) => ctx["auxMarkets"][tf] = m,
                Err(_) => {
                    incomplete = true;
                    break;
                }
            }
        }
        if incomplete {
            market_gaps += 1;
            continue;
        }
        let mut raw_context = timeline.at(symbol, now);
        let ticker = ticker_at(symbol, main, now);
        raw_context["ticker24h"] = ticker.clone();
        raw_context["meta"]["ticker24h"] =
            json!({"fetchedAt":iso(now),"origin":"closed_1m_24h_window"});
        ctx["marketContext"] = raw_context.clone();
        let mut raw = strategies::analyze(id, &market, &ctx)?;
        analyzed += 1;
        if let Some(checks) = raw["marketFilter"]["checks"].as_array() {
            raw_entries += 1;
            for check in checks.iter().filter(|c| c["missing"] == true) {
                *missing
                    .entry(check["key"].as_str().unwrap_or("unknown").into())
                    .or_default() += 1;
            }
            if raw["marketFilter"]["passed"] == false {
                filtered += 1;
            }
        } else if matches!(raw["action"].as_str(), Some("BUY" | "SELL")) {
            raw_entries += 1;
        }
        // Pending re-evaluation shares the production grace/reversal policy.
        let plan_market = if plan_tf == "1m" {
            market.clone()
        } else {
            ctx["auxMarkets"][plan_tf].clone()
        };
        if !plan_market.is_object() {
            market_gaps += 1;
            continue;
        }
        raw["maxHoldBarsLimit"] = params["maxHoldBars"].clone();
        let mut signal = research::normalize_plan(&raw, &plan_market, now);
        signal["strategyId"] = json!(id);
        for order in state["orders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .filter(|o| o["status"] == "pending")
        {
            if plan_tf == "1m" {
                automation::apply_pending(order, &signal, now)?;
            }
        }
        if signal["eligible"] != true {
            continue;
        }
        signal["opportunityReport"] =
            strategies::opportunity_report(&signal, &plan_market, &raw_context, &def, now);
        let candidate = json!({"symbol":symbol,"signal":signal,"strategy":def});
        if let Some(reason) = automation::entry_guard_at(&state, &candidate, config, now) {
            *blocked.entry(reason).or_default() += 1;
            continue;
        }
        let closed = crate::analytics::closed_orders(&state);
        let hour = chrono::DateTime::from_timestamp_millis(now).unwrap().hour();
        if crate::analytics::should_open_position(
            symbol,
            Some(hour),
            &closed,
            &crate::analytics::adaptive_config(adaptive),
        )["shouldOpen"]
            != true
        {
            *blocked.entry("自适应风控".into()).or_default() += 1;
            continue;
        }
        if automation_guards::enabled("NOFX_LIQUIDITY_SCREEN", true)
            && !automation_guards::screen(&ticker, Some(&market))
        {
            *blocked.entry("流动性筛选".into()).or_default() += 1;
            continue;
        }
        let funds = paper::account_summary(&state, now);
        let equity = number(&funds["equity"], initial);
        let env_cap = automation_guards::env_num("NOFX_MAX_LEVERAGE", 5., 1., 125.);
        let cap = number(&config["trader"]["maxLeverage"], env_cap)
            .floor()
            .clamp(1., env_cap);
        let mut leverage = number(&signal["recommendedLeverage"], 1.)
            .floor()
            .clamp(1., cap);
        let mut margin_pct = number(
            &signal["plan"]["autoMarginPct"],
            automation_guards::env_num("NOFX_AUTO_MARGIN_PCT", 0.05, 0.01, 1.),
        )
        .clamp(0.01, 1.);
        if automation_guards::enabled("NOFX_SCORE_SIZING", false) {
            if let Some((lev, pct)) =
                automation_guards::score_size(&signal, number(&funds["openCount"], 0.) as usize)
            {
                leverage = lev.min(cap);
                margin_pct = pct;
            } else {
                continue;
            }
        }
        let Some((leverage, margin)) = automation_guards::entry_size(
            equity,
            margin_pct,
            leverage,
            number(&config["trader"]["minOrderMargin"], 5.),
            number(&config["trader"]["maxPositionNotionalPct"], 0.25),
            Some(number(&funds["available"], 0.)),
            5.,
        ) else {
            continue;
        };
        let record = json!({"id":format!("replay-{now}"),"marketProvider":"binance","strategyId":id,"strategyName":def["name"],"strategyParams":params,"snapshot":{},"analyses":[signal]});
        let input = json!({"symbol":symbol,"strategyId":id,"margin":margin,"leverage":leverage,"automatic":true,"executionPlan":strategies::execution_plan(&signal)});
        match paper::submit_paper_order(&mut state, &record, &input, now) {
            Ok(_) => submitted += 1,
            Err(e) => *blocked.entry(e.to_string()).or_default() += 1,
        }
    }
    let orders = state["orders"].as_array().unwrap();
    let closed: Vec<_> = orders.iter().filter(|o| o["status"] == "closed").collect();
    let wins = closed.iter().filter(|o| number(&o["net"], 0.) > 0.).count();
    let final_funds = paper::account_summary(&state, end);
    let equity = number(&final_funds["equity"], initial);
    Ok(
        json!({"startTime":iso(start),"endTime":iso(end),"initialEquity":initial,"finalEquity":equity,"net":equity-initial,"returnPct":(equity/initial-1.)*100.,"maxDrawdownPct":drawdown*100.,"closedTrades":closed.len(),"winRatePct":if closed.is_empty(){Value::Null}else{json!(wins as f64/closed.len() as f64*100.)},"activeOrders":orders.iter().filter(|o|matches!(o["status"].as_str(),Some("open"|"pending"))).count(),"submitted":submitted,"analyzed":analyzed,"rawEntries":raw_entries,"filtered":filtered,"missing":missing,"blocked":blocked,"marketGaps":market_gaps,"costs":research::costs()}),
    )
}

pub async fn run(db: &Db, input: &Value, config: &Value, adaptive: &Value) -> Result<Value> {
    let (symbol, start, end) = indicator_history::range(input)?;
    let id = input["strategyId"].as_str().unwrap_or("enhanced-trend-v1");
    let combinations = combinations(id, &input["params"], &input["grid"])?;
    let bars = (end - start) / 60_000;
    if bars * (combinations.len() as i64 + 1) > 2_000_000 {
        bail!("400: 回测最多 200 万根×组合，请缩短区间或减少组合");
    }
    let initial = number(&input["initialBalance"], 10000.);
    if !(100. ..=1_000_000.).contains(&initial) {
        bail!("400: 初始权益需要在 100～1000000 USDT");
    }
    let validation = number(&input["validationFraction"], 0.3);
    if !(0.1..=0.5).contains(&validation) {
        bail!("400: 验证区间比例需在 0.1～0.5");
    }
    let split =
        (start + ((end - start) as f64 * (1. - validation)) as i64).div_euclid(60_000) * 60_000;
    let history = load_history(db, &symbol, id, start, end).await?;
    if combinations.iter().any(|p| p["marketBookEnabled"] == true)
        && !history
            .samples
            .iter()
            .any(|s| s.kind == "depth" && s.available_at >= start)
    {
        bail!("400: 这段历史没有本系统采集的 20 档盘口快照，请关闭盘口过滤或选择有快照的区间");
    }
    let local_config = trading_config(config);
    let datasets = history.datasets;
    let samples = history.samples;
    let initial_input = json!({"symbol":symbol,"strategyId":id,"startTime":start,"endTime":end,"validationFraction":validation});
    let baseline_params = strategies::resolve_params(id, &input["params"])?["params"].clone();
    let id = id.to_owned();
    let adaptive = adaptive.clone();
    let dataset_counts: BTreeMap<_, _> =
        datasets.iter().map(|(k, v)| (k.clone(), v.len())).collect();
    tokio::task::spawn_blocking(move ||{
        let mut results=vec![];
        let evaluate=|params:&Value|->Result<Value>{
            let train=replay(&symbol,&id,params,&datasets,&samples,&local_config,start,split,initial,&adaptive)?;
            let validation=replay(&symbol,&id,params,&datasets,&samples,&local_config,split,end,initial,&adaptive)?;
            Ok(json!({"params":params,"training":train,"validation":validation,"sufficient":train["closedTrades"].as_u64().unwrap_or(0)>=5}))
        };
        let baseline=evaluate(&baseline_params)?;
        for params in combinations {results.push(evaluate(&params)?);}
        // Rank only on training. Validation remains untouched evidence of generalization.
        results.sort_by(|a,b| (b["sufficient"]==true).cmp(&(a["sufficient"]==true)).then_with(||{
            let score=|v:&Value|number(&v["training"]["returnPct"],0.)-number(&v["training"]["maxDrawdownPct"],0.);
            score(b).total_cmp(&score(a))
        }));
        Ok(json!({"researchOnly":true,"input":initial_input,"baseline":baseline,"combinations":results,"selection":"只按训练区间：收益百分数减最大回撤百分数；至少 5 笔已平仓才标记样本充分","datasetCounts":dataset_counts,"historicalSamples":samples.len(),"limitations":["单币种回放，不代表全市场组合结果；期末未平仓按共享引擎浮盈计入权益，不强制平仓","资金费成本沿用共享固定成本模型；历史结算费率用于信号过滤","历史统计可用时间保守延后 5 分钟、结算费率 1 分钟；仅已采集快照可回放盘口与当时预估费率","复用账户提交、资金约束、置信度门槛、冷却、分批止盈、移动保护与策略复核；交易所历史精度/最小数量、实时成交延迟不在本次回放中"]}))
    }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_does_not_read_appended_future_bars_or_metrics() {
        let start = 1_700_000_000_000_i64.div_euclid(60_000) * 60_000;
        let rows:Vec<_>=(0..1750).map(|i|{
            let close=100.+i as f64*0.01+(i as f64/4.).sin()*0.05;
            json!({"openTime":start+(i-1500)*60_000,"open":close-0.01,"high":close+0.1,"low":close-0.1,"close":close,"volume":10000,"quoteVolume":10000.*close,"takerBuyQuoteVolume":6000.*close,"tradeCount":100,"confirmed":true})
        }).collect();
        let mut datasets = BTreeMap::from([("1m".into(), rows)]);
        let aux:Vec<_>=(-210..18).map(|i|json!({"openTime":start.div_euclid(900_000)*900_000+i*900_000,"open":100.,"high":101.,"low":99.,"close":100.,"volume":10000.,"quoteVolume":1000000.,"confirmed":true})).collect();
        datasets.insert("15m".into(), aux);
        let params = strategies::defaults("enhanced-trend-v1");
        let config = json!({"trader":{"enabled":true,"allowEntryOrders":true,"minConfidence":0.,"maxLeverage":5}});
        let end = start + 240 * 60_000;
        let a = replay(
            "BTCUSDT",
            "enhanced-trend-v1",
            &params,
            &datasets,
            &[],
            &config,
            start,
            end,
            10000.,
            &json!({}),
        )
        .unwrap();
        datasets.get_mut("1m").unwrap().push(json!({"openTime":end+10_000_000,"open":1.,"high":100000.,"low":0.1,"close":99999.,"volume":1e9,"quoteVolume":1e12,"takerBuyQuoteVolume":1e12,"tradeCount":1e9}));
        let future = Sample {
            kind: "oi5m".into(),
            observed_at: end - 300_000,
            available_at: end + 1,
            origin: "live".into(),
            data: json!({"timestamp":end-300_000,"sumOpenInterest":1e12}),
        };
        let b = replay(
            "BTCUSDT",
            "enhanced-trend-v1",
            &params,
            &datasets,
            &[future],
            &config,
            start,
            end,
            10000.,
            &json!({}),
        )
        .unwrap();
        assert!(a["analyzed"].as_u64().unwrap() > 0);
        assert_eq!(a, b);
    }
    #[test]
    fn grid_validates_values_and_bounds_combinations() {
        let id = "enhanced-trend-v1";
        let combos = combinations(
            id,
            &json!({}),
            &json!({"marketFlowEnabled":[false,true],"marketFlowMinFraction":[0.5,0.6]}),
        )
        .unwrap();
        assert_eq!(combos.len(), 4);
        assert!(combinations(id, &json!({}), &json!({"unknown":[1]})).is_err());
        assert!(combinations(id, &json!({}), &json!({"marketFlowMinFraction":[1.1]})).is_err());
        assert!(combinations(id, &json!({}), &json!({"marketOiWindowMinutes":[10]})).is_err());
        assert!(
            combinations(
                id,
                &json!({}),
                &json!({"marketFlowMinFraction":vec![0.5;65]})
            )
            .is_err()
        );
    }
}
