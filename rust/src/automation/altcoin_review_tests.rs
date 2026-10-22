use super::*;

#[test]
fn deleted_entry_algorithms_still_have_read_only_review_metadata() {
    let generic = json!({"interval":"1h","plan":{"stopLoss":95.,"takeProfit":120.}});
    let definition = review_definition(&generic, "legacy-removed");
    assert_eq!(definition["planInterval"], "1h");
    assert_eq!(definition["needsAux"], json!([]));
    assert_eq!(review_market_window(&generic, &definition, "1h", false), 80);
    let trend = json!({"interval":"1m","plan":{"altcoinTrend":{"parameters":{
        "emaSlow":90,"channelPeriod":10}}}});
    let definition = review_definition(&trend, "legacy-breakout");
    assert_eq!(definition["planInterval"], "4h");
    assert_eq!(definition["needsAux"], json!(["4h"]));
    assert!(review_market_window(&trend, &definition, "4h", true) >= 180);
}

const FOUR_HOURS: i64 = 14_400_000;

fn order() -> Value {
    json!({"status":"open","direction":"OPEN_LONG","interval":"4h",
        "entryAt":FOUR_HOURS,"plan":{"stopLoss":95.,"takeProfit":10000.,
        "takeProfitEnabled":false,"altcoinTrend":{"parameters":{"emaSlow":90,"channelPeriod":10}}},
        "initialPlan":{"stopLoss":95.},"protectionRevisions":[]})
}

fn state(at: i64, high: f64, low: f64) -> Value {
    json!({"highestClose":high,"lowestClose":low,"lastReviewAt":at})
}

#[test]
fn altcoin_review_requests_full_frozen_indicator_window() {
    let mut order = order();
    let definition = json!({"engine":"altcoin-trend","marketWindows":{"4h":300}});
    assert_eq!(review_market_window(&order, &definition, "4h", false), 300);
    order["plan"]["altcoinTrend"]["parameters"]["emaSlow"] = json!(480);
    assert_eq!(review_market_window(&order, &definition, "4h", false), 480);
    order["plan"]["altcoinTrend"]["parameters"]["minBars"] = json!(600);
    assert_eq!(review_market_window(&order, &definition, "4h", true), 600);
    assert_eq!(review_market_window(&order, &json!({}), "4h", false), 600);
    assert_eq!(review_market_window(&order, &definition, "15m", false), 80);
    assert_eq!(
        review_market_window(&json!({}), &json!({}), "4h", false),
        80
    );
}

#[test]
fn held_review_persists_extremes_and_rejects_time_or_extreme_regression() {
    let mut order = order();
    let now = 3 * FOUR_HOURS + 2_000;
    let first = state(2 * FOUR_HOURS, 105., 99.);
    apply_protection(
        &mut order,
        &json!({"action":"HOLD","altcoinTrendState":first}),
        &json!({}),
        now,
    )
    .unwrap();
    assert_eq!(order["altcoinTrendState"], first);
    for invalid in [
        state(FOUR_HOURS, 106., 98.),
        state(3 * FOUR_HOURS, 104., 98.),
        state(3 * FOUR_HOURS, 106., 100.),
        state(4 * FOUR_HOURS, 106., 98.),
        state(3 * FOUR_HOURS + 1, 106., 98.),
        state(2 * FOUR_HOURS, 106., 98.),
        state(3 * FOUR_HOURS, 98., 106.),
    ] {
        assert!(!persist_altcoin_review_state(
            &mut order,
            &json!({"action":"HOLD","altcoinTrendState":invalid}),
            now,
        ));
        assert_eq!(order["altcoinTrendState"], first);
    }
    let next = state(3 * FOUR_HOURS, 106., 98.);
    assert!(persist_altcoin_review_state(
        &mut order,
        &json!({"altcoinTrendState":next}),
        now,
    ));
    assert_eq!(order["altcoinTrendState"], next);
}

#[test]
fn altcoin_stop_uses_completed_boundary_and_records_actual_application_time() {
    let mut order = order();
    // The disabled target is intentionally behind price: it must not gate the stop.
    order["plan"]["takeProfit"] = json!(100.);
    let now = 2 * FOUR_HOURS + 7_000;
    apply_protection(
        &mut order,
        &json!({"action":"UPDATE_PROTECTION","stopLoss":100.,"takeProfit":100.,
            "altcoinTrendState":state(2 * FOUR_HOURS,105.,101.)}),
        &json!({"klines":[{"close":105.}]}),
        now,
    )
    .unwrap();
    assert_eq!(order["plan"]["stopLoss"], 100.);
    let revision = &order["protectionRevisions"][0];
    assert_eq!(revision["effectiveFrom"], 2 * FOUR_HOURS);
    assert_eq!(timestamp(&revision["at"]), Some(now));
    assert_eq!(timestamp(&revision["actualAt"]), Some(now));
    assert_eq!(order["plan"]["takeProfitEnabled"], false);
}

#[test]
fn invalid_altcoin_state_cannot_modify_stop_and_close_can_save_valid_state() {
    let mut order = order();
    let now = 2 * FOUR_HOURS + 1_000;
    apply_protection(
        &mut order,
        &json!({"action":"UPDATE_PROTECTION","stopLoss":100.,"takeProfit":10000.,
            "altcoinTrendState":state(3 * FOUR_HOURS,105.,101.)}),
        &json!({"klines":[{"close":105.}]}),
        now,
    )
    .unwrap();
    assert_eq!(order["plan"]["stopLoss"], 95.);
    assert!(order["protectionRevisions"].as_array().unwrap().is_empty());
    let next = state(2 * FOUR_HOURS, 105., 101.);
    assert!(persist_altcoin_review_state(
        &mut order,
        &json!({"action":"CLOSE","altcoinTrendState":next}),
        now,
    ));
    assert_eq!(order["altcoinTrendState"], next);
}

#[test]
fn historical_generic_plans_keep_the_target_guard_and_next_period_effective_time() {
    let mut order = json!({"direction":"OPEN_LONG","interval":"4h",
        "plan":{"stopLoss":95.,"takeProfit":120.,"takeProfitEnabled":false},
        "initialPlan":{"stopLoss":95.},"protectionRevisions":[]});
    let now = 2 * FOUR_HOURS + 1_000;
    apply_protection(
        &mut order,
        &json!({"action":"UPDATE_PROTECTION","stopLoss":100.,"takeProfit":120.}),
        &json!({"klines":[{"close":105.}]}),
        now,
    )
    .unwrap();
    assert_eq!(order["plan"]["stopLoss"], 100.);
    assert_eq!(
        order["protectionRevisions"][0]["effectiveFrom"],
        3 * FOUR_HOURS
    );
    assert!(order["altcoinTrendState"].is_null());
    apply_protection(
        &mut order,
        &json!({"action":"UPDATE_PROTECTION","stopLoss":101.,"takeProfit":100.}),
        &json!({"klines":[{"close":105.}]}),
        now,
    )
    .unwrap();
    assert_eq!(order["plan"]["stopLoss"], 100.);
    assert_eq!(order["protectionRevisions"].as_array().unwrap().len(), 1);
}
