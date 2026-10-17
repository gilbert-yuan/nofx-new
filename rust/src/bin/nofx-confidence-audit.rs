//! Read-only calibration of the classifier's stated probability against outcomes.
//!
//! The confidence floor (`trader.minConfidence`) only means something if a higher
//! probability actually predicts a better trade. This tool answers that with the
//! recorded orders rather than with an assumption: every closed model order that
//! still carries `analysisContext.confidence` is bucketed, and each bucket reports
//! its realized win rate and net expectancy in basis points of notional.
//!
//! Read-only: opens the account with the full extension set, never writes.
use anyhow::{Context, Result};
use nofx_core::{db::Db, number, timestamp};
use serde_json::{Value, json};
use std::path::PathBuf;

const STRATEGY: &str = "chronos-lightgbm-v1";
const EDGES: [f64; 7] = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 1.01];

fn main() -> Result<()> {
    let mut out = PathBuf::from("output");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--out" {
            out = PathBuf::from(args.next().context("--out 需要目录")?);
        }
    }
    std::fs::create_dir_all(&out)?;
    tokio::runtime::Runtime::new()?.block_on(run(out))
}

async fn run(out: PathBuf) -> Result<()> {
    let db = Db::connect().await?;
    // light=false: closed orders keep the trimmed analysisContext, but the underlying
    // extension rows are still there, so the full read is the only way to recover p.
    let state = db.account(false, None).await?;
    let orders = state["orders"].as_array().cloned().unwrap_or_default();

    let mut closed: Vec<(f64, f64, i64)> = vec![]; // (p, net_bps, exit_ms)
    let mut open_p: Vec<f64> = vec![];
    for order in &orders {
        if order["strategyId"] != STRATEGY && order["analysisContext"]["strategyId"] != STRATEGY {
            continue;
        }
        let confidence = number(&order["analysisContext"]["confidence"], f64::NAN);
        let status = order["status"].as_str().unwrap_or("");
        if matches!(status, "pending" | "open") {
            if confidence.is_finite() {
                open_p.push(confidence);
            }
            continue;
        }
        if status != "closed" {
            continue;
        }
        let notional = number(&order["notional"], 0.);
        let net = number(&order["net"], f64::NAN);
        if !confidence.is_finite() || notional <= 0. || !net.is_finite() {
            continue;
        }
        closed.push((
            confidence,
            net / notional * 10_000.,
            timestamp(&order["exitAt"]).unwrap_or(0),
        ));
    }

    let mut buckets = vec![];
    for window in EDGES.windows(2) {
        let (low, high) = (window[0], window[1]);
        let rows: Vec<&(f64, f64, i64)> = closed
            .iter()
            .filter(|(p, _, _)| *p >= low && *p < high)
            .collect();
        if rows.is_empty() {
            continue;
        }
        let wins = rows.iter().filter(|(_, bps, _)| *bps > 0.).count();
        let win_sum: f64 = rows.iter().filter(|(_, b, _)| *b > 0.).map(|(_, b, _)| b).sum();
        let loss_sum: f64 = rows.iter().filter(|(_, b, _)| *b <= 0.).map(|(_, b, _)| b).sum();
        let losses = rows.len() - wins;
        let win_rate = wins as f64 / rows.len() as f64;
        let avg_win = if wins > 0 { win_sum / wins as f64 } else { 0. };
        let avg_loss = if losses > 0 { loss_sum / losses as f64 } else { 0. };
        buckets.push(json!({
            "from": low, "to": high,
            "trades": rows.len(),
            "share_pct": (rows.len() as f64 / closed.len() as f64 * 10000.).round() / 100.,
            "win_rate": (win_rate * 1000.).round() / 1000.,
            "avg_win_bps": avg_win.round(),
            "avg_loss_bps": avg_loss.round(),
            "expectancy_bps": (win_rate * avg_win + (1. - win_rate) * avg_loss).round(),
        }));
    }

    // Cumulative view: what a floor at each edge would have produced above it.
    let mut floors = vec![];
    for low in EDGES.iter().take(EDGES.len() - 1) {
        let rows: Vec<&(f64, f64, i64)> = closed.iter().filter(|(p, _, _)| p >= low).collect();
        if rows.len() < 10 {
            continue;
        }
        let wins = rows.iter().filter(|(_, b, _)| *b > 0.).count();
        let win_rate = wins as f64 / rows.len() as f64;
        let avg_win = if wins > 0 {
            rows.iter().filter(|(_, b, _)| *b > 0.).map(|(_, b, _)| b).sum::<f64>() / wins as f64
        } else {
            0.
        };
        let losses = rows.len() - wins;
        let avg_loss = if losses > 0 {
            rows.iter().filter(|(_, b, _)| *b <= 0.).map(|(_, b, _)| b).sum::<f64>()
                / losses as f64
        } else {
            0.
        };
        floors.push(json!({
            "floor": low, "trades": rows.len(),
            "win_rate": (win_rate * 1000.).round() / 1000.,
            "expectancy_bps": (win_rate * avg_win + (1. - win_rate) * avg_loss).round(),
        }));
    }

    open_p.sort_by(f64::total_cmp);
    let quantile = |q: f64| {
        if open_p.is_empty() {
            f64::NAN
        } else {
            open_p[((open_p.len() as f64 - 1.) * q).round() as usize]
        }
    };
    let report = json!({
        "strategy": STRATEGY,
        "read_only": true,
        "closed_with_confidence": closed.len(),
        "open_signals": open_p.len(),
        "emitted_distribution": {
            "min": open_p.first().copied().unwrap_or(f64::NAN),
            "p50": quantile(0.5), "p75": quantile(0.75), "p90": quantile(0.9),
            "max": open_p.last().copied().unwrap_or(f64::NAN),
        },
        "buckets": buckets,
        "floors": floors,
    });
    let path = out.join("confidence-calibration.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&report)?)?;

    println!("已平仓且带置信度：{} 笔；在场信号：{} 个", closed.len(), open_p.len());
    println!(
        "在场信号分位：p50={:.3} p75={:.3} p90={:.3} max={:.3}",
        quantile(0.5),
        quantile(0.75),
        quantile(0.9),
        open_p.last().copied().unwrap_or(f64::NAN)
    );
    println!("\n按置信度分桶（净收益 bps，已含手续费/资金费）：");
    for b in &buckets {
        println!(
            "  [{:.2},{:.2})  n={:3}  占比 {:5.1}%  胜率 {:5.1}%  均盈 {:5.0}  均亏 {:5.0}  期望 {:6.0}",
            number(&b["from"], 0.),
            number(&b["to"], 0.),
            b["trades"],
            number(&b["share_pct"], 0.),
            number(&b["win_rate"], 0.) * 100.,
            number(&b["avg_win_bps"], 0.),
            number(&b["avg_loss_bps"], 0.),
            number(&b["expectancy_bps"], 0.),
        );
    }
    println!("\n若把门槛设在下列位置（只统计门槛以上的单）：");
    for f in &floors {
        println!(
            "  >= {:.2}  剩 {:3} 笔  胜率 {:5.1}%  期望 {:6.0}bps",
            number(&f["floor"], 0.),
            f["trades"],
            number(&f["win_rate"], 0.) * 100.,
            number(&f["expectancy_bps"], 0.),
        );
    }
    println!("\n清单：{}", path.display());
    Ok(())
}

#[allow(dead_code)]
fn _assert_value(_: &Value) {}
