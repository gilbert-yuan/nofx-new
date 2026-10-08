//! Persistent exchange fills and exact cash accounting, isolated by environment and API key.
use crate::{db::Db, exchange::Exchange, iso, now_ms, number, timestamp};
use anyhow::{Context, Result, bail};
use futures::{StreamExt, TryStreamExt};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn n(v: &Value, key: &str) -> f64 {
    number(&v[key], 0.)
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn id(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
}
fn blank() -> Value {
    json!({"entryQty":0.,"entryNotional":0.,"filledQty":0.,"filledNotional":0.,"exitQty":0.,"exitNotional":0.,"remainingQty":0.,"realized":0.,"commission":0.,"funding":0.})
}
fn add(v: &mut Value, key: &str, amount: f64) {
    v[key] = json!(n(v, key) + amount);
}
fn side(position: &Value) -> &'static str {
    if n(position, "positionAmt") < 0. || position["positionSide"] == "SHORT" {
        "OPEN_SHORT"
    } else {
        "OPEN_LONG"
    }
}
fn link<'a>(order: &'a Value, env: &str) -> &'a Value {
    if order["exchangeSync"][env].is_object() {
        &order["exchangeSync"][env]
    } else if env == "demo" {
        &order["exchange"]
    } else {
        &Value::Null
    }
}
fn ensure_external(
    external: &mut BTreeMap<String, Value>,
    symbol: &str,
    direction: &str,
) -> String {
    let key = format!("{symbol}:{direction}");
    external.entry(key.clone()).or_insert_with(|| {
        let mut v = blank();
        v["symbol"] = json!(symbol);
        v["direction"] = json!(direction);
        v["openRealized"] = json!(0.);
        v["cycleQty"] = json!(0.);
        v["cycleNotional"] = json!(0.);
        v["closedCycles"] = json!([]);
        v
    });
    key
}
#[derive(Clone)]
enum Owner {
    Local(String),
    External(String),
}
impl Owner {
    fn metric<'a>(
        &self,
        local: &'a BTreeMap<String, Value>,
        ext: &'a BTreeMap<String, Value>,
    ) -> &'a Value {
        match self {
            Self::Local(id) => &local[id],
            Self::External(id) => &ext[id],
        }
    }
    fn metric_mut<'a>(
        &self,
        local: &'a mut BTreeMap<String, Value>,
        ext: &'a mut BTreeMap<String, Value>,
    ) -> &'a mut Value {
        match self {
            Self::Local(id) => local.get_mut(id).unwrap(),
            Self::External(id) => ext.get_mut(id).unwrap(),
        }
    }
    fn external(&self) -> bool {
        matches!(self, Self::External(_))
    }
}
fn owners(local: &BTreeMap<String, Value>, symbol: &str, direction: Option<&str>) -> Vec<Owner> {
    local
        .iter()
        .filter(|(_, m)| {
            s(m, "symbol") == symbol
                && direction.is_none_or(|d| s(m, "direction") == d)
                && n(m, "remainingQty") > 1e-10
        })
        .map(|(id, _)| Owner::Local(id.clone()))
        .collect()
}

/// Known entry fills belong to their local order. Aggregate closes and funding are split
/// by the quantities actually held at that instant; pre-adoption external cash stays outside the pool.
pub fn derive(
    orders: &[Value],
    env: &str,
    fills: &[Value],
    funding: &[Value],
    adopted: &[Value],
    start: i64,
) -> Result<Value> {
    let mut local = BTreeMap::new();
    let mut entries = BTreeMap::new();
    let mut external: BTreeMap<String, Value> = BTreeMap::new();
    for order in orders {
        let binding = link(order, env);
        if binding["orderId"].is_null() || binding["orderId"] == 0 || binding["orderId"] == "" {
            continue;
        }
        let key = id(&order["id"]);
        let mut m = blank();
        m["symbol"] = order["symbol"].clone();
        m["direction"] = order["direction"].clone();
        local.insert(key.clone(), m);
        entries.insert(
            format!("{}:{}", s(order, "symbol"), id(&binding["orderId"])),
            key,
        );
    }
    let mut events: Vec<(i64, u8, Option<&Value>)> = fills
        .iter()
        .map(|v| (n(v, "time") as i64, 1, Some(v)))
        .chain(funding.iter().map(|v| (n(v, "time") as i64, 2, Some(v))))
        .collect();
    events.push((start, 0, None));
    events.sort_by_key(|e| (e.0, if e.1 == 0 { 0 } else { 1 }));
    for (time, kind, event) in events {
        if kind == 0 {
            let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for (id, m) in &local {
                if n(m, "remainingQty") > 1e-10 {
                    groups
                        .entry(format!("{}:{}", s(m, "symbol"), s(m, "direction")))
                        .or_default()
                        .push(id.clone());
                }
            }
            for (key, group) in groups {
                let actual = adopted
                    .iter()
                    .filter(|p| format!("{}:{}", s(p, "symbol"), side(p)) == key)
                    .map(|p| n(p, "positionAmt").abs())
                    .sum::<f64>();
                let known = group
                    .iter()
                    .map(|id| n(&local[id], "remainingQty"))
                    .sum::<f64>();
                if known > actual + 1e-8 {
                    for id in group {
                        let m = local.get_mut(&id).unwrap();
                        let remaining = n(m, "remainingQty") * actual / known;
                        m["missingExitQty"] = json!(n(m, "remainingQty") - remaining);
                        m["remainingQty"] = json!(remaining);
                        m["closedByObservation"] = json!(remaining <= 1e-10);
                        m["observedClosedAt"] = json!(iso(time));
                    }
                }
            }
            for m in external.values_mut() {
                for (k, v) in blank().as_object().unwrap() {
                    m[k] = v.clone();
                }
                m["openRealized"] = json!(0.);
                m["cycleQty"] = json!(0.);
                m["cycleNotional"] = json!(0.);
            }
            for p in adopted {
                let symbol = s(p, "symbol");
                let direction = side(p);
                let known = owners(&local, symbol, Some(direction))
                    .iter()
                    .map(|o| n(o.metric(&local, &external), "remainingQty"))
                    .sum::<f64>();
                let remaining = (n(p, "positionAmt").abs() - known).max(0.);
                if remaining == 0. {
                    continue;
                }
                let key = ensure_external(&mut external, symbol, direction);
                let m = external.get_mut(&key).unwrap();
                for k in ["entryQty", "remainingQty", "cycleQty"] {
                    add(m, k, remaining);
                }
                for k in ["entryNotional", "cycleNotional"] {
                    add(m, k, remaining * n(p, "entryPrice"));
                }
                m["entryAt"] = json!(iso(time));
                m["leverage"] = json!(number(&p["leverage"], 1.).max(1.));
            }
            continue;
        }
        let row = event.unwrap();
        let symbol = s(row, "symbol");
        if kind == 2 {
            if row["asset"] != "USDT" && n(row, "income") != 0. {
                bail!("资金费包含非 USDT 资产，无法计入统一资金池。");
            }
            let mut allocation = owners(&local, symbol, None);
            allocation.extend(
                external
                    .iter()
                    .filter(|(_, m)| s(m, "symbol") == symbol && n(m, "remainingQty") > 0.)
                    .map(|(key, _)| Owner::External(key.clone())),
            );
            let quantity = allocation
                .iter()
                .map(|o| n(o.metric(&local, &external), "remainingQty"))
                .sum::<f64>();
            for o in allocation {
                if o.external() && time < start {
                    continue;
                }
                let m = o.metric_mut(&mut local, &mut external);
                let amount = if quantity > 0. {
                    n(row, "income") * n(m, "remainingQty") / quantity
                } else {
                    0.
                };
                add(m, "realized", amount);
                add(m, "funding", amount);
                if o.external() {
                    add(m, "openRealized", amount);
                }
            }
            continue;
        }
        if ["price", "quantity", "realizedPnl", "commission"]
            .iter()
            .any(|k| !number(&row[k], f64::NAN).is_finite())
        {
            bail!("成交金额或收益数据无效。");
        }
        if row["commissionAsset"] != "USDT" && n(row, "commission") != 0. {
            bail!("手续费包含非 USDT 资产，无法计入统一资金池。");
        }
        let fee = n(row, "commission");
        let quantity = n(row, "quantity");
        let gross = n(row, "realizedPnl");
        let price = n(row, "price");
        if quantity <= 0. || price <= 0. {
            bail!("成交价格和数量必须为正。");
        }
        let entry_id = entries
            .get(&format!("{symbol}:{}", id(&row["orderId"])))
            .cloned();
        if let Some(id) = &entry_id {
            let m = local.get_mut(id).unwrap();
            if row["side"]
                != if m["direction"] == "OPEN_LONG" {
                    "BUY"
                } else {
                    "SELL"
                }
            {
                bail!("历史入口订单方向与币安成交不一致，需重新核对绑定。");
            }
            add(m, "filledQty", quantity);
            add(m, "filledNotional", quantity * price);
            if m["entryAt"].is_null() {
                m["entryAt"] = json!(iso(time));
            }
        }
        let closing = if row["side"] == "SELL" {
            "OPEN_LONG"
        } else {
            "OPEN_SHORT"
        };
        let ps = s(row, "positionSide");
        let can_close = ps.is_empty()
            || ps == "BOTH"
            || (ps == "LONG" && row["side"] == "SELL")
            || (ps == "SHORT" && row["side"] == "BUY");
        let mut allocation = if can_close {
            owners(&local, symbol, Some(closing))
        } else {
            vec![]
        };
        let ext_key = ensure_external(&mut external, symbol, closing);
        if can_close && n(&external[&ext_key], "remainingQty") > 0. {
            allocation.push(Owner::External(ext_key));
        }
        let available = allocation
            .iter()
            .map(|o| n(o.metric(&local, &external), "remainingQty"))
            .sum::<f64>();
        let closed = quantity.min(available);
        if closed > 0. {
            for o in allocation {
                let m = o.metric_mut(&mut local, &mut external);
                let qty = closed * n(m, "remainingQty") / available;
                let ratio = qty / quantity;
                let income = gross * qty / closed - fee * ratio;
                m["remainingQty"] = json!((n(m, "remainingQty") - qty).max(0.));
                add(m, "exitQty", qty);
                add(m, "exitNotional", qty * price);
                if !o.external() || time >= start {
                    add(m, "realized", income);
                    add(m, "commission", fee * ratio);
                }
                m["allocationMethod"] = json!("remaining_quantity");
                m["exitAt"] = json!(iso(time));
                if o.external() && time >= start {
                    add(m, "openRealized", income);
                    if n(m, "remainingQty") <= 1e-10 {
                        let cycle = json!({"entryQty":m["cycleQty"],"entryNotional":m["cycleNotional"],"entryAt":m["entryAt"],"exitAt":m["exitAt"],"realized":m["openRealized"],"leverage":number(&m["leverage"],1.).max(1.)});
                        m["closedCycles"].as_array_mut().unwrap().push(cycle);
                        m["cycleQty"] = json!(0.);
                        m["cycleNotional"] = json!(0.);
                        m["openRealized"] = json!(0.);
                    }
                }
            }
        }
        let opening = (quantity - closed).max(0.);
        if opening > 1e-10 {
            let direction = if ps == "SHORT" || (ps == "BOTH" && row["side"] == "SELL") {
                "OPEN_SHORT"
            } else {
                "OPEN_LONG"
            };
            let owner = match &entry_id {
                Some(id) => Owner::Local(id.clone()),
                None => Owner::External(ensure_external(&mut external, symbol, direction)),
            };
            let m = owner.metric_mut(&mut local, &mut external);
            if entry_id.is_some() && can_close && closed == 0. && gross != 0. {
                add(m, "realized", gross - fee);
                add(m, "commission", fee);
                m["offsetEntry"] = json!(true);
                m["exitAt"] = json!(iso(time));
                continue;
            }
            if n(m, "remainingQty") < 1e-10 {
                m["openRealized"] = json!(0.);
                m["entryAt"] = json!(iso(time));
            }
            add(m, "remainingQty", opening);
            add(m, "entryQty", opening);
            add(m, "entryNotional", opening * price);
            if owner.external() {
                add(m, "cycleQty", opening);
                add(m, "cycleNotional", opening * price);
            }
            if owner.external() && time < start {
                continue;
            }
            let amount = if closed == 0. { gross } else { 0. } - fee * opening / quantity;
            add(m, "realized", amount);
            add(m, "commission", fee * opening / quantity);
            if owner.external() {
                add(m, "openRealized", amount);
            }
        } else if let Some(id) = entry_id {
            let m = local.get_mut(&id).unwrap();
            m["offsetEntry"] = json!(true);
            m["exitAt"] = json!(iso(time));
        }
    }
    Ok(json!({"orderMetrics":local,"externalMetrics":external}))
}

const DDL: &str = "CREATE TABLE IF NOT EXISTS simulation_exchange_fills (environment TEXT NOT NULL,account_key TEXT NOT NULL,symbol TEXT NOT NULL,trade_id TEXT NOT NULL,order_id TEXT NOT NULL,trade_time BIGINT NOT NULL,side TEXT NOT NULL,position_side TEXT NOT NULL,price FLOAT8 NOT NULL,quantity FLOAT8 NOT NULL,realized_pnl FLOAT8 NOT NULL,commission FLOAT8 NOT NULL,commission_asset TEXT NOT NULL,PRIMARY KEY(environment,account_key,symbol,trade_id)); CREATE TABLE IF NOT EXISTS simulation_exchange_funding (environment TEXT NOT NULL,account_key TEXT NOT NULL,flow_id TEXT NOT NULL,symbol TEXT NOT NULL,flow_time BIGINT NOT NULL,income FLOAT8 NOT NULL,asset TEXT NOT NULL,PRIMARY KEY(environment,account_key,flow_id)); CREATE TABLE IF NOT EXISTS simulation_exchange_cursors (environment TEXT NOT NULL,account_key TEXT NOT NULL,symbol TEXT NOT NULL,synced_until BIGINT NOT NULL,PRIMARY KEY(environment,account_key,symbol));";
async fn cursor(db: &Db, env: &str, key: &str, symbol: &str, first: i64) -> Result<i64> {
    let time:Option<i64>=sqlx::query_scalar("SELECT synced_until FROM simulation_exchange_cursors WHERE environment=$1 AND account_key=$2 AND symbol=$3").bind(env).bind(key).bind(symbol).fetch_optional(&db.pool).await?;
    Ok(time.map(|t| first.max(t - 60000)).unwrap_or(first))
}
async fn save_cursor(db: &Db, env: &str, key: &str, symbol: &str, end: i64) -> Result<()> {
    sqlx::query("INSERT INTO simulation_exchange_cursors VALUES($1,$2,$3,$4) ON CONFLICT(environment,account_key,symbol) DO UPDATE SET synced_until=EXCLUDED.synced_until").bind(env).bind(key).bind(symbol).bind(end).execute(&db.pool).await?;
    Ok(())
}
async fn trade_window(client: &Exchange, symbol: &str, start: i64, end: i64) -> Result<Vec<Value>> {
    let mut windows = vec![(start, end, 0)];
    let mut trades = vec![];
    while let Some((start, end, depth)) = windows.pop() {
        let response = client
            .signed(
                "GET",
                "/fapi/v1/userTrades",
                &json!({"symbol":symbol,"startTime":start,"endTime":end,"limit":1000}),
            )
            .await?;
        let rows = response.as_array().context("币安未返回完整成交记录。")?;
        if rows.len() < 1000 {
            trades.extend(rows.iter().cloned());
        } else {
            if end <= start || depth >= 30 {
                bail!("同一时间的成交记录超过查询上限，未发布不完整收益。");
            }
            let middle = start + (end - start) / 2;
            windows.push((middle + 1, end, depth + 1));
            windows.push((start, middle, depth + 1));
        }
    }
    Ok(trades)
}
async fn fetch_symbol(
    db: &Db,
    client: &Exchange,
    env: &str,
    key: &str,
    symbol: &str,
    first: i64,
    now: i64,
) -> Result<()> {
    let mut start = cursor(db, env, key, symbol, first).await?;
    while start <= now {
        let end = now.min(start + 7 * 86400000 - 1);
        let rows = trade_window(client, symbol, start, end).await?;
        let mut values = vec![];
        for r in rows {
            let time = number(&r["time"], f64::NAN);
            let price = number(&r["price"], f64::NAN);
            let qty = number(&r["qty"], f64::NAN);
            let pnl = number(&r["realizedPnl"], 0.);
            let commission = number(&r["commission"], 0.);
            if !matches!(s(&r, "side"), "BUY" | "SELL")
                || r["id"].is_null()
                || r["orderId"].is_null()
                || ![time, price, qty, pnl, commission]
                    .iter()
                    .all(|v| v.is_finite())
                || price <= 0.
                || qty <= 0.
            {
                bail!("成交记录缺少数量、时间或收益。");
            }
            values.push(json!({"symbol":r["symbol"].as_str().unwrap_or(symbol),"trade_id":id(&r["id"]),"order_id":id(&r["orderId"]),"trade_time":time as i64,"side":r["side"],"position_side":r["positionSide"].as_str().unwrap_or("BOTH"),"price":price,"quantity":qty,"realized_pnl":pnl,"commission":commission,"commission_asset":r["commissionAsset"].as_str().unwrap_or("")}));
        }
        if !values.is_empty() {
            sqlx::query("INSERT INTO simulation_exchange_fills SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(symbol text,trade_id text,order_id text,trade_time bigint,side text,position_side text,price float8,quantity float8,realized_pnl float8,commission float8,commission_asset text) ON CONFLICT(environment,account_key,symbol,trade_id) DO NOTHING").bind(env).bind(key).bind(json!(values)).execute(&db.pool).await?;
        }
        save_cursor(db, env, key, symbol, end).await?;
        start = end + 1;
    }
    Ok(())
}
#[expect(
    clippy::too_many_arguments,
    reason = "exchange journal synchronization requires separate observed and adopted exposure"
)]
async fn synchronize_inner(
    db: &Db,
    client: &Exchange,
    env: &str,
    previous: &Value,
    orders: &[Value],
    positions: &[Value],
    pending: &[Value],
    adopted: &[Value],
    adopted_at: i64,
    now: i64,
) -> Result<Value> {
    sqlx::raw_sql(DDL).execute(&db.pool).await?;
    let key = client.account_key();
    let same = previous["accountKey"] == key;
    let bootstrap = !same || previous["metricsSyncedAt"].is_null();
    let bound: Vec<_> = orders
        .iter()
        .filter(|o| !link(o, env)["orderId"].is_null())
        .collect();
    let mut symbols = BTreeSet::new();
    for r in positions.iter().chain(pending) {
        if let Some(symbol) = r["symbol"].as_str() {
            symbols.insert(symbol.to_owned());
        }
    }
    for o in &bound {
        let m = &previous["orderMetrics"][s(o, "id")];
        if bootstrap
            || matches!(s(o, "status"), "open" | "pending")
            || n(m, "remainingQty") > 1e-10
            || !m.is_object()
            || timestamp(&o["exitAt"]).is_some_and(|t| now - t < 120000)
        {
            symbols.insert(s(o, "symbol").to_owned());
        }
    }
    for (_, m) in previous["externalMetrics"]
        .as_object()
        .into_iter()
        .flatten()
    {
        if n(m, "remainingQty") > 1e-10 {
            symbols.insert(s(m, "symbol").to_owned());
        }
    }
    let pool_start = timestamp(&previous["poolStartedAt"]).unwrap_or(adopted_at);
    let earliest = bound
        .iter()
        .filter_map(|o| timestamp(&o["createdAt"]))
        .fold(pool_start, i64::min)
        .max(now - 89 * 86400000);
    futures::stream::iter(symbols.into_iter().map(|symbol| {
        let first = bound
            .iter()
            .filter(|o| o["symbol"] == symbol)
            .filter_map(|o| timestamp(&o["createdAt"]))
            .fold(pool_start, i64::min)
            .max(now - 89 * 86400000);
        let key = &key;
        async move { fetch_symbol(db, client, env, key, &symbol, first, now).await }
    }))
    .buffer_unordered(4)
    .try_collect::<Vec<_>>()
    .await?;
    let start = cursor(db, env, &key, "__funding", earliest).await?;
    let mut complete = false;
    for page in 1..=20 {
        let response=client.signed("GET","/fapi/v1/income",&json!({"incomeType":"FUNDING_FEE","startTime":start,"endTime":now,"page":page,"limit":1000})).await?;
        let rows = response.as_array().context("币安资金费流水不完整。")?;
        let mut values = vec![];
        for r in rows.iter().filter(|r| r["incomeType"] == "FUNDING_FEE") {
            let time = number(&r["time"], f64::NAN);
            let income = number(&r["income"], f64::NAN);
            if s(r, "symbol").is_empty()
                || r["tranId"].is_null()
                || !time.is_finite()
                || !income.is_finite()
            {
                bail!("资金费流水金额或时间无效。");
            }
            values.push(json!({"flow_id":id(&r["tranId"]),"symbol":r["symbol"],"flow_time":time as i64,"income":income,"asset":r["asset"]}));
        }
        if !values.is_empty() {
            sqlx::query("INSERT INTO simulation_exchange_funding SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(flow_id text,symbol text,flow_time bigint,income float8,asset text) ON CONFLICT(environment,account_key,flow_id) DO NOTHING").bind(env).bind(&key).bind(json!(values)).execute(&db.pool).await?;
        }
        if rows.len() < 1000 {
            complete = true;
            break;
        }
    }
    if !complete {
        bail!("资金费流水超过查询上限，保留上次收益。");
    }
    save_cursor(db, env, &key, "__funding", now).await?;
    let fills:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('symbol',symbol,'id',trade_id,'orderId',order_id,'time',trade_time,'side',side,'positionSide',position_side,'price',price,'quantity',quantity,'realizedPnl',realized_pnl,'commission',commission,'commissionAsset',commission_asset) FROM simulation_exchange_fills WHERE environment=$1 AND account_key=$2 ORDER BY trade_time,trade_id").bind(env).bind(&key).fetch_all(&db.pool).await?;
    let funding:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('symbol',symbol,'time',flow_time,'income',income,'asset',asset) FROM simulation_exchange_funding WHERE environment=$1 AND account_key=$2 ORDER BY flow_time,flow_id").bind(env).bind(&key).fetch_all(&db.pool).await?;
    let mut metrics = derive(orders, env, &fills, &funding, adopted, adopted_at)?;
    for p in positions {
        let key = format!("{}:{}", s(p, "symbol"), side(p));
        if metrics["externalMetrics"][&key].is_object() {
            metrics["externalMetrics"][&key]["leverage"] = p["leverage"].clone();
        }
    }
    let ids: BTreeSet<_> = fills.iter().map(|r| id(&r["orderId"])).collect();
    metrics["observedOrderIds"] = json!(ids);
    metrics["metricsVersion"] = json!(2);
    metrics["metricsSyncedAt"] = json!(iso(now));
    metrics["metricsError"] = json!("");
    Ok(metrics)
}
pub async fn synchronize(
    db: &Db,
    client: &Exchange,
    env: &str,
    previous: &Value,
    orders: &[Value],
    positions: &[Value],
    pending: &[Value],
) -> Result<Value> {
    let now = now_ms();
    let same = previous["accountKey"] == client.account_key();
    let adopted = if same {
        previous["adoptedPositions"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(positions)
    } else {
        positions
    };
    let adopted_at = if same {
        timestamp(&previous["adoptedAt"]).unwrap_or(now)
    } else {
        now
    };
    let mut result = match synchronize_inner(
        db, client, env, previous, orders, positions, pending, adopted, adopted_at, now,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let mut result = if same { previous.clone() } else { json!({}) };
            result["metricsError"] = json!(error.to_string().chars().take(300).collect::<String>());
            result
        }
    };
    result["adoptedPositions"] = json!(adopted);
    result["adoptedAt"] = json!(iso(adopted_at));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fill(order: i64, time: i64, side: &str, qty: f64, pnl: f64) -> Value {
        json!({"symbol":"BTCUSDT","orderId":order,"time":time,"side":side,"positionSide":"BOTH","price":100.,"quantity":qty,"realizedPnl":pnl,"commission":qty*0.1,"commissionAsset":"USDT"})
    }
    #[test]
    fn exact_entries_shared_exit_funding() {
        let orders = vec![
            json!({"id":"a","symbol":"BTCUSDT","direction":"OPEN_LONG","exchangeSync":{"live":{"orderId":1}}}),
            json!({"id":"b","symbol":"BTCUSDT","direction":"OPEN_LONG","exchangeSync":{"live":{"orderId":2}}}),
        ];
        let fills = vec![
            fill(1, 10, "BUY", 1., 0.),
            fill(2, 11, "BUY", 3., 0.),
            fill(3, 30, "SELL", 2., 20.),
        ];
        let funding = vec![json!({"symbol":"BTCUSDT","time":20,"asset":"USDT","income":4.})];
        let result = derive(&orders, "live", &fills, &funding, &[], 0).unwrap();
        let a = &result["orderMetrics"]["a"];
        let b = &result["orderMetrics"]["b"];
        assert!((n(a, "realized") - 5.85).abs() < 1e-9);
        assert!((n(b, "realized") - 17.55).abs() < 1e-9);
        assert_eq!(n(a, "remainingQty"), 0.5);
        assert_eq!(n(b, "remainingQty"), 1.5);
    }
    #[test]
    fn adoption_closes_missing_exposure_without_inventing_profit() {
        let orders = vec![
            json!({"id":"a","symbol":"BTCUSDT","direction":"OPEN_LONG","exchange":{"orderId":1}}),
        ];
        let result = derive(&orders, "demo", &[fill(1, 10, "BUY", 2., 0.)], &[], &[], 20).unwrap();
        let m = &result["orderMetrics"]["a"];
        assert_eq!(n(m, "remainingQty"), 0.);
        assert_eq!(n(m, "missingExitQty"), 2.);
        assert_eq!(m["closedByObservation"], true);
        assert_eq!(n(m, "realized"), -0.2);
    }
    #[test]
    fn external_history_rebases_cash_and_rejects_other_fee_assets() {
        let adopted =
            vec![json!({"symbol":"BTCUSDT","positionAmt":2.,"entryPrice":100.,"leverage":5})];
        let result = derive(
            &[],
            "live",
            &[fill(1, 10, "BUY", 5., 0.), fill(2, 30, "SELL", 2., 10.)],
            &[],
            &adopted,
            20,
        )
        .unwrap();
        let m = &result["externalMetrics"]["BTCUSDT:OPEN_LONG"];
        assert_eq!(n(m, "realized"), 9.8);
        assert_eq!(m["closedCycles"][0]["entryQty"], 2.);
        let mut r = fill(1, 10, "BUY", 1., 0.);
        r["commissionAsset"] = json!("BNB");
        assert!(derive(&[], "live", &[r], &[], &[], 0).is_err());
    }
}
