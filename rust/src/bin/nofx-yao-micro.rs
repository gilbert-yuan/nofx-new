//! 妖币启动前微观（1m/5m）量能特征研究（只读）。
//!
//! 输入：nofx-martin-collect 冻结语料（datasets: 1m/5m/15m/...，含 volume/quoteVolume/takerBuy）。
//! 事件定义与 nofx-yao-research 一致：未来 24h 内最大涨幅 >= label_gain_pct，72h 冷却。
//! 防未来函数：特征只用决策 bar 及之前已收盘 K 线。
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

const MINUTE: i64 = 60_000;

#[derive(Parser)]
#[command(about = "Yao-coin pre-launch micro (1m) volume feature research")]
struct Args {
    #[arg(long, default_value = "output/yao-research-20261018/data")]
    data_dir: PathBuf,
    #[arg(long, default_value = "output/yao-research-20261018")]
    output_dir: PathBuf,
    #[arg(long, default_value_t = 50.)]
    label_gain_pct: f64,
    /// 标签 horizon（分钟）。
    #[arg(long, default_value_t = 1440)]
    fwd_minutes: usize,
    #[arg(long, default_value_t = 4320)]
    cooldown_minutes: usize,
    /// 上市初期剔除（分钟）：默认 2 天。
    #[arg(long, default_value_t = 2880)]
    min_history_minutes: usize,
    #[arg(long, default_value_t = 5)]
    controls_per_event: usize,
    #[arg(long, default_value_t = 0.7)]
    train_frac: f64,
}

struct Bars {
    ts: Vec<i64>,
    open: Vec<f64>,
    high: Vec<f64>,
    low: Vec<f64>,
    close: Vec<f64>,
    quote: Vec<f64>,
    taker: Vec<f64>,
    trades: Vec<f64>,
}

fn load_1m(doc: &Value) -> Option<Bars> {
    let rows = doc["datasets"]["1m"].as_array()?;
    let mut b = Bars {
        ts: vec![],
        open: vec![],
        high: vec![],
        low: vec![],
        close: vec![],
        quote: vec![],
        taker: vec![],
        trades: vec![],
    };
    for r in rows {
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
        b.quote.push(number(&r["quoteVolume"], 0.));
        b.taker.push(number(&r["takerBuyQuoteVolume"], f64::NAN));
        b.trades.push(number(&r["tradeCount"], f64::NAN));
    }
    (b.ts.len() > 20000).then_some(b)
}

fn forward_max(high: &[f64], w: usize) -> Vec<f64> {
    let n = high.len();
    let mut out = vec![f64::NAN; n];
    let mut dq: VecDeque<usize> = VecDeque::new();
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

fn median(xs: &[f64]) -> f64 {
    let mut v: Vec<f64> = xs.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn pct(a: f64, b: f64) -> f64 {
    (a / b - 1.) * 100.
}

/// 决策 bar t（含）之前的微观特征。k 单位为 1m bar 数。
fn features_at(b: &Bars, t: usize) -> Value {
    let n = b.ts.len();
    let nan = f64::NAN;
    let win = |k: usize| -> (usize, usize) { (t + 1 - k.min(t + 1), t + 1) };
    let qmean = |k: usize| {
        let (a, z) = win(k);
        mean(&b.quote[a..z])
    };
    // 量能：近 2h / 近 24h、近 30m / 近 24h（缩量横盘 vs 放量）
    let q2h = qmean(120);
    let q30m = qmean(30);
    let q24h = qmean(1440);
    let q7d = qmean(10080);
    let vol_dryup_2h = q2h / q24h;
    let vol_dryup_30m = q30m / q24h;
    let vol_vs_7d = q24h / q7d;
    // 单日峰值量能占比（有没有已经放过量）
    let (a1, z1) = win(1440);
    let qmax_24h = b.quote[a1..z1].iter().fold(0f64, |x, y| x.max(*y));
    let spike_24h = qmax_24h / q24h;
    // taker 主买占比（近 1h / 近 24h）
    let taker_ratio = |k: usize| {
        let (a, z) = win(k);
        let tq: f64 = b.taker[a..z].iter().filter(|x| x.is_finite()).sum();
        let qq: f64 = b.quote[a..z].iter().sum();
        if qq > 0. && tq.is_finite() {
            tq / qq
        } else {
            nan
        }
    };
    let taker_1h = taker_ratio(60);
    let taker_24h = taker_ratio(1440);
    // 笔数活跃度
    let (a2, z2) = win(60);
    let trades_1h: f64 = b.trades[a2..z2].iter().filter(|x| x.is_finite()).sum();
    let (a3, z3) = win(1440);
    let trades_24h_mean = {
        let s: f64 = b.trades[a3..z3].iter().filter(|x| x.is_finite()).sum();
        s / 24.
    };
    let trades_ratio = if trades_24h_mean > 0. {
        trades_1h / trades_24h_mean
    } else {
        nan
    };
    // 价格结构：近 6h 振幅 / 近 7d 振幅（5m 级别压缩）
    let range_pct = |k: usize| {
        let (a, z) = win(k);
        if z <= a {
            return nan;
        }
        let h = b.high[a..z]
            .iter()
            .fold(f64::NEG_INFINITY, |x, y| x.max(*y));
        let l = b.low[a..z].iter().fold(f64::INFINITY, |x, y| x.min(*y));
        (h - l) / b.close[t] * 100.
    };
    let range_6h = range_pct(360);
    let range_7d = range_pct(10080);
    let range_ratio_6h_7d = range_6h / range_7d;
    // 启动前漂移
    let ret = |k: usize| {
        if t >= k && b.close[t - k] > 0. {
            pct(b.close[t], b.close[t - k])
        } else {
            nan
        }
    };
    // 连续同向 15m（用 15 根 1m 聚合方向）
    let mut consec15 = 0i32;
    let mut sign = 0i32;
    for chunk in 1..=6 {
        if t < chunk * 15 {
            break;
        }
        let c0 = b.close[t - chunk * 15];
        let c1 = b.close[t - (chunk - 1) * 15];
        let d = if c1 > c0 {
            1
        } else if c1 < c0 {
            -1
        } else {
            0
        };
        if d == 0 || (sign != 0 && d != sign) {
            break;
        }
        sign = d;
        consec15 += 1;
    }
    // 距 7d 高点
    let (a4, z4) = win(10080);
    let h7d = b.high[a4..z4]
        .iter()
        .fold(f64::NEG_INFINITY, |x, y| x.max(*y));
    json!({
        "volDryup2h": vol_dryup_2h, "volDryup30m": vol_dryup_30m, "volVs7d": vol_vs_7d,
        "spike24h": spike_24h, "takerRatio1h": taker_1h, "takerRatio24h": taker_24h,
        "tradesRatio": trades_ratio,
        "range6hPct": range_6h, "rangeRatio6h7d": range_ratio_6h_7d,
        "ret30mPct": ret(30), "ret2hPct": ret(120), "ret6hPct": ret(360), "ret24hPct": ret(1440),
        "consec15m": (consec15 * sign) as f64, "distHigh7dPct": pct(h7d, b.close[t]),
        "minuteOfDay": ((b.ts[t] / MINUTE).rem_euclid(1440)) as f64,
        "n": n,
    })
}

fn process(path: &PathBuf, args: &Args) -> Result<(Vec<Value>, Vec<Value>)> {
    let text = fs::read_to_string(path).with_context(|| format!("Read {}", path.display()))?;
    let doc: Value = serde_json::from_str(&text)?;
    let symbol = doc["symbol"].as_str().unwrap_or("?").to_string();
    let b = load_1m(&doc).context("no usable 1m dataset")?;
    let n = b.ts.len();
    let fwd = forward_max(&b.high, args.fwd_minutes);
    let mut events = vec![];
    let mut last: Option<usize> = None;
    let lo = args.min_history_minutes;
    let hi = n.saturating_sub(args.fwd_minutes + 1);
    for t in lo..hi {
        if !fwd[t].is_finite() || b.close[t] <= 0. {
            continue;
        }
        let g = pct(fwd[t], b.close[t]);
        if g < args.label_gain_pct {
            continue;
        }
        if last.is_some_and(|le| t < le + args.cooldown_minutes) {
            continue;
        }
        last = Some(t);
        events.push(
            json!({"symbol":symbol,"barIndex":t,"ts":b.ts[t],"iso":nofx_core::iso(b.ts[t]),
            "close":b.close[t],"fwdGainPct":g,"features":features_at(&b, t)}),
        );
    }
    let mut cands = vec![];
    'outer: for t in (lo..hi).step_by(30) {
        if !fwd[t].is_finite() || b.close[t] <= 0. {
            continue;
        }
        if pct(fwd[t], b.close[t]) >= 10. {
            continue;
        }
        for e in &events {
            let et = e["barIndex"].as_u64().unwrap() as usize;
            if t.abs_diff(et) <= args.cooldown_minutes {
                continue 'outer;
            }
        }
        cands.push(t);
    }
    let want = events.len() * args.controls_per_event;
    let mut controls = vec![];
    if !cands.is_empty() && want > 0 {
        let stride = (cands.len() as f64 / want as f64).max(1.);
        let mut idx = 0.;
        while (idx as usize) < cands.len() && controls.len() < want {
            let t = cands[idx as usize];
            controls.push(json!({"symbol":symbol,"barIndex":t,"ts":b.ts[t],
                "fwdGainPct":pct(fwd[t], b.close[t]),"features":features_at(&b, t)}));
            idx += stride;
        }
    }
    Ok((events, controls))
}

fn auc(events: &[f64], controls: &[f64]) -> Option<f64> {
    if events.len() < 15 || controls.len() < 15 {
        return None;
    }
    let mut wins = 0.;
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

const FEATURES: [&str; 17] = [
    "volDryup2h",
    "volDryup30m",
    "volVs7d",
    "spike24h",
    "takerRatio1h",
    "takerRatio24h",
    "tradesRatio",
    "range6hPct",
    "rangeRatio6h7d",
    "ret30mPct",
    "ret2hPct",
    "ret6hPct",
    "ret24hPct",
    "consec15m",
    "distHigh7dPct",
    "minuteOfDay",
    "n",
];

fn feat(row: &Value, key: &str) -> Option<f64> {
    let v = number(&row["features"][key], f64::NAN);
    v.is_finite().then_some(v)
}

fn main() -> Result<()> {
    let args = Args::parse();
    let mut paths: Vec<PathBuf> = fs::read_dir(&args.data_dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    ensure!(!paths.is_empty(), "no corpus files");
    let counter = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);
    let results: Vec<(Vec<Value>, Vec<Value>)> = std::thread::scope(|scope| {
        let mut hs = vec![];
        for _ in 0..workers {
            let c = &counter;
            let ps = &paths;
            let a = &args;
            hs.push(scope.spawn(move || {
                let mut out = vec![];
                loop {
                    let i = c.fetch_add(1, Ordering::Relaxed);
                    if i >= ps.len() {
                        break;
                    }
                    match process(&ps[i], a) {
                        Ok(r) => out.push(r),
                        Err(e) => eprintln!("SKIP {}: {e:#}", ps[i].display()),
                    }
                }
                out
            }));
        }
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let mut events: Vec<Value> = vec![];
    let mut controls: Vec<Value> = vec![];
    for (e, c) in results {
        events.extend(e);
        controls.extend(c);
    }
    events.sort_by_key(|e| e["ts"].as_i64().unwrap_or(0));
    controls.sort_by_key(|e| e["ts"].as_i64().unwrap_or(0));
    let split = events
        .get((events.len() as f64 * args.train_frac) as usize)
        .and_then(|e| e["ts"].as_i64())
        .unwrap_or(i64::MAX);
    let ev: Vec<&Value> = events.iter().collect();
    let ct: Vec<&Value> = controls.iter().collect();
    let (tr_e, te_e): (Vec<&Value>, Vec<&Value>) = ev
        .iter()
        .copied()
        .partition(|r| r["ts"].as_i64().unwrap_or(0) < split);
    let (tr_c, te_c): (Vec<&Value>, Vec<&Value>) = ct
        .iter()
        .copied()
        .partition(|r| r["ts"].as_i64().unwrap_or(0) < split);
    let mut report = serde_json::Map::new();
    for key in FEATURES {
        let gv = |rows: &[&Value]| rows.iter().filter_map(|r| feat(r, key)).collect::<Vec<_>>();
        let (a, b, c, d) = (gv(&tr_e), gv(&tr_c), gv(&te_e), gv(&te_c));
        let train_auc = auc(&a, &b);
        let test_auc = auc(&c, &d);
        // 中位数对比
        let med = |xs: &[f64]| median(xs);
        let verdict = match (train_auc, test_auc) {
            (Some(x), Some(y)) => {
                if (x - 0.5).abs() >= 0.05
                    && (x - 0.5).signum() == (y - 0.5).signum()
                    && (y - 0.5).abs() >= 0.03
                {
                    "predictive"
                } else if (x - 0.5).abs() >= 0.05 {
                    "overfit_or_noise"
                } else {
                    "weak"
                }
            }
            _ => "insufficient_data",
        };
        report.insert(
            key.to_string(),
            json!({"trainAuc":train_auc,"testAuc":test_auc,"verdict":verdict,
                "eventMedianTrain":med(&a),"controlMedianTrain":med(&b),
                "eventMedianTest":med(&c),"controlMedianTest":med(&d),
                "trainN":[a.len(),b.len()],"testN":[c.len(),d.len()]}),
        );
    }
    let out = json!({
        "params":{"labelGainPct":args.label_gain_pct,"fwdMinutes":args.fwd_minutes,
            "cooldownMinutes":args.cooldown_minutes,"trainFrac":args.train_frac},
        "events":events.len(),"controls":controls.len(),
        "splitIso":nofx_core::iso(split),
        "trainEvents":tr_e.len(),"testEvents":te_e.len(),
        "featureReport":report,
    });
    fs::write(
        args.output_dir.join("micro_report.json"),
        serde_json::to_vec_pretty(&out)?,
    )?;
    fs::write(
        args.output_dir.join("micro_events.json"),
        serde_json::to_vec_pretty(&json!(events))?,
    )?;
    println!(
        "{}",
        json!({"events":events.len(),"controls":controls.len(),"splitIso":nofx_core::iso(split)})
    );
    Ok(())
}
