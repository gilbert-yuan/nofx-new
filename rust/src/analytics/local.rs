use super::*;

fn rows(market: &Value) -> &[Value] {
    market["klines"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn valid(rows: &[Value]) -> bool {
    rows.len() >= 50
        && rows.iter().all(|r| {
            ["open", "high", "low", "close"]
                .iter()
                .all(|k| r[*k].as_f64().is_some_and(|v| v.is_finite() && v > 0.0))
                && num(r, "low") <= num(r, "open").min(num(r, "close"))
                && num(r, "high") >= num(r, "open").max(num(r, "close"))
        })
}
fn mean(rows: &[Value], period: usize) -> f64 {
    rows[rows.len() - period..]
        .iter()
        .map(|v| num(v, "close"))
        .sum::<f64>()
        / period as f64
}
fn atr(rows: &[Value]) -> f64 {
    rows[rows.len() - 14..]
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let previous = num(&rows[rows.len() - 15 + i], "close");
            (num(v, "high") - num(v, "low"))
                .max((num(v, "high") - previous).abs())
                .max((num(v, "low") - previous).abs())
        })
        .sum::<f64>()
        / 14.0
}
fn env_num(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}
fn long_only() -> bool {
    std::env::var("NOFX_LONG_ONLY")
        .ok()
        .is_some_and(|s| matches!(s.to_lowercase().trim(), "true" | "1" | "yes"))
}
fn limit(close: f64, atr: f64, long: bool, proxy: f64) -> f64 {
    let floor = env_num("NOFX_SCORE_FLOOR", 70.0);
    let ceil = env_num("NOFX_SCORE_CEIL", 100.0);
    let score = (floor + (proxy - 0.3) * 20.0).max(floor).min(ceil);
    let t = if ceil > floor {
        ((score - floor) / (ceil - floor)).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let depth = env_num("NOFX_PULLBACK_ATR_DEEP", 1.5)
        + (env_num("NOFX_PULLBACK_ATR_SHALLOW", 0.3) - env_num("NOFX_PULLBACK_ATR_DEEP", 1.5)) * t;
    close + if long { -depth * atr } else { depth * atr }
}
fn plan(close: f64, atr: f64, long: bool, proxy: f64, stop: f64, target: f64, hold: f64) -> Value {
    let min = close - atr * 0.35;
    let max = close + atr * 0.35;
    let entry = limit(close, atr, long, proxy);
    let sl = if long {
        min - atr * stop
    } else {
        max + atr * stop
    };
    json!({"entryMin":min,"entryMax":max,"entryLimit":entry,"stopLoss":sl,"takeProfit":if long{max+atr*target}else{min-atr*target},"riskUnit":(entry-sl).abs(),"maxHoldBars":hold})
}
pub fn local_analysis(market: &Value) -> Value {
    let rows = rows(market);
    let wait = |reason: &str| json!({"symbol":market["symbol"],"action":"WAIT","confidence":0,"reason":reason,"risk":"本地规则仅使用均线和波动率，不代表盈利保证。","plan":null});
    if !valid(rows) {
        return wait("本地规则需要至少 50 根有效的已收盘 K 线。");
    }
    let fast = mean(rows, 20);
    let slow = mean(rows, 50);
    let close = num(rows.last().unwrap(), "close");
    let a = atr(rows);
    if a <= 0.0 || a / close > 0.08 || a / close < 0.0005 || (fast - slow).abs() < a * 0.3 {
        return wait("趋势不清晰或波动异常（过大或过小），暂不生成开仓计划。");
    }
    let long = fast > slow;
    if if long { close < fast } else { close > fast } {
        return wait("价格与均线趋势不一致，等待确认。");
    }
    if long_only() && !long {
        return wait("当前配置 NOFX_LONG_ONLY 已启用，仅允许做多。");
    }
    if (close - fast).abs() / a > 1.0 {
        return wait("价格偏离20均线超过1 ATR，等待回归确认，避免追涨杀跌。");
    }
    json!({"symbol":market["symbol"],"action":if long{"BUY"}else{"SELL"},"confidence":(0.65+(fast-slow).abs()/a*0.03).min(0.85),"reason":format!("本地规则：20 根均线{}50 根均线，收盘价与趋势同向。",if long{"高于"}else{"低于"}),"risk":"均线趋势可能反转；以 14 根平均真实波幅设置保护价格。规则分数不是胜率。","plan":plan(close,a,long,(fast-slow).abs()/a,2.5,4.0,120.0)})
}
pub fn local_multi(market: &Value, aux: &Value, adaptive: &Value) -> Value {
    let rows = rows(market);
    let wait = |reason: &str| json!({"symbol":market["symbol"],"action":"WAIT","confidence":0,"reason":reason,"risk":"多周期规则使用均线和波动率，不代表盈利保证。","plan":null});
    if !valid(rows) {
        return wait("主周期需要至少 50 根有效的已收盘 K 线。");
    }
    let fast = mean(rows, 20);
    let slow = mean(rows, 50);
    let close = num(rows.last().unwrap(), "close");
    let a = atr(rows);
    if a <= 0.0 || a / close > 0.08 || a / close < 0.0005 {
        return wait("主周期波动异常（过大或过小），ATR计算失败或死水行情。");
    }
    if (fast - slow).abs() < a * 0.3 {
        return wait("主周期趋势不清晰。");
    }
    let long = fast > slow;
    let trend = if long { "long" } else { "short" };
    if if long { close < fast } else { close > fast } {
        return wait("主周期价格与均线趋势不一致。");
    }
    if (close - fast).abs() / a > 1.0 {
        return wait("价格偏离20均线超过1 ATR，等待回落确认，避免追涨。");
    }
    let mut analysis = json!({});
    for interval in ["15m", "1h", "4h"] {
        let data = if market["interval"] == interval {
            market
        } else {
            &aux[interval]
        };
        let candles = super::local::rows(data);
        if !valid(candles) {
            analysis[interval] = json!({"trend":"unknown","reason":"数据不足"});
            continue;
        }
        let af = mean(candles, 20);
        let asl = mean(candles, 50);
        let ac = num(candles.last().unwrap(), "close");
        let aa = atr(candles);
        if aa <= 0.0 || aa / ac > 0.08 {
            analysis[interval] = json!({"trend":"unknown","reason":"波动过大"});
            continue;
        }
        let al = af > asl;
        let strength = (af - asl).abs() / aa;
        analysis[interval] = json!({"trend":if al{"long"}else{"short"},"strength":strength,"aligned":if al{ac>=af}else{ac<=af},"reason":format!("{}趋势，强度{strength:.2}",if al{"上升"}else{"下降"})});
    }
    let aligned = ["1h", "4h"]
        .iter()
        .filter(|i| analysis[**i]["trend"] == trend)
        .count();
    let strong = ["1h", "4h"]
        .iter()
        .filter(|i| {
            analysis[**i]["trend"] == trend
                && analysis[**i]["aligned"] == true
                && num(&analysis[**i], "strength") > 0.5
        })
        .count();
    if strong != 2 {
        return wait(
            "需要1小时和4小时均同向、价格与趋势一致且趋势强度超过0.5 ATR；数据不足或冲突时等待。",
        );
    }
    if analysis["15m"]["trend"] != trend
        || analysis["15m"]["aligned"] != true
        || num(&analysis["15m"], "strength") <= 0.3
    {
        return wait("15分钟趋势未确认或数据不足，等待。");
    }
    if long_only() && !long {
        return wait("当前配置 NOFX_LONG_ONLY 已启用，仅允许做多。");
    }
    let stop = number(&adaptive["stopLossATR"], 2.5).clamp(1.0, 3.5);
    let requested = number(&adaptive["takeProfitATR"], 4.0).clamp(1.5, 6.0);
    let target = requested.max((1.25 * (stop + 0.7) * 100.0).round() / 100.0);
    let hold = number(&adaptive["maxHoldBars"], 120.0)
        .round()
        .clamp(1.0, 200.0);
    let reason = format!(
        "主周期：20MA{}50MA；15分钟：{}；1小时：{}；4小时：{}；共振度：{aligned}/2个高级周期一致",
        if long { ">" } else { "<" },
        text(&analysis["15m"], "reason", "无数据"),
        text(&analysis["1h"], "reason", "无数据"),
        text(&analysis["4h"], "reason", "无数据")
    );
    let adapt = text(adaptive, "reason", "");
    json!({"symbol":market["symbol"],"action":if long{"BUY"}else{"SELL"},"confidence":(0.65+(fast-slow).abs()/a*0.03+aligned as f64*0.05+strong as f64*0.05).min(0.95),"reason":if adapt.is_empty(){format!("多周期分析：{reason}")}else{format!("多周期分析：{reason}\n自适应调整：{adapt}")},"risk":"多周期过滤效果需要独立验证；止损止盈基于主周期ATR设置，规则分数不是胜率。","multiTimeframeAnalysis":analysis,"adaptiveParamsUsed":{"stopLossATR":stop,"takeProfitATR":target,"maxHoldBars":hold,"confidence":num(adaptive,"confidence"),"targetAdjustedForRisk":target!=requested},"plan":plan(close,a,long,(fast-slow).abs()/a,stop,target,hold)})
}
pub fn recommended_leverage(plan: &Value, direction: &str, limits: &Value) -> f64 {
    let entry = if num(plan, "entryLimit") > 0.0 {
        num(plan, "entryLimit")
    } else if direction == "OPEN_LONG" {
        num(plan, "entryMax")
    } else {
        num(plan, "entryMin")
    };
    let distance = (entry - num(plan, "stopLoss")).abs() / entry;
    if !distance.is_finite() || distance <= 0.0 {
        return 1.0;
    }
    let max = number(&limits["maxLeverage"], env_num("NOFX_MAX_LEVERAGE", 5.0));
    let budget = number(
        &limits["riskBudgetPct"],
        env_num("NOFX_RISK_BUDGET_PCT", 0.1),
    );
    (budget / distance).floor().min(max).max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_aux_is_wait() {
        let rows: Vec<Value> = (0..60)
            .map(|i| {
                let close = 100.0 + i as f64 * 0.01;
                json!({"open":close,"high":close+1.0,"low":close-1.0,"close":close})
            })
            .collect();
        let m = json!({"symbol":"BTCUSDT","interval":"1m","klines":rows});
        assert_eq!(local_multi(&m, &json!({}), &json!({}))["action"], "WAIT");
    }
    #[test]
    fn invalid_geometry_is_wait() {
        let rows: Vec<Value> = (0..50)
            .map(|_| json!({"open":100,"high":99,"low":98,"close":100}))
            .collect();
        assert_eq!(local_analysis(&json!({"klines":rows}))["action"], "WAIT");
    }
}
