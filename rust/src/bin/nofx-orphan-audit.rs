//! Read-only attribution for exchange positions that no local order manages.
//!
//! The demo account accumulated positions the ledger has no plan for. They are not
//! governed by the frozen 11-bar exit, never appear in the strategy's PnL, and
//! they consume the capacity buffer the strategy needs. This tool classifies every
//! such position against local history so a human can decide what to close.
//!
//! It never writes to the database, the exchange or the running service.
use anyhow::{Context, Result};
use nofx_core::{db::Db, iso, now_ms, number};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut out = PathBuf::from("output");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--out" {
            out = PathBuf::from(args.next().context("--out 需要目录")?);
        }
    }
    std::fs::create_dir_all(&out)?;
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(run(out))
}

async fn run(out: PathBuf) -> Result<()> {
    let db = Db::connect().await?;
    let state = db.account(true, None).await?;
    let demo = &state["exchangeAccounts"]["demo"];
    let positions = demo["positions"]
        .as_array()
        .context("Demo 持仓未同步，无法审计")?;
    let orders = state["orders"].as_array().cloned().unwrap_or_default();
    let synced_at = demo["syncedAt"].as_str().unwrap_or("");

    // Every symbol that ever appeared locally, with the facts needed to attribute it.
    let mut history: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for order in &orders {
        if let Some(symbol) = order["symbol"].as_str() {
            history.entry(symbol.to_owned()).or_default().push(order);
        }
    }
    let open: BTreeSet<String> = orders
        .iter()
        .filter(|o| matches!(o["status"].as_str(), Some("pending" | "open")))
        .filter_map(|o| o["symbol"].as_str().map(str::to_owned))
        .collect();

    let mut rows = vec![];
    for position in positions {
        let symbol = position["symbol"].as_str().unwrap_or("").to_owned();
        if symbol.is_empty() || open.contains(&symbol) {
            continue;
        }
        let quantity = number(&position["positionAmt"], 0.);
        let notional = number(&position["notional"], 0.).abs();
        if quantity == 0. || notional == 0. {
            continue;
        }
        let local = history.get(&symbol);
        let closed_locally = local.is_some_and(|list| {
            list.iter()
                .any(|o| o["status"] == "closed" && o["source"] != "binance-demo")
        });
        let attempted = local.is_some_and(|list| {
            list.iter().any(|o| {
                matches!(o["status"].as_str(), Some("expired" | "cancelled"))
                    || !o["error"].as_str().unwrap_or("").is_empty()
            })
        });
        let attribution = if closed_locally {
            "closed_locally_but_still_on_exchange"
        } else if attempted {
            "entry_attempted_never_filled"
        } else if local.is_some() {
            "traceable_local_record"
        } else {
            "never_in_local_records"
        };
        let first_seen = local.and_then(|list| {
            list.iter()
                .filter_map(|o| o["createdAt"].as_str())
                .min()
                .map(str::to_owned)
        });
        let holding_days = first_seen
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| (now_ms() - t.timestamp_millis()) as f64 / 86_400_000.);
        rows.push(json!({
            "symbol": symbol,
            "side": if quantity > 0. { "LONG" } else { "SHORT" },
            "quantity": quantity,
            "entry": number(&position["entryPrice"], 0.),
            "mark": number(&position["markPrice"], 0.),
            "notional_usdt": notional.round2(),
            "unrealized_usdt": number(&position["unrealized"], 0.).round2(),
            "leverage": number(&position["leverage"], 1.),
            "attribution": attribution,
            "local_orders": local.map(Vec::len).unwrap_or(0),
            "first_local_record": first_seen,
            "holding_days": holding_days.map(|d| (d * 10.).round() / 10.),
            "last_exchange_update": position["updateTime"],
        }));
    }
    rows.sort_by(|a, b| {
        number(&b["notional_usdt"], 0.).total_cmp(&number(&a["notional_usdt"], 0.))
    });

    let mut by_attribution: BTreeMap<String, (usize, f64, f64)> = BTreeMap::new();
    for row in &rows {
        let entry = by_attribution
            .entry(row["attribution"].as_str().unwrap_or("").to_owned())
            .or_default();
        entry.0 += 1;
        entry.1 += number(&row["notional_usdt"], 0.);
        entry.2 += number(&row["unrealized_usdt"], 0.);
    }
    let total_notional: f64 = rows.iter().map(|r| number(&r["notional_usdt"], 0.)).sum();
    let total_unrealized: f64 = rows.iter().map(|r| number(&r["unrealized_usdt"], 0.)).sum();
    let equity = number(
        &nofx_core::paper::account_summary(&state, now_ms())["equity"],
        0.,
    );
    let report = json!({
        "generated_at": iso(now_ms()),
        "exchange_synced_at": synced_at,
        "read_only": true,
        "exchange_positions": positions.len(),
        "locally_managed_symbols": open.len(),
        "orphan_positions": rows.len(),
        "orphan_notional_usdt": total_notional.round2(),
        "orphan_unrealized_usdt": total_unrealized.round2(),
        "equity_usdt": equity.round2(),
        "orphan_share_of_equity_pct": if equity > 0. { (total_notional / equity * 100.).round2()} else { 0. },
        "by_attribution": by_attribution.iter().map(|(k,(n,notional,pnl))| json!({"attribution":k,"count":n,"notional_usdt":notional.round2(),"unrealized_usdt":pnl.round2()})).collect::<Vec<_>>(),
        "positions": rows,
    });
    let path = out.join(format!(
        "orphan-audit-{}.json",
        iso(now_ms()).replace([':', '.'], "-")
    ));
    std::fs::write(&path, serde_json::to_vec_pretty(&report)?)?;

    println!(
        "孤儿仓 {} 个，名义 {:.0}U，浮盈亏 {:+.2}U，占权益 {:.1}%",
        rows.len(),
        total_notional,
        total_unrealized,
        if equity > 0. {
            total_notional / equity * 100.
        } else {
            0.
        }
    );
    for (attribution, (count, notional, pnl)) in &by_attribution {
        println!("  {attribution:36} {count:3} 个  名义 {notional:8.0}U  浮盈亏 {pnl:+7.2}U");
    }
    println!("清单：{}", path.display());
    Ok(())
}

trait Round2 {
    fn round2(self) -> f64;
}
impl Round2 for f64 {
    fn round2(self) -> f64 {
        (self * 100.).round() / 100.
    }
}
