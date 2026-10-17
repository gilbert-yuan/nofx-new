//! Read-only, post-hoc attribution of saved replay orders; never a new backtest.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::ml_optimization_metrics::Aggregate;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    about = "Reconcile and describe existing holdout replay orders without fitting or trading"
)]
struct Args {
    #[arg(long, default_value = "output/ml-rolling-20261016")]
    run_dir: PathBuf,
    /// Must be a new directory; existing output is never overwritten.
    #[arg(long)]
    output_dir: Option<PathBuf>,
}

#[derive(Default, Serialize)]
struct Totals {
    closed_trades: usize,
    wins: usize,
    losses: usize,
    net_pnl_usdt: f64,
    gross_after_fill_slippage_usdt: f64,
    fees_usdt: f64,
    funding_usdt: f64,
    slippage_usdt: f64,
    isolated_loss_adjustment_usdt: f64,
    winning_net_usdt: f64,
    losing_net_usdt: f64,
}
impl Totals {
    fn add(&mut self, order: &Self) {
        self.closed_trades += order.closed_trades;
        self.wins += order.wins;
        self.losses += order.losses;
        self.net_pnl_usdt += order.net_pnl_usdt;
        self.gross_after_fill_slippage_usdt += order.gross_after_fill_slippage_usdt;
        self.fees_usdt += order.fees_usdt;
        self.funding_usdt += order.funding_usdt;
        self.slippage_usdt += order.slippage_usdt;
        self.isolated_loss_adjustment_usdt += order.isolated_loss_adjustment_usdt;
        self.winning_net_usdt += order.winning_net_usdt;
        self.losing_net_usdt += order.losing_net_usdt;
    }
}
fn number(v: &Value, key: &str) -> Result<f64> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .with_context(|| format!("Missing/invalid finite {key}"))
}
fn count(v: &Value, key: &str) -> Result<usize> {
    usize::try_from(
        v[key]
            .as_u64()
            .with_context(|| format!("Missing/invalid count {key}"))?,
    )
    .context("Count overflow")
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .with_context(|| format!("Missing/empty {key}"))
}
fn close(actual: f64, expected: f64, label: &str) -> Result<()> {
    ensure!(
        (actual - expected).abs() <= 1e-7 + 1e-9 * expected.abs(),
        "Reconciliation failed for {label}: {actual} != {expected}"
    );
    Ok(())
}
fn order_totals(order: &Value) -> Result<Totals> {
    let costs = &order["incurred_costs"];
    ensure!(
        costs["slippage_in_fill_prices"] == true && costs["slippage_deducted_again"] == false,
        "Unrecognized slippage accounting"
    );
    let net = number(order, "net")?;
    let gross = number(order, "gross")?;
    let fees = number(costs, "fees_usdt")?;
    let funding = number(costs, "funding_usdt")?;
    let slippage = number(costs, "slippage_usdt")?;
    let adjustment = number(order, "isolatedLossAdjustment")?;
    ensure!(fees >= 0. && slippage >= 0., "Negative fees/slippage");
    close(
        net,
        gross - fees - funding + adjustment,
        "closed order net = gross - fees - funding + isolated adjustment",
    )?;
    // gross/net already include partial exits. realizedGross/realizedNet must not be added.
    Ok(Totals {
        closed_trades: 1,
        wins: usize::from(net > 0.),
        losses: usize::from(net < 0.),
        net_pnl_usdt: net,
        gross_after_fill_slippage_usdt: gross,
        fees_usdt: fees,
        funding_usdt: funding,
        slippage_usdt: slippage,
        isolated_loss_adjustment_usdt: adjustment,
        winning_net_usdt: net.max(0.),
        losing_net_usdt: net.min(0.),
    })
}

#[derive(Default, Serialize)]
struct Attribution {
    total: Totals,
    by_direction: BTreeMap<String, Totals>,
    by_exit_reason: BTreeMap<String, Totals>,
    by_symbol: BTreeMap<String, Totals>,
    by_exit_date_utc: BTreeMap<String, Totals>,
    by_selected_direction_probability: BTreeMap<String, Totals>,
}
fn submitted_signals(replay: &Value) -> Result<BTreeMap<String, &Value>> {
    let signals = replay["signal_log"]
        .as_array()
        .context("Missing signal_log array")?;
    ensure!(
        signals.len() == count(&replay["metrics"], "signals")?,
        "Signal count mismatch"
    );
    let mut submitted = BTreeMap::new();
    for signal in signals.iter().filter(|v| v["outcome"] == "submitted") {
        let id = text(signal, "order_id")?;
        ensure!(
            submitted.insert(id.to_owned(), signal).is_none(),
            "Duplicate submitted order_id {id}"
        );
    }
    Ok(submitted)
}
fn attribute_replay(
    replay: &Value,
    all: &mut Attribution,
    ids: &mut BTreeSet<String>,
) -> Result<()> {
    let symbol = text(replay, "symbol")?;
    ensure!(
        !all.by_symbol.contains_key(symbol),
        "Duplicate replay symbol {symbol}"
    );
    let metrics = &replay["metrics"];
    ensure!(
        count(metrics, "unresolved_orders")? == 0,
        "Cannot reconcile unfinished replay {symbol}"
    );
    let orders = replay["orders"]
        .as_array()
        .context("Missing orders array")?;
    let mut signals = submitted_signals(replay)?;
    ensure!(
        orders.len() == count(metrics, "submitted_orders")? && orders.len() == signals.len(),
        "Missing or extra orders for {symbol}"
    );
    let mut total = Totals::default();
    for order in orders {
        let id = text(order, "id")?;
        ensure!(ids.insert(id.to_owned()), "Duplicate order id {id}");
        let signal = signals
            .remove(id)
            .with_context(|| format!("Missing submitted signal for {id}"))?;
        ensure!(
            text(order, "symbol")? == symbol,
            "Order/replay symbol mismatch"
        );
        if text(order, "status")? != "closed" {
            // Zero-cost expired/unfilled orders cannot contribute realized PnL.
            let entry = order.get("entry").context("Missing expired entry")?;
            ensure!(
                order["status"] == "expired" && (entry.is_null() || entry.as_f64() == Some(0.)),
                "Unexpected nonclosed order {id}"
            );
            for key in ["fees_usdt", "funding_usdt", "slippage_usdt"] {
                close(number(&order["incurred_costs"], key)?, 0., key)?;
            }
            continue;
        }
        let t = order_totals(order)?;
        let direction = text(order, "direction")?;
        let action = match direction {
            "OPEN_LONG" => "BUY",
            "OPEN_SHORT" => "SELL",
            _ => anyhow::bail!("Invalid direction {direction}"),
        };
        ensure!(
            text(signal, "decision")? == action,
            "Order/signal direction mismatch"
        );
        let probability = number(&signal["probabilities"], action)?;
        ensure!(
            (0. ..=1.).contains(&probability),
            "Invalid selected probability"
        );
        let bin = ((probability * 10.).floor() as usize).min(9);
        let bucket = format!(
            "[{:.1},{:.1}{}",
            bin as f64 / 10.,
            (bin + 1) as f64 / 10.,
            if bin == 9 { "]" } else { ")" }
        );
        let date = chrono::DateTime::parse_from_rfc3339(text(order, "exitAt")?)?
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%d")
            .to_string();
        all.by_direction
            .entry(direction.to_owned())
            .or_default()
            .add(&t);
        all.by_exit_reason
            .entry(text(order, "reason")?.to_owned())
            .or_default()
            .add(&t);
        all.by_exit_date_utc.entry(date).or_default().add(&t);
        all.by_selected_direction_probability
            .entry(bucket)
            .or_default()
            .add(&t);
        total.add(&t);
    }
    ensure!(signals.is_empty(), "Submitted signals have missing orders");
    for (actual, key) in [
        (total.closed_trades, "closed_trades"),
        (total.wins, "wins"),
        (total.losses, "losses"),
    ] {
        ensure!(actual == count(metrics, key)?, "{symbol} {key} mismatch");
    }
    for (actual, key) in [
        (total.net_pnl_usdt, "net_pnl_usdt"),
        (total.net_pnl_usdt, "settled_net_usdt"),
        (total.fees_usdt, "fees_usdt"),
        (total.funding_usdt, "funding_usdt"),
        (total.slippage_usdt, "slippage_usdt"),
    ] {
        close(actual, number(metrics, key)?, &format!("{symbol}.{key}"))?;
    }
    all.total.add(&total);
    all.by_symbol.insert(symbol.to_owned(), total);
    Ok(())
}
fn reconcile_aggregate(actual: &Aggregate, expected: &Value) -> Result<()> {
    let actual = serde_json::to_value(actual)?;
    for (key, value) in actual.as_object().unwrap() {
        close(number(&actual, key)?, number(expected, key)?, key)?;
        ensure!(value.is_number(), "Aggregate field {key} must be numeric");
    }
    Ok(())
}
fn variant(run: &Path, name: &str, expected: &Value) -> Result<Value> {
    let mut files = fs::read_dir(run.join("holdout").join(name))?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    files.retain(|p| p.extension().is_some_and(|ext| ext == "json"));
    files.sort();
    ensure!(
        files.len() == count(expected, "symbols")?,
        "Missing/extra replay files in {name}"
    );
    let mut attribution = Attribution::default();
    let mut aggregate = Aggregate::default();
    let mut ids = BTreeSet::new();
    let mut sources = Vec::new();
    for file in files {
        let bytes = fs::read(&file)?;
        let value: Value =
            serde_json::from_slice(&bytes).with_context(|| format!("Parse {}", file.display()))?;
        let replay = &value["replay"];
        ensure!(
            file.file_stem().and_then(|s| s.to_str()) == Some(text(replay, "symbol")?),
            "Filename/symbol mismatch"
        );
        attribute_replay(replay, &mut attribution, &mut ids)
            .with_context(|| format!("Reconcile {}", file.display()))?;
        aggregate.add(replay)?;
        sources.push(json!({"file":file.file_name().unwrap().to_string_lossy(), "sha256":hex::encode(Sha256::digest(&bytes))}));
    }
    reconcile_aggregate(&aggregate, expected)?;
    close(
        attribution.total.net_pnl_usdt,
        aggregate.net_pnl_usdt,
        "order net / report aggregate",
    )?;
    Ok(
        json!({"reconciliation":"passed", "aggregate":aggregate, "attribution":attribution, "source_replays":sources}),
    )
}
fn main() -> Result<()> {
    let args = Args::parse();
    let run = fs::canonicalize(&args.run_dir)?;
    let bytes = fs::read(run.join("report.json"))?;
    let report: Value = serde_json::from_slice(&bytes)?;
    let mut variants = BTreeMap::new();
    for (directory, key) in [
        ("with-chronos", "with_chronos"),
        ("without-chronos", "without_chronos"),
    ] {
        variants.insert(
            key,
            variant(
                &run,
                directory,
                &report["historical_holdout"][key]["aggregate"],
            )?,
        );
    }
    let output = args.output_dir.unwrap_or_else(|| {
        PathBuf::from(format!(
            "output/ml-diagnosis-{}-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
            uuid::Uuid::new_v4().simple()
        ))
    });
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent).context("Output parent directory must already exist")?;
    ensure!(
        !parent
            .join(output.file_name().context("Invalid output directory")?)
            .starts_with(&run),
        "Output must be outside the input run directory"
    );
    fs::create_dir(&output)
        .with_context(|| format!("Output must be a new directory: {}", output.display()))?;
    let result = json!({"schema_version":1, "post_hoc":true, "descriptive_only":true, "reconciliation":"passed", "run_dir":run,
        "source_report_sha256":hex::encode(Sha256::digest(&bytes)), "created_at_utc":chrono::Utc::now(), "variants":variants,
        "limitations":["Existing holdout has already been examined; group results are not new out-of-sample evidence or a selection rule.",
            "Each symbol has an independent account; sums are not shared-portfolio returns or portfolio drawdown.",
            "gross_after_fill_slippage_usdt already includes fill slippage; net = gross - fees - funding + isolated_loss_adjustment. Never subtract reported slippage again.",
            "Partial-exit realizedGross/realizedNet are already included in final closed-order gross/net and are not added again.",
            "Probability groups describe the selected entry direction only; exit dates use UTC."]});
    let destination = output.join("diagnosis.json");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)?;
    file.write_all(&serde_json::to_vec_pretty(&result)?)?;
    file.sync_all()?;
    println!(
        "Reconciliation passed: {}",
        fs::canonicalize(destination)?.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn order() -> Value {
        json!({"id":"a", "status":"closed", "symbol":"BTCUSDT", "direction":"OPEN_LONG", "reason":"stop_loss", "exitAt":"2026-10-01T01:00:00Z",
            "gross":2., "net":1.7, "realizedGross":1.2, "realizedNet":1., "partialFills":2, "isolatedLossAdjustment":0.,
            "incurred_costs":{"fees_usdt":0.2,"funding_usdt":0.1,"slippage_usdt":0.4,"slippage_in_fill_prices":true,"slippage_deducted_again":false}})
    }
    #[test]
    fn split_exits_are_counted_once_and_slippage_is_not_deducted_twice() {
        let t = order_totals(&order()).unwrap();
        assert_eq!(t.closed_trades, 1);
        assert_eq!(t.net_pnl_usdt, 1.7);
        assert_eq!(t.gross_after_fill_slippage_usdt, 2.);
        let mut invalid = order();
        invalid["net"] = json!(1.3);
        assert!(order_totals(&invalid).is_err());
        invalid = order();
        invalid["incurred_costs"]
            .as_object_mut()
            .unwrap()
            .remove("fees_usdt");
        assert!(order_totals(&invalid).is_err());
    }
    fn replay() -> Value {
        json!({"symbol":"BTCUSDT", "orders":[order()], "signal_log":[{"order_id":"a", "outcome":"submitted", "decision":"BUY", "probabilities":{"BUY":0.7}}],
            "metrics":{"signals":1,"submitted_orders":1,"closed_trades":1,"wins":1,"losses":0,"unresolved_orders":0,"net_pnl_usdt":1.7,"settled_net_usdt":1.7,"fees_usdt":0.2,"funding_usdt":0.1,"slippage_usdt":0.4}})
    }
    fn check(v: &Value) -> Result<()> {
        attribute_replay(v, &mut Attribution::default(), &mut BTreeSet::new())
    }
    #[test]
    fn rejects_duplicate_or_missing_orders_instead_of_hiding_them() {
        assert!(check(&replay()).is_ok());
        let mut v = replay();
        v["orders"] = json!([]);
        assert!(check(&v).is_err());
        let mut v = replay();
        v["orders"] = json!([order(), order()]);
        v["metrics"]["submitted_orders"] = json!(2);
        v["metrics"]["signals"] = json!(2);
        let mut second_signal = v["signal_log"][0].clone();
        second_signal["order_id"] = json!("b");
        v["signal_log"].as_array_mut().unwrap().push(second_signal);
        assert!(check(&v).is_err());
        let mut v = replay();
        let signal = v["signal_log"][0].clone();
        v["signal_log"].as_array_mut().unwrap().push(signal);
        v["metrics"]["signals"] = json!(2);
        assert!(check(&v).is_err());
        let mut v = replay();
        v["signal_log"][0]["order_id"] = json!("missing");
        assert!(check(&v).is_err());
    }
}
