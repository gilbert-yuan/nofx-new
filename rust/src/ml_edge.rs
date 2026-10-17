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
    let mut closed: Vec<&Value> = orders
        .iter()
        .filter(|o| o["status"] == "closed")
        .filter(|o| o["strategyId"] == strategy || o["analysisContext"]["strategyId"] == strategy)
        .filter(|o| number(&o["notional"], 0.) > 0. && number(&o["net"], f64::NAN).is_finite())
        .filter(|o| timestamp(&o["exitAt"]).unwrap_or(0) >= since_ms)
        .collect();
    closed.sort_by_key(|o| std::cmp::Reverse(timestamp(&o["exitAt"]).unwrap_or(0)));
    closed.truncate(WINDOW);
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

/// Forward-window scoreboard. Reports the raw count even below `MIN_OBSERVATIONS`
/// so progress toward the scaling bar is visible instead of an unexplained "n/a".
pub fn forward(orders: &[Value], strategy: &str, since_ms: i64) -> Value {
    let mut closed: Vec<&Value> = orders
        .iter()
        .filter(|o| o["status"] == "closed")
        .filter(|o| o["strategyId"] == strategy || o["analysisContext"]["strategyId"] == strategy)
        .filter(|o| number(&o["notional"], 0.) > 0. && number(&o["net"], f64::NAN).is_finite())
        .filter(|o| timestamp(&o["exitAt"]).unwrap_or(0) >= since_ms)
        .collect();
    closed.sort_by_key(|o| std::cmp::Reverse(timestamp(&o["exitAt"]).unwrap_or(0)));
    closed.truncate(WINDOW);
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
        "required_trades": FORWARD_REQUIRED_TRADES,
        "win_rate": if trades > 0 { (win_rate * 1000.).round() / 1000. } else { 0. },
        "expectancy_bps": expectancy.round(),
        "required_expectancy_bps": FORWARD_REQUIRED_EDGE_BPS,
        "ready_to_scale": complete && expectancy >= FORWARD_REQUIRED_EDGE_BPS,
        "note": "样本不足或边际未达标前不得放大单笔名义，只允许按 50U 参考规模验证",
    })
}

/// Refuses to authorise a new position unless the strategy's realised net
/// expectancy clears `minimum_bps`. Fails closed when the sample is too small:
/// "no evidence" is not the same as "no problem".
pub fn require(orders: &[Value], strategy: &str, minimum_bps: f64) -> Result<Edge> {
    ensure!(minimum_bps.is_finite(), "净收益门槛配置无效");
    let edge = realized(orders, strategy).ok_or_else(|| {
        anyhow::anyhow!("模型净收益样本不足（需要 {MIN_OBSERVATIONS} 笔已平仓记录）")
    })?;
    let expectancy = edge.expectancy_bps();
    ensure!(
        expectancy >= minimum_bps,
        "模型已实现净期望 {expectancy:.0}bps/笔（{} 笔，胜率 {:.0}%，均盈 {:.0}bps，均亏 {:.0}bps）低于门槛 {minimum_bps:.0}bps",
        edge.trades,
        edge.win_rate * 100.,
        edge.avg_win_bps,
        edge.avg_loss_bps
    );
    Ok(edge)
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
    fn thin_samples_never_authorize_a_position() {
        let handful = series(&[-100.; MIN_OBSERVATIONS - 1]);
        assert_eq!(realized(&handful, "chronos-lightgbm-v1"), None);
        assert!(require(&handful, "chronos-lightgbm-v1", 0.).is_err());
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
        let error = require(&losing, "chronos-lightgbm-v1", 25.).unwrap_err();
        assert!(format!("{error:#}").contains("低于门槛"));
        let winning = series(&[120.; MIN_OBSERVATIONS]);
        assert!(require(&winning, "chronos-lightgbm-v1", 25.).is_ok());
    }
}
