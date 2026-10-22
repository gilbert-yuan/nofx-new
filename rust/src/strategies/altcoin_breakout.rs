//! Altcoin perpetual trend rules, shared by analysis and parameterized replay.
//! Structural parameters are validated at analysis and frozen per entry plan.
//!
//! Every call consumes only a contiguous, explicitly closed 4h prefix. EMA uses
//! the shared SMA seed and ATR uses Wilder's SMA seed and recursive smoothing.
//! Replay must retain the same prefix origin: trimming a rolling window changes
//! those seeds and is not mathematically equivalent to the full-prefix strategy.
//! Entry, protection activation, fills, costs and liquidation belong to the
//! shared execution engine; this module never simulates an execution.
use super::indicators::{closes, ema, finite_candle, true_ranges};
use super::{merge, rows, tightest_stop, wait};
use crate::{number, timestamp};
use serde_json::{Value, json};
use std::collections::VecDeque;

pub const INTERVAL_MS: i64 = 14_400_000;
pub const MIN_BARS: usize = 180;
const FAST: usize = 25;
const SLOW: usize = 75;
const CHANNEL: usize = 8;
const ATR_PERIOD: usize = 14;
const STOP_ATR: f64 = 1.;
const TRAIL_ATR: f64 = 3.;

pub fn parameter_snapshot() -> Value {
    Parameters::default().snapshot()
}

/// Structural parameters are validated once and frozen in every entry plan.
/// Risk and leverage remain separate execution-layer constraints.
#[derive(Clone, Debug, PartialEq)]
struct Parameters {
    fast: usize,
    slow: usize,
    channel: usize,
    stop_atr: f64,
    trail_atr: f64,
    ema_filter: bool,
}

impl Default for Parameters {
    fn default() -> Self {
        Self {
            fast: FAST,
            slow: SLOW,
            channel: CHANNEL,
            stop_atr: STOP_ATR,
            trail_atr: TRAIL_ATR,
            ema_filter: true,
        }
    }
}

impl Parameters {
    fn parse(value: &Value) -> Result<Self, String> {
        let integer = |key: &str, default: usize, min: usize, max: usize| {
            if value[key].is_null() {
                return Ok(default);
            }
            let n = value[key]
                .as_f64()
                .ok_or_else(|| format!("{key} 必须是整数。"))?;
            if !n.is_finite() || n.fract() != 0. || n < min as f64 || n > max as f64 {
                return Err(format!("{key} 必须是 {min} 到 {max} 之间的整数。"));
            }
            Ok(n as usize)
        };
        let decimal = |key: &str, default: f64, min: f64, max: f64| {
            if value[key].is_null() {
                return Ok(default);
            }
            let n = value[key]
                .as_f64()
                .ok_or_else(|| format!("{key} 必须是有限数值。"))?;
            if !n.is_finite() || n < min || n > max {
                return Err(format!("{key} 必须在 {min} 到 {max} 之间。"));
            }
            Ok(n)
        };
        let result = Self {
            fast: integer("emaFast", FAST, 2, 240)?,
            slow: integer("emaSlow", SLOW, 3, 480)?,
            channel: integer("channelPeriod", CHANNEL, 2, 240)?,
            stop_atr: decimal("stopAtr", STOP_ATR, 0.25, 10.)?,
            trail_atr: decimal("trailAtr", TRAIL_ATR, 0.25, 20.)?,
            ema_filter: if value["useEmaFilter"].is_null() {
                true
            } else {
                value["useEmaFilter"]
                    .as_bool()
                    .ok_or("useEmaFilter 必须是布尔值。")?
            },
        };
        if result.fast >= result.slow {
            return Err("emaFast 必须小于 emaSlow。".into());
        }
        Ok(result)
    }

    fn minimum_bars(&self) -> usize {
        MIN_BARS.max(self.slow).max(self.channel + 1)
    }

    fn snapshot(&self) -> Value {
        json!({"interval":"4h","emaFast":self.fast,"emaSlow":self.slow,
            "channelPeriod":self.channel,"atrPeriod":ATR_PERIOD,"atrSmoothing":"Wilder",
            "stopAtr":self.stop_atr,"trailAtr":self.trail_atr,"useEmaFilter":self.ema_filter,
            "minBars":self.minimum_bars(),"entryExecution":"next_open","exitExecution":"next_open"})
    }

    fn frozen(order: &Value) -> Result<Self, String> {
        // Older plans without a complete snapshot retain the original A
        // interpretation. New entry defaults must never rewrite old positions.
        let legacy = json!({"emaFast":20,"emaSlow":60,"channelPeriod":20,
            "stopAtr":2.,"trailAtr":3.});
        let frozen = &order["plan"]["altcoinTrend"]["parameters"];
        if frozen.is_object() {
            let mut value = merge(legacy, frozen.clone());
            if value["useEmaFilter"].is_null() {
                value["useEmaFilter"] = json!(
                    order["plan"]["altcoinTrend"]["useEmaFilter"]
                        .as_bool()
                        .unwrap_or(true)
                );
            }
            Self::parse(&value)
        } else {
            Self::parse(&merge(
                legacy,
                json!({"useEmaFilter":
                order["plan"]["altcoinTrend"]["useEmaFilter"].as_bool().unwrap_or(true)}),
            ))
        }
    }
}

/// Useful for rejecting an entire search grid before replay starts.
pub fn validate_parameters(params: &Value) -> Result<Value, String> {
    Parameters::parse(params).map(|p| p.snapshot())
}

/// Deliberately distinct from the shared trailing-window SMA ATR.
fn atr_series(candles: &[Value]) -> Vec<f64> {
    let tr = true_ranges(candles);
    let mut out = vec![f64::NAN; tr.len()];
    if tr.len() < ATR_PERIOD {
        return out;
    }
    let mut previous = tr[..ATR_PERIOD].iter().sum::<f64>() / ATR_PERIOD as f64;
    out[ATR_PERIOD - 1] = previous;
    for i in ATR_PERIOD..tr.len() {
        previous = (previous * (ATR_PERIOD - 1) as f64 + tr[i]) / ATR_PERIOD as f64;
        out[i] = previous;
    }
    out
}

fn feed<'a>(market: &'a Value, context: &'a Value) -> &'a Value {
    if market["interval"] == "4h" {
        market
    } else {
        &context["auxMarkets"]["4h"]
    }
}

/// Returns no data rather than interpolating gaps or using an unfinished bar.
fn closed_rows(market: &Value, context: &Value) -> Option<(Vec<Value>, i64)> {
    let now = timestamp(&context["evaluationAt"]).or_else(|| timestamp(&market["dataAsOf"]))?;
    let source = feed(market, context);
    if source["interval"] != "4h" {
        return None;
    }
    let mut result: Vec<Value> = Vec::new();
    for row in rows(source) {
        let open = timestamp(&row["openTime"])?;
        let end = open.checked_add(INTERVAL_MS)?;
        if end > now || row["confirmed"] != true {
            continue;
        }
        if open.rem_euclid(INTERVAL_MS) != 0
            || !finite_candle(&row)
            || result.last().is_some_and(|previous| {
                timestamp(&previous["openTime"]) != Some(open - INTERVAL_MS)
            })
        {
            return None;
        }
        result.push(row);
    }
    let end = timestamp(&result.last()?["openTime"])?.checked_add(INTERVAL_MS)?;
    (end == now.div_euclid(INTERVAL_MS) * INTERVAL_MS).then_some((result, end))
}

pub(crate) fn eligible_symbol(symbol: &str) -> bool {
    let normalized = crate::exchange::strip_symbol(symbol).to_uppercase();
    let base = normalized
        .strip_suffix("USDT")
        .or_else(|| normalized.strip_suffix("USDC"))
        .or_else(|| normalized.strip_suffix("USD"))
        .unwrap_or(&normalized);
    !matches!(
        base,
        "BTC"
            | "ETH"
            | "USDT"
            | "USDC"
            | "BUSD"
            | "FDUSD"
            | "TUSD"
            | "DAI"
            | "USDP"
            | "USDE"
            | "USDD"
            | "USD1"
            | "PYUSD"
            | "FRAX"
    )
}

struct Indicators {
    fast: Vec<f64>,
    slow: Vec<f64>,
    atr: Vec<f64>,
    channel_high: Vec<f64>,
    channel_low: Vec<f64>,
    params: Parameters,
}

impl Indicators {
    fn new(candles: &[Value], params: &Parameters) -> Self {
        let close = closes(candles);
        // Monotone deques contain only bars strictly before the decision bar.
        // Calculating the full series therefore cannot introduce future prices.
        let mut upper = VecDeque::<usize>::new();
        let mut lower = VecDeque::<usize>::new();
        let mut channel_high = vec![f64::NAN; candles.len()];
        let mut channel_low = vec![f64::NAN; candles.len()];
        for index in 0..candles.len() {
            let start = index.saturating_sub(params.channel);
            while upper.front().is_some_and(|i| *i < start) {
                upper.pop_front();
            }
            while lower.front().is_some_and(|i| *i < start) {
                lower.pop_front();
            }
            if index >= params.channel {
                channel_high[index] = number(&candles[*upper.front().unwrap()]["high"], f64::NAN);
                channel_low[index] = number(&candles[*lower.front().unwrap()]["low"], f64::NAN);
            }
            let high = number(&candles[index]["high"], f64::NAN);
            let low = number(&candles[index]["low"], f64::NAN);
            while upper
                .back()
                .is_some_and(|i| number(&candles[*i]["high"], f64::NAN) <= high)
            {
                upper.pop_back();
            }
            while lower
                .back()
                .is_some_and(|i| number(&candles[*i]["low"], f64::NAN) >= low)
            {
                lower.pop_back();
            }
            upper.push_back(index);
            lower.push_back(index);
        }
        Self {
            fast: ema(&close, params.fast),
            slow: ema(&close, params.slow),
            atr: atr_series(candles),
            channel_high,
            channel_low,
            params: params.clone(),
        }
    }

    fn trend(&self, index: usize, long: bool) -> bool {
        !self.params.ema_filter
            || if long {
                self.fast[index] > self.slow[index]
            } else {
                self.fast[index] < self.slow[index]
            }
    }

    fn level(&self, index: usize, long: bool) -> f64 {
        if long {
            self.channel_high[index]
        } else {
            self.channel_low[index]
        }
    }

    fn condition(&self, candles: &[Value], index: usize, long: bool) -> bool {
        if index < self.params.channel.max(self.params.slow - 1) || !self.trend(index, long) {
            return false;
        }
        let close = number(&candles[index]["close"], f64::NAN);
        let level = self.level(index, long);
        if long { close > level } else { close < level }
    }

    fn trigger(&self, candles: &[Value], index: usize, long: bool) -> bool {
        index > 0
            && self.condition(candles, index, long)
            && !self.condition(candles, index - 1, long)
    }
}

#[derive(Clone, Copy)]
struct Setup {
    index: usize,
    long: bool,
    level: f64,
    atr: f64,
}

/// Shared causal state machine used by both ordinary analysis and prepared replay.
/// Each result depends exclusively on candles at or before that index.
fn setup_series(candles: &[Value], indicators: &Indicators) -> Vec<Option<Setup>> {
    let mut result = vec![None; candles.len()];
    let p = &indicators.params;
    // Only a fresh breakout after the full declared warmup is actionable.
    for index in p.minimum_bars() - 1..candles.len() {
        for long in [true, false] {
            if indicators.trigger(candles, index, long) {
                let candidate = Setup {
                    index,
                    long,
                    level: indicators.level(index, long),
                    atr: indicators.atr[index],
                };
                result[index] = Some(candidate);
                break;
            }
        }
    }
    result
}

fn disabled_exit_rules() -> Value {
    json!({"trailing":{"triggerR":1_000_000,"profitTriggerPct":1_000_000,
        "extendTpAtr":0,"lockMinRoomAtr":0,"useBreakEven":false,
        "breakEvenFloorAtr":0,"breakEvenCostBufferBps":0,
        "ladder":[{"atR":0,"trailR":1_000_000,"lockR":0}]},
        "smartExit":{"enabled":false,"barLevelEnabled":false,"barLevel":false,
            "maPeriod":20,"atrPeriod":14,"maBreakAtr":0,"maExitMaxProfitR":0,
            "tpMinR":0,"minHoldBars":0},
        "partialTp":{"enabled":false,"tp1R":1,"tp2R":2,"tp1ClosePct":0,
            "tp2ClosePct":0,"moveStopToBreakEven":false}})
}

pub fn analyze(market: &Value, context: &Value) -> Value {
    let hold = |reason: &str, metrics: Value| {
        wait(
            market,
            reason,
            &json!({"interval":"4h"}),
            json!({"metrics":metrics}),
        )
    };
    if !eligible_symbol(market["symbol"].as_str().unwrap_or("")) {
        return hold("山寨合约策略排除 BTC、ETH 和稳定币标的。", json!({}));
    }
    let Some((candles, end)) = closed_rows(market, context) else {
        return hold(
            "需要连续、有效且已确认收盘的 4h 行情与决策时间。",
            json!({}),
        );
    };
    let p = &context["params"];
    let params = match Parameters::parse(p) {
        Ok(params) => params,
        Err(reason) => return hold(&reason, json!({"invalidParameters":true})),
    };
    if candles.len() < params.minimum_bars() {
        return hold(
            "4h 预热不足，需要满足已冻结参数的最少已收盘 K 线数。",
            json!({"bars":candles.len(),"requiredBars":params.minimum_bars()}),
        );
    }
    let indicators = Indicators::new(&candles, &params);
    let candidates = setup_series(&candles, &indicators);
    analyze_closed(
        market,
        &candles,
        end,
        &indicators,
        *candidates.last().unwrap(),
        p,
    )
}

fn analyze_closed(
    market: &Value,
    candles: &[Value],
    end: i64,
    indicators: &Indicators,
    candidate: Option<Setup>,
    p: &Value,
) -> Value {
    let hold = |reason: &str, metrics: Value| {
        wait(
            market,
            reason,
            &json!({"interval":"4h"}),
            json!({"metrics":metrics}),
        )
    };
    let params = &indicators.params;
    if candles.len() < params.minimum_bars() {
        return hold(
            "4h 预热不足，需要满足已冻结参数的最少已收盘 K 线数。",
            json!({"bars":candles.len(),"requiredBars":params.minimum_bars()}),
        );
    }
    let last = candles.len() - 1;
    let price = number(&candles[last]["close"], f64::NAN);
    let mut metrics = json!({"ema20":indicators.fast[last],"ema60":indicators.slow[last],
        "emaFast":indicators.fast[last],"emaSlow":indicators.slow[last],
        "atr14":indicators.atr[last],"useEmaFilter":params.ema_filter,
        "channelHigh":indicators.level(last,true),
        "channelLow":indicators.level(last,false),"parameters":params.snapshot()});
    let Some(candidate) = candidate else {
        return hold("等待前序通道收盘突破的新触发。", metrics);
    };
    // The entry-signal candle's ATR freezes the initial stop distance.
    let entry_atr = indicators.atr[last];
    let risk = params.stop_atr * entry_atr;
    let sign = if candidate.long { 1. } else { -1. };
    let stop = price - sign * risk;
    if !(entry_atr.is_finite() && entry_atr > 0. && stop.is_finite() && stop > 0.) {
        return hold("ATR 或初始止损无效。", metrics);
    }
    let risk_fraction = number(&p["riskPerTrade"], 0.003);
    let max_notional = number(&p["maxNotionalPct"], 0.5);
    let margin = (risk_fraction / (risk / price)).min(max_notional);
    let plan = json!({"entryStyle":"market","entryExecution":"next_open",
        "entryReference":price,"entryMin":price,"entryMax":price,
        "entryAtr":entry_atr,"stopAtr":params.stop_atr,"trailAtr":params.trail_atr,
        "reanchorToFill":true,"stopLoss":stop,"riskUnit":risk,
        "takeProfitEnabled":false,"takeProfit":if candidate.long{price*100.}else{price*0.01},
        "maxHoldBars":1_000_000,"maxHoldBarsLimit":1_000_000,
        "recommendedLeverage":1,"autoMarginPct":margin,
        "maxPositions":number(&p["maxPositions"],3.),"maxSameDirectionPositions":2,
        "riskSizing":{"riskFraction":risk_fraction,"maxNotionalFraction":max_notional,
            "maxLeverage":1,"fundingReserveHours":24},
        "exitRules":disabled_exit_rules(),
        "altcoinTrend":{"variant":"breakout",
            "useEmaFilter":params.ema_filter,"breakoutLevel":candidate.level,
            "breakoutAtr":candidate.atr,"breakoutAt":timestamp(&candles[candidate.index]["openTime"]),
            "signalAt":end,"parameters":params.snapshot()}});
    metrics["breakoutLevel"] = json!(candidate.level);
    metrics["breakoutAtr"] = json!(candidate.atr);
    metrics["breakoutIndex"] = json!(candidate.index);
    merge(
        json!({"symbol":market["symbol"],"action":if candidate.long{"BUY"}else{"SELL"},
        "decision":if candidate.long{"LONG_ALLOWED"}else{"SHORT_ALLOWED"},"state":"ALLOWED",
        "confidence":0.6,"confidenceType":"rule_strength","recommendedLeverage":1,
        "score":60,"pendingOrderTtlMs":INTERVAL_MS,"maxHoldBarsLimit":1_000_000,
        "reason":"山寨趋势：EMA 方向与前序通道收盘突破的新触发。",
        "risk":"规则强度不是胜率；成交、资金费、强平与组合风险由共享执行层核算。",
        "trend":{"interval":"4h","direction":if candidate.long{"long"}else{"short"}},"metrics":metrics}),
        json!({"plan":plan}),
    )
}

pub fn review(order: &Value, market: &Value, context: &Value) -> Value {
    let hold = |reason: &str| json!({"action":"HOLD","reason":reason});
    let Some((candles, end)) = closed_rows(market, context) else {
        return hold("4h 已收盘行情无效，保留原保护。 ");
    };
    let params = match Parameters::frozen(order) {
        Ok(params) => params,
        Err(_) => return hold("冻结参数无效，保留原保护。 "),
    };
    if candles.len() < params.minimum_bars() {
        return hold("4h EMA 复核预热不足，保留原保护。 ");
    }
    let indicators = Indicators::new(&candles, &params);
    review_closed(order, &candles, end, &indicators)
}

fn review_closed(order: &Value, candles: &[Value], end: i64, indicators: &Indicators) -> Value {
    let hold = |reason: &str| json!({"action":"HOLD","reason":reason});
    if candles.len() < indicators.params.minimum_bars() {
        return hold("4h EMA 复核预热不足，保留原保护。 ");
    }
    let Some(entry_at) = timestamp(&order["entryAt"]) else {
        return hold("缺少实际成交时间，无法确认入场后的收盘极值。 ");
    };
    let long = order["direction"] == "OPEN_LONG";
    let ema_filter = indicators.params.ema_filter;
    let last = candles.len() - 1;
    let price = number(&candles[last]["close"], f64::NAN);
    let previous_state = &order["altcoinTrendState"];
    let reviewed_at = timestamp(&previous_state["lastReviewAt"]);
    let high = number(&previous_state["highestClose"], f64::NAN);
    let low = number(&previous_state["lowestClose"], f64::NAN);
    let state_valid = reviewed_at.is_some_and(|at| at >= entry_at && at <= end)
        && high.is_finite()
        && high > 0.
        && low.is_finite()
        && low > 0.
        && high >= low;
    let first = timestamp(&candles[0]["openTime"]).unwrap();
    if !state_valid && first > entry_at.div_euclid(INTERVAL_MS) * INTERVAL_MS {
        return hold("行情窗口未覆盖入场时刻且没有持久收盘极值，保留原保护。 ");
    }
    let mut highest = if state_valid { high } else { f64::NEG_INFINITY };
    let mut lowest = if state_valid { low } else { f64::INFINITY };
    let after = if state_valid {
        reviewed_at.unwrap().max(entry_at)
    } else {
        entry_at
    };
    let first_new =
        candles.partition_point(|row| timestamp(&row["openTime"]).unwrap() + INTERVAL_MS <= after);
    for row in &candles[first_new..] {
        let close_at = timestamp(&row["openTime"]).unwrap() + INTERVAL_MS;
        if close_at <= entry_at || state_valid && close_at <= reviewed_at.unwrap() {
            continue;
        }
        let close = number(&row["close"], f64::NAN);
        highest = highest.max(close);
        lowest = lowest.min(close);
    }
    if !highest.is_finite() || !lowest.is_finite() {
        return hold("实际成交后尚无已收盘 4h K 线。 ");
    }
    let state = json!({"highestClose":highest,"lowestClose":lowest,"lastReviewAt":end});
    let base = tightest_stop(order, long);
    let atr = indicators.atr[last];
    let proposed = if long {
        highest - indicators.params.trail_atr * atr
    } else {
        lowest + indicators.params.trail_atr * atr
    };
    let stop = if long {
        base.max(proposed)
    } else {
        base.min(proposed)
    };
    let metrics = json!({"ema20":indicators.fast[last],"ema60":indicators.slow[last],
        "emaFast":indicators.fast[last],"emaSlow":indicators.slow[last],
        "atr14":atr,"highestClose":highest,"lowestClose":lowest,"proposedStop":proposed,
        "parameters":indicators.params.snapshot()});
    let reversal = ema_filter
        && if long {
            indicators.fast[last] < indicators.slow[last]
        } else {
            indicators.fast[last] > indicators.slow[last]
        };
    let crossed = stop.is_finite() && if long { stop >= price } else { stop <= price };
    if reversal || crossed {
        return json!({"action":"CLOSE","exitExecution":"next_open",
            "reason":if reversal{"4h EMA 方向反转，下一可成交开盘退出。"}else{"收盘更新的移动止损已越过现价，下一可成交开盘退出。"},
            "altcoinTrendState":state,"metrics":metrics});
    }
    if stop.is_finite() && stop > 0. && if long { stop > base } else { stop < base } {
        json!({"action":"UPDATE_PROTECTION","stopLoss":stop,
            "takeProfit":order["plan"]["takeProfit"],"takeProfitEnabled":false,
            "effectiveFrom":"next_open","altcoinTrendState":state,"metrics":metrics,
            "reason":"按入场后已收盘极值与冻结倍数的 Wilder ATR 收紧止损。"})
    } else {
        json!({"action":"HOLD","altcoinTrendState":state,"metrics":metrics,
            "reason":"移动止损未超过当前保护，保留较紧止损。"})
    }
}

struct PreparedSegment {
    start: usize,
    end: usize,
    indicators: Indicators,
    candidates: Vec<Option<Setup>>,
}

/// Reuses the ordinary strategy's indicator and setup implementations without
/// cloning historical JSON on every decision. No fills or P&L are modeled here.
/// Every gap restarts both recursive seeds and warmup, exactly like the replay's
/// latest contiguous prefix. `closed_len` must exclude all unfinished bars.
pub struct PreparedSeries<'a> {
    candles: &'a [Value],
    params: Value,
    segments: Vec<PreparedSegment>,
}

impl<'a> PreparedSeries<'a> {
    pub fn new(candles: &'a [Value], params: &Value) -> Result<Self, String> {
        let parsed = Parameters::parse(params)?;
        let mut starts = Vec::new();
        let mut previous: Option<i64> = None;
        for (index, row) in candles.iter().enumerate() {
            let open = timestamp(&row["openTime"]).ok_or("4h openTime 无效。")?;
            if open.rem_euclid(INTERVAL_MS) != 0 || row["confirmed"] != true || !finite_candle(row)
            {
                return Err(format!("第 {index} 根 4h K 线未确认或无效。"));
            }
            if previous.is_some_and(|at| open <= at) {
                return Err("4h K 线必须按时间严格递增。".into());
            }
            if previous.is_none_or(|at| open - at != INTERVAL_MS) {
                starts.push(index);
            }
            previous = Some(open);
        }
        let mut segments = Vec::with_capacity(starts.len());
        for (i, start) in starts.iter().copied().enumerate() {
            let end = starts.get(i + 1).copied().unwrap_or(candles.len());
            let rows = &candles[start..end];
            let indicators = Indicators::new(rows, &parsed);
            let candidates = setup_series(rows, &indicators);
            segments.push(PreparedSegment {
                start,
                end,
                indicators,
                candidates,
            });
        }
        Ok(Self {
            candles,
            params: params.clone(),
            segments,
        })
    }

    pub fn closed_at(&self, closed_len: usize) -> Option<i64> {
        timestamp(&self.candles.get(closed_len.checked_sub(1)?)?["openTime"])?
            .checked_add(INTERVAL_MS)
    }

    fn prefix(&self, closed_len: usize) -> Option<(&[Value], &PreparedSegment, i64)> {
        if closed_len == 0 || closed_len > self.candles.len() {
            return None;
        }
        let index = self.segments.partition_point(|s| s.end < closed_len);
        let segment = self.segments.get(index)?;
        Some((
            &self.candles[segment.start..closed_len],
            segment,
            self.closed_at(closed_len)?,
        ))
    }

    pub fn analyze_at(&self, symbol: &str, closed_len: usize) -> Value {
        let market = json!({"symbol":symbol});
        if !eligible_symbol(symbol) {
            return wait(
                &market,
                "山寨合约策略排除 BTC、ETH 和稳定币标的。",
                &json!({"interval":"4h"}),
                json!({"metrics":{}}),
            );
        }
        let Some((candles, segment, end)) = self.prefix(closed_len) else {
            return wait(
                &market,
                "需要连续、有效且已确认收盘的 4h 行情与决策时间。",
                &json!({"interval":"4h"}),
                json!({"metrics":{}}),
            );
        };
        analyze_closed(
            &market,
            candles,
            end,
            &segment.indicators,
            segment.candidates[candles.len() - 1],
            &self.params,
        )
    }

    pub fn review_at(&self, order: &Value, closed_len: usize) -> Value {
        let Some((candles, segment, end)) = self.prefix(closed_len) else {
            return json!({"action":"HOLD","reason":"4h 已收盘行情无效，保留原保护。 "});
        };
        let frozen = match Parameters::frozen(order) {
            Ok(params) => params,
            Err(_) => return json!({"action":"HOLD","reason":"冻结参数无效，保留原保护。 "}),
        };
        if frozen == segment.indicators.params {
            review_closed(order, candles, end, &segment.indicators)
        } else {
            // A caller may reuse a cache while reviewing an older parameter set.
            // Never let the new run's parameters alter that existing position.
            let indicators = Indicators::new(candles, &frozen);
            review_closed(order, candles, end, &indicators)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(count: usize) -> Vec<Value> {
        let start = 1_700_000_000_000_i64.div_euclid(INTERVAL_MS) * INTERVAL_MS;
        (0..count)
            .map(|i| {
                let close = 100. + i as f64 * 0.1;
                json!({"openTime":start+i as i64*INTERVAL_MS,"open":close,
                "high":close+1.,"low":close-1.,"close":close,"volume":100.,"confirmed":true})
            })
            .collect()
    }

    fn market(rows: &[Value]) -> Value {
        json!({"symbol":"SOLUSDT","interval":"4h","klines":rows,
            "dataAsOf":timestamp(&rows.last().unwrap()["openTime"]).unwrap()+INTERVAL_MS})
    }

    fn breakout() -> Vec<Value> {
        let mut rows = candles(181);
        rows[180]["close"] = json!(121.);
        rows[180]["high"] = json!(121.5);
        rows[180]["low"] = json!(117.);
        rows
    }

    #[test]
    fn breakthrough_excludes_current_high_and_fires_once() {
        let mut rows = breakout();
        let first = analyze(&market(&rows), &json!({}));
        assert_eq!(first["action"], "BUY");
        assert!((number(&first["plan"]["altcoinTrend"]["breakoutLevel"], 0.) - 118.9).abs() < 1e-9);
        assert_eq!(first["plan"]["reanchorToFill"], true);
        assert_eq!(first["plan"]["takeProfitEnabled"], false);
        let mut next = rows.last().unwrap().clone();
        next["openTime"] = json!(timestamp(&next["openTime"]).unwrap() + INTERVAL_MS);
        next["open"] = json!(121.5);
        next["close"] = json!(122.);
        next["high"] = json!(122.5);
        next["low"] = json!(120.);
        rows.push(next);
        assert_eq!(analyze(&market(&rows), &json!({}))["action"], "WAIT");
    }

    #[test]
    fn registered_strategy_normalizes_without_a_fictitious_fixed_target_rr() {
        let mut m = market(&breakout());
        m["marketProvider"] = json!("binance");
        let at = timestamp(&m["dataAsOf"]).unwrap();
        let blocked =
            crate::strategies::analyze("altcoin-trend-breakout-v1", &m, &json!({})).unwrap();
        assert_eq!(blocked["action"], "WAIT");
        assert_eq!(blocked["researchOnly"], true);
        let raw = crate::strategies::analyze(
            "altcoin-trend-breakout-v1",
            &m,
            &json!({"evaluationAt":at,"deferMarketFilters":true,"allowResearchOnly":true}),
        )
        .unwrap();
        let normalized = crate::research::normalize_plan(&raw, &m, at);
        assert_eq!(normalized["eligible"], true, "{normalized}");
        assert_eq!(normalized["plan"]["takeProfitEnabled"], false);
        assert!(normalized["plan"]["netRewardRisk"].is_null());
    }

    #[test]
    fn ordinary_submission_blocks_explicit_and_implicitly_selected_research_signals() {
        let id = "altcoin-trend-breakout-v1";
        for explicit in [true, false] {
            let mut account = json!({"initialBalance":10000.,"orders":[]});
            let mut record = json!({"id":"research-gate","analyses":[{
                "symbol":"SOLUSDT","strategyId":id}]});
            if explicit {
                record["strategyId"] = json!(id);
            }
            let error = crate::paper::submit_paper_order(
                &mut account,
                &record,
                &json!({"symbol":"SOLUSDT"}),
                0,
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("仅允许当前山寨趋势突破"),
                "{error}"
            );
            assert!(account["orders"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn unclosed_future_data_cannot_create_a_signal() {
        let rows = breakout();
        let mut m = market(&rows);
        m["dataAsOf"] = json!(timestamp(&rows[180]["openTime"]).unwrap());
        assert_eq!(analyze(&m, &json!({}))["action"], "WAIT");
        m["dataAsOf"] = market(&rows)["dataAsOf"].clone();
        m["klines"][180]["confirmed"] = json!(false);
        assert_eq!(analyze(&m, &json!({}))["action"], "WAIT");
    }

    #[test]
    fn missing_bar_and_excluded_assets_hold() {
        let mut rows = breakout();
        rows.remove(100);
        assert_eq!(analyze(&market(&rows), &json!({}))["action"], "WAIT");
        let mut m = market(&breakout());
        m["symbol"] = json!("BTCUSDT");
        assert_eq!(analyze(&m, &json!({}))["action"], "WAIT");
    }

    #[test]
    fn reflected_market_produces_a_short_breakout() {
        let mut rows = breakout();
        for row in &mut rows {
            let high = number(&row["high"], 0.);
            let low = number(&row["low"], 0.);
            row["open"] = json!(200. - number(&row["open"], 0.));
            row["close"] = json!(200. - number(&row["close"], 0.));
            row["high"] = json!(200. - low);
            row["low"] = json!(200. - high);
        }
        let out = analyze(&market(&rows), &json!({}));
        assert_eq!(out["action"], "SELL");
        assert!(number(&out["plan"]["stopLoss"], 0.) > number(&rows[180]["close"], 0.));
    }

    #[test]
    fn wilder_atr_smooths_instead_of_using_only_latest_window() {
        let mut rows = candles(180);
        rows[160]["high"] = json!(200.);
        let out = atr_series(&rows);
        assert!(out[179] > 2.);
        assert!((out[179] - (out[178] * 13. + 2.) / 14.).abs() < 1e-12);
    }

    #[test]
    fn review_preserves_tighter_stop_and_reconstructs_past_extrema() {
        let rows = candles(190);
        let m = market(&rows);
        let entry_at = timestamp(&rows[181]["openTime"]).unwrap();
        let order = json!({"direction":"OPEN_LONG","entry":118.1,"entryAt":entry_at,
            "initialPlan":{"stopLoss":114.1},"plan":{"stopLoss":116.,"takeProfit":10000.,"altcoinTrend":{"useEmaFilter":true}}});
        let out = review(&order, &m, &json!({}));
        assert_eq!(out["action"], "HOLD");
        assert_eq!(out["altcoinTrendState"]["highestClose"], rows[189]["close"]);
        assert_eq!(out["altcoinTrendState"]["lowestClose"], rows[181]["close"]);
    }

    #[test]
    fn legacy_plan_keeps_its_separately_frozen_disabled_ema_filter() {
        let rows = candles(190);
        let mut legacy_parameters = parameter_snapshot();
        legacy_parameters
            .as_object_mut()
            .unwrap()
            .remove("useEmaFilter");
        let order = json!({"direction":"OPEN_SHORT",
            "entryAt":timestamp(&rows[181]["openTime"]).unwrap(),
            "initialPlan":{"stopLoss":140.},"plan":{"stopLoss":140.,"takeProfit":1.,
                "altcoinTrend":{"useEmaFilter":false,"parameters":legacy_parameters}}});
        let result = review(&order, &market(&rows), &json!({}));
        assert_ne!(result["action"], "CLOSE", "{result}");
        assert_eq!(result["metrics"]["parameters"]["useEmaFilter"], false);
    }

    #[test]
    fn newly_computed_stop_beyond_close_queues_exit_instead_of_filling_at_stop() {
        let mut rows = candles(190);
        rows[185]["open"] = json!(130.);
        rows[185]["high"] = json!(130.1);
        rows[185]["low"] = json!(129.9);
        rows[185]["close"] = json!(130.);
        let entry_at = timestamp(&rows[181]["openTime"]).unwrap();
        let order = json!({"direction":"OPEN_LONG","entryAt":entry_at,
            "initialPlan":{"stopLoss":110.},"plan":{"stopLoss":110.,
                "takeProfit":10000.,"altcoinTrend":{"useEmaFilter":true}}});
        let out = review(&order, &market(&rows), &json!({}));
        assert_eq!(out["action"], "CLOSE");
        assert_eq!(out["exitExecution"], "next_open");
        assert_eq!(out["altcoinTrendState"]["highestClose"], 130.);
        assert!(out["stopLoss"].is_null());
    }

    fn oscillating(count: usize) -> Vec<Value> {
        let mut rows = candles(count);
        let mut previous: f64 = 100.;
        for (i, row) in rows.iter_mut().enumerate() {
            let close = 100.
                + i as f64 * 0.02
                + 9. * (i as f64 * 0.08).sin()
                + 2. * (i as f64 * 0.41).sin();
            row["open"] = json!(previous);
            row["high"] = json!(previous.max(close) + 0.2);
            row["low"] = json!(previous.min(close) - 0.2);
            row["close"] = json!(close);
            previous = close;
        }
        rows
    }

    #[test]
    fn prepared_series_matches_every_closed_prefix_and_parameter_set() {
        let rows = oscillating(405);
        let parameter_sets = [
            json!({}),
            json!({"emaFast":10,"emaSlow":40,
            "channelPeriod":10,"stopAtr":1.5,"trailAtr":2.}),
            json!({"emaFast":30,"emaSlow":90,"channelPeriod":40,
            "stopAtr":2.5,"trailAtr":4.}),
        ];
        let mut entries = 0;
        for params in parameter_sets {
            {
                let prepared = PreparedSeries::new(&rows, &params).unwrap();
                for end in 1..=rows.len() {
                    let ordinary = analyze(&market(&rows[..end]), &json!({"params":params}));
                    let cached = prepared.analyze_at("SOLUSDT", end);
                    assert_eq!(cached, ordinary, "end={end}, params={params}");
                    entries += usize::from(cached["action"] == "BUY" || cached["action"] == "SELL");
                }
            }
        }
        assert!(
            entries > 5,
            "causal equivalence must exercise actual entries"
        );
    }

    #[test]
    fn prepared_future_prices_and_later_gaps_cannot_change_earlier_signals() {
        let rows = oscillating(420);
        let mut changed = rows.clone();
        for row in &mut changed[260..] {
            for key in ["open", "high", "low", "close"] {
                row[key] = json!(number(&row[key], 0.) * 100.);
            }
        }
        changed.drain(330..334);
        {
            let original = PreparedSeries::new(&rows, &json!({})).unwrap();
            let mutated = PreparedSeries::new(&changed, &json!({})).unwrap();
            for end in 180..=260 {
                assert_eq!(
                    original.analyze_at("SOLUSDT", end),
                    mutated.analyze_at("SOLUSDT", end)
                );
            }
        }
    }

    #[test]
    fn prepared_gaps_restart_seed_and_warmup_from_latest_contiguous_segment() {
        let mut rows = oscillating(590);
        rows.drain(210..214);
        {
            let prepared = PreparedSeries::new(&rows, &json!({})).unwrap();
            for end in 205..=rows.len() {
                let start = if end > 210 { 210 } else { 0 };
                let ordinary = analyze(&market(&rows[start..end]), &json!({}));
                assert_eq!(prepared.analyze_at("SOLUSDT", end), ordinary, "end={end}");
            }
        }
    }

    #[test]
    fn registered_analysis_keeps_custom_structural_parameters() {
        let rows = breakout();
        let params = json!({"emaFast":10,"emaSlow":40,"channelPeriod":10,
            "stopAtr":1.5,"trailAtr":2.});
        let prepared = PreparedSeries::new(&rows, &params).unwrap();
        let registered = crate::strategies::analyze(
            "altcoin-trend-breakout-v1",
            &market(&rows),
            &json!({"params":params,"allowResearchOnly":true,"deferMarketFilters":true}),
        )
        .unwrap();
        assert_eq!(registered, prepared.analyze_at("SOLUSDT", rows.len()));
        assert_eq!(registered["action"], "BUY");
        assert_eq!(
            registered["plan"]["altcoinTrend"]["parameters"]["channelPeriod"],
            10
        );
        assert!(
            (number(&registered["plan"]["riskUnit"], 0.) - 1.5 * atr_series(&rows)[180]).abs()
                < 1e-12
        );
    }

    #[test]
    fn review_uses_frozen_parameters_with_another_runs_cache() {
        let rows = oscillating(405);
        let params = json!({"emaFast":10,"emaSlow":40,"channelPeriod":10,
            "stopAtr":1.5,"trailAtr":2.});
        let wrong = json!({"emaFast":30,"emaSlow":120,"trailAtr":10.});
        let cache = PreparedSeries::new(&rows, &wrong).unwrap();
        let entry_at = timestamp(&rows[180]["openTime"]).unwrap();
        let mut order = json!({"direction":"OPEN_LONG","entryAt":entry_at,
            "initialPlan":{"stopLoss":80.},"plan":{"stopLoss":80.,"takeProfit":10000.,
                "altcoinTrend":{"parameters":validate_parameters(&params).unwrap()}}});
        let mut exits = 0;
        for end in 182..=rows.len() {
            let ordinary = review(&order, &market(&rows[..end]), &json!({"params":wrong}));
            assert_eq!(ordinary, cache.review_at(&order, end), "end={end}");
            exits += usize::from(ordinary["action"] == "CLOSE");
            if ordinary["altcoinTrendState"].is_object() {
                order["altcoinTrendState"] = ordinary["altcoinTrendState"].clone();
            }
            if ordinary["action"] == "UPDATE_PROTECTION" {
                order["plan"]["stopLoss"] = ordinary["stopLoss"].clone();
            }
        }
        assert!(
            exits > 0,
            "mismatched cache must preserve actual exit decisions"
        );
    }

    #[test]
    fn structural_parameters_reject_invalid_numbers_and_relationships() {
        for params in [
            json!({"emaFast":60,"emaSlow":40}),
            json!({"channelPeriod":2.5}),
            json!({"stopAtr":0}),
            json!({"trailAtr":-1}),
            json!({"useEmaFilter":"false"}),
        ] {
            assert!(validate_parameters(&params).is_err(), "{params}");
            let signal = analyze(&market(&breakout()), &json!({"params":params}));
            assert_eq!(signal["action"], "WAIT");
            assert_eq!(signal["metrics"]["invalidParameters"], true);
        }
        let slow = validate_parameters(&json!({"emaSlow":240})).unwrap();
        assert_eq!(slow["minBars"], 240);
    }
}
