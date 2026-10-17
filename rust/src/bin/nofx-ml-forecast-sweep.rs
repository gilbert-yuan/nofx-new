//! Candle-interval x forecast-horizon sweep: which combination predicts best?
//!
//! Walk-forward training per combination, evaluated strictly out of sample with
//! the same purge/cost discipline as `nofx-ml-rolling-benchmark`. The ranking
//! metric is the out-of-sample information coefficient (prediction vs realized
//! return); directional accuracy and net return are reported alongside.
//!
//! Intervals: 15m and 4h need real candles. 15m comes from a 15m archive, 4h is
//! aggregated losslessly from 1h bars (exact 4-bar UTC buckets). 1m/5m are not
//! collected by any local archive and are out of scope here.

use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    ml_lightgbm::{self, LightGbmRegressor, LightGbmRuntime},
    rolling_bench::{self, CostModel, Fold, HOUR_MS, Performance, Series, Simulation},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const HOUR: i64 = HOUR_MS;

#[derive(Parser)]
#[command(
    about = "Walk-forward sweep across candle intervals and forecast horizons, ranked by out-of-sample IC"
)]
struct Args {
    /// 1h archive root (`symbols/*.json`, datasets.1h).
    #[arg(long, default_value = "data/ml/expanded-archive-20261016")]
    data_dir_1h: PathBuf,
    /// 15m archive root (`symbols/*.json`, datasets.15m).
    #[arg(long, default_value = "data/ml/intraday-15m-20261017")]
    data_dir_15m: PathBuf,
    #[arg(long)]
    output_dir: Option<PathBuf>,
    #[arg(long, default_value = ml_lightgbm::DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    /// Empty = every symbol present and aligned in both archives.
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    /// 1h/4h training window in hours.
    #[arg(long, default_value_t = 1080)]
    train_hours: i64,
    /// 15m training window in hours (shorter archive, 88 days).
    #[arg(long, default_value_t = 720)]
    train_hours_15m: i64,
    /// Test window in hours, identical for every interval.
    #[arg(long, default_value_t = 336)]
    test_hours: i64,
    #[arg(long, default_value_t = 6.0)]
    fee_bps: f64,
    #[arg(long, default_value_t = 5.0)]
    slippage_bps: f64,
    /// Trade only when |prediction| exceeds this multiple of the round-trip cost.
    #[arg(long, default_value_t = 1.0)]
    threshold_multiple: f64,
    #[arg(long, default_value_t = 120)]
    iterations: usize,
}

#[derive(Clone, Copy)]
struct Combo {
    interval: &'static str,
    /// Forecast horizon in hours (>= the candle interval).
    horizon_hours: i64,
}

const COMBOS: &[Combo] = &[
    Combo {
        interval: "15m",
        horizon_hours: 0,
    }, // 15m is 0.25h, handled via horizon_bars
    Combo {
        interval: "15m",
        horizon_hours: 1,
    },
    Combo {
        interval: "15m",
        horizon_hours: 4,
    },
    Combo {
        interval: "15m",
        horizon_hours: 24,
    },
    Combo {
        interval: "1h",
        horizon_hours: 1,
    },
    Combo {
        interval: "1h",
        horizon_hours: 4,
    },
    Combo {
        interval: "1h",
        horizon_hours: 24,
    },
    Combo {
        interval: "4h",
        horizon_hours: 4,
    },
    Combo {
        interval: "4h",
        horizon_hours: 24,
    },
];

impl Combo {
    fn horizon_label(&self) -> String {
        if self.interval == "15m" && self.horizon_hours == 0 {
            "15m".to_string()
        } else {
            format!("{}h", self.horizon_hours)
        }
    }
    /// Horizon length in whole hours; the 15m/15m pair is one quarter-hour.
    fn horizon_ms(&self) -> i64 {
        if self.horizon_hours == 0 {
            HOUR / 4
        } else {
            self.horizon_hours * HOUR
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct ComboResult {
    interval: String,
    horizon: String,
    symbols: usize,
    folds: usize,
    samples: usize,
    train_hours: i64,
    mean_ic: f64,
    directional_accuracy: f64,
    net_return: f64,
    gross_return: f64,
    cost_drag: f64,
    sharpe: f64,
    max_drawdown: f64,
    turnover: f64,
    exposure: f64,
    best_fold_ic: f64,
    worst_fold_ic: f64,
    /// Folds whose IC is positive, i.e. sign stability instead of one lucky fold.
    folds_positive_ic: usize,
    /// 1/sqrt(samples): a lower bound on the IC standard error. Cross-sectional
    /// correlation across symbols makes the true error larger.
    ic_standard_error: f64,
    significant: bool,
}

fn read_dataset(path: &Path, dataset: &str) -> Result<Vec<Value>> {
    let bytes = fs::read(path).with_context(|| format!("Read {}", path.display()))?;
    let value: Value =
        serde_json::from_slice(&bytes).with_context(|| format!("Parse {}", path.display()))?;
    Ok(value
        .get("datasets")
        .and_then(|datasets| datasets.get(dataset))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Lossless 4x aggregation of hourly bars into UTC-aligned 4h bars. A trailing
/// partial bucket is dropped so every bar spans exactly four hours.
fn aggregate_1h_to_4h(rows: &[Value]) -> Result<Vec<Value>> {
    let step = 4 * HOUR;
    let mut buckets: Vec<(i64, Vec<Value>)> = Vec::new();
    for row in rows {
        let open = nofx_core::timestamp(&row["openTime"]).context("Missing openTime")?;
        ensure!(open % HOUR == 0, "1h rows expected");
        let bucket = open - open % step;
        match buckets.last_mut() {
            Some((stamp, items)) if *stamp == bucket => items.push(row.clone()),
            Some(_) | None => buckets.push((bucket, vec![row.clone()])),
        }
    }
    if buckets.last().is_some_and(|(_, items)| items.len() < 4) {
        buckets.pop();
    }
    let mut output = Vec::with_capacity(buckets.len());
    for (stamp, items) in buckets {
        ensure!(
            items.len() == 4,
            "Bucket at {} is not full",
            nofx_core::iso(stamp)
        );
        let number = |name: &str| nofx_core::number(&items[0][name], 0.0);
        let high = items
            .iter()
            .map(|row| nofx_core::number(&row["high"], 0.0))
            .fold(f64::NEG_INFINITY, f64::max);
        let low = items
            .iter()
            .map(|row| nofx_core::number(&row["low"], 0.0))
            .fold(f64::INFINITY, f64::min);
        let sum = |name: &str| {
            items
                .iter()
                .map(|row| nofx_core::number(&row[name], 0.0))
                .sum::<f64>()
        };
        output.push(json!({
            "openTime": stamp,
            "closeTime": items.last().expect("non-empty")["closeTime"],
            "open": number("open"),
            "high": high,
            "low": low,
            "close": items.last().expect("non-empty")["close"],
            "volume": sum("volume"),
            "quoteVolume": sum("quoteVolume"),
            "confirmed": true,
        }));
    }
    Ok(output)
}

/// Load one interval for every symbol available in that source archive.
fn load_interval_series(
    data_dir: &Path,
    dataset: &str,
    interval: &str,
    symbols: &[String],
) -> Result<Vec<Series>> {
    let mut series_list = Vec::new();
    for symbol in symbols {
        let path = data_dir.join("symbols").join(format!("{symbol}.json"));
        let Ok(rows) = read_dataset(&path, dataset) else {
            continue;
        };
        if rows.is_empty() {
            continue;
        }
        match rolling_bench::build_series_interval(symbol, &rows, interval) {
            Ok(series) => series_list.push(series),
            Err(error) => println!("skip {symbol} {interval}: {error}"),
        }
    }
    ensure!(!series_list.is_empty(), "No usable {interval} series");
    Ok(series_list)
}

/// Keep only symbols whose bars share the dominant grid inside one interval.
fn align_interval(series_list: &mut Vec<Series>) {
    if series_list.is_empty() {
        return;
    }
    let reference_len = series_list[0].len();
    let first = series_list[0].open_ms[0];
    let last = *series_list[0].open_ms.last().expect("non-empty");
    series_list.retain(|series| {
        series.len() == reference_len
            && series.open_ms.first() == Some(&first)
            && series.open_ms.last() == Some(&last)
    });
}

fn decision_grid(series: &Series, fold: &Fold, horizon_bars: usize) -> Vec<usize> {
    let (Some(start), Some(last)) = (
        series.index_at_or_after(fold.test_start_ms),
        series.index_before(fold.test_end_ms),
    ) else {
        return Vec::new();
    };
    let mut origins = Vec::new();
    let mut origin = start;
    while origin + horizon_bars <= last {
        if series.features[origin].is_some() {
            origins.push(origin);
        }
        origin += horizon_bars;
    }
    origins
}

fn correlation(left: &[f64], right: &[f64]) -> f64 {
    if left.len() < 3 || left.len() != right.len() {
        return 0.0;
    }
    let count = left.len() as f64;
    let mean_left = left.iter().sum::<f64>() / count;
    let mean_right = right.iter().sum::<f64>() / count;
    let (mut covariance, mut variance_left, mut variance_right) = (0.0, 0.0, 0.0);
    for index in 0..left.len() {
        let a = left[index] - mean_left;
        let b = right[index] - mean_right;
        covariance += a * b;
        variance_left += a * a;
        variance_right += b * b;
    }
    if variance_left <= 0.0 || variance_right <= 0.0 {
        return 0.0;
    }
    covariance / (variance_left.sqrt() * variance_right.sqrt())
}

fn directional_accuracy(pairs: &[(f64, f64)], floor: f64) -> f64 {
    let traded: Vec<&(f64, f64)> = pairs
        .iter()
        .filter(|(prediction, _)| prediction.abs() > floor)
        .collect();
    if traded.is_empty() {
        return 0.0;
    }
    let correct = traded
        .iter()
        .filter(|(prediction, realized)| prediction.signum() == realized.signum())
        .count();
    correct as f64 / traded.len() as f64
}

#[allow(clippy::too_many_arguments)]
fn run_combo(
    runtime: &Arc<LightGbmRuntime>,
    series_list: &[Series],
    interval: &str,
    horizon_label: &str,
    horizon_bars: usize,
    train_hours: i64,
    test_hours: i64,
    args: &Args,
    cost: CostModel,
) -> Result<ComboResult> {
    let data_start = series_list[0].open_ms[0];
    let data_end = *series_list[0].open_ms.last().expect("non-empty") + rolling_bench::HOUR_MS;
    let folds = rolling_bench::plan_folds(data_start, data_end, train_hours, test_hours)?;
    let threshold = args.threshold_multiple * cost.round_trip();

    let mut fold_ics: Vec<(usize, f64)> = Vec::new();
    let mut portfolio_runs: Vec<Simulation> = Vec::new();
    let mut samples = 0usize;
    let mut accuracy_sum = 0.0;

    for fold in &folds {
        let mut features: Vec<Vec<f64>> = Vec::new();
        let mut targets: Vec<f64> = Vec::new();
        for series in series_list {
            let (Some(start), Some(last)) = (
                series.index_at_or_after(fold.train_start_ms),
                series.index_before(fold.train_end_ms),
            ) else {
                continue;
            };
            for origin in start..=last {
                if origin + horizon_bars > last {
                    break;
                }
                let Some(vector) = series.features[origin].as_ref() else {
                    continue;
                };
                let target = series.close[origin + horizon_bars] / series.close[origin] - 1.0;
                if target.is_finite() {
                    features.push(vector.clone());
                    targets.push(target);
                }
            }
        }
        ensure!(
            features.len() >= ml_lightgbm::MIN_TRAIN_ROWS,
            "{interval}: fold {} has only {} rows",
            fold.index,
            features.len()
        );
        let mut model = LightGbmRegressor::train_config(
            runtime.clone(),
            &features,
            &targets,
            ml_lightgbm::REGRESSION_PARAMETERS,
            args.iterations,
        )
        .with_context(|| format!("{interval}: fold {} training failed", fold.index))?;

        let mut runs = Vec::with_capacity(series_list.len());
        let mut pairs: Vec<(f64, f64)> = Vec::new();
        for series in series_list {
            let origins = decision_grid(series, fold, horizon_bars);
            ensure!(
                !origins.is_empty(),
                "{}: fold {} has no decision bar",
                series.symbol,
                fold.index
            );
            let batch: Vec<Vec<f64>> = origins
                .iter()
                .map(|&origin| series.features[origin].clone().expect("checked by grid"))
                .collect();
            let predictions = model
                .predict(&batch)
                .with_context(|| format!("{}: prediction failed", series.symbol))?;
            let decisions: Vec<(usize, f64)> = origins
                .iter()
                .zip(&predictions)
                .map(|(&origin, prediction)| {
                    let position = if *prediction > threshold {
                        1.0
                    } else if *prediction < -threshold {
                        -1.0
                    } else {
                        0.0
                    };
                    (origin, position)
                })
                .collect();
            for (&origin, &prediction) in origins.iter().zip(&predictions) {
                let realized = series.close[origin + horizon_bars] / series.close[origin] - 1.0;
                if realized.is_finite() {
                    pairs.push((prediction, realized));
                }
            }
            let target = rolling_bench::settle_positions(series.len(), &decisions, horizon_bars)?;
            runs.push(rolling_bench::simulate_positions(
                series, fold, &target, cost,
            )?);
        }
        let fold_ic = correlation(
            &pairs.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
            &pairs.iter().map(|(_, r)| *r).collect::<Vec<_>>(),
        );
        fold_ics.push((pairs.len(), fold_ic));
        accuracy_sum += directional_accuracy(&pairs, threshold) * pairs.len() as f64;
        samples += pairs.len();
        portfolio_runs.push(rolling_bench::aggregate(&runs)?);
    }

    let total = rolling_bench::concatenate(&portfolio_runs)?;
    let performance: Performance = total.performance();
    let weight: f64 = fold_ics.iter().map(|(count, _)| *count as f64).sum();
    let mean_ic = if weight > 0.0 {
        fold_ics
            .iter()
            .map(|(count, ic)| ic * *count as f64)
            .sum::<f64>()
            / weight
    } else {
        0.0
    };

    Ok(ComboResult {
        interval: interval.to_string(),
        horizon: horizon_label.to_string(),
        symbols: series_list.len(),
        folds: folds.len(),
        samples,
        train_hours,
        mean_ic,
        directional_accuracy: if samples == 0 {
            0.0
        } else {
            accuracy_sum / samples as f64
        },
        net_return: performance.net_return,
        gross_return: performance.gross_return,
        cost_drag: performance.cost_drag,
        sharpe: performance.sharpe,
        max_drawdown: performance.max_drawdown,
        turnover: performance.turnover,
        exposure: performance.exposure,
        best_fold_ic: fold_ics.iter().map(|(_, ic)| *ic).fold(f64::MIN, f64::max),
        worst_fold_ic: fold_ics.iter().map(|(_, ic)| *ic).fold(f64::MAX, f64::min),
        folds_positive_ic: fold_ics.iter().filter(|(_, ic)| *ic > 0.0).count(),
        ic_standard_error: if samples == 0 {
            f64::INFINITY
        } else {
            1.0 / (samples as f64).sqrt()
        },
        significant: samples > 0 && mean_ic.abs() > 2.0 / (samples as f64).sqrt(),
    })
}

fn pct(value: f64) -> String {
    format!("{:+.2}%", value * 100.0)
}

fn main() -> Result<()> {
    let args = Args::parse();
    let cost = CostModel {
        fee_bps: args.fee_bps,
        slippage_bps: args.slippage_bps,
    };
    cost.validate()?;
    let output_dir = args.output_dir.clone().unwrap_or_else(|| {
        PathBuf::from(format!(
            "output/forecast-sweep-{}",
            chrono::Utc::now().format("%Y%m%d")
        ))
    });
    fs::create_dir_all(&output_dir)?;

    let started = Instant::now();
    let hourly = load_interval_series(&args.data_dir_1h, "1h", "1h", &args.symbols)?;
    let mut quarter = load_interval_series(&args.data_dir_15m, "15m", "15m", &args.symbols)?;
    align_interval(&mut quarter);

    // 4h comes from the same hourly archive so the comparison stays on one dataset.
    let mut four_hour: Vec<Series> = Vec::new();
    for series in &hourly {
        let path = args
            .data_dir_1h
            .join("symbols")
            .join(format!("{}.json", series.symbol));
        let rows = read_dataset(&path, "1h")?;
        match rolling_bench::build_series_interval(
            &series.symbol,
            &aggregate_1h_to_4h(&rows)?,
            "4h",
        ) {
            Ok(aggregated) => four_hour.push(aggregated),
            Err(error) => println!("skip {} 4h: {error}", series.symbol),
        }
    }
    align_interval(&mut four_hour);
    let mut hourly_aligned = hourly;
    align_interval(&mut hourly_aligned);
    ensure!(!hourly_aligned.is_empty(), "No aligned 1h series");
    ensure!(!quarter.is_empty(), "No aligned 15m series");
    ensure!(!four_hour.is_empty(), "No aligned 4h series");

    // Restrict every interval to the symbol set available in all three.
    let names_15m: std::collections::BTreeSet<String> =
        quarter.iter().map(|s| s.symbol.clone()).collect();
    let names_4h: std::collections::BTreeSet<String> =
        four_hour.iter().map(|s| s.symbol.clone()).collect();
    let common: Vec<String> = hourly_aligned
        .iter()
        .map(|s| s.symbol.clone())
        .filter(|name| names_15m.contains(name) && names_4h.contains(name))
        .collect();
    ensure!(common.len() >= 5, "Only {} common symbols", common.len());
    let pick = |list: &[Series]| -> Vec<Series> {
        list.iter()
            .filter(|series| common.contains(&series.symbol))
            .cloned()
            .collect()
    };
    let hourly = pick(&hourly_aligned);
    let quarter = pick(&quarter);
    let four_hour = pick(&four_hour);
    println!(
        "sweep universe: {} symbols; bars per interval: 15m={}, 1h={}, 4h={}",
        common.len(),
        quarter[0].len(),
        hourly[0].len(),
        four_hour[0].len()
    );

    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut results: Vec<ComboResult> = Vec::new();
    for combo in COMBOS {
        let (series_list, interval, horizon_bars, train_hours) = match combo.interval {
            "15m" => (
                &quarter,
                "15m",
                (combo.horizon_ms() / (HOUR / 4)) as usize,
                args.train_hours_15m,
            ),
            "1h" => (
                &hourly,
                "1h",
                (combo.horizon_ms() / HOUR) as usize,
                args.train_hours,
            ),
            "4h" => (
                &four_hour,
                "4h",
                (combo.horizon_ms() / (4 * HOUR)) as usize,
                args.train_hours,
            ),
            _ => unreachable!("unknown interval"),
        };
        let horizon_bars = horizon_bars.max(1);
        let result = run_combo(
            &runtime,
            &series_list,
            interval,
            &combo.horizon_label(),
            horizon_bars,
            train_hours,
            args.test_hours,
            &args,
            cost,
        )?;
        println!(
            "{:>4} → {:>3} | folds {:>2} | samples {:>5} | IC {:+.3} | acc {:.1}% | net {} | gross {}",
            interval,
            combo.horizon_label(),
            result.folds,
            result.samples,
            result.mean_ic,
            result.directional_accuracy * 100.0,
            pct(result.net_return),
            pct(result.gross_return)
        );
        results.push(result);
    }
    results.sort_by(|a, b| b.mean_ic.total_cmp(&a.mean_ic));

    let report = json!({
        "schema_version": 1,
        "generated_at": nofx_core::iso(chrono::Utc::now().timestamp_millis()),
        "research_only": true,
        "orders_enabled": false,
        "ranking_metric": "out_of_sample_information_coefficient",
        "config": {
            "symbols": common,
            "test_hours": args.test_hours,
            "train_hours_1h_4h": args.train_hours,
            "train_hours_15m": args.train_hours_15m,
            "threshold_multiple": args.threshold_multiple,
            "iterations": args.iterations,
            "lightgbm_parameters": ml_lightgbm::REGRESSION_PARAMETERS,
            "cost": {
                "fee_bps": cost.fee_bps,
                "slippage_bps": cost.slippage_bps,
                "round_trip_bps": cost.round_trip() * 10_000.0,
            },
            "note_4h": "4h bars are losslessly aggregated from the 1h archive; features use the same bar-based template on every interval",
        },
        "results": results,
        "runtime_ms": started.elapsed().as_secs_f64() * 1000.0,
    });
    fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;

    let mut markdown = String::new();
    markdown.push_str("# K 线周期 × 预测周期：哪个组合预测更准？\n\n");
    markdown.push_str(&format!(
        "- 标的 {} 个；每折滚动训练 → 样本外测试 {}h（窗口零重叠、标签折内到期）\n",
        common.len(),
        args.test_hours
    ));
    markdown.push_str(&format!(
        "- 训练窗口：1h/4h 用 {}h（约 {:.0} 天），15m 用 {}h（约 {:.0} 天，本地 15m 归档共 88 天）\n",
        args.train_hours,
        args.train_hours as f64 / 24.0,
        args.train_hours_15m,
        args.train_hours_15m as f64 / 24.0
    ));
    markdown.push_str(&format!(
        "- 排名指标：样本外 IC（预测值与实际未来收益的相关系数，越高越准）；同时给出方向准确率与扣 22bps 往返成本后的净收益\n\n"
    ));
    markdown.push_str("| 排名 | K 线周期 | 预测周期 | 样本外 IC | IC 95%区间 | IC>0 折数 | 方向准确率 | 净收益(成本后) | 毛收益 | Sharpe | 换手 | 折数 | 样本数 |\n");
    markdown.push_str("| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    for (index, result) in results.iter().enumerate() {
        let ci = 2.0 * result.ic_standard_error;
        markdown.push_str(&format!(
            "| {} | {} | {} | {:+.3} | ±{:.3}{} | {}/{} | {:.1}% | {} | {} | {} | {:.1} | {} | {} |\n",
            index + 1,
            result.interval,
            result.horizon,
            result.mean_ic,
            ci,
            if result.significant { " ★" } else { "" },
            result.folds_positive_ic,
            result.folds,
            result.directional_accuracy * 100.0,
            pct(result.net_return),
            pct(result.gross_return),
            format!("{:.2}", result.sharpe),
            result.turnover,
            result.folds,
            result.samples
        ));
    }
    let best = &results[0];
    markdown.push_str(&format!(
        "\n**结论：样本外 IC 最高的组合是 {} K 线 → 预测 {}**（IC {:+.3}，方向准确率 {:.1}%，净收益 {}）。\n\n",
        best.interval,
        best.horizon,
        best.mean_ic,
        best.directional_accuracy * 100.0,
        pct(best.net_return)
    ));
    markdown.push_str("注意：\n\n");
    markdown.push_str("- 1 分钟 / 5 分钟 K 线本地没有归档、采集器也不支持该粒度，未纳入本轮对比；15m 归档只有 88 天，训练窗口短于 1h/4h，属数据可得性差异。\n");
    markdown.push_str("- IC 是同一批标的、同一套 bar-based 特征（256 根 K 线前缀）下的相关系数；净收益按每边 11bps 计费，周期越短换手越高，成本拖累越大。\n");
    markdown.push_str("- 方向准确率只统计 |预测| 超过往返成本的决策，空仓决策不计入。\n");
    markdown.push_str("- ★ 表示 |IC| 超过 2/√样本数（忽略标的间相关性后的宽松下限）；同一时刻 16 个标的市场方向高度相关，真实标准误比该值大数倍，因此即使标 ★ 也不足以认定信号真实有效。IC 的经济含义比显著性更重要：IC=0.013 意味着预测与结果只有 1.3% 的相关性。\n");
    fs::write(output_dir.join("report.md"), markdown)?;
    println!("written: {}", output_dir.display());
    Ok(())
}
