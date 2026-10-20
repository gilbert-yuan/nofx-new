//! A causal, long-only crypto adaptation of Martin Luk's strong-stock pullbacks.
//! The 4h/15m timeframes and mechanical setup definitions are project choices,
//! not a claim to reproduce his discretionary stock trading exactly.
use super::indicators::{atr, closes, ema, finite_candle, last, mean};
use super::{b, merge, n, rows, wait};
use crate::{iso, number, timestamp};
use serde_json::{Value, json};

const ENTRY_MS: i64 = 900_000;
const TREND_MS: i64 = 14_400_000;

fn period(p: &Value, key: &str) -> usize {
    n(p, key).floor().max(1.) as usize
}

fn feed<'a>(m: &'a Value, ctx: &'a Value, tf: &str) -> &'a Value {
    // Position review supplies a shorter main window plus the full auxiliary
    // windows. Keep pending re-analysis on the same history as initial scans.
    if ctx["auxMarkets"][tf].is_object() {
        &ctx["auxMarkets"][tf]
    } else if m["interval"] == tf {
        m
    } else {
        &ctx["auxMarkets"][tf]
    }
}

// A timestamped decision is required. Future/unconfirmed bars are excluded;
// holes or stale closed data fail closed instead of changing the indicator clock.
fn closed(feed: &Value, duration: i64, now: i64) -> Option<Vec<Value>> {
    let mut result = Vec::new();
    for row in rows(feed) {
        let open = timestamp(&row["openTime"])?;
        if row["confirmed"] == false || open.checked_add(duration)? > now {
            continue;
        }
        let volume = number(&row["volume"], f64::NAN);
        if open.rem_euclid(duration) != 0
            || !finite_candle(&row)
            || !volume.is_finite()
            || volume < 0.
            || result.last().is_some_and(|previous: &Value| {
                timestamp(&previous["openTime"]) != Some(open - duration)
            })
        {
            return None;
        }
        result.push(row);
    }
    let end = timestamp(&result.last()?["openTime"])? + duration;
    (end == now.div_euclid(duration) * duration).then_some(result)
}

fn exit_rules(p: &Value) -> Value {
    // Disable the enhanced engine's inherited SMA/RSI exits and R ladder.
    // This strategy owns its EMA close exit; fills/costs/partials stay shared.
    json!({
        "trailing":{"triggerR":1_000_000,"profitTriggerPct":1_000_000,
            "extendTpAtr":0,"lockMinRoomAtr":0,"useBreakEven":false,
            "breakEvenFloorAtr":0,"breakEvenCostBufferBps":0,
            "ladder":[{"atR":0,"trailR":1_000_000,"lockR":0}]},
        "smartExit":{"enabled":false,"barLevelEnabled":false,"barLevel":false,
            "maPeriod":9,"atrPeriod":14,"maBreakAtr":0,"maExitMaxProfitR":0,
            "tpMinR":0,"minHoldBars":0},
        "partialTp":{"enabled":b(p,"partialTpEnabled"),
            "tp1R":p["partialTp1R"],"tp2R":p["partialTp2R"],
            "tp1ClosePct":p["partialTp1ClosePct"],"tp2ClosePct":p["partialTp2ClosePct"],
            "moveStopToBreakEven":false}
    })
}

fn support_cluster(bar: &Value, levels: [f64; 3], tolerance: f64) -> Vec<f64> {
    let mut candidates: Vec<f64> = levels
        .into_iter()
        .filter(|level| n(bar, "low") <= level + tolerance && n(bar, "high") >= level - tolerance)
        .collect();
    candidates.sort_by(f64::total_cmp);
    let mut best = Vec::new();
    for (start, &level) in candidates.iter().enumerate() {
        let cluster: Vec<f64> = candidates[start..]
            .iter()
            .copied()
            .take_while(|next| next - level <= 2. * tolerance)
            .collect();
        if cluster.len() >= best.len() {
            best = cluster;
        }
    }
    best
}

pub fn analyze(m: &Value, ctx: &Value) -> Value {
    let p = &ctx["params"];
    let hold = |reason: &str, metrics: Value| {
        wait(
            m,
            reason,
            &json!({"interval":"4h"}),
            json!({"metrics":metrics}),
        )
    };
    let fast = period(p, "emaFast");
    let medium = period(p, "emaMedium");
    let slow = period(p, "emaSlow");
    if !(fast < medium && medium < slow)
        || n(p, "minStopPct") > n(p, "maxStopPct")
        || n(p, "exitMinHoldBars") >= n(p, "maxHoldBars")
        || (b(p, "partialTpEnabled")
            && (n(p, "partialTp1R") >= n(p, "partialTp2R")
                || n(p, "partialTp2R") >= n(p, "targetR")))
    {
        return hold(
            "参数冲突：检查 EMA 顺序、止损范围、持有期限和止盈档位。",
            json!({}),
        );
    }
    let Some(now) = timestamp(&ctx["evaluationAt"]).or_else(|| timestamp(&m["dataAsOf"])) else {
        return hold("缺少决策时间，无法确认已收盘行情。", json!({}));
    };
    let (Some(higher), Some(entry)) = (
        closed(feed(m, ctx, "4h"), TREND_MS, now),
        closed(feed(m, ctx, "15m"), ENTRY_MS, now),
    ) else {
        return hold("4h/15m 行情缺失、过期或存在无效 K 线。", json!({}));
    };
    let momentum_bars = period(p, "momentumBars");
    let days = period(p, "adrDays");
    let atr_period = period(p, "atrPeriod");
    if higher.len() < (slow + 1).max(momentum_bars + 1).max(days * 6)
        || entry.len() <= atr_period.max(fast) + 1
    {
        return hold("4h/15m 预热数据不足。", json!({}));
    }
    let prices = closes(&higher);
    let ef = ema(&prices, fast);
    let em = ema(&prices, medium);
    let es = ema(&prices, slow);
    let i = higher.len() - 1;
    let momentum = prices[i] / prices[i - momentum_bars] - 1.;
    // Non-overlapping six-bar blocks ending at the latest closed 4h bar.
    // This is a rolling 24h range proxy, deliberately not calendar-day ADR.
    let adr = mean(
        &higher[higher.len() - days * 6..]
            .chunks_exact(6)
            .map(|block| {
                let high = block.iter().map(|r| n(r, "high")).fold(0., f64::max);
                let low = block
                    .iter()
                    .map(|r| n(r, "low"))
                    .fold(f64::INFINITY, f64::min);
                high / low - 1.
            })
            .collect::<Vec<_>>(),
    );
    let mut metrics = json!({"emaFast":ef[i],"emaMedium":em[i],"emaSlow":es[i],
        "momentumPct":momentum,"adrPct":adr,"adrKind":"rolling_6x4h_range",
        "trendInterval":"4h","entryInterval":"15m"});
    if !(ef[i] > em[i] && em[i] > es[i] && ef[i] > ef[i - 1] && em[i] > em[i - 1])
        || prices[i] < em[i]
        || momentum < n(p, "minMomentumPct")
        || adr < n(p, "minAdrPct")
    {
        return hold(
            "4h 强势趋势、动量或 24h 波幅未达门槛，仅等待强势标的回调。",
            metrics,
        );
    }
    let peak_start = higher.len().saturating_sub(period(p, "peakLookback"));
    let peak_index = (peak_start..higher.len())
        .max_by(|&a, &b| n(&higher[a], "high").total_cmp(&n(&higher[b], "high")))
        .unwrap();
    let anchor = timestamp(&higher[peak_index]["openTime"]).unwrap();
    let peak_end = anchor + TREND_MS;
    let first_entry = timestamp(&entry[0]["openTime"]).unwrap();
    if first_entry > anchor || now < peak_end + ENTRY_MS {
        return hold("需要完整的峰值 K 线及其后的 15m 回调数据。", metrics);
    }
    let elapsed = (now.div_euclid(ENTRY_MS) * ENTRY_MS - peak_end) / ENTRY_MS;
    if elapsed > period(p, "maxPullbackBars") as i64 {
        return hold("本波段高点已超出首次回调等待窗口。", metrics);
    }
    metrics["anchorAt"] = json!(iso(anchor));
    metrics["peakPrice"] = higher[peak_index]["high"].clone();

    let mut pv = 0.;
    let mut volume = 0.;
    let mut episodes = 0;
    let mut touching = false;
    let mut last_touch = None;
    let mut pullback_low = f64::INFINITY;
    let mut reclaimed_level = f64::NAN;
    let mut latest_avwap = f64::NAN;
    let mut latest_atr = f64::NAN;
    for (j, bar) in entry.iter().enumerate() {
        let open = timestamp(&bar["openTime"]).unwrap();
        if open < anchor {
            continue;
        }
        let v = n(bar, "volume");
        pv += (n(bar, "high") + n(bar, "low") + n(bar, "close")) / 3. * v;
        volume += v;
        if volume <= 0. {
            continue;
        }
        latest_avwap = pv / volume;
        if open < peak_end {
            continue;
        }
        let end = open + ENTRY_MS;
        let hi = higher.partition_point(|r| timestamp(&r["openTime"]).unwrap() + TREND_MS <= end);
        if hi == 0 || !ef[hi - 1].is_finite() || !em[hi - 1].is_finite() {
            continue;
        }
        let a = atr(&entry[..=j], atr_period);
        if !a.is_finite() || a <= 0. {
            continue;
        }
        latest_atr = a;
        let tolerance = n(p, "supportToleranceAtr") * a;
        let levels = support_cluster(bar, [ef[hi - 1], em[hi - 1], latest_avwap], tolerance);
        let contact = levels.len() >= period(p, "minConfluence");
        if contact {
            if !touching {
                episodes += 1;
            }
            last_touch = Some(j);
            reclaimed_level = levels.iter().copied().fold(0., f64::max);
        } else if touching {
            // 离开支撑簇：下一段回踩从这里重新起算。否则允许多次回踩后
            // pullback_low 会累计整段结构的最低点，止损越拖越宽，反被
            // "深度跌穿"/"止损距离" 闸门吃掉。
            pullback_low = f64::INFINITY;
        }
        touching = contact;
        if episodes > 0 {
            pullback_low = pullback_low.min(n(bar, "low"));
        }
    }
    metrics["avwap"] = json!(latest_avwap);
    metrics["atr"] = json!(latest_atr);
    metrics["pullbackEpisodes"] = json!(episodes);
    metrics["pullbackLow"] = json!(pullback_low);
    if !latest_atr.is_finite() || !latest_avwap.is_finite() {
        return hold("回调 ATR 或峰值锚定 AVWAP 无效，等待有效成交量。", metrics);
    }
    // 原版只允许"恰好一次"支撑接触，只要回踩过一次就永久失效；真实趋势里常见的
    // "回踩→反弹失败→再回踩→才启动"会整段错过。改为允许第 N 次回踩，但"最后接触
    // 必须紧邻"这条保留——它才是保证入场及时性的部分。
    let max_episodes = period(p, "maxPullbackEpisodes").max(1);
    metrics["maxPullbackEpisodes"] = json!(max_episodes);
    if episodes == 0 {
        return hold("尚未出现连续支撑接触，等待首次回调。", metrics);
    }
    if episodes > max_episodes {
        let reason = format!("回踩次数 {episodes} 已超出允许上限 {max_episodes}，放弃本轮。");
        return hold(&reason, metrics.clone());
    }
    // 支撑接触后必须在 confirmWithinBars 根内给出转强确认，否则这次接触作废。
    // 原版硬编码 2 根（30 分钟），对"接触后横盘一两小时再启动"的走法过于苛刻。
    let confirm = period(p, "confirmWithinBars").max(1);
    if last_touch.is_none_or(|j| j + confirm < entry.len()) {
        return hold("支撑接触已不紧邻，等待新的转强确认。", metrics);
    }
    let bar = entry.last().unwrap();
    let price = n(bar, "close");
    let local_ema = last(&ema(&closes(&entry), fast));
    if pullback_low < reclaimed_level - n(p, "maxSupportBreakAtr") * latest_atr {
        return hold("回调已深度跌穿支撑簇，放弃本轮。", metrics);
    }
    if price <= n(bar, "open")
        || price <= n(&entry[entry.len() - 2], "high")
        || price < reclaimed_level
        || price < local_ema
    {
        return hold("15m 尚未阳线收复支撑并突破前一根高点。", metrics);
    }
    if price - reclaimed_level > n(p, "maxChaseAtr") * latest_atr {
        return hold("确认价格离支撑过远，避免追涨。", metrics);
    }
    let stop =
        (pullback_low - n(p, "stopBufferAtr") * latest_atr).min(price * (1. - n(p, "minStopPct")));
    let band = (latest_atr * n(p, "entryBandAtr")).min((price - stop) * 0.1);
    let entry_max = price + band;
    let risk = entry_max - stop;
    let stop_pct = risk / entry_max;
    if stop <= 0.
        || stop >= price - band
        || stop_pct > n(p, "maxStopPct").min(adr * n(p, "maxStopAdrFraction"))
    {
        return hold(
            "结构止损距离超过百分比或波幅约束，不压缩止损强行开仓。",
            metrics,
        );
    }
    let target = entry_max + risk * n(p, "targetR");
    let costs = &ctx["costs"];
    let fee = number(&costs["feeBps"], 6.) / 10_000.;
    let slip = number(&costs["slippageBps"], 5.) / 10_000.;
    let funding =
        number(&costs["fundingBpsPer8h"], 3.) / 10_000. * n(p, "maxHoldBars") * ENTRY_MS as f64
            / 28_800_000.;
    let cost = entry_max * (2. * (fee + slip) + funding);
    let net_rr = (target - entry_max - cost) / (risk + cost);
    metrics["stopDistancePct"] = json!(stop_pct);
    metrics["netRewardRisk"] = json!(net_rr);
    if !net_rr.is_finite() || net_rr < n(p, "minNetRr") {
        return hold("预计成本后盈亏比不足。", metrics);
    }
    // Submission re-evaluates these hard limits against current account equity
    // and the final execution geometry, even if generic score sizing intervenes.
    let margin_pct =
        (n(p, "riskPerTrade") / (stop_pct + cost / entry_max)).min(n(p, "maxNotionalPct"));
    let plan = json!({"entryStyle":"market","entryReference":price,
        "entryMin":price-band,"entryMax":entry_max,"stopLoss":stop,
        "takeProfit":target,"riskUnit":risk,"maxHoldBars":n(p,"maxHoldBars").floor(),
        "recommendedLeverage":1,"autoMarginPct":margin_pct,
        "maxPositions":n(p,"maxPositions").floor(),"exitRules":exit_rules(p),
        "riskSizing":{"riskFraction":p["riskPerTrade"],
            "maxNotionalFraction":p["maxNotionalPct"],"maxLeverage":1},
        "martinLukExit":{"emaPeriod":p["exitEmaPeriod"],"minHoldBars":p["exitMinHoldBars"]},
        "setup":{"anchorAt":iso(anchor),"peakPrice":higher[peak_index]["high"],
            "avwap":latest_avwap,"support":reclaimed_level,"pullbackLow":pullback_low}});
    merge(
        json!({"symbol":m["symbol"],"action":"BUY","decision":"LONG_ALLOWED",
        "state":"ALLOWED","confidence":0.8,"confidenceType":"rule_strength",
        "maxHoldBarsLimit":1000,"pendingOrderTtlMs":3*ENTRY_MS,
        "recommendedLeverage":1,"score":80,
        "reason":"Martin Luk 本地适配：4h 强势趋势，首次回调支撑簇，15m 收复并突破确认。",
        "risk":"4h/15m、峰值锚点及首次回调均为本地量化定义；仅做多，规则分数不是胜率。",
        "trend":{"interval":"4h","direction":"long"},"metrics":metrics}),
        json!({"plan":plan}),
    )
}

pub fn review(order: &Value, market: &Value) -> Value {
    let hold = |reason: &str| json!({"action":"HOLD","reason":reason});
    let snapshot = &order["initialPlan"]["martinLukExit"];
    if !snapshot.is_object() || market["interval"] != "15m" || order["direction"] != "OPEN_LONG" {
        return hold("缺少冻结的 Martin Luk 出场参数或 15m 多头行情。");
    }
    let Some(now) = timestamp(&market["dataAsOf"]) else {
        return hold("缺少已收盘行情时间。");
    };
    let Some(r) = closed(market, ENTRY_MS, now) else {
        return hold("15m 行情无效，保留保护价格。");
    };
    let Some(entry_at) = timestamp(&order["entryAt"]) else {
        return hold("订单尚未成交。");
    };
    let length = period(snapshot, "emaPeriod");
    if r.len() < length
        || now < entry_at + (n(snapshot, "minHoldBars").floor() as i64).max(1) * ENTRY_MS
    {
        return hold("EMA 未就绪或尚无持仓后的完整 15m K 线。");
    }
    let e = last(&ema(&closes(&r), length));
    if n(r.last().unwrap(), "close") < e {
        json!({"action":"CLOSE","confidence":0.8,
            "reason":format!("Martin Luk 本地适配：15m 收盘跌破 EMA{length}，结束波段。")})
    } else {
        hold("15m 收盘仍守住跟踪 EMA，继续持有。")
    }
}

#[cfg(test)]
#[path = "martin_luk_tests.rs"]
mod tests;
