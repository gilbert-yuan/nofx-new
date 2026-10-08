use super::indicators::{finite_candle, skill_structure, skill_summary};
use super::{b, exit_rules, merge, n, rows, wait};
use crate::number;
use serde_json::{Value, json};
fn rounded(x: f64) -> f64 {
    (x * 10000.).round() / 10000.
}
fn view(s4: &Value, s1: &Value, s15: &Value) -> Value {
    json!({"4h":{"trend":s4["trend"],"highPattern":s4["highPattern"],"lowPattern":s4["lowPattern"]},"1h":{"trend":s1["trend"],"highPattern":s1["highPattern"],"lowPattern":s1["lowPattern"],"resistance":s1["resistance"],"support":s1["support"]},"15m":{"trend":s15["trend"],"chochBullish":s15["chochBullish"],"bosBullish":s15["bosBullish"],"chochBearish":s15["chochBearish"],"bosBearish":s15["bosBearish"],"failedBreakout":s15["failedBreakout"],"failedBreakdown":s15["failedBreakdown"]}})
}
fn trade_plan(long: bool, i: &Value, s4: &Value, s1: &Value, p: &Value, balance: f64) -> Value {
    let price = n(i, "price");
    let a = n(i, "atr");
    let vol = n(i, "atrPercentile");
    let target = n(p, "minRealRR").max(1.);
    let eb = n(p, "entryBufAtr").max(0.);
    let sb = n(p, "stopBufferAtr").max(0.);
    let min_stop = n(p, "minStopPct").max(0.);
    let support = n(if long { s1 } else { s4 }, "support");
    let resistance = n(if long { s4 } else { s1 }, "resistance");
    let support = if support > 0. && support < price {
        support
    } else {
        price - a * if long { 0.8 } else { 2. }
    };
    let resistance = if resistance > price {
        resistance
    } else {
        price + a * if long { 2. } else { 0.8 }
    };
    let (low, high) = if long {
        (support - a * eb * 0.6, price.min(support + a * eb))
    } else {
        (price.max(resistance - a * eb), resistance + a * eb * 0.6)
    };
    let entry = (low + high) / 2.;
    let stop = if long {
        (support - a * sb).min(entry - entry * min_stop)
    } else {
        (resistance + a * sb).max(entry + entry * min_stop)
    };
    let risk = (entry - stop).abs();
    if entry <= 0. || risk <= 0. {
        return Value::Null;
    }
    let sign = if long { 1. } else { -1. };
    let tp1 = if long {
        resistance.max(entry + risk)
    } else {
        support.min(entry - risk)
    };
    let tp2 = entry + sign * risk * target;
    let tp3 = entry + sign * risk * 3_f64.max(target + 1.);
    let threshold = n(p, "highVolatilityPercentile");
    let factor = if vol > threshold {
        0.5
    } else if vol > (threshold - 0.1).max(0.4) {
        0.7
    } else {
        1.
    };
    let adjusted = (n(p, "riskPerTrade") * factor).clamp(0., 0.02);
    let risk_amount = balance * adjusted;
    let pct = risk / entry;
    let notional = risk_amount / pct;
    let cap = n(p, "maxLeverage").max(1.);
    let lev = n(p, "defaultLeverage").max(1.);
    let budget = n(p, "riskBudgetPct");
    let requested = if budget > 0. {
        lev.min(budget / pct)
    } else {
        lev
    };
    let effective = requested.max(1.).min(cap);
    let liquidation = entry * (1. - sign / effective + sign * 0.005);
    json!({"entryMin":low,"entryMax":high,"entryLimit":entry,"secondaryZone":if long{[support-a,support-a*0.5]}else{[resistance+a*0.5,resistance+a]},"stopLoss":stop,"takeProfit":tp2,"takeProfit1":tp1,"takeProfit2":tp2,"takeProfit3":tp3,"riskReward":(tp2-entry).abs()/risk,"riskUnit":risk,"adjustedRisk":adjusted,"position":{"accountBalance":balance,"riskAmount":risk_amount,"stopDistancePercent":pct*100.,"notional":notional,"leverage":effective,"estimatedMargin":notional/effective},"liquidationSafety":{"estimatedLiquidationPrice":liquidation,"distanceFromStopPercent":sign*(stop-liquidation)/stop*100.,"stopBeforeEstimatedLiquidation":sign*(stop-liquidation)>0.,"note":"近似估算；实际强平价受保证金模式、维持保证金阶梯、费用及其他仓位影响。"},"recommendedLeverage":effective,"marginRiskPct":effective*pct})
}
pub fn analyze(long: bool, m: &Value, ctx: &Value) -> Value {
    let p = &ctx["params"];
    let aux = &ctx["auxMarkets"];
    let source15 = if aux["15m"].is_object() {
        &aux["15m"]
    } else if m["interval"] == "15m" {
        m
    } else {
        &Value::Null
    };
    let r15 = rows(source15);
    let r1 = rows(&aux["1h"]);
    let r4 = rows(&aux["4h"]);
    let r5 = rows(&aux["5m"]);
    let trend = json!({"interval":"15m","bars":{"5m":r5.len(),"15m":r15.len(),"1h":r1.len(),"4h":r4.len()},"dataAsOf":source15["dataAsOf"]});
    let mut missing = vec![];
    if r4.len() < 200 {
        missing.push("4h>=200");
    }
    if r1.len() < 50 {
        missing.push("1h>=50");
    }
    if r15.len() < 30 {
        missing.push("15m>=30");
    }
    if (b(p, "requireFiveMinute") || b(&ctx["skillContext"], "requireFiveMinute")) && r5.len() < 30
    {
        missing.push("5m>=30");
    }
    let quality = json!({"good":missing.is_empty(),"missing":missing});
    let hold = |reason: String, extra: Value| {
        merge(
            wait(m, reason, &trend, extra),
            json!({"quality":quality,"dataQuality":if missing.is_empty(){"GOOD"}else{"DEGRADED"}}),
        )
    };
    if b(p, "strictSkillData") && !missing.is_empty() {
        return hold(
            format!(
                "SKILL 所需市场数据不完整，保持 HOLD：{}",
                missing.join("、")
            ),
            json!({"missingData":missing}),
        );
    }
    for (tf, r, min) in [("15m", &r15, 30), ("1h", &r1, 30), ("4h", &r4, 10)] {
        if r.len() < min {
            return hold(
                format!("结构策略需要至少 {min} 根 {tf} K 线，实际 {} 根。", r.len()),
                json!({}),
            );
        }
    }
    if [&r15, &r1, &r4]
        .iter()
        .any(|r| !r.iter().all(finite_candle))
    {
        return hold("K 线存在坏打印（OHLC 非法），本轮 HOLD。".into(), json!({}));
    }
    let s4 = skill_structure(&r4);
    let s1 = skill_structure(&r1);
    let s15 = skill_structure(&r15);
    let i4 = skill_summary(&r4);
    let i1 = skill_summary(&r1);
    let i15 = skill_summary(&r15);
    let structure = view(&s4, &s1, &s15);
    if n(&i4, "atr") <= 0. || i4["ema20"].is_null() {
        return hold(
            "4H SKILL 指标未就绪（ATR/EMA20 无效），本轮 HOLD。".into(),
            json!({"structure":structure}),
        );
    }
    let price = n(&i4, "price");
    let a = n(&i4, "atr");
    let ext = (price - n(&i4, "ema20")) / a;
    let high_vol = n(p, "highVolatilityPercentile");
    let vol = n(&i4, "atrPercentile");
    let regime = if vol > high_vol {
        "HIGH_VOLATILITY"
    } else if s4["trend"] == "BULLISH"
        && n(&i4, "ema20") > n(&i4, "ema50")
        && n(&i4, "ema50") > n(&i4, "ema200")
    {
        "TREND_UP"
    } else if s4["trend"] == "BEARISH"
        && n(&i4, "ema20") < n(&i4, "ema50")
        && n(&i4, "ema50") < n(&i4, "ema200")
    {
        "TREND_DOWN"
    } else if vol < 0.2 {
        "LOW_VOLATILITY"
    } else {
        "RANGE"
    };
    let near_s =
        !s1["support"].is_null() && (price - n(&s1, "support")).abs() <= n(p, "nearLevelAtr") * a;
    let near_r = !s1["resistance"].is_null()
        && (price - n(&s1, "resistance")).abs() <= n(p, "nearLevelAtr") * a;
    let choch = b(&s15, if long { "chochBullish" } else { "chochBearish" });
    let bos = b(&s15, if long { "bosBullish" } else { "bosBearish" });
    let confirmed = choch && bos;
    let failed = b(
        &s15,
        if long {
            "failedBreakdown"
        } else {
            "failedBreakout"
        },
    );
    let near = if long { near_s } else { near_r };
    let sign = if long { 1. } else { -1. };
    let ema_align = sign * (price - n(&i4, "ema20")) > 0.
        && sign * (n(&i4, "ema20") - n(&i4, "ema50")) > 0.
        && sign * (n(&i4, "ema50") - n(&i4, "ema200")) > 0.;
    let target_trend = if long { "BULLISH" } else { "BEARISH" };
    let mut reasons = vec![];
    let mut score: f64 = 0.;
    for (pass, points, text) in [
        (
            s4["trend"] == target_trend,
            20.,
            if long {
                "4H形成HH+HL"
            } else {
                "4H形成LH+LL"
            },
        ),
        (
            s1["trend"] == target_trend,
            15.,
            if long {
                "1H多头结构"
            } else {
                "1H空头结构"
            },
        ),
        (confirmed, 10., "15m CHOCH+BOS确认"),
        (
            near || failed,
            10.,
            if long {
                "价格接近支撑或出现假跌破"
            } else {
                "价格接近阻力或出现假突破"
            },
        ),
        (
            ema_align,
            10.,
            if long {
                "EMA多头排列"
            } else {
                "EMA空头排列"
            },
        ),
        (
            n(&i4, "volumeRatio") > n(p, "volumeRatioMin"),
            10.,
            "放量确认",
        ),
    ] {
        if pass {
            score += points;
            reasons.push(text);
        }
    }
    let balance = [
        &ctx["account"]["equity"],
        &ctx["account"]["balance"],
        &ctx["state"]["initialBalance"],
        &ctx["balance"],
    ]
    .iter()
    .map(|x| if x.is_null() { 0. } else { number(x, f64::NAN) })
    .find(|x| x.is_finite())
    .unwrap_or(10000.);
    // Undefined account fields do not become zero in the legacy adapter.
    let balance = if [
        &ctx["account"]["equity"],
        &ctx["account"]["balance"],
        &ctx["state"]["initialBalance"],
        &ctx["balance"],
    ]
    .iter()
    .all(|x| x.is_null())
    {
        10000.
    } else {
        balance
    };
    let plan = trade_plan(long, &i4, &s4, &s1, p, balance);
    if plan.is_null() {
        return hold(
            "SKILL 无法建立有效入场/止损计划，本轮 HOLD。".into(),
            json!({"structure":structure,"score":score}),
        );
    }
    if n(&plan, "riskReward") >= 3. {
        score += 10.;
    } else if n(&plan, "riskReward") >= 2. {
        score += 7.;
    }
    score = score.clamp(0., 100.);
    let rsi = n(&i4, "rsi");
    let rsi_extreme = if long {
        rsi > n(p, "rsiExtreme")
    } else {
        rsi < 100. - n(p, "rsiExtreme")
    };
    let mut quality_score: f64 = 50.;
    if near {
        quality_score += 15.;
    }
    if choch {
        quality_score += 12.;
    }
    if bos {
        quality_score += 8.;
    }
    if failed {
        quality_score += 10.;
    }
    if sign * ext > n(p, "extendedAtr") {
        quality_score -= 35.;
    }
    if sign * ext > n(p, "extremeAtr") {
        quality_score -= 20.;
    }
    if rsi_extreme {
        quality_score -= 20.;
    }
    if vol > high_vol {
        quality_score -= 15.;
    }
    quality_score = quality_score.clamp(0., 100.);
    let min_score = n(
        p,
        if long {
            "bullishScoreMin"
        } else {
            "bearishScoreMin"
        },
    );
    let mut decision = if long {
        "LONG_ALLOWED"
    } else {
        "SHORT_ALLOWED"
    };
    let mut state = if long {
        "LONG_TRIGGERED"
    } else {
        "SHORT_TRIGGERED"
    };
    let mut blockers = vec![];
    if regime == if long { "TREND_DOWN" } else { "TREND_UP" } {
        decision = "HOLD";
        state = "NO_SETUP";
        blockers.push(if long {
            "4H强下跌趋势".to_owned()
        } else {
            "4H强上涨趋势".to_owned()
        });
    } else if score < min_score {
        decision = "HOLD";
        state = "NO_SETUP";
        blockers.push(format!(
            "{}评分不足{min_score}",
            if long { "多头" } else { "空头" }
        ));
    } else if sign * ext >= n(p, "extendedAtr") || quality_score < n(p, "entryQualityMin") {
        decision = "WAIT_FOR_PULLBACK";
        state = "WAITING_PULLBACK";
        blockers.push(if long {
            "当前位置不适合追涨".into()
        } else {
            "当前位置不适合追空".into()
        });
    } else if n(&plan, "riskReward") < n(p, "minRealRR") {
        decision = "HOLD";
        state = "NO_SETUP";
        blockers.push(format!("预期盈亏比低于1:{}", n(p, "minRealRR")));
    } else if !confirmed {
        decision = "WAIT_FOR_CONFIRMATION";
        state = "WAITING_CONFIRMATION";
        blockers.push("等待15m CHOCH+BOS".into());
    }
    let mut risks = vec![];
    if vol > (high_vol - 0.1).max(0.8) {
        risks.push("波动率偏高，应降低仓位");
    }
    if rsi_extreme {
        risks.push(if long {
            "RSI超买，存在回调风险"
        } else {
            "RSI超卖，存在反弹风险"
        });
    }
    let allowed = decision
        == if long {
            "LONG_ALLOWED"
        } else {
            "SHORT_ALLOWED"
        };
    let name = if long { "做多" } else { "做空" };
    let plan_meta = merge(
        plan.clone(),
        json!({"maxHoldBars":n(p,"maxHoldBars").round(),"riskPerTrade":p["riskPerTrade"],"maxDailyLoss":p["maxDailyLoss"],"extremeAtr":p["extremeAtr"],"exitRules":exit_rules(p)}),
    );
    let mut result = json!({"symbol":m["symbol"],"action":if allowed{if long{"BUY"}else{"SELL"}}else{"WAIT"},"decision":decision,"state":state,"confidence":if allowed{(score/100.).clamp(0.,0.95)}else{0.},"score":score,"entryQuality":quality_score,"dataQuality":if missing.is_empty(){"GOOD"}else{"DEGRADED"},"quality":quality,"reason":format!("{name}（4H→1H→15m）：{}；评分 {score}/100、入场质量 {quality_score}/100、4H RSI {rsi:.1}、距 4H EMA20 {ext:.2}×ATR；SKILL {}开仓条件{}。",reasons.join("；"),if allowed{"满足"}else{"未满足"},if blockers.is_empty(){String::new()}else{format!("（{}）",blockers.join("；"))}),"risk":format!("结构{name}（SKILL parity）：4H 定方向、1H 定位置、15m 定确认；按止损风险计算仓位，不追势。 {}",risks.join("；")),"marketRegime":regime,"currentPrice":rounded(price),"secondaryZone":plan["secondaryZone"],"confirmationRequired":"15m CHOCH + BOS + Retest","stopLoss":plan["stopLoss"],"tp1":plan["takeProfit1"],"tp2":plan["takeProfit2"],"tp3":plan["takeProfit3"],"riskReward":plan["riskReward"],"suggestedRisk":format!("{:.2}%",n(&plan,"adjustedRisk")*100.),"position":plan["position"],"liquidationSafety":plan["liquidationSafety"],"invalidation":format!("1H/4H收盘有效{} {}",if long{"跌破"}else{"突破"},rounded(n(&plan,"stopLoss"))),"indicators":{"4h":i4,"1h":i1,"15m":i15},"structure":structure,"mainReasons":reasons,"blockers":blockers,"risks":risks,"trend":trend,"plan":if allowed{plan_meta}else{Value::Null}});
    if long {
        result["bullishProbability"] = json!(score);
        result["doNotChaseAbove"] = json!(rounded(n(&i4, "ema20") + n(p, "extendedAtr") * a));
        result["primaryLongZone"] = json!([plan["entryMin"], plan["entryMax"]]);
    } else {
        result["bearishProbability"] = json!(score);
        result["doNotChaseBelow"] = json!(rounded(n(&i4, "ema20") - n(p, "extendedAtr") * a));
        result["primaryShortZone"] = json!([plan["entryMin"], plan["entryMax"]]);
    }
    result
}
