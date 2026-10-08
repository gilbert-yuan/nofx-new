pub mod analytics;
pub mod api;
pub mod automation;
pub mod automation_guards;
pub mod db;
pub mod exchange;
pub mod flow;
pub mod ledger;
pub mod paper;
pub mod research;
pub mod simulator;
pub mod spot;
pub mod store;
pub mod strategies;

#[cfg(test)]
mod oracle_tests;

use serde_json::Value;

pub fn number(value: &Value, fallback: f64) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(fallback)
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn iso(time: i64) -> String {
    chrono::DateTime::from_timestamp_millis(time)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn timestamp(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(value.as_str()?)
            .ok()
            .map(|t| t.timestamp_millis())
    })
}

pub fn interval_ms(interval: &str) -> Option<i64> {
    let (amount, unit) = interval.split_at(interval.len().checked_sub(1)?);
    let count: i64 = amount.parse().ok()?;
    if count <= 0 {
        return None;
    }
    count.checked_mul(match unit {
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        "w" => 604_800_000,
        _ => return None,
    })
}
