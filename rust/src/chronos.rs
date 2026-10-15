//! CPU-only Chronos-Bolt inference. Model conversion is performed separately;
//! pricing, decisions and simulation remain in the Rust application.

use anyhow::{Context, Result, ensure};
use ort::{
    execution_providers::CPUExecutionProvider,
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Instant};

pub const MODEL_ID: &str = "amazon/chronos-bolt-tiny";
pub const CONTEXT_LENGTH: usize = 256;
pub const HORIZON_HOURS: usize = 12;
pub const MODEL_HORIZON: usize = 64;
pub const HOUR_MS: i64 = 3_600_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ContextRecord {
    pub symbol: String,
    /// First future hourly candle's open time, after the context has closed.
    pub origin_ms: i64,
    pub context_end_open_ms: i64,
    pub context: Vec<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_open_ms: Option<Vec<i64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_sha256: Option<String>,
}

impl ContextRecord {
    pub fn validate(&self) -> Result<()> {
        crate::exchange::valid_symbol(&self.symbol)?;
        ensure!(
            self.context.len() == CONTEXT_LENGTH,
            "Chronos requires exactly {CONTEXT_LENGTH} hourly closes"
        );
        ensure!(
            self.context
                .iter()
                .all(|price| price.is_finite() && *price > 0.0),
            "Context prices must be finite and positive"
        );
        ensure!(
            self.context_end_open_ms >= 0
                && self.context_end_open_ms % HOUR_MS == 0
                && self.origin_ms % HOUR_MS == 0
                && self.context_end_open_ms.checked_add(HOUR_MS) == Some(self.origin_ms),
            "origin_ms must be the hour immediately after context_end_open_ms"
        );
        if let Some(times) = &self.context_open_ms {
            ensure!(
                times.len() == CONTEXT_LENGTH,
                "Context timestamp count must equal context length"
            );
            for (index, time) in times.iter().enumerate() {
                let distance = (CONTEXT_LENGTH - index) as i64 * HOUR_MS;
                ensure!(
                    self.origin_ms.checked_sub(distance) == Some(*time),
                    "Context contains a missing, duplicate or future hourly candle"
                );
            }
        }
        if let Some(hash) = &self.history_sha256 {
            ensure!(
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
                "Invalid history SHA-256"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct InputDocument {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holdout_start_ms: Option<i64>,
    pub records: Vec<ContextRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ForecastRecord {
    pub symbol: String,
    pub origin_ms: i64,
    pub context_end_open_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_sha256: Option<String>,
    pub current_price: f64,
    pub interval: String,
    pub horizon_hours: usize,
    pub q10: Vec<f64>,
    pub q50: Vec<f64>,
    pub q90: Vec<f64>,
    /// Raw model quantiles are preserved; crossing intervals are exposed.
    pub quantile_crossings: usize,
    pub inference_ms: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LatencySummary {
    pub count: usize,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

pub fn latency_summary(records: &[ForecastRecord]) -> LatencySummary {
    let mut times: Vec<f64> = records.iter().map(|record| record.inference_ms).collect();
    times.sort_by(f64::total_cmp);
    let percentile = |p: f64| {
        times
            .get(((times.len() as f64 * p).ceil() as usize).saturating_sub(1))
            .copied()
            .unwrap_or(0.0)
    };
    LatencySummary {
        count: times.len(),
        mean_ms: if times.is_empty() {
            0.0
        } else {
            times.iter().sum::<f64>() / times.len() as f64
        },
        p50_ms: percentile(0.5),
        p95_ms: percentile(0.95),
        max_ms: times.last().copied().unwrap_or(0.0),
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ForecastDocument {
    pub schema_version: u32,
    pub model: String,
    pub interval: String,
    pub context_length: usize,
    pub horizon_hours: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holdout_start_ms: Option<i64>,
    pub model_load_ms: f64,
    pub total_ms: f64,
    pub inference_summary: LatencySummary,
    pub records: Vec<ForecastRecord>,
}

pub struct ChronosModel {
    session: Session,
    pub model_load_ms: f64,
}

impl ChronosModel {
    pub fn load(model_path: &Path, runtime_path: &Path, threads: usize) -> Result<Self> {
        ensure!(
            model_path.is_file(),
            "Model does not exist: {}",
            model_path.display()
        );
        ensure!(
            runtime_path.is_file(),
            "ONNX Runtime does not exist: {}",
            runtime_path.display()
        );
        ensure!(
            (1..=12).contains(&threads),
            "CPU threads must be between 1 and 12"
        );
        let started = Instant::now();
        // ONNX Runtime is process-global; initialize before any session API.
        ort::init_from(runtime_path.to_string_lossy())
            .with_name("nofx-chronos-cpu")
            .with_telemetry(false)
            .commit()
            .context("Initialize CPU ONNX Runtime")?;
        let session = Session::builder()?
            .with_execution_providers([CPUExecutionProvider::default().build()])?
            .with_intra_threads(threads)?
            .with_inter_threads(1)?
            .with_parallel_execution(false)?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .commit_from_file(model_path)
            .context("Load Chronos-Bolt ONNX model")?;
        ensure!(
            session.inputs.len() == 1 && session.inputs[0].name == "context",
            "Expected one ONNX input named context"
        );
        ensure!(
            session.outputs.len() == 1 && session.outputs[0].name == "quantile_preds",
            "Expected one ONNX output named quantile_preds"
        );
        Ok(Self {
            session,
            model_load_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    pub fn forecast(&mut self, record: &ContextRecord) -> Result<ForecastRecord> {
        record.validate()?;
        let started = Instant::now();
        let input = Tensor::from_array(([1_usize, CONTEXT_LENGTH], record.context.clone()))?;
        let outputs = self.session.run(ort::inputs!["context" => input])?;
        let (shape, values) = outputs["quantile_preds"].try_extract_tensor::<f32>()?;
        decode_forecast(
            record,
            &shape[..],
            values,
            started.elapsed().as_secs_f64() * 1000.0,
        )
    }
}

fn decode_forecast(
    record: &ContextRecord,
    shape: &[i64],
    values: &[f32],
    inference_ms: f64,
) -> Result<ForecastRecord> {
    ensure!(
        shape == [1, 9, MODEL_HORIZON as i64] && values.len() == 9 * MODEL_HORIZON,
        "Expected ONNX forecasts shaped [1, 9, {MODEL_HORIZON}], got {shape:?}"
    );
    let quantile = |index: usize| -> Result<Vec<f64>> {
        let prices = &values[index * MODEL_HORIZON..index * MODEL_HORIZON + HORIZON_HOURS];
        ensure!(
            prices.iter().all(|price| price.is_finite() && *price > 0.0),
            "Model returned invalid forecast prices"
        );
        Ok(prices.iter().map(|price| f64::from(*price)).collect())
    };
    let q10 = quantile(0)?;
    let q50 = quantile(4)?;
    let q90 = quantile(8)?;
    let quantile_crossings = (0..HORIZON_HOURS)
        .filter(|&hour| q10[hour] > q50[hour] || q50[hour] > q90[hour])
        .count();
    Ok(ForecastRecord {
        symbol: record.symbol.clone(),
        origin_ms: record.origin_ms,
        context_end_open_ms: record.context_end_open_ms,
        history_sha256: record.history_sha256.clone(),
        current_price: f64::from(*record.context.last().context("Empty context")?),
        interval: "1h".into(),
        horizon_hours: HORIZON_HOURS,
        q10,
        q50,
        q90,
        quantile_crossings,
        inference_ms,
    })
}

/// Fetch only complete, consecutive hourly candles using the existing public
/// exchange client. This path has no account, database or order dependency.
pub async fn live_context(symbol: &str) -> Result<ContextRecord> {
    crate::exchange::valid_symbol(symbol)?;
    let origin_ms = crate::now_ms().div_euclid(HOUR_MS) * HOUR_MS;
    let exchange = crate::exchange::Exchange::public()?;
    let mut rows = exchange
        .klines(symbol, "1h", CONTEXT_LENGTH + 4, None, Some(origin_ms - 1))
        .await?;
    rows.retain(|row| {
        row["confirmed"] == true
            && row["openTime"]
                .as_i64()
                .is_some_and(|time| time >= 0 && time + HOUR_MS <= origin_ms)
    });
    rows.sort_by_key(|row| row["openTime"].as_i64().unwrap_or(0));
    rows.dedup_by_key(|row| row["openTime"].as_i64().unwrap_or(0));
    ensure!(
        rows.len() >= CONTEXT_LENGTH,
        "Insufficient closed hourly candles for {symbol}"
    );
    let rows = &rows[rows.len() - CONTEXT_LENGTH..];
    for (index, row) in rows.iter().enumerate() {
        let expected = origin_ms - (CONTEXT_LENGTH - index) as i64 * HOUR_MS;
        ensure!(
            row["openTime"].as_i64() == Some(expected),
            "Missing or stale hourly candle for {symbol} at {expected}"
        );
    }
    let context = rows
        .iter()
        .map(|row| crate::number(&row["close"], f64::NAN) as f32)
        .collect();
    let record = ContextRecord {
        symbol: symbol.into(),
        origin_ms,
        context_end_open_ms: origin_ms - HOUR_MS,
        context,
        context_open_ms: Some(
            rows.iter()
                .map(|row| row["openTime"].as_i64().unwrap())
                .collect(),
        ),
        history_sha256: None,
    };
    record.validate()?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> ContextRecord {
        ContextRecord {
            symbol: "BTCUSDT".into(),
            origin_ms: 300 * HOUR_MS,
            context_end_open_ms: 299 * HOUR_MS,
            context: vec![100.0; CONTEXT_LENGTH],
            context_open_ms: None,
            history_sha256: None,
        }
    }

    #[test]
    fn validates_context_and_closed_hour_boundary() {
        let good = record();
        assert!(good.validate().is_ok());
        let mut bad = good.clone();
        bad.origin_ms = bad.context_end_open_ms;
        assert!(bad.validate().is_err());
        bad = good.clone();
        bad.context[0] = f32::NAN;
        assert!(bad.validate().is_err());
        bad = good;
        bad.context.pop();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn rejects_missing_candles_in_timestamped_context() {
        let mut input = record();
        input.context_open_ms = Some(
            (0..CONTEXT_LENGTH)
                .map(|index| input.origin_ms - (CONTEXT_LENGTH - index) as i64 * HOUR_MS)
                .collect(),
        );
        assert!(input.validate().is_ok());
        input.context_open_ms.as_mut().unwrap()[10] += HOUR_MS;
        assert!(input.validate().is_err());
    }

    #[test]
    fn selects_trained_quantiles_and_twelve_hour_horizon() {
        let values: Vec<f32> = (0..9)
            .flat_map(|quantile| {
                (0..64).map(move |hour| 100.0 + quantile as f32 * 10.0 + hour as f32)
            })
            .collect();
        let forecast = decode_forecast(&record(), &[1, 9, 64], &values, 1.0).unwrap();
        assert_eq!(forecast.q10, (100..112).map(f64::from).collect::<Vec<_>>());
        assert_eq!(forecast.q50, (140..152).map(f64::from).collect::<Vec<_>>());
        assert_eq!(forecast.q90, (180..192).map(f64::from).collect::<Vec<_>>());
        assert_eq!(forecast.quantile_crossings, 0);
        assert!(decode_forecast(&record(), &[1, 64, 9], &values, 1.0).is_err());
    }

    #[test]
    fn exposes_crossing_and_rejects_invalid_predictions() {
        let mut values = vec![100.0; 9 * 64];
        values[0] = 200.0;
        let forecast = decode_forecast(&record(), &[1, 9, 64], &values, 1.0).unwrap();
        assert_eq!(forecast.quantile_crossings, 1);
        assert_eq!(forecast.q10[0], 200.0);
        values[0] = f32::INFINITY;
        assert!(decode_forecast(&record(), &[1, 9, 64], &values, 1.0).is_err());
    }

    #[test]
    #[ignore = "requires exported model, CPU runtime DLL and PyTorch parity-reference.json"]
    fn onnx_matches_official_pytorch_reference() -> Result<()> {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("data/chronos");
        let reference: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("parity-reference.json"))?)?;
        let mut input = record();
        input.context = serde_json::from_value(reference["context"].clone())?;
        let mut model = ChronosModel::load(
            &directory.join("chronos-bolt-tiny.onnx"),
            &directory.join("model-toolchain/Lib/site-packages/onnxruntime/capi/onnxruntime.dll"),
            4,
        )?;
        let forecast = model.forecast(&input)?;
        let mut expected: Vec<Vec<f32>> = if reference["quantile_preds"]
            .as_array()
            .is_some_and(|array| array.len() == 1)
        {
            serde_json::from_value(reference["quantile_preds"][0].clone())?
        } else {
            serde_json::from_value(reference["quantile_preds"].clone())?
        };
        ensure!(
            expected.len() == 9 && expected.iter().all(|row| row.len() == MODEL_HORIZON),
            "Reference shape must be [9,64] or [1,9,64]"
        );
        for (index, actual) in [(0, &forecast.q10), (4, &forecast.q50), (8, &forecast.q90)] {
            for (hour, (actual, expected)) in actual
                .iter()
                .zip(expected[index].drain(..HORIZON_HOURS))
                .enumerate()
            {
                let expected = f64::from(expected);
                ensure!(
                    (actual - expected).abs() <= 1e-3 + expected.abs() * 1e-6,
                    "ONNX/PyTorch parity differs at quantile {index}, hour {hour}: {actual} vs {expected}"
                );
            }
        }
        Ok(())
    }
}
