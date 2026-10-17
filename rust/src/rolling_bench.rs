//! Rolling walk-forward benchmark: model vs. simple trend baseline under one cost model.
//!
//! Guarantees enforced here:
//! * every feature vector is built from a closed price prefix (`base_features`);
//! * a training label must mature inside its own training window (purge);
//! * every simulated bar belongs to the current fold's out-of-sample slice, so
//!   positions never leak PnL from one fold into another;
//! * both strategies are charged the same per-side cost on every unit of
//!   position change, so the comparison is cost-symmetric.
//!
//! This module only accounts for offline research equity. Live order placement
//! stays in the paper/simulator engines.

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ml_features;

pub const HOUR_MS: i64 = 3_600_000;
/// Crypto trades every day; 24 bars a day, 365 days a year.
pub const BARS_PER_YEAR: f64 = 24.0 * 365.0;

/// Per-side cost in basis points. Charged on every unit of position change, so a
/// long-to-short flip costs two round trips' worth of sides.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct CostModel {
    pub fee_bps: f64,
    pub slippage_bps: f64,
}

impl Default for CostModel {
    fn default() -> Self {
        // Binance USD-M taker 0.06% and the project-wide 5 bps slippage assumption.
        Self {
            fee_bps: 6.0,
            slippage_bps: 5.0,
        }
    }
}

impl CostModel {
    pub fn one_way(&self) -> f64 {
        (self.fee_bps + self.slippage_bps) / 10_000.0
    }
    pub fn round_trip(&self) -> f64 {
        2.0 * self.one_way()
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.fee_bps.is_finite()
                && self.slippage_bps.is_finite()
                && (0.0..=500.0).contains(&self.fee_bps)
                && (0.0..=500.0).contains(&self.slippage_bps),
            "Cost bps must be finite and within 0..=500"
        );
        Ok(())
    }
}

/// One out-of-sample slice with the training block that precedes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fold {
    pub index: usize,
    pub train_start_ms: i64,
    pub train_end_ms: i64,
    pub test_start_ms: i64,
    pub test_end_ms: i64,
}

impl Fold {
    /// Purge boundary: only labels maturing at or before this instant may train.
    pub fn train_label_cutoff_ms(&self) -> i64 {
        self.train_end_ms
    }
    pub fn test_bars(&self, horizon_hours: i64) -> i64 {
        (self.test_end_ms - self.test_start_ms) / HOUR_MS / horizon_hours
    }
}

/// Non-overlapping, strictly forward test windows. Train windows slide forward by
/// exactly one test window, so the test slices tile the data after warm-up.
pub fn plan_folds(
    data_start_ms: i64,
    data_end_ms: i64,
    train_hours: i64,
    test_hours: i64,
) -> Result<Vec<Fold>> {
    ensure!(
        train_hours >= 24 && test_hours >= 1,
        "train_hours must be >= 24 and test_hours >= 1"
    );
    let train_span = train_hours * HOUR_MS;
    let test_span = test_hours * HOUR_MS;
    ensure!(
        data_end_ms - data_start_ms >= train_span + test_span,
        "Data span is shorter than one train+test fold"
    );
    let mut folds = Vec::new();
    let mut test_start = data_start_ms + train_span;
    let mut index = 0usize;
    while test_start + test_span <= data_end_ms {
        folds.push(Fold {
            index,
            train_start_ms: test_start - train_span,
            train_end_ms: test_start,
            test_start_ms: test_start,
            test_end_ms: test_start + test_span,
        });
        test_start += test_span;
        index += 1;
    }
    ensure!(!folds.is_empty(), "No complete fold fits in the data span");
    Ok(folds)
}

/// A gap-free hourly close series with causal features precomputed per bar.
#[derive(Clone, Debug)]
pub struct Series {
    pub symbol: String,
    pub open_ms: Vec<i64>,
    pub close: Vec<f64>,
    /// `features[i]` is the closed-prefix vector ending at bar `i`; `None` during
    /// the 256-bar warm-up where the feature window is incomplete.
    pub features: Vec<Option<Vec<f64>>>,
}

impl Series {
    pub fn len(&self) -> usize {
        self.open_ms.len()
    }
    pub fn is_empty(&self) -> bool {
        self.open_ms.is_empty()
    }
    /// Index of the bar opening exactly at `ms`.
    pub fn index_of(&self, ms: i64) -> Option<usize> {
        self.open_ms.binary_search(&ms).ok()
    }
    /// First bar opening at or after `ms` — the start of any time range, whatever
    /// the candle interval is.
    pub fn index_at_or_after(&self, ms: i64) -> Option<usize> {
        let index = self.open_ms.partition_point(|open| *open < ms);
        (index < self.open_ms.len()).then_some(index)
    }
    /// Last bar opening strictly before `ms` — the end of a half-open range.
    pub fn index_before(&self, ms: i64) -> Option<usize> {
        let index = self.open_ms.partition_point(|open| *open < ms);
        index.checked_sub(1)
    }
}

/// Validate the given interval dataset and precompute features. Rows must be
/// contiguous at `interval` cadence; features use the shared bar-based template.
pub fn build_series_interval(symbol: &str, rows: &[Value], interval: &str) -> Result<Series> {
    ensure!(
        rows.len() > ml_features::CONTEXT,
        "{symbol}: need more than {} closed {interval} bars",
        ml_features::CONTEXT
    );
    ml_features::validate_interval(rows, interval)
        .with_context(|| format!("{symbol}: invalid {interval} data"))?;
    let mut open_ms = Vec::with_capacity(rows.len());
    let mut close = Vec::with_capacity(rows.len());
    for row in rows {
        let stamp = crate::timestamp(&row["openTime"]).context("Missing candle openTime")?;
        let price = crate::number(&row["close"], 0.0);
        ensure!(price > 0.0, "{symbol}: non-positive close");
        open_ms.push(stamp);
        close.push(price);
    }
    let mut features = Vec::with_capacity(rows.len());
    features.resize(ml_features::CONTEXT - 1, None);
    for end in ml_features::CONTEXT..=rows.len() {
        let vector = ml_features::base_features_for_interval(rows, end, interval)
            .with_context(|| format!("{symbol}: feature build failed at bar {end}"))?;
        ensure!(
            vector.len() == ml_features::BASE_FEATURE_NAMES.len(),
            "{symbol}: unexpected feature width"
        );
        ensure!(
            vector.iter().all(|value| value.is_finite()),
            "{symbol}: non-finite feature at bar {end}"
        );
        features.push(Some(vector));
    }
    ensure!(
        features.len() == open_ms.len(),
        "{symbol}: feature index misaligned"
    );
    Ok(Series {
        symbol: symbol.to_string(),
        open_ms,
        close,
        features,
    })
}

/// Validate a raw `1h` dataset and precompute features. Rows must be contiguous.
pub fn build_series(symbol: &str, rows: &[Value]) -> Result<Series> {
    build_series_interval(symbol, rows, "1h")
}

/// Target position per bar from `(origin_bar, position)` decisions. A decision at
/// bar `o` is applied to bars `o+1 ..= o+horizon`, so its PnL closes inside the
/// horizon and decisions cannot overlap.
pub fn settle_positions(
    bars: usize,
    decisions: &[(usize, f64)],
    horizon_bars: usize,
) -> Result<Vec<f64>> {
    ensure!(horizon_bars > 0, "horizon_bars must be positive");
    let mut target = vec![0.0; bars];
    let mut previous_end = 0usize;
    for &(origin, position) in decisions {
        ensure!(
            position.is_finite() && position.abs() <= 1.0,
            "Decision position must be finite and within [-1, 1]"
        );
        let start = origin + 1;
        let end = origin + horizon_bars;
        ensure!(end < bars, "Decision horizon exceeds the series");
        ensure!(
            start >= previous_end,
            "Decisions overlap: origin {origin} starts before {previous_end}"
        );
        for slot in &mut target[start..=end] {
            *slot = position;
        }
        previous_end = end + 1;
    }
    Ok(target)
}

/// One strategy's per-bar path for one symbol and one fold.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Simulation {
    pub times_ms: Vec<i64>,
    /// Net of costs, expressed as a fraction of equity per bar.
    pub net: Vec<f64>,
    /// Same position path with costs switched off.
    pub gross: Vec<f64>,
    pub positions: Vec<f64>,
    pub turnover: f64,
    pub position_changes: usize,
}

/// Walk the fold bar by bar. `target[t]` is the position held over `(t-1, t]`.
pub fn simulate_positions(
    series: &Series,
    fold: &Fold,
    target: &[f64],
    cost: CostModel,
) -> Result<Simulation> {
    cost.validate()?;
    ensure!(
        target.len() == series.len(),
        "{}: target length mismatch",
        series.symbol
    );
    let start = series
        .index_at_or_after(fold.test_start_ms)
        .with_context(|| format!("{}: fold start after the data", series.symbol))?;
    let last = series
        .index_before(fold.test_end_ms)
        .with_context(|| format!("{}: fold end before the data", series.symbol))?;
    ensure!(last > start, "Fold window holds no tradable bars");

    let one_way = cost.one_way();
    let capacity = last - start;
    let mut times_ms = Vec::with_capacity(capacity);
    let mut net = Vec::with_capacity(capacity);
    let mut gross = Vec::with_capacity(capacity);
    let mut positions = Vec::with_capacity(capacity);
    let mut turnover = 0.0;
    let mut position_changes = 0usize;
    let mut held = 0.0;
    for bar in (start + 1)..=last {
        let position = target[bar];
        ensure!(
            position.is_finite() && position.abs() <= 1.0,
            "{}: position out of range",
            series.symbol
        );
        let previous_close = series.close[bar - 1];
        let bar_return = series.close[bar] / previous_close - 1.0;
        ensure!(bar_return.is_finite(), "Non-finite bar return");
        let change = (position - held).abs();
        turnover += change;
        if change > 0.0 {
            position_changes += 1;
        }
        let bar_gross = position * bar_return;
        times_ms.push(series.open_ms[bar]);
        net.push(bar_gross - change * one_way);
        gross.push(bar_gross);
        positions.push(position);
        held = position;
    }
    Ok(Simulation {
        times_ms,
        net,
        gross,
        positions,
        turnover,
        position_changes,
    })
}

/// Equal-weight portfolio of aligned symbol simulations. Rebalancing back to
/// equal weight is free here, which slightly favours neither strategy because
/// both are aggregated identically.
pub fn aggregate(simulations: &[Simulation]) -> Result<Simulation> {
    ensure!(!simulations.is_empty(), "No simulations to aggregate");
    let length = simulations[0].net.len();
    ensure!(length > 0, "Empty simulation");
    for simulation in simulations {
        ensure!(
            simulation.net.len() == length && simulation.times_ms == simulations[0].times_ms,
            "Portfolio members are not time aligned"
        );
    }
    let scale = 1.0 / simulations.len() as f64;
    let mut times_ms = simulations[0].times_ms.clone();
    times_ms.shrink_to_fit();
    let mut net = vec![0.0; length];
    let mut gross = vec![0.0; length];
    let mut positions = vec![0.0; length];
    let mut turnover = 0.0;
    let mut position_changes = 0usize;
    for simulation in simulations {
        for bar in 0..length {
            net[bar] += simulation.net[bar] * scale;
            gross[bar] += simulation.gross[bar] * scale;
            positions[bar] += simulation.positions[bar] * scale;
        }
        turnover += simulation.turnover * scale;
        position_changes += simulation.position_changes;
    }
    Ok(Simulation {
        times_ms,
        net,
        gross,
        positions,
        turnover,
        position_changes,
    })
}

/// Chain several fold simulations (already chronological) into one OOS path.
pub fn concatenate(simulations: &[Simulation]) -> Result<Simulation> {
    ensure!(!simulations.is_empty(), "No folds to concatenate");
    let mut result = Simulation {
        times_ms: Vec::new(),
        net: Vec::new(),
        gross: Vec::new(),
        positions: Vec::new(),
        turnover: 0.0,
        position_changes: 0,
    };
    for simulation in simulations {
        result.times_ms.extend_from_slice(&simulation.times_ms);
        result.net.extend_from_slice(&simulation.net);
        result.gross.extend_from_slice(&simulation.gross);
        result.positions.extend_from_slice(&simulation.positions);
        result.turnover += simulation.turnover;
        result.position_changes += simulation.position_changes;
    }
    Ok(result)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Performance {
    pub bars: usize,
    pub net_return: f64,
    pub gross_return: f64,
    /// Gross minus net, in return points: the drag paid to fees and slippage.
    pub cost_drag: f64,
    pub annualized_return: f64,
    pub annualized_volatility: f64,
    pub sharpe: f64,
    pub max_drawdown: f64,
    pub exposure: f64,
    pub turnover: f64,
    pub position_changes: usize,
    pub positive_bar_rate: f64,
    pub best_bar: f64,
    pub worst_bar: f64,
}

fn compounded(values: &[f64]) -> f64 {
    values
        .iter()
        .fold(1.0, |equity, value| equity * (1.0 + value))
        - 1.0
}

fn max_drawdown(values: &[f64]) -> f64 {
    let mut equity: f64 = 1.0;
    let mut peak: f64 = 1.0;
    let mut worst: f64 = 0.0;
    for value in values {
        equity *= 1.0 + value;
        peak = peak.max(equity);
        if peak > 0.0 {
            worst = worst.max(1.0 - equity / peak);
        }
    }
    worst
}

fn mean_and_std(values: &[f64]) -> (f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0);
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance = if values.len() > 1 {
        values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / (values.len() - 1) as f64
    } else {
        0.0
    };
    (mean, variance.sqrt())
}

impl Simulation {
    pub fn performance(&self) -> Performance {
        let bars = self.net.len();
        let net_return = compounded(&self.net);
        let gross_return = compounded(&self.gross);
        let (mean, std) = mean_and_std(&self.net);
        let exposure = if bars == 0 {
            0.0
        } else {
            self.positions.iter().filter(|p| p.abs() > 0.0).count() as f64 / bars as f64
        };
        let positive_bar_rate = if bars == 0 {
            0.0
        } else {
            self.net.iter().filter(|value| **value > 0.0).count() as f64 / bars as f64
        };
        let annualized_return = if net_return <= -1.0 || bars == 0 {
            -1.0
        } else {
            (1.0 + net_return).powf(BARS_PER_YEAR / bars as f64) - 1.0
        };
        Performance {
            bars,
            net_return,
            gross_return,
            cost_drag: gross_return - net_return,
            annualized_return,
            annualized_volatility: std * BARS_PER_YEAR.sqrt(),
            sharpe: if std > 0.0 {
                mean / std * BARS_PER_YEAR.sqrt()
            } else {
                0.0
            },
            max_drawdown: max_drawdown(&self.net),
            exposure,
            turnover: self.turnover,
            position_changes: self.position_changes,
            positive_bar_rate,
            best_bar: self.net.iter().copied().fold(0.0, f64::max),
            worst_bar: self.net.iter().copied().fold(0.0, f64::min),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_series(closes: &[f64]) -> Series {
        let open_ms = (0..closes.len())
            .map(|i| 1_700_000_000_000 + i as i64 * HOUR_MS)
            .collect::<Vec<_>>();
        Series {
            symbol: "TESTUSDT".to_string(),
            open_ms,
            close: closes.to_vec(),
            features: vec![None; closes.len()],
        }
    }

    fn fold(index: usize, test_start_idx: i64, test_bars: i64) -> Fold {
        let start = 1_700_000_000_000;
        Fold {
            index,
            train_start_ms: start + (test_start_idx - 100) * HOUR_MS,
            train_end_ms: start + test_start_idx * HOUR_MS,
            test_start_ms: start + test_start_idx * HOUR_MS,
            test_end_ms: start + (test_start_idx + test_bars) * HOUR_MS,
        }
    }

    #[test]
    fn folds_tile_the_data_without_overlap() {
        let start = 1_700_000_000_000;
        let folds = plan_folds(start, start + 1000 * HOUR_MS, 200, 100).unwrap();
        assert_eq!(folds.len(), 8);
        for (index, current) in folds.iter().enumerate() {
            assert_eq!(current.index, index);
            assert_eq!(current.train_end_ms, current.test_start_ms);
            assert_eq!(current.train_end_ms - current.train_start_ms, 200 * HOUR_MS);
            assert_eq!(current.test_end_ms - current.test_start_ms, 100 * HOUR_MS);
            if index > 0 {
                assert_eq!(folds[index - 1].test_end_ms, current.test_start_ms);
            }
        }
        assert_eq!(folds[0].test_start_ms, start + 200 * HOUR_MS);
        assert_eq!(folds[7].test_end_ms, start + 1000 * HOUR_MS);
    }

    #[test]
    fn short_span_is_rejected() {
        let start = 1_700_000_000_000;
        assert!(plan_folds(start, start + 100 * HOUR_MS, 200, 100).is_err());
    }

    #[test]
    fn entering_and_exiting_a_flat_market_costs_two_sides() {
        let series = flat_series(&[100.0, 100.0, 100.0, 100.0, 100.0, 100.0]);
        let cost = CostModel {
            fee_bps: 6.0,
            slippage_bps: 5.0,
        };
        let target = settle_positions(6, &[(1, 1.0)], 2).unwrap();
        let simulation = simulate_positions(&series, &fold(0, 1, 4), &target, cost).unwrap();
        assert_eq!(simulation.net.len(), 3);
        assert!((simulation.net[0] + cost.one_way()).abs() < 1e-12);
        assert!(simulation.net[1].abs() < 1e-12);
        assert!((simulation.net[2] + cost.one_way()).abs() < 1e-12);
        assert!((simulation.turnover - 2.0).abs() < 1e-12);
        assert!(
            (compounded(&simulation.net) - ((1.0 - cost.one_way()).powi(2) - 1.0)).abs() < 1e-12
        );
    }

    #[test]
    fn flipping_pays_both_sides() {
        let series = flat_series(&[100.0, 100.0, 100.0, 100.0, 100.0, 100.0]);
        let cost = CostModel {
            fee_bps: 6.0,
            slippage_bps: 5.0,
        };
        let target = settle_positions(6, &[(1, 1.0), (3, -1.0)], 2).unwrap();
        let simulation = simulate_positions(&series, &fold(0, 1, 4), &target, cost).unwrap();
        assert!((simulation.turnover - 3.0).abs() < 1e-12);
        assert!((simulation.net[2] + cost.round_trip()).abs() < 1e-12);
    }

    #[test]
    fn overlapping_decisions_are_rejected() {
        assert!(settle_positions(20, &[(0, 1.0), (3, 1.0)], 4).is_err());
    }

    #[test]
    fn performance_tracks_cost_drag_and_drawdown() {
        let simulation = Simulation {
            times_ms: vec![0, 1, 2, 3],
            net: vec![0.10, -0.20, 0.05, 0.02],
            gross: vec![0.101, -0.199, 0.051, 0.021],
            positions: vec![1.0, 1.0, 0.0, 0.0],
            turnover: 3.0,
            position_changes: 2,
        };
        let performance = simulation.performance();
        assert!((performance.net_return - (1.10 * 0.80 * 1.05 * 1.02 - 1.0)).abs() < 1e-12);
        assert!(performance.cost_drag > 0.0);
        assert!((performance.exposure - 0.5).abs() < 1e-12);
        assert!((performance.max_drawdown - 0.20).abs() < 1e-12);
        assert!(performance.sharpe.is_finite());
    }

    #[test]
    fn aggregation_is_equal_weighted() {
        let left = Simulation {
            times_ms: vec![1, 2],
            net: vec![0.02, 0.02],
            gross: vec![0.02, 0.02],
            positions: vec![1.0, 1.0],
            turnover: 1.0,
            position_changes: 1,
        };
        let right = Simulation {
            times_ms: vec![1, 2],
            net: vec![-0.02, 0.0],
            gross: vec![-0.02, 0.0],
            positions: vec![-1.0, -1.0],
            turnover: 1.0,
            position_changes: 1,
        };
        let portfolio = aggregate(&[left, right]).unwrap();
        assert!((portfolio.net[0]).abs() < 1e-12);
        assert!((portfolio.positions[0]).abs() < 1e-12);
        assert_eq!(portfolio.position_changes, 2);
    }
}
