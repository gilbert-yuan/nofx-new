//! Account-aware Demo authorization. The predictor remains a pure data provider;
//! only this backend adapter may authorize its signals against the actual ledger.
use crate::{
    exchange, iso,
    ml_replay::{self, ReplayConfig, RiskLedger},
    number, paper, research, timestamp,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

pub const STRATEGY_ID: &str = "chronos-lightgbm-v1";
const HOUR: i64 = 3_600_000;

pub fn demo_enabled(config: &Value) -> bool {
    config["ml"]["mode"] == "demo"
}
pub fn is_model_order(order: &Value) -> bool {
    order["strategyId"] == STRATEGY_ID || order["analysisContext"]["strategyId"] == STRATEGY_ID
}
pub fn validate_config(config: &Value) -> Result<()> {
    ensure!(demo_enabled(config), "模型自动交易未开启");
    ensure!(
        exchange::is_demo(&config["binance"]),
        "模型仅允许 Binance Demo 环境"
    );
    ensure!(
        config["trader"]["syncPaperOrdersToLive"] != true,
        "模型 Demo 模式禁止同步实盘"
    );
    ensure!(
        config["trader"]["syncPaperOrdersToDemo"] == true,
        "Demo 同步尚未开启"
    );
    ensure!(
        config["trader"]["enabled"] == true
            && config["trader"]["dryRun"] != true
            && config["trader"]["allowEntryOrders"] == true
            && config["marketSync"]["dataOnly"] != true,
        "交易开关或数据展示模式不允许新增订单"
    );
    Ok(())
}

fn policy(prediction: &Value) -> ReplayConfig {
    let risk = &prediction["risk_management"];
    let limit = |key: &str, maximum: f64| number(&risk[key], maximum).min(maximum);
    ReplayConfig {
        risk_fraction: limit("risk_fraction", 0.01),
        max_notional_fraction: limit("max_notional_fraction", 0.20),
        max_notional_usdt: limit("max_notional_usdt", 50.),
        daily_loss_fraction: limit("daily_loss_fraction", 0.03),
        max_drawdown_fraction: limit("max_drawdown_fraction", 0.10),
        ..Default::default()
    }
}

fn account_risk(state: &Value, config: &Value, now: i64) -> Result<(Value, RiskLedger)> {
    validate_config(config)?;
    ensure!(
        !state["fusedPoolStartedAt"].is_null(),
        "Demo 统一资金池尚未就绪"
    );
    let demo = &state["exchangeAccounts"]["demo"];
    ensure!(
        demo["enabled"] == true && demo["configured"] == true,
        "Demo 账户尚未配置或同步"
    );
    ensure!(
        state["exchangeAccounts"]["live"]["enabled"] != true,
        "实盘账户处于启用状态，模型 Demo 执行已阻止"
    );
    let funds = paper::account_summary(state, now);
    ensure!(
        funds["syncReady"] == true,
        "Demo 账户或成交收益正在同步/对账"
    );
    let equity = funds["equity"]
        .as_f64()
        .filter(|x| x.is_finite() && *x > 0.)
        .context("Demo 权益无效")?;
    if !state["mlRisk"]["accountKey"].is_null() {
        ensure!(
            state["mlRisk"]["accountKey"] == demo["accountKey"],
            "Demo 执行账户已变更，模型风控需要重新核验"
        );
    }
    let mut ledger: RiskLedger = if state["mlRisk"]["ledger"].is_null() {
        RiskLedger::new(equity)
    } else {
        serde_json::from_value(state["mlRisk"]["ledger"].clone()).context("模型风控账本无效")?
    };
    ledger.observe(now, equity, &ReplayConfig::default());
    Ok((funds, ledger))
}

pub fn observe_account(state: &mut Value, config: &Value, now: i64) -> Result<Value> {
    let (funds, ledger) = account_risk(state, config, now)?;
    if !state["mlRisk"].is_object() {
        state["mlRisk"] = json!({});
    }
    state["mlRisk"]["ledger"] = serde_json::to_value(&ledger)?;
    state["mlRisk"]["accountKey"] = state["exchangeAccounts"]["demo"]["accountKey"].clone();
    state["mlRisk"]["observedAt"] = json!(iso(now));
    Ok(
        json!({"checked":true,"can_open":funds["canOpen"]==true&&ledger.entry_block().is_none(),"reason":ledger.entry_block()}),
    )
}

pub fn signal(prediction: &Value, market: &Value, now: i64) -> Result<Value> {
    ensure!(
        prediction["data_mode"] == "live_public",
        "模型自动交易仅接受实时公共行情"
    );
    let origin = prediction["origin_ms"].as_i64().context("模型缺少时点")?;
    ensure!(
        origin == now.div_euclid(HOUR) * HOUR
            && prediction["stale"] == false
            && prediction["forecast_target_still_future"] == true,
        "模型行情已过期或预测已结束"
    );
    ensure!(
        timestamp(&market["dataAsOf"]) == Some(origin),
        "模型与交易行情时点不一致"
    );
    let action = prediction["action"].as_str().context("模型方向缺失")?;
    ensure!(matches!(action, "BUY" | "SELL" | "HOLD"), "模型方向无效");
    let confidence = prediction["probabilities"][action]
        .as_f64()
        .context("分类概率缺失")?;
    let raw = json!({"positionRecommendation":action,"confidence":confidence,"recommendedLeverage":1,
        "reason":"Chronos-Bolt-Tiny 预测，LightGBM 分类，Demo 账户风控",
        "plan":prediction["risk_management"]["plan"]});
    let mut signal = research::normalize_plan(&raw, market, now);
    // The ML candidate keeps trailing and partial take-profit but must never use the
    // 0-bar MA exit of enhanced-trend-v1. Enforce it at the execution boundary so a
    // stale predictor binary cannot silently reintroduce that rule through its plan.
    if let Some(plan) = signal["plan"].as_object_mut() {
        plan.insert(
            "exitRules".into(),
            crate::strategies::ml_horizon_exit_rules(),
        );
    }
    signal["strategyId"] = json!(STRATEGY_ID);
    signal["analysisEngine"] = json!("monthly-ml");
    signal["confidenceType"] = json!("classifier_probability");
    signal["mlPrediction"] = prediction.clone();
    signal["mlRiskPolicy"] = serde_json::to_value(policy(prediction))?;
    signal["executionEnvironment"] = json!("demo");
    Ok(signal)
}

fn ensure_capacity(funds: &Value) -> Result<()> {
    // Position count is bounded only by margin here, so a broad scan can fill the
    // whole equity and leave `available` negative. Keep a reserve for fees, funding
    // and adverse moves instead of opening until the ledger refuses.
    let committed = number(&funds["committed"], 0.);
    let equity = number(&funds["equity"], 0.);
    let ceiling = crate::automation_guards::env_num("NOFX_ML_MAX_COMMITTED_PCT", 0.80, 0.1, 1.0);
    ensure!(
        equity > 0. && committed <= equity * ceiling + 1e-8,
        "持仓占用已达权益的 {:.0}% 缓冲上限，暂停新增订单",
        ceiling * 100.
    );
    Ok(())
}

fn authorize(
    state: &Value,
    config: &Value,
    signal: &Value,
    now: i64,
    existing: Option<&str>,
) -> Result<Value> {
    let (funds, ledger) = account_risk(state, config, now)?;
    ensure!(
        ledger.entry_block().is_none(),
        "{}",
        ledger.entry_block().unwrap_or("模型风控阻止开仓")
    );
    ensure!(
        funds["canOpen"] == true,
        "Demo 资金或挂单占用不允许新增订单"
    );
    ensure_capacity(&funds)?;
    ensure!(signal["eligible"] == true, "模型未生成有效新仓计划");
    ensure!(
        number(&signal["confidence"], 0.) >= number(&config["trader"]["minConfidence"], 0.45),
        "模型分类概率低于配置开仓门槛"
    );
    let prediction = &signal["mlPrediction"];
    ensure!(
        prediction["data_mode"] == "live_public",
        "拒绝历史或外部行情执行"
    );
    let origin = prediction["origin_ms"].as_i64().context("缺少模型时点")?;
    let age = now - origin;
    ensure!(
        origin.rem_euclid(HOUR) == 0
            && age >= 0
            && age < if existing.is_some() { 2 * HOUR } else { HOUR },
        "模型开仓时点已过期"
    );
    ensure!(
        prediction["forecast_target_end_ms"]
            .as_i64()
            .is_some_and(|end| end > now),
        "模型预测期限已结束"
    );
    let symbol = signal["symbol"].as_str().context("模型币种缺失")?;
    ensure!(prediction["symbol"] == symbol, "模型币种不一致");
    if existing.is_none() {
        ensure!(
            state["mlRisk"]["consumed"][symbol]["origin_ms"]
                .as_i64()
                .is_none_or(|last| last < origin),
            "该币种此小时的模型信号已处理"
        );
    }
    ensure!(
        !state["orders"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|o| o["symbol"] == symbol
                && matches!(o["status"].as_str(), Some("pending" | "open"))
                && existing.is_none_or(|id| o["id"] != id)),
        "该币种已有挂单或仓位"
    );
    ensure!(
        !paper::fused_orders(state)["activeOrders"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|o| o["symbol"] == symbol
                && (existing.is_none()
                    || !o["localOrders"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|r| r["id"] == existing.unwrap()))),
        "Demo 已有同币种远端持仓或挂单"
    );
    let cfg = policy(prediction);
    let size = ml_replay::position_size(signal, funds["equity"].as_f64().unwrap(), &cfg)?;
    Ok(size)
}

pub fn authorize_new(
    state: &mut Value,
    config: &Value,
    signal: &Value,
    input: &Value,
    now: i64,
) -> Result<Value> {
    let size = authorize(state, config, signal, now, None)?;
    ensure!(
        input["stopLoss"].is_null() && input["takeProfit"].is_null(),
        "模型保护价格不接受手动覆盖"
    );
    if input["executionPlan"].is_object() {
        let expected = crate::strategies::execution_plan(signal);
        ensure!(
            expected.is_object() && input["executionPlan"] == expected,
            "模型执行计划不允许覆盖风险规则"
        );
    }
    let margin = number(&input["margin"], f64::NAN);
    ensure!(
        number(&input["leverage"], f64::NAN) == 1.
            && margin.is_finite()
            && margin > 0.
            && margin <= number(&size["margin_usdt"], 0.) + 1e-8,
        "模型订单超过账户风险预算、50 USDT 上限或 1 倍杠杆"
    );
    observe_account(state, config, now)?;
    let symbol = signal["symbol"].as_str().unwrap();
    if !state["mlRisk"]["consumed"].is_object() {
        state["mlRisk"]["consumed"] = json!({});
    }
    state["mlRisk"]["consumed"][symbol] = json!({"origin_ms":signal["mlPrediction"]["origin_ms"],"model_fingerprint":signal["mlPrediction"]["model_fingerprint"]});
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(now: i64) -> (Value, Value, Value) {
        let mut config = crate::store::default_config();
        config["ml"]["mode"] = json!("demo");
        config["trader"]["enabled"] = json!(true);
        config["trader"]["dryRun"] = json!(false);
        config["trader"]["allowEntryOrders"] = json!(true);
        config["trader"]["syncPaperOrdersToDemo"] = json!(true);
        let state = json!({"initialBalance":1000.,"fusedPoolStartedAt":iso(now),"orders":[],"capitalReservations":{},
            "exchangeAccounts":{"demo":{"enabled":true,"configured":true,"syncedAt":iso(now),"metricsSyncedAt":iso(now),"accountKey":"fixture-demo","positions":[],"orders":[],"externalMetrics":{},"orderMetrics":{}},"live":{"enabled":false}}});
        let origin = now.div_euclid(HOUR) * HOUR;
        let rows:Vec<Value>=(0..256).map(|i|json!({"openTime":origin-(256-i)*HOUR,"open":100.,"high":101.,"low":99.,"close":100.,"volume":10.,"confirmed":true})).collect();
        let mut prediction = json!({"symbol":"BTCUSDT","origin_ms":origin,"action":"BUY","data_mode":"live_public","stale":false,"forecast_target_still_future":true,"forecast_target_end_ms":origin+12*HOUR,"model_fingerprint":"fixture","candidate_status":"research_only","probabilities":{"BUY":0.7,"SELL":0.1,"HOLD":0.2}});
        crate::ml_pipeline::attach(&mut prediction, &rows, &Default::default());
        (config, state, prediction)
    }
    fn normalized(prediction: &Value, now: i64) -> Value {
        signal(prediction,&json!({"symbol":"BTCUSDT","interval":"1h","marketProvider":"binance","dataAsOf":iso(prediction["origin_ms"].as_i64().unwrap())}),now).unwrap()
    }
    fn fresh(state: &mut Value, now: i64) {
        state["exchangeAccounts"]["demo"]["syncedAt"] = json!(iso(now));
        state["exchangeAccounts"]["demo"]["metricsSyncedAt"] = json!(iso(now));
    }

    #[test]
    fn capacity_buffer_blocks_entries_before_margin_is_exhausted() {
        assert!(ensure_capacity(&json!({"committed":700.,"equity":1000.})).is_ok());
        assert!(ensure_capacity(&json!({"committed":800.,"equity":1000.})).is_ok());
        assert!(ensure_capacity(&json!({"committed":801.,"equity":1000.})).is_err());
        assert!(ensure_capacity(&json!({"committed":1000.,"equity":1000.})).is_err());
        assert!(ensure_capacity(&json!({"committed":0.,"equity":0.})).is_err());
    }

    #[test]
    fn stale_predictor_exit_rules_are_replaced_at_the_execution_boundary() {
        let now = 300 * HOUR + 1000;
        let (_, _, mut prediction) = fixture(now);
        prediction["risk_management"]["plan"]["exitRules"] =
            crate::strategies::exit_rules_for(&json!({}));
        assert_eq!(
            prediction["risk_management"]["plan"]["exitRules"]["smartExit"]["enabled"],
            true
        );
        let signal = normalized(&prediction, now);
        assert_eq!(
            signal["plan"]["exitRules"],
            crate::strategies::ml_horizon_exit_rules()
        );
        assert_eq!(signal["plan"]["exitRules"]["smartExit"]["enabled"], false);
        assert_eq!(
            signal["plan"]["exitRules"]["smartExit"]["barLevelEnabled"],
            false
        );
        assert_eq!(
            signal["plan"]["exitRules"]["partialTp"]["enabled"], true,
            "partial take-profit must survive the override"
        );
    }

    #[test]
    fn demo_order_uses_shared_ledger_and_rejects_duplicate_and_overrides() {
        let now = 300 * HOUR + 1000;
        let (config, mut state, prediction) = fixture(now);
        let signal = normalized(&prediction, now);
        let record = json!({"id":"model-record","interval":"1h","strategyId":STRATEGY_ID,"analyses":[signal]});
        let input = json!({"recordId":"model-record","symbol":"BTCUSDT","strategyId":STRATEGY_ID,"margin":50.,"leverage":1});
        assert!(paper::submit_paper_order(&mut state.clone(), &record, &input, now).is_err());
        for (key, value) in [
            ("margin", json!(51.)),
            ("leverage", json!(2)),
            ("stopLoss", json!(1.)),
            ("executionPlan", json!({"stopLoss":1.})),
        ] {
            let mut bad = input.clone();
            bad[key] = value;
            assert!(
                paper::submit_paper_order_inner(
                    &mut state.clone(),
                    &record,
                    &bad,
                    now,
                    Some(&config)
                )
                .is_err(),
                "{key}"
            );
        }
        let order =
            paper::submit_paper_order_inner(&mut state, &record, &input, now, Some(&config))
                .unwrap();
        assert_eq!(order["strategyId"], STRATEGY_ID);
        assert_eq!(order["leverage"], 1.);
        assert_eq!(order["notional"], 50.);
        assert_eq!(state["orders"].as_array().unwrap().len(), 1);
        // The existing idempotent record retry returns the same order.
        assert_eq!(
            paper::submit_paper_order_inner(&mut state, &record, &input, now, Some(&config))
                .unwrap()["id"],
            order["id"]
        );
        state["orders"] = json!([]);
        assert!(authorize_new(&mut state, &config, &record["analyses"][0], &input, now).is_err());
    }

    #[test]
    fn account_sync_live_environment_and_small_equity_fail_closed() {
        let now = 300 * HOUR + 1000;
        let (config, state, prediction) = fixture(now);
        let signal = normalized(&prediction, now);
        for key in ["syncedAt", "metricsSyncedAt"] {
            let mut stale = state.clone();
            stale["exchangeAccounts"]["demo"][key] = json!(iso(now - 121000));
            assert!(authorize(&stale, &config, &signal, now, None).is_err());
        }
        let mut bad = config.clone();
        bad["trader"]["syncPaperOrdersToLive"] = json!(true);
        assert!(validate_config(&bad).is_err());
        let mut bad = config.clone();
        bad["binance"]["demo"] = json!(false);
        bad["binance"]["testnet"] = json!(false);
        assert!(validate_config(&bad).is_err());
        let mut small = state.clone();
        small["initialBalance"] = json!(100.);
        assert!(
            authorize_new(
                &mut small,
                &config,
                &signal,
                &json!({"margin":50.,"leverage":1}),
                now
            )
            .is_err()
        );
        assert!(
            authorize_new(
                &mut small,
                &config,
                &signal,
                &json!({"margin":10.,"leverage":1}),
                now
            )
            .is_ok()
        );
        let mut other = state.clone();
        other["orders"] =
            json!([{"id":"other","symbol":"BTCUSDT","status":"pending","margin":1.,"notional":1.}]);
        assert!(authorize(&other, &config, &signal, now, None).is_err());
    }

    #[test]
    fn closed_history_gaps_do_not_override_active_account_reconciliation() {
        let now = 300 * HOUR + 1000;
        let (config, mut state, prediction) = fixture(now);
        let signal = normalized(&prediction, now);
        state["orders"] = json!([{"id":"old","symbol":"SOLUSDT","status":"closed","accountingIncomplete":true,"net":0.}]);
        let funds = paper::account_summary(&state, now);
        assert_eq!(funds["accountingComplete"], false);
        assert_eq!(funds["syncReady"], true);
        assert!(authorize(&state, &config, &signal, now, None).is_ok());

        state["orders"] = json!([{"id":"unreconciled","symbol":"SOLUSDT","status":"open","direction":"OPEN_LONG","entry":100.,"margin":100.,"notional":100.}]);
        state["exchangeAccounts"]["demo"]["orderMetrics"]["unreconciled"] =
            json!({"filledQty":1.,"remainingQty":1.,"entryQty":1.,"entryNotional":100.});
        assert_eq!(paper::account_summary(&state, now)["syncReady"], false);
        assert!(authorize(&state, &config, &signal, now, None).is_err());
    }

    #[test]
    fn shared_daily_pause_survives_recovery_and_drawdown_survives_rollover() {
        let now = 300 * HOUR + 1000;
        let (config, mut state, _) = fixture(now);
        observe_account(&mut state, &config, now).unwrap();
        state["initialBalance"] = json!(960.);
        fresh(&mut state, now + 1000);
        assert_eq!(
            observe_account(&mut state, &config, now + 1000).unwrap()["can_open"],
            false
        );
        state["initialBalance"] = json!(1000.);
        fresh(&mut state, now + 2000);
        assert_eq!(
            observe_account(&mut state, &config, now + 2000).unwrap()["can_open"],
            false
        );
        let next_day = (now.div_euclid(86_400_000) + 1) * 86_400_000;
        fresh(&mut state, next_day);
        assert_eq!(
            observe_account(&mut state, &config, next_day).unwrap()["can_open"],
            true
        );
        state["initialBalance"] = json!(890.);
        fresh(&mut state, next_day + 1000);
        assert_eq!(
            observe_account(&mut state, &config, next_day + 1000).unwrap()["can_open"],
            false
        );
        state["initialBalance"] = json!(1000.);
        fresh(&mut state, next_day + 86_400_000);
        assert_eq!(
            observe_account(&mut state, &config, next_day + 86_400_000).unwrap()["can_open"],
            false
        );
    }

    #[test]
    fn stale_predictions_and_paused_worker_never_authorize_execution() {
        let now = 300 * HOUR + 1000;
        let (config, state, mut prediction) = fixture(now);
        describe(&mut prediction, &state, &config, now, false);
        assert_eq!(prediction["research_mode"], false);
        assert_eq!(prediction["risk_management"]["account_risk_checked"], true);
        assert_eq!(prediction["risk_management"]["entry_permitted"], false);
        assert_eq!(prediction["pipeline"]["execution_action"], "HOLD");
        let (_, _, mut prediction) = fixture(now);
        describe(&mut prediction, &state, &config, now, true);
        assert_eq!(prediction["risk_management"]["entry_permitted"], true);
        assert_eq!(prediction["pipeline"]["execution_action"], "BUY");
        assert_eq!(prediction["real_trading_enabled"], false);
        let (_, _, mut prediction) = fixture(now);
        prediction["data_mode"] = json!("frozen_snapshot");
        assert!(signal(&prediction, &json!({}), now).is_err());
        let (_, _, prediction) = fixture(now);
        assert!(signal(&prediction, &json!({}), now + HOUR).is_err());
    }
}

pub fn recheck_pending(state: &Value, config: &Value, order: &Value, now: i64) -> Result<()> {
    let signal = &order["analysisContext"]["signal"];
    let size = authorize(state, config, signal, now, order["id"].as_str())?;
    ensure!(
        number(&order["margin"], f64::INFINITY) <= number(&size["margin_usdt"], 0.) + 1e-8
            && number(&order["leverage"], 0.) == 1.,
        "待成交订单已超过当前模型账户风控预算"
    );
    Ok(())
}

pub fn describe(output: &mut Value, state: &Value, config: &Value, now: i64, active: bool) {
    output["operating_mode"] = json!(if demo_enabled(config) {
        "demo_auto"
    } else {
        "research"
    });
    output["research_mode"] = json!(!demo_enabled(config));
    if !demo_enabled(config) {
        return;
    }
    output["model_evaluation_status"] = output["candidate_status"].clone();
    output["candidate_status"] = json!("demo_auto");
    output["advisory_only"] = json!(false);
    output["real_trading_enabled"] = json!(false);
    let base = account_risk(state, config, now);
    let mut reasons = vec![];
    if !active {
        reasons.push("Demo 自动任务尚未启动".to_owned());
    }
    let account_ok = match &base {
        Ok((funds, ledger)) => {
            if funds["canOpen"] != true {
                reasons.push("Demo 资金池暂不允许新增订单".into());
            }
            if let Some(reason) = ledger.entry_block() {
                reasons.push(reason.into());
            }
            true
        }
        Err(error) => {
            reasons.push(format!("{error:#}"));
            false
        }
    };
    output["execution_context"] = json!({"environment":"demo","worker_active":active,"account_checked":account_ok,"blocked_reasons":reasons});
    if let Ok((funds, _)) = &base {
        output["execution_context"]["accounting_complete"] = funds["accountingComplete"].clone();
        output["execution_context"]["accounting_notice"] =
            json!(if funds["accountingComplete"] == true {
                "当前资金与成交记录已核验"
            } else {
                "部分已平仓历史成交记录不完整；当前持仓及资金开仓许可按系统共享资金池检查"
            });
    }
    output["orders_enabled"] = json!(active && reasons.is_empty());
    if output["risk_management"].is_object() {
        let market = json!({"symbol":output["symbol"],"interval":"1h","dataAsOf":iso(output["origin_ms"].as_i64().unwrap_or(0))});
        let permitted = signal(output, &market, now)
            .and_then(|signal| authorize(state, config, &signal, now, None));
        let allow = active && permitted.is_ok();
        if let Err(error) = &permitted {
            reasons.push(format!("{error:#}"));
        }
        let accounting_notice = output["execution_context"]["accounting_notice"].clone();
        let risk = &mut output["risk_management"];
        if let Ok((funds, _)) = &base {
            risk["reference_equity_usdt"] = funds["equity"].clone();
        }
        if let Ok(size) = permitted {
            risk["position_size"] = size;
        }
        risk["capital_source"] = json!("binance_demo_shared_account");
        risk["advisory_only"] = json!(false);
        if !account_ok {
            risk["position_size"] = Value::Null;
            risk["reference_equity_usdt"] = Value::Null;
        }
        risk["account_risk_checked"] = json!(account_ok);
        risk["account_positions_checked"] = json!(account_ok);
        risk["account_risk_notice"] = json!(if account_ok {
            "已核验 Demo 账户、资金占用、当日亏损、回撤和同币种仓位"
        } else {
            "Demo 账户风控尚未就绪，等待同步或对账"
        });
        risk["accounting_notice"] = accounting_notice;
        risk["blocked_reasons"] = json!(reasons);
        risk["entry_permitted"] = json!(allow);
        risk["orders_enabled"] = json!(allow);
        if risk["status"] == "ready_research" {
            risk["status"] = json!(if allow { "ready_demo" } else { "blocked_demo" });
        }
        let stage_status = risk["status"].clone();
        output["pipeline"]["stages"][2]["status"] = stage_status;
        output["trade_execution_permitted"] = json!(allow);
        output["pipeline"]["execution_action"] = if allow {
            output["pipeline"]["risk_adjusted_action"].clone()
        } else {
            json!("HOLD")
        };
        output["pipeline"]["trade_execution_permitted"] = json!(allow);
    }
}
