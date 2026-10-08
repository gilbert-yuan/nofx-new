//! Native entry profiles, liquidity checks and score-based sizing.
use crate::{interval_ms, number, store::Store, strategies};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
pub fn env_num(key: &str, default: f64, min: f64, max: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite() && (min..=max).contains(n))
        .unwrap_or(default)
}
pub fn enabled(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| matches!(s.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(default)
}
pub async fn entry_filter(
    store: &Store,
    config: &Value,
    strategy: &Value,
) -> Result<Option<Value>> {
    let setting = &config["analysis"]["backtestFeatureFilters"];
    if setting["enabled"] == false {
        return Ok(None);
    }
    let deployed = store.dir.join("backtest/production-profiles.json");
    if setting["enabled"] != true && !deployed.exists() {
        return Ok(None);
    }
    let file = if setting["enabled"] == true {
        setting["file"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
    } else {
        Some(deployed)
    };
    let profiles = if let Some(file) = file {
        let file = if file.is_absolute() {
            file
        } else {
            store.dir.parent().unwrap_or(&store.dir).join(file)
        };
        let data: Value = serde_json::from_str(&tokio::fs::read_to_string(file).await?)?;
        data["strategies"].clone()
    } else {
        setting["profiles"].clone()
    };
    let mut p = profiles[strategy["id"].as_str().context("策略 ID 缺失")?].clone();
    if p["enabled"] != true {
        return Ok(None);
    }
    if p["params"]
        .as_object()
        .is_some_and(|m| m.iter().any(|(k, v)| strategy["params"][k] != *v))
    {
        return Ok(None);
    }
    let f = &p["featureConfig"];
    let interval = f["interval"].as_str().context("筛选配置周期无效")?;
    let count = f["lookbackBars"].as_u64().context("筛选配置窗口无效")?;
    if interval_ms(interval).is_none()
        || !(interval.ends_with('m') || interval.ends_with('h') || interval.ends_with('d'))
        || !(2..=1000).contains(&count)
    {
        bail!("回测筛选配置的周期或窗口无效");
    }
    p["rules"].as_array().context("筛选规则必须为数组")?;
    if p["missing"].is_null() {
        p["missing"] = json!("reject");
    }
    strategies::match_feature_rules(
        &json!({}),
        &p["rules"],
        p["missing"].as_str().unwrap_or("reject"),
    )?;
    Ok(Some(p))
}
fn optional(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
pub fn score_size(signal: &Value, open_count: usize) -> Option<(f64, f64)> {
    if open_count as f64 >= env_num("NOFX_MAX_POSITIONS", 10., 1., 100.) {
        return None;
    }
    let p = &signal["plan"];
    let score = [
        &p["trendStrengthScore"],
        &p["signalScore"],
        &signal["score"],
        &signal["entryQuality"],
        &signal["confidence"],
    ]
    .into_iter()
    .find_map(optional)
    .map(|v| if v > 1. { v } else { v * 100. });
    let min_lev = env_num("NOFX_SIZE_MIN_LEV", 1., 1., 50.);
    let max_lev = env_num("NOFX_SIZE_MAX_LEV", 5., 1., 50.).max(min_lev);
    let min_margin = env_num("NOFX_SIZE_MIN_MARGIN_PCT", 0.02, 0.001, 1.);
    let max_margin = env_num("NOFX_SIZE_MAX_MARGIN_PCT", 0.08, 0.001, 1.);
    let (mut leverage, mut margin) = if let Some(score) = score {
        let floor = env_num("NOFX_SIZE_SCORE_FLOOR", 40., 0., 100.);
        let ceil = env_num("NOFX_SIZE_SCORE_CEIL", 90., 1., 100.);
        let t = ((score - floor) / (ceil - floor).max(1e-9)).clamp(0., 1.);
        (
            (min_lev + t * (max_lev - min_lev))
                .round()
                .clamp(min_lev, max_lev),
            min_margin + t * (max_margin - min_margin),
        )
    } else {
        (
            env_num("NOFX_SIZE_BASE_LEV", 2., 1., 50.).floor(),
            env_num("NOFX_SIZE_BASE_MARGIN_PCT", 0.05, 0.001, 1.),
        )
    };
    let entry = optional(&p["entryLimit"]).or_else(|| optional(&p["entry"]));
    if let Some((entry, stop)) = entry.zip(optional(&p["stopLoss"]))
        && entry > 0.
        && stop > 0.
    {
        let distance = (entry - stop).abs() / entry;
        let max_loss = env_num("NOFX_MAX_LOSS_PCT", 0.02, 0.001, 0.2);
        while margin * leverage * distance > max_loss && leverage > 1. {
            leverage -= 1.;
        }
        if margin * leverage * distance > max_loss {
            margin = max_loss / (leverage * distance);
        }
        if margin < min_margin / 4. {
            return None;
        }
    }
    Some((leverage, margin))
}
/// Fit the minimum margin by reducing leverage, without increasing capped exposure.
pub fn entry_size(
    equity: f64,
    margin_pct: f64,
    leverage: f64,
    min_margin: f64,
    notional_pct: f64,
    available: Option<f64>,
    minimum_notional: f64,
) -> Option<(f64, f64)> {
    if ![equity, margin_pct, leverage, min_margin, minimum_notional]
        .into_iter()
        .all(f64::is_finite)
        || equity <= 0.
        || margin_pct <= 0.
        || leverage < 1.
        || min_margin < 0.
        || minimum_notional < 0.
        || available.is_some_and(|v| !v.is_finite() || v <= 0.)
    {
        return None;
    }
    let mut leverage = leverage.floor();
    let required_margin = (minimum_notional / leverage * 100.).ceil() / 100.;
    let mut notional = (equity * margin_pct).max(min_margin).max(required_margin) * leverage;
    if notional_pct > 0. && notional_pct <= 1. {
        notional = notional.min(equity * notional_pct);
    }
    if !notional.is_finite() || notional < minimum_notional {
        return None;
    }
    loop {
        let mut margin = notional / leverage;
        if let Some(available) = available {
            margin = margin.min(available / (1. + leverage * 12. / 10000.));
        }
        margin = (margin * 100.).floor() / 100.;
        if margin >= min_margin.max(1.) && margin * leverage >= minimum_notional {
            return Some((leverage, margin));
        }
        if leverage <= 1. {
            return None;
        }
        leverage -= 1.;
    }
}
pub fn screen(ticker: &Value, market: Option<&Value>) -> bool {
    let volume = optional(&ticker["quoteVolume"]);
    if volume.is_none_or(|v| v < env_num("NOFX_MIN_QUOTE_VOL_24H", 5_000_000., 0., 1e12)) {
        return false;
    }
    if let Some(m) = market
        && let Some(rows) = m["klines"].as_array()
        && rows.len() >= 15
    {
        let atr = rows[rows.len() - 15..]
            .windows(2)
            .map(|pair| {
                let high = number(&pair[1]["high"], f64::NAN);
                let low = number(&pair[1]["low"], f64::NAN);
                let previous = number(&pair[0]["close"], f64::NAN);
                (high - low)
                    .max((high - previous).abs())
                    .max((low - previous).abs())
            })
            .sum::<f64>()
            / 14.;
        let close = number(&rows.last().unwrap()["close"], 0.);
        let ratio = atr / close;
        if !ratio.is_finite()
            || ratio < env_num("NOFX_SCREEN_MIN_ATR_PCT", 0.002, 0., 1.)
            || ratio > env_num("NOFX_SCREEN_MAX_ATR_PCT", 0.08, 0.001, 2.)
        {
            return false;
        }
    }
    if let (Some(bid), Some(ask)) = (optional(&ticker["bidPrice"]), optional(&ticker["askPrice"]))
        && bid > 0.
        && ask >= bid
        && (ask - bid) / ((ask + bid) / 2.) * 10000. > env_num("NOFX_MAX_SPREAD_BPS", 8., 0.1, 200.)
    {
        return false;
    }
    true
}
fn depth(rows: &Value, count: usize) -> Option<f64> {
    let rows = rows.as_array()?;
    if rows.is_empty() {
        return None;
    }
    rows.iter().take(count).try_fold(0., |sum, r| {
        let price = optional(r.get(0).unwrap_or(&r["price"]))?;
        let qty = optional(r.get(1).unwrap_or(&r["qty"]))?;
        if price <= 0. || qty <= 0. {
            None
        } else {
            Some(sum + price * qty)
        }
    })
}
pub fn book_check(book: &Value, order_book: &Value, notional: f64) -> Result<()> {
    let bid = optional(&book["bidPrice"]).context("缺少买价")?;
    let ask = optional(&book["askPrice"]).context("缺少卖价")?;
    if bid <= 0. || ask < bid {
        bail!("买卖价格无效");
    }
    let spread = (ask - bid) / ((ask + bid) / 2.) * 10000.;
    let maximum = env_num("NOFX_MAX_SPREAD_BPS", 8., 0.1, 200.);
    if spread > maximum {
        bail!("盘口价差 {spread:.2}bps 超过 {maximum}");
    }
    let levels = env_num("NOFX_BOOK_LEVELS", 5., 1., 50.) as usize;
    let bid_depth = depth(&order_book["bids"], levels).context("缺少买盘深度")?;
    let ask_depth = depth(&order_book["asks"], levels).context("缺少卖盘深度")?;
    let min = env_num("NOFX_MIN_BOOK_NOTIONAL", 200., 0., 1e9);
    if bid_depth < min || ask_depth < min {
        bail!("盘口深度低于最低名义 {min}");
    }
    if !notional.is_finite()
        || notional < env_num("NOFX_MIN_EXCHANGE_NOTIONAL", 5., 0., 1000.)
        || notional > bid_depth.min(ask_depth)
    {
        bail!("下单名义低于最低成交额或超过可成交深度");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimum_margin_reduces_leverage_without_raising_exposure() {
        for requested in [3., 5.] {
            let (leverage, margin) = entry_size(53.77, 0.06, requested, 5., 0.25, Some(50.), 0.)
                .expect("lower leverage fits the same notional cap");
            assert_eq!(leverage, 2.);
            assert!(margin >= 5.);
            assert!(margin * leverage <= 53.77 * 0.25);
            assert!(margin * (1. + leverage * 12. / 10000.) <= 50.);
        }
        assert_eq!(
            entry_size(100., 0.06, 3., 5., 0.25, Some(50.), 0.),
            Some((3., 6.))
        );
    }
    #[test]
    fn minimum_margin_still_rejects_insufficient_equity_or_cash() {
        assert_eq!(entry_size(18., 0.06, 5., 5., 0.25, Some(50.), 0.), None);
        assert_eq!(entry_size(53.77, 0.06, 5., 5., 0.25, Some(4.99), 0.), None);
        let (leverage, margin) = entry_size(53.77, 0.06, 5., 5., 0.25, Some(5.01), 0.).unwrap();
        assert_eq!((leverage, margin), (1., 5.));
        assert!(margin * (1. + leverage * 12. / 10000.) <= 5.01);
        assert_eq!(
            entry_size(f64::NAN, 0.06, 5., 5., 0.25, Some(50.), 0.),
            None
        );
    }
    #[test]
    fn sizing_covers_exchange_rounding_and_rejects_minimum_above_risk_cap() {
        let info = json!({"filters":[
            {"filterType":"LOT_SIZE","stepSize":"1","minQty":"1","maxQty":"100000"},
            {"filterType":"MIN_NOTIONAL","notional":"5"}
        ]});
        let price = 0.1234;
        let too_small = crate::paper::aligned_quantity(&info, 5. / price, true).unwrap();
        assert!(too_small * price < 5.);
        let minimum = crate::paper::minimum_entry_notional(&info, price, true).unwrap();
        let (leverage, margin) = entry_size(53.77, 0.06, 1., 5., 0.25, Some(50.), minimum).unwrap();
        let quantity =
            crate::paper::aligned_quantity(&info, margin * leverage / price, true).unwrap();
        assert!(quantity * price >= 5.);
        assert!(margin * leverage <= 53.77 * 0.25);
        assert_eq!(entry_size(53.77, 0.06, 5., 5., 0.25, Some(50.), 20.), None);
        assert!(crate::paper::minimum_entry_notional(&info, f64::NAN, true).is_err());
    }
    #[test]
    fn missing_book_and_excessive_size_fail_closed() {
        let book = json!({"bidPrice":100,"askPrice":100.01});
        let depth = json!({"bids":[[100,10]],"asks":[[100.01,10]]});
        assert!(book_check(&book, &depth, 100.).is_ok());
        assert!(book_check(&book, &depth, 2000.).is_err());
        assert!(book_check(&book, &json!({}), 100.).is_err());
        assert!(!screen(&json!({}), None));
    }
}
