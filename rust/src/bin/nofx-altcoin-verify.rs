//! Compare replay economic outputs; descriptive metadata may evolve independently.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

#[derive(Parser)]
struct Args {
    #[arg(long)]
    reference: PathBuf,
    #[arg(long)]
    candidate: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

fn scalar(left: &Value, right: &Value, label: &str, precise: bool) -> Result<f64> {
    if let Some(a) = left.as_f64() {
        let b = right
            .as_f64()
            .with_context(|| format!("Missing number: {label}"))?;
        let delta = (a - b).abs();
        let tolerance = if precise {
            1e-12 * (1. + a.abs().max(b.abs()))
        } else {
            1e-6
        };
        ensure!(
            a.is_finite() && b.is_finite() && delta <= tolerance,
            "Economic mismatch {label}: {a} vs {b} (delta {delta})"
        );
        Ok(delta)
    } else {
        ensure!(left == right, "Field mismatch {label}: {left} vs {right}");
        Ok(0.)
    }
}

fn compare_case(reference: &Value, candidate: &Value) -> Result<Value> {
    let mut max_delta = 0_f64;
    for field in [
        "initial_equity",
        "final_equity",
        "return_pct",
        "max_drawdown_pct",
        "max_active_positions",
        "max_same_direction_positions",
    ] {
        max_delta = max_delta.max(scalar(&reference[field], &candidate[field], field, false)?);
    }
    for field in [
        "net",
        "gross",
        "fees",
        "funding",
        "trades",
        "wins",
        "win_rate_pct",
        "profit_factor",
        "net_ex_top_1",
        "net_ex_top_3",
    ] {
        max_delta = max_delta.max(scalar(
            &reference["stats"][field],
            &candidate["stats"][field],
            field,
            false,
        )?);
    }
    let order_key = |o: &Value| {
        format!(
            "{}|{}|{}|{}|{}",
            o["symbol"], o["direction"], o["entryAt"], o["exitAt"], o["status"]
        )
    };
    let mut left: Vec<_> = reference["orders"]
        .as_array()
        .context("Missing reference orders")?
        .iter()
        .collect();
    let mut right: Vec<_> = candidate["orders"]
        .as_array()
        .context("Missing candidate orders")?
        .iter()
        .collect();
    left.sort_by_key(|o| order_key(o));
    right.sort_by_key(|o| order_key(o));
    ensure!(left.len() == right.len(), "Order count mismatch");
    for (a, b) in left.iter().zip(&right) {
        ensure!(order_key(a) == order_key(b), "Order identity mismatch");
        for field in [
            "reason",
            "entry",
            "exit",
            "margin",
            "notional",
            "quantity",
            "entryFee",
            "net",
            "gross",
            "fee",
            "fees",
            "funding",
            "heldBars",
            "roi",
            "netReturn",
        ] {
            max_delta = max_delta.max(scalar(
                &a[field],
                &b[field],
                field,
                matches!(field, "entry" | "exit" | "quantity"),
            )?);
        }
        for field in ["stopLoss", "riskUnit"] {
            max_delta = max_delta.max(scalar(
                &a["initialPlan"][field],
                &b["initialPlan"][field],
                field,
                true,
            )?);
        }
    }
    let a_curve = reference["equity_curve"]
        .as_array()
        .context("Missing reference curve")?;
    let b_curve = candidate["equity_curve"]
        .as_array()
        .context("Missing candidate curve")?;
    ensure!(
        a_curve.len() == b_curve.len(),
        "Equity sampling count mismatch"
    );
    for (a, b) in a_curve.iter().zip(b_curve) {
        for field in ["time_ms", "equity", "open_positions"] {
            max_delta = max_delta.max(scalar(&a[field], &b[field], field, false)?);
        }
    }
    Ok(json!({"orders":left.len(),"equity_points":a_curve.len(),"max_absolute_delta":max_delta}))
}

fn verify(reference: &Value, candidate: &Value) -> Result<Value> {
    let mut results = Vec::new();
    let expected = reference["results"]
        .as_array()
        .context("Missing reference results")?;
    ensure!(!expected.is_empty(), "Empty reference report");
    let actual = candidate["results"]
        .as_array()
        .context("Missing candidate results")?;
    for row in expected {
        let matches: Vec<_> = actual
            .iter()
            .filter(|item| {
                ["period", "strategy", "cost_multiplier"]
                    .iter()
                    .all(|key| item[*key] == row[*key])
            })
            .collect();
        ensure!(
            matches.len() == 1,
            "Expected one matching scenario for {} / {} / {}",
            row["period"],
            row["strategy"],
            row["cost_multiplier"]
        );
        let mut result = compare_case(row, matches[0])?;
        for key in ["period", "strategy", "cost_multiplier"] {
            result[key] = row[key].clone();
        }
        results.push(result);
    }
    Ok(json!({"passed":true,"reference_cases":expected.len(),"cases":results}))
}

fn main() -> Result<()> {
    let args = Args::parse();
    let report = verify(
        &serde_json::from_slice(&fs::read(&args.reference)?)?,
        &serde_json::from_slice(&fs::read(&args.candidate)?)?,
    )?;
    if let Some(parent) = args.output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.output, serde_json::to_vec_pretty(&report)?)?;
    println!("Verified {} reference scenarios", report["reference_cases"]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"results":[{"period":"full","strategy":"test","cost_multiplier":1.,
            "initial_equity":100.,"final_equity":101.,"stats":{"net":1.,"funding":0.1},
            "orders":[{"symbol":"SOLUSDT","direction":"OPEN_LONG","status":"closed",
                "entryAt":"a","exitAt":"b","entry":10.,"exit":11.,"net":1.,"funding":0.1}],
            "equity_curve":[{"time_ms":0,"equity":100.,"open_positions":0},
                {"time_ms":1,"equity":101.,"open_positions":0}]}]})
    }
    #[test]
    fn accepts_descriptive_changes_but_detects_funding_or_fill_drift() {
        let reference = fixture();
        let mut candidate = reference.clone();
        candidate["results"][0]["orders"][0]["id"] = json!("new-description");
        assert!(verify(&reference, &candidate).is_ok());
        candidate["results"][0]["orders"][0]["funding"] = json!(0.2);
        assert!(verify(&reference, &candidate).is_err());
        candidate = reference.clone();
        candidate["results"][0]["orders"][0]["entry"] = json!(10.0001);
        assert!(verify(&reference, &candidate).is_err());
    }
}
