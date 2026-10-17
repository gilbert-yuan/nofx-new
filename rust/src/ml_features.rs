//! Closed-prefix features and a frozen three-class policy. No account or execution access.
use crate::{chronos::ForecastRecord, number, research, simulator, strategies, timestamp};
use anyhow::{Result, ensure};
use serde_json::Value;

pub const HOUR: i64 = 3_600_000;
pub const HORIZON: usize = 12;
pub const CONTEXT: usize = 256;
pub const PROBABILITY_THRESHOLD: f64 = 0.55;
pub const PROBABILITY_MARGIN: f64 = 0.10;
pub const LABEL_EDGE_BUFFER_BPS: f64 = 25.0;
pub const BASE_FEATURE_NAMES: &[&str] = &[
    "return_1h",
    "return_3h",
    "return_6h",
    "return_12h",
    "return_24h",
    "return_72h",
    "return_168h",
    "close_sma20",
    "close_sma50",
    "sma20_sma50",
    "close_ema12",
    "close_ema26",
    "ema12_ema26",
    "rsi14",
    "atr14_fraction",
    "volatility24",
    "volatility72",
    "candle_range_fraction",
    "range_position24",
    "volume_z24",
    "volume5_volume20",
    "hour_sin",
    "hour_cos",
    "weekday_sin",
    "weekday_cos",
];
pub const CHRONOS_FEATURE_NAMES: &[&str] = &[
    "chronos_q10_return12",
    "chronos_q50_return12",
    "chronos_q90_return12",
    "chronos_width12",
    "chronos_q50_slope1_to12",
    "chronos_mean_q50_return",
];

/// Quarter-hour indicators retain their bar counts. Their names explicitly
/// identify steps so 24 bars (6h) can never be mistaken for 24 hours.
pub fn base_feature_names_for_interval(interval: &str) -> Result<Vec<String>> {
    crate::chronos::interval_ms(interval)?;
    if interval == "1h" {
        return Ok(BASE_FEATURE_NAMES.iter().map(|s| (*s).into()).collect());
    }
    Ok(BASE_FEATURE_NAMES
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let name = if i < 7 {
                name.replace('h', "_bars")
            } else if i >= 21 {
                (*name).into()
            } else {
                format!("{name}_bars")
            };
            format!("15m_{name}")
        })
        .collect())
}

pub fn chronos_feature_names_for_interval(interval: &str) -> Result<Vec<String>> {
    crate::chronos::interval_ms(interval)?;
    Ok(CHRONOS_FEATURE_NAMES
        .iter()
        .map(|name| {
            if interval == "1h" {
                (*name).into()
            } else {
                format!("15m_{name}_steps")
            }
        })
        .collect())
}

fn price(row: &Value) -> f64 {
    number(&row["close"], f64::NAN)
}
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

pub fn validate_hourly(rows: &[Value]) -> Result<()> {
    validate_interval(rows, "1h")
}

pub fn validate_interval(rows: &[Value], interval: &str) -> Result<()> {
    let step_ms = crate::chronos::interval_ms(interval)?;
    ensure!(!rows.is_empty(), "Empty {interval} data");
    let mut previous = None;
    for row in rows {
        ensure!(simulator::valid_candle(row), "Invalid OHLCV candle");
        ensure!(row["confirmed"] != false, "Unclosed input candle");
        let open =
            timestamp(&row["openTime"]).ok_or_else(|| anyhow::anyhow!("Missing candle time"))?;
        ensure!(open >= 0 && open % step_ms == 0, "Non-{interval} timestamp");
        ensure!(
            previous.is_none_or(|prior| open - prior == step_ms),
            "{interval} gap, duplicate or unsorted data"
        );
        previous = Some(open);
    }
    Ok(())
}

/// Only rows before `end` participate; end is an exclusive closed-prefix boundary.
pub fn base_features(rows: &[Value], end: usize) -> Result<Vec<f64>> {
    base_features_for_interval(rows, end, "1h")
}

pub fn base_features_for_interval(rows: &[Value], end: usize, interval: &str) -> Result<Vec<f64>> {
    let step_ms = crate::chronos::interval_ms(interval)?;
    ensure!(
        end >= CONTEXT && end <= rows.len(),
        "Need 256 closed-prefix observations"
    );
    let prefix = &rows[end - CONTEXT..end];
    validate_interval(prefix, interval)?;
    let close: Vec<f64> = prefix.iter().map(price).collect();
    let current = *close.last().unwrap();
    let mut output = Vec::with_capacity(BASE_FEATURE_NAMES.len());
    for lag in [1, 3, 6, 12, 24, 72, 168] {
        output.push(current / close[close.len() - 1 - lag] - 1.0);
    }
    let sma20 = mean(&close[close.len() - 20..]);
    let sma50 = mean(&close[close.len() - 50..]);
    let ema12 = ema(&close, 12);
    let ema26 = ema(&close, 26);
    output.extend([
        current / sma20 - 1.0,
        current / sma50 - 1.0,
        sma20 / sma50 - 1.0,
        current / ema12 - 1.0,
        current / ema26 - 1.0,
        ema12 / ema26 - 1.0,
    ]);
    let changes: Vec<f64> = close.windows(2).map(|w| w[1] - w[0]).collect();
    let recent = &changes[changes.len() - 14..];
    let gains = recent.iter().map(|x| x.max(0.0)).sum::<f64>();
    let losses = recent.iter().map(|x| (-x).max(0.0)).sum::<f64>();
    let rsi = if gains + losses == 0.0 {
        0.5
    } else {
        gains / (gains + losses)
    };
    output.extend([rsi, strategies::atr(prefix, 14) / current]);
    let returns: Vec<f64> = close.windows(2).map(|w| w[1] / w[0] - 1.0).collect();
    output.extend([
        std(&returns[returns.len() - 24..]),
        std(&returns[returns.len() - 72..]),
    ]);
    let last = prefix.last().unwrap();
    output.push((number(&last["high"], 0.0) - number(&last["low"], 0.0)) / current);
    let last24 = &prefix[prefix.len() - 24..];
    let high = last24
        .iter()
        .map(|r| number(&r["high"], 0.0))
        .fold(f64::NEG_INFINITY, f64::max);
    let low = last24
        .iter()
        .map(|r| number(&r["low"], 0.0))
        .fold(f64::INFINITY, f64::min);
    output.push(if high > low {
        (current - low) / (high - low)
    } else {
        0.5
    });
    let volume: Vec<f64> = last24.iter().map(|r| number(&r["volume"], 0.0)).collect();
    let volume_std = std(&volume);
    output.push(if volume_std > 0.0 {
        (volume[23] - mean(&volume)) / volume_std
    } else {
        0.0
    });
    let volume20 = mean(&volume[4..]);
    output.push(if volume20 > 0.0 {
        mean(&volume[19..]) / volume20 - 1.0
    } else {
        0.0
    });
    let origin = timestamp(&last["openTime"]).unwrap() + step_ms;
    let hour = if interval == "1h" {
        origin.div_euclid(HOUR).rem_euclid(24) as f64
    } else {
        origin.rem_euclid(24 * HOUR) as f64 / HOUR as f64
    };
    let weekday = (origin.div_euclid(86_400_000) + 3).rem_euclid(7) as f64;
    let tau = std::f64::consts::TAU;
    output.extend([
        (tau * hour / 24.0).sin(),
        (tau * hour / 24.0).cos(),
        (tau * weekday / 7.0).sin(),
        (tau * weekday / 7.0).cos(),
    ]);
    ensure!(
        output.len() == BASE_FEATURE_NAMES.len() && output.iter().all(|x| x.is_finite()),
        "Invalid derived features"
    );
    Ok(output)
}

pub fn chronos_features(forecast: &ForecastRecord) -> Result<Vec<f64>> {
    ensure!(
        forecast.quantile_crossings == 0 && forecast.horizon_steps()? == HORIZON,
        "Invalid Chronos horizon or crossing"
    );
    ensure!(
        forecast.q10.len() == HORIZON
            && forecast.q50.len() == HORIZON
            && forecast.q90.len() == HORIZON,
        "Missing forecast quantiles"
    );
    let last = forecast.current_price;
    let i = HORIZON - 1;
    let output = vec![
        forecast.q10[i] / last - 1.0,
        forecast.q50[i] / last - 1.0,
        forecast.q90[i] / last - 1.0,
        (forecast.q90[i] - forecast.q10[i]) / last,
        (forecast.q50[i] - forecast.q50[0]) / last,
        mean(&forecast.q50) / last - 1.0,
    ];
    ensure!(
        last > 0.0 && output.iter().all(|x| x.is_finite()),
        "Invalid Chronos features"
    );
    Ok(output)
}

pub fn label_threshold() -> f64 {
    let costs = research::costs();
    (2.0 * number(&costs["feeBps"], 6.0)
        + 2.0 * number(&costs["slippageBps"], 5.0)
        + number(&costs["fundingBpsPer8h"], 3.0) * HORIZON as f64 / 8.0
        + LABEL_EDGE_BUFFER_BPS)
        / 10_000.0
}

/// A supervised label needs twelve entirely closed future hours, unavailable to features.
pub fn label(rows: &[Value], end: usize) -> Option<usize> {
    if end == 0 || end + HORIZON > rows.len() {
        return None;
    }
    let change = price(&rows[end + HORIZON - 1]) / price(&rows[end - 1]) - 1.0;
    Some(if change > label_threshold() {
        2
    } else if change < -label_threshold() {
        0
    } else {
        1
    })
}

pub fn decide(probabilities: &[f64; 3]) -> &'static str {
    if probabilities
        .iter()
        .any(|x| !x.is_finite() || !(0.0..=1.0).contains(x))
        || (probabilities.iter().sum::<f64>() - 1.0).abs() > 1e-5
    {
        return "HOLD";
    }
    let mut ranked = [0, 1, 2];
    ranked.sort_by(|a, b| probabilities[*b].total_cmp(&probabilities[*a]));
    if ranked[0] == 1
        || probabilities[ranked[0]] < PROBABILITY_THRESHOLD
        || probabilities[ranked[0]] - probabilities[ranked[1]] < PROBABILITY_MARGIN
    {
        return "HOLD";
    }
    if ranked[0] == 2 { "BUY" } else { "SELL" }
}

pub fn probabilities_json(p: &[f64; 3]) -> Value {
    serde_json::json!({"SELL":p[0],"HOLD":p[1],"BUY":p[2]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn rows() -> Vec<Value> {
        (0..300)
            .map(|i| {
                let c = 100.0 + i as f64 * 0.1;
                json!({"openTime":i*HOUR,"open":c,"close":c,"high":c+1.0,"low":c-1.0,"volume":10.0})
            })
            .collect()
    }
    #[test]
    fn future_change_cannot_change_features_but_can_change_label() {
        let mut data = rows();
        let original = base_features(&data, 256).unwrap();
        let original_label = label(&data, 256);
        for row in &mut data[256..] {
            row["close"] = json!(70.0);
            row["open"] = json!(70.0);
            row["high"] = json!(71.0);
            row["low"] = json!(69.0);
        }
        assert_eq!(original, base_features(&data, 256).unwrap());
        assert_ne!(original_label, label(&data, 256));
    }
    #[test]
    fn policy_is_three_way_and_fails_closed() {
        assert_eq!(decide(&[0.1, 0.2, 0.7]), "BUY");
        assert_eq!(decide(&[0.7, 0.2, 0.1]), "SELL");
        assert_eq!(decide(&[0.2, 0.7, 0.1]), "HOLD");
        assert_eq!(decide(&[0.1, 0.45, 0.45]), "HOLD");
        assert_eq!(decide(&[f64::NAN, 0.0, 1.0]), "HOLD");
        assert_eq!(decide(&[0.2, 0.2, 0.2]), "HOLD");
    }
    #[test]
    fn missing_future_label_and_broken_candles_are_rejected() {
        let mut data = rows();
        assert!(label(&data, 290).is_none());
        data[200]["openTime"] = json!(199 * HOUR);
        assert!(base_features(&data, 256).is_err());
    }

    #[test]
    fn quarter_hour_features_are_causal_and_have_distinct_bar_schema() {
        let mut data = rows();
        for (index, row) in data.iter_mut().enumerate() {
            row["openTime"] = json!(index as i64 * crate::chronos::QUARTER_HOUR_MS);
        }
        let original = base_features_for_interval(&data, 257, "15m").unwrap();
        let current = number(&data[256]["close"], 0.);
        let prior = number(&data[255]["close"], 0.);
        assert_eq!(original[0], current / prior - 1.);
        let names = base_feature_names_for_interval("15m").unwrap();
        assert_eq!(names[0], "15m_return_1_bars");
        assert_eq!(names.len(), original.len());
        assert_ne!(names, base_feature_names_for_interval("1h").unwrap());
        let fractional_hour = (257 * crate::chronos::QUARTER_HOUR_MS) % (24 * HOUR);
        assert!(
            (original[21]
                - (std::f64::consts::TAU * fractional_hour as f64 / (24 * HOUR) as f64).sin())
            .abs()
                < 1e-12
        );
        assert!(base_features(&data, 257).is_err());
        for row in &mut data[257..] {
            row["close"] = json!(1e9);
        }
        assert_eq!(
            original,
            base_features_for_interval(&data, 257, "15m").unwrap()
        );
        data[100]["openTime"] = json!(99 * crate::chronos::QUARTER_HOUR_MS);
        assert!(base_features_for_interval(&data, 257, "15m").is_err());
    }
}
