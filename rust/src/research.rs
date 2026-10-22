use crate::{
    db::Db,
    exchange::{Exchange, storage_symbol},
    interval_ms, iso, now_ms, number,
    store::Store,
    timestamp,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct InsufficientHistory {
    pub symbol: String,
    pub interval: String,
    pub required: usize,
    pub available: usize,
}
impl std::fmt::Display for InsufficientHistory {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}：已收盘K线不足，需要至少 {} 根，实际 {} 根",
            self.symbol, self.required, self.available
        )
    }
}
impl std::error::Error for InsufficientHistory {}

pub fn costs() -> Value {
    json!({"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3,"notional":10})
}
pub fn candle_open(now: i64, interval: &str) -> Result<i64> {
    let duration = interval_ms(interval).context("不支持的周期")?;
    let anchor = if interval == "1w" { 4 * 86_400_000 } else { 0 };
    Ok((now - anchor).div_euclid(duration) * duration + anchor)
}
pub fn prepare_market(
    symbol: &str,
    interval: &str,
    rows: &[Value],
    limit: usize,
    now: i64,
) -> Result<Value> {
    let duration = interval_ms(interval).context("不支持的周期")?;
    let mut closed: Vec<Value> = rows
        .iter()
        .filter(|r| r["confirmed"] != false && number(&r["openTime"], 0.) as i64 + duration <= now)
        .cloned()
        .collect();
    closed.sort_by_key(|r| number(&r["openTime"], 0.) as i64);
    if closed.len() > limit {
        closed.drain(..closed.len() - limit);
    }
    let minimum = limit.min(50.max(limit.saturating_sub(2)));
    if closed.len() < minimum {
        return Err(InsufficientHistory {
            symbol: symbol.to_owned(),
            interval: interval.to_owned(),
            required: minimum,
            available: closed.len(),
        }
        .into());
    }
    let mut previous = None;
    for r in &mut closed {
        let time = number(&r["openTime"], 0.) as i64;
        if !crate::simulator::valid_candle(r) || candle_open(time, interval)? != time {
            bail!("{symbol}：K线数值或时间无效");
        }
        if previous.is_some_and(|t| t + duration != time) {
            bail!("{symbol}：K线缺失或重复，请重新同步");
        }
        r["closeTime"] = json!(time + duration - 1);
        // Database rows have no transport confirmation flag. The time, candle
        // validity and continuity checks above establish that these are closed.
        r["confirmed"] = json!(true);
        previous = Some(time);
    }
    let end = previous.context("没有有效K线")? + duration;
    if end != candle_open(now, interval)? {
        bail!("{symbol}：行情已过期，缺少最新已收盘K线");
    }
    Ok(
        json!({"symbol":symbol,"exchange":"binance","marketProvider":"binance","interval":interval,"dataAsOf":iso(end),"klines":closed}),
    )
}
pub fn normalize_plan(raw: &Value, market: &Value, now: i64) -> Value {
    let interval = market["interval"].as_str().unwrap_or("15m");
    let duration = interval_ms(interval).unwrap_or(900000);
    let open = candle_open(now, interval).unwrap_or(now);
    let mut issues = vec![];
    if timestamp(&market["dataAsOf"]) != Some(open) {
        issues.push("分析完成时行情已跨周期，请重新分析".to_owned());
    }
    let requested = raw["positionRecommendation"]
        .as_str()
        .or(raw["action"].as_str())
        .unwrap_or("WAIT")
        .to_uppercase();
    let action = match requested.as_str() {
        "BUY" => "OPEN_LONG",
        "SELL" => "OPEN_SHORT",
        "HOLD" => "WAIT",
        other => other,
    };
    let confidence = raw["confidence"]
        .as_f64()
        .filter(|c| (0. ..=1.).contains(c));
    if confidence.is_none() {
        issues.push("信号规则分必须为 0～1 的数值".into());
    }
    if !matches!(action, "OPEN_LONG" | "OPEN_SHORT" | "WAIT") {
        issues.push("未知交易方向或没有对应持仓".into());
    }
    let mut plan = Value::Null;
    let mut leverage = 1.;
    let mut margin_risk = 0.;
    if matches!(action, "OPEN_LONG" | "OPEN_SHORT") {
        let p = &raw["plan"];
        let positive = [
            "entryMin",
            "entryMax",
            "stopLoss",
            "takeProfit",
            "maxHoldBars",
        ]
        .iter()
        .all(|k| p[k].as_f64().is_some_and(|v| v > 0. && v.is_finite()));
        if !positive {
            issues.push("缺少有效入场区间、止损、止盈或持有期限".into());
        } else {
            let min = number(&p["entryMin"], 0.);
            let max = number(&p["entryMax"], 0.);
            let sl = number(&p["stopLoss"], 0.);
            let tp = number(&p["takeProfit"], 0.);
            let long = action == "OPEN_LONG";
            let hold = number(&p["maxHoldBars"], 0.);
            if min > max
                || if long {
                    !(sl < min && tp > max)
                } else {
                    !(tp < min && sl > max)
                }
            {
                issues.push("入场、止损、止盈价格关系无效".into());
            }
            let limit = number(&raw["maxHoldBarsLimit"], 120.).max(120.);
            if hold.fract() != 0. || hold > limit {
                issues.push(format!("持有期限须为1～{limit}根"));
            }
            let market_entry = p["entryStyle"] == "market"
                || p["entryRule"] == "market"
                || p["entryRule"] == "next_candle_market";
            let entry_limit = if market_entry {
                None
            } else {
                p["entryLimit"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n > 0.)
            };
            let entry = entry_limit.unwrap_or(if long { max } else { min });
            let trailing_only = p["takeProfitEnabled"] == false && p["reanchorToFill"] == true;
            let funding_hours = if trailing_only {
                number(&p["riskSizing"]["fundingReserveHours"], 24.).clamp(0., 8760.)
            } else {
                duration as f64 * hold / 3_600_000.
            };
            let cost = entry * (22. + 3. * funding_hours / 8.) / 10_000.;
            let rr = ((tp - entry).abs() - cost) / ((entry - sl).abs() + cost);
            if !trailing_only && rr < 1. {
                issues.push("按最不利入场价估算，成本后盈亏比低于1".into());
            }
            if issues.is_empty() {
                plan = p.clone();
                plan["entryLimit"] = json!(entry_limit);
                plan["netRewardRisk"] = if trailing_only {
                    Value::Null
                } else {
                    json!(rr)
                };
                plan["entryStyle"] = json!(if market_entry { "market" } else { "limit" });
                plan["entryRule"] = json!(if entry_limit.is_some() {
                    "limit_pullback"
                } else {
                    "next_candle_open_in_range"
                });
                let distance = (entry - sl).abs() / entry;
                leverage = [&raw["recommendedLeverage"], &p["recommendedLeverage"]]
                    .into_iter()
                    .filter_map(Value::as_f64)
                    .find(|v| v.is_finite() && *v >= 1.)
                    .unwrap_or_else(|| (0.10 / distance).floor())
                    .clamp(1., 12.);
                margin_risk = leverage * distance;
            }
        }
    }
    let final_action = if issues.is_empty() { action } else { "WAIT" };
    let mut result = raw.clone();
    if !result.is_object() {
        result = json!({});
    }
    for(k,v)in json!({"symbol":market["symbol"],"exchange":"binance","marketProvider":market["marketProvider"],"interval":interval,"dataAsOf":market["dataAsOf"],"generatedAt":iso(now),"firstEntryAt":iso(open+duration),"positionRecommendation":final_action,"action":if final_action=="OPEN_LONG"{"BUY"}else if final_action=="OPEN_SHORT"{"SELL"}else{"HOLD"},"confidence":confidence,"confidenceType":"rule_strength","reason":raw["reason"].as_str().unwrap_or(""),"risk":raw["risk"].as_str().unwrap_or(""),"suggestion":raw["suggestion"].as_str().unwrap_or(""),"recommendedLeverage":leverage,"marginRiskPct":margin_risk,"validationIssues":issues,"eligible":final_action!="WAIT"&&!plan.is_null(),"plan":plan}).as_object().unwrap(){result[k]=v.clone();}
    result
}
#[expect(
    clippy::too_many_arguments,
    reason = "public record assembly preserves the existing snapshot contract"
)]
pub fn create_record(
    _config: &Value,
    strategy: &Value,
    markets: &[Value],
    analyses: &[Value],
    scope: &Value,
    kind: &str,
    now: i64,
    strategy_meta: Option<&Value>,
    errors: &[String],
) -> Value {
    let provider = markets
        .first()
        .map(|m| m["marketProvider"].clone())
        .unwrap_or(json!("binance"));
    let mut snapshot = json!({"version":"closed-candle-plan-v1","exchange":"binance","marketProvider":provider,"strategy":strategy,"costs":costs()});
    if let Some(meta) = strategy_meta {
        snapshot["strategyId"] = meta["id"].clone();
        snapshot["strategyName"] = meta["name"].clone();
        snapshot["strategyParams"] = meta["params"].clone();
    }
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&snapshot).unwrap_or_default(),
    ));
    let symbols: Vec<Value> = markets.iter().map(|m| m["symbol"].clone()).collect();
    let mut record = json!({"id":uuid::Uuid::new_v4().to_string(),"at":iso(now),"researchOnly":true,"type":kind,"symbol":if symbols.len()==1{symbols[0].clone()}else{Value::Null},"symbols":symbols,"scope":scope,"interval":strategy["interval"],"exchange":"binance","marketProvider":provider,"strategyVersion":&version[..16],"snapshot":snapshot,"analyses":analyses,"error":errors.join(" | "),"market":markets});
    if let Some(meta) = strategy_meta {
        record["strategyId"] = meta["id"].clone();
        record["strategyName"] = meta["name"].clone();
        record["strategyParams"] = meta["params"].clone();
    }
    record
}
/// Keep candle storage independent of the minimum history required by analysis.
pub async fn sync_candles(
    db: &Db,
    client: &Exchange,
    symbol: &str,
    interval: &str,
    limit: usize,
) -> Result<Vec<Value>> {
    let key = storage_symbol(symbol, "binance")?;
    let cached = db.candles(&key, interval, limit as i64, None, None).await?;
    if prepare_market(symbol, interval, &cached, limit, now_ms()).is_ok() {
        return Ok(cached);
    }
    let rows = client
        .klines(
            symbol,
            interval,
            sync_fetch_limit(symbol, interval, &cached, limit, now_ms()),
            None,
            None,
        )
        .await?;
    let closed: Vec<Value> = rows
        .into_iter()
        .filter(|r| r["confirmed"] != false)
        .collect();
    if closed.is_empty() {
        bail!("{symbol}/{interval}：没有已收盘K线");
    }
    db.save_klines(&key, interval, &closed).await?;
    // Incremental responses must be merged with the persisted history.
    db.candles(&key, interval, limit as i64, None, None).await
}
fn sync_fetch_limit(
    symbol: &str,
    interval: &str,
    cached: &[Value],
    limit: usize,
    now: i64,
) -> usize {
    let full = limit.saturating_add(2).min(1000);
    let Some(duration) = interval_ms(interval) else {
        return full;
    };
    let Some(end) = cached
        .last()
        .and_then(|r| r["openTime"].as_i64())
        .map(|t| t + duration)
    else {
        return full;
    };
    let Ok(current) = candle_open(now, interval) else {
        return full;
    };
    if end > current || prepare_market(symbol, interval, cached, limit, end).is_err() {
        return full;
    }
    let missing = ((current - end) / duration) as usize;
    full.min(missing.saturating_add(2))
}

// Historical cache is only a display fallback; execution keeps using fresh_market.
pub async fn display_market(
    db: &Db,
    client: &Exchange,
    symbol: &str,
    interval: &str,
    limit: usize,
    read_only: bool,
) -> Result<Value> {
    match fresh_market(db, client, symbol, interval, limit).await {
        Ok(market) => Ok(market),
        Err(error) if read_only => {
            let key = storage_symbol(symbol, "binance")?;
            let rows = db.candles(&key, interval, limit as i64, None, None).await?;
            let end = rows
                .last()
                .and_then(|r| r["openTime"].as_i64())
                .context("没有可用于只读展示的缓存行情")?
                + interval_ms(interval).context("不支持的周期")?;
            let mut market = prepare_market(symbol, interval, &rows, limit, end)?;
            market["cacheOnly"] = json!(true);
            market["marketWarning"] = json!(format!("实时行情不可用，使用缓存：{error:#}"));
            Ok(market)
        }
        Err(error) => Err(error),
    }
}
pub async fn fresh_market(
    db: &Db,
    client: &Exchange,
    symbol: &str,
    interval: &str,
    limit: usize,
) -> Result<Value> {
    let rows = sync_candles(db, client, symbol, interval, limit).await?;
    prepare_market(symbol, interval, &rows, limit, now_ms())
}
fn manual_window(input: &Value, params: &Value) -> Result<usize> {
    let scope = input.get("scope").unwrap_or(input);
    let interval = input["interval"]
        .as_str()
        .or(scope["interval"].as_str())
        .unwrap_or("4h");
    if interval != "4h" {
        bail!("当前山寨趋势突破策略只支持 4h 分析");
    }
    let minimum = crate::strategies::altcoin_breakout::MIN_BARS
        .max(number(&params["emaSlow"], 75.) as usize)
        .max(number(&params["channelPeriod"], 8.) as usize + 1);
    Ok(number(
        input
            .get("limit")
            .or(scope.get("limit"))
            .unwrap_or(&Value::Null),
        200.,
    )
    .floor()
    .clamp(minimum as f64, 1000.) as usize)
}
pub async fn analyze(
    db: &Db,
    store: &Store,
    client: &Exchange,
    kind: &str,
    input: &Value,
) -> Result<Value> {
    let config = store.read("config").await?;
    let meta = crate::strategies::list(&config, &store.read("strategies").await?)["strategies"]
        .as_array()
        .context("当前策略配置不可用")?
        .iter()
        .find(|strategy| strategy["id"] == crate::strategies::ACTIVE_STRATEGY_ID)
        .cloned()
        .context("当前山寨趋势突破策略未注册")?;
    let scope = input.get("scope").unwrap_or(input);
    let limit = manual_window(input, &meta["params"])?;
    let interval = "4h";
    let symbols = if kind == "single" {
        vec![
            input["symbol"]
                .as_str()
                .context("请选择有效USDT合约")?
                .to_uppercase(),
        ]
    } else {
        let requested = symbols(scope);
        client
            .contracts()
            .await?
            .iter()
            .filter_map(|c| c["symbol"].as_str().map(str::to_owned))
            .filter(|s| kind == "all" || requested.is_empty() || requested.contains(s))
            .take(if kind == "all" {
                usize::MAX
            } else {
                number(&scope["maxSymbols"], 20.).clamp(1., 300.) as usize
            })
            .collect()
    };
    if symbols.is_empty() {
        bail!("没有符合范围的合约");
    }
    let mut markets = vec![];
    let mut errors = vec![];
    let requests = futures::stream::iter(symbols.into_iter().map(|s| async move {
        let r = fresh_market(db, client, &s, interval, limit).await;
        (s, r)
    }));
    use futures::StreamExt;
    let results = requests.buffer_unordered(5).collect::<Vec<_>>().await;
    for (s, r) in results {
        match r {
            Ok(m) => markets.push(m),
            Err(e) => errors.push(format!("{s}: {e}")),
        }
    }
    if markets.is_empty() {
        bail!("{}", errors.join(" | "));
    }
    let now = now_ms();
    let mut signals = vec![];
    for market in &markets {
        let r = crate::strategies::analyze(
            crate::strategies::ACTIVE_STRATEGY_ID,
            market,
            &json!({"params":meta["params"],"evaluationAt":iso(now)}),
        )?;
        let mut signal = normalize_plan(&r, market, now);
        signal["strategyId"] = meta["id"].clone();
        signal["analysisEngine"] = meta["engine"].clone();
        signal["confidenceType"] = json!("rule_strength");
        signals.push(signal);
    }
    let strategy = json!({"name":meta["name"],"interval":interval,"klineLimit":limit});
    let mut record = create_record(
        &config,
        &strategy,
        &markets,
        &signals,
        scope,
        kind,
        now,
        Some(&meta),
        &errors,
    );
    record["analysisEngine"] = meta["engine"].clone();
    db.save_record(&record).await?;
    record.as_object_mut().unwrap().remove("snapshot");
    record.as_object_mut().unwrap().remove("market");
    Ok(record)
}
pub fn symbols(input: &Value) -> Vec<String> {
    let raw = if let Some(a) = input["symbols"].as_array() {
        a.iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect()
    } else {
        input["symbolsText"]
            .as_str()
            .or(input["symbols"].as_str())
            .or(input["symbol"].as_str())
            .unwrap_or("")
            .split(',')
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    raw.into_iter()
        .map(|s| crate::exchange::strip_symbol(s.trim()).to_uppercase())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_analysis_requires_four_hours_and_current_parameter_warmup() {
        assert_eq!(manual_window(&json!({}), &json!({})).unwrap(), 200);
        assert_eq!(
            manual_window(&json!({"limit":20}), &json!({})).unwrap(),
            180
        );
        assert_eq!(
            manual_window(&json!({"scope":{"limit":80}}), &json!({"emaSlow":300})).unwrap(),
            300
        );
        assert_eq!(
            manual_window(&json!({"limit":180}), &json!({"channelPeriod":240})).unwrap(),
            241
        );
        assert_eq!(
            manual_window(&json!({"limit":2000}), &json!({})).unwrap(),
            1000
        );
        assert!(manual_window(&json!({"interval":"1h"}), &json!({})).is_err());
        assert!(manual_window(&json!({"scope":{"interval":"15m"}}), &json!({})).is_err());
    }
    #[test]
    fn current_record_freezes_strategy_parameters_without_model_metadata() {
        let meta = json!({"id":crate::strategies::ACTIVE_STRATEGY_ID,"name":"Current breakout",
            "params":{"emaFast":25,"emaSlow":75,"stopAtr":1,"trailAtr":3}});
        let declaration = json!({"name":meta["name"],"interval":"4h","klineLimit":200});
        let build = |config: &Value| {
            create_record(
                config,
                &declaration,
                &[json!({"symbol":"NEARUSDT","marketProvider":"binance"})],
                &[],
                &json!({"interval":"4h"}),
                "single",
                0,
                Some(&meta),
                &[],
            )
        };
        let record = build(
            &json!({"model":{"apiKey":"legacy-secret","model":"old-model","baseUrl":"https://old.invalid"}}),
        );
        for key in ["model", "providerFingerprint", "temperature"] {
            assert!(record["snapshot"].get(key).is_none());
        }
        assert_eq!(record["snapshot"]["strategyParams"], meta["params"]);
        assert_eq!(record["strategyId"], meta["id"]);
        assert_eq!(
            record["strategyVersion"],
            build(&json!({}))["strategyVersion"]
        );
        assert!(!record.to_string().contains("legacy-secret"));
    }
    #[test]
    fn new_contract_history_shortage_is_typed_and_full_invalid_history_still_fails() {
        let rows: Vec<Value> = (0..62).map(|i| json!({"openTime":i*14_400_000i64,"open":1,"high":2,"low":1,"close":2,"volume":1})).collect();
        let error = prepare_market("CTUSDT", "4h", &rows, 300, 62 * 14_400_000i64).unwrap_err();
        let shortage = error.downcast_ref::<InsufficientHistory>().unwrap();
        assert_eq!((shortage.required, shortage.available), (298, 62));
        assert_eq!(shortage.interval, "4h");
        let mut invalid = rows;
        invalid[0]["high"] = json!(0);
        let invalid_error =
            prepare_market("CTUSDT", "4h", &invalid, 62, 62 * 14_400_000i64).unwrap_err();
        assert!(
            invalid_error
                .downcast_ref::<InsufficientHistory>()
                .is_none()
        );
    }
    #[test]
    fn normalization_respects_strategy_leverage_and_risk_budget() {
        let now = 1_800_000;
        let market = json!({"symbol":"BTCUSDT","interval":"1m","dataAsOf":iso(now)});
        let mut raw = json!({"action":"BUY","confidence":0.9,"plan":{"entryMin":99.,"entryMax":101.,"entryLimit":100.,"stopLoss":98.,"takeProfit":108.,"maxHoldBars":20,"recommendedLeverage":2.}});
        let signal = normalize_plan(&raw, &market, now);
        assert_eq!(signal["eligible"], true);
        assert_eq!(signal["recommendedLeverage"], 2.);
        assert_eq!(signal["marginRiskPct"], 0.04);
        raw["recommendedLeverage"] = json!(1.);
        assert_eq!(
            normalize_plan(&raw, &market, now)["recommendedLeverage"],
            1.
        );
        raw["recommendedLeverage"] = json!(0.);
        assert_eq!(
            normalize_plan(&raw, &market, now)["recommendedLeverage"],
            2.
        );
        raw["plan"]
            .as_object_mut()
            .unwrap()
            .remove("recommendedLeverage");
        assert_eq!(
            normalize_plan(&raw, &market, now)["recommendedLeverage"],
            5.
        );
    }
    #[test]
    fn incremental_fetch_keeps_full_refill_for_broken_history() {
        let rows: Vec<Value> = (920..1000).map(|i| json!({"openTime":i * 60_000,"open":100,"high":101,"low":99,"close":100,"volume":10})).collect();
        assert_eq!(
            sync_fetch_limit("BTCUSDT", "1m", &rows, 80, 1001 * 60_000),
            3
        );
        assert_eq!(
            sync_fetch_limit("BTCUSDT", "1m", &rows, 80, 1020 * 60_000),
            22
        );
        assert_eq!(
            sync_fetch_limit("BTCUSDT", "1m", &rows, 80, 1100 * 60_000),
            82
        );
        assert_eq!(
            sync_fetch_limit("BTCUSDT", "1m", &rows[..75], 80, 1001 * 60_000),
            82
        );
        let mut gapped = rows;
        gapped.remove(40);
        assert_eq!(
            sync_fetch_limit("BTCUSDT", "1m", &gapped, 80, 1001 * 60_000),
            82
        );
    }
    #[test]
    fn stale_and_invalid_plan_never_eligible() {
        let now = 1_800_000;
        let market = json!({"symbol":"BTCUSDT","interval":"15m","dataAsOf":iso(now-900000),"marketProvider":"binance"});
        let signal = normalize_plan(
            &json!({"action":"BUY","confidence":0.9,"plan":{"entryMin":100,"entryMax":101,"stopLoss":90,"takeProfit":125,"maxHoldBars":20}}),
            &market,
            now,
        );
        assert_eq!(signal["eligible"], false);
        assert_eq!(signal["positionRecommendation"], "WAIT");
    }
    #[test]
    fn closed_window_rejects_gap() {
        let now = 120000;
        let rows = vec![
            json!({"openTime":0,"open":1,"high":2,"low":1,"close":2,"volume":1}),
            json!({"openTime":90000,"open":1,"high":2,"low":1,"close":2,"volume":1}),
        ];
        assert!(prepare_market("BTCUSDT", "1m", &rows, 2, now).is_err());
    }
}
