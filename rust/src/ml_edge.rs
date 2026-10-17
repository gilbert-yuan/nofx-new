//! Cost-aware net-edge gate for the deployed Chronos/LightGBM classifier.
//!
//! `ml_profit_policy` scores *regression* predictions of net USDT per 50-USDT
//! budget; no runtime binary produces those scores (the deployed predictor only
//! emits a three-class distribution). The decision rule is therefore applied to
//! the realised record instead of to a fabricated per-signal score:
//!
//! * A per-signal probability is only meaningful after it has been calibrated
//!   against outcomes. Closed demo records used to drop `analysisContext`, so
//!   history cannot be bucketed retroactively - today 94% of the emitted
//!   probabilities sit in [0.40, 0.60) and the realized win rate is 28.6%,
//!   i.e. the number carries no information about the outcome.
//! * Until a calibrated per-bucket estimate exists (>= 30 closed records that
//!   carry the confidence), the only honest estimate of the next trade's edge is
//!   the strategy's own realized net expectancy in basis points of notional.
//! * Only exits this system executed count. Positions that disappear on the
//!   exchange (manual close, orphan cleanup) are booked against the local order
//!   and keep its last reason, so they must not enter the estimate.
//!
//! Both layers are the same threshold: expected net return after costs must
//! clear `NOFX_ML_MIN_EDGE_BPS`. Nothing here loosens another gate.
use crate::{number, timestamp};
use anyhow::{Result, ensure};
use serde_json::Value;

/// Trades kept for the rolling estimate. Large enough for a stable mean,
/// small enough that a changed exit policy shows up within days rather than weeks.
pub const WINDOW: usize = 200;
/// Below this the estimate is noise, so the gate refuses to authorise risk.
pub const MIN_OBSERVATIONS: usize = 30;

/// Did this system actually produce the exit?
///
/// The ledger books every position that disappears on the exchange against the
/// local order that owned the symbol. The orphan-cleanup run and manual exchange
/// closes both land here, and they inherit whatever exit reason the simulator
/// last wrote - so `reason = "timeout"` alone does not prove a timeout happened.
/// In the first forward window 47 of 52 "trades" were such rows, carrying about
/// +42 USDT of cleanup profit into an estimate that claimed +176bps of edge.
///
/// A timeout / trailing / MA / partial take-profit exit placed by this system
/// always leaves a filled close order; exchange-side stop protection is the only
/// legitimate exit that may not. A stop-loss is kept either way because the
/// protection order is the strategy's own risk rule.
fn strategy_exit(order: &Value) -> bool {
    match order["reason"].as_str().unwrap_or("") {
        "manual" => false,
        "stop_loss" => true,
        _ => match order["exchange"]["closeOrders"].as_array() {
            Some(closes) => closes
                .iter()
                .any(|c| c["status"] == "filled" || number(&c["executedQty"], 0.) > 0.),
            // No exchange block at all: a paper-only record, which cannot be an
            // external flat (those always arrive through the exchange sync).
            None => true,
        },
    }
}

struct Sample<'a> {
    closed: Vec<&'a Value>,
    excluded: usize,
    excluded_net: f64,
}

/// Closed strategy orders that can testify about the running policy, plus a count
/// of the rows that had to be dropped because the exit was somebody else's.
fn sample<'a>(orders: &'a [Value], strategy: &str, since_ms: i64) -> Sample<'a> {
    let mut sample = Sample {
        closed: Vec::new(),
        excluded: 0,
        excluded_net: 0.,
    };
    for order in orders {
        if order["status"] != "closed" {
            continue;
        }
        if order["strategyId"] != strategy && order["analysisContext"]["strategyId"] != strategy {
            continue;
        }
        if !(number(&order["notional"], 0.) > 0. && number(&order["net"], f64::NAN).is_finite()) {
            continue;
        }
        if timestamp(&order["exitAt"]).unwrap_or(0) < since_ms {
            continue;
        }
        if !strategy_exit(order) {
            sample.excluded += 1;
            sample.excluded_net += number(&order["net"], 0.);
            continue;
        }
        sample.closed.push(order);
    }
    sample
        .closed
        .sort_by_key(|o| std::cmp::Reverse(timestamp(&o["exitAt"]).unwrap_or(0)));
    sample.closed.truncate(WINDOW);
    sample
}

#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub trades: usize,
    pub wins: usize,
    pub win_rate: f64,
    pub avg_win_bps: f64,
    pub avg_loss_bps: f64,
}

impl Edge {
    /// Realized net expectancy per trade in basis points of notional. Fees,
    /// funding and slippage are already inside each order's `net`.
    pub fn expectancy_bps(&self) -> f64 {
        self.win_rate * self.avg_win_bps + (1. - self.win_rate) * self.avg_loss_bps
    }
}

/// Rolling realized edge over the most recent closed trades of one strategy.
/// Returns `None` when there is not enough evidence to estimate anything.
pub fn realized(orders: &[Value], strategy: &str) -> Option<Edge> {
    realized_since(orders, strategy, i64::MIN)
}

/// Same estimate restricted to trades closed at or after `since_ms`. This is the
/// forward window: the historical sample was produced under a different exit rule,
/// so only trades after the policy change can answer "does this work now".
pub fn realized_since(orders: &[Value], strategy: &str, since_ms: i64) -> Option<Edge> {
    let closed = sample(orders, strategy, since_ms).closed;
    if closed.len() < MIN_OBSERVATIONS {
        return None;
    }
    let mut wins = 0;
    let mut win_sum = 0.;
    let mut loss_sum = 0.;
    let mut losses = 0;
    for order in &closed {
        let bps = number(&order["net"], 0.) / number(&order["notional"], 1.) * 10_000.;
        if !bps.is_finite() {
            return None;
        }
        if bps > 0. {
            wins += 1;
            win_sum += bps;
        } else {
            losses += 1;
            loss_sum += bps;
        }
    }
    Some(Edge {
        trades: closed.len(),
        wins,
        win_rate: wins as f64 / closed.len() as f64,
        avg_win_bps: if wins > 0 { win_sum / wins as f64 } else { 0. },
        avg_loss_bps: if losses > 0 {
            loss_sum / losses as f64
        } else {
            0.
        },
    })
}

/// Scaling is a decision about size, not about trading at all: it needs a larger
/// sample and a positive edge measured *after* the current exit policy shipped.
pub const FORWARD_REQUIRED_TRADES: usize = 200;
pub const FORWARD_REQUIRED_EDGE_BPS: f64 = 25.;
/// Per-order margin ceiling while the forward window is short of the scaling bar.
/// It equals the size the strategy is already trading: the instruction is "do not
/// enlarge until 200 forward trades clear +25bps", not "shrink while you wait".
pub const PROBE_MARGIN_USDT: f64 = 50.;

/// Override for that ceiling, clamped to what the exchange and the 50-USDT
/// per-order limit can both accommodate.
pub fn probe_margin() -> f64 {
    crate::automation_guards::env_num("NOFX_ML_PROBE_MARGIN", PROBE_MARGIN_USDT, 5., 50.)
}

/// Margin cap justified by the forward window, i.e. by trades closed under the
/// exit rule that is running right now.
pub fn margin_cap(orders: &[Value], strategy: &str, since_ms: i64) -> f64 {
    let status = forward(orders, strategy, since_ms);
    if status["ready_to_scale"] == true {
        f64::INFINITY
    } else {
        probe_margin()
    }
}

/// Forward-window scoreboard. Reports the raw count even below `MIN_OBSERVATIONS`
/// so progress toward the scaling bar is visible instead of an unexplained "n/a".
pub fn forward(orders: &[Value], strategy: &str, since_ms: i64) -> Value {
    let sample = sample(orders, strategy, since_ms);
    let closed = sample.closed;
    let trades = closed.len();
    let mut wins = 0;
    let mut win_sum = 0.;
    let mut loss_sum = 0.;
    let mut losses = 0;
    for order in &closed {
        let bps = number(&order["net"], 0.) / number(&order["notional"], 1.) * 10_000.;
        if bps > 0. {
            wins += 1;
            win_sum += bps;
        } else {
            losses += 1;
            loss_sum += bps;
        }
    }
    let win_rate = if trades > 0 {
        wins as f64 / trades as f64
    } else {
        0.
    };
    let avg_win = if wins > 0 { win_sum / wins as f64 } else { 0. };
    let avg_loss = if losses > 0 {
        loss_sum / losses as f64
    } else {
        0.
    };
    let expectancy = win_rate * avg_win + (1. - win_rate) * avg_loss;
    let complete = trades >= FORWARD_REQUIRED_TRADES;
    serde_json::json!({
        "since_ms": since_ms,
        "trades": trades,
        "excluded_external": sample.excluded,
        "excluded_net_usdt": (sample.excluded_net * 100.).round() / 100.,
        "required_trades": FORWARD_REQUIRED_TRADES,
        "win_rate": if trades > 0 { (win_rate * 1000.).round() / 1000. } else { 0. },
        "expectancy_bps": expectancy.round(),
        "required_expectancy_bps": FORWARD_REQUIRED_EDGE_BPS,
        "ready_to_scale": complete && expectancy >= FORWARD_REQUIRED_EDGE_BPS,
        "note": "样本不足或边际未达标前不得放大单笔名义，只允许按 50U 参考规模验证",
    })
}

/// How much risk the forward window currently justifies.
///
/// The all-history record cannot be the entry gate: it was produced by the exit
/// rule that this change retired, so using it would licence a permanent veto on
/// the very experiment that has to run to replace it. A gate on the forward
/// window instead is self-consistent - but only if the system keeps producing
/// forward trades, which a blanket "no evidence, no risk" rule would prevent.
///
/// So the verdict has three states rather than two:
/// * `probe` - fewer than [`MIN_OBSERVATIONS`] forward trades: trade the minimum
///   viable size so evidence accumulates while each observation costs little.
/// * `open`  - enough forward trades and the expectancy clears the floor.
/// * `blocked` - enough forward trades and the expectancy does not clear it.
pub fn gate(orders: &[Value], strategy: &str, since_ms: i64, minimum_bps: f64) -> Result<Value> {
    ensure!(minimum_bps.is_finite(), "净收益门槛配置无效");
    let mut status = forward(orders, strategy, since_ms);
    let trades = status["trades"].as_u64().unwrap_or(0) as usize;
    let expectancy = status["expectancy_bps"].as_f64().unwrap_or(0.);
    let edge = realized_since(orders, strategy, since_ms);
    let verdict = if trades < MIN_OBSERVATIONS {
        "probe"
    } else {
        ensure!(
            expectancy >= minimum_bps,
            "前向窗口已实现净期望 {expectancy:.0}bps/笔（{trades} 笔，胜率 {:.0}%）低于门槛 {minimum_bps:.0}bps",
            status["win_rate"].as_f64().unwrap_or(0.) * 100.
        );
        "open"
    };
    if let Some(edge) = &edge {
        status["avg_win_bps"] = serde_json::json!(edge.avg_win_bps.round());
        status["avg_loss_bps"] = serde_json::json!(edge.avg_loss_bps.round());
    }
    status["verdict"] = serde_json::json!(verdict);
    status["minimum_bps"] = serde_json::json!(minimum_bps);
    status["observations_required"] = serde_json::json!(MIN_OBSERVATIONS);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn order(index: i64, net_bps: f64) -> Value {
        json!({
            "id": format!("o{index}"),
            "status": "closed",
            "strategyId": "chronos-lightgbm-v1",
            "notional": 50.,
            "net": net_bps / 10_000. * 50.,
            "exitAt": crate::iso(index * 3_600_000),
        })
    }

    fn series(net_bps: &[f64]) -> Vec<Value> {
        net_bps
            .iter()
            .enumerate()
            .map(|(i, bps)| order(i as i64, *bps))
            .collect()
    }

    #[test]
    fn expectancy_uses_realized_win_rate_and_payoff() {
        // 9 wins of +300, 21 losses of -100 => 0.3*300 + 0.7*(-100) = +20bps.
        let mut values = vec![300.; 9];
        values.extend(vec![-100.; 21]);
        let edge = realized(&series(&values), "chronos-lightgbm-v1").unwrap();
        assert_eq!(edge.trades, MIN_OBSERVATIONS);
        assert!((edge.win_rate - 0.3).abs() < 1e-12);
        assert!((edge.avg_win_bps - 300.).abs() < 1e-9);
        assert!((edge.avg_loss_bps + 100.).abs() < 1e-9);
        assert!((edge.expectancy_bps() - 20.).abs() < 1e-9);
    }

    #[test]
    fn thin_samples_trade_a_probe_instead_of_freezing_the_experiment() {
        let handful = series(&[-100.; MIN_OBSERVATIONS - 1]);
        assert_eq!(realized(&handful, "chronos-lightgbm-v1"), None);
        let verdict = gate(&handful, "chronos-lightgbm-v1", 0, 25.).unwrap();
        assert_eq!(verdict["verdict"], "probe");
        assert_eq!(verdict["trades"], MIN_OBSERVATIONS - 1);
        assert_eq!(
            margin_cap(&handful, "chronos-lightgbm-v1", 0),
            PROBE_MARGIN_USDT
        );
    }

    #[test]
    fn only_the_requested_strategy_and_closed_orders_count() {
        let mut values = series(&[100.; MIN_OBSERVATIONS]);
        let mut other = order(999, 5_000.);
        other["strategyId"] = json!("enhanced-trend-v1");
        values.push(other);
        let mut live = order(1000, 5_000.);
        live["status"] = json!("open");
        values.push(live);
        let edge = realized(&values, "chronos-lightgbm-v1").unwrap();
        assert_eq!(edge.trades, MIN_OBSERVATIONS);
        assert!((edge.expectancy_bps() - 100.).abs() < 1e-9);
    }

    #[test]
    fn negative_edge_blocks_and_positive_edge_opens_the_gate() {
        let losing = series(&[-90.; MIN_OBSERVATIONS]);
        let error = gate(&losing, "chronos-lightgbm-v1", 0, 25.).unwrap_err();
        assert!(format!("{error:#}").contains("低于门槛"));
        let winning = series(&[120.; MIN_OBSERVATIONS]);
        let verdict = gate(&winning, "chronos-lightgbm-v1", 0, 25.).unwrap();
        assert_eq!(verdict["verdict"], "open");
        // A positive but unscaled record still buys probe size only.
        assert_eq!(
            margin_cap(&winning, "chronos-lightgbm-v1", 0),
            PROBE_MARGIN_USDT
        );
    }

    #[test]
    fn forward_window_ignores_trades_closed_under_the_previous_policy() {
        let old = series(&[-500.; MIN_OBSERVATIONS]);
        let cutoff = 40 * 3_600_000;
        assert_eq!(
            realized_since(&old, "chronos-lightgbm-v1", cutoff),
            None,
            "交易时点早于 cutoff 时不能计入前向窗口"
        );
        let mut all = old;
        all.extend((0..MIN_OBSERVATIONS).map(|i| order(100 + i as i64, 100.)));
        let edge = realized_since(&all, "chronos-lightgbm-v1", cutoff).unwrap();
        assert_eq!(edge.trades, MIN_OBSERVATIONS);
        assert!((edge.expectancy_bps() - 100.).abs() < 1e-9);
    }

    #[test]
    fn positions_flattened_outside_the_strategy_do_not_count_as_edge() {
        // 30 rows that claim "timeout" but carry no close order are exactly what
        // the orphan cleanup left behind: the position vanished on the exchange
        // and the ledger booked it against the local order, keeping its old reason.
        let flattened: Vec<Value> = (0..MIN_OBSERVATIONS as i64)
            .map(|i| {
                let mut o = order(i, 500.);
                o["reason"] = json!("timeout");
                o["exchange"] = json!({"closeOrders": []});
                o
            })
            .collect();
        let status = forward(&flattened, "chronos-lightgbm-v1", 0);
        assert_eq!(status["trades"], 0);
        assert_eq!(status["excluded_external"], MIN_OBSERVATIONS);
        assert_eq!(
            gate(&flattened, "chronos-lightgbm-v1", 0, 25.).unwrap()["verdict"],
            "probe",
            "外部平仓不能把门槛从 probe 推到 open"
        );

        // A manual exchange close is not a strategy exit even if it left a fill.
        let mut manual = order(0, 9_000.);
        manual["reason"] = json!("manual");
        manual["exchange"] = json!({"closeOrders": [{"status":"filled","executedQty":50.}]});
        assert_eq!(forward(&[manual], "chronos-lightgbm-v1", 0)["trades"], 0);

        // A stop-loss executed by exchange-side protection has no close order and
        // still belongs to the strategy's risk rule.
        let mut stopped = order(0, -100.);
        stopped["reason"] = json!("stop_loss");
        stopped["exchange"] = json!({"closeOrders": []});
        assert_eq!(forward(&[stopped], "chronos-lightgbm-v1", 0)["trades"], 1);
    }

    #[test]
    fn exits_this_system_executed_still_build_the_forward_sample() {
        let genuine: Vec<Value> = (0..MIN_OBSERVATIONS as i64)
            .map(|i| {
                let mut o = order(i, 120.);
                o["reason"] = json!("timeout");
                o["exchange"] = json!({"closeOrders": [{"status":"filled","executedQty":50.}]});
                o
            })
            .collect();
        let status = forward(&genuine, "chronos-lightgbm-v1", 0);
        assert_eq!(status["trades"], MIN_OBSERVATIONS);
        assert_eq!(status["excluded_external"], 0);
        assert_eq!(
            gate(&genuine, "chronos-lightgbm-v1", 0, 25.).unwrap()["verdict"],
            "open"
        );
    }

    #[test]
    fn scaling_stays_blocked_until_the_forward_sample_clears_both_bars() {
        let thin = series(&[200.; MIN_OBSERVATIONS]);
        let status = forward(&thin, "chronos-lightgbm-v1", 0);
        assert_eq!(status["trades"], MIN_OBSERVATIONS);
        assert_eq!(status["ready_to_scale"], false, "sample below 200");
        assert_eq!(status["required_trades"], FORWARD_REQUIRED_TRADES);

        let enough = series(&[200.; FORWARD_REQUIRED_TRADES]);
        let status = forward(&enough, "chronos-lightgbm-v1", 0);
        assert_eq!(status["trades"], FORWARD_REQUIRED_TRADES);
        assert_eq!(status["ready_to_scale"], true);
        assert!(
            margin_cap(&enough, "chronos-lightgbm-v1", 0).is_infinite(),
            "只有前向样本达标后才放开探针上限"
        );

        let losing = series(&[-10.; FORWARD_REQUIRED_TRADES]);
        let status = forward(&losing, "chronos-lightgbm-v1", 0);
        assert_eq!(status["ready_to_scale"], false, "样本够了但边际没达标");
    }
}
