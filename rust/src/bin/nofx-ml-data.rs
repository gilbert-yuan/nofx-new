use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::exchange::{Exchange, valid_symbol};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;
const MINUTE_MS: i64 = 60_000;

#[derive(Parser)]
#[command(about = "Freeze closed public Binance futures candles for local ML research")]
struct Args {
    #[arg(long, default_value = "data/ml-market-20261014")]
    output_dir: PathBuf,
    #[arg(long, value_delimiter = ',', default_value = "BTCUSDT,ETHUSDT")]
    symbols: Vec<String>,
    #[arg(long, default_value_t = 150)]
    days: u32,
    /// Previously frozen raw candles are reused only when already closed at collection time.
    #[arg(long, default_value = "output/profit-improvement-20261011/data")]
    frozen_source: PathBuf,
    /// Exclusive frozen cutoff in milliseconds; rounded down to a closed hourly boundary.
    #[arg(long)]
    end_ms: Option<i64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        (30..=730).contains(&args.days),
        "days must be between 30 and 730"
    );
    let closed_now = nofx_core::now_ms().div_euclid(HOUR_MS) * HOUR_MS;
    let end_ms = args.end_ms.unwrap_or(closed_now).div_euclid(HOUR_MS) * HOUR_MS;
    ensure!(
        end_ms > i64::from(args.days) * DAY_MS,
        "end-ms is too early"
    );
    ensure!(
        end_ms <= closed_now,
        "end-ms must not include future or unclosed candles"
    );
    let start_ms = end_ms - i64::from(args.days) * DAY_MS;
    let intervals = intervals(args.days);
    let symbols: Vec<String> = args
        .symbols
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .collect();
    ensure!(!symbols.is_empty(), "symbols must not be empty");
    ensure!(
        symbols.iter().collect::<BTreeSet<_>>().len() == symbols.len(),
        "symbols must be unique"
    );
    for symbol in &symbols {
        valid_symbol(symbol)?;
    }
    fs::create_dir_all(&args.output_dir)?;
    let exchange = Exchange::public()?;
    let mut summaries = Vec::new();
    for symbol in symbols {
        let path = args.output_dir.join(format!("{symbol}.json"));
        if path.exists() {
            let existing: Value = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("Read existing frozen file {}", path.display()))?;
            validate_document(&existing, &symbol, start_ms, end_ms, &intervals)?;
            summaries.push(
                json!({"symbol":symbol,"path":path,"reused":true,"metadata":existing["metadata"]}),
            );
            continue;
        }
        let mut datasets = BTreeMap::<String, Vec<Value>>::new();
        let mut timeframes = BTreeMap::<String, Value>::new();
        let source_path = args.frozen_source.join(format!("{symbol}.json"));
        let source = read_source(&source_path)?;
        for &(interval, duration, days) in &intervals {
            // Include a whole 4h candle at the left edge and only candles closed by end_ms.
            let first = (end_ms - i64::from(days) * DAY_MS).div_euclid(duration) * duration;
            let cutoff = end_ms.div_euclid(duration) * duration;
            let (seed, rejected) = source_rows(
                source.as_ref().map(|s| &s.0),
                &symbol,
                interval,
                duration,
                first,
                cutoff,
            )?;
            let reused = seed.len();
            let rows =
                fetch_interval(&exchange, &symbol, interval, duration, first, cutoff, seed).await?;
            let sha = digest(&rows)?;
            timeframes.insert(
                interval.into(),
                json!({
                    "interval_ms":duration,"start_open_ms":first,"end_exclusive_ms":cutoff,
                    "last_open_ms":cutoff-duration,"rows":rows.len(),"sha256":sha,
                    "requested_days":days,"reused_rows":reused,"fetched_rows":rows.len()-reused,
                    "excluded_source_rows":rejected,
                    "complete":true,"consecutive":true,"closed_only":true
                }),
            );
            datasets.insert(interval.into(), rows);
        }
        let content_sha256 = digest(&json!({"symbol":symbol,"datasets":datasets}))?;
        let document = json!({
            "symbol":symbol,"datasets":datasets,"samples":[],
            "metadata":{
                "schema_version":1,"source":"Binance USD-M Futures public /fapi/v1/klines",
                "source_base":std::env::var("BINANCE_FUTURES_BASE").unwrap_or_else(|_|"https://fapi.binance.com".into()),
                "collected_at_ms":nofx_core::now_ms(),"as_of_ms":end_ms,
                "start_ms":start_ms,"end_exclusive_ms":end_ms,"requested_days":args.days,
                "timeframes":timeframes,"content_sha256":content_sha256,
                "sourceHashes":source.as_ref().map(|s|json!([{ "path":source_path,"sha256":s.1 }])).unwrap_or_else(||json!([])),
                "immutable":true,"account_credentials_used":false,"orders_enabled":false
            }
        });
        validate_document(&document, &symbol, start_ms, end_ms, &intervals)?;
        write_new(&path, &document)?;
        summaries.push(
            json!({"symbol":symbol,"path":path,"reused":false,"metadata":document["metadata"]}),
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status":"complete","start_ms":start_ms,"as_of_ms":end_ms,
            "days":args.days,"output_dir":args.output_dir,"datasets":summaries
        }))?
    );
    Ok(())
}

fn intervals(training_days: u32) -> Vec<(&'static str, i64, u32)> {
    vec![
        ("1h", HOUR_MS, training_days),
        ("4h", 4 * HOUR_MS, training_days),
        ("1m", MINUTE_MS, 32),
        ("15m", 15 * MINUTE_MS, 35),
    ]
}

fn read_source(path: &Path) -> Result<Option<(Value, String)>> {
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(path)?;
    let sha = hex::encode(Sha256::digest(&bytes));
    let source = serde_json::from_slice(&bytes)
        .with_context(|| format!("Read frozen source {}", path.display()))?;
    Ok(Some((source, sha)))
}

fn source_rows(
    source: Option<&Value>,
    symbol: &str,
    interval: &str,
    duration: i64,
    first: i64,
    cutoff: i64,
) -> Result<(BTreeMap<i64, Value>, usize)> {
    let mut seed = BTreeMap::new();
    let mut rejected = 0;
    let Some(source) = source else {
        return Ok((seed, rejected));
    };
    ensure!(
        source["symbol"].as_str().is_none_or(|name| name == symbol),
        "Frozen source has the wrong symbol"
    );
    let rows = source["datasets"][interval]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    for original in rows {
        let Some(time) = original["openTime"].as_i64() else {
            rejected += 1;
            continue;
        };
        if time < first || time >= cutoff {
            continue;
        }
        ensure!(
            original["symbol"]
                .as_str()
                .is_none_or(|name| nofx_core::exchange::strip_symbol(name) == symbol),
            "Frozen source candle has the wrong symbol"
        );
        let collected = nofx_core::timestamp(&original["refreshedAt"])
            .or_else(|| source["metadata"]["collected_at_ms"].as_i64())
            .or_else(|| source["metadata"]["as_of_ms"].as_i64());
        // A cached candle may now be old, while its cached OHLC was still partial when read.
        if time % duration != 0
            || collected.is_none_or(|at| at < time + duration)
            || original["confirmed"] == false
        {
            rejected += 1;
            continue;
        }
        let mut row = original.clone();
        row["confirmed"] = json!(true);
        if validate_candle(&row, time, duration, cutoff).is_err() {
            rejected += 1;
            continue;
        }
        if let Some(previous) = seed.insert(time, row.clone()) {
            ensure!(
                previous == row,
                "Frozen source contains conflicting duplicate {interval} candles at {time}"
            );
        }
    }
    Ok((seed, rejected))
}

async fn fetch_interval(
    exchange: &Exchange,
    symbol: &str,
    interval: &str,
    duration: i64,
    first: i64,
    cutoff: i64,
    mut rows: BTreeMap<i64, Value>,
) -> Result<Vec<Value>> {
    let expected = ((cutoff - first) / duration) as usize;
    let mut cursor = first;
    while cursor < cutoff {
        if rows.contains_key(&cursor) {
            cursor += duration;
            continue;
        }
        let gap_end = rows
            .range((cursor + duration)..cutoff)
            .next()
            .map(|(time, _)| *time)
            .unwrap_or(cutoff);
        let mut page = exchange
            .klines(symbol, interval, 1000, Some(cursor), Some(gap_end - 1))
            .await
            .with_context(|| format!("Fetch {symbol}/{interval} at {cursor}"))?;
        ensure!(
            !page.is_empty(),
            "Missing {symbol}/{interval} candles at {cursor}"
        );
        page.sort_by_key(|row| row["openTime"].as_i64().unwrap_or(-1));
        for row in page {
            validate_candle(&row, cursor, duration, gap_end)
                .with_context(|| format!("Invalid {symbol}/{interval} candle at {cursor}"))?;
            ensure!(
                rows.insert(cursor, row).is_none(),
                "Fetched candle overlaps frozen source"
            );
            cursor += duration;
        }
        eprintln!(
            "{symbol}/{interval}: {}/{expected} closed candles",
            rows.len()
        );
    }
    let rows: Vec<Value> = rows.into_values().collect();
    validate_rows(&rows, first, cutoff, duration)?;
    Ok(rows)
}

fn validate_candle(row: &Value, expected_open: i64, duration: i64, cutoff: i64) -> Result<()> {
    ensure!(
        row["openTime"].as_i64() == Some(expected_open),
        "Candles are missing, duplicated, or out of order"
    );
    ensure!(
        expected_open + duration <= cutoff,
        "Candle is not closed at frozen cutoff"
    );
    ensure!(
        row["closeTime"].as_i64() == Some(expected_open + duration - 1),
        "Unexpected candle closeTime"
    );
    ensure!(row["confirmed"] == true, "Unconfirmed candle");
    let value = |key: &str| -> Result<f64> {
        let n = row[key]
            .as_f64()
            .with_context(|| format!("Missing numeric {key}"))?;
        ensure!(n.is_finite(), "Invalid {key}");
        Ok(n)
    };
    let open = value("open")?;
    let high = value("high")?;
    let low = value("low")?;
    let close = value("close")?;
    ensure!(
        low > 0.0 && high >= open.max(close) && low <= open.min(close),
        "Invalid OHLC range"
    );
    ensure!(
        value("volume")? >= 0.0 && value("quoteVolume")? >= 0.0,
        "Negative volume"
    );
    ensure!(
        row["tradeCount"].as_i64().is_some_and(|n| n >= 0),
        "Invalid tradeCount"
    );
    Ok(())
}

fn validate_rows(rows: &[Value], first: i64, cutoff: i64, duration: i64) -> Result<()> {
    ensure!(
        cutoff > first && (cutoff - first) % duration == 0,
        "Invalid dataset bounds"
    );
    ensure!(
        rows.len() == ((cutoff - first) / duration) as usize,
        "Dataset is incomplete"
    );
    for (index, row) in rows.iter().enumerate() {
        validate_candle(row, first + index as i64 * duration, duration, cutoff)?;
    }
    Ok(())
}

fn validate_document(
    document: &Value,
    symbol: &str,
    start: i64,
    end: i64,
    intervals: &[(&str, i64, u32)],
) -> Result<()> {
    ensure!(
        document["symbol"] == symbol,
        "Frozen symbol does not match requested symbol"
    );
    let meta = &document["metadata"];
    ensure!(
        meta["schema_version"] == 1 && meta["as_of_ms"] == end && meta["start_ms"] == start,
        "Existing frozen dataset has different bounds or schema; use a new output directory"
    );
    ensure!(
        document["samples"].as_array().is_some_and(Vec::is_empty),
        "ML collection must not contain fabricated indicator samples"
    );
    for &(interval, duration, days) in intervals {
        let rows = document["datasets"][interval]
            .as_array()
            .context("Missing dataset")?;
        let first = (end - i64::from(days) * DAY_MS).div_euclid(duration) * duration;
        let cutoff = end.div_euclid(duration) * duration;
        validate_rows(rows, first, cutoff, duration)?;
        ensure!(
            meta["timeframes"][interval]["sha256"] == digest(rows)?,
            "Frozen dataset checksum mismatch"
        );
    }
    ensure!(
        meta["content_sha256"]
            == digest(&json!({"symbol":symbol,"datasets":document["datasets"]}))?,
        "Frozen content checksum mismatch"
    );
    Ok(())
}

fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

fn write_new(path: &Path, document: &Value) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("Create immutable file {}", path.display()))?;
    file.write_all(&serde_json::to_vec_pretty(document)?)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(first: i64, count: usize, duration: i64) -> Vec<Value> {
        (0..count).map(|index| {
            let open = first + index as i64 * duration;
            json!({"openTime":open,"closeTime":open+duration-1,"open":100.,"high":102.,
                "low":99.,"close":101.,"volume":20.,"quoteVolume":2020.,"tradeCount":2,"confirmed":true})
        }).collect()
    }

    #[test]
    fn rejects_missing_duplicate_unclosed_and_invalid_prices() {
        let first = 10 * HOUR_MS;
        let cutoff = 13 * HOUR_MS;
        let original = candles(first, 3, HOUR_MS);
        validate_rows(&original, first, cutoff, HOUR_MS).unwrap();
        let mut missing = original.clone();
        missing.remove(1);
        assert!(validate_rows(&missing, first, cutoff, HOUR_MS).is_err());
        let mut duplicate = original.clone();
        duplicate[1] = duplicate[0].clone();
        assert!(validate_rows(&duplicate, first, cutoff, HOUR_MS).is_err());
        let mut unclosed = original.clone();
        unclosed[2]["confirmed"] = json!(false);
        assert!(validate_rows(&unclosed, first, cutoff, HOUR_MS).is_err());
        let mut invalid = original;
        invalid[1]["high"] = json!(100.);
        assert!(validate_rows(&invalid, first, cutoff, HOUR_MS).is_err());
    }

    #[test]
    fn frozen_files_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("BTCUSDT.json");
        write_new(&path, &json!({"frozen":true})).unwrap();
        assert!(write_new(&path, &json!({"frozen":false})).is_err());
        let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["frozen"], true);
    }

    #[test]
    fn source_candles_must_have_been_closed_when_the_snapshot_was_taken() {
        let first = 10 * HOUR_MS;
        let mut original = candles(first, 3, HOUR_MS);
        for row in &mut original {
            row.as_object_mut().unwrap().remove("confirmed");
            row["refreshedAt"] = json!(nofx_core::iso(first + 2 * HOUR_MS));
        }
        let source = json!({"datasets":{"1h":original}});
        let (seed, rejected) = source_rows(
            Some(&source),
            "BTCUSDT",
            "1h",
            HOUR_MS,
            first,
            first + 3 * HOUR_MS,
        )
        .unwrap();
        assert_eq!(seed.len(), 2);
        assert_eq!(rejected, 1);
        assert!(seed.values().all(|row| row["confirmed"] == true));
    }
}
