//! Causal, execution-aware labels for the existing hourly paper replay.
//!
//! Features and protection levels stop at `origin_ms`. Each counterfactual
//! direction then gets its own finite-capital account in the shared Rust replay;
//! this module never calculates a fill, trading cost or PnL itself. Labels are
//! deliberately withheld until the complete observation window is available,
//! even when an order exits early. This is a paper execution label: Demo market
//! order scheduling is different and is not claimed to be reproduced here.
use crate::{
    ml_replay::{self, ReplayConfig, ReplaySignal},
    number, simulator, strategies, timestamp,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const HOUR: i64 = 3_600_000;
pub const LABEL_SCHEMA_VERSION: u32 = 1;
pub const LABEL_CLASSES: [&str; 3] = ["SELL", "HOLD", "BUY"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TradeLabelConfig {
    /// Includes the shared 24h pending TTL, 11 held bars and entry delay.
    /// Forty-eight hours is the default; values below 36h are rejected.
    pub observation_hours: usize,
    /// A direction must make strictly more than this positive, net USDT edge.
    pub min_net_edge_usdt: f64,
    /// A positive winner must also exceed the other direction by this amount.
    /// Exact ties always become HOLD, including when this is zero.
    pub min_advantage_usdt: f64,
    /// Only capital/risk fields are used; the label owns its explicit window.
    pub replay: ReplayConfig,
}

impl Default for TradeLabelConfig {
    fn default() -> Self {
        Self {
            observation_hours: 48,
            min_net_edge_usdt: 0.05,
            min_advantage_usdt: 0.,
            replay: ReplayConfig::default(),
        }
    }
}

impl TradeLabelConfig {
    fn validate(&self) -> Result<()> {
        ensure!(
            (36..=168).contains(&self.observation_hours),
            "Trade label observation must be between 36 and 168 hours"
        );
        ensure!(
            self.min_net_edge_usdt.is_finite() && self.min_net_edge_usdt > 0.,
            "Trade label net edge must be finite and strictly positive"
        );
        ensure!(
            self.min_advantage_usdt.is_finite() && self.min_advantage_usdt >= 0.,
            "Trade label advantage must be finite and nonnegative"
        );
        ensure!(
            self.replay.starting_equity.is_finite() && self.replay.starting_equity > 0.,
            "Trade label starting equity must be finite and positive"
        );
        ensure!(
            self.replay.allow_buy && self.replay.allow_sell,
            "Trade labels require both counterfactual directions"
        );
        let defaults = ReplayConfig::default();
        for (name, value, ceiling) in [
            (
                "risk_fraction",
                self.replay.risk_fraction,
                defaults.risk_fraction,
            ),
            (
                "max_notional_fraction",
                self.replay.max_notional_fraction,
                defaults.max_notional_fraction,
            ),
            (
                "max_notional_usdt",
                self.replay.max_notional_usdt,
                defaults.max_notional_usdt,
            ),
            (
                "daily_loss_fraction",
                self.replay.daily_loss_fraction,
                defaults.daily_loss_fraction,
            ),
            (
                "max_drawdown_fraction",
                self.replay.max_drawdown_fraction,
                defaults.max_drawdown_fraction,
            ),
        ] {
            ensure!(
                value.is_finite() && value > 0. && value <= ceiling,
                "{name} must preserve or tighten the existing label risk limit"
            );
        }
        Ok(())
    }
}

/// All economic amounts come verbatim from the shared replay result. `settled`
/// means a terminal order, including an unfilled expiry; training additionally
/// requires `entered` and a closed trade in BOTH directions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectionOutcome {
    pub decision: String,
    pub submitted: bool,
    pub entered: bool,
    pub settled: bool,
    pub status: String,
    pub reason: Option<String>,
    pub net_usdt: Option<f64>,
    pub gross_usdt: Option<f64>,
    pub fees_usdt: Option<f64>,
    pub funding_usdt: Option<f64>,
    pub slippage_usdt: Option<f64>,
    pub entry_at_ms: Option<i64>,
    pub exit_at_ms: Option<i64>,
    pub resolved_at_ms: Option<i64>,
    pub mature_by_ms: i64,
    pub exclusion_reason: Option<String>,
    pub plan: Value,
}

impl DirectionOutcome {
    fn excluded(decision: &str, mature_by_ms: i64, reason: &str) -> Self {
        Self {
            decision: decision.into(),
            submitted: false,
            entered: false,
            settled: false,
            status: "not_evaluated".into(),
            reason: None,
            net_usdt: None,
            gross_usdt: None,
            fees_usdt: None,
            funding_usdt: None,
            slippage_usdt: None,
            entry_at_ms: None,
            exit_at_ms: None,
            resolved_at_ms: None,
            mature_by_ms,
            exclusion_reason: Some(reason.into()),
            plan: Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeLabel {
    pub schema_version: u32,
    pub symbol: String,
    pub execution_scope: String,
    pub origin_ms: i64,
    pub feature_cutoff_ms: i64,
    /// Conservative purge boundary, never shortened by an early exit.
    pub mature_by_ms: i64,
    /// Latest supplied, closed candle used by the label, capped by its deadline.
    pub label_observed_through_ms: i64,
    pub eligible: bool,
    /// Same ordering as the existing LightGBM model: SELL=0, HOLD=1, BUY=2.
    /// Missing or immature outcomes have None, never a synthetic HOLD target.
    pub class_index: Option<usize>,
    pub decision: Option<String>,
    pub exclusion_reason: Option<String>,
    pub config: TradeLabelConfig,
    pub long: DirectionOutcome,
    pub short: DirectionOutcome,
}

fn finite(value: &Value) -> Option<f64> {
    let value = number(value, f64::NAN);
    value.is_finite().then_some(value)
}

fn frozen_signal(
    symbol: &str,
    closed_prefix: &[Value],
    origin_ms: i64,
    decision: &str,
) -> Result<ReplaySignal> {
    let price = number(
        &closed_prefix.last().context("Missing label prefix")?["close"],
        f64::NAN,
    );
    let atr = strategies::atr(closed_prefix, 14);
    ensure!(
        price.is_finite() && price > 0.,
        "Invalid label prefix price"
    );
    ensure!(atr.is_finite() && atr > 0., "Invalid label prefix ATR");
    let direction = if decision == "BUY" { 1. } else { -1. };
    let mut plan = json!({
        "entryStyle":"market", "entryMin":price-0.5*atr, "entryMax":price+0.5*atr,
        "stopLoss":price-direction*2.*atr, "takeProfit":price+direction*5.*atr,
        "riskUnit":2.*atr, "maxHoldBars":11
    });
    plan["exitRules"] = strategies::exit_rules_for(&plan);
    let mut signal = ReplaySignal {
        origin_ms,
        decision: decision.into(),
        probabilities: if decision == "BUY" {
            json!({"SELL":0.,"HOLD":0.,"BUY":1.})
        } else {
            json!({"SELL":1.,"HOLD":0.,"BUY":0.})
        },
        metadata: json!({"variant":"paper_trade_outcome_label", "schema_version":LABEL_SCHEMA_VERSION,
            "feature_cutoff_ms":origin_ms, "counterfactual_direction":decision,
            "stop_atr":2, "target_atr":5, "max_hold_bars":11}),
        plan: Some(plan),
    };
    let normalized = ml_replay::normalize_signal(symbol, closed_prefix, &signal)?;
    if normalized["plan"].is_object() {
        signal.plan = Some(normalized["plan"].clone());
    }
    Ok(signal)
}

fn direction_outcome(
    symbol: &str,
    rows: &[Value],
    signal: &ReplaySignal,
    config: &ReplayConfig,
    mature_by_ms: i64,
) -> Result<DirectionOutcome> {
    let replay = ml_replay::replay(symbol, rows, std::slice::from_ref(signal), config)?;
    let orders = replay["orders"]
        .as_array()
        .context("Missing shared replay orders")?;
    ensure!(
        orders.len() <= 1,
        "A counterfactual label created multiple orders"
    );
    let Some(order) = orders.first() else {
        let rejection = replay["signal_log"][0]["outcome"]
            .as_str()
            .unwrap_or("not_submitted");
        let mut outcome = DirectionOutcome::excluded(&signal.decision, mature_by_ms, rejection);
        outcome.status = rejection.into();
        outcome.plan = signal.plan.clone().unwrap_or(Value::Null);
        return Ok(outcome);
    };
    let status = order["status"]
        .as_str()
        .context("Missing shared order status")?;
    let entered = number(&order["entry"], 0.) > 0.;
    let closed = status == "closed";
    let settled = closed || status == "expired";
    let exit_at_ms = timestamp(&order["exitAt"]);
    let resolved_at_ms = if closed {
        exit_at_ms
    } else if status == "expired" {
        timestamp(&order["expiredAt"]).or_else(|| timestamp(&order["expiresAt"]))
    } else {
        None
    };
    ensure!(
        !closed || (entered && exit_at_ms.is_some()),
        "Closed shared order lacks an entry or exit timestamp"
    );
    let net_usdt = if closed { finite(&order["net"]) } else { None };
    ensure!(
        !closed || net_usdt.is_some(),
        "Closed shared order has non-finite net PnL"
    );
    let exclusion_reason = if !entered {
        Some(
            if settled {
                "not_entered"
            } else {
                "entry_unresolved"
            }
            .into(),
        )
    } else if !closed {
        Some("exit_unresolved".into())
    } else {
        None
    };
    Ok(DirectionOutcome {
        decision: signal.decision.clone(),
        submitted: true,
        entered,
        settled,
        status: status.into(),
        reason: order["reason"].as_str().map(str::to_owned),
        net_usdt,
        gross_usdt: closed.then(|| finite(&order["gross"])).flatten(),
        fees_usdt: finite(&order["incurred_costs"]["fees_usdt"]),
        funding_usdt: finite(&order["incurred_costs"]["funding_usdt"]),
        slippage_usdt: finite(&order["incurred_costs"]["slippage_usdt"]),
        entry_at_ms: timestamp(&order["entryAt"]),
        exit_at_ms,
        resolved_at_ms,
        mature_by_ms,
        exclusion_reason,
        plan: signal.plan.clone().unwrap_or(Value::Null),
    })
}

/// Produce a training target from two independent executions at a causal origin.
///
/// `observed_through_ms` must be an hourly closed boundary. Rows after it or after
/// the observation deadline are not even validated or passed to the simulator.
/// An incomplete window, unfilled order, invalid plan or unresolved position is
/// an excluded sample with `class_index=None`. HOLD is reserved for two complete,
/// filled executions that fail the configured positive net edge/advantage.
pub fn label_origin(
    symbol: &str,
    rows: &[Value],
    origin_ms: i64,
    observed_through_ms: i64,
    config: &TradeLabelConfig,
) -> Result<TradeLabel> {
    config.validate()?;
    crate::exchange::valid_symbol(symbol)?;
    ensure!(
        origin_ms.rem_euclid(HOUR) == 0 && observed_through_ms.rem_euclid(HOUR) == 0,
        "Trade label origin and observed-through boundaries must be hourly aligned"
    );
    ensure!(
        observed_through_ms >= origin_ms,
        "Label observation precedes its origin"
    );
    let mature_by_ms = origin_ms
        .checked_add(config.observation_hours as i64 * HOUR)
        .context("Label observation timestamp overflow")?;
    let upper = observed_through_ms.min(mature_by_ms);
    let mut used_end = 0;
    let mut origin_end = None;
    let mut previous_close = None;
    let mut actual_end = None;
    for row in rows {
        let close = timestamp(&row["openTime"])
            .context("Invalid label candle openTime")?
            .checked_add(HOUR)
            .context("Label candle timestamp overflow")?;
        if close > upper {
            break;
        }
        ensure!(simulator::valid_candle(row), "Invalid label candle");
        ensure!(close.rem_euclid(HOUR) == 0, "Unaligned label candle");
        if let Some(previous) = previous_close {
            ensure!(
                close == previous + HOUR,
                "Missing or duplicate label candle"
            );
        }
        previous_close = Some(close);
        used_end += 1;
        actual_end = Some(close);
        if close == origin_ms {
            origin_end = Some(used_end);
        }
        if close == upper {
            break;
        }
    }
    let origin_end = origin_end.context("Trade label origin lacks its closed candle")?;
    let actual_end = actual_end.context("Trade label needs closed candles")?;
    let mut label = TradeLabel {
        schema_version: LABEL_SCHEMA_VERSION,
        symbol: symbol.into(),
        execution_scope:
            "paper_hourly_replay; independent counterfactual accounts; not Demo execution parity"
                .into(),
        origin_ms,
        feature_cutoff_ms: origin_ms,
        mature_by_ms,
        label_observed_through_ms: actual_end,
        eligible: false,
        class_index: None,
        decision: None,
        exclusion_reason: None,
        config: config.clone(),
        long: DirectionOutcome::excluded("BUY", mature_by_ms, "insufficient_closed_context"),
        short: DirectionOutcome::excluded("SELL", mature_by_ms, "insufficient_closed_context"),
    };
    if origin_end < 15 {
        label.exclusion_reason = Some("insufficient_closed_context".into());
        return Ok(label);
    }
    let closed_prefix = &rows[..origin_end];
    let atr = strategies::atr(closed_prefix, 14);
    if !atr.is_finite() || atr <= 0. {
        label.exclusion_reason = Some("invalid_closed_prefix_atr".into());
        label.long = DirectionOutcome::excluded("BUY", mature_by_ms, "invalid_closed_prefix_atr");
        label.short = DirectionOutcome::excluded("SELL", mature_by_ms, "invalid_closed_prefix_atr");
        return Ok(label);
    }
    let replay_config = ReplayConfig {
        start_ms: origin_ms,
        end_ms: actual_end,
        ..config.replay.clone()
    };
    let long = frozen_signal(symbol, closed_prefix, origin_ms, "BUY")?;
    let short = frozen_signal(symbol, closed_prefix, origin_ms, "SELL")?;
    label.long = direction_outcome(
        symbol,
        &rows[..used_end],
        &long,
        &replay_config,
        mature_by_ms,
    )?;
    label.short = direction_outcome(
        symbol,
        &rows[..used_end],
        &short,
        &replay_config,
        mature_by_ms,
    )?;
    if actual_end < mature_by_ms {
        label.exclusion_reason = Some("observation_incomplete".into());
        return Ok(label);
    }
    if label.long.exclusion_reason.is_some() || label.short.exclusion_reason.is_some() {
        label.exclusion_reason = Some("both_directions_must_enter_and_settle".into());
        return Ok(label);
    }
    let long_net = label.long.net_usdt.context("Missing settled long net")?;
    let short_net = label.short.net_usdt.context("Missing settled short net")?;
    let class_index = if long_net > config.min_net_edge_usdt
        && long_net - short_net > config.min_advantage_usdt
    {
        2
    } else if short_net > config.min_net_edge_usdt
        && short_net - long_net > config.min_advantage_usdt
    {
        0
    } else {
        1
    };
    label.eligible = true;
    label.class_index = Some(class_index);
    label.decision = Some(LABEL_CLASSES[class_index].into());
    Ok(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(count: usize) -> Vec<Value> {
        (0..count)
            .map(|i| {
                json!({"openTime":i as i64*HOUR,"open":100.,"high":101.,
                "low":99.,"close":100.,"volume":1.,"confirmed":true})
            })
            .collect()
    }

    fn label(rows: &[Value]) -> TradeLabel {
        label_origin(
            "BTCUSDT",
            rows,
            24 * HOUR,
            72 * HOUR,
            &TradeLabelConfig::default(),
        )
        .unwrap()
    }

    #[test]
    fn flat_price_round_trips_are_hold_after_shared_costs() {
        let result = label(&candles(72));
        assert!(result.eligible);
        assert_eq!(result.class_index, Some(1));
        assert_eq!(result.mature_by_ms, 72 * HOUR);
        for direction in [&result.long, &result.short] {
            assert!(direction.entered && direction.settled);
            assert!(direction.net_usdt.unwrap() < 0.);
            assert!(direction.fees_usdt.unwrap() > 0.);
            assert!(direction.funding_usdt.unwrap() > 0.);
            assert!(direction.slippage_usdt.unwrap() > 0.);
            // The shared net already includes slippage in its fill prices.
            assert!(
                (direction.gross_usdt.unwrap()
                    - direction.fees_usdt.unwrap()
                    - direction.funding_usdt.unwrap()
                    - direction.net_usdt.unwrap())
                .abs()
                    < 1e-9
            );
        }
    }

    #[test]
    fn small_positive_gross_return_is_hold_when_shared_fees_consume_it() {
        let mut rows = candles(72);
        for row in &mut rows[24..] {
            row["high"] = json!(100.25);
            row["low"] = json!(99.9);
            row["close"] = json!(100.15);
        }
        let result = label(&rows);
        assert!(result.eligible);
        assert!(result.long.gross_usdt.unwrap() > 0.);
        assert!(result.long.net_usdt.unwrap() < 0.);
        assert_eq!(result.class_index, Some(1));
    }

    #[test]
    fn shared_intrabar_stop_precedes_target_and_later_recovery_cannot_relabel_loss() {
        let mut target_first = candles(72);
        target_first[25] = json!({"openTime":25*HOUR,"open":100.,"high":111.,
            "low":99.,"close":110.,"volume":1.,"confirmed":true});
        let winning = label(&target_first);
        assert_eq!(winning.class_index, Some(2));
        assert!(winning.long.net_usdt.unwrap() > 0.);

        let mut both_touched = target_first.clone();
        both_touched[25]["low"] = json!(95.);
        let ambiguous = label(&both_touched);
        assert!(ambiguous.long.net_usdt.unwrap() < 0.);
        assert!(ambiguous.long.reason.as_deref().unwrap().contains("stop"));

        let mut stop_first = candles(72);
        stop_first[25] = json!({"openTime":25*HOUR,"open":100.,"high":101.,
            "low":95.,"close":96.,"volume":1.,"confirmed":true});
        stop_first[26] = target_first[25].clone();
        stop_first[26]["openTime"] = json!(26 * HOUR);
        let losing = label(&stop_first);
        assert!(losing.long.net_usdt.unwrap() < 0.);
        assert!(losing.long.exit_at_ms.unwrap() < winning.mature_by_ms);
        assert_eq!(losing.mature_by_ms, 72 * HOUR);
    }

    #[test]
    fn unfilled_expiry_is_excluded_instead_of_synthetic_hold() {
        let mut rows = candles(72);
        for row in &mut rows[24..] {
            row["open"] = json!(120.);
            row["high"] = json!(121.);
            row["low"] = json!(119.);
            row["close"] = json!(120.);
        }
        let result = label(&rows);
        assert!(!result.eligible);
        assert_eq!(result.class_index, None);
        assert_eq!(result.long.status, "expired");
        assert_eq!(result.short.status, "expired");
        assert!(!result.long.entered && result.long.settled);
        assert_eq!(result.long.net_usdt, None);
        assert_eq!(result.long.exclusion_reason.as_deref(), Some("not_entered"));
    }

    #[test]
    fn early_exit_does_not_shorten_purge_or_use_unobserved_rows() {
        let rows = candles(80);
        let result = label_origin(
            "BTCUSDT",
            &rows,
            24 * HOUR,
            40 * HOUR,
            &TradeLabelConfig::default(),
        )
        .unwrap();
        assert!(result.long.settled && result.short.settled);
        assert_eq!(result.class_index, None);
        assert_eq!(
            result.exclusion_reason.as_deref(),
            Some("observation_incomplete")
        );
        assert_eq!(result.label_observed_through_ms, 40 * HOUR);
        assert_eq!(result.mature_by_ms, 72 * HOUR);

        let missing = label(&rows[..40]);
        assert_eq!(missing.class_index, None);
        assert_eq!(
            missing.exclusion_reason.as_deref(),
            Some("observation_incomplete")
        );

        let mut changed = rows.clone();
        changed[40] = Value::Null;
        let same = label_origin(
            "BTCUSDT",
            &changed,
            24 * HOUR,
            40 * HOUR,
            &TradeLabelConfig::default(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::to_value(same).unwrap()
        );
        let unresolved = label_origin(
            "BTCUSDT",
            &rows,
            24 * HOUR,
            25 * HOUR,
            &TradeLabelConfig::default(),
        )
        .unwrap();
        assert!(!unresolved.long.entered && !unresolved.long.settled);
        assert_eq!(unresolved.class_index, None);
        assert_eq!(
            unresolved.long.exclusion_reason.as_deref(),
            Some("entry_unresolved")
        );
    }

    #[test]
    fn frozen_plans_depend_only_on_closed_prefix_and_future_tail_is_ignored() {
        let rows = candles(80);
        let original = label(&rows);
        let mut altered = rows.clone();
        altered[25]["high"] = json!(150.);
        let changed_future = label(&altered);
        assert_eq!(original.long.plan, changed_future.long.plan);
        assert_eq!(original.short.plan, changed_future.short.plan);
        // Even an invalid OHLC after the deadline must not enter this label.
        altered[73]["close"] = json!(-1.);
        let ignored_tail = label(&altered);
        assert_eq!(
            serde_json::to_value(changed_future).unwrap(),
            serde_json::to_value(ignored_tail).unwrap()
        );
    }

    #[test]
    fn unsafe_risk_short_windows_and_nonpositive_edge_are_rejected() {
        let rows = candles(72);
        for config in [
            TradeLabelConfig {
                observation_hours: 12,
                ..TradeLabelConfig::default()
            },
            TradeLabelConfig {
                min_net_edge_usdt: 0.,
                ..TradeLabelConfig::default()
            },
            TradeLabelConfig {
                replay: ReplayConfig {
                    max_notional_usdt: 100.,
                    ..ReplayConfig::default()
                },
                ..TradeLabelConfig::default()
            },
        ] {
            assert!(label_origin("BTCUSDT", &rows, 24 * HOUR, 72 * HOUR, &config).is_err());
        }
        assert!(
            label_origin(
                "BTCUSDT",
                &rows,
                24 * HOUR + 1,
                72 * HOUR,
                &TradeLabelConfig::default()
            )
            .is_err()
        );
    }
}
