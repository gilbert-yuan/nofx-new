//! Shared finite-capital, candle-based replay of a multi-symbol model policy.
//!
//! This module only schedules the existing paper engine. It does not implement
//! fills, stops, targets, fees, funding, or dynamic protection independently.
use crate::ml_replay::{
    ReplayConfig, ReplaySignal, RiskLedger, normalize_signal_with_config, position_size,
};
use crate::{iso, number, paper, research, simulator, strategies, timestamp};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const HOUR: i64 = 3_600_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PortfolioConfig {
    pub replay: ReplayConfig,
    pub top_n: usize,
    pub scan_batch_size: usize,
    pub max_new_entries_per_cycle: usize,
}

impl Default for PortfolioConfig {
    fn default() -> Self {
        Self {
            replay: ReplayConfig::default(),
            top_n: 50,
            scan_batch_size: 20,
            max_new_entries_per_cycle: 1,
        }
    }
}

impl PortfolioConfig {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.replay.starting_equity.is_finite() && self.replay.starting_equity > 0.,
            "Starting equity must be finite and positive"
        );
        ensure!(self.top_n > 0, "top_n must be positive");
        ensure!(self.scan_batch_size > 0, "scan_batch_size must be positive");
        ensure!(
            self.max_new_entries_per_cycle > 0,
            "max_new_entries_per_cycle must be positive"
        );
        // ReplayConfig's validator is private. Exercise the public shared sizing
        // API on a valid fixed plan, so its actual ceilings remain authoritative.
        // This is validation only, never a simulated order or an alternative rule.
        position_size(
            &json!({"eligible":true,"positionRecommendation":"OPEN_LONG",
                "plan":{"entryStyle":"market","entryMin":100.,"entryMax":100.,
                    "stopLoss":99.,"maxHoldBars":11}}),
            self.replay.starting_equity.max(1000.),
            &self.replay,
        )?;
        Ok(())
    }
}

struct Market<'a> {
    rows: &'a [Value],
    closes: Vec<i64>,
    segment_starts: Vec<usize>,
    interval_ms: i64,
}

impl<'a> Market<'a> {
    fn new(rows: &'a [Value], interval_ms: i64) -> Result<Self> {
        ensure!(!rows.is_empty(), "Portfolio market has no candles");
        let mut closes = Vec::with_capacity(rows.len());
        let mut segment_starts = Vec::with_capacity(rows.len());
        let mut segment_start = 0;
        for (index, row) in rows.iter().enumerate() {
            ensure!(simulator::valid_candle(row), "Invalid portfolio candle");
            let close = timestamp(&row["openTime"])
                .context("Invalid candle openTime")?
                .checked_add(interval_ms)
                .context("Candle close overflow")?;
            ensure!(
                close.rem_euclid(interval_ms) == 0,
                "Unaligned portfolio candle"
            );
            if let Some(&previous) = closes.last() {
                ensure!(close > previous, "Unsorted or duplicate portfolio candle");
                if close != previous + interval_ms {
                    segment_start = index;
                }
            }
            closes.push(close);
            segment_starts.push(segment_start);
        }
        Ok(Self {
            rows,
            closes,
            segment_starts,
            interval_ms,
        })
    }

    fn at(&self, now: i64) -> Option<usize> {
        self.closes.binary_search(&now).ok()
    }

    fn closed_prefix(&self, index: usize) -> &[Value] {
        &self.rows[self.segment_starts[index]..=index]
    }

    fn quote_volume_24h(&self, now: i64) -> Option<f64> {
        let index = self.at(now)?;
        let bars = (24 * HOUR / self.interval_ms) as usize;
        if index + 1 - self.segment_starts[index] < bars {
            return None;
        }
        let mut total = 0.;
        for row in &self.rows[index + 1 - bars..=index] {
            let volume = number(&row["quoteVolume"], f64::NAN);
            if !volume.is_finite() || volume < 0. {
                return None;
            }
            total += volume;
        }
        (total.is_finite() && total > 0.).then_some(total)
    }
}

fn active(order: &Value) -> bool {
    matches!(order["status"].as_str(), Some("pending" | "open"))
}

fn decision(value: &str) -> Result<&'static str> {
    match value.to_ascii_uppercase().as_str() {
        "BUY" | "OPEN_LONG" => Ok("BUY"),
        "SELL" | "OPEN_SHORT" => Ok("SELL"),
        "HOLD" | "WAIT" => Ok("HOLD"),
        _ => bail!("Unknown decision {value}; expected BUY, SELL or HOLD"),
    }
}

fn liquidity_rank<'a>(markets: &BTreeMap<&'a str, Market<'_>>, now: i64) -> Vec<(&'a str, f64)> {
    let mut ranked: Vec<_> = markets
        .iter()
        .filter_map(|(&symbol, market)| market.quote_volume_24h(now).map(|v| (symbol, v)))
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    ranked
}

/// Freeze the same execution plan as ml_trade_labels::frozen_signal. A model
/// signal without a plan must retain the label's dynamic/MA exit semantics;
/// ml_replay's generic None-plan default does not freeze those exit rules.
fn label_equivalent_signal(
    symbol: &str,
    closed_prefix: &[Value],
    signal: &ReplaySignal,
    config: &ReplayConfig,
) -> Result<ReplaySignal> {
    if signal.plan.is_some() || decision(&signal.decision)? == "HOLD" {
        return Ok(signal.clone());
    }
    let price = number(
        &closed_prefix
            .last()
            .context("Missing portfolio signal prefix")?["close"],
        f64::NAN,
    );
    let atr = strategies::atr(closed_prefix, 14);
    ensure!(price.is_finite() && price > 0., "Invalid prefix price");
    ensure!(atr.is_finite() && atr > 0., "Invalid prefix ATR");
    let direction = if decision(&signal.decision)? == "BUY" {
        1.
    } else {
        -1.
    };
    let mut plan = json!({"entryStyle":"market","entryMin":price-0.5*atr,
        "entryMax":price+0.5*atr,"stopLoss":price-direction*2.*atr,
        "takeProfit":price+direction*5.*atr,"riskUnit":2.*atr,"maxHoldBars":11});
    plan["exitRules"] = strategies::ml_horizon_exit_rules();
    let mut frozen = signal.clone();
    frozen.plan = Some(plan);
    // Match the label producer's initial normalization and frozen plan before
    // the common replay normalization at submission. Explicit caller plans are
    // returned above and are neither replaced nor augmented here.
    let normalized = normalize_signal_with_config(symbol, closed_prefix, &frozen, config)?;
    if normalized["plan"].is_object() {
        frozen.plan = Some(normalized["plan"].clone());
    }
    Ok(frozen)
}

/// The caller supplies each symbol's evaluation window plus causal warmup only.
/// Listings/retirements may have different coverage. No future labels or future
/// liquidity are used to decide membership, scan order, sizing, or execution.
pub fn replay_portfolio(
    markets: &BTreeMap<String, Vec<Value>>,
    signals: &BTreeMap<String, Vec<ReplaySignal>>,
    config: &PortfolioConfig,
) -> Result<Value> {
    config.validate()?;
    let interval_ms = config.replay.candle_interval_ms;
    ensure!(!markets.is_empty(), "Portfolio requires markets");
    let mut prepared = BTreeMap::new();
    for (symbol, rows) in markets {
        crate::exchange::valid_symbol(symbol)?;
        prepared.insert(
            symbol.as_str(),
            Market::new(rows, interval_ms).with_context(|| symbol.clone())?,
        );
    }
    let available_start = prepared.values().map(|m| m.closes[0]).min().unwrap();
    let available_end = prepared
        .values()
        .map(|m| *m.closes.last().unwrap())
        .max()
        .unwrap();
    let first_signal = signals.values().flatten().map(|s| s.origin_ms).min();
    let start = if config.replay.start_ms == 0 {
        first_signal.unwrap_or(available_start)
    } else {
        config.replay.start_ms
    };
    let end = if config.replay.end_ms == i64::MAX {
        available_end
    } else {
        config.replay.end_ms
    };
    ensure!(start <= end, "Portfolio start follows end");
    ensure!(
        start.rem_euclid(interval_ms) == 0 && end.rem_euclid(interval_ms) == 0,
        "Portfolio boundaries must align to the configured candle interval"
    );
    ensure!(
        start >= available_start && end <= available_end,
        "Portfolio interval is outside all supplied coverage"
    );
    let mut by_time: BTreeMap<i64, BTreeMap<&str, &ReplaySignal>> = BTreeMap::new();
    let mut outside = 0_usize;
    let mut supplied = 0_usize;
    for (symbol, values) in signals {
        ensure!(
            prepared.contains_key(symbol.as_str()),
            "Signals have no market: {symbol}"
        );
        for signal in values {
            supplied += 1;
            decision(&signal.decision)?;
            ensure!(
                signal.origin_ms.rem_euclid(interval_ms) == 0,
                "Unaligned signal"
            );
            if signal.origin_ms < start || signal.origin_ms > end {
                outside += 1;
                continue;
            }
            ensure!(
                prepared[symbol.as_str()].at(signal.origin_ms).is_some(),
                "Signal has no closed candle: {symbol} at {}",
                signal.origin_ms
            );
            ensure!(
                by_time
                    .entry(signal.origin_ms)
                    .or_default()
                    .insert(symbol, signal)
                    .is_none(),
                "Duplicate symbol signal at the same origin"
            );
        }
    }
    let mut account = json!({"initialBalance":config.replay.starting_equity,
        "unlimitedCapital":false,"orders":[],"entriesPaused":false});
    let mut ledger = RiskLedger::new(config.replay.starting_equity);
    let mut curve = Vec::new();
    let mut signal_log = Vec::new();
    let mut gap_log = Vec::new();
    let mut blocked_orders = BTreeSet::new();
    let mut rejections: BTreeMap<String, usize> = BTreeMap::new();
    let mut cursor = 0_usize;
    let mut peak = config.replay.starting_equity;
    let mut max_drawdown: f64 = 0.;
    let mut scanned_without_signal = 0_usize;
    let mut scanned_symbols = 0_usize;
    let mut now = start;
    loop {
        // Advance all existing reservations/positions before admitting candidates.
        // A missing candle is never skipped: freeze that unresolved order and stop
        // new entries globally, since its account equity is no longer current.
        for order in account["orders"].as_array_mut().unwrap() {
            if !active(order) {
                continue;
            }
            let id = order["id"].as_str().context("Order id missing")?.to_owned();
            if blocked_orders.contains(&id) {
                continue;
            }
            let symbol = order["symbol"]
                .as_str()
                .context("Order symbol missing")?
                .to_owned();
            let market = prepared
                .get(symbol.as_str())
                .context("Order market missing")?;
            if let Some(index) = market.at(now) {
                paper::advance_paper_order(order, &market.rows[..=index], now)?;
                if !order["error"].as_str().unwrap_or("").is_empty() {
                    blocked_orders.insert(id.clone());
                    gap_log.push(json!({"time_ms":now,"symbol":symbol,"order_id":id,
                        "reason":"shared_engine_data_gap","error":order["error"]}));
                }
            } else {
                blocked_orders.insert(id.clone());
                gap_log.push(json!({"time_ms":now,"symbol":symbol,"order_id":id,
                    "reason":"missing_candle_for_active_order"}));
                order["error"] =
                    json!("Missing configured closed candle; replay has not skipped the gap");
            }
        }
        account["entriesPaused"] = json!(!blocked_orders.is_empty());
        let funds = paper::account_summary(&account, now);
        let equity = number(&funds["equity"], f64::NAN);
        ensure!(equity.is_finite(), "Non-finite shared account equity");
        let (drawdown, daily_loss) = ledger.observe(now, equity, &config.replay);
        peak = peak.max(equity);
        max_drawdown = max_drawdown.max(((peak - equity) / peak).max(0.));
        let mut ranked = liquidity_rank(&prepared, now);
        ranked.truncate(config.top_n);
        let scan_count = ranked.len().min(config.scan_batch_size);
        let mut admitted = 0_usize;
        for offset in 0..scan_count {
            let (symbol, quote_volume) = ranked[(cursor + offset) % ranked.len()];
            scanned_symbols += 1;
            let Some(signal) = by_time.get(&now).and_then(|m| m.get(symbol)).copied() else {
                scanned_without_signal += 1;
                continue;
            };
            let action = decision(&signal.decision)?;
            let mut item = json!({"origin_ms":now,"symbol":symbol,"decision":action,
                "quote_volume_24h":quote_volume,"scan_position":offset,
                "equity_before":equity,"metadata":signal.metadata,"outcome":""});
            let reason = if action == "HOLD" {
                Some("hold")
            } else if (action == "BUY" && !config.replay.allow_buy)
                || (action == "SELL" && !config.replay.allow_sell)
            {
                Some("direction_disabled")
            } else if !blocked_orders.is_empty() {
                Some("incomplete_position_data")
            } else if ledger.entry_block().is_some() {
                Some("shared_risk_halt")
            } else if equity <= 0. {
                Some("non_positive_equity")
            } else if admitted >= config.max_new_entries_per_cycle {
                Some("cycle_entry_limit")
            } else if account["orders"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| active(o) && o["symbol"] == symbol)
            {
                Some("active_symbol_order")
            } else {
                None
            };
            if let Some(reason) = reason {
                item["outcome"] = json!(reason);
            } else {
                let market = &prepared[symbol];
                let index = market.at(now).unwrap();
                let prefix = market.closed_prefix(index);
                match label_equivalent_signal(symbol, prefix, signal, &config.replay).and_then(
                    |frozen| normalize_signal_with_config(symbol, prefix, &frozen, &config.replay),
                ) {
                    Ok(normalized) if normalized["eligible"] == true => {
                        match position_size(&normalized, equity, &config.replay) {
                            Ok(size) => {
                                let record_id = format!("ml-portfolio-{symbol}-{now}");
                                let record = json!({"id":record_id,"marketProvider":"binance",
                                    "analysisEngine":"local_ml_portfolio_replay",
                                    "snapshot":{"model":signal.metadata},"analyses":[normalized]});
                                match paper::submit_paper_order(
                                    &mut account,
                                    &record,
                                    &json!({"symbol":symbol,"margin":size["margin_usdt"],"leverage":1}),
                                    now,
                                ) {
                                    Ok(_) => {
                                        // Stable audit identifiers; all financial fields remain
                                        // exactly as produced by submit_paper_order.
                                        account["orders"][0]["id"] = json!(record_id);
                                        admitted += 1;
                                        item["outcome"] = json!("submitted");
                                        item["order_id"] = json!(record_id);
                                        item["sizing"] = size;
                                    }
                                    Err(error) => {
                                        item["outcome"] = json!("submission_rejected");
                                        item["error"] = json!(error.to_string());
                                    }
                                }
                            }
                            Err(error) => {
                                item["outcome"] = json!("risk_size_rejected");
                                item["error"] = json!(error.to_string());
                            }
                        }
                    }
                    Ok(normalized) => {
                        item["outcome"] = json!("invalid_plan");
                        item["error"] = normalized["validationIssues"].clone();
                    }
                    Err(error) => {
                        item["outcome"] = json!("invalid_prefix");
                        item["error"] = json!(error.to_string());
                    }
                }
            }
            if item["outcome"] != "submitted" {
                *rejections
                    .entry(item["outcome"].as_str().unwrap().to_owned())
                    .or_default() += 1;
            }
            signal_log.push(item);
        }
        if !ranked.is_empty() {
            cursor = (cursor + scan_count) % ranked.len();
        }
        let funds = paper::account_summary(&account, now);
        curve.push(
            json!({"time_ms":now,"equity":funds["equity"],"balance":funds["balance"],
            "available":funds["available"],"used_margin":funds["usedMargin"],
            "fee_reserve":funds["feeReserve"],"open_orders":funds["openCount"],
            "drawdown_percent":drawdown*100.,"daily_loss_percent":daily_loss*100.,
            "liquid_symbols":ranked.len(),"scanned_symbols":scan_count,
            "entries_blocked":!blocked_orders.is_empty() || ledger.entry_block().is_some()}),
        );
        if now == end {
            break;
        }
        now = now
            .checked_add(interval_ms)
            .context("Portfolio time overflow")?;
    }
    let final_account = paper::account_summary(&account, end);
    let final_equity = number(&final_account["equity"], f64::NAN);
    let orders = account["orders"].as_array().unwrap();
    let closed: Vec<_> = orders.iter().filter(|o| o["status"] == "closed").collect();
    let unresolved = orders.iter().filter(|o| active(o)).count();
    let settled_net: f64 = closed.iter().map(|o| number(&o["net"], 0.)).sum();
    let profits: f64 = closed.iter().map(|o| number(&o["net"], 0.).max(0.)).sum();
    let losses: f64 = closed.iter().map(|o| -number(&o["net"], 0.).min(0.)).sum();
    let active_symbols: BTreeSet<_> = orders
        .iter()
        .filter(|o| number(&o["entry"], 0.) > 0.)
        .filter_map(|o| o["symbol"].as_str())
        .collect();
    Ok(
        json!({"schema_version":1,"scope":"one shared finite-capital paper account",
        "interval":config.replay.candle_interval()?,"start_ms":start,"end_ms":end,"start":iso(start),"end":iso(end),
        "config":config,"costs":research::costs(),"source_symbols":markets.len(),
        "selection_policy":{"liquidity":"sum of previous 24 hours of contiguous closed candle quoteVolume",
            "liquidity_window_bars":24*HOUR/interval_ms,
            "ties":"symbol ascending","scan":"rotating rank cursor; reset cursor at evaluation start",
            "existing_orders_advanced_first":true,"future_labels_used":false,
            "default_execution_plan":"label-equivalent frozen 2ATR stop,5ATR target,11 bars and shared exit_rules_for"},
        "metrics":{"net_pnl_usdt":final_equity-config.replay.starting_equity,
            "final_equity":final_equity,"return_percent":(final_equity/config.replay.starting_equity-1.)*100.,
            "closed_trades":closed.len(),"submitted_orders":orders.len(),
            "entered_trades":orders.iter().filter(|o|number(&o["entry"],0.)>0.).count(),
            "settled_net_usdt":settled_net,"active_symbols":active_symbols.len(),
            "wins":closed.iter().filter(|o|number(&o["net"],0.)>0.).count(),
            "losses":closed.iter().filter(|o|number(&o["net"],0.)<0.).count(),
            "profit_factor":(losses>0.).then(||profits/losses),
            "max_drawdown_percent":max_drawdown*100.,"unresolved_orders":unresolved,
            "comparison_complete":unresolved==0 && blocked_orders.is_empty(),
            "gap_blocked_orders":blocked_orders.len(),"signals_supplied":supplied,
            "signals_scanned":signal_log.len(),"scanned_symbols":scanned_symbols,
            "scanned_without_signal":scanned_without_signal,"ignored_signals_outside_window":outside,
            "rejections":rejections},"final_account":final_account,"orders":orders,
        "signal_log":signal_log,"equity_curve":curve,"data_gap_log":gap_log,
        "limitations":["Paper entry has a one-source-candle delay (15m or 1h); this is not immediate Demo execution or order-book replay.",
            "Fees, funding, slippage and dynamic exits use the shared simulator assumptions, not reconstructed venue fills.",
            "Missing active-position candles freeze that order and block all new entries; stale marks make the comparison incomplete.",
            "Liquidity ranking requires 24 complete closed hours (24 hourly bars or 96 quarter-hour bars); newly listed or post-gap symbols wait for this history.",
            "Unclosed positions are marked by the shared account and are never force-liquidated at the evaluation boundary."]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(count: usize, quote: f64) -> Vec<Value> {
        (0..count)
            .map(|i| {
                json!({"openTime":i as i64*HOUR,"open":100.,"high":101.,
            "low":99.,"close":100.,"volume":1.,"quoteVolume":quote,"confirmed":true})
            })
            .collect()
    }

    fn signal(hour: i64, action: &str) -> ReplaySignal {
        ReplaySignal {
            origin_ms: hour * HOUR,
            decision: action.to_owned(),
            probabilities: json!({"BUY":0.8,"SELL":0.1,"HOLD":0.1}),
            metadata: json!({}),
            plan: None,
        }
    }

    fn config(start: i64, end: i64) -> PortfolioConfig {
        PortfolioConfig {
            replay: ReplayConfig {
                start_ms: start * HOUR,
                end_ms: end * HOUR,
                ..ReplayConfig::default()
            },
            ..PortfolioConfig::default()
        }
    }

    #[test]
    fn quarter_hour_portfolio_requires_96_bars_and_matches_shared_labels() {
        let quarter = 900_000;
        let mut rows = candles(160, 1000.);
        for (index, row) in rows.iter_mut().enumerate() {
            row["openTime"] = json!(index as i64 * quarter);
        }
        let market = Market::new(&rows, quarter).unwrap();
        assert_eq!(market.quote_volume_24h(95 * quarter), None);
        assert_eq!(market.quote_volume_24h(96 * quarter), Some(96_000.));
        let replay = ReplayConfig {
            candle_interval_ms: quarter,
            start_ms: 95 * quarter,
            end_ms: 144 * quarter,
            ..ReplayConfig::default()
        };
        let signals = [95, 96]
            .into_iter()
            .map(|bar| ReplaySignal {
                origin_ms: bar * quarter,
                decision: "BUY".into(),
                probabilities: Value::Null,
                metadata: json!({}),
                plan: None,
            })
            .collect();
        let result = replay_portfolio(
            &BTreeMap::from([("BTCUSDT".into(), rows.clone())]),
            &BTreeMap::from([("BTCUSDT".into(), signals)]),
            &PortfolioConfig {
                replay: replay.clone(),
                ..PortfolioConfig::default()
            },
        )
        .unwrap();
        let label = crate::ml_trade_labels::label_origin(
            "BTCUSDT",
            &rows,
            96 * quarter,
            144 * quarter,
            &crate::ml_trade_labels::TradeLabelConfig {
                observation_hours: 12,
                replay,
                ..crate::ml_trade_labels::TradeLabelConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result["interval"], "15m");
        assert_eq!(result["selection_policy"]["liquidity_window_bars"], 96);
        assert_eq!(result["metrics"]["submitted_orders"], 1);
        assert_eq!(result["orders"][0]["pendingOrderTtlMs"], 24 * quarter);
        assert_eq!(
            timestamp(&result["orders"][0]["entryAt"]),
            label.long.entry_at_ms
        );
        assert_eq!(
            timestamp(&result["orders"][0]["exitAt"]),
            label.long.exit_at_ms
        );
        assert_eq!(
            number(&result["orders"][0]["net"], f64::NAN),
            label.long.net_usdt.unwrap()
        );
        assert_eq!(result["orders"][0]["plan"], label.long.plan);
    }

    #[test]
    fn quarter_hour_missing_bar_blocks_shared_entries_without_skipping() {
        let quarter = 900_000;
        let mut rows = candles(144, 1000.);
        for (index, row) in rows.iter_mut().enumerate() {
            row["openTime"] = json!(index as i64 * quarter);
        }
        rows.remove(96);
        let signal = ReplaySignal {
            origin_ms: 96 * quarter,
            decision: "BUY".into(),
            probabilities: Value::Null,
            metadata: json!({}),
            plan: None,
        };
        let result = replay_portfolio(
            &BTreeMap::from([("BTCUSDT".into(), rows)]),
            &BTreeMap::from([("BTCUSDT".into(), vec![signal])]),
            &PortfolioConfig {
                replay: ReplayConfig {
                    candle_interval_ms: quarter,
                    start_ms: 96 * quarter,
                    end_ms: 144 * quarter,
                    ..ReplayConfig::default()
                },
                ..PortfolioConfig::default()
            },
        )
        .unwrap();
        assert_eq!(result["metrics"]["gap_blocked_orders"], 1);
        assert_eq!(result["metrics"]["comparison_complete"], false);
        assert_eq!(result["data_gap_log"][0]["time_ms"], 97 * quarter);
    }

    #[test]
    fn one_symbol_uses_the_shared_engine_for_entry_exit_and_net_equity() {
        let rows = candles(72, 1000.);
        let policy = vec![signal(24, "BUY")];
        let cfg = config(24, 36);
        let result = replay_portfolio(
            &BTreeMap::from([("BTCUSDT".into(), rows.clone())]),
            &BTreeMap::from([("BTCUSDT".into(), policy.clone())]),
            &cfg,
        )
        .unwrap();
        let label = crate::ml_trade_labels::label_origin(
            "BTCUSDT",
            &rows,
            24 * HOUR,
            72 * HOUR,
            &crate::ml_trade_labels::TradeLabelConfig::default(),
        )
        .unwrap();
        let mut explicit_policy = policy.clone();
        explicit_policy[0].plan = Some(label.long.plan.clone());
        let single =
            crate::ml_replay::replay("BTCUSDT", &rows, &explicit_policy, &cfg.replay).unwrap();
        assert_eq!(
            result["metrics"]["net_pnl_usdt"],
            single["metrics"]["net_pnl_usdt"]
        );
        assert_eq!(
            result["orders"][0]["entryAt"],
            single["orders"][0]["entryAt"]
        );
        assert_eq!(result["orders"][0]["exitAt"], single["orders"][0]["exitAt"]);
        assert_eq!(result["orders"][0]["net"], single["orders"][0]["net"]);
        assert_eq!(result["orders"][0]["gross"], single["orders"][0]["gross"]);
        assert_eq!(result["orders"][0]["reason"], single["orders"][0]["reason"]);
        assert_eq!(result["metrics"]["closed_trades"], 1);
    }

    #[test]
    fn default_portfolio_plans_keep_hard_stops_instead_of_zero_bar_ma_exits() {
        for action in ["BUY", "SELL"] {
            let mut rows = candles(72, 1000.);
            // Break the MA by more than one ATR, while staying inside the
            // original two-ATR stop. Horizon ML plans must not inherit the
            // enhanced-trend 0-bar MA exit on this adverse but in-stop path.
            for row in &mut rows[25..] {
                if action == "BUY" {
                    row["open"] = json!(100.);
                    row["high"] = json!(100.);
                    row["low"] = json!(97.);
                    row["close"] = json!(97.5);
                } else {
                    row["open"] = json!(100.);
                    row["high"] = json!(103.);
                    row["low"] = json!(100.);
                    row["close"] = json!(102.5);
                }
            }
            let label = crate::ml_trade_labels::label_origin(
                "BTCUSDT",
                &rows,
                24 * HOUR,
                72 * HOUR,
                &crate::ml_trade_labels::TradeLabelConfig::default(),
            )
            .unwrap();
            let outcome = if action == "BUY" {
                &label.long
            } else {
                &label.short
            };
            assert_ne!(outcome.reason.as_deref(), Some("smart_exit_ma"));
            assert_eq!(
                outcome.plan["exitRules"],
                crate::strategies::ml_horizon_exit_rules()
            );
            let policy = vec![signal(24, action)];
            let cfg = config(24, 72);
            let result = replay_portfolio(
                &BTreeMap::from([("BTCUSDT".into(), rows.clone())]),
                &BTreeMap::from([("BTCUSDT".into(), policy.clone())]),
                &cfg,
            )
            .unwrap();
            let mut explicit = policy;
            explicit[0].plan = Some(outcome.plan.clone());
            let baseline =
                crate::ml_replay::replay("BTCUSDT", &rows, &explicit, &cfg.replay).unwrap();
            let order = &result["orders"][0];
            for field in ["net", "gross", "reason", "entryAt", "exitAt"] {
                assert_eq!(
                    order[field], baseline["orders"][0][field],
                    "{action}: {field}"
                );
            }
            assert_eq!(number(&order["net"], f64::NAN), outcome.net_usdt.unwrap());
            assert_eq!(
                number(&order["gross"], f64::NAN),
                outcome.gross_usdt.unwrap()
            );
            assert_eq!(order["plan"]["exitRules"], outcome.plan["exitRules"]);
            assert_eq!(order["reason"], "timeout");
        }
    }

    #[test]
    fn explicit_plans_are_preserved_without_inserting_default_exit_rules() {
        let rows = candles(40, 1000.);
        let mut signal = signal(24, "BUY");
        let plan = json!({"entryStyle":"market","entryMin":99.,"entryMax":101.,
            "stopLoss":96.,"takeProfit":110.,"riskUnit":4.,"maxHoldBars":7,
            "exitRules":{"smartExit":{"enabled":false,"barLevelEnabled":false},
                "partialTp":{"enabled":false}}});
        signal.plan = Some(plan.clone());
        let frozen =
            label_equivalent_signal("BTCUSDT", &rows[..24], &signal, &ReplayConfig::default())
                .unwrap();
        assert_eq!(frozen.plan, Some(plan));
        let config = config(24, 36);
        let result = replay_portfolio(
            &BTreeMap::from([("BTCUSDT".into(), rows.clone())]),
            &BTreeMap::from([("BTCUSDT".into(), vec![signal.clone()])]),
            &config,
        )
        .unwrap();
        let baseline =
            crate::ml_replay::replay("BTCUSDT", &rows, &[signal], &config.replay).unwrap();
        for field in ["net", "gross", "reason", "entryAt", "exitAt"] {
            assert_eq!(result["orders"][0][field], baseline["orders"][0][field]);
        }
    }

    #[test]
    fn causal_liquidity_ranking_and_rotation_limit_new_entries() {
        let markets = BTreeMap::from([
            ("BTCUSDT".into(), candles(50, 10.)),
            ("ETHUSDT".into(), candles(50, 20.)),
        ]);
        let signals = BTreeMap::from([
            ("BTCUSDT".into(), vec![signal(24, "BUY"), signal(25, "BUY")]),
            ("ETHUSDT".into(), vec![signal(24, "BUY"), signal(25, "BUY")]),
        ]);
        let mut cfg = config(24, 37);
        cfg.scan_batch_size = 1;
        let result = replay_portfolio(&markets, &signals, &cfg).unwrap();
        assert_eq!(result["signal_log"][0]["symbol"], "ETHUSDT");
        assert_eq!(result["signal_log"][1]["symbol"], "BTCUSDT");
        assert_eq!(result["metrics"]["submitted_orders"], 2);
        cfg.scan_batch_size = 20;
        let result = replay_portfolio(&markets, &signals, &cfg).unwrap();
        assert_eq!(result["signal_log"][1]["outcome"], "cycle_entry_limit");
    }

    #[test]
    fn reservations_cannot_exceed_the_single_shared_cash_pool() {
        let markets = BTreeMap::from([
            ("BTCUSDT".into(), candles(50, 10.)),
            ("ETHUSDT".into(), candles(50, 20.)),
        ]);
        let signals = BTreeMap::from([
            ("BTCUSDT".into(), vec![signal(24, "BUY")]),
            ("ETHUSDT".into(), vec![signal(24, "BUY")]),
        ]);
        let mut cfg = config(24, 24);
        cfg.replay.starting_equity = 100.;
        cfg.replay.max_notional_fraction = 0.20;
        cfg.max_new_entries_per_cycle = 2;
        let result = replay_portfolio(&markets, &signals, &cfg).unwrap();
        assert_eq!(result["metrics"]["submitted_orders"], 2);
        assert!(number(&result["final_account"]["usedMargin"], 0.) <= 40.);
        assert!(number(&result["final_account"]["available"], -1.) >= 0.);
        // Many simultaneous candidates must share cash; none receive a fresh
        // per-symbol balance. Fees reserve makes the 20th 50-USDT order reject.
        let markets: BTreeMap<_, _> = (0..25)
            .map(|i| (format!("COIN{i}USDT"), candles(25, 1000.)))
            .collect();
        let signals = markets
            .keys()
            .map(|s| (s.clone(), vec![signal(24, "BUY")]))
            .collect();
        let mut cfg = config(24, 24);
        cfg.top_n = 25;
        cfg.scan_batch_size = 25;
        cfg.max_new_entries_per_cycle = 25;
        let result = replay_portfolio(&markets, &signals, &cfg).unwrap();
        assert_eq!(result["metrics"]["submitted_orders"], 19);
        assert!(number(&result["final_account"]["available"], -1.) >= 0.);
    }

    #[test]
    fn future_prices_volumes_and_listings_do_not_change_past_decisions() {
        let cfg = config(24, 30);
        let mut markets = BTreeMap::from([
            ("BTCUSDT".into(), candles(50, 10.)),
            ("ETHUSDT".into(), candles(50, 20.)),
        ]);
        let signals = BTreeMap::from([
            ("BTCUSDT".into(), vec![signal(24, "BUY")]),
            ("ETHUSDT".into(), vec![signal(24, "BUY")]),
        ]);
        let first = replay_portfolio(&markets, &signals, &cfg).unwrap();
        for rows in markets.values_mut() {
            for row in &mut rows[30..] {
                row["open"] = json!(500.);
                row["high"] = json!(600.);
                row["low"] = json!(400.);
                row["close"] = json!(500.);
                row["quoteVolume"] = json!(1e12);
            }
        }
        let mut later = candles(50, 1e20);
        later.drain(..35);
        markets.insert("NEWUSDT".into(), later);
        let after = replay_portfolio(&markets, &signals, &cfg).unwrap();
        assert_eq!(first["signal_log"], after["signal_log"]);
        assert_eq!(first["equity_curve"], after["equity_curve"]);
        assert_eq!(first["metrics"], after["metrics"]);
    }

    #[test]
    fn missing_active_hour_stays_unresolved_and_blocks_further_entries() {
        let mut missing = candles(50, 20.);
        missing.remove(24);
        let markets = BTreeMap::from([
            ("BTCUSDT".into(), missing),
            ("ETHUSDT".into(), candles(50, 10.)),
        ]);
        let signals = BTreeMap::from([
            ("BTCUSDT".into(), vec![signal(24, "BUY")]),
            ("ETHUSDT".into(), vec![signal(26, "BUY")]),
        ]);
        let result = replay_portfolio(&markets, &signals, &config(24, 40)).unwrap();
        assert_eq!(result["metrics"]["submitted_orders"], 1);
        assert_eq!(result["metrics"]["gap_blocked_orders"], 1);
        assert_eq!(result["metrics"]["comparison_complete"], false);
        assert_eq!(
            result["signal_log"][1]["outcome"],
            "incomplete_position_data"
        );
        assert_eq!(result["orders"][0]["status"], "pending");
    }

    #[test]
    fn invalid_config_and_unaligned_or_duplicate_signals_are_rejected() {
        let markets = BTreeMap::from([("BTCUSDT".into(), candles(50, 10.))]);
        let mut cfg = config(24, 36);
        cfg.replay.risk_fraction = 0.02;
        assert!(replay_portfolio(&markets, &BTreeMap::new(), &cfg).is_err());
        cfg = config(24, 36);
        cfg.top_n = 0;
        assert!(replay_portfolio(&markets, &BTreeMap::new(), &cfg).is_err());
        let signals = BTreeMap::from([(
            "BTCUSDT".into(),
            vec![signal(24, "BUY"), signal(24, "SELL")],
        )]);
        assert!(replay_portfolio(&markets, &signals, &config(24, 36)).is_err());
    }
}
