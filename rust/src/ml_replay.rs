//! Serial, finite-capital replay for classification policies.
//!
//! This module only operates on in-memory snapshots. Fills, exits, fees, funding,
//! partial take profits and marking come from the production paper simulator.
//! It never constructs an exchange client or invokes the database-backed submit.
use crate::{iso, number, paper, research, simulator, strategies, timestamp};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

/// A decision made at a closed candle boundary. Probabilities and metadata are
/// retained verbatim so every model version, fold and rejected signal is auditable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaySignal {
    pub origin_ms: i64,
    pub decision: String,
    #[serde(default)]
    pub probabilities: Value,
    #[serde(default)]
    pub metadata: Value,
    /// Optional existing strategy plan. Omit for the common ATR protection plan.
    #[serde(default)]
    pub plan: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ReplayConfig {
    /// Genuine source-candle duration. Existing serialized configurations default
    /// to 1h; 15m data must be fetched independently rather than interpolated.
    pub candle_interval_ms: i64,
    pub starting_equity: f64,
    /// Zero selects the earliest supplied signal (or first candle close).
    pub start_ms: i64,
    /// i64::MAX selects the last supplied candle close.
    pub end_ms: i64,
    pub allow_buy: bool,
    pub allow_sell: bool,
    pub risk_fraction: f64,
    pub max_notional_fraction: f64,
    pub max_notional_usdt: f64,
    pub daily_loss_fraction: f64,
    pub max_drawdown_fraction: f64,
}

impl Default for ReplayConfig {
    fn default() -> Self {
        Self {
            candle_interval_ms: HOUR,
            starting_equity: 1000.,
            start_ms: 0,
            end_ms: i64::MAX,
            allow_buy: true,
            allow_sell: true,
            risk_fraction: 0.01,
            max_notional_fraction: 0.20,
            max_notional_usdt: 50.,
            daily_loss_fraction: 0.03,
            max_drawdown_fraction: 0.10,
        }
    }
}

impl ReplayConfig {
    pub fn candle_interval(&self) -> Result<&'static str> {
        match self.candle_interval_ms {
            HOUR => Ok("1h"),
            900_000 => Ok("15m"),
            _ => bail!("ML replay supports genuine 1h or 15m candles"),
        }
    }

    /// Preserve the existing 24-candle pending window when changing timeframe.
    pub fn pending_order_ttl_ms(&self) -> i64 {
        24 * self.candle_interval_ms
    }

    fn validate(&self) -> Result<()> {
        self.candle_interval()?;
        ensure!(
            self.starting_equity.is_finite() && self.starting_equity > 0.,
            "Starting equity must be finite and positive"
        );
        // These are hard upper bounds. Configuration can only tighten them.
        for (name, value, ceiling) in [
            ("risk_fraction", self.risk_fraction, 0.01),
            ("max_notional_fraction", self.max_notional_fraction, 0.20),
            ("max_notional_usdt", self.max_notional_usdt, 100.),
            ("daily_loss_fraction", self.daily_loss_fraction, 0.03),
            ("max_drawdown_fraction", self.max_drawdown_fraction, 0.10),
        ] {
            ensure!(
                value.is_finite() && value > 0. && value <= ceiling,
                "{name} must be positive and no greater than {ceiling}"
            );
        }
        Ok(())
    }
}

fn canonical_decision(value: &str) -> Result<&'static str> {
    match value.to_ascii_uppercase().as_str() {
        "BUY" | "OPEN_LONG" => Ok("BUY"),
        "SELL" | "OPEN_SHORT" => Ok("SELL"),
        "HOLD" | "WAIT" => Ok("HOLD"),
        _ => bail!("Unknown decision {value}; expected BUY, SELL or HOLD"),
    }
}

fn close_at(row: &Value, interval_ms: i64) -> Result<i64> {
    timestamp(&row["openTime"])
        .context("Invalid candle openTime")?
        .checked_add(interval_ms)
        .context("Candle timestamp overflow")
}

fn active(order: &Value) -> bool {
    matches!(order["status"].as_str(), Some("pending" | "open"))
}

fn confidence(signal: &ReplaySignal, decision: &str) -> f64 {
    signal.probabilities[decision]
        .as_f64()
        .or_else(|| signal.metadata["confidence"].as_f64())
        .filter(|n| n.is_finite() && (0. ..=1.).contains(n))
        .unwrap_or(0.5)
}

/// Build/validate a plan using only the closed prefix. The common 11 held bars
/// account for the production one-candle entry delay in a 12-candle prediction.
/// This compatibility entry point retains the original 1h semantics.
pub fn normalize_signal(
    symbol: &str,
    closed_prefix: &[Value],
    signal: &ReplaySignal,
) -> Result<Value> {
    normalize_signal_with_config(symbol, closed_prefix, signal, &ReplayConfig::default())
}

pub fn normalize_signal_with_config(
    symbol: &str,
    closed_prefix: &[Value],
    signal: &ReplaySignal,
    config: &ReplayConfig,
) -> Result<Value> {
    config.validate()?;
    ensure!(closed_prefix.len() >= 15, "ATR needs 15 closed candles");
    for pair in closed_prefix.windows(2) {
        let previous = timestamp(&pair[0]["openTime"]).context("Invalid prefix candle time")?;
        let next = timestamp(&pair[1]["openTime"]).context("Invalid prefix candle time")?;
        ensure!(
            previous.rem_euclid(config.candle_interval_ms) == 0
                && next == previous + config.candle_interval_ms,
            "Signal prefix must contain contiguous candles of its configured interval"
        );
    }
    ensure!(
        close_at(
            closed_prefix.last().context("Empty closed prefix")?,
            config.candle_interval_ms
        )? == signal.origin_ms,
        "Signal origin must equal the latest closed candle boundary"
    );
    let decision = canonical_decision(&signal.decision)?;
    let market = research::prepare_market(
        symbol,
        config.candle_interval()?,
        closed_prefix,
        closed_prefix.len().min(256),
        signal.origin_ms,
    )?;
    let current = number(&closed_prefix.last().unwrap()["close"], f64::NAN);
    let atr = strategies::atr(closed_prefix, 14);
    ensure!(atr.is_finite() && atr > 0., "Invalid closed-prefix ATR");
    let long = decision == "BUY";
    let direction = if long { 1. } else { -1. };
    let plan = signal.plan.clone().unwrap_or_else(|| {
        json!({"entryStyle":"market","entryMin":current-0.5*atr,"entryMax":current+0.5*atr,
            "stopLoss":current-direction*2.*atr,"takeProfit":current+direction*5.*atr,
            "riskUnit":2.*atr,"maxHoldBars":11})
    });
    let raw = json!({"positionRecommendation":decision,"confidence":confidence(signal,decision),
        "recommendedLeverage":1,"reason":"Frozen classification policy, shared Rust replay",
        "plan":if decision=="HOLD" {Value::Null} else {plan}});
    let mut normalized = research::normalize_plan(&raw, &market, signal.origin_ms);
    normalized["confidenceType"] = json!(if signal.probabilities.is_object() {
        "classifier_probability"
    } else {
        "policy_score"
    });
    normalized["probabilities"] = signal.probabilities.clone();
    normalized["policyMetadata"] = signal.metadata.clone();
    normalized["riskAtr"] = json!(atr);
    normalized["analysisEngine"] = json!("local_ml_replay");
    normalized["pendingOrderTtlMs"] = json!(config.pending_order_ttl_ms());
    Ok(normalized)
}

/// Conservative size at the worst permitted entry and stop, with the same cost
/// constants used by the production simulator. Price gaps can exceed this budget.
pub fn position_size(signal: &Value, equity: f64, config: &ReplayConfig) -> Result<Value> {
    config.validate()?;
    ensure!(equity.is_finite() && equity > 0., "Non-positive equity");
    ensure!(signal["eligible"] == true, "Signal has no eligible plan");
    let costs = research::costs();
    let fee = number(&costs["feeBps"], 6.) / 10_000.;
    let slip = number(&costs["slippageBps"], 5.) / 10_000.;
    let funding = number(&costs["fundingBpsPer8h"], 3.) / 10_000.;
    let long = signal["positionRecommendation"] == "OPEN_LONG";
    let dir = if long { 1. } else { -1. };
    let plan = &signal["plan"];
    if plan["entryStyle"] != "market"
        && let Some(limit) = plan["entryLimit"].as_f64()
    {
        let min = number(&plan["entryMin"], f64::NAN);
        let max = number(&plan["entryMax"], f64::NAN);
        ensure!(
            limit.is_finite() && limit > 0. && limit >= min && limit <= max,
            "Limit entry is outside the risk-budgeted entry range"
        );
    }
    let entry =
        number(&plan[if long { "entryMax" } else { "entryMin" }], f64::NAN) * (1. + dir * slip);
    let stop = number(&plan["stopLoss"], f64::NAN) * (1. - dir * slip);
    let hold = number(&plan["maxHoldBars"], f64::NAN);
    ensure!(
        [entry, stop, hold].iter().all(|x| x.is_finite() && *x > 0.),
        "Invalid plan for risk sizing"
    );
    let stop_fraction = (entry - stop).abs() / entry;
    // Funding remains an absolute eight-hour clock, never a count of candles.
    let held_hours = hold * config.candle_interval_ms as f64 / HOUR as f64;
    let cost_fraction = fee + fee * stop / entry + funding * held_hours / 8.;
    let loss_fraction = stop_fraction + cost_fraction;
    let budget = equity * config.risk_fraction;
    let cap = config
        .max_notional_usdt
        .min(equity * config.max_notional_fraction);
    let margin = ((budget / loss_fraction).min(cap) * 100.).floor() / 100.;
    ensure!(
        margin >= 1.,
        "Risk budget is below the 1 USDT minimum margin"
    );
    Ok(
        json!({"margin_usdt":margin,"notional_usdt":margin,"leverage":1,
        "risk_budget_usdt":budget,"estimated_stop_loss_usdt":margin*loss_fraction,
        "worst_entry":entry,"stop_fill_before_gap":stop,"cost_fraction":cost_fraction,
        "notional_cap_usdt":cap}),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RiskLedger {
    peak: f64,
    max_drawdown: f64,
    day: Option<i64>,
    day_start: f64,
    daily_paused: bool,
    drawdown_halted: bool,
    daily_pause_days: usize,
    halt_at: Option<i64>,
}

impl RiskLedger {
    pub(crate) fn new(equity: f64) -> Self {
        Self {
            peak: equity,
            max_drawdown: 0.,
            day: None,
            day_start: equity,
            daily_paused: false,
            drawdown_halted: false,
            daily_pause_days: 0,
            halt_at: None,
        }
    }

    pub(crate) fn observe(&mut self, now: i64, equity: f64, config: &ReplayConfig) -> (f64, f64) {
        let day = now.div_euclid(DAY);
        if self.day != Some(day) {
            // The close at midnight establishes that day's opening equity.
            self.day = Some(day);
            self.day_start = equity;
            self.daily_paused = false;
        }
        self.peak = self.peak.max(equity);
        let drawdown = ((self.peak - equity) / self.peak).max(0.);
        let daily_loss = ((self.day_start - equity) / self.day_start).max(0.);
        self.max_drawdown = self.max_drawdown.max(drawdown);
        if daily_loss >= config.daily_loss_fraction && !self.daily_paused {
            self.daily_paused = true;
            self.daily_pause_days += 1;
        }
        if drawdown >= config.max_drawdown_fraction && !self.drawdown_halted {
            self.drawdown_halted = true;
            self.halt_at = Some(now);
        }
        (drawdown, daily_loss)
    }

    pub(crate) fn entry_block(&self) -> Option<&'static str> {
        if self.drawdown_halted {
            Some("达到模型账户最大回撤限制")
        } else if self.daily_paused {
            Some("达到模型账户当日亏损限制，等待下一 UTC 日")
        } else {
            None
        }
    }
}

/// Costs already reflected in production equity. Slippage is reconstructed from
/// fill quantities/prices; it is informational and MUST NOT be deducted again.
fn incurred_costs(order: &Value) -> Value {
    let entry = number(&order["entry"], 0.);
    if entry <= 0. {
        return json!({"fees_usdt":0.,"funding_usdt":0.,"slippage_usdt":0.});
    }
    let qty = number(&order["quantity"], 0.);
    let realized_qty = number(&order["realizedQty"], 0.);
    let original = qty + realized_qty;
    let closed = order["status"] == "closed";
    let realized_share = if original > 0. {
        realized_qty / original
    } else {
        0.
    };
    let entry_fee = number(&order["entryFee"], 0.);
    let fees = if closed {
        number(&order["fee"], 0.)
    } else {
        entry_fee + number(&order["realizedFee"], 0.) - entry_fee * realized_share
    };
    let dir = if order["direction"] == "OPEN_LONG" {
        1.
    } else {
        -1.
    };
    let open_funding =
        dir * (number(&order["markPrice"], entry) - entry) * qty - number(&order["unrealized"], 0.);
    let funding = if closed {
        number(&order["funding"], 0.)
    } else {
        number(&order["realizedFunding"], 0.) + open_funding.max(0.)
    };
    let slip = number(&order["costs"]["slippageBps"], 0.) / 10_000.;
    let entry_raw = entry / (1. + dir * slip);
    let exit_qty = if closed { original } else { realized_qty };
    let realized_gross = if closed {
        number(&order["gross"], 0.)
    } else {
        number(&order["realizedGross"], 0.)
    };
    let exit_value = (entry * exit_qty + dir * realized_gross).max(0.);
    let exit_slip = exit_value * slip / (1. - dir * slip);
    let slippage = (entry - entry_raw).abs() * original + exit_slip;
    json!({"fees_usdt":fees,"funding_usdt":funding,"slippage_usdt":slippage,
        "slippage_in_fill_prices":true,"slippage_deducted_again":false})
}

fn equity_point(
    account: &Value,
    now: i64,
    ledger: &RiskLedger,
    drawdown: f64,
    daily_loss: f64,
) -> Value {
    let funds = paper::account_summary(account, now);
    json!({"time_ms":now,"time":iso(now),"equity":funds["equity"],
        "balance":funds["balance"],"realized":funds["realized"],
        "unrealized":funds["unrealized"],"net":funds["net"],
        "used_margin":funds["usedMargin"],"fee_reserve":funds["feeReserve"],
        "open_orders":funds["openCount"],"drawdown_percent":drawdown*100.,
        "daily_loss_percent":daily_loss*100.,"daily_paused":ledger.daily_paused,
        "drawdown_halted":ledger.drawdown_halted})
}

/// Replay one symbol as one finite-capital account. Historical context preceding
/// start_ms is used only for causal features/plans, never for measured returns.
pub fn replay(
    symbol: &str,
    rows: &[Value],
    signals: &[ReplaySignal],
    config: &ReplayConfig,
) -> Result<Value> {
    config.validate()?;
    crate::exchange::valid_symbol(symbol)?;
    let interval_ms = config.candle_interval_ms;
    ensure!(!rows.is_empty(), "Replay requires closed candles");
    let mut closes = Vec::with_capacity(rows.len());
    for row in rows {
        ensure!(simulator::valid_candle(row), "Invalid replay candle");
        let end = close_at(row, interval_ms)?;
        ensure!(end.rem_euclid(interval_ms) == 0, "Unaligned replay candle");
        if let Some(previous) = closes.last() {
            ensure!(
                end == previous + interval_ms,
                "Missing or duplicate replay candle"
            );
        }
        closes.push(end);
    }
    let available_end = *closes.last().unwrap();
    let first_signal = signals.iter().map(|s| s.origin_ms).min();
    let start = if config.start_ms == 0 {
        first_signal.unwrap_or(closes[0])
    } else {
        config.start_ms
    };
    let end = if config.end_ms == i64::MAX {
        available_end
    } else {
        config.end_ms
    };
    ensure!(
        start.rem_euclid(interval_ms) == 0 && end.rem_euclid(interval_ms) == 0,
        "Replay boundaries must align to the configured candle interval"
    );
    ensure!(start <= end, "Replay start must not follow end");
    ensure!(
        start >= closes[0] && end <= available_end,
        "Requested replay period is outside the supplied candles"
    );
    let mut by_time: BTreeMap<i64, Vec<(usize, &ReplaySignal)>> = BTreeMap::new();
    let mut ignored_outside_window = 0;
    for (index, signal) in signals.iter().enumerate() {
        canonical_decision(&signal.decision)?;
        ensure!(
            signal.origin_ms.rem_euclid(interval_ms) == 0,
            "Unaligned signal origin"
        );
        if signal.origin_ms < start || signal.origin_ms > end {
            ignored_outside_window += 1;
            continue;
        }
        ensure!(
            closes.binary_search(&signal.origin_ms).is_ok(),
            "Signal origin lacks its closed prefix"
        );
        by_time
            .entry(signal.origin_ms)
            .or_default()
            .push((index, signal));
    }
    let mut account = json!({"initialBalance":config.starting_equity,
        "unlimitedCapital":false,"orders":[],"entriesPaused":false});
    let mut ledger = RiskLedger::new(config.starting_equity);
    let mut curve = vec![equity_point(&account, start, &ledger, 0., 0.)];
    let mut log = Vec::new();
    let mut last_equity = config.starting_equity;
    let mut decisions = BTreeMap::from([("BUY", 0_usize), ("SELL", 0), ("HOLD", 0)]);
    let mut rejection_counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, &now) in closes.iter().enumerate() {
        if now < start || now > end {
            continue;
        }
        let prefix = &rows[..=i];
        for order in account["orders"].as_array_mut().unwrap() {
            if active(order) {
                paper::advance_paper_order(order, prefix, now)?;
                ensure!(
                    order["error"].as_str().unwrap_or("").is_empty(),
                    "Shared simulator replay failed: {}",
                    order["error"]
                );
            }
        }
        let equity = number(&paper::account_summary(&account, now)["equity"], f64::NAN);
        ensure!(equity.is_finite(), "Non-finite shared account equity");
        let (drawdown, daily_loss) = ledger.observe(now, equity, config);
        last_equity = equity;
        for (index, signal) in by_time.get(&now).into_iter().flatten() {
            let decision = canonical_decision(&signal.decision)?;
            *decisions.get_mut(decision).unwrap() += 1;
            let mut item = json!({"signal_index":index,"origin_ms":now,"origin":iso(now),
                "decision":decision,"probabilities":signal.probabilities,"metadata":signal.metadata,
                "equity_before":equity,"drawdown_percent":drawdown*100.,
                "daily_loss_percent":daily_loss*100.,"outcome":"","order_id":Value::Null});
            let rejection = if decision == "HOLD" {
                Some("hold")
            } else if (decision == "BUY" && !config.allow_buy)
                || (decision == "SELL" && !config.allow_sell)
            {
                Some("direction_disabled")
            } else if ledger.drawdown_halted {
                Some("drawdown_halted")
            } else if ledger.daily_paused {
                Some("daily_loss_paused")
            } else if equity <= 0. {
                Some("non_positive_equity")
            } else if account["orders"].as_array().unwrap().iter().any(active) {
                Some("active_order")
            } else {
                None
            };
            if let Some(reason) = rejection {
                item["outcome"] = json!(reason);
            } else {
                match normalize_signal_with_config(symbol, prefix, signal, config) {
                    Ok(normalized) => {
                        item["normalized_signal"] = normalized.clone();
                        if normalized["eligible"] != true {
                            item["outcome"] = json!("invalid_plan");
                            item["error"] = normalized["validationIssues"].clone();
                        } else {
                            match position_size(&normalized, equity, config) {
                                Ok(size) => {
                                    item["sizing"] = size.clone();
                                    let record = json!({"id":format!("ml-replay-{symbol}-{now}-{index}"),
                                        "marketProvider":"binance","analysisEngine":"local_ml_replay",
                                        "snapshot":{"model":signal.metadata},"analyses":[normalized]});
                                    match paper::submit_paper_order(
                                        &mut account,
                                        &record,
                                        &json!({"symbol":symbol,"margin":size["margin_usdt"],"leverage":1}),
                                        now,
                                    ) {
                                        Ok(order) => {
                                            item["outcome"] = json!("submitted");
                                            item["order_id"] = order["id"].clone();
                                            item["first_entry_at"] = order["nextTime"].clone();
                                        }
                                        Err(error) => {
                                            item["outcome"] = json!("submission_rejected");
                                            item["error"] = json!(error.to_string());
                                        }
                                    }
                                }
                                Err(error) => {
                                    item["outcome"] = json!("risk_size_rejected");
                                    item["error"] = json!(error.to_string());
                                }
                            }
                        }
                    }
                    Err(error) => {
                        item["outcome"] = json!("invalid_prefix");
                        item["error"] = json!(error.to_string());
                    }
                }
            }
            if item["outcome"] != "submitted" {
                *rejection_counts
                    .entry(item["outcome"].as_str().unwrap().to_owned())
                    .or_default() += 1;
            }
            log.push(item);
        }
        let point = equity_point(&account, now, &ledger, drawdown, daily_loss);
        if curve.last().unwrap()["time_ms"] == now {
            *curve.last_mut().unwrap() = point;
        } else {
            curve.push(point);
        }
    }
    let mut orders = account["orders"].as_array().unwrap().clone();
    orders.reverse();
    let closed: Vec<_> = orders
        .iter()
        .filter(|o| o["status"] == "closed")
        .cloned()
        .collect();
    let wins: Vec<_> = closed
        .iter()
        .filter(|o| number(&o["net"], 0.) > 0.)
        .collect();
    let losses: Vec<_> = closed
        .iter()
        .filter(|o| number(&o["net"], 0.) < 0.)
        .collect();
    let profit = wins.iter().map(|o| number(&o["net"], 0.)).sum::<f64>();
    let loss = losses.iter().map(|o| -number(&o["net"], 0.)).sum::<f64>();
    let settled_net = closed.iter().map(|o| number(&o["net"], 0.)).sum::<f64>();
    let avg_win = (!wins.is_empty()).then(|| profit / wins.len() as f64);
    let avg_loss = (!losses.is_empty()).then(|| loss / losses.len() as f64);
    let payoff = avg_win.zip(avg_loss).map(|(win, loss)| win / loss);
    let unresolved = orders.iter().filter(|o| active(o)).count();
    let mut fees = 0.;
    let mut funding = 0.;
    let mut slippage = 0.;
    for order in &mut orders {
        let cost = incurred_costs(order);
        fees += number(&cost["fees_usdt"], 0.);
        funding += number(&cost["funding_usdt"], 0.);
        slippage += number(&cost["slippage_usdt"], 0.);
        order["incurred_costs"] = cost;
    }
    let metrics = json!({"signals":log.len(),"decisions":decisions,"submitted_orders":orders.len(),
            "entered_trades":orders.iter().filter(|o|number(&o["entry"],0.)>0.).count(),
            "closed_trades":closed.len(),"wins":wins.len(),"losses":losses.len(),
            "expired_orders":orders.iter().filter(|o|o["status"]=="expired").count(),
            "unresolved_orders":unresolved,"comparison_complete":unresolved==0,
            "final_equity":last_equity,"net_pnl_usdt":last_equity-config.starting_equity,
            "settled_net_usdt":settled_net,"return_percent":(last_equity/config.starting_equity-1.)*100.,
            "max_drawdown_percent":ledger.max_drawdown*100.,
            "win_rate_percent":(!closed.is_empty()).then(||wins.len() as f64/closed.len() as f64*100.),
            "profit_factor":(loss>0.).then(||profit/loss),"avg_win_usdt":avg_win,
            "avg_loss_usdt":avg_loss,"payoff_ratio":payoff,
            "fees_usdt":fees,"funding_usdt":funding,"slippage_usdt":slippage,
            "slippage_in_fill_prices":true,"slippage_deducted_again":false,
            "daily_pause_days":ledger.daily_pause_days,"drawdown_halted_at_ms":ledger.halt_at,
            "ignored_signals_outside_window":ignored_outside_window,"rejections":rejection_counts});
    let final_account = paper::account_summary(&account, end);
    let decision_semantics = json!({"BUY":"OPEN_LONG","SELL":"OPEN_SHORT",
        "HOLD":"no new order; existing production protection remains active"});
    let risk_policy = json!({"max_active_orders_per_symbol":1,"leverage":1,"daily_timezone":"UTC",
        "default_stop_atr":2,"default_target_atr":5,"default_held_bars":11,
        "candle_interval_ms":interval_ms,"first_entry_delay_bars":1,
        "first_entry_delay_hours":interval_ms as f64/HOUR as f64,
        "pending_ttl_bars":24,"pending_ttl_hours":config.pending_order_ttl_ms() as f64/HOUR as f64,
        "gaps_can_exceed_estimated_risk":true});
    Ok(
        json!({"schema_version":1,"symbol":symbol,"interval":config.candle_interval()?,"start_ms":start,"end_ms":end,
        "start":iso(start),"end":iso(end),"starting_equity":config.starting_equity,
        "config":config,"costs":research::costs(),"scope":"One finite-capital account per symbol; configured candle close mark-to-market; no real exchange execution",
        "decision_semantics":decision_semantics,"risk_policy":risk_policy,"metrics":metrics,
        "final_account":final_account,"signal_log":log,"orders":orders,"equity_curve":curve}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(count: usize) -> Vec<Value> {
        (0..count)
            .map(|i| json!({"openTime":i as i64*HOUR,"open":100.,"high":101.,"low":99.,"close":100.,"volume":1.,"confirmed":true}))
            .collect()
    }

    fn signal(origin: i64, decision: &str) -> ReplaySignal {
        ReplaySignal {
            origin_ms: origin,
            decision: decision.to_owned(),
            probabilities: json!({"BUY":0.8,"SELL":0.1,"HOLD":0.1}),
            metadata: json!({"fold":1}),
            plan: None,
        }
    }

    fn quarter_hour_candles(count: usize) -> Vec<Value> {
        let mut rows = candles(count);
        for (index, row) in rows.iter_mut().enumerate() {
            row["openTime"] = json!(index as i64 * 900_000);
        }
        rows
    }

    #[test]
    fn quarter_hour_replay_preserves_bar_delay_and_absolute_funding_clock() {
        let quarter = 900_000;
        let origin = 96 * quarter;
        let config = ReplayConfig {
            candle_interval_ms: quarter,
            start_ms: origin,
            end_ms: origin + 12 * quarter,
            ..ReplayConfig::default()
        };
        let rows = quarter_hour_candles(144);
        let normalized =
            normalize_signal_with_config("BTCUSDT", &rows[..96], &signal(origin, "BUY"), &config)
                .unwrap();
        assert_eq!(normalized["interval"], "15m");
        assert_eq!(normalized["pendingOrderTtlMs"], 24 * quarter);
        let result = replay("BTCUSDT", &rows, &[signal(origin, "BUY")], &config).unwrap();
        let order = &result["orders"][0];
        assert_eq!(order["interval"], "15m");
        assert_eq!(order["status"], "closed");
        assert_eq!(timestamp(&order["entryAt"]), Some(origin + quarter));
        assert_eq!(timestamp(&order["exitAt"]), Some(origin + 12 * quarter));
        assert_eq!(order["heldBars"], 11);
        let expected_funding =
            number(&order["notional"], 0.) * 0.0003 * 11. * quarter as f64 / (8 * HOUR) as f64;
        assert!((number(&order["funding"], f64::NAN) - expected_funding).abs() < 1e-9);
        let fees = number(&result["metrics"]["fees_usdt"], 0.);
        let slip = number(&result["metrics"]["slippage_usdt"], 0.);
        assert!((number(&order["net"], 0.) + fees + slip + expected_funding).abs() < 1e-9);
        let hourly = normalize_signal("BTCUSDT", &candles(96), &signal(96 * HOUR, "BUY")).unwrap();
        let hourly_cost = number(
            &position_size(&hourly, 1000., &ReplayConfig::default()).unwrap()["cost_fraction"],
            0.,
        );
        let quarter_cost = number(
            &position_size(&normalized, 1000., &config).unwrap()["cost_fraction"],
            0.,
        );
        assert!((hourly_cost - quarter_cost - 0.0003 * 11. * 0.75 / 8.).abs() < 1e-12);
    }

    #[test]
    fn quarter_hour_expiry_and_interval_mismatch_are_not_hourly() {
        let quarter = 900_000;
        let origin = 96 * quarter;
        let config = ReplayConfig {
            candle_interval_ms: quarter,
            start_ms: origin,
            end_ms: origin + 48 * quarter,
            ..ReplayConfig::default()
        };
        let mut rows = quarter_hour_candles(144);
        for row in &mut rows[96..] {
            row["open"] = json!(120.);
            row["high"] = json!(121.);
            row["low"] = json!(119.);
            row["close"] = json!(120.);
        }
        let result = replay("BTCUSDT", &rows, &[signal(origin, "BUY")], &config).unwrap();
        let order = &result["orders"][0];
        assert_eq!(order["status"], "expired");
        assert_eq!(timestamp(&order["expiredAt"]), Some(origin + 24 * quarter));
        assert_eq!(number(&order["entry"], 0.), 0.);
        assert!(replay("BTCUSDT", &candles(144), &[signal(origin, "BUY")], &config).is_err());
        assert!(
            normalize_signal_with_config(
                "BTCUSDT",
                &candles(96),
                &signal(95 * HOUR + quarter, "BUY"),
                &config
            )
            .is_err()
        );
    }

    #[test]
    fn production_delay_and_fee_funding_accounting_are_preserved() {
        let rows = candles(50);
        let origin = 24 * HOUR;
        let result = replay(
            "BTCUSDT",
            &rows,
            &[signal(origin, "BUY")],
            &ReplayConfig {
                start_ms: origin,
                end_ms: origin + 12 * HOUR,
                ..ReplayConfig::default()
            },
        )
        .unwrap();
        let order = &result["orders"][0];
        assert_eq!(order["status"], "closed");
        assert_eq!(timestamp(&order["entryAt"]), Some(origin + HOUR));
        assert_eq!(timestamp(&order["exitAt"]), Some(origin + 12 * HOUR));
        assert_eq!(order["heldBars"], 11);
        let metrics = &result["metrics"];
        let fees = number(&metrics["fees_usdt"], 0.);
        let slip = number(&metrics["slippage_usdt"], 0.);
        let funding = number(&metrics["funding_usdt"], 0.);
        let net = number(&order["net"], 0.);
        assert!((net + fees + slip + funding).abs() < 1e-9);
        assert!((number(&metrics["net_pnl_usdt"], 0.) - net).abs() < 1e-9);
        assert!(number(&metrics["max_drawdown_percent"], 0.) > 0.);
    }

    #[test]
    fn every_signal_is_logged_and_positions_do_not_overlap() {
        let origin = 24 * HOUR;
        let signals = [
            signal(origin, "BUY"),
            signal(origin + HOUR, "SELL"),
            signal(origin + 2 * HOUR, "HOLD"),
            signal(origin + 12 * HOUR, "SELL"),
        ];
        let result = replay("ETHUSDT", &candles(60), &signals, &ReplayConfig::default()).unwrap();
        assert_eq!(result["metrics"]["signals"], 4);
        assert_eq!(result["metrics"]["submitted_orders"], 2);
        assert_eq!(result["signal_log"][1]["outcome"], "active_order");
        assert_eq!(result["signal_log"][2]["outcome"], "hold");
        assert!(
            result["equity_curve"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["open_orders"].as_u64().unwrap() <= 1)
        );
    }

    #[test]
    fn risk_plan_is_prefix_only_and_budget_is_capped() {
        let mut rows = candles(50);
        let origin = 24 * HOUR;
        let first = normalize_signal("BTCUSDT", &rows[..24], &signal(origin, "BUY")).unwrap();
        for row in &mut rows[24..] {
            row["high"] = json!(10_000.);
            row["close"] = json!(9_000.);
        }
        let after = normalize_signal("BTCUSDT", &rows[..24], &signal(origin, "BUY")).unwrap();
        assert_eq!(first, after);
        let size = position_size(&first, 1000., &ReplayConfig::default()).unwrap();
        assert_eq!(ReplayConfig::default().max_notional_usdt, 50.);
        assert!(number(&size["notional_usdt"], 0.) <= 50.);
        assert!(number(&size["estimated_stop_loss_usdt"], 0.) <= 10.);
        assert_eq!(size["leverage"], 1);
        let mut outside_limit = first.clone();
        outside_limit["plan"]["entryStyle"] = json!("limit");
        outside_limit["plan"]["entryLimit"] = json!(200.);
        assert!(position_size(&outside_limit, 1000., &ReplayConfig::default()).is_err());
        assert!(
            position_size(
                &first,
                1000.,
                &ReplayConfig {
                    risk_fraction: 0.1,
                    ..ReplayConfig::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn unresolved_position_uses_mark_to_market_and_is_disclosed() {
        let origin = 24 * HOUR;
        let result = replay(
            "BTCUSDT",
            &candles(50),
            &[signal(origin, "BUY")],
            &ReplayConfig {
                end_ms: origin + 3 * HOUR,
                ..ReplayConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result["metrics"]["unresolved_orders"], 1);
        assert_eq!(result["metrics"]["comparison_complete"], false);
        assert_eq!(result["metrics"]["settled_net_usdt"], 0.);
        assert!(number(&result["metrics"]["net_pnl_usdt"], 0.) < 0.);
        let equity = number(&result["metrics"]["final_equity"], 0.);
        assert!((equity - number(&result["final_account"]["equity"], 0.)).abs() < 1e-9);
        assert!(number(&result["metrics"]["funding_usdt"], 0.) > 0.);
    }

    #[test]
    fn partial_exit_does_not_charge_the_entry_fee_twice() {
        let origin = 24 * HOUR;
        let mut rows = candles(50);
        rows[25]["high"] = json!(105.);
        rows[25]["close"] = json!(103.);
        let mut decision = signal(origin, "BUY");
        decision.plan = Some(json!({"entryStyle":"market","entryMin":99.,"entryMax":101.,
            "stopLoss":96.,"takeProfit":110.,"riskUnit":4.,"maxHoldBars":11,
            "exitRules":{"partialTp":{"enabled":true,"tp1R":1.,"tp2R":2.,
                "tp1ClosePct":0.4,"tp2ClosePct":0.4,"moveStopToBreakEven":false}}}));
        let result = replay(
            "BTCUSDT",
            &rows,
            &[decision],
            &ReplayConfig {
                end_ms: origin + 2 * HOUR,
                ..ReplayConfig::default()
            },
        )
        .unwrap();
        let order = &result["orders"][0];
        assert_eq!(order["status"], "open");
        assert!(number(&order["realizedQty"], 0.) > 0.);
        let gross = number(&order["realizedGross"], 0.)
            + (number(&order["markPrice"], 0.) - number(&order["entry"], 0.))
                * number(&order["quantity"], 0.);
        let expected = 1000. + gross
            - number(&result["metrics"]["fees_usdt"], 0.)
            - number(&result["metrics"]["funding_usdt"], 0.);
        assert!((expected - number(&result["metrics"]["final_equity"], 0.)).abs() < 1e-9);
        assert!(number(&result["metrics"]["slippage_usdt"], 0.) > 0.);
    }

    #[test]
    fn daily_pause_latches_until_utc_rollover_and_drawdown_halt_persists() {
        let config = ReplayConfig::default();
        let mut ledger = RiskLedger::new(1000.);
        ledger.observe(0, 1000., &config);
        ledger.observe(HOUR, 960., &config);
        assert!(ledger.daily_paused);
        ledger.observe(2 * HOUR, 1000., &config);
        assert!(ledger.daily_paused);
        ledger.observe(DAY, 1000., &config);
        assert!(!ledger.daily_paused);
        ledger.observe(DAY + HOUR, 890., &config);
        assert!(ledger.drawdown_halted);
        ledger.observe(2 * DAY, 1100., &config);
        assert!(ledger.drawdown_halted);
        assert_eq!(ledger.halt_at, Some(DAY + HOUR));
    }

    #[test]
    fn daily_loss_guard_blocks_reentry_but_allows_the_next_utc_day() {
        let origin = 24 * HOUR;
        let result = replay(
            "BTCUSDT",
            &candles(72),
            &[
                signal(origin, "BUY"),
                signal(origin + 12 * HOUR, "SELL"),
                signal(origin + DAY, "BUY"),
            ],
            &ReplayConfig {
                daily_loss_fraction: 0.0001,
                ..ReplayConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result["signal_log"][0]["outcome"], "submitted");
        assert_eq!(result["signal_log"][1]["outcome"], "daily_loss_paused");
        assert_eq!(result["signal_log"][2]["outcome"], "submitted");
        assert_eq!(result["metrics"]["submitted_orders"], 2);
    }

    #[test]
    fn direction_permissions_cannot_create_an_order() {
        let origin = 24 * HOUR;
        let result = replay(
            "BTCUSDT",
            &candles(50),
            &[signal(origin, "BUY"), signal(origin + HOUR, "SELL")],
            &ReplayConfig {
                allow_buy: false,
                allow_sell: false,
                ..ReplayConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result["metrics"]["submitted_orders"], 0);
        assert_eq!(result["metrics"]["final_equity"], 1000.);
        assert_eq!(result["signal_log"][0]["outcome"], "direction_disabled");
        assert_eq!(result["signal_log"][1]["outcome"], "direction_disabled");
    }
}
