//! Native candle replay. All costs and partial fills are shared by the account and offline backtests.
use crate::{interval_ms, iso, number, timestamp};
use anyhow::{Context, Result, bail};
use chrono::{Datelike, TimeZone, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn n(v: &Value, key: &str, default: f64) -> f64 {
    number(&v[key], default)
}
fn flag(v: &Value, key: &str, default: bool) -> bool {
    v[key].as_bool().unwrap_or(default)
}
fn env_num(name: &str, default: f64, min: f64, max: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|x| x.is_finite())
        .unwrap_or(default)
        .clamp(min, max)
}
fn env_flag(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| v != "false" && v != "0")
        .unwrap_or(default)
}

pub fn next_open(time: i64, interval: &str) -> Result<i64> {
    if interval == "1M" || interval == "M" {
        let date = Utc
            .timestamp_millis_opt(time)
            .single()
            .context("Invalid candle timestamp")?;
        let (year, month) = if date.month() == 12 {
            (date.year() + 1, 1)
        } else {
            (date.year(), date.month() + 1)
        };
        return Ok(Utc
            .with_ymd_and_hms(year, month, 1, 0, 0, 0)
            .single()
            .context("Invalid monthly timestamp")?
            .timestamp_millis());
    }
    let duration = interval_ms(interval)
        .or_else(|| {
            interval
                .parse::<i64>()
                .ok()
                .filter(|x| *x > 0)
                .and_then(|x| x.checked_mul(60_000))
        })
        .context("Unsupported candle interval")?;
    time.checked_add(duration)
        .context("Candle timestamp overflow")
}

pub fn valid_candle(row: &Value) -> bool {
    let values = ["open", "high", "low", "close"].map(|k| n(row, k, f64::NAN));
    timestamp(&row["openTime"]).is_some()
        && values.iter().all(|x| x.is_finite() && *x > 0.)
        && values[2] <= values[0].min(values[3])
        && values[1] >= values[0].max(values[3])
        && n(row, "volume", f64::NAN) >= 0.
        && row["confirmed"] != false
}

#[derive(Clone, Copy)]
struct Costs {
    fee: f64,
    slip: f64,
    funding: f64,
}
impl Costs {
    fn from(v: &Value) -> Self {
        Self {
            fee: n(v, "feeBps", 6.),
            slip: n(v, "slippageBps", 5.),
            funding: n(v, "fundingBpsPer8h", 3.),
        }
    }
}
#[derive(Clone, Copy)]
struct Partial {
    enabled: bool,
    r1: f64,
    r2: f64,
    p1: f64,
    p2: f64,
    breakeven: bool,
}
impl Partial {
    fn from(v: &Value) -> Self {
        let defaults = v.is_null();
        let p1 = env_num("NOFX_TP1_CLOSE_PCT", 0.4, 0.05, 0.95);
        let p2 = env_num("NOFX_TP2_CLOSE_PCT", 0.4, 0.05, 0.95).min((0.95 - p1).max(0.05));
        Self {
            enabled: flag(
                v,
                "enabled",
                if defaults {
                    env_flag("NOFX_PARTIAL_TP", true)
                } else {
                    true
                },
            ),
            r1: n(v, "tp1R", env_num("NOFX_TP1_R", 1., 0.1, 10.)),
            r2: n(v, "tp2R", env_num("NOFX_TP2_R", 2., 0.1, 10.)),
            p1: n(v, "tp1ClosePct", p1),
            p2: n(v, "tp2ClosePct", p2),
            breakeven: flag(
                v,
                "moveStopToBreakEven",
                if defaults {
                    env_flag("NOFX_TP_BREAKEVEN", false)
                } else {
                    false
                },
            ),
        }
    }
}
struct State {
    plan: Value,
    initial: Value,
    revisions: Vec<Value>,
    interval: String,
    time: i64,
    expires: Option<i64>,
    entry: Option<f64>,
    entry_time: Option<i64>,
    held: u64,
    quantity: f64,
    entry_fee: f64,
    liquidation: Option<f64>,
    mark: Option<f64>,
    mark_at: Value,
    unrealized: f64,
    stage: usize,
    floor: Option<f64>,
    gross: f64,
    fee: f64,
    funding: f64,
    net: f64,
    realized_qty: f64,
    notional: f64,
    margin: f64,
    leverage: f64,
    costs: Costs,
    long: bool,
}
impl State {
    fn checkpoint(&self) -> Value {
        json!({"nextTime":self.time,"entry":self.entry,"entryAt":self.entry_time.map(iso),
        "heldBars":self.held,"quantity":self.quantity,"entryFee":self.entry_fee,"liquidationPrice":self.liquidation,
        "markPrice":self.mark,"markAt":self.mark_at,"unrealized":self.unrealized,"tpStage":self.stage,"tpStopFloor":self.floor,
        "realizedGross":self.gross,"realizedFee":self.fee,"realizedFunding":self.funding,"realizedNet":self.net,"realizedQty":self.realized_qty})
    }
    fn direction(&self) -> f64 {
        if self.long { 1. } else { -1. }
    }
    fn funding_for(&self, notional: f64, exit: i64) -> f64 {
        notional * self.costs.funding / 10000. * (exit - self.entry_time.unwrap_or(exit)) as f64
            / 28_800_000.
    }
    fn protection(&self, dynamic: bool) -> Value {
        if !dynamic || self.revisions.is_empty() {
            return self.plan.clone();
        }
        if let Some(rev) = self.revisions.iter().rev().find(|r| {
            timestamp(&r["effectiveFrom"])
                .map(|t| t <= self.time)
                .unwrap_or(false)
        }) {
            let mut plan = self.plan.clone();
            plan["stopLoss"] = rev["stopLoss"].clone();
            plan["takeProfit"] = rev["takeProfit"].clone();
            plan
        } else if self.initial.is_object() {
            self.initial.clone()
        } else {
            self.plan.clone()
        }
    }
}
fn state(input: &Value, config: &Value) -> Result<State> {
    let signal = !input["eligible"].is_null();
    let costs = if signal {
        &config["costs"]
    } else if input["costs"].is_object() {
        &input["costs"]
    } else {
        &Value::Null
    };
    let notional = if signal {
        n(&config["costs"], "notional", 10.)
    } else {
        n(input, "notional", 10.)
    };
    let created = timestamp(&input["createdAt"]);
    let time = if signal {
        timestamp(&input["firstEntryAt"])
    } else {
        timestamp(&input["nextTime"]).or(created)
    }
    .context("Order requires nextTime / createdAt, or signal firstEntryAt")?;
    let entry = if n(input, "entry", 0.) > 0. {
        Some(n(input, "entry", 0.))
    } else {
        None
    };
    let long = input["direction"] == "OPEN_LONG" || input["positionRecommendation"] == "OPEN_LONG";
    let leverage = if signal { 1. } else { n(input, "leverage", 1.) };
    let account = config["mode"] == "account";
    let liquidation = number(&input["liquidationPrice"], f64::NAN);
    let liquidation = if liquidation.is_finite() {
        Some(liquidation)
    } else if flag(config, "enableLiquidation", account) && entry.is_some() && leverage > 1. {
        entry.map(|e| e * (1. - (if long { 1. } else { -1. }) * (1. / leverage - 0.005)))
    } else {
        None
    };
    let ttl = n(config, "pendingOrderTtlMs", 86_400_000.);
    let ttl = if ttl > 0. { ttl as i64 } else { 86_400_000 };
    Ok(State {
        plan: input["plan"].clone(),
        initial: input["initialPlan"].clone(),
        revisions: input["protectionRevisions"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        interval: input["interval"].as_str().unwrap_or("1m").into(),
        time,
        expires: created.and_then(|t| t.checked_add(ttl)),
        entry,
        entry_time: timestamp(&input["entryAt"]),
        held: n(input, "heldBars", 0.) as u64,
        quantity: n(input, "quantity", 0.),
        entry_fee: n(input, "entryFee", 0.),
        liquidation,
        mark: input["markPrice"].as_f64(),
        mark_at: input["markAt"].clone(),
        unrealized: n(input, "unrealized", 0.),
        stage: n(input, "tpStage", 0.) as usize,
        floor: input["tpStopFloor"].as_f64(),
        gross: n(input, "realizedGross", 0.),
        fee: n(input, "realizedFee", 0.),
        funding: n(input, "realizedFunding", 0.),
        net: n(input, "realizedNet", 0.),
        realized_qty: n(input, "realizedQty", 0.),
        notional,
        margin: if signal {
            notional
        } else {
            n(input, "margin", notional)
        },
        leverage,
        costs: Costs::from(costs),
        long,
    })
}

fn stop_reason(s: &State, stop: f64, be_dist: f64) -> &'static str {
    let initial = n(&s.initial, "stopLoss", n(&s.plan, "stopLoss", 0.));
    let entry = s.entry.unwrap_or(0.);
    if [initial, entry, stop]
        .iter()
        .any(|x| !x.is_finite() || *x <= 0.)
    {
        return "stop_loss";
    }
    if !(if s.long {
        stop > initial + entry * 1e-6
    } else {
        stop < initial - entry * 1e-6
    }) {
        return "stop_loss";
    }
    if be_dist > 0. && (stop - entry - s.direction() * be_dist).abs() <= entry * 2e-4 {
        "break_even_stop"
    } else {
        "trailing_stop"
    }
}
fn merge(mut base: Value, other: Value) -> Value {
    for (k, v) in other.as_object().into_iter().flatten() {
        base[k] = v.clone();
    }
    base
}

/// Stable close codes also accept historical Chinese explanations retained by older records.
pub fn normalize_close_reason(reason: &str) -> &str {
    match reason {
        "stop_loss"
        | "take_profit"
        | "partial_take_profit"
        | "trailing_stop"
        | "break_even_stop"
        | "timeout"
        | "liquidation"
        | "smart_exit_ma"
        | "smart_exit_rsi"
        | "smart_exit_macd"
        | "manual"
        | "strategy_cancelled" => return reason,
        _ => {}
    }
    let reason = reason.trim();
    if reason.contains("均线失守")
        || reason.contains("趋势证伪")
        || ((reason.contains("跌破") || reason.contains("突破")) && reason.contains("均线"))
    {
        "smart_exit_ma"
    } else if reason.contains("RSI") {
        "smart_exit_rsi"
    } else if reason.contains("MACD") {
        "smart_exit_macd"
    } else if reason.contains("保本") {
        "break_even_stop"
    } else if reason.contains("移动止损") || reason.contains("跟踪止损") {
        "trailing_stop"
    } else if reason.contains("止盈") || reason.contains("获利了结") {
        "take_profit"
    } else if reason.contains("止损") {
        "stop_loss"
    } else if reason.contains("到期") || reason.contains("超时") {
        "timeout"
    } else if reason.contains("爆仓") || reason.contains("强平") {
        "liquidation"
    } else {
        "manual"
    }
}

fn settle(
    s: &State,
    price: f64,
    exit_time: i64,
    reason: &str,
    ambiguous: bool,
    adverse: f64,
    isolated: bool,
) -> Value {
    let entry = s.entry.unwrap();
    let exit = price * (1. - s.direction() * s.costs.slip / 10000.);
    let original = s.realized_qty + s.quantity;
    let share = if original > 0. {
        s.quantity / original
    } else {
        0.
    };
    let gross = s.direction() * (exit - entry) * s.quantity;
    let entry_fee = (if s.entry_fee != 0. {
        s.entry_fee
    } else {
        s.notional * s.costs.fee / 10000.
    }) * share;
    let exit_fee = exit * s.quantity * s.costs.fee / 10000.;
    let funding = s.funding_for(s.notional * share, exit_time);
    let raw = gross - entry_fee - exit_fee - funding + s.net;
    let max_loss = -s.margin - s.entry_fee;
    let net = if isolated && raw < 0. {
        raw.max(max_loss)
    } else {
        raw
    };
    json!({"status":"closed","reason":reason,"entry":entry,"exit":exit,"entryAt":s.entry_time.map(iso),"exitAt":iso(exit_time),
        "gross":gross+s.gross,"fee":entry_fee+exit_fee+s.fee,"fees":entry_fee+exit_fee+s.fee,"fundingReserve":funding+s.funding,"funding":funding+s.funding,
        "net":net,"netReturn":net/s.notional,"roi":net/s.margin,"heldBars":s.held,"adverseReturnUpperBound":adverse,"isolatedLossAdjustment":net-raw,
        "ambiguousBar":ambiguous,"partialFills":s.stage})
}

/// Force an existing position closed at the current mark (manual / strategy review / backtest end).
pub fn close_order(
    input: &Value,
    price: f64,
    now: i64,
    reason: &str,
    config: &Value,
) -> Result<Value> {
    if !(price.is_finite() && price > 0.) {
        bail!("Invalid close price");
    }
    let mut s = state(input, config)?;
    if s.entry.is_none() {
        bail!("Cannot close an unfilled order");
    }
    if s.entry_time.map(|t| now < t).unwrap_or(false) {
        bail!("Close time precedes order entry");
    }
    s.time = now;
    let code = normalize_close_reason(reason);
    let mut result = merge(
        s.checkpoint(),
        settle(
            &s,
            price,
            now,
            code,
            false,
            0.,
            flag(config, "enableIsolatedMargin", config["mode"] == "account"),
        ),
    );
    result["unrealized"] = json!(0.);
    result["error"] = json!("");
    result["needsReplayAnalysis"] = json!(true);
    result["reasonDetail"] = json!(if reason == code { "" } else { reason });
    Ok(result)
}

pub fn evaluate(input: &Value, rows: &[Value], now: i64, config: &Value) -> Result<Value> {
    if input["eligible"] == false || !input["plan"].is_object() {
        return Ok(json!({"status":"excluded"}));
    }
    let mut s = state(input, config)?;
    let account = config["mode"] == "account";
    let liquidate = flag(config, "enableLiquidation", account);
    let isolated = flag(config, "enableIsolatedMargin", account);
    let dynamic = flag(config, "enableDynamicProtection", account);
    let partial = Partial::from(&s.plan["exitRules"]["partialTp"]);
    let be_bps = 2. * (s.costs.fee + s.costs.slip)
        + n(
            &s.plan["exitRules"]["trailing"],
            "breakEvenCostBufferBps",
            env_num("NOFX_TRAIL_BREAKEVEN_BUFFER_BPS", 4., 0., 200.),
        );
    let smart = if s.plan["exitRules"]["smartExit"].is_object() {
        s.plan["exitRules"]["smartExit"].clone()
    } else {
        s.plan["smartExit"].clone()
    };
    let ma_exit = smart.is_object()
        && flag(&smart, "barLevelEnabled", flag(&smart, "enabled", true))
        && flag(&smart, "barLevel", true);
    let ma_period = n(&smart, "maPeriod", 20.) as usize;
    let ma_period = if ma_period > 1 { ma_period } else { 20 };
    let atr_period = n(&smart, "atrPeriod", 14.) as usize;
    let atr_period = if atr_period > 1 { atr_period } else { 14 };
    let mut by_time = BTreeMap::new();
    for row in rows {
        if let Some(t) = timestamp(&row["openTime"]) {
            by_time.insert(t, row);
        }
    }
    let mut ma_at = BTreeMap::new();
    if ma_exit {
        let ordered: Vec<_> = by_time.iter().collect();
        for (i, (t, _)) in ordered.iter().enumerate() {
            if i + 1 >= ma_period && i >= atr_period {
                let ma = ordered[i + 1 - ma_period..=i]
                    .iter()
                    .map(|(_, r)| n(r, "close", f64::NAN))
                    .sum::<f64>()
                    / ma_period as f64;
                let atr = (i + 1 - atr_period..=i)
                    .map(|k| {
                        let r = ordered[k].1;
                        let prev = n(ordered[k - 1].1, "close", f64::NAN);
                        (n(r, "high", 0.) - n(r, "low", 0.))
                            .max((n(r, "high", 0.) - prev).abs())
                            .max((n(r, "low", 0.) - prev).abs())
                    })
                    .sum::<f64>()
                    / atr_period as f64;
                ma_at.insert(**t, (ma, atr));
            }
        }
    }
    let mut adverse: f64 = 0.;
    let mut entry_via_limit = false;
    let mut levels: Option<Vec<(f64, f64)>> = None;
    while next_open(s.time, &s.interval)? <= now {
        if s.entry.is_none() && s.expires.map(|t| s.time >= t).unwrap_or(false) {
            return Ok(merge(
                s.checkpoint(),
                json!({"status":"expired","reason":"pending_expired","expiresAt":s.expires.map(iso)}),
            ));
        }
        let row = by_time.get(&s.time).copied();
        if !row
            .map(|r| {
                valid_candle(r)
                    && timestamp(&r["refreshedAt"])
                        .map(|t| t >= next_open(s.time, &s.interval).unwrap())
                        .unwrap_or(true)
            })
            .unwrap_or(false)
        {
            return Ok(merge(
                s.checkpoint(),
                json!({"status":"data_gap","missingAt":iso(s.time)}),
            ));
        }
        let row = row.unwrap();
        let end = next_open(s.time, &s.interval)?;
        let p = s.protection(dynamic);
        let open = n(row, "open", 0.);
        let high = n(row, "high", 0.);
        let low = n(row, "low", 0.);
        let close = n(row, "close", 0.);
        let stop = n(&p, "stopLoss", f64::NAN);
        let target = n(&p, "takeProfit", f64::NAN);
        if s.entry.is_none() {
            let limit = n(&p, "entryLimit", f64::NAN);
            let is_limit = p["entryStyle"] != "market" && limit.is_finite() && limit > 0.;
            let touched = if is_limit {
                if s.long { low <= limit } else { high >= limit }
            } else {
                open >= n(&p, "entryMin", f64::NAN) && open <= n(&p, "entryMax", f64::NAN)
            };
            if touched {
                let price = (if is_limit { limit } else { open })
                    * (1. + s.direction() * s.costs.slip / 10000.);
                if if s.long {
                    price > stop && price < target
                } else {
                    price < stop && price > target
                } {
                    s.entry = Some(price);
                    s.entry_time = Some(s.time);
                    s.quantity = s.notional / price;
                    s.entry_fee = s.notional * s.costs.fee / 10000.;
                    entry_via_limit = is_limit;
                    if liquidate && s.leverage > 1. {
                        s.liquidation =
                            Some(price * (1. - s.direction() * (1. / s.leverage - 0.005)));
                    }
                }
            }
        }
        if let Some(entry) = s.entry {
            s.held += 1;
            s.mark = Some(close);
            s.mark_at = json!(iso(end));
            adverse = adverse
                .max(if s.long {
                    (entry - low) / entry
                } else {
                    (high - entry) / entry
                })
                .max(0.);
            let mut working = if let Some(floor) = s.floor.filter(|x| *x > 0.) {
                if s.long {
                    stop.max(floor)
                } else {
                    stop.min(floor)
                }
            } else {
                stop
            };
            let entry_bar = entry_via_limit && s.held == 1;
            let protected = if s.long {
                low <= working
            } else {
                high >= working
            };
            let liq = liquidate
                && s.liquidation
                    .map(|p| if s.long { low <= p } else { high >= p })
                    .unwrap_or(false);
            if levels.is_none() {
                let risk = n(&s.plan, "riskUnit", 0.);
                let risk = if risk > 0. {
                    risk
                } else {
                    (entry - n(&s.initial, "stopLoss", stop)).abs()
                };
                let mut computed = vec![];
                if partial.enabled && risk.is_finite() && risk > 0. {
                    for (r, pct) in [(partial.r1, partial.p1), (partial.r2, partial.p2)] {
                        let price = entry + s.direction() * r * risk;
                        if target <= 0.
                            || !target.is_finite()
                            || (if s.long {
                                price < target
                            } else {
                                price > target
                            })
                        {
                            computed.push((price, pct));
                        }
                    }
                }
                levels = Some(computed);
            }
            if !entry_bar && !protected && !liq {
                let levels = levels.as_ref().unwrap();
                while s.stage < levels.len() {
                    let (price, pct) = levels[s.stage];
                    if !(if s.long { high >= price } else { low <= price }) {
                        break;
                    }
                    let original = s.realized_qty + s.quantity;
                    let qty = (original * pct).min(s.quantity);
                    if qty <= 0. {
                        break;
                    }
                    let exit = price * (1. - s.direction() * s.costs.slip / 10000.);
                    let share = if original > 0. { qty / original } else { 0. };
                    let gross = s.direction() * (exit - entry) * qty;
                    let fee = s.entry_fee * share + exit * qty * s.costs.fee / 10000.;
                    let funding = s.funding_for(s.notional * share, end);
                    s.gross += gross;
                    s.fee += fee;
                    s.funding += funding;
                    s.net += gross - fee - funding;
                    s.realized_qty += qty;
                    s.quantity = (s.quantity - qty).max(0.);
                    s.stage += 1;
                    if partial.breakeven {
                        let be = entry + s.direction() * entry * be_bps / 10000.;
                        let floor = if let Some(old) = s.floor.filter(|x| *x > 0.) {
                            if s.long { old.max(be) } else { old.min(be) }
                        } else {
                            be
                        };
                        s.floor = Some(floor);
                        working = if s.long {
                            working.max(floor)
                        } else {
                            working.min(floor)
                        };
                    }
                }
            }
            let original = s.realized_qty + s.quantity;
            let share = if original > 0. {
                s.quantity / original
            } else {
                1.
            };
            s.unrealized = s.direction() * (close - entry) * s.quantity
                - s.funding_for(s.notional * share, end);
            let stop_code = stop_reason(
                &s,
                working,
                if partial.breakeven {
                    entry * be_bps / 10000.
                } else {
                    0.
                },
            );
            let tp_code = if s.stage > 0 {
                "partial_take_profit"
            } else {
                "take_profit"
            };
            let hit_stop = if s.long {
                low <= working
            } else {
                high >= working
            };
            let hit_tp = if s.long {
                high >= target
            } else {
                low <= target
            };
            let mut exit = None;
            if liq {
                let price = s.liquidation.unwrap();
                let beyond = if s.long { open <= price } else { open >= price };
                let stop_before = if s.long {
                    working > price
                } else {
                    working < price
                };
                if beyond || !stop_before {
                    exit = Some(("liquidation", if beyond { open } else { price }, hit_tp));
                }
            }
            if exit.is_none() {
                if entry_bar {
                    if hit_stop {
                        exit = Some((stop_code, working, true));
                    }
                } else if hit_stop && hit_tp {
                    if if s.long {
                        open >= target
                    } else {
                        open <= target
                    } {
                        exit = Some((
                            tp_code,
                            if s.long {
                                open.max(target)
                            } else {
                                open.min(target)
                            },
                            true,
                        ));
                    } else {
                        exit = Some((
                            stop_code,
                            if s.long {
                                open.min(working)
                            } else {
                                open.max(working)
                            },
                            true,
                        ));
                    }
                } else if hit_stop {
                    exit = Some((
                        stop_code,
                        if s.long {
                            open.min(working)
                        } else {
                            open.max(working)
                        },
                        false,
                    ));
                } else if hit_tp {
                    exit = Some((tp_code, target, false));
                } else if s.held as f64 >= n(&p, "maxHoldBars", f64::INFINITY) {
                    exit = Some(("timeout", close, false));
                }
            }
            if exit.is_none()
                && ma_exit
                && let Some((ma, atr)) = ma_at.get(&s.time)
            {
                let risk = n(&s.plan, "riskUnit", 0.);
                let profit = if risk > 0. {
                    s.direction() * (close - entry) / risk
                } else {
                    f64::NAN
                };
                let invalid = if s.long { close < *ma } else { close > *ma };
                let deviated = (close - ma).abs()
                    > atr
                        * n(
                            &smart,
                            "maBreakAtr",
                            env_num("NOFX_SMART_MA_ATR", 1., 0.2, 5.),
                        );
                if atr.is_finite()
                    && *atr > 0.
                    && invalid
                    && deviated
                    && (!profit.is_finite()
                        || profit
                            < n(
                                &smart,
                                "maExitMaxProfitR",
                                env_num("NOFX_SMART_MA_EXIT_MAX_R", 0.4, 0., 20.),
                            ))
                    && s.held as f64
                        >= n(
                            &smart,
                            "minHoldBars",
                            env_num("NOFX_SMART_MIN_HOLD", 0., 0., 1000.),
                        )
                {
                    exit = Some(("smart_exit_ma", close, false));
                }
            }
            if let Some((reason, price, ambiguous)) = exit {
                let result = settle(&s, price, end, reason, ambiguous, adverse, isolated);
                s.time = end;
                return Ok(merge(s.checkpoint(), result));
            }
        }
        s.time = end;
    }
    let status = if s.entry.is_some() { "open" } else { "pending" };
    Ok(merge(s.checkpoint(), json!({"status":status})))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn order() -> Value {
        json!({"direction":"OPEN_LONG","interval":"1m","createdAt":iso(0),"nextTime":0,"notional":1000.,"margin":100.,"leverage":10.,"costs":{"feeBps":0,"slippageBps":0,"fundingBpsPer8h":0},"plan":{"entryStyle":"market","entryMin":99.,"entryMax":101.,"stopLoss":90.,"takeProfit":140.,"riskUnit":10.,"maxHoldBars":100,"exitRules":{"partialTp":{"enabled":false}}}})
    }
    fn row(t: i64, o: f64, h: f64, l: f64, c: f64) -> Value {
        json!({"openTime":t,"open":o,"high":h,"low":l,"close":c,"volume":1,"confirmed":true})
    }
    #[test]
    fn gap_is_resumable_and_expiry_precedes_data() {
        let o = order();
        let gap = evaluate(&o, &[], 60000, &json!({})).unwrap();
        assert_eq!(gap["status"], "data_gap");
        assert_eq!(gap["nextTime"], 0);
        let mut o = o;
        o["nextTime"] = json!(120000);
        let expired = evaluate(&o, &[], 180000, &json!({"pendingOrderTtlMs":120000})).unwrap();
        assert_eq!(expired["status"], "expired");
    }
    #[test]
    fn limit_entry_cannot_use_preentry_target() {
        let mut o = order();
        o["plan"]["entryStyle"] = json!("limit");
        o["plan"]["entryLimit"] = json!(100.);
        o["plan"]["takeProfit"] = json!(110.);
        let r = evaluate(&o, &[row(0, 115., 118., 99., 102.)], 60000, &json!({})).unwrap();
        assert_eq!(r["status"], "open");
        let r = evaluate(&o, &[row(0, 115., 118., 89., 102.)], 60000, &json!({})).unwrap();
        assert_eq!(r["reason"], "stop_loss");
        assert_eq!(r["exit"], 90.);
    }
    #[test]
    fn partial_checkpoint_equals_single_pass() {
        let mut o = order();
        o["plan"]["exitRules"]["partialTp"] = json!({"enabled":true,"tp1R":1,"tp2R":2,"tp1ClosePct":0.4,"tp2ClosePct":0.4,"moveStopToBreakEven":false});
        let rows = vec![
            row(0, 100., 105., 99., 101.),
            row(60000, 101., 111., 100., 109.),
            row(120000, 109., 125., 108., 122.),
            row(180000, 122., 141., 120., 140.),
        ];
        let first = evaluate(&o, &rows, 120000, &json!({})).unwrap();
        assert_eq!(first["tpStage"], 1);
        let resumed = evaluate(&merge(o.clone(), first), &rows, 240000, &json!({})).unwrap();
        let whole = evaluate(&o, &rows, 240000, &json!({})).unwrap();
        assert_eq!(resumed["net"], whole["net"]);
        assert_eq!(whole["quantity"], 2.);
        assert_eq!(whole["partialFills"], 2);
        assert_eq!(whole["net"], 200.);
    }
    #[test]
    fn stop_before_liquidation_and_isolated_cap() {
        let mut o = order();
        o["plan"]["stopLoss"] = json!(95.);
        let r = evaluate(
            &o,
            &[row(0, 100., 102., 20., 50.)],
            60000,
            &json!({"enableLiquidation":true,"enableIsolatedMargin":true}),
        )
        .unwrap();
        assert_eq!(r["reason"], "stop_loss");
        assert_eq!(r["net"], -50.);
        let first = evaluate(
            &o,
            &[row(0, 100., 102., 98., 101.)],
            60000,
            &json!({"enableLiquidation":true}),
        )
        .unwrap();
        let r = evaluate(
            &merge(o, first),
            &[row(60000, 20., 22., 10., 15.)],
            120000,
            &json!({"enableLiquidation":true,"enableIsolatedMargin":true}),
        )
        .unwrap();
        assert_eq!(r["reason"], "liquidation");
        assert_eq!(r["net"], -100.);
        assert!(r["isolatedLossAdjustment"].as_f64().unwrap() > 0.);
    }
    #[test]
    fn dynamic_revisions_apply_only_at_effective_time() {
        let mut o = order();
        o["initialPlan"] = o["plan"].clone();
        o["plan"]["stopLoss"] = json!(105.);
        o["protectionRevisions"] =
            json!([{"effectiveFrom":60000,"stopLoss":105.,"takeProfit":140.}]);
        let r = evaluate(
            &o,
            &[
                row(0, 100., 110., 99., 108.),
                row(60000, 108., 110., 104., 106.),
            ],
            120000,
            &json!({"enableDynamicProtection":true}),
        )
        .unwrap();
        assert_eq!(r["entry"], 100.);
        assert_eq!(r["reason"], "trailing_stop");
        assert_eq!(r["exit"], 105.);
    }
    #[test]
    fn fees_and_funding_are_notional_scaled() {
        let mut o = order();
        o["costs"] = json!({"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3});
        o["plan"]["maxHoldBars"] = json!(1);
        let r = evaluate(&o, &[row(0, 100., 101., 99., 100.)], 60000, &json!({})).unwrap();
        let entry = 100.05;
        let exit = 99.95;
        let q = 1000. / entry;
        let expected = (exit - entry) * q - 0.6 - exit * q * 0.0006 - 1000. * 0.0003 / 480.;
        assert!((r["net"].as_f64().unwrap() - expected).abs() < 1e-9);
    }
}
