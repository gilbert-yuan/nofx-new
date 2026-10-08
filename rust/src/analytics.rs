//! Account reports and adaptive rules. All computations use persisted order snapshots.
mod adaptive;
mod local;
mod optimizer;
mod replay;
pub use adaptive::*;
pub use local::*;
pub use optimizer::*;
pub use replay::*;

use crate::{iso, now_ms, number, timestamp};
use chrono::{Datelike, Timelike};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn orders(state: &Value) -> Vec<Value> {
    state["orders"].as_array().cloned().unwrap_or_default()
}
pub fn closed_orders(state: &Value) -> Vec<Value> {
    orders(state)
        .into_iter()
        .filter(|o| o["status"] == "closed")
        .collect()
}
pub(crate) fn num(v: &Value, k: &str) -> f64 {
    number(&v[k], 0.0)
}
pub(crate) fn text<'a>(v: &'a Value, k: &str, default: &'a str) -> &'a str {
    v[k].as_str().filter(|s| !s.is_empty()).unwrap_or(default)
}
pub(crate) fn win_rate(rows: &[Value]) -> f64 {
    if rows.is_empty() {
        0.0
    } else {
        rows.iter().filter(|o| num(o, "net") > 0.0).count() as f64 / rows.len() as f64
    }
}
pub(crate) fn average(rows: &[Value], key: &str) -> f64 {
    if rows.is_empty() {
        0.0
    } else {
        rows.iter().map(|o| num(o, key)).sum::<f64>() / rows.len() as f64
    }
}
pub(crate) fn group<F: Fn(&Value) -> String>(
    rows: &[Value],
    key: F,
) -> BTreeMap<String, Vec<Value>> {
    let mut out = BTreeMap::new();
    for row in rows {
        out.entry(key(row))
            .or_insert_with(Vec::new)
            .push(row.clone());
    }
    out
}
pub fn normalize_reason(reason: &str) -> &str {
    match reason {
        "stop_loss"
        | "trailing_stop"
        | "break_even_stop"
        | "take_profit"
        | "partial_take_profit"
        | "smart_exit_ma"
        | "smart_exit_rsi"
        | "smart_exit_macd"
        | "liquidation"
        | "timeout"
        | "manual"
        | "strategy_cancelled" => return reason,
        _ => {}
    }
    if ["均线失守", "趋势证伪"].iter().any(|s| reason.contains(s))
        || ((reason.contains("跌破") || reason.contains("突破")) && reason.contains("均线"))
    {
        "smart_exit_ma"
    } else if reason.contains("RSI") {
        "smart_exit_rsi"
    } else if reason.contains("MACD") {
        "smart_exit_macd"
    } else if reason.contains("保本") {
        "break_even_stop"
    } else if reason.contains("移动止损") || reason.contains("跟踪止损") {
        "trailing_stop"
    } else if reason.contains("止盈") || reason.contains("获利了结") {
        "take_profit"
    } else if reason.contains("止损") {
        "stop_loss"
    } else if reason.contains("到期") || reason.contains("超时") {
        "timeout"
    } else if reason.contains("爆仓") || reason.contains("强平") {
        "liquidation"
    } else {
        "manual"
    }
}
fn is_stop(s: &str) -> bool {
    matches!(
        normalize_reason(s),
        "stop_loss" | "trailing_stop" | "break_even_stop"
    )
}
fn is_tp(s: &str) -> bool {
    matches!(normalize_reason(s), "take_profit" | "partial_take_profit")
}
fn local_date(order: &Value, key: &str) -> String {
    timestamp(&order[key])
        .and_then(|t| chrono::DateTime::from_timestamp_millis(t + 28_800_000))
        .map(|t| format!("{:04}-{:02}-{:02}", t.year(), t.month(), t.day()))
        .unwrap_or_else(|| "unknown".into())
}
fn base(rows: &[Value]) -> Value {
    let wins = rows.iter().filter(|o| num(o, "net") > 0.0).count();
    json!({"count":rows.len(),"wins":wins,"totalNet":rows.iter().map(|o|num(o,"net")).sum::<f64>(),"winRate":win_rate(rows),"avgNet":average(rows,"net")})
}
fn group_stats<F: Fn(&Value) -> String>(
    rows: &[Value],
    key: F,
    label: &str,
    gross: bool,
) -> Vec<Value> {
    let mut out: Vec<Value> = group(rows, key)
        .into_iter()
        .map(|(key, rows)| {
            let mut v = base(&rows);
            v[label] = json!(key);
            if gross {
                v["totalGross"] = json!(rows.iter().map(|o| num(o, "gross")).sum::<f64>());
            }
            v
        })
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v["count"].as_u64().unwrap_or(0)));
    out
}
fn day_stats(rows: &[Value]) -> Vec<Value> {
    group(rows, |o| local_date(o, "exitAt"))
        .into_iter()
        .rev()
        .map(|(date, rows)| {
            let mut v = base(&rows);
            v["date"] = json!(date);
            let wins: Vec<Value> = rows
                .iter()
                .filter(|o| num(o, "net") > 0.0)
                .cloned()
                .collect();
            v["avgWin"] = json!(average(&wins, "net"));
            for (field, key) in [
                ("totalGross", "gross"),
                ("totalFees", "fees"),
                ("totalFunding", "funding"),
            ] {
                v[field] = json!(rows.iter().map(|o| num(o, key)).sum::<f64>());
            }
            v["longCount"] = json!(
                rows.iter()
                    .filter(|o| o["direction"] == "OPEN_LONG")
                    .count()
            );
            v["shortCount"] = json!(
                rows.iter()
                    .filter(|o| o["direction"] == "OPEN_SHORT")
                    .count()
            );
            v["stoppedCount"] = json!(
                rows.iter()
                    .filter(|o| is_stop(text(o, "reason", "")))
                    .count()
            );
            v["takeProfitCount"] =
                json!(rows.iter().filter(|o| is_tp(text(o, "reason", ""))).count());
            v
        })
        .collect()
}
pub fn statistics(state: &Value) -> Value {
    let all = orders(state);
    let closed = closed_orders(state);
    let days = day_stats(&closed);
    let by_symbol = group_stats(
        &closed,
        |o| text(o, "symbol", "unknown").into(),
        "symbol",
        true,
    );
    let by_strategy = group_stats(
        &closed,
        |o| text(&o["analysisContext"], "strategyVersion", "unknown").into(),
        "version",
        false,
    );
    let by_engine = group_stats(
        &closed,
        |o| text(&o["analysisContext"], "analysisEngine", "unknown").into(),
        "engine",
        false,
    );
    let mut hours = Vec::new();
    for hour in 0..24 {
        let rows: Vec<Value> = closed
            .iter()
            .filter(|o| {
                timestamp(&o["createdAt"])
                    .and_then(chrono::DateTime::from_timestamp_millis)
                    .is_some_and(|t| t.hour() == hour)
            })
            .cloned()
            .collect();
        if !rows.is_empty() {
            let mut v = base(&rows);
            v["hour"] = json!(hour);
            hours.push(v);
        }
    }
    let with_hold: Vec<Value> = closed
        .iter()
        .filter(|o| num(o, "heldBars") != 0.0)
        .cloned()
        .collect();
    let mut hold: Vec<Value> = group(&with_hold, |o| {
        ((num(o, "heldBars") / 5.0).floor() * 5.0).to_string()
    })
    .into_iter()
    .map(|(bars, rows)| {
        let mut v = base(&rows);
        v["bars"] = json!(bars.parse::<f64>().unwrap_or(0.0));
        v
    })
    .collect();
    hold.sort_by(|a, b| num(a, "bars").total_cmp(&num(b, "bars")));
    let ambiguous: Vec<Value> = closed
        .iter()
        .filter(|o| o["ambiguousBar"] == true)
        .cloned()
        .collect();
    let mut reasons = group_stats(
        &ambiguous,
        |o| text(o, "reason", "unknown").into(),
        "reason",
        false,
    );
    for row in &mut reasons {
        row.as_object_mut().unwrap().remove("avgNet");
    }
    json!({"summary":{"totalOrders":all.len(),"closedOrders":closed.len(),"activeOrders":all.iter().filter(|o|matches!(o["status"].as_str(),Some("open"|"pending"))).count(),
        "dayCount":days.iter().filter(|d|d["date"]!="unknown").count(),"totalNetDailySum":days.iter().map(|d|num(d,"totalNet")).sum::<f64>(),"firstCloseDay":days.last().map(|d|d["date"].clone()),"lastCloseDay":days.first().map(|d|d["date"].clone())},
        "bySymbol":by_symbol,"byStrategy":by_strategy,"byEngine":by_engine,"byHour":hours,"byHoldingBars":hold,"byDay":days,
        "ambiguousBar":{"total":ambiguous.len(),"sampledFrom":closed.len(),"ratio":if closed.is_empty(){0.0}else{ambiguous.len() as f64/closed.len() as f64},"byReason":reasons}})
}
pub fn daily_trend(state: &Value) -> Value {
    let stats = statistics(state);
    let closed = closed_orders(state);
    let mut summary = stats["summary"].clone();
    let known: Vec<Value> = stats["byDay"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["date"] != "unknown")
        .cloned()
        .collect();
    summary["firstCloseDay"] = known
        .last()
        .map(|d| d["date"].clone())
        .unwrap_or(Value::Null);
    summary["lastCloseDay"] = known
        .first()
        .map(|d| d["date"].clone())
        .unwrap_or(Value::Null);
    summary["avgDailyWinRate"] = json!(average(&known, "winRate"));
    let mut reasons = group_stats(
        &closed,
        |o| text(o, "reason", "unknown").into(),
        "reason",
        false,
    );
    for v in &mut reasons {
        let rows: Vec<Value> = closed
            .iter()
            .filter(|o| o["reason"] == v["reason"])
            .cloned()
            .collect();
        let wins: Vec<Value> = rows
            .iter()
            .filter(|o| num(o, "net") > 0.0)
            .cloned()
            .collect();
        v["totalFees"] = json!(rows.iter().map(|o| num(o, "fees")).sum::<f64>());
        v["avgWin"] = json!(average(&wins, "net"));
    }
    json!({"byDay":stats["byDay"],"byReason":reasons,"summary":summary,"generatedAt":iso(now_ms()),"source":"rust"})
}
pub fn strategy_stats(state: &Value, granularity: &str) -> Value {
    let gran = if granularity == "hour" { "hour" } else { "day" };
    let all = orders(state);
    let sid = |o: &Value| text(&o["analysisContext"], "strategyId", "unknown").to_owned();
    let aggregation = |rows: &[Value]| {
        let closed = rows.iter().filter(|o| o["status"] == "closed").count();
        let profit = rows.iter().filter(|o| num(o, "net") > 0.0).count();
        json!({"orders":rows.len(),"closed":closed,"profit":profit,"net":(rows.iter().map(|o|num(o,"net")).sum::<f64>()*100.0).round()/100.0,"winRate":if closed>0{profit as f64/closed as f64}else{0.0}})
    };
    let mut strategies: Vec<Value> = group(&all, sid)
        .into_iter()
        .map(|(id, rows)| {
            let mut v = aggregation(&rows);
            v["id"] = json!(id);
            v["name"] = json!(text(&rows[0]["analysisContext"], "strategyName", "(未知)"));
            v
        })
        .collect();
    strategies.sort_by_key(|v| std::cmp::Reverse(v["orders"].as_u64().unwrap()));
    let bucket = |o: &Value| {
        if gran == "hour" {
            timestamp(&o["createdAt"])
                .and_then(|t| chrono::DateTime::from_timestamp_millis(t + 28_800_000))
                .map(|t| t.hour().to_string())
                .unwrap_or_else(|| "unknown".into())
        } else {
            local_date(o, "createdAt")
        }
    };
    let mut buckets: Vec<Value> = group(&all, bucket)
        .into_iter()
        .map(|(key, rows)| {
            let mut v = aggregation(&rows);
            let count = v["orders"].clone();
            v.as_object_mut().unwrap().remove("orders");
            v.as_object_mut().unwrap().remove("winRate");
            v["total"] = count;
            v["bucket"] = json!(key);
            let mut detail = json!({});
            for (id, sub) in group(&rows, sid) {
                let mut item = aggregation(&sub);
                item.as_object_mut().unwrap().remove("winRate");
                detail[id] = item;
            }
            v["byStrategy"] = detail;
            v
        })
        .collect();
    if gran == "hour" {
        buckets.sort_by_key(|v| text(v, "bucket", "99").parse::<u32>().unwrap_or(99));
    }
    json!({"generatedAt":iso(now_ms()),"filters":{"granularity":gran},"overview":aggregation(&all),"byStrategy":strategies,"timeline":{"granularity":gran,"buckets":buckets}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daily_exit_buckets_use_utc_plus_eight_and_reason_families() {
        let state = json!({"orders":[{"status":"closed","createdAt":"2026-10-01T12:00:00Z","exitAt":"2026-10-01T17:00:00Z","net":2,"fees":1,"direction":"OPEN_LONG","reason":"trailing_stop"},{"status":"closed","exitAt":"broken","net":-1,"reason":"take_profit"},{"status":"pending"}]});
        let report = daily_trend(&state);
        assert_eq!(report["summary"]["dayCount"], 1);
        assert_eq!(report["summary"]["firstCloseDay"], "2026-10-02");
        assert_eq!(report["summary"]["totalNetDailySum"], 1.0);
        let day = report["byDay"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["date"] == "2026-10-02")
            .unwrap();
        assert_eq!(day["stoppedCount"], 1);
        assert_eq!(day["avgWin"], 2.0);
    }
}
