use anyhow::{Context, Result, ensure};
use clap::{Parser, ValueEnum};
use futures::{StreamExt, stream};
use nofx_core::{
    exchange::Exchange,
    ml_dataset::{self, CandleInterval, DAY_MS, HOUR_MS},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Phase {
    Candles,
    History,
    All,
}

#[derive(Parser)]
#[command(
    about = "Resume public Binance USDT perpetual monthly data collection; never places orders"
)]
struct Args {
    #[arg(long, default_value = "data/ml/monthly-20261014")]
    output_dir: PathBuf,
    #[arg(long, default_value_t = 30)]
    days: u32,
    #[arg(long, default_value_t = 256)]
    warmup_hours: u32,
    #[arg(long, default_value_t = 4)]
    concurrency: usize,
    #[arg(long, value_enum, default_value = "all")]
    phase: Phase,
    /// Optional restricted smoke run; default freezes every active USDT perpetual.
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    /// An exclusive closed-hour UTC cutoff; a resume keeps the original frozen cutoff.
    #[arg(long)]
    end_ms: Option<i64>,
    /// Retry previously unavailable optional histories, preserving successful endpoint files.
    #[arg(long)]
    retry_failed: bool,
    /// Native market candles; optional contract histories retain their real cadence.
    #[arg(long, default_value = "1h", value_parser = CandleInterval::parse)]
    interval: CandleInterval,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!((1..=90).contains(&args.days), "days must be 1..=90");
    ensure!(
        (1..=8).contains(&args.concurrency),
        "concurrency must be 1..=8"
    );
    ensure!(args.warmup_hours <= 2048, "warmup-hours must be <=2048");
    fs::create_dir_all(&args.output_dir)?;
    let _writer = ml_dataset::collector_lock(&args.output_dir)?;
    let exchange = Exchange::public()?;
    let manifest_path = args.output_dir.join("manifest.json");
    let mut manifest = if manifest_path.exists() {
        let saved = ml_dataset::read_json(&manifest_path)?;
        ensure!(
            saved["schema_version"] == 1
                && saved["days"] == args.days
                && saved["warmup_hours"] == args.warmup_hours
                && saved["interval"].as_str().unwrap_or("1h") == args.interval.as_str(),
            "Resume parameters differ; use a new output directory"
        );
        ensure!(
            args.end_ms
                .is_none_or(|end| saved["end_ms"] == end.div_euclid(HOUR_MS) * HOUR_MS),
            "Resume cutoff differs"
        );
        saved
    } else {
        let server = exchange.public_request("/fapi/v1/time", &json!({})).await?;
        let closed_now = server["serverTime"]
            .as_i64()
            .context("Missing server time")?
            .div_euclid(HOUR_MS)
            * HOUR_MS;
        let end = args.end_ms.unwrap_or(closed_now).div_euclid(HOUR_MS) * HOUR_MS;
        ensure!(
            end <= closed_now
                && end > (i64::from(args.days) * DAY_MS + i64::from(args.warmup_hours) * HOUR_MS),
            "Invalid closed-hour cutoff"
        );
        let info = exchange
            .public_request("/fapi/v1/exchangeInfo", &json!({}))
            .await?;
        let universe = select_universe(&info, &args.symbols)?;
        let frozen_info = json!({"collected_at_ms":nofx_core::now_ms(),"historical_training_eligible":false,"data":info});
        let info_path = args.output_dir.join("snapshots/exchange-info.json");
        if !info_path.exists() {
            ml_dataset::write_new(&info_path, &frozen_info)?;
        }
        json!({"schema_version":1,"status":"collecting","train_ready":false,"days":args.days,"warmup_hours":args.warmup_hours,
            "interval":args.interval.as_str(),"interval_ms":args.interval.millis(),"context_bars":256,
            "start_ms":end-i64::from(args.days)*DAY_MS,"end_ms":end,"end_exclusive_ms":end,
            "lookback_start_ms":end-i64::from(args.days)*DAY_MS-i64::from(args.warmup_hours)*HOUR_MS,
            "collected_at_ms":nofx_core::now_ms(),"provider":"Binance USD-M public REST API",
            "universe":"current TRADING PERPETUAL quoteAsset=USDT marginAsset=USDT contracts; survivorship bias; not all global coins",
            "restricted_symbols":!args.symbols.is_empty(),"account_credentials_used":false,"orders_enabled":false,
            "snapshots_training_eligible":false,"symbols":universe})
    };
    let start = manifest["start_ms"].as_i64().context("Missing start")?;
    let end = manifest["end_ms"].as_i64().context("Missing end")?;
    let lookback = manifest["lookback_start_ms"]
        .as_i64()
        .context("Missing lookback")?;
    ml_dataset::checkpoint(&manifest_path, &manifest)?;
    if matches!(args.phase, Phase::Candles | Phase::All) {
        let jobs = manifest["symbols"]
            .as_array()
            .context("Missing universe")?
            .clone();
        let total = jobs.len();
        let directory = &args.output_dir;
        let mut completed = 0;
        let mut tasks = stream::iter(jobs.into_iter().map(|entry| {
            let exchange = exchange.clone();
            async move {
                let mut result = entry.clone();
                match collect_candles(
                    &exchange,
                    directory,
                    &entry,
                    lookback,
                    start,
                    end,
                    args.interval,
                )
                .await
                {
                    Ok(data) => {
                        for (key, value) in data.as_object().unwrap() {
                            result[key] = value.clone();
                        }
                    }
                    Err(error) => {
                        result["status"] = json!("failed");
                        result["training_eligible"] = json!(false);
                        result["error"] = json!(format!("{error:#}"));
                    }
                }
                result
            }
        }))
        .buffer_unordered(args.concurrency);
        while let Some(entry) = tasks.next().await {
            completed += 1;
            replace_entry(&mut manifest, entry.clone())?;
            update_status(&mut manifest, false)?;
            ml_dataset::checkpoint(&manifest_path, &manifest)?;
            eprintln!(
                "candles {completed}/{total} {} status={} rows={} eligible={}",
                entry["symbol"], entry["status"], entry["rows"], entry["training_eligible"]
            );
        }
        update_status(&mut manifest, true)?;
        ml_dataset::checkpoint(&manifest_path, &manifest)?;
    }
    if matches!(args.phase, Phase::History | Phase::All) {
        collect_snapshots(&exchange, &args.output_dir).await?;
        let jobs = manifest["symbols"].as_array().unwrap().clone();
        let total = jobs.len();
        let directory = &args.output_dir;
        let retry = args.retry_failed;
        let mut completed = 0;
        let mut tasks = stream::iter(jobs.into_iter().map(|entry| {
            let exchange = exchange.clone();
            async move {
                let mut result = entry.clone();
                match collect_history(&exchange, directory, &entry, start, end, retry).await {
                    Ok(history) => {
                        result["history_path"] = history["path"].clone();
                        result["history_sha256"] = history["sha256"].clone();
                        result["history_status"] = history["status"].clone();
                        result["history_errors"] = history["errors"].clone();
                    }
                    Err(error) => {
                        result["history_status"] = json!("failed");
                        result["history_errors"] = json!([format!("{error:#}")]);
                    }
                }
                result
            }
        }))
        .buffer_unordered(args.concurrency);
        while let Some(entry) = tasks.next().await {
            completed += 1;
            replace_entry(&mut manifest, entry.clone())?;
            ml_dataset::checkpoint(&manifest_path, &manifest)?;
            eprintln!(
                "history {completed}/{total} {} status={}",
                entry["symbol"], entry["history_status"]
            );
        }
        update_status(&mut manifest, true)?;
        let historical_errors = manifest["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["history_status"] != "complete")
            .count();
        manifest["history_complete"] = json!(true);
        manifest["history_all_available"] = json!(historical_errors == 0);
        manifest["history_unavailable_symbols"] = json!(historical_errors);
        manifest["status"] = json!(if manifest["failed_symbols"].as_u64().unwrap_or(0) == 0
            && historical_errors == 0
        {
            "complete"
        } else {
            "complete_with_errors"
        });
        ml_dataset::checkpoint(&manifest_path, &manifest)?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"manifest":manifest_path,"status":manifest["status"],"universe_symbols":manifest["symbols"].as_array().unwrap().len(),"successful_symbols":manifest["successful_symbols"],"eligible_symbols":manifest["eligible_symbols"],"failed_symbols":manifest["failed_symbols"],"start_ms":start,"end_ms":end})
        )?
    );
    Ok(())
}

fn select_universe(info: &Value, selected: &[String]) -> Result<Vec<Value>> {
    let normalized: Vec<_> = selected
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .collect();
    let selected: BTreeSet<_> = normalized.iter().cloned().collect();
    ensure!(selected.len() == normalized.len(), "Symbols must be unique");
    let mut rows = Vec::new();
    for contract in info["symbols"]
        .as_array()
        .context("Missing exchangeInfo symbols")?
    {
        if contract["status"] != "TRADING"
            || contract["contractType"] != "PERPETUAL"
            || contract["quoteAsset"] != "USDT"
            || contract["marginAsset"] != "USDT"
        {
            continue;
        }
        let symbol = contract["symbol"].as_str().context("Missing symbol")?;
        nofx_core::exchange::valid_symbol(symbol)?;
        if !selected.is_empty() && !selected.contains(symbol) {
            continue;
        }
        rows.push(json!({"symbol":symbol,"base_asset":contract["baseAsset"],"onboard_ms":contract["onboardDate"],"status":"pending","training_eligible":false,"history_status":"pending"}));
    }
    rows.sort_by(|a, b| a["symbol"].as_str().cmp(&b["symbol"].as_str()));
    ensure!(
        !rows.is_empty(),
        "No active contracts in requested universe"
    );
    ensure!(
        selected.is_empty() || rows.len() == selected.len(),
        "Requested symbol absent from active USDT perpetual universe"
    );
    Ok(rows)
}

async fn collect_candles(
    exchange: &Exchange,
    root: &Path,
    entry: &Value,
    lookback: i64,
    start: i64,
    end: i64,
    interval: CandleInterval,
) -> Result<Value> {
    let symbol = entry["symbol"].as_str().context("Missing symbol")?;
    nofx_core::exchange::valid_symbol(symbol)?;
    let relative = format!("symbols/{symbol}.json");
    let path = root.join(&relative);
    let doc = if path.exists() {
        let doc = ml_dataset::read_json(&path)?;
        ensure!(
            doc["symbol"] == symbol
                && doc["metadata"]["end_exclusive_ms"] == end
                && doc["metadata"]["training_start_ms"] == start
                && doc["metadata"]["lookback_start_ms"] == lookback
                && doc["metadata"]["interval"].as_str().unwrap_or("1h") == interval.as_str(),
            "Frozen symbol has different bounds"
        );
        ensure!(
            doc["metadata"]["content_sha256"] == ml_dataset::digest(&doc["datasets"])?,
            "Frozen candle content checksum mismatch"
        );
        doc
    } else {
        let mut rows = BTreeMap::<i64, Value>::new();
        let mut cursor = lookback;
        while cursor < end {
            let page = exchange
                .klines(symbol, interval.as_str(), 1000, Some(cursor), Some(end - 1))
                .await?;
            if page.is_empty() {
                break;
            }
            let mut last = cursor - 1;
            for mut row in page {
                let time = row["openTime"]
                    .as_i64()
                    .context("Invalid candle openTime")?;
                ensure!(
                    time >= cursor && time < end,
                    "Binance candle outside requested page"
                );
                last = last.max(time);
                if interval == CandleInterval::QuarterHour {
                    row["available_at_ms"] = json!(time + interval.millis());
                }
                ensure!(rows.insert(time, row).is_none(), "Duplicate Binance candle");
            }
            ensure!(last >= cursor, "Candle pagination made no progress");
            cursor = last + interval.millis();
        }
        let rows: Vec<_> = rows.into_values().collect();
        ensure!(!rows.is_empty(), "No closed native candles");
        let effective = rows[0]["openTime"].as_i64().unwrap();
        let coverage = if interval == CandleInterval::Hour {
            serde_json::to_value(ml_dataset::candle_coverage(&rows, effective, end)?)?
        } else {
            serde_json::to_value(ml_dataset::interval_candle_coverage(
                &rows,
                effective,
                end,
                interval.millis(),
            )?)?
        };
        let datasets = json!({interval.as_str():rows});
        let doc = json!({"symbol":symbol,"datasets":datasets,"samples":[],"metadata":{"schema_version":1,
            "source":"Binance public /fapi/v1/klines","source_base":std::env::var("BINANCE_FUTURES_BASE").unwrap_or_else(|_|"https://fapi.binance.com".into()),
            "collected_at_ms":nofx_core::now_ms(),"start_ms":effective,"lookback_start_ms":lookback,"training_start_ms":start,"end_exclusive_ms":end,
            "interval":interval.as_str(),"interval_ms":interval.millis(),"native_candles":true,"interpolated":false,
            "content_sha256":ml_dataset::digest(&datasets)?,"coverage":coverage,"closed_only":true,"immutable":true}});
        ml_dataset::write_new(&path, &doc)?;
        doc
    };
    let rows = doc["datasets"][interval.as_str()]
        .as_array()
        .context("Missing native rows")?;
    let effective = doc["metadata"]["start_ms"]
        .as_i64()
        .context("Missing start")?;
    let onboard = entry["onboard_ms"].as_i64().unwrap_or(0);
    // Older contracts must cover the requested left edge. Only a listing in
    // this interval can explain a shorter history (allow its first full hour).
    let expected_start = if onboard >= lookback
        && effective
            <= ((onboard + interval.millis() - 1) / interval.millis() + 1) * interval.millis()
    {
        effective
    } else {
        lookback
    };
    let coverage =
        ml_dataset::interval_candle_coverage(rows, expected_start, end, interval.millis())?;
    // A newly listed asset may be usable once a full context and future label exist.
    let eligible = coverage.complete
        && rows.len() >= 256 + 12 + 24
        && end > start.max(effective + 256 * interval.millis()) + 12 * interval.millis();
    let mut fields = json!({"path":relative,"sha256":ml_dataset::file_digest(&path)?,"rows":rows.len(),"effective_start_ms":effective,
        "status":if coverage.complete {"complete"} else {"partial"},"training_eligible":eligible,"missing_bars":coverage.missing_bars,"interval_ms":interval.millis(),
        "missing_hours":coverage.missing_bars as f64*interval.millis()as f64/HOUR_MS as f64,
        "missing_warmup_hours":((effective-lookback)/HOUR_MS).max(0),"coverage":coverage,"error":Value::Null});
    if interval == CandleInterval::Hour {
        fields["missing_hours"] = json!(coverage.missing_bars);
        fields["coverage"] =
            serde_json::to_value(ml_dataset::candle_coverage(rows, expected_start, end)?)?;
    }
    Ok(fields)
}

const HISTORIES: [(&str, &str, &str); 9] = [
    ("funding", "/fapi/v1/fundingRate", "fundingTime"),
    (
        "open_interest",
        "/futures/data/openInterestHist",
        "timestamp",
    ),
    (
        "global_long_short",
        "/futures/data/globalLongShortAccountRatio",
        "timestamp",
    ),
    (
        "top_account_long_short",
        "/futures/data/topLongShortAccountRatio",
        "timestamp",
    ),
    (
        "top_position_long_short",
        "/futures/data/topLongShortPositionRatio",
        "timestamp",
    ),
    (
        "taker_long_short",
        "/futures/data/takerlongshortRatio",
        "timestamp",
    ),
    ("basis", "/futures/data/basis", "timestamp"),
    ("mark_price_1h", "/fapi/v1/markPriceKlines", "openTime"),
    ("index_price_1h", "/fapi/v1/indexPriceKlines", "openTime"),
];

async fn collect_history(
    exchange: &Exchange,
    root: &Path,
    entry: &Value,
    start: i64,
    end: i64,
    retry: bool,
) -> Result<Value> {
    let symbol = entry["symbol"].as_str().context("Missing symbol")?;
    nofx_core::exchange::valid_symbol(symbol)?;
    let summary_relative = format!("history/{symbol}.json");
    let summary_path = root.join(&summary_relative);
    let mut datasets = serde_json::Map::new();
    let mut coverage = serde_json::Map::new();
    let mut errors = Vec::new();
    let endpoints = HISTORIES.into_iter().chain(std::iter::once((
        "premium_index_1h",
        "/fapi/v1/premiumIndexKlines",
        "openTime",
    )));
    for (name, endpoint, time_key) in endpoints {
        let relative = format!("history/{symbol}/{name}.json");
        let path = root.join(&relative);
        let error_path = root.join(format!("history/{symbol}/{name}.error.json"));
        let result = if path.exists() {
            ml_dataset::read_json(&path).and_then(|document| {
                ensure!(
                    document["symbol"] == symbol
                        && document["start_ms"] == start
                        && document["end_exclusive_ms"] == end,
                    "Frozen history bounds mismatch"
                );
                ensure!(
                    document["sha256"] == ml_dataset::digest(&document["rows"])?,
                    "Frozen history checksum mismatch"
                );
                Ok(document)
            })
        } else if error_path.exists() && !retry {
            Err(anyhow::anyhow!(
                "{}",
                ml_dataset::read_json(&error_path)?["error"]
                    .as_str()
                    .unwrap_or("Unavailable history")
            ))
        } else {
            match fetch_history(exchange, symbol, endpoint, time_key, start, end).await {
                Ok(rows) => {
                    let expected = if name == "funding" {
                        None
                    } else {
                        Some(((end - start) / HOUR_MS) as usize)
                    };
                    let doc = json!({"symbol":symbol,"endpoint":endpoint,"start_ms":start,"end_exclusive_ms":end,"collected_at_ms":nofx_core::now_ms(),
                        "rows":rows,"sha256":ml_dataset::digest(&rows)?,"coverage":{"rows":rows.len(),"first_ms":rows.first().and_then(|r|r[time_key].as_i64()),
                        "last_ms":rows.last().and_then(|r|r[time_key].as_i64()),"expected_rows":expected,"complete":expected.is_some_and(|n|n==rows.len()),
                        "availability_policy":if name=="funding" {"funding timestamp"} else {"period start + 1h; conservative publication bound; no archived receipt timestamp"}}});
                    ml_dataset::write_new(&path, &doc)?;
                    Ok(doc)
                }
                Err(error) => {
                    let failure = json!({"symbol":symbol,"endpoint":endpoint,"collected_at_ms":nofx_core::now_ms(),"error":format!("{error:#}")});
                    ml_dataset::checkpoint(&error_path, &failure)?;
                    Err(error)
                }
            }
        };
        match result {
            Ok(doc) => {
                datasets.insert(name.into(), doc["rows"].clone());
                coverage.insert(name.into(),json!({"path":relative,"sha256":ml_dataset::file_digest(&path)?,"coverage":doc["coverage"]}));
            }
            Err(error) => {
                datasets.insert(name.into(), json!([]));
                errors
                    .push(json!({"dataset":name,"endpoint":endpoint,"error":format!("{error:#}")}));
            }
        }
    }
    let status = if errors.is_empty() {
        "complete"
    } else if errors.len() == 10 {
        "unavailable"
    } else {
        "partial"
    };
    let summary = json!({"schema_version":1,"symbol":symbol,"start_ms":start,"end_exclusive_ms":end,"status":status,"datasets":datasets,"coverage":coverage,"errors":errors,
        "historical_training_eligible":true,"snapshots_included":false});
    ml_dataset::checkpoint(&summary_path, &summary)?;
    Ok(
        json!({"path":summary_relative,"sha256":ml_dataset::file_digest(&summary_path)?,"status":status,"errors":errors}),
    )
}

async fn fetch_history(
    exchange: &Exchange,
    symbol: &str,
    endpoint: &str,
    time_key: &str,
    start: i64,
    end: i64,
) -> Result<Vec<Value>> {
    let kline = time_key == "openTime";
    let funding = time_key == "fundingTime";
    // Statistics retain only the latest 30 days; do not make an invalid older request.
    let retained_start = if endpoint.starts_with("/futures/data/") {
        start.max((nofx_core::now_ms() - 30 * DAY_MS).div_euclid(HOUR_MS) * HOUR_MS + HOUR_MS)
    } else {
        start
    };
    let mut cursor = retained_start;
    let mut rows = BTreeMap::new();
    while cursor < end {
        let limit = if funding || kline { 1000 } else { 500 };
        let mut params = json!({"symbol":symbol,"limit":limit,"startTime":cursor,"endTime":end-1});
        if endpoint.contains("indexPriceKlines") {
            params.as_object_mut().unwrap().remove("symbol");
            params["pair"] = json!(symbol);
        }
        if endpoint.ends_with("/basis") {
            params.as_object_mut().unwrap().remove("symbol");
            params["pair"] = json!(symbol);
            params["contractType"] = json!("PERPETUAL");
        }
        if kline {
            params["interval"] = json!("1h");
        } else if !funding {
            params["period"] = json!("1h");
        }
        let response = exchange.public_request(endpoint, &params).await?;
        let page = response
            .as_array()
            .context("History endpoint did not return an array")?;
        if page.is_empty() {
            break;
        }
        let mut last = cursor - 1;
        for raw in page {
            let mut row = if kline {
                normalize_reference_kline(raw)?
            } else {
                raw.clone()
            };
            let at = row[time_key]
                .as_i64()
                .context("History timestamp missing")?;
            ensure!(at >= cursor && at < end, "Out-of-range history timestamp");
            ensure!(funding || at % HOUR_MS == 0, "Non-hourly history timestamp");
            row["available_at_ms"] = json!(at + if funding { 0 } else { HOUR_MS });
            last = last.max(at);
            ensure!(
                rows.insert(at, row).is_none(),
                "Duplicate history timestamp"
            );
        }
        ensure!(last >= cursor, "History pagination made no progress");
        cursor = last + if funding { 1 } else { HOUR_MS };
        if page.len() < limit {
            break;
        }
    }
    ensure!(!rows.is_empty(), "No retained rows from {endpoint}");
    Ok(rows.into_values().collect())
}

fn normalize_reference_kline(raw: &Value) -> Result<Value> {
    let values = raw.as_array().context("Reference kline is not an array")?;
    ensure!(values.len() >= 7, "Reference kline lacks fields");
    let time = values[0].as_i64().context("Missing reference timestamp")?;
    let mut row = json!({"openTime":time,"closeTime":values[6],"confirmed":true});
    for (index, key) in [(1, "open"), (2, "high"), (3, "low"), (4, "close")] {
        let number = values[index]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .or_else(|| values[index].as_f64())
            .context("Invalid reference OHLC")?;
        ensure!(number.is_finite(), "Nonfinite reference OHLC");
        row[key] = json!(number);
    }
    ensure!(
        row["closeTime"].as_i64() == Some(time + HOUR_MS - 1),
        "Unclosed reference kline"
    );
    ensure!(
        row["high"].as_f64().unwrap()
            >= row["open"]
                .as_f64()
                .unwrap()
                .max(row["close"].as_f64().unwrap())
            && row["low"].as_f64().unwrap()
                <= row["open"]
                    .as_f64()
                    .unwrap()
                    .min(row["close"].as_f64().unwrap()),
        "Invalid reference OHLC range"
    );
    Ok(row)
}

async fn collect_snapshots(exchange: &Exchange, root: &Path) -> Result<()> {
    for (name, endpoint) in [
        ("ticker-24h", "/fapi/v1/ticker/24hr"),
        ("premium-index", "/fapi/v1/premiumIndex"),
        ("book-ticker", "/fapi/v1/ticker/bookTicker"),
        ("funding-info", "/fapi/v1/fundingInfo"),
    ] {
        let path = root.join(format!("snapshots/{name}.json"));
        if path.exists() {
            continue;
        }
        let collected = nofx_core::now_ms();
        let result = exchange.public_request(endpoint, &json!({})).await;
        let value = match result {
            Ok(data) => {
                json!({"endpoint":endpoint,"collected_at_ms":collected,"historical_training_eligible":false,"data":data})
            }
            Err(error) => {
                json!({"endpoint":endpoint,"collected_at_ms":collected,"historical_training_eligible":false,"error":format!("{error:#}")})
            }
        };
        ml_dataset::write_new(&path, &value)?;
    }
    Ok(())
}

fn replace_entry(manifest: &mut Value, entry: Value) -> Result<()> {
    let old = manifest["symbols"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|old| old["symbol"] == entry["symbol"])
        .context("Manifest symbol disappeared")?;
    *old = entry;
    Ok(())
}

fn update_status(manifest: &mut Value, finished: bool) -> Result<()> {
    let entries = manifest["symbols"]
        .as_array()
        .context("Missing manifest entries")?;
    let successful = entries.iter().filter(|e| e["status"] == "complete").count();
    let failed = entries
        .iter()
        .filter(|e| e["status"] == "failed" || e["status"] == "partial")
        .count();
    let eligible = entries
        .iter()
        .filter(|e| e["training_eligible"] == true)
        .count();
    let pending = entries.iter().filter(|e| e["status"] == "pending").count();
    manifest["successful_symbols"] = json!(successful);
    manifest["failed_symbols"] = json!(failed);
    manifest["eligible_symbols"] = json!(eligible);
    manifest["pending_symbols"] = json!(pending);
    manifest["train_ready"] = json!(finished && pending == 0 && eligible > 0);
    manifest["status"] = json!(if finished && pending == 0 {
        if failed == 0 {
            "candles_complete"
        } else {
            "candles_complete_with_errors"
        }
    } else {
        "collecting"
    });
    manifest["updated_at_ms"] = json!(nofx_core::now_ms());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn universe_excludes_nonperpetual_or_nontrading_and_requires_requested_symbols() {
        let item = |name: &str, status: &str, kind: &str| json!({"symbol":name,"status":status,"contractType":kind,"quoteAsset":"USDT","marginAsset":"USDT"});
        let info = json!({"symbols":[item("BTCUSDT","TRADING","PERPETUAL"),item("ETHUSDT","BREAK","PERPETUAL"),item("SOLUSDT","TRADING","CURRENT_QUARTER")]});
        let universe = select_universe(&info, &[]).unwrap();
        assert_eq!(universe.len(), 1);
        assert_eq!(universe[0]["symbol"], "BTCUSDT");
        assert!(select_universe(&info, &["ETHUSDT".into()]).is_err());
    }
    #[test]
    fn reference_kline_checks_closed_boundary_and_preserves_negative_premium() {
        let raw = json!([
            HOUR_MS,
            "-0.1",
            "0.1",
            "-0.2",
            "-0.05",
            "0",
            2 * HOUR_MS - 1
        ]);
        assert_eq!(normalize_reference_kline(&raw).unwrap()["close"], -0.05);
        let mut invalid = raw;
        invalid[6] = json!(2 * HOUR_MS);
        assert!(normalize_reference_kline(&invalid).is_err());
    }
}
