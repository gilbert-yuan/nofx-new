use anyhow::{Result, bail};
use reqwest::header::HeaderMap;
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

// Leave capacity for private requests and other users of the same proxy IP.
const WEIGHT_PER_MINUTE: u32 = 1200;

#[derive(Default)]
pub(super) struct Budget {
    minute: i64,
    used: u32,
    funding_window: i64,
    funding_used: u32,
    cooldown_until: i64,
}

pub(super) fn shared(demo: bool) -> Arc<Mutex<Budget>> {
    static LIVE: OnceLock<Arc<Mutex<Budget>>> = OnceLock::new();
    static DEMO: OnceLock<Arc<Mutex<Budget>>> = OnceLock::new();
    (if demo { &DEMO } else { &LIVE })
        .get_or_init(|| Arc::new(Mutex::new(Budget::default())))
        .clone()
}

pub(super) fn weight(path: &str, params: &Value) -> u32 {
    match path {
        "/fapi/v1/klines" => match params["limit"].as_u64().unwrap_or(500) {
            0..100 => 1,
            100..500 => 2,
            500..=1000 => 5,
            _ => 10,
        },
        "/fapi/v1/ticker/24hr" if params["symbol"].is_null() => 40,
        "/fapi/v1/premiumIndex" if params["symbol"].is_null() => 10,
        "/fapi/v1/depth" => match params["limit"].as_u64().unwrap_or(500) {
            0..=50 => 2,
            51..=100 => 5,
            101..=500 => 10,
            _ => 20,
        },
        "/fapi/v1/ticker/bookTicker" if params["symbol"].is_null() => 5,
        "/fapi/v1/ticker/bookTicker" => 2,
        "/fapi/v1/exchangeInfo"
        | "/fapi/v1/time"
        | "/fapi/v1/ticker/24hr"
        | "/fapi/v1/premiumIndex"
        | "/fapi/v1/openInterest"
        | "/fapi/v1/fundingRate"
        | "/futures/data/openInterestHist" => 1,
        _ => 5,
    }
}

impl Budget {
    fn reset_window(&mut self, now: i64) {
        let minute = now.div_euclid(60_000);
        if minute != self.minute {
            self.minute = minute;
            self.used = 0;
        }
        let funding_window = now.div_euclid(300_000);
        if funding_window != self.funding_window {
            self.funding_window = funding_window;
            self.funding_used = 0;
        }
    }

    // Return the delay without reserving while full, so concurrent waiters recheck capacity.
    pub(super) fn reserve(&mut self, path: &str, params: &Value, now: i64) -> Result<i64> {
        if self.cooldown_until > now {
            bail!(
                "Binance 行情请求冷却中，恢复时间 {}",
                crate::iso(self.cooldown_until)
            );
        }
        self.reset_window(now);
        let cost = weight(path, params);
        if self.used.saturating_add(cost) > WEIGHT_PER_MINUTE {
            return Ok((self.minute + 1) * 60_000 - now + 100);
        }
        if path == "/fapi/v1/fundingRate" && self.funding_used >= 400 {
            return Ok(((self.funding_window + 1) * 300_000 - now + 100).min(60_000));
        }
        self.used += cost;
        if path == "/fapi/v1/fundingRate" {
            self.funding_used += 1;
        }
        Ok(0)
    }

    pub(super) fn observe_headers(&mut self, headers: &HeaderMap, sent: i64, now: i64) {
        self.reset_window(now);
        if sent.div_euclid(60_000) == self.minute
            && let Some(used) = headers
                .get("x-mbx-used-weight-1m")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u32>().ok())
        {
            self.used = self.used.max(used);
        }
    }

    pub(super) fn observe_rejection(
        &mut self,
        status: u16,
        headers: &HeaderMap,
        body: &str,
        now: i64,
    ) {
        if !matches!(status, 418 | 429) {
            return;
        }
        let retry_ms = headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v >= 0)
            .map(|v| v.saturating_mul(1000))
            .unwrap_or(if status == 418 { 120_000 } else { 60_000 });
        let ban_until = body
            .split_once("banned until ")
            .and_then(|(_, text)| text.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|v| v.parse::<i64>().ok());
        self.cooldown_until = self
            .cooldown_until
            .max(ban_until.unwrap_or(now.saturating_add(retry_ms)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn weights_match_kline_boundaries_and_whole_market_tickers() {
        for (limit, expected) in [(99, 1), (100, 2), (499, 2), (500, 5), (1000, 5), (1001, 10)] {
            assert_eq!(weight("/fapi/v1/klines", &json!({"limit":limit})), expected);
        }
        assert_eq!(weight("/fapi/v1/ticker/24hr", &json!({})), 40);
        assert_eq!(
            weight("/fapi/v1/ticker/24hr", &json!({"symbol":"BTCUSDT"})),
            1
        );
    }

    #[test]
    fn observed_ip_usage_blocks_reservations_until_next_minute() {
        let mut budget = Budget::default();
        let mut headers = HeaderMap::new();
        headers.insert("x-mbx-used-weight-1m", "1200".parse().unwrap());
        budget.observe_headers(&headers, 61_000, 61_000);
        assert!(
            budget
                .reserve("/fapi/v1/klines", &json!({"limit":3}), 61_000)
                .unwrap()
                > 0
        );
        assert_eq!(
            budget
                .reserve("/fapi/v1/klines", &json!({"limit":3}), 120_100)
                .unwrap(),
            0
        );
        // A slow response from the previous window must not block the new window.
        budget.observe_headers(&headers, 61_000, 120_100);
        assert_eq!(budget.used, 1);
    }

    #[test]
    fn ban_timestamp_and_retry_after_are_obeyed() {
        let mut budget = Budget::default();
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "90".parse().unwrap());
        budget.observe_rejection(
            418,
            &headers,
            "IP banned until 500000. Please use websocket",
            100_000,
        );
        assert!(
            budget
                .reserve("/fapi/v1/time", &json!({}), 499_999)
                .is_err()
        );
        assert_eq!(
            budget
                .reserve("/fapi/v1/time", &json!({}), 500_000)
                .unwrap(),
            0
        );
        budget.observe_rejection(429, &headers, "", 500_000);
        assert!(
            budget
                .reserve("/fapi/v1/time", &json!({}), 589_999)
                .is_err()
        );
        assert_eq!(
            budget
                .reserve("/fapi/v1/time", &json!({}), 590_000)
                .unwrap(),
            0
        );
    }
}
