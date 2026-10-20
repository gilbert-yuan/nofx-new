use super::{ENTRY_MS, TREND_MS, analyze, review, support_cluster};
use crate::{iso, number, timestamp};
use serde_json::{Value, json};

const ID: &str = "martin-luk-pullback-v1";
const BASE: i64 = 1_728_000_000_000;

fn bar(at: i64, open: f64, high: f64, low: f64, close: f64) -> Value {
    json!({"openTime":iso(at),"open":open,"high":high,"low":low,
        "close":close,"volume":100,"confirmed":true})
}

fn fixture_with_tail(tail: &[[f64; 4]]) -> (Value, Value, i64) {
    let peak_end = BASE + 96 * TREND_MS;
    let now = peak_end + tail.len() as i64 * ENTRY_MS;
    let higher: Vec<Value> = (0..96)
        .map(|i| {
            let close = if i < 84 { 100. + i as f64 * 0.8 } else { 168. };
            bar(
                BASE + i * TREND_MS,
                close - 0.4,
                if i == 95 { 174. } else { close + 4. },
                close - 4.,
                close,
            )
        })
        .collect();
    let mut entry: Vec<Value> = (0..240 - tail.len())
        .map(|i| bar(now - (240 - i) as i64 * ENTRY_MS, 168., 168.4, 167.6, 168.))
        .collect();
    let anchor = peak_end - TREND_MS;
    let peak = entry
        .iter_mut()
        .find(|r| timestamp(&r["openTime"]) == Some(anchor))
        .unwrap();
    peak["high"] = json!(174.);
    peak["volume"] = json!(1.);
    for (i, &[open, high, low, close]) in tail.iter().enumerate() {
        entry.push(bar(peak_end + i as i64 * ENTRY_MS, open, high, low, close));
    }
    let market = json!({"symbol":"BTCUSDT","interval":"15m","marketProvider":"binance",
        "dataAsOf":iso(now),"klines":entry});
    let context = json!({"evaluationAt":iso(now),"params":crate::strategies::defaults(ID),
        "auxMarkets":{"4h":{"interval":"4h","klines":higher}},
        "costs":{"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3}});
    (market, context, now)
}

fn fixture() -> (Value, Value, i64) {
    fixture_with_tail(&[[168.1, 168.4, 167.6, 167.8], [167.9, 169., 167.8, 168.8]])
}

fn buy(market: &Value, context: &Value) -> Value {
    let signal = analyze(market, context);
    assert_eq!(signal["action"], "BUY", "{signal:#}");
    signal
}

#[test]
fn martin_luk_entry_band_atr_widens_the_allowed_entry_zone() {
    // The allowed entry zone is [price - band, price + band] with
    // band = min(ATR * entryBandAtr, (price - stop) * 0.1). Widening the
    // parameter must widen the zone symmetrically and move the risk/target
    // geometry with it, which is what unblocks drifted entries in replay.
    let (market, context, _now) = fixture();
    let narrow = buy(&market, &context);
    let reference = number(&narrow["plan"]["entryReference"], 0.);
    let narrow_band = number(&narrow["plan"]["entryMax"], 0.) - reference;
    assert!(narrow_band > 0., "{narrow:#}");
    assert!(
        (reference - number(&narrow["plan"]["entryMin"], 0.) - narrow_band).abs() < 1e-9,
        "{narrow:#}"
    );

    let mut wide_context = context.clone();
    wide_context["params"]["entryBandAtr"] = json!(1.0);
    let wide = buy(&market, &wide_context);
    let wide_band = number(&wide["plan"]["entryMax"], 0.) - reference;
    assert!(
        wide_band > narrow_band,
        "expected a wider zone, narrow={narrow_band} wide={wide_band}"
    );
    // A wider entry raises the reference risk distance and therefore the target.
    assert!(
        number(&wide["plan"]["riskUnit"], 0.) > number(&narrow["plan"]["riskUnit"], 0.),
        "{wide:#}"
    );
    assert!(
        number(&wide["plan"]["takeProfit"], 0.) > number(&narrow["plan"]["takeProfit"], 0.),
        "{wide:#}"
    );
    // buy() already asserts every shared guard (chase, stop distance, net R:R)
    // still passes, so a widened zone must keep the stop below the entry.
    assert!(
        number(&wide["plan"]["entryMax"], 0.) > number(&wide["plan"]["stopLoss"], 0.),
        "{wide:#}"
    );
}

fn wait_with(signal: &Value, reason: &str) {
    assert_eq!(signal["action"], "WAIT", "{signal:#}");
    assert!(signal["plan"].is_null(), "{signal:#}");
    assert!(
        signal["reason"].as_str().unwrap().contains(reason),
        "{signal:#}"
    );
}

#[test]
fn martin_luk_defaults_produce_a_long_only_first_pullback_plan() {
    let (market, context, _) = fixture();
    let signal = buy(&market, &context);
    assert_eq!(signal["metrics"]["pullbackEpisodes"], 1);
    assert_eq!(signal["trend"]["interval"], "4h");
    assert_eq!(signal["plan"]["entryStyle"], "market");
    assert_eq!(signal["plan"]["recommendedLeverage"], 1);
    assert_eq!(signal["plan"]["riskSizing"]["riskFraction"], 0.005);
    assert_eq!(signal["plan"]["riskSizing"]["maxNotionalFraction"], 0.35);
    assert_eq!(signal["plan"]["martinLukExit"]["emaPeriod"], 9);
    assert_eq!(signal["plan"]["exitRules"]["partialTp"]["enabled"], false);
    assert_eq!(signal["plan"]["exitRules"]["smartExit"]["enabled"], false);
    assert!(number(&signal["plan"]["autoMarginPct"], 0.) <= 0.35);
    assert!(number(&signal["metrics"]["netRewardRisk"], 0.) >= 2.);
}

#[test]
fn martin_luk_waits_for_strong_trend_and_confirmed_reversal() {
    let (market, mut context, _) = fixture();
    for row in context["auxMarkets"]["4h"]["klines"]
        .as_array_mut()
        .unwrap()
    {
        row["open"] = json!(168.);
        row["close"] = json!(168.);
        row["high"] = json!(172.);
        row["low"] = json!(164.);
    }
    wait_with(&analyze(&market, &context), "4h 强势趋势");

    let (mut market, context, _) = fixture();
    let latest = market["klines"].as_array_mut().unwrap().last_mut().unwrap();
    latest["open"] = json!(168.3);
    latest["high"] = json!(168.4);
    latest["close"] = json!(168.);
    wait_with(&analyze(&market, &context), "尚未阳线收复");
}

#[test]
fn martin_luk_ignores_future_and_unconfirmed_candles_in_both_timeframes() {
    let (mut market, mut context, now) = fixture();
    let expected = buy(&market, &context);
    market["klines"]
        .as_array_mut()
        .unwrap()
        .push(bar(now, 168., 999., 1., 900.));
    context["auxMarkets"]["4h"]["klines"]
        .as_array_mut()
        .unwrap()
        .push(bar(now - 2 * ENTRY_MS, 168., 999., 1., 900.));
    assert_eq!(analyze(&market, &context), expected);

    market["klines"].as_array_mut().unwrap().last_mut().unwrap()["confirmed"] = json!(false);
    context["auxMarkets"]["4h"]["klines"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["confirmed"] = json!(false);
    assert_eq!(analyze(&market, &context), expected);
}

#[test]
fn martin_luk_short_primary_feed_uses_complete_auxiliary_entry_history() {
    let (mut market, mut context, _) = fixture();
    let expected = buy(&market, &context);
    context["auxMarkets"]["15m"] = market.clone();
    market["klines"].as_array_mut().unwrap().drain(..160);
    assert_eq!(analyze(&market, &context), expected);
}

#[test]
fn martin_luk_rejects_stale_or_gapped_causal_data() {
    let (mut market, context, _) = fixture();
    market["klines"].as_array_mut().unwrap().pop();
    wait_with(&analyze(&market, &context), "行情缺失、过期");
    let (mut market, context, _) = fixture();
    market["klines"].as_array_mut().unwrap().remove(200);
    wait_with(&analyze(&market, &context), "行情缺失、过期");
}

#[test]
fn martin_luk_repeated_separate_support_contacts_are_not_a_first_pullback() {
    let (market, context, _) = fixture_with_tail(&[
        [168.1, 168.4, 167.6, 167.8],
        [170., 171., 170., 170.5],
        [168.1, 168.5, 167.6, 167.8],
        [167.9, 169., 167.8, 168.8],
    ]);
    let signal = analyze(&market, &context);
    wait_with(&signal, "已超出允许上限");
    assert_eq!(signal["metrics"]["pullbackEpisodes"], 2);

    // 放开上限后同一个形态应当可以入场（其余闸门不变）。
    let mut relaxed = context.clone();
    relaxed["params"]["maxPullbackEpisodes"] = json!(2);
    let signal = analyze(&market, &relaxed);
    assert_eq!(signal["action"], "BUY", "{signal:#}");
    assert_eq!(signal["metrics"]["pullbackEpisodes"], 2);
    assert_eq!(signal["metrics"]["maxPullbackEpisodes"], 2);
}

#[test]
fn martin_luk_wide_candle_cannot_fake_confluent_support() {
    let candle = bar(BASE, 100., 120., 80., 110.);
    assert_eq!(support_cluster(&candle, [90., 100., 110.], 0.5).len(), 1);
    assert_eq!(
        support_cluster(&candle, [100., 100.4, 110.], 0.5),
        vec![100., 100.4]
    );
}

#[test]
fn martin_luk_rejects_chasing_and_excessive_structural_stop_distance() {
    let (market, mut context, _) = fixture();
    context["params"]["maxChaseAtr"] = json!(0.1);
    wait_with(&analyze(&market, &context), "避免追涨");

    let (market, mut context, _) = fixture();
    context["params"]["minStopPct"] = json!(0.001);
    context["params"]["maxStopPct"] = json!(0.002);
    wait_with(&analyze(&market, &context), "结构止损距离超过");
}

#[test]
fn martin_luk_avwap_requires_valid_nonzero_volume() {
    let (mut market, context, _) = fixture();
    for row in market["klines"].as_array_mut().unwrap() {
        row["volume"] = json!(0.);
    }
    wait_with(&analyze(&market, &context), "等待有效成交量");

    let (mut market, context, _) = fixture();
    market["klines"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("volume");
    wait_with(&analyze(&market, &context), "行情缺失、过期");
}

#[test]
fn martin_luk_parameter_conflicts_fail_closed_and_inactive_partials_do_not_block() {
    let (market, mut context, _) = fixture();
    context["params"]["emaMedium"] = context["params"]["emaFast"].clone();
    wait_with(&analyze(&market, &context), "参数冲突");

    let (market, mut context, _) = fixture();
    context["params"]["targetR"] = json!(4.);
    context["params"]["partialTpEnabled"] = json!(false);
    buy(&market, &context);
    context["params"]["partialTpEnabled"] = json!(true);
    wait_with(&analyze(&market, &context), "参数冲突");
    let resolved = crate::strategies::resolve_params(ID, &json!({"riskPerTrade":0.02})).unwrap();
    assert_eq!(resolved["params"]["riskPerTrade"], 0.005);
    assert_eq!(resolved["rejected"][0]["key"], "riskPerTrade");
}

#[test]
fn martin_luk_ema_exit_uses_frozen_rules_and_a_complete_post_entry_bar() {
    let (mut market, context, now) = fixture();
    let signal = buy(&market, &context);
    let mut order = json!({"direction":"OPEN_LONG","entryAt":iso(now),
        "initialPlan":signal["plan"],"plan":signal["plan"]});
    // A changed current plan cannot alter the frozen entry-time exit policy.
    order["plan"]["martinLukExit"] = json!({"emaPeriod":50,"minHoldBars":20});
    let latest = market["klines"].as_array_mut().unwrap().last_mut().unwrap();
    latest["open"] = json!(168.);
    latest["close"] = json!(166.);
    latest["low"] = json!(165.8);
    assert_eq!(review(&order, &market)["action"], "HOLD");

    order["entryAt"] = json!(iso(now - ENTRY_MS));
    let proposal = review(&order, &market);
    assert_eq!(proposal["action"], "CLOSE", "{proposal:#}");
    assert!(proposal["reason"].as_str().unwrap().contains("EMA9"));
    order["entryAt"] = Value::Null;
    assert_eq!(review(&order, &market)["action"], "HOLD");
    order["entryAt"] = json!(iso(now - ENTRY_MS));
    order["initialPlan"]["martinLukExit"] = Value::Null;
    assert_eq!(review(&order, &market)["action"], "HOLD");
}

#[test]
fn martin_luk_plan_uses_shared_submission_execution_protection_and_costs() {
    let (market, context, now) = fixture();
    let mut signal = crate::research::normalize_plan(&buy(&market, &context), &market, now);
    assert_eq!(signal["eligible"], true, "{signal:#}");
    signal["strategyId"] = json!(ID);
    let record = json!({"id":"martin-luk-fixture","strategyId":ID,
        "marketProvider":"binance","analyses":[signal]});
    let mut state = json!({"initialBalance":10000,"orders":[]});
    let input = json!({"symbol":"BTCUSDT","strategyId":ID,"margin":100000,"leverage":12});
    let mut order = crate::paper::submit_paper_order(&mut state, &record, &input, now).unwrap();
    assert_eq!(order["status"], "pending");
    assert_eq!(order["leverage"], 1.);
    assert!(number(&order["notional"], 0.) <= 3500.);
    assert_eq!(order["initialPlan"]["martinLukExit"]["emaPeriod"], 9);
    assert_eq!(order["costs"]["feeBps"], 6);
    let entry_time = timestamp(&order["nextTime"]).unwrap();
    assert!(entry_time > now);
    let reference = number(&signal["plan"]["entryReference"], 0.);
    let stop = number(&signal["plan"]["stopLoss"], 0.);
    let entry_bar = bar(
        entry_time,
        reference,
        reference + 0.05,
        reference - 0.05,
        reference,
    );
    crate::paper::advance_paper_order(&mut order, &[entry_bar.clone()], entry_time + ENTRY_MS)
        .unwrap();
    assert_eq!(order["status"], "open", "{order:#}");
    assert_eq!(timestamp(&order["entryAt"]), Some(entry_time));
    let entry = number(&order["entry"], 0.);
    let quantity = number(&order["quantity"], 0.);
    let notional = number(&order["notional"], 0.);
    assert!((entry - reference * 1.0005).abs() < 1e-9);
    assert!((number(&order["entryFee"], 0.) - notional * 0.0006).abs() < 1e-9);
    let exit_bar = bar(
        entry_time + ENTRY_MS,
        reference,
        reference + 0.05,
        stop - 0.1,
        stop,
    );
    crate::paper::advance_paper_order(
        &mut order,
        &[entry_bar, exit_bar],
        entry_time + 2 * ENTRY_MS,
    )
    .unwrap();
    assert_eq!(order["status"], "closed", "{order:#}");
    assert_eq!(order["reason"], "stop_loss");
    let exit = stop * 0.9995;
    assert!((number(&order["exit"], 0.) - exit).abs() < 1e-9);
    let gross = (exit - entry) * quantity;
    let fees = (notional + exit * quantity) * 0.0006;
    let elapsed = timestamp(&order["exitAt"]).unwrap() - entry_time;
    let funding = notional * 0.0003 * elapsed as f64 / 28_800_000.;
    assert!((number(&order["net"], 0.) - (gross - fees - funding)).abs() < 1e-9);
    assert!(number(&order["net"], 0.) >= -50. - 1e-7);
}

#[test]
fn martin_luk_unfilled_order_expires_after_three_entry_bars() {
    let (market, context, now) = fixture();
    let mut signal = crate::research::normalize_plan(&buy(&market, &context), &market, now);
    signal["strategyId"] = json!(ID);
    assert_eq!(signal["pendingOrderTtlMs"], 3 * ENTRY_MS);
    let record = json!({"id":"martin-luk-expiry","strategyId":ID,
        "marketProvider":"binance","analyses":[signal]});
    let mut state = json!({"initialBalance":10000,"orders":[]});
    let input = json!({"symbol":"BTCUSDT","strategyId":ID,"margin":100,"leverage":1});
    let mut order = crate::paper::submit_paper_order(&mut state, &record, &input, now).unwrap();
    crate::paper::advance_paper_order(&mut order, &[], now + 3 * ENTRY_MS).unwrap();
    assert_eq!(order["status"], "expired", "{order:#}");
    assert_eq!(order["reason"], "pending_expired");
    assert!(order["entry"].is_null());
}

#[test]
fn martin_luk_historical_replay_submits_fills_and_exits_without_future_leakage() {
    use std::collections::BTreeMap;

    let (market, context, start) = fixture();
    let end = start + 3 * ENTRY_MS;
    let mut higher: Vec<Value> = (0..144)
        .map(|i| {
            let close = 40. + i as f64 * 0.4;
            bar(
                BASE - (144 - i) * TREND_MS,
                close,
                close + 2.,
                close - 2.,
                close,
            )
        })
        .collect();
    higher.extend(
        context["auxMarkets"]["4h"]["klines"]
            .as_array()
            .unwrap()
            .clone(),
    );
    let mut entry = market["klines"].as_array().unwrap().clone();
    entry.extend([
        bar(start, 168.8, 168.85, 168.75, 168.8),
        bar(start + ENTRY_MS, 168.8, 168.85, 167.9, 168.),
        bar(start + 2 * ENTRY_MS, 168., 168.1, 167.9, 168.),
    ]);
    let main: Vec<Value> = (0..1440 + 45)
        .map(|i| {
            let mut row = bar(start - (1440 - i) * 60_000, 168.8, 169., 168.4, 168.8);
            row["quoteVolume"] = json!(1_000_000.);
            row
        })
        .collect();
    let mut datasets = BTreeMap::from([
        ("1m".to_owned(), main),
        ("15m".to_owned(), entry),
        ("4h".to_owned(), higher),
    ]);
    // Historical exchange datasets store the candle opening timestamp as epoch ms.
    for rows in datasets.values_mut() {
        for row in rows {
            row["openTime"] = json!(timestamp(&row["openTime"]).unwrap());
        }
    }
    let config = crate::backtest::trading_config(&json!({"trader":{
        "minConfidence":0,"maxLeverage":1,"minOrderMargin":1,
        "maxPositionNotionalPct":0.35}}));
    let run = |datasets: &BTreeMap<String, Vec<Value>>| {
        crate::backtest::replay(
            "BTCUSDT",
            ID,
            &context["params"],
            datasets,
            &[],
            &config,
            start,
            end,
            10000.,
            &json!({"enabled":false}),
        )
        .unwrap()
    };
    let result = run(&datasets);
    assert!(number(&result["submitted"], 0.) > 0., "{result:#}");
    assert!(number(&result["closedTrades"], 0.) > 0., "{result:#}");
    assert_eq!(result["activeOrders"], 0, "{result:#}");
    assert_eq!(result["marketGaps"], 0, "{result:#}");
    let fill = &result["orderFills"][0];
    // The shared close API currently maps a strategy review close to its
    // existing "manual" code; timing and price below prove the EMA review path.
    assert_eq!(fill["reason"], "manual", "{fill:#}");
    assert_eq!(fill["leverage"], 1.);
    assert_eq!(timestamp(&fill["entryAt"]), Some(start + ENTRY_MS));
    assert_eq!(timestamp(&fill["exitAt"]), Some(start + 2 * ENTRY_MS));
    assert_eq!(fill["heldBars"], 1);
    assert!((number(&fill["exit"], 0.) - 168. * 0.9995).abs() < 1e-9);
    let setup = buy(&market, &context);
    assert!(number(&setup["plan"]["stopLoss"], 0.) < 167.9);
    assert!(number(&fill["fees"], 0.) > 0.);
    assert!(
        (number(&fill["net"], 0.)
            - (number(&fill["gross"], 0.)
                - number(&fill["fees"], 0.)
                - number(&fill["funding"], 0.)))
        .abs()
            < 1e-9
    );

    for (tf, rows) in &mut datasets {
        let duration = crate::interval_ms(tf).unwrap();
        let first_future = (end.div_euclid(duration) + 1) * duration;
        for i in 0..3 {
            let at = first_future + i * duration;
            let mut row = bar(at, 900., 999., 1., 950.);
            row["openTime"] = json!(at);
            rows.push(row);
        }
    }
    assert_eq!(run(&datasets), result);
}
