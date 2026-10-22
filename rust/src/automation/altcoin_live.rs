//! Live universe policy for the deployed altcoin breakout variant.
//! Only completed 4h candles in the preceding 30 days enter the ranking.
use crate::{db::Db, number, strategies::altcoin_breakout, timestamp};
use anyhow::Result;
use futures::StreamExt;
use serde_json::{Value, json};

pub(super) const STRATEGY_ID: &str = "altcoin-trend-breakout-live-v1";
const FOUR_HOURS: i64 = altcoin_breakout::INTERVAL_MS;
const DAY: i64 = 86_400_000;
const WINDOW: usize = 180;

pub(super) fn entry_block(state: &Value, candidate: &Value) -> Option<String> {
    if candidate["strategy"]["id"] != STRATEGY_ID {
        return None;
    }
    let signal_at = timestamp(&candidate["signal"]["plan"]["altcoinTrend"]["signalAt"]);
    let Some(signal_at) = signal_at else {
        return Some("山寨突破信号缺少已收盘决策时间".into());
    };
    let orders: Vec<_> = state["orders"].as_array().into_iter().flatten().collect();
    if orders.iter().any(|order| {
        (order["strategyId"] == STRATEGY_ID
            || order["analysisContext"]["strategyId"] == STRATEGY_ID)
            && order["symbol"] == candidate["symbol"]
            && timestamp(&order["plan"]["altcoinTrend"]["signalAt"]) == Some(signal_at)
    }) {
        return Some("该根4h突破信号已经提交，等待下一次新触发".into());
    }
    let active: Vec<_> = orders
        .into_iter()
        .filter(|o| o["status"] == "pending" || o["status"] == "open")
        .collect();
    if active.len() >= 3 {
        return Some("达到山寨突破组合最多3仓上限（含其他策略在途订单）".into());
    }
    let direction = &candidate["signal"]["positionRecommendation"];
    if active
        .iter()
        .filter(|o| &o["direction"] == direction)
        .count()
        >= 2
    {
        return Some("达到山寨突破同方向最多2仓上限".into());
    }
    None
}

fn eligible_contract(contract: &Value, at: i64) -> bool {
    contract["symbol"]
        .as_str()
        .is_some_and(|symbol| symbol.ends_with("USDT") && altcoin_breakout::eligible_symbol(symbol))
        && contract["underlyingType"] == "COIN"
        && contract["contractType"] == "PERPETUAL"
        && timestamp(&contract["onboardDate"])
            .is_some_and(|onboard| onboard > 0 && at - onboard >= 180 * DAY)
}

fn turnover(candles: &[Value], at: i64) -> Option<f64> {
    let closed = candles.partition_point(|row| {
        timestamp(&row["openTime"]).is_some_and(|open| open + FOUR_HOURS <= at)
    });
    let tail = candles.get(closed.checked_sub(WINDOW)?..closed)?;
    let mut total = 0.;
    for (index, row) in tail.iter().enumerate() {
        if timestamp(&row["openTime"])? != at - 30 * DAY + index as i64 * FOUR_HOURS
            || row["confirmed"] == false
        {
            return None;
        }
        let quote = number(&row["quoteVolume"], f64::NAN);
        if !quote.is_finite() || quote < 0. {
            return None;
        }
        total += quote;
    }
    (total.is_finite() && total > 0.).then_some(total)
}

fn rank(mut scores: Vec<(String, f64)>) -> Vec<(String, f64)> {
    scores.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scores.truncate(30);
    scores
}

pub(super) async fn universe(db: &Db, contracts: &[Value], now: i64) -> Result<Value> {
    let at = now.div_euclid(FOUR_HOURS) * FOUR_HOURS;
    let eligible: Vec<_> = contracts
        .iter()
        .filter(|c| eligible_contract(c, at))
        .map(|c| c["symbol"].as_str().unwrap().to_owned())
        .collect();
    let eligible_count = eligible.len();
    let jobs = futures::stream::iter(eligible.into_iter().map(|symbol: String| {
        let db = db.clone();
        async move {
            let candles = db
                .candles(
                    &format!("BINANCE_{symbol}"),
                    "4h",
                    WINDOW as i64,
                    Some(at - 30 * DAY),
                    Some(at),
                )
                .await?;
            Ok::<_, anyhow::Error>(turnover(&candles, at).map(|volume| (symbol, volume)))
        }
    }));
    let mut jobs = jobs.buffer_unordered(4);
    let mut scores = Vec::new();
    while let Some(result) = jobs.next().await {
        if let Some(score) = result? {
            scores.push(score);
        }
    }
    let complete = scores.len();
    let ranked = rank(scores);
    Ok(
        json!({"asOf":crate::iso(at),"lookbackDays":30,"minimumListingDays":180,
        "topN":30,"eligibleContracts":eligible_count,"completeHistories":complete,
        "incompleteHistories":eligible_count-complete,
        "symbols":ranked.iter().map(|r| &r.0).collect::<Vec<_>>(),
        "ranking":ranked.iter().map(|r| json!({"symbol":r.0,"quoteVolume":r.1})).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(at: i64) -> Vec<Value> {
        (0..WINDOW)
            .map(|index| {
                json!({"openTime":at-30*DAY+index as i64*FOUR_HOURS,
            "quoteVolume":10.,"confirmed":true})
            })
            .collect()
    }

    #[test]
    fn universe_requires_the_exact_completed_window_and_ignores_future_volume() {
        let at = 200 * DAY;
        let mut candles = rows(at);
        assert_eq!(turnover(&candles, at), Some(1800.));
        candles.push(json!({"openTime":at,"quoteVolume":1e20,"confirmed":false}));
        assert_eq!(turnover(&candles, at), Some(1800.));
        candles.remove(90);
        assert_eq!(turnover(&candles, at), None);
        let mut invalid = rows(at);
        invalid[50]["quoteVolume"] = Value::Null;
        assert_eq!(turnover(&invalid, at), None);
        assert_eq!(turnover(&rows(at - FOUR_HOURS), at), None);
    }

    #[test]
    fn universe_excludes_new_non_crypto_and_major_assets_and_ranks_ties_stably() {
        let at = 200 * DAY;
        let contract = json!({"symbol":"SOLUSDT","onboardDate":20*DAY,
            "underlyingType":"COIN","contractType":"PERPETUAL"});
        assert!(eligible_contract(&contract, at));
        for (key, value) in [
            ("symbol", json!("BTCUSDT")),
            ("symbol", json!("ETHUSDT")),
            ("symbol", json!("USDCUSDT")),
            ("onboardDate", json!(20 * DAY + 1)),
            ("underlyingType", json!("INDEX")),
            ("contractType", json!("CURRENT_QUARTER")),
        ] {
            let mut excluded = contract.clone();
            excluded[key] = value;
            assert!(!eligible_contract(&excluded, at), "{excluded}");
        }
        let scores = (0..32)
            .rev()
            .map(|i| (format!("ALT{i:02}USDT"), 100.))
            .collect();
        let ranked = rank(scores);
        assert_eq!(ranked.len(), 30);
        assert_eq!(ranked[0].0, "ALT00USDT");
        assert_eq!(ranked[29].0, "ALT29USDT");
    }

    #[test]
    fn entry_caps_include_old_positions_and_closed_signals_cannot_reenter() {
        let candidate = json!({"symbol":"SOLUSDT","strategy":{"id":STRATEGY_ID},
            "signal":{"positionRecommendation":"OPEN_LONG","plan":{"altcoinTrend":{"signalAt":100}}}});
        let mut state = json!({"orders":[]});
        assert_eq!(entry_block(&state, &candidate), None);
        state["orders"] = json!([
            {"status":"open","direction":"OPEN_LONG","strategyId":"old"},
            {"status":"pending","direction":"OPEN_LONG","strategyId":"old"}]);
        assert!(entry_block(&state, &candidate).unwrap().contains("同方向"));
        state["orders"][1]["direction"] = json!("OPEN_SHORT");
        assert_eq!(entry_block(&state, &candidate), None);
        state["orders"]
            .as_array_mut()
            .unwrap()
            .push(json!({"status":"open","direction":"OPEN_SHORT"}));
        assert!(entry_block(&state, &candidate).unwrap().contains("最多3仓"));
        state["orders"] = json!([{"status":"closed","symbol":"SOLUSDT","strategyId":STRATEGY_ID,
            "plan":{"altcoinTrend":{"signalAt":100}}}]);
        assert!(
            entry_block(&state, &candidate)
                .unwrap()
                .contains("已经提交")
        );
        state["orders"][0]["plan"]["altcoinTrend"]["signalAt"] = json!(99);
        assert_eq!(entry_block(&state, &candidate), None);
    }

    #[test]
    fn database_shaped_closed_candles_reach_the_live_strategy() {
        let mut candles: Vec<_> = (0..181)
            .map(|i| {
                let close = 100. + i as f64 * 0.1;
                json!({"openTime":(1000+i)*FOUR_HOURS,"open":close,"high":close+1.,
                "low":close-1.,"close":close,"volume":100.,"quoteVolume":close*100.})
            })
            .collect();
        candles[180]["close"] = json!(121.);
        candles[180]["high"] = json!(121.5);
        candles[180]["low"] = json!(117.);
        let now = 1181 * FOUR_HOURS + 1_000;
        candles.push(json!({"openTime":1181*FOUR_HOURS,"open":121.,"high":1e10,
            "low":1.,"close":1e9,"volume":100.,"confirmed":false}));
        let market = crate::research::prepare_market("SOLUSDT", "4h", &candles, 181, now).unwrap();
        assert_eq!(market["klines"].as_array().unwrap().len(), 181);
        assert!(
            market["klines"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["confirmed"] == true)
        );
        let signal = crate::strategies::analyze(
            STRATEGY_ID,
            &market,
            &json!({"evaluationAt":now,"deferMarketFilters":true}),
        )
        .unwrap();
        assert_eq!(signal["action"], "BUY", "{signal}");
        assert_eq!(
            signal["plan"]["altcoinTrend"]["signalAt"],
            1181 * FOUR_HOURS
        );
        assert_eq!(signal["plan"]["altcoinTrend"]["parameters"]["emaSlow"], 90);
    }
}
