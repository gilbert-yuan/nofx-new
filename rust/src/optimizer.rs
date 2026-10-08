//! Adaptive parameter search over the shared candle replay. Strategy-agnostic:
//! search keys come from a campaign `searchSpace` or the strategy schema.
use crate::{
    backtest::{self, History},
    interval_ms, iso, number, strategies, timestamp,
};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const INDICATOR_GROUPS: &[&str] = &["indicator"];

#[derive(Clone)]
pub struct SearchDim {
    pub key: String,
    pub values: Vec<Value>,
}

#[derive(Clone)]
pub struct SearchSpec {
    pub strategy_id: String,
    pub base: Value,
    pub dims: Vec<SearchDim>,
}

#[derive(Clone, Copy)]
pub struct Split {
    pub train_start: i64,
    pub train_end: i64,
    pub validation_end: i64,
    pub test_end: i64,
}

pub fn load_campaign(raw: &Value) -> Result<Value> {
    if !raw.is_object() {
        bail!("campaign 必须是 JSON 对象");
    }
    Ok(raw.clone())
}

pub fn period_bounds(campaign: &Value) -> Result<(i64, i64, i64)> {
    let period = &campaign["period"];
    let to = timestamp(&period["to"]).context("period.to 必须是 ISO 时间或毫秒")?;
    let from = timestamp(&period["from"])
        .unwrap_or_else(|| to - (number(&period["days"], 365.).max(1.) as i64) * 86_400_000);
    if from >= to {
        bail!("period.from 必须早于 period.to");
    }
    let warmup = (number(&period["warmupDays"], 90.).max(0.) as i64) * 86_400_000;
    Ok((from, to, warmup))
}

pub fn split_range(from: i64, to: i64, opt: &Value) -> Result<Split> {
    let train_frac = number(&opt["trainFraction"], 0.6).clamp(0.2, 0.85);
    let val_frac = number(&opt["validationFraction"], 0.2).clamp(0.05, 0.5);
    if train_frac + val_frac >= 0.95 {
        bail!("trainFraction + validationFraction 必须小于 0.95");
    }
    let span = to - from;
    let train_end = align((from as f64 + span as f64 * train_frac) as i64);
    let validation_end = align((from as f64 + span as f64 * (train_frac + val_frac)) as i64);
    if train_end <= from || validation_end <= train_end || to <= validation_end {
        bail!("划分后的训练/验证/测试区间为空");
    }
    Ok(Split {
        train_start: from,
        train_end,
        validation_end,
        test_end: to,
    })
}

fn align(t: i64) -> i64 {
    t.div_euclid(60_000) * 60_000
}

pub fn default_indicator_space(id: &str) -> Result<BTreeMap<String, Vec<Value>>> {
    let def = strategies::definition(id).context("未知策略")?;
    let mut space = BTreeMap::new();
    for spec in def["paramSchema"].as_array().unwrap() {
        if !INDICATOR_GROUPS.contains(&spec["group"].as_str().unwrap_or("")) {
            continue;
        }
        if spec["type"] == "boolean" {
            continue;
        }
        let key = spec["key"].as_str().unwrap();
        let default = number(&spec["default"], f64::NAN);
        let min = number(&spec["min"], default);
        let max = number(&spec["max"], default);
        let step = number(&spec["step"], 1.).max(1e-9);
        if !default.is_finite() {
            continue;
        }
        let mut values = vec![];
        for factor in [0.7, 1.0, 1.3] {
            let mut v = (default * factor / step).round() * step;
            v = v.clamp(min, max);
            if spec["step"]
                .as_f64()
                .is_some_and(|s| (s - s.round()).abs() < 1e-12)
            {
                v = v.round();
            }
            let item = json!(v);
            if !values.iter().any(|x| x == &item) {
                values.push(item);
            }
        }
        if values.len() >= 2 {
            space.insert(key.to_owned(), values);
        }
    }
    Ok(space)
}

pub fn resolve_space(
    id: &str,
    campaign: &Value,
    auto_indicators: bool,
) -> Result<BTreeMap<String, Vec<Value>>> {
    if auto_indicators {
        let space = default_indicator_space(id)?;
        if space.is_empty() {
            bail!("{id} 的 schema 没有可搜索的指标周期");
        }
        return Ok(space);
    }
    let mut space = BTreeMap::new();
    let declared = &campaign["strategies"][id]["searchSpace"];
    if let Some(obj) = declared.as_object() {
        for (key, values) in obj {
            let list = values
                .as_array()
                .filter(|v| !v.is_empty())
                .with_context(|| format!("{id}.{key} 的 searchSpace 必须是非空数组"))?;
            space.insert(key.clone(), list.clone());
        }
    }
    if space.is_empty() || campaign["optimization"]["autoSpace"] == true {
        space = default_indicator_space(id)?;
    }
    if space.is_empty() {
        bail!(
            "{id} 没有可搜索参数：请在 campaign.strategies.{id}.searchSpace 声明，或开启 --indicators"
        );
    }
    Ok(space)
}

pub fn search_spec(id: &str, campaign: &Value, auto_indicators: bool) -> Result<SearchSpec> {
    let overrides = campaign["strategies"][id]["params"].clone();
    let resolved = strategies::resolve_params(id, &overrides)?;
    if resolved["rejected"]
        .as_array()
        .is_some_and(|r| !r.is_empty())
    {
        bail!("{id} 基础参数越界：{}", resolved["rejected"]);
    }
    let space = resolve_space(id, campaign, auto_indicators)?;
    let mut dims = vec![];
    for (key, values) in space {
        let mut unique = vec![];
        for value in values {
            let mut trial = resolved["params"].clone();
            trial[&key] = value.clone();
            let checked = strategies::resolve_params(id, &trial)?;
            if !checked["rejected"].as_array().unwrap().is_empty() {
                bail!("{id}.{key} 候选 {value} 越界");
            }
            if !unique.iter().any(|x| x == &value) {
                unique.push(value);
            }
        }
        if unique.len() < 2 {
            continue;
        }
        dims.push(SearchDim {
            key,
            values: unique,
        });
    }
    if dims.is_empty() {
        bail!("{id} 搜索空间折叠后没有可变维度");
    }
    Ok(SearchSpec {
        strategy_id: id.to_owned(),
        base: resolved["params"].clone(),
        dims,
    })
}

fn xorshift(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

fn pick<'a>(rng: &mut u64, values: &'a [Value]) -> &'a Value {
    &values[(xorshift(rng) as usize) % values.len()]
}

pub fn sample_params(spec: &SearchSpec, rng: &mut u64, center: &Value, explore: f64) -> Value {
    let mut params = spec.base.clone();
    if let Some(obj) = center.as_object() {
        for (k, v) in obj {
            params[k] = v.clone();
        }
    }
    for dim in &spec.dims {
        let stay = explore < 1. && (xorshift(rng) as f64 / u64::MAX as f64) > explore;
        if stay && !center[&dim.key].is_null() {
            params[&dim.key] = center[&dim.key].clone();
            continue;
        }
        params[&dim.key] = pick(rng, &dim.values).clone();
    }
    strategies::resolve_params(&spec.strategy_id, &params).unwrap()["params"].clone()
}

pub fn fingerprint(params: &Value, keys: &[String]) -> String {
    let mut parts = vec![];
    for key in keys {
        parts.push(format!("{key}={}", params[key]));
    }
    parts.join("|")
}

pub fn score_trial(trial: &Value, opt: &Value) -> f64 {
    let train = &trial["training"];
    let trades = number(&train["closedTrades"], 0.);
    let min_trades = number(&opt["minTrades"], 30.);
    if trades < min_trades {
        return f64::NEG_INFINITY;
    }
    let ret = number(&train["returnPct"], 0.) / 100.;
    let dd = number(&train["maxDrawdownPct"], 0.) / 100.;
    let max_dd = number(&opt["maxDrawdown"], 0.3);
    let dd_pen = number(&opt["drawdownPenalty"], 0.5);
    let val = &trial["validation"];
    let val_ret = number(&val["returnPct"], 0.) / 100.;
    let instability = (ret - val_ret).abs() * number(&opt["instabilityPenalty"], 0.1);
    let mut score = match opt["objective"].as_str().unwrap_or("return") {
        "calmar" => ret / dd.max(0.01),
        "risk-adjusted" => ret - dd_pen * dd,
        _ => ret - dd_pen * dd.max(0.),
    };
    if dd > max_dd {
        score -= (dd - max_dd) * dd_pen * 4.;
    }
    score - instability
}

#[expect(
    clippy::too_many_arguments,
    reason = "replay inputs stay explicit so search never hides a side channel"
)]
pub fn evaluate_params(
    symbol: &str,
    spec: &SearchSpec,
    params: &Value,
    history: &History,
    config: &Value,
    adaptive: &Value,
    split: &Split,
    initial: f64,
    min_trades: f64,
) -> Result<Value> {
    let training = backtest::replay(
        symbol,
        &spec.strategy_id,
        params,
        &history.datasets,
        &history.samples,
        config,
        split.train_start,
        split.train_end,
        initial,
        adaptive,
    )?;
    let validation = backtest::replay(
        symbol,
        &spec.strategy_id,
        params,
        &history.datasets,
        &history.samples,
        config,
        split.train_end,
        split.validation_end,
        initial,
        adaptive,
    )?;
    let sufficient = number(&training["closedTrades"], 0.) >= min_trades;
    Ok(json!({"params":params,"training":training,"validation":validation,"sufficient":sufficient}))
}

#[expect(
    clippy::too_many_arguments,
    reason = "holdout uses the same explicit replay inputs as training"
)]
pub fn holdout(
    symbol: &str,
    spec: &SearchSpec,
    params: &Value,
    history: &History,
    config: &Value,
    adaptive: &Value,
    split: &Split,
    initial: f64,
) -> Result<Value> {
    backtest::replay(
        symbol,
        &spec.strategy_id,
        params,
        &history.datasets,
        &history.samples,
        config,
        split.validation_end,
        split.test_end,
        initial,
        adaptive,
    )
}

#[expect(
    clippy::too_many_arguments,
    reason = "one symbol search keeps datasets, split and costs visible"
)]
pub fn optimize_symbol(
    symbol: &str,
    spec: &SearchSpec,
    history: &History,
    config: &Value,
    adaptive: &Value,
    split: &Split,
    opt: &Value,
    initial: f64,
) -> Result<Value> {
    let seed = number(&opt["seed"], 20261007.) as u64;
    let mut rng = if seed == 0 {
        0x9E37_79B9_7F4A_7C15
    } else {
        seed
    };
    let max_rounds = number(&opt["maxRounds"], 5.).max(1.) as usize;
    let trials_per = number(&opt["trialsPerRound"], 6.).max(1.) as usize;
    let patience = number(&opt["patience"], 2.).max(1.) as usize;
    let min_improvement = number(&opt["minImprovement"], 0.0001);
    let min_trades = number(&opt["minTrades"], 30.);
    let keys: Vec<String> = spec.dims.iter().map(|d| d.key.clone()).collect();
    let mut seen = BTreeMap::<String, Value>::new();
    let mut trials = vec![];
    let baseline = evaluate_params(
        symbol, spec, &spec.base, history, config, adaptive, split, initial, min_trades,
    )?;
    let mut best = baseline.clone();
    best["score"] = json!(score_trial(&best, opt));
    seen.insert(fingerprint(&spec.base, &keys), best.clone());
    trials.push(best.clone());
    let mut stale = 0;
    for round in 0..max_rounds {
        let explore = (0.85 - round as f64 * 0.15).max(0.25);
        let mut produced = 0;
        let mut attempts = 0;
        while produced < trials_per && attempts < trials_per * 8 {
            attempts += 1;
            let params = sample_params(spec, &mut rng, &best["params"], explore);
            let fp = fingerprint(&params, &keys);
            if seen.contains_key(&fp) {
                continue;
            }
            let mut trial = evaluate_params(
                symbol, spec, &params, history, config, adaptive, split, initial, min_trades,
            )?;
            let score = score_trial(&trial, opt);
            trial["score"] = json!(score);
            trial["round"] = json!(round);
            seen.insert(fp, trial.clone());
            trials.push(trial.clone());
            produced += 1;
            if score.is_finite()
                && score > number(&best["score"], f64::NEG_INFINITY) + min_improvement
            {
                best = trial;
                stale = 0;
            }
        }
        stale += 1;
        if stale > patience {
            break;
        }
    }
    trials.sort_by(|a, b| {
        number(&b["score"], f64::NEG_INFINITY).total_cmp(&number(&a["score"], f64::NEG_INFINITY))
    });
    let test = if best["sufficient"] == true {
        holdout(
            symbol,
            spec,
            &best["params"],
            history,
            config,
            adaptive,
            split,
            initial,
        )?
    } else {
        json!({"skipped":true,"reason":"训练样本不足，不进入测试区间"})
    };
    Ok(json!({
        "symbol":symbol,
        "strategyId":spec.strategy_id,
        "dims":spec.dims.iter().map(|d|json!({"key":d.key,"values":d.values})).collect::<Vec<_>>(),
        "split":{
            "trainStart":iso(split.train_start),
            "trainEnd":iso(split.train_end),
            "validationEnd":iso(split.validation_end),
            "testEnd":iso(split.test_end)
        },
        "baseline":baseline,
        "best":best,
        "holdout":test,
        "trials":trials,
        "selection":"只按训练区间目标函数选参；验证区间惩罚不稳定；测试区间只评估一次最优参数"
    }))
}

pub fn execution_config(campaign: &Value, fallback: &Value) -> Value {
    let mut config = backtest::trading_config(fallback);
    let exec = &campaign["execution"];
    if exec.is_object() {
        if let Some(v) = exec["maxLeverage"].as_f64() {
            config["trader"]["maxLeverage"] = json!(v);
        }
        if let Some(v) = exec["marginPct"].as_f64() {
            config["trader"]["autoMarginPct"] = json!(v);
        }
        if let Some(v) = exec["minOrderMargin"].as_f64() {
            config["trader"]["minOrderMargin"] = json!(v);
        }
    }
    config
}

pub fn initial_balance(campaign: &Value) -> f64 {
    number(&campaign["execution"]["initialBalance"], 1000.).clamp(100., 1_000_000.)
}

pub fn warmup_start(from: i64, warmup: i64, id: &str) -> i64 {
    let def = strategies::definition(id).unwrap_or(json!({}));
    let window = number(&def["marketWindow"], 80.) as i64;
    let dt = interval_ms(def["planInterval"].as_str().unwrap_or("1m")).unwrap_or(60_000);
    from - warmup.max((window + 2) * dt)
}

pub fn summarize_params(params: &Value, dims: &[SearchDim]) -> Map<String, Value> {
    let mut out = Map::new();
    for dim in dims {
        out.insert(dim.key.clone(), params[&dim.key].clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indicator_space_uses_schema_not_exit_rules() {
        let space = default_indicator_space("enhanced-trend-v1").unwrap();
        assert!(space.contains_key("maFastPeriod"));
        assert!(space.contains_key("rsiPeriod"));
        assert!(!space.contains_key("maxHoldBars"));
        assert!(!space.contains_key("stopAtr"));
        for values in space.values() {
            assert!(values.len() >= 2);
        }
    }

    #[test]
    fn campaign_space_is_used_when_indicators_are_off() {
        let campaign = json!({"strategies":{"enhanced-trend-v1":{"params":{},"searchSpace":{"maFastPeriod":[10,20],"rsiPeriod":[10,14,20]}}}});
        let spec = search_spec("enhanced-trend-v1", &campaign, false).unwrap();
        assert_eq!(spec.dims.len(), 2);
        let ma = spec.dims.iter().find(|d| d.key == "maFastPeriod").unwrap();
        assert_eq!(ma.values, vec![json!(10), json!(20)]);
        let indicators = search_spec("enhanced-trend-v1", &campaign, true).unwrap();
        assert!(indicators.dims.len() > 2);
        assert!(indicators.dims.iter().all(|d| d.key != "stopAtr"));
    }

    #[test]
    fn sample_stays_inside_schema() {
        let campaign = json!({"strategies":{"enhanced-trend-v1":{"params":{},"searchSpace":{"maFastPeriod":[8,20,40],"maSlowPeriod":[30,50]}}}});
        let spec = search_spec("enhanced-trend-v1", &campaign, false).unwrap();
        let mut rng = 7;
        for _ in 0..20 {
            let params = sample_params(&spec, &mut rng, &spec.base, 1.);
            let ma_fast = number(&params["maFastPeriod"], 0.);
            let ma_slow = number(&params["maSlowPeriod"], 0.);
            assert!((8. ..=40.).contains(&ma_fast));
            assert!((30. ..=50.).contains(&ma_slow));
        }
    }

    #[test]
    fn insufficient_trades_do_not_win() {
        let opt = json!({"minTrades":30,"drawdownPenalty":0.5,"instabilityPenalty":0.1,"objective":"return","maxDrawdown":0.3});
        let weak = json!({"training":{"closedTrades":2,"returnPct":90.0,"maxDrawdownPct":1.0},"validation":{"returnPct":90.0}});
        let ok = json!({"training":{"closedTrades":40,"returnPct":8.0,"maxDrawdownPct":4.0},"validation":{"returnPct":6.0}});
        assert!(score_trial(&weak, &opt).is_infinite());
        assert!(score_trial(&ok, &opt).is_finite());
        assert!(score_trial(&ok, &opt) > score_trial(&weak, &opt));
    }

    #[test]
    fn split_keeps_holdout_untouched() {
        let from = 1_700_000_000_000;
        let to = from + 100 * 86_400_000;
        let split = split_range(
            from,
            to,
            &json!({"trainFraction":0.6,"validationFraction":0.2}),
        )
        .unwrap();
        assert!(split.train_end > split.train_start);
        assert!(split.validation_end > split.train_end);
        assert!(split.test_end > split.validation_end);
        assert_eq!(split.test_end, to);
    }
}
