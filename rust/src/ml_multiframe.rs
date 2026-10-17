//! Causal higher-timeframe features from already-closed hourly candles.
//!
//! Chronos-Bolt still consumes one native series. Extra frames are LightGBM
//! inputs only, built at `origin_ms` from 4h bars whose close is <= origin.
//! Incomplete 4h groups and unclosed hours are dropped. 1m/5m/15m are never
//! synthesized by upsampling.
use crate::{number, timestamp};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

const HOUR: i64 = 3_600_000;
const BAR_4H: i64 = 4 * HOUR;

pub const FEATURE_NAMES: &[&str] = &[
    "h4_return_1_bars",
    "h4_return_3_bars",
    "h4_return_6_bars",
    "h4_return_12_bars",
    "h4_close_sma20",
    "h4_sma20_sma50",
    "h4_ema12_ema26",
    "h4_rsi14",
    "h4_atr14_fraction",
    "h4_volatility12",
    "h4_range_position24",
    "h4_volume_z24",
    "h4_available",
];

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn std(values: &[f64]) -> f64 {
    let m = mean(values);
    (values.iter().map(|x| (x - m).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
}

fn ema(values: &[f64], period: usize) -> f64 {
    let alpha = 2.0 / (period as f64 + 1.0);
    values.iter().skip(1).fold(values[0], |previous, x| {
        alpha * x + (1.0 - alpha) * previous
    })
}

fn unavailable() -> Vec<f64> {
    let mut row = vec![0.; FEATURE_NAMES.len()];
    *row.last_mut().unwrap() = 0.;
    row
}

fn aggregate(open_ms: i64, hours: [&Value; 4]) -> Result<Value> {
    let open = number(&hours[0]["open"], f64::NAN);
    let close = number(&hours[3]["close"], f64::NAN);
    let high = hours
        .iter()
        .map(|row| number(&row["high"], f64::NAN))
        .fold(f64::NEG_INFINITY, f64::max);
    let low = hours
        .iter()
        .map(|row| number(&row["low"], f64::NAN))
        .fold(f64::INFINITY, f64::min);
    let volume: f64 = hours.iter().map(|row| number(&row["volume"], 0.)).sum();
    ensure!(
        [open, close, high, low]
            .iter()
            .all(|v| v.is_finite() && *v > 0.)
            && high >= open.max(close)
            && low <= open.min(close)
            && volume >= 0.,
        "Invalid aggregated 4h candle"
    );
    Ok(json!({
        "openTime":open_ms,"open":open,"high":high,"low":low,"close":close,
        "volume":volume,"confirmed":true
    }))
}

/// 4h candles closed at or before `origin_ms`, aggregated from contiguous 1h bars.
pub fn closed_4h_from_hourly(hourly: &[Value], origin_ms: i64) -> Result<Vec<Value>> {
    ensure!(
        origin_ms > 0 && origin_ms % HOUR == 0,
        "Origin must be a closed hourly boundary"
    );
    let mut by_open = std::collections::BTreeMap::new();
    for row in hourly {
        let open = timestamp(&row["openTime"]).context("Hourly candle missing openTime")?;
        ensure!(open >= 0 && open % HOUR == 0, "Unaligned hourly candle");
        if open + HOUR > origin_ms {
            continue;
        }
        ensure!(
            by_open.insert(open, row).is_none(),
            "Duplicate hourly candle"
        );
    }
    let Some((&first, _)) = by_open.first_key_value() else {
        return Ok(Vec::new());
    };
    let start = first.div_euclid(BAR_4H).saturating_mul(BAR_4H);
    let start = if start < first { start + BAR_4H } else { start };
    let mut bars = Vec::new();
    let mut cursor = start;
    while cursor.saturating_add(BAR_4H) <= origin_ms {
        let hours = [
            by_open.get(&cursor),
            by_open.get(&(cursor + HOUR)),
            by_open.get(&(cursor + 2 * HOUR)),
            by_open.get(&(cursor + 3 * HOUR)),
        ];
        if let [Some(a), Some(b), Some(c), Some(d)] = hours {
            bars.push(aggregate(cursor, [*a, *b, *c, *d])?);
        }
        cursor = cursor.saturating_add(BAR_4H);
    }
    Ok(bars)
}

/// Compact 4h technicals. Missing history yields zeros and `h4_available=0`.
pub fn four_hour_features(hourly: &[Value], origin_ms: i64) -> Result<Vec<f64>> {
    let bars = closed_4h_from_hourly(hourly, origin_ms)?;
    if bars.len() < 50 {
        return Ok(unavailable());
    }
    let close: Vec<f64> = bars
        .iter()
        .map(|row| number(&row["close"], f64::NAN))
        .collect();
    ensure!(
        close.iter().all(|v| v.is_finite() && *v > 0.),
        "Nonfinite 4h close"
    );
    let current = *close.last().unwrap();
    let ret = |bars_back: usize| current / close[close.len() - 1 - bars_back] - 1.;
    let sma20 = mean(&close[close.len() - 20..]);
    let sma50 = mean(&close[close.len() - 50..]);
    let ema12 = ema(&close[close.len() - 50..], 12);
    let ema26 = ema(&close[close.len() - 50..], 26);
    let changes: Vec<f64> = close.windows(2).map(|w| w[1] - w[0]).collect();
    let recent = &changes[changes.len() - 14..];
    let gains: f64 = recent.iter().map(|x| x.max(0.)).sum();
    let losses: f64 = recent.iter().map(|x| (-x).max(0.)).sum();
    let rsi = if gains + losses == 0. {
        0.5
    } else {
        gains / (gains + losses)
    };
    let mut tr = Vec::with_capacity(14);
    for i in bars.len() - 14..bars.len() {
        let high = number(&bars[i]["high"], f64::NAN);
        let low = number(&bars[i]["low"], f64::NAN);
        let previous = number(&bars[i - 1]["close"], f64::NAN);
        tr.push(
            (high - low)
                .max((high - previous).abs())
                .max((low - previous).abs()),
        );
    }
    let atr = mean(&tr) / current;
    let returns: Vec<f64> = close.windows(2).map(|w| w[1] / w[0] - 1.).collect();
    let last24 = &bars[bars.len() - 24..];
    let high = last24
        .iter()
        .map(|row| number(&row["high"], 0.))
        .fold(f64::NEG_INFINITY, f64::max);
    let low = last24
        .iter()
        .map(|row| number(&row["low"], 0.))
        .fold(f64::INFINITY, f64::min);
    let position = if high > low {
        (current - low) / (high - low)
    } else {
        0.5
    };
    let volume: Vec<f64> = last24
        .iter()
        .map(|row| number(&row["volume"], 0.))
        .collect();
    let volume_std = std(&volume);
    let volume_z = if volume_std > 0. {
        (volume[23] - mean(&volume)) / volume_std
    } else {
        0.
    };
    let output = vec![
        ret(1),
        ret(3),
        ret(6),
        ret(12),
        current / sma20 - 1.,
        sma20 / sma50 - 1.,
        ema12 / ema26 - 1.,
        rsi,
        atr,
        std(&returns[returns.len() - 12..]),
        position,
        volume_z,
        1.,
    ];
    ensure!(
        output.len() == FEATURE_NAMES.len() && output.iter().all(|v| v.is_finite()),
        "Invalid 4h feature vector"
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hourly(count: usize, start: i64) -> Vec<Value> {
        (0..count)
            .map(|i| {
                let open = start + i as i64 * HOUR;
                let close = 100. + i as f64;
                json!({"openTime":open,"open":close,"high":close+1.,"low":close-1.,"close":close,"volume":10.,"confirmed":true})
            })
            .collect()
    }

    #[test]
    fn unclosed_hour_and_incomplete_4h_group_are_excluded() {
        let rows = hourly(10, 0);
        let origin = 10 * HOUR;
        let bars = closed_4h_from_hourly(&rows, origin).unwrap();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0]["openTime"], 0);
        assert_eq!(bars[1]["openTime"], 4 * HOUR);
        assert_eq!(bars[1]["close"], 100. + 7.);
        let later = closed_4h_from_hourly(&rows, 11 * HOUR).unwrap();
        assert_eq!(later.len(), 2);
    }

    #[test]
    fn future_hourly_closes_cannot_change_4h_features() {
        let mut rows = hourly(220, 0);
        let origin = 200 * HOUR;
        let original = four_hour_features(&rows, origin).unwrap();
        assert_eq!(original[12], 1.);
        for row in &mut rows[200..] {
            row["close"] = json!(1e9);
            row["high"] = json!(1e9);
        }
        assert_eq!(original, four_hour_features(&rows, origin).unwrap());
        rows[50]["openTime"] = json!(49 * HOUR);
        assert!(closed_4h_from_hourly(&rows, origin).is_err());
    }

    #[test]
    fn short_history_is_marked_unavailable_instead_of_invented() {
        let rows = hourly(20, 0);
        let features = four_hour_features(&rows, 20 * HOUR).unwrap();
        assert_eq!(features, unavailable());
        assert_eq!(features[12], 0.);
    }
}
