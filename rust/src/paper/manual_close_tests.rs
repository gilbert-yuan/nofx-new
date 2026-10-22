use super::*;
use futures::FutureExt;
use sqlx::{
    Connection, PgConnection,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::str::FromStr;

fn local_position(id: &str, margin: f64) -> Value {
    json!({
        "id": id,
        "symbol": "BTCUSDT",
        "direction": "OPEN_LONG",
        "status": "open",
        "margin": margin,
        "notional": margin * 5.,
        "quantity": margin * 5. / 100.,
        "leverage": 5.,
        "entry": 100.,
        "realizedQty": 0.
    })
}

#[test]
fn manual_paper_submission_has_no_total_order_limit_and_keeps_funding_and_symbol_guards() {
    let now = 1_800_000_000_000_i64;
    let record = json!({
        "id": "manual-entry", "marketProvider": "binance", "strategyId": crate::strategies::ACTIVE_STRATEGY_ID,
        "analyses": [{
            "symbol": "ETHUSDT", "eligible": true, "positionRecommendation": "OPEN_LONG",
            "firstEntryAt": iso(now), "interval": "1m", "strategyId": crate::strategies::ACTIVE_STRATEGY_ID,
            "plan": {"entryMin": 99., "entryMax": 101., "entryLimit": 100., "stopLoss": 90., "takeProfit": 120.}
        }]
    });
    let input = json!({"symbol": "ETHUSDT", "margin": 10., "leverage": 2});
    for count in [20, 100, 1000] {
        let orders: Vec<_> = (0..count)
            .map(|i| {
                let mut existing = local_position(&format!("existing-{i}"), 5.);
                existing["symbol"] = json!(format!("EXISTING{i}USDT"));
                existing["status"] = json!(if i % 2 == 0 { "open" } else { "pending" });
                existing
            })
            .collect();
        let mut state =
            json!({"initialBalance": 10000., "unlimitedCapital": false, "orders": orders});
        let order = submit_paper_order(&mut state, &record, &input, now)
            .expect("funded new symbols can be submitted above the old 20-order ceiling");
        assert_eq!(order["status"], "pending");
        assert_eq!(state["orders"].as_array().unwrap().len(), count + 1);
        let retry = submit_paper_order(&mut state, &record, &input, now).unwrap();
        assert_eq!(retry["id"], order["id"]);
        assert_eq!(state["orders"].as_array().unwrap().len(), count + 1);

        let mut another_record = record.clone();
        another_record["id"] = json!("another-manual-entry");
        assert!(
            submit_paper_order(&mut state, &another_record, &input, now)
                .unwrap_err()
                .to_string()
                .contains("该币种已有模拟挂单或持仓")
        );
        another_record["analyses"][0]["symbol"] = json!("LTCUSDT");
        let unfunded = json!({"symbol": "LTCUSDT", "margin": 100000., "leverage": 1});
        assert!(
            submit_paper_order(&mut state, &another_record, &unfunded, now)
                .unwrap_err()
                .to_string()
                .contains("可用余额不足")
        );
        assert_eq!(state["orders"].as_array().unwrap().len(), count + 1);
    }
}

#[test]
fn margin_threshold_is_strict_and_excludes_pending_orders() {
    for (margin, selected) in [(49.99, false), (50., false), (50.01, true)] {
        let position = local_position("position", margin);
        assert_eq!(margin_close_row(&position, 50.).is_some(), selected);
        let mut pending = position;
        pending["status"] = json!("pending");
        assert!(margin_close_row(&pending, 50.).is_none());
    }
    let mut closed = local_position("closed", 100.);
    closed["status"] = json!("closed");
    assert!(margin_close_row(&closed, 50.).is_none());
}

#[test]
fn margin_threshold_uses_remaining_margin_after_partial_realization() {
    for (original_margin, expected_margin, selected) in [(100., 50., false), (100.02, 50.01, true)]
    {
        let mut position = local_position("partial", original_margin);
        position["quantity"] = json!(1.);
        position["realizedQty"] = json!(1.);
        let rows = fused_orders(&json!({"orders": [position]}));
        let row = &rows["activeOrders"][0];
        assert!((n(row, "margin", 0.) - expected_margin).abs() < 1e-8);
        assert_eq!(margin_close_row(row, 50.).is_some(), selected);
    }
}

fn dual_environment_state(demo_margin: f64, live_margin: f64) -> Value {
    let mut shared = local_position("shared", 100.);
    shared["exchangeSync"] = json!({
        "demo": {"executedQty": 1.}, "live": {"executedQty": 1.}
    });
    let mut demo_only = local_position("demo-only", 100.);
    demo_only["exchangeSync"] = json!({"demo": {"executedQty": 1.}});
    let mut live_only = local_position("live-only", 100.);
    live_only["exchangeSync"] = json!({"live": {"executedQty": 1.}});
    let snapshot = |margin: f64| {
        json!({
            "enabled": true,
            "configured": true,
            "syncedAt": "2026-10-11T00:00:00Z",
            "positions": [{
                "symbol": "BTCUSDT",
                "positionSide": "BOTH",
                "positionAmt": margin * 2. / 100.,
                "entryPrice": 100.,
                "leverage": 2.
            }]
        })
    };
    json!({
        "orders": [shared, demo_only, live_only],
        "exchangeAccounts": {"demo": snapshot(demo_margin), "live": snapshot(live_margin)}
    })
}

#[test]
fn a_fully_exited_local_order_is_not_listed_under_the_exchange_position() {
    let mut open = local_position("open-order", 50.);
    open["exchangeSync"] = json!({"demo": {"executedQty": 240.}});
    let mut closed = local_position("closed-order", 50.);
    closed["status"] = json!("closed");
    closed["exchangeSync"] = json!({"demo": {"executedQty": 2371.}});
    // Closed locally while exchange exposure remains (orphan) — must stay referenced.
    let mut orphan = local_position("orphan-order", 50.);
    orphan["status"] = json!("closed");
    orphan["exchangeSync"] = json!({"demo": {"executedQty": 100.}});
    // A position whose only local order is already closed is a ledger difference, not a
    // contradiction: it must be flagged for reconciliation.
    let mut lost = local_position("lost-order", 50.);
    lost["symbol"] = json!("ETHUSDT");
    lost["status"] = json!("closed");
    lost["exchangeSync"] = json!({"demo": {"executedQty": 70.}});
    let snapshot = json!({
        "enabled": true,
        "configured": true,
        "syncedAt": "2026-10-17T04:00:00Z",
        "positions": [{
            "symbol": "BTCUSDT",
            "positionSide": "BOTH",
            "positionAmt": 340.,
            "entryPrice": 100.,
            "leverage": 1.
        }, {
            "symbol": "ETHUSDT",
            "positionSide": "BOTH",
            "positionAmt": 70.,
            "entryPrice": 100.,
            "leverage": 1.
        }],
        "orderMetrics": {
            "open-order": {"symbol": "BTCUSDT", "direction": "OPEN_LONG", "entryQty": 240., "filledQty": 240., "exitQty": 0., "remainingQty": 240.},
            "closed-order": {"symbol": "BTCUSDT", "direction": "OPEN_LONG", "entryQty": 2371., "filledQty": 2371., "exitQty": 2371., "remainingQty": 0.},
            "orphan-order": {"symbol": "BTCUSDT", "direction": "OPEN_LONG", "entryQty": 100., "filledQty": 100., "exitQty": 0., "remainingQty": 100.},
            "lost-order": {"symbol": "ETHUSDT", "direction": "OPEN_LONG", "entryQty": 70., "filledQty": 70., "exitQty": 0., "remainingQty": 70.}
        }
    });
    let state = json!({
        "orders": [open, closed, orphan, lost],
        "exchangeAccounts": {"demo": snapshot}
    });
    let rows = fused_orders(&state);
    let row = arr(&rows["activeOrders"])
        .into_iter()
        .find(|r| r["id"] == "fused:position:BTCUSDT:OPEN_LONG")
        .expect("exchange position row");
    assert_eq!(row["reconciliationPending"], false);
    let refs = arr(&row["localOrders"]);
    let ids: Vec<&str> = refs.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"open-order"));
    assert!(ids.contains(&"orphan-order"));
    assert!(
        !ids.contains(&"closed-order"),
        "fully exited local order must not be listed under the exchange position: {ids:?}"
    );
    let target_refs = arr(&row["executionTargets"][0]["localOrders"]);
    let target_ids: Vec<&str> = target_refs
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert!(!target_ids.contains(&"closed-order"));
    let lost_row = arr(&rows["activeOrders"])
        .into_iter()
        .find(|r| r["id"] == "fused:position:ETHUSDT:OPEN_LONG")
        .expect("orphan-only position row");
    assert_eq!(
        lost_row["reconciliationPending"], true,
        "a position whose local orders are all closed must be flagged for reconciliation"
    );
    assert_eq!(arr(&lost_row["localOrders"]).len(), 1);
}

#[test]
fn margin_selection_uses_each_environment_and_preserves_shared_small_positions() {
    let activity = fused_orders(&dual_environment_state(100., 40.));
    let row = &activity["activeOrders"][0];
    // Live supplies the displayed metrics; the larger Demo position still qualifies.
    assert_eq!(row["margin"], 40.);
    let selected = margin_close_row(row, 50.).unwrap();
    assert_eq!(selected["executionTargets"].as_array().unwrap().len(), 1);
    assert_eq!(selected["executionTargets"][0]["environment"], "demo");
    assert_eq!(selected["executionTargets"][0]["minimumCloseMargin"], 50.);
    assert_eq!(
        arr(&selected["localOrders"])
            .iter()
            .map(|reference| reference["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["demo-only"]
    );
}

#[test]
fn eligible_exposures_in_both_environments_are_selected() {
    let activity = fused_orders(&dual_environment_state(100., 60.));
    let selected = margin_close_row(&activity["activeOrders"][0], 50.).unwrap();
    assert_eq!(selected["executionTargets"].as_array().unwrap().len(), 2);
    assert_eq!(selected["localOrders"].as_array().unwrap().len(), 3);
    let activity = fused_orders(&dual_environment_state(50., 49.99));
    assert!(margin_close_row(&activity["activeOrders"][0], 50.).is_none());
}

#[test]
fn eligible_activity_is_not_truncated_after_one_hundred_positions() {
    let mut orders: Vec<_> = (0..135)
        .map(|i| local_position(&format!("eligible-{i}"), 50.01))
        .collect();
    let mut pending = local_position("pending", 500.);
    pending["status"] = json!("pending");
    orders.push(pending);
    orders.push(local_position("small", 49.99));
    let rows = fused_orders(&json!({"orders": orders}));
    let selected: Vec<_> = arr(&rows["activeOrders"])
        .iter()
        .filter_map(|row| margin_close_row(row, 50.))
        .collect();
    assert_eq!(selected.len(), 135);
    assert_eq!(selected.last().unwrap()["id"], "eligible-134");
}

#[test]
fn a_failed_manual_close_can_refresh_only_its_selected_position() {
    let mut requested = local_position("requested", 100.);
    requested["manualCloseRequested"] = json!(true);
    assert!(!should_refresh_order(&requested, None));
    assert!(should_refresh_order(&requested, Some("requested")));
    assert!(!should_refresh_order(&requested, Some("other")));
    let other = local_position("other", 100.);
    assert!(should_refresh_order(&other, None));
    assert!(!should_refresh_order(&other, Some("requested")));
    requested["status"] = json!("closed");
    assert!(!should_refresh_order(&requested, Some("requested")));
}

#[test]
fn a_completed_close_does_not_block_an_observed_quantity_reduction() {
    let previous = json!({"status": "filled", "remainingBefore": 20., "executedQty": 4.});
    for quantity in [0., 15., 16., -16.] {
        let position = json!({"positionAmt": quantity});
        assert!(!close_position_awaits_update(
            &previous,
            &position,
            &Value::Null
        ));
    }
}

#[test]
fn only_a_position_update_after_exchange_close_completion_is_new_exposure() {
    let completion = 1_791_504_000_000_i64;
    let previous = json!({
        "status": "filled", "remainingBefore": 20., "executedQty": 4.,
        "exchangeUpdatedAt": completion
    });
    for (updated_at, waiting) in [
        (completion - 1, true),
        (completion, true),
        (completion + 1, false),
    ] {
        let position = json!({"positionAmt": 20., "updateTime": updated_at});
        assert_eq!(
            close_position_awaits_update(&previous, &position, &Value::Null),
            waiting
        );
    }
}

#[test]
fn legacy_completed_close_uses_confirmed_exchange_order_time() {
    let completion = 1_791_504_000_000_i64;
    let previous = json!({
        "status": "filled", "remainingBefore": 1521.6, "executedQty": 1521.6,
        "createdAt": iso(completion - 10_000), "updatedAt": iso(completion - 5_000)
    });
    let confirmed_order = json!({"status": "FILLED", "updateTime": completion});
    // The old close consumed its position; this smaller, later position belongs to a new cycle.
    let reopened = json!({"positionAmt": 70.1, "updateTime": completion + 86_400_000});
    assert!(!close_position_awaits_update(
        &previous,
        &reopened,
        &confirmed_order
    ));
    let stale = json!({"positionAmt": 1521.6, "updateTime": completion});
    assert!(close_position_awaits_update(
        &previous,
        &stale,
        &confirmed_order
    ));
}

#[test]
fn missing_exchange_timestamps_keep_duplicate_close_protection() {
    let completion = 1_791_504_000_000_i64;
    let legacy = json!({
        "status": "filled", "remainingBefore": 45., "executedQty": 45.,
        "createdAt": iso(completion - 86_400_000), "updatedAt": iso(completion - 1)
    });
    let position = json!({"positionAmt": 3011.7, "updateTime": completion + 1});
    assert!(close_position_awaits_update(
        &legacy,
        &position,
        &Value::Null
    ));
    for unknown in [Value::Null, json!(0), json!(-1), json!("invalid")] {
        let mut previous = legacy.clone();
        previous["exchangeUpdatedAt"] = unknown;
        assert!(close_position_awaits_update(
            &previous,
            &position,
            &Value::Null
        ));
    }
    let previous = json!({
        "status": "filled", "remainingBefore": 45., "executedQty": 45.,
        "exchangeUpdatedAt": completion
    });
    assert!(close_position_awaits_update(
        &previous,
        &json!({"positionAmt": 3011.7}),
        &Value::Null
    ));
}

#[test]
fn persisted_exchange_completion_time_takes_precedence_over_an_older_confirmation() {
    let completion = 1_791_504_000_000_i64;
    let previous = json!({
        "status": "filled", "remainingBefore": 20., "executedQty": 20.,
        "exchangeUpdatedAt": completion
    });
    let position = json!({"positionAmt": -10., "updateTime": completion - 1});
    let confirmation = json!({"status": "FILLED", "updateTime": completion - 1000});
    assert!(close_position_awaits_update(
        &previous,
        &position,
        &confirmation
    ));
}

#[tokio::test]
#[ignore = "requires local PostgreSQL; uses a disposable database and cached candles, no exchange requests"]
async fn failed_local_close_refreshes_and_margin_batch_has_no_count_limit() -> Result<()> {
    let _ = dotenvy::from_path(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env"));
    let options = if let Ok(url) = std::env::var("DATABASE_URL") {
        PgConnectOptions::from_str(&url)?
    } else {
        PgConnectOptions::new()
            .host(&std::env::var("PGHOST").unwrap_or("127.0.0.1".into()))
            .port(
                std::env::var("PGPORT")
                    .ok()
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(5432),
            )
            .database(&std::env::var("PGDATABASE").unwrap_or("nofx_lite".into()))
            .username(&std::env::var("PGUSER").unwrap_or("postgres".into()))
            .password(&std::env::var("PGPASSWORD").unwrap_or_default())
    };
    let mut admin = PgConnection::connect_with(&options).await?;
    let name = format!("nofx_rust_test_{}", uuid::Uuid::new_v4().simple());
    assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    sqlx::query(&format!("CREATE DATABASE \"{name}\""))
        .execute(&mut admin)
        .await?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(options.database(&name))
        .await?;
    let db = Db::from_pool(pool);
    let result = std::panic::AssertUnwindSafe(run_cached_manual_close(&db))
        .catch_unwind()
        .await;
    db.pool.close().await;
    sqlx::query(&format!("DROP DATABASE \"{name}\" WITH (FORCE)"))
        .execute(&mut admin)
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn run_cached_manual_close(db: &Db) -> Result<()> {
    db.init().await?;
    let root = tempfile::tempdir()?;
    let store = Store::new(root.path().join("data")).await?;
    // Empty credentials ensure exchange-refresh performs no remote reads or writes.
    store.write("config", &json!({"binance": {}})).await?;
    let duration = interval_ms("1d").unwrap();
    let current = now_ms().div_euclid(duration) * duration;
    let previous = current - duration;
    db.save_klines(
        "BINANCE_BTCUSDT",
        "1d",
        &[json!({
            "openTime": previous,
            "open": 100., "high": 102., "low": 99., "close": 101.,
            "closeTime": current - 1,
            "volume": 1., "quoteVolume": 100., "tradeCount": 1
        })],
    )
    .await?;
    let cached_position = |id: &str, margin: f64| {
        let mut order = local_position(id, margin);
        patch(
            &mut order,
            &json!({
                "interval": "1d", "marketProvider": "binance",
                "createdAt": iso(previous), "entryAt": iso(previous),
                "nextTime": previous, "markAt": iso(previous), "markPrice": 70.,
                "manualCloseRequested": true, "error": "旧行情等待更新",
                "plan": {
                    "stopLoss": 90., "takeProfit": 120., "maxHoldBars": 1000,
                    "exitRules": {
                        "partialTp": {"enabled": false},
                        "trailing": {"enabled": false},
                        "smartExit": {"enabled": false}
                    }
                },
                "costs": {"feeBps": 6., "slippageBps": 5., "fundingBpsPer8h": 0.}
            }),
        );
        order
    };
    let requested = cached_position("previously-failed", 100.);
    let other = cached_position("untouched", 100.);
    db.mutate_account(|state| {
        state["orders"] = json!([requested, other.clone()]);
        state["entriesPaused"] = json!(false);
        Ok(Value::Null)
    })
    .await?;
    let result = close_internal(db, &store, "previously-failed", false, None, false).await?;
    assert_eq!(result["ok"], true);
    let state = db.account(false, None).await?;
    let requested = arr(&state["orders"])
        .into_iter()
        .find(|order| order["id"] == "previously-failed")
        .unwrap();
    assert_eq!(requested["status"], "closed");
    assert_eq!(requested["reason"], "manual");
    assert_eq!(timestamp(&requested["markAt"]), Some(current));
    assert!(n(&requested, "exit", 0.) > 100.);
    let untouched = arr(&state["orders"])
        .into_iter()
        .find(|order| order["id"] == "untouched")
        .unwrap();
    assert_eq!(untouched["status"], "open");
    assert_eq!(untouched["markAt"], other["markAt"]);
    assert_eq!(untouched["nextTime"], other["nextTime"]);

    let mut orders: Vec<_> = (0..101)
        .map(|i| cached_position(&format!("batch-{i}"), 50.01))
        .collect();
    orders.push(cached_position("boundary", 50.));
    orders.push(cached_position("below", 49.99));
    let mut pending = cached_position("pending", 500.);
    pending["status"] = json!("pending");
    orders.push(pending);
    db.mutate_account(|state| {
        state["orders"] = json!(orders);
        Ok(Value::Null)
    })
    .await?;
    let result = close_above_margin(db, &store, &json!({"minimumMargin": 50.})).await?;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["results"].as_array().unwrap().len(), 101);
    let state = db.account(false, None).await?;
    assert_eq!(state["entriesPaused"], false);
    let orders = arr(&state["orders"]);
    assert_eq!(
        orders
            .iter()
            .filter(|order| order["status"] == "closed")
            .count(),
        101
    );
    for (id, status) in [
        ("boundary", "open"),
        ("below", "open"),
        ("pending", "pending"),
    ] {
        assert_eq!(
            orders.iter().find(|order| order["id"] == id).unwrap()["status"],
            status
        );
    }
    Ok(())
}

/// An entry the exchange cancelled with no fill has to stop counting as an active order:
/// otherwise it holds its margin reservation and re-appears in every bulk close.
#[test]
fn dormant_exchange_entry_only_matches_remote_dead_entries_without_fills() {
    let link = |status: &str, executed: f64, order_id: Option<u64>| json!({"status":status,"executedQty":executed,"orderId":order_id});
    let pending = json!({"status":"pending"});
    assert!(dormant_exchange_entry(
        &pending,
        &link("canceled", 0., Some(343935677))
    ));
    assert!(dormant_exchange_entry(
        &pending,
        &link("expired", 0., Some(343935677))
    ));
    assert!(dormant_exchange_entry(
        &pending,
        &link("rejected", 0., Some(343935677))
    ));
    // A cancelled entry that partially filled is a position, not a dead row.
    assert!(!dormant_exchange_entry(
        &pending,
        &link("canceled", 12.5, Some(343935677))
    ));
    // Still resting on the book.
    assert!(!dormant_exchange_entry(
        &pending,
        &link("new", 0., Some(343935677))
    ));
    // Never reached the exchange: nothing there to retire.
    assert!(!dormant_exchange_entry(
        &pending,
        &link("canceled", 0., None)
    ));
    assert!(!dormant_exchange_entry(
        &pending,
        &json!({"status":"not_submitted"})
    ));
    // Rows that already moved on are somebody else's business.
    for status in ["open", "closed", "expired", "cancelled"] {
        assert!(!dormant_exchange_entry(
            &json!({"status":status}),
            &link("canceled", 0., Some(343935677))
        ));
    }
}
