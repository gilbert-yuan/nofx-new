//! Causal helpers for independently calibrated long/short net-return policies.
//!
//! Scores are net USDT divided by the fixed 50-USDT label budget, not class
//! probabilities. Daily grouping reduces pseudo-replication; it does not remove
//! temporal dependence or provide a per-trade confidence bound or 95% guarantee.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const HOUR: i64 = 3_600_000;
pub const DAY: i64 = 24 * HOUR;
const DIRECTION_MARGIN: f64 = 0.0005;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ResidualObservation {
    pub origin_ms: i64,
    pub mature_by_ms: i64,
    pub prediction: f64,
    pub target: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DirectionCalibration {
    /// Global observation-weighted mean of target minus prediction.
    pub bias: f64,
    /// Twice the sample standard deviation of daily mean residuals divided by
    /// sqrt(days). This is a conservative heuristic for mean uncertainty only.
    pub uncertainty_allowance: f64,
    pub observations: usize,
    pub days: usize,
    pub usable: bool,
}

impl DirectionCalibration {
    pub fn score(&self, prediction: f64) -> Option<f64> {
        if !self.usable
            || !prediction.is_finite()
            || !self.bias.is_finite()
            || !self.uncertainty_allowance.is_finite()
            || self.uncertainty_allowance < 0.
        {
            return None;
        }
        let score = prediction + self.bias - self.uncertainty_allowance;
        score.is_finite().then_some(score)
    }
}

/// Fit using only mature observations whose origins fall in [start_ms,end_ms).
/// Non-finite selected values fail explicitly rather than conceal model errors.
pub fn calibrate_side(
    observations: &[ResidualObservation],
    start_ms: i64,
    end_ms: i64,
) -> Result<DirectionCalibration> {
    ensure!(start_ms < end_ms, "Calibration interval must be nonempty");
    let mut count = 0_usize;
    let mut mean = 0.;
    let mut daily: BTreeMap<i64, (usize, f64)> = BTreeMap::new();
    for observation in observations {
        if observation.origin_ms < start_ms
            || observation.origin_ms >= end_ms
            || observation.mature_by_ms > end_ms
        {
            continue;
        }
        ensure!(
            observation.prediction.is_finite() && observation.target.is_finite(),
            "Non-finite mature calibration prediction or target at {}",
            observation.origin_ms
        );
        let residual = observation.target - observation.prediction;
        ensure!(residual.is_finite(), "Calibration residual overflow");
        count += 1;
        mean += (residual - mean) / count as f64;
        let (day_count, day_mean) = daily
            .entry(observation.origin_ms.div_euclid(DAY))
            .or_insert((0, 0.));
        *day_count += 1;
        *day_mean += (residual - *day_mean) / *day_count as f64;
        ensure!(
            mean.is_finite() && day_mean.is_finite(),
            "Calibration mean overflow"
        );
    }
    let days = daily.len();
    if count < 30 || days < 3 {
        return Ok(DirectionCalibration {
            bias: 0.,
            uncertainty_allowance: 0.,
            observations: count,
            days,
            usable: false,
        });
    }
    let mut daily_mean = 0.;
    let mut sum_squares = 0.;
    for (index, (_, value)) in daily.values().enumerate() {
        let delta = value - daily_mean;
        daily_mean += delta / (index + 1) as f64;
        sum_squares += delta * (value - daily_mean);
    }
    let sample_variance = (sum_squares / (days - 1) as f64).max(0.);
    let allowance = 2. * sample_variance.sqrt() / (days as f64).sqrt();
    ensure!(
        daily_mean.is_finite() && sum_squares.is_finite() && allowance.is_finite(),
        "Calibration daily variance overflow"
    );
    Ok(DirectionCalibration {
        bias: mean,
        uncertainty_allowance: allowance,
        observations: count,
        days,
        usable: true,
    })
}

/// Unusable sides remain unknown, never an invented zero score. When both sides
/// are available the larger must also clear the fixed separation margin.
pub fn decide(
    long_prediction: f64,
    short_prediction: f64,
    long_calibration: &DirectionCalibration,
    short_calibration: &DirectionCalibration,
    min_edge: Option<f64>,
) -> Result<String> {
    let Some(edge) = min_edge else {
        return Ok("HOLD".into());
    };
    ensure!(
        edge.is_finite() && edge >= 0.,
        "Invalid minimum net-return edge"
    );
    let long = long_calibration.score(long_prediction);
    let short = short_calibration.score(short_prediction);
    let action = match (long, short) {
        (Some(long), Some(short)) if long > edge && long - short >= DIRECTION_MARGIN => "BUY",
        (Some(long), Some(short)) if short > edge && short - long >= DIRECTION_MARGIN => "SELL",
        (Some(long), None) if long > edge => "BUY",
        (None, Some(short)) if short > edge => "SELL",
        _ => "HOLD",
    };
    Ok(action.into())
}

/// Three pre-evaluation weeks plus 1..=4 evaluation weeks, ending at end_ms.
/// The final boundary is included for the separately declared final refit.
pub fn weekly_boundaries(end_ms: i64, evaluation_weeks: usize) -> Result<Vec<i64>> {
    ensure!(
        (1..=4).contains(&evaluation_weeks),
        "evaluation_weeks must be 1..=4"
    );
    ensure!(
        end_ms > 0 && end_ms.rem_euclid(DAY) == 0,
        "Weekly end must be a positive UTC day boundary"
    );
    let total_weeks = evaluation_weeks
        .checked_add(3)
        .context("Week count overflow")?;
    let week = DAY.checked_mul(7).context("Week duration overflow")?;
    let duration = week
        .checked_mul(total_weeks as i64)
        .context("Week duration overflow")?;
    let start = end_ms
        .checked_sub(duration)
        .context("Weekly start overflow")?;
    ensure!(start > 0, "Weekly history must start after the Unix epoch");
    (0..=total_weeks)
        .map(|index| {
            let offset = week
                .checked_mul(index as i64)
                .context("Weekly offset overflow")?;
            start
                .checked_add(offset)
                .context("Weekly boundary overflow")
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(day: i64, residual: f64) -> ResidualObservation {
        ResidualObservation {
            origin_ms: day * DAY,
            mature_by_ms: (day + 1) * DAY,
            prediction: 0.01,
            target: 0.01 + residual,
        }
    }

    fn usable(bias: f64, allowance: f64) -> DirectionCalibration {
        DirectionCalibration {
            bias,
            uncertainty_allowance: allowance,
            observations: 30,
            days: 3,
            usable: true,
        }
    }

    #[test]
    fn residual_bias_uses_all_observations_and_uncertainty_uses_daily_means() {
        let mut values = vec![observation(1, 0.); 20];
        values.extend(vec![observation(2, 1.); 5]);
        values.extend(vec![observation(3, -1.); 5]);
        let fitted = calibrate_side(&values, DAY, 4 * DAY).unwrap();
        assert!(fitted.usable);
        assert_eq!(fitted.observations, 30);
        assert_eq!(fitted.days, 3);
        assert!(fitted.bias.abs() < 1e-12);
        assert!((fitted.uncertainty_allowance - 2. / 3_f64.sqrt()).abs() < 1e-12);
        assert!((fitted.score(2.).unwrap() - (2. - 2. / 3_f64.sqrt())).abs() < 1e-12);
    }

    #[test]
    fn future_and_unmatured_observations_do_not_change_calibration() {
        let mut values: Vec<_> = (1..=3)
            .flat_map(|day| vec![observation(day, -0.002); 10])
            .collect();
        let before = calibrate_side(&values, DAY, 4 * DAY).unwrap();
        values.push(observation(0, f64::NAN));
        values.push(observation(4, f64::INFINITY));
        values.push(ResidualObservation {
            origin_ms: 2 * DAY,
            mature_by_ms: 5 * DAY,
            prediction: f64::NAN,
            target: f64::INFINITY,
        });
        let after = calibrate_side(&values, DAY, 4 * DAY).unwrap();
        assert_eq!(before, after);
        assert!((after.bias + 0.002).abs() < 1e-12);
        assert_eq!(after.uncertainty_allowance, 0.);
    }

    #[test]
    fn low_observation_or_day_counts_hold_without_fabricated_scores() {
        let values: Vec<_> = (1..=3)
            .flat_map(|day| vec![observation(day, 0.01); 9])
            .collect();
        let fitted = calibrate_side(&values, DAY, 4 * DAY).unwrap();
        assert!(!fitted.usable);
        assert_eq!(fitted.bias, 0.);
        assert_eq!(fitted.uncertainty_allowance, 0.);
        assert_eq!(fitted.score(100.), None);
        assert_eq!(
            decide(100., 100., &fitted, &fitted, Some(0.)).unwrap(),
            "HOLD"
        );
        let one_day = calibrate_side(&vec![observation(1, 0.01); 100], DAY, 4 * DAY).unwrap();
        assert!(!one_day.usable);
        assert_eq!(one_day.days, 1);
    }

    #[test]
    fn directions_are_independent_and_valid_sides_require_positive_net_edge() {
        let long = usable(-0.001, 0.0005);
        let short = DirectionCalibration {
            usable: false,
            ..usable(0., 0.)
        };
        assert_eq!(
            decide(0.004, f64::NAN, &long, &short, Some(0.001)).unwrap(),
            "BUY"
        );
        assert_eq!(
            decide(f64::NAN, 0.004, &short, &long, Some(0.001)).unwrap(),
            "SELL"
        );
        assert_eq!(
            decide(0.0015, f64::NAN, &long, &short, Some(0.)).unwrap(),
            "HOLD"
        );
        let both = usable(0., 0.);
        assert_eq!(
            decide(0.002, 0.0018, &both, &both, Some(0.)).unwrap(),
            "HOLD"
        );
        assert_eq!(decide(0.003, 0.001, &both, &both, Some(0.)).unwrap(), "BUY");
        assert_eq!(
            decide(0.001, 0.003, &both, &both, Some(0.)).unwrap(),
            "SELL"
        );
        assert_eq!(
            decide(0.003, 0.001, &both, &both, Some(0.003)).unwrap(),
            "HOLD"
        );
        assert_eq!(decide(100., 100., &both, &both, None).unwrap(), "HOLD");
    }

    #[test]
    fn selected_invalid_values_fail_while_unknown_scores_stay_unknown() {
        let mut value = observation(1, 0.);
        value.target = f64::NAN;
        assert!(calibrate_side(&[value], DAY, 4 * DAY).is_err());
        assert!(calibrate_side(&[], DAY, DAY).is_err());
        let cal = usable(0., 0.);
        assert_eq!(cal.score(f64::INFINITY), None);
        assert!(decide(0., 0., &cal, &cal, Some(-0.1)).is_err());
        assert!(decide(0., 0., &cal, &cal, Some(f64::NAN)).is_err());
    }

    #[test]
    fn weekly_boundaries_are_aligned_ordered_and_include_final_refit() {
        let boundaries = weekly_boundaries(100 * DAY, 4).unwrap();
        assert_eq!(boundaries.len(), 8);
        assert_eq!(boundaries[0], 51 * DAY);
        assert_eq!(*boundaries.last().unwrap(), 100 * DAY);
        assert!(boundaries.windows(2).all(|w| w[1] - w[0] == 7 * DAY));
        assert!(weekly_boundaries(100 * DAY, 0).is_err());
        assert!(weekly_boundaries(100 * DAY, 5).is_err());
        assert!(weekly_boundaries(100 * DAY + HOUR, 1).is_err());
        assert!(weekly_boundaries(10 * DAY, 1).is_err());
        assert!(weekly_boundaries(i64::MIN, 1).is_err());
    }
}
