//! Native strategy registry and deterministic analysis. All parameter schemas are
//! embedded data, shared by live analysis and replay; no JavaScript is executed.
use crate::number;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::sync::OnceLock;
#[path = "strategies/enhanced.rs"]
mod enhanced;
#[path = "strategies/h4.rs"]
mod h4;
#[path = "strategies/indicators.rs"]
pub mod indicators;
#[path = "strategies/opportunity.rs"]
mod opportunity;
#[path = "strategies/structure.rs"]
mod structure;
#[path = "strategies/yao.rs"]
mod yao;
pub use indicators::{atr, ema, rsi};
pub use opportunity::{execution_plan, opportunity_report};
pub use opportunity::{is_market_plan, market_entry_block};
pub use yao::{
    calibrate as yao_calibrate, features as yao_features, predict as yao_prediction,
    profile as yao_market_profile, universe as yao_universe,
};

pub fn yao_predictions(
    symbols: &[Value],
    markets: &Value,
    tickers: &Value,
    now: i64,
    options: &Value,
) -> Value {
    let mut results: Vec<Value> = symbols
        .iter()
        .filter_map(|s| {
            let key = s.as_str()?;
            let p = yao_prediction(&markets[key], &tickers[key], now, options);
            if p.is_null() { None } else { Some(p) }
        })
        .collect();
    results.sort_by(|a, b| {
        (b["stage"] == "TRIGGERED")
            .cmp(&(a["stage"] == "TRIGGERED"))
            .then_with(|| n(b, "probabilityPct").total_cmp(&n(a, "probabilityPct")))
            .then_with(|| {
                n(b, "predictedMovePct")
                    .abs()
                    .total_cmp(&n(a, "predictedMovePct").abs())
            })
            .then_with(|| a["symbol"].as_str().cmp(&b["symbol"].as_str()))
    });
    results.truncate(number(&options["maxCandidates"], 50.).trunc().max(1.) as usize);
    json!(results)
}

fn registry() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("strategies/registry.json"))
            .expect("embedded strategy registry")
    })
}
pub fn definitions() -> Vec<Value> {
    let mut definitions = registry()["strategies"].as_array().unwrap().clone();
    for definition in &mut definitions {
        definition["paramSchema"]
            .as_array_mut()
            .unwrap()
            .extend(crate::market_filters::schema());
    }
    definitions
}
pub fn definition(id: &str) -> Option<Value> {
    definitions().into_iter().find(|d| d["id"] == id)
}
pub fn defaults(id: &str) -> Value {
    definition(id)
        .map(|d| {
            Value::Object(
                d["paramSchema"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| (s["key"].as_str().unwrap().to_owned(), s["default"].clone()))
                    .collect(),
            )
        })
        .unwrap_or(json!({}))
}
pub fn resolve_params(id: &str, overrides: &Value) -> Result<Value> {
    let def = definition(id).ok_or_else(|| anyhow::anyhow!("未知策略：{id}"))?;
    let mut params = defaults(id);
    let mut rejected = vec![];
    for spec in def["paramSchema"].as_array().unwrap() {
        let key = spec["key"].as_str().unwrap();
        let raw = &overrides[key];
        if raw.is_null() || raw == "" {
            continue;
        }
        if spec["type"] == "boolean" {
            let parsed = raw.as_bool().or_else(|| {
                match raw
                    .as_str()
                    .map(|s| s.trim().to_lowercase())
                    .unwrap_or_else(|| raw.to_string())
                    .as_str()
                {
                    "true" | "1" | "yes" => Some(true),
                    "false" | "0" | "no" => Some(false),
                    _ => None,
                }
            });
            if let Some(v) = parsed {
                params[key] = json!(v);
            } else {
                rejected.push(json!({"key":key,"value":raw,"reason":"需要布尔值"}));
            }
        } else {
            let v = number(raw, f64::NAN);
            let min = number(&spec["min"], 0.);
            let max = number(&spec["max"], 0.);
            if v.is_finite() && v >= min && v <= max {
                params[key] = json!(v);
            } else {
                rejected
                    .push(json!({"key":key,"value":raw,"reason":format!("需要在 {min}~{max}")}));
            }
        }
    }
    crate::market_filters::validate(&params)?;
    Ok(json!({"params":params,"rejected":rejected}))
}
pub fn list(config: &Value, state: &Value) -> Value {
    let engine = config["analysis"]["engine"].as_str().unwrap_or("enhanced");
    let default_id = match engine {
        "h4-breakout" => "h4-trend-breakout-v1",
        "h4-reversion" => "h4-mean-reversion-v1",
        _ => "enhanced-trend-v1",
    };
    let initialized = state["initialized"].as_bool().unwrap_or_else(|| {
        state["strategies"]
            .as_object()
            .map(|o| !o.is_empty())
            .unwrap_or(false)
    });
    let mut enabled = vec![];
    let all: Vec<Value> = definitions()
        .into_iter()
        .map(|mut d| {
            let id = d["id"].as_str().unwrap().to_owned();
            let entry = &state["strategies"][&id];
            let on = if initialized {
                entry["enabled"].as_bool().unwrap_or(false)
            } else if let Some(old) = state["enabled"].as_array() {
                old.iter().any(|x| x == &id)
            } else {
                id == default_id
            };
            if on {
                enabled.push(id.clone());
            }
            let over = if entry["params"].is_object() {
                &entry["params"]
            } else {
                &state["overrides"][&id]
            };
            d["enabled"] = json!(on);
            d["defaults"] = defaults(&id);
            d["params"] = resolve_params(&id, over).unwrap()["params"].clone();
            let note = entry["notes"]
                .as_str()
                .or_else(|| state["notes"][&id].as_str())
                .unwrap_or("");
            d["notes"] = json!(
                note.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(200)
                    .collect::<String>()
            );
            d
        })
        .collect();
    let mut labels = registry()["groupLabels"].clone();
    labels["marketContext"] = json!("免费行情指标 · 历史回放过滤");
    json!({"enabled":enabled,"strategies":all,"updatedAt":state["updatedAt"],"groupLabels":labels})
}
pub fn analyze(id: &str, market: &Value, context: &Value) -> Result<Value> {
    let p = resolve_params(id, &context["params"])?["params"].clone();
    let mut ctx = context.clone();
    if !ctx.is_object() {
        ctx = json!({});
    }
    ctx["params"] = p;
    let mut signal = match id {
        "h4-trend-breakout-v1" | "h4-mean-reversion-v1" | "h4-chandelier-breakout-v1" => {
            h4::analyze(id, market, &ctx)
        }
        "structure-long-v1" => structure::analyze(true, market, &ctx),
        "structure-short-v1" => structure::analyze(false, market, &ctx),
        "enhanced-trend-v1" => enhanced::analyze(market, &ctx),
        "yao-coin-ambush-v1" => yao::analyze(market, &ctx),
        _ => bail!("未知策略：{id}"),
    };
    if ctx["deferMarketFilters"] != true {
        crate::market_filters::apply(&mut signal, market, &ctx);
    }
    Ok(signal)
}
pub fn review(id: &str, order: &Value, market: &Value, context: &Value) -> Result<Value> {
    if definition(id).is_none() {
        bail!("未知策略：{id}");
    }
    Ok(match id {
        "h4-chandelier-breakout-v1" => h4::chandelier_review(order, market),
        "enhanced-trend-v1" => enhanced::review(order, market, context),
        _ => local_review(order, market),
    })
}
pub(crate) fn n(p: &Value, key: &str) -> f64 {
    number(&p[key], 0.)
}
pub(crate) fn b(p: &Value, key: &str) -> bool {
    p[key].as_bool().unwrap_or(false)
}
pub(crate) fn rows(m: &Value) -> Vec<Value> {
    m["klines"].as_array().cloned().unwrap_or_default()
}
pub(crate) fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(a), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        a.extend(e.clone());
    }
    base
}
pub(crate) fn wait(m: &Value, reason: impl Into<String>, trend: &Value, extra: Value) -> Value {
    merge(
        json!({"symbol":m["symbol"],"action":"WAIT","decision":"HOLD","state":"HOLD","confidence":0,"reason":reason.into(),"risk":"规则强度是信号分，不是胜率。","plan":null,"trend":trend}),
        extra,
    )
}
pub fn exit_rules(p: &Value) -> Value {
    json!({"trailing":{"triggerR":p["trailingTriggerR"],"profitTriggerPct":p["trailingProfitTriggerPct"],"extendTpAtr":p["trailingExtendTpAtr"],"lockMinRoomAtr":p["trailingLockMinRoomAtr"],"useBreakEven":p["trailingUseBreakEven"],"breakEvenFloorAtr":p["trailingBreakEvenFloorAtr"],"breakEvenCostBufferBps":p["trailingBreakEvenCostBufferBps"],"ladder":[{"atR":0,"trailR":p["trailingL0TrailR"],"lockR":p["trailingL0LockR"]},{"atR":p["trailingL1AtR"],"trailR":p["trailingL1TrailR"],"lockR":p["trailingL1LockR"]},{"atR":p["trailingL2AtR"],"trailR":p["trailingL2TrailR"],"lockR":p["trailingL2LockR"]}]},"smartExit":{"enabled":p["smartExitEnabled"],"barLevelEnabled":p["smartExitBarLevelEnabled"].as_bool().unwrap_or(b(p,"smartExitEnabled")),"barLevel":p["smartExitBarLevel"],"maPeriod":p["smartExitMaPeriod"],"atrPeriod":p["smartExitAtrPeriod"],"maBreakAtr":p["smartExitMaAtr"],"maExitMaxProfitR":p["smartExitMaExitMaxR"],"tpMinR":p["smartExitTpMinR"],"minHoldBars":p["smartExitMinHold"]},"partialTp":{"enabled":p["partialTpEnabled"],"tp1R":p["partialTp1R"],"tp2R":p["partialTp2R"],"tp1ClosePct":p["partialTp1ClosePct"],"tp2ClosePct":p["partialTp2ClosePct"],"moveStopToBreakEven":p["partialTpMoveStopToBreakeven"]}})
}
pub fn exit_rules_for(plan: &Value) -> Value {
    let mut rules = exit_rules(&defaults("enhanced-trend-v1"));
    for key in ["trailing", "smartExit", "partialTp"] {
        let snap = if key == "smartExit" && !plan["exitRules"][key].is_object() {
            &plan["smartExit"]
        } else {
            &plan["exitRules"][key]
        };
        if let Some(obj) = snap.as_object() {
            for (k, v) in obj {
                if !v.is_null() {
                    rules[key][k] = v.clone();
                }
            }
        }
    }
    rules
}
pub fn tightest_stop(order: &Value, long: bool) -> f64 {
    let mut vals = vec![
        n(&order["initialPlan"], "stopLoss"),
        n(&order["plan"], "stopLoss"),
    ];
    if let Some(r) = order["protectionRevisions"].as_array() {
        vals.extend(r.iter().map(|x| n(x, "stopLoss")));
    }
    vals.into_iter()
        .filter(|x| x.is_finite() && *x > 0.)
        .reduce(|a, x| if long { a.max(x) } else { a.min(x) })
        .unwrap_or(f64::NAN)
}
pub fn plan_risk_unit(plan: &Value, long: bool) -> f64 {
    let fixed = n(plan, "riskUnit");
    if fixed > 0. {
        return fixed;
    }
    let entry = number(
        &plan["entryLimit"],
        if long {
            n(plan, "entryMax")
        } else {
            n(plan, "entryMin")
        },
    );
    (entry - n(plan, "stopLoss")).abs()
}
pub fn local_review(order: &Value, market: &Value) -> Value {
    local_review_with_atr(order, market, atr(&rows(market), 14))
}
pub(crate) fn local_review_with_atr(order: &Value, market: &Value, range: f64) -> Value {
    let r = rows(market);
    if r.is_empty() || !range.is_finite() || range <= 0. {
        return json!({"action":"HOLD","reason":"波动率无效，保留当前保护价格。"});
    }
    let price = n(r.last().unwrap(), "close");
    let long = order["direction"] == "OPEN_LONG";
    let sign = if long { 1. } else { -1. };
    let entry = n(order, "entry");
    let risk = plan_risk_unit(&order["plan"], long);
    let profit_r = sign * (price - entry) / risk;
    let profit = sign * (price - entry) / entry;
    let rules = exit_rules_for(&order["plan"]);
    let rule = &rules["trailing"];
    if !(profit_r.is_finite() && profit_r + 1e-9 >= n(rule, "triggerR")
        || profit > n(rule, "profitTriggerPct"))
    {
        return json!({"action":"HOLD","reason":format!("浮盈 {profit_r:.2}R 未达保护触发线。")});
    }
    let mut step = rule["ladder"][0].clone();
    if let Some(l) = rule["ladder"].as_array() {
        for item in l {
            if profit_r >= n(item, "atR") {
                step = item.clone();
            }
        }
    }
    let base = n(&order["plan"], "stopLoss");
    let mut candidates = vec![base, price - sign * n(&step, "trailR") * risk];
    if n(&step, "lockR") > 0. && risk > 0. {
        let costs = &order["costs"];
        let cost_dist = entry
            * (2. * (number(&costs["feeBps"], 6.) + number(&costs["slippageBps"], 5.))
                + n(rule, "breakEvenCostBufferBps"))
            / 10000.;
        let by_step = entry + sign * n(&step, "lockR") * risk;
        let by_cost = entry + sign * cost_dist;
        let wanted = if long {
            by_step.max(by_cost)
        } else {
            by_step.min(by_cost)
        };
        if sign * (price - wanted) >= n(rule, "lockMinRoomAtr") * range {
            candidates.push(wanted);
        }
    }
    if b(rule, "useBreakEven") {
        candidates.push(entry + sign * n(rule, "breakEvenFloorAtr") * range);
    }
    let stop = candidates
        .into_iter()
        .filter(|x| x.is_finite() && *x > 0.)
        .reduce(|a, x| if long { a.max(x) } else { a.min(x) })
        .unwrap_or(f64::NAN);
    if !stop.is_finite() || sign * (price - stop) <= 0. || sign * (stop - base) <= 0. {
        return json!({"action":"HOLD","reason":"止损已处于对应档位的最紧位置或越过现价。"});
    }
    let target = n(&order["plan"], "takeProfit");
    let tp = if long {
        target.max(price + n(rule, "extendTpAtr") * range)
    } else {
        target.min(price - n(rule, "extendTpAtr") * range)
    };
    json!({"action":"UPDATE_PROTECTION","stopLoss":stop,"takeProfit":tp,"confidence":0.75,"reason":format!("浮盈 {profit_r:.2}R 启用移动止损。")})
}
pub const FEATURE_NAMES: [&str; 9] = [
    "trendReturn",
    "trendEfficiency",
    "atrPct",
    "returnVolatility",
    "volumeRatio",
    "volumeTrend",
    "upperWickRatio",
    "lowerWickRatio",
    "rangePosition",
];
pub fn kline_features(raw: &[Value], options: &Value) -> Option<Value> {
    let period = |k: &str, d: usize| number(&options[k], d as f64).max(1.) as usize;
    let look = period("lookbackBars", 72);
    let trend_n = period("trendBars", 24);
    let ap = period("atrPeriod", 14);
    let vp = period("volumePeriod", 20);
    let w = &raw[raw.len().saturating_sub(look)..];
    if w.len() < trend_n.max(ap).max(vp) + 1
        || w.iter().any(|r| {
            ["openTime", "open", "high", "low", "close", "volume"]
                .iter()
                .any(|k| !number(&r[k], f64::NAN).is_finite())
        })
    {
        return None;
    }
    let last = w.last()?;
    let trend = &w[w.len() - trend_n - 1..];
    let ret: Vec<f64> = trend
        .windows(2)
        .map(|r| (n(&r[1], "close") / n(&r[0], "close")).ln())
        .collect();
    let mean = indicators::mean(&ret);
    let travel = trend
        .windows(2)
        .map(|r| (n(&r[1], "close") - n(&r[0], "close")).abs())
        .sum::<f64>();
    let volume_mean = |s: &[Value]| s.iter().map(|r| n(r, "volume")).sum::<f64>() / s.len() as f64;
    let base = volume_mean(&w[w.len() - vp - 1..w.len() - 1]);
    let previous = &w[w.len().saturating_sub(2 * vp)..w.len() - vp];
    let high = trend
        .iter()
        .map(|r| n(r, "high"))
        .fold(f64::NEG_INFINITY, f64::max);
    let low = trend
        .iter()
        .map(|r| n(r, "low"))
        .fold(f64::INFINITY, f64::min);
    let range = n(last, "high") - n(last, "low");
    let close = n(last, "close");
    Some(
        json!({"trendReturn":close/n(&trend[0],"close")-1.,"trendEfficiency":if travel>0.{(close-n(&trend[0],"close")).abs()/travel}else{0.},"atrPct":atr(w,ap)/close,"returnVolatility":(ret.iter().map(|x|(x-mean).powi(2)).sum::<f64>()/ret.len()as f64).sqrt(),"volumeRatio":if base>0.{Some(n(last,"volume")/base)}else{None},"volumeTrend":if previous.len()==vp&&volume_mean(previous)>0.{Some(volume_mean(&w[w.len()-vp..])/volume_mean(previous))}else{None},"upperWickRatio":if range>0.{(n(last,"high")-n(last,"open").max(close))/range}else{0.},"lowerWickRatio":if range>0.{(n(last,"open").min(close)-n(last,"low"))/range}else{0.},"rangePosition":if high>low{(close-low)/(high-low)}else{0.5}}),
    )
}
pub fn match_feature_rules(features: &Value, rules: &Value, missing: &str) -> Result<Value> {
    let list = rules
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("feature rules 必须为数组"))?;
    let mut failures = vec![];
    for r in list {
        let key = r["feature"].as_str().unwrap_or("");
        let min = number(&r["min"], f64::NAN);
        let max = number(&r["max"], f64::NAN);
        if !FEATURE_NAMES.contains(&key) || !min.is_finite() || !max.is_finite() || min > max {
            bail!("无效特征规则 {r}");
        }
        let x = number(&features[key], f64::NAN);
        if !x.is_finite() {
            if missing != "pass" {
                failures.push(format!("{key}:missing"));
            }
        } else if x < min || x > max {
            failures.push(format!("{key}:{x} not in [{min},{max}]"));
        }
    }
    Ok(json!({"passed":failures.is_empty(),"failures":failures}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn oracle() -> Value {
        serde_json::from_str(include_str!("strategies/fixtures.json")).unwrap()
    }
    fn market(dataset: &Value, interval: &str) -> Value {
        let count = dataset["count"].as_u64().unwrap() as usize;
        let drift = n(dataset, "drift");
        let mode = dataset["mode"].as_str().unwrap();
        let dt = crate::interval_ms(interval).unwrap();
        let base = 1_760_000_000_000_i64;
        let mut candles = vec![];
        for i in 0..count {
            let x = i as f64;
            let mut close = 100. + drift * x + (x / 4.).sin() * 0.8;
            let mut open = close - ((x / 3.).cos() * 0.25 + 0.03);
            let mut high = open.max(close) + 0.6;
            let mut low = open.min(close) - 0.6;
            let mut volume = 1000. + (x / 6.).sin() * 120.;
            if mode == "flat" {
                close = 100.;
                open = 100.;
                high = 100.5;
                low = 99.5;
            }
            if i >= count - 12 && mode == "surge" {
                close += (i as f64 - count as f64 + 13.) * 0.8;
                high = open.max(close) + 0.6;
                low = open.min(close) - 0.6;
                volume *= 4.;
            }
            if i == count - 1 && mode == "break" {
                close += if drift < 0. { -4. } else { 4. };
                high = open.max(close) + 0.6;
                low = open.min(close) - 0.6;
                volume *= 2.;
            }
            if i == count - 1 && mode == "dip" {
                close -= 10.;
                high = open.max(close) + 0.6;
                low = open.min(close) - 0.6;
            }
            candles.push(json!({"openTime":base+i as i64*dt,"open":open,"high":high,"low":low,"close":close,"volume":volume,"quoteVolume":volume*close}));
        }
        json!({"symbol":"TESTUSDT","interval":interval,"klines":candles,"dataAsOf":crate::iso(base+count as i64*dt)})
    }
    fn compatible(expected: &Value, actual: &Value, path: &str) {
        if let Some(a) = expected.as_f64() {
            let b = actual
                .as_f64()
                .unwrap_or_else(|| panic!("{path}: expected numeric {a}, got {actual}"));
            assert!(
                (a - b).abs() <= 1e-8 * (1. + a.abs()),
                "{path}: expected {a}, got {b}"
            );
            return;
        }
        match expected {
            Value::Object(obj) => {
                for (k, v) in obj {
                    if [
                        "reason",
                        "risk",
                        "suggestion",
                        "summary",
                        "description",
                        "invalidation",
                        "generatedAt",
                        "suggestedRisk",
                        "dataSource",
                    ]
                    .contains(&k.as_str())
                    {
                        continue;
                    }
                    compatible(v, &actual[k], &format!("{path}.{k}"));
                }
            }
            Value::Array(arr) => {
                let got = actual
                    .as_array()
                    .unwrap_or_else(|| panic!("{path}: expected array, got {actual}"));
                assert_eq!(arr.len(), got.len(), "{path} array length");
                for (i, v) in arr.iter().enumerate() {
                    if v.is_string() {
                        continue;
                    }
                    compatible(v, &got[i], &format!("{path}[{i}]"));
                }
            }
            _ => assert_eq!(expected, actual, "{path}"),
        }
    }
    #[test]
    fn registered_strategy_decisions_and_prices_match_legacy_oracles() {
        let f = oracle();
        for case in f["cases"].as_array().unwrap() {
            let index = case["dataset"].as_u64().unwrap() as usize;
            let dataset = &f["datasets"][index];
            let m = market(dataset, "1m");
            let ctx = json!({"auxMarkets":{"15m":market(dataset,"15m"),"1h":market(dataset,"1h"),"4h":market(dataset,"4h"),"5m":market(dataset,"15m")},"params":case["params"],"account":{"equity":10000},"costs":{"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3}});
            let id = case["id"].as_str().unwrap();
            let got = analyze(id, &m, &ctx).unwrap();
            compatible(&case["expected"], &got, &format!("{id}:{index}"));
        }
    }
    #[test]
    fn order_review_matches_legacy_protection_and_smart_exit() {
        let f = oracle();
        for case in f["reviews"].as_array().unwrap() {
            let idx = case["market"]["dataset"].as_u64().unwrap() as usize;
            let interval = case["market"]["interval"].as_str().unwrap();
            let mut m = market(&f["datasets"][idx], interval);
            let last = m["klines"].as_array_mut().unwrap().last_mut().unwrap();
            let close = n(&case["market"], "close");
            *last = merge(
                last.clone(),
                json!({"open":close,"close":close,"high":close+0.6,"low":close-0.6}),
            );
            let id = case["id"].as_str().unwrap();
            let got = review(id, &case["order"], &m, &json!({})).unwrap();
            compatible(&case["expected"], &got, id);
        }
    }
    #[test]
    fn yao_features_predictions_and_feature_filters_match_legacy() {
        let f = oracle();
        for (i, expected) in f["predictions"].as_array().unwrap().iter().enumerate() {
            let m = market(&f["datasets"][i], "1m");
            compatible(
                &expected["features"],
                &yao_features(&m, &expected["ticker"], &json!({})),
                &format!("yao-features:{i}"),
            );
            compatible(
                &expected["prediction"],
                &yao_prediction(
                    &m,
                    &expected["ticker"],
                    1_760_000_000_000,
                    &json!({"minRawProbabilityPct":40}),
                ),
                &format!("yao-prediction:{i}"),
            );
            compatible(
                &expected["klineFeatures"],
                &kline_features(m["klines"].as_array().unwrap(), &json!({})).unwrap(),
                &format!("features:{i}"),
            );
        }
    }
    #[test]
    fn registration_preserves_schemas_and_validation() {
        assert_eq!(definitions().len(), 7);
        let p = resolve_params(
            "h4-mean-reversion-v1",
            &json!({"longOnly":"yes","maxLeverage":9000,"atrPeriod":14}),
        )
        .unwrap();
        assert_eq!(p["params"]["longOnly"], true);
        assert_eq!(number(&p["params"]["maxLeverage"], 0.), 2.);
        assert_eq!(number(&p["params"]["atrPeriod"], 0.), 14.);
        assert_eq!(p["rejected"].as_array().unwrap().len(), 1);
        let l = list(&json!({}), &json!({}));
        assert_eq!(l["enabled"], json!(["enhanced-trend-v1"]));
    }
    #[test]
    fn market_opportunity_preserves_market_execution() {
        let p = json!({"entryStyle":"market","entryMin":99,"entryMax":101,"entryReference":100,"stopLoss":95,"takeProfit":110,"riskUnit":5});
        let mut signal = json!({"symbol":"TESTUSDT","action":"BUY","plan":p});
        let m = json!({"symbol":"TESTUSDT","interval":"4h","klines":[{"close":100}]});
        signal["opportunityReport"] = opportunity_report(
            &signal,
            &m,
            &json!({"ticker24h":{"lastPrice":100}}),
            &json!({}),
            0,
        );
        assert_eq!(signal["opportunityReport"]["canProceed"], true);
        assert!(execution_plan(&signal)["entryLimit"].is_null());
        signal["opportunityReport"] = opportunity_report(
            &signal,
            &m,
            &json!({"ticker24h":{"lastPrice":102}}),
            &json!({}),
            0,
        );
        assert_eq!(
            signal["opportunityReport"]["decision"]["code"],
            "WAIT_REANALYSIS"
        );
    }
    #[test]
    fn oi_notional_inflation_does_not_create_a_false_crowding_block() {
        let signal = json!({"symbol":"TESTUSDT","action":"BUY","plan":{"entryStyle":"market","entryMin":99.,"entryMax":101.,"stopLoss":95.,"takeProfit":110.}});
        let market = json!({"symbol":"TESTUSDT","interval":"1m","klines":[{"close":100.}]});
        let mut context = json!({"ticker24h":{"lastPrice":100.,"priceChangePercent":15.},"premium":{"lastFundingRate":0.0001},"oi":[{"sumOpenInterest":100.,"sumOpenInterestValue":10000.},{"sumOpenInterest":100.,"sumOpenInterestValue":13000.}]});
        let report = opportunity_report(&signal, &market, &context, &json!({}), 0);
        assert_eq!(report["current"]["oiChangePct"], 0.);
        assert_eq!(report["canProceed"], true);
        context["oi"][1]["sumOpenInterest"] = json!(130.);
        assert_eq!(
            opportunity_report(&signal, &market, &context, &json!({}), 0)["canProceed"],
            false
        );
    }
}
