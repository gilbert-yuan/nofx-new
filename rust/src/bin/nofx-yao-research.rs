//! 妖币事件筛选与启动前特征有效性研究（只读，不触碰账户/订单）。
//!
//! 输入：data/ml/expanded-archive-* 的 1h 永续档案（mark/index price + funding + OI + 多空比）。
//! 输出：事件清单、对照组、逐特征样本内外 AUC 与分位 lift、候选规则评估。
//! 防未来函数：特征只用决策 bar（含）之前已收盘且已可用的数据；标签只看未来 fwd_bars。
use anyhow::{Context, Result, ensure};
use clap::Parser;
use nofx_core::{number, timestamp};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

#[derive(Parser)]
#[command(about = "Yao-coin event screening and pre-launch feature validity research")]
struct Args {
    #[arg(long, default_value = "data/ml/expanded-archive-20261016")]
    archive_dir: PathBuf,
    #[arg(long, default_value = "output/yao-research-20261018")]
    output_dir: PathBuf,
    /// 当天振幅阈值（%），用于「妖币日」统计。
    #[arg(long, default_value_t = 50.)]
    day_amp_pct: f64,
    /// 启动点标签：未来 fwd_bars 根 1h 内最大涨幅达到该值（%）。
    #[arg(long, default_value_t = 50.)]
    label_gain_pct: f64,
    #[arg(long, default_value_t = 24)]
    fwd_bars: usize,
    /// 同币事件最小间隔（1h bar 数）。
    #[arg(long, default_value_t = 72)]
    cooldown_bars: usize,
    /// 上市初期剔除：历史不足该 bar 数（30 天）的区段不参与事件/对照。
    #[arg(long, default_value_t = 720)]
    min_history_bars: usize,
    /// 流动性门槛：中位日 OI 价值（USD）。无 OI 数据的币不因此被剔除（单独计数）。
    #[arg(long, default_value_t = 1_000_000.)]
    min_oi_usd: f64,
    /// 训练段占比（按时间先后切分）。
    #[arg(long, default_value_t = 0.7)]
    train_frac: f64,
    /// 每个事件在同币抽取的对照 bar 上限。
    #[arg(long, default_value_t = 5)]
    controls_per_event: usize,
    /// 只处理前 N 个币（0 = 全部）。
    #[arg(long, default_value_t = 0)]
    max_symbols: usize,
}

struct Bars {
    ts: Vec<i64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
}

impl Bars {
    fn len(&self) -> usize {
        self.ts.len()
    }
}

fn dataset_rows(doc: &Value, key: &str) -> Vec<Value> {
    doc["datasets"][key].as_array().cloned().unwrap_or_default()
}

fn load_bars(doc: &Value) -> Option<Bars> {
    let rows = {
        let mark = dataset_rows(doc, "mark_price_1h");
        if mark.len() >= 1000 {
            mark
        } else {
            dataset_rows(doc, "index_price_1h")
        }
    };
    if rows.len() < 1000 {
        return None;
    }
    let mut b = Bars {
        ts: Vec::with_capacity(rows.len()),
        open: Vec::with_capacity(rows.len()),
        high: Vec::with_capacity(rows.len()),
        low: Vec::with_capacity(rows.len()),
        close: Vec::with_capacity(rows.len()),
    };
    for r in &rows {
        let t = timestamp(&r["openTime"])?;
        let (o, h, l, c) = (
            number(&r["open"], 0.),
            number(&r["high"], 0.),
            number(&r["low"], 0.),
            number(&r["close"], 0.),
        );
        if o <= 0. || h <= 0. || l <= 0. || c <= 0. || h < l {
            continue;
        }
        b.ts.push(t);
        b.open.push(o);
        b.high.push(h);
        b.low.push(l);
        b.close.push(c);
    }
    if b.len() < 1000 {
        return None;
    }
    Some(b)
}

/// 滑动窗口（向前看）最大值：out[t] = max(high[t+1 ..= t+w])。
fn forward_max(high: &[f64], w: usize) -> Vec<f64> {
    let n = high.len();
    let mut out = vec![f64::NAN; n];
    let mut dq: VecDeque<usize> = VecDeque::new();
    // 逆序维护窗口 [t+1, t+w]
    for t in (0..n).rev() {
        let enter = t + 1;
        if enter < n {
            while let Some(&i) = dq.back() {
                if high[i] <= high[enter] {
                    dq.pop_back();
                } else {
                    break;
                }
            }
            dq.push_back(enter);
        }
        while let Some(&i) = dq.front() {
            if i > t + w {
                dq.pop_front();
            } else {
                break;
            }
        }
        if let Some(&i) = dq.front() {
            out[t] = high[i];
        }
    }
    out
}

fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        f64::NAN
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}

fn std_of(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return f64::NAN;
    }
    let m = mean(xs);
    (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (xs.len() - 1) as f64).sqrt()
}

/// 当前值在窗口内的分位（0..1）。
fn percentile(window: &[f64], x: f64) -> f64 {
    if window.is_empty() || !x.is_finite() {
        return f64::NAN;
    }
    let le = window.iter().filter(|v| **v <= x).count();
    le as f64 / window.len() as f64
}

/// 简单二分：最后一个满足 ts <= key 的下标。
fn latest_le(ts: &[i64], key: i64) -> Option<usize> {
    if ts.is_empty() || ts[0] > key {
        return None;
    }
    let mut lo = 0usize;
    let mut hi = ts.len();
    while lo + 1 < hi {
        let mid = (lo + hi) / 2;
        if ts[mid] <= key {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some(lo)
}

struct Aux {
    // (available_at_ms, value)
    funding: Vec<(i64, f64)>,
    oi_usd: Vec<(i64, f64)>,
    ls_top: Vec<(i64, f64)>,
}

fn load_aux(doc: &Value) -> Aux {
    let mut funding: Vec<(i64, f64)> = dataset_rows(doc, "funding")
        .iter()
        .filter_map(|r| {
            let at = timestamp(&r["available_at_ms"]).or_else(|| timestamp(&r["fundingTime"]))?;
            let v = number(&r["fundingRate"], f64::NAN);
            v.is_finite().then_some((at, v))
        })
        .collect();
    funding.sort_by_key(|r| r.0);
    let mut oi_usd: Vec<(i64, f64)> = dataset_rows(doc, "open_interest")
        .iter()
        .filter_map(|r| {
            let at = timestamp(&r["available_at_ms"])?;
            let v = number(&r["sumOpenInterestValue"], f64::NAN);
            (v.is_finite() && v > 0.).then_some((at, v))
        })
        .collect();
    oi_usd.sort_by_key(|r| r.0);
    let mut ls_top: Vec<(i64, f64)> = dataset_rows(doc, "top_account_long_short")
        .iter()
        .filter_map(|r| {
            let at = timestamp(&r["available_at_ms"])?;
            let v = number(&r["longShortRatio"], f64::NAN);
            (v.is_finite() && v > 0.).then_some((at, v))
        })
        .collect();
    ls_top.sort_by_key(|r| r.0);
    Aux {
        funding,
        oi_usd,
        ls_top,
    }
}

fn aux_at(rows: &[(i64, f64)], key: i64) -> Option<f64> {
    let ts: Vec<i64> = rows.iter().map(|r| r.0).collect();
    latest_le(&ts, key).map(|i| rows[i].1)
}

/// 决策时点 t（用 <= t 的已收盘 bar 与 available_at <= close_time 的辅助数据）提取特征。
fn features_at(b: &Bars, aux: &Aux, t: usize, min_hist: usize) -> Value {
    let nan = f64::NAN;
    if t < min_hist || t >= b.len() {
        return Value::Null;
    }
    let close = b.close[t];
    let pct = |a: f64, base: f64| (a / base - 1.) * 100.;
    let ret = |k: usize| {
        if t >= k && b.close[t - k] > 0. {
            pct(close, b.close[t - k])
        } else {
            nan
        }
    };
    // TR 序列（从 1 开始有效）
    let tr = |i: usize| {
        if i == 0 {
            b.high[0] - b.low[0]
        } else {
            (b.high[i] - b.low[i])
                .max((b.high[i] - b.close[i - 1]).abs())
                .max((b.low[i] - b.close[i - 1]).abs())
        }
    };
    let trs: Vec<f64> = (0..=t).map(tr).collect();
    let atr14 = mean(&trs[t + 1 - 14..=t]);
    let atr_pct = atr14 / close * 100.;
    let atr_window: Vec<f64> = ((t + 1 - 720).max(13)..=t)
        .rev()
        .take(720)
        .map(|i| mean(&trs[i + 1 - 14..=i]) / b.close[i] * 100.)
        .collect();
    let atr_pctile_30d = percentile(&atr_window, atr_pct);
    let tr_ratio_6_120 = mean(&trs[t + 1 - 6..=t]) / mean(&trs[t + 1 - 120..=t]);
    let h24 = b.high[t + 1 - 24..=t]
        .iter()
        .fold(f64::NEG_INFINITY, |a, x| a.max(*x));
    let l24 = b.low[t + 1 - 24..=t]
        .iter()
        .fold(f64::INFINITY, |a, x| a.min(*x));
    let range_24h_pct = (h24 - l24) / close * 100.;
    let range_window: Vec<f64> = ((t + 1 - 720).max(23)..=t)
        .map(|i| {
            let hh = b.high[i + 1 - 24..=i]
                .iter()
                .fold(f64::NEG_INFINITY, |a, x| a.max(*x));
            let ll = b.low[i + 1 - 24..=i]
                .iter()
                .fold(f64::INFINITY, |a, x| a.min(*x));
            (hh - ll) / b.close[i] * 100.
        })
        .collect();
    let range_pctile_30d = percentile(&range_window, range_24h_pct);
    let h720 = b.high[t + 1 - 720..=t]
        .iter()
        .fold(f64::NEG_INFINITY, |a, x| a.max(*x));
    let l720 = b.low[t + 1 - 720..=t]
        .iter()
        .fold(f64::INFINITY, |a, x| a.min(*x));
    let pos_in_30d = if h720 > l720 {
        (close - l720) / (h720 - l720)
    } else {
        nan
    };
    let dist_high_30d_pct = pct(h720, close);
    let mut consec = 0i32;
    let mut sign = 0i32;
    for i in (1..=t).rev() {
        let d = if b.close[i] > b.close[i - 1] {
            1
        } else if b.close[i] < b.close[i - 1] {
            -1
        } else {
            0
        };
        if d == 0 || (sign != 0 && d != sign) {
            break;
        }
        sign = d;
        consec += 1;
        if consec >= 6 {
            break;
        }
    }
    let consec_dir = (consec * sign) as f64;
    let rets: Vec<f64> = (1..=t).map(|i| b.close[i] / b.close[i - 1] - 1.).collect();
    let vol_ratio_24_168 = std_of(&rets[t - 24..t]) / std_of(&rets[t.saturating_sub(168)..t]);
    let decision_ms = b.ts[t] + HOUR;
    let funding_last = aux_at(&aux.funding, decision_ms);
    let funding_mean_7d = funding_last.map(|_| {
        let from = decision_ms - 7 * DAY;
        let vals: Vec<f64> = aux
            .funding
            .iter()
            .filter(|(at, _)| *at > from && *at <= decision_ms)
            .map(|(_, v)| *v)
            .collect();
        mean(&vals)
    });
    let oi_now = aux_at(&aux.oi_usd, decision_ms);
    let oi_24h = aux_at(&aux.oi_usd, decision_ms - DAY);
    let oi_7d = aux_at(&aux.oi_usd, decision_ms - 7 * DAY);
    let oi_chg_24h_pct = oi_now
        .zip(oi_24h)
        .and_then(|(a, b)| (b > 0.).then_some((a / b - 1.) * 100.));
    let oi_chg_7d_pct = oi_now
        .zip(oi_7d)
        .and_then(|(a, b)| (b > 0.).then_some((a / b - 1.) * 100.));
    let ls_now = aux_at(&aux.ls_top, decision_ms);
    let ls_24h = aux_at(&aux.ls_top, decision_ms - DAY);
    let ls_top_chg_24h = ls_now.zip(ls_24h).map(|(a, b)| a - b);
    let hour_utc = (b.ts[t] / HOUR).rem_euclid(24) as f64;
    json!({
        "ret1hPct": ret(1), "ret4hPct": ret(4), "ret12hPct": ret(12), "ret24hPct": ret(24),
        "atrPct": atr_pct, "atrPctile30d": atr_pctile_30d,
        "trRatio6v120": tr_ratio_6_120, "range24hPct": range_24h_pct,
        "rangePctile30d": range_pctile_30d, "posIn30dRange": pos_in_30d,
        "distHigh30dPct": dist_high_30d_pct, "consecDir": consec_dir,
        "volRatio24v168": vol_ratio_24_168,
        "fundingLastBps": funding_last.map(|v| v * 1e4),
        "fundingMean7dBps": funding_mean_7d.map(|v| v * 1e4),
        "oiChg24hPct": oi_chg_24h_pct, "oiChg7dPct": oi_chg_7d_pct,
        "lsTopChg24h": ls_top_chg_24h, "hourUtc": hour_utc,
    })
}

fn process_symbol(path: &PathBuf, args: &Args) -> Result<(String, Vec<Value>, Vec<Value>, Value)> {
    let text = fs::read_to_string(path).with_context(|| format!("Read {}", path.display()))?;
    let doc: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))?;
    let symbol = doc["symbol"].as_str().unwrap_or("?").to_string();
    let bars = load_bars(&doc).context("insufficient price bars")?;
    let aux = load_aux(&doc);
    // 流动性：中位日 OI 价值
    let oi_vals: Vec<f64> = aux.oi_usd.iter().map(|(_, v)| *v).collect();
    let mut sorted = oi_vals.clone();
    sorted.sort_by(f64::total_cmp);
    let median_oi = if sorted.is_empty() {
        f64::NAN
    } else {
        sorted[sorted.len() / 2]
    };
    let liquid = !median_oi.is_finite() || median_oi >= args.min_oi_usd;
    let n = bars.len();
    let fwd_max = forward_max(&bars.high, args.fwd_bars);
    let fwd_max_48 = forward_max(&bars.high, 2 * args.fwd_bars);
    let fwd_gain: Vec<f64> = (0..n)
        .map(|t| {
            if fwd_max[t].is_finite() && bars.close[t] > 0. && t + args.fwd_bars < n {
                (fwd_max[t] / bars.close[t] - 1.) * 100.
            } else {
                f64::NAN
            }
        })
        .collect();
    // 妖币日统计（UTC 天振幅）
    let mut day_stats = json!({"days":0,"yaoDays":0});
    {
        let mut cur_day = -1i64;
        let (mut dopen, mut dh, mut dl) = (0., f64::NEG_INFINITY, f64::INFINITY);
        let mut days = 0i64;
        let mut yao = 0i64;
        let mut flush = |o: f64, h: f64, l: f64, days: &mut i64, yao: &mut i64| {
            if h >= l && o > 0. {
                *days += 1;
                if (h - l) / o * 100. >= args.day_amp_pct {
                    *yao += 1;
                }
            }
        };
        for i in 0..n {
            let d = bars.ts[i] / DAY;
            if d != cur_day {
                if cur_day >= 0 {
                    flush(dopen, dh, dl, &mut days, &mut yao);
                }
                cur_day = d;
                dopen = bars.open[i];
                dh = f64::NEG_INFINITY;
                dl = f64::INFINITY;
            }
            dh = dh.max(bars.high[i]);
            dl = dl.min(bars.low[i]);
        }
        flush(dopen, dh, dl, &mut days, &mut yao);
        day_stats = json!({"days":days,"yaoDays":yao});
    }
    if !liquid {
        return Ok((
            symbol,
            vec![],
            vec![],
            json!({"status":"excluded_illiquid","medianOiUsd":median_oi,"dayStats":day_stats}),
        ));
    }
    // 事件定位：fwd_gain >= 阈值，72h 冷却取最早
    let mut events = vec![];
    let mut last_event: Option<usize> = None;
    for t in args.min_history_bars..n.saturating_sub(args.fwd_bars + 1) {
        if !fwd_gain[t].is_finite() || fwd_gain[t] < args.label_gain_pct {
            continue;
        }
        if last_event.is_some_and(|le| t < le + args.cooldown_bars) {
            continue;
        }
        last_event = Some(t);
        let f = features_at(&bars, &aux, t, args.min_history_bars);
        events.push(json!({
            "symbol":symbol,"barIndex":t,"ts":bars.ts[t],"iso":nofx_core::iso(bars.ts[t]),
            "close":bars.close[t],"fwdGainPct":fwd_gain[t],
            "fwdGain48hPct": if t+2*args.fwd_bars<n && fwd_max_48[t].is_finite() {(fwd_max_48[t]/bars.close[t]-1.)*100.} else {f64::NAN},
            "features":f,
        }));
    }
    // 对照组：fwd_gain < 10%，距任何事件 > 72h，同币等距抽样
    let mut candidates = vec![];
    'outer: for t in args.min_history_bars..n.saturating_sub(args.fwd_bars + 1) {
        if !fwd_gain[t].is_finite() || fwd_gain[t] >= 10. {
            continue;
        }
        for e in &events {
            let et = e["barIndex"].as_u64().unwrap() as usize;
            if t.abs_diff(et) <= args.cooldown_bars {
                continue 'outer;
            }
        }
        candidates.push(t);
    }
    let want = events.len() * args.controls_per_event;
    let mut controls = vec![];
    if !candidates.is_empty() && want > 0 {
        let stride = (candidates.len() as f64 / want as f64).max(1.);
        let mut idx = 0.0;
        while (idx as usize) < candidates.len() && controls.len() < want {
            let t = candidates[idx as usize];
            controls.push(json!({
                "symbol":symbol,"barIndex":t,"ts":bars.ts[t],
                "fwdGainPct":fwd_gain[t],
                "features":features_at(&bars, &aux, t, args.min_history_bars),
            }));
            idx += stride;
        }
    }
    Ok((
        symbol,
        events,
        controls,
        json!({"status":"ok","medianOiUsd":median_oi,"dayStats":day_stats,"bars":n}),
    ))
}

/// Mann-Whitney AUC：P(x_event > x_control) + 0.5*P(tie)。
fn auc(events: &[f64], controls: &[f64]) -> Option<f64> {
    if events.len() < 20 || controls.len() < 20 {
        return None;
    }
    let mut wins = 0f64;
    for &e in events {
        for &c in controls {
            if e > c {
                wins += 1.;
            } else if e == c {
                wins += 0.5;
            }
        }
    }
    Some(wins / (events.len() * controls.len()) as f64)
}

const FEATURES: [&str; 19] = [
    "ret1hPct",
    "ret4hPct",
    "ret12hPct",
    "ret24hPct",
    "atrPct",
    "atrPctile30d",
    "trRatio6v120",
    "range24hPct",
    "rangePctile30d",
    "posIn30dRange",
    "distHigh30dPct",
    "consecDir",
    "volRatio24v168",
    "fundingLastBps",
    "fundingMean7dBps",
    "oiChg24hPct",
    "oiChg7dPct",
    "lsTopChg24h",
    "hourUtc",
];

fn feat_value(row: &Value, key: &str) -> Option<f64> {
    let v = number(&row["features"][key], f64::NAN);
    v.is_finite().then_some(v)
}

/// 分位 lift：按训练段对照组分位数切 5 桶，报每桶事件率 / 基准率。
fn quintile_lift(
    train_events: &[f64],
    train_controls: &[f64],
    eval_events: &[f64],
    eval_controls: &[f64],
) -> Value {
    let mut qs: Vec<f64> = train_controls.to_vec();
    qs.sort_by(f64::total_cmp);
    if qs.len() < 20 {
        return Value::Null;
    }
    let cuts: Vec<f64> = (1..5).map(|i| qs[qs.len() * i / 5]).collect();
    let bucket = |x: f64| cuts.iter().filter(|&&c| x > c).count();
    let base = train_events.len() as f64 / (train_events.len() + train_controls.len()) as f64;
    let mut rows = vec![];
    for b in 0..5 {
        let te = train_events.iter().filter(|&&x| bucket(x) == b).count();
        let tc = train_controls.iter().filter(|&&x| bucket(x) == b).count();
        let ee = eval_events.iter().filter(|&&x| bucket(x) == b).count();
        let ec = eval_controls.iter().filter(|&&x| bucket(x) == b).count();
        rows.push(json!({
            "bucket":b,
            "trainEventRate": if te+tc>0 {te as f64/(te+tc) as f64} else {f64::NAN},
            "trainLift": if te+tc>0 && base>0. {te as f64/(te+tc) as f64/base} else {f64::NAN},
            "testEventRate": if ee+ec>0 {ee as f64/(ee+ec) as f64} else {f64::NAN},
            "testN": ee+ec,
        }));
    }
    json!({"cuts":cuts,"baseRate":base,"buckets":rows})
}

fn main() -> Result<()> {
    let args = Args::parse();
    let manifest_path = args.archive_dir.join("manifest.json");
    let manifest: Value = serde_json::from_str(&fs::read_to_string(&manifest_path)?)?;
    let mut paths: Vec<PathBuf> = manifest["symbols"]
        .as_array()
        .context("manifest.symbols missing")?
        .iter()
        .filter_map(|s| s["history_path"].as_str().map(|p| args.archive_dir.join(p)))
        .filter(|p| p.is_file())
        .collect();
    paths.sort();
    if args.max_symbols > 0 {
        paths.truncate(args.max_symbols);
    }
    ensure!(!paths.is_empty(), "no history files found");
    fs::create_dir_all(&args.output_dir)?;
    eprintln!("processing {} symbols", paths.len());

    let counter = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map(|n| n.get().min(12))
        .unwrap_or(4);
    let results: Vec<(String, Vec<Value>, Vec<Value>, Value)> = std::thread::scope(|scope| {
        let mut handles = vec![];
        for _ in 0..workers {
            let counter = &counter;
            let paths = &paths;
            let args = &args;
            handles.push(scope.spawn(move || {
                let mut out = vec![];
                loop {
                    let i = counter.fetch_add(1, Ordering::Relaxed);
                    if i >= paths.len() {
                        break;
                    }
                    match process_symbol(&paths[i], args) {
                        Ok(r) => out.push(r),
                        Err(e) => out.push((
                            paths[i]
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .into_owned(),
                            vec![],
                            vec![],
                            json!({"status":"error","error":format!("{e:#}")}),
                        )),
                    }
                }
                out
            }));
        }
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap())
            .collect()
    });

    let mut all_events: Vec<Value> = vec![];
    let mut all_controls: Vec<Value> = vec![];
    let mut symbol_stats = vec![];
    let mut excluded = serde_json::Map::new();
    for (symbol, events, controls, stat) in results {
        let status = stat["status"].as_str().unwrap_or("?");
        if status != "ok" {
            *excluded.entry(status.to_string()).or_insert(json!(0)) =
                json!(excluded.get(status).and_then(|v| v.as_i64()).unwrap_or(0) + 1);
        }
        if !events.is_empty() || status == "ok" {
            symbol_stats.push(json!({
                "symbol":symbol,"status":status,"events":events.len(),
                "medianOiUsd":stat["medianOiUsd"],"dayStats":stat["dayStats"],"bars":stat["bars"],
            }));
        }
        all_events.extend(events);
        all_controls.extend(controls);
    }
    all_events.sort_by_key(|e| e["ts"].as_i64().unwrap_or(0));
    all_controls.sort_by_key(|e| e["ts"].as_i64().unwrap_or(0));

    // 样本内外：按时间切分
    let split_idx = (all_events.len() as f64 * args.train_frac) as usize;
    let split_ts = all_events
        .get(split_idx)
        .and_then(|e| e["ts"].as_i64())
        .unwrap_or(i64::MAX);
    let in_train = |r: &Value| r["ts"].as_i64().unwrap_or(0) < split_ts;
    let tr_e: Vec<&Value> = all_events.iter().filter(|r| in_train(r)).collect();
    let te_e: Vec<&Value> = all_events.iter().filter(|r| !in_train(r)).collect();
    let tr_c: Vec<&Value> = all_controls.iter().filter(|r| in_train(r)).collect();
    let te_c: Vec<&Value> = all_controls.iter().filter(|r| !in_train(r)).collect();

    let mut feature_report = serde_json::Map::new();
    for key in FEATURES {
        let gv = |rows: &[&Value]| -> Vec<f64> {
            rows.iter().filter_map(|r| feat_value(r, key)).collect()
        };
        let (tre, trc, tee, tec) = (gv(&tr_e), gv(&tr_c), gv(&te_e), gv(&te_c));
        let train_auc = auc(&tre, &trc);
        let test_auc = auc(&tee, &tec);
        let verdict = match (train_auc, test_auc) {
            (Some(a), Some(b)) => {
                let strong_train = (a - 0.5).abs() >= 0.05;
                let consistent =
                    (a - 0.5).signum() == (b - 0.5).signum() && (b - 0.5).abs() >= 0.03;
                if strong_train && consistent {
                    "predictive"
                } else if strong_train && !consistent {
                    "overfit_or_noise"
                } else {
                    "weak"
                }
            }
            _ => "insufficient_data",
        };
        feature_report.insert(
            key.to_string(),
            json!({
                "trainAuc":train_auc,"testAuc":test_auc,
                "trainN":[tre.len(),trc.len()],"testN":[tee.len(),tec.len()],
                "verdict":verdict,
                "lift":quintile_lift(&tre,&trc,&tee,&tec),
            }),
        );
    }

    // 候选规则：取训练段 |AUC-0.5| 最大的 4 个特征，在训练段选最优分位阈值，样本外验证
    let mut ranked: Vec<(&str, f64, f64)> = feature_report
        .iter()
        .filter_map(|(k, v)| {
            let a = v["trainAuc"].as_f64()?;
            Some((k.as_str(), a, (a - 0.5).abs()))
        })
        .collect();
    ranked.sort_by(|a, b| b.2.total_cmp(&a.2));
    let mut rules = vec![];
    if ranked.len() >= 2 {
        let top: Vec<(&str, f64)> = ranked.iter().take(4).map(|(k, a, _)| (*k, *a)).collect();
        // 每个特征取方向性阈值：AUC>0.5 取高分位，否则取低分位
        let mut thresholds: Vec<(&str, bool, f64)> = vec![];
        for (k, a) in &top {
            let mut vals: Vec<f64> = tr_c.iter().filter_map(|r| feat_value(r, k)).collect();
            vals.sort_by(f64::total_cmp);
            if vals.len() < 20 {
                continue;
            }
            let high_side = *a > 0.5;
            let q = if high_side { 0.8 } else { 0.2 };
            thresholds.push((k, high_side, vals[(vals.len() as f64 * q) as usize]));
        }
        // 两两组合 + 三组合
        let eval = |combo: &[(&str, bool, f64)], events: &[&Value], controls: &[&Value]| {
            let pass = |r: &Value| {
                combo.iter().all(|(k, high, th)| {
                    feat_value(r, k).is_some_and(|x| if *high { x >= *th } else { x <= *th })
                })
            };
            let ep = events.iter().filter(|r| pass(r)).count();
            let cp = controls.iter().filter(|r| pass(r)).count();
            json!({"eventPass":ep,"controlPass":cp,
                "precision": if ep+cp>0 {ep as f64/(ep+cp) as f64} else {f64::NAN},
                "recall": if !events.is_empty() {ep as f64/events.len() as f64} else {f64::NAN}})
        };
        for i in 0..thresholds.len() {
            for j in i + 1..thresholds.len() {
                let combo = [thresholds[i], thresholds[j]];
                rules.push(json!({
                    "conditions":combo.iter().map(|(k,h,t)|format!("{k}{}{t:.4}",if *h{">="}else{"<="})).collect::<Vec<_>>(),
                    "train":eval(&combo,&tr_e,&tr_c),"test":eval(&combo,&te_e,&te_c),
                }));
            }
        }
        if thresholds.len() >= 3 {
            let combo: Vec<_> = thresholds.iter().take(3).cloned().collect();
            rules.push(json!({
                "conditions":combo.iter().map(|(k,h,t)|format!("{k}{}{t:.4}",if *h{">="}else{"<="})).collect::<Vec<_>>(),
                "train":eval(&combo,&tr_e,&tr_c),"test":eval(&combo,&te_e,&te_c),
            }));
        }
    }

    let total_days: i64 = symbol_stats
        .iter()
        .filter_map(|s| s["dayStats"]["days"].as_i64())
        .sum();
    let yao_days: i64 = symbol_stats
        .iter()
        .filter_map(|s| s["dayStats"]["yaoDays"].as_i64())
        .sum();
    let summary = json!({
        "archiveDir":args.archive_dir,"windowMs":[manifest["start_ms"],manifest["end_ms"]],
        "params":{"dayAmpPct":args.day_amp_pct,"labelGainPct":args.label_gain_pct,
            "fwdBars":args.fwd_bars,"cooldownBars":args.cooldown_bars,
            "minHistoryBars":args.min_history_bars,"minOiUsd":args.min_oi_usd,
            "trainFrac":args.train_frac},
        "symbolsTotal":paths.len(),"symbolStats":symbol_stats,"excluded":excluded,
        "events":all_events.len(),"controls":all_controls.len(),
        "symbolsWithEvents":all_events.iter().map(|e|e["symbol"].as_str().unwrap_or("")).collect::<std::collections::BTreeSet<_>>().len(),
        "yaoDays":yao_days,"totalSymbolDays":total_days,
        "splitTs":split_ts,"splitIso":nofx_core::iso(split_ts),
        "trainEvents":tr_e.len(),"testEvents":te_e.len(),
        "trainControls":tr_c.len(),"testControls":te_c.len(),
    });

    let write = |name: &str, v: &Value| -> Result<()> {
        fs::write(args.output_dir.join(name), serde_json::to_vec_pretty(v)?)?;
        Ok(())
    };
    write("summary.json", &summary)?;
    write("events.json", &json!(all_events))?;
    write("controls.json", &json!(all_controls))?;
    write("feature_report.json", &json!(feature_report))?;
    write("rules.json", &json!(rules))?;
    println!(
        "{}",
        json!({"events":all_events.len(),"controls":all_controls.len(),
            "splitIso":nofx_core::iso(split_ts),"outputDir":args.output_dir})
    );
    Ok(())
}
