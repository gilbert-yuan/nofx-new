//! Rolling walk-forward LightGBM benchmark against a simple trend baseline.
//!
//! Offline research only: no exchange, account or order APIs are touched.
//!
//! Usage:
//!   cargo run --release --bin nofx-ml-rolling-benchmark -- \
//!     --data-dir data/ml/expanded-archive-20261016 \
//!     --output-dir output/rolling-benchmark

use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{
    ml_lightgbm::{self, LightGbmRegressor, LightGbmRuntime},
    rolling_bench::{self, CostModel, Fold, Performance, Series, Simulation},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

#[derive(Parser)]
#[command(
    about = "Train LightGBM on Binance hourly klines and compare rolling out-of-sample net returns with a trend baseline"
)]
struct Args {
    /// Archive root containing `symbols/*.json` with `datasets.1h`.
    #[arg(long, default_value = "data/ml/expanded-archive-20261016")]
    data_dir: PathBuf,
    #[arg(long)]
    output_dir: Option<PathBuf>,
    #[arg(long, default_value = ml_lightgbm::DEFAULT_RUNTIME_PATH)]
    runtime: PathBuf,
    /// Explicit universe; empty selects the most liquid symbols automatically.
    #[arg(long, value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long, default_value_t = 20)]
    universe_size: usize,
    /// Training window in hours (purged by the label horizon).
    #[arg(long, default_value_t = 1080)]
    train_hours: i64,
    /// Out-of-sample testing window in hours, must be a multiple of `horizon`.
    #[arg(long, default_value_t = 336)]
    test_hours: i64,
    /// Forward-return label horizon and position holding period, in hours.
    #[arg(long, default_value_t = 12)]
    horizon: i64,
    #[arg(long, default_value_t = 6.0)]
    fee_bps: f64,
    #[arg(long, default_value_t = 5.0)]
    slippage_bps: f64,
    /// The model only opens a position when |prediction| exceeds this multiple of
    /// the round-trip cost. Trend and buy-and-hold always trade their own signal.
    #[arg(long, default_value_t = 1.0)]
    threshold_multiple: f64,
    #[arg(long, default_value_t = 24)]
    trend_fast: usize,
    #[arg(long, default_value_t = 96)]
    trend_slow: usize,
    #[arg(long, default_value_t = 120)]
    iterations: usize,
}

#[derive(Clone, Debug, Serialize)]
struct DecisionMix {
    long: usize,
    short: usize,
    flat: usize,
    mean_abs_prediction: f64,
}

impl DecisionMix {
    fn total(&self) -> usize {
        self.long + self.short + self.flat
    }
    fn accumulate(&mut self, other: &DecisionMix) {
        self.long += other.long;
        self.short += other.short;
        self.flat += other.flat;
        self.mean_abs_prediction += other.mean_abs_prediction;
    }
}

struct FoldBundle {
    fold: Fold,
    train_rows: usize,
    model_iterations: usize,
    train_ms: f64,
    model_runs: Vec<Simulation>,
    trend_runs: Vec<Simulation>,
    hold_runs: Vec<Simulation>,
    model: Simulation,
    trend: Simulation,
    buy_hold: Simulation,
    model_decisions: DecisionMix,
    trend_decisions: DecisionMix,
    /// Out-of-sample rank correlation between prediction and realized return.
    ic: f64,
    directional_accuracy: f64,
    samples: usize,
}

#[derive(Clone, Debug, Serialize)]
struct FoldReport {
    index: usize,
    train_start: String,
    train_end: String,
    test_start: String,
    test_end: String,
    train_rows: usize,
    model_iterations: usize,
    model_train_ms: f64,
    model: Performance,
    trend: Performance,
    buy_hold: Performance,
    model_decisions: DecisionMix,
    trend_decisions: DecisionMix,
    ic: f64,
    directional_accuracy: f64,
    samples: usize,
}

#[derive(Clone, Debug, Serialize)]
struct SymbolReport {
    symbol: String,
    median_hourly_quote_volume_usdt: f64,
    model: Performance,
    trend: Performance,
    buy_hold: Performance,
}

fn read_hourly_rows(path: &Path) -> Result<Vec<Value>> {
    let bytes = fs::read(path).with_context(|| format!("Read {}", path.display()))?;
    let value: Value =
        serde_json::from_slice(&bytes).with_context(|| format!("Parse {}", path.display()))?;
    let rows = value
        .get("datasets")
        .and_then(|datasets| datasets.get("1h"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(rows)
}

fn median_hourly_quote_volume(rows: &[Value]) -> f64 {
    let mut values: Vec<f64> = rows
        .iter()
        .filter_map(|row| row.get("quoteVolume").and_then(Value::as_f64))
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect();
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).expect("finite quote volumes"));
    values[values.len() / 2]
}

/// Explicit list, or the `universe_size` most liquid symbols that share the
/// archive's dominant coverage window. Time alignment is decided before loading
/// rows so a newer listing cannot silently shrink the universe.
fn load_universe(
    data_dir: &Path,
    explicit: &[String],
    universe_size: usize,
) -> Result<Vec<(String, f64, PathBuf)>> {
    ensure!(universe_size > 0, "universe_size must be positive");
    let symbol_dir = data_dir.join("symbols");
    if !explicit.is_empty() {
        let mut selected = Vec::new();
        for symbol in explicit {
            let path = symbol_dir.join(format!("{symbol}.json"));
            ensure!(path.is_file(), "Missing symbol file {}", path.display());
            let rows = read_hourly_rows(&path)?;
            ensure!(!rows.is_empty(), "{symbol}: empty hourly dataset");
            selected.push((symbol.clone(), median_hourly_quote_volume(&rows), path));
        }
        selected.sort_by(|a, b| b.1.partial_cmp(&a.1).expect("finite liquidity"));
        return Ok(selected);
    }

    struct Candidate {
        symbol: String,
        path: PathBuf,
        liquidity: f64,
        first_ms: i64,
        bars: usize,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut scanned = 0usize;
    for entry in
        fs::read_dir(&symbol_dir).with_context(|| format!("List {}", symbol_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Some(symbol) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Ok(rows) = read_hourly_rows(&path) else {
            continue;
        };
        scanned += 1;
        if rows.len() <= 300 {
            continue;
        }
        let Some(first_ms) = rows
            .first()
            .and_then(|row| row.get("openTime"))
            .and_then(Value::as_i64)
        else {
            continue;
        };
        let liquidity = median_hourly_quote_volume(&rows);
        if liquidity <= 0.0 {
            continue;
        }
        candidates.push(Candidate {
            symbol: symbol.to_string(),
            path,
            liquidity,
            first_ms,
            bars: rows.len(),
        });
    }
    ensure!(!candidates.is_empty(), "No symbol with usable hourly data");

    // Group by exact coverage; the dominant group is the full-archive cohort.
    let mut groups: std::collections::BTreeMap<(i64, usize), (usize, f64)> =
        std::collections::BTreeMap::new();
    for candidate in &candidates {
        let entry = groups
            .entry((candidate.first_ms, candidate.bars))
            .or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += candidate.liquidity;
    }
    let (&(first_ms, bars), _) = groups
        .iter()
        .max_by(|a, b| a.1.0.cmp(&b.1.0).then(a.1.1.total_cmp(&b.1.1)))
        .expect("non-empty groups");

    let mut aligned: Vec<Candidate> = candidates
        .into_iter()
        .filter(|candidate| candidate.first_ms == first_ms && candidate.bars == bars)
        .collect();
    let excluded = scanned.saturating_sub(aligned.len());
    aligned.sort_by(|a, b| b.liquidity.partial_cmp(&a.liquidity).expect("finite"));
    aligned.truncate(universe_size);
    println!(
        "universe scan: {scanned} files parsed, {excluded} excluded for partial history, \
         kept {} symbols on the {bars}-bar window from {}",
        aligned.len(),
        iso(first_ms)
    );
    Ok(aligned
        .into_iter()
        .map(|candidate| (candidate.symbol, candidate.liquidity, candidate.path))
        .collect())
}

fn prefix_sums(closes: &[f64]) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(closes.len() + 1);
    prefix.push(0.0);
    for close in closes {
        prefix.push(prefix.last().copied().unwrap_or(0.0) + close);
    }
    prefix
}

fn sma(prefix: &[f64], index: usize, window: usize) -> Option<f64> {
    if window == 0 || index + 1 < window {
        return None;
    }
    Some((prefix[index + 1] - prefix[index + 1 - window]) / window as f64)
}

fn decision_grid(series: &Series, fold: &Fold, horizon: usize) -> Vec<usize> {
    let (Some(start), Some(last)) = (
        series.index_of(fold.test_start_ms),
        series.index_of(fold.test_end_ms - rolling_bench::HOUR_MS),
    ) else {
        return Vec::new();
    };
    let mut origins = Vec::new();
    let mut origin = start;
    while origin + horizon <= last {
        if series.features[origin].is_some() {
            origins.push(origin);
        }
        origin += horizon;
    }
    origins
}

/// Pearson correlation; zero when either side has no variance.
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

/// Share of tradeable predictions whose sign matches the realized return.
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

fn mix(decisions: &[(usize, f64)], mean_abs_prediction: f64) -> DecisionMix {
    let mut bundle = DecisionMix {
        long: 0,
        short: 0,
        flat: 0,
        mean_abs_prediction,
    };
    for &(_, position) in decisions {
        if position > 0.0 {
            bundle.long += 1;
        } else if position < 0.0 {
            bundle.short += 1;
        } else {
            bundle.flat += 1;
        }
    }
    bundle
}

fn run_fold(
    runtime: &Arc<LightGbmRuntime>,
    series_list: &[Series],
    fold: &Fold,
    args: &Args,
    cost: CostModel,
) -> Result<FoldBundle> {
    let horizon = args.horizon as usize;
    let mut features: Vec<Vec<f64>> = Vec::new();
    let mut targets: Vec<f64> = Vec::new();
    for series in series_list {
        let (Some(start), Some(last)) = (
            series.index_of(fold.train_start_ms),
            series.index_of(fold.train_end_ms - rolling_bench::HOUR_MS),
        ) else {
            continue;
        };
        for origin in start..=last {
            if origin + horizon > last {
                break;
            }
            let Some(vector) = series.features[origin].as_ref() else {
                continue;
            };
            let target = series.close[origin + horizon] / series.close[origin] - 1.0;
            if target.is_finite() {
                features.push(vector.clone());
                targets.push(target);
            }
        }
    }
    ensure!(
        features.len() >= ml_lightgbm::MIN_TRAIN_ROWS,
        "Fold {} has only {} training rows",
        fold.index,
        features.len()
    );
    let trained = Instant::now();
    let mut model = LightGbmRegressor::train_config(
        runtime.clone(),
        &features,
        &targets,
        ml_lightgbm::REGRESSION_PARAMETERS,
        args.iterations,
    )
    .with_context(|| format!("Fold {} training failed", fold.index))?;
    let train_ms = trained.elapsed().as_secs_f64() * 1000.0;
    let train_rows = features.len();
    let iterations = model.summary().iterations;

    let threshold = args.threshold_multiple * cost.round_trip();
    let test_bars = ((fold.test_end_ms - fold.test_start_ms) / rolling_bench::HOUR_MS) as usize;
    let mut model_runs = Vec::with_capacity(series_list.len());
    let mut trend_runs = Vec::with_capacity(series_list.len());
    let mut hold_runs = Vec::with_capacity(series_list.len());
    let mut model_decisions = DecisionMix {
        long: 0,
        short: 0,
        flat: 0,
        mean_abs_prediction: 0.0,
    };
    let mut trend_decisions = model_decisions.clone();
    let mut pairs: Vec<(f64, f64)> = Vec::new();

    for series in series_list {
        let origins = decision_grid(series, fold, horizon);
        ensure!(
            !origins.is_empty(),
            "{}: fold {} has no eligible decision bar",
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
        ensure!(
            predictions.len() == origins.len(),
            "{}: prediction count mismatch",
            series.symbol
        );

        let model_plan: Vec<(usize, f64)> = origins
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
            let realized = series.close[origin + horizon] / series.close[origin] - 1.0;
            if realized.is_finite() {
                pairs.push((prediction, realized));
            }
        }

        let prefix = prefix_sums(&series.close);
        let trend_plan: Vec<(usize, f64)> = origins
            .iter()
            .map(|&origin| {
                let fast = sma(&prefix, origin, args.trend_fast).unwrap_or(0.0);
                let slow = sma(&prefix, origin, args.trend_slow).unwrap_or(0.0);
                let position = if fast > slow {
                    1.0
                } else if fast < slow {
                    -1.0
                } else {
                    0.0
                };
                (origin, position)
            })
            .collect();

        let hold_plan = vec![(
            series.index_of(fold.test_start_ms).expect("fold start"),
            1.0,
        )];

        let model_target = rolling_bench::settle_positions(series.len(), &model_plan, horizon)?;
        let trend_target = rolling_bench::settle_positions(series.len(), &trend_plan, horizon)?;
        let hold_target =
            rolling_bench::settle_positions(series.len(), &hold_plan, test_bars.saturating_sub(1))?;

        model_runs.push(rolling_bench::simulate_positions(
            series,
            fold,
            &model_target,
            cost,
        )?);
        trend_runs.push(rolling_bench::simulate_positions(
            series,
            fold,
            &trend_target,
            cost,
        )?);
        hold_runs.push(rolling_bench::simulate_positions(
            series,
            fold,
            &hold_target,
            cost,
        )?);

        let mean_abs = if predictions.is_empty() {
            0.0
        } else {
            predictions.iter().map(|value| value.abs()).sum::<f64>() / predictions.len() as f64
        };
        let symbol_mix = mix(&model_plan, mean_abs);
        model_decisions.accumulate(&symbol_mix);
        trend_decisions.accumulate(&mix(&trend_plan, 0.0));
    }
    let symbols = series_list.len().max(1) as f64;
    model_decisions.mean_abs_prediction /= symbols;
    trend_decisions.mean_abs_prediction = 0.0;
    let predicted: Vec<f64> = pairs.iter().map(|(prediction, _)| *prediction).collect();
    let realized: Vec<f64> = pairs.iter().map(|(_, observed)| *observed).collect();
    let ic = correlation(&predicted, &realized);
    let accuracy = directional_accuracy(&pairs, threshold);

    Ok(FoldBundle {
        fold: *fold,
        train_rows,
        model_iterations: iterations,
        train_ms,
        model: rolling_bench::aggregate(&model_runs)?,
        trend: rolling_bench::aggregate(&trend_runs)?,
        buy_hold: rolling_bench::aggregate(&hold_runs)?,
        model_runs,
        trend_runs,
        hold_runs,
        model_decisions,
        trend_decisions,
        ic,
        directional_accuracy: accuracy,
        samples: pairs.len(),
    })
}

fn pct(value: f64) -> String {
    format!("{:+.2}%", value * 100.0)
}

fn decimal(value: f64) -> String {
    format!("{value:.3}")
}

fn iso(ms: i64) -> String {
    nofx_core::iso(ms)
}

fn fold_reports(bundles: &[FoldBundle]) -> Vec<FoldReport> {
    bundles
        .iter()
        .map(|bundle| FoldReport {
            index: bundle.fold.index,
            train_start: iso(bundle.fold.train_start_ms),
            train_end: iso(bundle.fold.train_end_ms),
            test_start: iso(bundle.fold.test_start_ms),
            test_end: iso(bundle.fold.test_end_ms),
            train_rows: bundle.train_rows,
            model_iterations: bundle.model_iterations,
            model_train_ms: bundle.train_ms,
            model: bundle.model.performance(),
            trend: bundle.trend.performance(),
            buy_hold: bundle.buy_hold.performance(),
            model_decisions: bundle.model_decisions.clone(),
            trend_decisions: bundle.trend_decisions.clone(),
            ic: bundle.ic,
            directional_accuracy: bundle.directional_accuracy,
            samples: bundle.samples,
        })
        .collect()
}

fn per_symbol_reports(
    bundles: &[FoldBundle],
    series_list: &[Series],
    liquidity: &[f64],
) -> Result<Vec<SymbolReport>> {
    let mut reports = Vec::with_capacity(series_list.len());
    for (index, series) in series_list.iter().enumerate() {
        let model = rolling_bench::concatenate(
            &bundles
                .iter()
                .map(|bundle| bundle.model_runs[index].clone())
                .collect::<Vec<_>>(),
        )?;
        let trend = rolling_bench::concatenate(
            &bundles
                .iter()
                .map(|bundle| bundle.trend_runs[index].clone())
                .collect::<Vec<_>>(),
        )?;
        let hold = rolling_bench::concatenate(
            &bundles
                .iter()
                .map(|bundle| bundle.hold_runs[index].clone())
                .collect::<Vec<_>>(),
        )?;
        reports.push(SymbolReport {
            symbol: series.symbol.clone(),
            median_hourly_quote_volume_usdt: liquidity[index],
            model: model.performance(),
            trend: trend.performance(),
            buy_hold: hold.performance(),
        });
    }
    Ok(reports)
}

fn write_markdown(
    path: &Path,
    args: &Args,
    cost: CostModel,
    data_start: i64,
    data_end: i64,
    symbols: &[String],
    folds: &[FoldReport],
    model: &Performance,
    trend: &Performance,
    hold: &Performance,
    per_symbol: &[SymbolReport],
    model_iterations: usize,
    model_mix: &DecisionMix,
) -> Result<()> {
    let mut text = String::new();
    let bars = (data_end - data_start) / rolling_bench::HOUR_MS;
    text.push_str("# LightGBM 滚动窗口回测 vs 简单趋势策略\n\n");
    text.push_str(&format!(
        "- 数据：币安 USD-M 永续 1h K 线归档，{} → {}（{} 小时 / {:.1} 天）\n",
        iso(data_start),
        iso(data_end),
        bars,
        bars as f64 / 24.0
    ));
    text.push_str(&format!(
        "- 标的 {} 个（按小时成交额中位数取前 {}）：{}\n",
        symbols.len(),
        symbols.len(),
        symbols.join(", ")
    ));
    text.push_str(&format!(
        "- 滚动窗口：训练 {}h → 测试 {}h，标签/持仓周期 {}h，样本外 {} 折（测试窗口零重叠）\n",
        args.train_hours,
        args.test_hours,
        args.horizon,
        folds.len()
    ));
    text.push_str(&format!(
        "- 成本：taker {:.1}bps + 滑点 {:.1}bps = {:.1}bps/边，往返 {:.1}bps，两策略共用同一成本模型\n",
        cost.fee_bps,
        cost.slippage_bps,
        cost.fee_bps + cost.slippage_bps,
        cost.round_trip() * 10_000.0
    ));
    text.push_str(&format!(
        "- 模型：LightGBM 回归（{} 棵树、25 个因果特征、CPU 多线程），仅当 |预测 {}h 收益| > {:.2}% 时持仓\n",
        model_iterations,
        args.horizon,
        args.threshold_multiple * cost.round_trip() * 100.0
    ));
    text.push_str(&format!(
        "- 基准：SMA{}/{} 趋势（同一天然 12h 决策网格、同一持仓周期、同一成本）\n\n",
        args.trend_fast, args.trend_slow
    ));

    text.push_str("## 样本外总体表现（等权组合，成本后）\n\n");
    text.push_str(
        "| 策略 | 净收益 | 年化 | Sharpe | 最大回撤 | 成本拖累（百分点） | 换手 | 持仓占比 |\n",
    );
    text.push_str("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    let rows = [
        ("LightGBM（滚动样本外）".to_string(), model),
        (
            format!("趋势基准 SMA{}/{}", args.trend_fast, args.trend_slow),
            trend,
        ),
        ("买入持有".to_string(), hold),
    ];
    for (name, performance) in rows.iter() {
        text.push_str(&format!(
            "| {} | {} | {} | {} | {:.2}% | {:.2} | {:.2} | {:.1}% |\n",
            name,
            pct(performance.net_return),
            pct(performance.annualized_return),
            decimal(performance.sharpe),
            performance.max_drawdown * 100.0,
            performance.cost_drag * 100.0,
            performance.turnover,
            performance.exposure * 100.0
        ));
    }
    text.push_str(&format!(
        "\nLightGBM 相对趋势基准的样本外净收益差：**{}**。\n\n",
        pct(model.net_return - trend.net_return)
    ));

    text.push_str("## 逐折样本外净收益\n\n");
    text.push_str("| 折 | 测试区间 | LightGBM | 趋势 | 差 | 买入持有 | 训练行数 | 模型持仓占比 | 预测 IC | 方向准确率 |\n");
    text.push_str("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    for fold in folds {
        text.push_str(&format!(
            "| {} | {} → {} | {} | {} | {} | {} | {} | {:.1}% | {:+.3} | {:.1}% |\n",
            fold.index,
            &fold.test_start[..10],
            &fold.test_end[..10],
            pct(fold.model.net_return),
            pct(fold.trend.net_return),
            pct(fold.model.net_return - fold.trend.net_return),
            pct(fold.buy_hold.net_return),
            fold.train_rows,
            fold.model.exposure * 100.0,
            fold.ic,
            fold.directional_accuracy * 100.0
        ));
    }
    let model_wins = folds
        .iter()
        .filter(|fold| fold.model.net_return > fold.trend.net_return)
        .count();
    let samples: usize = folds.iter().map(|fold| fold.samples).sum();
    let weighted_ic = if samples == 0 {
        0.0
    } else {
        folds
            .iter()
            .map(|fold| fold.ic * fold.samples as f64)
            .sum::<f64>()
            / samples as f64
    };
    let weighted_accuracy = if samples == 0 {
        0.0
    } else {
        folds
            .iter()
            .map(|fold| fold.directional_accuracy * fold.samples as f64)
            .sum::<f64>()
            / samples as f64
    };
    text.push_str(&format!(
        "\nLightGBM 在 {} / {} 折中跑赢趋势基准；样本外预测 IC = {:+.3}（预测与未来 {}h 收益的相关系数，{} 个决策样本），方向准确率 {:.1}%。\n\n",
        model_wins,
        folds.len(),
        weighted_ic,
        args.horizon,
        samples,
        weighted_accuracy * 100.0
    ));

    text.push_str("## 逐标的表现（全部样本外折拼接）\n\n");
    text.push_str(
        "| 标的 | 小时成交额中位数 | LightGBM | 趋势 | 买入持有 | 模型 Sharpe | 趋势 Sharpe |\n",
    );
    text.push_str("| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    for report in per_symbol {
        text.push_str(&format!(
            "| {} | {:.0}M | {} | {} | {} | {} | {} |\n",
            report.symbol,
            report.median_hourly_quote_volume_usdt / 1e6,
            pct(report.model.net_return),
            pct(report.trend.net_return),
            pct(report.buy_hold.net_return),
            decimal(report.model.sharpe),
            decimal(report.trend.sharpe)
        ));
    }
    let symbol_wins = per_symbol
        .iter()
        .filter(|report| report.model.net_return > report.trend.net_return)
        .count();
    text.push_str(&format!(
        "\n按标的配对比较：LightGBM 在 {} / {} 个标的上净收益更高。\n\n",
        symbol_wins,
        per_symbol.len()
    ));

    text.push_str("## 读数与口径\n\n");
    text.push_str(&format!(
        "- 扣费前：LightGBM {:+.2}% / 趋势 {:+.2}% / 买入持有 {:+.2}%；扣费后 {} / {} / {}。\n",
        model.gross_return * 100.0,
        trend.gross_return * 100.0,
        hold.gross_return * 100.0,
        pct(model.net_return),
        pct(trend.net_return),
        pct(hold.net_return)
    ));
    text.push_str(&format!(
        "- 决策分布：做多 {} / 做空 {} / 空仓 {}，平均 |预测 {}h 收益| = {:.3}%。\n",
        model_mix.long,
        model_mix.short,
        model_mix.flat,
        args.horizon,
        model_mix.mean_abs_prediction * 100.0
    ));
    text.push_str(&format!(
        "- 成本拖累：LightGBM {:.2} 个百分点 vs 趋势 {:.2} 个百分点（换手 {:.1} vs {:.1}，成本随换手线性累加）。\n",
        model.cost_drag * 100.0,
        trend.cost_drag * 100.0,
        model.turnover,
        trend.turnover
    ));
    text.push_str(&format!(
        "- 收益质量：每 bar 胜率 {:.1}% vs {:.1}%，年化波动 {:.1}% vs {:.1}%。\n",
        model.positive_bar_rate * 100.0,
        trend.positive_bar_rate * 100.0,
        model.annualized_volatility * 100.0,
        trend.annualized_volatility * 100.0
    ));
    text.push_str(
        "- 无前视：特征只用收盘前缀；训练标签在训练窗口内到期；测试窗口不重叠且持仓在折内平掉。\n",
    );
    text.push_str(
        "- 未计资金费率：归档不含历史 funding，故多空对称地只收手续费与滑点；实盘年化差异会随持仓方向与费率波动。\n",
    );
    text.push_str("- 杠杆 1x（每标的等权名义 1），不做波动率目标与再平衡成本。\n");
    text.push_str(
        "- 标的池按成交额自动选取，可能包含 XAUUSDT / XAGUSDT / CLUSDT / BZUSDT 等非加密永续；需要纯加密口径时用 --symbols 显式指定。\n",
    );
    fs::write(path, text).with_context(|| format!("Write {}", path.display()))?;
    Ok(())
}

fn write_equity_csv(
    path: &Path,
    model: &Simulation,
    trend: &Simulation,
    hold: &Simulation,
) -> Result<()> {
    let mut file = fs::File::create(path).with_context(|| format!("Create {}", path.display()))?;
    writeln!(
        file,
        "time_ms,time,model_equity,trend_equity,buy_hold_equity"
    )?;
    let mut model_equity = 1.0;
    let mut trend_equity = 1.0;
    let mut hold_equity = 1.0;
    for bar in 0..model.net.len() {
        model_equity *= 1.0 + model.net[bar];
        trend_equity *= 1.0 + trend.net[bar];
        hold_equity *= 1.0 + hold.net[bar];
        writeln!(
            file,
            "{},{},{:.6},{:.6},{:.6}",
            model.times_ms[bar],
            iso(model.times_ms[bar]),
            model_equity,
            trend_equity,
            hold_equity
        )?;
    }
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    let cost = CostModel {
        fee_bps: args.fee_bps,
        slippage_bps: args.slippage_bps,
    };
    cost.validate()?;
    ensure!(
        args.test_hours % args.horizon == 0,
        "test_hours must be a multiple of horizon"
    );
    ensure!(
        args.horizon >= 1 && args.horizon <= args.test_hours,
        "horizon must fit inside the test window"
    );
    ensure!(
        args.trend_fast > 0 && args.trend_fast < args.trend_slow,
        "trend_fast must be smaller than trend_slow"
    );

    let output_dir = args.output_dir.clone().unwrap_or_else(|| {
        PathBuf::from(format!(
            "output/rolling-benchmark-{}",
            chrono::Utc::now().format("%Y%m%d")
        ))
    });
    fs::create_dir_all(&output_dir)?;

    let started = Instant::now();
    let candidates = load_universe(&args.data_dir, &args.symbols, args.universe_size)?;
    let mut loaded: Vec<(Series, f64)> = Vec::new();
    for (symbol, volume, path) in &candidates {
        let rows = read_hourly_rows(path)?;
        match rolling_bench::build_series(symbol, &rows) {
            Ok(series) => loaded.push((series, *volume)),
            Err(error) => println!("skip {symbol}: {error}"),
        }
    }
    ensure!(!loaded.is_empty(), "No usable symbol in the universe");

    let reference_len = loaded[0].0.len();
    let reference_start = loaded[0].0.open_ms[0];
    let reference_end = *loaded[0].0.open_ms.last().expect("non-empty");
    let total = loaded.len();
    loaded.retain(|(series, _)| {
        series.len() == reference_len
            && series.open_ms.first() == Some(&reference_start)
            && series.open_ms.last() == Some(&reference_end)
    });
    let skipped = total - loaded.len();
    ensure!(!loaded.is_empty(), "No time-aligned symbol remains");
    let series_list: Vec<Series> = loaded.iter().map(|(series, _)| series.clone()).collect();
    let liquidity: Vec<f64> = loaded.iter().map(|(_, volume)| *volume).collect();
    let data_start = reference_start;
    let data_end = reference_end + rolling_bench::HOUR_MS;
    println!(
        "aligned universe: {} symbols x {} bars, skipped {} misaligned, span {} → {}",
        series_list.len(),
        reference_len,
        skipped,
        iso(data_start),
        iso(data_end)
    );

    let folds = rolling_bench::plan_folds(data_start, data_end, args.train_hours, args.test_hours)?;
    println!("walk-forward folds: {}", folds.len());

    let runtime = LightGbmRuntime::load(&args.runtime)?;
    let mut bundles: Vec<FoldBundle> = Vec::with_capacity(folds.len());
    for fold in &folds {
        let bundle = run_fold(&runtime, &series_list, fold, &args, cost)?;
        println!(
            "fold {:>2} {} → {} | rows {:>6} | model {:>8} | trend {:>8} | flat {}/{}",
            fold.index,
            &iso(fold.test_start_ms)[..10],
            &iso(fold.test_end_ms)[..10],
            bundle.train_rows,
            pct(bundle.model.performance().net_return),
            pct(bundle.trend.performance().net_return),
            bundle.model_decisions.flat,
            bundle.model_decisions.total()
        );
        bundles.push(bundle);
    }

    let model_total =
        rolling_bench::concatenate(&bundles.iter().map(|b| b.model.clone()).collect::<Vec<_>>())?;
    let trend_total =
        rolling_bench::concatenate(&bundles.iter().map(|b| b.trend.clone()).collect::<Vec<_>>())?;
    let hold_total = rolling_bench::concatenate(
        &bundles
            .iter()
            .map(|b| b.buy_hold.clone())
            .collect::<Vec<_>>(),
    )?;
    let model_performance = model_total.performance();
    let trend_performance = trend_total.performance();
    let hold_performance = hold_total.performance();

    let mut model_mix = DecisionMix {
        long: 0,
        short: 0,
        flat: 0,
        mean_abs_prediction: 0.0,
    };
    let mut trend_mix = model_mix.clone();
    for bundle in &bundles {
        model_mix.accumulate(&bundle.model_decisions);
        trend_mix.accumulate(&bundle.trend_decisions);
    }
    model_mix.mean_abs_prediction /= bundles.len() as f64;
    trend_mix.mean_abs_prediction = 0.0;

    let reports = fold_reports(&bundles);
    let per_symbol = per_symbol_reports(&bundles, &series_list, &liquidity)?;
    let model_iterations = bundles
        .first()
        .map(|bundle| bundle.model_iterations)
        .unwrap_or(0);
    let symbols: Vec<String> = series_list.iter().map(|s| s.symbol.clone()).collect();

    let model_wins = reports
        .iter()
        .filter(|fold| fold.model.net_return > fold.trend.net_return)
        .count();
    let symbol_wins = per_symbol
        .iter()
        .filter(|report| report.model.net_return > report.trend.net_return)
        .count();
    let paired = json!({
        "fold_wins_model": model_wins,
        "fold_wins_trend": reports.len() - model_wins,
        "symbol_wins_model": symbol_wins,
        "symbol_wins_trend": per_symbol.len() - symbol_wins,
    });
    let signal_samples: usize = reports.iter().map(|fold| fold.samples).sum();
    let signal = json!({
        "samples": signal_samples,
        "mean_ic": if signal_samples == 0 { 0.0 } else {
            reports.iter().map(|fold| fold.ic * fold.samples as f64).sum::<f64>() / signal_samples as f64
        },
        "mean_directional_accuracy": if signal_samples == 0 { 0.0 } else {
            reports.iter().map(|fold| fold.directional_accuracy * fold.samples as f64).sum::<f64>() / signal_samples as f64
        },
    });

    let report = json!({
        "schema_version": 1,
        "generated_at": iso(chrono::Utc::now().timestamp_millis()),
        "research_only": true,
        "orders_enabled": false,
        "config": {
            "data_dir": args.data_dir.display().to_string(),
            "train_hours": args.train_hours,
            "test_hours": args.test_hours,
            "horizon_hours": args.horizon,
            "trend_fast": args.trend_fast,
            "trend_slow": args.trend_slow,
            "threshold_multiple": args.threshold_multiple,
            "iterations": args.iterations,
            "lightgbm_parameters": ml_lightgbm::REGRESSION_PARAMETERS,
            "feature_names": ml_features_names(),
        },
        "data": {
            "bars": reference_len,
            "start": iso(data_start),
            "end": iso(data_end),
            "symbols": symbols,
            "skipped_misaligned": skipped,
            "universe_rule": if args.symbols.is_empty() { "top median hourly quote volume" } else { "explicit" },
        },
        "cost_model": {
            "fee_bps": cost.fee_bps,
            "slippage_bps": cost.slippage_bps,
            "one_way_bps": cost.one_way() * 10_000.0,
            "round_trip_bps": cost.round_trip() * 10_000.0,
        },
        "folds": reports,
        "summary": {
            "model": model_performance,
            "trend": trend_performance,
            "buy_hold": hold_performance,
            "paired": paired,
            "model_signal": signal,
        },
        "per_symbol": per_symbol,
        "decisions": { "model": model_mix, "trend": trend_mix },
        "runtime_ms": started.elapsed().as_secs_f64() * 1000.0,
    });

    fs::write(
        output_dir.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    write_equity_csv(
        &output_dir.join("equity.csv"),
        &model_total,
        &trend_total,
        &hold_total,
    )?;
    write_markdown(
        &output_dir.join("report.md"),
        &args,
        cost,
        data_start,
        data_end,
        &symbols,
        &reports,
        &model_performance,
        &trend_performance,
        &hold_performance,
        &per_symbol,
        model_iterations,
        &model_mix,
    )?;

    println!("\n=== out-of-sample summary (net of cost) ===");
    println!(
        "LightGBM : net {:>8} | ann {:>8} | sharpe {:>6} | maxDD {:>6} | drag {:>6}",
        pct(model_performance.net_return),
        pct(model_performance.annualized_return),
        decimal(model_performance.sharpe),
        pct(-model_performance.max_drawdown),
        pct(-model_performance.cost_drag)
    );
    println!(
        "Trend    : net {:>8} | ann {:>8} | sharpe {:>6} | maxDD {:>6} | drag {:>6}",
        pct(trend_performance.net_return),
        pct(trend_performance.annualized_return),
        decimal(trend_performance.sharpe),
        pct(-trend_performance.max_drawdown),
        pct(-trend_performance.cost_drag)
    );
    println!(
        "Buy&Hold : net {:>8} | ann {:>8} | sharpe {:>6} | maxDD {:>6} | drag {:>6}",
        pct(hold_performance.net_return),
        pct(hold_performance.annualized_return),
        decimal(hold_performance.sharpe),
        pct(-hold_performance.max_drawdown),
        pct(-hold_performance.cost_drag)
    );
    println!(
        "edge vs trend: {} | folds {}/{} | symbols {}/{}",
        pct(model_performance.net_return - trend_performance.net_return),
        model_wins,
        reports.len(),
        symbol_wins,
        per_symbol.len()
    );
    println!("written: {}", output_dir.display());
    Ok(())
}

fn ml_features_names() -> Vec<String> {
    nofx_core::ml_features::BASE_FEATURE_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}
