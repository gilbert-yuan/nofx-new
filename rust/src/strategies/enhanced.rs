use super::indicators::{atr, closes, ema_first, enhanced_macd, mean, rsi_simple};
use super::{
    b, defaults, exit_rules, exit_rules_for, local_review_with_atr, n, plan_risk_unit, rows,
};
use crate::number;
use serde_json::{Map, Value, json};
fn period(p: &Value, key: &str) -> usize {
    n(p, key).max(1.).floor() as usize
}
fn average_tail(v: &[f64], p: usize) -> f64 {
    mean(&v[v.len().saturating_sub(p)..])
}
fn volume(r: &[Value], p: &Value) -> f64 {
    let recent = period(p, "volumeRecentPeriod");
    let look = period(p, "volumeLookbackPeriod");
    if recent >= look || r.len() < look {
        return f64::NAN;
    }
    let sum = |rs: &[Value]| rs.iter().map(|r| n(r, "volume")).sum::<f64>() / rs.len() as f64;
    sum(&r[r.len() - recent..]) / sum(&r[r.len() - look..r.len() - recent])
}
fn bollinger(c: &[f64], p: &Value) -> Value {
    let k = period(p, "bollingerPeriod");
    if c.len() < k {
        return Value::Null;
    }
    let win = &c[c.len() - k..];
    let m = mean(win);
    let std = (win.iter().map(|x| (x - m).powi(2)).sum::<f64>() / k as f64).sqrt();
    let width = n(p, "bollingerStdDev") * std;
    json!({"upper":m+width,"middle":m,"lower":m-width,"bandwidth":2.*width/m})
}
fn support_resistance(r: &[Value], p: &Value) -> (f64, f64) {
    let rp = period(p, "supportRecentPeriod");
    let lp = period(p, "supportLookbackPeriod");
    let tail = &r[r.len().saturating_sub(rp)..];
    let high = tail
        .iter()
        .map(|r| n(r, "high"))
        .fold(f64::NEG_INFINITY, f64::max);
    let low = tail
        .iter()
        .map(|r| n(r, "low"))
        .fold(f64::INFINITY, f64::min);
    if r.len() < lp || high == low {
        return (low, high);
    }
    let bin_size = (high - low) / 20.;
    let mut bins: Vec<(i64, usize)> = vec![];
    for row in &r[r.len() - lp..] {
        let bin = ((n(row, "high") - low) / bin_size).floor() as i64;
        if let Some(pair) = bins.iter_mut().find(|b| b.0 == bin) {
            pair.1 += 1;
        } else {
            bins.push((bin, 1));
        }
    }
    bins.sort_by(|a, b| match (a.0 >= 0, b.0 >= 0) {
        (true, true) => a.0.cmp(&b.0),
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    });
    bins.retain(|b| b.1 >= 3);
    bins.sort_by_key(|a| std::cmp::Reverse(a.1));
    let levels: Vec<f64> = bins
        .iter()
        .map(|(bin, _)| low + (*bin as f64 + 0.5) * bin_size)
        .collect();
    let price = n(r.last().unwrap(), "close");
    (
        levels
            .iter()
            .rev()
            .copied()
            .find(|x| *x < price)
            .unwrap_or(low),
        levels.into_iter().find(|x| *x > price).unwrap_or(high),
    )
}
fn strength(r: &[Value], p: &Value) -> Value {
    let c = closes(r);
    let close = *c.last().unwrap();
    let fast = average_tail(&c, period(p, "maFastPeriod"));
    let slow = average_tail(&c, period(p, "maSlowPeriod"));
    let mut score = 0.;
    let mut reasons: Vec<String> = vec![];
    if fast > slow && close > fast {
        score += 20.;
        reasons.push("多头均线排列完美".into());
    } else if fast < slow && close < fast {
        score += 20.;
        reasons.push("空头均线排列完美".into());
    } else if (fast - slow).abs() < slow * 0.005 {
        reasons.push("均线纠缠，趋势不明".into());
    } else {
        score += 8.;
        reasons.push("均线排列一般".into());
    }
    let macd = enhanced_macd(
        &c,
        period(p, "macdFastPeriod"),
        period(p, "macdSlowPeriod"),
        period(p, "macdSignalPeriod"),
    );
    if macd.0.is_finite() {
        if macd.2.abs() > (c[c.len().saturating_sub(10)] - close).abs() * 0.002 {
            if (macd.2 > 0. && macd.0 > macd.1) || (macd.2 < 0. && macd.0 < macd.1) {
                score += 15.;
                reasons.push(
                    if macd.2 > 0. {
                        "MACD金叉且柱状图扩大"
                    } else {
                        "MACD死叉且柱状图扩大"
                    }
                    .into(),
                );
            } else {
                score += 8.;
                reasons.push("MACD信号中等".into());
            }
        } else {
            score += 5.;
            reasons.push("MACD信号较弱".into());
        }
    }
    let rs = rsi_simple(&c, period(p, "rsiPeriod"));
    if rs.is_finite() {
        let text = if rs > 50. && rs < 70. {
            score += 12.;
            "RSI健康多头区"
        } else if rs < 50. && rs > 30. {
            score += 12.;
            "RSI健康空头区"
        } else if rs >= 70. {
            score += 5.;
            "RSI超买"
        } else if rs <= 30. {
            score += 5.;
            "RSI超卖"
        } else {
            score += 8.;
            "RSI中性"
        };
        reasons.push(format!("{text}({rs:.1})"));
    }
    let bb = bollinger(&c, p);
    if !bb.is_null() {
        let pos = (close - n(&bb, "lower")) / (n(&bb, "upper") - n(&bb, "lower"));
        let text = if pos > 0.3 && pos < 0.7 {
            score += 10.;
            "价格在布林带中轨"
        } else if pos > 0.8 {
            score += 6.;
            "价格接近布林带上轨"
        } else if pos < 0.2 {
            score += 6.;
            "价格接近布林带下轨"
        } else {
            score += 8.;
            "价格在布林带正常区域"
        };
        reasons.push(text.into());
    }
    let vr = volume(r, p);
    if vr.is_finite() {
        let text = if vr > 1.8 {
            score += 13.;
            format!("成交量大幅放大({vr:.2}倍)")
        } else if vr > 1.5 {
            score += 9.;
            format!("成交量温和放大({vr:.2}倍)")
        } else if vr >= 0.7 {
            score += 7.;
            "成交量平稳".into()
        } else {
            score += 3.;
            "成交量萎缩".into()
        };
        reasons.push(text);
    }
    let tenkan = period(p, "ichimokuTenkanPeriod");
    let kijun = period(p, "ichimokuKijunPeriod");
    let span = period(p, "ichimokuSpanPeriod");
    let mid = |k: usize| {
        let w = &r[r.len() - k..];
        (w.iter()
            .map(|r| n(r, "high"))
            .fold(f64::NEG_INFINITY, f64::max)
            + w.iter().map(|r| n(r, "low")).fold(f64::INFINITY, f64::min))
            / 2.
    };
    if r.len() >= tenkan.max(kijun).max(span) {
        let t = mid(tenkan);
        let k = mid(kijun);
        let sa = (t + k) / 2.;
        let sb = mid(span);
        let (strength, signal) = if close > sa.max(sb) {
            (30. + if t > k { 20. } else { 0. }, "BULLISH")
        } else if close < sa.min(sb) {
            (30. + if t < k { 20. } else { 0. }, "BEARISH")
        } else {
            (0., "NEUTRAL")
        };
        score += strength / 7.;
        reasons.push(format!("Ichimoku{signal}({strength}/70)"));
    }
    let dp = period(p, "dmiPeriod");
    if r.len() > dp {
        let mut plus = 0.;
        let mut minus = 0.;
        let mut tr = 0.;
        for i in r.len() - dp..r.len() {
            let up = n(&r[i], "high") - n(&r[i - 1], "high");
            let down = n(&r[i - 1], "low") - n(&r[i], "low");
            if up > 0. && up > down {
                plus += up;
            }
            if down > 0. && down > up {
                minus += down;
            }
            tr += (n(&r[i], "high") - n(&r[i], "low"))
                .max((n(&r[i], "high") - n(&r[i - 1], "close")).abs())
                .max((n(&r[i], "low") - n(&r[i - 1], "close")).abs());
        }
        let pd = plus / tr * 100.;
        let md = minus / tr * 100.;
        let ax = (pd - md).abs() / (pd + md) * 100.;
        if ax > 25. {
            score += 8.;
            reasons.push(format!("ADX强趋势({ax:.1})"));
        } else if ax > 20. {
            score += 5.;
            reasons.push(format!("ADX中等趋势({ax:.1})"));
        } else {
            score += 2.;
            reasons.push(format!("ADX弱趋势({ax:.1})"));
        }
    }
    let sp = period(p, "supertrendPeriod");
    if r.len() >= sp {
        let mut a = 0.;
        for i in r.len() - sp + 1..r.len() {
            let prev = n(&r[i - 1], "close");
            a += (n(&r[i], "high") - n(&r[i], "low"))
                .max((n(&r[i], "high") - prev).abs())
                .max((n(&r[i], "low") - prev).abs());
        }
        a /= sp as f64;
        let row = r.last().unwrap();
        let mid = (n(row, "high") + n(row, "low")) / 2.;
        let trend = if close > mid - n(p, "supertrendMultiplier") * a {
            "BULLISH"
        } else if close < mid + n(p, "supertrendMultiplier") * a {
            "BEARISH"
        } else {
            "NEUTRAL"
        };
        score += if trend == "NEUTRAL" { 3. } else { 7. };
        reasons.push(format!("Supertrend{trend}"));
    }
    if r.len() >= 2 {
        let op = period(p, "obvPeriod");
        let mut obvs = vec![];
        let mut ov = 0.;
        for i in 1..r.len().min(op) {
            let index = r.len() as isize - op as isize + i as isize;
            if index < 1 {
                continue;
            }
            let j = index as usize;
            if c[j] > c[j - 1] {
                ov += n(&r[j], "volume");
            } else if c[j] < c[j - 1] {
                ov -= n(&r[j], "volume");
            }
            obvs.push(ov);
        }
        if obvs.len() > 10 {
            score += 5.;
            reasons.push(
                if obvs.last() > obvs.first() {
                    "OBVRISING"
                } else {
                    "OBVFALLING"
                }
                .into(),
            );
        } else {
            score += 2.;
            reasons.push("OBV中性".into());
        }
    }
    json!({"score":score,"reasons":reasons,"maxScore":100})
}
pub fn analyze(m: &Value, ctx: &Value) -> Value {
    let p = &ctx["params"];
    let r = rows(m);
    let symbol = &m["symbol"];
    let hold = |reason: String, trend: Value| json!({"symbol":symbol,"action":"WAIT","confidence":0,"reason":reason,"risk":"市场条件不满足开仓要求。","plan":null,"trendScore":trend});
    let mut need = 50;
    for key in [
        "maSlowPeriod",
        "maFastPeriod",
        "bollingerPeriod",
        "volumeLookbackPeriod",
        "supportLookbackPeriod",
        "ichimokuTenkanPeriod",
        "ichimokuKijunPeriod",
        "ichimokuSpanPeriod",
        "obvPeriod",
    ] {
        need = need.max(period(p, key));
    }
    for key in ["atrPeriod", "rsiPeriod", "dmiPeriod", "supertrendPeriod"] {
        need = need.max(period(p, key) + 1);
    }
    need = need.max(period(p, "macdSlowPeriod") + period(p, "macdSignalPeriod") - 1);
    if r.len() < need {
        return hold("需要至少50根K线数据，当前数据不足。".into(), Value::Null);
    }
    let c = closes(&r);
    let close = *c.last().unwrap();
    let fast = average_tail(&c, period(p, "maFastPeriod"));
    let slow = average_tail(&c, period(p, "maSlowPeriod"));
    let a = atr(&r, period(p, "atrPeriod"));
    let macd = enhanced_macd(
        &c,
        period(p, "macdFastPeriod"),
        period(p, "macdSlowPeriod"),
        period(p, "macdSignalPeriod"),
    );
    let rs = rsi_simple(&c, period(p, "rsiPeriod"));
    let bb = bollinger(&c, p);
    let vr = volume(&r, p);
    let (sr, rr) = support_resistance(&r, p);
    let strength = strength(&r, p);
    let score = n(&strength, "score");
    let vol = a / close;
    let bull = fast > slow && close > fast;
    let bear = fast < slow && close < fast;
    if vol > n(p, "maxAtrPct") {
        return hold(
            format!(
                "波动率过高（>{:.0}%），等待市场稳定。",
                n(p, "maxAtrPct") * 100.
            ),
            strength,
        );
    }
    if vol < n(p, "minAtrPct") {
        return hold(
            format!("波动率过低（{:.3}%），震荡市不做趋势单。", vol * 100.),
            strength,
        );
    }
    if (fast - slow).abs() < a * 0.3 {
        return hold("均线纠缠，趋势不明确，等待突破方向。".into(), strength);
    }
    if bull && rs < n(p, "minRsiLong") {
        return hold(
            format!("多头信号但RSI偏弱（{rs:.1}），等待动能确认。"),
            Value::Null,
        );
    }
    if bear && rs > n(p, "maxRsiShort") {
        return hold(
            format!("空头信号但RSI偏强（{rs:.1}），等待动能确认。"),
            Value::Null,
        );
    }
    if bear && rs < 30. {
        return hold(
            "空头信号但RSI超卖，避免在下跌末端追空。".into(),
            Value::Null,
        );
    }
    if b(p, "requireVolumeConfirm") && vr.is_finite() && vr <= n(p, "minVolumeRatio") {
        return hold(
            format!("成交量不足（量比{vr:.2}），等待量能确认。"),
            strength,
        );
    }
    if vr >= 1.2 {
        return hold(
            format!("近期成交量放大至基线{vr:.2}倍，避免放量追势。"),
            strength,
        );
    }
    if score < n(p, "minTrendScore") {
        return hold(
            format!("综合信号强度不足（{score}/100），等待更强信号。"),
            strength,
        );
    }
    let long = if bull && (macd.2 > 0. || score >= 70.) {
        true
    } else if bear && (macd.2 < 0. || score >= 70.) {
        false
    } else {
        return hold("缺少关键确认信号，等待。".into(), strength);
    };
    if !long && b(p, "longOnly") {
        return hold("当前配置仅允许做多。".into(), strength);
    }
    let sign = if long { 1. } else { -1. };
    let mut filter = Value::Null;
    if b(p, "trend15Enabled") {
        let r15 = rows(&ctx["auxMarkets"]["15m"]);
        let need = period(p, "trend15EmaFast")
            .max(period(p, "trend15EmaSlow"))
            .max(14)
            + 2;
        if r15.len() < need {
            return hold(
                format!("15m 趋势闸门已启用但行情缺失，需 ≥{need} 根。"),
                strength,
            );
        }
        let c15 = closes(&r15);
        let ef = ema_first(&c15, period(p, "trend15EmaFast"));
        let es = ema_first(&c15, period(p, "trend15EmaSlow"));
        let a15 = atr(&r15, 14);
        let ap = a15 / c15.last().unwrap();
        let sep = (ef - es) / a15;
        if !ap.is_finite()
            || !sep.is_finite()
            || ap < n(p, "trend15MinAtrPct")
            || (n(p, "trend15MaxAtrPct") > 0. && ap > n(p, "trend15MaxAtrPct"))
            || sign * (ef - es) <= 0.
            || sign * sep < n(p, "trend15MinSepAtr")
        {
            return hold(
                "15m 趋势或波动率未达到闸门要求，本轮观望。".into(),
                strength,
            );
        }
        filter = json!({"emaFast":ef,"emaSlow":es,"atr":a15,"atrPct":ap,"sepAtr":sep,"emaFastPeriod":p["trend15EmaFast"],"emaSlowPeriod":p["trend15EmaSlow"]});
    }
    let ext = (close - fast) / a;
    if sign * ext > 1.5 {
        return hold(
            format!("价格偏离20均线超过1.5 ATR（{ext:.2}），等待回调。"),
            strength,
        );
    }
    let band = a * n(p, "entryBandAtr");
    let e0 = close - band;
    let e1 = close + band;
    let span = n(p, "scoreCeil") - n(p, "scoreFloor");
    let t = if span > 0. {
        ((score - n(p, "scoreFloor")) / span).clamp(0., 1.)
    } else {
        1.
    };
    let depth =
        n(p, "pullbackAtrDeep") + (n(p, "pullbackAtrShallow") - n(p, "pullbackAtrDeep")) * t;
    let limit = close - sign * depth * a;
    let unit = (a * n(p, "stopAtr")).max(close * n(p, "minStopPct"));
    let stop = if long { e0 - unit } else { e1 + unit };
    let anchor = if long { e1 } else { e0 };
    let tp1 = anchor + sign * unit;
    let mut tp2 = anchor + sign * unit * 2.;
    let mut tp3 = anchor + sign * unit * n(p, "mainTpR");
    let rr_from = |target: f64| (target - close).abs() / (close - stop).abs();
    let level = if long { rr } else { sr };
    if if long {
        level < tp3 && level > tp1
    } else {
        level > tp3 && level < tp1
    } {
        let narrowed = level + sign * unit;
        if rr_from(narrowed) >= n(p, "srNarrowMinRr") {
            tp2 = level;
            tp3 = narrowed;
        }
    }
    let risk_reward = rr_from(tp3);
    if risk_reward < n(p, "minRiskReward") {
        return hold(
            format!("风险收益比不足（{risk_reward:.2}:1），等待更好位置。"),
            Value::Null,
        );
    }
    let actual = (limit - stop).abs();
    let pct = actual / limit;
    let lev = (n(p, "riskBudgetPct") / pct)
        .floor()
        .max(1.)
        .min(n(p, "maxLeverage"));
    let exit = exit_rules(p);
    let mut periods = Map::new();
    if let Some(def) = super::definition("enhanced-trend-v1") {
        for spec in def["paramSchema"].as_array().unwrap() {
            if spec["group"] == "indicator" {
                let key = spec["key"].as_str().unwrap();
                periods.insert(key.into(), p[key].clone());
            }
        }
    }
    json!({"symbol":symbol,"action":if long{"BUY"}else{"SELL"},"confidence":(0.60+score/250.).min(0.90),"reason":format!("增强分析({score}/100分)：{}",strength["reasons"].as_array().unwrap().iter().take(3).filter_map(|s|s.as_str()).collect::<Vec<_>>().join("；")),"risk":format!("波动率{:.2}%；风险收益比{risk_reward:.2}:1；推荐杠杆{lev}x（保证金风险约{:.2}%）",vol*100.,lev*pct*100.),"plan":{"entryMin":e0,"entryMax":e1,"entryLimit":limit,"stopLoss":stop,"takeProfit":tp3,"takeProfit1":tp1,"takeProfit2":tp2,"takeProfit3":tp3,"riskUnit":actual,"marginRiskPct":lev*pct,"exitRules":exit,"smartExit":exit["smartExit"],"maxHoldBars":p["maxHoldBars"],"riskRewardRatio":risk_reward,"recommendedLeverage":lev,"trendStrengthScore":score,"trend15Filter":filter,"indicators":{"periods":periods,"ma20":fast,"ma50":slow,"atr":a,"rsi":rs,"macd":if macd.0.is_finite(){json!({"histogram":macd.2})}else{Value::Null},"bollinger":bb,"volumeRatio":vr,"support":sr,"resistance":rr}}})
}
pub fn review(order: &Value, m: &Value, _ctx: &Value) -> Value {
    let r = rows(m);
    if r.len() < 30 {
        return json!({"action":"HOLD","reason":"数据不足，保留当前保护价格。"});
    }
    let mut p = defaults("enhanced-trend-v1");
    if let Some(snap) = order["plan"]["indicators"]["periods"].as_object() {
        p.as_object_mut().unwrap().extend(snap.clone());
    }
    let rules = exit_rules_for(&order["plan"]);
    let smart = &rules["smartExit"];
    let c = closes(&r);
    let mp = number(&smart["maPeriod"], 20.) as usize;
    let ap = number(&smart["atrPeriod"], 14.) as usize;
    if r.len() < mp.max(ap + 1) {
        return json!({"action":"HOLD","reason":"指标周期所需数据不足。"});
    }
    let close = *c.last().unwrap();
    let ma = average_tail(&c, mp);
    let a = atr(&r, ap);
    let long = order["direction"] == "OPEN_LONG";
    let sign = if long { 1. } else { -1. };
    let pr = sign * (close - n(order, "entry")) / plan_risk_unit(&order["plan"], long);
    let rs = rsi_simple(&c, period(&p, "rsiPeriod"));
    let macd = enhanced_macd(
        &c,
        period(&p, "macdFastPeriod"),
        period(&p, "macdSlowPeriod"),
        period(&p, "macdSignalPeriod"),
    );
    let mut code = "";
    if sign * (close - ma) <= 0.
        && (close - ma).abs() > a * n(smart, "maBreakAtr")
        && (!pr.is_finite() || pr < n(smart, "maExitMaxProfitR"))
    {
        code = "smart_exit_ma";
    }
    if pr.is_finite() && pr + 1e-9 >= n(smart, "tpMinR") {
        if long && rs > 80. || !long && rs < 20. {
            code = "smart_exit_rsi";
        }
        if long && macd.2 < 0. || !long && macd.2 > 0. {
            code = "smart_exit_macd";
        }
    }
    if b(smart, "enabled") && !code.is_empty() && n(order, "heldBars") >= n(smart, "minHoldBars") {
        return json!({"action":"CLOSE","closeReason":code,"closePrice":close,"confidence":0.80,"profitR":pr,"reason":format!("智能退出 {code}，浮盈 {pr:.2}R。")});
    }
    let mut result = local_review_with_atr(order, m, a);
    result["trendScore"] = strength(&r, &p)["score"].clone();
    if result["action"] == "UPDATE_PROTECTION" {
        result["profitPercent"] =
            json!(sign * (close - n(order, "entry")) / n(order, "entry") * 100.);
    }
    result
}
