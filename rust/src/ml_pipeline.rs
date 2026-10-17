//! Forecast -> classifier -> shared production protection/risk plan.
//! This candidate has no account ledger or order router. Research sizing uses
//! the manifest's reference capital, never an assumed live account balance.
use crate::{ml_replay, strategies};
use serde_json::{Value, json};

pub fn attach(output: &mut Value, rows: &[Value], config: &ml_replay::ReplayConfig) {
    let origin = output["origin_ms"].as_i64().unwrap_or(0);
    let action = output["action"].as_str().unwrap_or("HOLD").to_owned();
    let mut reasons = vec!["当前候选仅用于研究，交易执行未启用".to_owned()];
    let mut status = "hold";
    let mut plan = Value::Null;
    let mut size = Value::Null;
    let mut atr = Value::Null;
    let mut issues = vec![];
    if matches!(action.as_str(), "BUY" | "SELL") {
        let signal = ml_replay::ReplaySignal {
            origin_ms: origin,
            decision: action.clone(),
            probabilities: output["probabilities"].clone(),
            metadata: json!({"model_fingerprint":output["model_fingerprint"]}),
            plan: None,
        };
        match ml_replay::normalize_signal(output["symbol"].as_str().unwrap_or(""), rows, &signal) {
            Ok(normalized) => {
                atr = normalized["riskAtr"].clone();
                if normalized["eligible"] == true {
                    match ml_replay::position_size(&normalized, config.starting_equity, config) {
                        Ok(sizing) => {
                            plan = normalized["plan"].clone();
                            // Short-horizon ML holds keep trailing/partial TP, not the 0-bar MA exit.
                            plan["exitRules"] = strategies::ml_horizon_exit_rules();
                            size = sizing;
                            status = "ready_research";
                        }
                        Err(error) => issues.push(format!("仓位风控未通过：{error:#}")),
                    }
                } else {
                    issues.extend(
                        normalized["validationIssues"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned),
                    );
                }
            }
            Err(error) => issues.push(format!("保护计划未通过：{error:#}")),
        }
        if action == "BUY" && !config.allow_buy || action == "SELL" && !config.allow_sell {
            issues.push("风险配置禁止该开仓方向".into());
            plan = Value::Null;
            size = Value::Null;
        }
        if !issues.is_empty() || plan.is_null() {
            status = "rejected";
            reasons.extend(issues.iter().cloned());
        }
    } else {
        reasons.push("LightGBM 为 HOLD，不生成新仓止盈止损；不代表平掉已有持仓".into());
    }
    let stale = output["stale"] != false || output["forecast_target_still_future"] != true;
    if stale {
        reasons.push("行情或预测时点已过期，禁止用于新开仓".into());
        status = "stale";
    }
    let valid = !plan.is_null() && !size.is_null();
    let adjusted = if valid && !stale {
        action.as_str()
    } else {
        "HOLD"
    };
    output["risk_management"] = json!({
        "schema_version":1,"status":status,"plan_valid":valid,"entry_permitted":false,
        "plan":plan,"position_size":size,"atr14":atr,
        "reference_equity_usdt":config.starting_equity,"capital_source":"model_manifest_research_reference",
        "risk_fraction":config.risk_fraction,"daily_loss_fraction":config.daily_loss_fraction,
        "max_notional_usdt":config.max_notional_usdt,"max_notional_fraction":config.max_notional_fraction,
        "max_drawdown_fraction":config.max_drawdown_fraction,
        "account_risk_checked":false,"account_positions_checked":false,
        "account_risk_notice":"研究资金测算；未核验账户余额、当日亏损、回撤或已有仓位，不能作为下单许可",
        "protection_engine":"Rust shared production simulator / ml_replay",
        "protection_policy":{"atr_period":14,"stop_atr":2,"target_atr":5,"max_hold_bars":11,"entry_delay_bars":1},
        "validation_issues":issues,"blocked_reasons":reasons,
        "advisory_only":true,"orders_enabled":false,"real_trading_enabled":false
    });
    output["pipeline"] = json!({
        "id":"chronos-lightgbm-risk-v1","model_action":action,"risk_adjusted_action":adjusted,
        "execution_action":"HOLD","trade_execution_permitted":false,
        "stages":[
            {"id":"forecast","name":"Chronos-Bolt-Tiny","status":"completed"},
            {"id":"signal","name":"LightGBM","status":"completed"},
            {"id":"risk","name":"风险管理","status":status}
        ]
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    const HOUR: i64 = 3_600_000;
    fn input(action: &str) -> (Value, Vec<Value>) {
        let origin = 300 * HOUR;
        let rows = (0..256).map(|i| json!({"openTime":origin-(256-i)*HOUR,"closeTime":origin-(255-i)*HOUR-1,"confirmed":true,"open":100.,"high":101.,"low":99.,"close":100.,"volume":100.})).collect();
        (
            json!({"symbol":"BTCUSDT","action":action,"origin_ms":origin,"probabilities":{"BUY":0.7,"SELL":0.7,"HOLD":0.7},"stale":false,"forecast_target_still_future":true}),
            rows,
        )
    }

    #[test]
    fn both_directions_share_production_plans_and_conservative_risk_budget() {
        for action in ["BUY", "SELL"] {
            let (mut output, rows) = input(action);
            let config = ml_replay::ReplayConfig::default();
            attach(&mut output, &rows, &config);
            let risk = &output["risk_management"];
            assert_eq!(risk["status"], "ready_research");
            let shared = ml_replay::normalize_signal(
                "BTCUSDT",
                &rows,
                &ml_replay::ReplaySignal {
                    origin_ms: 300 * HOUR,
                    decision: action.into(),
                    probabilities: output["probabilities"].clone(),
                    metadata: Value::Null,
                    plan: None,
                },
            )
            .unwrap();
            for key in [
                "entryMin",
                "entryMax",
                "stopLoss",
                "takeProfit",
                "maxHoldBars",
                "netRewardRisk",
            ] {
                assert_eq!(risk["plan"][key], shared["plan"][key]);
            }
            assert_eq!(
                risk["position_size"],
                ml_replay::position_size(&shared, 1000., &config).unwrap()
            );
            assert!(
                risk["position_size"]["estimated_stop_loss_usdt"]
                    .as_f64()
                    .unwrap()
                    <= 10.
            );
            assert!(risk["position_size"]["notional_usdt"].as_f64().unwrap() <= 50.);
            assert_eq!(risk["entry_permitted"], false);
            assert_eq!(risk["account_risk_checked"], false);
            assert_eq!(output["pipeline"]["execution_action"], "HOLD");
            assert_eq!(
                risk["plan"]["exitRules"],
                strategies::ml_horizon_exit_rules()
            );
            assert_eq!(risk["plan"]["exitRules"]["smartExit"]["enabled"], false);
        }
    }

    #[test]
    fn hold_never_creates_a_plan_or_closes_a_position() {
        let (mut output, rows) = input("HOLD");
        attach(&mut output, &rows, &Default::default());
        assert_eq!(output["risk_management"]["status"], "hold");
        assert!(output["risk_management"]["plan"].is_null());
        assert!(output["risk_management"]["position_size"].is_null());
        assert_eq!(output["pipeline"]["risk_adjusted_action"], "HOLD");
    }

    #[test]
    fn stale_and_expired_targets_cannot_become_actionable() {
        for key in ["stale", "forecast_target_still_future"] {
            let (mut output, rows) = input("BUY");
            output[key] = json!(key == "stale");
            attach(&mut output, &rows, &Default::default());
            assert_eq!(output["risk_management"]["status"], "stale");
            assert_eq!(output["pipeline"]["risk_adjusted_action"], "HOLD");
            assert_eq!(output["risk_management"]["entry_permitted"], false);
        }
    }

    #[test]
    fn invalid_geometry_or_risk_limits_block_instead_of_loosening_limits() {
        let (mut output, mut rows) = input("BUY");
        rows.last_mut().unwrap()["high"] = json!(10000.);
        attach(&mut output, &rows, &Default::default());
        assert_eq!(output["risk_management"]["status"], "rejected");
        assert!(output["risk_management"]["plan"].is_null());
        let (mut output, rows) = input("SELL");
        attach(
            &mut output,
            &rows,
            &ml_replay::ReplayConfig {
                risk_fraction: 0.5,
                ..Default::default()
            },
        );
        assert_eq!(output["risk_management"]["status"], "rejected");
        assert_eq!(output["pipeline"]["execution_action"], "HOLD");
    }

    #[test]
    fn disabled_directions_never_receive_a_position() {
        for action in ["BUY", "SELL"] {
            let (mut output, rows) = input(action);
            attach(
                &mut output,
                &rows,
                &ml_replay::ReplayConfig {
                    allow_buy: false,
                    allow_sell: false,
                    ..Default::default()
                },
            );
            assert_eq!(output["risk_management"]["status"], "rejected");
            assert!(output["risk_management"]["position_size"].is_null());
            assert_eq!(output["pipeline"]["risk_adjusted_action"], "HOLD");
        }
    }

    #[test]
    fn generated_protection_is_honored_by_the_actual_shared_fill_and_exit_engine() {
        for action in ["BUY", "SELL"] {
            for profit in [false, true] {
                let (mut output, mut rows) = input(action);
                attach(&mut output, &rows, &Default::default());
                let plan = output["risk_management"]["plan"].clone();
                for i in 300..306 {
                    rows.push(json!({"openTime":i*HOUR,"open":100.,"high":101.,"low":99.,"close":100.,"volume":100.,"confirmed":true}));
                }
                let shock = &mut rows[257]; // first eligible entry bar, one hour after the signal
                if (action == "BUY") == profit {
                    shock["high"] = json!(112.);
                    shock["close"] = json!(105.);
                } else {
                    shock["low"] = json!(88.);
                    shock["close"] = json!(95.);
                }
                let replay = ml_replay::replay(
                    "BTCUSDT",
                    &rows,
                    &[ml_replay::ReplaySignal {
                        origin_ms: 300 * HOUR,
                        decision: action.into(),
                        probabilities: output["probabilities"].clone(),
                        metadata: Value::Null,
                        plan: Some(plan),
                    }],
                    &ml_replay::ReplayConfig {
                        start_ms: 300 * HOUR,
                        end_ms: 306 * HOUR,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert_eq!(replay["metrics"]["closed_trades"], 1);
                assert_eq!(replay["metrics"]["unresolved_orders"], 0);
                assert_eq!(replay["orders"][0]["status"], "closed");
                let net = replay["orders"][0]["net"].as_f64().unwrap();
                assert_eq!(net > 0., profit, "{action} profit={profit}: {replay}");
            }
        }
    }
}
