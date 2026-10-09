use super::n;
use serde_json::{Value, json};
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
pub fn ema_first(values: &[f64], period: usize) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let k = 2. / (period + 1) as f64;
    values[1..]
        .iter()
        .fold(values[0], |e, x| x * k + e * (1. - k))
}
pub fn last(xs: &[f64]) -> f64 {
    xs.last().copied().unwrap_or(f64::NAN)
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
pub fn atr_series(r: &[Value], period: usize) -> Vec<f64> {
    let tr = true_ranges(r);
    (0..r.len())
        .map(|i| {
            if i < period {
                f64::NAN
            } else {
                mean(&tr[i - period + 1..=i])
            }
        })
        .collect()
}
pub fn rsi(v: &[f64], period: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; v.len()];
    if period == 0 || v.len() <= period {
        return out;
    }
    let mut gain = 0.;
    let mut loss = 0.;
    for i in 1..=period {
        let d = v[i] - v[i - 1];
        gain += d.max(0.);
        loss += (-d).max(0.);
    }
    gain /= period as f64;
    loss /= period as f64;
    out[period] = if loss == 0. {
        100.
    } else {
        100. - 100. / (1. + gain / loss)
    };
    for i in period + 1..v.len() {
        let d = v[i] - v[i - 1];
        gain = (gain * (period - 1) as f64 + d.max(0.)) / period as f64;
        loss = (loss * (period - 1) as f64 + (-d).max(0.)) / period as f64;
        out[i] = if loss == 0. {
            100.
        } else {
            100. - 100. / (1. + gain / loss)
        };
    }
    out
}
pub fn rsi_simple(v: &[f64], p: usize) -> f64 {
    if v.len() <= p {
        return f64::NAN;
    }
    let mut gain = 0.;
    let mut loss = 0.;
    for i in v.len() - p..v.len() {
        let d = v[i] - v[i - 1];
        gain += d.max(0.);
        loss += (-d).max(0.);
    }
    if loss == 0. {
        100.
    } else {
        100. - 100. / (1. + gain / loss)
    }
}
pub fn macd(v: &[f64], fast: usize, slow: usize, signal: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let ef = ema(v, fast);
    let es = ema(v, slow);
    let line: Vec<f64> = ef.iter().zip(es.iter()).map(|(a, b)| a - b).collect();
    let valid: Vec<f64> = line.iter().copied().filter(|x| x.is_finite()).collect();
    let sig = ema(&valid, signal);
    let mut cursor = 0;
    let aligned: Vec<f64> = line
        .iter()
        .map(|x| {
            if x.is_finite() {
                let r = sig[cursor];
                cursor += 1;
                r
            } else {
                f64::NAN
            }
        })
        .collect();
    let hist = line
        .iter()
        .zip(aligned.iter())
        .map(|(a, b)| a - b)
        .collect();
    (line, aligned, hist)
}
// Use the same SMA-seeded EMA history as the shared MACD implementation.
pub fn enhanced_macd(v: &[f64], fast: usize, slow: usize, signal: usize) -> (f64, f64, f64) {
    if fast == 0 || signal == 0 || fast >= slow || v.len() < slow {
        return (f64::NAN, f64::NAN, f64::NAN);
    }
    let (line, signal, histogram) = macd(v, fast, slow, signal);
    (last(&line), last(&signal), last(&histogram))
}
pub fn adx(r: &[Value], p: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let tr = true_ranges(r);
    let mut plus = vec![0.; r.len()];
    let mut minus = plus.clone();
    for i in 1..r.len() {
        let up = n(&r[i], "high") - n(&r[i - 1], "high");
        let down = n(&r[i - 1], "low") - n(&r[i], "low");
        if up > down && up > 0. {
            plus[i] = up;
        }
        if down > up && down > 0. {
            minus[i] = down;
        }
    }
    let a = ema(&tr, p);
    let ep = ema(&plus, p);
    let em = ema(&minus, p);
    let pd: Vec<f64> = a
        .iter()
        .zip(ep.iter())
        .map(|(a, x)| if *a != 0. { 100. * x / a } else { f64::NAN })
        .collect();
    let md: Vec<f64> = a
        .iter()
        .zip(em.iter())
        .map(|(a, x)| if *a != 0. { 100. * x / a } else { f64::NAN })
        .collect();
    let dx: Vec<f64> = pd
        .iter()
        .zip(md.iter())
        .map(|(a, b)| 100. * (a - b).abs() / if a + b == 0. { 1. } else { a + b })
        .collect();
    let good: Vec<f64> = dx.iter().copied().filter(|x| x.is_finite()).collect();
    let smooth = ema(&good, p);
    let mut i = 0;
    let ax = dx
        .iter()
        .map(|x| {
            if x.is_finite() {
                let v = smooth[i];
                i += 1;
                v
            } else {
                f64::NAN
            }
        })
        .collect();
    (ax, pd, md)
}
pub fn finite_candle(r: &Value) -> bool {
    ["open", "high", "low", "close"].iter().all(|k| {
        r[k].as_f64()
            .map(|v| v.is_finite() && v > 0.)
            .unwrap_or(false)
    }) && n(r, "low") <= n(r, "open").min(n(r, "close"))
        && n(r, "high") >= n(r, "open").max(n(r, "close"))
}
pub fn skill_summary(r: &[Value]) -> Value {
    let c = closes(r);
    let volume: Vec<f64> = r.iter().map(|x| n(x, "volume")).collect();
    let e20 = ema(&c, 20);
    let e50 = ema(&c, 50);
    let e200 = ema(&c, 200);
    let a = ema(&true_ranges(r), 14);
    let av: Vec<f64> = a.iter().copied().filter(|x| x.is_finite()).collect();
    let window = &av[av.len().saturating_sub(200)..];
    let current = last(&a);
    let percentile = if window.is_empty() {
        0.
    } else {
        window.iter().filter(|x| **x <= current).count() as f64 / window.len() as f64
    };
    let m = macd(&c, 12, 26, 9);
    let d = adx(r, 14);
    let volmean = mean(&volume[volume.len().saturating_sub(20)..]);
    let zwin = &volume[volume.len().saturating_sub(100)..];
    let zm = mean(zwin);
    let std = (zwin.iter().map(|v| (v - zm).powi(2)).sum::<f64>() / zwin.len() as f64).sqrt();
    let slope = |e: &[f64]| {
        last(e)
            - e.get(e.len().saturating_sub(6))
                .copied()
                .unwrap_or(f64::NAN)
    };
    json!({"price":last(&c),"ema20":last(&e20),"ema50":last(&e50),"ema200":last(&e200),"ema20Slope":slope(&e20),"ema50Slope":slope(&e50),"atr":current,"atrPercentile":percentile,"atrPct":percentile,"rsi":last(&rsi(&c,14)),"macd":last(&m.0),"macdSignal":last(&m.1),"macdHistogram":last(&m.2),"adx":last(&d.0),"plusDI":last(&d.1),"minusDI":last(&d.2),"volumeRatio":if volmean!=0.{last(&volume)/volmean}else{f64::NAN},"volumeZ":if std>0.{(last(&volume)-zm)/std}else{0.}})
}
pub fn pivots(r: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let mut h = vec![];
    let mut l = vec![];
    if r.len() < 7 {
        return (h, l);
    }
    for i in 3..r.len() - 3 {
        let hi = n(&r[i], "high");
        let lo = n(&r[i], "low");
        if (i - 3..=i + 3).all(|j| j == i || n(&r[j], "high") < hi) {
            h.push(json!({"index":i,"price":hi,"time":r[i]["openTime"]}));
        }
        if (i - 3..=i + 3).all(|j| j == i || n(&r[j], "low") > lo) {
            l.push(json!({"index":i,"price":lo,"time":r[i]["openTime"]}));
        }
    }
    (h, l)
}
pub fn skill_structure(r: &[Value]) -> Value {
    let (h, l) = pivots(r);
    let hp = if h.len() < 2 {
        "NA"
    } else if n(h.last().unwrap(), "price") < n(&h[h.len() - 2], "price") {
        "LH"
    } else {
        "HH"
    };
    let lp = if l.len() < 2 {
        "NA"
    } else if n(l.last().unwrap(), "price") < n(&l[l.len() - 2], "price") {
        "LL"
    } else {
        "HL"
    };
    let close = r.last().map(|x| n(x, "close")).unwrap_or(f64::NAN);
    let resistance = h.last().map(|x| n(x, "price"));
    let support = l.last().map(|x| n(x, "price"));
    let bull = resistance.map(|x| close > x).unwrap_or(false);
    let bear = support.map(|x| close < x).unwrap_or(false);
    let recent = &r[r.len().saturating_sub(8)..];
    json!({"trend":if hp=="LH"&&lp=="LL"{"BEARISH"}else if hp=="HH"&&lp=="HL"{"BULLISH"}else{"NEUTRAL"},"highPattern":hp,"lowPattern":lp,"bosBullish":bull,"bosBearish":bear,"chochBullish":bull&&lp=="HL","chochBearish":bear&&hp=="LH","failedBreakout":h.len()>=2&&recent.iter().any(|x|n(x,"high")>n(&h[h.len()-2],"price")&&n(x,"close")<n(&h[h.len()-2],"price")),"failedBreakdown":l.len()>=2&&recent.iter().any(|x|n(x,"low")<n(&l[l.len()-2],"price")&&n(x,"close")>n(&l[l.len()-2],"price")),"resistance":resistance,"support":support,"highs":h,"lows":l})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enhanced_macd_uses_every_fast_ema_update() {
        // On a linear series SMA-seeded EMA(2) - EMA(5) is exactly +/-1.5.
        // Skipping the fast EMA updates between the two seeds creates false momentum.
        for direction in [1., -1.] {
            let values: Vec<f64> = (0..8).map(|i| 100. + direction * i as f64).collect();
            let (line, signal, histogram) = enhanced_macd(&values, 2, 5, 2);
            assert!((line - direction * 1.5).abs() < 1e-12, "{line}");
            assert!((signal - direction * 1.5).abs() < 1e-12, "{signal}");
            assert!(histogram.abs() < 1e-12, "{histogram}");
        }
    }

    #[test]
    fn enhanced_macd_rejects_invalid_periods_and_waits_for_signal_seed() {
        let values = [100.; 8];
        for (fast, slow, signal) in [(0, 5, 2), (2, 0, 2), (5, 2, 2), (2, 5, 0)] {
            let result = enhanced_macd(&values, fast, slow, signal);
            assert!(result.0.is_nan() && result.1.is_nan() && result.2.is_nan());
        }
        let result = enhanced_macd(&values[..5], 2, 5, 2);
        assert_eq!(result.0, 0.);
        assert!(result.1.is_nan() && result.2.is_nan());
    }
}
