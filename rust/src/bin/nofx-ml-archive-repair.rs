//! Stage repairs from complete, checksum-verified public 15m/1m observations.
//! Original frozen files are preserved. Apply only after collector exit.
use anyhow::{Context, Result, ensure};
use chrono::{NaiveDate, TimeZone, Utc};
use clap::Parser;
use nofx_core::{
    ml_archive,
    ml_dataset::{self, DAY_MS, HOUR_MS},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Parser)]
#[command(
    about = "Stage observed-bar archive repairs; apply proposals only after collection exits"
)]
struct Args {
    #[arg(long, default_value = "data/ml/monthly-archive-20261014")]
    data_dir: PathBuf,
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long)]
    prepare_only: bool,
    #[arg(long, conflicts_with = "prepare_only")]
    apply: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let manifest_path = args.data_dir.join("manifest.json");
    let mut manifest = ml_dataset::read_json(&manifest_path)?;
    ensure!(
        manifest["provider"] == "Binance Public Data archives",
        "Only public archive datasets can be repaired"
    );
    let proposal_path = args.data_dir.join("repairs/proposals.json");
    fs::create_dir_all(args.data_dir.join("repairs"))?;
    if args.apply {
        ensure!(
            manifest["history_complete"] == true
                && ["complete", "complete_with_errors"]
                    .contains(&manifest["status"].as_str().unwrap_or("")),
            "Wait for collector completion and process exit before applying proposals"
        );
        let writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(args.data_dir.join(".collector.lock"))?;
        writer
            .try_lock()
            .context("Another collector/repair writer holds the dataset lock")?;
        // Read the state protected by the acquired lock, rather than retaining
        // a manifest another writer may have advanced before this acquisition.
        manifest = ml_dataset::read_json(&manifest_path)?;
        ensure!(
            manifest["history_complete"] == true
                && ["complete", "complete_with_errors"]
                    .contains(&manifest["status"].as_str().unwrap_or("")),
            "Collection changed before the repair writer lock was acquired"
        );
        let proposals = ml_dataset::read_json(&proposal_path)?;
        let mut applied = 0;
        for proposal in proposals["repairs"]
            .as_array()
            .context("Missing repair proposals")?
        {
            if proposal["status"] != "prepared" {
                continue;
            }
            let symbol = proposal["symbol"].as_str().context("Missing symbol")?;
            nofx_core::exchange::valid_symbol(symbol)?;
            let target = manifest["symbols"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|entry| entry["symbol"] == symbol)
                .context("Unknown repair symbol")?;
            if target["path"] == proposal["new_entry"]["path"] {
                continue;
            }
            ensure!(
                target["path"] == proposal["original_path"]
                    && target["sha256"] == proposal["original_sha256"],
                "Original manifest entry changed before repair apply"
            );
            let relative = proposal["new_entry"]["path"]
                .as_str()
                .context("Missing repair path")?;
            ensure!(
                relative == format!("symbols/{symbol}.repaired.json"),
                "Unsafe repaired path"
            );
            ensure!(
                ml_dataset::file_digest(&args.data_dir.join(relative))?
                    == proposal["new_entry"]["sha256"],
                "Staged repair checksum mismatch"
            );
            for (key, value) in proposal["new_entry"].as_object().unwrap() {
                target[key] = value.clone();
            }
            target["history_status"] = json!("pending_repaired");
            applied += 1;
        }
        if applied > 0 {
            let entries = manifest["symbols"].as_array().unwrap();
            let successful = entries
                .iter()
                .filter(|entry| entry["status"] == "complete")
                .count();
            let eligible = entries
                .iter()
                .filter(|entry| entry["training_eligible"] == true)
                .count();
            let total = entries.len();
            manifest["successful_symbols"] = json!(successful);
            manifest["failed_symbols"] = json!(total - successful);
            manifest["eligible_symbols"] = json!(eligible);
            manifest["train_ready"] = json!(eligible > 0);
            manifest["history_complete"] = json!(false);
            manifest["history_all_available"] = json!(false);
            manifest["status"] = json!("candles_complete_with_errors");
            manifest["repairs_applied"] = json!(applied);
            manifest["updated_at_ms"] = json!(nofx_core::now_ms());
            ml_dataset::checkpoint(&manifest_path, &manifest)?;
        }
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"status":"applied","repairs_applied":applied,"history_refresh_required":applied>0,"manifest":manifest_path})
            )?
        );
        return Ok(());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(40))
        .connect_timeout(Duration::from_secs(10))
        .build()?;
    let selected: BTreeSet<_> = args
        .symbols
        .iter()
        .map(|name| name.trim().to_ascii_uppercase())
        .collect();
    let entries: Vec<_> = manifest["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| {
            entry["status"] == "partial"
                && (selected.is_empty()
                    || selected.contains(entry["symbol"].as_str().unwrap_or("")))
        })
        .cloned()
        .collect();
    if entries.is_empty() && proposal_path.exists() {
        let mut report = ml_dataset::read_json(&proposal_path)?;
        report["preparation_reused"] = json!(true);
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    let mut repairs = Vec::new();
    for entry in entries {
        let symbol = entry["symbol"].as_str().unwrap();
        let result = prepare(&client, &args.data_dir, &entry).await;
        repairs.push(match result {
            Ok(proposal) => proposal,
            Err(error) => json!({"symbol":symbol,"status":"refused","error":format!("{error:#}")}),
        });
    }
    let report = json!({"schema_version":1,"prepared_at_ms":nofx_core::now_ms(),"source_manifest_sha256_at_prepare":ml_dataset::file_digest(&manifest_path)?,
        "collector_manifest_modified":false,"original_files_preserved":true,"repairs":repairs});
    ml_dataset::checkpoint(&proposal_path, &report)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

async fn prepare(client: &reqwest::Client, root: &Path, entry: &Value) -> Result<Value> {
    let symbol = entry["symbol"].as_str().context("Missing symbol")?;
    nofx_core::exchange::valid_symbol(symbol)?;
    let original_path = entry["path"].as_str().context("Missing original path")?;
    ensure!(
        original_path == format!("symbols/{symbol}.json"),
        "Repair requires the original frozen symbol file"
    );
    let path = root.join(original_path);
    let original_sha = ml_dataset::file_digest(&path)?;
    ensure!(entry["sha256"] == original_sha, "Original source changed");
    let mut doc = ml_dataset::read_json(&path)?;
    let start = doc["metadata"]["start_ms"]
        .as_i64()
        .context("Missing start")?;
    let end = doc["metadata"]["end_exclusive_ms"]
        .as_i64()
        .context("Missing end")?;
    let rows = doc["datasets"]["1h"]
        .as_array()
        .context("Missing hourly rows")?;
    ml_dataset::candle_coverage(rows, start, end)?;
    let mut merged: BTreeMap<i64, Value> = rows
        .iter()
        .map(|row| (row["openTime"].as_i64().unwrap(), row.clone()))
        .collect();
    let mut missing_days = BTreeSet::<NaiveDate>::new();
    let mut cursor = start;
    while cursor < end {
        if !merged.contains_key(&cursor) {
            missing_days.insert(
                Utc.timestamp_millis_opt(cursor)
                    .single()
                    .context("Invalid gap timestamp")?
                    .date_naive(),
            );
        }
        cursor += HOUR_MS;
    }
    ensure!(
        !missing_days.is_empty() && missing_days.len() <= 5,
        "No small bounded archive gap to repair"
    );
    let before = merged.len();
    let mut sources = Vec::new();
    for day in missing_days {
        let first = day
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let mut recovered = None;
        for (interval, duration) in [("15m", 900_000), ("1m", 60_000)] {
            if let Some((bytes, source)) = download(client, root, symbol, day, interval).await? {
                let records = ml_archive::read_csv(&bytes)?;
                let observations =
                    ml_archive::interval_klines(&records, first, first + DAY_MS, duration)?;
                let hours =
                    ml_archive::aggregate_hourly(&observations, first, first + DAY_MS, duration)?;
                recovered = Some((hours, source));
                break;
            }
        }
        let (hours, source) = recovered.with_context(|| {
            format!("No complete official15m/1m archive for {symbol}/{day}; refused to invent bars")
        })?;
        for row in hours {
            let time = row["openTime"].as_i64().unwrap();
            if time >= start && time < end {
                merged.entry(time).or_insert(row);
            }
        }
        sources.push(source);
    }
    let rows: Vec<_> = merged.into_values().collect();
    let coverage = ml_dataset::candle_coverage(&rows, start, end)?;
    ensure!(
        coverage.complete,
        "Observed-bar recovery still has missing hours"
    );
    let training_start = doc["metadata"]["training_start_ms"]
        .as_i64()
        .context("Missing training start")?;
    let eligible = rows.len() >= 256 + 12 + 24
        && end > training_start.max(start + 256 * HOUR_MS) + 12 * HOUR_MS;
    let relative = format!("symbols/{symbol}.repaired.json");
    let new_path = root.join(&relative);
    doc["datasets"]["1h"] = json!(rows);
    doc["metadata"]["content_sha256"] = json!(ml_dataset::digest(&doc["datasets"])?);
    doc["metadata"]["coverage"] = json!(coverage);
    doc["metadata"]["repair"] = json!({"original_path":original_path,"original_sha256":original_sha,
        "repaired_at_ms":nofx_core::now_ms(),"recovered_hours":rows.len()-before,"sources":sources,"method":"Exact4x15m or60x1m closed consecutive observed bars; original hourly observations preserved"});
    if new_path.exists() {
        let saved = ml_dataset::read_json(&new_path)?;
        ensure!(
            saved["datasets"] == doc["datasets"],
            "Different staged repair already exists"
        );
    } else {
        ml_dataset::write_new(&new_path, &doc)?;
    }
    Ok(
        json!({"symbol":symbol,"status":"prepared","original_path":original_path,"original_sha256":original_sha,"recovered_hours":rows.len()-before,
            "new_entry":{"path":relative,"sha256":ml_dataset::file_digest(&new_path)?,"rows":rows.len(),"status":"complete","training_eligible":eligible,
            "missing_hours":0,"coverage":coverage,"repair_original_path":original_path,"repair_original_sha256":original_sha,"error":Value::Null},"sources":sources}),
    )
}

async fn download(
    client: &reqwest::Client,
    root: &Path,
    symbol: &str,
    day: NaiveDate,
    interval: &str,
) -> Result<Option<(Vec<u8>, Value)>> {
    let name = format!("{symbol}-{interval}-{day}.zip");
    let url = format!(
        "https://data.binance.vision/data/futures/um/daily/klines/{symbol}/{interval}/{name}"
    );
    let response = client.get(format!("{url}.CHECKSUM")).send().await?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    ensure!(
        response.status().is_success(),
        "Repair checksum HTTP {}",
        response.status()
    );
    let check = String::from_utf8(ml_dataset::bounded_response_bytes(response, 4096).await?)?;
    ensure!(check.len() <= 4096, "Repair checksum too large");
    let parts: Vec<_> = check.split_whitespace().collect();
    let expected = parts.first().context("Missing repair checksum")?;
    ensure!(
        expected.len() == 64
            && parts
                .get(1)
                .is_some_and(|value| value.trim_start_matches('*') == name),
        "Invalid repair checksum file"
    );
    let response = client.get(&url).send().await?;
    ensure!(
        response.status().is_success(),
        "Repair ZIP HTTP {}",
        response.status()
    );
    ensure!(
        response
            .content_length()
            .is_none_or(|n| n <= ml_archive::MAX_ZIP_BYTES as u64),
        "Repair ZIP too large"
    );
    let bytes = ml_dataset::bounded_response_bytes(response, ml_archive::MAX_ZIP_BYTES).await?;
    ensure!(
        bytes.len() <= ml_archive::MAX_ZIP_BYTES,
        "Repair ZIP too large"
    );
    let sha = hex::encode(Sha256::digest(&bytes));
    ensure!(
        sha.eq_ignore_ascii_case(expected),
        "Repair ZIP checksum mismatch"
    );
    let relative = format!("raw/repairs/{symbol}/{name}");
    let path = root.join(&relative);
    if path.exists() {
        ensure!(
            ml_dataset::file_digest(&path)? == sha,
            "Frozen repair ZIP differs from publisher"
        );
    } else {
        write_bytes(&path, &bytes)?;
    }
    let checksum_path = root.join(format!("{relative}.CHECKSUM"));
    if !checksum_path.exists() {
        write_bytes(&checksum_path, check.as_bytes())?;
    }
    Ok(Some((
        bytes,
        json!({"url":url,"zip_path":relative,"sha256":sha,"interval":interval,"utc_day":day.to_string()}),
    )))
}
fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().context("Missing repair raw directory")?)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(&temporary, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}
