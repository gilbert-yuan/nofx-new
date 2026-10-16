//! Causal rolling research helpers. Trading evaluation stays in the shared engine.
use crate::{chronos::ForecastRecord, ml_features};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CLASS_ORDER: [&str; 3] = ["SELL", "HOLD", "BUY"];
pub const LABEL_MATURITY_HOURS: i64 = 48;
pub const TEMPERATURE_CANDIDATES: [f64; 5] = [0.75, 1., 1.25, 1.5, 2.];
const DAY: i64 = 24 * ml_features::HOUR;
const LOSS_FLOOR: f64 = 1e-15;
const PRICE_FLOOR_FRACTION: f64 = 1e-9;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub start_ms: i64,
    pub end_ms: i64,
}
impl TimeRange {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.start_ms < self.end_ms
                && self.start_ms % ml_features::HOUR == 0
                && self.end_ms % ml_features::HOUR == 0,
            "Invalid hourly half-open time range"
        );
        Ok(())
    }
    /// The entire 48-hour label observation must mature inside this partition.
    pub fn contains_mature_origin(&self, origin_ms: i64) -> bool {
        origin_ms >= self.start_ms
            && origin_ms < self.end_ms
            && origin_ms
                .checked_add(LABEL_MATURITY_HOURS * ml_features::HOUR)
                .is_some_and(|matured| matured <= self.end_ms)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Partition {
    Train,
    Validation,
    Calibration,
    Confirmation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Fold {
    pub index: usize,
    pub train: TimeRange,
    pub validation: TimeRange,
    pub calibration: TimeRange,
    pub confirmation: TimeRange,
}
impl Fold {
    pub fn validate(&self) -> Result<()> {
        let ranges = [
            self.train,
            self.validation,
            self.calibration,
            self.confirmation,
        ];
        for range in ranges {
            range.validate()?;
        }
        ensure!(
            ranges
                .windows(2)
                .all(|pair| pair[0].end_ms <= pair[1].start_ms),
            "Fold partitions overlap or are out of order"
        );
        Ok(())
    }
    pub fn partition(&self, origin_ms: i64) -> Option<Partition> {
        self.validate().ok()?;
        [
            (self.train, Partition::Train),
            (self.validation, Partition::Validation),
            (self.calibration, Partition::Calibration),
            (self.confirmation, Partition::Confirmation),
        ]
        .into_iter()
        .find_map(|(range, part)| range.contains_mature_origin(origin_ms).then_some(part))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RollingPlan {
    pub data: TimeRange,
    pub folds: Vec<Fold>,
    /// Historical holdout is separate from confirmation and is not called blind.
    pub historical_holdout: TimeRange,
    pub unused_pre_holdout_gap: Option<TimeRange>,
    /// Data at or after this instant was not present in this frozen archive.
    pub future_unseen_start_ms: i64,
    pub label_maturity_hours: i64,
}
impl RollingPlan {
    /// Expanding 60d train, 14d validation/calibration/confirmation, 28d step.
    /// Day 160..180 is held out; day 158..160 is deliberately unused.
    /// Folds may reuse earlier historical partitions as later training data;
    /// confirmation ranges themselves never overlap.
    pub fn expanding_180d(start_ms: i64, end_ms: i64) -> Result<Self> {
        let data = TimeRange { start_ms, end_ms };
        data.validate()?;
        ensure!(
            start_ms % DAY == 0
                && end_ms % DAY == 0
                && end_ms.checked_sub(start_ms) == Some(180 * DAY),
            "Rolling plan requires exactly 180 complete UTC days"
        );
        let at_day = |day: i64| -> Result<i64> {
            start_ms
                .checked_add(day * DAY)
                .ok_or_else(|| anyhow::anyhow!("Time overflow"))
        };
        let mut folds = Vec::new();
        for index in 0..3 {
            let train_days = 60 + index as i64 * 28;
            let fold = Fold {
                index,
                train: TimeRange {
                    start_ms,
                    end_ms: at_day(train_days)?,
                },
                validation: TimeRange {
                    start_ms: at_day(train_days)?,
                    end_ms: at_day(train_days + 14)?,
                },
                calibration: TimeRange {
                    start_ms: at_day(train_days + 14)?,
                    end_ms: at_day(train_days + 28)?,
                },
                confirmation: TimeRange {
                    start_ms: at_day(train_days + 28)?,
                    end_ms: at_day(train_days + 42)?,
                },
            };
            fold.validate()?;
            folds.push(fold);
        }
        Ok(Self {
            data,
            folds,
            historical_holdout: TimeRange {
                start_ms: at_day(160)?,
                end_ms,
            },
            unused_pre_holdout_gap: Some(TimeRange {
                start_ms: at_day(158)?,
                end_ms: at_day(160)?,
            }),
            future_unseen_start_ms: end_ms,
            label_maturity_hours: LABEL_MATURITY_HOURS,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LightGbmCandidate {
    pub id: String,
    pub parameters: String,
    pub iterations: usize,
}

/// A fixed, reproducible design rather than an unbounded Cartesian search.
pub fn controlled_candidates(threads: usize) -> Result<Vec<LightGbmCandidate>> {
    ensure!(
        (1..=64).contains(&threads),
        "CPU thread count must be in 1..=64"
    );
    let settings = [
        (0.03, 180, 7, 120, 0., 10., 1., 1.),
        (0.03, 240, 15, 160, 0.5, 15., 0.9, 0.9),
        (0.03, 300, 31, 240, 1., 20., 0.8, 0.85),
        (0.05, 100, 15, 30, 0., 5., 1., 1.),
        (0.05, 160, 7, 160, 1., 10., 0.9, 0.9),
        (0.05, 180, 15, 120, 0.5, 10., 0.9, 0.9),
        (0.05, 200, 31, 240, 1., 20., 0.85, 0.85),
        (0.07, 100, 7, 160, 1., 20., 1., 1.),
        (0.07, 120, 15, 160, 1., 15., 0.9, 0.9),
        (0.07, 140, 31, 320, 2., 25., 0.8, 0.85),
        (0.02, 300, 7, 240, 0.5, 20., 1., 0.9),
        (0.02, 360, 15, 240, 1., 25., 0.85, 0.85),
        (0.04, 180, 15, 320, 2., 30., 0.8, 0.8),
        (0.04, 220, 31, 400, 3., 40., 0.8, 0.8),
        (0.06, 140, 15, 240, 1., 20., 0.9, 0.85),
        (0.06, 160, 31, 320, 2., 30., 0.85, 0.85),
    ];
    Ok(settings.into_iter().enumerate().map(|(index, (rate, iterations, leaves, min_leaf, l1, l2, feature_fraction, bagging_fraction))| {
        let depth = match leaves { 7 => 3, 15 => 5, _ => 6 };
        let bagging_freq = usize::from(bagging_fraction < 1.);
        LightGbmCandidate {
            id: format!("cpu-multiclass-{index:02}"),
            iterations,
            parameters: format!("boosting=gbdt device_type=cpu objective=multiclass num_class=3 metric=multi_logloss deterministic=true force_col_wise=true num_threads={threads} num_leaves={leaves} min_data_in_leaf={min_leaf} lambda_l1={l1} lambda_l2={l2} learning_rate={rate} max_depth={depth} seed=42 feature_fraction_seed=42 bagging_seed=42 data_random_seed=42 feature_fraction={feature_fraction} bagging_fraction={bagging_fraction} bagging_freq={bagging_freq} verbosity=-1"),
        }
    }).collect())
}

pub fn validate_class_order(order: &[String]) -> Result<()> {
    ensure!(
        order.iter().map(String::as_str).eq(CLASS_ORDER),
        "Class order must be SELL=0,HOLD=1,BUY=2"
    );
    Ok(())
}
pub fn validate_probabilities(probabilities: &[f64; 3]) -> Result<()> {
    ensure!(
        probabilities
            .iter()
            .all(|p| p.is_finite() && (0. ..=1.).contains(p))
            && (probabilities.iter().sum::<f64>() - 1.).abs() <= 1e-6,
        "Invalid multiclass probabilities"
    );
    Ok(())
}
pub fn apply_temperature(probabilities: &[f64; 3], temperature: f64) -> Result<[f64; 3]> {
    validate_probabilities(probabilities)?;
    ensure!(
        temperature.is_finite() && temperature > 0.,
        "Invalid temperature"
    );
    let logits = probabilities.map(|p| p.ln() / temperature);
    let maximum = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let weights = logits.map(|p| (p - maximum).exp());
    let total = weights.iter().sum::<f64>();
    let calibrated = weights.map(|p| p / total);
    validate_probabilities(&calibrated)?;
    Ok(calibrated)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProbabilityObservation {
    pub symbol: String,
    pub origin_ms: i64,
    pub label: usize,
    pub probabilities: [f64; 3],
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TemperatureCalibration {
    pub temperature: f64,
    pub class_order: [String; 3],
}
impl Default for TemperatureCalibration {
    fn default() -> Self {
        Self {
            temperature: 1.,
            class_order: CLASS_ORDER.map(str::to_owned),
        }
    }
}
impl TemperatureCalibration {
    pub fn validate(&self) -> Result<()> {
        validate_class_order(&self.class_order)?;
        ensure!(
            TEMPERATURE_CANDIDATES.contains(&self.temperature),
            "Temperature is outside the frozen search design"
        );
        Ok(())
    }
    pub fn apply(&self, probabilities: &[f64; 3]) -> Result<[f64; 3]> {
        self.validate()?;
        apply_temperature(probabilities, self.temperature)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemperatureTrial {
    pub temperature: f64,
    pub calibration_log_loss: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TemperatureFit {
    pub selected: TemperatureCalibration,
    pub trials: Vec<TemperatureTrial>,
    pub rows_used: usize,
    pub fitted_range: TimeRange,
    pub label_maturity_hours: i64,
}
/// Only mature observations in the independent calibration slice are inspected.
pub fn fit_temperature(
    rows: &[ProbabilityObservation],
    calibration_range: TimeRange,
) -> Result<TemperatureFit> {
    calibration_range.validate()?;
    let selected_rows: Vec<_> = rows
        .iter()
        .filter(|row| calibration_range.contains_mature_origin(row.origin_ms))
        .collect();
    ensure!(
        !selected_rows.is_empty(),
        "No mature probability calibration rows"
    );
    for row in &selected_rows {
        ensure!(row.label < 3, "Invalid multiclass label");
        validate_probabilities(&row.probabilities)?;
    }
    let mut best = f64::INFINITY;
    let mut selected = TemperatureCalibration::default();
    let mut trials = Vec::new();
    for temperature in TEMPERATURE_CANDIDATES {
        let mut loss = 0.;
        for row in &selected_rows {
            loss -= apply_temperature(&row.probabilities, temperature)?[row.label]
                .max(LOSS_FLOOR)
                .ln();
        }
        loss /= selected_rows.len() as f64;
        trials.push(TemperatureTrial {
            temperature,
            calibration_log_loss: loss,
        });
        if loss < best - 1e-12 || ((loss - best).abs() <= 1e-12 && temperature == 1.) {
            best = loss;
            selected.temperature = temperature;
        }
    }
    Ok(TemperatureFit {
        selected,
        trials,
        rows_used: selected_rows.len(),
        fitted_range: calibration_range,
        label_maturity_hours: LABEL_MATURITY_HOURS,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClassificationMetrics {
    pub class_order: [String; 3],
    pub rows: usize,
    pub symbols: usize,
    pub class_counts: [usize; 3],
    pub confusion: [[usize; 3]; 3],
    pub accuracy_percent: f64,
    pub balanced_accuracy_percent: f64,
    pub macro_symbol_accuracy_percent: f64,
    pub directional_class_accuracy_percent: Option<f64>,
    pub log_loss: f64,
    pub brier_score: f64,
}
pub fn classification_metrics(
    rows: &[ProbabilityObservation],
    calibration: Option<&TemperatureCalibration>,
) -> Result<ClassificationMetrics> {
    ensure!(!rows.is_empty(), "Empty classification evaluation");
    if let Some(calibration) = calibration {
        calibration.validate()?;
    }
    let mut confusion = [[0usize; 3]; 3];
    let mut counts = [0usize; 3];
    let mut symbols = BTreeMap::<&str, (usize, usize)>::new();
    let mut log_loss = 0.;
    let mut brier_score = 0.;
    for row in rows {
        ensure!(
            row.label < 3 && !row.symbol.is_empty(),
            "Invalid classification label or symbol"
        );
        validate_probabilities(&row.probabilities)?;
        let probabilities = match calibration {
            Some(calibration) => calibration.apply(&row.probabilities)?,
            None => row.probabilities,
        };
        // Strict improvement preserves the first class for exact ties.
        let predicted = (1..3).fold(0, |best, index| {
            if probabilities[index] > probabilities[best] {
                index
            } else {
                best
            }
        });
        confusion[row.label][predicted] += 1;
        counts[row.label] += 1;
        let symbol = symbols.entry(&row.symbol).or_default();
        symbol.0 += 1;
        symbol.1 += usize::from(predicted == row.label);
        log_loss -= probabilities[row.label].max(LOSS_FLOOR).ln();
        for (index, probability) in probabilities.iter().enumerate() {
            brier_score += (probability - if index == row.label { 1. } else { 0. }).powi(2);
        }
    }
    let correct = (0..3).map(|index| confusion[index][index]).sum::<usize>();
    let present_classes = counts.iter().filter(|&&count| count > 0).count();
    let balanced = (0..3)
        .filter(|&index| counts[index] > 0)
        .map(|index| confusion[index][index] as f64 / counts[index] as f64)
        .sum::<f64>()
        / present_classes as f64;
    let directional_rows = counts[0] + counts[2];
    Ok(ClassificationMetrics {
        class_order: CLASS_ORDER.map(str::to_owned),
        rows: rows.len(),
        symbols: symbols.len(),
        class_counts: counts,
        confusion,
        accuracy_percent: correct as f64 / rows.len() as f64 * 100.,
        balanced_accuracy_percent: balanced * 100.,
        macro_symbol_accuracy_percent: symbols
            .values()
            .map(|(rows, correct)| *correct as f64 / *rows as f64)
            .sum::<f64>()
            / symbols.len() as f64
            * 100.,
        directional_class_accuracy_percent: (directional_rows > 0)
            .then(|| (confusion[0][0] + confusion[2][2]) as f64 / directional_rows as f64 * 100.),
        log_loss: log_loss / rows.len() as f64,
        brier_score: brier_score / rows.len() as f64,
    })
}

/// Matched slices and labels are required for the Chronos feature ablation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AblationMetrics {
    pub with_chronos: ClassificationMetrics,
    pub without_chronos: ClassificationMetrics,
    pub accuracy_delta_points: f64,
    pub balanced_accuracy_delta_points: f64,
    pub log_loss_delta: f64,
}
pub fn ablation_metrics(
    with_chronos: &[ProbabilityObservation],
    without_chronos: &[ProbabilityObservation],
    with_calibration: Option<&TemperatureCalibration>,
    without_calibration: Option<&TemperatureCalibration>,
) -> Result<AblationMetrics> {
    ensure!(
        with_chronos.len() == without_chronos.len()
            && with_chronos
                .iter()
                .zip(without_chronos)
                .all(|(a, b)| a.symbol == b.symbol
                    && a.origin_ms == b.origin_ms
                    && a.label == b.label),
        "Ablation rows or labels differ"
    );
    let with_chronos = classification_metrics(with_chronos, with_calibration)?;
    let without_chronos = classification_metrics(without_chronos, without_calibration)?;
    Ok(AblationMetrics {
        accuracy_delta_points: with_chronos.accuracy_percent - without_chronos.accuracy_percent,
        balanced_accuracy_delta_points: with_chronos.balanced_accuracy_percent
            - without_chronos.balanced_accuracy_percent,
        log_loss_delta: with_chronos.log_loss - without_chronos.log_loss,
        with_chronos,
        without_chronos,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForecastObservation {
    pub forecast: ForecastRecord,
    /// Actual future closes/current_price - 1, available only after maturity.
    pub realized_returns: Vec<f64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuantileCalibration {
    pub bias_by_hour: Vec<f64>,
    pub median_shrink: f64,
    pub lower_width_scale: f64,
    pub upper_width_scale: f64,
}
impl Default for QuantileCalibration {
    fn default() -> Self {
        Self {
            bias_by_hour: vec![0.; ml_features::HORIZON],
            median_shrink: 1.,
            lower_width_scale: 1.,
            upper_width_scale: 1.,
        }
    }
}
impl QuantileCalibration {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.bias_by_hour.len() == ml_features::HORIZON
                && self
                    .bias_by_hour
                    .iter()
                    .all(|bias| bias.is_finite() && bias.abs() <= 0.5),
            "Invalid rolling quantile bias"
        );
        ensure!(
            self.median_shrink.is_finite() && (0. ..=1.).contains(&self.median_shrink),
            "Invalid rolling median shrink"
        );
        ensure!(
            [self.lower_width_scale, self.upper_width_scale]
                .iter()
                .all(|scale| scale.is_finite() && *scale > 0. && *scale <= 20.),
            "Invalid rolling quantile width scale"
        );
        Ok(())
    }
    fn quantiles_at(&self, forecast: &ForecastRecord, hour: usize) -> Result<[f64; 3]> {
        let floor = (forecast.current_price * PRICE_FLOOR_FRACTION).max(f64::MIN_POSITIVE);
        let median = (forecast.current_price
            * (1.
                + self.median_shrink * (forecast.q50[hour] / forecast.current_price - 1.)
                + self.bias_by_hour[hour]))
            .max(floor);
        let lower = (median - (forecast.q50[hour] - forecast.q10[hour]) * self.lower_width_scale)
            .max(floor);
        let upper = median + (forecast.q90[hour] - forecast.q50[hour]) * self.upper_width_scale;
        ensure!(
            [lower, median, upper]
                .iter()
                .all(|value| value.is_finite() && *value > 0.)
                && lower <= median
                && median <= upper,
            "Invalid calibrated positive-price quantiles"
        );
        Ok([lower, median, upper])
    }
}
fn validate_forecast(forecast: &ForecastRecord) -> Result<()> {
    ensure!(
        forecast.current_price.is_finite()
            && forecast.current_price > 0.
            && forecast.horizon_hours == ml_features::HORIZON
            && forecast.interval == "1h"
            && forecast.context_end_open_ms.checked_add(ml_features::HOUR)
                == Some(forecast.origin_ms)
            && forecast.origin_ms % ml_features::HOUR == 0
            && forecast.quantile_crossings == 0,
        "Invalid hourly rolling forecast metadata"
    );
    ensure!(
        [&forecast.q10, &forecast.q50, &forecast.q90]
            .iter()
            .all(|values| values.len() == ml_features::HORIZON
                && values.iter().all(|value| value.is_finite()
                    && *value > 0.
                    && (value / forecast.current_price).is_finite())),
        "Invalid rolling forecast horizon or price"
    );
    ensure!(
        (0..ml_features::HORIZON).all(|hour| forecast.q10[hour] <= forecast.q50[hour]
            && forecast.q50[hour] <= forecast.q90[hour]),
        "Raw forecast quantiles cross"
    );
    Ok(())
}
pub fn apply_quantile_calibration(
    forecast: &ForecastRecord,
    calibration: &QuantileCalibration,
) -> Result<ForecastRecord> {
    validate_forecast(forecast)?;
    calibration.validate()?;
    let mut output = forecast.clone();
    for hour in 0..ml_features::HORIZON {
        let [lower, median, upper] = calibration.quantiles_at(forecast, hour)?;
        output.q10[hour] = lower;
        output.q50[hour] = median;
        output.q90[hour] = upper;
    }
    output.quantile_crossings = 0;
    Ok(output)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuantileMetrics {
    pub rows: usize,
    pub median_mae_return_fraction: f64,
    pub endpoint_mae_return_fraction: f64,
    pub endpoint_directional_accuracy_percent: Option<f64>,
    pub endpoint_direction_rows: usize,
    pub pinball_return_loss: f64,
    pub interval_coverage_percent: f64,
    pub endpoint_interval_coverage_percent: f64,
    pub mean_interval_width_return_fraction: f64,
}
fn quantile_metrics(
    rows: &[&ForecastObservation],
    calibration: &QuantileCalibration,
) -> Result<QuantileMetrics> {
    let mut absolute = 0.;
    let mut pinball = 0.;
    let mut covered = 0usize;
    let mut width = 0.;
    let mut endpoint_absolute = 0.;
    let mut endpoint_covered = 0usize;
    let mut directional_correct = 0usize;
    let mut directional_rows = 0usize;
    for row in rows {
        for hour in 0..ml_features::HORIZON {
            let quantiles = calibration
                .quantiles_at(&row.forecast, hour)?
                .map(|price| price / row.forecast.current_price - 1.);
            let actual = row.realized_returns[hour];
            absolute += (actual - quantiles[1]).abs();
            width += quantiles[2] - quantiles[0];
            covered += usize::from(actual >= quantiles[0] && actual <= quantiles[2]);
            if hour + 1 == ml_features::HORIZON {
                endpoint_absolute += (actual - quantiles[1]).abs();
                endpoint_covered += usize::from(actual >= quantiles[0] && actual <= quantiles[2]);
                if actual != 0. {
                    directional_rows += 1;
                    directional_correct +=
                        usize::from(quantiles[1] != 0. && (actual > 0.) == (quantiles[1] > 0.));
                }
            }
            for (predicted, quantile) in quantiles.into_iter().zip([0.1, 0.5, 0.9]) {
                let error = actual - predicted;
                pinball += if error >= 0. {
                    quantile * error
                } else {
                    (quantile - 1.) * error
                };
            }
        }
    }
    let count = (rows.len() * ml_features::HORIZON) as f64;
    ensure!(
        [absolute, pinball, width, endpoint_absolute]
            .iter()
            .all(|value| value.is_finite()),
        "Non-finite forecast metric aggregate"
    );
    Ok(QuantileMetrics {
        rows: rows.len(),
        median_mae_return_fraction: absolute / count,
        endpoint_mae_return_fraction: endpoint_absolute / rows.len() as f64,
        endpoint_directional_accuracy_percent: (directional_rows > 0)
            .then(|| directional_correct as f64 / directional_rows as f64 * 100.),
        endpoint_direction_rows: directional_rows,
        pinball_return_loss: pinball / (3. * count),
        interval_coverage_percent: covered as f64 / count * 100.,
        endpoint_interval_coverage_percent: endpoint_covered as f64 / rows.len() as f64 * 100.,
        mean_interval_width_return_fraction: width / count,
    })
}
/// Evaluate a fixed calibration on one mature partition without fitting it.
pub fn forecast_metrics(
    rows: &[ForecastObservation],
    range: TimeRange,
    calibration: &QuantileCalibration,
) -> Result<QuantileMetrics> {
    range.validate()?;
    calibration.validate()?;
    let selected: Vec<_> = rows
        .iter()
        .filter(|row| range.contains_mature_origin(row.forecast.origin_ms))
        .collect();
    ensure!(
        !selected.is_empty(),
        "No mature forecast evaluation observations"
    );
    for row in &selected {
        validate_forecast(&row.forecast)?;
        ensure!(
            row.realized_returns.len() == ml_features::HORIZON
                && row
                    .realized_returns
                    .iter()
                    .all(|value| value.is_finite() && *value > -1.),
            "Invalid realized forecast returns"
        );
    }
    quantile_metrics(&selected, calibration)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuantileCalibrationTrial {
    pub calibration: QuantileCalibration,
    pub validation: QuantileMetrics,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuantileCalibrationFit {
    pub selected: QuantileCalibration,
    pub train_range: TimeRange,
    pub validation_range: TimeRange,
    pub train_rows: usize,
    pub validation_rows: usize,
    pub label_maturity_hours: i64,
    pub center_trials: Vec<QuantileCalibrationTrial>,
    pub selected_center_trial: usize,
    pub train_fitted_lower_width_scale: f64,
    pub train_fitted_upper_width_scale: f64,
    /// Identity is always index 0 and is eligible for final selection.
    pub interval_trials: Vec<QuantileCalibrationTrial>,
    pub selected_interval_trial: usize,
}
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        values[middle - 1] / 2. + values[middle] / 2.
    } else {
        values[middle]
    }
}
fn conservative_quantile(mut values: Vec<f64>, probability: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    values[((values.len() as f64 * probability).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1)]
}
/// Biases and base interval scales use training labels only. Validation first
/// selects median shrink by median MAE, then independent lower/upper multipliers
/// by pinball loss. Confirmation and historical/future holdouts are ignored.
pub fn fit_quantile_calibration(
    rows: &[ForecastObservation],
    train_range: TimeRange,
    validation_range: TimeRange,
) -> Result<QuantileCalibrationFit> {
    train_range.validate()?;
    validation_range.validate()?;
    ensure!(
        train_range.end_ms <= validation_range.start_ms,
        "Quantile train and validation overlap"
    );
    let train: Vec<_> = rows
        .iter()
        .filter(|row| train_range.contains_mature_origin(row.forecast.origin_ms))
        .collect();
    let validation: Vec<_> = rows
        .iter()
        .filter(|row| validation_range.contains_mature_origin(row.forecast.origin_ms))
        .collect();
    ensure!(
        !train.is_empty() && !validation.is_empty(),
        "Missing mature quantile train or validation observations"
    );
    for row in train.iter().chain(&validation) {
        validate_forecast(&row.forecast)?;
        ensure!(
            row.realized_returns.len() == ml_features::HORIZON
                && row
                    .realized_returns
                    .iter()
                    .all(|value| value.is_finite() && *value > -1.),
            "Invalid realized forecast returns"
        );
    }
    let identity = QuantileCalibration::default();
    let mut center_trials = vec![QuantileCalibrationTrial {
        validation: quantile_metrics(&validation, &identity)?,
        calibration: identity.clone(),
    }];
    for shrink in [0., 0.25, 0.5, 0.75, 1.] {
        let bias_by_hour = (0..ml_features::HORIZON)
            .map(|hour| {
                median(
                    train
                        .iter()
                        .map(|row| {
                            row.realized_returns[hour]
                                - shrink
                                    * (row.forecast.q50[hour] / row.forecast.current_price - 1.)
                        })
                        .collect(),
                )
                .clamp(-0.5, 0.5)
            })
            .collect();
        let calibration = QuantileCalibration {
            bias_by_hour,
            median_shrink: shrink,
            ..identity.clone()
        };
        center_trials.push(QuantileCalibrationTrial {
            validation: quantile_metrics(&validation, &calibration)?,
            calibration,
        });
    }
    let selected_center_trial = center_trials
        .iter()
        .enumerate()
        .min_by(|(ia, a), (ib, b)| {
            a.validation
                .median_mae_return_fraction
                .total_cmp(&b.validation.median_mae_return_fraction)
                .then(ia.cmp(ib))
        })
        .unwrap()
        .0;
    let center = &center_trials[selected_center_trial].calibration;
    let mut lower_ratios = Vec::new();
    let mut upper_ratios = Vec::new();
    for row in &train {
        for hour in 0..ml_features::HORIZON {
            let median_return =
                center.quantiles_at(&row.forecast, hour)?[1] / row.forecast.current_price - 1.;
            let lower_width =
                (row.forecast.q50[hour] - row.forecast.q10[hour]) / row.forecast.current_price;
            let upper_width =
                (row.forecast.q90[hour] - row.forecast.q50[hour]) / row.forecast.current_price;
            if lower_width > LOSS_FLOOR {
                lower_ratios
                    .push(((median_return - row.realized_returns[hour]) / lower_width).max(0.));
            }
            if upper_width > LOSS_FLOOR {
                upper_ratios
                    .push(((row.realized_returns[hour] - median_return) / upper_width).max(0.));
            }
        }
    }
    let lower_scale = if lower_ratios.is_empty() {
        1.
    } else {
        conservative_quantile(lower_ratios, 0.9).clamp(0.1, 10.)
    };
    let upper_scale = if upper_ratios.is_empty() {
        1.
    } else {
        conservative_quantile(upper_ratios, 0.9).clamp(0.1, 10.)
    };
    let mut interval_trials = vec![QuantileCalibrationTrial {
        validation: quantile_metrics(&validation, &identity)?,
        calibration: identity.clone(),
    }];
    // Include unmodified widths for the chosen center as well as trained widths.
    interval_trials.push(center_trials[selected_center_trial].clone());
    for lower_multiplier in [0.75, 1., 1.25, 1.5, 2.] {
        for upper_multiplier in [0.75, 1., 1.25, 1.5, 2.] {
            let calibration = QuantileCalibration {
                lower_width_scale: lower_scale * lower_multiplier,
                upper_width_scale: upper_scale * upper_multiplier,
                ..center.clone()
            };
            calibration.validate()?;
            interval_trials.push(QuantileCalibrationTrial {
                validation: quantile_metrics(&validation, &calibration)?,
                calibration,
            });
        }
    }
    let selected_interval_trial = interval_trials
        .iter()
        .enumerate()
        .min_by(|(ia, a), (ib, b)| {
            a.validation
                .pinball_return_loss
                .total_cmp(&b.validation.pinball_return_loss)
                .then(ia.cmp(ib))
        })
        .unwrap()
        .0;
    Ok(QuantileCalibrationFit {
        selected: interval_trials[selected_interval_trial].calibration.clone(),
        train_range,
        validation_range,
        train_rows: train.len(),
        validation_rows: validation.len(),
        label_maturity_hours: LABEL_MATURITY_HOURS,
        center_trials,
        selected_center_trial,
        train_fitted_lower_width_scale: lower_scale,
        train_fitted_upper_width_scale: upper_scale,
        interval_trials,
        selected_interval_trial,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn range(start_day: i64, end_day: i64) -> TimeRange {
        TimeRange {
            start_ms: start_day * DAY,
            end_ms: end_day * DAY,
        }
    }
    fn probability(
        symbol: &str,
        day: i64,
        label: usize,
        probabilities: [f64; 3],
    ) -> ProbabilityObservation {
        ProbabilityObservation {
            symbol: symbol.into(),
            origin_ms: day * DAY,
            label,
            probabilities,
        }
    }
    fn forecast(day: i64, actual: f64) -> ForecastObservation {
        ForecastObservation {
            forecast: ForecastRecord {
                symbol: "BTCUSDT".into(),
                origin_ms: day * DAY,
                context_end_open_ms: day * DAY - ml_features::HOUR,
                history_sha256: None,
                current_price: 100.,
                interval: "1h".into(),
                horizon_hours: ml_features::HORIZON,
                q10: vec![98.; ml_features::HORIZON],
                q50: vec![102.; ml_features::HORIZON],
                q90: vec![107.; ml_features::HORIZON],
                quantile_crossings: 0,
                inference_ms: 0.,
            },
            realized_returns: vec![actual; ml_features::HORIZON],
        }
    }
    #[test]
    fn rolling_boundaries_purge_full_48h_and_reserve_later_data() {
        let plan = RollingPlan::expanding_180d(0, 180 * DAY).unwrap();
        assert_eq!(plan.folds.len(), 3);
        for (index, fold) in plan.folds.iter().enumerate() {
            assert_eq!(fold.train.end_ms, (60 + index as i64 * 28) * DAY);
            assert_eq!(fold.partition(fold.train.start_ms), Some(Partition::Train));
            assert_eq!(
                fold.partition(fold.train.end_ms - 48 * ml_features::HOUR),
                Some(Partition::Train)
            );
            assert_eq!(
                fold.partition(fold.train.end_ms - 48 * ml_features::HOUR + 1),
                None
            );
            assert_eq!(
                fold.partition(fold.validation.start_ms),
                Some(Partition::Validation)
            );
            assert_eq!(
                fold.partition(fold.calibration.start_ms),
                Some(Partition::Calibration)
            );
            assert_eq!(
                fold.partition(fold.confirmation.start_ms),
                Some(Partition::Confirmation)
            );
            assert_eq!(fold.partition(fold.confirmation.end_ms), None);
            assert_eq!(fold.partition(plan.historical_holdout.start_ms), None);
        }
        assert_eq!(plan.folds[2].confirmation, range(144, 158));
        assert_eq!(plan.unused_pre_holdout_gap, Some(range(158, 160)));
        assert_eq!(plan.historical_holdout, range(160, 180));
        assert_eq!(plan.future_unseen_start_ms, 180 * DAY);
        assert!(
            !TimeRange {
                start_ms: 0,
                end_ms: i64::MAX
            }
            .contains_mature_origin(i64::MAX - 1)
        );
        assert!(RollingPlan::expanding_180d(0, 179 * DAY).is_err());
        let mut invalid = plan.folds[0].clone();
        invalid.validation.start_ms = invalid.train.end_ms - DAY;
        assert!(invalid.validate().is_err());
        assert_eq!(invalid.partition(0), None);
    }
    #[test]
    fn candidates_are_bounded_distinct_cpu_multiclass_and_seeded() {
        let candidates = controlled_candidates(4).unwrap();
        assert_eq!(candidates.len(), 16);
        let unique: std::collections::BTreeSet<_> = candidates
            .iter()
            .map(|candidate| (&candidate.parameters, candidate.iterations))
            .collect();
        assert_eq!(unique.len(), 16);
        for candidate in candidates {
            assert!((1..=1000).contains(&candidate.iterations));
            for required in [
                "device_type=cpu",
                "objective=multiclass",
                "num_class=3",
                "num_threads=4",
                "seed=42",
                "lambda_l1=",
                "lambda_l2=",
                "feature_fraction=",
                "bagging_fraction=",
            ] {
                assert!(candidate.parameters.contains(required));
            }
        }
        assert!(controlled_candidates(0).is_err());
        assert!(controlled_candidates(65).is_err());
    }
    #[test]
    fn probability_calibration_is_stable_and_ignores_future_or_immature_labels() {
        let mut rows = vec![
            probability("A", 11, 0, [0.99, 0.005, 0.005]),
            probability("B", 12, 1, [0.99, 0.005, 0.005]),
        ];
        let fit = fit_temperature(&rows, range(10, 20)).unwrap();
        assert_eq!(fit.selected.temperature, 2.);
        assert_eq!(fit.rows_used, 2);
        rows.push(probability("FUTURE", 21, 99, [f64::NAN; 3]));
        rows.push(probability("IMMATURE", 19, 99, [f64::NAN; 3]));
        assert_eq!(
            fit_temperature(&rows, range(10, 20)).unwrap().selected,
            fit.selected
        );
        let one_hot = apply_temperature(&[0., 1., 0.], 2.).unwrap();
        assert_eq!(one_hot, [0., 1., 0.]);
        let mut invalid = fit.selected;
        invalid.class_order.swap(0, 2);
        assert!(invalid.apply(&[0.3, 0.4, 0.3]).is_err());
        assert!(apply_temperature(&[0.5, 0.5, 0.5], 1.).is_err());
        assert!(apply_temperature(&[-0.1, 0.6, 0.5], 1.).is_err());
    }
    #[test]
    fn classification_uses_class_and_symbol_balancing_and_matched_ablation() {
        let rows = vec![
            probability("A", 1, 0, [0.8, 0.1, 0.1]),
            probability("A", 2, 2, [0.7, 0.1, 0.2]),
            probability("B", 1, 1, [0.1, 0.8, 0.1]),
        ];
        let metrics = classification_metrics(&rows, None).unwrap();
        assert_eq!(metrics.confusion, [[1, 0, 0], [0, 1, 0], [1, 0, 0]]);
        assert!((metrics.accuracy_percent - 200. / 3.).abs() < 1e-10);
        assert!((metrics.balanced_accuracy_percent - 200. / 3.).abs() < 1e-10);
        assert_eq!(metrics.macro_symbol_accuracy_percent, 75.);
        assert_eq!(metrics.directional_class_accuracy_percent, Some(50.));
        assert_eq!(
            ablation_metrics(&rows, &rows, None, None)
                .unwrap()
                .log_loss_delta,
            0.
        );
        let mut changed = rows.clone();
        changed[0].label = 1;
        assert!(ablation_metrics(&rows, &changed, None, None).is_err());
    }
    #[test]
    fn median_shrink_does_not_shrink_independent_interval_widths() {
        let raw = forecast(1, 0.03).forecast;
        let calibration = QuantileCalibration {
            bias_by_hour: vec![0.01; ml_features::HORIZON],
            median_shrink: 0.25,
            lower_width_scale: 2.,
            upper_width_scale: 3.,
        };
        let corrected = apply_quantile_calibration(&raw, &calibration).unwrap();
        assert!((corrected.q50[0] - 101.5).abs() < 1e-10);
        assert!((corrected.q10[0] - 93.5).abs() < 1e-10);
        assert!((corrected.q90[0] - 116.5).abs() < 1e-10);
        let mut wide = calibration;
        wide.lower_width_scale = 20.;
        let mut extreme = raw;
        extreme.q10 = vec![1.; ml_features::HORIZON];
        let corrected = apply_quantile_calibration(&extreme, &wide).unwrap();
        assert!(
            corrected.q10[0] > 0.
                && corrected.q10[0] <= corrected.q50[0]
                && corrected.q50[0] <= corrected.q90[0]
        );
    }
    #[test]
    fn quantile_bias_uses_train_only_and_future_observations_cannot_change_fit() {
        let mut rows = vec![
            forecast(1, 0.03),
            forecast(2, 0.04),
            forecast(11, 0.02),
            forecast(12, -0.01),
        ];
        let fit = fit_quantile_calibration(&rows, range(0, 10), range(10, 20)).unwrap();
        assert_eq!(fit.train_rows, 2);
        assert_eq!(fit.validation_rows, 2);
        assert_eq!(
            fit.interval_trials[0].calibration,
            QuantileCalibration::default()
        );
        let mut future = forecast(21, 0.9);
        future.forecast.q10.clear();
        rows.push(future);
        assert_eq!(
            fit_quantile_calibration(&rows, range(0, 10), range(10, 20))
                .unwrap()
                .selected,
            fit.selected
        );
        rows[2].realized_returns.fill(0.5);
        rows[3].realized_returns.fill(0.4);
        let changed_validation =
            fit_quantile_calibration(&rows, range(0, 10), range(10, 20)).unwrap();
        for (original, changed) in fit
            .center_trials
            .iter()
            .zip(&changed_validation.center_trials)
        {
            assert_eq!(original.calibration, changed.calibration);
        }
        assert!(fit_quantile_calibration(&rows, range(0, 10), range(9, 20)).is_err());
        let serialized = serde_json::to_vec(&fit).unwrap();
        let decoded: QuantileCalibrationFit = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(decoded.selected, fit.selected);
    }
}
