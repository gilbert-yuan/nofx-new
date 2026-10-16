//! Separately published Binance Public Data archives; no trading REST API or proxy.
use anyhow::{Context, Result, ensure};
use chrono::{Datelike, Duration as Days, NaiveDate, Utc};
use clap::{Parser, ValueEnum};
use futures::{StreamExt, stream};
use nofx_core::{
    ml_archive,
    ml_dataset::{self, DAY_MS, HOUR_MS},
};
use quick_xml::{Reader, events::Event};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

const BASE: &str = "https://data.binance.vision";
const BUCKET: &str = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
#[derive(Clone, Copy, ValueEnum)]
enum Phase {
    Candles,
    History,
    All,
}
#[derive(Parser)]
#[command(about = "Download checksum-verified public USD-M archives using native Rust")]
struct Args {
    #[arg(long)]
    probe: bool,
    #[arg(long, default_value = "data/ml/monthly-archive-20261014")]
    output_dir: PathBuf,
    #[arg(long, value_enum, default_value = "all")]
    phase: Phase,
    #[arg(long, default_value_t = 8)]
    concurrency: usize,
    #[arg(long, default_value_t = 30)]
    days: u32,
    /// Exclusive UTC date, frozen in the manifest (for example 2026-10-14).
    #[arg(long)]
    end_date: Option<NaiveDate>,
    #[arg(long, default_value_t = 256)]
    warmup_hours: u32,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    /// Rebuild normalized histories from frozen raw files, preserving originals.
    #[arg(long)]
    rebuild_history: bool,
    /// Use only frozen archives; no network requests, including directory listings.
    #[arg(long)]
    cache_only: bool,
    /// Reuse verified raw ZIP/CHECKSUM pairs from existing dataset roots read-only.
    #[arg(long)]
    raw_cache_dir: Vec<PathBuf>,
    /// Preserve real historical rows of contracts absent on the final UTC day.
    #[arg(long)]
    include_inactive: bool,
}
#[derive(Clone)]
struct Archive {
    client: reqwest::Client,
    root: PathBuf,
    cache_only: bool,
    raw_cache_dirs: Vec<PathBuf>,
    inventory: bool,
    include_inactive: bool,
}
struct File {
    bytes: Vec<u8>,
    source: Value,
}
#[derive(Default)]
struct Listing {
    prefixes: Vec<String>,
    keys: Vec<String>,
    next: Option<String>,
    truncated: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        (1..=8).contains(&args.concurrency),
        "concurrency must be 1..=8"
    );
    ensure!(
        (1..=730).contains(&args.days) && args.warmup_hours <= 2048,
        "Invalid window"
    );
    fs::create_dir_all(&args.output_dir)?;
    let root = fs::canonicalize(&args.output_dir)?;
    let mut raw_cache_dirs = Vec::new();
    for cache in &args.raw_cache_dir {
        let cache = fs::canonicalize(cache).context("Raw cache directory does not exist")?;
        ensure!(
            cache != root && cache.is_dir(),
            "Raw cache must be a different dataset root"
        );
        ensure!(
            !raw_cache_dirs.contains(&cache),
            "Duplicate raw cache directory"
        );
        raw_cache_dirs.push(cache);
    }
    let raw_cache_fingerprints: Vec<Value> = raw_cache_dirs.iter().map(|root| -> Result<Value> {
        Ok(json!({"root":root,"manifest_sha256":ml_dataset::file_digest(&root.join("manifest.json"))?}))
    }).collect::<Result<_>>()?;
    let _writer = ml_dataset::collector_lock(&args.output_dir)?;
    let archive = Archive {
        client: reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(40))
            .connect_timeout(Duration::from_secs(10))
            .user_agent("NOFX-Public-Archive/0.1")
            .build()?,
        root: args.output_dir.clone(),
        cache_only: args.cache_only,
        raw_cache_dirs,
        inventory: args.days > 90 || args.include_inactive,
        include_inactive: args.include_inactive,
    };
    if args.probe {
        let latest = archive.latest_day().await?;
        let dirs = archive.list("data/futures/um/daily/klines/").await?;
        ensure!(!dirs.is_empty(), "No public archive directories");
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"status":"probe_success","latest_verified_utc_day":latest.to_string(),
            "provider":"Binance Public Data archives","proxy_used":false,"public_directory_listing":true,"archive_directories":dirs.len()})
            )?
        );
        return Ok(());
    }
    let manifest_path = archive.root.join("manifest.json");
    let mut manifest = if manifest_path.exists() {
        let saved = ml_dataset::read_json(&manifest_path)?;
        ensure!(
            saved["schema_version"] == 1
                && saved["days"] == args.days
                && saved["warmup_hours"] == args.warmup_hours
                && saved["provider"] == "Binance Public Data archives"
                && saved["include_inactive"].as_bool().unwrap_or(false) == args.include_inactive
                && saved["raw_cache_dirs"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    == serde_json::to_value(&archive.raw_cache_dirs)?
                        .as_array()
                        .unwrap()
                        .clone()
                && saved["raw_cache_fingerprints"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    == raw_cache_fingerprints
                && saved["collector_code_sha256"]
                    .as_str()
                    .is_none_or(|sha| sha
                        == hex::encode(Sha256::digest(include_bytes!("nofx-ml-archive.rs"))))
                && args
                    .end_date
                    .is_none_or(|day| saved["end_ms"] == day_ms(day)),
            "Resume parameters differ; use a new directory"
        );
        saved
    } else {
        ensure!(
            !matches!(args.phase, Phase::History),
            "Collect candles before history"
        );
        let (latest, end) = if let Some(end_date) = args.end_date {
            ensure!(
                end_date <= Utc::now().date_naive(),
                "end-date must exclude the current incomplete UTC day"
            );
            let latest = end_date - Days::days(1);
            archive.verify_day(latest).await?;
            (latest, day_ms(end_date))
        } else {
            let latest = archive.latest_day().await?;
            (latest, day_ms(latest + Days::days(1)))
        };
        let mut dirs = archive.list("data/futures/um/daily/klines/").await?;
        if args.include_inactive {
            dirs.extend(archive.list("data/futures/um/monthly/klines/").await?);
        }
        let symbols = universe(&dirs, &args.symbols)?;
        json!({"schema_version":1,"status":"collecting","train_ready":false,"history_complete":false,"days":args.days,"warmup_hours":args.warmup_hours,
            "provider":"Binance Public Data archives","universe":if args.include_inactive {"Public USD-M daily/monthly archive USDT directory union; historical inactive rows preserved separately from current eligibility; current REST trading status unavailable; not all global coins"} else {"Public USD-M archive USDT directories; eligibility requires complete newest published UTC day; current REST trading status unavailable; not all global coins"},
            "include_inactive":args.include_inactive,"raw_cache_dirs":archive.raw_cache_dirs,"archive_inventory_enabled":archive.inventory,
            "raw_cache_fingerprints":raw_cache_fingerprints,"collector_code_sha256":hex::encode(Sha256::digest(include_bytes!("nofx-ml-archive.rs"))),
            "latest_published_utc_day":latest.to_string(),"start_ms":end-i64::from(args.days)*DAY_MS,"end_ms":end,"end_exclusive_ms":end,
            "lookback_start_ms":end-i64::from(args.days)*DAY_MS-i64::from(args.warmup_hours)*HOUR_MS,
            "collected_at_ms":nofx_core::now_ms(),"proxy_used":false,"account_credentials_used":false,"orders_enabled":false,
            "snapshots_training_eligible":false,"restricted_symbols":!args.symbols.is_empty(),"symbols":symbols})
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
        let mut done = 0;
        let mut tasks = stream::iter(jobs.into_iter().map(|entry| {
            let archive = archive.clone();
            async move {
                let mut result = entry.clone();
                match candles(&archive, &entry, lookback, start, end).await {
                    Ok(fields) => merge(&mut result, &fields),
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
            done += 1;
            replace(&mut manifest, entry.clone())?;
            status(&mut manifest, false)?;
            ml_dataset::checkpoint(&manifest_path, &manifest)?;
            eprintln!(
                "candles {done}/{total} {} status={} rows={} eligible={}",
                entry["symbol"], entry["status"], entry["rows"], entry["training_eligible"]
            );
        }
        status(&mut manifest, true)?;
        ml_dataset::checkpoint(&manifest_path, &manifest)?;
        eprintln!(
            "CANDLE_STAGE_READY eligible={} end_ms={end}",
            manifest["eligible_symbols"]
        );
    }
    if matches!(args.phase, Phase::History | Phase::All) {
        manifest["history_complete"] = json!(false);
        ml_dataset::checkpoint(&manifest_path, &manifest)?;
        let daily = archive.list("data/futures/um/daily/").await?;
        let monthly = archive.list("data/futures/um/monthly/").await?;
        let jobs: Vec<_> = manifest["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                e["training_eligible"] == true
                    || (args.include_inactive && e["historical_training_eligible"] == true)
            })
            .filter(|e| {
                args.symbols.is_empty()
                    || args.symbols.iter().any(|name| {
                        e["symbol"].as_str() == Some(name.trim().to_ascii_uppercase().as_str())
                    })
            })
            .cloned()
            .collect();
        ensure!(
            args.symbols.is_empty() || jobs.len() == args.symbols.len(),
            "Requested history symbols must be unique eligible manifest entries"
        );
        for entry in manifest["symbols"].as_array_mut().unwrap() {
            if entry["training_eligible"] != true
                && !(args.include_inactive && entry["historical_training_eligible"] == true)
            {
                entry["history_status"] = json!("excluded_ineligible");
            }
        }
        let total = jobs.len();
        let mut done = 0;
        let mut tasks = stream::iter(jobs.into_iter().map(|entry| {
            let archive = archive.clone();
            let daily = daily.clone();
            let monthly = monthly.clone();
            async move {
                let mut result = entry.clone();
                match history(
                    &archive,
                    &entry,
                    start,
                    end,
                    &daily,
                    &monthly,
                    args.rebuild_history,
                )
                .await
                {
                    Ok(fields) => merge(&mut result, &fields),
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
            done += 1;
            replace(&mut manifest, entry.clone())?;
            ml_dataset::checkpoint(&manifest_path, &manifest)?;
            eprintln!(
                "history {done}/{total} {} status={}",
                entry["symbol"], entry["history_status"]
            );
        }
        status(&mut manifest, true)?;
        let errors = manifest["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| {
                (e["training_eligible"] == true
                    || (args.include_inactive && e["historical_training_eligible"] == true))
                    && e["history_status"] != "complete"
            })
            .count();
        manifest["history_complete"] = json!(true);
        manifest["history_all_available"] = json!(errors == 0);
        manifest["history_unavailable_symbols"] = json!(errors);
        manifest["status"] = json!(if errors == 0
            && manifest["failed_symbols"].as_u64().unwrap_or(0) == 0
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
            &json!({"manifest":manifest_path,"status":manifest["status"],"candidates":manifest["symbols"].as_array().unwrap().len(),
        "eligible_symbols":manifest["eligible_symbols"],"historically_eligible_symbols":manifest["historically_eligible_symbols"],"failed_symbols":manifest["failed_symbols"],"history_complete":manifest["history_complete"],"start_ms":start,"end_ms":end})
        )?
    );
    Ok(())
}

impl Archive {
    async fn get(&self, url: &str) -> Result<reqwest::Response> {
        for attempt in 0..4 {
            match self.client.get(url).send().await {
                Ok(response)
                    if response.status().as_u16() == 429 || response.status().is_server_error() =>
                {
                    ensure!(
                        attempt < 3,
                        "Public archive HTTP {}: {url}",
                        response.status()
                    );
                    let delay = response
                        .headers()
                        .get("retry-after")
                        .and_then(|h| h.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(1 << attempt)
                        .min(30);
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                }
                Ok(response) => return Ok(response),
                Err(error) if attempt == 3 => return Err(error.into()),
                Err(_) => tokio::time::sleep(Duration::from_millis(500 << attempt)).await,
            }
        }
        unreachable!()
    }
    async fn download(&self, key: &str) -> Result<Option<File>> {
        ensure!(
            key.starts_with("data/futures/um/") && !key.contains("..") && key.ends_with(".zip"),
            "Unsafe archive key"
        );
        let relative = format!("raw/{key}");
        let path = self.root.join(&relative);
        let check_path = self.root.join(format!("{relative}.CHECKSUM"));
        let url = format!("{BASE}/{key}");
        let cached = raw_pair(&archive_roots(self), &relative)?;
        let (bytes, check, reused) = if let Some((bytes, check, root)) = cached {
            (bytes, check, (root != self.root).then_some(root))
        } else {
            if self.cache_only {
                return Ok(None);
            }
            let response = self.get(&format!("{url}.CHECKSUM")).await?;
            if response.status().as_u16() == 404 {
                return Ok(None);
            }
            ensure!(
                response.status().is_success(),
                "Public checksum HTTP {}: {url}",
                response.status()
            );
            let check =
                String::from_utf8(ml_dataset::bounded_response_bytes(response, 4096).await?)?;
            ensure!(check.len() <= 4096, "Checksum too large");
            let response = self.get(&url).await?;
            ensure!(
                response.status().is_success(),
                "Public ZIP HTTP {}: {url}",
                response.status()
            );
            ensure!(
                response
                    .content_length()
                    .is_none_or(|n| n <= ml_archive::MAX_ZIP_BYTES as u64),
                "ZIP too large"
            );
            (
                ml_dataset::bounded_response_bytes(response, ml_archive::MAX_ZIP_BYTES).await?,
                check,
                None,
            )
        };
        let sha = verify_raw(&bytes, &check, key)?;
        if path.exists() {
            ensure!(
                ml_dataset::file_digest(&path)? == sha,
                "Existing orphan ZIP differs from verified download; use a new dataset directory"
            );
        } else {
            write_bytes(&path, &bytes)?;
        }
        if !check_path.exists() {
            write_bytes(&check_path, check.as_bytes())?;
        } else {
            verify_raw(&bytes, &fs::read_to_string(&check_path)?, key)?;
        }
        Ok(Some(File {
            bytes,
            source: json!({"url":url,"zip_path":relative,"checksum_path":format!("{relative}.CHECKSUM"),"sha256":sha,"reused_from_read_only_dataset":reused}),
        }))
    }
    async fn list(&self, prefix: &str) -> Result<Vec<String>> {
        if self.cache_only {
            let mut prefixes = Vec::new();
            for root in archive_roots(self) {
                let directory = root.join("raw").join(prefix);
                if directory.exists() {
                    for entry in fs::read_dir(directory)? {
                        let entry = entry?;
                        if entry.file_type()?.is_dir() {
                            prefixes
                                .push(format!("{prefix}{}/", entry.file_name().to_string_lossy()));
                        }
                    }
                }
            }
            prefixes.sort();
            prefixes.dedup();
            return Ok(prefixes);
        }
        let mut marker = None::<String>;
        let mut prefixes = Vec::new();
        loop {
            let mut url = reqwest::Url::parse(BUCKET)?;
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("prefix", prefix)
                    .append_pair("delimiter", "/")
                    .append_pair("max-keys", "1000");
                if let Some(marker) = &marker {
                    query.append_pair("marker", marker);
                }
            }
            let response = self.get(url.as_str()).await?;
            ensure!(
                response.status().is_success(),
                "Public listing HTTP {}",
                response.status()
            );
            let text = String::from_utf8(
                ml_dataset::bounded_response_bytes(response, 4 * 1024 * 1024).await?,
            )?;
            ensure!(text.len() <= 4 * 1024 * 1024, "Listing too large");
            let listing = parse_listing(&text)?;
            let next = listing
                .next
                .or_else(|| listing.prefixes.last().cloned())
                .or_else(|| listing.keys.last().cloned());
            prefixes.extend(listing.prefixes.into_iter().filter(|p| p != prefix));
            if !listing.truncated {
                break;
            }
            let next = next.context("Truncated listing lacks marker")?;
            ensure!(
                marker.as_ref().is_none_or(|old| next > *old),
                "Listing made no progress"
            );
            marker = Some(next);
        }
        prefixes.sort();
        prefixes.dedup();
        Ok(prefixes)
    }
    async fn latest_day(&self) -> Result<NaiveDate> {
        for ago in 1..=3 {
            let day = Utc::now().date_naive() - Days::days(ago);
            if let Some(file) = self
                .download(&daily_key("klines", "BTCUSDT", Some("1h"), day))
                .await?
            {
                let first = day_ms(day);
                let rows =
                    ml_archive::klines(&ml_archive::read_csv(&file.bytes)?, first, first + DAY_MS)?;
                ensure!(
                    ml_dataset::candle_coverage(&rows, first, first + DAY_MS)?.complete,
                    "Newest BTC file is not a complete UTC day"
                );
                return Ok(day);
            }
        }
        anyhow::bail!("No BTC archive within latest3 full UTC days; refusing older-month fallback")
    }

    async fn verify_day(&self, day: NaiveDate) -> Result<()> {
        let file = self
            .download(&daily_key("klines", "BTCUSDT", Some("1h"), day))
            .await?
            .context("Requested final UTC day has no published BTC archive")?;
        let first = day_ms(day);
        let rows = ml_archive::klines(&ml_archive::read_csv(&file.bytes)?, first, first + DAY_MS)?;
        ensure!(
            ml_dataset::candle_coverage(&rows, first, first + DAY_MS)?.complete,
            "Requested final BTC archive is not a complete UTC day"
        );
        Ok(())
    }

    /// Restrict S3 enumeration to one contract and the requested key range.
    /// The initial marker skips older years and the upper bound ends pagination.
    async fn available_keys(
        &self,
        category: &str,
        symbol: &str,
        interval: Option<&str>,
        monthly: bool,
        start: i64,
        end: i64,
    ) -> Result<BTreeSet<String>> {
        let range = inventory_range(category, symbol, interval, monthly, start, end)?;
        let identity = json!({"schema_version":1,"prefix":range.0,"lower":range.1,"upper":range.2,
            "cache_only":self.cache_only,"raw_cache_dirs":self.raw_cache_dirs});
        let path = self
            .root
            .join("inventory")
            .join(format!("{}.json", ml_dataset::digest(&identity)?));
        if path.exists() {
            let doc = ml_dataset::read_json(&path)?;
            ensure!(
                doc["identity"] == identity
                    && doc["keys_sha256"] == ml_dataset::digest(&doc["keys"])?,
                "Archive inventory checksum mismatch"
            );
            let keys: BTreeSet<String> = serde_json::from_value(doc["keys"].clone())?;
            ensure!(
                keys.iter().all(|key| key.starts_with(&range.0)
                    && key.as_str() >= range.1.as_str()
                    && key.as_str() < range.2.as_str()
                    && key.ends_with(".zip")),
                "Invalid frozen archive inventory key"
            );
            return Ok(keys);
        }
        let mut keys = BTreeSet::new();
        if self.cache_only {
            for root in archive_roots(self) {
                let directory = root.join("raw").join(&range.0);
                if !directory.exists() {
                    continue;
                }
                for item in fs::read_dir(directory)? {
                    let item = item?;
                    if item.file_type()?.is_file() {
                        let key = format!("{}{}", range.0, item.file_name().to_string_lossy());
                        if key.as_str() >= range.1.as_str()
                            && key.as_str() < range.2.as_str()
                            && key.ends_with(".zip")
                            && root.join("raw").join(format!("{key}.CHECKSUM")).exists()
                        {
                            keys.insert(key);
                        }
                    }
                }
            }
        } else {
            let mut marker = range.1.trim_end_matches(".zip").to_owned();
            loop {
                let mut url = reqwest::Url::parse(BUCKET)?;
                url.query_pairs_mut()
                    .append_pair("prefix", &range.0)
                    .append_pair("marker", &marker)
                    .append_pair("max-keys", "1000");
                let response = self.get(url.as_str()).await?;
                ensure!(
                    response.status().is_success(),
                    "Archive inventory HTTP {}",
                    response.status()
                );
                let text = String::from_utf8(
                    ml_dataset::bounded_response_bytes(response, 4 * 1024 * 1024).await?,
                )?;
                let listing = parse_listing(&text)?;
                ensure!(
                    listing.prefixes.iter().all(|prefix| prefix == &range.0),
                    "Unexpected inventory common prefix"
                );
                let reached_end = listing.keys.iter().any(|key| key >= &range.2);
                for key in &listing.keys {
                    ensure!(
                        key.starts_with(&range.0),
                        "Archive inventory escaped requested prefix"
                    );
                    if key >= &range.1 && key < &range.2 && key.ends_with(".zip") {
                        keys.insert(key.clone());
                    }
                }
                if !listing.truncated || reached_end {
                    break;
                }
                let next = listing
                    .next
                    .or_else(|| listing.keys.last().cloned())
                    .context("Truncated inventory lacks marker")?;
                ensure!(next > marker, "Archive inventory made no progress");
                marker = next;
            }
        }
        let doc = json!({"identity":identity,"keys":keys,"keys_sha256":ml_dataset::digest(&keys)?,
            "listed_at_ms":nofx_core::now_ms(),"source":if self.cache_only {"verified raw cache filenames"} else {"Binance public S3 key listing"}});
        ml_dataset::write_new(&path, &doc)?;
        Ok(keys)
    }
}

fn archive_roots(archive: &Archive) -> Vec<PathBuf> {
    std::iter::once(archive.root.clone())
        .chain(archive.raw_cache_dirs.iter().cloned())
        .collect()
}

fn raw_pair(roots: &[PathBuf], relative: &str) -> Result<Option<(Vec<u8>, String, PathBuf)>> {
    for root in roots {
        let path = root.join(relative);
        let check = root.join(format!("{relative}.CHECKSUM"));
        if path.exists() && check.exists() {
            ensure!(
                fs::metadata(&path)?.len() <= ml_archive::MAX_ZIP_BYTES as u64
                    && fs::metadata(&check)?.len() <= 4096,
                "Raw cache pair exceeds size limit"
            );
            return Ok(Some((
                fs::read(path)?,
                fs::read_to_string(check)?,
                root.clone(),
            )));
        }
    }
    Ok(None)
}

fn verify_raw(bytes: &[u8], check: &str, key: &str) -> Result<String> {
    ensure!(
        bytes.len() <= ml_archive::MAX_ZIP_BYTES && check.len() <= 4096,
        "Archive exceeds size limit"
    );
    let parts: Vec<_> = check.split_whitespace().collect();
    let expected = parts.first().context("Empty checksum")?;
    ensure!(
        parts.len() <= 2 && expected.len() == 64 && expected.chars().all(|c| c.is_ascii_hexdigit()),
        "Invalid published SHA256"
    );
    if let Some(name) = parts.get(1) {
        ensure!(
            name.trim_start_matches('*') == key.rsplit('/').next().unwrap(),
            "Checksum filename mismatch"
        );
    }
    let sha = hex::encode(Sha256::digest(bytes));
    ensure!(
        sha.eq_ignore_ascii_case(expected),
        "Archive checksum mismatch: {key}"
    );
    ensure!(bytes.starts_with(b"PK"), "Not a ZIP");
    Ok(sha)
}

fn inventory_range(
    category: &str,
    symbol: &str,
    interval: Option<&str>,
    monthly: bool,
    start: i64,
    end: i64,
) -> Result<(String, String, String)> {
    ensure!(start < end, "Invalid archive inventory range");
    let first = date(start)?;
    let cutoff = date(end)?;
    let key = |day| {
        if monthly {
            monthly_key(category, symbol, interval, day)
        } else {
            daily_key(category, symbol, interval, day)
        }
    };
    let lower = key(if monthly {
        NaiveDate::from_ymd_opt(first.year(), first.month(), 1).unwrap()
    } else {
        first
    });
    let upper = key(if monthly {
        next_month(NaiveDate::from_ymd_opt(cutoff.year(), cutoff.month(), 1).unwrap())
    } else {
        cutoff
    });
    let prefix = format!(
        "{}/",
        lower.rsplit_once('/').context("Invalid inventory key")?.0
    );
    Ok((prefix, lower, upper))
}

fn parse_listing(text: &str) -> Result<Listing> {
    let mut reader = Reader::from_str(text);
    reader.config_mut().trim_text(true);
    let mut out = Listing::default();
    let mut tag = Vec::new();
    let mut root = false;
    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                tag = e.name().as_ref().to_vec();
                if tag == b"ListBucketResult" {
                    root = true;
                }
            }
            Event::Text(e) => {
                let value = e.decode()?.into_owned();
                match tag.as_slice() {
                    b"Prefix" => out.prefixes.push(value),
                    b"Key" => out.keys.push(value),
                    b"NextMarker" => out.next = Some(value),
                    b"IsTruncated" => out.truncated = value == "true",
                    _ => {}
                }
            }
            Event::End(_) => tag.clear(),
            Event::Eof => break,
            _ => {}
        }
    }
    ensure!(root, "Not a public bucket listing");
    Ok(out)
}
fn universe(dirs: &[String], selected: &[String]) -> Result<Vec<Value>> {
    let normalized: Vec<_> = selected
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .collect();
    let selected: BTreeSet<_> = normalized.iter().cloned().collect();
    ensure!(selected.len() == normalized.len(), "Duplicate symbols");
    let mut rows = BTreeMap::new();
    for dir in dirs {
        let Some(symbol) = dir
            .strip_prefix("data/futures/um/daily/klines/")
            .or_else(|| dir.strip_prefix("data/futures/um/monthly/klines/"))
            .and_then(|s| s.strip_suffix('/'))
        else {
            continue;
        };
        if !symbol.ends_with("USDT") || (!selected.is_empty() && !selected.contains(symbol)) {
            continue;
        }
        let supported = nofx_core::exchange::valid_symbol(symbol).is_ok();
        rows.insert(symbol.to_owned(), json!({"symbol":symbol,"status":if supported {"pending"} else {"unsupported_symbol"},"training_eligible":false,"historical_training_eligible":false,"history_status":"pending",
            "error":if supported {Value::Null} else {json!("Unsupported symbol in system validator")}}));
    }
    let rows: Vec<_> = rows.into_values().collect();
    ensure!(!rows.is_empty(), "No USDT archive candidates");
    ensure!(
        selected.is_empty() || rows.len() == selected.len(),
        "Requested symbol absent from archive"
    );
    Ok(rows)
}
async fn candles(
    archive: &Archive,
    entry: &Value,
    lookback: i64,
    start: i64,
    end: i64,
) -> Result<Value> {
    let symbol = entry["symbol"].as_str().context("Missing symbol")?;
    nofx_core::exchange::valid_symbol(symbol)?;
    let relative = candle_relative(entry, symbol)?;
    let path = archive.root.join(&relative);
    let doc = if path.exists() {
        if entry["path"] == relative {
            ensure!(
                entry["sha256"] == ml_dataset::file_digest(&path)?,
                "Manifest candle file checksum mismatch"
            );
        }
        let doc = ml_dataset::read_json(&path)?;
        ensure!(
            doc["symbol"] == symbol
                && doc["metadata"]["training_start_ms"] == start
                && doc["metadata"]["lookback_start_ms"] == lookback
                && doc["metadata"]["end_exclusive_ms"] == end,
            "Frozen bounds mismatch"
        );
        ensure!(
            doc["metadata"]["content_sha256"] == ml_dataset::digest(&doc["datasets"])?,
            "Frozen checksum mismatch"
        );
        doc
    } else {
        if !archive.include_inactive {
            let Some(latest) = archive
                .download(&daily_key(
                    "klines",
                    symbol,
                    Some("1h"),
                    date(end - DAY_MS)?,
                ))
                .await?
            else {
                return Ok(
                    json!({"status":"unavailable_latest_day","rows":0,"training_eligible":false,"error":"Newest complete UTC day not published: stopped, delisted, or unavailable cannot be distinguished"}),
                );
            };
            let rows =
                ml_archive::klines(&ml_archive::read_csv(&latest.bytes)?, end - DAY_MS, end)?;
            ensure!(
                ml_dataset::candle_coverage(&rows, end - DAY_MS, end)?.complete,
                "Newest symbol day incomplete"
            );
        }
        let (records, sources, missing) =
            period(archive, "klines", symbol, Some("1h"), lookback, end, true).await?;
        let rows = ml_archive::klines(&records, lookback, end)?;
        if rows.is_empty() {
            return Ok(
                json!({"status":"unavailable_requested_window","rows":0,"training_eligible":false,
                "historical_training_eligible":false,"missing_archives":missing,"error":"No real hourly observations published in requested window"}),
            );
        }
        let first = rows[0]["openTime"].as_i64().unwrap();
        let coverage = ml_dataset::candle_coverage(&rows, first, end)?;
        let available_end = rows.last().unwrap()["openTime"].as_i64().unwrap() + HOUR_MS;
        let historical_coverage = ml_dataset::candle_coverage(&rows, first, available_end)?;
        let datasets = json!({"1h":rows});
        let doc = json!({"symbol":symbol,"datasets":datasets,"samples":[],"metadata":{"schema_version":1,"source":"Binance Public Data USD-M archive ZIP/CSV",
            "collected_at_ms":nofx_core::now_ms(),"start_ms":first,"lookback_start_ms":lookback,"training_start_ms":start,"end_exclusive_ms":end,"coverage":coverage,
            "content_sha256":ml_dataset::digest(&datasets)?,"closed_only":true,"immutable":true,"sources":sources,"missing_archives":missing,
            "available_end_exclusive_ms":available_end,"historical_coverage":historical_coverage,
            "missing_suffix_hours":(end-available_end)/HOUR_MS,"inactive_at_window_end":available_end<end,
            "missing_prefix_hours":(first-lookback)/HOUR_MS,"short_prefix_reason":"New listing and unpublished earlier archive cannot be distinguished"}});
        ml_dataset::write_new(&path, &doc)?;
        doc
    };
    let rows = doc["datasets"]["1h"]
        .as_array()
        .context("Missing hourly rows")?;
    let first = doc["metadata"]["start_ms"].as_i64().unwrap();
    let mut fields = candle_eligibility(rows, lookback, start, end)?;
    fields["path"] = json!(relative);
    fields["sha256"] = json!(ml_dataset::file_digest(&path)?);
    fields["effective_start_ms"] = json!(first);
    Ok(fields)
}

fn candle_eligibility(rows: &[Value], lookback: i64, start: i64, end: i64) -> Result<Value> {
    let first = rows
        .first()
        .and_then(|row| row["openTime"].as_i64())
        .context("No hourly rows")?;
    let available_end = rows
        .last()
        .and_then(|row| row["openTime"].as_i64())
        .context("Missing final openTime")?
        + HOUR_MS;
    let coverage = ml_dataset::candle_coverage(rows, first, end)?;
    let historical_coverage = ml_dataset::candle_coverage(rows, first, available_end)?;
    let enough = rows.len() >= 256 + 12 + 24
        && available_end > start.max(first + 256 * HOUR_MS) + 12 * HOUR_MS;
    Ok(
        json!({"status":if coverage.complete {"complete"} else if historical_coverage.complete && available_end<end {"historical_inactive"} else {"partial"},
        "rows":rows.len(),"training_eligible":coverage.complete&&enough,
        "historical_training_eligible":historical_coverage.complete&&enough,"effective_start_ms":first,
        "available_end_exclusive_ms":available_end,"inactive_at_window_end":available_end<end,
        "missing_hours":coverage.missing_hours,"missing_warmup_hours":(first-lookback)/HOUR_MS,"missing_suffix_hours":(end-available_end)/HOUR_MS,
        "requested_coverage_complete":first==lookback&&coverage.complete,"coverage":coverage,
        "historical_coverage":historical_coverage,"error":Value::Null}),
    )
}
async fn period(
    archive: &Archive,
    category: &str,
    symbol: &str,
    interval: Option<&str>,
    start: i64,
    end: i64,
    monthly: bool,
) -> Result<(Vec<Vec<String>>, Vec<Value>, Vec<Value>)> {
    let mut records = Vec::new();
    let mut sources = Vec::new();
    let mut missing = Vec::new();
    let first = date(start)?;
    let cutoff = date(end)?;
    let monthly_keys = if archive.inventory && monthly {
        Some(
            archive
                .available_keys(category, symbol, interval, true, start, end)
                .await?,
        )
    } else {
        None
    };
    let mut daily_keys = None;
    let mut month = NaiveDate::from_ymd_opt(first.year(), first.month(), 1).unwrap();
    while month < cutoff {
        let next = next_month(month);
        let mut got = false;
        if monthly && next <= cutoff {
            let key = monthly_key(category, symbol, interval, month);
            if download_listed(archive, &key, monthly_keys.as_ref()) {
                if let Some(file) = archive.download(&key).await? {
                    append_csv(&mut records, ml_archive::read_csv(&file.bytes)?)?;
                    sources.push(file.source);
                    got = true;
                }
            }
        }
        if !got {
            if archive.inventory && daily_keys.is_none() {
                daily_keys = Some(
                    archive
                        .available_keys(category, symbol, interval, false, start, end)
                        .await?,
                );
            }
            let mut day = month.max(first);
            while day < next.min(cutoff) {
                let key = daily_key(category, symbol, interval, day);
                let file = if download_listed(archive, &key, daily_keys.as_ref()) {
                    archive.download(&key).await?
                } else {
                    None
                };
                match file {
                Some(file)=>{append_csv(&mut records, ml_archive::read_csv(&file.bytes)?)?;sources.push(file.source);},
                None=>missing.push(json!({"url":format!("{BASE}/{key}"),"utc_day":day.to_string(),"reason":if archive.cache_only {"not_in_verified_raw_cache"} else {"archive_not_published"},"publication_listing_checked":daily_keys.is_some()}))
            }
                day += Days::days(1);
            }
        }
        month = next;
    }
    Ok((records, sources, missing))
}

fn download_listed(archive: &Archive, key: &str, inventory: Option<&BTreeSet<String>>) -> bool {
    inventory.is_none_or(|keys| keys.contains(key))
        || archive_roots(archive).iter().any(|root| {
            root.join("raw").join(key).exists()
                && root.join("raw").join(format!("{key}.CHECKSUM")).exists()
        })
}
const DATASETS: [&str; 10] = [
    "funding",
    "open_interest",
    "global_long_short",
    "top_account_long_short",
    "top_position_long_short",
    "taker_long_short",
    "basis",
    "mark_price_1h",
    "index_price_1h",
    "premium_index_1h",
];
async fn history(
    archive: &Archive,
    entry: &Value,
    start: i64,
    end: i64,
    daily: &[String],
    monthly: &[String],
    rebuild: bool,
) -> Result<Value> {
    let symbol = entry["symbol"].as_str().context("Missing symbol")?;
    nofx_core::exchange::valid_symbol(symbol)?;
    let relative = history_relative(entry, symbol, rebuild)?;
    let path = archive.root.join(&relative);
    if path.exists() {
        if entry["history_path"] == relative {
            ensure!(
                entry["history_sha256"] == ml_dataset::file_digest(&path)?,
                "Manifest history file checksum mismatch"
            );
        }
        let doc = ml_dataset::read_json(&path)?;
        ensure!(
            doc["symbol"] == symbol && doc["start_ms"] == start && doc["end_exclusive_ms"] == end,
            "Frozen history bounds mismatch"
        );
        ensure!(
            doc["content_sha256"] == ml_dataset::digest(&doc["datasets"])?,
            "History checksum mismatch"
        );
        return Ok(
            json!({"history_path":relative,"history_sha256":ml_dataset::file_digest(&path)?,"history_status":doc["status"],"history_errors":doc["errors"]}),
        );
    }
    let mut datasets: BTreeMap<String, Vec<Value>> = DATASETS
        .into_iter()
        .map(|s| (s.into(), Vec::new()))
        .collect();
    let mut errors = Vec::<Value>::new();
    let mut sources = Vec::<Value>::new();
    let has = |cats: &[String], period: &str, name: &str| {
        cats.iter()
            .any(|p| p == &format!("data/futures/um/{period}/{name}/"))
    };
    if has(daily, "daily", "metrics") || has(monthly, "monthly", "metrics") {
        match period(
            archive,
            "metrics",
            symbol,
            None,
            start,
            end,
            has(monthly, "monthly", "metrics"),
        )
        .await
        {
            Ok((records, raw, missing)) => match metrics_for_symbol(&records, symbol, start, end) {
                Ok(parsed) => {
                    datasets.extend(parsed);
                    sources.extend(raw);
                    for item in missing {
                        errors.push(json!({"dataset":"metrics","detail":item}));
                    }
                }
                Err(e) => errors.push(json!({"dataset":"metrics","error":format!("{e:#}")})),
            },
            Err(e) => errors.push(json!({"dataset":"metrics","error":format!("{e:#}")})),
        }
    } else {
        errors.push(json!({"dataset":"metrics","error":"Daily metrics category absent"}));
    }
    if has(monthly, "monthly", "fundingRate") || has(daily, "daily", "fundingRate") {
        let first = date(start)?;
        let cutoff = date(end)?;
        let mut month = NaiveDate::from_ymd_opt(first.year(), first.month(), 1).unwrap();
        let mut records = Vec::new();
        let funding_keys = if archive.inventory {
            Some(
                archive
                    .available_keys("fundingRate", symbol, None, true, start, end)
                    .await?,
            )
        } else {
            None
        };
        while month < cutoff {
            let next = next_month(month);
            let key = monthly_key("fundingRate", symbol, None, month);
            let file = if download_listed(archive, &key, funding_keys.as_ref()) {
                archive.download(&key).await
            } else {
                Ok(None)
            };
            match file {
            Ok(Some(file))=>match ml_archive::read_csv(&file.bytes) {Ok(rows)=>{append_csv(&mut records, rows)?;sources.push(file.source);},Err(e)=>errors.push(json!({"dataset":"funding","error":format!("{e:#}")}))},
            Ok(None) if has(daily,"daily","fundingRate")=>match period(archive,"fundingRate",symbol,None,start.max(day_ms(month)),end.min(day_ms(next)),false).await {
                Ok((rows,raw,missing))=>{append_csv(&mut records, rows)?;sources.extend(raw);for item in missing {errors.push(json!({"dataset":"funding","detail":item}));}},Err(e)=>errors.push(json!({"dataset":"funding","error":format!("{e:#}")}))},
            Ok(None)=>errors.push(json!({"dataset":"funding","month":month.format("%Y-%m").to_string(),"error":"Monthly funding not published; daily category absent"})),
            Err(e)=>errors.push(json!({"dataset":"funding","error":format!("{e:#}")}))
        }
            month = next;
        }
        match ml_archive::funding(&records, start, end) {
            Ok(rows) => {
                datasets.insert("funding".into(), rows);
            }
            Err(e) => errors.push(json!({"dataset":"funding","error":format!("{e:#}")})),
        }
    } else {
        errors.push(json!({"dataset":"funding","error":"Funding archive category absent"}));
    }
    for (name, cat) in [
        ("mark_price_1h", "markPriceKlines"),
        ("index_price_1h", "indexPriceKlines"),
        ("premium_index_1h", "premiumIndexKlines"),
    ] {
        if has(daily, "daily", cat) || has(monthly, "monthly", cat) {
            match period(
                archive,
                cat,
                symbol,
                Some("1h"),
                start,
                end,
                has(monthly, "monthly", cat),
            )
            .await
            {
                Ok((records, raw, missing)) => {
                    match ml_archive::reference_klines(&records, start, end) {
                        Ok(rows) => {
                            datasets.insert(name.into(), rows);
                            sources.extend(raw);
                            for item in missing {
                                errors.push(json!({"dataset":name,"detail":item}));
                            }
                        }
                        Err(e) => errors.push(json!({"dataset":name,"error":format!("{e:#}")})),
                    }
                }
                Err(e) => errors.push(json!({"dataset":name,"error":format!("{e:#}")})),
            }
        } else {
            errors.push(
                json!({"dataset":name,"error":"Public archive category absent; REST unavailable"}),
            );
        }
    }
    errors.push(json!({"dataset":"basis","error":"Basis not published by archive product; REST unavailable"}));
    let mut coverage = serde_json::Map::new();
    for (name, rows) in &datasets {
        let key = if name == "funding" {
            "fundingTime"
        } else if name.ends_with("_1h") {
            "openTime"
        } else {
            "timestamp"
        };
        let expected = if name == "funding" {
            None
        } else {
            Some(((end - start) / HOUR_MS) as usize)
        };
        coverage.insert(name.clone(),json!({"rows":rows.len(),"first_ms":rows.first().and_then(|r|r[key].as_i64()),"last_ms":rows.last().and_then(|r|r[key].as_i64()),
            "expected_rows":expected,"complete":expected.is_some_and(|n|n==rows.len()),"availability_policy":if name=="funding" {"event time"} else {"source timestamp +1h"}}));
    }
    let result = if errors.is_empty() {
        "complete"
    } else if datasets.values().all(Vec::is_empty) {
        "unavailable"
    } else {
        "partial"
    };
    let doc = json!({"schema_version":1,"symbol":symbol,"start_ms":start,"end_exclusive_ms":end,"status":result,"datasets":datasets,"coverage":coverage,"errors":errors,
        "content_sha256":ml_dataset::digest(&datasets)?,"source":"Binance Public Data archives","sources":sources,"historical_training_eligible":true,"snapshots_included":false,
        "limitations":"Metrics supplies hourly OI and ratio observations. Missing taker buy/sell volumes are not fabricated. Raw ZIP preserves all5min observations; historical receipt times unavailable."});
    ml_dataset::write_new(&path, &doc)?;
    Ok(
        json!({"history_path":relative,"history_sha256":ml_dataset::file_digest(&path)?,"history_status":result,"history_errors":errors}),
    )
}
fn daily_key(cat: &str, symbol: &str, interval: Option<&str>, day: NaiveDate) -> String {
    match interval {
        Some(i) => format!("data/futures/um/daily/{cat}/{symbol}/{i}/{symbol}-{i}-{day}.zip"),
        None => format!("data/futures/um/daily/{cat}/{symbol}/{symbol}-{cat}-{day}.zip"),
    }
}

fn history_relative(entry: &Value, symbol: &str, rebuild: bool) -> Result<String> {
    let original = format!("history/{symbol}.json");
    let rebuilt = format!("history/{symbol}.rebuilt.json");
    if rebuild {
        return Ok(rebuilt);
    }
    let selected = entry["history_path"]
        .as_str()
        .unwrap_or(&original)
        .to_owned();
    ensure!(
        selected == original || selected == rebuilt,
        "Unsafe or unsupported history path"
    );
    Ok(selected)
}

fn candle_relative(entry: &Value, symbol: &str) -> Result<String> {
    let original = format!("symbols/{symbol}.json");
    let repaired = format!("symbols/{symbol}.repaired.json");
    let selected = entry["path"].as_str().unwrap_or(&original).to_owned();
    ensure!(
        selected == original || selected == repaired,
        "Unsafe or unsupported candle path"
    );
    Ok(selected)
}

fn metrics_for_symbol(
    records: &[Vec<String>],
    symbol: &str,
    start: i64,
    end: i64,
) -> Result<BTreeMap<String, Vec<Value>>> {
    for row in records.iter().skip(1) {
        ensure!(
            row.get(1).map(String::as_str) == Some(symbol),
            "Metrics CSV symbol differs from requested {symbol}"
        );
    }
    ml_archive::metrics(records, start, end)
}
fn monthly_key(cat: &str, symbol: &str, interval: Option<&str>, day: NaiveDate) -> String {
    let month = day.format("%Y-%m");
    match interval {
        Some(i) => format!("data/futures/um/monthly/{cat}/{symbol}/{i}/{symbol}-{i}-{month}.zip"),
        None => format!("data/futures/um/monthly/{cat}/{symbol}/{symbol}-{cat}-{month}.zip"),
    }
}
fn next_month(d: NaiveDate) -> NaiveDate {
    if d.month() == 12 {
        NaiveDate::from_ymd_opt(d.year() + 1, 1, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(d.year(), d.month() + 1, 1).unwrap()
    }
}
fn date(ms: i64) -> Result<NaiveDate> {
    Ok(chrono::DateTime::from_timestamp_millis(ms)
        .context("Invalid timestamp")?
        .date_naive())
}
fn day_ms(d: NaiveDate) -> i64 {
    d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis()
}
fn merge(target: &mut Value, fields: &Value) {
    for (k, v) in fields.as_object().unwrap() {
        target[k] = v.clone();
    }
}
fn replace(manifest: &mut Value, entry: Value) -> Result<()> {
    let old = manifest["symbols"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|e| e["symbol"] == entry["symbol"])
        .context("Unknown symbol")?;
    *old = entry;
    Ok(())
}
fn status(manifest: &mut Value, finished: bool) -> Result<()> {
    let entries = manifest["symbols"].as_array().context("Missing entries")?;
    let ok = entries.iter().filter(|e| e["status"] == "complete").count();
    let pending = entries.iter().filter(|e| e["status"] == "pending").count();
    let inactive = entries
        .iter()
        .filter(|e| e["status"] == "historical_inactive")
        .count();
    let failed = entries.len() - ok - pending - inactive;
    let eligible = entries
        .iter()
        .filter(|e| e["training_eligible"] == true)
        .count();
    let historically_eligible = entries
        .iter()
        .filter(|e| e["historical_training_eligible"] == true)
        .count();
    manifest["successful_symbols"] = json!(ok);
    manifest["failed_symbols"] = json!(failed);
    manifest["pending_symbols"] = json!(pending);
    manifest["eligible_symbols"] = json!(eligible);
    manifest["historically_eligible_symbols"] = json!(historically_eligible);
    manifest["historical_inactive_symbols"] = json!(inactive);
    manifest["train_ready"] = json!(finished && pending == 0 && eligible > 0);
    manifest["historical_train_ready"] =
        json!(finished && pending == 0 && historically_eligible > 0);
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
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing raw directory")?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expanded_window_and_inventory_skip_old_years_and_include_boundary_month() {
        let args = Args::try_parse_from([
            "archive",
            "--days",
            "180",
            "--end-date",
            "2026-10-14",
            "--include-inactive",
            "--raw-cache-dir",
            "old-dataset",
        ])
        .unwrap();
        let end = day_ms(args.end_date.unwrap());
        assert_eq!(
            date(end - i64::from(args.days) * DAY_MS)
                .unwrap()
                .to_string(),
            "2026-04-17"
        );
        let first = day_ms(NaiveDate::from_ymd_opt(2026, 4, 6).unwrap()) + 8 * HOUR_MS;
        let (prefix, lower, upper) =
            inventory_range("klines", "BTCUSDT", Some("1h"), false, first, end).unwrap();
        assert_eq!(prefix, "data/futures/um/daily/klines/BTCUSDT/1h/");
        assert!(lower.ends_with("2026-04-06.zip"));
        assert!(upper.ends_with("2026-10-14.zip"));
        let (_, lower, upper) =
            inventory_range("fundingRate", "BTCUSDT", None, true, first, end).unwrap();
        assert!(lower.ends_with("2026-04.zip"));
        assert!(upper.ends_with("2026-11.zip"));
        assert!(inventory_range("klines", "BTCUSDT", Some("1h"), false, end, first).is_err());
    }

    #[test]
    fn historical_inactive_rows_are_kept_without_fabricating_suffix_or_bridging_gaps() {
        let rows: Vec<_> = (0..300).map(|index| json!({"openTime":index*HOUR_MS,
            "closeTime":(index+1)*HOUR_MS-1,"confirmed":true,"open":10.0,"high":11.0,"low":9.0,"close":10.5,
            "volume":100.0,"quoteVolume":1000.0,"takerBuyVolume":40.0,"takerBuyQuoteVolume":400.0,"tradeCount":7})).collect();
        let fields = candle_eligibility(&rows, 0, 256 * HOUR_MS, 360 * HOUR_MS).unwrap();
        assert_eq!(fields["training_eligible"], false);
        assert_eq!(fields["historical_training_eligible"], true);
        assert_eq!(fields["available_end_exclusive_ms"], 300 * HOUR_MS);
        assert_eq!(fields["missing_suffix_hours"], 60);
        assert_eq!(fields["status"], "historical_inactive");
        let mut gapped = rows.clone();
        gapped.remove(280);
        assert_eq!(
            candle_eligibility(&gapped, 0, 256 * HOUR_MS, 360 * HOUR_MS).unwrap()["historical_training_eligible"],
            false
        );
        assert_eq!(
            candle_eligibility(&rows[..280], 0, 256 * HOUR_MS, 360 * HOUR_MS).unwrap()["historical_training_eligible"],
            false
        );
        assert_eq!(
            candle_eligibility(&rows, 0, 256 * HOUR_MS, 300 * HOUR_MS).unwrap()["training_eligible"],
            true
        );
    }

    #[test]
    fn borrowed_raw_pair_is_read_only_and_still_requires_exact_checksum_and_name() {
        let directory =
            std::env::temp_dir().join(format!("nofx-raw-reuse-{}", uuid::Uuid::new_v4()));
        let source = directory.join("source");
        let target = directory.join("target");
        let key = "data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-10-01.zip";
        let relative = format!("raw/{key}");
        let path = source.join(&relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::create_dir_all(&target).unwrap();
        let bytes = b"PKverified immutable fixture";
        let sha = hex::encode(Sha256::digest(bytes));
        let check = format!("{sha}  BTCUSDT-1h-2026-10-01.zip\n");
        fs::write(&path, bytes).unwrap();
        fs::write(source.join(format!("{relative}.CHECKSUM")), &check).unwrap();
        let pair = raw_pair(&[target.clone(), source.clone()], &relative)
            .unwrap()
            .unwrap();
        assert_eq!(pair.2, source);
        assert_eq!(verify_raw(&pair.0, &pair.1, key).unwrap(), sha);
        assert!(!target.join(&relative).exists());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let mut changed = pair.0;
        changed[2] ^= 1;
        assert!(verify_raw(&changed, &pair.1, key).is_err());
        assert!(verify_raw(bytes, &check.replace("BTCUSDT", "ETHUSDT"), key).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn daily_and_monthly_universe_union_includes_inactive_symbols_once() {
        let dirs = vec![
            "data/futures/um/daily/klines/BTCUSDT/".to_owned(),
            "data/futures/um/monthly/klines/BTCUSDT/".to_owned(),
            "data/futures/um/monthly/klines/OLDUSDT/".to_owned(),
        ];
        let entries = universe(&dirs, &[]).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["symbol"], "BTCUSDT");
        assert_eq!(entries[1]["symbol"], "OLDUSDT");
    }
    #[test]
    fn metrics_identity_must_match_the_requested_archive_symbol() {
        let header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
        let record = "1970-01-01 00:00:00,BTCUSDT,1,2,3,4,5,6";
        let rows = vec![header, record]
            .into_iter()
            .map(|row| row.split(',').map(str::to_string).collect())
            .collect::<Vec<_>>();
        assert_eq!(
            metrics_for_symbol(&rows, "BTCUSDT", 0, HOUR_MS).unwrap()["open_interest"].len(),
            1
        );
        assert!(metrics_for_symbol(&rows, "ETHUSDT", 0, HOUR_MS).is_err());
    }
    #[test]
    fn history_resume_keeps_verified_rebuilt_path() {
        let entry = json!({"history_path":"history/BTCUSDT.rebuilt.json"});
        assert_eq!(
            history_relative(&entry, "BTCUSDT", false).unwrap(),
            "history/BTCUSDT.rebuilt.json"
        );
        assert_eq!(
            history_relative(&json!({}), "GRTUSDT", false).unwrap(),
            "history/GRTUSDT.json"
        );
        assert!(
            history_relative(&json!({"history_path":"../other.json"}), "BTCUSDT", false).is_err()
        );
        assert_eq!(
            candle_relative(&json!({"path":"symbols/GRTUSDT.repaired.json"}), "GRTUSDT").unwrap(),
            "symbols/GRTUSDT.repaired.json"
        );
        assert!(candle_relative(&json!({"path":"../bad.json"}), "GRTUSDT").is_err());
    }
    #[test]
    fn listing_and_symbol_validation_are_explicit() {
        let xml = "<ListBucketResult><Prefix>data/futures/um/daily/klines/</Prefix><IsTruncated>true</IsTruncated><NextMarker>next/</NextMarker><CommonPrefixes><Prefix>data/futures/um/daily/klines/BTCUSDT/</Prefix></CommonPrefixes></ListBucketResult>";
        let out = parse_listing(xml).unwrap();
        assert!(out.truncated);
        assert_eq!(out.next.as_deref(), Some("next/"));
        assert_eq!(universe(&out.prefixes, &[]).unwrap().len(), 1);
        assert!(universe(&out.prefixes, &["BTCUSDT".into(), "btcusdt".into()]).is_err());
        assert!(parse_listing("<Error/>").is_err());
    }
    #[test]
    fn keys_and_calendar_boundaries_match_published_layout() {
        let d = NaiveDate::from_ymd_opt(2026, 12, 1).unwrap();
        assert_eq!(next_month(d), NaiveDate::from_ymd_opt(2027, 1, 1).unwrap());
        assert_eq!(
            daily_key("klines", "BTCUSDT", Some("1h"), d),
            "data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-2026-12-01.zip"
        );
        assert_eq!(
            monthly_key("fundingRate", "BTCUSDT", None, d),
            "data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2026-12.zip"
        );
    }
}

fn append_csv(target: &mut Vec<Vec<String>>, mut rows: Vec<Vec<String>>) -> Result<()> {
    let Some(incoming) = rows.first() else {
        return Ok(());
    };
    if let Some(first) = target.first() {
        ensure!(
            first.len() == incoming.len(),
            "Archive chunks have inconsistent columns"
        );
        let header = |row: &[String]| {
            let key: String = row[0]
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .flat_map(char::to_lowercase)
                .collect();
            [
                "opentime",
                "createtime",
                "calctime",
                "fundingtime",
                "timestamp",
            ]
            .contains(&key.as_str())
        };
        if header(incoming) {
            ensure!(
                header(first) && first == incoming,
                "Archive chunks have inconsistent headers"
            );
            rows.remove(0);
        }
    }
    target.extend(rows);
    Ok(())
}

#[cfg(test)]
mod chunk_tests {
    use super::*;
    #[test]
    fn concatenated_archive_headers_preserve_every_observation() {
        let row = |items: &[&str]| {
            items
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        };
        let header = row(&["create_time", "symbol", "sum_open_interest"]);
        let first = row(&["2026-10-01 00:00:00", "BTCUSDT", "1"]);
        let second = row(&["2026-10-02 00:00:00", "BTCUSDT", "2"]);
        let mut all = Vec::new();
        append_csv(&mut all, vec![header.clone(), first.clone()]).unwrap();
        append_csv(&mut all, vec![header.clone(), second.clone()]).unwrap();
        assert_eq!(all, vec![header, first, second]);
        assert!(
            append_csv(
                &mut all,
                vec![row(&["create_time", "sum_open_interest", "symbol"])]
            )
            .is_err()
        );
        assert!(append_csv(&mut all, vec![row(&["create_time", "symbol"])]).is_err());
    }
}
