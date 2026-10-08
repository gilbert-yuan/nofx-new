//! The same optional entry filters are used by live analysis and chronological replay.
use crate::{market_indicators, number, timestamp};
use serde_json::{Value, json};

pub fn schema() -> Vec<Value> {
    let mut specs = vec![];
    let mut add = |key: &str,
                   label: &str,
                   default: Value,
                   min: f64,
                   max: f64,
                   step: f64,
                   description: &str| {
        specs.push(json!({"key":key,"label":label,"group":"marketContext","type":if default.is_boolean(){"boolean"}else{"number"},"default":default,"min":min,"max":max,"step":step,"description":description}));
    };
    add(
        "marketRequireData",
        "指标缺失时禁止入场",
        json!(true),
        0.,
        1.,
        1.,
        "仅影响已开启的过滤项。回测报告会统计缺失，关闭此项时缺失项跳过而非补零。",
    );
    for (key, label, note) in [
        (
            "marketOiEnabled",
            "启用 OI 数量过滤",
            "5m 历史统计；REST 最近一个月。OI 增加本身不指明方向。",
        ),
        (
            "marketFlowEnabled",
            "启用主动成交过滤",
            "最近 5 根已收盘主周期 K 线；多头用买入占比，空头用卖出占比。",
        ),
        (
            "marketFundingEnabled",
            "启用已结算资金费过滤",
            "使用当时已知的最近一次结算费率；多头取原值，空头取负值。单位为百分数，不使用事后才知道的下一期费率。",
        ),
        (
            "marketGlobalRatioEnabled",
            "启用全市场账户多空比",
            "多头取多/空比，空头取空/多比。REST 最近 30 天。",
        ),
        (
            "marketTopRatioEnabled",
            "启用大户持仓多空比",
            "多头取多/空比，空头取空/多比；与账户多空比不同。REST 最近 30 天。",
        ),
        (
            "marketBookEnabled",
            "启用盘口过滤",
            "20 档实时快照，仅可回测本系统已采集的历史快照；缺失时按数据要求处理。",
        ),
    ] {
        add(key, label, json!(false), 0., 1., 1., note);
    }
    for (key, label, default, min, max, step, note) in [
        (
            "marketOiWindowMinutes",
            "OI 变化窗口（分钟）",
            15.,
            5.,
            60.,
            5.,
            "仅支持 5、15、60 分钟，使用持仓数量变化。",
        ),
        (
            "marketOiMinPct",
            "OI 数量变化下限 %",
            -100.,
            -100.,
            1000.,
            0.1,
            "数值 1 表示增加 1%。",
        ),
        (
            "marketOiMaxPct",
            "OI 数量变化上限 %",
            1000.,
            -100.,
            1000.,
            0.1,
            "下限不得超过上限。",
        ),
        (
            "marketFlowMinFraction",
            "同向主动成交占比下限",
            0.55,
            0.,
            1.,
            0.01,
            "0.55 表示多头主动买入/空头主动卖出至少 55%。",
        ),
        (
            "marketFlowMinActivity",
            "成交活跃度下限",
            0.,
            0.,
            100.,
            0.1,
            "最近 5 根成交笔数 / 前 5 根成交笔数。",
        ),
        (
            "marketFlowMaxVwapDeviationPct",
            "价格偏离窗口 VWAP 上限 %",
            100.,
            0.,
            100.,
            0.1,
            "最新收盘价相对最近 5 根 VWAP 的绝对偏离。",
        ),
        (
            "marketFundingMinPct",
            "同向已结算费率下限 %",
            -5.,
            -5.,
            5.,
            0.001,
            "数值 0.01 表示费率 0.01%；负值代表该方向收取资金费。",
        ),
        (
            "marketFundingMaxPct",
            "同向已结算费率上限 %",
            5.,
            -5.,
            5.,
            0.001,
            "这是信号过滤，回测成交成本继续复用共享成本模型。",
        ),
        (
            "marketGlobalRatioMin",
            "同向账户比例下限",
            0.,
            0.,
            100.,
            0.05,
            "多头为多/空，空头为空/多。",
        ),
        (
            "marketGlobalRatioMax",
            "同向账户比例上限",
            100.,
            0.,
            100.,
            0.05,
            "下限不得超过上限。",
        ),
        (
            "marketTopRatioMin",
            "同向大户持仓比例下限",
            0.,
            0.,
            100.,
            0.05,
            "多头为多/空，空头为空/多。",
        ),
        (
            "marketTopRatioMax",
            "同向大户持仓比例上限",
            100.,
            0.,
            100.,
            0.05,
            "下限不得超过上限。",
        ),
        (
            "marketBookMinImbalance",
            "同向盘口失衡下限",
            0.,
            -1.,
            1.,
            0.05,
            "多头取买盘减卖盘比例，空头取负值；挂单可撤回。",
        ),
        (
            "marketBookMaxSpreadBps",
            "盘口价差上限 bps",
            50.,
            0.,
            1000.,
            0.1,
            "1 bps = 0.01%。",
        ),
    ] {
        add(key, label, json!(default), min, max, step, note);
    }
    specs
}

pub fn enabled(params: &Value) -> bool {
    [
        "marketOiEnabled",
        "marketFlowEnabled",
        "marketFundingEnabled",
        "marketGlobalRatioEnabled",
        "marketTopRatioEnabled",
        "marketBookEnabled",
    ]
    .iter()
    .any(|k| params[*k] == true)
}
pub fn needs_remote(params: &Value) -> bool {
    [
        "marketOiEnabled",
        "marketFundingEnabled",
        "marketGlobalRatioEnabled",
        "marketTopRatioEnabled",
        "marketBookEnabled",
    ]
    .iter()
    .any(|k| params[*k] == true)
}
pub fn validate(params: &Value) -> anyhow::Result<()> {
    if ![5., 15., 60.].contains(&number(&params["marketOiWindowMinutes"], 15.)) {
        anyhow::bail!("400: OI 窗口只支持 5、15、60 分钟");
    }
    for (lo, hi) in [
        ("marketOiMinPct", "marketOiMaxPct"),
        ("marketFundingMinPct", "marketFundingMaxPct"),
        ("marketGlobalRatioMin", "marketGlobalRatioMax"),
        ("marketTopRatioMin", "marketTopRatioMax"),
    ] {
        if number(&params[lo], 0.) > number(&params[hi], 0.) {
            anyhow::bail!("400: {lo} 不得大于 {hi}");
        }
    }
    Ok(())
}

pub fn apply(signal: &mut Value, market: &Value, context: &Value) {
    let p = &context["params"];
    if !enabled(p) || !matches!(signal["action"].as_str(), Some("BUY" | "SELL")) {
        return;
    }
    let now = timestamp(&context["evaluationAt"])
        .or_else(|| timestamp(&market["dataAsOf"]))
        .unwrap_or(0);
    let indicators = market_indicators::summarize(&context["marketContext"], market, now);
    let long = signal["action"] == "BUY";
    let side = if long { 1. } else { -1. };
    let mut checks = vec![];
    let require = p["marketRequireData"] != false;
    let mut check = |key: &str, value: Option<f64>, min: f64, max: f64| {
        let passed = value.map(|v| v >= min && v <= max).unwrap_or(!require);
        checks.push(json!({"key":key,"value":value,"min":min,"max":max,"missing":value.is_none(),"passed":passed}));
    };
    let fresh_value = |group: &str, field: &str| {
        (indicators[group]["status"] == "fresh")
            .then(|| number(&indicators[group][field], f64::NAN))
            .filter(|n| n.is_finite())
    };
    if p["marketOiEnabled"] == true {
        let window = match number(&p["marketOiWindowMinutes"], 15.) as i64 {
            5 => "5m",
            60 => "1h",
            _ => "15m",
        };
        let v = (indicators["openInterest"]["status"] == "fresh")
            .then(|| {
                number(
                    &indicators["openInterest"]["changes"][window]["quantityPct"],
                    f64::NAN,
                )
            })
            .filter(|v| v.is_finite());
        check(
            "openInterest",
            v,
            number(&p["marketOiMinPct"], -100.),
            number(&p["marketOiMaxPct"], 1000.),
        );
    }
    if p["marketFlowEnabled"] == true {
        check(
            "flowDirection",
            fresh_value("flow", "takerBuyFraction").map(|v| if long { v } else { 1. - v }),
            number(&p["marketFlowMinFraction"], 0.55),
            1.,
        );
        check(
            "flowActivity",
            fresh_value("flow", "tradeCountRatio"),
            number(&p["marketFlowMinActivity"], 0.),
            f64::MAX,
        );
        let close = market["klines"]
            .as_array()
            .and_then(|r| r.last())
            .map(|r| number(&r["close"], f64::NAN));
        check(
            "flowVwapDeviation",
            fresh_value("flow", "vwap")
                .zip(close)
                .filter(|(v, c)| *v > 0. && c.is_finite())
                .map(|(v, c)| (c / v - 1.).abs() * 100.),
            0.,
            number(&p["marketFlowMaxVwapDeviationPct"], 100.),
        );
    }
    if p["marketFundingEnabled"] == true {
        check(
            "settledFunding",
            fresh_value("settledFunding", "rate").map(|v| side * v * 100.),
            number(&p["marketFundingMinPct"], -5.),
            number(&p["marketFundingMaxPct"], 5.),
        );
    }
    for (toggle, group, min, max) in [
        (
            "marketGlobalRatioEnabled",
            "globalPositioning",
            "marketGlobalRatioMin",
            "marketGlobalRatioMax",
        ),
        (
            "marketTopRatioEnabled",
            "topPositioning",
            "marketTopRatioMin",
            "marketTopRatioMax",
        ),
    ] {
        if p[toggle] == true {
            check(
                group,
                fresh_value(group, "longShortRatio")
                    .filter(|v| *v > 0.)
                    .map(|v| if long { v } else { 1. / v }),
                number(&p[min], 0.),
                number(&p[max], 100.),
            );
        }
    }
    if p["marketBookEnabled"] == true {
        check(
            "bookImbalance",
            fresh_value("orderBook", "imbalance").map(|v| side * v),
            number(&p["marketBookMinImbalance"], 0.),
            1.,
        );
        check(
            "bookSpread",
            fresh_value("orderBook", "spreadBps"),
            0.,
            number(&p["marketBookMaxSpreadBps"], 50.),
        );
    }
    let passed = checks.iter().all(|c| c["passed"] == true);
    signal["marketFilter"] = json!({"passed":passed,"evaluatedAt":crate::iso(now),"checks":checks,"indicators":indicators});
    if !passed {
        signal["unfilteredAction"] = signal["action"].clone();
        signal["action"] = json!("WAIT");
        signal["decision"] = json!("HOLD");
        signal["state"] = json!("HOLD");
        signal["positionRecommendation"] = json!("WAIT");
        signal["eligible"] = json!(false);
        signal["plan"] = Value::Null;
        signal["reason"] = json!("免费行情指标过滤未通过（或缺少所需历史数据）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn historical_oi_funding_and_ratios_share_live_thresholds() {
        let now = 1_800_000_000_000_i64;
        let market = json!({"symbol":"BTCUSDT","interval":"1m","dataAsOf":crate::iso(now),"klines":(0..80).map(|i|json!({"openTime":now-(80-i)*60_000,"close":100,"volume":10,"quoteVolume":1000,"takerBuyQuoteVolume":600,"tradeCount":10})).collect::<Vec<_>>()});
        let raw = json!({"symbol":"BTCUSDT","oi5m":(0..13).map(|i|json!({"timestamp":now-(12-i)*300_000,"sumOpenInterest":100+i})).collect::<Vec<_>>(),"funding":[{"fundingTime":now-60000,"fundingRate":"0.0001"},{"fundingTime":now+3600000,"fundingRate":"1"}],"globalRatio":[{"timestamp":now,"longAccount":"0.6","shortAccount":"0.4","longShortRatio":"1.5"}],"topPositionRatio":[{"timestamp":now,"longAccount":"0.6","shortAccount":"0.4","longShortRatio":"1.5"}],"depth":{"T":now,"bids":[["99.99","3"]],"asks":[["100.01","1"]]}});
        let p = json!({"marketOiEnabled":true,"marketOiWindowMinutes":15,"marketOiMinPct":2,"marketOiMaxPct":3,"marketFundingEnabled":true,"marketFundingMinPct":0.009,"marketFundingMaxPct":0.011,"marketGlobalRatioEnabled":true,"marketGlobalRatioMin":1.4,"marketGlobalRatioMax":1.6,"marketTopRatioEnabled":true,"marketTopRatioMin":1.4,"marketTopRatioMax":1.6,"marketBookEnabled":true,"marketBookMinImbalance":0.4,"marketBookMaxSpreadBps":3});
        let mut signal = json!({"action":"BUY","plan":{}});
        let mut ctx = json!({"params":p,"marketContext":raw});
        apply(&mut signal, &market, &ctx);
        assert_eq!(signal["action"], "BUY");
        assert!((number(&signal["marketFilter"]["checks"][1]["value"], 0.) - 0.01).abs() < 1e-9);
        ctx["marketContext"]["oi5m"]
            .as_array_mut()
            .unwrap()
            .remove(9);
        signal = json!({"action":"BUY","plan":{}});
        apply(&mut signal, &market, &ctx);
        assert_eq!(signal["positionRecommendation"], "WAIT");
        assert_eq!(signal["marketFilter"]["checks"][0]["missing"], true);
    }
    #[test]
    fn directional_missing_and_default_behavior() {
        let now = 1_800_000_000_000_i64;
        let market = json!({"interval":"1m","dataAsOf":crate::iso(now),"klines":(0..10).map(|i|json!({"openTime":now-(10-i)*60_000,"close":100,"volume":10,"quoteVolume":1000,"takerBuyQuoteVolume":600,"tradeCount":10})).collect::<Vec<_>>()});
        let signal = json!({"action":"BUY","plan":{}});
        let mut v = signal.clone();
        apply(&mut v, &market, &json!({"params":{}}));
        assert_eq!(v, signal);
        let ctx = json!({"params":{"marketFlowEnabled":true,"marketFlowMinFraction":0.55}});
        apply(&mut v, &market, &ctx);
        assert_eq!(v["action"], "BUY");
        v = json!({"action":"SELL","plan":{}});
        apply(&mut v, &market, &ctx);
        assert_eq!(v["action"], "WAIT");
        v = signal.clone();
        apply(&mut v, &market, &json!({"params":{"marketOiEnabled":true}}));
        assert_eq!(v["action"], "WAIT");
        v = signal;
        apply(
            &mut v,
            &market,
            &json!({"params":{"marketOiEnabled":true,"marketRequireData":false}}),
        );
        assert_eq!(v["action"], "BUY");
    }
}
