//! Summaries of the shared replay engine's existing metrics.
//!
//! Each input is one independent finite-capital symbol account. Adding its
//! reported net PnL does not turn these accounts into a shared portfolio; the
//! drawdown below is the worst individual account drawdown, not portfolio DD.
//! No fills, costs, or trading returns are recalculated in this module.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

/// Tolerance in percentage points, used only for a zero baseline drawdown.
const DRAWDOWN_EPSILON: f64 = 1e-9;

#[derive(Default, Serialize, Deserialize, Clone, Debug)]
pub struct Aggregate {
    pub symbols: usize,
    pub net_pnl_usdt: f64,
    pub closed_trades: usize,
    pub wins: usize,
    pub losses: usize,
    pub fees_usdt: f64,
    pub funding_usdt: f64,
    pub slippage_usdt: f64,
    pub max_symbol_drawdown_percent: f64,
    pub unresolved_orders: usize,
    pub profitable_symbols: usize,
    pub losing_symbols: usize,
    pub flat_symbols: usize,
}

fn finite(metrics: &Value, key: &str) -> Result<f64> {
    metrics[key]
        .as_f64()
        .filter(|value| value.is_finite())
        .with_context(|| format!("Replay metrics.{key} must be a finite number"))
}

fn count(metrics: &Value, key: &str) -> Result<usize> {
    let value = metrics[key]
        .as_u64()
        .with_context(|| format!("Replay metrics.{key} must be a nonnegative integer"))?;
    usize::try_from(value).with_context(|| format!("Replay metrics.{key} exceeds usize"))
}

fn add_count(total: usize, value: usize, name: &str) -> Result<usize> {
    total
        .checked_add(value)
        .with_context(|| format!("Aggregate {name} overflow"))
}

fn add_finite(total: f64, value: f64, name: &str) -> Result<f64> {
    let next = total + value;
    ensure!(next.is_finite(), "Aggregate {name} must remain finite");
    Ok(next)
}

impl Aggregate {
    /// Add exactly one symbol's metrics, preserving the engine's reported PnL.
    /// An invalid input or aggregate overflow leaves this value unchanged.
    pub fn add(&mut self, replay: &Value) -> Result<()> {
        let metrics = &replay["metrics"];
        ensure!(metrics.is_object(), "Replay metrics must be an object");
        let net = finite(metrics, "net_pnl_usdt")?;
        let fees = finite(metrics, "fees_usdt")?;
        let funding = finite(metrics, "funding_usdt")?;
        let slippage = finite(metrics, "slippage_usdt")?;
        let drawdown = finite(metrics, "max_drawdown_percent")?;
        ensure!(drawdown >= 0., "Replay drawdown must be nonnegative");
        let closed = count(metrics, "closed_trades")?;
        let wins = count(metrics, "wins")?;
        let losses = count(metrics, "losses")?;
        let unresolved = count(metrics, "unresolved_orders")?;
        ensure!(
            add_count(wins, losses, "trade outcomes")? <= closed,
            "Replay wins plus losses exceed closed trades"
        );
        ensure!(
            self.finite_metrics(),
            "Existing aggregate has invalid metrics"
        );

        let mut next = self.clone();
        next.symbols = add_count(next.symbols, 1, "symbols")?;
        next.net_pnl_usdt = add_finite(next.net_pnl_usdt, net, "net_pnl_usdt")?;
        next.closed_trades = add_count(next.closed_trades, closed, "closed_trades")?;
        next.wins = add_count(next.wins, wins, "wins")?;
        next.losses = add_count(next.losses, losses, "losses")?;
        next.fees_usdt = add_finite(next.fees_usdt, fees, "fees_usdt")?;
        next.funding_usdt = add_finite(next.funding_usdt, funding, "funding_usdt")?;
        next.slippage_usdt = add_finite(next.slippage_usdt, slippage, "slippage_usdt")?;
        next.max_symbol_drawdown_percent = next.max_symbol_drawdown_percent.max(drawdown);
        next.unresolved_orders =
            add_count(next.unresolved_orders, unresolved, "unresolved_orders")?;
        if net > 0. {
            next.profitable_symbols = add_count(next.profitable_symbols, 1, "profitable_symbols")?;
        } else if net < 0. {
            next.losing_symbols = add_count(next.losing_symbols, 1, "losing_symbols")?;
        } else {
            next.flat_symbols = add_count(next.flat_symbols, 1, "flat_symbols")?;
        }
        *self = next;
        Ok(())
    }

    fn finite_metrics(&self) -> bool {
        [
            self.net_pnl_usdt,
            self.fees_usdt,
            self.funding_usdt,
            self.slippage_usdt,
            self.max_symbol_drawdown_percent,
        ]
        .iter()
        .all(|value| value.is_finite())
            && self.max_symbol_drawdown_percent >= 0.
    }

    fn active_symbols(&self) -> Option<usize> {
        self.profitable_symbols.checked_add(self.losing_symbols)
    }

    /// Minimum evidence and completed settlement are required even if a caller
    /// specifies zero minimum trades or symbols. Flat symbol accounts do not
    /// satisfy the active-symbol requirement.
    pub fn eligible(
        &self,
        min_trades: usize,
        min_symbols: usize,
        max_drawdown_percent: f64,
    ) -> bool {
        self.finite_metrics()
            && max_drawdown_percent.is_finite()
            && max_drawdown_percent >= 0.
            && self.unresolved_orders == 0
            && self.closed_trades > 0
            && self.closed_trades >= min_trades
            && self
                .active_symbols()
                .is_some_and(|active| active > 0 && active >= min_symbols && active <= self.symbols)
            && self.max_symbol_drawdown_percent <= max_drawdown_percent
    }

    fn rankable(&self) -> bool {
        self.eligible(1, 1, f64::MAX)
    }
}

/// `Greater` means `a` is preferable. A completed candidate with trades ranks
/// above an empty, unresolved, or invalid candidate. Among valid candidates,
/// prefer greater net PnL, then lower worst-symbol drawdown, then more trades.
/// Callers must additionally filter their chosen minimum-evidence thresholds.
pub fn compare(a: &Aggregate, b: &Aggregate) -> Ordering {
    match (a.rankable(), b.rankable()) {
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => Ordering::Equal,
        (true, true) => a
            .net_pnl_usdt
            .partial_cmp(&b.net_pnl_usdt)
            .unwrap()
            .then_with(|| {
                b.max_symbol_drawdown_percent
                    .partial_cmp(&a.max_symbol_drawdown_percent)
                    .unwrap()
            })
            .then_with(|| a.closed_trades.cmp(&b.closed_trades)),
    }
}

/// A reduction in losses is not a profitable upgrade. Promotion requires
/// positive net PnL, improvement over the baseline, sufficient settled trades
/// and active symbols, and no worse individual-account drawdown.
pub fn profitable_upgrade(
    candidate: &Aggregate,
    baseline: &Aggregate,
    min_trades: usize,
    min_symbols: usize,
) -> bool {
    baseline.finite_metrics()
        && baseline.unresolved_orders == 0
        && candidate.net_pnl_usdt > 0.
        && candidate.net_pnl_usdt > baseline.net_pnl_usdt
        && candidate.eligible(
            min_trades,
            min_symbols,
            baseline.max_symbol_drawdown_percent.max(DRAWDOWN_EPSILON),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn replay(net: f64, trades: usize, drawdown: f64) -> Value {
        json!({"metrics":{
            "net_pnl_usdt":net,"closed_trades":trades,
            "wins":if net>0. {trades} else {0},
            "losses":if net<0. {trades} else {0},
            "fees_usdt":0.6,"funding_usdt":0.1,"slippage_usdt":0.5,
            "max_drawdown_percent":drawdown,"unresolved_orders":0
        }})
    }

    fn aggregate(net: f64, trades: usize, drawdown: f64) -> Aggregate {
        let mut result = Aggregate::default();
        result.add(&replay(net, trades, drawdown)).unwrap();
        result
    }

    #[test]
    fn aggregates_reported_metrics_without_deducting_costs_again() {
        let mut result = aggregate(2., 3, 0.2);
        result.add(&replay(-1., 2, 0.4)).unwrap();
        result.add(&replay(0., 0, 0.)).unwrap();
        assert_eq!(result.symbols, 3);
        assert_eq!(result.net_pnl_usdt, 1.);
        assert_eq!(result.closed_trades, 5);
        assert_eq!(result.wins, 3);
        assert_eq!(result.losses, 2);
        assert!((result.fees_usdt - 1.8).abs() < 1e-12);
        assert!((result.funding_usdt - 0.3).abs() < 1e-12);
        assert_eq!(result.slippage_usdt, 1.5);
        assert_eq!(result.max_symbol_drawdown_percent, 0.4);
        assert_eq!(result.profitable_symbols, 1);
        assert_eq!(result.losing_symbols, 1);
        assert_eq!(result.flat_symbols, 1);
        assert!(result.eligible(5, 2, 0.4));
        assert!(!result.eligible(5, 3, 0.4));
    }

    #[test]
    fn missing_or_nonfinite_fields_are_rejected_atomically() {
        let original = aggregate(1., 2, 0.2);
        for key in [
            "net_pnl_usdt",
            "closed_trades",
            "wins",
            "losses",
            "fees_usdt",
            "funding_usdt",
            "slippage_usdt",
            "max_drawdown_percent",
            "unresolved_orders",
        ] {
            let mut invalid = replay(2., 3, 0.1);
            invalid["metrics"].as_object_mut().unwrap().remove(key);
            let mut result = original.clone();
            assert!(result.add(&invalid).is_err(), "missing {key}");
            assert_eq!(
                serde_json::to_value(&result).unwrap(),
                serde_json::to_value(&original).unwrap()
            );
        }
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            // JSON has no nonfinite numbers; its null representation must be
            // rejected rather than silently read as zero.
            let mut invalid = replay(1., 1, 0.1);
            invalid["metrics"]["net_pnl_usdt"] = json!(value);
            assert!(Aggregate::default().add(&invalid).is_err());
        }
        let mut invalid = original;
        invalid.net_pnl_usdt = f64::NAN;
        assert!(!invalid.eligible(1, 1, 1.));
    }

    #[test]
    fn overflow_is_rejected_without_partial_accumulation() {
        let mut result = aggregate(f64::MAX, 1, 0.1);
        assert!(result.add(&replay(f64::MAX, 1, 0.1)).is_err());
        assert_eq!(result.symbols, 1);
        assert_eq!(result.net_pnl_usdt, f64::MAX);
        result.closed_trades = usize::MAX;
        assert!(result.add(&replay(1., 1, 0.1)).is_err());
        assert_eq!(result.symbols, 1);
    }

    #[test]
    fn empty_or_unsettled_candidates_cannot_win() {
        let empty = aggregate(0., 0, 0.);
        let traded = aggregate(-1., 3, 0.2);
        assert!(!empty.eligible(0, 0, 1.));
        assert_eq!(compare(&empty, &traded), Ordering::Less);
        assert!(!profitable_upgrade(&empty, &traded, 0, 0));
        let mut unresolved = aggregate(10., 5, 0.1);
        unresolved.unresolved_orders = 1;
        assert!(!unresolved.eligible(1, 1, 1.));
        assert_eq!(compare(&unresolved, &traded), Ordering::Less);
        assert!(!profitable_upgrade(&unresolved, &traded, 1, 1));
    }

    #[test]
    fn reducing_a_loss_does_not_qualify_as_a_profitable_upgrade() {
        let baseline = aggregate(-2., 10, 0.3);
        let candidate = aggregate(-1., 10, 0.2);
        assert_eq!(compare(&candidate, &baseline), Ordering::Greater);
        assert!(!profitable_upgrade(&candidate, &baseline, 10, 1));
        assert!(!profitable_upgrade(
            &aggregate(0., 10, 0.2),
            &baseline,
            10,
            1
        ));
    }

    #[test]
    fn promotion_requires_positive_improvement_evidence_and_lower_drawdown() {
        let baseline = aggregate(-2., 10, 0.3);
        let candidate = aggregate(1., 10, 0.2);
        assert!(profitable_upgrade(&candidate, &baseline, 10, 1));
        assert!(!profitable_upgrade(&candidate, &baseline, 11, 1));
        assert!(!profitable_upgrade(&candidate, &baseline, 10, 2));
        assert!(!profitable_upgrade(
            &aggregate(1., 10, 0.31),
            &baseline,
            10,
            1
        ));
        assert!(!profitable_upgrade(
            &candidate,
            &aggregate(2., 10, 0.3),
            10,
            1
        ));
    }

    #[test]
    fn comparison_prefers_profit_then_lower_drawdown_then_more_trades() {
        let baseline = aggregate(1., 10, 0.3);
        assert_eq!(
            compare(&aggregate(2., 5, 0.4), &baseline),
            Ordering::Greater
        );
        assert_eq!(
            compare(&aggregate(1., 5, 0.2), &baseline),
            Ordering::Greater
        );
        assert_eq!(
            compare(&aggregate(1., 11, 0.3), &baseline),
            Ordering::Greater
        );
        assert_eq!(compare(&baseline, &baseline), Ordering::Equal);
    }
}
