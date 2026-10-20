//! Read-only candle collector for widening a backtest symbol universe.
//!
//! Pulls 1m/5m/15m/1h/4h public klines for a symbol set over one frozen window
//! and writes files shaped exactly like `output/monthly-enabled/data/<SYMBOL>.json`
//! so the same `nofx-ml-strategies` / `nofx-martin-audit` inputs can be reused.
//! No account, order or credential is touched; only public market data.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{exchange::Exchange, interval_ms, number, simulator::valid_candle, timestamp};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf, time::Instant};
use tokio::task::JoinSet;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// One Binance klines page; `Exchange::klines` clamps this to 1000.
const PAGE: usize = 1000;
/// Warmup depth per timeframe: the strategy needs 240 closed bars per aux window,
/// and `backtest::replay` additionally requires 1m to reach one day before `start`.
const WARMUP: [(&str, i64); 5] = [
    ("1m", 2 * DAY),
    ("5m", 2 * DAY),
    ("15m", 15 * DAY),
    ("1h", 30 * DAY),
    ("4h", 45 * DAY),
];

#[derive(Parser)]
#[command(about = "Collect frozen multi-timeframe candles for a widened backtest universe")]
struct Args {
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long)]
    output_dir: PathBuf,
    /// Exclusive window end; must be in the past.
    #[arg(long)]
    end_ms: i64,
    #[arg(long)]
    start_ms: i64,
    #[arg(long, default_value_t = 6)]
    concurrency: usize,
    /// Skip symbols whose output file already exists.
    #[arg(long)]
    skip_existing: bool,
}

async fn fetch_window(
    exchange: &Exchange,
    symbol: &str,
    tf: &str,
    from: i64,
    end: i64,
) -> Result<Vec<Value>> {
    let dt = interval_ms(tf).context("invalid timeframe")?;
    let mut rows = Vec::new();
    let mut cursor = from;
    while cursor < end {
        let window_end = (cursor + PAGE as i64 * dt).min(end);
        let page = exchange
            .klines(symbol, tf, PAGE, Some(cursor), Some(window_end))
            .await?;
        ensure!(!page.is_empty(), "{symbol}/{tf} returned no candles");
        let last_open = timestamp(&page.last().unwrap()["openTime"]).context("bad openTime")?;
        let mut page = page;
        // The frozen window end is only minute-aligned. A coarser candle whose
        // close lands after it is still open at that instant and must be dropped,
        // exactly like `backtest::replay`'s `open + duration <= end` check.
        page.retain(|r| timestamp(&r["openTime"]).is_some_and(|at| at + dt <= end));
        if page.is_empty() {
            break;
        }
        rows.extend(page);
        ensure!(
            last_open > cursor,
            "{symbol}/{tf} pagination stalled at {}",
            nofx_core::iso(cursor)
        );
        cursor = last_open + dt;
    }
    Ok(rows)
}

fn validate(symbol: &str, tf: &str, rows: &[Value], end: i64) -> Result<()> {
    let dt = interval_ms(tf).context("invalid timeframe")?;
    ensure!(!rows.is_empty(), "{symbol}/{tf} empty");
    let mut previous = None;
    for row in rows {
        let open = timestamp(&row["openTime"]).context("missing openTime")?;
        ensure!(
            open % dt == 0 && open + dt <= end,
            "{symbol}/{tf} unclosed or misaligned candle at {}",
            nofx_core::iso(open)
        );
        ensure!(
            valid_candle(row),
            "{symbol}/{tf} invalid candle at {}",
            nofx_core::iso(open)
        );
        ensure!(
            number(&row["volume"], -1.) >= 0. && number(&row["quoteVolume"], -1.) >= 0.,
            "{symbol}/{tf} negative volume at {}",
            nofx_core::iso(open)
        );
        ensure!(
            previous.is_none_or(|at| open == at + dt),
            "{symbol}/{tf} gap at {}",
            nofx_core::iso(open)
        );
        previous = Some(open);
    }
    Ok(())
}

async fn collect(symbol: &str, args: &Args) -> Result<Value> {
    let path = args.output_dir.join(format!("{symbol}.json"));
    if args.skip_existing && path.is_file() {
        return Ok(json!({"symbol":symbol,"status":"skipped_existing"}));
    }
    let exchange = Exchange::public()?;
    let mut datasets = BTreeMap::<String, Vec<Value>>::new();
    let mut gaps = Vec::new();
    for (tf, warmup) in WARMUP {
        let from = args.start_ms - warmup;
        let rows = fetch_window(&exchange, symbol, tf, from, args.end_ms).await;
        match rows.and_then(|rows| validate(symbol, tf, &rows, args.end_ms).map(|()| rows)) {
            Ok(rows) => {
                datasets.insert(tf.to_string(), rows);
            }
            Err(error) => {
                eprintln!("GAP {symbol}/{tf} from {}: {error:#}", nofx_core::iso(from));
                gaps.push(json!({"timeframe":tf,"from_ms":from,"error":format!("{error:#}")}));
            }
        }
    }
    ensure!(
        datasets.contains_key("1m"),
        "{symbol}: 1m history unavailable, required by the replay engine"
    );
    let main = &datasets["1m"];
    ensure!(
        timestamp(&main.last().unwrap()["openTime"]) == Some(args.end_ms - MINUTE),
        "{symbol}: 1m dataset does not reach the frozen cutoff"
    );
    ensure!(
        timestamp(&main[0]["openTime"]).is_some_and(|at| at <= args.start_ms - DAY),
        "{symbol}: insufficient 1m warmup"
    );
    let doc = json!({
        "symbol":symbol,
        "datasets":Value::Object(datasets.into_iter().map(|(k, v)|(k, json!(v))).collect()),
        "samples":Value::Array(vec![]),
        "metadata":{"as_of_ms":args.end_ms,"collected_by":"nofx-martin-collect","source":"binance-fapi-public-klines"}
    });
    fs::create_dir_all(&args.output_dir)?;
    let bytes = serde_json::to_vec_pretty(&doc)?;
    fs::write(&path, bytes).with_context(|| format!("Write {}", path.display()))?;
    Ok(json!({"symbol":symbol,"status":"ok","gaps":gaps,
        "bars":Value::Object(doc["datasets"].as_object().unwrap().iter()
            .map(|(k,v)|(k.clone(),json!(v.as_array().unwrap().len()))).collect())}))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(!args.symbols.is_empty(), "no symbols requested");
    ensure!(
        args.end_ms > args.start_ms && args.end_ms <= nofx_core::now_ms(),
        "window must be past and non-empty"
    );
    ensure!(
        args.symbols
            .iter()
            .all(|s| s.ends_with("USDT") && s.len() >= 5),
        "symbols must be USDT perpetuals"
    );
    fs::create_dir_all(&args.output_dir)?;
    let started = Instant::now();
    let mut queue = args.symbols.clone();
    queue.sort();
    queue.dedup();
    let shared = std::sync::Arc::new(args);
    let mut collected = 0usize;
    let mut failed = Vec::new();
    while !queue.is_empty() {
        let batch: Vec<String> = queue.drain(..shared.concurrency.min(queue.len())).collect();
        let mut set = JoinSet::new();
        for symbol in batch {
            let shared = shared.clone();
            set.spawn(async move {
                let started = Instant::now();
                let outcome = collect(&symbol, &shared).await;
                (symbol, started.elapsed().as_secs_f64(), outcome)
            });
        }
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((symbol, elapsed, Ok(report))) => {
                    collected += 1;
                    let bars = &report["bars"];
                    eprintln!(
                        "collected {symbol} in {elapsed:.1}s: {}",
                        bars.as_object()
                            .map(|m| m
                                .iter()
                                .map(|(k, v)| format!("{k}={}", v))
                                .collect::<Vec<_>>()
                                .join(" "))
                            .unwrap_or_default()
                    );
                }
                Ok((symbol, elapsed, Err(error))) => {
                    failed.push(json!({"symbol":symbol,"error":error.to_string()}));
                    eprintln!("FAILED {symbol} after {elapsed:.1}s: {error}");
                }
                Err(error) => failed.push(json!({"symbol":null,"error":error.to_string()})),
            }
        }
    }
    println!(
        "{}",
        json!({"symbols":shared.symbols.len(),"collected":collected,"failed":failed.len(),
            "output_dir":shared.output_dir,"elapsed_s":started.elapsed().as_secs_f64()})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(open: i64) -> Value {
        json!({"openTime":open,"open":10.,"high":11.,"low":9.,"close":10.5,
            "volume":1.,"quoteVolume":10.5,"tradeCount":2,"takerBuyVolume":0.5,
            "takerBuyQuoteVolume":5.,"confirmed":true})
    }

    #[test]
    fn validation_rejects_gaps_misalignment_and_unclosed_bars() {
        let end = 3 * HOUR;
        assert!(
            validate("TESTUSDT", "1h", &[bar(0), bar(2 * HOUR)], end).is_err(),
            "gap"
        );
        assert!(
            validate("TESTUSDT", "1h", &[bar(0), bar(HOUR)], end).is_ok(),
            "contiguous"
        );
        assert!(
            validate("TESTUSDT", "1h", &[bar(MINUTE), bar(HOUR + MINUTE)], end).is_err(),
            "misaligned"
        );
        assert!(
            validate("TESTUSDT", "1h", &[bar(0)], 30 * MINUTE).is_err(),
            "unclosed tail"
        );
        assert!(validate("TESTUSDT", "1h", &[bar(0), bar(HOUR)], 2 * HOUR).is_ok());
    }

    #[test]
    fn validation_rejects_invalid_ohlc_and_negative_volume() {
        let end = 2 * HOUR;
        let mut broken = bar(0);
        broken["high"] = json!(1.); // high below low
        assert!(validate("TESTUSDT", "1h", &[broken, bar(HOUR)], end).is_err());
        let mut negative = bar(0);
        negative["volume"] = json!(-1.);
        assert!(validate("TESTUSDT", "1h", &[negative, bar(HOUR)], end).is_err());
    }

    #[test]
    fn warmup_covers_the_strategy_windows() {
        // 4h needs 240 closed bars before `start`; 45 days gives 270.
        let four_hour = WARMUP.iter().find(|(tf, _)| *tf == "4h").unwrap().1;
        assert!(four_hour >= 240 * interval_ms("4h").unwrap());
        let minute = WARMUP.iter().find(|(tf, _)| *tf == "1m").unwrap().1;
        assert!(minute >= DAY, "replay requires one day of 1m warmup");
    }
}
