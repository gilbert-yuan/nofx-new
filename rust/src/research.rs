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
        bail!(
            "{symbol}：已收盘K线不足，需要至少 {minimum} 根，实际 {} 根",
            closed.len()
        );
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
        issues.push("模型自评分必须为 0～1 的数值".into());
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
            let cost = entry * (22. + 3. * (duration as f64 * hold / 3_600_000.) / 8.) / 10_000.;
            let rr = ((tp - entry).abs() - cost) / ((entry - sl).abs() + cost);
            if rr < 1. {
                issues.push("按最不利入场价估算，成本后盈亏比低于1".into());
            }
            if issues.is_empty() {
                plan = p.clone();
                plan["entryLimit"] = json!(entry_limit);
                plan["netRewardRisk"] = json!(rr);
                plan["entryStyle"] = json!(if market_entry { "market" } else { "limit" });
                plan["entryRule"] = json!(if entry_limit.is_some() {
                    "limit_pullback"
                } else {
                    "next_candle_open_in_range"
                });
                let distance = (entry - sl).abs() / entry;
                leverage = raw["recommendedLeverage"]
                    .as_f64()
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
    for(k,v)in json!({"symbol":market["symbol"],"exchange":"binance","marketProvider":market["marketProvider"],"interval":interval,"dataAsOf":market["dataAsOf"],"generatedAt":iso(now),"firstEntryAt":iso(open+duration),"positionRecommendation":final_action,"action":if final_action=="OPEN_LONG"{"BUY"}else if final_action=="OPEN_SHORT"{"SELL"}else{"HOLD"},"confidence":confidence,"confidenceType":"model_self_assessment","reason":raw["reason"].as_str().unwrap_or(""),"risk":raw["risk"].as_str().unwrap_or(""),"suggestion":raw["suggestion"].as_str().unwrap_or(""),"recommendedLeverage":leverage,"marginRiskPct":margin_risk,"validationIssues":issues,"eligible":final_action!="WAIT"&&!plan.is_null(),"plan":plan}).as_object().unwrap(){result[k]=v.clone();}
    result
}
#[expect(
    clippy::too_many_arguments,
    reason = "public record assembly preserves the existing snapshot contract"
)]
pub fn create_record(
    config: &Value,
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
    let mut snapshot = json!({"version":"closed-candle-plan-v1","exchange":"binance","marketProvider":provider,"model":config["model"]["model"],"providerFingerprint":hex::encode(Sha256::digest(config["model"]["baseUrl"].as_str().unwrap_or("").as_bytes()))[..16],"temperature":0.2,"strategy":strategy,"costs":costs()});
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
        .klines(symbol, interval, limit.saturating_add(2), None, None)
        .await?;
    let closed: Vec<Value> = rows
        .into_iter()
        .filter(|r| r["confirmed"] != false)
        .collect();
    if closed.is_empty() {
        bail!("{symbol}/{interval}：没有已收盘K线");
    }
    db.save_klines(&key, interval, &closed).await?;
    Ok(closed)
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
pub async fn ai_analyze(config: &Value, strategy: &Value, markets: &[Value]) -> Result<Vec<Value>> {
    if config["model"]["enabled"] != true
        || config["model"]["apiKey"].as_str().unwrap_or("").is_empty()
    {
        bail!("AI 分析需要模型 Key；可切换本地规则分析。");
    }
    let payload = json!({"model":config["model"]["model"],"temperature":0.2,"messages":[{"role":"system","content":format!("{}\nAnalyze each supplied closed-candle market independently. Return strict JSON {{\"analyses\":[{{\"symbol\":\"BTCUSDT\",\"positionRecommendation\":\"OPEN_LONG|OPEN_SHORT|WAIT\",\"confidence\":0,\"reason\":\"\",\"risk\":\"\",\"suggestion\":\"\",\"plan\":{{\"entryMin\":0,\"entryMax\":0,\"stopLoss\":0,\"takeProfit\":0,\"maxHoldBars\":12}}}}]}}. Numeric confidence 0..1 is self-assessment. This is research only; no account positions supplied. Never close or increase positions. Entry occurs on a future candle, maxHoldBars 1..120. For longs stopLoss < entryMin <= entryMax < takeProfit; reverse for shorts. Weak evidence: WAIT and plan null. One result per symbol.",strategy["systemPrompt"].as_str().unwrap_or(""))},{"role":"user","content":json!({"rules":strategy["rules"],"market":markets}).to_string()}]});
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let url = format!(
        "{}/chat/completions",
        config["model"]["baseUrl"]
            .as_str()
            .context("模型地址缺失")?
            .trim_end_matches('/')
    );
    let response = client
        .post(url)
        .bearer_auth(config["model"]["apiKey"].as_str().unwrap_or(""))
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let body: Value = response.json().await.context("模型服务返回非 JSON")?;
    if !status.is_success() || !body["error"].is_null() {
        bail!(
            "模型服务错误：{}",
            body["error"]["message"].as_str().unwrap_or(status.as_str())
        );
    }
    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .context("模型服务未返回分析内容")?;
    let content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let parsed: Value = serde_json::from_str(content).context("模型输出不是有效 JSON")?;
    Ok(parsed["analyses"]
        .as_array()
        .context("模型输出缺少 analyses 数组")?
        .clone())
}
pub async fn analyze(
    db: &Db,
    store: &Store,
    client: &Exchange,
    kind: &str,
    input: &Value,
) -> Result<Value> {
    let config = store.read("config").await?;
    let mut strategy = store.read("strategy").await?;
    let scope = input.get("scope").unwrap_or(input);
    let engine = scope["engine"]
        .as_str()
        .or(input["engine"].as_str())
        .unwrap_or("auto");
    if !matches!(engine, "auto" | "local" | "local-mtf" | "ai") {
        bail!("不支持的分析方式");
    }
    let interval = input["interval"]
        .as_str()
        .or(scope["interval"].as_str())
        .or(strategy["interval"].as_str())
        .unwrap_or("15m")
        .to_owned();
    let limit = number(
        input
            .get("limit")
            .or(scope.get("limit"))
            .unwrap_or(&strategy["klineLimit"]),
        80.,
    )
    .clamp(20., 200.) as usize;
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
    let requests = futures::stream::iter(symbols.into_iter().map(|s| {
        let interval = interval.clone();
        async move {
            let r = fresh_market(db, client, &s, &interval, limit).await;
            (s, r)
        }
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
    strategy["interval"] = json!(markets[0]["interval"]);
    let effective = if engine == "ai"
        || engine == "auto"
            && config["model"]["enabled"] == true
            && !config["model"]["apiKey"].as_str().unwrap_or("").is_empty()
    {
        "ai"
    } else {
        engine
    };
    let raw = if effective == "ai" {
        ai_analyze(&config, &strategy, &markets).await?
    } else {
        let mut result = vec![];
        for market in &markets {
            let mut context = json!({"params":{}});
            if effective == "local-mtf" {
                for aux in ["15m", "1h", "4h"] {
                    if let Ok(m) =
                        fresh_market(db, client, market["symbol"].as_str().unwrap_or(""), aux, 80)
                            .await
                    {
                        context["auxMarkets"][aux] = m;
                    }
                }
            }
            result.push(if effective == "local-mtf" {
                crate::analytics::local_multi(market, &context["auxMarkets"], &json!({}))
            } else {
                crate::analytics::local_analysis(market)
            });
        }
        result
    };
    let now = now_ms();
    let mut signals = vec![];
    for market in &markets {
        let r = raw
            .iter()
            .find(|r| r["symbol"] == market["symbol"])
            .cloned()
            .unwrap_or(json!({"action":"HOLD","confidence":0,"reason":"分析未返回该币种"}));
        let mut signal = normalize_plan(&r, market, now);
        signal["analysisEngine"] = json!(effective);
        if effective != "ai" {
            signal["confidenceType"] = json!("rule_strength");
        }
        signals.push(signal);
    }
    let mut record = create_record(
        &config, &strategy, &markets, &signals, scope, kind, now, None, &errors,
    );
    record["analysisEngine"] = json!(effective);
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
