use super::{n, rows};
use crate::{iso, number};
use serde_json::{Value, json};
pub fn is_market_plan(p: &Value) -> bool {
    p["entryStyle"] == "market" || number(&p["entryLimit"], 0.) <= 0.
}
fn next_open_trend(signal: &Value) -> bool {
    let p = &signal["plan"];
    signal["strategyId"] == "altcoin-trend-breakout-live-v1"
        && p["altcoinTrend"].is_object()
        && p["reanchorToFill"] == true
        && p["entryExecution"] == "next_open"
}
fn trend_market_entry_block(p: &Value, price: f64, long: bool) -> Option<String> {
    // These strategies freeze an ATR distance, not a price band. The execution
    // gateway rechecks the short entry window and sizes against its fresh quote.
    let risk = number(&p["riskUnit"], f64::NAN);
    (!(price.is_finite() && price > 0. && risk.is_finite() && risk > 0. && (!long || price > risk)))
        .then(|| "市价或 ATR 止损距离无效，等待重新分析。".into())
}
pub fn market_entry_block(p: &Value, price: f64, long: bool) -> Option<String> {
    let min = number(&p["entryMin"], f64::NAN);
    let max = number(&p["entryMax"], f64::NAN);
    let stop = number(&p["stopLoss"], f64::NAN);
    let target = number(&p["takeProfit"], f64::NAN);
    if [price, min, max, stop, target]
        .iter()
        .any(|x| !x.is_finite() || *x <= 0.)
        || min > max
    {
        return Some("市价或入场计划无效，等待重新分析。".into());
    }
    if if long {
        price <= stop || price >= target
    } else {
        price >= stop || price <= target
    } {
        return Some("当前价已越过原计划的止损或止盈，原入场计划失效，等待重新分析。".into());
    }
    if price < min || price > max {
        return Some("当前价已偏离信号允许的入场区间，等待重新分析。".into());
    }
    None
}
fn nullable(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|x| x.is_finite())
}
fn positive(v: &Value) -> Option<f64> {
    nullable(v).filter(|x| *x > 0.)
}
fn source_fresh(raw: &Value, key: &str, at: &Value, now: i64, maximum_age: i64) -> bool {
    // Timeless imported fixtures remain compatible; live collection always carries metadata.
    if !raw["meta"].is_object() {
        return true;
    }
    let at = crate::timestamp(at).or_else(|| crate::timestamp(&raw["meta"][key]["fetchedAt"]));
    at.is_some_and(|at| at > 0 && at <= now + 5_000 && now - at <= maximum_age)
}
fn context(raw: &Value, now: i64) -> Value {
    let funding = raw["funding"]
        .as_array()
        .and_then(|r| r.last())
        .unwrap_or(&Value::Null);
    let oi = raw["oi"]
        .as_array()
        .or_else(|| raw["openInterest"].as_array());
    let latest = oi.and_then(|r| r.last()).unwrap_or(&Value::Null);
    let previous = oi
        .and_then(|r| {
            if r.len() > 1 {
                r.get(r.len() - 2)
            } else {
                None
            }
        })
        .unwrap_or(&Value::Null);
    // Price appreciation can inflate OI notional without any increase in contracts.
    let current = nullable(&latest["sumOpenInterest"]);
    let prior = nullable(&previous["sumOpenInterest"]);
    let change = current
        .zip(prior)
        .filter(|(_, p)| *p > 0.)
        .map(|(c, p)| (c / p - 1.) * 100.);
    let ticker_fresh = source_fresh(
        raw,
        "ticker24h",
        &raw["ticker24h"]["closeTime"],
        now,
        90_000,
    );
    let premium_fresh = source_fresh(raw, "premium", &raw["premium"]["time"], now, 90_000);
    let oi_fresh = source_fresh(raw, "oi", &latest["timestamp"], now, 1_860_000)
        && (!raw["meta"].is_object()
            || crate::timestamp(&latest["timestamp"])
                .zip(crate::timestamp(&previous["timestamp"]))
                .is_some_and(|(a, b)| a - b == 900_000));
    let funding_fresh = source_fresh(raw, "funding", &funding["fundingTime"], now, 129_600_000);
    let rate = premium_fresh
        .then(|| nullable(&raw["premium"]["lastFundingRate"]))
        .flatten()
        .or_else(|| {
            funding_fresh
                .then(|| nullable(&funding["fundingRate"]))
                .flatten()
        });
    json!({"lastPrice":if ticker_fresh{positive(&raw["ticker24h"]["lastPrice"])}else{None},"change24hPct":if ticker_fresh{nullable(&raw["ticker24h"]["priceChangePercent"])}else{None},"oiChangePct":if oi_fresh{change}else{None},"fundingRate":rate,"markPrice":if premium_fresh{positive(&raw["premium"]["markPrice"])}else{None},"errors":if raw["errors"].is_object(){raw["errors"].clone()}else{json!({})}})
}
fn collect_targets(plan: &Value, long: bool) -> Vec<f64> {
    let mut targets: Vec<f64> = ["takeProfit1", "takeProfit2", "takeProfit3", "takeProfit"]
        .iter()
        .filter_map(|k| positive(&plan[*k]))
        .collect();
    targets.sort_by(|a, b| if long { a.total_cmp(b) } else { b.total_cmp(a) });
    targets.dedup();
    targets
}
pub fn opportunity_report(
    signal: &Value,
    market: &Value,
    market_context: &Value,
    strategy: &Value,
    now: i64,
) -> Value {
    let position = signal["positionRecommendation"].as_str().unwrap_or("");
    let action = match signal["action"].as_str().unwrap_or("") {
        "BUY" => "BUY",
        "SELL" => "SELL",
        _ => match position {
            "OPEN_LONG" => "BUY",
            "OPEN_SHORT" => "SELL",
            _ => "WAIT",
        },
    };
    let p = &signal["plan"];
    let r = rows(market);
    let trailing_only = next_open_trend(signal) && p["takeProfitEnabled"] == false;
    let Some(price) = r.last().and_then(|r| positive(&r["close"])) else {
        return Value::Null;
    };
    if action == "WAIT"
        || !["entryMin", "entryMax", "stopLoss"]
            .iter()
            .all(|k| positive(&p[*k]).is_some())
        || (!trailing_only && collect_targets(p, true).is_empty())
        || n(p, "entryMin") > n(p, "entryMax")
    {
        return Value::Null;
    }
    let long = action == "BUY";
    let e0 = n(p, "entryMin");
    let e1 = n(p, "entryMax");
    let limit = positive(&p["entryLimit"]);
    let market_entry = is_market_plan(p);
    let reference = positive(&p["entryReference"]).unwrap_or((e0 + e1) / 2.);
    let ctx = context(market_context, now);
    let current = positive(&ctx["lastPrice"])
        .or_else(|| positive(&ctx["markPrice"]))
        .unwrap_or(price);
    let optimal = if market_entry { Some(current) } else { limit };
    let targets = if trailing_only {
        vec![]
    } else {
        collect_targets(p, long)
    };
    let target_summary = if trailing_only {
        "ATR移动止损退出（无固定止盈）".to_owned()
    } else {
        targets
            .iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(" / ")
    };
    let change = nullable(&ctx["change24hPct"]);
    let oi = nullable(&ctx["oiChangePct"]);
    let funding = nullable(&ctx["fundingRate"]);
    let crowded =
        change.unwrap_or(0.) >= 10. && oi.unwrap_or(0.) >= 20. && funding.unwrap_or(0.) > 0.;
    let extended = if long {
        current > limit.unwrap_or(e1) * 1.001
    } else {
        current < limit.unwrap_or(e0) * 0.999
    };
    let online_trend = next_open_trend(signal);
    let wait = !online_trend && (extended || long && crowded);
    let block = if online_trend {
        trend_market_entry_block(p, current, long)
    } else if market_entry {
        market_entry_block(p, current, long)
    } else {
        None
    };
    let (code, label, proceed, reason) = if let Some(reason) = block {
        (
            "WAIT_REANALYSIS",
            "价格偏离原计划，等待重新分析",
            false,
            reason,
        )
    } else if wait && long {
        (
            "WAIT_PULLBACK",
            "偏多，但不追涨，等待回踩后做多",
            false,
            if crowded {
                "24h 拉升、OI 快速增加且资金费率为正，多头可能拥挤，等待回踩确认。"
            } else {
                "当前价高于理想做多价，等待回踩确认，不直接追多。"
            }
            .into(),
        )
    } else if wait {
        (
            "WAIT_REBOUND",
            "偏空，但不追空，等待反弹后做空",
            false,
            "当前价低于理想做空价，等待反弹确认，不直接追空。".into(),
        )
    } else if long {
        (
            "BUY_NOW",
            "可以考虑做多",
            true,
            "价格已接近策略给出的做多参考区域。".into(),
        )
    } else {
        (
            "SELL_NOW",
            "可以考虑做空",
            true,
            "价格已接近策略给出的做空参考区域。".into(),
        )
    };
    let mut warnings = vec![];
    if change.unwrap_or(0.).abs() >= 15. {
        warnings.push(format!("24h 波动 {:+.2}%，高波动风险较高", change.unwrap()));
    }
    if change.unwrap_or(0.) >= 10. && oi.unwrap_or(0.) >= 20. {
        warnings.push("拉升伴随 OI 快速增加，新仓位集中进入，追涨风险较高".into());
    }
    if funding.unwrap_or(0.) > 0.0005 {
        warnings.push(
            if long {
                "资金费率明显为正，多头可能拥挤"
            } else {
                "资金费率为正，空头需注意反向挤压"
            }
            .into(),
        );
    }
    let symbol = signal["symbol"]
        .as_str()
        .or_else(|| market["symbol"].as_str())
        .unwrap_or("");
    let indicators = crate::market_indicators::summarize(market_context, market, now);
    let evidence = crate::market_indicators::evidence(&indicators, long);
    json!({"generatedAt":iso(now),"dataAsOf":if !signal["dataAsOf"].is_null(){&signal["dataAsOf"]}else{&market["dataAsOf"]},"symbol":symbol,"exchange":signal["exchange"].as_str().or_else(||market["exchange"].as_str()).unwrap_or("binance"),"marketProvider":signal["marketProvider"].as_str().or_else(||market["marketProvider"].as_str()).unwrap_or("binance"),"interval":signal["interval"].as_str().or_else(||market["interval"].as_str()),"strategyId":signal["strategyId"].as_str().or_else(||strategy["id"].as_str()),"strategyName":strategy["name"].as_str().or_else(||signal["strategyName"].as_str()),"action":action,"trend":if long{"LONG"}else{"SHORT"},"confidence":number(&signal["confidence"],0.),"recommendation":if proceed{action}else{"HOLD"},"canProceed":proceed,"decision":{"code":code,"label":label,"canProceed":proceed,"reason":reason},"current":{"price":current,"change24hPct":change,"oiChangePct":oi,"fundingRate":funding,"markPrice":ctx["markPrice"]},"levels":{"entryRange":{"min":e0,"max":e1},"optimalEntry":optimal,"entryMode":if market_entry{"MARKET_OR_NEXT_OPEN"}else{"LIMIT_PULLBACK"},"signalReference":reference,"stopLoss":positive(&p["stopLoss"]),"takeProfits":targets,"riskUnit":positive(&p["riskUnit"])},"warnings":warnings,"strategyReason":signal["reason"].as_str().unwrap_or(""),"risk":signal["risk"].as_str().unwrap_or(""),"summary":format!("{symbol} 初步判断{}；当前价 {current}；理想入场 {e0}～{e1}；止损 {}；止盈 {}；结论：{label}。",if long{"做多"}else{"做空"},n(p,"stopLoss"),target_summary),"contextErrors":ctx["errors"],"indicators":indicators,"evidence":evidence})
}
pub fn execution_plan(signal: &Value) -> Value {
    let p = &signal["plan"];
    if next_open_trend(signal) {
        return p.clone();
    }
    let levels = &signal["opportunityReport"]["levels"];
    let Some(entry) = positive(&levels["optimalEntry"]) else {
        return Value::Null;
    };
    if !p.is_object() || !levels.is_object() {
        return Value::Null;
    }
    let mut plan = p.clone();
    let market = is_market_plan(p);
    plan["entryStyle"] = json!(if market { "market" } else { "limit" });
    plan["entryRule"] = json!(if market {
        "next_candle_open_in_range"
    } else {
        "limit_pullback"
    });
    if market {
        plan.as_object_mut().unwrap().remove("entryLimit");
    } else {
        plan["entryLimit"] = json!(entry);
    }
    if let Some(stop) = positive(&levels["stopLoss"]) {
        plan["stopLoss"] = json!(stop);
    }
    let tp: Vec<f64> = levels["takeProfits"]
        .as_array()
        .map(|r| r.iter().filter_map(positive).collect())
        .unwrap_or_default();
    if let Some(main) = tp.last() {
        plan["takeProfit"] = json!(main);
        for (i, key) in ["takeProfit1", "takeProfit2", "takeProfit3"]
            .iter()
            .enumerate()
        {
            if let Some(price) = tp.get(i) {
                plan[*key] = json!(price);
            } else {
                plan.as_object_mut().unwrap().remove(*key);
            }
        }
    }
    plan
}

#[cfg(test)]
mod online_trend_tests {
    use super::*;

    #[test]
    fn only_online_breakout_uses_frozen_distance_instead_of_pullback_filters() {
        let plan = json!({"entryStyle":"market","entryExecution":"next_open","reanchorToFill":true,
            "entryReference":100.,"entryMin":100.,"entryMax":100.,"stopLoss":98.,"riskUnit":2.,
            "takeProfit":10000.,"takeProfitEnabled":false,"altcoinTrend":{"signalAt":0}});
        let mut signal = json!({"symbol":"SOLUSDT","strategyId":"altcoin-trend-breakout-live-v1",
            "action":"BUY","plan":plan});
        let market = json!({"symbol":"SOLUSDT","klines":[{"close":100.}]});
        let context = json!({"ticker24h":{"lastPrice":110.,"priceChangePercent":20.},
            "premium":{"markPrice":110.,"lastFundingRate":0.001},
            "oi":[{"sumOpenInterest":100.},{"sumOpenInterest":150.}]});
        let report = opportunity_report(&signal, &market, &context, &json!({}), 0);
        assert_eq!(report["canProceed"], true);
        assert_eq!(report["levels"]["takeProfits"], json!([]));
        assert!(report["summary"].as_str().unwrap().contains("无固定止盈"));
        signal["opportunityReport"] = report;
        assert_eq!(execution_plan(&signal), plan);
        signal["strategyId"] = json!("altcoin-trend-breakout-v1");
        assert_eq!(
            opportunity_report(&signal, &market, &context, &json!({}), 0)["canProceed"],
            false
        );
        assert!(market_entry_block(&plan, 110., true).is_some());
    }
}
