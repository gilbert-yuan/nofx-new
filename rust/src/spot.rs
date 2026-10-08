//! Spot Demo history and FIFO accounting using the existing page contract.
use crate::{exchange::Exchange, iso, now_ms, number, store::Store};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
fn n(v: &Value, k: &str) -> f64 {
    number(&v[k], 0.)
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn add(v: &mut Value, k: &str, x: f64) {
    v[k] = json!(n(v, k) + x);
}
fn normalize_trade(symbol: &str, r: &Value) -> Value {
    json!({"symbol":symbol,"tradeId":r["id"],"orderId":r["orderId"],"time":n(r,"time"),"side":if r["isBuyer"]==true{"BUY"}else{"SELL"},"price":n(r,"price"),"quantity":n(r,"qty"),"quoteQuantity":number(&r["quoteQty"],n(r,"price")*n(r,"qty")),"commission":n(r,"commission"),"commissionAsset":s(r,"commissionAsset"),"maker":r["isMaker"]==true})
}
fn normalize_order(symbol: &str, r: &Value) -> Value {
    json!({"symbol":symbol,"orderId":r["orderId"],"clientOrderId":s(r,"clientOrderId"),"time":number(&r["updateTime"],n(r,"time")),"side":s(r,"side").to_uppercase(),"type":s(r,"type"),"status":s(r,"status"),"price":n(r,"price"),"avgPrice":if n(r,"executedQty")>0.{n(r,"cummulativeQuoteQty")/n(r,"executedQty")}else{0.},"origQty":n(r,"origQty"),"executedQty":n(r,"executedQty"),"quoteOrderQty":n(r,"cummulativeQuoteQty"),"reduceOnly":false,"closePosition":false})
}
pub fn report(trades: &[Value]) -> Value {
    let mut groups: BTreeMap<String, Value> = BTreeMap::new();
    let mut inventory: BTreeMap<String, VecDeque<(f64, f64)>> = BTreeMap::new();
    let mut summary = json!({"orders":0,"closed":0,"fees":0.,"realizedPnl":0.,"netPnl":0.,"buyQuote":0.,"sellQuote":0.,"totalQuote":0.});
    for trade in trades {
        let symbol = s(trade, "symbol");
        let remote_id = trade["orderId"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| trade["orderId"].to_string());
        let key = format!("{symbol}:{remote_id}");
        let item=groups.entry(key.clone()).or_insert_with(||json!({"id":key,"symbol":symbol,"orderId":trade["orderId"],"buyQty":0.,"sellQty":0.,"buyQuote":0.,"sellQuote":0.,"fees":0.,"realizedPnl":0.,"firstTime":trade["time"],"lastTime":trade["time"],"fills":0}));
        let fee = n(trade, "commission")
            * if matches!(s(trade, "commissionAsset"), "USDT" | "USDC" | "BUSD") {
                1.
            } else {
                n(trade, "price")
            };
        let qty = n(trade, "quantity");
        let quote = n(trade, "quoteQuantity");
        let lots = inventory.entry(symbol.into()).or_default();
        if trade["side"] == "BUY" {
            add(item, "buyQty", qty);
            add(item, "buyQuote", quote);
            lots.push_back((qty, n(trade, "price")));
            add(&mut summary, "buyQuote", quote);
        } else {
            add(item, "sellQty", qty);
            add(item, "sellQuote", quote);
            add(&mut summary, "sellQuote", quote);
            let mut remaining = qty;
            while remaining > 0. && !lots.is_empty() {
                let lot = lots.front_mut().unwrap();
                let matched = remaining.min(lot.0);
                let pnl = matched * (n(trade, "price") - lot.1);
                add(item, "realizedPnl", pnl);
                add(&mut summary, "realizedPnl", pnl);
                lot.0 -= matched;
                remaining -= matched;
                if lot.0 <= 1e-12 {
                    lots.pop_front();
                }
            }
        }
        add(item, "fees", fee);
        add(&mut summary, "fees", fee);
        item["firstTime"] = json!(n(item, "firstTime").min(n(trade, "time")));
        item["lastTime"] = json!(n(item, "lastTime").max(n(trade, "time")));
        add(item, "fills", 1.);
    }
    let mut orders = groups.into_values().collect::<Vec<_>>();
    for item in &mut orders {
        let buy = n(item, "buyQty");
        let sell = n(item, "sellQty");
        item["buyPrice"] = if buy > 0. {
            json!(n(item, "buyQuote") / buy)
        } else {
            Value::Null
        };
        item["sellPrice"] = if sell > 0. {
            json!(n(item, "sellQuote") / sell)
        } else {
            Value::Null
        };
        item["netPnl"] = json!(n(item, "realizedPnl") - n(item, "fees"));
        item["status"] = json!(if buy > 0. && sell > 0. {
            "closed"
        } else {
            "filled"
        });
    }
    orders.sort_by_key(|o| std::cmp::Reverse(n(o, "lastTime") as i64));
    summary["orders"] = json!(orders.len());
    summary["closed"] = json!(orders.iter().filter(|o| o["status"] == "closed").count());
    summary["totalQuote"] = json!(n(&summary, "buyQuote") + n(&summary, "sellQuote"));
    summary["netPnl"] = json!(n(&summary, "realizedPnl") - n(&summary, "fees"));
    json!({"orders":orders,"summary":summary})
}
pub async fn orders(
    store: &Store,
    query: &HashMap<String, String>,
    start: Option<i64>,
    end: Option<i64>,
) -> Result<Value> {
    let mut config = store.read("config").await?;
    let key = config["binance"]["spotApiKey"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(config["binance"]["apiKey"].as_str())
        .unwrap_or("")
        .to_owned();
    let secret = config["binance"]["spotSecretKey"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(config["binance"]["secretKey"].as_str())
        .unwrap_or("")
        .to_owned();
    config["binance"]["demoApiKey"] = json!(key);
    config["binance"]["demoSecretKey"] = json!(secret);
    let client = Exchange::new(&config, "demo")?;
    if !client.credentials() {
        bail!("请填写 Binance Spot Demo API Key 和 Secret Key。");
    }
    let requested: Vec<String> = query
        .get("symbols")
        .map(String::as_str)
        .unwrap_or("")
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|s| s.trim().to_uppercase())
        .collect();
    let automatic = requested.is_empty() || requested.iter().any(|s| s == "ALL");
    let mut symbols = BTreeSet::new();
    let mut discovery = json!({"mode":"manual","candidateCount":requested.len(),"sources":[]});
    if automatic {
        let account = client
            .spot_signed("/api/v3/account", &json!({"omitZeroBalances":true}))
            .await?;
        let info = client
            .spot_public("/api/v3/exchangeInfo", &json!({}))
            .await?;
        let mut active = BTreeSet::new();
        for b in account["balances"].as_array().context("现货账户格式错误")? {
            if n(b, "free") > 0. || n(b, "locked") > 0. {
                active.insert(s(b, "asset").to_owned());
            }
        }
        for r in info["symbols"].as_array().context("现货合约列表格式错误")? {
            if r["status"] == "TRADING"
                && r["isSpotTradingAllowed"] != false
                && active.contains(s(r, "baseAsset"))
                && (matches!(
                    s(r, "quoteAsset"),
                    "USDT" | "USDC" | "BUSD" | "BTC" | "ETH" | "BNB" | "FDUSD"
                ) || active.contains(s(r, "quoteAsset")))
            {
                symbols.insert(s(r, "symbol").to_owned());
            }
        }
        for path in ["/api/v3/openOrders", "/api/v3/allOrderList"] {
            if let Ok(rows) = client.spot_signed(path, &json!({})).await {
                for r in rows.as_array().into_iter().flatten() {
                    if !s(r, "symbol").is_empty() {
                        symbols.insert(s(r, "symbol").to_owned());
                    }
                }
            }
        }
        let count = symbols.len();
        symbols = symbols.into_iter().take(120).collect();
        discovery = json!({"mode":"auto-account","candidateCount":count,"truncated":count>120,"activeAssets":active,"sources":["当前挂单","订单列表","非零账户资产"]});
    }
    for symbol in requested.into_iter().filter(|s| s != "ALL") {
        if symbol.len() < 5
            || symbol.len() > 20
            || !symbol.chars().all(|c| c.is_ascii_alphanumeric())
        {
            bail!("现货交易对格式无效");
        }
        symbols.insert(symbol);
    }
    if start.zip(end).is_some_and(|(s, e)| s > e) {
        bail!("开始日期不能晚于结束日期。");
    }
    let limit = query
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1000)
        .clamp(1, 1000);
    let mut windows = vec![];
    if start.is_none() && end.is_none() {
        windows.push((None, None));
    } else {
        let end = end.unwrap_or(now_ms());
        let mut cursor = start.unwrap_or((end - 86399999).max(0));
        while cursor <= end {
            windows.push((Some(cursor), Some(end.min(cursor + 86399999))));
            cursor += 86400000;
        }
    }
    let mut trades = BTreeMap::new();
    let mut history = BTreeMap::new();
    let mut reached = false;
    for symbol in &symbols {
        for (start, end) in &windows {
            let params = json!({"symbol":symbol,"limit":limit,"startTime":start,"endTime":end});
            let (fills, orders) = tokio::try_join!(
                client.spot_signed("/api/v3/myTrades", &params),
                client.spot_signed("/api/v3/allOrders", &params)
            )?;
            let fills = fills.as_array().context("现货成交格式错误")?;
            let orders = orders.as_array().context("现货订单格式错误")?;
            reached |= fills.len() >= limit || orders.len() >= limit;
            for r in fills {
                trades.insert(
                    format!("{symbol}:{}:{}", r["id"], r["orderId"]),
                    normalize_trade(symbol, r),
                );
            }
            for r in orders {
                history.insert(
                    format!("{symbol}:{}", r["orderId"]),
                    normalize_order(symbol, r),
                );
            }
        }
    }
    let mut trades = trades.into_values().collect::<Vec<_>>();
    trades.sort_by_key(|t| n(t, "time") as i64);
    let mut history = history.into_values().collect::<Vec<_>>();
    history.sort_by_key(|o| std::cmp::Reverse(n(o, "time") as i64));
    let mut result = report(&trades);
    result["summary"]["historyOrders"] = json!(history.len());
    discovery["windows"] = json!(windows.len());
    discovery["reachedPerWindowLimit"] = json!(reached);
    result.as_object_mut().unwrap().extend(json!({"ok":true,"product":"spot","demo":true,"baseUrl":"https://demo-api.binance.com/api","symbols":symbols,"syncedAt":iso(now_ms()),"trades":trades,"historyOrders":history,"discovery":discovery}).as_object().unwrap().clone());
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fifo_uses_lot_costs_and_preserves_fee_and_order_fields() {
        let trades = vec![
            json!({"symbol":"BTCUSDT","orderId":1,"time":1,"side":"BUY","price":100,"quantity":1,"quoteQuantity":100,"commission":0.001,"commissionAsset":"BTC"}),
            json!({"symbol":"BTCUSDT","orderId":2,"time":2,"side":"BUY","price":200,"quantity":1,"quoteQuantity":200,"commission":0.2,"commissionAsset":"USDT"}),
            json!({"symbol":"BTCUSDT","orderId":3,"time":3,"side":"SELL","price":150,"quantity":1.5,"quoteQuantity":225,"commission":0.225,"commissionAsset":"USDT"}),
        ];
        let report = report(&trades);
        assert_eq!(report["summary"]["realizedPnl"], 25.);
        assert!((n(&report["summary"], "netPnl") - 24.475).abs() < 1e-9);
        assert_eq!(report["orders"][0]["sellPrice"], 150.);
    }
}
