//! Audited, native 15-minute inputs. Hourly candles are never upsampled.
use crate::{
    chronos::{CONTEXT_LENGTH, ChronosModel, ContextRecord},
    ml_features,
    ml_monthly::{self, Calibration},
    ml_profit_data::{ProfitData, ProfitRecord},
    ml_replay::ReplayConfig,
    ml_trade_labels::{self, DirectionOutcome, TradeLabelConfig},
    ml_training_data::TrainingRecord,
    number,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BTreeMap, BTreeSet, BinaryHeap},
    fs::{self, File, OpenOptions},
    io::{BufReader, Write},
    path::{Component, Path, PathBuf},
};

pub const INTERVAL_MS: i64 = 900_000;
pub const MATURITY_MS: i64 = 48 * INTERVAL_MS;
const DAY_MS: i64 = 86_400_000;

pub struct IntradayPreparationConfig {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub forecast_model: PathBuf,
    pub forecast_runtime: PathBuf,
    pub threads: usize,
    pub symbols: Vec<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub top_n: usize,
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn read(path: &Path) -> Result<Value> {
    Ok(serde_json::from_reader(BufReader::new(File::open(path)?))?)
}
fn write_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if path.exists() {
        ensure!(
            fs::read(path)? == bytes,
            "Immutable intraday checkpoint changed: {}",
            path.display()
        );
        return Ok(());
    }
    fs::create_dir_all(path.parent().context("Missing parent")?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    let result = fs::hard_link(&temp, path);
    let _ = fs::remove_file(&temp);
    match result {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => {
            ensure!(
                fs::read(path)? == bytes,
                "Concurrent intraday checkpoint changed"
            );
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}
fn confined(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(
        !relative.contains(['\\', ':'])
            && Path::new(relative)
                .components()
                .all(|p| matches!(p, Component::Normal(_))),
        "Unsafe normalized source path"
    );
    let root = root.canonicalize()?;
    let path = root.join(relative).canonicalize()?;
    ensure!(
        path.is_file() && path.starts_with(&root),
        "Source escapes dataset directory"
    );
    Ok(path)
}
fn audited_json(root: &Path, entry: &Value, key: &str, hash_key: &str) -> Result<Value> {
    let path = confined(root, entry[key].as_str().context("Missing source path")?)?;
    let bytes = fs::read(path)?;
    ensure!(
        Some(sha(&bytes).as_str()) == entry[hash_key].as_str(),
        "Intraday source SHA mismatch"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
fn entries(data_dir: &Path, requested: &[String]) -> Result<(Value, Vec<Value>)> {
    let manifest = read(&data_dir.join("manifest.json"))?;
    ensure!(
        manifest["interval"] == "15m" && manifest["interval_ms"] == INTERVAL_MS,
        "Expected a real 15m archive manifest"
    );
    ensure!(
        manifest["pending_symbols"].as_u64().unwrap_or(0) == 0,
        "15m archive collection has not completed"
    );
    let wanted: BTreeSet<_> = requested.iter().map(|s| s.to_ascii_uppercase()).collect();
    ensure!(
        wanted.len() == requested.len(),
        "Duplicate requested symbols"
    );
    let selected: Vec<_> = manifest["symbols"]
        .as_array()
        .context("No archive symbols")?
        .iter()
        .filter(|e| e["training_eligible"] == true || e["historical_training_eligible"] == true)
        .filter(|e| wanted.is_empty() || e["symbol"].as_str().is_some_and(|s| wanted.contains(s)))
        .cloned()
        .collect();
    ensure!(!selected.is_empty(), "No eligible 15m symbols");
    if !wanted.is_empty() {
        ensure!(
            selected.len() == wanted.len(),
            "Requested 15m symbols unavailable"
        );
    }
    Ok((manifest, selected))
}
fn source(data_dir: &Path, entry: &Value) -> Result<(Vec<Value>, Value)> {
    let symbol = entry["symbol"].as_str().context("Missing symbol")?;
    let mut document = audited_json(data_dir, entry, "path", "sha256")?;
    ensure!(
        document["symbol"] == symbol && document["metadata"]["interval"] == "15m",
        "Normalized source interval differs"
    );
    ensure!(
        document["metadata"]["content_sha256"].as_str()
            == Some(sha(&serde_json::to_vec(&document["datasets"])?).as_str()),
        "Normalized source content changed"
    );
    let rows: Vec<Value> = serde_json::from_value(document["datasets"]["15m"].take())?;
    ensure!(
        rows.len() >= CONTEXT_LENGTH + 48,
        "Insufficient 15m context and observation"
    );
    let first = rows[0]["openTime"]
        .as_i64()
        .context("Missing candle time")?;
    let mut expected = first;
    for row in &rows {
        ensure!(
            row["openTime"].as_i64() == Some(expected)
                && expected % INTERVAL_MS == 0
                && row["confirmed"] == true,
            "15m candles have gaps, duplicates or unclosed bars"
        );
        let (o, h, l, c) = (
            number(&row["open"], f64::NAN),
            number(&row["high"], f64::NAN),
            number(&row["low"], f64::NAN),
            number(&row["close"], f64::NAN),
        );
        ensure!(
            [o, h, l, c].iter().all(|x| x.is_finite() && *x > 0.)
                && h >= o.max(c)
                && l <= o.min(c)
                && h >= l,
            "Invalid real 15m OHLC"
        );
        expected += INTERVAL_MS;
    }
    let history = audited_json(data_dir, entry, "history_path", "history_sha256")?;
    ensure!(
        history["symbol"] == symbol
            && history["content_sha256"].as_str()
                == Some(sha(&serde_json::to_vec(&history["datasets"])?).as_str()),
        "Historical reference changed"
    );
    for (name, values) in history["datasets"]
        .as_object()
        .context("Missing historical datasets")?
    {
        let mut last = None;
        for row in values.as_array().context("Invalid historical series")? {
            let event = if name == "funding" {
                row["fundingTime"].as_i64()
            } else {
                row["openTime"]
                    .as_i64()
                    .or_else(|| row["timestamp"].as_i64())
            }
            .context("Missing historical timestamp")?;
            let available = row["available_at_ms"]
                .as_i64()
                .context("Missing availability")?;
            // Reused hourly derivatives/reference bars are not made available early.
            ensure!(
                available >= event + if name == "funding" { 0 } else { 3_600_000 }
                    && last.is_none_or(|p| available > p),
                "Future/unsorted historical reference"
            );
            last = Some(available);
        }
    }
    Ok((rows, history))
}

#[derive(Clone, Copy, Debug)]
struct Rank {
    volume: f64,
    symbol: usize,
}
impl PartialEq for Rank {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Rank {}
impl PartialOrd for Rank {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Rank {
    fn cmp(&self, other: &Self) -> Ordering {
        self.volume
            .total_cmp(&other.volume)
            .then_with(|| other.symbol.cmp(&self.symbol))
    }
}
fn add_rank(
    ranks: &mut BTreeMap<i64, BinaryHeap<Reverse<Rank>>>,
    at: i64,
    rank: Rank,
    top_n: usize,
) {
    let heap = ranks.entry(at).or_default();
    if heap.len() < top_n {
        heap.push(Reverse(rank));
    } else if heap.peek().is_some_and(|low| rank > low.0) {
        heap.pop();
        heap.push(Reverse(rank));
    }
}
/// At every closed boundary rank only the preceding continuous 24h candles.
fn rank_source(
    rows: &[Value],
    symbol: usize,
    start: i64,
    end: i64,
    top_n: usize,
    ranks: &mut BTreeMap<i64, BinaryHeap<Reverse<Rank>>>,
) -> Result<()> {
    let mut total = 0.;
    let window = (DAY_MS / INTERVAL_MS) as usize;
    for (i, row) in rows.iter().enumerate() {
        let quote = number(&row["quoteVolume"], f64::NAN);
        ensure!(
            quote.is_finite() && quote >= 0.,
            "Missing real quote volume"
        );
        total += quote;
        if i >= window {
            total -= number(&rows[i - window]["quoteVolume"], 0.);
        }
        let at = row["openTime"].as_i64().context("Missing rank timestamp")? + INTERVAL_MS;
        if i + 1 >= CONTEXT_LENGTH && at >= start && at < end {
            add_rank(
                ranks,
                at,
                Rank {
                    volume: total.max(0.),
                    symbol,
                },
                top_n,
            );
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct CachedRow {
    record: TrainingRecord,
    long_target: Option<f64>,
    short_target: Option<f64>,
}
#[derive(Serialize, Deserialize)]
struct SymbolCache {
    identity: Value,
    rows: Vec<CachedRow>,
    invalid_forecasts: usize,
    immature_origins: usize,
}

fn net_target(outcome: &DirectionOutcome, mature: bool) -> Result<Option<f64>> {
    if !mature {
        return Ok(None);
    }
    if outcome.status == "expired" && outcome.settled && !outcome.entered {
        return Ok(Some(0.));
    }
    if outcome.status == "closed" && outcome.settled && outcome.entered {
        let net = outcome
            .net_usdt
            .context("Closed outcome lacks shared-engine net")?;
        ensure!(net.is_finite(), "Invalid economic target");
        return Ok(Some(net / 50.));
    }
    Ok(None)
}

pub fn prepare_intraday(config: &IntradayPreparationConfig) -> Result<ProfitData> {
    ensure!(
        config.start_ms < config.end_ms
            && config.top_n > 0
            && config.top_n <= 50
            && (1..=4).contains(&config.threads),
        "Invalid 15m preparation bounds"
    );
    let (manifest, mut selected) = entries(&config.data_dir, &config.symbols)?;
    selected.sort_by(|a, b| a["symbol"].as_str().cmp(&b["symbol"].as_str()));
    ensure!(
        manifest["start_ms"]
            .as_i64()
            .is_some_and(|v| v <= config.start_ms)
            && manifest["end_ms"].as_i64() == Some(config.end_ms),
        "15m collection does not cover training"
    );
    fs::create_dir_all(&config.cache_dir)?;
    let _lock = crate::ml_dataset::collector_lock(&config.cache_dir)?;
    let symbols: Vec<String> = selected
        .iter()
        .map(|e| e["symbol"].as_str().unwrap().to_owned())
        .collect();
    let labels = TradeLabelConfig {
        observation_hours: 12,
        replay: ReplayConfig {
            candle_interval_ms: INTERVAL_MS,
            ..ReplayConfig::default()
        },
        ..TradeLabelConfig::default()
    };
    let names = ml_monthly::feature_names_for_interval("15m")?;
    let identity = json!({"schema_version":1,"interval":"15m","interval_ms":INTERVAL_MS,
        "start_ms":config.start_ms,"end_ms":config.end_ms,"symbols":symbols,"top_n":config.top_n,
        "cadence_bars":1,"context_bars":256,"forecast_steps":12,"forecast_hours":3,
        "label_maturity_bars":48,"label_maturity_hours":12,"label_config":labels,
        "universe":"causal top N by preceding continuous 24h quote volume; no future fills or PnL filter",
        "manifest_sha256":sha(&fs::read(config.data_dir.join("manifest.json"))?),
        "model_sha256":sha(&fs::read(&config.forecast_model)?),
        "runtime_sha256":sha(&fs::read(&config.forecast_runtime)?),
        "feature_names":names,"costs":crate::research::costs(),
        "exit_rules":crate::strategies::ml_horizon_exit_rules(),
        "code_sha256":sha(&[include_bytes!("ml_intraday_data.rs").as_slice(),
            include_bytes!("ml_features.rs").as_slice(),include_bytes!("ml_monthly.rs").as_slice(),
            include_bytes!("chronos.rs").as_slice(),include_bytes!("ml_trade_labels.rs").as_slice(),
            include_bytes!("ml_replay.rs").as_slice(),include_bytes!("ml_portfolio.rs").as_slice(),
            include_bytes!("paper.rs").as_slice(),include_bytes!("simulator.rs").as_slice(),
            include_bytes!("strategies.rs").as_slice(),include_bytes!("research.rs").as_slice()].concat())});
    write_new(&config.cache_dir.join("preparation.json"), &identity)?;
    let mut ranks: BTreeMap<i64, BinaryHeap<Reverse<Rank>>> = BTreeMap::new();
    let mut btc = Vec::new();
    let mut eth = Vec::new();
    for (i, entry) in selected.iter().enumerate() {
        let (rows, _) = source(&config.data_dir, entry)?;
        rank_source(
            &rows,
            i,
            config.start_ms,
            config.end_ms,
            config.top_n,
            &mut ranks,
        )?;
        if symbols[i] == "BTCUSDT" {
            btc = rows;
        } else if symbols[i] == "ETHUSDT" {
            eth = rows;
        }
        if (i + 1) % 25 == 0 || i + 1 == selected.len() {
            eprintln!("15m universe ranking {}/{}", i + 1, selected.len());
        }
    }
    let mut origins: Vec<Vec<i64>> = vec![Vec::new(); symbols.len()];
    for (at, heap) in ranks {
        for Reverse(rank) in heap {
            origins[rank.symbol].push(at);
        }
    }
    let mut records = Vec::new();
    let mut hashes = BTreeMap::new();
    let mut model = None;
    let mut diagnostics = Vec::new();
    for (i, entry) in selected.iter().enumerate() {
        let symbol = &symbols[i];
        let path = config.cache_dir.join(format!("{symbol}.json"));
        let proof = config.cache_dir.join(format!("{symbol}.sha256.json"));
        let local_identity = json!({"preparation_sha256":sha(&serde_json::to_vec(&identity)?),
            "source":entry,"origins_sha256":sha(&serde_json::to_vec(&origins[i])?)});
        let cached = if path.exists() && proof.exists() {
            let bytes = fs::read(&path)?;
            ensure!(
                read(&proof)?["sha256"] == sha(&bytes),
                "15m cached features changed"
            );
            let cache: SymbolCache = serde_json::from_slice(&bytes)?;
            ensure!(
                cache.identity == local_identity,
                "15m feature cache identity changed"
            );
            cache
        } else {
            ensure!(
                !path.exists(),
                "Orphan intraday cache lacks its SHA proof; preserve and use a fresh cache"
            );
            let (rows, history) = source(&config.data_dir, entry)?;
            let mut cache = SymbolCache {
                identity: local_identity,
                rows: Vec::new(),
                invalid_forecasts: 0,
                immature_origins: 0,
            };
            for (n, &at) in origins[i].iter().enumerate() {
                let index = rows
                    .binary_search_by_key(&(at - INTERVAL_MS), |r| r["openTime"].as_i64().unwrap())
                    .map_err(|_| anyhow::anyhow!("Rank origin lacks real 15m candle"))?;
                let end = index + 1;
                if end + 48 > rows.len() {
                    cache.immature_origins += 1;
                    continue;
                }
                let prefix = &rows[end - CONTEXT_LENGTH..end];
                let input = ContextRecord {
                    symbol: symbol.clone(),
                    origin_ms: at,
                    context_end_open_ms: at - INTERVAL_MS,
                    context: prefix
                        .iter()
                        .map(|r| number(&r["close"], f64::NAN) as f32)
                        .collect(),
                    context_open_ms: Some(
                        prefix
                            .iter()
                            .map(|r| r["openTime"].as_i64().unwrap())
                            .collect(),
                    ),
                    history_sha256: Some(sha(&serde_json::to_vec(prefix)?)),
                };
                if model.is_none() {
                    model = Some(ChronosModel::load(
                        &config.forecast_model,
                        &config.forecast_runtime,
                        config.threads,
                    )?);
                }
                let forecast = match model
                    .as_mut()
                    .unwrap()
                    .forecast_for_interval(&input, "15m")
                    .and_then(|f| {
                        ml_features::chronos_features(&f)?;
                        Ok(f)
                    }) {
                    Ok(f) => f,
                    Err(e) => {
                        cache.invalid_forecasts += 1;
                        eprintln!("Invalid 15m forecast {symbol} {at}: {e}");
                        continue;
                    }
                };
                let mut base = ml_monthly::combined_features_with_market_for_interval(
                    &rows,
                    end,
                    &history,
                    &forecast,
                    &Calibration::default(),
                    &btc,
                    &eth,
                    "15m",
                )?;
                base.truncate(base.len().checked_sub(6).context("Missing Chronos block")?);
                let label = ml_trade_labels::label_origin(
                    symbol,
                    &rows[end - CONTEXT_LENGTH..end + 48],
                    at,
                    at + MATURITY_MS,
                    &labels,
                )?;
                ensure!(
                    label.mature_by_ms == at + MATURITY_MS
                        && label.label_observed_through_ms == label.mature_by_ms,
                    "15m label did not mature at its real deadline"
                );
                let current = number(&rows[end - 1]["close"], f64::NAN);
                let realized_returns: Vec<f64> = rows[end..end + 12]
                    .iter()
                    .map(|r| number(&r["close"], f64::NAN) / current - 1.)
                    .collect();
                let last = realized_returns[11];
                let terminal_label = if last > 0. {
                    2
                } else if last < 0. {
                    0
                } else {
                    1
                };
                cache.rows.push(CachedRow {
                    long_target: net_target(&label.long, true)?,
                    short_target: net_target(&label.short, true)?,
                    record: TrainingRecord {
                        symbol: symbol.clone(),
                        origin_ms: at,
                        mature_by_ms: label.mature_by_ms,
                        label: label.class_index,
                        terminal_label,
                        base,
                        forecast,
                        realized_returns,
                    },
                });
                if (n + 1) % 1000 == 0 {
                    eprintln!("15m features {symbol} {}/{}", n + 1, origins[i].len());
                }
            }
            write_new(&path, &cache)?;
            write_new(&proof, &json!({"sha256":sha(&fs::read(&path)?)}))?;
            cache
        };
        for row in &cached.rows {
            ensure!(
                row.record.symbol == *symbol
                    && row.record.base.len() == 63
                    && row.record.origin_ms >= config.start_ms
                    && row.record.origin_ms < config.end_ms
                    && row.record.mature_by_ms == row.record.origin_ms + MATURITY_MS
                    && row.record.forecast.interval == "15m"
                    && origins[i].binary_search(&row.record.origin_ms).is_ok()
                    && row.record.base.iter().all(|x| x.is_finite())
                    && row.long_target.is_none_or(f64::is_finite)
                    && row.short_target.is_none_or(f64::is_finite),
                "Invalid audited intraday record"
            );
        }
        hashes.insert(symbol.clone(), sha(&fs::read(&path)?));
        diagnostics.push(json!({"symbol":symbol,"ranked_origins":origins[i].len(),"records":cached.rows.len(),
            "invalid_forecasts":cached.invalid_forecasts,"immature_origins":cached.immature_origins}));
        records.extend(cached.rows.into_iter().map(|r| ProfitRecord {
            record: r.record,
            long_target: r.long_target,
            short_target: r.short_target,
        }));
        eprintln!(
            "15m prepared {symbol} ({}/{}) total_records={}",
            i + 1,
            symbols.len(),
            records.len()
        );
    }
    drop(model);
    records.sort_by(|a, b| {
        a.record
            .origin_ms
            .cmp(&b.record.origin_ms)
            .then_with(|| a.record.symbol.cmp(&b.record.symbol))
    });
    let provenance = json!({"preparation":identity,"cache_sha256":hashes,"per_symbol":diagnostics,
        "records":records.len(),"all_collected_symbols":symbols.len(),"interval":"15m",
        "inference_population":"valid forecasts for point-in-time top50; no fill/PnL target filtering; final immature 12h omitted",
        "chronos_weights_updated":false,"targets_in_features":false});
    Ok(ProfitData {
        records,
        symbols,
        start_ms: config.start_ms,
        end_ms: config.end_ms,
        provenance,
    })
}

/// Verified compact candles for the union of causally selected replay symbols.
pub fn replay_markets(
    data_dir: &Path,
    data: &ProfitData,
    start: i64,
    end: i64,
) -> Result<BTreeMap<String, Vec<Value>>> {
    let (_, selected) = entries(data_dir, &data.symbols)?;
    let wanted: BTreeSet<_> = data
        .records
        .iter()
        .filter(|r| r.record.origin_ms >= start && r.record.origin_ms < end)
        .map(|r| r.record.symbol.as_str())
        .collect();
    let mut markets = BTreeMap::new();
    // Rank competitors must include every collected symbol even if never selected.
    for (i, entry) in selected.iter().enumerate() {
        let symbol = entry["symbol"].as_str().unwrap();
        let (rows, _) = source(data_dir, entry)?;
        let compact:Vec<_>=rows.into_iter().filter(|r|{
            let close=r["openTime"].as_i64().unwrap()+INTERVAL_MS;
            close>=start-256*INTERVAL_MS && close<=end
        }).map(|r|json!({"openTime":r["openTime"],"open":r["open"],"high":r["high"],"low":r["low"],
            "close":r["close"],"volume":r["volume"],"quoteVolume":r["quoteVolume"],"confirmed":true})).collect();
        if !compact.is_empty() {
            markets.insert(symbol.to_owned(), compact);
        } else {
            ensure!(
                !wanted.contains(symbol),
                "Selected inference lacks replay market"
            );
        }
        if (i + 1) % 50 == 0 {
            eprintln!("15m replay markets {}/{}", i + 1, selected.len());
        }
    }
    Ok(markets)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candles(n: usize) -> Vec<Value> {
        (0..n)
            .map(|i| json!({"openTime":i as i64*INTERVAL_MS,"quoteVolume":1.}))
            .collect()
    }
    #[test]
    fn point_in_time_universe_uses_only_the_closed_96_bar_prefix_and_deterministic_ties() {
        let rows = candles(300);
        let mut altered = rows.clone();
        for row in &mut altered[280..] {
            row["quoteVolume"] = json!(1e12);
        }
        let mut a = BTreeMap::new();
        let mut b = BTreeMap::new();
        rank_source(&rows, 1, 256 * INTERVAL_MS, 280 * INTERVAL_MS, 1, &mut a).unwrap();
        rank_source(&altered, 1, 256 * INTERVAL_MS, 280 * INTERVAL_MS, 1, &mut b).unwrap();
        for (at, heap) in &a {
            assert_eq!(
                heap.peek().unwrap().0.volume,
                b[at].peek().unwrap().0.volume
            );
        }
        let at = 279 * INTERVAL_MS;
        assert_eq!(a[&at].peek().unwrap().0.volume, 96.);
        add_rank(
            &mut a,
            at,
            Rank {
                volume: 96.,
                symbol: 0,
            },
            1,
        );
        assert_eq!(a[&at].peek().unwrap().0.symbol, 0);
    }
    #[test]
    fn intraday_maturity_keeps_a_real_twelve_hour_embargo() {
        assert_eq!(MATURITY_MS, 12 * 3_600_000);
        assert_eq!(CONTEXT_LENGTH as i64 * INTERVAL_MS, 64 * 3_600_000);
    }
}
