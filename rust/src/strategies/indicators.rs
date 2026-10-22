use super::n;
use serde_json::Value;
pub fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        f64::NAN
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}
pub fn ema(values: &[f64], period: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; values.len()];
    if period == 0 || values.len() < period {
        return out;
    }
    let mut prev = mean(&values[..period]);
    out[period - 1] = prev;
    let k = 2. / (period + 1) as f64;
    for i in period..values.len() {
        prev = values[i] * k + prev * (1. - k);
        out[i] = prev;
    }
    out
}
pub fn closes(r: &[Value]) -> Vec<f64> {
    r.iter().map(|x| n(x, "close")).collect()
}
pub fn true_ranges(r: &[Value]) -> Vec<f64> {
    r.iter()
        .enumerate()
        .map(|(i, x)| {
            let range = n(x, "high") - n(x, "low");
            if i == 0 {
                range
            } else {
                range
                    .max((n(x, "high") - n(&r[i - 1], "close")).abs())
                    .max((n(x, "low") - n(&r[i - 1], "close")).abs())
            }
        })
        .collect()
}
pub fn atr(r: &[Value], period: usize) -> f64 {
    if r.len() <= period || period == 0 {
        return f64::NAN;
    }
    mean(&true_ranges(r)[r.len() - period..])
}
pub fn finite_candle(r: &Value) -> bool {
    ["open", "high", "low", "close"].iter().all(|k| {
        r[k].as_f64()
            .map(|v| v.is_finite() && v > 0.)
            .unwrap_or(false)
    }) && n(r, "low") <= n(r, "open").min(n(r, "close"))
        && n(r, "high") >= n(r, "open").max(n(r, "close"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atr_and_ema_handle_short_and_invalid_windows() {
        let rows: Vec<Value> = (0..30)
            .map(|i| {
                let p = 100. + i as f64;
                serde_json::json!({"high": p + 1., "low": p - 1., "close": p})
            })
            .collect();
        assert!(atr(&rows, 0).is_nan());
        assert!(atr(&rows[..10], 14).is_nan());
        assert!(atr(&rows, 14) > 0.);
        let series = ema(&closes(&rows), 5);
        assert!(series[..4].iter().all(|v| v.is_nan()));
        assert!(series[4].is_finite());
        assert!(ema(&closes(&rows), 0).iter().all(|v| v.is_nan()));
    }
    #[test]
    fn finite_candle_rejects_non_positive_or_inverted_bars() {
        assert!(finite_candle(
            &serde_json::json!({"open":10.,"high":11.,"low":9.,"close":10.5})
        ));
        assert!(!finite_candle(
            &serde_json::json!({"open":10.,"high":9.,"low":9.,"close":10.5})
        ));
        assert!(!finite_candle(
            &serde_json::json!({"open":0.,"high":11.,"low":9.,"close":10.5})
        ));
        assert!(!finite_candle(
            &serde_json::json!({"open":10.,"high":11.,"low":12.,"close":10.5})
        ));
    }
}
