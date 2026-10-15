//! Read-only references using registered strategies and the shared production replay engine.
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    backtest::{self, History},
    campaign,
    exchange::{Exchange, valid_symbol},
    indicator_history::{Sample, Timeline},
    number, research, strategies, timestamp,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;
const INITIAL: f64 = 1000.;

#[derive(Parser)]
#[command(
    about = "Replay current registered strategies against frozen recent-month ML data; no account or orders"
)]
struct Args {
    #[arg(long, default_value = "data/ml-market-20261014")]
    data_dir: PathBuf,
    #[arg(long, default_value = "data/strategies.json")]
    state: PathBuf,
    #[arg(
        long,
        default_value = "output/ml-baseline-20261014/existing-strategies"
    )]
    output_dir: PathBuf,
    #[arg(long, default_value = "output/profit-improvement-20261011/data")]
    samples_source: PathBuf,
    #[arg(long, value_delimiter = ',', default_value = "BTCUSDT,ETHUSDT")]
    symbols: Vec<String>,
    /// Empty means all enabled strategies, with enhanced-trend and h4-trend first.
    #[arg(long, value_delimiter = ',')]
    strategies: Vec<String>,
    #[arg(long)]
    start_ms: Option<i64>,
    #[arg(long)]
    end_ms: Option<i64>,
    /// Reuse frozen samples only; mark missing recent market context explicitly.
    #[arg(long)]
    skip_public_update: bool,
}

fn reference_config() -> Value {
    // These are replay inputs only. No live configuration or credentials are loaded.
    json!({"marketSync":{"dataOnly":false},"trader":{
        "enabled":true,"dryRun":false,"allowEntryOrders":true,"maxLeverage":1,
        "minConfidence":0.45,"minOrderMargin":5,"maxPositionNotionalPct":0.1,
        "maxNewEntriesPerCycle":1,"syncPaperOrdersToDemo":false,"syncPaperOrdersToLive":false
    }})
}

fn read_hashed(path: &Path) -> Result<(Value, String)> {
    let bytes = fs::read(path).with_context(|| format!("Read {}", path.display()))?;
    let hash = hex::encode(Sha256::digest(&bytes));
    let text = std::str::from_utf8(&bytes)?;
    Ok((
        serde_json::from_str(text.trim_start_matches('\u{feff}'))?,
        hash,
    ))
}

fn selected(state: &Value, requested: &[String]) -> Result<Vec<(String, Value)>> {
    let mut ids: Vec<String> = if requested.is_empty() {
        state["strategies"]
            .as_object()
            .context("Strategy state has no strategies")?
            .iter()
            .filter(|(_, entry)| entry["enabled"] == true)
            .map(|(id, _)| id.clone())
            .collect()
    } else {
        requested.to_vec()
    };
    ensure!(!ids.is_empty(), "No strategies selected");
    ensure!(
        ids.iter().collect::<BTreeSet<_>>().len() == ids.len(),
        "Duplicate strategy ids"
    );
    ids.sort_by_key(|id| {
        (
            match id.as_str() {
                "enhanced-trend-v1" => 0,
                "h4-trend-breakout-v1" => 1,
                _ => 2,
            },
            id.clone(),
        )
    });
    ids.into_iter()
        .map(|id| {
            let resolved = strategies::resolve_params(&id, &state["strategies"][&id]["params"])?;
            ensure!(
                resolved["rejected"].as_array().is_some_and(Vec::is_empty),
                "Rejected current parameters for {id}: {}",
                resolved["rejected"]
            );
            Ok((id, resolved["params"].clone()))
        })
        .collect()
}

fn validate_history(history: &History, start: i64, end: i64) -> Result<()> {
    for (tf, rows) in &history.datasets {
        let duration = nofx_core::interval_ms(tf).context("Invalid timeframe")?;
        ensure!(!rows.is_empty(), "Empty {tf} dataset");
        let mut previous = None;
        for row in rows {
            let open = timestamp(&row["openTime"]).context("Missing candle openTime")?;
            ensure!(
                open % duration == 0 && row["confirmed"] != false && open + duration <= end,
                "Unclosed or misaligned {tf} candle at {open}"
            );
            ensure!(
                nofx_core::simulator::valid_candle(row),
                "Invalid {tf} candle at {open}"
            );
            ensure!(
                previous.is_none_or(|at| open == at + duration),
                "Discontinuous {tf} dataset at {open}"
            );
            previous = Some(open);
        }
    }
    let main = history
        .datasets
        .get("1m")
        .context("No real 1m execution candles")?;
    ensure!(
        timestamp(&main[0]["openTime"]).is_some_and(|at| at <= start - DAY),
        "Insufficient 24h ticker warmup"
    );
    ensure!(
        timestamp(&main.last().unwrap()["openTime"]) == Some(end - MINUTE),
        "1m dataset does not reach cutoff"
    );
    Ok(())
}

/// Aggregate actual complete 1m observations; never interpolate or invent an intrabar path.
fn derive_five_minute(history: &mut History) -> Result<Option<Value>> {
    if history.datasets.contains_key("5m") {
        return Ok(None);
    }
    let main = history
        .datasets
        .get("1m")
        .context("Cannot derive 5m without 1m candles")?;
    let mut rows = Vec::new();
    let source_sha = hex::encode(Sha256::digest(serde_json::to_vec(main)?));
    let mut index = 0;
    while index < main.len() {
        let open = timestamp(&main[index]["openTime"]).context("Missing 1m timestamp")?;
        if open % (5 * MINUTE) != 0 {
            index += 1;
            continue;
        }
        if index + 5 > main.len() {
            break;
        }
        let group = &main[index..index + 5];
        ensure!(
            group
                .iter()
                .enumerate()
                .all(
                    |(i, row)| timestamp(&row["openTime"]) == Some(open + i as i64 * MINUTE)
                        && row["confirmed"] != false
                ),
            "5m aggregation source has a gap or unfinished 1m candle"
        );
        let sum = |field: &str| -> Result<f64> {
            group.iter().try_fold(0., |total, row| {
                let value = number(&row[field], f64::NAN);
                ensure!(
                    value.is_finite() && value >= 0.,
                    "Invalid 1m {field} for 5m aggregation"
                );
                Ok(total + value)
            })
        };
        let mut derived = json!({"openTime":open,"closeTime":open+5*MINUTE-1,"confirmed":true,
            "open":group[0]["open"],"close":group[4]["close"],
            "high":group.iter().map(|r|number(&r["high"],f64::NAN)).fold(f64::NEG_INFINITY,f64::max),
            "low":group.iter().map(|r|number(&r["low"],f64::NAN)).fold(f64::INFINITY,f64::min),
            "volume":sum("volume")?,"quoteVolume":sum("quoteVolume")?,
            "tradeCount":sum("tradeCount")? as i64,"takerBuyVolume":sum("takerBuyVolume")?,
            "takerBuyQuoteVolume":sum("takerBuyQuoteVolume")?,"derivedFrom":"5_complete_closed_1m_candles"});
        if let Some(symbol) = group[0]["symbol"].as_str() {
            derived["symbol"] = json!(symbol);
        }
        ensure!(
            nofx_core::simulator::valid_candle(&derived),
            "Invalid derived 5m candle"
        );
        rows.push(derived);
        index += 5;
    }
    ensure!(!rows.is_empty(), "No complete 5m groups");
    let metadata = json!({"timeframe":"5m","derived":true,"source":"complete_closed_1m_OHLCV_sum",
        "source_1m_sha256":source_sha,"rows":rows.len(),"start_open_ms":rows[0]["openTime"],
        "end_exclusive_ms":timestamp(&rows.last().unwrap()["openTime"]).unwrap()+5*MINUTE});
    history.datasets.insert("5m".into(), rows);
    Ok(Some(metadata))
}

fn sample_start(samples: &[Sample], kind: &str, start: i64, end: i64, period: i64) -> i64 {
    samples
        .iter()
        .filter(|s| s.kind == kind && s.observed_at < end && s.available_at >= s.observed_at)
        .map(|s| s.observed_at)
        .max()
        .map_or(start - 2 * DAY, |last| last - period)
        .max(start - 2 * DAY)
        .max(1)
}

async fn supplement(
    exchange: &Exchange,
    symbol: &str,
    samples: &mut Vec<Sample>,
    start: i64,
    end: i64,
) -> Value {
    let mut updates = Vec::new();
    let mut errors = Vec::new();
    for (kind, path, field, limit, lag) in [
        (
            "oi5m",
            "/futures/data/openInterestHist",
            "timestamp",
            500_i64,
            300_000_i64,
        ),
        (
            "funding",
            "/fapi/v1/fundingRate",
            "fundingTime",
            1000_i64,
            60_000_i64,
        ),
    ] {
        let mut cursor = sample_start(
            samples,
            kind,
            start,
            end,
            if kind == "oi5m" { 3_600_000 } else { DAY },
        );
        if kind == "oi5m" {
            cursor = cursor.max(nofx_core::now_ms() - 29 * DAY);
        }
        let first = cursor;
        let mut count = 0;
        let mut response_hashes = Vec::new();
        while cursor < end {
            let query_end = if kind == "oi5m" {
                (cursor + (limit - 1) * 300_000).min(end - 1)
            } else {
                end - 1
            };
            let mut params =
                json!({"symbol":symbol,"startTime":cursor,"endTime":query_end,"limit":limit});
            if kind == "oi5m" {
                params["period"] = json!("5m");
            }
            eprintln!(
                "supplement {symbol}/{kind}: {} → {}",
                nofx_core::iso(cursor),
                nofx_core::iso(query_end)
            );
            let response = match tokio::time::timeout(
                Duration::from_secs(25),
                exchange.public_request(path, &params),
            )
            .await
            {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => {
                    errors.push(format!("{kind}: {error}"));
                    break;
                }
                Err(_) => {
                    errors.push(format!("{kind}: timeout"));
                    break;
                }
            };
            response_hashes.push(hex::encode(Sha256::digest(
                serde_json::to_vec(&response).unwrap(),
            )));
            let Some(rows) = response.as_array() else {
                errors.push(format!("{kind}: response is not an array"));
                break;
            };
            let mut last = None;
            for row in rows {
                let Some(at) = timestamp(&row[field]) else {
                    errors.push(format!("{kind}: missing {field}"));
                    continue;
                };
                if at < cursor || at > query_end || at >= end {
                    errors.push(format!("{kind}: out-of-window timestamp"));
                    continue;
                }
                let valid = if kind == "oi5m" {
                    number(&row["sumOpenInterest"], f64::NAN).is_finite()
                        && number(&row["sumOpenInterest"], -1.) >= 0.
                } else {
                    number(&row["fundingRate"], f64::NAN).is_finite()
                };
                if !valid {
                    errors.push(format!("{kind}: invalid value at {at}"));
                    continue;
                }
                samples.push(Sample {
                    kind: kind.into(),
                    observed_at: at,
                    available_at: at + lag,
                    origin: "historical-rest".into(),
                    data: row.clone(),
                });
                last = Some(last.map_or(at, |previous: i64| previous.max(at)));
                count += 1;
            }
            if kind == "funding" {
                let Some(last) = last else {
                    break;
                };
                if last < cursor {
                    errors.push("funding pagination made no progress".into());
                    break;
                }
                cursor = last + 1;
                if rows.len() < limit as usize {
                    break;
                }
            } else {
                cursor = query_end + 1;
            }
        }
        updates.push(json!({"kind":kind,"path":path,"start_ms":first,"end_exclusive_ms":end,
            "added_rows":count,"response_sha256":response_hashes,"collected_at_ms":nofx_core::now_ms(),
            "availability_assumption_ms":lag,"origin":"historical-rest"}));
    }
    json!({"updates":updates,"errors":errors,"complete_requests":errors.is_empty(),
        "availabilityAssumption":"OI statistics usable observedAt+5min; settled funding observedAt+1min. Retrospective REST assumption, not observed collection time.",
        "historicalBookAvailable":false,"historicalPremiumAvailable":false})
}

fn sample_coverage(samples: &[Sample], symbol: &str, start: i64, end: i64) -> Value {
    let mut timeline = Timeline::new(samples);
    let mut oi_fresh = 0;
    let mut funding_fresh = 0;
    let mut joint = 0;
    let mut evaluated = 0;
    let mut counts = BTreeMap::<String, usize>::new();
    for sample in samples {
        *counts.entry(sample.kind.clone()).or_default() += 1;
    }
    for now in (start..end).step_by(MINUTE as usize) {
        let raw = timeline.at(symbol, now);
        // Match opportunity.rs crowding availability rather than inventing unknown OI/funding.
        let oi = raw["oi"].as_array();
        let (last, previous) = oi
            .filter(|r| r.len() >= 2)
            .map(|r| (&r[r.len() - 1], &r[r.len() - 2]))
            .unwrap_or((&Value::Null, &Value::Null));
        let latest_at = timestamp(&last["timestamp"]);
        let old_at = timestamp(&previous["timestamp"]);
        let fresh_oi = latest_at
            .zip(old_at)
            .is_some_and(|(a, b)| a - b == 900_000 && a <= now && now - a <= 1_860_000)
            && number(&last["sumOpenInterest"], f64::NAN).is_finite()
            && number(&previous["sumOpenInterest"], 0.) > 0.;
        let funding = raw["funding"]
            .as_array()
            .and_then(|r| r.last())
            .unwrap_or(&Value::Null);
        let fresh_funding = timestamp(&funding["fundingTime"])
            .is_some_and(|at| at <= now && now - at <= 36 * 3_600_000)
            && number(&funding["fundingRate"], f64::NAN).is_finite();
        oi_fresh += usize::from(fresh_oi);
        funding_fresh += usize::from(fresh_funding);
        joint += usize::from(fresh_oi && fresh_funding);
        evaluated += 1;
    }
    json!({"samples_by_kind":counts,"evaluated_minutes":evaluated,
        "oi_fresh_minutes":oi_fresh,"funding_fresh_minutes":funding_fresh,"crowding_joint_fresh_minutes":joint,
        "crowding_joint_coverage_pct":if evaluated>0{joint as f64/evaluated as f64*100.}else{0.},
        "oi_missing_or_stale_minutes":evaluated-oi_fresh,"funding_missing_or_stale_minutes":evaluated-funding_fresh,
        "book_historical_coverage":"not reconstructed","premium_historical_coverage":"only originally collected snapshots"})
}

struct Heartbeat {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Heartbeat {
    fn start(label: String) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let handle = std::thread::spawn(move || {
            let started = Instant::now();
            while !worker_stop.load(Ordering::Relaxed) {
                std::thread::park_timeout(Duration::from_secs(20));
                if !worker_stop.load(Ordering::Relaxed) {
                    eprintln!(
                        "replaying {label}: {} seconds elapsed",
                        started.elapsed().as_secs()
                    );
                }
            }
        });
        Self {
            stop,
            handle: Some(handle),
        }
    }
}
impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            handle.thread().unpark();
            let _ = handle.join();
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args = Args::parse();
    let (state, state_sha) = read_hashed(&args.state)?;
    let chosen = selected(&state, &args.strategies)?;
    ensure!(
        !args.output_dir.exists(),
        "Use a fresh output directory; results are immutable"
    );
    ensure!(!args.symbols.is_empty(), "No symbols selected");
    let symbols: Vec<_> = args
        .symbols
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .collect();
    ensure!(
        symbols.iter().collect::<BTreeSet<_>>().len() == symbols.len(),
        "Duplicate symbols"
    );
    for symbol in &symbols {
        valid_symbol(symbol)?;
    }
    let mut histories = Vec::new();
    let mut frozen_end = None;
    for symbol in &symbols {
        let path = args.data_dir.join(format!("{symbol}.json"));
        let (document, sha) = read_hashed(&path)?;
        ensure!(
            document["symbol"] == symbol.as_str(),
            "Frozen market file has the wrong symbol"
        );
        let cutoff = document["metadata"]["as_of_ms"]
            .as_i64()
            .context("Missing frozen as_of_ms")?;
        ensure!(
            frozen_end.is_none_or(|at| at == cutoff),
            "Symbols have different frozen cutoffs"
        );
        frozen_end = Some(cutoff);
        let history: History = serde_json::from_value(document)?;
        histories.push((symbol.clone(), path, sha, history));
    }
    let end = args.end_ms.unwrap_or(frozen_end.unwrap());
    let start = args.start_ms.unwrap_or(end - 30 * DAY);
    ensure!(
        start > DAY
            && end > start
            && end - start <= 31 * DAY
            && start % MINUTE == 0
            && end % MINUTE == 0,
        "Replay needs aligned past start/end over at most 31 days"
    );
    ensure!(
        end <= frozen_end.unwrap() && end <= nofx_core::now_ms(),
        "Replay extends past frozen closed data"
    );
    fs::create_dir_all(&args.output_dir)?;
    let config = reference_config();
    let adaptive = nofx_core::analytics::adaptive_config(&json!({}));
    let meta = json!({"schema_version":1,"research_only":true,"orders_enabled":false,"data_dir":args.data_dir,
        "strategy_state":args.state,"strategy_state_sha256":state_sha,"strategies":chosen,
        "start_ms":start,"end_exclusive_ms":end,"initial_equity_per_symbol_strategy":INITIAL,
        "risk":{"max_leverage":1,"requested_max_margin_usdt":100.,"engine_hard_notional_cap_usdt":nofx_core::automation_guards::MAX_ENTRY_NOTIONAL,
            "one_active_order_per_symbol":true},"config":config,"adaptive":adaptive,
        "environment":campaign::environment_snapshot(),"costs":research::costs(),"engine_version":campaign::engine_version(),
        "comparison_role":"strategy reference with original timeframes; excluded from Chronos feature admission gate",
        "portfolio_note":"Each symbol/strategy starts an independent 1000-USDT account. Do not sum these as one shared portfolio.",
        "filter_policy":"Current strategy parameters retained; missing enabled remote indicators follow production HOLD rules",
        "fidelity":"Shared production replay and guards; retrospective REST publication delays are assumptions. Full historical book/premium unavailable."});
    campaign::write_json(&args.output_dir.join("manifest.json"), &meta)?;
    let exchange = if args.skip_public_update {
        None
    } else {
        Some(Exchange::public()?)
    };
    let mut results = Vec::new();
    for (symbol, data_path, data_sha, mut history) in histories {
        // A requested shorter end is an explicit prefix evaluation, never a source overwrite.
        for (tf, rows) in &mut history.datasets {
            let dt = nofx_core::interval_ms(tf).unwrap();
            rows.retain(|row| timestamp(&row["openTime"]).is_some_and(|at| at + dt <= end));
        }
        validate_history(&history, start, end)?;
        let derived = derive_five_minute(&mut history)?;
        let sample_path = args.samples_source.join(format!("{symbol}.json"));
        let mut source_meta = json!({"path":sample_path,"available":false});
        if sample_path.is_file() {
            let (document, sha) = read_hashed(&sample_path)?;
            let samples: Vec<Sample> = serde_json::from_value(document["samples"].clone())?;
            history.samples.extend(samples);
            source_meta = json!({"path":sample_path,"sha256":sha,"available":true});
        }
        history.samples.retain(|sample| {
            sample.observed_at > 0
                && sample.observed_at < end
                && sample.available_at >= sample.observed_at
        });
        let update = if let Some(exchange) = &exchange {
            supplement(exchange, &symbol, &mut history.samples, start, end).await
        } else {
            json!({"skipped":true,"reason":"skip-public-update","availabilityAssumption":"Existing sample timestamps retained"})
        };
        let coverage = sample_coverage(&history.samples, &symbol, start, end);
        let samples_meta = json!({"symbol":symbol,"source":source_meta,"supplement":update,"coverage":coverage,
            "merged_samples_sha256":hex::encode(Sha256::digest(serde_json::to_vec(&history.samples)?))});
        campaign::write_json(
            &args.output_dir.join(format!("samples-{symbol}.json")),
            &json!({"metadata":samples_meta,"samples":history.samples}),
        )?;
        for (id, params) in &chosen {
            let def = strategies::definition(id).unwrap();
            let missing: Vec<_> = def["needsAux"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|tf| !history.datasets.contains_key(*tf))
                .collect();
            if !missing.is_empty() {
                results.push(json!({"symbol":symbol,"strategyId":id,"status":"skipped_missing_timeframes","missing":missing}));
                continue;
            }
            eprintln!(
                "begin {symbol}/{id}: {} → {}",
                nofx_core::iso(start),
                nofx_core::iso(end)
            );
            let started = Instant::now();
            let heartbeat = Heartbeat::start(format!("{symbol}/{id}"));
            let replay = backtest::replay(
                &symbol,
                id,
                params,
                &history.datasets,
                &history.samples,
                &config,
                start,
                end,
                INITIAL,
                &adaptive,
            );
            drop(heartbeat);
            let output = args.output_dir.join(format!("{id}-{symbol}.json"));
            match replay {
                Ok(result) => {
                    let fills = result["orderFills"]
                        .as_array()
                        .context("Replay missing orderFills")?;
                    ensure!(
                        fills
                            .iter()
                            .all(|fill| number(&fill["leverage"], f64::INFINITY) <= 1.
                                && number(&fill["margin"], f64::INFINITY) <= 100.),
                        "Replay exceeded fixed leverage/margin limits"
                    );
                    let fees: f64 = fills.iter().map(|fill| number(&fill["fees"], 0.)).sum();
                    let funding: f64 = fills.iter().map(|fill| number(&fill["funding"], 0.)).sum();
                    let complete = number(&result["marketGaps"], 0.) == 0.;
                    campaign::write_json(
                        &output,
                        &json!({"symbol":symbol,"strategyId":id,"params":params,"result":result,
                        "metadata":{"strategy_state_sha256":state_sha,"market_source":data_path,"market_sha256":data_sha,
                            "derived_timeframes":derived,"market_context":samples_meta,"config":config,"adaptive":adaptive,
                            "costs":research::costs(),"elapsed_ms":started.elapsed().as_secs_f64()*1000.,"complete_ohlc_replay":complete,
                            "research_only":true,"orders_enabled":false,"production_exact_claim":false}}),
                    )?;
                    results.push(json!({"symbol":symbol,"strategyId":id,"status":if complete {"complete"} else {"completed_with_data_gaps"},"path":output,
                        "net":result["net"],"returnPct":result["returnPct"],"maxDrawdownPct":result["maxDrawdownPct"],
                        "closedTrades":result["closedTrades"],"winRatePct":result["winRatePct"],"activeOrders":result["activeOrders"],
                        "fees":fees,"funding":funding,"missing":result["missing"],"blocked":result["blocked"],
                        "marketGaps":result["marketGaps"],"market_context_coverage":coverage,"elapsed_ms":started.elapsed().as_secs_f64()*1000.}));
                    eprintln!(
                        "done {symbol}/{id}: net={} trades={} elapsed={:.1}s",
                        result["net"],
                        result["closedTrades"],
                        started.elapsed().as_secs_f64()
                    );
                }
                Err(error) => {
                    let failure = json!({"symbol":symbol,"strategyId":id,"status":"failed","error":error.to_string(),"params":params});
                    campaign::write_json(&output, &failure)?;
                    results.push(failure);
                }
            }
            campaign::write_json(
                &args.output_dir.join("summary.json"),
                &json!({"metadata":meta,"results":results}),
            )?;
        }
    }
    campaign::write_json(
        &args.output_dir.join("summary.json"),
        &json!({"metadata":meta,"results":results}),
    )?;
    println!(
        "{}",
        json!({"summary":args.output_dir.join("summary.json"),"results":results.len(),"research_only":true})
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn five_minute_aggregation_uses_complete_observed_candles() {
        let rows: Vec<Value> = (0..10).map(|i|json!({"openTime":i*MINUTE,"closeTime":(i+1)*MINUTE-1,
            "open":100.+i as f64,"close":101.+i as f64,"high":102.+i as f64,"low":99.+i as f64,
            "volume":2.,"quoteVolume":200.,"tradeCount":3,"takerBuyVolume":1.,"takerBuyQuoteVolume":100.,"confirmed":true})).collect();
        let mut history = History {
            datasets: BTreeMap::from([("1m".into(), rows)]),
            samples: vec![],
        };
        derive_five_minute(&mut history).unwrap();
        let derived = &history.datasets["5m"];
        assert_eq!(derived.len(), 2);
        assert_eq!(derived[0]["open"], 100.);
        assert_eq!(derived[0]["close"], 105.);
        assert_eq!(derived[0]["high"], 106.);
        assert_eq!(derived[0]["low"], 99.);
        assert_eq!(derived[0]["volume"], 10.);
        assert_eq!(derived[0]["tradeCount"], 15);
        history.datasets.remove("5m");
        history.datasets.get_mut("1m").unwrap()[3]["openTime"] = json!(4 * MINUTE);
        assert!(derive_five_minute(&mut history).is_err());
    }
    #[test]
    fn parameters_are_current_resolved_parameters_without_relaxation() {
        let state = json!({"strategies":{"enhanced-trend-v1":{"enabled":true,"params":{"minTrendScore":88,"marketOiEnabled":true}}}});
        let chosen = selected(&state, &[]).unwrap();
        assert_eq!(chosen[0].1["minTrendScore"], 88.);
        assert_eq!(chosen[0].1["marketOiEnabled"], true);
        assert_eq!(reference_config()["trader"]["maxLeverage"], 1);
        assert_eq!(reference_config()["trader"]["syncPaperOrdersToLive"], false);
    }
}
