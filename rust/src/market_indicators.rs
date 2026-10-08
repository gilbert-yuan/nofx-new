//! Public market context shared by opportunity reports, predictions and the read-only API.
//! It provides evidence, not a calibrated probability or an additional execution gate.
use crate::{interval_ms, iso, number, timestamp};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn finite(value: &Value) -> Option<f64> {
    let value = number(value, f64::NAN);
    value.is_finite().then_some(value)
}
fn positive(value: &Value) -> Option<f64> {
    finite(value).filter(|n| *n > 0.)
}
fn time(value: &Value) -> Option<i64> {
    timestamp(value).or_else(|| value.as_str()?.parse().ok())
}
fn fresh(at: Option<i64>, now: i64, max_age: i64) -> bool {
    at.is_some_and(|at| at > 0 && at <= now + 5_000 && now - at <= max_age)
}
fn change(current: Option<f64>, prior: Option<f64>) -> Option<f64> {
    current
        .zip(prior)
        .filter(|(_, p)| *p > 0.)
        .map(|(c, p)| (c / p - 1.) * 100.)
}
fn status(at: Option<i64>, valid: bool, now: i64, max_age: i64) -> &'static str {
    if !valid || at.is_none() {
        "unavailable"
    } else if fresh(at, now, max_age) {
        "fresh"
    } else {
        "stale"
    }
}
fn stamped(mut value: Value, at: Option<i64>, state: &str) -> Value {
    value["status"] = json!(state);
    value["asOf"] = json!(at.map(iso));
    value
}
fn series<'a>(raw: &'a Value, key: &str, now: i64) -> BTreeMap<i64, &'a Value> {
    raw[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let at = time(&row["timestamp"])?;
            (at > 0 && at <= now).then_some((at, row))
        })
        .collect()
}
fn close_at(market: &Value, target: i64) -> Option<f64> {
    let interval = interval_ms(market["interval"].as_str()?)?;
    market["klines"]
        .as_array()?
        .iter()
        .filter_map(|row| {
            if row["confirmed"] == false {
                return None;
            }
            let end = time(&row["openTime"])? + interval;
            (end <= target && target - end < interval)
                .then(|| positive(&row["close"]).map(|v| (end, v)))
                .flatten()
        })
        .max_by_key(|(at, _)| *at)
        .map(|(_, price)| price)
}

fn open_interest(raw: &Value, market: &Value, now: i64) -> Value {
    let mut rows = series(raw, "oi5m", now);
    let mut period = 300_000;
    if rows.is_empty() {
        rows = series(raw, "oi", now);
        period = 900_000;
    }
    let last = rows.last_key_value();
    let at = last.map(|(at, _)| *at);
    let latest = last.map(|(_, row)| *row).unwrap_or(&Value::Null);
    let quantity = finite(&latest["sumOpenInterest"]).filter(|n| *n >= 0.);
    let state = status(at, quantity.is_some(), now, period * 2 + 60_000);
    let usable = state == "fresh";
    let mut result = stamped(
        json!({"source":"binance","unit":"base_asset","period":if period==300_000{"5m"}else{"15m"},"quantity":if usable{quantity}else{None},"notionalUsdt":if usable{finite(&latest["sumOpenInterestValue"])}else{None},"changes":{}}),
        at,
        state,
    );
    for (label, duration) in [("5m", 300_000), ("15m", 900_000), ("1h", 3_600_000)] {
        let previous_at = at.map(|at| at - duration);
        let previous = previous_at
            .and_then(|at| rows.get(&at))
            .copied()
            .unwrap_or(&Value::Null);
        let quantity_change = usable
            .then(|| change(quantity, finite(&previous["sumOpenInterest"])))
            .flatten();
        let value_change = usable
            .then(|| {
                change(
                    finite(&latest["sumOpenInterestValue"]),
                    finite(&previous["sumOpenInterestValue"]),
                )
            })
            .flatten();
        let price_change = usable
            .then(|| {
                change(
                    at.and_then(|t| close_at(market, t)),
                    previous_at.and_then(|t| close_at(market, t)),
                )
            })
            .flatten();
        result["changes"][label] = json!({"quantityPct":quantity_change,"notionalPct":value_change,"pricePct":price_change,"from":if quantity_change.is_some(){previous_at.map(iso)}else{None},"to":if quantity_change.is_some(){at.map(iso)}else{None}});
    }
    result
}

fn funding(raw: &Value, now: i64) -> Value {
    let premium = &raw["premium"];
    let at = time(&premium["time"]);
    let rate = finite(&premium["lastFundingRate"]);
    let mark = positive(&premium["markPrice"]);
    let index = positive(&premium["indexPrice"]);
    let next = time(&premium["nextFundingTime"]);
    let state = status(at, rate.is_some() && mark.is_some(), now, 90_000);
    let usable = state == "fresh";
    let info = raw["fundingInfo"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["symbol"] == raw["symbol"]));
    // Absence from the adjustment list does not provide an explicit observed interval.
    let hours = info.and_then(|row| positive(&row["fundingIntervalHours"]));
    stamped(
        json!({"source":"binance","rate":if usable{rate}else{None},"markPrice":if usable{mark}else{None},"indexPrice":if usable{index}else{None},"markIndexDeviationBps":if usable{mark.zip(index).map(|(m,i)|(m/i-1.)*10_000.)}else{None},"nextFundingAt":if usable{next.filter(|t| *t>now).map(iso)}else{None},"secondsToFunding":if usable{next.filter(|t|*t>now).map(|t|(t-now)/1000)}else{None},"intervalHours":hours,"ratePerHour":if usable{rate.zip(hours).map(|(r,h)|r/h)}else{None},"cap":info.and_then(|row|finite(&row["adjustedFundingRateCap"])),"floor":info.and_then(|row|finite(&row["adjustedFundingRateFloor"]))}),
        at,
        state,
    )
}

fn positioning(raw: &Value, key: &str, now: i64) -> Value {
    let rows = series(raw, key, now);
    let latest = rows.last_key_value();
    let at = latest.map(|(at, _)| *at);
    let latest = latest.map(|(_, row)| *row).unwrap_or(&Value::Null);
    let long = finite(&latest["longAccount"]).filter(|v| (0. ..=1.).contains(v));
    let short = finite(&latest["shortAccount"]).filter(|v| (0. ..=1.).contains(v));
    let ratio = positive(&latest["longShortRatio"]);
    let state = status(
        at,
        ratio.is_some() && long.is_some() && short.is_some(),
        now,
        660_000,
    );
    let previous = at
        .and_then(|at| rows.get(&(at - 300_000)))
        .copied()
        .unwrap_or(&Value::Null);
    let usable = state == "fresh";
    stamped(
        json!({"source":"binance","kind":if key=="globalRatio"{"account_ratio"}else{"top_trader_position_ratio"},"longShortRatio":if usable{ratio}else{None},"longFraction":if usable{long}else{None},"shortFraction":if usable{short}else{None},"ratioChangePct":if usable{change(ratio,positive(&previous["longShortRatio"]))}else{None}}),
        at,
        state,
    )
}

fn book(raw: &Value, now: i64) -> Value {
    let depth = &raw["depth"];
    let at = time(&depth["T"])
        .or_else(|| time(&depth["E"]))
        .or_else(|| time(&raw["meta"]["depth"]["fetchedAt"]));
    let levels = |key: &str| -> Option<Vec<(f64, f64)>> {
        let rows = depth[key].as_array()?;
        if rows.is_empty() {
            return None;
        }
        rows.iter()
            .take(20)
            .map(|r| Some((positive(&r[0])?, positive(&r[1])?)))
            .collect()
    };
    let bids = levels("bids");
    let asks = levels("asks");
    let bid = bids.as_ref().and_then(|rows| rows.first()).map(|(p, _)| *p);
    let ask = asks.as_ref().and_then(|rows| rows.first()).map(|(p, _)| *p);
    let valid = bid.zip(ask).is_some_and(|(b, a)| a >= b);
    let state = status(at, valid, now, 30_000);
    let usable = state == "fresh";
    let bid_value = usable.then(|| {
        bids.as_ref()
            .unwrap()
            .iter()
            .map(|(p, q)| p * q)
            .sum::<f64>()
    });
    let ask_value = usable.then(|| {
        asks.as_ref()
            .unwrap()
            .iter()
            .map(|(p, q)| p * q)
            .sum::<f64>()
    });
    stamped(
        json!({"source":"binance","levels":20,"spreadBps":if usable{bid.zip(ask).map(|(b,a)|(a-b)/((a+b)/2.)*10_000.)}else{None},"bidNotionalUsdt":bid_value,"askNotionalUsdt":ask_value,"imbalance":bid_value.zip(ask_value).filter(|(b,a)|b+a>0.).map(|(b,a)|(b-a)/(b+a))}),
        at,
        state,
    )
}

fn flow(market: &Value, now: i64) -> Value {
    let interval = market["interval"].as_str().unwrap_or("1m");
    let duration = interval_ms(interval).unwrap_or(60_000);
    let rows: BTreeMap<i64, &Value> = market["klines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let start = time(&row["openTime"])?;
            (row["confirmed"] != false && start + duration <= now).then_some((start, row))
        })
        .collect();
    let rows: Vec<(i64, &Value)> = rows.into_iter().collect();
    let recent = &rows[rows.len().saturating_sub(5)..];
    let at = recent.last().map(|(start, _)| start + duration);
    let contiguous = recent.len() == 5 && recent.windows(2).all(|w| w[1].0 - w[0].0 == duration);
    let state = status(at, contiguous, now, duration * 2 + 30_000);
    let totals: Option<(f64, f64, f64, f64)> = (state == "fresh")
        .then(|| {
            recent
                .iter()
                .try_fold((0., 0., 0., 0.), |(q, b, v, t), (_, row)| {
                    let quote = finite(&row["quoteVolume"]).filter(|n| *n >= 0.)?;
                    let buy =
                        finite(&row["takerBuyQuoteVolume"]).filter(|n| *n >= 0. && *n <= quote)?;
                    let volume = finite(&row["volume"]).filter(|n| *n >= 0.)?;
                    let trades = finite(&row["tradeCount"]).filter(|n| *n >= 0.)?;
                    Some((q + quote, b + buy, v + volume, t + trades))
                })
        })
        .flatten();
    let prior = if rows.len() >= 10 {
        &rows[rows.len() - 10..rows.len() - 5]
    } else {
        &[]
    };
    let prior_trades: Option<f64> = (!prior.is_empty()
        && prior.windows(2).all(|w| w[1].0 - w[0].0 == duration)
        && prior
            .last()
            .zip(recent.first())
            .is_some_and(|(p, r)| r.0 - p.0 == duration))
    .then(|| {
        prior.iter().try_fold(0., |sum, (_, row)| {
            Some(sum + finite(&row["tradeCount"]).filter(|n| *n >= 0.)?)
        })
    })
    .flatten();
    let valid = totals.is_some_and(|(q, _, v, _)| q > 0. && v > 0.);
    let state = if state == "fresh" && !valid {
        "unavailable"
    } else {
        state
    };
    let totals = valid.then_some(totals).flatten();
    stamped(
        json!({"source":"binance_klines","interval":interval,"windowBars":5,"takerBuyFraction":totals.map(|(q,b,_,_)|b/q),"deltaQuoteUsdt":totals.map(|(q,b,_,_)|2.*b-q),"deltaRatio":totals.map(|(q,b,_,_)|(2.*b-q)/q),"vwap":totals.map(|(q,_,v,_)|q/v),"tradeCount":totals.map(|(_,_,_,t)|t),"tradeCountRatio":totals.and_then(|(_,_,_,t)|prior_trades.filter(|p|*p>0.).map(|p|t/p)),"interpretation":"主动买入减主动卖出的成交额，不代表实际入金或主力资金流入"}),
        at,
        state,
    )
}

pub fn summarize(raw: &Value, market: &Value, now: i64) -> Value {
    let mut result = json!({"version":"public-indicators-v1","mode":"advisory","source":"binance","symbol":raw["symbol"].as_str().or_else(||market["symbol"].as_str()),"evaluatedAt":iso(now),"openInterest":open_interest(raw,market,now),"funding":funding(raw,now),"globalPositioning":positioning(raw,"globalRatio",now),"topPositioning":positioning(raw,"topPositionRatio",now),"orderBook":book(raw,now),"flow":flow(market,now),"sources":raw["meta"],"errors":if raw["errors"].is_object(){raw["errors"].clone()}else{json!({})}});
    let groups = [
        "openInterest",
        "funding",
        "globalPositioning",
        "topPositioning",
        "orderBook",
        "flow",
    ];
    let settled = raw["funding"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| time(&r["fundingTime"]).is_some_and(|t| t <= now))
        .max_by_key(|r| time(&r["fundingTime"]));
    let at = settled.and_then(|r| time(&r["fundingTime"]));
    let rate = settled.and_then(|r| finite(&r["fundingRate"]));
    let state = status(at, rate.is_some(), now, 36 * 3_600_000);
    result["settledFunding"] = stamped(
        json!({"rate":if state=="fresh"{rate}else{None},"kind":"last_settled","source":"binance"}),
        at,
        state,
    );
    let available = groups
        .iter()
        .filter(|key| result[**key]["status"] == "fresh")
        .count();
    result["coverage"] = json!({"fresh":available,"total":groups.len(),"status":if available==groups.len(){"complete"}else if available>0{"partial"}else{"unavailable"}});
    result
}

pub fn evidence(indicators: &Value, long: bool) -> Vec<Value> {
    let side = if long { 1. } else { -1. };
    let mut result = vec![];
    for (key, label, value, note) in [
        (
            "flow",
            "主动成交方向",
            finite(&indicators["flow"]["deltaRatio"]),
            "主动买卖成交差额，只作方向证据",
        ),
        (
            "orderBook",
            "盘口厚度",
            finite(&indicators["orderBook"]["imbalance"]),
            "20 档盘口快照，挂单可能撤回",
        ),
    ] {
        let state = if indicators[key]["status"] != "fresh" {
            "missing"
        } else if value.is_some_and(|v| v * side > 0.) {
            "support"
        } else if value.is_some_and(|v| v * side < 0.) {
            "conflict"
        } else {
            "neutral"
        };
        result.push(json!({"key":key,"label":label,"state":state,"value":value,"asOf":indicators[key]["asOf"],"note":note}));
    }
    result.push(json!({"key":"openInterest","label":"持仓数量与价格","state":if indicators["openInterest"]["status"]=="fresh"{"context"}else{"missing"},"quantityChange15mPct":indicators["openInterest"]["changes"]["15m"]["quantityPct"],"priceChange15mPct":indicators["openInterest"]["changes"]["15m"]["pricePct"],"asOf":indicators["openInterest"]["asOf"],"note":"OI 增加本身不指明多空方向，需结合价格与主动成交"}));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_800_000_000_000;
    fn fixture() -> (Value, Value) {
        let rows:Vec<Value>=(0..80).map(|i|json!({"openTime":NOW-(80-i)*60_000,"close":100.,"volume":10.,"quoteVolume":1000.,"takerBuyQuoteVolume":600.,"tradeCount":if i<75{10}else{20}})).collect();
        let oi:Vec<Value>=(0..13).map(|i|json!({"timestamp":NOW-(12-i)*300_000,"sumOpenInterest":100.,"sumOpenInterestValue":10000.+i as f64*100.})).collect();
        (
            json!({"symbol":"BTCUSDT","oi5m":oi,"premium":{"time":NOW,"markPrice":"100","indexPrice":"99","lastFundingRate":"0","nextFundingTime":NOW+60_000},"fundingInfo":[{"symbol":"BTCUSDT","fundingIntervalHours":4}],"globalRatio":[{"timestamp":NOW,"longAccount":"0.6","shortAccount":"0.4","longShortRatio":"1.5"}],"topPositionRatio":[{"timestamp":NOW,"longAccount":"0.4","shortAccount":"0.6","longShortRatio":"0.666666"}],"depth":{"T":NOW,"bids":[["99","3"]],"asks":[["101","1"]]},"meta":{},"errors":{}}),
            json!({"symbol":"BTCUSDT","interval":"1m","klines":rows}),
        )
    }
    #[test]
    fn quantity_price_and_notional_are_separate_and_funding_zero_is_valid() {
        let (raw, market) = fixture();
        let v = summarize(&raw, &market, NOW);
        assert_eq!(v["coverage"]["fresh"], 6);
        for tf in ["5m", "15m", "1h"] {
            assert_eq!(v["openInterest"]["changes"][tf]["quantityPct"], 0.);
            assert_eq!(v["openInterest"]["changes"][tf]["pricePct"], 0.);
        }
        assert!(number(&v["openInterest"]["changes"]["15m"]["notionalPct"], 0.) > 0.);
        assert_eq!(v["funding"]["rate"], 0.);
        assert_eq!(v["funding"]["secondsToFunding"], 60);
        assert_eq!(v["funding"]["intervalHours"], 4.);
        assert_eq!(v["flow"]["takerBuyFraction"], 0.6);
        assert_eq!(v["flow"]["vwap"], 100.);
        assert_eq!(v["flow"]["deltaQuoteUsdt"], 1000.);
        assert_eq!(v["flow"]["tradeCountRatio"], 2.);
        assert_eq!(evidence(&v, true)[0]["state"], "support");
        assert_eq!(evidence(&v, false)[0]["state"], "conflict");
    }
    #[test]
    fn expired_future_and_missing_data_do_not_become_zero_or_confirmation() {
        let (mut raw, mut market) = fixture();
        raw["premium"]["time"] = json!(NOW - 100_000);
        raw["depth"]["T"] = json!(NOW + 10_000);
        raw["oi5m"] = json!([{ "timestamp":NOW+300_000,"sumOpenInterest":900. }]);
        market["klines"][79]["takerBuyQuoteVolume"] = Value::Null;
        let v = summarize(&raw, &market, NOW);
        assert_eq!(v["funding"]["status"], "stale");
        assert!(v["funding"]["rate"].is_null());
        assert!(v["openInterest"]["quantity"].is_null());
        assert!(v["orderBook"]["imbalance"].is_null());
        assert_eq!(v["flow"]["status"], "unavailable");
        assert!(v["flow"]["deltaRatio"].is_null());
        assert_eq!(evidence(&v, true)[0]["state"], "missing");
    }
    #[test]
    fn gaps_unclosed_candles_and_unobserved_funding_intervals_stay_unknown() {
        let (mut raw, mut market) = fixture();
        raw["oi5m"].as_array_mut().unwrap().remove(9);
        raw["fundingInfo"] = json!([]);
        market["klines"][77]["confirmed"] = json!(false);
        let v = summarize(&raw, &market, NOW);
        assert!(v["openInterest"]["changes"]["15m"]["quantityPct"].is_null());
        assert!(v["funding"]["intervalHours"].is_null());
        assert!(v["funding"]["ratePerHour"].is_null());
        assert_eq!(v["flow"]["status"], "unavailable");
    }
}
