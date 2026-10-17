//! Parameter search inputs for the frozen monthly classifier.
//!
//! This module only builds causal signals and delegates all accounting, fills,
//! exits and costs to `ml_replay`, which uses the production paper engine.
//! Its results remain one finite-capital account per symbol, not a portfolio.
use crate::{
    ml_features, ml_monthly,
    ml_replay::{self, ReplayConfig, ReplaySignal},
    number, strategies, timestamp,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const HOUR: i64 = ml_features::HOUR;
const SETTLEMENT_TAIL_HOURS: i64 = 36;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbabilityPoint {
    pub origin_ms: i64,
    /// Class order is SELL, HOLD, BUY, as in the monthly LightGBM model.
    pub probabilities: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolData {
    pub symbol: String,
    pub rows: Vec<Value>,
    pub predictions: Vec<ProbabilityPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StrategyParameters {
    pub probability_threshold: f64,
    pub probability_margin: f64,
    pub stop_atr: f64,
    pub target_atr: f64,
    pub max_hold_bars: usize,
}

impl Default for StrategyParameters {
    fn default() -> Self {
        Self {
            probability_threshold: 0.45,
            probability_margin: 0.05,
            stop_atr: 2.,
            target_atr: 5.,
            max_hold_bars: 11,
        }
    }
}

impl StrategyParameters {
    fn validate(&self) -> Result<()> {
        self.decision_policy().validate()?;
        ensure!(
            self.stop_atr.is_finite() && (0.5..=10.).contains(&self.stop_atr),
            "Stop ATR must be finite and between 0.5 and 10"
        );
        ensure!(
            self.target_atr.is_finite() && (0.5..=20.).contains(&self.target_atr),
            "Target ATR must be finite and between 0.5 and 20"
        );
        // One-hour delayed entry plus at most eleven held bars remains inside
        // the classifier's twelve-hour forecast and the common settlement tail.
        ensure!(
            (1..ml_features::HORIZON).contains(&self.max_hold_bars),
            "Holding period must be 1..11 closed hourly bars"
        );
        Ok(())
    }

    fn decision_policy(&self) -> ml_monthly::DecisionPolicy {
        ml_monthly::DecisionPolicy {
            probability_threshold: self.probability_threshold,
            probability_margin: self.probability_margin,
        }
    }
}

/// Fixed, reproducible coarse search; risk budgets and leverage are not searched.
pub fn candidate_grid() -> Vec<StrategyParameters> {
    let mut candidates = Vec::with_capacity(48);
    for probability_threshold in [0.45, 0.55, 0.65] {
        for probability_margin in [0.05, 0.10] {
            for stop_atr in [1.5, 2.] {
                for target_atr in [4., 5.] {
                    for max_hold_bars in [5, 11] {
                        candidates.push(StrategyParameters {
                            probability_threshold,
                            probability_margin,
                            stop_atr,
                            target_atr,
                            max_hold_bars,
                        });
                    }
                }
            }
        }
    }
    candidates
}

fn validate_probability(point: &ProbabilityPoint) -> Result<()> {
    ensure!(
        point.origin_ms > 0 && point.origin_ms.rem_euclid(HOUR) == 0,
        "Prediction origin must be a positive closed hourly boundary"
    );
    ensure!(
        point
            .probabilities
            .iter()
            .all(|p| p.is_finite() && (0.0..=1.0).contains(p))
            && (point.probabilities.iter().sum::<f64>() - 1.).abs() <= 1e-5,
        "Invalid SELL/HOLD/BUY probability distribution"
    );
    Ok(())
}

/// The caller supplies an already truncated prefix: future candles are never
/// reachable while calculating ATR, protection prices or the classification.
fn build_signal(
    symbol: &str,
    closed_prefix: &[Value],
    point: &ProbabilityPoint,
    parameters: &StrategyParameters,
    end_ms: i64,
    exits: &Value,
) -> Result<ReplaySignal> {
    let last = closed_prefix.last().context("Missing closed prefix")?;
    let last_close = timestamp(&last["openTime"])
        .context("Invalid closed-prefix timestamp")?
        .checked_add(HOUR)
        .context("Closed-prefix timestamp overflow")?;
    ensure!(
        last_close == point.origin_ms,
        "Prediction origin must equal its latest closed candle boundary"
    );
    let matured = point
        .origin_ms
        .checked_add(ml_features::HORIZON as i64 * HOUR)
        .is_some_and(|maturity| maturity <= end_ms);
    let settlement_tail = point.origin_ms >= end_ms - SETTLEMENT_TAIL_HOURS * HOUR;
    let raw_decision = ml_monthly::decide(&point.probabilities, &parameters.decision_policy());
    let decision = if settlement_tail || !matured {
        "HOLD"
    } else {
        raw_decision
    };
    let mut signal = ReplaySignal {
        origin_ms: point.origin_ms,
        decision: decision.into(),
        probabilities: ml_features::probabilities_json(&point.probabilities),
        metadata: json!({
            "variant":"monthly_parameter_search",
            "parameters":parameters,
            "raw_model_decision":raw_decision,
            "label_matured_within_window":matured,
            "settlement_tail":settlement_tail,
            "settlement_tail_hours":SETTLEMENT_TAIL_HOURS
        }),
        plan: None,
    };
    if decision == "HOLD" {
        return Ok(signal);
    }
    ensure!(closed_prefix.len() >= 15, "ATR needs 15 closed candles");
    let atr = strategies::atr(closed_prefix, 14);
    let price = number(&last["close"], f64::NAN);
    ensure!(atr.is_finite() && atr > 0., "Invalid closed-prefix ATR");
    ensure!(
        price.is_finite() && price > 0.,
        "Invalid closed-prefix price"
    );
    let direction = if decision == "BUY" { 1. } else { -1. };
    let mut plan = json!({
        "entryStyle":"market",
        "entryMin":price - 0.5 * atr,
        "entryMax":price + 0.5 * atr,
        "stopLoss":price - direction * parameters.stop_atr * atr,
        "takeProfit":price + direction * parameters.target_atr * atr,
        "riskUnit":parameters.stop_atr * atr,
        "maxHoldBars":parameters.max_hold_bars
    });
    plan["exitRules"] = exits.clone();
    signal.plan = Some(plan);
    let normalized = ml_replay::normalize_signal(symbol, closed_prefix, &signal)?;
    if normalized["plan"].is_object() {
        signal.plan = Some(normalized["plan"].clone());
    }
    // Invalid candidate plans stay explicit, allowing the shared replay to log
    // its normal invalid_plan rejection; None would replace them with defaults.
    Ok(signal)
}

/// Evaluate only the explicit window, with one common no-new-entry settlement
/// tail. All predictions (including those outside the window) are validated so
/// a malformed cache cannot silently alter which candidates are compared.
pub fn evaluate(
    source: &SymbolData,
    parameters: &StrategyParameters,
    config: &ReplayConfig,
) -> Result<Value> {
    evaluate_with_exits(
        source,
        parameters,
        config,
        &strategies::ml_horizon_exit_rules(),
    )
}

/// Same frozen signals and shared engine as [`evaluate`], with an explicit
/// exit-rule snapshot so a caller can compare the previous 0-bar MA exit.
pub fn evaluate_with_exits(
    source: &SymbolData,
    parameters: &StrategyParameters,
    config: &ReplayConfig,
    exits: &Value,
) -> Result<Value> {
    parameters.validate()?;
    ensure!(
        config.start_ms > 0
            && config.end_ms != i64::MAX
            && config.start_ms < config.end_ms
            && config.start_ms.rem_euclid(HOUR) == 0
            && config.end_ms.rem_euclid(HOUR) == 0,
        "Optimization requires explicit, increasing, hour-aligned start_ms/end_ms"
    );
    let defaults = ReplayConfig::default();
    for (name, value, ceiling) in [
        (
            "risk_fraction",
            config.risk_fraction,
            defaults.risk_fraction,
        ),
        (
            "max_notional_fraction",
            config.max_notional_fraction,
            defaults.max_notional_fraction,
        ),
        (
            "max_notional_usdt",
            config.max_notional_usdt,
            defaults.max_notional_usdt,
        ),
        (
            "daily_loss_fraction",
            config.daily_loss_fraction,
            defaults.daily_loss_fraction,
        ),
        (
            "max_drawdown_fraction",
            config.max_drawdown_fraction,
            defaults.max_drawdown_fraction,
        ),
    ] {
        ensure!(
            value.is_finite() && value > 0. && value <= ceiling,
            "{name} must preserve or tighten the existing risk limit"
        );
    }
    let mut closes = Vec::with_capacity(source.rows.len());
    for row in &source.rows {
        let close = timestamp(&row["openTime"])
            .context("Invalid source candle timestamp")?
            .checked_add(HOUR)
            .context("Source candle timestamp overflow")?;
        ensure!(close.rem_euclid(HOUR) == 0, "Unaligned source candle");
        if let Some(previous) = closes.last() {
            ensure!(
                close == previous + HOUR,
                "Source candles must be continuous"
            );
        }
        closes.push(close);
    }
    let mut previous_origin = None;
    let mut signals = Vec::new();
    for point in &source.predictions {
        validate_probability(point)?;
        if let Some(previous) = previous_origin {
            ensure!(
                point.origin_ms > previous,
                "Predictions must have strictly increasing, unique origins"
            );
        }
        previous_origin = Some(point.origin_ms);
        let index = closes
            .binary_search(&point.origin_ms)
            .map_err(|_| anyhow::anyhow!("Prediction origin lacks its closed candle prefix"))?;
        if point.origin_ms < config.start_ms || point.origin_ms > config.end_ms {
            continue;
        }
        signals.push(build_signal(
            &source.symbol,
            &source.rows[..=index],
            point,
            parameters,
            config.end_ms,
            exits,
        )?);
    }
    let mut result = ml_replay::replay(&source.symbol, &source.rows, &signals, config)?;
    result["effective_parameters"] = serde_json::to_value(parameters)?;
    // ml_replay labels its baseline protection fields as default_*. Preserve
    // those reference labels and state the actual candidate explicitly rather
    // than implying that every candidate used 2/5 ATR and eleven held bars.
    result["risk_policy"]["default_protection_fields_are_reference"] = json!(true);
    result["risk_policy"]["effective_stop_atr"] = json!(parameters.stop_atr);
    result["risk_policy"]["effective_target_atr"] = json!(parameters.target_atr);
    result["risk_policy"]["effective_held_bars"] = json!(parameters.max_hold_bars);
    result["execution_scope"] = json!({
        "fills":"shared_production_paper_simulator",
        "demo_entry_timing_reproduced":false,
        "paper_first_entry_delay_hours":1,
        "paper_pending_ttl_hours":24,
        "demo_first_send_max_signal_age_hours":2,
        "notice":"Demo routes an eligible market or limit order immediately; this replay retains the shared paper engine's delayed entry and pending expiry."
    });
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (SymbolData, ReplayConfig) {
        let rows = (0..96)
            .map(|i| {
                json!({"openTime":i * HOUR,"open":100.,"high":101.,"low":99.,
                    "close":100.,"volume":100.,"confirmed":true})
            })
            .collect();
        (
            SymbolData {
                symbol: "BTCUSDT".into(),
                rows,
                predictions: vec![ProbabilityPoint {
                    origin_ms: 24 * HOUR,
                    probabilities: [0.05, 0.05, 0.90],
                }],
            },
            ReplayConfig {
                start_ms: 24 * HOUR,
                end_ms: 96 * HOUR,
                ..Default::default()
            },
        )
    }

    #[test]
    fn grid_has_48_unique_candidates_and_the_deployed_default() {
        let candidates = candidate_grid();
        assert_eq!(candidates.len(), 48);
        assert!(candidates.contains(&StrategyParameters::default()));
        for (index, candidate) in candidates.iter().enumerate() {
            candidate.validate().unwrap();
            assert!(!candidates[..index].contains(candidate));
        }
    }

    #[test]
    fn malformed_parameters_probabilities_origins_and_risk_limits_are_rejected() {
        let (source, config) = fixture();
        let mut parameters = StrategyParameters::default();
        parameters.stop_atr = f64::NAN;
        assert!(evaluate(&source, &parameters, &config).is_err());
        parameters = StrategyParameters::default();
        parameters.max_hold_bars = 12;
        assert!(evaluate(&source, &parameters, &config).is_err());
        parameters = StrategyParameters::default();
        parameters.probability_margin = -0.01;
        assert!(evaluate(&source, &parameters, &config).is_err());
        let mut malformed = source.clone();
        malformed.predictions[0].probabilities = [0.1, 0.1, 0.9];
        assert!(evaluate(&malformed, &StrategyParameters::default(), &config).is_err());
        malformed = source.clone();
        malformed.predictions.push(malformed.predictions[0].clone());
        assert!(evaluate(&malformed, &StrategyParameters::default(), &config).is_err());
        malformed = source.clone();
        malformed.predictions[0].origin_ms += 1;
        assert!(evaluate(&malformed, &StrategyParameters::default(), &config).is_err());
        let mut enlarged_risk = config.clone();
        enlarged_risk.max_notional_usdt = 100.;
        assert!(evaluate(&source, &StrategyParameters::default(), &enlarged_risk).is_err());
        assert!(
            evaluate(
                &source,
                &StrategyParameters::default(),
                &ReplayConfig::default()
            )
            .is_err()
        );
    }

    #[test]
    fn future_candles_cannot_change_the_origin_protection_plan() {
        let (source, config) = fixture();
        let parameters = StrategyParameters::default();
        let original = evaluate(&source, &parameters, &config).unwrap();
        let mut changed = source.clone();
        for row in &mut changed.rows[24..] {
            row["high"] = json!(200.);
            row["low"] = json!(50.);
        }
        let alternate = evaluate(&changed, &parameters, &config).unwrap();
        let first = &original["signal_log"][0]["normalized_signal"];
        let second = &alternate["signal_log"][0]["normalized_signal"];
        assert!(first["plan"].is_object());
        assert_eq!(first["plan"], second["plan"]);
        assert_eq!(first["riskAtr"], second["riskAtr"]);
        assert_eq!(first["plan"]["stopLoss"], 96.);
        assert_eq!(first["plan"]["takeProfit"], 110.);
        assert!(first["plan"]["exitRules"]["partialTp"].is_object());
        assert!(
            build_signal(
                &source.symbol,
                &source.rows,
                &source.predictions[0],
                &parameters,
                config.end_ms,
                &strategies::ml_horizon_exit_rules(),
            )
            .is_err()
        );
    }

    #[test]
    fn stop_and_target_candidates_use_the_shared_production_fills_and_costs() {
        let (mut source, config) = fixture();
        source.rows[26]["low"] = json!(96.5);
        source.rows[27]["high"] = json!(112.);
        source.rows[27]["close"] = json!(111.);
        let tighter = StrategyParameters {
            stop_atr: 1.5,
            target_atr: 4.,
            ..Default::default()
        };
        let wider = StrategyParameters::default();
        let stopped = evaluate(&source, &tighter, &config).unwrap();
        let survived = evaluate(&source, &wider, &config).unwrap();
        assert_eq!(stopped["effective_parameters"], json!(tighter));
        assert_eq!(stopped["risk_policy"]["default_stop_atr"], 2);
        assert_eq!(stopped["risk_policy"]["effective_stop_atr"], 1.5);
        assert_eq!(stopped["risk_policy"]["effective_target_atr"], 4.);
        assert_eq!(stopped["risk_policy"]["effective_held_bars"], 11);
        assert_eq!(
            stopped["execution_scope"]["demo_entry_timing_reproduced"],
            false
        );
        for result in [&stopped, &survived] {
            assert_eq!(result["metrics"]["submitted_orders"], 1);
            assert_eq!(result["metrics"]["closed_trades"], 1);
            assert_eq!(result["metrics"]["comparison_complete"], true);
            assert_eq!(timestamp(&result["orders"][0]["entryAt"]), Some(25 * HOUR));
            assert!(number(&result["metrics"]["fees_usdt"], 0.) > 0.);
            assert_eq!(result["metrics"]["slippage_deducted_again"], false);
        }
        assert!(number(&stopped["metrics"]["net_pnl_usdt"], 0.) < 0.);
        assert!(
            number(&survived["metrics"]["net_pnl_usdt"], 0.)
                > number(&stopped["metrics"]["net_pnl_usdt"], 0.)
        );
        assert_ne!(
            stopped["orders"][0]["initialPlan"],
            survived["orders"][0]["initialPlan"]
        );
    }

    #[test]
    fn common_settlement_tail_prevents_new_entries_even_with_high_probability() {
        let (mut source, config) = fixture();
        source.predictions = [59, 60, 90]
            .into_iter()
            .map(|hour| ProbabilityPoint {
                origin_ms: hour * HOUR,
                probabilities: [0.05, 0.05, 0.90],
            })
            .collect();
        let result = evaluate(&source, &StrategyParameters::default(), &config).unwrap();
        assert_eq!(result["signal_log"][0]["decision"], "BUY");
        assert_eq!(result["signal_log"][1]["decision"], "HOLD");
        assert_eq!(result["signal_log"][2]["decision"], "HOLD");
        assert_eq!(result["signal_log"][1]["metadata"]["settlement_tail"], true);
        assert_eq!(
            result["signal_log"][2]["metadata"]["label_matured_within_window"],
            false
        );
        assert_eq!(result["metrics"]["comparison_complete"], true);
    }

    #[test]
    fn horizon_exits_hold_through_an_in_stop_ma_break_that_legacy_rules_cut() {
        let (mut source, config) = fixture();
        for row in &mut source.rows[25..] {
            row["open"] = json!(100.);
            row["high"] = json!(100.);
            row["low"] = json!(97.);
            row["close"] = json!(97.5);
        }
        let parameters = StrategyParameters::default();
        let legacy = evaluate_with_exits(
            &source,
            &parameters,
            &config,
            &strategies::exit_rules_for(&json!({})),
        )
        .unwrap();
        let horizon = evaluate(&source, &parameters, &config).unwrap();
        assert_eq!(legacy["orders"][0]["reason"], "smart_exit_ma");
        assert_eq!(horizon["orders"][0]["reason"], "timeout");
        assert_eq!(
            horizon["orders"][0]["plan"]["exitRules"],
            strategies::ml_horizon_exit_rules()
        );
        assert_ne!(legacy["orders"][0]["net"], horizon["orders"][0]["net"]);
    }
}
