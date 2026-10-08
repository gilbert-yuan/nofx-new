use super::indicators::{adx, atr, closes, ema, finite_candle, last, mean, rsi};
use super::{b, exit_rules, merge, n, rows, tightest_stop, wait};
use crate::{number, timestamp};
use serde_json::{Map, Value, json};
fn clamp(v: f64) -> f64 {
    v.clamp(0., 1.)
}
fn rr(entry: f64, stop: f64, target: f64, bars: f64, costs: &Value) -> (f64, f64, f64) {
    let cost = entry
        * (2. * (number(&costs["feeBps"], 6.) + number(&costs["slippageBps"], 5.))
            + number(&costs["fundingBpsPer8h"], 3.) * bars / 2.)
        / 10000.;
    let risk = (entry - stop).abs();
    (
        (target - entry).abs() / risk,
        ((target - entry).abs() - cost) / (risk + cost),
        cost,
    )
}
#[expect(
    clippy::too_many_arguments,
    reason = "explicit price geometry shared by three registered engines"
)]
fn plan(
    direction: f64,
    price: f64,
    a: f64,
    target: f64,
    p: &Value,
    score: Option<f64>,
    target_source: String,
    extra: Value,
) -> Value {
    let risk = (n(p, "stopAtr") * a).max(n(p, "minStopPct") * price);
    let pct = risk / price;
    let band = n(p, "entryBandAtr").max(0.01) * a;
    let hard = std::env::var("NOFX_MAX_LEVERAGE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(5.);
    let mut cap = n(p, "maxLeverage").floor().clamp(1., hard);
    if b(p, "scoreLeverageEnabled") && score.unwrap_or(-1.) >= n(p, "scoreLeverageThreshold") {
        cap = cap.max(n(p, "scoreLeverageMax").floor().min(hard));
    }
    let lev = (n(p, "riskBudgetPct") / pct).floor().clamp(1., cap);
    let margin = n(p, "autoMarginPct");
    let pos = n(p, "maxPositions").floor();
    merge(
        json!({"entryMin":price-band,"entryMax":price+band,"entryReference":price,"stopLoss":price-direction*risk,"takeProfit":target,"riskUnit":risk,"stopDistancePct":pct,"maxHoldBars":n(p,"maxHoldBars").round(),"recommendedLeverage":lev,"marginRiskPct":lev*pct,"signalScore":score.unwrap_or(0.),"autoMarginPct":if margin>0.&&margin<=1.{Some(margin)}else{None},"maxPositions":if pos>=1.{Some(pos)}else{None},"targetSource":target_source,"entryStyle":"market","exitRules":exit_rules(p)}),
        extra,
    )
}
fn sane(p: &Value, d: f64) -> bool {
    let e0 = n(p, "entryMin");
    let e1 = n(p, "entryMax");
    let sl = n(p, "stopLoss");
    let tp = n(p, "takeProfit");
    [e0, e1, sl, tp, n(p, "riskUnit"), n(p, "maxHoldBars")]
        .iter()
        .all(|x| x.is_finite())
        && e0 > 0.
        && e1 > e0
        && n(p, "riskUnit") > 0.
        && if d > 0. {
            sl < e0 && tp > e1
        } else {
            sl > e1 && tp < e0
        }
}
pub fn analyze(id: &str, m: &Value, ctx: &Value) -> Value {
    let p = &ctx["params"];
    let reversion = id == "h4-mean-reversion-v1";
    let chandelier = id == "h4-chandelier-breakout-v1";
    let aux = &ctx["auxMarkets"]["4h"];
    let (feed, source) = if !rows(aux).is_empty() {
        (aux, "aux")
    } else if m["interval"] == "4h" {
        (m, "main")
    } else {
        (&Value::Null, "none")
    };
    let r = rows(feed);
    let keys = if reversion {
        vec!["meanPeriod", "atrPeriod", "rsiPeriod", "adxPeriod"]
    } else {
        vec![
            "emaFast",
            "emaSlow",
            "atrPeriod",
            "channelPeriod",
            "volPeriod",
            "rsiPeriod",
            "adxPeriod",
        ]
    };
    let mut actual = Map::new();
    let mut requested = Map::new();
    let mut degraded = vec![];
    for key in keys {
        let want = n(p, key).floor().max(2.) as usize;
        let got = want.min(r.len().saturating_sub(2).max(3));
        actual.insert(key.to_owned(), json!(got));
        requested.insert(key.to_owned(), json!(want));
        if want != got {
            degraded.push(key);
        }
    }
    let trend = json!({"interval":"4h","bars":r.len(),"dataAsOf":feed["dataAsOf"],"source":source,"periods":actual,"periodRequested":requested,"degradedPeriods":degraded,"dataGap":false});
    let period = |k: &str| trend["periods"][k].as_u64().unwrap_or(2) as usize;
    let hold = |reason: String, extra: Value| wait(m, reason, &trend, extra);
    if r.is_empty() {
        return hold(
            "未获取到 4H 行情，本轮观望。".into(),
            json!({"dataGap":true,"trend":merge(trend.clone(),json!({"dataGap":true}))}),
        );
    }
    if reversion && n(p, "rsiOversold") >= n(p, "rsiOverbought") {
        return hold(
            "参数冲突：超卖阈值必须低于超买阈值。".into(),
            json!({"paramConflict":"rsiOversold>=rsiOverbought"}),
        );
    }
    if !reversion && period("emaFast") >= period("emaSlow") {
        return hold(
            "参数冲突：快线周期不小于慢线。".into(),
            json!({"paramConflict":"emaFast>=emaSlow"}),
        );
    }
    let need = if reversion {
        period("meanPeriod")
            .max(period("atrPeriod"))
            .max(period("rsiPeriod"))
            + 2
    } else {
        period("emaSlow")
            .max(period("channelPeriod"))
            .max(period("atrPeriod"))
            + 2
    };
    if r.len() < need {
        return hold(
            format!("4H 数据不足：需要 {need} 根，实际 {} 根。", r.len()),
            json!({"dataGap":true,"trend":merge(trend.clone(),json!({"dataGap":true}))}),
        );
    }
    if !r.iter().all(finite_candle) {
        return hold(
            "4H K 线存在坏打印（OHLC 非法），本轮观望。".into(),
            json!({}),
        );
    }
    let c = closes(&r);
    let latest = r.last().unwrap();
    let price = n(latest, "close");
    let a = atr(&r, period("atrPeriod"));
    let rs = last(&rsi(&c, period("rsiPeriod")));
    let ax = last(&adx(&r, period("adxPeriod")).0);
    let ap = a / price;
    if !a.is_finite() || a <= 0. {
        return hold(
            "4H 指标未就绪（ATR 无效），本轮观望。".into(),
            json!({"dataGap":true}),
        );
    }
    let (direction, metrics, score, target, target_source, extra) = if reversion {
        let mean = last(&ema(&c, period("meanPeriod")));
        let ext = (price - mean) / a;
        let metrics = json!({"price":price,"mean":mean,"atr":a,"atrPct":ap,"extension":ext,"rsi":rs,"adx":ax});
        if ap < n(p, "minAtrPct") || ap > n(p, "maxAtrPct") {
            return hold(
                format!("4H ATR {:.3}% 越过波动率闸门。", ap * 100.),
                json!({"metrics":metrics}),
            );
        }
        if n(p, "adxMax") > 0. && ax.is_finite() && ax > n(p, "adxMax") {
            return hold(
                format!("ADX {ax:.1} 高于上限，禁止逆势入场。"),
                json!({"metrics":metrics}),
            );
        }
        let long = ext <= -n(p, "entryExtAtr") && (!rs.is_finite() || rs <= n(p, "rsiOversold"));
        let short = ext >= n(p, "entryExtAtr") && (!rs.is_finite() || rs >= n(p, "rsiOverbought"));
        if !long && !short {
            return hold(
                format!("4H 偏离 {ext:.2}×ATR、RSI {rs:.1} 未达到均值回归条件。"),
                json!({"metrics":metrics}),
            );
        }
        let direction = if long { 1. } else { -1. };
        let mid = (n(latest, "high") + n(latest, "low")) / 2.;
        let reversal = if long {
            price > n(latest, "open") && price >= mid
        } else {
            price < n(latest, "open") && price <= mid
        };
        if b(p, "requireReversalCandle") && !reversal {
            return hold(
                "偏离与 RSI 已达标，但当根未出现反向企稳确认。".into(),
                json!({"metrics":metrics}),
            );
        }
        let rs_edge = if long {
            n(p, "rsiOversold") - rs
        } else {
            rs - n(p, "rsiOverbought")
        };
        let score = (10.
            + 30. * clamp((ext.abs() - n(p, "entryExtAtr")) / 2.)
            + if rs_edge > 0. { 20. } else { 5. }
            + if reversal { 15. } else { 5. }
            + 15.
                * if ax.is_finite() {
                    clamp(1. - ax / 50.)
                } else {
                    0.5
                }
            + 10. * clamp(1. - (ap - 0.01).abs() / 0.02))
        .clamp(0., 100.)
        .round();
        let risk = (n(p, "stopAtr") * a).max(n(p, "minStopPct") * price);
        let (target, src) = if b(p, "tpToMean") {
            (mean, format!("mean=EMA{}", period("meanPeriod")))
        } else if n(p, "tpAtr") > 0. && n(p, "tpR") <= 0. {
            (
                price + direction * n(p, "tpAtr") * a,
                format!("tpAtr={}", n(p, "tpAtr")),
            )
        } else {
            (
                price + direction * n(p, "tpR") * risk,
                format!("tpR={}", n(p, "tpR")),
            )
        };
        (
            direction,
            metrics,
            score,
            target,
            src,
            json!({"mean":mean,"extension":ext,"atrPct":ap,"trendStrengthScore":score}),
        )
    } else {
        let fast = last(&ema(&c, period("emaFast")));
        let slow = last(&ema(&c, period("emaSlow")));
        let cp = period("channelPeriod");
        let vp = period("volPeriod");
        let channel = &r[r.len() - cp - 1..r.len() - 1];
        let high = channel
            .iter()
            .map(|r| n(r, "high"))
            .fold(f64::NEG_INFINITY, f64::max);
        let low = channel
            .iter()
            .map(|r| n(r, "low"))
            .fold(f64::INFINITY, f64::min);
        let volume: Vec<f64> = r[r.len() - vp - 1..r.len() - 1]
            .iter()
            .map(|r| n(r, "volume"))
            .collect();
        let vr = n(latest, "volume") / mean(&volume);
        let spread = (fast - slow) / a;
        let metrics = json!({"price":price,"emaFast":fast,"emaSlow":slow,"atr":a,"atrPct":ap,"channelHigh":high,"channelLow":low,"spreadAtr":spread,"rsi":rs,"adx":ax,"volumeRatio":vr});
        if ap < n(p, "minAtrPct") || ap > n(p, "maxAtrPct") {
            return hold(
                format!("4H ATR {:.3}% 越过波动率闸门。", ap * 100.),
                json!({"metrics":metrics}),
            );
        }
        let up = price > high + n(p, "breakoutBufAtr") * a;
        let down = price < low - n(p, "breakoutBufAtr") * a;
        let direction = if up && !down {
            1.
        } else if down && !up {
            -1.
        } else {
            0.
        };
        if direction == 0. {
            return hold(
                "4H 收盘未有效突破通道边界，本轮观望。".into(),
                json!({"metrics":metrics,"channel":{"channelHigh":high,"channelLow":low}}),
            );
        }
        let align = if direction > 0. {
            fast > slow && price > slow
        } else {
            fast < slow && price < slow
        };
        if (chandelier || b(p, "requireTrendAlign")) && !align {
            return hold(
                "突破方向与均线排列不一致，本轮观望。".into(),
                json!({"metrics":metrics}),
            );
        }
        if !chandelier && n(p, "trendSepAtr") > 0. && direction * spread < n(p, "trendSepAtr") {
            return hold(
                "均线间距低于门槛，趋势未成型。".into(),
                json!({"metrics":metrics}),
            );
        }
        if n(p, "adxMin") > 0. && (!ax.is_finite() || ax < n(p, "adxMin")) {
            return hold("ADX 低于趋势强度门槛。".into(), json!({"metrics":metrics}));
        }
        if n(p, "volumeMult") > 0. && (!vr.is_finite() || vr < n(p, "volumeMult")) {
            return hold(
                "量比低于门槛，本轮观望。".into(),
                json!({"metrics":metrics}),
            );
        }
        let (min, max) = if direction > 0. {
            (n(p, "rsiLongMin"), n(p, "rsiLongMax"))
        } else {
            (n(p, "rsiShortMin"), n(p, "rsiShortMax"))
        };
        if rs.is_finite() && (rs < min || rs > max) {
            return hold("RSI 不在方向允许区间。".into(), json!({"metrics":metrics}));
        }
        let edge = if direction > 0. {
            (price - high) / a
        } else {
            (low - price) / a
        };
        let score = (10.
            + 25.
                * clamp(if chandelier {
                    spread.abs() / 3.
                } else {
                    direction * spread / 3.
                })
            + 25. * clamp(edge / 1.5)
            + 15.
                * if vr.is_finite() {
                    clamp((vr - 0.8) / 1.2)
                } else {
                    0.5
                }
            + 15. * if ax.is_finite() { clamp(ax / 40.) } else { 0.4 }
            + 10. * clamp(1. - (ap - 0.01).abs() / 0.02))
        .clamp(0., 100.)
        .round();
        let risk = (n(p, "stopAtr") * a).max(n(p, "minStopPct") * price);
        let target = price
            + direction
                * if !chandelier && b(p, "tpByAtr") {
                    n(p, "tpAtr") * a
                } else {
                    n(p, "tpR") * risk
                };
        let src = if chandelier {
            format!("tpR={}(远端)+chandelier", n(p, "tpR"))
        } else if b(p, "tpByAtr") {
            format!("tpAtr={}", n(p, "tpAtr"))
        } else {
            format!("tpR={}", n(p, "tpR"))
        };
        let mut extra = json!({"channelHigh":high,"channelLow":low,"atrPct":ap,"spreadAtr":spread});
        if chandelier {
            extra["chandelier"] = json!({"enabled":p["chandelierEnabled"],"atrPeriod":p["chandelierAtrPeriod"],"mult":p["chandelierMult"],"scratchEnabled":p["scratchOnChannelReclose"],"scratchBufAtr":p["scratchBufAtr"],"channelHigh":high,"channelLow":low});
        }
        (direction, metrics, score, target, src, extra)
    };
    if direction > 0. && b(p, "shortOnly") {
        return hold(
            "多头信号被 shortOnly 拦截。".into(),
            json!({"metrics":metrics}),
        );
    }
    if direction < 0. && b(p, "longOnly") {
        return hold(
            "空头信号被 longOnly 拦截。".into(),
            json!({"metrics":metrics}),
        );
    }
    let plan = plan(
        direction,
        price,
        a,
        target,
        p,
        if reversion { Some(score) } else { None },
        target_source,
        extra,
    );
    if !sane(&plan, direction) {
        return hold(
            "计划几何非法，本轮观望。".into(),
            json!({"metrics":metrics}),
        );
    }
    let gate = if chandelier {
        price + direction * n(p, "tpGateR") * n(&plan, "riskUnit")
    } else {
        target
    };
    let entry = if direction > 0. {
        n(&plan, "entryMax")
    } else {
        n(&plan, "entryMin")
    };
    let rr = rr(
        entry,
        n(&plan, "stopLoss"),
        gate,
        n(p, "maxHoldBars"),
        &ctx["costs"],
    );
    if rr.1 < n(p, "minNetRr") {
        return hold(
            format!("成本后净盈亏比 {:.2} 低于门槛 {}。", rr.1, n(p, "minNetRr")),
            json!({"metrics":metrics,"rr":{"grossRr":rr.0,"netRr":rr.1}}),
        );
    }
    json!({"symbol":m["symbol"],"action":if direction>0.{"BUY"}else{"SELL"},"decision":if direction>0.{"LONG_ALLOWED"}else{"SHORT_ALLOWED"},"state":"ALLOWED","confidence":(score/100.).clamp(0.,0.95),"reason":format!("4H {}：评分 {score}，市价入场≈{price}，止损 {}，止盈 {target}，成本后 {:.2}R。",if reversion{"均值回归"}else if chandelier{"吊灯突破"}else{"趋势突破"},n(&plan,"stopLoss"),rr.1),"risk":"规则强度是信号分，不是胜率；使用已收盘 4H 数据。","score":score,"entryQuality":score,"metrics":metrics,"trend":trend,"plan":plan})
}
pub fn chandelier_review(order: &Value, market: &Value) -> Value {
    let long = order["direction"] == "OPEN_LONG";
    let price = n(order, "markPrice");
    let entry = timestamp(&order["entryAt"]);
    let snap = &order["plan"]["chandelier"];
    let hold = |reason: &str| json!({"action":"HOLD","reason":reason});
    if snap["enabled"] == false {
        return hold("吊灯止损未启用。");
    }
    let r: Vec<Value> = rows(market).into_iter().filter(finite_candle).collect();
    if r.is_empty() || price <= 0. || entry.is_none() {
        return hold("行情或订单数据不足，保留当前保护价格。");
    }
    let a = atr(&r, number(&snap["atrPeriod"], 22.).floor().max(2.) as usize);
    if !a.is_finite() || a <= 0. {
        return hold("吊灯 ATR 未就绪。");
    }
    let held: Vec<&Value> = r
        .iter()
        .filter(|r| n(r, "openTime") as i64 + 14_400_000 > entry.unwrap())
        .collect();
    if held.is_empty() {
        return hold("成交后尚无已收盘 4H。");
    }
    let current = tightest_stop(order, long);
    let high = number(&snap["channelHigh"], f64::NAN);
    let low = number(&snap["channelLow"], f64::NAN);
    if snap["scratchEnabled"] != false && high.is_finite() && low.is_finite() {
        let buf = n(snap, "scratchBufAtr").max(0.) * a;
        let close = n(r.last().unwrap(), "close");
        let failed = if long {
            close < high - buf
        } else {
            close > low + buf
        };
        let immediate = price * if long { 0.9995 } else { 1.0005 };
        if failed
            && if long {
                immediate > current
            } else {
                immediate < current
            }
        {
            return json!({"action":"UPDATE_PROTECTION","stopLoss":immediate,"takeProfit":order["plan"]["takeProfit"],"confidence":0.8,"reason":"假突破刮单：4H 收盘收回信号通道内，贴价止损次根开盘离场。"});
        }
    }
    let extreme = held
        .iter()
        .map(|r| n(r, if long { "high" } else { "low" }))
        .reduce(|a, x| if long { a.max(x) } else { a.min(x) })
        .unwrap();
    let mult = number(&snap["mult"], 3.).max(0.5);
    let stop = if long {
        extreme - mult * a
    } else {
        extreme + mult * a
    };
    if if long {
        stop <= current || stop >= price
    } else {
        stop >= current || stop <= price
    } {
        return hold("吊灯候选不紧于历史最紧或越过现价。");
    }
    json!({"action":"UPDATE_PROTECTION","stopLoss":stop,"takeProfit":order["plan"]["takeProfit"],"confidence":0.75,"reason":format!("吊灯止损：持仓极值 {extreme}，ATR {a}，倍数 {mult}。")})
}
