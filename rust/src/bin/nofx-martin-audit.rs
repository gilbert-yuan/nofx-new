//! Read-only rejection attribution for the Martin Luk pullback strategy.
//!
//! The backtest reports `rawEntries` but not *which* rule rejected each candidate.
//! This tool walks the same frozen history, calls the shared registered strategy
//! (`strategies::analyze`) through the same aux-market construction as `backtest::replay`,
//! and tallies the resulting HOLD reasons. It never sizes, submits or persists orders.
//! The trend-gate split reads metrics the strategy already returned; each item is a
//! necessary sub-condition, so a miss proves failure but a pass does not prove the gate passed.
//! The strategy only changes verdict when a 15m candle closes, so the 14 intermediate
//! minutes per bucket repeat the same decision verbatim and are sampled once.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{interval_ms, iso, number, research, strategies, timestamp};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf};

const MINUTE: i64 = 60_000;
const ENTRY_MS: i64 = 15 * MINUTE;
const STRATEGY: &str = "martin-luk-pullback-v1";
const AUX: [(&str, usize); 2] = [("4h", 240), ("15m", 240)];
const SAMPLE_EVERY_MS: i64 = ENTRY_MS;
const MAIN_WINDOW: usize = 80;

#[derive(Parser)]
#[command(about = "Attribute Martin Luk pullback rejections on frozen candle history")]
struct Args {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    output_dir: PathBuf,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long)]
    start_ms: i64,
    #[arg(long)]
    end_ms: i64,
    /// Overrides layered on registry defaults, e.g. {"minMomentumPct":0.05}.
    #[arg(long, default_value = "{}")]
    params: String,
}

fn window(symbol: &str, tf: &str, all: &[Value], limit: usize, now: i64) -> Result<Value> {
    let dt = interval_ms(tf).context("invalid timeframe")?;
    let end = all.partition_point(|r| timestamp(&r["openTime"]).unwrap_or(i64::MAX) + dt <= now);
    let from = end.saturating_sub(limit);
    research::prepare_market(symbol, tf, &all[from..end], limit, now)
}

fn summarise(values: &[f64]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let pick = |q: f64| sorted[(q * (sorted.len() - 1) as f64).round() as usize];
    json!({"n":sorted.len(),"min":sorted[0],"p50":pick(0.5),"max":sorted[sorted.len()-1]})
}

fn audit(symbol: &str, docs: &Value, start: i64, end: i64, params: &Value) -> Result<Value> {
    let mut datasets = BTreeMap::<String, Vec<Value>>::new();
    for (tf, rows) in docs["datasets"].as_object().context("datasets missing")? {
        let rows = rows.as_array().context("dataset is not an array")?.clone();
        let dt = interval_ms(tf).context("invalid timeframe")?;
        datasets.insert(
            tf.clone(),
            rows.into_iter()
                .filter(|r| timestamp(&r["openTime"]).is_some_and(|at| at + dt <= end))
                .collect(),
        );
    }
    let main = datasets.get("1m").context("no 1m dataset")?;
    let mut reasons = BTreeMap::<String, usize>::new();
    let mut momentum = Vec::new();
    let mut adr = Vec::new();
    let mut stack_pass = 0usize;
    let mut momentum_pass = 0usize;
    let mut adr_pass = 0usize;
    let mut all_three = 0usize;
    let mut decisions = 0usize;
    let mut beyond_trend = 0usize;
    let min_momentum = number(&params["minMomentumPct"], f64::NAN);
    let min_adr = number(&params["minAdrPct"], f64::NAN);
    let mut now = start;
    while now < end {
        let market = window(symbol, "1m", main, MAIN_WINDOW, now)?;
        let mut ctx = json!({"params":params,"costs":research::costs(),"auxMarkets":{},
            "planInterval":"15m","evaluationAt":iso(now)});
        for (tf, limit) in AUX {
            let rows = datasets.get(tf).with_context(|| format!("missing {tf}"))?;
            ctx["auxMarkets"][tf] = window(symbol, tf, rows, limit, now)?;
        }
        let raw = strategies::analyze(STRATEGY, &market, &ctx)?;
        decisions += 1;
        let reason = raw["reason"].as_str().unwrap_or("(no reason)").to_string();
        *reasons.entry(reason.clone()).or_default() += 1;
        let m = &raw["metrics"];
        if m["momentumPct"].is_number() && m["adrPct"].is_number() {
            let mo = number(&m["momentumPct"], f64::NAN);
            let av = number(&m["adrPct"], f64::NAN);
            let ef = number(&m["emaFast"], f64::NAN);
            let em = number(&m["emaMedium"], f64::NAN);
            let es = number(&m["emaSlow"], f64::NAN);
            momentum.push(mo);
            adr.push(av);
            let stack = ef > em && em > es;
            let momentum_ok = mo >= min_momentum;
            let adr_ok = av >= min_adr;
            stack_pass += stack as usize;
            momentum_pass += momentum_ok as usize;
            adr_pass += adr_ok as usize;
            all_three += (stack && momentum_ok && adr_ok) as usize;
        }
        if !reason.contains("4h 强势趋势") {
            beyond_trend += 1;
        }
        now += SAMPLE_EVERY_MS;
    }
    let first_open = main
        .iter()
        .find(|r| timestamp(&r["openTime"]).is_some_and(|at| at >= start))
        .map(|r| number(&r["open"], f64::NAN))
        .unwrap_or(f64::NAN);
    let last_close = main
        .iter()
        .rev()
        .find(|r| timestamp(&r["openTime"]).is_some_and(|at| at < end))
        .map(|r| number(&r["close"], f64::NAN))
        .unwrap_or(f64::NAN);
    Ok(json!({
        "symbol":symbol,"decisions":decisions,
        "pastTrendGate":beyond_trend,
        "reasons":reasons,
        "trendSubconditions":{
            "emaStackRatio":number(&json!(stack_pass as f64/decisions as f64),0.),
            "momentumPctPassRatio":number(&json!(momentum_pass as f64/decisions as f64),0.),
            "adrPctPassRatio":number(&json!(adr_pass as f64/decisions as f64),0.),
            "allThreeUpperBound":all_three},
        "momentumPct":summarise(&momentum),
        "adrPct":summarise(&adr),
        "window":{"firstOpen":first_open,"lastClose":last_close,
            "changePct":if first_open>0.{(last_close/first_open-1.)*100.}else{f64::NAN}},
        "params":params}))
}

fn main() -> Result<()> {
    let args = Args::parse();
    let overrides: Value = serde_json::from_str(&args.params).context("invalid --params")?;
    let resolved = strategies::resolve_params(STRATEGY, &overrides)?;
    ensure!(
        resolved["rejected"].as_array().is_some_and(Vec::is_empty),
        "Rejected parameters: {}",
        resolved["rejected"]
    );
    let params = resolved["params"].clone();
    // Frozen windows start on an arbitrary minute; step from the first 15m boundary inside it.
    let start = (args.start_ms + SAMPLE_EVERY_MS - 1) / SAMPLE_EVERY_MS * SAMPLE_EVERY_MS;
    ensure!(args.end_ms > start, "Audit needs a non-empty past window");
    fs::create_dir_all(&args.output_dir)?;
    let mut reports = Vec::new();
    for symbol in &args.symbols {
        let path = args.data_dir.join(format!("{symbol}.json"));
        let bytes = fs::read(&path).with_context(|| format!("Read {}", path.display()))?;
        let text = std::str::from_utf8(&bytes)?;
        let docs: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
        eprintln!("auditing {symbol}");
        let report = audit(symbol, &docs, start, args.end_ms, &params)?;
        reports.push(report.clone());
        fs::write(
            args.output_dir.join(format!("{symbol}.json")),
            serde_json::to_vec_pretty(&report)?,
        )?;
    }
    fs::write(
        args.output_dir.join("summary.json"),
        serde_json::to_vec_pretty(&json!({"strategy":STRATEGY,"params":params,
            "window":{"start_ms":args.start_ms,"end_ms":args.end_ms},
            "sample_every_ms":SAMPLE_EVERY_MS,"reports":reports}))?,
    )?;
    println!(
        "{}",
        json!({"summary":args.output_dir.join("summary.json"),"symbols":args.symbols.len()})
    );
    Ok(())
}
