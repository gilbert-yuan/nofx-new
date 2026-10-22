//! Offline, finite-capital altcoin portfolio replay using the production paper simulator.
//! Optional public-history repairs are cached separately; no order API is loaded.
use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use nofx_core::strategies::altcoin_breakout::PreparedSeries;
use nofx_core::{
    exchange::Exchange, iso, ml_archive, number, paper, simulator, strategies, timestamp,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const HOUR: i64 = 3_600_000;
const FOUR_HOURS: i64 = 4 * HOUR;
const DAY: i64 = 24 * HOUR;
const BREAKOUT: &str = "altcoin-trend-breakout-v1";
const LIVE: &str = "altcoin-trend-breakout-live-v1";

#[derive(Parser)]
#[command(
    about = "Offline altcoin breakout replay: 4h signals, actual 1h execution, historical funding"
)]
struct Args {
    #[arg(long, default_value = "data/ml/expanded-archive-20261016")]
    archive_dir: PathBuf,
    #[arg(
        long,
        default_value = "data/ml/intraday-15m-20261017/snapshots/exchange-info.json"
    )]
    listing_file: PathBuf,
    #[arg(long, default_value = "output/altcoin-trend-backtest")]
    output_dir: PathBuf,
    #[arg(long)]
    start_ms: Option<i64>,
    #[arg(long)]
    end_ms: Option<i64>,
    #[arg(long)]
    holdout_ms: Option<i64>,
    #[arg(long, default_value_t = 10000.)]
    initial: f64,
    #[arg(long, default_value_t = 30)]
    top_n: usize,
    #[arg(long, default_value_t = 180)]
    listing_days: i64,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    /// Diagnostic short run; rankings still use the entire retained historical universe.
    #[arg(long)]
    inspect_only: bool,
    /// Fetch missing historical observations from public GET endpoints into output/repairs.
    #[arg(long, default_value_t = false)]
    repair_history: bool,
    /// Frozen {id,strategy,params} candidate or finite array; defaults to the current strategy.
    #[arg(long)]
    search_grid: Option<PathBuf>,
    /// Explicit diagnostic cap; a capped run is reported as an incomplete search.
    #[arg(long)]
    search_limit: Option<usize>,
    /// Continue a matching optimization journal without repeating completed candidates.
    #[arg(long, default_value_t = false)]
    resume: bool,
}

#[derive(Clone, Debug)]
struct SearchCandidate {
    id: String,
    strategy: String,
    params: Value,
}

#[derive(Clone, Debug)]
struct Candle {
    at: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    quote: f64,
}
impl Candle {
    fn from_value(row: &Value) -> Result<Self> {
        ensure!(simulator::valid_candle(row), "Invalid archive candle");
        let at = timestamp(&row["openTime"]).context("Missing openTime")?;
        let quote = number(&row["quoteVolume"], f64::NAN);
        ensure!(
            at % HOUR == 0 && quote.is_finite() && quote >= 0.,
            "Invalid timestamp/quoteVolume"
        );
        Ok(Self {
            at,
            open: number(&row["open"], 0.),
            high: number(&row["high"], 0.),
            low: number(&row["low"], 0.),
            close: number(&row["close"], 0.),
            volume: number(&row["volume"], 0.),
            quote,
        })
    }
    fn value(&self, duration: i64) -> Value {
        json!({"openTime":self.at,"closeTime":self.at+duration-1,"confirmed":true,
            "open":self.open,"high":self.high,"low":self.low,"close":self.close,
            "volume":self.volume,"quoteVolume":self.quote})
    }
}

struct Candidate {
    symbol: String,
    path: PathBuf,
    history: PathBuf,
    onboard: i64,
    bars: Vec<Candle>,
    sha256: String,
    inactive: bool,
}

struct Market {
    symbol: String,
    h4: Vec<Value>,
    hourly: BTreeMap<i64, Value>,
    funding: Value,
    metadata: Value,
}

fn read_json(path: &Path) -> Result<(Value, String)> {
    let bytes = fs::read(path).with_context(|| format!("Read {}", path.display()))?;
    let hash = hex::encode(Sha256::digest(&bytes));
    let text = std::str::from_utf8(&bytes)?;
    Ok((
        serde_json::from_str(text.trim_start_matches('\u{feff}'))?,
        hash,
    ))
}

fn hours(doc: &Value) -> Result<Vec<Candle>> {
    let rows = doc["datasets"]["1h"]
        .as_array()
        .context("Archive has no 1h candles")?;
    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        let candle = Candle::from_value(row)?;
        ensure!(
            output
                .last()
                .is_none_or(|last: &Candle| last.at < candle.at),
            "Unsorted/duplicate archive candles"
        );
        output.push(candle);
    }
    Ok(output)
}

/// Incomplete groups are discarded; OHLC paths are never interpolated.
fn aggregate_four_hours(rows: &[Candle]) -> Vec<Candle> {
    let mut output = Vec::new();
    let mut index = 0;
    while index + 4 <= rows.len() {
        let first = &rows[index];
        if first.at % FOUR_HOURS != 0
            || !(0..4).all(|k| rows[index + k].at == first.at + k as i64 * HOUR)
        {
            index += 1;
            continue;
        }
        let group = &rows[index..index + 4];
        output.push(Candle {
            at: first.at,
            open: first.open,
            high: group
                .iter()
                .map(|c| c.high)
                .fold(f64::NEG_INFINITY, f64::max),
            low: group.iter().map(|c| c.low).fold(f64::INFINITY, f64::min),
            close: group[3].close,
            volume: group.iter().map(|c| c.volume).sum(),
            quote: group.iter().map(|c| c.quote).sum(),
        });
        index += 4;
    }
    output
}

fn excluded_symbol(symbol: &str) -> bool {
    let base = symbol.strip_suffix("USDT").unwrap_or(symbol);
    [
        "BTC", "ETH", "USDT", "USDC", "BUSD", "FDUSD", "TUSD", "USDP", "DAI", "USDD", "USD1",
        "USDE", "USTC", "PAXG", "XAUT",
    ]
    .contains(&base)
}

fn listing_map(doc: &Value) -> Result<BTreeMap<String, Value>> {
    let rows = doc["data"]["symbols"]
        .as_array()
        .or_else(|| doc["symbols"].as_array())
        .context("No exchange-info symbols")?;
    Ok(rows
        .iter()
        .filter_map(|row| Some((row["symbol"].as_str()?.to_string(), row.clone())))
        .collect())
}

fn load_candidates(
    args: &Args,
    manifest: &Value,
    listing: &Value,
) -> Result<(Vec<Candidate>, Value)> {
    let definitions = listing_map(listing)?;
    let requested: BTreeSet<_> = args
        .symbols
        .iter()
        .map(|s| s.to_ascii_uppercase())
        .collect();
    let mut candidates = Vec::new();
    let mut exclusions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for item in manifest["symbols"]
        .as_array()
        .context("No archive symbols")?
    {
        let Some(symbol) = item["symbol"].as_str() else {
            continue;
        };
        if !requested.is_empty() && !requested.contains(symbol) {
            continue;
        }
        let reason = if excluded_symbol(symbol) || !symbol.ends_with("USDT") {
            Some("excluded_asset")
        } else if !definitions.contains_key(symbol) {
            Some("listing_metadata_missing")
        } else {
            let definition = &definitions[symbol];
            if definition["underlyingType"] != "COIN" || definition["contractType"] != "PERPETUAL" {
                Some("non_crypto_or_non_perpetual")
            } else if definition["onboardDate"].as_i64().is_none_or(|t| t <= 0) {
                Some("onboard_date_missing")
            } else {
                None
            }
        };
        if let Some(reason) = reason {
            exclusions
                .entry(reason.into())
                .or_default()
                .push(symbol.into());
            continue;
        }
        let Some(path) = item["path"].as_str() else {
            exclusions
                .entry("archive_path_missing".into())
                .or_default()
                .push(symbol.into());
            continue;
        };
        let full_path = args.archive_dir.join(path);
        let loaded = read_json(&full_path)
            .and_then(|(doc, hash)| Ok((aggregate_four_hours(&hours(&doc)?), hash)));
        match loaded {
            Ok((bars, sha256)) if bars.len() >= 180 => {
                let history = item["history_path"]
                    .as_str()
                    .map(|p| args.archive_dir.join(p))
                    .unwrap_or_else(|| {
                        args.archive_dir
                            .join("history")
                            .join(format!("{symbol}.json"))
                    });
                candidates.push(Candidate {
                    symbol: symbol.into(),
                    path: full_path,
                    history,
                    onboard: definitions[symbol]["onboardDate"].as_i64().unwrap(),
                    bars,
                    sha256,
                    inactive: item["inactive_at_window_end"] == true,
                });
            }
            Ok(_) => exclusions
                .entry("insufficient_closed_4h_history".into())
                .or_default()
                .push(symbol.into()),
            Err(error) => exclusions
                .entry(format!("archive_error: {error}"))
                .or_default()
                .push(symbol.into()),
        }
    }
    candidates.sort_by(|a, b| a.symbol.cmp(&b.symbol));
    ensure!(
        !candidates.is_empty(),
        "No valid historical crypto candidates"
    );
    Ok((candidates, json!(exclusions)))
}

/// Rankings use exactly the preceding 30 days of complete 4h candles.
fn rank_universe(
    candidates: &[Candidate],
    start: i64,
    end: i64,
    top: usize,
    listing_days: i64,
) -> BTreeMap<i64, Vec<usize>> {
    let mut rankings = BTreeMap::new();
    for at in (start..end).step_by(FOUR_HOURS as usize) {
        let mut scores = Vec::new();
        for (index, candidate) in candidates.iter().enumerate() {
            if at - candidate.onboard < listing_days * DAY {
                continue;
            }
            let count = candidate.bars.partition_point(|c| c.at + FOUR_HOURS <= at);
            if count < 180 {
                continue;
            }
            let tail = &candidate.bars[count - 180..count];
            if tail[0].at != at - 30 * DAY
                || tail[179].at + FOUR_HOURS != at
                || !tail.windows(2).all(|w| w[1].at - w[0].at == FOUR_HOURS)
            {
                continue;
            }
            let volume = tail.iter().map(|c| c.quote).sum::<f64>();
            if volume > 0. {
                scores.push((index, volume));
            }
        }
        scores.sort_by(|a, b| {
            b.1.total_cmp(&a.1)
                .then_with(|| candidates[a.0].symbol.cmp(&candidates[b.0].symbol))
        });
        rankings.insert(at, scores.into_iter().take(top).map(|(i, _)| i).collect());
    }
    rankings
}

fn interval_hours(row: &Value) -> f64 {
    let hours = number(&row["fundingIntervalHours"], 8.);
    if hours.is_finite() && (0.25..=24.).contains(&hours) {
        hours
    } else {
        8.
    }
}

fn funding_repair_windows(rows: &[Value], start: i64, end: i64) -> Vec<(i64, i64)> {
    let mut ordered: Vec<_> = rows
        .iter()
        .filter_map(|r| Some((timestamp(&r["fundingTime"])?, r)))
        .collect();
    ordered.sort_by_key(|(at, _)| *at);
    let Some(&(first, _)) = ordered.first() else {
        return vec![(start, end)];
    };
    let mut windows = Vec::new();
    if first > start {
        windows.push((start, (first + 1000).min(end)));
    }
    for pair in ordered.windows(2) {
        let (left, left_row) = pair[0];
        let (right, right_row) = pair[1];
        let expected = interval_hours(left_row).max(interval_hours(right_row)) * HOUR as f64;
        if (right - left) as f64 > expected + 1000. && right > start && left < end {
            windows.push(((left - 1000).max(start), (right + 1000).min(end)));
        }
    }
    let &(last, row) = ordered.last().unwrap();
    if last + ((interval_hours(row) * HOUR as f64) as i64) < end {
        windows.push(((last - 1000).max(start), end));
    }
    windows.retain(|(left, right)| left < right);
    windows
}

fn mark_repair_windows(rows: &[Value], start: i64, end: i64) -> Vec<(i64, i64)> {
    let known: BTreeSet<_> = rows
        .iter()
        .filter_map(|r| timestamp(&r["openTime"]))
        .collect();
    let mut windows = Vec::new();
    let mut missing_start = None;
    for at in (start - HOUR..end).step_by(HOUR as usize) {
        if !known.contains(&at) {
            missing_start.get_or_insert(at);
        } else if let Some(left) = missing_start.take() {
            windows.push((left, at));
        }
    }
    if let Some(left) = missing_start {
        windows.push((left, end));
    }
    windows
}

/// One public request has the Exchange client's bounded retry and shared rate-limit policy.
/// Errors are cached too, so a repeated run cannot turn a failed window into an unbounded retry.
async fn cached_public_history(
    exchange: &Exchange,
    endpoint: &str,
    params: &Value,
    path: &Path,
) -> Result<Value> {
    if path.exists() {
        let (cached, _) = read_json(path)?;
        ensure!(
            cached["endpoint"] == endpoint && cached["params"] == *params,
            "Repair cache parameters do not match"
        );
        if let Some(error) = cached["error"].as_str() {
            bail!("Cached public-history failure: {error}");
        }
        return Ok(cached["response"].clone());
    }
    fs::create_dir_all(path.parent().context("Repair cache has no parent")?)?;
    let fetched = nofx_core::now_ms();
    match exchange.public_request(endpoint, params).await {
        Ok(response) => {
            let envelope = json!({"schema_version":1,"method":"GET","endpoint":endpoint,
                "source_base":exchange.base(),"params":params,"fetched_at_ms":fetched,"response":response});
            fs::write(path, serde_json::to_vec_pretty(&envelope)?)?;
            Ok(envelope["response"].clone())
        }
        Err(error) => {
            let envelope = json!({"schema_version":1,"method":"GET","endpoint":endpoint,
                "source_base":exchange.base(),"params":params,"fetched_at_ms":fetched,"error":error.to_string()});
            fs::write(path, serde_json::to_vec_pretty(&envelope)?)?;
            Err(error)
        }
    }
}

fn merge_funding_rows(original: &[Value], repair: &[Value]) -> Vec<Value> {
    // Archive calc_time and REST can differ by a few milliseconds for the same
    // scheduled settlement. Prefer the API's unmodified timestamp once per second.
    let mut rows: BTreeMap<i64, Value> = original
        .iter()
        .filter_map(|r| Some((timestamp(&r["fundingTime"])? / 1000, r.clone())))
        .collect();
    for row in repair {
        if let Some(at) = timestamp(&row["fundingTime"]) {
            rows.insert(at / 1000, row.clone());
        }
    }
    rows.into_values().collect()
}

fn merge_mark_rows(original: &[Value], repair: &[Value]) -> Vec<Value> {
    let mut rows: BTreeMap<i64, Value> = original
        .iter()
        .filter_map(|r| Some((timestamp(&r["openTime"])?, r.clone())))
        .collect();
    for row in repair {
        if let Some(at) = timestamp(&row["openTime"]) {
            rows.insert(at, row.clone());
        }
    }
    rows.into_values().collect()
}

async fn repair_market_history(
    exchange: &Exchange,
    candidate: &Candidate,
    start: i64,
    end: i64,
    root: &Path,
) -> Result<Value> {
    let (history, history_sha) = read_json(&candidate.history)?;
    let original_funding = history["datasets"]["funding"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let original_marks = history["datasets"]["mark_price_1h"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let directory = root.join(&candidate.symbol).join(format!("{start}-{end}"));
    let overlay_path = directory.join("overlay.json");
    if overlay_path.exists() {
        let (overlay, _) = read_json(&overlay_path)?;
        ensure!(
            overlay["source_history_sha256"] == history_sha
                && overlay["start_ms"] == start
                && overlay["end_ms"] == end,
            "Historical repair overlay does not match its original source/window"
        );
        return Ok(overlay);
    }
    fs::create_dir_all(&directory)?;
    let funding_windows = funding_repair_windows(&original_funding, start, end);
    let mark_windows = mark_repair_windows(&original_marks, start, end);
    let mut funding_repairs = Vec::new();
    let mut mark_repairs = Vec::new();
    let mut failures = Vec::new();
    let mut sources = Vec::new();
    for (kind, endpoint, windows) in [
        ("funding", "/fapi/v1/fundingRate", &funding_windows),
        ("mark_price_1h", "/fapi/v1/markPriceKlines", &mark_windows),
    ] {
        if windows.len() > 32 {
            failures.push(
                json!({"kind":kind,"error":"More than 32 missing windows; repair requests capped"}),
            );
        }
        for (window_index, &(left, right)) in windows.iter().take(32).enumerate() {
            let mut cursor = left;
            let mut completed = false;
            for page in 0..8 {
                if cursor >= right {
                    completed = true;
                    break;
                }
                let mut params = json!({"symbol":candidate.symbol,"startTime":cursor,"endTime":right-1,"limit":1000});
                if kind == "mark_price_1h" {
                    params["interval"] = json!("1h");
                }
                let cache = directory.join(format!("{kind}-window{window_index}-page{page}.json"));
                let response = match cached_public_history(exchange, endpoint, &params, &cache)
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        failures.push(json!({"kind":kind,"start_ms":left,"end_ms":right,"error":error.to_string()}));
                        break;
                    }
                };
                let (_, cache_sha) = read_json(&cache)?;
                sources.push(
                    json!({"path":cache,"sha256":cache_sha,"endpoint":endpoint,"params":params}),
                );
                let Some(rows) = response.as_array() else {
                    failures.push(
                        json!({"kind":kind,"error":"Public history response is not an array"}),
                    );
                    break;
                };
                if rows.is_empty() {
                    completed = true;
                    break;
                }
                let parsed: Result<(Vec<Value>, i64)> = if kind == "funding" {
                    (|| {
                        let mut parsed = Vec::new();
                        let mut latest = cursor - 1;
                        for row in rows {
                            let at = timestamp(&row["fundingTime"])
                                .context("API fundingTime missing")?;
                            let rate = number(&row["fundingRate"], f64::NAN);
                            ensure!(
                                at >= cursor && at < right && rate.is_finite(),
                                "Invalid API funding record"
                            );
                            let mark = number(&row["markPrice"], f64::NAN);
                            ensure!(
                                mark.is_finite() && mark > 0.,
                                "API funding settlement has no positive actual markPrice"
                            );
                            let nearest = original_funding
                                .iter()
                                .filter_map(|r| {
                                    Some(((timestamp(&r["fundingTime"])? - at).abs(), r))
                                })
                                .min_by_key(|(distance, _)| *distance)
                                .map(|(_, r)| interval_hours(r))
                                .unwrap_or(8.);
                            parsed.push(json!({"fundingTime":at,"fundingRate":rate,"markPrice":mark,
                                "fundingIntervalHours":nearest,"interval_source":"nearest_original_archive_metadata","source":"Binance public fundingRate REST"}));
                            latest = latest.max(at);
                        }
                        Ok((parsed, latest + 1))
                    })()
                } else {
                    (|| {
                        let records = rows
                            .iter()
                            .map(|row| {
                                row.as_array()
                                    .context("Invalid public mark kline")
                                    .map(|fields| {
                                        fields
                                            .iter()
                                            .map(|v| {
                                                v.as_str()
                                                    .map(str::to_string)
                                                    .unwrap_or_else(|| v.to_string())
                                            })
                                            .collect::<Vec<_>>()
                                    })
                            })
                            .collect::<Result<Vec<_>>>()?;
                        let parsed = ml_archive::reference_klines(&records, left, right)?;
                        ensure!(
                            parsed.iter().all(|r| number(&r["low"], 0.) > 0.),
                            "Nonpositive public mark price"
                        );
                        let next = parsed
                            .last()
                            .and_then(|r| timestamp(&r["openTime"]))
                            .context("Public mark page has no valid closed candle")?
                            + HOUR;
                        Ok((parsed, next))
                    })()
                };
                match parsed {
                    Ok((parsed, next)) => {
                        if kind == "funding" {
                            funding_repairs.extend(parsed);
                        } else {
                            mark_repairs.extend(parsed);
                        }
                        if next <= cursor {
                            failures.push(json!({"kind":kind,"error":"Public pagination cursor did not advance"}));
                            break;
                        }
                        cursor = next;
                        if rows.len() < 1000 || cursor >= right {
                            completed = true;
                            break;
                        }
                    }
                    Err(error) => {
                        failures.push(json!({"kind":kind,"error":error.to_string()}));
                        break;
                    }
                }
            }
            if !completed && cursor < right {
                failures.push(json!({"kind":kind,"start_ms":cursor,"end_ms":right,"error":"Window repair incomplete after bounded requests"}));
            }
        }
    }
    let funding = merge_funding_rows(&original_funding, &funding_repairs);
    let marks = merge_mark_rows(&original_marks, &mark_repairs);
    let remaining_funding = funding_repair_windows(&funding, start, end);
    let remaining_marks = mark_repair_windows(&marks, start, end);
    if !remaining_funding.is_empty() {
        failures.push(json!({"kind":"funding","error":"Actual public responses did not resolve all funding gaps","remaining_windows":remaining_funding}));
    }
    if !remaining_marks.is_empty() {
        failures.push(json!({"kind":"mark_price_1h","error":"Actual public responses did not resolve all mark gaps","remaining_windows":remaining_marks}));
    }
    let overlay = json!({"schema_version":1,"symbol":candidate.symbol,"source_history_sha256":history_sha,
        "start_ms":start,"end_ms":end,"created_at_ms":nofx_core::now_ms(),"orders_enabled":false,
        "original_funding_windows":funding_windows,"original_mark_windows":mark_windows,
        "funding_records":funding_repairs,"mark_price_1h_records":mark_repairs,"sources":sources,
        "remaining_funding_windows":remaining_funding,"remaining_mark_windows":remaining_marks,"failures":failures});
    fs::write(&overlay_path, serde_json::to_vec_pretty(&overlay)?)?;
    println!(
        "{} public repairs: funding={}, marks={}, failures={}",
        candidate.symbol,
        overlay["funding_records"].as_array().map_or(0, Vec::len),
        overlay["mark_price_1h_records"]
            .as_array()
            .map_or(0, Vec::len),
        overlay["failures"].as_array().map_or(0, Vec::len)
    );
    Ok(overlay)
}

fn load_market(
    candidate: &Candidate,
    start: i64,
    end: i64,
    repair: Option<&Value>,
) -> Result<Market> {
    let (doc, _) = read_json(&candidate.path)?;
    let raw = hours(&doc)?;
    let (history, history_sha) = read_json(&candidate.history)?;
    let repair_overlay_sha = repair
        .map(|overlay| serde_json::to_vec(overlay).map(|bytes| hex::encode(Sha256::digest(&bytes))))
        .transpose()?;
    let original_funding = history["datasets"]["funding"]
        .as_array()
        .context("Missing historical funding")?;
    let funding = merge_funding_rows(
        original_funding,
        repair
            .and_then(|r| r["funding_records"].as_array())
            .map_or(&[] as &[Value], Vec::as_slice),
    );
    ensure!(
        !funding.is_empty(),
        "Empty historical funding is not evidence of zero rates"
    );
    let original_marks = history["datasets"]["mark_price_1h"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let merged_marks = merge_mark_rows(
        &original_marks,
        repair
            .and_then(|r| r["mark_price_1h_records"].as_array())
            .map_or(&[] as &[Value], Vec::as_slice),
    );
    let marks: BTreeMap<i64, &Value> = merged_marks
        .iter()
        .filter_map(|row| Some((timestamp(&row["openTime"])?, row)))
        .collect();
    let mut hourly = BTreeMap::new();
    let mut missing_mark = 0usize;
    for candle in &raw {
        if candle.at + HOUR < start || candle.at >= end {
            continue;
        }
        let mut row = candle.value(HOUR);
        if let Some(mark) = marks.get(&candle.at) {
            for (to, from) in [
                ("markOpen", "open"),
                ("markHigh", "high"),
                ("markLow", "low"),
                ("markClose", "close"),
            ] {
                ensure!(
                    number(&mark[from], 0.) > 0.,
                    "Invalid historical mark price"
                );
                row[to] = mark[from].clone();
            }
        } else {
            missing_mark += 1;
        }
        hourly.insert(candle.at, row);
    }
    let mut normalized = Vec::new();
    let mut mark_fallback = 0;
    for item in &funding {
        let at = timestamp(&item["fundingTime"]).context("Missing fundingTime")?;
        let rate = number(&item["fundingRate"], f64::NAN);
        ensure!(rate.is_finite(), "Invalid funding rate");
        let hour = at.div_euclid(HOUR) * HOUR;
        // A past mark is used, never the close of the funding hour (future information).
        let mark = item["markPrice"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.)
            .or_else(|| {
                marks
                    .get(&(hour - HOUR))
                    .map(|r| number(&r["close"], 0.))
                    .filter(|v| *v > 0.)
            });
        let mark = if let Some(mark) = mark {
            mark
        } else {
            mark_fallback += 1;
            raw.binary_search_by_key(&(hour - HOUR), |c| c.at)
                .ok()
                .map(|i| raw[i].close)
                .or_else(|| {
                    raw.binary_search_by_key(&hour, |c| c.at)
                        .ok()
                        .map(|i| raw[i].open)
                })
                .context("No historical price for funding settlement")?
        };
        normalized.push(json!({"fundingTime":at,"fundingRate":rate,"markPrice":mark,
            "fundingIntervalHours":number(&item["fundingIntervalHours"],8.)}));
    }
    normalized.sort_by_key(|r| timestamp(&r["fundingTime"]).unwrap());
    let first = timestamp(&normalized[0]["fundingTime"]).unwrap();
    let last = timestamp(&normalized.last().unwrap()["fundingTime"]).unwrap();
    let tail_hours = number(&normalized.last().unwrap()["fundingIntervalHours"], 8.);
    ensure!(
        first <= start && last + (tail_hours * HOUR as f64) as i64 >= end,
        "Funding does not cover full measurement window: {} .. {}",
        iso(first),
        iso(last)
    );
    for pair in normalized.windows(2) {
        let left = timestamp(&pair[0]["fundingTime"]).unwrap();
        let right = timestamp(&pair[1]["fundingTime"]).unwrap();
        if right <= start || left >= end {
            continue;
        }
        let gap = right - left;
        let expected = number(&pair[0]["fundingIntervalHours"], 8.)
            .max(number(&pair[1]["fundingIntervalHours"], 8.))
            * HOUR as f64;
        ensure!(
            gap > 0 && gap as f64 <= expected + 1000.,
            "Funding history has duplicate timestamps or a settlement gap"
        );
    }
    Ok(Market {
        symbol: candidate.symbol.clone(),
        h4: candidate.bars.iter().map(|c| c.value(FOUR_HOURS)).collect(),
        hourly,
        funding: json!(normalized),
        metadata: json!({"symbol":candidate.symbol,"candles_sha256":candidate.sha256,
            "history_sha256":history_sha,"repair_overlay_sha256":repair_overlay_sha,
            "onboard_ms":candidate.onboard,"inactive_at_window_end":candidate.inactive,
            "four_hour_bars":candidate.bars.len(),"missing_mark_hours":missing_mark,
            "funding_mark_trade_fallback_events":mark_fallback,"first_funding_ms":first,"last_funding_ms":last}),
    })
}

fn market_at(market: &Market, at: i64) -> Result<Value> {
    let count = market
        .h4
        .partition_point(|r| timestamp(&r["openTime"]).unwrap() + FOUR_HOURS <= at);
    ensure!(
        count >= 180 && timestamp(&market.h4[count - 1]["openTime"]) == Some(at - FOUR_HOURS),
        "No complete signal prefix"
    );
    let mut first = 0;
    for i in (1..count).rev() {
        if timestamp(&market.h4[i]["openTime"]).unwrap()
            - timestamp(&market.h4[i - 1]["openTime"]).unwrap()
            != FOUR_HOURS
        {
            first = i;
            break;
        }
    }
    ensure!(
        count - first >= 180,
        "Signal prefix has insufficient continuous warmup"
    );
    Ok(
        json!({"symbol":market.symbol,"marketProvider":"binance","interval":"4h",
        "klines":market.h4[first..count],"dataAsOf":iso(at),"price":market.h4[count-1]["close"]}),
    )
}

fn active(order: &Value) -> bool {
    matches!(order["status"].as_str(), Some("open" | "pending"))
}
fn patch(target: &mut Value, changes: &Value) {
    for (key, value) in changes.as_object().into_iter().flatten() {
        target[key] = value.clone();
    }
}

fn stats(orders: &[Value]) -> Value {
    let closed: Vec<_> = orders.iter().filter(|o| o["status"] == "closed").collect();
    let net = closed.iter().map(|o| number(&o["net"], 0.)).sum::<f64>();
    let wins = closed.iter().filter(|o| number(&o["net"], 0.) > 0.).count();
    let profits = closed
        .iter()
        .map(|o| number(&o["net"], 0.).max(0.))
        .sum::<f64>();
    let losses = closed
        .iter()
        .map(|o| number(&o["net"], 0.).min(0.))
        .sum::<f64>();
    let mut nets: Vec<_> = closed.iter().map(|o| number(&o["net"], 0.)).collect();
    nets.sort_by(|a, b| b.total_cmp(a));
    json!({"trades":closed.len(),"wins":wins,"win_rate_pct":if closed.is_empty(){Value::Null}else{json!(wins as f64/closed.len() as f64*100.)},
        "net":net,"gross":closed.iter().map(|o|number(&o["gross"],0.)).sum::<f64>(),
        "fees":closed.iter().map(|o|number(&o["fee"],0.)).sum::<f64>(),
        "funding":closed.iter().map(|o|number(&o["funding"],0.)).sum::<f64>(),
        "profit_factor":if losses<0.{json!(profits/-losses)}else{Value::Null},
        "net_ex_top_1":nets.iter().skip(1).sum::<f64>(),"net_ex_top_3":nets.iter().skip(3).sum::<f64>()})
}

fn candidate(strategy: &str, params: Value) -> SearchCandidate {
    let encoded = serde_json::to_vec(&json!({"strategy":strategy,"params":params})).unwrap();
    let hash = hex::encode(Sha256::digest(&encoded));
    SearchCandidate {
        id: format!("A-{}", &hash[..12]),
        strategy: strategy.into(),
        params,
    }
}

fn baseline_params() -> Value {
    json!({"emaFast":25,"emaSlow":75,"channelPeriod":8,"stopAtr":1.,"trailAtr":3.})
}

fn search_grid(args: &Args) -> Result<Vec<SearchCandidate>> {
    let Some(path) = &args.search_grid else {
        return Ok(vec![candidate(BREAKOUT, baseline_params())]);
    };
    let (doc, _) = read_json(path)?;
    parse_search_grid(&doc)
}

fn parse_search_grid(doc: &Value) -> Result<Vec<SearchCandidate>> {
    let singleton =
        (doc["strategy"].is_string() && doc["params"].is_object()).then(|| vec![doc.clone()]);
    let input = doc
        .as_array()
        .or_else(|| doc["candidates"].as_array())
        .or(singleton.as_ref())
        .context("Search grid must contain a candidate, candidate array, or candidates array")?;
    ensure!(
        !input.is_empty() && input.len() <= 512,
        "Search grid must contain 1..512 finite candidates"
    );
    let mut ids = BTreeSet::new();
    let mut rows = Vec::new();
    for item in input {
        let strategy = item["strategy"]
            .as_str()
            .context("Missing candidate strategy")?;
        ensure!(
            [BREAKOUT, LIVE].contains(&strategy),
            "Only the current altcoin breakout strategy can be replayed"
        );
        let params = item["params"]
            .as_object()
            .context("Candidate params must be an object")?;
        let allowed = [
            "emaFast",
            "emaSlow",
            "channelPeriod",
            "stopAtr",
            "trailAtr",
            // Ignored legacy A fields preserve frozen candidate hashes and audit provenance.
            "retestBars",
            "retestBandAtr",
            "useEmaFilter",
        ];
        ensure!(
            params.keys().all(|key| allowed.contains(&key.as_str())),
            "Search changes structural parameters only; portfolio risk is fixed"
        );
        let mut row = candidate(strategy, item["params"].clone());
        if let Some(id) = item["id"].as_str() {
            ensure!(
                !id.is_empty()
                    && id.len() <= 96
                    && id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "Invalid candidate id"
            );
            row.id = id.into();
        }
        ensure!(
            ids.insert(row.id.clone()),
            "Duplicate candidate id: {}",
            row.id
        );
        rows.push(row);
    }
    Ok(rows)
}

fn candidate_value(row: &SearchCandidate) -> Value {
    json!({"id":row.id,"strategy":row.strategy,"params":row.params})
}

fn engine_fingerprint() -> String {
    let mut hash = Sha256::new();
    for text in [
        include_str!("nofx-altcoin-backtest.rs"),
        include_str!("../strategies/altcoin_breakout.rs"),
        include_str!("../paper.rs"),
        include_str!("../paper/strategy_risk.rs"),
        include_str!("../simulator.rs"),
    ] {
        hash.update(text.as_bytes());
    }
    hex::encode(hash.finalize())
}

fn executable_fingerprint() -> Result<String> {
    let executable = std::env::current_exe().context("Locate current backtest executable")?;
    let bytes = fs::read(&executable)
        .with_context(|| format!("Hash current backtest executable {}", executable.display()))?;
    Ok(hex::encode(Sha256::digest(&bytes)))
}

fn summary_only(result: &Value) -> Value {
    result
        .as_object()
        .map(|object| {
            Value::Object(
                object
                    .iter()
                    .filter(|(key, _)| {
                        !["orders", "equity_curve", "training"].contains(&key.as_str())
                    })
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
        })
        .unwrap_or(Value::Null)
}

fn ranked_attempts(attempts: &[Value], measure: &str) -> Vec<usize> {
    let mut indexes: Vec<_> = attempts
        .iter()
        .enumerate()
        .filter(|(_, item)| item["status"] == "completed")
        .map(|(index, _)| index)
        .collect();
    indexes.sort_by(|a, b| {
        number(&attempts[*b][measure]["return_pct"], f64::NEG_INFINITY)
            .total_cmp(&number(
                &attempts[*a][measure]["return_pct"],
                f64::NEG_INFINITY,
            ))
            .then_with(|| {
                number(&attempts[*a][measure]["max_drawdown_pct"], f64::INFINITY).total_cmp(
                    &number(&attempts[*b][measure]["max_drawdown_pct"], f64::INFINITY),
                )
            })
            .then_with(|| {
                attempts[*a]["id"]
                    .as_str()
                    .cmp(&attempts[*b]["id"].as_str())
            })
    });
    indexes
}

fn write_search_progress(args: &Args, state: &Value) -> Result<()> {
    fs::write(
        args.output_dir.join("optimization.json"),
        serde_json::to_vec_pretty(state)?,
    )?;
    let mut writer = csv::Writer::from_path(args.output_dir.join("optimization-summary.csv"))?;
    writer.write_record([
        "id",
        "strategy",
        "status",
        "params",
        "training_return_pct",
        "training_max_drawdown_pct",
        "training_trades",
        "full_return_pct",
        "full_max_drawdown_pct",
        "full_trades",
        "elapsed_seconds",
        "error",
    ])?;
    for row in state["attempts"].as_array().into_iter().flatten() {
        writer.write_record([
            row["id"].as_str().unwrap_or("").to_string(),
            row["strategy"].as_str().unwrap_or("").into(),
            row["status"].as_str().unwrap_or("").into(),
            row["params"].to_string(),
            row["training"]["return_pct"].to_string(),
            row["training"]["max_drawdown_pct"].to_string(),
            row["training"]["stats"]["trades"].to_string(),
            row["full"]["return_pct"].to_string(),
            row["full"]["max_drawdown_pct"].to_string(),
            row["full"]["stats"]["trades"].to_string(),
            row["elapsed_seconds"].to_string(),
            row["error"].as_str().unwrap_or("").into(),
        ])?;
    }
    writer.flush()?;
    Ok(())
}

fn execute_search_candidate(
    row: &SearchCandidate,
    args: &Args,
    start: i64,
    holdout: i64,
    end: i64,
    candidates: &[Candidate],
    rankings: &BTreeMap<i64, Vec<usize>>,
    markets: &BTreeMap<String, Market>,
) -> Value {
    let began = std::time::Instant::now();
    let result = (|| -> Result<Value> {
        let prepared: BTreeMap<_, _> = markets
            .iter()
            .map(|(symbol, market)| {
                PreparedSeries::new(&market.h4, &row.params)
                    .map(|series| (symbol.clone(), series))
                    .map_err(anyhow::Error::msg)
            })
            .collect::<Result<_>>()?;
        run_portfolio(
            &row.strategy,
            1.,
            start,
            end,
            args.initial,
            candidates,
            rankings,
            markets,
            &mut BTreeMap::new(),
            Some(&prepared),
            Some(holdout),
        )
    })();
    let mut record = json!({"id":row.id,"strategy":row.strategy,"params":row.params,
        "elapsed_seconds":began.elapsed().as_secs_f64()});
    match result {
        Ok(result) => {
            record["status"] = json!("completed");
            record["full"] = summary_only(&result);
            record["training"] = summary_only(&result["training"]);
        }
        Err(error) => {
            record["status"] = json!("failed");
            record["error"] = json!(error.to_string());
        }
    }
    record
}

fn optimize(
    args: &Args,
    report: &mut Value,
    start: i64,
    holdout: i64,
    end: i64,
    candidates: &[Candidate],
    rankings: &BTreeMap<i64, Vec<usize>>,
    markets: &BTreeMap<String, Market>,
) -> Result<()> {
    let grid = search_grid(args)?;
    let identity = json!({"start_ms":start,"holdout_ms":holdout,"end_ms":end,"initial":args.initial,
        "engine_source_sha256":engine_fingerprint(),
        "engine_binary_sha256":executable_fingerprint()?,
        "top_n":args.top_n,"listing_days":args.listing_days,"archive_manifest_sha256":report["archive_manifest_sha256"],
        "listing_file_sha256":report["listing_file_sha256"],"execution_market_count":report["execution_market_count"],
        "portfolio_policy":report["portfolio_policy"],"cost_policy":report["cost_policy"],"market_metadata":report["market_metadata"]});
    let mut state = json!({"schema_version":2,"objective":"maximum net return, tie lower drawdown then stable candidate id",
        "created_at_utc":chrono::Utc::now(),"training_start_ms":start,"training_end_ms":holdout,"holdout_end_ms":end,
        "study_identity":identity,
        "risk_fixed":report["portfolio_policy"],"grid":grid.iter().map(candidate_value).collect::<Vec<_>>(),
        "search_mode":if args.search_grid.is_some(){"external_fixed_grid"}else{"current_strategy"},
        "search_limit":args.search_limit,"attempts":[],"status":"running"});
    let state_path = args.output_dir.join("optimization.json");
    let journal_path = args.output_dir.join("optimization-attempts.jsonl");
    let mut index = 0;
    if args.resume {
        let (previous, _) =
            read_json(&state_path).context("Resume requires an existing optimization.json")?;
        ensure!(
            previous["study_identity"] == identity && previous["grid"] == state["grid"],
            "Resume data/period/risk/grid identity does not match this study"
        );
        state = previous;
        state["status"] = json!("running");
        state["search_limit"] = json!(args.search_limit);
        let text = fs::read_to_string(&journal_path)?;
        let attempts: Vec<Value> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<std::result::Result<_, _>>()?;
        ensure!(
            attempts.len() <= grid.len(),
            "Journal exceeds saved candidate grid"
        );
        for (attempt, row) in attempts.iter().zip(&grid) {
            ensure!(
                attempt["id"] == row.id
                    && attempt["strategy"] == row.strategy
                    && attempt["params"] == row.params,
                "Journal candidate sequence does not match saved grid"
            );
        }
        index = attempts.len();
        state["attempts"] = json!(attempts);
        println!("Resuming {index} recorded candidates of {}", grid.len());
    } else {
        ensure!(
            !state_path.exists() && !journal_path.exists(),
            "Optimization output already exists; use a new output directory or --resume"
        );
        fs::write(
            args.output_dir.join("optimization-grid.json"),
            serde_json::to_vec_pretty(&state)?,
        )?;
    }
    write_search_progress(args, &state)?;
    let mut journal = fs::OpenOptions::new()
        .create(true)
        .append(args.resume)
        .truncate(!args.resume)
        .write(true)
        .open(journal_path)?;
    while index < grid.len() && args.search_limit.is_none_or(|limit| index < limit) {
        let row = &grid[index];
        println!(
            "Search {}/{} {} {}",
            index + 1,
            grid.len(),
            row.id,
            row.params
        );
        let attempt = execute_search_candidate(
            row, args, start, holdout, end, candidates, rankings, markets,
        );
        println!(
            "Completed {}: {} train {}% full {}% in {:.2}s",
            row.id,
            attempt["status"],
            attempt["training"]["return_pct"],
            attempt["full"]["return_pct"],
            number(&attempt["elapsed_seconds"], 0.)
        );
        serde_json::to_writer(&mut journal, &attempt)?;
        journal.write_all(b"\n")?;
        journal.flush()?;
        journal.sync_data()?;
        state["attempts"].as_array_mut().unwrap().push(attempt);
        write_search_progress(args, &state)?;
        index += 1;
    }
    let attempts = state["attempts"].as_array().unwrap();
    let full_rank = ranked_attempts(attempts, "full");
    let train_rank = ranked_attempts(attempts, "training");
    if full_rank.is_empty() || train_rank.is_empty() {
        state["status"] = json!("failed");
        state["attempted_candidate_count"] = json!(index);
        state["planned_candidate_count"] = json!(grid.len());
        write_search_progress(args, &state)?;
        bail!("Every parameter candidate failed; see recorded failures");
    }
    let full_id = attempts[full_rank[0]]["id"].as_str().unwrap().to_string();
    let train_id = attempts[train_rank[0]]["id"].as_str().unwrap().to_string();
    state["full_winner_id"] = json!(full_id);
    state["training_winner_id"] = json!(train_id);
    for (selection, selected_id, selection_end) in
        [("full", &full_id, end), ("training", &train_id, holdout)]
    {
        let row = grid.iter().find(|row| &row.id == selected_id).unwrap();
        let resolved = strategies::altcoin_breakout::validate_parameters(&row.params)
            .map_err(anyhow::Error::msg)?;
        let replay_params: serde_json::Map<String, Value> = [
            "emaFast",
            "emaSlow",
            "channelPeriod",
            "stopAtr",
            "trailAtr",
            "useEmaFilter",
        ]
        .into_iter()
        .map(|key| (key.into(), resolved[key].clone()))
        .collect();
        fs::write(
            args.output_dir.join(format!("best-{selection}.json")),
            serde_json::to_vec_pretty(&json!({
            "id":row.id,"strategy":row.strategy,"params":replay_params,"resolved_rules":resolved,
            "selection_period":{"label":selection,"start_ms":start,"end_ms":selection_end},
            "researchOnly":true,"enabled":false,"portfolio_policy":report["portfolio_policy"],
            "study_identity":identity,"selection_objective":"maximum net return; tie lower maximum drawdown then stable candidate id"}))?,
        )?;
    }
    state["full_ranking"] = json!(
        full_rank
            .iter()
            .map(|i| state["attempts"][*i]["id"].clone())
            .collect::<Vec<_>>()
    );
    state["training_ranking"] = json!(
        train_rank
            .iter()
            .map(|i| state["attempts"][*i]["id"].clone())
            .collect::<Vec<_>>()
    );
    let mut selected = BTreeSet::from([full_id, train_id]);
    for strategy in [BREAKOUT, LIVE] {
        let baseline = candidate(strategy, baseline_params());
        if state["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == baseline.id && a["status"] == "completed")
        {
            selected.insert(baseline.id);
        }
    }
    state["verification_candidate_ids"] = json!(selected);
    state["search_complete"] = json!(index == grid.len());
    state["planned_candidate_count"] = json!(grid.len());
    state["attempted_candidate_count"] = json!(index);
    state["status"] = json!("verifying_winners");
    write_search_progress(args, &state)?;
    for row in grid.iter().filter(|row| selected.contains(&row.id)) {
        let prepared: BTreeMap<_, _> = markets
            .iter()
            .map(|(symbol, market)| {
                PreparedSeries::new(&market.h4, &row.params)
                    .map(|series| (symbol.clone(), series))
                    .map_err(anyhow::Error::msg)
            })
            .collect::<Result<_>>()?;
        for (period, begin) in [("full", start), ("holdout", holdout)] {
            for multiplier in [1., 2.] {
                println!("Verifying {} {period} cost{multiplier}", row.id);
                let mut result = run_portfolio(
                    &row.strategy,
                    multiplier,
                    begin,
                    end,
                    args.initial,
                    candidates,
                    rankings,
                    markets,
                    &mut BTreeMap::new(),
                    Some(&prepared),
                    if period == "full" {
                        Some(holdout)
                    } else {
                        None
                    },
                )?;
                result["period"] = json!(period);
                result["candidate_id"] = json!(row.id);
                result["params"] = row.params.clone();
                if period == "full" {
                    let mut train = result.as_object_mut().unwrap().remove("training").unwrap();
                    train["period"] = json!("training");
                    train["candidate_id"] = json!(row.id);
                    train["params"] = row.params.clone();
                    report["results"].as_array_mut().unwrap().push(train);
                }
                report["results"].as_array_mut().unwrap().push(result);
                write_report(args, report)?;
            }
        }
    }
    state["status"] = json!("complete");
    state["completed_at_utc"] = json!(chrono::Utc::now());
    write_search_progress(args, &state)?;
    report["optimization"] = state;
    Ok(())
}

fn strategy_context(at: i64) -> Value {
    json!({"evaluationAt":at,"allowResearchOnly":true,"deferMarketFilters":true,"params":{},"costs":{"feeBps":6.,"slippageBps":5.,"fundingBpsPer8h":3.}})
}

fn submit(
    account: &mut Value,
    market: &Market,
    mut signal: Value,
    id: &str,
    at: i64,
    multiplier: f64,
    sequence: usize,
) -> Result<()> {
    let direction = signal["positionRecommendation"]
        .as_str()
        .or(signal["action"].as_str())
        .unwrap_or("");
    let direction = match direction {
        "OPEN_LONG" | "LONG" | "BUY" => "OPEN_LONG",
        "OPEN_SHORT" | "SHORT" | "SELL" => "OPEN_SHORT",
        _ => bail!("Not an entry signal"),
    };
    let direction = direction.to_string();
    // The closed-bar signal is frozen, but quantity is chosen at the next
    // executable quote. Only this bar's OPEN is read here; OHLC after entry is
    // consumed exclusively by the shared simulator once the hour closes.
    let quote = market
        .hourly
        .get(&at)
        .map(|row| number(&row["open"], f64::NAN))
        .context("No next-open execution quote")?;
    let unit = number(&signal["plan"]["riskUnit"], f64::NAN);
    ensure!(
        quote.is_finite() && quote > 0. && unit.is_finite() && unit > 0.,
        "Invalid next-open quote or frozen risk unit"
    );
    signal["signalCloseReference"] = signal["plan"]["entryReference"].clone();
    signal["plan"]["entryReference"] = json!(quote);
    signal["plan"]["entryMin"] = json!(quote);
    signal["plan"]["entryMax"] = json!(quote);
    signal["plan"]["stopLoss"] = json!(
        quote
            - if direction == "OPEN_LONG" {
                unit
            } else {
                -unit
            }
    );
    signal["plan"]["takeProfit"] = json!(if direction == "OPEN_LONG" {
        quote * 100.
    } else {
        quote * 0.01
    });
    signal["eligible"] = json!(true);
    signal["positionRecommendation"] = json!(direction);
    signal["strategyId"] = json!(id);
    signal["marketProvider"] = json!("binance");
    signal["interval"] = json!("1h");
    signal["firstEntryAt"] = json!(at);
    // advance_paper_order is called after a source candle closes, so expiry must
    // allow that first complete execution candle to be consumed.
    signal["pendingOrderTtlMs"] = json!(2 * HOUR);
    let funds = paper::account_summary(account, at);
    let equity = number(&funds["equity"], 0.);
    let available = number(&funds["available"], 0.);
    ensure!(equity > 0. && available > 1., "Insufficient capital");
    let costs = json!({"feeBps":6.*multiplier,"slippageBps":5.*multiplier,"fundingBpsPer8h":0.});
    let (margin, _) = paper::constrain_strategy_risk(
        &signal["plan"]["riskSizing"],
        &signal["plan"],
        &costs,
        equity,
        available.min(100000.),
        1.,
        direction == "OPEN_LONG",
        HOUR,
    )?;
    let record = json!({"id":format!("altcoin-{id}-{}-{at}-{sequence}",market.symbol),"strategyId":id,
        "marketProvider":"binance","analysisEngine":"offline_altcoin_portfolio","analyses":[signal]});
    let submitted = paper::submit_paper_order(
        account,
        &record,
        &json!({"symbol":market.symbol,"margin":margin.min(100000.),"leverage":1}),
        at - 1,
    )?;
    let order = account["orders"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["id"] == submitted["id"])
        .unwrap();
    order["id"] = record["id"].clone();
    // Submission applies its production limits too. Re-apply the scenario's
    // actual costs to the already constrained amount, and never enlarge it.
    let constrained = paper::constrain_strategy_risk(
        &order["plan"]["riskSizing"],
        &order["plan"],
        &costs,
        equity,
        number(&order["margin"], 0.),
        1.,
        direction == "OPEN_LONG",
        HOUR,
    );
    let (margin, leverage) = match constrained {
        Ok(size) => size,
        Err(error) => {
            account["orders"]
                .as_array_mut()
                .unwrap()
                .retain(|o| o["id"] != record["id"]);
            return Err(error);
        }
    };
    order["margin"] = json!(margin);
    order["leverage"] = json!(leverage);
    order["notional"] = json!(margin * leverage);
    order["costs"] = costs;
    order["fundingHistory"] = market.funding.clone();
    order["strategySignalAt"] = json!(at);
    order["nextTime"] = json!(at);
    Ok(())
}

fn run_portfolio(
    id: &str,
    multiplier: f64,
    start: i64,
    end: i64,
    initial: f64,
    candidates: &[Candidate],
    rankings: &BTreeMap<i64, Vec<usize>>,
    markets: &BTreeMap<String, Market>,
    signal_cache: &mut BTreeMap<(String, i64, String), Value>,
    prepared: Option<&BTreeMap<String, PreparedSeries<'_>>>,
    training_end: Option<i64>,
) -> Result<Value> {
    let mut account = json!({"initialBalance":initial,"unlimitedCapital":false,"orders":[],"entriesPaused":false});
    let mut curve = vec![json!({"time_ms":start,"equity":initial,"open_positions":0})];
    let mut rejected: BTreeMap<String, usize> = BTreeMap::new();
    let mut peak = initial;
    let mut drawdown = 0_f64;
    let mut sequence = 0;
    let mut max_open = 0;
    let mut max_same = 0;
    let mut missing_mark_held_hours = 0;
    let mut training = Value::Null;
    for at in (start..end).step_by(HOUR as usize) {
        // The training branch consumes only candles preceding this boundary.
        // Its forced close cannot change the continuing full-period account.
        if training_end == Some(at) {
            training = finish_portfolio(
                id,
                multiplier,
                start,
                at,
                initial,
                account.clone(),
                curve.clone(),
                peak,
                drawdown,
                &rejected,
                max_open,
                max_same,
                missing_mark_held_hours,
                markets,
            )?;
        }
        // First settle the preceding, now closed 1h candle for all positions.
        for order in account["orders"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .filter(|o| active(o))
        {
            let symbol = order["symbol"].as_str().unwrap();
            let market = &markets[symbol];
            if let Some(row) = market.hourly.get(&(at - HOUR)) {
                if order["status"] == "open" && row["markOpen"].is_null() {
                    missing_mark_held_hours += 1;
                }
                paper::advance_paper_order(order, std::slice::from_ref(row), at)?;
                ensure!(
                    order["error"].as_str().unwrap_or("").is_empty(),
                    "Shared execution failed: {}",
                    order["error"]
                );
                if !active(order) {
                    order.as_object_mut().unwrap().remove("fundingHistory");
                }
            } else if timestamp(&order["nextTime"]).is_some_and(|t| t < at) {
                bail!(
                    "Missing held execution candle for {symbol} at {}",
                    iso(at - HOUR)
                );
            }
        }
        if at % FOUR_HOURS == 0 {
            for order in account["orders"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|o| o["status"] == "open")
            {
                let market = &markets[order["symbol"].as_str().unwrap()];
                let review =
                    if let Some(series) = prepared.and_then(|rows| rows.get(&market.symbol)) {
                        let count = market.h4.partition_point(|row| {
                            timestamp(&row["openTime"]).unwrap() + FOUR_HOURS <= at
                        });
                        ensure!(
                            count > 0
                                && timestamp(&market.h4[count - 1]["openTime"])
                                    == Some(at - FOUR_HOURS),
                            "No complete prepared review prefix"
                        );
                        series.review_at(order, count)
                    } else {
                        let snapshot = market_at(market, at)?;
                        strategies::review(id, order, &snapshot, &strategy_context(at))?
                    };
                if review["altcoinTrendState"].is_object() {
                    order["altcoinTrendState"] = review["altcoinTrendState"].clone();
                }
                if review["action"] == "CLOSE" {
                    order["pendingStrategyClose"] =
                        json!({"effectiveFrom":at,"reason":"strategy_close"});
                } else if review["action"] == "UPDATE_PROTECTION" {
                    let stop = review["stopLoss"]
                        .as_f64()
                        .or_else(|| review["protection"]["stopLoss"].as_f64())
                        .or_else(|| review["plan"]["stopLoss"].as_f64());
                    if let Some(stop) = stop {
                        order["plan"]["stopLoss"] = json!(stop);
                        let target = order["plan"]["takeProfit"].clone();
                        order["protectionRevisions"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"effectiveFrom":at,"stopLoss":stop,"takeProfit":target}));
                    }
                }
            }
            // A close decided from the completed 4h prefix executes at this
            // boundary's open before replacement entries compete for capital.
            // Do not consume the current hour's future high, low, or close.
            for order in account["orders"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|o| o["status"] == "open" && o["pendingStrategyClose"].is_object())
            {
                if timestamp(&order["pendingStrategyClose"]["effectiveFrom"])
                    .is_none_or(|effective| effective > at)
                {
                    continue;
                }
                let market = &markets[order["symbol"].as_str().unwrap()];
                let Some(row) = market.hourly.get(&at) else {
                    continue;
                };
                let open = number(&row["open"], f64::NAN);
                let mark_open = row["markOpen"].as_f64();
                let closed = simulator::close_queued_at_open(
                    order,
                    open,
                    mark_open,
                    at,
                    &json!({"mode":"account"}),
                )?;
                patch(order, &closed);
                order.as_object_mut().unwrap().remove("fundingHistory");
            }
            let context = strategy_context(at);
            for &index in rankings.get(&at).into_iter().flatten() {
                let symbol = &candidates[index].symbol;
                let Some(market) = markets.get(symbol) else {
                    *rejected
                        .entry("funding_or_execution_data_unavailable".into())
                        .or_default() += 1;
                    continue;
                };
                let key = (id.to_string(), at, symbol.clone());
                let signal = if let Some(series) = prepared.and_then(|rows| rows.get(symbol)) {
                    let count = market.h4.partition_point(|row| {
                        timestamp(&row["openTime"]).unwrap() + FOUR_HOURS <= at
                    });
                    if count == 0
                        || timestamp(&market.h4[count - 1]["openTime"]) != Some(at - FOUR_HOURS)
                    {
                        *rejected
                            .entry("incomplete_signal_prefix".into())
                            .or_default() += 1;
                        continue;
                    }
                    series.analyze_at(symbol, count)
                } else if let Some(signal) = signal_cache.get(&key) {
                    signal.clone()
                } else {
                    let snapshot = match market_at(market, at) {
                        Ok(v) => v,
                        Err(_) => {
                            *rejected
                                .entry("incomplete_signal_prefix".into())
                                .or_default() += 1;
                            continue;
                        }
                    };
                    let signal = strategies::analyze(id, &snapshot, &context)?;
                    // WAIT diagnostics contain full indicator snapshots. Only an
                    // entry plan is needed to reproduce subsequent cost scenarios.
                    let cached = if signal["plan"].is_object() {
                        signal
                    } else {
                        Value::Null
                    };
                    signal_cache.insert(key, cached.clone());
                    cached
                };
                if !signal["plan"].is_object() {
                    continue;
                }
                let direction = signal["positionRecommendation"]
                    .as_str()
                    .or(signal["action"].as_str())
                    .unwrap_or("");
                let long = matches!(direction, "OPEN_LONG" | "LONG" | "BUY");
                let orders = account["orders"].as_array().unwrap();
                let live: Vec<_> = orders.iter().filter(|o| active(o)).collect();
                let reason = if live.iter().any(|o| o["symbol"] == symbol.as_str()) {
                    Some("symbol_already_active")
                } else if live.len() >= 3 {
                    Some("portfolio_max_3")
                } else if live
                    .iter()
                    .filter(|o| (o["direction"] == "OPEN_LONG") == long)
                    .count()
                    >= 2
                {
                    Some("direction_max_2")
                } else if !market.hourly.contains_key(&at) {
                    Some("entry_candle_missing")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    *rejected.entry(reason.into()).or_default() += 1;
                    continue;
                }
                sequence += 1;
                if let Err(error) =
                    submit(&mut account, market, signal, id, at, multiplier, sequence)
                {
                    *rejected.entry(format!("submission: {error}")).or_default() += 1;
                }
            }
        }
        let summary = paper::account_summary(&account, at);
        let equity = number(&summary["equity"], f64::NAN);
        ensure!(equity.is_finite(), "Non-finite shared account equity");
        peak = peak.max(equity);
        drawdown = drawdown.max((peak - equity) / peak);
        let live: Vec<_> = account["orders"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|o| active(o))
            .collect();
        let longs = live
            .iter()
            .filter(|o| o["direction"] == "OPEN_LONG")
            .count();
        max_open = max_open.max(live.len());
        max_same = max_same.max(longs.max(live.len() - longs));
        ensure!(
            live.len() <= 3 && longs <= 2 && live.len() - longs <= 2,
            "Portfolio risk caps violated"
        );
        curve.push(json!({"time_ms":at,"equity":equity,"open_positions":live.len(),"used_margin":summary["usedMargin"]}));
    }
    let mut result = finish_portfolio(
        id,
        multiplier,
        start,
        end,
        initial,
        account,
        curve,
        peak,
        drawdown,
        &rejected,
        max_open,
        max_same,
        missing_mark_held_hours,
        markets,
    )?;
    if training.is_object() {
        result["training"] = training;
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn finish_portfolio(
    id: &str,
    multiplier: f64,
    start: i64,
    end: i64,
    initial: f64,
    mut account: Value,
    mut curve: Vec<Value>,
    mut peak: f64,
    mut drawdown: f64,
    rejected: &BTreeMap<String, usize>,
    max_open: usize,
    max_same: usize,
    missing_mark_held_hours: usize,
    markets: &BTreeMap<String, Market>,
) -> Result<Value> {
    for order in account["orders"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|o| active(o))
    {
        let market = &markets[order["symbol"].as_str().unwrap()];
        if let Some(row) = market.hourly.get(&(end - HOUR)) {
            paper::advance_paper_order(order, std::slice::from_ref(row), end)?;
            ensure!(
                order["error"].as_str().unwrap_or("").is_empty(),
                "End settlement has an execution gap"
            );
            if order["status"] == "open" {
                let result = simulator::close_order(
                    order,
                    number(&row["close"], 0.),
                    end - 1,
                    "backtest_end",
                    &json!({"mode":"account","enableIsolatedMargin":true}),
                )?;
                patch(order, &result);
            }
        } else {
            bail!("No final execution candle for {}", market.symbol);
        }
        if order["status"] == "pending" {
            order["status"] = json!("expired");
            order["reason"] = json!("backtest_end_unfilled");
        }
        order.as_object_mut().unwrap().remove("fundingHistory");
    }
    let final_summary = paper::account_summary(&account, end);
    let equity = number(&final_summary["equity"], f64::NAN);
    peak = peak.max(equity);
    drawdown = drawdown.max((peak - equity) / peak);
    curve.push(json!({"time_ms":end,"equity":equity,"open_positions":0}));
    let orders = account["orders"].as_array().unwrap();
    let totals = stats(orders);
    ensure!(
        (equity - initial - number(&totals["net"], 0.)).abs() < 1e-6,
        "Closed trade ledger and shared equity do not reconcile"
    );
    let mut by_direction = BTreeMap::new();
    for direction in ["OPEN_LONG", "OPEN_SHORT"] {
        by_direction.insert(
            direction,
            stats(
                &orders
                    .iter()
                    .filter(|o| o["direction"] == direction)
                    .cloned()
                    .collect::<Vec<_>>(),
            ),
        );
    }
    let mut by_symbol = BTreeMap::new();
    for symbol in orders
        .iter()
        .filter_map(|o| o["symbol"].as_str())
        .collect::<BTreeSet<_>>()
    {
        by_symbol.insert(
            symbol,
            stats(
                &orders
                    .iter()
                    .filter(|o| o["symbol"] == symbol)
                    .cloned()
                    .collect::<Vec<_>>(),
            ),
        );
    }
    Ok(
        json!({"strategy":id,"cost_multiplier":multiplier,"start_ms":start,"end_ms":end,
        "initial_equity":initial,"final_equity":equity,"return_pct":(equity/initial-1.)*100.,"max_drawdown_pct":drawdown*100.,
        "stats":totals,"by_direction":by_direction,"by_symbol":by_symbol,"rejections":rejected,
        "max_active_positions":max_open,"max_same_direction_positions":max_same,
        "missing_mark_held_hours":missing_mark_held_hours,"orders":orders,"equity_curve":curve}),
    )
}

fn write_report(args: &Args, report: &Value) -> Result<()> {
    fs::create_dir_all(&args.output_dir)?;
    fs::write(
        args.output_dir.join("report.json"),
        serde_json::to_vec_pretty(report)?,
    )?;
    let mut summary = csv::Writer::from_path(args.output_dir.join("summary.csv"))?;
    summary.write_record([
        "period",
        "candidate_id",
        "params",
        "strategy",
        "cost_multiplier",
        "return_pct",
        "max_drawdown_pct",
        "trades",
        "net",
        "fees",
        "funding",
        "long_net",
        "short_net",
    ])?;
    let mut markdown = String::from(
        "# 山寨永续趋势策略组合回测\n\n采用同一有限资金账户、4h 信号和历史 1h OHLC 保守成交模型。金额单位 USDT。资金费率和时间采用真实历史，结算标记价可能使用代理值。\n\n| 区间 | 策略/参数组 | 成本倍数 | 收益% | 最大回撤% | 成交 | 净额 | 多头净额 | 空头净额 |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n",
    );
    for result in report["results"].as_array().into_iter().flatten() {
        let period = result["period"].as_str().unwrap_or("");
        let id = result["strategy"].as_str().unwrap_or("");
        summary.write_record([
            period.to_string(),
            result["candidate_id"].as_str().unwrap_or("").to_string(),
            result["params"].to_string(),
            id.into(),
            result["cost_multiplier"].to_string(),
            result["return_pct"].to_string(),
            result["max_drawdown_pct"].to_string(),
            result["stats"]["trades"].to_string(),
            result["stats"]["net"].to_string(),
            result["stats"]["fees"].to_string(),
            result["stats"]["funding"].to_string(),
            result["by_direction"]["OPEN_LONG"]["net"].to_string(),
            result["by_direction"]["OPEN_SHORT"]["net"].to_string(),
        ])?;
        markdown.push_str(&format!(
            "| {period} | {} | {} | {:.3} | {:.3} | {} | {:.2} | {:.2} | {:.2} |\n",
            result["candidate_id"].as_str().unwrap_or(id),
            result["cost_multiplier"],
            number(&result["return_pct"], 0.),
            number(&result["max_drawdown_pct"], 0.),
            result["stats"]["trades"],
            number(&result["stats"]["net"], 0.),
            number(&result["by_direction"]["OPEN_LONG"]["net"], 0.),
            number(&result["by_direction"]["OPEN_SHORT"]["net"], 0.)
        ));
        let key = format!(
            "{period}-{}-cost{}",
            result["candidate_id"].as_str().unwrap_or(id),
            result["cost_multiplier"]
        );
        let mut trades = csv::Writer::from_path(args.output_dir.join(format!("{key}-trades.csv")))?;
        trades.write_record([
            "id",
            "symbol",
            "direction",
            "entry_at",
            "exit_at",
            "entry",
            "exit",
            "net",
            "gross",
            "fee",
            "funding",
            "reason",
        ])?;
        for order in result["orders"].as_array().into_iter().flatten() {
            trades.write_record(
                [
                    "id",
                    "symbol",
                    "direction",
                    "entryAt",
                    "exitAt",
                    "entry",
                    "exit",
                    "net",
                    "gross",
                    "fee",
                    "funding",
                    "reason",
                ]
                .map(|field| {
                    order[field]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| order[field].to_string())
                }),
            )?;
        }
        trades.flush()?;
        let mut curve = csv::Writer::from_path(args.output_dir.join(format!("{key}-equity.csv")))?;
        curve.write_record(["time_ms", "equity", "open_positions"])?;
        for point in result["equity_curve"].as_array().into_iter().flatten() {
            curve.write_record([
                point["time_ms"].to_string(),
                point["equity"].to_string(),
                point["open_positions"].to_string(),
            ])?;
        }
        curve.flush()?;
    }
    summary.flush()?;
    if report["optimization"].is_object() {
        let optimization = &report["optimization"];
        markdown.push_str(&format!("\n## 参数搜索\n\n- 尝试 {} / {} 组，完整搜索：{}；全部尝试与失败见 optimization-summary.csv、optimization-attempts.jsonl。\n- 全期描述性最高：{}；仅按训练前 2/3 选出的最高：{}。\n- 参数已反复查询同一段历史，全期冠军不是独立样本外证据。训练冠军的后段以独立账户重新回放；该区间曾在初轮固定参数研究中公开，不能称为从未看过的盲测。\n",
            optimization["attempted_candidate_count"],optimization["planned_candidate_count"],optimization["search_complete"],
            optimization["full_winner_id"],optimization["training_winner_id"]));
    }
    markdown.push_str("\n## 数据及边界\n\n");
    markdown.push_str(&format!("- 测量区间：{} 至 {}，后段从 {} 起以独立初始资金重新回放。\n- 历史候选 {} 个，进入过动态前 {} 的标的 {} 个，成功加载执行与资金费历史 {} 个。\n",
        report["start_utc"].as_str().unwrap_or(""),report["end_utc"].as_str().unwrap_or(""),report["holdout_utc"].as_str().unwrap_or(""),
        report["candidate_count"],args.top_n,report["ever_selected_count"],report["execution_market_count"]));
    for limitation in report["limitations"].as_array().into_iter().flatten() {
        markdown.push_str(&format!("- {}\n", limitation.as_str().unwrap_or("")));
    }
    fs::write(args.output_dir.join("report.md"), markdown)?;
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        args.initial.is_finite() && args.initial > 0. && args.top_n > 0 && args.listing_days >= 0,
        "Invalid portfolio settings"
    );
    ensure!(
        args.search_limit.is_none_or(|limit| limit > 0),
        "Search limit must be positive"
    );
    ensure!(
        !args.resume || !args.inspect_only,
        "--resume cannot be combined with --inspect-only"
    );
    let (manifest, manifest_sha) = read_json(&args.archive_dir.join("manifest.json"))?;
    let (listing, listing_sha) = read_json(&args.listing_file)?;
    let lookback = manifest["lookback_start_ms"]
        .as_i64()
        .context("Missing archive lookback_start_ms")?;
    let available_end = manifest["end_exclusive_ms"]
        .as_i64()
        .context("Missing archive end")?;
    let start = args
        .start_ms
        .unwrap_or((lookback + 30 * DAY + FOUR_HOURS - 1).div_euclid(FOUR_HOURS) * FOUR_HOURS);
    let end = args.end_ms.unwrap_or(available_end);
    let holdout = args
        .holdout_ms
        .unwrap_or((start + (end - start) * 2 / 3).div_euclid(FOUR_HOURS) * FOUR_HOURS);
    ensure!(
        start % FOUR_HOURS == 0
            && end % FOUR_HOURS == 0
            && holdout % FOUR_HOURS == 0
            && start < holdout
            && holdout < end
            && end <= available_end,
        "Invalid aligned measurement/holdout boundaries"
    );
    println!(
        "Loading historical candidate candles: {} .. {}",
        iso(start),
        iso(end)
    );
    let (candidates, exclusions) = load_candidates(&args, &manifest, &listing)?;
    let rankings = rank_universe(&candidates, start, end, args.top_n, args.listing_days);
    let selected: BTreeSet<_> = rankings.values().flatten().copied().collect();
    println!(
        "{} candidates, {} ever selected",
        candidates.len(),
        selected.len()
    );
    let mut markets = BTreeMap::new();
    let mut data_errors = BTreeMap::new();
    let repair_runtime = if args.repair_history {
        Some(
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?,
        )
    } else {
        None
    };
    let repair_exchange = if args.repair_history {
        Some(Exchange::public()?)
    } else {
        None
    };
    let mut repair_failures = BTreeMap::new();
    let mut repair_summary = Vec::new();
    for &index in &selected {
        let candidate = &candidates[index];
        let repair = if let (Some(runtime), Some(exchange)) = (&repair_runtime, &repair_exchange) {
            match runtime.block_on(repair_market_history(
                exchange,
                candidate,
                start,
                end,
                &args.output_dir.join("repairs"),
            )) {
                Ok(overlay) => {
                    if overlay["failures"]
                        .as_array()
                        .is_some_and(|rows| !rows.is_empty())
                    {
                        repair_failures
                            .insert(candidate.symbol.clone(), overlay["failures"].clone());
                    }
                    repair_summary.push(json!({"symbol":candidate.symbol,"funding_records":overlay["funding_records"].as_array().map_or(0,Vec::len),
                        "mark_price_1h_records":overlay["mark_price_1h_records"].as_array().map_or(0,Vec::len),
                        "sources":overlay["sources"],"failures":overlay["failures"]}));
                    Some(overlay)
                }
                Err(error) => {
                    eprintln!("{} public repair failed: {error}", candidate.symbol);
                    repair_failures.insert(
                        candidate.symbol.clone(),
                        json!([{"error":error.to_string()}]),
                    );
                    None
                }
            }
        } else {
            None
        };
        match load_market(candidate, start, end, repair.as_ref()) {
            Ok(market) => {
                markets.insert(candidate.symbol.clone(), market);
            }
            Err(error) => {
                eprintln!("{} unavailable: {error}", candidate.symbol);
                data_errors.insert(candidate.symbol.clone(), error.to_string());
            }
        }
    }
    fs::create_dir_all(&args.output_dir)?;
    fs::write(
        args.output_dir.join("repair-summary.json"),
        serde_json::to_vec_pretty(&json!({
        "enabled":args.repair_history,"execution_market_count":markets.len(),"ever_selected_count":selected.len(),
        "public_repairs":repair_summary,"repair_failures":repair_failures,"execution_data_errors":data_errors}))?,
    )?;
    ensure!(!markets.is_empty(), "No complete execution/funding markets");
    let mut report = json!({"schema_version":1,"created_at_utc":chrono::Utc::now(),"orders_enabled":false,"account_credentials_used":false,
        "archive_dir":args.archive_dir,"archive_manifest_sha256":manifest_sha,"listing_file":args.listing_file,"listing_file_sha256":listing_sha,
        "start_ms":start,"end_ms":end,"holdout_ms":holdout,"start_utc":iso(start),"end_utc":iso(end),"holdout_utc":iso(holdout),
        "initial_equity":args.initial,"candidate_count":candidates.len(),"ever_selected_count":selected.len(),"execution_market_count":markets.len(),
        "universe_policy":{"trailing_quote_volume_days":30,"top_n":args.top_n,"min_listing_days":args.listing_days,"current_status_filter":false},
        "portfolio_policy":{"max_active":3,"max_same_direction":2,"risk_fraction":0.003,"max_notional_fraction":0.5,"leverage":1},
        "cost_policy":{"base_fee_bps_per_side":6.,"base_slippage_bps_per_side":5.,"stress_multiplier":2.,"funding":"historical signed settlements unchanged in execution-cost stress"},
        "candidate_exclusions":exclusions,"execution_data_errors":data_errors,
        "history_repair_enabled":args.repair_history,"history_repair_failures":repair_failures,"history_repairs":repair_summary,
        "market_metadata":markets.values().map(|m|m.metadata.clone()).collect::<Vec<_>>(),
        "candidate_sources":candidates.iter().map(|c|json!({"symbol":c.symbol,"sha256":c.sha256})).collect::<Vec<_>>(),
        "rankings":rankings.iter().map(|(at,ids)|json!({"time_ms":at,"symbols":ids.iter().map(|i|&candidates[*i].symbol).collect::<Vec<_>>()})).collect::<Vec<_>>(),
        "limitations":["This is a retrospective replay. The later chronological segment is separately replayed; it is not evidence of future profitability or a never-seen blind test.",
            "The listing snapshot was collected after the sample. Its onboard dates and asset types are reused, but current trading status is never used. Missing metadata excludes some historically inactive contracts and can leave survivorship bias.",
            "Only symbols with funding coverage across the full measurement window are executable. This retrospective data-availability filter can exclude late-entry or early-delisted contracts and bias the result; per-symbol exclusions are recorded.",
            "Optional public-history repair queries only observed gaps and stores the original REST responses separately. Missing or empty public responses remain unknown; no funding rate, settlement, or mark candle is invented. Cached failures are not retried automatically.",
            "Historical 30-day turnover is a liquidity proxy. Order-book depth, partial fills, IOC rejection, exchange outages and position-size capacity are not simulated.",
            "Signals use complete 4h candles aggregated from real 1h candles; stops execute conservatively on 1h OHLC. Intrahour path, stop timing and liquidation remain approximate.",
            "Missing mark candles fall back to trade candles for liquidation checks. Funding settlement mark uses the prior closed hourly mark, or a disclosed historical trade-price proxy.",
            "Archive funding timestamps can be 1-2 milliseconds after scheduled boundaries; their raw times are retained.",
            "Execution cost stress doubles fees and slippage, and retains actual signed funding. A fixed slippage assumption does not prove that large orders can be executed.",
            "All results use one shared finite-capital portfolio per strategy/scenario. The holdout account starts afresh; long/short attribution is not an independently compounded return."],"results":[]});
    if !args.inspect_only {
        if args.search_grid.is_some() {
            report["limitations"][0] = json!(
                "External candidate comparisons repeatedly query retrospective data. Full-period rankings are descriptive fitted results. Training selects only on the earlier segment; the later segment is separately replayed and is not a never-seen blind test."
            );
        }
        optimize(
            &args,
            &mut report,
            start,
            holdout,
            end,
            &candidates,
            &rankings,
            &markets,
        )?;
    }
    write_report(&args, &report)?;
    println!("Wrote {}", args.output_dir.join("report.json").display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candle(at: i64, quote: f64) -> Candle {
        Candle {
            at,
            open: 100.,
            high: 101.,
            low: 99.,
            close: 100.,
            volume: 1.,
            quote,
        }
    }
    #[test]
    fn default_replays_current_parameters_without_generating_new_candidates() {
        let args = Args::try_parse_from(["replay"]).unwrap();
        let grid = search_grid(&args).unwrap();
        assert_eq!(grid.len(), 1);
        assert_eq!(grid[0].strategy, BREAKOUT);
        assert_eq!(grid[0].params, baseline_params());
        assert_eq!(grid[0].params["emaFast"], 25);
        assert_eq!(grid[0].params["emaSlow"], 75);
        assert_eq!(grid[0].params["channelPeriod"], 8);
        assert_eq!(grid[0].params["stopAtr"], 1.);
        assert_eq!(grid[0].params["trailAtr"], 3.);
    }

    #[test]
    fn winner_object_replays_and_grid_cannot_raise_account_risk() {
        let row = candidate(BREAKOUT, baseline_params());
        let replay = parse_search_grid(
            &json!({"id":row.id,"strategy":row.strategy,"params":row.params,
            "researchOnly":true,"enabled":false}),
        )
        .unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].params, baseline_params());
        assert!(
            parse_search_grid(&json!({"strategy":BREAKOUT,"params":{"riskPerTrade":0.1}})).is_err()
        );
        assert!(
            parse_search_grid(&json!({"strategy":BREAKOUT,"params":{"maxLeverage":50}})).is_err()
        );
        assert!(
            parse_search_grid(&json!({"strategy":"altcoin-trend-retest-v1","params":{}})).is_err()
        );
        let legacy = candidate(
            BREAKOUT,
            json!({"emaFast":30,"emaSlow":90,"channelPeriod":10,
            "stopAtr":1.5,"trailAtr":3.0,"retestBars":3,"retestBandAtr":0.25}),
        );
        assert_eq!(legacy.id, "A-aadb2873715e");
        let live = parse_search_grid(&json!({"strategy":LIVE,"params":baseline_params()})).unwrap();
        assert_eq!(live[0].strategy, LIVE);
    }
    fn replay_fixture(
        end_count: usize,
    ) -> (
        Vec<Candidate>,
        BTreeMap<i64, Vec<usize>>,
        BTreeMap<String, Market>,
    ) {
        let mut hourly = BTreeMap::new();
        let mut h4 = Vec::new();
        let mut bars = Vec::new();
        for index in 0..end_count {
            let price = if index < 180 {
                100.
            } else if index < 187 {
                110. + (index - 180) as f64
            } else {
                112.
            };
            let at = index as i64 * FOUR_HOURS;
            let bar = Candle {
                at,
                open: price,
                high: price + 0.5,
                low: price - 0.5,
                close: price,
                volume: 1000.,
                quote: price * 1000.,
            };
            h4.push(bar.value(FOUR_HOURS));
            bars.push(bar.clone());
            for hour in 0..4 {
                let row = Candle {
                    at: at + hour * HOUR,
                    ..bar.clone()
                }
                .value(HOUR);
                hourly.insert(at + hour * HOUR, row);
            }
        }
        let candidate = Candidate {
            symbol: "SOLUSDT".into(),
            path: PathBuf::new(),
            history: PathBuf::new(),
            onboard: 0,
            bars,
            sha256: String::new(),
            inactive: false,
        };
        let rankings = (180..end_count)
            .map(|i| (i as i64 * FOUR_HOURS, vec![0]))
            .collect();
        let market = Market {
            symbol: "SOLUSDT".into(),
            h4,
            hourly,
            funding: json!([]),
            metadata: json!({}),
        };
        (
            vec![candidate],
            rankings,
            BTreeMap::from([("SOLUSDT".into(), market)]),
        )
    }
    #[test]
    fn training_checkpoint_matches_independent_shared_replay_and_ignores_future() {
        let (candidates, rankings, markets) = replay_fixture(205);
        let params = baseline_params();
        let prepared = BTreeMap::from([(
            "SOLUSDT".into(),
            PreparedSeries::new(&markets["SOLUSDT"].h4, &params).unwrap(),
        )]);
        let start = 180 * FOUR_HOURS;
        let split = 190 * FOUR_HOURS;
        let independent = run_portfolio(
            BREAKOUT,
            1.,
            start,
            split,
            10000.,
            &candidates,
            &rankings,
            &markets,
            &mut BTreeMap::new(),
            Some(&prepared),
            None,
        )
        .unwrap();
        assert!(independent["stats"]["trades"].as_u64().unwrap() > 0);
        let full = run_portfolio(
            BREAKOUT,
            1.,
            start,
            205 * FOUR_HOURS,
            10000.,
            &candidates,
            &rankings,
            &markets,
            &mut BTreeMap::new(),
            Some(&prepared),
            Some(split),
        )
        .unwrap();
        assert_eq!(full["training"], independent);
        let (short_candidates, short_rankings, short_markets) = replay_fixture(195);
        let short_prepared = BTreeMap::from([(
            "SOLUSDT".into(),
            PreparedSeries::new(&short_markets["SOLUSDT"].h4, &params).unwrap(),
        )]);
        let shorter = run_portfolio(
            BREAKOUT,
            1.,
            start,
            195 * FOUR_HOURS,
            10000.,
            &short_candidates,
            &short_rankings,
            &short_markets,
            &mut BTreeMap::new(),
            Some(&short_prepared),
            Some(split),
        )
        .unwrap();
        assert_eq!(full["training"], shorter["training"]);
    }
    #[test]
    fn funding_repair_requires_an_actual_missing_settlement() {
        let begin = 20 * DAY;
        let original = vec![
            json!({"fundingTime":begin+5,"fundingRate":0.0001,"fundingIntervalHours":4}),
            json!({"fundingTime":begin+8*HOUR+5,"fundingRate":-0.0002,"fundingIntervalHours":4}),
        ];
        assert_eq!(
            funding_repair_windows(&original, begin + 5, begin + 12 * HOUR).len(),
            1
        );
        assert_eq!(
            funding_repair_windows(
                &merge_funding_rows(&original, &[]),
                begin + 5,
                begin + 12 * HOUR
            )
            .len(),
            1
        );
        let actual = vec![
            json!({"fundingTime":begin+4*HOUR+5,"fundingRate":-0.0003,"markPrice":100.,"fundingIntervalHours":4}),
        ];
        assert!(
            funding_repair_windows(
                &merge_funding_rows(&original, &actual),
                begin + 5,
                begin + 12 * HOUR
            )
            .is_empty()
        );
        let same_event = vec![
            json!({"fundingTime":begin,"fundingRate":0.0001,"markPrice":100.,"fundingIntervalHours":4}),
        ];
        let merged = merge_funding_rows(&original, &same_event);
        assert_eq!(merged.len(), 2);
        assert_eq!(timestamp(&merged[0]["fundingTime"]), Some(begin));
    }
    #[test]
    fn mark_repair_coalesces_exactly_the_missing_hours() {
        let marks = vec![json!({"openTime":0}), json!({"openTime":25*HOUR})];
        assert_eq!(
            mark_repair_windows(&marks, HOUR, 26 * HOUR),
            vec![(HOUR, 25 * HOUR)]
        );
    }
    #[test]
    fn aggregation_rejects_missing_hours_and_unclosed_groups() {
        let rows = vec![
            candle(0, 1.),
            candle(HOUR, 1.),
            candle(2 * HOUR, 1.),
            candle(4 * HOUR, 1.),
        ];
        assert!(aggregate_four_hours(&rows).is_empty());
        let full = (0..4).map(|i| candle(i * HOUR, 1.)).collect::<Vec<_>>();
        let output = aggregate_four_hours(&full);
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].quote, 4.);
    }
    #[test]
    fn historical_rank_never_reads_the_current_or_future_bar() {
        let bars = (0..200)
            .map(|i| candle(i * FOUR_HOURS, if i < 180 { 1. } else { 1e12 }))
            .collect();
        let candidate = Candidate {
            symbol: "SOLUSDT".into(),
            path: PathBuf::new(),
            history: PathBuf::new(),
            onboard: 0,
            bars,
            sha256: String::new(),
            inactive: false,
        };
        let second = Candidate {
            symbol: "LINKUSDT".into(),
            path: PathBuf::new(),
            history: PathBuf::new(),
            onboard: 0,
            bars: (0..200).map(|i| candle(i * FOUR_HOURS, 2.)).collect(),
            sha256: String::new(),
            inactive: false,
        };
        let ranks = rank_universe(
            &[candidate, second],
            180 * FOUR_HOURS,
            181 * FOUR_HOURS,
            1,
            0,
        );
        assert_eq!(ranks[&(180 * FOUR_HOURS)], vec![1]);
    }

    #[test]
    fn pending_submission_fills_at_next_open_before_its_expiry() {
        let at = 100 * HOUR;
        let market = Market {
            symbol: "SOLUSDT".into(),
            h4: vec![],
            hourly: BTreeMap::from([(at, json!({"openTime":at,"open":108.}))]),
            funding: json!([]),
            metadata: json!({}),
        };
        let signal = json!({"symbol":"SOLUSDT","action":"BUY","plan":{
            "entryStyle":"market","entryExecution":"next_open","reanchorToFill":true,
            "entryReference":100.,"entryMin":100.,"entryMax":100.,"stopLoss":98.,"riskUnit":2.,
            "takeProfit":10000.,"takeProfitEnabled":false,"maxHoldBars":1_000_000,
            "riskSizing":{"riskFraction":0.003,"maxNotionalFraction":0.5,"maxLeverage":1,"fundingReserveHours":24},
            "exitRules":{"partialTp":{"enabled":false},"smartExit":{"enabled":false}}
        }});
        let mut account = json!({"initialBalance":10000.,"unlimitedCapital":false,"orders":[]});
        submit(&mut account, &market, signal, BREAKOUT, at, 1., 1).unwrap();
        let order = &mut account["orders"][0];
        let row = json!({"openTime":at,"open":108.,"high":109.,"low":107.,"close":108.,"volume":1.,"confirmed":true});
        paper::advance_paper_order(order, &[row], at + HOUR).unwrap();
        assert_eq!(order["status"], "open");
        assert_eq!(timestamp(&order["entryAt"]), Some(at));
        assert!(number(&order["entry"], 0.) > 108.);
        assert!(
            (number(&order["entry"], 0.) - number(&order["plan"]["stopLoss"], 0.) - 2.).abs()
                < 1e-9
        );
    }
}
