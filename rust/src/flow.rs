//! Multi-timeframe price/volume rules shared by the native API and offline tools.
use crate::{iso, now_ms, number};
use serde_json::{Value, json};

pub const INTERVALS: [&str; 4] = ["1m", "5m", "1h", "1d"];
const LABELS: [&str; 4] = [
    "吸筹型量价特征",
    "洗盘后收复型特征",
    "放量突破型拉升特征",
    "高位派发风险特征",
];
const KEYS: [&str; 4] = ["accumulation", "washout", "markup", "distribution"];

fn optional(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        _ => {
            let n = number(v, f64::NAN);
            n.is_finite().then_some(n)
        }
    }
}
fn n(v: &Value, key: &str) -> f64 {
    number(&v[key], f64::NAN)
}
fn mean(v: &[f64]) -> Option<f64> {
    (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
}
fn ratio(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    a.zip(b).and_then(|(a, b)| (b > 0.0).then_some(a / b))
}
fn score(hit: bool, points: i64) -> i64 {
    if hit { points } else { 0 }
}

pub fn normalize_params(input: &Value) -> Value {
    let schema: Value = serde_json::from_str(include_str!("flow_defaults.json"))
        .expect("valid embedded flow schema");
    let mut p = schema["defaults"].clone();
    for (key, bounds) in schema["bounds"].as_object().unwrap() {
        if let Some(value) = input.get(key) {
            // JavaScript Number(null) is zero; absent values retain defaults.
            if let Some(value) = if value.is_null() {
                Some(0.0)
            } else {
                optional(value)
            } {
                p[key] =
                    json!(value.clamp(bounds[0].as_f64().unwrap(), bounds[1].as_f64().unwrap()));
            }
        }
    }
    for key in ["lookbackBars", "recentBars", "minBars"] {
        p[key] = json!(n(&p, key).round());
    }
    for interval in INTERVALS {
        if let Some(value) = input["lookaheadBarsByInterval"].get(interval)
            && let Some(value) = if value.is_null() {
                Some(0.0)
            } else {
                optional(value)
            }
        {
            p["lookaheadBarsByInterval"][interval] = json!(value.clamp(1.0, 500.0).round());
        }
    }
    for (lo, hi) in [
        ("accumulationVolumeRatioMin", "accumulationVolumeRatioMax"),
        (
            "accumulationGentleVolumeRatioMin",
            "accumulationGentleVolumeRatioMax",
        ),
    ] {
        if n(&p, hi) < n(&p, lo) {
            let a = p[lo].clone();
            p[lo] = p[hi].clone();
            p[hi] = a;
        }
    }
    if n(&p, "forecastHighScore") <= n(&p, "forecastMediumScore") {
        p["forecastHighScore"] = json!((n(&p, "forecastMediumScore") + 1.0).min(100.0));
    }
    p
}

#[derive(Clone)]
struct Candle {
    time: Option<f64>,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    quote: f64,
    buy_quote: Option<f64>,
    net: Option<f64>,
    turnover: Option<f64>,
}
fn alias<'a>(row: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter()
        .find_map(|key| row.get(*key).filter(|v| !v.is_null()))
        .unwrap_or(&Value::Null)
}
fn candles(rows: &[Value]) -> Vec<Candle> {
    let mut out: Vec<Candle> = rows
        .iter()
        .filter_map(|r| {
            if r["confirmed"] == false {
                return None;
            }
            let open = optional(&r["open"])?;
            let high = optional(&r["high"])?;
            let low = optional(&r["low"])?;
            let close = optional(&r["close"])?;
            let volume = optional(&r["volume"])?;
            if open <= 0.0 || close <= 0.0 || volume < 0.0 {
                return None;
            }
            let quote =
                optional(alias(r, &["quoteVolume", "quote_volume"])).unwrap_or(volume * close);
            let buy_quote = optional(alias(r, &["takerBuyQuoteVolume", "taker_buy_quote_volume"]))
                .or_else(|| {
                    optional(alias(r, &["takerBuyVolume", "taker_buy_volume"])).map(|v| v * close)
                });
            Some(Candle {
                time: optional(alias(r, &["openTime", "timestamp", "time", "date"])),
                open,
                high,
                low,
                close,
                volume,
                quote,
                buy_quote,
                net: optional(alias(r, &["netFlow", "net_flow"]))
                    .or_else(|| buy_quote.map(|b| b - (quote - b))),
                turnover: optional(alias(r, &["turnoverRate", "turnover_rate"])),
            })
        })
        .collect();
    out.sort_by(|a, b| a.time.unwrap_or(0.0).total_cmp(&b.time.unwrap_or(0.0)));
    if out.len() > 500 {
        out.drain(..out.len() - 500);
    }
    out
}

fn metrics(c: &[Candle], p: &Value) -> Value {
    let latest = c.last().unwrap();
    let recent_count = n(p, "recentBars") as usize;
    let lookback = n(p, "lookbackBars") as usize;
    let recent_start = c.len().saturating_sub(recent_count);
    let recent = &c[recent_start..];
    let previous = &c[c.len().saturating_sub(lookback + recent_count)..recent_start];
    let prior = &c[c.len().saturating_sub(lookback + 1)..c.len() - 1];
    let split = (recent.len() / 2).max(1);
    let avg_vol = |slice: &[Candle]| mean(&slice.iter().map(|v| v.volume).collect::<Vec<_>>());
    let recent_volume = avg_vol(recent);
    let baseline = avg_vol(previous);
    let volume_ratio = ratio(recent_volume, baseline);
    let gentle = ratio(avg_vol(&recent[split..]), avg_vol(&recent[..split]));
    let total_quote = recent.iter().map(|v| v.quote).sum::<f64>();
    let nets: Vec<f64> = recent.iter().filter_map(|v| v.net).collect();
    let net = (!nets.is_empty()).then(|| nets.iter().sum::<f64>());
    let net_ratio = ratio(net, Some(total_quote));
    let buy = recent.iter().filter_map(|v| v.buy_quote).sum::<f64>();
    let taker = if recent.iter().any(|v| v.buy_quote.is_some()) {
        ratio(Some(buy), Some(total_quote))
    } else {
        None
    };
    let high = recent
        .iter()
        .map(|v| v.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let low = recent.iter().map(|v| v.low).fold(f64::INFINITY, f64::min);
    let prior_high = (!prior.is_empty()).then(|| {
        prior
            .iter()
            .map(|v| v.high)
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let prior_low =
        (!prior.is_empty()).then(|| prior.iter().map(|v| v.low).fold(f64::INFINITY, f64::min));
    let near_high = prior_high
        .zip(prior_low)
        .and_then(|(h, l)| (h > l && h != 0.0).then_some((latest.close - l) / (h - l)));
    let turnover: Vec<f64> = recent.iter().filter_map(|v| v.turnover).collect();
    let ret = (c.len() > recent_count)
        .then(|| (latest.close / c[c.len() - recent_count - 1].close - 1.0) * 100.0);
    json!({"latestPrice":latest.close,"latestTime":latest.time,"volumeRatio":volume_ratio,"gentleVolumeRatio":gentle,
        "recentVolume":recent_volume,"baselineVolume":baseline,"recentRangePct":if low>0.0{Some((high/low-1.0)*100.0)}else{None},
        "recentReturnPct":ret,"priorHigh":prior_high,"priorLow":prior_low,"nearHighRatio":near_high,
        "upperWickRatio":(latest.high-latest.open.max(latest.close))/(latest.high-latest.low).max(f64::EPSILON),
        "netFlow":net,"netFlowRatio":net_ratio,"takerBuyRatio":taker,"averageTurnoverRate":mean(&turnover),
        "latestQuoteVolume":latest.quote,"hasFlowData":!nets.is_empty(),"hasTurnoverData":!turnover.is_empty()})
}

fn analyze_interval(interval: &str, rows: &[Value], p: &Value) -> Value {
    let c = candles(rows);
    if c.is_empty() {
        return json!({"interval":interval,"usableBars":0,"label":"数据不足","confidence":0,"patternKey":null,"metrics":{},"patterns":[],"warnings":["该周期没有可用的已收盘 K 线。"]});
    }
    let m = metrics(&c, p);
    let vr = n(&m, "volumeRatio");
    let range = n(&m, "recentRangePct");
    let ret = n(&m, "recentReturnPct");
    let near = n(&m, "nearHighRatio");
    let flow = n(&m, "netFlowRatio");
    let gentle = n(&m, "gentleVolumeRatio");
    let accumulation_ok = range <= n(p, "consolidationRangeMaxPct")
        && vr >= n(p, "accumulationVolumeRatioMin")
        && vr <= n(p, "accumulationVolumeRatioMax")
        && gentle >= n(p, "accumulationGentleVolumeRatioMin")
        && gentle <= n(p, "accumulationGentleVolumeRatioMax");
    let accumulation = score(range <= n(p, "consolidationRangeMaxPct"), 30)
        + score(
            vr >= n(p, "accumulationVolumeRatioMin") && vr <= n(p, "accumulationVolumeRatioMax"),
            20,
        )
        + score(
            gentle >= n(p, "accumulationGentleVolumeRatioMin")
                && gentle <= n(p, "accumulationGentleVolumeRatioMax"),
            25,
        )
        + if flow.is_nan() {
            5
        } else {
            score(flow >= n(p, "positiveFlowRatioMin"), 15)
        }
        + score((0.35..=0.85).contains(&near), 10);
    let mut washout = Value::Null;
    let mut washout_score = 0;
    let mut washout_ok = false;
    if c.len() >= n(p, "recentBars") as usize + 3 {
        let start = c
            .len()
            .saturating_sub((n(p, "recentBars") as usize).min(4))
            .max(1);
        let trough = (start..c.len())
            .min_by(|a, b| c[*a].low.total_cmp(&c[*b].low))
            .unwrap();
        let peak = c[trough.saturating_sub(n(p, "lookbackBars") as usize)..trough]
            .iter()
            .map(|v| v.high)
            .fold(f64::NEG_INFINITY, f64::max);
        let low = c[trough].low;
        let drop = if peak > low {
            (peak - low) / peak * 100.0
        } else {
            0.0
        };
        let recovery = if peak > low {
            (c.last().unwrap().close - low) / (peak - low)
        } else {
            0.0
        };
        let trough_volume = ratio(Some(c[trough].volume), optional(&m["baselineVolume"]));
        washout_score = score(drop >= n(p, "washoutDropMinPct"), 35)
            + score(
                c[trough].close < c[trough].open
                    && trough_volume.is_some_and(|v| v <= n(p, "washoutVolumeRatioMax")),
                25,
            )
            + score(recovery >= n(p, "washoutRecoveryRatioMin"), 30)
            + score(c.last().unwrap().close > c[trough].close, 10);
        washout_ok = drop >= n(p, "washoutDropMinPct")
            && trough_volume.is_some_and(|v| v <= n(p, "washoutVolumeRatioMax"))
            && recovery >= n(p, "washoutRecoveryRatioMin");
        washout = json!({"dropPct":drop,"recoveryRatio":recovery,"troughPrice":low,"peakPrice":peak,"troughVolumeRatio":trough_volume});
    }
    let breakout = n(&m, "latestPrice") > n(&m, "priorHigh");
    let markup_ok =
        breakout && vr >= n(p, "breakoutVolumeRatioMin") && ret >= n(p, "breakoutRiseMinPct");
    let markup = score(breakout, 35)
        + score(vr >= n(p, "breakoutVolumeRatioMin"), 30)
        + score(ret >= n(p, "breakoutRiseMinPct"), 25)
        + score(flow > 0.0, 10);
    let distribution_ok = near >= 0.75
        && vr >= n(p, "distributionVolumeRatioMin")
        && (ret.abs() <= n(p, "distributionStallMaxPct")
            || n(&m, "upperWickRatio") >= n(p, "distributionUpperWickMin"));
    let distribution = score(near >= 0.75, 25)
        + score(vr >= n(p, "distributionVolumeRatioMin"), 25)
        + score(ret.abs() <= n(p, "distributionStallMaxPct"), 20)
        + score(
            n(&m, "upperWickRatio") >= n(p, "distributionUpperWickMin"),
            20,
        )
        + score(
            n(&m, "averageTurnoverRate") >= n(p, "distributionTurnoverRateMinPct"),
            10,
        );
    let scores = [accumulation, washout_score, markup, distribution];
    let eligible = [accumulation_ok, washout_ok, markup_ok, distribution_ok];
    let mut patterns: Vec<Value> = (0..4)
        .map(|i| json!({"key":KEYS[i],"label":LABELS[i],"score":scores[i],"eligible":eligible[i]}))
        .collect();
    patterns.sort_by_key(|v| std::cmp::Reverse(v["score"].as_i64().unwrap()));
    let primary = if c.len() < n(p, "minBars") as usize {
        None
    } else {
        patterns
            .iter()
            .find(|v| v["eligible"] == true && v["score"].as_i64().unwrap() >= 45)
    };
    let condition = |label: &str, value: Value, threshold: Value, unit: &str, matched: bool| json!({"label":label,"value":value,"threshold":threshold,"unit":unit,"matched":matched});
    let available = |mut v: Value, yes: bool| {
        v["available"] = json!(yes);
        v
    };
    let evidence = json!([
        {"key":KEYS[0],"label":LABELS[0],"score":accumulation,"conditions":[
            condition("近端价格窄幅整理",m["recentRangePct"].clone(),p["consolidationRangeMaxPct"].clone(),"%",range<=n(p,"consolidationRangeMaxPct")),
            condition("近端量能处于设定区间",m["volumeRatio"].clone(),json!(format!("{}–{}",n(p,"accumulationVolumeRatioMin"),n(p,"accumulationVolumeRatioMax"))),"倍",vr>=n(p,"accumulationVolumeRatioMin")&&vr<=n(p,"accumulationVolumeRatioMax")),
            condition("整理后段温和放量",m["gentleVolumeRatio"].clone(),json!(format!("{}–{}",n(p,"accumulationGentleVolumeRatioMin"),n(p,"accumulationGentleVolumeRatioMax"))),"倍",gentle>=n(p,"accumulationGentleVolumeRatioMin")&&gentle<=n(p,"accumulationGentleVolumeRatioMax")),
            available(condition("净流入占成交额比例",m["netFlowRatio"].clone(),p["positiveFlowRatioMin"].clone(),"比值",flow>=n(p,"positiveFlowRatioMin")),flow.is_finite()),
            condition("收盘位于整理区间中上部",m["nearHighRatio"].clone(),json!("0.35–0.85"),"比值",(0.35..=0.85).contains(&near))]},
        {"key":KEYS[1],"label":LABELS[1],"score":washout_score,"conditions":[
            condition("近端急跌幅度",washout["dropPct"].clone(),p["washoutDropMinPct"].clone(),"%",n(&washout,"dropPct")>=n(p,"washoutDropMinPct")),
            condition("低点下跌量能 / 基准量",washout["troughVolumeRatio"].clone(),p["washoutVolumeRatioMax"].clone(),"倍",n(&washout,"troughVolumeRatio")<=n(p,"washoutVolumeRatioMax")),
            condition("从低点收复回撤比例",washout["recoveryRatio"].clone(),p["washoutRecoveryRatioMin"].clone(),"比值",n(&washout,"recoveryRatio")>=n(p,"washoutRecoveryRatioMin"))]},
        {"key":KEYS[2],"label":LABELS[2],"score":markup,"conditions":[
            condition("收盘站上前序区间高点",m["latestPrice"].clone(),m["priorHigh"].clone(),"价格",breakout),
            condition("近端量比",m["volumeRatio"].clone(),p["breakoutVolumeRatioMin"].clone(),"倍",vr>=n(p,"breakoutVolumeRatioMin")),
            condition("近端价格涨幅",m["recentReturnPct"].clone(),p["breakoutRiseMinPct"].clone(),"%",ret>=n(p,"breakoutRiseMinPct")),
            available(condition("净资金流为正",m["netFlowRatio"].clone(),json!(0),"比值",flow>0.0),flow.is_finite())]},
        {"key":KEYS[3],"label":LABELS[3],"score":distribution,"conditions":[
            condition("收盘位于前序区间高位",m["nearHighRatio"].clone(),json!(0.75),"比值",near>=0.75),
            condition("近端量比",m["volumeRatio"].clone(),p["distributionVolumeRatioMin"].clone(),"倍",vr>=n(p,"distributionVolumeRatioMin")),
            condition("价格滞涨幅度",json!(if ret.is_finite(){Some(ret.abs())}else{None}),p["distributionStallMaxPct"].clone(),"%",ret.abs()<=n(p,"distributionStallMaxPct")),
            condition("最新 K 线上影占振幅",m["upperWickRatio"].clone(),p["distributionUpperWickMin"].clone(),"比值",n(&m,"upperWickRatio")>=n(p,"distributionUpperWickMin")),
            available(condition("平均换手率",m["averageTurnoverRate"].clone(),p["distributionTurnoverRateMinPct"].clone(),"%",n(&m,"averageTurnoverRate")>=n(p,"distributionTurnoverRateMinPct")),m["hasTurnoverData"]==true)]}
    ]);
    let mut warnings = Vec::new();
    if c.len() < n(p, "minBars") as usize {
        warnings.push(format!(
            "有效 K 线 {} 根，少于规则要求的 {} 根。",
            c.len(),
            n(p, "minBars")
        ));
    }
    if m["hasFlowData"] != true {
        warnings.push("缺少可计算的主动买卖量/净资金流字段，资金流条件不参与评分。".into());
    }
    if m["hasTurnoverData"] != true {
        warnings.push("未提供换手率；此项不参与判定。".into());
    }
    if distribution >= 55 {
        warnings.push("出现高位放量滞涨或长上影组合，存在派发风险特征。".into());
    }
    json!({"interval":interval,"usableBars":c.len(),"latestPrice":m["latestPrice"],"latestTime":m["latestTime"],
        "label":primary.map(|v|v["label"].clone()).unwrap_or(json!("量价特征不明显")),"patternKey":primary.map(|v|v["key"].clone()),"confidence":primary.map(|v|v["score"].clone()).unwrap_or(json!(0)),
        "metrics":m,"patterns":patterns,"evidence":evidence,"warnings":warnings,
        "patternDetails":{"accumulation":accumulation,"washout":washout_score,"markup":markup,"distribution":distribution,
            "eligibility":{"accumulation":accumulation_ok,"washout":washout_ok,"markup":markup_ok,"distribution":distribution_ok},"washoutMetrics":washout,"confirmedBreakout":breakout}})
}

pub fn analyze(input: &Value) -> Value {
    let p = normalize_params(&input["params"]);
    let selected = input["primaryInterval"]
        .as_str()
        .filter(|i| INTERVALS.contains(i))
        .unwrap_or("1h");
    let intervals: Vec<Value> = INTERVALS
        .iter()
        .filter_map(|interval| {
            input["datasets"][interval]
                .as_array()
                .map(|rows| analyze_interval(interval, rows, &p))
        })
        .collect();
    let fallback = analyze_interval(selected, &[], &p);
    let primary = intervals
        .iter()
        .find(|v| v["interval"] == selected)
        .or_else(|| intervals.iter().find(|v| n(v, "usableBars") > 0.0))
        .unwrap_or(&fallback);
    let pattern_score = |key: &str| {
        primary["patterns"]
            .as_array()
            .and_then(|arr| {
                arr.iter()
                    .find(|v| v["key"] == key && v["eligible"] == true)
            })
            .map(|v| n(v, "score"))
            .unwrap_or(0.0)
    };
    let aligned = intervals
        .iter()
        .filter(|v| {
            v["interval"] != primary["interval"]
                && matches!(
                    v["patternKey"].as_str(),
                    Some("accumulation" | "washout" | "markup")
                )
        })
        .count();
    let flow = n(&primary["metrics"], "netFlowRatio");
    let distribution = pattern_score("distribution");
    let total = (15
        + score(pattern_score("accumulation") >= 50.0, 22)
        + score(pattern_score("washout") >= 55.0, 20)
        + score(pattern_score("markup") >= 55.0, 18)
        + score(flow >= n(&p, "positiveFlowRatioMin"), 15)
        + score(
            n(&primary["metrics"], "volumeRatio") >= n(&p, "breakoutVolumeRatioMin"),
            12,
        )
        + (aligned * 5).min(15) as i64
        - score(distribution >= 55.0, 35)
        - score(flow < 0.0, 12))
    .clamp(0, 100);
    let interval = primary["interval"].as_str().unwrap_or(selected);
    let bars = n(&p["lookaheadBarsByInterval"], interval) as i64;
    let horizon = match interval {
        "1m" => format!("未来约 {bars} 分钟"),
        "5m" => format!("未来约 {} 小时", (bars as f64 * 5.0 / 60.0).round()),
        "1h" => format!("未来约 {} 天", (bars as f64 / 24.0).round()),
        _ => format!("未来约 {bars} 个交易日"),
    };
    let mut triggers = Vec::new();
    if let Some(high) = optional(&primary["metrics"]["priorHigh"]) {
        triggers.push(format!("收盘价有效站上观察高点 {high}，而非仅盘中刺穿。"));
    }
    triggers.push(format!(
        "近 {} 根均量 / 前 {} 根均量达到 {:.2} 倍。",
        n(&p, "recentBars"),
        n(&p, "lookbackBars"),
        n(&p, "breakoutVolumeRatioMin")
    ));
    triggers.push(format!(
        "近端涨幅达到 {:.2}%，并由主动买入或净流入确认（有字段时）。",
        n(&p, "breakoutRiseMinPct")
    ));
    let mut forecast_warnings = Vec::<String>::new();
    if distribution >= 55.0 {
        forecast_warnings.push("派发风险分较高，拉升评分已扣减。".into());
    }
    if aligned == 0 {
        forecast_warnings.push("其他周期未出现同向量价阶段，缺少多周期共振。".into());
    }
    if n(primary, "usableBars") < n(&p, "minBars") {
        forecast_warnings.push("样本量不足，当前等级仅作低置信度观察。".into());
    }
    let mut warnings = Vec::<Value>::new();
    for arr in [&input["dataWarnings"], &primary["warnings"]] {
        if let Some(arr) = arr.as_array() {
            warnings.extend(arr.iter().cloned());
        }
    }
    warnings.extend(forecast_warnings.iter().map(|v| json!(v)));
    if !intervals
        .iter()
        .any(|v| v["interval"] != primary["interval"] && n(v, "usableBars") >= n(&p, "minBars"))
    {
        warnings.push(json!("缺少足量的其他周期数据；当前判断未获得多周期确认。"));
    }
    if primary["patternKey"] == "distribution" {
        warnings.push(json!(
            "当前主周期更接近派发风险形态，避免把高位放量误读为吸筹。"
        ));
    }
    let mut unique = Vec::new();
    for w in warnings {
        if !unique.contains(&w) {
            unique.push(w);
        }
    }
    json!({"symbol":input["symbol"].as_str().unwrap_or(""),"source":input["source"],"generatedAt":iso(now_ms()),"primaryInterval":primary["interval"],
        "stage":{"label":primary["label"],"patternKey":primary["patternKey"],"confidence":primary["confidence"]},
        "forecast":{"level":if total as f64>=n(&p,"forecastHighScore"){"高"}else if total as f64>=n(&p,"forecastMediumScore"){"中"}else{"低"},"ruleScore":total,
            "scoreMeaning":"规则符合度评分，非经历史回测校准的统计概率。","referenceWindow":horizon,"lookaheadBars":bars,"triggerConditions":triggers,
            "keyLevels":{"breakout":primary["metrics"]["priorHigh"],"support":primary["metrics"]["priorLow"],"current":primary["metrics"]["latestPrice"],"largeRiseThresholdPct":p["largeRiseMinPct"]},"warnings":forecast_warnings},
        "primary":primary,"intervals":intervals,"rules":{"thresholds":p,"descriptions":[
            format!("吸筹：近端价格区间不超过 {}%、量比处于 {}–{}，整理后段量能较前段温和抬升至 {}–{} 倍，并结合资金流与区间位置。",n(&p,"consolidationRangeMaxPct"),n(&p,"accumulationVolumeRatioMin"),n(&p,"accumulationVolumeRatioMax"),n(&p,"accumulationGentleVolumeRatioMin"),n(&p,"accumulationGentleVolumeRatioMax")),
            format!("洗盘：近端回撤至少 {}%、下跌量能不高于基准量 {} 倍，且收复回撤幅度至少 {}%。",n(&p,"washoutDropMinPct"),n(&p,"washoutVolumeRatioMax"),(n(&p,"washoutRecoveryRatioMin")*100.0).round()),
            format!("拉升：收盘突破前 {} 根高点、量比至少 {} 倍、近端涨幅至少 {}%。",n(&p,"lookbackBars"),n(&p,"breakoutVolumeRatioMin"),n(&p,"breakoutRiseMinPct")),
            format!("派发：价格处于区间高位、量比至少 {} 倍，并出现滞涨或上影线占比不低于 {}%；提供换手率时，达到 {}% 作为辅助条件。",n(&p,"distributionVolumeRatioMin"),(n(&p,"distributionUpperWickMin")*100.0).round(),n(&p,"distributionTurnoverRateMinPct"))]},"warnings":unique,
        "riskNotice":"仅依据输入行情按可配置规则匹配量价形态，不代表识别到真实操盘主体，也不构成投资建议。加密资产与股票均可能因流动性、停牌、除权、合约杠杆和突发消息快速反向。"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_fields_never_invent_net_flow() {
        let rows:Vec<Value>=(0..40).map(|i|json!({"openTime":i*60_000,"open":100,"high":101,"low":99,"close":100,"volume":10})).collect();
        let a = analyze(&json!({"datasets":{"1m":rows},"primaryInterval":"1m"}));
        assert_eq!(a["primary"]["usableBars"], 40);
        assert!(a["primary"]["metrics"]["netFlowRatio"].is_null());
        assert_eq!(a["primary"]["metrics"]["hasFlowData"], false);
    }
    #[test]
    fn excludes_unconfirmed_and_invalid_prices() {
        let a = analyze(
            &json!({"datasets":{"1h":[{"open":100,"high":101,"low":99,"close":100,"volume":10,"confirmed":false},{"open":0,"high":101,"low":99,"close":100,"volume":10}]}}),
        );
        assert_eq!(a["primary"]["usableBars"], 0);
        assert_eq!(a["stage"]["confidence"], 0);
    }
    #[test]
    fn bounds_and_inverted_ranges_follow_contract() {
        let p = normalize_params(
            &json!({"lookbackBars":1,"recentBars":3.8,"accumulationVolumeRatioMin":4,"accumulationVolumeRatioMax":1,"forecastMediumScore":80,"forecastHighScore":70}),
        );
        assert_eq!(n(&p, "lookbackBars"), 10.0);
        assert_eq!(n(&p, "recentBars"), 4.0);
        assert_eq!(n(&p, "accumulationVolumeRatioMin"), 1.0);
        assert_eq!(n(&p, "accumulationVolumeRatioMax"), 4.0);
        assert_eq!(n(&p, "forecastHighScore"), 81.0);
    }
}
