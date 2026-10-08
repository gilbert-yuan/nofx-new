//! Timestamped source data, never today's context substituted into yesterday's signals.
use crate::{
    db::Db,
    exchange::{Exchange, storage_symbol, valid_symbol},
    interval_ms, iso, now_ms, number, timestamp,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub kind: String,
    pub observed_at: i64,
    pub available_at: i64,
    pub origin: String,
    pub data: Value,
}

pub fn samples(raw: &Value) -> Vec<Sample> {
    let mut result = vec![];
    for (key, field, array) in [
        ("oi5m", "timestamp", true),
        ("globalRatio", "timestamp", true),
        ("topPositionRatio", "timestamp", true),
        ("funding", "fundingTime", true),
        ("premium", "time", false),
        ("depth", "T", false),
    ] {
        let Some(known) = timestamp(&raw["meta"][key]["fetchedAt"]) else {
            continue;
        };
        let rows = if array {
            raw[key].as_array().cloned().unwrap_or_default()
        } else {
            vec![raw[key].clone()]
        };
        for data in rows {
            let observed = timestamp(&data[field]).unwrap_or(known);
            if data.is_object() && observed <= known && observed > 0 {
                result.push(Sample {
                    kind: key.into(),
                    observed_at: observed,
                    available_at: known,
                    origin: "live".into(),
                    data,
                });
            }
        }
    }
    result
}

pub fn context(symbol: &str, samples: &[Sample], now: i64) -> Value {
    let mut groups: BTreeMap<&str, BTreeMap<i64, &Sample>> = BTreeMap::new();
    // Prefer the earliest known version at a timestamp, independent of input ordering.
    for sample in samples
        .iter()
        .filter(|s| s.observed_at <= now && s.available_at <= now)
    {
        let rows = groups.entry(&sample.kind).or_default();
        if rows
            .get(&sample.observed_at)
            .is_none_or(|s| s.available_at > sample.available_at)
        {
            rows.insert(sample.observed_at, sample);
        }
    }
    render(symbol, groups)
}
fn render(symbol: &str, groups: BTreeMap<&str, BTreeMap<i64, &Sample>>) -> Value {
    let mut raw = json!({"symbol":symbol,"meta":{},"errors":{}});
    for (key, rows) in groups {
        let keep = match key {
            "oi5m" => 13,
            "globalRatio" | "topPositionRatio" => 2,
            _ => 1,
        };
        let recent: Vec<_> = rows.values().rev().take(keep).rev().collect();
        let latest = recent.last().unwrap();
        raw[key] = if matches!(key, "premium" | "depth") {
            latest.data.clone()
        } else {
            json!(recent.iter().map(|s| &s.data).collect::<Vec<_>>())
        };
        raw["meta"][key] = json!({"source":"binance","fetchedAt":iso(latest.available_at),"origin":latest.origin,"replay":true});
    }
    if let Some(rows) = raw["oi5m"].as_array() {
        let oi: Vec<_> = rows
            .iter()
            .filter(|r| timestamp(&r["timestamp"]).is_some_and(|t| t % 900_000 == 0))
            .cloned()
            .collect();
        raw["oi"] = json!(oi);
        raw["meta"]["oi"] = raw["meta"]["oi5m"].clone();
    }
    raw
}

pub struct Timeline<'a> {
    samples: Vec<&'a Sample>,
    cursor: usize,
    groups: BTreeMap<&'a str, BTreeMap<i64, &'a Sample>>,
}
impl<'a> Timeline<'a> {
    pub fn new(samples: &'a [Sample]) -> Self {
        let mut samples: Vec<_> = samples
            .iter()
            .filter(|s| s.available_at >= s.observed_at)
            .collect();
        samples.sort_by_key(|s| s.available_at);
        Self {
            samples,
            cursor: 0,
            groups: BTreeMap::new(),
        }
    }
    pub fn at(&mut self, symbol: &str, now: i64) -> Value {
        while self.cursor < self.samples.len() && self.samples[self.cursor].available_at <= now {
            let sample = self.samples[self.cursor];
            let rows = self.groups.entry(&sample.kind).or_default();
            rows.entry(sample.observed_at).or_insert(sample);
            // Keep enough samples for the longest OI horizon plus publication lag.
            while rows.len() > 32 {
                rows.pop_first();
            }
            self.cursor += 1;
        }
        render(symbol, self.groups.clone())
    }
}

pub fn range(input: &Value) -> Result<(String, i64, i64)> {
    let symbol = input["symbol"]
        .as_str()
        .unwrap_or("BTCUSDT")
        .trim()
        .to_uppercase();
    valid_symbol(&symbol)?;
    let start = timestamp(&input["startTime"])
        .context("400: startTime 必须是毫秒时间戳或带时区的 ISO 时间")?;
    let end =
        timestamp(&input["endTime"]).context("400: endTime 必须是毫秒时间戳或带时区的 ISO 时间")?;
    if start <= 0 || end <= start || end > now_ms() || end - start > 31 * 86_400_000 {
        bail!("400: 请选择过去不超过 31 天的区间；结束时间不含在内");
    }
    Ok((symbol, start, end))
}

/// Advance only across contiguous, complete candles fetched after they closed.
fn advance_cached(rows: &[Value], index: &mut usize, mut cursor: i64, dt: i64, end: i64) -> i64 {
    while let Some(row) = rows.get(*index) {
        let Some(open) = timestamp(&row["openTime"]) else {
            *index += 1;
            continue;
        };
        if open < cursor {
            *index += 1;
            continue;
        }
        if open != cursor
            || open + dt > end
            || timestamp(&row["refreshedAt"]).is_none_or(|at| at < open + dt)
            || ["open", "high", "low", "close"].iter().any(|key| {
                let n = number(&row[key], f64::NAN);
                !n.is_finite() || n <= 0.
            })
            || ["volume", "quoteVolume", "tradeCount", "takerBuyQuoteVolume"]
                .iter()
                .any(|key| {
                    let n = number(&row[key], f64::NAN);
                    !n.is_finite() || n < 0.
                })
        {
            break;
        }
        cursor += dt;
        *index += 1;
    }
    cursor
}

/// The REST statistics window is bounded by Binance; older local history remains usable.
pub async fn fetch(db: &Db, exchange: &Exchange, input: &Value) -> Result<Value> {
    let (symbol, start, end) = range(input)?;
    let id = input["strategyId"].as_str().unwrap_or("enhanced-trend-v1");
    let def = crate::strategies::definition(id).context("400: 未知策略")?;
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
    let mut counts = json!({});
    let mut reused = json!({});
    let mut errors = vec![];
    for (tf, window) in intervals {
        let dt = interval_ms(&tf).context("策略周期无效")?;
        let mut cursor = (start - (window as i64 + 2) * dt).max(dt).div_euclid(dt) * dt;
        let storage = storage_symbol(&symbol, "binance")?;
        let cached = db
            .candles(&storage, &tf, 100_000, Some(cursor), Some(end))
            .await?;
        let mut cache_index = 0;
        let mut count = 0;
        let mut reuse_count = 0;
        while cursor < end {
            let next = advance_cached(&cached, &mut cache_index, cursor, dt, end);
            reuse_count += (next - cursor) / dt;
            cursor = next;
            if cursor >= end {
                break;
            }
            // Fetch a gap without overwriting a later complete cached segment.
            let query_end = cached
                .get(cache_index)
                .and_then(|r| timestamp(&r["openTime"]))
                .filter(|at| *at > cursor)
                .map_or(end - 1, |at| (at - 1).min(end - 1));
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                exchange.klines(&symbol, &tf, 1000, Some(cursor), Some(query_end)),
            )
            .await;
            let rows = match result {
                Ok(Ok(rows)) => rows,
                Ok(Err(e)) => {
                    errors.push(format!("{tf}: {e}"));
                    break;
                }
                Err(_) => {
                    errors.push(format!("{tf}: 请求超过 30 秒"));
                    break;
                }
            };
            if rows.is_empty() {
                break;
            }
            let next = rows
                .iter()
                .filter_map(|r| timestamp(&r["openTime"]))
                .max()
                .context("K 线无时间")?
                + dt;
            db.save_klines(&storage, &tf, &rows).await?;
            count += rows.len();
            if next <= cursor {
                bail!("K 线分页没有前进");
            }
            cursor = next;
        }
        counts[&tf] = json!(count);
        reused[&tf] = json!(reuse_count);
    }
    let earliest = now_ms() - 29 * 86_400_000;
    for (kind, path, field, limit, lag) in [
        (
            "oi5m",
            "/futures/data/openInterestHist",
            "timestamp",
            500,
            300_000,
        ),
        (
            "globalRatio",
            "/futures/data/globalLongShortAccountRatio",
            "timestamp",
            500,
            300_000,
        ),
        (
            "topPositionRatio",
            "/futures/data/topLongShortPositionRatio",
            "timestamp",
            500,
            300_000,
        ),
        (
            "funding",
            "/fapi/v1/fundingRate",
            "fundingTime",
            1000,
            60_000,
        ),
    ] {
        let mut cursor = (start - 2 * 86_400_000).max(1);
        if kind != "funding" {
            cursor = cursor.max(earliest);
        }
        let mut count = 0;
        while cursor < end {
            let query_end = if kind == "funding" {
                end - 1
            } else {
                (cursor + (limit as i64 - 1) * 300_000).min(end - 1)
            };
            let mut params =
                json!({"symbol":symbol,"startTime":cursor,"endTime":query_end,"limit":limit});
            if kind != "funding" {
                params["period"] = json!("5m");
            }
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                exchange.public_request(path, &params),
            )
            .await;
            let response = match response {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => {
                    errors.push(format!("{kind}: {e}"));
                    break;
                }
                Err(_) => {
                    errors.push(format!("{kind}: 请求超过 20 秒"));
                    break;
                }
            };
            let rows = response.as_array().context("历史统计返回格式错误")?;
            if rows.is_empty() {
                if kind == "funding" {
                    break;
                }
                cursor = query_end + 1;
                continue;
            }
            let next = rows
                .iter()
                .filter_map(|r| timestamp(&r[field]))
                .max()
                .context("历史统计无时间")?
                + 1;
            let samples: Vec<_> = rows
                .iter()
                .filter_map(|row| {
                    let at = timestamp(&row[field])?;
                    (at < end).then(|| Sample {
                        kind: kind.into(),
                        observed_at: at,
                        available_at: at + lag,
                        origin: "historical-rest".into(),
                        data: row.clone(),
                    })
                })
                .collect();
            db.save_indicator_samples(&symbol, &samples).await?;
            count += samples.len();
            if next <= cursor {
                bail!("历史指标分页没有前进");
            }
            cursor = if kind == "funding" {
                next
            } else {
                query_end + 1
            };
            if kind == "funding" && rows.len() < limit as usize {
                break;
            }
        }
        counts[kind] = json!(count);
    }
    Ok(
        json!({"symbol":symbol,"startTime":iso(start),"endTime":iso(end),"saved":counts,"reusedKlines":reused,"errors":errors,"complete":errors.is_empty(),"availabilityAssumption":"历史统计保守延后 5 分钟可用；结算费率延后 1 分钟；实时快照按实际获取时间","bookHistory":"只使用已采集的 20 档快照，不用其他盘口口径替代"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_history_never_bridges_gaps_or_accepts_unfinished_or_incomplete_rows() {
        let candle = |at| json!({"openTime":at,"open":1.,"high":2.,"low":1.,"close":2.,"volume":3.,"quoteVolume":6.,"tradeCount":1,"takerBuyQuoteVolume":4.,"refreshedAt":at+60_000});
        let rows = vec![candle(60_000), candle(120_000), candle(240_000)];
        let mut index = 0;
        assert_eq!(
            advance_cached(&rows, &mut index, 60_000, 60_000, 300_000),
            180_000
        );
        assert_eq!(index, 2);
        assert_eq!(
            advance_cached(&rows, &mut index, 240_000, 60_000, 300_000),
            300_000
        );
        for key in ["quoteVolume", "tradeCount", "takerBuyQuoteVolume"] {
            let mut incomplete = candle(60_000);
            incomplete[key] = Value::Null;
            assert_eq!(
                advance_cached(&[incomplete], &mut 0, 60_000, 60_000, 120_000),
                60_000
            );
        }
        let mut unfinished = candle(60_000);
        unfinished["refreshedAt"] = json!(90_000);
        assert_eq!(
            advance_cached(&[unfinished], &mut 0, 60_000, 60_000, 120_000),
            60_000
        );
        assert_eq!(
            advance_cached(&[candle(60_000)], &mut 0, 60_000, 60_000, 90_000),
            60_000
        );
    }
    #[test]
    fn publication_and_observation_times_both_gate_replay() {
        let samples = vec![Sample {
            kind: "oi5m".into(),
            observed_at: 100,
            available_at: 200,
            origin: "live".into(),
            data: json!({"timestamp":100,"sumOpenInterest":50}),
        }];
        assert!(context("BTCUSDT", &samples, 150)["oi5m"].is_null());
        assert_eq!(
            context("BTCUSDT", &samples, 200)["oi5m"][0]["sumOpenInterest"],
            50
        );
        let mut future = samples.clone();
        future[0].observed_at = 300;
        assert!(context("BTCUSDT", &future, 200)["oi5m"].is_null());
    }
}
