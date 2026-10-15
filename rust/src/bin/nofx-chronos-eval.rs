//! Offline Chronos forecast evaluation. All trading execution is delegated to
//! the production Rust paper simulator; the model never sees future candles.
use anyhow::{Context, Result, bail, ensure};
use clap::Parser;
use nofx_core::{iso, now_ms, number, paper, research, simulator, timestamp};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf};

const HOUR: i64 = 3_600_000;
const HORIZON: usize = 12;
const HOLDOUT_START: i64 = 1_790_944_920_000;

#[derive(Parser)]
#[command(
    about = "Prepare prefix-only Chronos inputs or evaluate frozen forecasts with the shared Rust simulator"
)]
struct Args {
    #[arg(long, default_value = "output/profit-improvement-20261011/data")]
    data_dir: PathBuf,
    #[arg(long, default_value = "BTCUSDT,ETHUSDT", value_delimiter = ',')]
    symbols: Vec<String>,
    #[arg(long, default_value_t = 256)]
    context_length: usize,
    #[arg(long, conflicts_with = "forecasts")]
    prepare_inputs: Option<PathBuf>,
    #[arg(long, conflicts_with = "prepare_inputs")]
    forecasts: Option<PathBuf>,
    #[arg(
        long,
        default_value = "output/chronos-bolt-tiny-20261014/evaluation.json"
    )]
    output: PathBuf,
}

#[derive(Deserialize)]
struct Forecasts {
    schema_version: u32,
    model: String,
    interval: String,
    context_length: usize,
    #[serde(alias = "horizon_hours")]
    prediction_length: usize,
    #[serde(default = "reserved_holdout_start")]
    holdout_start_ms: i64,
    records: Vec<Forecast>,
}

#[derive(Deserialize)]
struct Forecast {
    symbol: String,
    origin_ms: i64,
    context_end_open_ms: i64,
    q10: Vec<f64>,
    q50: Vec<f64>,
    q90: Vec<f64>,
    #[serde(default)]
    history_sha256: Option<String>,
    #[serde(default, alias = "inference_ms")]
    latency_ms: Option<f64>,
}

fn reserved_holdout_start() -> i64 {
    HOLDOUT_START
}

#[derive(Default)]
struct Errors {
    count: usize,
    absolute: f64,
    percent: f64,
    covered: usize,
    width: f64,
    width_percent: f64,
    directional: usize,
    directional_count: usize,
}

impl Errors {
    fn add(&mut self, actual: f64, predicted: f64, last: f64, bounds: Option<(f64, f64)>) {
        self.count += 1;
        self.absolute += (actual - predicted).abs();
        self.percent += (actual - predicted).abs() / actual * 100.;
        if let Some((low, high)) = bounds {
            self.covered += usize::from(actual >= low && actual <= high);
            self.width += high - low;
            self.width_percent += (high - low) / last * 100.;
        }
        // Flat realized prices have no up/down direction. Exclude them from
        // directional accuracy instead of treating them as downward moves.
        // A flat forecast for a realized move stays in the denominator and
        // misses: abstaining must not inflate a model's hit rate.
        if actual != last {
            self.directional_count += 1;
            self.directional +=
                usize::from(predicted != last && (predicted > last) == (actual > last));
        }
    }

    fn output(&self, probabilistic: bool) -> Value {
        let mean = |sum: f64| (self.count > 0).then(|| sum / self.count as f64);
        json!({
            "observations":self.count,"mae":mean(self.absolute),"mape_percent":mean(self.percent),
            "direction_accuracy_percent":(self.directional_count>0).then(||self.directional as f64/self.directional_count as f64*100.),
            "direction_observations":self.directional_count,
            "empirical_80pct_interval_coverage_percent":if probabilistic{mean(self.covered as f64*100.)}else{None},
            "mean_interval_width":if probabilistic{mean(self.width)}else{None},
            "mean_interval_width_percent_of_last_close":if probabilistic{mean(self.width_percent)}else{None}
        })
    }

    fn persistence_output(&self) -> Value {
        let mut output = self.output(false);
        output["direction_accuracy_percent"] = Value::Null;
        output["direction_observations"] = json!(0);
        output["direction_note"] =
            json!("Persistence predicts zero change and has no directional forecast.");
        output
    }
}

#[derive(Default)]
struct Metrics {
    chronos_all: Errors,
    persistence_all: Errors,
    linear_all: Errors,
    chronos_endpoint: Errors,
    persistence_endpoint: Errors,
    linear_endpoint: Errors,
}

impl Metrics {
    fn output(&self) -> Value {
        json!({
            "all_12_steps":{"chronos":self.chronos_all.output(true),"persistence":self.persistence_all.persistence_output(),"linear_trend_last_24h":self.linear_all.output(false)},
            "step_12":{"chronos":self.chronos_endpoint.output(true),"persistence":self.persistence_endpoint.persistence_output(),"linear_trend_last_24h":self.linear_endpoint.output(false)}
        })
    }
}

fn read_rows(path: &PathBuf) -> Result<Vec<Value>> {
    let data: Value =
        serde_json::from_slice(&fs::read(path).with_context(|| path.display().to_string())?)?;
    let rows = data["datasets"]["1h"]
        .as_array()
        .context("dataset must contain datasets.1h")?
        .clone();
    ensure!(!rows.is_empty(), "empty 1h dataset");
    for row in &rows {
        ensure!(
            simulator::valid_candle(row),
            "invalid candle in {}",
            path.display()
        );
        ensure!(open(row)? % HOUR == 0, "non-hourly candle timestamp");
    }
    ensure!(
        rows.windows(2).all(|p| open(&p[1])
            .ok()
            .zip(open(&p[0]).ok())
            .is_some_and(|(b, a)| b - a == HOUR)),
        "1h history has gaps, duplicates or unsorted rows"
    );
    Ok(rows)
}

fn open(row: &Value) -> Result<i64> {
    timestamp(&row["openTime"]).context("invalid candle openTime")
}

fn close(row: &Value) -> f64 {
    number(&row["close"], f64::NAN)
}

fn prefix_sha(rows: &[Value]) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(rows).expect("JSON candles"),
    ))
}

fn origin_index(rows: &[Value], origin: i64) -> Result<usize> {
    rows.binary_search_by_key(&origin, |r| open(r).unwrap())
        .map_err(|_| anyhow::anyhow!("origin does not match a dataset candle: {origin}"))
}

fn validate_forecast(f: &Forecast, rows: &[Value], context: usize) -> Result<usize> {
    let end = origin_index(rows, f.origin_ms)?;
    ensure!(
        context >= 50 && end >= context,
        "insufficient closed context"
    );
    ensure!(
        end + HORIZON <= rows.len(),
        "forecast targets absent from dataset"
    );
    ensure!(
        f.context_end_open_ms == open(&rows[end - 1])?
            && f.context_end_open_ms + HOUR == f.origin_ms,
        "forecast context timestamp is not its closed prefix"
    );
    ensure!(
        f.origin_ms + HORIZON as i64 * HOUR <= HOLDOUT_START,
        "forecast evaluation would consume reserved holdout"
    );
    if let Some(expected) = &f.history_sha256 {
        ensure!(
            *expected == prefix_sha(&rows[..end]),
            "history SHA does not match frozen prefix"
        );
    }
    ensure!(
        [&f.q10, &f.q50, &f.q90]
            .iter()
            .all(|q| q.len() == HORIZON && q.iter().all(|x| x.is_finite() && *x > 0.)),
        "quantiles must be 12 positive finite hourly values"
    );
    ensure!(
        (0..HORIZON).all(|i| f.q10[i] <= f.q50[i] && f.q50[i] <= f.q90[i]),
        "crossed forecast quantiles"
    );
    ensure!(
        f.latency_ms.is_none_or(|x| x.is_finite() && x >= 0.),
        "invalid latency"
    );
    Ok(end)
}

fn linear_trend(rows: &[Value], step: usize) -> f64 {
    let sample = &rows[rows.len() - 24..];
    let mean = sample.iter().map(close).sum::<f64>() / 24.;
    let slope = sample
        .iter()
        .enumerate()
        .map(|(i, r)| (i as f64 - 11.5) * (close(r) - mean))
        .sum::<f64>()
        / (0..24).map(|i| (i as f64 - 11.5).powi(2)).sum::<f64>();
    (mean + slope * (23. + step as f64 - 11.5)).max(f64::MIN_POSITIVE)
}

fn add_metrics(metrics: &mut Metrics, forecast: &Forecast, rows: &[Value], end: usize) {
    let last = close(&rows[end - 1]);
    for i in 0..HORIZON {
        let actual = close(&rows[end + i]);
        let trend = linear_trend(&rows[..end], i + 1);
        let bounds = Some((forecast.q10[i], forecast.q90[i]));
        metrics
            .chronos_all
            .add(actual, forecast.q50[i], last, bounds);
        metrics.persistence_all.add(actual, last, last, None);
        metrics.linear_all.add(actual, trend, last, None);
        if i + 1 == HORIZON {
            metrics
                .chronos_endpoint
                .add(actual, forecast.q50[i], last, bounds);
            metrics.persistence_endpoint.add(actual, last, last, None);
            metrics.linear_endpoint.add(actual, trend, last, None);
        }
    }
}

fn atr(rows: &[Value]) -> f64 {
    (rows.len() - 14..rows.len())
        .map(|i| {
            let high = number(&rows[i]["high"], f64::NAN);
            let low = number(&rows[i]["low"], f64::NAN);
            let previous = close(&rows[i - 1]);
            (high - low)
                .max((high - previous).abs())
                .max((low - previous).abs())
        })
        .sum::<f64>()
        / 14.
}

fn mean(rows: &[Value], count: usize) -> f64 {
    rows[rows.len() - count..].iter().map(close).sum::<f64>() / count as f64
}

fn signal(rows: &[Value], end: usize, symbol: &str) -> Result<Value> {
    let origin = open(&rows[end])?;
    let market = research::prepare_market(symbol, "1h", &rows[..end], 256.min(end), origin)?;
    let price = close(&rows[end - 1]);
    let a = atr(&rows[..end]);
    ensure!(a.is_finite() && a > 0., "invalid closed-prefix ATR");
    // Fixed common protection for both policies. The 11 held bars account for
    // the production one-hour entry delay within a 12-hour forecast horizon.
    let raw = json!({"positionRecommendation":"OPEN_LONG","confidence":0.5,"recommendedLeverage":1,
        "reason":"Frozen offline Chronos comparison","plan":{"entryStyle":"market","entryMin":price-a*0.5,"entryMax":price+a*0.5,
        "stopLoss":price-a*2.,"takeProfit":price+a*5.,"maxHoldBars":11}});
    Ok(research::normalize_plan(&raw, &market, origin))
}

fn simulate(rows: &[Value], forecast: &Forecast, end: usize, signal: &Value) -> Result<Value> {
    let mut account = json!({"initialBalance":1000,"unlimitedCapital":false,"orders":[]});
    let record = json!({"id":format!("chronos-{}-{}",forecast.symbol,forecast.origin_ms),"marketProvider":"binance","analysisEngine":"local","analyses":[signal]});
    let mut order = paper::submit_paper_order(
        &mut account,
        &record,
        &json!({"symbol":forecast.symbol,"margin":100,"leverage":1}),
        forecast.origin_ms,
    )?;
    for row in &rows[end..end + HORIZON] {
        paper::advance_paper_order(&mut order, rows, open(row)? + HOUR)?;
        ensure!(
            order["error"].as_str().unwrap_or("").is_empty(),
            "shared simulator data gap: {}",
            order["error"]
        );
        if !matches!(order["status"].as_str(), Some("pending" | "open")) {
            break;
        }
    }
    Ok(
        json!({"status":order["status"],"entry":order["entry"],"entryAt":order["entryAt"],"exit":order["exit"],"exitAt":order["exitAt"],
        "reason":order["reason"],"net":order["net"],"gross":order["gross"],"fee":order["fee"],"funding":order["funding"],"heldBars":order["heldBars"],
        "ambiguousBar":order["ambiguousBar"],"costs":order["costs"],"mark":order["markPrice"],"unrealized":order["unrealized"],"margin_usdt":100,"leverage":1}),
    )
}

fn trade_summary(cases: &[Value], policy: &str) -> Value {
    let eligible: Vec<_> = cases
        .iter()
        .filter(|c| c[policy]["decision"] == "BUY")
        .collect();
    let entered = eligible
        .iter()
        .filter(|c| !c[policy]["trade"]["entry"].is_null())
        .count();
    let settled: Vec<_> = eligible
        .iter()
        .filter_map(|c| {
            let t = &c[policy]["trade"];
            (t["status"] == "closed").then_some(t)
        })
        .collect();
    let unresolved = eligible
        .iter()
        .filter(|c| {
            matches!(
                c[policy]["trade"]["status"].as_str(),
                Some("open" | "pending")
            )
        })
        .count();
    let sum = |key: &str| settled.iter().map(|t| number(&t[key], 0.)).sum::<f64>();
    let profit = settled
        .iter()
        .map(|t| number(&t["net"], 0.).max(0.))
        .sum::<f64>();
    let loss = settled
        .iter()
        .map(|t| (-number(&t["net"], 0.)).max(0.))
        .sum::<f64>();
    json!({"opportunities":cases.len(),"buy_decisions":eligible.len(),"entered":entered,"settled":settled.len(),"unresolved":unresolved,
        "settled_net_usdt":sum("net"),"settled_gross_usdt":sum("gross"),"settled_fees_usdt":sum("fee"),"settled_funding_usdt":sum("funding"),
        "settled_win_rate_percent":(!settled.is_empty()).then(||settled.iter().filter(|t|number(&t["net"],0.)>0.).count() as f64/settled.len() as f64*100.),
        "settled_profit_factor":(loss>0.).then(||profit/loss),"comparison_complete":unresolved==0,
        "scope":"Isolated 100 USDT orders; sums are not a portfolio return. Unresolved trades are disclosed and make the comparison incomplete."})
}

fn write_json(path: &PathBuf, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn prepare(args: &Args, datasets: &BTreeMap<String, Vec<Value>>, path: &PathBuf) -> Result<()> {
    ensure!(
        args.context_length >= 50,
        "context length must be at least 50"
    );
    let mut records = Vec::new();
    let mut data_asof = BTreeMap::new();
    for (symbol, rows) in datasets {
        data_asof.insert(symbol, iso(open(rows.last().unwrap())? + HOUR));
        for end in (args.context_length..rows.len().saturating_sub(HORIZON) + 1).step_by(HORIZON) {
            let origin = open(&rows[end])?;
            if origin + HORIZON as i64 * HOUR > HOLDOUT_START {
                break;
            }
            let context_rows = &rows[end - args.context_length..end];
            let values: Vec<f32> = context_rows.iter().map(|r| close(r) as f32).collect();
            ensure!(
                values.iter().all(|x| x.is_finite() && *x > 0.),
                "model input overflows f32"
            );
            records.push(json!({"symbol":symbol,"origin_ms":origin,"context_end_open_ms":open(&rows[end-1])?,
                "context_start_open_ms":open(&context_rows[0])?,"context":values,"context_open_ms":context_rows.iter().map(|r|open(r).unwrap()).collect::<Vec<_>>(),
                "history_sha256":prefix_sha(&rows[..end])}));
        }
    }
    ensure!(
        !records.is_empty(),
        "no prefix-only forecast origins before reserved holdout"
    );
    write_json(
        path,
        &json!({"schema_version":1,"model":"amazon/chronos-bolt-tiny","interval":"1h","context_length":args.context_length,
        "prediction_length":HORIZON,"holdout_start_ms":HOLDOUT_START,"origin_stride_hours":12,"computed_at":iso(now_ms()),"source_data_asof":data_asof,
        "research_only":true,"current_market_prediction":false,"records":records}),
    )?;
    println!(
        "{}",
        json!({"prepared_records":records.len(),"output":path})
    );
    Ok(())
}

fn evaluate(args: &Args, datasets: &BTreeMap<String, Vec<Value>>, path: &PathBuf) -> Result<()> {
    let mut forecasts: Forecasts = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        forecasts.schema_version == 1
            && forecasts.interval == "1h"
            && forecasts.prediction_length == HORIZON
            && forecasts.holdout_start_ms == HOLDOUT_START,
        "unsupported forecast schema, interval, horizon or holdout boundary"
    );
    ensure!(!forecasts.records.is_empty(), "empty forecast records");
    forecasts
        .records
        .sort_by(|a, b| (&a.symbol, a.origin_ms).cmp(&(&b.symbol, b.origin_ms)));
    let mut metrics = BTreeMap::<String, Metrics>::new();
    let mut last_origin = BTreeMap::<String, i64>::new();
    let mut next_trade = BTreeMap::<String, i64>::new();
    let mut cases = BTreeMap::<String, Vec<Value>>::new();
    let mut diagnostic = Vec::new();
    for f in &forecasts.records {
        let rows = datasets
            .get(&f.symbol)
            .with_context(|| format!("missing {} frozen dataset", f.symbol))?;
        let end = validate_forecast(f, rows, forecasts.context_length)?;
        ensure!(
            last_origin
                .get(&f.symbol)
                .is_none_or(|prior| f.origin_ms - *prior >= HORIZON as i64 * HOUR),
            "origins overlap or duplicate for {}",
            f.symbol
        );
        last_origin.insert(f.symbol.clone(), f.origin_ms);
        add_metrics(metrics.entry(f.symbol.clone()).or_default(), f, rows, end);
        let last = close(&rows[end - 1]);
        diagnostic.push(json!({"symbol":f.symbol,"origin_ms":f.origin_ms,"origin":iso(f.origin_ms),"last_close":last,"step12_actual":close(&rows[end+HORIZON-1]),
            "step12_q10":f.q10[HORIZON-1],"step12_q50":f.q50[HORIZON-1],"step12_q90":f.q90[HORIZON-1],"latency_ms":f.latency_ms}));
        // A 24-hour stride leaves room to disclose late fills at the 12-hour
        // endpoint without claiming those are nonoverlapping portfolio trades.
        if next_trade
            .get(&f.symbol)
            .is_some_and(|next| f.origin_ms < *next)
        {
            continue;
        }
        next_trade.insert(f.symbol.clone(), f.origin_ms + 24 * HOUR);
        let prefix = &rows[..end];
        let normalized = signal(rows, end, &f.symbol)?;
        let costs = research::costs();
        let cost_bps = 2. * (number(&costs["feeBps"], 6.) + number(&costs["slippageBps"], 5.))
            + number(&costs["fundingBpsPer8h"], 3.) * 12. / 8.;
        let chronos_buy = f.q10[HORIZON - 1] > last * (1. + cost_bps / 10000.);
        let trend_buy = last >= mean(prefix, 20) && mean(prefix, 20) > mean(prefix, 50);
        let eligible = normalized["eligible"] == true;
        let result = if eligible && (chronos_buy || trend_buy) {
            Some(simulate(rows, f, end, &normalized)?)
        } else {
            None
        };
        let policy = |buy: bool| json!({"decision":if buy&&eligible{"BUY"}else{"WAIT"},"signal_passed":buy,"risk_passed":eligible,"trade":if buy&&eligible{result.clone()}else{None}});
        cases.entry(f.symbol.clone()).or_default().push(json!({"origin_ms":f.origin_ms,"origin":iso(f.origin_ms),"forecast_horizon_hours":12,
            "price":last,"atr14":atr(prefix),"ma20":mean(prefix,20),"ma50":mean(prefix,50),"roundtrip_cost_threshold_bps":cost_bps,
            "plan":normalized["plan"],"validation_issues":normalized["validationIssues"],"chronos":policy(chronos_buy),"ma20_50_trend":policy(trend_buy)}));
    }
    let by_symbol: BTreeMap<_,_>=metrics.iter().map(|(symbol,m)|{
        let sample=cases.get(symbol).map(Vec::as_slice).unwrap_or(&[]);
        (symbol,json!({"forecast_metrics":m.output(),"trading":{"chronos":trade_summary(sample,"chronos"),"ma20_50_trend":trade_summary(sample,"ma20_50_trend")},"trade_cases":sample}))
    }).collect();
    let asof: BTreeMap<_, _> = datasets
        .iter()
        .map(|(s, r)| (s, iso(open(r.last().unwrap()).unwrap() + HOUR)))
        .collect();
    let output = json!({"schema_version":1,"model":forecasts.model,"computed_at":iso(now_ms()),"research_only":true,"current_market_prediction":false,
        "source_data_asof":asof,"forecast_records":forecasts.records.len(),"interval":"1h","prediction_length":12,"context_length":forecasts.context_length,
        "reserved_holdout_start":iso(HOLDOUT_START),"reserved_holdout_start_ms":HOLDOUT_START,"holdout_consumed":false,
        "method":{"forecast_origins":"nonoverlapping 12-hour origins, closed prefixes only","trading_origins":"at least 24 hours apart per symbol",
            "direction_accuracy":"Up/down matches excluding only flat realized targets; flat forecasts for realized moves count as misses. Persistence has no directional forecast and is shown separately as null. The denominator is reported explicitly.",
            "chronos_entry":"12h q10 exceeds last close plus shared 12h roundtrip costs","trend_entry":"last close >= SMA20 > SMA50",
            "common_risk":"ATR14; allowed market-entry range +/-0.5 ATR; stop -2 ATR; target +5 ATR; 11 held bars after production one-hour entry delay",
            "unresolved":"The production pending-entry policy is preserved; late fills may remain open at forecast endpoint and invalidate a complete PnL comparison.",
            "execution":"paper::submit_paper_order + paper::advance_paper_order + simulator::evaluate; 100 USDT margin, 1x leverage",
            "limitation":"Small retrospective experiment. Model quantile labels are not calibrated probabilities or evidence of trading profitability."},
        "symbols":by_symbol,"forecast_cases":diagnostic});
    write_json(&args.output, &output)?;
    println!(
        "{}",
        json!({"forecast_records":forecasts.records.len(),"symbols":output["symbols"],"output":args.output})
    );
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(!args.symbols.is_empty(), "no symbols requested");
    let mut datasets = BTreeMap::new();
    for symbol in &args.symbols {
        nofx_core::exchange::valid_symbol(symbol)?;
        datasets.insert(
            symbol.clone(),
            read_rows(&args.data_dir.join(format!("{symbol}.json")))?,
        );
    }
    if let Some(path) = &args.prepare_inputs {
        return prepare(&args, &datasets, path);
    }
    if let Some(path) = &args.forecasts {
        return evaluate(&args, &datasets, path);
    }
    bail!("supply --prepare-inputs <JSON path> or --forecasts <JSON path>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directional_accuracy_excludes_only_flat_targets_and_counts_flat_forecasts_as_misses() {
        let mut errors = Errors::default();
        errors.add(100., 99., 100., None);
        errors.add(100., 101., 100., None);
        errors.add(101., 100., 100., None);
        errors.add(101., 102., 100., None);
        errors.add(99., 98., 100., None);
        errors.add(99., 102., 100., None);
        assert_eq!(errors.count, 6);
        assert_eq!(errors.directional_count, 4);
        assert_eq!(errors.directional, 2);
        let output = errors.output(false);
        assert_eq!(output["direction_observations"], 4);
        let accuracy = output["direction_accuracy_percent"].as_f64().unwrap();
        assert!((accuracy - 50.).abs() < 1e-10);
        let persistence = errors.persistence_output();
        assert!(persistence["direction_accuracy_percent"].is_null());
        assert_eq!(persistence["direction_observations"], 0);
        assert!(
            persistence["direction_note"]
                .as_str()
                .unwrap()
                .contains("zero change")
        );
    }

    fn rows(count: usize) -> Vec<Value> {
        (0..count).map(|i|{
            let price=100.+i as f64*0.01;
            json!({"openTime":i as i64*HOUR,"open":price,"close":price,"high":price+1.,"low":price-1.,"volume":1.})
        }).collect()
    }

    fn forecast(end: usize) -> Forecast {
        Forecast {
            symbol: "BTCUSDT".into(),
            origin_ms: end as i64 * HOUR,
            context_end_open_ms: (end - 1) as i64 * HOUR,
            q10: vec![99.; 12],
            q50: vec![100.; 12],
            q90: vec![101.; 12],
            history_sha256: None,
            latency_ms: None,
        }
    }

    #[test]
    fn rejects_crossed_quantiles_and_reserved_targets() {
        let r = rows(400);
        let mut f = forecast(256);
        f.q10[0] = 102.;
        assert!(
            validate_forecast(&f, &r, 256)
                .unwrap_err()
                .to_string()
                .contains("crossed")
        );
        f.q10[0] = 99.;
        let mut late = rows(400);
        let shift = HOLDOUT_START - 256 * HOUR;
        for row in &mut late {
            row["openTime"] = json!(open(row).unwrap() + shift);
        }
        f.origin_ms += shift;
        f.context_end_open_ms += shift;
        assert!(
            validate_forecast(&f, &late, 256)
                .unwrap_err()
                .to_string()
                .contains("holdout")
        );
    }

    #[test]
    fn protection_and_baseline_use_only_closed_prefix() {
        let r = rows(300);
        let before = signal(&r, 256, "BTCUSDT").unwrap();
        let slope = linear_trend(&r[..256], 12);
        let mut changed = r.clone();
        for row in &mut changed[256..] {
            row["close"] = json!(10000.);
            row["high"] = json!(20000.);
        }
        assert_eq!(before, signal(&changed, 256, "BTCUSDT").unwrap());
        assert_eq!(slope, linear_trend(&changed[..256], 12));
        assert_ne!(prefix_sha(&r[..257]), prefix_sha(&changed[..257]));
        assert_eq!(prefix_sha(&r[..256]), prefix_sha(&changed[..256]));
    }

    #[test]
    fn production_entry_delay_and_timeout_fit_twelve_hour_endpoint() {
        let r = rows(300);
        let f = forecast(256);
        let s = signal(&r, 256, "BTCUSDT").unwrap();
        assert_eq!(s["eligible"], true);
        let t = simulate(&r, &f, 256, &s).unwrap();
        assert_eq!(t["status"], "closed");
        assert_eq!(t["reason"], "timeout");
        assert_eq!(timestamp(&t["entryAt"]), Some(f.origin_ms + HOUR));
        assert_eq!(timestamp(&t["exitAt"]), Some(f.origin_ms + 12 * HOUR));
        assert_eq!(t["heldBars"], 11);
        assert!(number(&t["fee"], 0.) > 0.);
        assert!(number(&t["funding"], 0.) > 0.);
    }

    #[test]
    fn discloses_unresolved_orders_instead_of_counting_zero_return() {
        let cases = vec![
            json!({"chronos":{"decision":"BUY","trade":{"status":"open","entry":100.,"net":null}}}),
        ];
        let summary = trade_summary(&cases, "chronos");
        assert_eq!(summary["unresolved"], 1);
        assert_eq!(summary["settled"], 0);
        assert_eq!(summary["comparison_complete"], false);
    }
}
