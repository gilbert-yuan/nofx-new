use super::indicators::{atr, closes, ema, last, mean, true_ranges};
use super::{b, merge, n, rows};
use crate::{iso, number};
use serde_json::{Value, json};
fn opt(p: &Value, key: &str, d: f64) -> f64 {
    number(&p[key], d)
}
fn nullable(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
fn valid(m: &Value) -> Vec<Value> {
    let mut r: Vec<Value> = rows(m)
        .into_iter()
        .filter(|r| {
            ["open", "high", "low", "close", "volume"]
                .iter()
                .all(|k| number(&r[k], 0.) > 0.)
        })
        .collect();
    r.sort_by_key(|r| n(r, "openTime") as i64);
    r
}
pub fn features(m: &Value, ticker: &Value, p: &Value) -> Value {
    let r = valid(m);
    let latest = r.last().cloned().unwrap_or(Value::Null);
    let price = nullable(&ticker["lastPrice"])
        .filter(|n| *n > 0.)
        .or_else(|| nullable(&latest["close"]));
    let open = nullable(&ticker["openPrice"]).filter(|n| *n > 0.);
    let high = nullable(&ticker["highPrice"]).filter(|n| *n > 0.);
    let low = nullable(&ticker["lowPrice"]).filter(|n| *n > 0.);
    let amplitude = if let (Some(o), Some(h), Some(l)) = (open, high, low) {
        if h >= l {
            Some((h - l) / o * 100.)
        } else {
            None
        }
    } else {
        None
    };
    let mut f = json!({"symbol":m["symbol"],"barCount":r.len(),"sufficient":r.len()>=opt(p,"minBars",40.)as usize,"currentPrice":price,"change24hPct":nullable(&ticker["priceChangePercent"]),"amplitude24hPct":amplitude,"dayOpen":open,"dayHigh":high,"dayLow":low,"recentReturnPct":null,"previousReturnPct":null,"accelerationPct":null,"volumeRatio":null,"rangeRatio":null,"trendConsistencyPct":null,"breakoutPositionPct":null,"breakoutDirection":0,"atr":null,"atrPct":null,"dataSource":if !ticker["priceChangePercent"].is_null(){"ticker24h+klines"}else{"klines-only"}});
    if r.len() < 2 {
        return f;
    }
    let recent = (opt(p, "recentBars", 12.).trunc() as usize)
        .min(r.len() - 1)
        .max(3)
        .min(r.len() - 1);
    let baseline = (opt(p, "baselineBars", 30.).trunc() as usize)
        .min(r.len().saturating_sub(recent + 1))
        .max(3);
    let breakout = (opt(p, "breakoutBars", 40.).trunc() as usize)
        .min(r.len() - 1)
        .max(5);
    let start = r.len() - recent - 1;
    let previous = start.saturating_sub(recent);
    let baseline_start = start.saturating_sub(baseline);
    let rw = &r[start + 1..];
    let bw = &r[baseline_start..=start];
    let br = &r[r.len().saturating_sub(breakout + 1)..r.len() - 1];
    let pct = |a: f64, b: f64| (a / b - 1.) * 100.;
    let recent_ret = pct(n(&latest, "close"), n(&r[start], "close"));
    let prev_ret = pct(n(&r[start], "close"), n(&r[previous], "close"));
    let vol = |w: &[Value]| {
        mean(
            &w.iter()
                .map(|x| number(&x["quoteVolume"], n(x, "volume")))
                .collect::<Vec<_>>(),
        )
    };
    let tr = true_ranges(&r);
    let vr = vol(rw) / vol(bw);
    let rr = mean(&tr[start + 1..]) / mean(&tr[baseline_start..=start]);
    let ap = (opt(p, "atrBars", 14.).trunc() as usize)
        .min(r.len())
        .max(3);
    let a = mean(&tr[r.len().saturating_sub(ap)..]);
    let up = rw.iter().filter(|x| n(x, "close") > n(x, "open")).count();
    let down = rw.iter().filter(|x| n(x, "close") < n(x, "open")).count();
    let consistency = if up + down > 0 {
        Some((up as f64 - down as f64) / (up + down) as f64 * 100.)
    } else {
        None
    };
    let high = br
        .iter()
        .map(|x| n(x, "high"))
        .fold(f64::NEG_INFINITY, f64::max);
    let low = br.iter().map(|x| n(x, "low")).fold(f64::INFINITY, f64::min);
    let close = n(&latest, "close");
    let up_break = if high > 0. {
        (close - high) / high * 100.
    } else {
        0.
    };
    let down_break = if low > 0. {
        (low - close) / low * 100.
    } else {
        0.
    };
    f = merge(
        f,
        json!({"recentReturnPct":recent_ret,"previousReturnPct":prev_ret,"accelerationPct":recent_ret-prev_ret,"volumeRatio":vr,"rangeRatio":rr,"atr":a,"atrPct":a/price.unwrap_or(close)*100.,"trendConsistencyPct":consistency,"breakoutPositionPct":if high>low{Some((close-low)/(high-low)*100.)}else{None},"breakoutDirection":if up_break>0.{(up_break/2.).clamp(0.,1.)}else if down_break>0.{-(down_break/2.).clamp(0.,1.)}else{0.}}),
    );
    f
}
pub fn calibrate(score: f64, target: bool) -> f64 {
    if !target {
        return 46.34;
    }
    let xs = [60., 65., 70., 75., 80., 85., 90., 92., 94., 96., 98., 99.];
    let ys = [
        0.43, 0.71, 0.87, 1.16, 1.48, 1.91, 2.67, 2.67, 2.67, 4.76, 4.76, 6.84,
    ];
    if score <= xs[0] {
        return ys[0];
    }
    for i in 1..xs.len() {
        if score <= xs[i] {
            return ys[i - 1] + (ys[i] - ys[i - 1]) * (score - xs[i - 1]) / (xs[i] - xs[i - 1]);
        }
    }
    *ys.last().unwrap()
}
pub fn predict(m: &Value, ticker: &Value, now: i64, p: &Value) -> Value {
    let f = features(m, ticker, p);
    if !b(&f, "sufficient") || f["currentPrice"].is_null() {
        return Value::Null;
    }
    let direction_score = (n(&f, "change24hPct") / 50.).clamp(-1., 1.) * 25.
        + (n(&f, "recentReturnPct") / 5.).clamp(-1., 1.) * 25.
        + (n(&f, "accelerationPct") / 5.).clamp(-1., 1.) * 15.
        + (n(&f, "trendConsistencyPct") / 100.).clamp(-1., 1.) * 20.
        + n(&f, "breakoutDirection").clamp(-1., 1.) * 15.;
    let direction = if direction_score.abs() >= 5. {
        direction_score.signum()
    } else if n(&f, "change24hPct") != 0. {
        n(&f, "change24hPct").signum()
    } else if n(&f, "recentReturnPct") != 0. {
        n(&f, "recentReturnPct").signum()
    } else {
        return Value::Null;
    };
    let clamp = |x: f64| x.clamp(0., 1.);
    let activity = 35. * clamp((n(&f, "change24hPct").abs() - 5.) / 35.)
        + 25. * clamp(direction * n(&f, "recentReturnPct") / 5.)
        + 15. * clamp(direction * n(&f, "accelerationPct") / 5.)
        + 15. * clamp(direction * n(&f, "trendConsistencyPct") / 100.)
        + 10. * clamp(direction * n(&f, "breakoutDirection"))
        + 20. * clamp((n(&f, "volumeRatio") - 1.) / 3.)
        + 10. * clamp((n(&f, "rangeRatio") - 1.) / 2.);
    let raw = (35. + clamp(direction_score.abs() / 100.) * 35. + activity)
        .clamp(0., 99.)
        .round();
    let amplitude = n(&f, "change24hPct")
        .abs()
        .max(n(&f, "amplitude24hPct"))
        .max(0.);
    let target = opt(p, "targetAmplitudePct", 50.);
    let reached = amplitude >= target;
    let min_raw = opt(p, "minRawProbabilityPct", 60.);
    if !reached && raw < min_raw {
        return Value::Null;
    }
    let probability = calibrate(raw, false);
    let expected = ((target
        .max(amplitude + 5. + (probability - opt(p, "minProbabilityPct", 60.)).max(0.) * 0.35))
    .clamp(target, 85.)
        * 10.)
        .round()
        / 10.;
    let price = n(&f, "currentPrice");
    let a = if n(&f, "atr") > 0. {
        n(&f, "atr")
    } else {
        price * 0.01
    };
    let r = valid(m);
    let recent = &r[r.len().saturating_sub(20)..];
    let recent_low = recent
        .iter()
        .map(|r| n(r, "low"))
        .fold(f64::INFINITY, f64::min);
    let recent_high = recent
        .iter()
        .map(|r| n(r, "high"))
        .fold(f64::NEG_INFINITY, f64::max);
    let pull = (a * opt(p, "pullbackAtr", 0.65).clamp(0.05, 2.)).clamp(price * 0.002, price * 0.03);
    let support = (recent_low + a * 0.35).min(price).max(price * 0.97);
    let resistance = (recent_high - a * 0.35).max(price).min(price * 1.03);
    let entry = if direction > 0. {
        (price - pull).max(support).min(price)
    } else {
        (price + pull).min(resistance).max(price)
    };
    let half = (a * opt(p, "entryBandAtr", 0.45).clamp(0.1, 2.)).max(entry * 0.002);
    let min = if direction > 0. {
        (entry - half).max(price * 0.9)
    } else {
        (entry - half).max(price)
    };
    let max = if direction > 0. {
        (entry + half).min(price)
    } else {
        (entry + half).min(price * 1.1)
    };
    let risk = (a * 1.5).max(entry * 0.01);
    let stop = if direction > 0. {
        (entry - risk).min(recent_low - a * 0.25)
    } else {
        (entry + risk).max(recent_high + a * 0.25)
    };
    let predicted = price * (1. + direction * expected / 100.);
    let mut reasons = vec![];
    if n(&f, "volumeRatio") >= 1.5 {
        reasons.push(format!(
            "近{}根成交量约为基线{:.1}倍",
            opt(p, "recentBars", 12.),
            n(&f, "volumeRatio")
        ));
    }
    if n(&f, "rangeRatio") >= 1.3 {
        reasons.push(format!("波动放大{:.1}倍", n(&f, "rangeRatio")));
    }
    if n(&f, "recentReturnPct").abs() >= 1. {
        reasons.push(format!("短线动量{:+.2}%", n(&f, "recentReturnPct")));
    }
    if n(&f, "accelerationPct").abs() >= 0.5 {
        reasons.push(format!("动量加速度{:+.2}%", n(&f, "accelerationPct")));
    }
    if n(&f, "trendConsistencyPct").abs() >= 45. {
        reasons.push(format!(
            "同向K线占优{}",
            if n(&f, "trendConsistencyPct") >= 0. {
                "偏多"
            } else {
                "偏空"
            }
        ));
    }
    if reached {
        reasons.push(format!("已达到±{target}%妖币振幅阈值"));
    }
    if reasons.is_empty() {
        reasons.push("启动前特征组合达到观察门槛".into());
    }
    json!({"generatedAt":iso(now),"symbol":f["symbol"],"direction":if direction>0.{"UP"}else{"DOWN"},"directionLabel":if direction>0.{"预计上涨"}else{"预计下跌"},"sideLabel":if direction>0.{"上涨"}else{"下跌"},"stage":if reached{"TRIGGERED"}else{"PRE_LAUNCH"},"stageLabel":if reached{"已触发妖币阈值"}else{"启动前候选"},"targetAmplitudePct":target,"targetDefinition":"24h涨跌幅绝对值或24h高低振幅达到阈值","probabilityPct":probability,"score":raw,"rawProbabilityPct":raw,"calibratedDirectionProbabilityPct":probability,"calibratedTargetProbabilityPct":(calibrate(raw,true)*100.).round()/100.,"predictedMovePct":direction*expected,"predictedMoveAbsPct":expected,"predictedTargetPrice":predicted,"current":{"price":price,"change24hPct":f["change24hPct"],"amplitude24hPct":f["amplitude24hPct"],"high24h":f["dayHigh"],"low24h":f["dayLow"]},"levels":{"entryRange":{"min":min.min(max),"max":min.max(max)},"optimalEntry":entry,"entryMode":"PULLBACK_REFERENCE","stopLoss":stop,"takeProfits":[entry+direction*risk*1.5,entry+direction*risk*2.5,entry+direction*risk*3.5],"riskUnit":risk,"predictedTargetPrice":predicted,"side":if direction>0.{"BUY"}else{"SELL_SHORT"}},"features":{"barCount":f["barCount"],"recentReturnPct":f["recentReturnPct"],"previousReturnPct":f["previousReturnPct"],"accelerationPct":f["accelerationPct"],"volumeRatio":f["volumeRatio"],"rangeRatio":f["rangeRatio"],"trendConsistencyPct":f["trendConsistencyPct"],"breakoutPositionPct":f["breakoutPositionPct"],"atrPct":f["atrPct"],"dataSource":f["dataSource"]},"reasons":reasons,"warnings":[if reached{"该币已达到妖币阈值，不属于提前预测；追涨杀跌风险很高。"}else{"这是启动前规则预测，不代表一定达到目标；请等待入场价区间。"},"妖币预测仅用于观察，不会绕过现有策略、保证金和止损风控。"]})
}
fn ticker(m: &Value, aux: &Value, count: usize) -> Value {
    let r = rows(m);
    let a = rows(aux);
    if a.len() < count || r.is_empty() || count == 0 {
        return Value::Null;
    }
    let window = &a[a.len() - count..];
    let last = r.last().unwrap();
    let price = n(last, "close");
    let open = n(&window[0], "open");
    let high = window
        .iter()
        .map(|r| n(r, "high"))
        .fold(n(last, "high"), f64::max);
    let low = window
        .iter()
        .map(|r| n(r, "low"))
        .fold(n(last, "low"), f64::min);
    if price <= 0. || open <= 0. || high < low {
        return Value::Null;
    }
    json!({"symbol":m["symbol"],"lastPrice":price,"openPrice":open,"highPrice":high,"lowPrice":low,"priceChangePercent":(price/open-1.)*100.,"dataSource":"15m-rolling-24h+1m-close"})
}
fn yao_exit(p: &Value) -> Value {
    json!({"trailing":{"triggerR":p["trailingTriggerR"],"profitTriggerPct":p["trailingProfitTriggerPct"],"extendTpAtr":p["trailingExtendTpAtr"],"lockMinRoomAtr":1,"useBreakEven":false,"breakEvenFloorAtr":0.2,"breakEvenCostBufferBps":4,"ladder":[{"atR":0,"trailR":0.7,"lockR":0},{"atR":1,"trailR":0.5,"lockR":0.3},{"atR":2,"trailR":0.4,"lockR":0.8}]},"smartExit":{"enabled":false,"barLevelEnabled":false,"barLevel":false,"maPeriod":20,"maBreakAtr":1,"maExitMaxProfitR":p["trailingTriggerR"],"tpMinR":2,"minHoldBars":0},"partialTp":{"enabled":true,"tp1R":p["tp1R"],"tp2R":p["tp2R"],"tp1ClosePct":0.4,"tp2ClosePct":0.4,"moveStopToBreakEven":false}})
}
pub fn analyze(m: &Value, ctx: &Value) -> Value {
    let p = &ctx["params"];
    let aux = &ctx["auxMarkets"]["15m"];
    let tk = ticker(m, aux, n(p, "minAuxBars") as usize);
    let hold = |reason: String, extra: Value| {
        merge(
            json!({"symbol":m["symbol"],"action":"WAIT","positionRecommendation":"WAIT","confidence":0,"score":0,"state":"WAIT","reason":reason,"risk":"妖币埋伏：依据短线动量、量能和波动放大特征提前埋伏；等待回踩/反弹限价成交，不追涨杀跌。","suggestion":"等待新的启动前特征组合，不追已经达到阈值的行情。"}),
            extra,
        )
    };
    if tk.is_null() {
        return hold(
            format!(
                "妖币埋伏需要至少 {} 根已收盘 15m K 线构造 24h 快照。",
                n(p, "minAuxBars")
            ),
            json!({"dataGap":true}),
        );
    }
    let options = json!({"targetAmplitudePct":p["targetAmplitudePct"],"minProbabilityPct":p["minProbabilityPct"],"minRawProbabilityPct":p["minRawProbabilityPct"],"minBars":40,"recentBars":12,"baselineBars":30,"breakoutBars":40,"atrBars":14,"pullbackAtr":p["entryPullbackAtr"],"entryBandAtr":p["entryBandAtr"]});
    let prediction = predict(
        m,
        &tk,
        crate::timestamp(&m["dataAsOf"]).unwrap_or_else(crate::now_ms),
        &options,
    );
    if prediction.is_null() {
        return hold(
            "启动前特征未达到妖币埋伏置信度门槛，观望。".into(),
            json!({}),
        );
    }
    let amplitude = n(&tk, "priceChangePercent")
        .abs()
        .max((n(&tk, "highPrice") - n(&tk, "lowPrice")) / n(&tk, "openPrice") * 100.);
    let snap = json!({"direction":prediction["direction"],"stage":prediction["stage"],"probabilityPct":prediction["probabilityPct"],"rawProbabilityPct":prediction["rawProbabilityPct"],"calibratedDirectionProbabilityPct":prediction["calibratedDirectionProbabilityPct"],"calibratedTargetProbabilityPct":prediction["calibratedTargetProbabilityPct"],"predictedMovePct":prediction["predictedMovePct"],"predictedTargetPrice":prediction["predictedTargetPrice"],"observedAmplitudePct":amplitude,"currentPrice":tk["lastPrice"],"features":prediction["features"]});
    let mut trend = merge(json!({"source":"yao-coin-prediction-v1"}), snap.clone());
    let long = prediction["direction"] == "UP";
    let sign = if long { 1. } else { -1. };
    let feat = &prediction["features"];
    let blocker = if prediction["stage"] != "PRE_LAUNCH" {
        Some("当前 24h 涨跌/振幅已达到目标阈值，埋伏策略不追入。".into())
    } else if n(&prediction, "probabilityPct") < n(p, "minProbabilityPct") {
        Some(format!(
            "历史校准方向概率 {:.2}% 低于门槛 {}%，观望。",
            n(&prediction, "probabilityPct"),
            n(p, "minProbabilityPct")
        ))
    } else if amplitude < n(p, "minCurrentAmplitudePct")
        || amplitude > n(p, "maxCurrentAmplitudePct")
    {
        Some("当前观察振幅不在埋伏区间内。".into())
    } else if n(feat, "volumeRatio") < n(p, "minVolumeRatio") {
        Some("量能比低于埋伏门槛。".into())
    } else if n(feat, "rangeRatio") < n(p, "minRangeRatio") {
        Some("波动比低于埋伏门槛。".into())
    } else if n(feat, "trendConsistencyPct").abs() < n(p, "minTrendConsistencyPct") {
        Some("同向 K 线净占比不足。".into())
    } else if sign * n(feat, "recentReturnPct") < n(p, "minRecentReturnPct") {
        Some("最近动量未与预测方向一致。".into())
    } else if long && b(p, "shortOnly") || !long && b(p, "longOnly") {
        Some("预测方向被策略方向开关拦截。".into())
    } else {
        None
    };
    if let Some(reason) = blocker {
        return hold(reason, json!({"trend":trend}));
    }
    let r15 = rows(aux);
    let fast_n = n(p, "trend15EmaFast") as usize;
    let slow_n = n(p, "trend15EmaSlow") as usize;
    let trend15 = if !b(p, "require15mTrend") {
        json!({"enabled":false})
    } else if fast_n >= slow_n || r15.len() < slow_n.max(15) + 1 {
        json!({"enabled":true,"ok":false,"reason":"15m趋势数据不足或均线周期冲突"})
    } else {
        let c = closes(&r15);
        let fast = last(&ema(&c, fast_n));
        let slow = last(&ema(&c, slow_n));
        let a = atr(&r15, 14);
        let sep = (fast - slow) / a;
        let aligned = sign * (fast - slow) > 0.;
        let separated = sep.is_finite() && sep.abs() >= n(p, "minTrend15SepAtr");
        json!({"enabled":true,"ok":aligned&&separated,"fast":fast,"slow":slow,"atr":a,"sepAtr":sep,"aligned":aligned,"separated":separated,"minSepAtr":p["minTrend15SepAtr"]})
    };
    trend["trend15"] = trend15.clone();
    if b(p, "require15mTrend") && !b(&trend15, "ok") {
        return hold(
            "15m 趋势未与预测一致或间距不足，观望。".into(),
            json!({"trend":trend}),
        );
    }
    let levels = &prediction["levels"];
    let e0 = n(&levels["entryRange"], "min");
    let e1 = n(&levels["entryRange"], "max");
    let limit = n(levels, "optimalEntry");
    let price = n(&tk, "lastPrice");
    let a = if n(feat, "atrPct") > 0. {
        price * n(feat, "atrPct") / 100.
    } else {
        price * 0.01
    };
    if [e0, e1, limit, price, a]
        .iter()
        .any(|x| !x.is_finite() || *x <= 0.)
        || e0 > e1
    {
        return hold(
            "妖币埋伏价格或 ATR 无效，观望。".into(),
            json!({"trend":trend}),
        );
    }
    let risk = (a * n(p, "stopAtr")).max(limit * n(p, "minStopPct"));
    let stop = if long {
        (limit - risk).min(e0 - a * 0.1)
    } else {
        (limit + risk).max(e1 + a * 0.1)
    };
    let mut tp = [n(p, "tp1R"), n(p, "tp2R"), n(p, "tp3R")];
    tp.sort_by(f64::total_cmp);
    let profits: Vec<f64> = tp.iter().map(|r| limit + sign * risk * r).collect();
    let target = *profits.last().unwrap();
    let worst = if long { e1 } else { e0 };
    let costs = &ctx["costs"];
    let cost = worst
        * (2. * (number(&costs["feeBps"], 6.) + number(&costs["slippageBps"], 5.))
            + number(&costs["fundingBpsPer8h"], 3.) * n(p, "maxHoldBars") / 60. / 8.)
        / 10000.;
    let gross = (target - worst).abs() / (worst - stop).abs();
    let net = ((target - worst).abs() - cost) / ((worst - stop).abs() + cost);
    if net < n(p, "minNetRr") {
        return hold(
            format!("埋伏计划成本后盈亏比 {net:.2} 低于门槛。"),
            json!({"trend":trend,"rr":{"grossRr":gross,"netRr":net}}),
        );
    }
    json!({"symbol":m["symbol"],"action":if long{"BUY"}else{"SELL"},"positionRecommendation":if long{"OPEN_LONG"}else{"OPEN_SHORT"},"confidence":(n(&prediction,"probabilityPct")/100.).clamp(0.,0.99),"score":prediction["score"],"state":"PRE_LAUNCH","decision":"AMBUSH_PRE_LAUNCH","trend":trend,"reason":format!("妖币埋伏{}：当前24h振幅 {amplitude:.2}%，参考 {limit}，止损 {stop}，止盈 {target}。",if long{"做多"}else{"做空"}),"risk":format!("原始规则分数 {}，历史校准方向概率 {:.2}%，成本后盈亏比 {net:.2}。",n(&prediction,"rawProbabilityPct"),n(&prediction,"probabilityPct")),"suggestion":"等待回踩/反弹区间成交；达到目标振幅则取消埋伏。","recommendedLeverage":n(p,"maxLeverage").trunc().clamp(1.,5.),"plan":{"entryMin":e0,"entryMax":e1,"entryLimit":limit,"stopLoss":stop,"takeProfit":target,"maxHoldBars":n(p,"maxHoldBars").trunc(),"riskUnit":risk,"takeProfit1":profits[0],"takeProfit2":profits[1],"takeProfit3":profits[2],"trendStrengthScore":prediction["score"],"predictedTargetPrice":prediction["predictedTargetPrice"],"yaoPrediction":snap,"exitRules":yao_exit(p)}})
}
pub fn profile(row: &Value, p: &Value) -> Value {
    let symbol = normalize_symbol(row["symbol"].as_str().unwrap_or(""));
    let cap = nullable(&row["marketCap"]);
    let rank = nullable(&row["marketCapRank"]);
    let volume = nullable(&row["volume24h"]).or_else(|| nullable(&row["quoteVolume"]));
    let circulating = nullable(&row["circulatingSupply"]);
    let total = nullable(&row["totalSupply"]);
    let ratio = circulating
        .zip(total)
        .filter(|(_, t)| *t > 0.)
        .map(|(c, t)| c / t);
    let liquidity = nullable(&row["volumeMarketCapRatio"])
        .or_else(|| volume.zip(cap).filter(|(_, c)| *c > 0.).map(|(v, c)| v / c));
    let change =
        nullable(&row["priceChangePercentage24h"]).or_else(|| nullable(&row["priceChangePct"]));
    let mut available = 0.;
    let mut weighted = 0.;
    let mut hard = false;
    let mut components = vec![];
    let tests = [
        (
            "marketCap",
            cap,
            25.,
            opt(p, "minMarketCapUsd", 20_000_000.),
            opt(p, "maxMarketCapUsd", 20_000_000_000.),
            "市值过小或过大",
        ),
        (
            "circulatingRatio",
            ratio,
            25.,
            opt(p, "minCirculatingRatio", 0.2),
            opt(p, "maxCirculatingRatio", 1.05),
            "流通率过低或供应数据异常",
        ),
        (
            "liquidityRatio",
            liquidity,
            20.,
            opt(p, "minVolumeMarketCapRatio", 0.005),
            opt(p, "maxVolumeMarketCapRatio", 2.),
            "流动性不足或成交额异常",
        ),
        (
            "volume24h",
            volume,
            15.,
            opt(p, "minVolume24hUsd", 5_000_000.),
            f64::INFINITY,
            "24h成交额偏低",
        ),
        (
            "marketCapRank",
            rank,
            10.,
            f64::NEG_INFINITY,
            opt(p, "maxMarketCapRank", 1000.),
            "市值排名过后",
        ),
        (
            "currentVolatility",
            change.map(f64::abs),
            5.,
            0.,
            45.,
            "当前涨跌幅过大",
        ),
    ];
    for (name, x, weight, min, max, reason) in tests {
        let pass = x.map(|x| x >= min && x <= max);
        if let Some(good) = pass {
            available += weight;
            if good {
                weighted += weight;
            } else {
                hard = true;
            }
        }
        components.push(json!({"name":name,"value":pass.map(|b|if b{1}else{0}),"available":pass.is_some(),"weight":weight,"reason":if pass==Some(false){reason}else if pass.is_none(){"市场画像字段不足"}else{"市场画像条件合格"}}));
    }
    let coverage = available / 100.;
    let score = if available > 0. {
        Some(weighted / available * 100.)
    } else {
        None
    };
    let known = available > 0.;
    let eligible = p["enabled"] != false
        && known
        && coverage >= opt(p, "minCoverage", 0.6)
        && !hard
        && score.unwrap_or(0.) >= opt(p, "minScore", 55.);
    let reason = if !known {
        "市场画像字段不足".into()
    } else if hard {
        components
            .iter()
            .filter(|c| c["value"] == 0)
            .filter_map(|c| c["reason"].as_str())
            .collect::<Vec<_>>()
            .join("；")
    } else {
        format!(
            "市场画像评分 {:.1}，覆盖率 {:.0}%",
            score.unwrap(),
            coverage * 100.
        )
    };
    json!({"symbol":symbol,"known":known,"eligible":eligible,"score":score.map(|s|(s*100.).round()/100.),"coverage":(coverage*1000.).round()/1000.,"marketCap":cap,"marketCapRank":rank,"volume24h":volume,"circulatingSupply":circulating,"totalSupply":total,"circulatingRatio":ratio.map(|r|(r*10000.).round()/10000.),"volumeMarketCapRatio":liquidity.map(|r|(r*10000.).round()/10000.),"priceChange24h":change,"hardReject":hard,"components":components,"reason":reason})
}
fn normalize_symbol(s: &str) -> String {
    let s = s.trim().to_uppercase();
    if s.ends_with("USDT") {
        s
    } else {
        format!("{s}USDT")
    }
}
fn base(s: &str) -> &str {
    if let Some(rest) = s.strip_prefix("1000000")
        && rest.starts_with(char::is_alphabetic)
    {
        return rest;
    }
    if let Some(rest) = s.strip_prefix("1000")
        && rest.starts_with(char::is_alphabetic)
    {
        return rest;
    }
    s
}
pub fn universe(symbols: &[Value], market_rows: &[Value], p: &Value) -> Value {
    if p["enabled"] == false {
        return json!({"filtered":symbols,"filteredOut":[],"profiles":[],"unavailable":false,"reasons":{}});
    }
    let mut filtered = vec![];
    let mut out = vec![];
    let mut profiles = vec![];
    let mut reasons = serde_json::Map::new();
    for input in symbols {
        let symbol = normalize_symbol(input.as_str().unwrap_or(""));
        let found = market_rows.iter().rev().find(|r| {
            let rs = normalize_symbol(r["symbol"].as_str().unwrap_or(""));
            rs == symbol || base(&rs) == base(&symbol)
        });
        let row = merge(
            found.cloned().unwrap_or(json!({})),
            json!({"symbol":symbol}),
        );
        let profile = profile(&row, p);
        let accept = !b(&profile, "known") && p["allowUnknown"] != false || b(&profile, "eligible");
        let reason = if !b(&profile, "known") && accept {
            "unknown"
        } else if accept {
            "eligible"
        } else {
            profile["reason"].as_str().unwrap_or("市场画像不合格")
        };
        let count = reasons.get(reason).and_then(|x| x.as_u64()).unwrap_or(0) + 1;
        reasons.insert(reason.to_owned(), json!(count));
        if accept {
            filtered.push(input.clone());
        } else {
            out.push(json!({"symbol":input,"score":profile["score"],"reason":profile["reason"]}));
        }
        profiles.push(profile);
    }
    let known = profiles.iter().filter(|p| b(p, "known")).count();
    let fraction = known as f64 / symbols.len().max(1) as f64;
    let unavailable = known == 0 || fraction < opt(p, "minKnownFraction", 0.2);
    json!({"filtered":if unavailable{symbols.to_vec()}else{filtered.clone()},"filteredOut":if unavailable{vec![]}else{out.clone()},"profiles":profiles,"unavailable":unavailable,"reasons":reasons,"summary":{"total":symbols.len(),"known":known,"knownFraction":fraction,"filtered":if unavailable{symbols.len()}else{filtered.len()},"removed":if unavailable{0}else{out.len()}}})
}
