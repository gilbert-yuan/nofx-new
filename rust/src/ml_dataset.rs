//! Frozen public market data shared by monthly collection and model training.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 24 * HOUR_MS;

/// OS-managed lock: concurrent writers fail and crashed writers release it.
pub fn collector_lock(directory: &Path) -> Result<fs::File> {
    fs::create_dir_all(directory)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(".collector.lock"))?;
    file.try_lock()
        .context("Another collector or repair holds the dataset writer lock")?;
    Ok(file)
}

/// Enforce the response cap while streaming, even without Content-Length.
pub async fn bounded_response_bytes(
    mut response: reqwest::Response,
    maximum: usize,
) -> Result<Vec<u8>> {
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= maximum as u64),
        "Response exceeds byte limit {maximum}"
    );
    let mut output = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            chunk.len() <= maximum.saturating_sub(output.len()),
            "Response exceeds byte limit {maximum}"
        );
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Coverage {
    pub rows: usize,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub expected_rows: Option<usize>,
    pub missing_hours: usize,
    pub complete: bool,
}

pub fn digest(value: &impl Serialize) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(value)?)))
}

pub fn file_digest(path: &Path) -> Result<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path)?)))
}

pub fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(path)?)
        .with_context(|| format!("Read JSON {}", path.display()))
}

/// Immutable artifacts never silently replace a previous successful download.
pub fn write_new(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        drop(file);
        // Linking a complete temporary file atomically creates the destination and
        // fails if it already exists, including on Windows. A crash cannot leave
        // a partially written raw file that poisons the next resume.
        fs::hard_link(&temporary, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

/// Only manifests and resumable summaries use replacement; raw success files are immutable.
pub fn checkpoint(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    fs::OpenOptions::new()
        .write(true)
        .open(&temporary)?
        .sync_all()?;
    for attempt in 0..40 {
        match fs::rename(&temporary, path) {
            Ok(()) => return Ok(()),
            Err(error)
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(5 | 32 | 33))
                    && attempt < 39 =>
            {
                // Readers such as Get-Content may omit FILE_SHARE_DELETE.
                // Preserve the existing manifest while their handles close.
                std::thread::sleep(std::time::Duration::from_millis(
                    25 + (attempt as u64 * 10).min(75),
                ));
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("Atomically replace checkpoint {}", path.display()));
            }
        }
    }
    unreachable!()
}

pub fn candle_coverage(rows: &[Value], start: i64, end: i64) -> Result<Coverage> {
    ensure!(
        start < end && start % HOUR_MS == 0 && end % HOUR_MS == 0,
        "Invalid hourly bounds"
    );
    let mut previous = None;
    for row in rows {
        let time = row["openTime"]
            .as_i64()
            .context("Missing candle openTime")?;
        ensure!(
            time >= start && time < end && time % HOUR_MS == 0,
            "Out-of-range hourly candle"
        );
        ensure!(
            previous.is_none_or(|last| time > last),
            "Duplicate or unsorted candle"
        );
        ensure!(
            row["closeTime"].as_i64() == Some(time + HOUR_MS - 1) && row["confirmed"] == true,
            "Unclosed candle"
        );
        let number = |key: &str| -> Result<f64> {
            let value = row[key]
                .as_f64()
                .with_context(|| format!("Missing numeric {key}"))?;
            ensure!(value.is_finite(), "Invalid {key}");
            Ok(value)
        };
        let open = number("open")?;
        let high = number("high")?;
        let low = number("low")?;
        let close = number("close")?;
        ensure!(
            low > 0.0 && high >= low && high >= open.max(close) && low <= open.min(close),
            "Invalid candle OHLC"
        );
        let volume = number("volume")?;
        let quote_volume = number("quoteVolume")?;
        let taker = number("takerBuyVolume")?;
        let taker_quote = number("takerBuyQuoteVolume")?;
        ensure!(
            volume >= 0.0
                && quote_volume >= 0.0
                && taker >= 0.0
                && taker <= volume * (1.0 + 1e-8)
                && taker_quote >= 0.0
                && taker_quote <= quote_volume * (1.0 + 1e-8),
            "Invalid volume/taker flow"
        );
        ensure!(row["tradeCount"].as_u64().is_some(), "Invalid tradeCount");
        previous = Some(time);
    }
    let expected = ((end - start) / HOUR_MS) as usize;
    ensure!(rows.len() <= expected, "Too many hourly candles");
    Ok(Coverage {
        rows: rows.len(),
        first_ms: rows.first().and_then(|row| row["openTime"].as_i64()),
        last_ms: previous,
        expected_rows: Some(expected),
        missing_hours: expected - rows.len(),
        complete: rows.len() == expected,
    })
}

/// Join on declared availability rather than copying collection-time snapshots backward.
pub fn as_of<'a>(rows: &'a [Value], origin_ms: i64) -> Option<&'a Value> {
    rows.iter().rev().find(|row| {
        row["available_at_ms"]
            .as_i64()
            .is_some_and(|at| at <= origin_ms)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn candle(time: i64) -> Value {
        json!({"openTime":time,"closeTime":time+HOUR_MS-1,"confirmed":true,
            "open":1.0,"high":2.0,"low":0.5,"close":1.1,"volume":10.0,
            "quoteVolume":11.0,"tradeCount":2,"takerBuyVolume":4.0,"takerBuyQuoteVolume":4.4})
    }

    #[test]
    fn coverage_detects_gaps_and_rejects_duplicates_unclosed_and_bad_flows() {
        let rows = vec![candle(HOUR_MS), candle(2 * HOUR_MS), candle(3 * HOUR_MS)];
        assert!(
            candle_coverage(&rows, HOUR_MS, 4 * HOUR_MS)
                .unwrap()
                .complete
        );
        let missing = vec![rows[0].clone(), rows[2].clone()];
        assert_eq!(
            candle_coverage(&missing, HOUR_MS, 4 * HOUR_MS)
                .unwrap()
                .missing_hours,
            1
        );
        assert!(
            candle_coverage(&[rows[0].clone(), rows[0].clone()], HOUR_MS, 4 * HOUR_MS).is_err()
        );
        let mut bad = rows.clone();
        bad[1]["confirmed"] = json!(false);
        assert!(candle_coverage(&bad, HOUR_MS, 4 * HOUR_MS).is_err());
        bad = rows;
        bad[1]["takerBuyVolume"] = json!(11.0);
        assert!(candle_coverage(&bad, HOUR_MS, 4 * HOUR_MS).is_err());
    }

    #[test]
    fn availability_join_excludes_future_and_snapshots_without_availability() {
        let rows = vec![
            json!({"timestamp":1,"available_at_ms":10}),
            json!({"timestamp":2,"available_at_ms":20}),
            json!({"timestamp":3}),
        ];
        assert!(as_of(&rows, 9).is_none());
        assert_eq!(as_of(&rows, 10).unwrap()["timestamp"], 1);
        assert_eq!(as_of(&rows, 19).unwrap()["timestamp"], 1);
        assert_eq!(as_of(&rows, 20).unwrap()["timestamp"], 2);
    }

    #[test]
    fn raw_artifacts_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frozen.json");
        write_new(&path, &json!({"v":1})).unwrap();
        assert!(write_new(&path, &json!({"v":2})).is_err());
        assert_eq!(read_json(&path).unwrap()["v"], 1);
    }

    #[test]
    fn writer_lock_releases_without_stale_pid_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let first = collector_lock(dir.path()).unwrap();
        assert!(collector_lock(dir.path()).is_err());
        drop(first);
        assert!(collector_lock(dir.path()).is_ok());
    }

    #[test]
    fn checkpoint_atomically_replaces_an_existing_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        checkpoint(&path, &json!({"revision":1})).unwrap();
        checkpoint(&path, &json!({"revision":2})).unwrap();
        assert_eq!(read_json(&path).unwrap()["revision"], 2);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn derived_market_metrics_keep_their_digest_after_json_roundtrip() {
        for value in 1..=2000 {
            let ratio = f64::from(value) / 137.0;
            let original = json!({"longShortRatio":ratio,"longAccount":ratio/(1.0+ratio),"shortAccount":1.0/(1.0+ratio)});
            let restored: Value =
                serde_json::from_slice(&serde_json::to_vec(&original).unwrap()).unwrap();
            assert_eq!(
                digest(&original).unwrap(),
                digest(&restored).unwrap(),
                "Derived ratio {value} changed during persisted JSON decoding"
            );
        }
    }

    #[tokio::test]
    async fn streamed_byte_limit_rejects_chunked_bodies_without_content_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\n12345\r\n5\r\n67890\r\n0\r\n\r\n").await.unwrap();
        });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}/"))
            .send()
            .await
            .unwrap();
        assert!(response.content_length().is_none());
        assert!(bounded_response_bytes(response, 8).await.is_err());
        server.await.unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn checkpoint_waits_for_readers_without_deleting_the_manifest() {
        use std::{os::windows::fs::OpenOptionsExt, sync::mpsc, thread, time::Duration};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("manifest.json");
        checkpoint(&path, &json!({"revision":1})).unwrap();
        let (ready_send, ready_receive) = mpsc::channel();
        let held_path = path.clone();
        let reader = thread::spawn(move || {
            let handle = fs::OpenOptions::new()
                .read(true)
                .share_mode(3)
                .open(&held_path)
                .unwrap();
            ready_send.send(()).unwrap();
            thread::sleep(Duration::from_millis(150));
            assert!(
                held_path.exists(),
                "Original manifest disappeared while its reader held it"
            );
            drop(handle);
        });
        ready_receive.recv().unwrap();
        checkpoint(&path, &json!({"revision":2})).unwrap();
        reader.join().unwrap();
        assert_eq!(read_json(&path).unwrap()["revision"], 2);
    }
}
