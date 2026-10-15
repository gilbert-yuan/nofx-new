//! Shared causal features and artifacts for monthly Chronos + LightGBM research.
use crate::{chronos::ForecastRecord, ml_features, number, timestamp};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MICRO_FEATURE_NAMES: &[&str] = &[
    "quote_volume_log",
    "trade_count_log",
    "taker_buy_fraction",
    "taker_flow_imbalance",
    "quote_to_close_volume",
    "mean_trade_quote_log",
    "microstructure_present",
    "trade_count_change24",
];
pub const HISTORY_FEATURE_NAMES: &[&str] = &[
    "funding_rate",
    "oi_log",
    "oi_change24",
    "global_long_short",
    "top_account_long_short",
    "top_position_long_short",
    "taker_long_short",
    "basis_rate",
    "premium_close",
    "mark_index_basis",
    "funding_available",
    "oi_available",
    "oi_change24_available",
    "global_long_short_available",
    "top_account_long_short_available",
    "top_position_long_short_available",
    "taker_long_short_available",
    "basis_available",
    "premium_available",
    "mark_index_available",
];
pub const MARKET_FEATURE_NAMES: &[&str] = &[
    "btc_return24",
    "btc_return72",
    "btc_correlation72",
    "relative_btc_return24",
    "btc_available",
    "eth_return24",
    "eth_return72",
    "eth_correlation72",
    "relative_eth_return24",
    "eth_available",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Calibration {
    pub bias_by_hour: Vec<f64>,
    pub shrink: f64,
}
impl Default for Calibration {
    fn default() -> Self {
        Self {
            bias_by_hour: vec![0.; ml_features::HORIZON],
            shrink: 1.,
        }
    }
}
impl Calibration {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.bias_by_hour.len() == ml_features::HORIZON
                && self
                    .bias_by_hour
                    .iter()
                    .all(|x| x.is_finite() && x.abs() <= 0.5),
            "Invalid forecast calibration bias"
        );
        ensure!(
            self.shrink.is_finite() && (0.0..=1.0).contains(&self.shrink),
            "Invalid forecast shrink"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DecisionPolicy {
    pub probability_threshold: f64,
    pub probability_margin: f64,
}
impl Default for DecisionPolicy {
    fn default() -> Self {
        Self {
            probability_threshold: 0.55,
            probability_margin: 0.10,
        }
    }
}
impl DecisionPolicy {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (0.34..=0.95).contains(&self.probability_threshold)
                && (0.0..=0.5).contains(&self.probability_margin),
            "Invalid decision policy"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelArtifact {
    pub path: String,
    pub sha256: String,
    pub feature_names: Vec<String>,
    pub feature_count: usize,
    pub parameters: String,
    pub iterations: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ForecastArtifact {
    pub model_id: String,
    pub path: String,
    pub sha256: String,
    pub runtime_path: String,
    pub weights_updated: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Split {
    pub start_ms: i64,
    pub train_end_ms: i64,
    pub validation_end_ms: i64,
    pub test_end_ms: i64,
    pub embargo_hours: usize,
}
impl Split {
    pub fn part(&self, origin: i64) -> Option<&'static str> {
        let matured = origin.checked_add(ml_features::HORIZON as i64 * ml_features::HOUR)?;
        if origin >= self.start_ms && matured <= self.train_end_ms {
            Some("train")
        } else if origin >= self.train_end_ms && matured <= self.validation_end_ms {
            Some("validation")
        } else if origin >= self.validation_end_ms && matured <= self.test_end_ms {
            Some("test")
        } else {
            None
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MonthlyManifest {
    pub schema_version: u32,
    pub pipeline: String,
    pub symbols: Vec<String>,
    pub model: ModelArtifact,
    pub baseline: ModelArtifact,
    pub forecast: ForecastArtifact,
    pub calibration: Calibration,
    pub policy: DecisionPolicy,
    pub split: Split,
    pub feature_schema_sha256: String,
    pub historical_features_used: bool,
    pub market_features_used: bool,
    pub chronos_retained: bool,
    pub stride_hours: usize,
    pub source_manifest_sha256: String,
    #[serde(default)]
    pub training_code_sha256: String,
    pub selection_gate: Value,
    pub risk: Value,
    pub created_at_ms: i64,
    pub source_training_report: String,
}
pub fn feature_names() -> Vec<String> {
    ml_features::BASE_FEATURE_NAMES
        .iter()
        .chain(MICRO_FEATURE_NAMES)
        .chain(HISTORY_FEATURE_NAMES)
        .chain(MARKET_FEATURE_NAMES)
        .chain(ml_features::CHRONOS_FEATURE_NAMES)
        .map(|x| (*x).to_owned())
        .collect()
}
pub fn schema_sha256() -> String {
    let mut hash = Sha256::new();
    // Persisted features and source digests require the exact decoder enabled
    // in Cargo.toml; caches from the former default float parser are distinct.
    hash.update(b"serde_json:float_roundtrip:exact-f64:v1");
    hash.update(include_bytes!("ml_monthly.rs"));
    hash.update(include_bytes!("ml_features.rs"));
    hash.update(include_bytes!("chronos.rs"));
    hex::encode(hash.finalize())
}
pub fn validate_manifest(manifest: &MonthlyManifest) -> Result<()> {
    ensure!(
        manifest.schema_version == 2 && manifest.pipeline == "chronos-bolt-tiny-lightgbm-monthly",
        "Unsupported monthly model schema"
    );
    ensure!(
        manifest.chronos_retained && manifest.forecast.model_id == crate::chronos::MODEL_ID,
        "Monthly model must retain Chronos-Bolt-Tiny"
    );
    ensure!(
        !manifest.forecast.weights_updated,
        "This artifact describes forecast calibration, not weight fine-tuning"
    );
    ensure!(
        manifest.feature_schema_sha256 == schema_sha256()
            && manifest.model.feature_names == feature_names()
            && manifest.model.feature_count == feature_names().len(),
        "Monthly feature implementation/schema mismatch"
    );
    ensure!(
        !manifest.symbols.is_empty() && (1..=24).contains(&manifest.stride_hours),
        "Invalid model universe or stride"
    );
    let split = &manifest.split;
    ensure!(
        split.start_ms > 0
            && split.start_ms < split.train_end_ms
            && split.train_end_ms < split.validation_end_ms
            && split.validation_end_ms < split.test_end_ms
            && split.embargo_hours == ml_features::HORIZON,
        "Invalid chronological split"
    );
    for cutoff in [
        split.start_ms,
        split.train_end_ms,
        split.validation_end_ms,
        split.test_end_ms,
    ] {
        ensure!(cutoff % ml_features::HOUR == 0, "Unaligned split");
    }
    manifest.calibration.validate()?;
    manifest.policy.validate()?;
    Ok(())
}
pub fn extended_features(rows: &[Value], end: usize) -> Result<Vec<f64>> {
    let mut output = ml_features::base_features(rows, end)?;
    let last = &rows[end - 1];
    let quote = number(&last["quoteVolume"], f64::NAN);
    let count = number(&last["tradeCount"], f64::NAN);
    let volume = number(&last["volume"], f64::NAN);
    let close = number(&last["close"], f64::NAN);
    let buy = number(&last["takerBuyVolume"], f64::NAN);
    let present = quote.is_finite()
        && quote >= 0.
        && count.is_finite()
        && count >= 0.
        && buy.is_finite()
        && buy >= 0.
        && buy <= volume;
    let prior = number(&rows[end - 25]["tradeCount"], f64::NAN);
    let fraction = if present && volume > 0. {
        buy / volume
    } else {
        0.5
    };
    output.extend(if present {
        [
            quote.ln_1p(),
            count.ln_1p(),
            fraction,
            2. * fraction - 1.,
            if volume * close > 0. {
                quote / (volume * close) - 1.
            } else {
                0.
            },
            if count > 0. {
                (quote / count).ln_1p()
            } else {
                0.
            },
            1.,
            if prior.is_finite() && prior > 0. {
                count / prior - 1.
            } else {
                0.
            },
        ]
    } else {
        [0., 0., 0.5, 0., 0., 0., 0., 0.]
    });
    ensure!(
        output.iter().all(|x| x.is_finite()),
        "Non-finite monthly candle features"
    );
    Ok(output)
}

/// Historical features require a publisher availability timestamp. Missing or
/// stale values carry explicit masks and never acquire a future observation.
fn as_of<'a>(history: &'a Value, dataset: &str, origin: i64, max_age: i64) -> Option<&'a Value> {
    history["datasets"][dataset]
        .as_array()?
        .iter()
        .filter(|row| {
            row["available_at_ms"]
                .as_i64()
                .is_some_and(|available| available <= origin && origin - available <= max_age)
        })
        .max_by_key(|row| row["available_at_ms"].as_i64())
}
pub fn historical_features(history: &Value, origin: i64) -> Vec<f64> {
    let day = 24 * ml_features::HOUR;
    let value = |dataset, key, age| {
        as_of(history, dataset, origin, age)
            .map(|r| number(&r[key], f64::NAN))
            .filter(|v| v.is_finite())
    };
    let funding = value("funding", "fundingRate", day);
    let oi = value("open_interest", "sumOpenInterest", day).filter(|v| *v > 0.);
    let prior_oi = as_of(
        history,
        "open_interest",
        origin - day,
        6 * ml_features::HOUR,
    )
    .map(|r| number(&r["sumOpenInterest"], f64::NAN))
    .filter(|v| v.is_finite() && *v > 0.);
    let oi_change = oi.zip(prior_oi).map(|(now, prior)| now / prior - 1.);
    let global = value("global_long_short", "longShortRatio", day);
    let account = value("top_account_long_short", "longShortRatio", day);
    let position = value("top_position_long_short", "longShortRatio", day);
    let taker = value("taker_long_short", "buySellRatio", day);
    let basis = value("basis", "basisRate", day);
    let premium = value("premium_index_1h", "close", 6 * ml_features::HOUR);
    let mark = as_of(history, "mark_price_1h", origin, 6 * ml_features::HOUR);
    let index = as_of(history, "index_price_1h", origin, 6 * ml_features::HOUR);
    let mark_basis = mark.zip(index).and_then(|(mark, index)| {
        let mark_open = timestamp(&mark["openTime"])?;
        let index_open = timestamp(&index["openTime"])?;
        if mark_open != index_open
            || mark["available_at_ms"].as_i64() != index["available_at_ms"].as_i64()
        {
            return None;
        }
        let mark_close = number(&mark["close"], f64::NAN);
        let index_close = number(&index["close"], f64::NAN);
        (mark_close.is_finite() && mark_close > 0. && index_close.is_finite() && index_close > 0.)
            .then(|| mark_close / index_close - 1.)
            .filter(|basis| basis.is_finite())
    });
    let values = [
        funding,
        oi.map(f64::ln_1p),
        oi_change,
        global,
        account,
        position,
        taker,
        basis,
        premium,
        mark_basis,
    ];
    values
        .iter()
        .map(|x| x.unwrap_or(0.))
        .chain(values.iter().map(|x| f64::from(x.is_some())))
        .collect()
}
pub fn market_features(
    rows: &[Value],
    end: usize,
    btc_rows: &[Value],
    eth_rows: &[Value],
) -> Vec<f64> {
    if end < 73 || end > rows.len() {
        return vec![0.; MARKET_FEATURE_NAMES.len()];
    }
    let Some(origin) = rows
        .get(end.wrapping_sub(1))
        .and_then(|r| timestamp(&r["openTime"]))
        .and_then(|t| t.checked_add(ml_features::HOUR))
    else {
        return vec![0.; MARKET_FEATURE_NAMES.len()];
    };
    let own = &rows[end - 73..end];
    let one = |reference: &[Value]| -> [f64; 5] {
        let boundary = reference.partition_point(|r| {
            timestamp(&r["openTime"]).is_some_and(|open| open + ml_features::HOUR <= origin)
        });
        if boundary < 73 {
            return [0.; 5];
        }
        let prefix = &reference[boundary - 73..boundary];
        if ml_features::validate_hourly(prefix).is_err()
            || timestamp(&prefix[72]["openTime"]) != Some(origin - ml_features::HOUR)
        {
            return [0.; 5];
        }
        let prices: Vec<f64> = prefix
            .iter()
            .map(|r| number(&r["close"], f64::NAN))
            .collect();
        let target: Vec<f64> = own.iter().map(|r| number(&r["close"], f64::NAN)).collect();
        let returns: Vec<f64> = prices.windows(2).map(|w| w[1] / w[0] - 1.).collect();
        let targets: Vec<f64> = target.windows(2).map(|w| w[1] / w[0] - 1.).collect();
        let mean = returns.iter().sum::<f64>() / 72.;
        let own_mean = targets.iter().sum::<f64>() / 72.;
        let covariance = returns
            .iter()
            .zip(&targets)
            .map(|(a, b)| (a - mean) * (b - own_mean))
            .sum::<f64>();
        let denom = (returns.iter().map(|x| (x - mean).powi(2)).sum::<f64>()
            * targets.iter().map(|x| (x - own_mean).powi(2)).sum::<f64>())
        .sqrt();
        let return24 = prices[72] / prices[48] - 1.;
        [
            return24,
            prices[72] / prices[0] - 1.,
            if denom > 0. { covariance / denom } else { 0. },
            target[72] / target[48] - 1. - return24,
            1.,
        ]
    };
    one(btc_rows).into_iter().chain(one(eth_rows)).collect()
}
pub fn calibrate_forecast(
    forecast: &ForecastRecord,
    calibration: &Calibration,
) -> Result<ForecastRecord> {
    calibration.validate()?;
    ml_features::chronos_features(forecast)?;
    let mut output = forecast.clone();
    for quantiles in [&mut output.q10, &mut output.q50, &mut output.q90] {
        for (hour, price) in quantiles.iter_mut().enumerate() {
            let change = (*price / forecast.current_price - 1.) * calibration.shrink
                + calibration.bias_by_hour[hour];
            *price = forecast.current_price * (1. + change);
            ensure!(
                price.is_finite() && *price > 0.,
                "Calibrated forecast is invalid"
            );
        }
    }
    Ok(output)
}
pub fn combined_features(
    rows: &[Value],
    end: usize,
    history: &Value,
    forecast: &ForecastRecord,
    calibration: &Calibration,
) -> Result<Vec<f64>> {
    combined_features_with_market(rows, end, history, forecast, calibration, &[], &[])
}
pub fn combined_features_with_market(
    rows: &[Value],
    end: usize,
    history: &Value,
    forecast: &ForecastRecord,
    calibration: &Calibration,
    btc_rows: &[Value],
    eth_rows: &[Value],
) -> Result<Vec<f64>> {
    let origin = timestamp(&rows[end - 1]["openTime"])
        .ok_or_else(|| anyhow::anyhow!("Missing candle timestamp"))?
        + ml_features::HOUR;
    ensure!(
        forecast.origin_ms == origin,
        "Forecast origin does not match closed history"
    );
    let mut output = extended_features(rows, end)?;
    output.extend(historical_features(history, origin));
    output.extend(market_features(rows, end, btc_rows, eth_rows));
    output.extend(ml_features::chronos_features(&calibrate_forecast(
        forecast,
        calibration,
    )?)?);
    ensure!(
        output.len() == feature_names().len() && output.iter().all(|x| x.is_finite()),
        "Invalid monthly feature vector"
    );
    Ok(output)
}
pub fn decide(probabilities: &[f64; 3], policy: &DecisionPolicy) -> &'static str {
    if policy.validate().is_err()
        || probabilities
            .iter()
            .any(|x| !x.is_finite() || !(0.0..=1.0).contains(x))
        || (probabilities.iter().sum::<f64>() - 1.).abs() > 1e-5
    {
        return "HOLD";
    }
    let mut ranked = [0, 1, 2];
    ranked.sort_by(|a, b| probabilities[*b].total_cmp(&probabilities[*a]));
    if ranked[0] == 1
        || probabilities[ranked[0]] < policy.probability_threshold
        || probabilities[ranked[0]] - probabilities[ranked[1]] < policy.probability_margin
    {
        "HOLD"
    } else if ranked[0] == 2 {
        "BUY"
    } else {
        "SELL"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn candles() -> Vec<Value> {
        (0..300).map(|hour| { let close=100.+hour as f64*0.01;
            json!({"openTime":hour*ml_features::HOUR,"open":close,"high":close+1.,"low":close-1.,"close":close,"volume":10.,"quoteVolume":10.*close,"tradeCount":20,"takerBuyVolume":6.,"confirmed":true})
        }).collect()
    }
    #[test]
    fn closed_microstructure_and_market_features_ignore_future_rows() {
        let rows = candles();
        let mut future = rows.clone();
        for row in &mut future[256..] {
            row["close"] = json!(999999.);
            row["takerBuyVolume"] = json!(0.);
        }
        assert_eq!(
            extended_features(&rows, 256).unwrap(),
            extended_features(&future, 256).unwrap()
        );
        let before = market_features(&rows, 256, &rows, &rows);
        assert_eq!(before, market_features(&rows, 256, &future, &future));
        assert_eq!(before[4], 1.);
        assert_eq!(before[9], 1.);
        assert_eq!(market_features(&rows, 256, &rows[..255], &[])[4], 0.);
    }
    #[test]
    fn availability_and_staleness_prevent_future_history_leakage() {
        let history = json!({"datasets":{"funding":[{"fundingRate":"0.001","available_at_ms":100*ml_features::HOUR},{"fundingRate":"0.9","available_at_ms":101*ml_features::HOUR}]}});
        let at = historical_features(&history, 100 * ml_features::HOUR);
        assert_eq!(at[0], 0.001);
        assert_eq!(at[10], 1.);
        assert_eq!(
            historical_features(&history, 200 * ml_features::HOUR)[10],
            0.
        );
        assert_eq!(
            historical_features(&history, 99 * ml_features::HOUR)[10],
            0.
        );
    }
    #[test]
    fn mark_index_basis_requires_aligned_observations_and_never_backfills_from_future() {
        let hour = ml_features::HOUR;
        let mut history = json!({"datasets":{
            "mark_price_1h":[{"openTime":100*hour,"available_at_ms":101*hour,"close":102.}],
            "index_price_1h":[{"openTime":100*hour,"available_at_ms":101*hour,"close":100.}]
        }});
        let original = historical_features(&history, 101 * hour);
        assert!((original[9] - 0.02).abs() < 1e-12);
        assert_eq!(original[19], 1.);
        history["datasets"]["index_price_1h"][0]["openTime"] = json!(99 * hour);
        assert_eq!(historical_features(&history, 101 * hour)[19], 0.);
        history["datasets"]["index_price_1h"][0]["openTime"] = json!(100 * hour);
        history["datasets"]["index_price_1h"][0]["available_at_ms"] = json!(100 * hour);
        assert_eq!(historical_features(&history, 101 * hour)[19], 0.);
        history["datasets"]["index_price_1h"][0]["available_at_ms"] = json!(101 * hour);
        history["datasets"]["index_price_1h"]
            .as_array_mut()
            .unwrap()
            .push(json!({"openTime":101*hour,"available_at_ms":102*hour,"close":50.}));
        assert_eq!(historical_features(&history, 101 * hour), original);
        let mismatched = historical_features(&history, 102 * hour);
        assert_eq!(mismatched[9], 0.);
        assert_eq!(mismatched[19], 0.);
        history["datasets"]["index_price_1h"][1]["openTime"] = json!(100 * hour);
        history["datasets"]["index_price_1h"][1]["available_at_ms"] = json!(101 * hour);
        history["datasets"]["index_price_1h"][1]["close"] = json!(0.);
        assert_eq!(historical_features(&history, 102 * hour)[19], 0.);
    }
    #[test]
    fn horizon_purge_applies_to_all_three_shared_splits() {
        let split = Split {
            start_ms: ml_features::HOUR,
            train_end_ms: 100 * ml_features::HOUR,
            validation_end_ms: 200 * ml_features::HOUR,
            test_end_ms: 300 * ml_features::HOUR,
            embargo_hours: 12,
        };
        assert_eq!(split.part(88 * ml_features::HOUR), Some("train"));
        assert_eq!(split.part(89 * ml_features::HOUR), None);
        assert_eq!(split.part(100 * ml_features::HOUR), Some("validation"));
        assert_eq!(split.part(199 * ml_features::HOUR), None);
        assert_eq!(split.part(200 * ml_features::HOUR), Some("test"));
    }
    #[test]
    fn calibration_preserves_quantile_order_and_requires_complete_bias() {
        let forecast = ForecastRecord {
            symbol: "BTCUSDT".into(),
            origin_ms: 256 * ml_features::HOUR,
            context_end_open_ms: 255 * ml_features::HOUR,
            history_sha256: None,
            current_price: 100.,
            interval: "1h".into(),
            horizon_hours: 12,
            q10: vec![98.; 12],
            q50: vec![100.; 12],
            q90: vec![103.; 12],
            quantile_crossings: 0,
            inference_ms: 0.,
        };
        let calibrated = calibrate_forecast(
            &forecast,
            &Calibration {
                bias_by_hour: vec![0.01; 12],
                shrink: 0.5,
            },
        )
        .unwrap();
        assert!(calibrated.q10[0] <= calibrated.q50[0] && calibrated.q50[0] <= calibrated.q90[0]);
        assert!((calibrated.q50[0] - 101.).abs() < 1e-8);
        assert!(
            calibrate_forecast(
                &forecast,
                &Calibration {
                    bias_by_hour: vec![],
                    shrink: 1.
                }
            )
            .is_err()
        );
    }
}
