//! Frozen strategy sizing limits shared by manual, automatic and replay orders.
use super::*;

#[allow(clippy::too_many_arguments)]
pub fn constrain(
    sizing: &Value,
    plan: &Value,
    costs: &Value,
    equity: f64,
    requested_margin: f64,
    requested_leverage: f64,
    long: bool,
    duration_ms: i64,
) -> Result<(f64, f64)> {
    let risk_fraction = n(sizing, "riskFraction", f64::NAN);
    let notional_fraction = n(sizing, "maxNotionalFraction", f64::NAN);
    let max_leverage = n(sizing, "maxLeverage", f64::NAN);
    if !sizing.is_object()
        || [risk_fraction, notional_fraction]
            .iter()
            .any(|v| !v.is_finite() || *v <= 0. || *v > 1.)
        || !max_leverage.is_finite()
        || !(1. ..=125.).contains(&max_leverage)
        || max_leverage.fract() != 0.
    {
        bail!(
            "策略 riskSizing 无效：风险和名义仓位比例须在 0～1 之间，杠杆上限须为 1～125 的整数。"
        );
    }
    if !equity.is_finite() || equity <= 0. {
        bail!("策略风险仓位须有有效的当前账户权益。");
    }
    let limit = n(plan, "entryLimit", 0.);
    if plan["entryStyle"] != "market"
        && limit > 0.
        && (limit < n(plan, "entryMin", f64::NAN) || limit > n(plan, "entryMax", f64::NAN))
    {
        bail!("策略风险仓位的限价必须位于入场区间内。");
    }
    let fee = n(costs, "feeBps", f64::NAN) / 10000.;
    let slip = n(costs, "slippageBps", f64::NAN) / 10000.;
    let funding = n(costs, "fundingBpsPer8h", f64::NAN) / 10000.;
    let hold = n(plan, "maxHoldBars", f64::NAN).ceil();
    if [fee, slip, funding]
        .iter()
        .any(|v| !v.is_finite() || *v < 0.)
        || fee >= 1.
        || slip >= 1.
        || !hold.is_finite()
        || hold <= 0.
        || duration_ms <= 0
    {
        bail!("策略风险仓位的成本或最长持仓时间无效。");
    }
    let side = if long { 1. } else { -1. };
    let anchored = plan["reanchorToFill"] == true;
    let quote = if anchored {
        n(plan, "entryReference", f64::NAN)
    } else {
        n(plan, if long { "entryMax" } else { "entryMin" }, f64::NAN)
    };
    let entry = quote * (1. + side * slip);
    let stop = if anchored {
        entry - side * n(plan, "riskUnit", f64::NAN)
    } else {
        n(plan, "stopLoss", f64::NAN)
    };
    let exit = stop * (1. - side * slip);
    // An open-ended trailing strategy has no fixed liquidation horizon. Its
    // funding reserve is an explicit sizing assumption, never a loss guarantee.
    let reserve_hours = sizing
        .get("fundingReserveHours")
        .map(|value| number(value, f64::NAN));
    if reserve_hours.is_some_and(|hours| !hours.is_finite() || !(0. ..=8760.).contains(&hours)) {
        bail!("fundingReserveHours must be between 0 and 8760");
    }
    let funding_hours = reserve_hours.unwrap_or(hold * duration_ms as f64 / 3_600_000.);
    // Match the simulator: quantity = notional / slipped entry, both fees use
    // their actual fill notionals, and funding accrues over every held candle.
    let fill_loss_fraction =
        side * (entry - exit) / entry + fee * (1. + exit / entry) + funding * funding_hours / 8.;
    // Exchange entry quantities use the unslipped quote as their denominator,
    // whereas the simulator divides by the slipped fill. A long exchange fill
    // can therefore carry (1 + slip) times the simulator quantity and entry
    // notional, including fees/funding. Budget for that larger quantity too;
    // applying the same factor to shorts is deliberately conservative.
    let loss_fraction = fill_loss_fraction * (1. + slip);
    if [entry, exit, loss_fraction]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.)
    {
        bail!("策略风险仓位的入场、止损或单位损失无效。");
    }
    let leverage = requested_leverage.min(max_leverage);
    let notional_cap = (equity * risk_fraction / loss_fraction)
        .min(equity * notional_fraction / (1. + slip))
        .min(requested_margin * leverage);
    let margin = (notional_cap / leverage * 100.).floor() / 100.;
    if !margin.is_finite() || margin < 1. {
        bail!("策略风险预算不足 1 USDT 最低保证金，跳过下单。");
    }
    Ok((margin, leverage))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sizing() -> Value {
        json!({"riskFraction":0.005,"maxNotionalFraction":0.35,"maxLeverage":1})
    }

    fn record(stop: f64) -> Value {
        json!({"id":"strategy-risk","strategyId":crate::strategies::ACTIVE_STRATEGY_ID,"marketProvider":"binance","analyses":[{
            "symbol":"BTCUSDT","strategyId":crate::strategies::ACTIVE_STRATEGY_ID,"eligible":true,
            "interval":"15m","positionRecommendation":"OPEN_LONG","firstEntryAt":0,
            "plan":{"entryStyle":"market","entryMin":99.,"entryMax":100.,"stopLoss":stop,
                "takeProfit":150.,"maxHoldBars":96,"riskSizing":sizing()}
        }]})
    }

    fn account(equity: f64) -> Value {
        json!({"initialBalance":equity,"orders":[]})
    }

    #[test]
    fn strategy_risk_caps_large_margin_and_high_leverage_at_stop_budget() {
        let mut state = account(10000.);
        let order = submit_paper_order(
            &mut state,
            &record(95.),
            &json!({"symbol":"BTCUSDT","margin":9000.,"leverage":10}),
            0,
        )
        .unwrap();
        assert_eq!(order["leverage"], 1.);
        assert!(n(&order, "notional", 0.) < 1000.);
        assert!(n(&order, "notional", 0.) <= 3500.);
        // Verify the cap against the shared simulator, including the adverse
        // entry, entry/exit fees and its full 96-candle funding charge.
        let mut rows = vec![];
        for index in 1..=96 {
            rows.push(
                json!({"openTime":index * 900000_i64,"open":100.,"high":100.1,
                "low":if index == 96 {94.9} else {99.9},"close":100.,"volume":1}),
            );
        }
        let settled = simulator::evaluate(
            &order,
            &rows,
            97 * 900000,
            &json!({"mode":"account","enableDynamicProtection":false}),
        )
        .unwrap();
        assert_eq!(settled["reason"], "stop_loss");
        assert!(n(&settled, "net", 0.) >= -50. - 1e-8);
        assert!(n(&settled, "net", 0.) < -49.);
    }

    #[test]
    fn strategy_risk_caps_precise_exchange_quote_quantity_with_fill_costs() {
        let order = submit_paper_order(
            &mut account(10000.),
            &record(95.),
            &json!({"symbol":"BTCUSDT","margin":9000.,"leverage":10}),
            0,
        )
        .unwrap();
        let slip = n(&order["costs"], "slippageBps", 0.) / 10000.;
        let fee = n(&order["costs"], "feeBps", 0.) / 10000.;
        for quote in [99., 100.] {
            // Reproduce exchange quantity alignment from the unslipped quote,
            // then give the resulting real fill to the shared simulator. A
            // fine lot prevents coarse quantity rounding from hiding oversize.
            let quantity = (n(&order, "notional", 0.) / quote * 1e8).floor() / 1e8;
            let entry = quote * (1. + slip);
            let filled_notional = entry * quantity;
            let mut filled = order.clone();
            filled["entry"] = json!(entry);
            filled["entryAt"] = json!(iso(900000));
            filled["quantity"] = json!(quantity);
            filled["notional"] = json!(filled_notional);
            filled["entryFee"] = json!(filled_notional * fee);
            let rows: Vec<Value> = (1..=96)
                .map(|index| {
                    json!({"openTime":index * 900000_i64,"open":quote,"high":quote+0.1,
                        "low":if index == 96 {94.9} else {quote-0.1},"close":quote,"volume":1})
                })
                .collect();
            let settled = simulator::evaluate(
                &filled,
                &rows,
                97 * 900000,
                &json!({"mode":"account","enableDynamicProtection":false}),
            )
            .unwrap();
            assert_eq!(settled["reason"], "stop_loss");
            assert!(n(&settled, "net", 0.) >= -50. - 1e-8);
            if quote == 100. {
                assert!(n(&settled, "net", 0.) < -49.99);
            }
        }
    }

    #[test]
    fn strategy_risk_tight_stop_still_obeys_notional_cap_and_never_adds_margin() {
        let mut signal = record(98.999);
        signal["analyses"][0]["plan"]["entryMin"] = json!(99.9995);
        signal["analyses"][0]["plan"]["stopLoss"] = json!(99.999);
        for requested in [9000., 12.345] {
            let order = submit_paper_order(
                &mut account(10000.),
                &signal,
                &json!({"symbol":"BTCUSDT","margin":requested,"leverage":10}),
                0,
            )
            .unwrap();
            let notional = n(&order, "notional", 0.);
            assert!(notional <= 3500.);
            assert!(n(&order, "margin", 0.) <= requested);
            assert_eq!(order["notional"], order["margin"]);
            let slip = n(&order["costs"], "slippageBps", 0.) / 10000.;
            let maximum_quote = n(&order["plan"], "entryMax", 0.);
            let quantity = (notional / maximum_quote * 1e8).floor() / 1e8;
            let filled_notional = quantity * maximum_quote * (1. + slip);
            assert!(filled_notional <= 3500. + 1e-8);
            if requested > 3500. {
                assert!(3500. - filled_notional < 0.02);
            } else {
                assert_eq!(order["margin"], 12.34);
            }
        }
        let automatic = submit_paper_order(
            &mut account(10000.),
            &signal,
            &json!({"symbol":"BTCUSDT","autoMarginPct":0.9,"leverage":10,"automatic":true}),
            0,
        )
        .unwrap();
        let slip = n(&automatic["costs"], "slippageBps", 0.) / 10000.;
        assert!(n(&automatic, "notional", 0.) * (1. + slip) <= 3500. + 1e-8);
        assert_eq!(automatic["leverage"], 1.);
    }

    #[test]
    fn strategy_risk_frozen_policy_survives_execution_plan_replacement() {
        let signal = record(95.);
        let mut replacement = signal["analyses"][0]["plan"].clone();
        replacement["riskSizing"] =
            json!({"riskFraction":1.,"maxNotionalFraction":1.,"maxLeverage":125});
        let order = submit_paper_order(
            &mut account(10000.),
            &signal,
            &json!({"symbol":"BTCUSDT","margin":9000.,"leverage":10,"executionPlan":replacement,"stopLoss":90.}),
            0,
        )
        .unwrap();
        assert_eq!(order["plan"]["riskSizing"], sizing());
        assert_eq!(order["initialPlan"]["riskSizing"], sizing());
        assert!(n(&order, "notional", 0.) < 500.);
        replacement.as_object_mut().unwrap().remove("riskSizing");
        let omitted = submit_paper_order(
            &mut account(10000.),
            &signal,
            &json!({"symbol":"BTCUSDT","margin":9000.,"leverage":10,"executionPlan":replacement}),
            0,
        )
        .unwrap();
        assert_eq!(omitted["plan"]["riskSizing"], sizing());
        assert!(n(&omitted, "notional", 0.) < 1000.);
    }

    #[test]
    fn strategy_risk_rejects_small_equity_and_invalid_frozen_policy() {
        let input = json!({"symbol":"BTCUSDT","margin":100.,"leverage":1});
        let mut state = account(2.);
        let error = submit_paper_order(&mut state, &record(95.), &input, 0).unwrap_err();
        assert!(error.to_string().contains("不足 1 USDT"));
        assert!(state["orders"].as_array().unwrap().is_empty());
        for policy in [
            Value::Null,
            json!({}),
            json!({"riskFraction":0.005,"maxNotionalFraction":0.35,"maxLeverage":0}),
        ] {
            let mut signal = record(95.);
            signal["analyses"][0]["plan"]["riskSizing"] = policy;
            assert!(submit_paper_order(&mut account(10000.), &signal, &input, 0).is_err());
        }
    }

    #[test]
    fn strategy_risk_rejects_limit_execution_outside_budgeted_entry_band() {
        let mut signal = record(95.);
        signal["analyses"][0]["plan"]["entryStyle"] = json!("limit");
        signal["analyses"][0]["plan"]["entryLimit"] = json!(110.);
        let error = submit_paper_order(
            &mut account(10000.),
            &signal,
            &json!({"symbol":"BTCUSDT","margin":1000.,"leverage":1}),
            0,
        )
        .unwrap_err();
        assert!(error.to_string().contains("限价必须位于入场区间"));
    }

    #[test]
    fn strategy_risk_uses_current_equity_and_short_adverse_entry() {
        let mut state = account(10000.);
        state["orders"] = json!([{"status":"closed","margin":100.,"net":-5000.}]);
        let mut signal = record(105.);
        signal["analyses"][0]["positionRecommendation"] = json!("OPEN_SHORT");
        signal["analyses"][0]["plan"]["takeProfit"] = json!(50.);
        let order = submit_paper_order(
            &mut state,
            &signal,
            &json!({"symbol":"BTCUSDT","margin":4000.,"leverage":10}),
            0,
        )
        .unwrap();
        assert!(n(&order, "notional", 0.) < 500.);
        let rows =
            [json!({"openTime":900000,"open":99.,"high":105.1,"low":98.9,"close":100.,"volume":1})];
        let settled =
            simulator::evaluate(&order, &rows, 1800000, &json!({"mode":"account"})).unwrap();
        assert_eq!(settled["reason"], "stop_loss");
        assert!(n(&settled, "net", 0.) >= -25. - 1e-8);
    }

    #[test]
    fn strategy_risk_legacy_orders_keep_requested_margin_and_leverage() {
        let mut signal = record(95.);
        signal["analyses"][0]["plan"]
            .as_object_mut()
            .unwrap()
            .remove("riskSizing");
        let order = submit_paper_order(
            &mut account(10000.),
            &signal,
            &json!({"symbol":"BTCUSDT","margin":123.456,"leverage":10}),
            0,
        )
        .unwrap();
        assert_eq!(order["margin"], 123.456);
        assert_eq!(order["leverage"], 10.);
        assert_eq!(order["notional"], 1234.56);
    }

    #[test]
    fn fill_anchored_trailing_risk_uses_explicit_funding_reserve_not_timeout() {
        let plan = json!({"entryStyle":"market","reanchorToFill":true,
            "entryReference":100.,"entryMin":100.,"entryMax":100.,"stopLoss":95.,
            "riskUnit":5.,"maxHoldBars":1_000_000});
        let policy = json!({"riskFraction":0.003,"maxNotionalFraction":0.5,
            "maxLeverage":1,"fundingReserveHours":24});
        let costs = json!({"feeBps":6.,"slippageBps":5.,"fundingBpsPer8h":3.});
        let (margin, leverage) =
            constrain(&policy, &plan, &costs, 10000., 9000., 1., true, 3600000).unwrap();
        assert_eq!(leverage, 1.);
        assert!(margin > 500. && margin < 600.);
        let invalid = json!({"riskFraction":0.003,"maxNotionalFraction":0.5,
            "maxLeverage":1,"fundingReserveHours":-1});
        assert!(constrain(&invalid, &plan, &costs, 10000., 9000., 1., true, 3600000).is_err());
    }
}
