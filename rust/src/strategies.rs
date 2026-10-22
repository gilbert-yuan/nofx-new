//! The active altcoin strategy and shared order protection helpers.
use crate::number;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::sync::OnceLock;
#[path = "strategies/altcoin_breakout.rs"]
pub mod altcoin_breakout;
#[path = "strategies/indicators.rs"]
pub mod indicators;
#[path = "strategies/opportunity.rs"]
mod opportunity;
pub use indicators::{atr, ema};
pub use opportunity::{execution_plan, is_market_plan, market_entry_block, opportunity_report};

pub const ACTIVE_STRATEGY_ID: &str = "altcoin-trend-breakout-live-v1";
/// Historical input alias for the same algorithm, never an online registration.
pub const RESEARCH_STRATEGY_ID: &str = "altcoin-trend-breakout-v1";
pub fn is_current_strategy(id: &str) -> bool {
    matches!(id, ACTIVE_STRATEGY_ID | RESEARCH_STRATEGY_ID)
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
    if !is_current_strategy(id) {
        return None;
    }
    let mut item = definitions().into_iter().next()?;
    if id == RESEARCH_STRATEGY_ID {
        item["id"] = json!(id);
        item["researchOnly"] = json!(true);
    }
    Some(item)
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
pub fn list(_config: &Value, state: &Value) -> Value {
    let default_id = ACTIVE_STRATEGY_ID;
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
    if !is_current_strategy(id) {
        bail!("未知策略：{id}");
    }
    if id == RESEARCH_STRATEGY_ID && context["allowResearchOnly"] != true {
        return Ok(wait(
            market,
            "历史研究别名仅供离线回测。",
            &Value::Null,
            json!({"researchOnly":true}),
        ));
    }
    let mut ctx = if context.is_object() {
        context.clone()
    } else {
        json!({})
    };
    ctx["params"] = resolve_params(id, &context["params"])?["params"].clone();
    let mut signal = altcoin_breakout::analyze(market, &ctx);
    if ctx["deferMarketFilters"] != true {
        crate::market_filters::apply(&mut signal, market, &ctx);
    }
    Ok(signal)
}
pub fn review(id: &str, order: &Value, market: &Value, context: &Value) -> Result<Value> {
    if is_current_strategy(id) || order["plan"]["altcoinTrend"]["variant"] == "breakout" {
        Ok(altcoin_breakout::review(order, market, context))
    } else {
        // Historical orders retain their frozen shared protection and can still
        // be inspected or closed after their former strategy was removed.
        Ok(local_review(order, market))
    }
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
    let defaults: Value = serde_json::from_str(include_str!("strategies/exit_defaults.json"))
        .expect("shared exit defaults");
    let mut rules = exit_rules(&defaults);
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_exposes_only_current_strategy_and_current_reset_defaults() {
        let snapshot = list(&json!({}), &json!({}));
        assert_eq!(snapshot["strategies"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["enabled"], json!([ACTIVE_STRATEGY_ID]));
        let p = defaults(ACTIVE_STRATEGY_ID);
        for (key, value) in [
            ("emaFast", 25.),
            ("emaSlow", 75.),
            ("channelPeriod", 8.),
            ("stopAtr", 1.),
            ("trailAtr", 3.),
            ("riskPerTrade", 0.003),
            ("maxNotionalPct", 0.5),
            ("maxPositions", 3.),
        ] {
            assert_eq!(number(&p[key], f64::NAN), value, "{key}");
        }
        assert_eq!(p["useEmaFilter"], true);
        let off = list(
            &json!({}),
            &json!({"initialized":true,
            "strategies":{"altcoin-trend-breakout-live-v1":{"enabled":false}}}),
        );
        assert!(off["enabled"].as_array().unwrap().is_empty());
    }
    #[test]
    fn historical_input_alias_never_adds_a_registered_or_executable_old_strategy() {
        assert_eq!(defaults(RESEARCH_STRATEGY_ID), defaults(ACTIVE_STRATEGY_ID));
        assert_eq!(
            definition(RESEARCH_STRATEGY_ID).unwrap()["researchOnly"],
            true
        );
        assert_eq!(
            analyze(RESEARCH_STRATEGY_ID, &json!({}), &json!({})).unwrap()["researchOnly"],
            true
        );
        for id in [
            "altcoin-trend-retest-v1",
            "h4-trend-breakout-v1",
            "enhanced-trend-v1",
            "yao-coin-ambush-v1",
            "crypto-quant-signal-v1",
            "chronos-lightgbm-v1",
        ] {
            assert!(definition(id).is_none(), "{id}");
            assert!(resolve_params(id, &json!({})).is_err(), "{id}");
            assert!(analyze(id, &json!({}), &json!({})).is_err(), "{id}");
        }
    }
    #[test]
    fn shared_exit_defaults_and_frozen_order_overrides_survive_registry_cleanup() {
        let base = exit_rules_for(&json!({}));
        assert_eq!(base["trailing"]["triggerR"], 0.4);
        assert_eq!(base["smartExit"]["maPeriod"], 20);
        assert_eq!(base["partialTp"]["tp1ClosePct"], 0.4);
        let frozen = exit_rules_for(&json!({"exitRules":{"smartExit":{"enabled":false},
            "partialTp":{"enabled":false},"trailing":{"triggerR":1000000}}}));
        assert_eq!(frozen["smartExit"]["enabled"], false);
        assert_eq!(frozen["partialTp"]["enabled"], false);
        assert_eq!(frozen["trailing"]["triggerR"], 1000000);
        assert_eq!(
            review("removed-historical-id", &json!({}), &json!({}), &json!({})).unwrap()["action"],
            "HOLD"
        );
    }
}
