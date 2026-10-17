//! Bounded, in-memory readers for Binance public historical archives.
//!
//! Archive timestamps describe observations, not the collector's download time.
//! Metrics/reference prices use a conservative one-hour availability delay.

use crate::ml_dataset::HOUR_MS;
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDateTime};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
};

pub const MAX_ZIP_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_CSV_BYTES: usize = 16 * 1024 * 1024;
const MAX_ZIP_MEMBERS: usize = 8;

/// Read exactly one CSV member without extracting any archive path.
/// Reading to EOF lets `zip` verify its CRC, and both declared and actual sizes
/// are checked so a misleading central directory cannot bypass the limit.
pub fn read_csv(bytes: &[u8]) -> Result<Vec<Vec<String>>> {
    ensure!(bytes.len() <= MAX_ZIP_BYTES, "Archive exceeds 32 MiB");
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).context("Invalid ZIP archive")?;
    ensure!(
        archive.len() > 0 && archive.len() <= MAX_ZIP_MEMBERS,
        "Invalid archive member count"
    );
    let mut csv_index = None;
    let mut declared_csv_size = 0_u64;
    for index in 0..archive.len() {
        let member = archive.by_index(index).context("Invalid ZIP member")?;
        ensure!(
            member.enclosed_name().is_some() && !member.name().contains('\\'),
            "Unsafe archive member path"
        );
        if member.is_dir() {
            continue;
        }
        if member.name().to_ascii_lowercase().ends_with(".csv") {
            ensure!(
                csv_index.is_none(),
                "Archive must contain exactly one CSV member"
            );
            declared_csv_size = declared_csv_size
                .checked_add(member.size())
                .context("Archive size overflow")?;
            ensure!(
                declared_csv_size <= MAX_CSV_BYTES as u64,
                "CSV exceeds 16 MiB"
            );
            csv_index = Some(index);
        }
    }
    let index = csv_index.context("Archive must contain exactly one CSV member")?;
    let member = archive.by_index(index)?;
    let expected_size = member.size();
    let mut decoded = Vec::with_capacity(expected_size as usize);
    member
        .take(MAX_CSV_BYTES as u64 + 1)
        .read_to_end(&mut decoded)
        .context("Read CSV and verify ZIP CRC")?;
    ensure!(decoded.len() <= MAX_CSV_BYTES, "CSV exceeds 16 MiB");
    ensure!(
        decoded.len() as u64 == expected_size,
        "ZIP member size mismatch"
    );
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(decoded.as_slice());
    let mut records = Vec::new();
    for record in reader.records() {
        let record = record.context("Invalid UTF-8 CSV record")?;
        if record.iter().all(str::is_empty) {
            continue;
        }
        records.push(record.iter().map(str::to_owned).collect());
    }
    Ok(records)
}

const KLINE_HEADERS: [&[&str]; 12] = [
    &["opentime"],
    &["open"],
    &["high"],
    &["low"],
    &["close"],
    &["volume"],
    &["closetime"],
    &["quotevolume", "quoteassetvolume"],
    &["count", "numberoftrades", "tradecount"],
    &["takerbuyvolume", "takerbuybaseassetvolume"],
    &["takerbuyquotevolume", "takerbuyquoteassetvolume"],
    &["ignore"],
];
const METRIC_HEADERS: [&[&str]; 8] = [
    &["createtime"],
    &["symbol"],
    &["sumopeninterest"],
    &["sumopeninterestvalue"],
    &["counttoptraderlongshortratio"],
    &["sumtoptraderlongshortratio"],
    &["countlongshortratio"],
    &["sumtakerlongshortvolratio"],
];

fn header_key(value: &str) -> String {
    value
        .trim_start_matches('\u{feff}')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn header_matches(record: &[String], names: &[&[&str]]) -> bool {
    record.len() == names.len()
        && record.iter().zip(names).all(|(value, aliases)| {
            let key = header_key(value);
            aliases.contains(&key.as_str())
        })
}

fn bounds(start: i64, end: i64) -> Result<()> {
    ensure!(start >= 0 && start < end, "Invalid archive time bounds");
    Ok(())
}

fn integer(value: &str, field: &str) -> Result<i64> {
    value
        .trim_start_matches('\u{feff}')
        .parse::<i64>()
        .with_context(|| format!("Invalid {field}: {value}"))
}

fn finite(value: &str, field: &str) -> Result<f64> {
    let number = value
        .parse::<f64>()
        .with_context(|| format!("Invalid {field}: {value}"))?;
    ensure!(number.is_finite(), "Nonfinite {field}");
    Ok(number)
}

fn optional_nonnegative(value: &str, field: &str) -> Result<Option<f64>> {
    if value.is_empty() {
        return Ok(None);
    }
    let number = finite(value, field)?;
    ensure!(number >= 0.0, "Negative {field}");
    Ok(Some(number))
}

// Binance spot archives changed to microseconds in January 2025. Close times
// end at xxx999 microseconds; flooring preserves the millisecond close boundary.
fn epoch_ms(value: &str, field: &str) -> Result<i64> {
    let time = integer(value, field)?;
    ensure!(time >= 0, "Negative {field}");
    Ok(if time >= 100_000_000_000_000 {
        let expected_remainder = if field == "close_time" { 999 } else { 0 };
        ensure!(
            time % 1_000 == expected_remainder,
            "Invalid microsecond {field} boundary"
        );
        time / 1_000
    } else {
        time
    })
}

fn parse_klines(
    records: &[Vec<String>],
    start: i64,
    end: i64,
    reference: bool,
    interval_ms: i64,
) -> Result<Vec<Value>> {
    bounds(start, end)?;
    let Some(first) = records.first() else {
        return Ok(vec![]);
    };
    let width = first.len();
    ensure!(
        if reference {
            (7..=12).contains(&width)
        } else {
            width == 12
        },
        "Unexpected kline CSV width"
    );
    let has_header = integer(&first[0], "open_time").is_err();
    if has_header {
        let recognized = first.iter().enumerate().all(|(index, value)| {
            let key = header_key(value);
            KLINE_HEADERS[index].contains(&key.as_str())
                || (reference
                    && index == 5
                    && ["ignore", "ignorevol", "ignorevolume"].contains(&key.as_str()))
        });
        ensure!(recognized, "Unknown kline CSV header");
    }
    let mut output = Vec::new();
    let mut previous = None;
    for record in &records[usize::from(has_header)..] {
        ensure!(record.len() == width, "Inconsistent kline CSV width");
        let open_time = epoch_ms(&record[0], "open_time")?;
        let close_time = epoch_ms(&record[6], "close_time")?;
        let close_boundary = open_time
            .checked_add(interval_ms)
            .context("Kline timestamp overflow")?;
        ensure!(
            open_time % interval_ms == 0 && close_time == close_boundary - 1,
            "Not a closed kline at the requested interval"
        );
        let open = finite(&record[1], "open")?;
        let high = finite(&record[2], "high")?;
        let low = finite(&record[3], "low")?;
        let close = finite(&record[4], "close")?;
        let volume = finite(&record[5], "volume")?;
        ensure!(
            high >= low && high >= open.max(close) && low <= open.min(close),
            "Invalid kline OHLC"
        );
        ensure!(reference || low > 0.0, "Nonpositive tradable candle");
        ensure!(volume >= 0.0, "Negative kline volume");
        // Reference archives can omit trailing volume/trade fields. Validate
        // every trailing field present without inventing absent observations.
        for (index, value) in record.iter().enumerate().skip(7) {
            if index == 8 {
                value.parse::<u64>().context("Invalid trade_count")?;
            } else {
                finite(value, "kline trailing field")?;
            }
        }
        if open_time < start || open_time >= end || close_boundary > end {
            continue;
        }
        ensure!(
            previous.is_none_or(|time| open_time > time),
            "Duplicate or unsorted archive kline"
        );
        previous = Some(open_time);
        let mut row = json!({"openTime":open_time,"closeTime":close_time,"open":open,"high":high,"low":low,"close":close,"confirmed":true});
        if reference {
            row["available_at_ms"] = json!(close_boundary);
        } else {
            let quote = finite(&record[7], "quote_volume")?;
            let taker = finite(&record[9], "taker_buy_volume")?;
            let taker_quote = finite(&record[10], "taker_buy_quote_volume")?;
            ensure!(
                quote >= 0.0
                    && taker >= 0.0
                    && taker <= volume * (1.0 + 1e-8)
                    && taker_quote >= 0.0
                    && taker_quote <= quote * (1.0 + 1e-8),
                "Invalid kline taker flow"
            );
            row["volume"] = json!(volume);
            row["quoteVolume"] = json!(quote);
            row["tradeCount"] = json!(record[8].parse::<u64>()?);
            row["takerBuyVolume"] = json!(taker);
            row["takerBuyQuoteVolume"] = json!(taker_quote);
        }
        output.push(row);
    }
    Ok(output)
}

/// Normalize 12-column spot/USD-M candles for the shared hourly ML dataset.
pub fn klines(records: &[Vec<String>], start: i64, end: i64) -> Result<Vec<Value>> {
    parse_klines(records, start, end, false, HOUR_MS)
}

/// Parse original native candles without interpolating or aggregating them.
pub fn native_klines(
    records: &[Vec<String>],
    start: i64,
    end: i64,
    interval_ms: i64,
) -> Result<Vec<Value>> {
    ensure!(
        interval_ms == HOUR_MS || interval_ms == 900_000,
        "Native candle interval must be 1h or 15m"
    );
    let mut rows = parse_klines(records, start, end, false, interval_ms)?;
    if interval_ms == 900_000 {
        for row in &mut rows {
            row["available_at_ms"] =
                json!(row["closeTime"].as_i64().context("Missing close time")? + 1);
        }
    }
    Ok(rows)
}

/// Mark/index/premium candles share the leading Binance kline fields.
/// Premium prices may be negative and are never treated as tradable prices.
pub fn reference_klines(records: &[Vec<String>], start: i64, end: i64) -> Result<Vec<Value>> {
    parse_klines(records, start, end, true, HOUR_MS)
}

fn repair_interval(interval_ms: i64) -> Result<()> {
    ensure!(
        interval_ms == 900_000 || interval_ms == 60_000,
        "Repair source interval must be 15m or 1m"
    );
    Ok(())
}

/// Read native closed 15-minute/minute bars using the same 12-column source
/// schema as hourly candles. Completeness is verified before aggregation.
pub fn interval_klines(
    records: &[Vec<String>],
    start: i64,
    end: i64,
    interval_ms: i64,
) -> Result<Vec<Value>> {
    repair_interval(interval_ms)?;
    bounds(start, end)?;
    ensure!(
        start % interval_ms == 0 && end % interval_ms == 0,
        "Invalid repair interval bounds"
    );
    parse_klines(records, start, end, false, interval_ms)
}

fn row_number(row: &Value, key: &str) -> Result<f64> {
    let number = row[key]
        .as_f64()
        .with_context(|| format!("Missing numeric repair field {key}"))?;
    ensure!(number.is_finite(), "Nonfinite repair field {key}");
    Ok(number)
}

/// Aggregate complete native source bars into the shared hourly schema.
/// Every expected bar must exist and be closed; gaps are never filled.
pub fn aggregate_hourly(
    rows: &[Value],
    start: i64,
    end: i64,
    interval_ms: i64,
) -> Result<Vec<Value>> {
    repair_interval(interval_ms)?;
    bounds(start, end)?;
    ensure!(
        start % HOUR_MS == 0 && end % HOUR_MS == 0,
        "Aggregation requires integer hourly bounds"
    );
    let expected =
        usize::try_from((end - start) / interval_ms).context("Repair source row count overflow")?;
    ensure!(rows.len() == expected, "Incomplete repair source bars");
    let group_size = usize::try_from(HOUR_MS / interval_ms)?;
    let mut expected_time = start;
    let mut output = Vec::with_capacity(rows.len() / group_size);
    for group in rows.chunks_exact(group_size) {
        let hour_start = expected_time;
        let open = row_number(&group[0], "open")?;
        let mut close = open;
        let mut high = f64::NEG_INFINITY;
        let mut low = f64::INFINITY;
        let mut sums = [0.0_f64; 4];
        let mut trades = 0_u64;
        for row in group {
            let close_boundary = expected_time
                .checked_add(interval_ms)
                .context("Repair source timestamp overflow")?;
            ensure!(
                row["openTime"].as_i64() == Some(expected_time)
                    && row["closeTime"].as_i64() == Some(close_boundary - 1)
                    && row["confirmed"] == true,
                "Missing, duplicate, unsorted, future, or unclosed repair source bar"
            );
            let source_open = row_number(row, "open")?;
            let source_high = row_number(row, "high")?;
            let source_low = row_number(row, "low")?;
            close = row_number(row, "close")?;
            ensure!(
                source_low > 0.0
                    && source_high >= source_low
                    && source_high >= source_open.max(close)
                    && source_low <= source_open.min(close),
                "Invalid repair source OHLC"
            );
            high = high.max(source_high);
            low = low.min(source_low);
            let volume = row_number(row, "volume")?;
            let quote = row_number(row, "quoteVolume")?;
            let taker = row_number(row, "takerBuyVolume")?;
            let taker_quote = row_number(row, "takerBuyQuoteVolume")?;
            ensure!(
                volume >= 0.0
                    && quote >= 0.0
                    && taker >= 0.0
                    && taker <= volume * (1.0 + 1e-8)
                    && taker_quote >= 0.0
                    && taker_quote <= quote * (1.0 + 1e-8),
                "Invalid repair source volume/taker flow"
            );
            for (sum, value) in sums.iter_mut().zip([volume, quote, taker, taker_quote]) {
                *sum += value;
                ensure!(sum.is_finite(), "Repair aggregate numeric overflow");
            }
            trades = trades
                .checked_add(
                    row["tradeCount"]
                        .as_u64()
                        .context("Invalid repair source tradeCount")?,
                )
                .context("Repair aggregate tradeCount overflow")?;
            expected_time = close_boundary;
        }
        output.push(json!({
            "openTime":hour_start,"closeTime":expected_time - 1,
            "open":open,"high":high,"low":low,"close":close,
            "volume":sums[0],"quoteVolume":sums[1],"tradeCount":trades,
            "takerBuyVolume":sums[2],"takerBuyQuoteVolume":sums[3],"confirmed":true
        }));
    }
    ensure!(expected_time == end, "Incomplete aggregate hour");
    let coverage = crate::ml_dataset::candle_coverage(&output, start, end)?;
    ensure!(coverage.complete, "Incomplete repaired hourly coverage");
    Ok(output)
}

fn metric_time(value: &str) -> Result<i64> {
    let time = if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        time.timestamp_millis()
    } else {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
            .context("Invalid metrics UTC create_time")?
            .and_utc()
            .timestamp_millis()
    };
    ensure!(time >= 0, "Negative metrics create_time");
    Ok(time)
}

/// Select hourly observations from the daily five-minute derivatives metrics.
/// A missing source field omits the affected signal; no volume is fabricated
/// from a ratio. Original numeric source fields remain identifiable by name.
pub fn metrics(
    records: &[Vec<String>],
    start: i64,
    end: i64,
) -> Result<BTreeMap<String, Vec<Value>>> {
    bounds(start, end)?;
    let mut output: BTreeMap<String, Vec<Value>> = [
        "open_interest",
        "global_long_short",
        "top_account_long_short",
        "top_position_long_short",
        "taker_long_short",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), vec![]))
    .collect();
    let Some(header) = records.first() else {
        return Ok(output);
    };
    ensure!(
        header_matches(header, &METRIC_HEADERS),
        "Unknown metrics CSV header"
    );
    let mut observations = BTreeMap::<i64, (String, Vec<Option<f64>>)>::new();
    for record in &records[1..] {
        ensure!(
            record.len() == METRIC_HEADERS.len(),
            "Inconsistent metrics CSV width"
        );
        let time = metric_time(&record[0])?;
        ensure!(!record[1].is_empty(), "Missing metrics symbol");
        let numeric: Vec<Option<f64>> = record[2..]
            .iter()
            .enumerate()
            .map(|(index, value)| optional_nonnegative(value, METRIC_HEADERS[index + 2][0]))
            .collect::<Result<_>>()?;
        let available = time
            .checked_add(HOUR_MS)
            .context("Metrics timestamp overflow")?;
        if time % HOUR_MS != 0 || time < start || time >= end || available > end {
            continue;
        }
        if let Some((symbol, values)) = observations.get(&time) {
            ensure!(
                symbol == &record[1] && values == &numeric,
                "Conflicting hourly metrics observations at {time}"
            );
        } else {
            observations.insert(time, (record[1].clone(), numeric));
        }
    }
    // Public daily metrics can overlap at midnight or arrive unsorted. Only
    // identical observations may collapse; conflicting source values fail.
    for (time, (_, numeric)) in observations {
        let available = time + HOUR_MS;
        if let (Some(quantity), Some(value)) = (numeric[0], numeric[1]) {
            output.get_mut("open_interest").unwrap().push(json!({"timestamp":time,"available_at_ms":available,"sumOpenInterest":quantity,"sumOpenInterestValue":value}));
        }
        for (dataset, index, source) in [
            (
                "top_account_long_short",
                2,
                "count_toptrader_long_short_ratio",
            ),
            (
                "top_position_long_short",
                3,
                "sum_toptrader_long_short_ratio",
            ),
            ("global_long_short", 4, "count_long_short_ratio"),
        ] {
            if let Some(ratio) = numeric[index] {
                let short = 1.0 / (1.0 + ratio);
                output.get_mut(dataset).unwrap().push(json!({"timestamp":time,"available_at_ms":available,"longShortRatio":ratio,"longAccount":ratio * short,"shortAccount":short,"source_fields":BTreeMap::from([(source, ratio)])}));
            }
        }
        if let Some(ratio) = numeric[5] {
            output.get_mut("taker_long_short").unwrap().push(json!({"timestamp":time,"available_at_ms":available,"buySellRatio":ratio,"source_fields":{"sum_taker_long_short_vol_ratio":ratio}}));
        }
    }
    Ok(output)
}

/// Settled funding is available at its declared settlement time. Archive
/// funding intervals are preserved, and mark price is present only if sourced.
pub fn funding(records: &[Vec<String>], start: i64, end: i64) -> Result<Vec<Value>> {
    bounds(start, end)?;
    let Some(header) = records.first() else {
        return Ok(vec![]);
    };
    const HEADERS: [&[&str]; 4] = [
        &["calctime", "fundingtime"],
        &["fundingintervalhours"],
        &["lastfundingrate", "fundingrate"],
        &["markprice"],
    ];
    ensure!(
        (3..=4).contains(&header.len()) && header_matches(header, &HEADERS[..header.len()]),
        "Unknown funding CSV header"
    );
    let mut output = Vec::new();
    let mut previous = None;
    for record in &records[1..] {
        ensure!(
            record.len() == header.len(),
            "Inconsistent funding CSV width"
        );
        let time = integer(&record[0], "calc_time")?;
        ensure!(time >= 0, "Negative funding timestamp");
        let interval = finite(&record[1], "funding_interval_hours")?;
        ensure!(interval > 0.0, "Invalid funding interval");
        let rate = finite(&record[2], "last_funding_rate")?;
        let mark = if record.len() == 4 && !record[3].is_empty() {
            let price = finite(&record[3], "mark_price")?;
            ensure!(price > 0.0, "Invalid funding mark price");
            Some(price)
        } else {
            None
        };
        if time < start || time >= end {
            continue;
        }
        ensure!(
            previous.is_none_or(|last| time > last),
            "Duplicate or unsorted funding records"
        );
        previous = Some(time);
        let mut row = json!({"fundingTime":time,"available_at_ms":time,"fundingRate":rate,"fundingIntervalHours":interval});
        if let Some(mark) = mark {
            row["markPrice"] = json!(mark);
        }
        output.push(row);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, contents) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn csv_records(csv: &str) -> Vec<Vec<String>> {
        read_csv(&archive(&[("observations.csv", csv.as_bytes())])).unwrap()
    }

    #[test]
    fn zip_csv_keeps_headers_and_rejects_invalid_archives() {
        let records = csv_records("a,b\n\n1,2\n , \n");
        assert_eq!(records, vec![vec!["a", "b"], vec!["1", "2"]]);
        assert!(read_csv(&archive(&[("a.csv", b"a"), ("b.csv", b"b")])).is_err());
        assert!(read_csv(&archive(&[("a.txt", b"a")])).is_err());
        assert!(read_csv(&archive(&[("../a.csv", b"a")])).is_err());
        assert!(read_csv(&archive(&[("..\\a.csv", b"a")])).is_err());
        assert!(read_csv(&vec![0; MAX_ZIP_BYTES + 1]).is_err());
        assert!(read_csv(b"PK broken ZIP").is_err());
        let entries: Vec<_> = (0..9).map(|_| ("a.txt", b"a".as_slice())).collect();
        assert!(read_csv(&archive(&entries)).is_err());
    }

    #[test]
    fn zip_checks_crc_reported_sizes_and_decompression_limit() {
        let original = archive(&[("a.csv", b"first,second\n1,2\n")]);
        let central = original
            .windows(4)
            .position(|bytes| bytes == b"PK\x01\x02")
            .unwrap();
        let mut bad_crc = original.clone();
        bad_crc[central + 16] ^= 1;
        assert!(read_csv(&bad_crc).is_err());
        let mut huge_report = original.clone();
        huge_report[central + 24..central + 28]
            .copy_from_slice(&((MAX_CSV_BYTES + 1) as u32).to_le_bytes());
        assert!(read_csv(&huge_report).is_err());
        let mut understated = original.clone();
        understated[central + 24..central + 28].copy_from_slice(&1_u32.to_le_bytes());
        assert!(read_csv(&understated).is_err());
        let huge = vec![b'x'; MAX_CSV_BYTES + 1];
        assert!(read_csv(&archive(&[("a.csv", &huge)])).is_err());
        assert!(read_csv(&original[..original.len() - 10]).is_err());
    }

    #[test]
    fn candle_schema_closure_and_microsecond_normalization() {
        let first = 1_735_689_600_000_i64;
        let header = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore";
        let source = format!(
            "{header}\n{},100,110,90,105,10,{},1000,7,4,400,0\n{},105,115,95,110,10,{},1100,8,5,550,0\n",
            first * 1000,
            (first + HOUR_MS) * 1000 - 1,
            (first + HOUR_MS) * 1000,
            (first + 2 * HOUR_MS) * 1000 - 1
        );
        let rows = klines(&csv_records(&source), first, first + HOUR_MS).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["openTime"], first);
        assert_eq!(rows[0]["closeTime"], first + HOUR_MS - 1);
        assert_eq!(rows[0]["takerBuyQuoteVolume"], 400.0);
        assert!(
            crate::ml_dataset::candle_coverage(&rows, first, first + HOUR_MS)
                .unwrap()
                .complete
        );
        let headerless = format!(
            "{first},100,110,90,105,10,{},1000,7,4,400,0\n",
            first + HOUR_MS - 1
        );
        assert_eq!(
            klines(&csv_records(&headerless), first, first + HOUR_MS).unwrap(),
            rows
        );
        assert!(
            klines(
                &csv_records(&headerless.replace(",105,", ",NaN,")),
                first,
                first + HOUR_MS
            )
            .is_err()
        );
        assert!(klines(&csv_records("unknown,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n"), first, first + HOUR_MS).is_err());
        assert!(klines(&csv_records(&headerless.repeat(2)), first, first + HOUR_MS).is_err());
    }

    #[test]
    fn reference_prices_allow_negative_premium_and_no_invented_volume() {
        let records = csv_records(
            "open_time,open,high,low,close,volume,close_time\n0,-0.01,0.01,-0.02,-0.005,0,3599999\n3600000,0,0,0,0,0,7199999\n",
        );
        let rows = reference_klines(&records, 0, HOUR_MS).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["available_at_ms"], HOUR_MS);
        assert_eq!(rows[0]["close"], -0.005);
        assert!(rows[0].get("volume").is_none());
        assert!(klines(&records, 0, HOUR_MS).is_err());
    }

    #[test]
    fn native_quarter_hour_source_keeps_flow_fields_and_true_close_availability() {
        let records = csv_records(
            "0,100,110,90,105,10,899999,1000,7,4,400,0\n900000,105,115,95,110,11,1799999,1100,8,5,500,0\n",
        );
        let rows = native_klines(&records, 0, 1_800_000, 900_000).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["tradeCount"], 7);
        assert_eq!(rows[1]["available_at_ms"], 1_800_000);
        assert_eq!(rows[1]["takerBuyQuoteVolume"], 500.0);
        assert!(native_klines(&records, 0, HOUR_MS, HOUR_MS).is_err());
        assert!(native_klines(&records, 0, HOUR_MS, 300_000).is_err());
    }

    fn repair_bars(interval_ms: i64) -> Vec<Value> {
        let mut csv = String::new();
        for index in 0..HOUR_MS / interval_ms {
            let time = index * interval_ms;
            let volume = (index + 1) * 10;
            csv.push_str(&format!(
                "{time},100,{},{},104,{volume},{},{},{},{},{},0\n",
                110 + index,
                90 - index,
                time + interval_ms - 1,
                volume * 100,
                index + 7,
                volume * 2 / 5,
                volume * 40,
            ));
        }
        interval_klines(&csv_records(&csv), 0, HOUR_MS, interval_ms).unwrap()
    }

    #[test]
    fn repair_aggregates_real_15m_and_1m_bars_without_filling() {
        let source = repair_bars(900_000);
        let rows = aggregate_hourly(&source, 0, HOUR_MS, 900_000).unwrap();
        assert_eq!(
            rows,
            vec![json!({
                "openTime":0,"closeTime":HOUR_MS - 1,
                "open":100.0,"high":113.0,"low":87.0,"close":104.0,
                "volume":100.0,"quoteVolume":10000.0,"tradeCount":34,
                "takerBuyVolume":40.0,"takerBuyQuoteVolume":4000.0,"confirmed":true
            })]
        );
        assert!(
            crate::ml_dataset::candle_coverage(&rows, 0, HOUR_MS)
                .unwrap()
                .complete
        );
        let minute = aggregate_hourly(&repair_bars(60_000), 0, HOUR_MS, 60_000).unwrap();
        assert_eq!(minute.len(), 1);
        assert_eq!(minute[0]["volume"], 18300.0);
        assert_eq!(minute[0]["tradeCount"], 2190);
        assert!(aggregate_hourly(&source, 1, HOUR_MS + 1, 900_000).is_err());
        assert!(interval_klines(&[], 0, HOUR_MS, 300_000).is_err());
    }

    #[test]
    fn repair_refuses_gaps_duplicate_unclosed_future_and_overflow_bars() {
        let source = repair_bars(900_000);
        assert!(aggregate_hourly(&source[..3], 0, HOUR_MS, 900_000).is_err());
        let mut duplicate = source.clone();
        duplicate[1] = duplicate[0].clone();
        assert!(aggregate_hourly(&duplicate, 0, HOUR_MS, 900_000).is_err());
        let mut unclosed = source.clone();
        unclosed[3]["confirmed"] = json!(false);
        assert!(aggregate_hourly(&unclosed, 0, HOUR_MS, 900_000).is_err());
        let mut future = source.clone();
        future[3]["openTime"] = json!(HOUR_MS);
        future[3]["closeTime"] = json!(HOUR_MS + 900_000 - 1);
        assert!(aggregate_hourly(&future, 0, HOUR_MS, 900_000).is_err());
        assert!(aggregate_hourly(&source, 0, HOUR_MS / 2, 900_000).is_err());
        let mut overflow = source.clone();
        overflow[0]["tradeCount"] = json!(u64::MAX);
        assert!(aggregate_hourly(&overflow, 0, HOUR_MS, 900_000).is_err());
        let mut overflow = source;
        for row in &mut overflow {
            row["volume"] = json!(f64::MAX);
        }
        assert!(aggregate_hourly(&overflow, 0, HOUR_MS, 900_000).is_err());
    }

    #[test]
    fn native_interval_parser_preserves_only_closed_requested_bars() {
        let csv = "0,100,110,90,104,10,899999,1000,7,4,400,0\n900000,100,110,90,104,10,1799999,1000,7,4,400,0\n";
        let rows = interval_klines(&csv_records(csv), 0, 900_000, 900_000).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["closeTime"], 899999);
        assert!(
            interval_klines(
                &csv_records(&csv.replace("899999", "900000")),
                0,
                900_000,
                900_000
            )
            .is_err()
        );
        assert!(interval_klines(&csv_records(csv), 0, 900_001, 900_000).is_err());
    }

    #[test]
    fn metrics_map_real_archive_fields_and_conservative_availability() {
        let header = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
        let records = csv_records(&format!(
            "{header}\n2025-01-01 00:00:00,BTCUSDT,10,1000,2,3,4,5\n2025-01-01 00:05:00,BTCUSDT,11,1100,2,3,4,5\n2025-01-01 01:00:00,BTCUSDT,12,1200,2,3,4,5\n"
        ));
        let first = 1_735_689_600_000;
        let result = metrics(&records, first, first + HOUR_MS).unwrap();
        assert!(result.values().all(|rows| rows.len() == 1));
        assert_eq!(result["open_interest"][0]["sumOpenInterestValue"], 1000.0);
        assert_eq!(result["global_long_short"][0]["longShortRatio"], 4.0);
        assert_eq!(result["top_account_long_short"][0]["longShortRatio"], 2.0);
        assert_eq!(result["top_position_long_short"][0]["longShortRatio"], 3.0);
        assert_eq!(result["global_long_short"][0]["longAccount"], 0.8);
        assert_eq!(result["taker_long_short"][0]["buySellRatio"], 5.0);
        assert!(result["taker_long_short"][0].get("buyVol").is_none());
        assert_eq!(
            result["global_long_short"][0]["available_at_ms"],
            first + HOUR_MS
        );
        assert_eq!(
            result["global_long_short"][0]["source_fields"]["count_long_short_ratio"],
            4.0
        );
        let missing = csv_records(&format!(
            "{header}\n2025-01-01 00:00:00,BTCUSDT,10,1000,,,4,\n"
        ));
        let missing = metrics(&missing, first, first + HOUR_MS).unwrap();
        assert!(missing["top_account_long_short"].is_empty());
        assert!(missing["taker_long_short"].is_empty());
        assert_eq!(missing["global_long_short"].len(), 1);
        assert!(
            metrics(
                &csv_records("create_time,symbol,garbage\n"),
                first,
                first + HOUR_MS
            )
            .is_err()
        );
    }

    #[test]
    fn funding_preserves_settlement_and_optional_mark_price() {
        let result = funding(&csv_records("calc_time,funding_interval_hours,last_funding_rate\n0,8,-0.0001\n3600000,1,0.0002\n"), 0, HOUR_MS).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["available_at_ms"], 0);
        assert_eq!(result[0]["fundingRate"], -0.0001);
        assert!(result[0].get("markPrice").is_none());
        let mark = funding(
            &csv_records(
                "calc_time,funding_interval_hours,last_funding_rate,mark_price\n0,8,0.0001,100\n",
            ),
            0,
            HOUR_MS,
        )
        .unwrap();
        assert_eq!(mark[0]["markPrice"], 100.0);
        assert!(
            funding(
                &csv_records("calc_time,funding_interval_hours,last_funding_rate\n0,0,0.01\n"),
                0,
                HOUR_MS
            )
            .is_err()
        );
        assert!(
            funding(
                &csv_records("calc_time,funding_interval_hours,last_funding_rate\n0,8,Infinity\n"),
                0,
                HOUR_MS
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod metric_merge_tests {
    use super::*;
    #[test]
    fn orders_actual_observations_and_deduplicates_numeric_equivalents() {
        let header = METRIC_HEADERS
            .iter()
            .map(|names| names[0].to_string())
            .collect::<Vec<_>>();
        let row = |time: &str, quantity: &str| {
            vec![
                time.into(),
                "BTCUSDT".into(),
                quantity.into(),
                "20".into(),
                "2".into(),
                "3".into(),
                "4".into(),
                "5".into(),
            ]
        };
        let records = vec![
            header.clone(),
            row("1970-01-01 02:00:00", "10"),
            row("1970-01-01 01:00:00", "10.0"),
            row("1970-01-01 01:00:00", "1e1"),
        ];
        let data = metrics(&records, 0, 4 * HOUR_MS).unwrap();
        assert_eq!(data["open_interest"].len(), 2);
        assert_eq!(data["open_interest"][0]["timestamp"], HOUR_MS);
        assert_eq!(data["open_interest"][1]["timestamp"], 2 * HOUR_MS);
        let conflict = vec![
            header,
            row("1970-01-01 01:00:00", "10"),
            row("1970-01-01 01:00:00", "11"),
        ];
        assert!(metrics(&conflict, 0, 4 * HOUR_MS).is_err());
    }
}
