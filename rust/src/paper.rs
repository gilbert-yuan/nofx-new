//! Native account ledger and guarded exchange lifecycle. Exchange observations remain distinct
//! from candle simulation; ambiguous executions retain their durable client IDs and reservations.
use crate::{
    db::Db,
    exchange::{Exchange, client_id, storage_symbol},
    interval_ms, iso, now_ms, number, simulator,
    store::Store,
    timestamp,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
mod execution_tests;

fn n(v: &Value, k: &str, d: f64) -> f64 {
    number(&v[k], d)
}
fn active(order: &Value) -> bool {
    matches!(order["status"].as_str(), Some("pending" | "open"))
}
fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn share(o: &Value) -> f64 {
    let exited = n(o, "realizedQty", 0.);
    if exited > 0. {
        n(o, "quantity", 0.) / (n(o, "quantity", 0.) + exited).max(1e-12)
    } else {
        1.
    }
}
fn patch(base: &mut Value, fields: &Value) {
    if !base.is_object() {
        *base = json!({});
    }
    for (k, v) in fields.as_object().into_iter().flatten() {
        base[k] = v.clone();
    }
}
fn binding<'a>(order: &'a Value, environment: &str) -> &'a Value {
    if order["exchangeSync"][environment].is_object() {
        &order["exchangeSync"][environment]
    } else if environment == "demo" {
        &order["exchange"]
    } else {
        &Value::Null
    }
}
fn direction(row: &Value) -> &'static str {
    if row["positionSide"] == "SHORT" || n(row, "positionAmt", 0.) < 0. {
        "OPEN_SHORT"
    } else {
        "OPEN_LONG"
    }
}
fn ref_order(order: &Value) -> Value {
    json!({"id":order["id"],"status":order["status"],"symbol":order["symbol"]})
}
fn preferred<'a>(o: &Value, accounts: &'a Value) -> Option<(&'a Value, &'static str)> {
    for env in ["live", "demo"] {
        let snapshot = &accounts[env];
        let metric = &snapshot["orderMetrics"][o["id"].as_str().unwrap_or("")];
        if snapshot["enabled"] == true
            && snapshot["configured"] == true
            && (n(metric, "filledQty", 0.) > 0. || n(metric, "entryQty", 0.) > 0.)
        {
            return Some((metric, env));
        }
    }
    None
}
fn sync_enabled(config: &Value, environment: &str) -> bool {
    config["trader"][if environment == "demo" {
        "syncPaperOrdersToDemo"
    } else {
        "syncPaperOrdersToLive"
    }] == true
}
pub fn sync_state(environment: &str) -> Value {
    json!({"environment":environment,"provider":format!("binance-{environment}"),"status":"not_submitted","clientOrderId":null,"orderId":null,"origQty":null,"executedQty":0,"avgPrice":null,"price":null,"submittedAt":null,"lastSyncedAt":null,"lastError":"","retryAt":null,"retryCount":0,"closeOrders":[],"protection":{"stopLoss":{"type":"STOP_MARKET","status":"not_submitted"},"takeProfit":{"type":"TAKE_PROFIT_MARKET","status":"not_submitted"}},"emergencyClose":{"status":"not_requested","executedQty":0}})
}
fn ensure_links(order: &mut Value) {
    if !order["exchangeSync"].is_object() {
        order["exchangeSync"] = json!({});
    }
    for env in ["demo", "live"] {
        if !order["exchangeSync"][env].is_object() {
            order["exchangeSync"][env] = if env == "demo" && order["exchange"].is_object() {
                order["exchange"].clone()
            } else {
                sync_state(env)
            };
        }
    }
}
fn mirror(order: &mut Value) {
    order["exchange"] = order["exchangeSync"]["demo"].clone();
}

/// Combine both exchange environments by symbol/direction; priority affects metrics, while
/// every execution target is retained so a manual close reaches both Demo and live exposure.
pub fn fused_orders(state: &Value) -> Value {
    let orders = arr(&state["orders"]);
    let accounts = &state["exchangeAccounts"];
    let mut groups: BTreeMap<String, Value> = BTreeMap::new();
    let mut represented = BTreeSet::new();
    for env in ["demo", "live"] {
        let snap = &accounts[env];
        if snap["enabled"] != true || snap["configured"] != true || snap["syncedAt"].is_null() {
            continue;
        }
        for pos in arr(&snap["positions"]) {
            let dir = direction(&pos);
            let ps = pos["positionSide"].as_str().unwrap_or("BOTH");
            let symbol = pos["symbol"].as_str().unwrap_or("");
            let key = format!("position:{symbol}:{dir}");
            let qty = n(&pos, "positionAmt", 0.).abs();
            if qty <= 0. {
                continue;
            }
            let refs: Vec<Value> = orders
                .iter()
                .filter(|o| {
                    o["symbol"] == symbol
                        && o["direction"] == dir
                        && (n(binding(o, env), "executedQty", 0.) > 0.
                            || n(
                                &snap["orderMetrics"][o["id"].as_str().unwrap_or("")],
                                "remainingQty",
                                0.,
                            ) > 1e-10)
                })
                .map(ref_order)
                .collect();
            let target = json!({"environment":env,"symbol":symbol,"positionSide":ps,"kind":"position","quantity":qty,"direction":dir,"updateTime":pos["updateTime"],"entry":pos["entryPrice"],"markPrice":pos["markPrice"],"localOrders":refs});
            let mut targets = groups
                .get(&key)
                .map(|g| arr(&g["executionTargets"]))
                .unwrap_or_default();
            targets.push(target);
            let mut all_refs = groups
                .get(&key)
                .map(|g| arr(&g["localOrders"]))
                .unwrap_or_default();
            for r in refs {
                if !all_refs.iter().any(|a| a["id"] == r["id"]) {
                    all_refs.push(r);
                }
            }
            for r in &all_refs {
                represented.insert(r["id"].as_str().unwrap_or("").to_owned());
            }
            let amount = qty * n(&pos, "entryPrice", 0.);
            let leverage = n(&pos, "leverage", 1.).max(1.);
            let realized = all_refs
                .iter()
                .map(|r| {
                    n(
                        &snap["orderMetrics"][r["id"].as_str().unwrap_or("")],
                        "realized",
                        0.,
                    )
                })
                .sum::<f64>()
                + n(
                    &snap["externalMetrics"][format!("{symbol}:{dir}")],
                    "openRealized",
                    0.,
                );
            let floating = n(&pos, "unrealized", n(&pos, "unRealizedProfit", 0.));
            let row = json!({"id":format!("fused:{key}"),"source":format!("binance-{env}"),"sourceLabel":if env=="demo"{"币安模拟盘"}else{"币安实盘"},"environment":env,"kind":"position","symbol":symbol,"direction":dir,"positionSide":ps,"status":"open","entry":pos["entryPrice"],"markPrice":pos["markPrice"],"quantity":qty,"notional":pos["notional"],"leverage":leverage,"margin":amount/leverage,"buyAmount":amount,"unrealized":floating,"realized":realized,"net":realized+floating,"roi":if amount>0.{json!((realized+floating)/(amount/leverage))}else{Value::Null},"liquidationPrice":pos["liquidationPrice"],"createdAt":timestamp(&pos["updateTime"]).map(iso).unwrap_or_else(||snap["syncedAt"].as_str().unwrap_or("").into()),"localOrders":all_refs,"executionTargets":targets,"stale":!snap["error"].as_str().unwrap_or("").is_empty(),"syncedAt":snap["syncedAt"],"syncError":snap["error"]});
            groups.insert(key, row);
        }
        for remote in arr(&snap["orders"]) {
            let symbol = remote["symbol"].as_str().unwrap_or("");
            let order_id = remote["orderId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| remote["orderId"].to_string());
            let cid = remote["clientOrderId"].as_str().unwrap_or("");
            let refs: Vec<_> = orders
                .iter()
                .filter(|o| {
                    o["symbol"] == symbol
                        && ((!binding(o, env)["orderId"].is_null()
                            && binding(o, env)["orderId"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| binding(o, env)["orderId"].to_string())
                                == order_id)
                            || (!cid.is_empty()
                                && (binding(o, env)["clientOrderId"] == cid
                                    || legacy_entry_id(o, env) == cid)))
                })
                .map(ref_order)
                .collect();
            let mut ids: Vec<_> = refs
                .iter()
                .map(|r| r["id"].as_str().unwrap_or(""))
                .collect();
            ids.sort_unstable();
            let key = if ids.is_empty() {
                format!("entry:{env}:{symbol}:{order_id}")
            } else {
                format!("entry:{}", ids.join(","))
            };
            let qty = (n(&remote, "origQty", 0.) - n(&remote, "executedQty", 0.)).max(0.);
            if qty <= 0. {
                continue;
            }
            let dir = if remote["side"] == "BUY" {
                "OPEN_LONG"
            } else {
                "OPEN_SHORT"
            };
            let mut targets = groups
                .get(&key)
                .map(|g| arr(&g["executionTargets"]))
                .unwrap_or_default();
            targets.push(json!({"environment":env,"symbol":symbol,"positionSide":remote["positionSide"],"kind":"entry_order","orderId":order_id,"clientOrderId":cid,"quantity":qty,"direction":dir,"localOrders":refs}));
            let mut all_refs = groups
                .get(&key)
                .map(|g| arr(&g["localOrders"]))
                .unwrap_or_default();
            for r in refs {
                if !all_refs.iter().any(|a| a["id"] == r["id"]) {
                    all_refs.push(r);
                }
            }
            for r in &all_refs {
                represented.insert(r["id"].as_str().unwrap_or("").to_owned());
            }
            let mut row = remote.clone();
            patch(
                &mut row,
                &json!({"id":format!("fused:{key}"),"source":format!("binance-{env}"),"sourceLabel":if env=="demo"{"币安模拟盘"}else{"币安实盘"},"environment":env,"kind":"entry_order","status":"pending","direction":dir,"entry":remote["price"],"quantity":qty,"buyAmount":qty*n(&remote,"price",0.),"margin":qty*n(&remote,"price",0.)/n(&remote,"leverage",1.).max(1.),"localOrders":all_refs,"executionTargets":targets,"syncedAt":snap["syncedAt"]}),
            );
            groups.insert(key, row);
        }
    }
    let mut closed = vec![];
    let mut local = vec![];
    for order in &orders {
        let metric = preferred(order, accounts);
        let remote_closed = metric
            .map(|(m, _)| {
                n(m, "remainingQty", 0.) <= 1e-10
                    && (n(m, "exitQty", 0.) > 0.
                        || m["offsetEntry"] == true
                        || m["closedByObservation"] == true)
            })
            .unwrap_or(false);
        if remote_closed || (order["status"] == "closed" && metric.is_none()) {
            let mut row = order.clone();
            if let Some((m, env)) = metric {
                let amount = n(
                    m,
                    "filledNotional",
                    n(m, "entryNotional", n(order, "notional", 0.)),
                );
                let leverage = n(
                    binding(order, env),
                    "actualLeverage",
                    n(order, "leverage", 1.),
                )
                .max(1.);
                patch(
                    &mut row,
                    &json!({"status":"closed","source":format!("binance-{env}"),"sourceLabel":if env=="demo"{"币安模拟盘"}else{"币安实盘"},"entry":if n(m,"filledQty",0.)>0.{json!(n(m,"filledNotional",0.)/n(m,"filledQty",1.))}else{order["entry"].clone()},"exit":if n(m,"missingExitQty",0.)>0.{Value::Null}else if n(m,"exitQty",0.)>0.{json!(n(m,"exitNotional",0.)/n(m,"exitQty",1.))}else{order["exit"].clone()},"entryAt":m["entryAt"],"exitAt":m["exitAt"].as_str().or(order["exitAt"].as_str()).or(m["observedClosedAt"].as_str()),"fees":m["commission"],"funding":m["funding"],"gross":n(m,"realized",0.)+n(m,"commission",0.)-n(m,"funding",0.),"accountingIncomplete":n(m,"missingExitQty",0.)>1e-8,"allocationMethod":m["allocationMethod"],"buyAmount":amount,"margin":amount/leverage,"leverage":leverage,"net":m["realized"],"realized":m["realized"],"roi":if amount>0.{json!(n(m,"realized",0.)/(amount/leverage))}else{Value::Null}}),
                );
            } else {
                row["source"] = json!("paper");
                row["sourceLabel"] = json!("本地策略");
                row["buyAmount"] = order["notional"].clone();
            }
            closed.push(row);
        } else if !represented.contains(order["id"].as_str().unwrap_or("")) {
            if let Some((m, env)) = metric.filter(|(m, _)| n(m, "remainingQty", 0.) > 1e-10) {
                let entry = n(m, "entryNotional", 0.) / n(m, "entryQty", 1.).max(1e-12);
                let amount = n(m, "remainingQty", 0.) * entry;
                let mut row = order.clone();
                patch(
                    &mut row,
                    &json!({"id":format!("reconciling:{}",order["id"].as_str().unwrap_or("")),"status":"open","kind":"position","source":format!("binance-{env}"),"environment":env,"quantity":m["remainingQty"],"entry":entry,"buyAmount":amount,"margin":amount/n(order,"leverage",1.).max(1.),"unrealized":0,"realized":m["realized"],"net":m["realized"],"stale":true,"reconciliationPending":true,"localOrders":[ref_order(order)],"executionTargets":[{"environment":env,"symbol":order["symbol"],"positionSide":"BOTH","kind":"position","direction":order["direction"],"localOrders":[ref_order(order)]}]}),
                );
                local.push(row);
            } else if active(order) {
                let remaining = if order["status"] == "open" {
                    share(order)
                } else {
                    1.
                };
                let mut row = order.clone();
                patch(
                    &mut row,
                    &json!({"source":"paper","sourceLabel":"本地策略","kind":if order["status"]=="open"{"position"}else{"entry_order"},"buyAmount":n(order,"notional",0.)*remaining,"margin":n(order,"margin",0.)*remaining,"net":if order["status"]=="open"{n(order,"realizedNet",0.)-n(order,"entryFee",0.)*remaining+n(order,"unrealized",0.)}else{0.},"executionTargets":[],"localOrders":[ref_order(order)]}),
                );
                local.push(row);
            }
        }
    }
    let mut histories = BTreeSet::new();
    for env in ["live", "demo"] {
        let snap = &accounts[env];
        if snap["enabled"] != true || snap["configured"] != true {
            continue;
        }
        for (key, m) in snap["externalMetrics"].as_object().into_iter().flatten() {
            if !histories.insert(key.clone()) {
                continue;
            }
            for cycle in arr(&m["closedCycles"]) {
                let amount = n(&cycle, "entryNotional", 0.);
                let leverage = n(&cycle, "leverage", 1.).max(1.);
                let mut row = cycle.clone();
                patch(
                    &mut row,
                    &json!({"id":format!("external:{env}:{key}:{}",cycle["exitAt"].as_str().unwrap_or("")),"symbol":m["symbol"],"direction":m["direction"],"source":format!("binance-{env}"),"sourceLabel":if env=="live"{"币安实盘"}else{"币安模拟盘"},"status":"closed","kind":"external_closed","entry":amount/n(&cycle,"entryQty",1.).max(1e-12),"buyAmount":amount,"margin":amount/leverage,"leverage":leverage,"net":cycle["realized"],"roi":if amount>0.{json!(n(&cycle,"realized",0.)/(amount/leverage))}else{Value::Null},"reason":"manual","createdAt":cycle["entryAt"],"entryAt":cycle["entryAt"]}),
                );
                closed.push(row);
            }
        }
    }
    let mut active_rows: Vec<Value> = groups.into_values().collect();
    active_rows.extend(local);
    json!({"activeOrders":active_rows,"closedOrders":closed})
}
pub fn account_summary(state: &Value, now: i64) -> Value {
    let orders = arr(&state["orders"]);
    let initial = n(state, "initialBalance", 10000.);
    if state["fusedPoolStartedAt"].is_null() {
        let realized = orders
            .iter()
            .map(|o| {
                if o["status"] == "closed" {
                    n(o, "net", 0.)
                } else if o["status"] == "open" {
                    n(o, "realizedNet", 0.)
                } else {
                    0.
                }
            })
            .sum::<f64>();
        let fees = orders
            .iter()
            .filter(|o| o["status"] == "open")
            .map(|o| n(o, "entryFee", 0.) * share(o))
            .sum::<f64>();
        let used = orders
            .iter()
            .filter(|o| active(o))
            .map(|o| n(o, "margin", 0.) * if o["status"] == "open" { share(o) } else { 1. })
            .sum::<f64>();
        let reserve = orders
            .iter()
            .filter(|o| o["status"] == "pending")
            .map(|o| n(o, "notional", 0.) * n(&o["costs"], "feeBps", 0.) / 10000.)
            .sum::<f64>();
        let floating = orders
            .iter()
            .filter(|o| o["status"] == "open")
            .map(|o| n(o, "unrealized", 0.))
            .sum::<f64>();
        let balance = initial + realized - fees;
        let unlimited = state["unlimitedCapital"] == true;
        let closed_margin = orders
            .iter()
            .filter(|o| o["status"] == "closed")
            .map(|o| n(o, "margin", 0.))
            .sum::<f64>();
        return json!({"unlimitedCapital":unlimited,"investedMargin":orders.iter().filter(|o|n(o,"entry",0.)>0.).map(|o|n(o,"margin",0.)).sum::<f64>(),"closedMargin":closed_margin,"realizedReturn":if closed_margin>0.{json!(realized/closed_margin)}else{Value::Null},"initialBalance":initial,"balance":if unlimited{Value::Null}else{json!(balance)},"available":if unlimited{Value::Null}else{json!(balance-used-reserve)},"equity":if unlimited{Value::Null}else{json!(balance+floating)},"usedMargin":used,"feeReserve":reserve,"entryFees":fees,"realized":realized,"unrealized":floating,"net":realized-fees+floating,"openCount":orders.iter().filter(|o|active(o)).count()});
    }
    let accounts = &state["exchangeAccounts"];
    let activity = fused_orders(state);
    let rows = arr(&activity["activeOrders"]);
    let closed = arr(&activity["closedOrders"]);
    let mut warnings = BTreeSet::new();
    let mut ready = true;
    let mut realized = 0.;
    let mut entry_fees = 0.;
    for o in &orders {
        if let Some((m, _)) = preferred(o, accounts) {
            realized += n(m, "realized", 0.);
        } else if o["status"] == "closed" {
            realized += n(o, "net", 0.);
        } else if o["status"] == "open" {
            let fee = n(o, "entryFee", 0.) * share(o);
            realized += n(o, "realizedNet", 0.) - fee;
            entry_fees += fee;
        }
    }
    let mut external = BTreeSet::new();
    for env in ["live", "demo"] {
        let snap = &accounts[env];
        if snap["enabled"] != true {
            continue;
        }
        let fresh = |k: &str| {
            timestamp(&snap[k])
                .map(|t| now >= t && now - t <= 120000)
                .unwrap_or(false)
        };
        if snap["configured"] != true {
            ready = false;
            warnings.insert("已启用的币安执行环境缺少凭证，暂不新增订单。".to_owned());
        }
        if !snap["error"].as_str().unwrap_or("").is_empty()
            || !snap["metricsError"].as_str().unwrap_or("").is_empty()
            || !fresh("syncedAt")
            || !fresh("metricsSyncedAt")
        {
            ready = false;
            warnings.insert(format!(
                "{env} 账户与成交收益未完成最新同步，暂不新增订单。"
            ));
        }
        for (k, m) in snap["externalMetrics"].as_object().into_iter().flatten() {
            if external.insert(k.clone()) {
                realized += n(m, "realized", 0.);
            }
        }
    }
    let floating = rows
        .iter()
        .filter(|o| o["status"] == "open")
        .map(|o| n(o, "unrealized", 0.))
        .sum::<f64>();
    let used = rows.iter().map(|o| n(o, "margin", 0.)).sum::<f64>();
    let fee_reserve = rows
        .iter()
        .map(|o| {
            n(o, "buyAmount", 0.) * n(&o["costs"], "feeBps", 6.) / 10000.
                * if o["status"] == "pending" { 2. } else { 1. }
        })
        .sum::<f64>();
    let reservations = state["capitalReservations"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, r)| {
            matches!(
                r["status"].as_str(),
                Some("submitting" | "submitted" | "unknown")
            )
        })
        .map(|(_, r)| n(r, "margin", 0.) + n(r, "feeReserve", 0.))
        .sum::<f64>();
    let equity = initial + realized + floating;
    let committed = used + fee_reserve + reservations;
    if rows.iter().any(|o| o["reconciliationPending"] == true)
        || orders.iter().any(|o| {
            ["live", "demo"].iter().any(|env| {
                accounts[env]["enabled"] == true
                    && n(binding(o, env), "executedQty", 0.) > 0.
                    && n(
                        &accounts[env]["orderMetrics"][o["id"].as_str().unwrap_or("")],
                        "filledQty",
                        0.,
                    ) <= 0.
            })
        })
    {
        ready = false;
        warnings.insert("持仓与成交记录正在对账，保留保证金占用并暂停新增订单。".into());
    }
    if equity <= 0. {
        warnings.insert("总权益不为正，不能新增订单。".into());
    } else if committed > equity + 1e-8 {
        warnings.insert("已有持仓与挂单占用超过当前权益，新增订单已暂停。".into());
    }
    if state["entriesPaused"] == true {
        warnings.insert("已暂停新增订单。".into());
    }
    let incomplete = closed
        .iter()
        .filter(|o| o["accountingIncomplete"] == true)
        .count();
    json!({"fused":true,"unlimitedCapital":false,"unit":"USDT","initialBalance":initial,"realized":realized,"unrealized":floating,"net":realized+floating,"balance":initial+realized,"equity":equity,"available":equity-committed,"usedMargin":used,"entryFees":entry_fees,"feeReserve":fee_reserve,"reservationMargin":reservations,"committed":committed,"totalBuyAmount":rows.iter().map(|o|n(o,"buyAmount",0.)).sum::<f64>(),"positions":rows.iter().filter(|o|o["status"]=="open").count(),"pending":rows.iter().filter(|o|o["status"]=="pending").count(),"openCount":rows.len(),"investedMargin":orders.iter().filter(|o|n(o,"entry",0.)>0.).map(|o|n(o,"margin",0.)).sum::<f64>(),"closedMargin":closed.iter().map(|o|n(o,"margin",0.)).sum::<f64>(),"syncReady":ready,"accountingComplete":incomplete==0,"incompleteHistory":incomplete,"canOpen":ready&&state["entriesPaused"]!=true&&equity>committed,"warnings":warnings.into_iter().collect::<Vec<_>>(),"poolStartedAt":state["fusedPoolStartedAt"]})
}
fn legacy_entry_id(o: &Value, env: &str) -> String {
    format!(
        "{}{}",
        if env == "demo" {
            "nofxpaper"
        } else {
            "nofxlive"
        },
        o["id"]
            .as_str()
            .unwrap_or("")
            .replace('-', "")
            .chars()
            .take(20)
            .collect::<String>()
    )
}

pub fn submit_paper_order(
    state: &mut Value,
    record: &Value,
    input: &Value,
    now: i64,
) -> Result<Value> {
    let symbol = input["symbol"].as_str().context("下单须指定币种")?;
    crate::exchange::valid_symbol(symbol)?;
    let requested = input["strategyId"]
        .as_str()
        .or(record["strategyId"].as_str());
    let candidates: Vec<_> = record["analyses"]
        .as_array()
        .context("分析记录无信号")?
        .iter()
        .filter(|s| s["symbol"] == symbol)
        .collect();
    let signal = if let Some(id) = requested {
        candidates
            .iter()
            .copied()
            .find(|s| s["strategyId"] == id)
            .or_else(|| {
                if candidates.len() == 1 && candidates[0]["strategyId"].is_null() {
                    Some(candidates[0])
                } else {
                    None
                }
            })
    } else {
        candidates.first().copied()
    }
    .context("未找到对应币种与策略的分析信号")?;
    let existing = state["orders"].as_array().into_iter().flatten().find(|o| {
        o["recordId"] == record["id"]
            && o["symbol"] == symbol
            && requested
                .map(|id| o["analysisContext"]["strategyId"] == id || o["strategyId"] == id)
                .unwrap_or(true)
    });
    if let Some(o) = existing {
        return Ok(o.clone());
    }
    if signal["eligible"] != true
        || !signal["plan"].is_object()
        || !matches!(
            signal["positionRecommendation"].as_str(),
            Some("OPEN_LONG" | "OPEN_SHORT")
        )
    {
        bail!("该分析为观望或没有有效开仓计划，不能模拟下单。");
    }
    let provider = signal["marketProvider"]
        .as_str()
        .or(record["marketProvider"].as_str())
        .context("分析行情来源无效")?;
    if !["binance", "okx"].contains(&provider) {
        bail!("分析行情来源无效，请重新分析。");
    }
    let tf = signal["interval"].as_str().unwrap_or("1m");
    let duration = interval_ms(tf).context("无效计划周期")?;
    let first = timestamp(&signal["firstEntryAt"])
        .context("分析计划入场时间无效")?
        .max((now.div_euclid(duration) + 1) * duration);
    let equity = n(&account_summary(state, now), "equity", 0.);
    let automatic_pct = input["autoMarginPct"].as_f64();
    let margin = if !input["margin"].is_null() && input["margin"] != "" {
        n(input, "margin", f64::NAN)
    } else if let Some(pct) = automatic_pct {
        (equity * pct * 100.).floor() / 100.
    } else {
        100.
    };
    let max = std::env::var("NOFX_MAX_LEVERAGE")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(12.)
        .clamp(1., 125.);
    let requested_leverage = n(
        input,
        "leverage",
        n(
            signal,
            "recommendedLeverage",
            n(&signal["plan"], "recommendedLeverage", 1.),
        ),
    );
    if !margin.is_finite()
        || !(1. ..=100000.).contains(&margin)
        || !requested_leverage.is_finite()
        || requested_leverage.fract() != 0.
        || requested_leverage < 1.
        || requested_leverage > max
    {
        bail!("保证金须为 1～100000 USDT，杠杆须为 1～{} 的整数。", max);
    }
    let per_symbol = n(input, "symbolMaxLeverage", max);
    let leverage = requested_leverage.min(per_symbol).max(1.);
    let fused = !state["fusedPoolStartedAt"].is_null();
    let orders = arr(&state["orders"]);
    if !fused && state["unlimitedCapital"] != true {
        if orders.iter().filter(|o| active(o)).count() >= 20 {
            bail!("最多同时持有 20 个模拟挂单或持仓。");
        }
        if orders.iter().any(|o| active(o) && o["symbol"] == symbol) {
            bail!("该币种已有模拟挂单或持仓。");
        }
    }
    if fused
        && arr(&fused_orders(state)["activeOrders"])
            .iter()
            .any(|o| o["symbol"] == symbol && o["direction"] != signal["positionRecommendation"])
    {
        bail!("该币种存在反向持仓或挂单，请先平仓。");
    }
    let mut plan = if input["executionPlan"].is_object() {
        input["executionPlan"].clone()
    } else {
        signal["plan"].clone()
    };
    for k in ["stopLoss", "takeProfit"] {
        if !input[k].is_null() {
            plan[k] = json!(n(input, k, f64::NAN));
        }
    }
    let long = signal["positionRecommendation"] == "OPEN_LONG";
    let lo = n(&plan, "entryMin", f64::NAN);
    let hi = n(&plan, "entryMax", f64::NAN);
    let stop = n(&plan, "stopLoss", f64::NAN);
    let target = n(&plan, "takeProfit", f64::NAN);
    if [lo, hi, stop, target]
        .iter()
        .any(|x| !x.is_finite() || *x <= 0.)
        || lo > hi
        || !(if long {
            stop < lo && target > hi
        } else {
            target < lo && stop > hi
        })
    {
        bail!("止盈止损必须位于入场区间两侧，且符合多空方向。");
    }
    let limit = n(&plan, "entryLimit", 0.);
    if plan["entryStyle"] == "market" || limit <= 0. {
        let current = n(&signal["opportunityReport"]["current"], "price", 0.);
        if current > 0.
            && (current < lo
                || current > hi
                || !(if long {
                    current > stop && current < target
                } else {
                    current < stop && current > target
                }))
        {
            bail!("当前价已偏离原计划的允许范围，等待重新分析。");
        }
    }
    let costs = json!({"feeBps":6,"slippageBps":5,"fundingBpsPer8h":3,"notional":10});
    let notional = margin * leverage;
    let funds = account_summary(state, now);
    if state["entriesPaused"] == true {
        bail!("统一资金池已暂停开仓。");
    }
    if fused && funds["syncReady"] != true {
        bail!("成交与持仓同步尚未完成，请稍后重试。");
    }
    if (fused || state["unlimitedCapital"] != true)
        && margin + notional * 0.0006 * if fused { 2. } else { 1. }
            > n(&funds, "available", 0.) + 1e-8
    {
        bail!("共享资金池可用余额不足：保证金和手续费预留不能超过总权益。");
    }
    let strategy_id = requested.or(signal["strategyId"].as_str());
    let order = json!({"id":uuid::Uuid::new_v4().to_string(),"recordId":record["id"],"symbol":symbol,"interval":tf,"marketProvider":provider,"direction":signal["positionRecommendation"],"status":"pending","margin":margin,"leverage":leverage,"notional":notional,"plan":plan,"initialPlan":plan,"costs":costs,"automatic":input["automatic"]==true,"protectionRevisions":[],"reviewHistory":[],"strategyId":strategy_id,"analysisContext":{"signal":signal,"strategyVersion":record["strategyVersion"],"strategyModel":record["snapshot"]["model"],"strategyId":strategy_id,"strategyName":record["strategyName"].as_str().or(record["snapshot"]["strategyName"].as_str()),"strategyParams":record["strategyParams"].as_object().or(record["snapshot"]["strategyParams"].as_object()),"analysisEngine":record["analysisEngine"].as_str().or(signal["analysisEngine"].as_str()),"scope":record["scope"],"confidence":signal["confidence"],"confidenceType":signal["confidenceType"],"reason":signal["reason"],"risk":signal["risk"],"validationIssues":signal["validationIssues"],"automationRunId":record["automationRunId"],"dataAsOf":signal["dataAsOf"]},"exchangeSync":{"demo":sync_state("demo"),"live":sync_state("live")},"exchange":sync_state("demo"),"createdAt":iso(now),"expiresAt":iso(now+86400000),"nextTime":first,"heldBars":0,"error":""});
    if !state["orders"].is_array() {
        state["orders"] = json!([]);
    }
    state["orders"]
        .as_array_mut()
        .unwrap()
        .insert(0, order.clone());
    Ok(order)
}

pub fn advance_paper_order(order: &mut Value, rows: &[Value], now: i64) -> Result<()> {
    if !active(order) {
        return Ok(());
    }
    if order["status"] == "pending"
        && timestamp(&order["createdAt"])
            .map(|t| now >= t + 86400000)
            .unwrap_or(false)
    {
        patch(
            order,
            &json!({"status":"expired","reason":"pending_expired","expiresAt":timestamp(&order["createdAt"]).map(|t|iso(t+86400000)),"expiredAt":iso(now),"error":""}),
        );
        return Ok(());
    }
    let output = simulator::evaluate(
        order,
        rows,
        now,
        &json!({"mode":"account","enableLiquidation":true,"enableIsolatedMargin":true,"enableDynamicProtection":true}),
    )?;
    for k in [
        "nextTime",
        "entry",
        "entryAt",
        "heldBars",
        "quantity",
        "entryFee",
        "liquidationPrice",
        "markPrice",
        "markAt",
        "unrealized",
        "tpStage",
        "tpStopFloor",
        "realizedGross",
        "realizedFee",
        "realizedFunding",
        "realizedNet",
        "realizedQty",
    ] {
        if !output[k].is_null() {
            order[k] = output[k].clone();
        }
    }
    if output["status"] == "data_gap" {
        if n(order, "entry", 0.) > 0. {
            order["status"] = json!("open");
        }
        order["error"] = json!(format!(
            "缺少 {} 的已收盘 K 线，等待补齐后继续。",
            output["missingAt"].as_str().unwrap_or("")
        ));
    } else {
        patch(order, &output);
        order["error"] = json!("");
        if order["status"] == "closed" {
            order["unrealized"] = json!(0.);
        }
    }
    Ok(())
}

pub fn apply_protection_review(
    order: &mut Value,
    proposal: &Value,
    now: i64,
    engine: &str,
) -> Result<Value> {
    let mut report = json!({"at":iso(now),"engine":engine,"action":"held","reason":proposal["reason"].as_str().unwrap_or("保留当前保护价格。")});
    if order["status"] != "open" {
        return Ok(report);
    }
    let tf = order["interval"].as_str().unwrap_or("1m").to_owned();
    let ms = interval_ms(&tf).context("Invalid interval")?;
    let fresh = timestamp(&order["markAt"]) == Some(now.div_euclid(ms) * ms)
        && order["error"].as_str().unwrap_or("").is_empty();
    if fresh && proposal["action"] == "UPDATE_PROTECTION" {
        let long = order["direction"] == "OPEN_LONG";
        let stop = n(proposal, "stopLoss", 0.);
        let target = n(proposal, "takeProfit", 0.);
        let price = n(order, "markPrice", 0.);
        let mut tight = n(
            &order["initialPlan"],
            "stopLoss",
            n(&order["plan"], "stopLoss", 0.),
        );
        for r in arr(&order["protectionRevisions"]) {
            tight = if long {
                tight.max(n(&r, "stopLoss", tight))
            } else {
                tight.min(n(&r, "stopLoss", tight))
            };
        }
        if [stop, target, price]
            .iter()
            .all(|x| x.is_finite() && *x > 0.)
            && (if long {
                stop < price && price < target && stop >= tight
            } else {
                target < price && price < stop && stop <= tight
            })
            && ((stop - n(&order["plan"], "stopLoss", stop)).abs() / price >= 0.0001
                || (target - n(&order["plan"], "takeProfit", target)).abs() / price >= 0.0001)
        {
            if order["initialPlan"].is_null() {
                order["initialPlan"] = order["plan"].clone();
            }
            let effective = simulator::next_open(now.div_euclid(ms) * ms, &tf)?;
            let revision = json!({"stopLoss":stop,"takeProfit":target,"effectiveFrom":effective,"at":iso(now)});
            if !order["protectionRevisions"].is_array() {
                order["protectionRevisions"] = json!([]);
            }
            order["protectionRevisions"]
                .as_array_mut()
                .unwrap()
                .push(revision);
            patch(
                &mut report,
                &json!({"action":"updated","previous":{"stopLoss":order["plan"]["stopLoss"],"takeProfit":order["plan"]["takeProfit"]},"stopLoss":stop,"takeProfit":target,"effectiveFrom":effective}),
            );
            order["plan"]["stopLoss"] = json!(stop);
            order["plan"]["takeProfit"] = json!(target);
        } else {
            report["reason"] = json!("建议价格无效、已被穿越或扩大了止损风险，保留原保护。");
        }
    } else if !fresh {
        report["reason"] = json!("行情尚未连续结算到最新收盘时间，暂不修改。");
    }
    let mut history = arr(&order["reviewHistory"]);
    history.push(report.clone());
    if history.len() > 50 {
        history.drain(0..history.len() - 50);
    }
    order["reviewHistory"] = json!(history);
    Ok(report)
}

pub async fn lock_execution<'a>(
    db: &'a Db,
    environment: &str,
    symbol: &str,
    position_side: &str,
) -> Result<Transaction<'a, Postgres>> {
    let mut tx = db.pool.begin().await?;
    let key = format!("nofx-execution:{environment}:{symbol}:{position_side}");
    let acquired: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(key)
            .fetch_one(&mut *tx)
            .await?;
    if !acquired {
        bail!("该币种正在执行其他交易操作，请稍后重试。");
    }
    Ok(tx)
}
pub async fn status(db: &Db) -> Result<Value> {
    let state = db.account(true, None).await?;
    let mut output = account_summary(&state, now_ms());
    let activity = fused_orders(&state);
    let active_orders = if state["fusedPoolStartedAt"].is_null() {
        arr(&state["orders"])
            .into_iter()
            .filter(active)
            .collect::<Vec<_>>()
    } else {
        arr(&activity["activeOrders"])
    };
    let closed_orders = if state["fusedPoolStartedAt"].is_null() {
        arr(&state["orders"])
            .into_iter()
            .filter(|o| o["status"] == "closed")
            .collect::<Vec<_>>()
    } else {
        arr(&activity["closedOrders"])
    };
    let mut accounts = state["exchangeAccounts"].clone();
    for (_, snapshot) in accounts.as_object_mut().into_iter().flatten() {
        if let Some(o) = snapshot.as_object_mut() {
            o.remove("accountKey");
        }
    }
    patch(
        &mut output,
        &json!({"orders":state["orders"],"activeOrders":active_orders,"closedOrders":closed_orders,"exchangeAccounts":accounts,"entriesPaused":state["entriesPaused"]==true,"activityCounts":{"positions":active_orders.iter().filter(|o|o["status"]=="open").count(),"pending":active_orders.iter().filter(|o|o["status"]=="pending").count()},"busy":false,"lastRunAt":state["lastPaperRunAt"],"error":state["lastPaperError"].as_str().unwrap_or(""),"autoMarginPct":std::env::var("NOFX_AUTO_MARGIN_PCT").ok().and_then(|s|s.parse::<f64>().ok()).unwrap_or(0.05).clamp(0.01,1.)}),
    );
    Ok(output)
}
pub async fn submit(db: &Db, store: &Store, input: &Value) -> Result<Value> {
    let record_id = input["recordId"].as_str().context("须指定分析记录")?;
    let record = db.record(record_id).await?.context("分析记录不存在")?;
    let order = db
        .mutate_account_light(|state| submit_paper_order(state, &record, input, now_ms()))
        .await?;
    let id = order["id"].as_str().context("Order id")?.to_owned();
    if let Err(error) = sync_entries(db, store, Some(&id)).await {
        tracing::warn!(%error,"Paper entry remains stored for exchange reconciliation");
    }
    let state = db.account(false, Some(&id)).await?;
    Ok(state["orders"][0].clone())
}

pub async fn refresh(db: &Db, store: &Store) -> Result<Value> {
    let _guard = lock_execution(db, "system", "paper-refresh", "ALL").await?;
    let state = db.account(true, None).await?;
    let client = Exchange::public()?;
    let now = now_ms();
    let mut processed = 0;
    for original in arr(&state["orders"])
        .into_iter()
        .filter(|o| active(o) && o["manualCloseRequested"] != true)
    {
        let id = original["id"]
            .as_str()
            .context("Order missing id")?
            .to_owned();
        let symbol = original["symbol"]
            .as_str()
            .context("Order missing symbol")?;
        let tf = original["interval"].as_str().unwrap_or("1m");
        let ms = interval_ms(tf).context("Invalid order interval")?;
        let result=async {
            if original["marketProvider"] != "binance" { bail!("行情来源已经切换为 Binance；旧订单不能使用其他交易所行情推进，请取消并重新分析。"); }
            let mut order=original.clone();if order["status"]=="pending" && timestamp(&order["createdAt"]).map(|t|now>=t+86400000).unwrap_or(false){advance_paper_order(&mut order,&[],now)?;return Ok::<Value,anyhow::Error>(order);}
            let next=timestamp(&order["nextTime"]).context("Order checkpoint missing")?;let smart=&order["plan"]["exitRules"]["smartExit"];let history=n(smart,"maPeriod",20.).max(n(smart,"atrPeriod",14.)).max(80.) as i64+2;let start=next-history*ms;
            let namespaced=storage_symbol(symbol,original["marketProvider"].as_str().unwrap_or("binance"))?;let mut rows=db.candles(&namespaced,tf,100000,Some(start),Some(now)).await?;
            let desired=next.div_euclid(ms)*ms;let has_latest=rows.last().and_then(|r|timestamp(&r["openTime"])).map(|t|t+ms>=now.div_euclid(ms)*ms).unwrap_or(false);
            let has_start=rows.iter().any(|r|timestamp(&r["openTime"])==Some(desired));
            if !has_latest||!has_start {
                if original["marketProvider"]!="binance"{bail!("当前原生行情客户端需要 Binance K 线；请切换行情来源并重新分析。");}
                let mut cursor=if has_start{rows.last().and_then(|r|timestamp(&r["openTime"])).unwrap_or(start)}else{start};
                for _ in 0..64 {if cursor+ms>now{break;}let fetched=client.klines(symbol,tf,1000,Some(cursor),Some(now-1)).await?;if fetched.is_empty(){break;}let latest=fetched.last().and_then(|r|timestamp(&r["openTime"])).context("Fetched candle timestamp")?;db.save_klines(&namespaced,tf,&fetched).await?;rows.extend(fetched);if latest<cursor{break;}cursor=latest+ms;}
            }
            rows.sort_by_key(|r|timestamp(&r["openTime"]));let mut map=BTreeMap::new();for row in rows{if let Some(t)=timestamp(&row["openTime"]){map.insert(t,row);}}let rows:Vec<_>=map.into_values().collect();advance_paper_order(&mut order,&rows,now)?;
            Ok(order)
        }.await;
        db.mutate_account_light(|state| {
            let Some(order) = state["orders"]
                .as_array_mut()
                .and_then(|a| a.iter_mut().find(|o| o["id"] == id))
            else {
                return Ok(Value::Null);
            };
            // A close/cancel issued during network reads wins over this older simulation snapshot.
            if !active(order) || order["nextTime"] != original["nextTime"] {
                return Ok(order.clone());
            }
            match result {
                Ok(ref updated) => {
                    let links = order["exchangeSync"].clone();
                    let legacy = order["exchange"].clone();
                    patch(order, updated);
                    order["exchangeSync"] = links;
                    order["exchange"] = legacy;
                    processed += 1;
                }
                Err(ref error) => order["error"] = json!(error.to_string()),
            }
            Ok(order.clone())
        })
        .await?;
    }
    db.mutate_account_light(|s| {
        s["lastPaperRunAt"] = json!(iso(now));
        s["lastPaperError"] = json!("");
        Ok(json!({"processed":processed}))
    })
    .await?;
    if let Err(error) = sync_entries(db, store, None).await {
        tracing::warn!(%error,"Exchange entries/protection awaiting reconciliation");
    }
    status(db).await
}

pub fn normalize_account(positions: &Value, orders: &Value) -> Result<Value> {
    let positions = positions.as_array().context("币安未返回完整持仓列表")?;
    let orders = orders.as_array().context("币安未返回完整挂单列表")?;
    for p in positions {
        if p["symbol"].as_str().unwrap_or("").is_empty()
            || !n(p, "positionAmt", f64::NAN).is_finite()
        {
            bail!("币安持仓数据无效，保留上次同步结果。");
        }
    }
    for o in orders {
        if o["symbol"].as_str().unwrap_or("").is_empty()
            || o["orderId"].is_null()
            || !n(o, "origQty", f64::NAN).is_finite()
            || !n(o, "executedQty", f64::NAN).is_finite()
        {
            bail!("币安挂单数据无效，保留上次同步结果。");
        }
    }
    let positions:Vec<_>=positions.iter().filter(|p|n(p,"positionAmt",0.)!=0.).map(|p|json!({"symbol":p["symbol"],"positionSide":p["positionSide"].as_str().unwrap_or("BOTH"),"positionAmt":n(p,"positionAmt",0.),"entryPrice":n(p,"entryPrice",0.),"markPrice":n(p,"markPrice",0.),"leverage":n(p,"leverage",1.),"notional":n(p,"notional",0.).abs().max((n(p,"positionAmt",0.)*n(p,"markPrice",0.)).abs()),"unrealized":n(p,"unRealizedProfit",n(p,"unrealizedProfit",0.)),"isolatedMargin":n(p,"isolatedMargin",0.),"liquidationPrice":n(p,"liquidationPrice",0.),"updateTime":n(p,"updateTime",0.)})).collect();
    let pending:Vec<_>=orders.iter().filter(|o|o["reduceOnly"]!=true&&o["reduceOnly"]!="true"&&o["closePosition"]!=true&&o["closePosition"]!="true"&&!(o["positionSide"]=="LONG"&&o["side"]=="SELL")&&!(o["positionSide"]=="SHORT"&&o["side"]=="BUY")&&matches!(o["status"].as_str(),Some("NEW"|"PARTIALLY_FILLED"))).map(|o|{let leverage=positions.iter().find(|p|p["symbol"]==o["symbol"]&&p["positionSide"].as_str().unwrap_or("BOTH")==o["positionSide"].as_str().unwrap_or("BOTH")).map(|p|n(p,"leverage",1.)).unwrap_or(1.);json!({"symbol":o["symbol"],"orderId":o["orderId"].as_str().map(str::to_owned).unwrap_or_else(||o["orderId"].to_string()),"clientOrderId":o["clientOrderId"].as_str().unwrap_or(""),"positionSide":o["positionSide"].as_str().unwrap_or("BOTH"),"side":o["side"],"type":o["type"],"status":o["status"].as_str().unwrap_or("").to_lowercase(),"price":n(o,"price",0.),"avgPrice":n(o,"avgPrice",0.),"origQty":n(o,"origQty",0.),"executedQty":n(o,"executedQty",0.),"time":n(o,"time",0.),"updateTime":n(o,"updateTime",0.),"leverage":leverage})}).collect();
    Ok(json!({"positions":positions,"orders":pending}))
}

pub fn reconcile_orders(state: &mut Value) {
    let accounts = state["exchangeAccounts"].clone();
    for order in state["orders"].as_array_mut().into_iter().flatten() {
        let Some((metric, env)) = preferred(order, &accounts) else {
            continue;
        };
        if n(metric, "filledQty", 0.) <= 0.
            || !n(metric, "filledNotional", f64::NAN).is_finite()
            || n(metric, "remainingQty", 0.) > 1e-10
            || !(n(metric, "exitQty", 0.) > 0.
                || metric["offsetEntry"] == true
                || metric["closedByObservation"] == true)
        {
            continue;
        }
        let pending = ["live", "demo"].iter().any(|e| {
            accounts[e]["enabled"] == true
                && arr(&accounts[e]["orders"]).iter().any(|r| {
                    r["symbol"] == order["symbol"]
                        && r["orderId"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| r["orderId"].to_string())
                            == binding(order, e)["orderId"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| binding(order, e)["orderId"].to_string())
                })
        });
        if pending {
            continue;
        }
        let lev = n(
            binding(order, env),
            "actualLeverage",
            n(order, "leverage", 1.),
        )
        .max(1.);
        let amount = n(metric, "filledNotional", 0.);
        patch(
            order,
            &json!({"status":"closed","reason":if matches!(order["status"].as_str(),Some("cancelled"|"expired")){"manual"}else{order["reason"].as_str().unwrap_or("manual")},"net":metric["realized"],"fees":metric["commission"],"funding":metric["funding"],"gross":n(metric,"realized",0.)+n(metric,"commission",0.)-n(metric,"funding",0.),"exitAt":metric["exitAt"].as_str().or(order["exitAt"].as_str()).or(metric["observedClosedAt"].as_str()),"entry":amount/n(metric,"filledQty",1.).max(1e-12),"margin":amount/lev,"notional":amount,"roi":if amount>0.{json!(n(metric,"realized",0.)/(amount/lev))}else{Value::Null}}),
        );
        if n(metric, "missingExitQty", 0.) <= 1e-8 && n(metric, "exitQty", 0.) > 0. {
            order["exit"] = json!(n(metric, "exitNotional", 0.) / n(metric, "exitQty", 1.));
        }
    }
}

pub async fn exchange_refresh(db: &Db, store: &Store) -> Result<Value> {
    let _guard = lock_execution(db, "system", "exchange-refresh", "ALL").await?;
    let config = store.read("config").await?;
    let state = db.account(true, None).await?;
    let mut results = vec![];
    for env in ["demo", "live"] {
        let client = Exchange::new(&config, env)?;
        let configured = client.credentials();
        let enabled = sync_enabled(&config, env)
            || (env == "demo" && configured && crate::exchange::is_demo(&config["binance"]));
        let mut result = json!({"environment":env,"enabled":enabled,"configured":configured,"lastAttemptAt":iso(now_ms()),"accountKey":client.account_key(),"error":if enabled&&!configured{"未配置币安账户凭证。"}else{""}});
        if enabled && configured {
            let response=async{
                let mut resolved=vec![];for(id,reservation)in state["capitalReservations"].as_object().into_iter().flatten(){if reservation["environment"]!=env||!matches!(reservation["status"].as_str(),Some("submitting"|"submitted"|"unknown")){continue;}let symbol=reservation["symbol"].as_str().unwrap_or("");let cid=reservation["clientOrderId"].as_str().unwrap_or("");if cid.is_empty(){continue;}
if let Ok(order)=client.signed("GET","/fapi/v1/order",&json!({"symbol":symbol,"origClientOrderId":cid})).await{resolved.push(json!({"id":id,"orderId":order["orderId"],"status":if matches!(order["status"].as_str(),Some("REJECTED"|"EXPIRED"|"CANCELED"))&&n(&order,"executedQty",0.)<=0.{"rejected"}else{"submitted"}}));}}
                let empty=json!({});let(positions,orders)=tokio::try_join!(client.signed("GET","/fapi/v2/positionRisk",&empty),client.signed("GET","/fapi/v1/openOrders",&empty))?;let mut snapshot=normalize_account(&positions,&orders)?;
                let previous=&state["exchangeAccounts"][env];let same=previous["accountKey"]==client.account_key();let mut previous=if same{previous.clone()}else{json!({})};previous["poolStartedAt"]=state["fusedPoolStartedAt"].clone();
                match crate::ledger::synchronize(db,&client,env,&previous,&arr(&state["orders"]),snapshot["positions"].as_array().unwrap(),snapshot["orders"].as_array().unwrap()).await{Ok(metrics)=>patch(&mut snapshot,&metrics),Err(error)=>{for k in ["orderMetrics","externalMetrics","metricsSyncedAt","observedOrderIds"]{snapshot[k]=previous[k].clone();}snapshot["metricsError"]=json!(error.to_string());}}
                patch(&mut snapshot,&json!({"syncedAt":iso(now_ms()),"error":"","resolvedReservations":resolved}));Ok::<Value,anyhow::Error>(snapshot)
            }.await;
            match response {
                Ok(snapshot) => patch(&mut result, &snapshot),
                Err(error) => result["error"] = json!(error.to_string()),
            }
        }
        results.push(result);
    }
    db.mutate_account_light(|state| {
        if !state["exchangeAccounts"].is_object() {
            state["exchangeAccounts"] = json!({});
        }
        for result in &results {
            let env = result["environment"].as_str().unwrap();
            let previous = state["exchangeAccounts"][env].clone();
            let same =
                result["configured"] == true && previous["accountKey"] == result["accountKey"];
            let mut snapshot = if same { previous } else { json!({}) };
            patch(&mut snapshot, result);
            let resolved = arr(&snapshot["resolvedReservations"]);
            snapshot
                .as_object_mut()
                .unwrap()
                .remove("resolvedReservations");
            for item in resolved {
                let id = item["id"].as_str().unwrap();
                if state["capitalReservations"][id].is_object() {
                    patch(&mut state["capitalReservations"][id], &item);
                }
            }
            if snapshot["error"] == "" && snapshot["metricsError"].as_str().unwrap_or("").is_empty()
            {
                for (_, reservation) in state["capitalReservations"]
                    .as_object_mut()
                    .into_iter()
                    .flatten()
                {
                    if reservation["environment"] != env {
                        continue;
                    }
                    if arr(&snapshot["orders"]).iter().any(|o| {
                        o["clientOrderId"] == reservation["clientOrderId"]
                            || (!reservation["orderId"].is_null()
                                && o["orderId"]
                                    .as_str()
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| o["orderId"].to_string())
                                    == reservation["orderId"]
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| reservation["orderId"].to_string()))
                    }) || arr(&snapshot["observedOrderIds"]).iter().any(|id| {
                        id.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| id.to_string())
                            == reservation["orderId"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| reservation["orderId"].to_string())
                    }) {
                        reservation["status"] = json!("reconciled");
                    }
                }
            }
            state["exchangeAccounts"][env] = snapshot;
        }
        reconcile_orders(state);
        Ok(json!(results))
    })
    .await?;
    status(db).await
}

fn uncertain(error: &anyhow::Error) -> bool {
    let message = error.to_string().to_lowercase();
    [
        "timeout",
        "timed out",
        "connect",
        "network",
        "socket",
        "sending request",
        "http 500",
        "http 502",
        "http 503",
        "http 504",
        "-1006",
        "-1007",
    ]
    .iter()
    .any(|s| message.contains(s))
}
fn missing_order(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("-2013") || message.contains("Order does not exist")
}
fn numeric_id(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn formatted(value: f64) -> String {
    format!("{value:.12}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}
pub fn aligned_quantity(info: &Value, amount: f64, market: bool) -> Result<f64> {
    if !amount.is_finite() || amount <= 0. {
        bail!("下单数量无效。");
    }
    let filters = info["filters"].as_array().context("币种数量过滤器未就绪")?;
    let filter = filters
        .iter()
        .find(|f| {
            f["filterType"]
                == if market {
                    "MARKET_LOT_SIZE"
                } else {
                    "LOT_SIZE"
                }
                && n(f, "stepSize", 0.) > 0.
        })
        .or_else(|| filters.iter().find(|f| f["filterType"] == "LOT_SIZE"))
        .context("缺少数量过滤器")?;
    let step = n(filter, "stepSize", 0.);
    if step <= 0. {
        bail!("币种数量步长无效。");
    }
    let max = n(filter, "maxQty", amount);
    let min = n(filter, "minQty", 0.);
    let quantity = ((amount.min(max) + step * 1e-8) / step).floor() * step;
    if quantity <= 0. || quantity < min || quantity > amount + step * 1e-7 {
        bail!("数量低于交易所最小值或超过可用持仓。");
    }
    Ok(formatted(quantity).parse()?)
}
pub fn aligned_price(info: &Value, price: f64) -> Result<f64> {
    let filter = info["filters"]
        .as_array()
        .and_then(|f| f.iter().find(|f| f["filterType"] == "PRICE_FILTER"))
        .context("缺少价格过滤器")?;
    let tick = n(filter, "tickSize", 0.);
    if tick <= 0. || !price.is_finite() || price <= 0. {
        bail!("保护/委托价格无效。");
    }
    let aligned = ((price + tick * 1e-8) / tick).floor() * tick;
    if aligned <= 0.
        || aligned < n(filter, "minPrice", 0.)
        || (n(filter, "maxPrice", 0.) > 0. && aligned > n(filter, "maxPrice", 0.))
    {
        bail!("委托价不满足交易所价格范围。");
    }
    Ok(formatted(aligned).parse()?)
}
async fn symbol_info(client: &Exchange, symbol: &str) -> Result<Value> {
    let info = client
        .public_request("/fapi/v1/exchangeInfo", &json!({}))
        .await?;
    info["symbols"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["symbol"] == symbol))
        .cloned()
        .context("目标交易环境不支持该合约")
}
async fn mode(client: &Exchange, direction: &str) -> Result<(bool, String)> {
    let mode = client
        .signed("GET", "/fapi/v1/positionSide/dual", &json!({}))
        .await?;
    let dual = mode["dualSidePosition"]
        .as_bool()
        .context("未能确认持仓模式，暂缓执行")?;
    Ok((
        dual,
        if dual {
            if direction == "OPEN_LONG" {
                "LONG"
            } else {
                "SHORT"
            }
        } else {
            "BOTH"
        }
        .into(),
    ))
}
async fn current_position(
    client: &Exchange,
    symbol: &str,
    ps: &str,
    dir: &str,
) -> Result<Option<Value>> {
    let positions = client
        .signed("GET", "/fapi/v2/positionRisk", &json!({"symbol":symbol}))
        .await?;
    Ok(positions
        .as_array()
        .context("未能读取实际持仓数量")?
        .iter()
        .find(|p| {
            p["symbol"] == symbol
                && p["positionSide"].as_str().unwrap_or("BOTH") == ps
                && (if dir == "OPEN_LONG" {
                    n(p, "positionAmt", 0.) > 0.
                } else {
                    n(p, "positionAmt", 0.) < 0.
                })
        })
        .cloned())
}
async fn set_leverage(client: &Exchange, symbol: &str, requested: f64) -> Result<f64> {
    let mut last = None;
    let mut seen = BTreeSet::new();
    for desired in [requested.floor().clamp(1., 125.) as i64, 5, 1] {
        if desired > requested as i64 || !seen.insert(desired) {
            continue;
        }
        match client
            .signed(
                "POST",
                "/fapi/v1/leverage",
                &json!({"symbol":symbol,"leverage":desired}),
            )
            .await
        {
            Ok(response) => {
                let actual = n(&response, "leverage", 0.);
                if actual >= 1. && actual <= requested {
                    return Ok(actual);
                }
                bail!("交易所返回的杠杆超出风控上限。");
            }
            Err(error) => {
                if uncertain(&error) {
                    return Err(error);
                }
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("无法设置杠杆")))
}
async fn update_link(db: &Db, id: &str, env: &str, fields: &Value) -> Result<Value> {
    db.mutate_order(id, |state| {
        let order = state["orders"]
            .as_array_mut()
            .and_then(|a| a.iter_mut().find(|o| o["id"] == id))
            .context("订单不存在")?;
        ensure_links(order);
        patch(&mut order["exchangeSync"][env], fields);
        mirror(order);
        Ok(order.clone())
    })
    .await
}
fn response_link(response: &Value) -> Value {
    json!({"status":response["status"].as_str().unwrap_or("NEW").to_lowercase(),"orderId":response["orderId"],"clientOrderId":response["clientOrderId"],"origQty":n(response,"origQty",0.),"executedQty":n(response,"executedQty",0.),"avgPrice":n(response,"avgPrice",0.),"price":n(response,"price",0.),"positionSide":response["positionSide"].as_str().unwrap_or("BOTH"),"lastSyncedAt":iso(now_ms()),"lastError":""})
}

async fn sync_entry(
    db: &Db,
    client: &Exchange,
    config: &Value,
    env: &str,
    order: &Value,
) -> Result<()> {
    let id = order["id"].as_str().context("Order id")?;
    let symbol = order["symbol"].as_str().context("Order symbol")?;
    let dir = order["direction"].as_str().context("Order direction")?;
    let link = binding(order, env);
    let existing_id = link["clientOrderId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| legacy_entry_id(order, env));
    if !client.credentials() {
        update_link(
            db,
            id,
            env,
            &json!({"status":"not_configured","lastError":"执行环境缺少凭证。"}),
        )
        .await?;
        return Ok(());
    }
    let (_, ps) = mode(client, dir).await?;
    let _guard = lock_execution(db, env, symbol, &ps).await?;
    if let Some(account) = db.account(true, None).await?["exchangeAccounts"][env].as_object()
        && account
            .get("accountKey")
            .is_some_and(|k| k != &json!(client.account_key()))
    {
        bail!("执行凭证已变更，请重新同步账户。");
    }
    let has_intent = matches!(
        link["status"].as_str(),
        Some("submitting" | "unknown" | "new" | "partially_filled" | "filled" | "submitted")
    ) || !link["orderId"].is_null();
    if has_intent {
        let response = client
            .signed(
                "GET",
                "/fapi/v1/order",
                &json!({"symbol":symbol,"origClientOrderId":existing_id}),
            )
            .await;
        match response {
            Ok(remote) => {
                update_link(db, id, env, &response_link(&remote)).await?;
                if !active(order)
                    && matches!(remote["status"].as_str(), Some("NEW" | "PARTIALLY_FILLED"))
                {
                    let canceled = client
                        .signed(
                            "DELETE",
                            "/fapi/v1/order",
                            &json!({"symbol":symbol,"orderId":remote["orderId"]}),
                        )
                        .await?;
                    update_link(db, id, env, &response_link(&canceled)).await?;
                }
            }
            Err(error) => {
                update_link(db,id,env,&json!({"lastError":error.to_string(),"status":if matches!(link["status"].as_str(),Some("submitting"|"unknown")){"unknown"}else{link["status"].as_str().unwrap_or("unknown")}})).await?;
                return Err(error);
            }
        }
        return Ok(());
    }
    if !active(order)
        || order["manualCloseRequested"] == true
        || order["manualEntryCancelled"] == true
    {
        return Ok(());
    }
    let state = db.account(true, None).await?;
    let funds = account_summary(&state, now_ms());
    if state["entriesPaused"] == true
        || (!state["fusedPoolStartedAt"].is_null()
            && (funds["syncReady"] != true
                || n(&funds, "committed", 0.) > n(&funds, "equity", 0.) + 1e-8))
    {
        bail!("开仓暂停、持仓未同步或资金池超限，暂不执行。");
    }
    // Querying before the first send recovers a crash after the server accepted a prior request.
    match client
        .signed(
            "GET",
            "/fapi/v1/order",
            &json!({"symbol":symbol,"origClientOrderId":existing_id}),
        )
        .await
    {
        Ok(remote) => {
            update_link(db, id, env, &response_link(&remote)).await?;
            return Ok(());
        }
        Err(error) if missing_order(&error) => {}
        Err(error) => return Err(error),
    }
    let info = symbol_info(client, symbol).await?;
    let actual = set_leverage(client, symbol, n(order, "leverage", 1.)).await?;
    let plan = &order["plan"];
    let limit = n(plan, "entryLimit", 0.);
    let market = plan["entryStyle"] == "market" || limit <= 0.;
    let mark = client
        .public_request("/fapi/v1/premiumIndex", &json!({"symbol":symbol}))
        .await?;
    let current = n(&mark, "markPrice", 0.);
    let price = if market {
        current
    } else {
        aligned_price(&info, limit)?
    };
    let stop = n(plan, "stopLoss", 0.);
    let target = n(plan, "takeProfit", 0.);
    if current <= 0.
        || !(if dir == "OPEN_LONG" {
            price > stop && price < target
        } else {
            price < stop && price > target
        })
    {
        bail!("计划价格已被穿越，等待重新分析。");
    }
    if market && (current < n(plan, "entryMin", 0.) || current > n(plan, "entryMax", f64::INFINITY))
    {
        bail!("市价已超出原信号入场区间，禁止追价。");
    }
    let quantity = aligned_quantity(&info, n(order, "margin", 0.) * actual / price, market)?;
    for f in arr(&info["filters"]) {
        if matches!(f["filterType"].as_str(), Some("MIN_NOTIONAL" | "NOTIONAL"))
            && quantity * price < n(&f, "notional", n(&f, "minNotional", 0.))
        {
            bail!("名义仓位低于交易所最小成交额。");
        }
        if f["filterType"] == "PERCENT_PRICE"
            && !market
            && (price > current * n(&f, "multiplierUp", f64::INFINITY)
                || price < current * n(&f, "multiplierDown", 0.))
        {
            bail!("限价超出交易所允许的当前价格范围。");
        }
    }
    let mut request = json!({"symbol":symbol,"side":if dir=="OPEN_LONG"{"BUY"}else{"SELL"},"type":if market{"MARKET"}else{"LIMIT"},"quantity":formatted(quantity),"newClientOrderId":existing_id,"newOrderRespType":"RESULT"});
    if ps != "BOTH" {
        request["positionSide"] = json!(ps);
    }
    if !market {
        request["price"] = json!(formatted(price));
        request["timeInForce"] = json!("GTC");
    }
    update_link(db,id,env,&json!({"status":"submitting","clientOrderId":existing_id,"actualLeverage":actual,"positionSide":ps,"submittedAt":iso(now_ms()),"accountKey":client.account_key(),"requestedQuantity":quantity})).await?;
    // Re-check cancellation immediately before sending; no retry is permitted after an ambiguous POST.
    let latest = db.account(true, Some(id)).await?;
    if latest["orders"][0]["manualEntryCancelled"] == true
        || latest["orders"][0]["manualCloseRequested"] == true
    {
        update_link(
            db,
            id,
            env,
            &json!({"status":"cancelled","lastError":"发送前已取消入场。"}),
        )
        .await?;
        return Ok(());
    }
    match client.signed("POST", "/fapi/v1/order", &request).await {
        Ok(remote) => {
            update_link(db, id, env, &response_link(&remote)).await?;
        }
        Err(error) => {
            let ambiguous = uncertain(&error);
            update_link(db,id,env,&json!({"status":if ambiguous{"unknown"}else{"rejected"},"lastError":error.to_string()})).await?;
            if ambiguous
                && let Ok(remote) = client
                    .signed(
                        "GET",
                        "/fapi/v1/order",
                        &json!({"symbol":symbol,"origClientOrderId":existing_id}),
                    )
                    .await
            {
                update_link(db, id, env, &response_link(&remote)).await?;
                return Ok(());
            }
            return Err(error);
        }
    }
    let _ = config;
    Ok(())
}

/// Automatic entries and manually submitted research orders use the same durable exchange links.
pub async fn sync_entries(db: &Db, store: &Store, only: Option<&str>) -> Result<Value> {
    let config = store.read("config").await?;
    let state = db.account(only.is_none(), only).await?;
    let mut results = vec![];
    for env in ["demo", "live"] {
        if !sync_enabled(&config, env) {
            continue;
        }
        let client = Exchange::new(&config, env)?;
        for order in arr(&state["orders"]) {
            if only.is_none() && !needs_exchange_sync(&order, env) {
                continue;
            }
            let id = order["id"].as_str().unwrap_or("");
            let result = sync_entry(db, &client, &config, env, &order).await;
            match result {
                Ok(()) => {
                    let fresh = db.account(false, Some(id)).await?;
                    let updated = &fresh["orders"][0];
                    if n(binding(updated, env), "executedQty", 0.) > 0. {
                        if updated["manualCloseRequested"] == true {
                            let target = json!({"environment":env,"symbol":updated["symbol"],"direction":updated["direction"],"positionSide":binding(updated,env)["positionSide"],"kind":"position","localOrders":[ref_order(updated)]});
                            if let Err(error) = execute_remote_close(db, store, &target, None).await
                            {
                                results.push(json!({"orderId":id,"environment":env,"error":error.to_string()}));
                            }
                        } else {
                            if let Err(error) =
                                sync_strategy_exit(db, &client, env, updated, false).await
                            {
                                results.push(json!({"orderId":id,"environment":env,"error":error.to_string()}));
                                continue;
                            }
                            if updated["status"] == "closed" {
                                continue;
                            }
                            if let Err(error) = sync_protection(db, &client, env, updated).await {
                                update_link(
                                    db,
                                    id,
                                    env,
                                    &json!({"protectionError":error.to_string()}),
                                )
                                .await?;
                                results.push(json!({"orderId":id,"environment":env,"error":error.to_string()}));
                            }
                        }
                    }
                }
                Err(error) => {
                    update_link(db, id, env, &json!({"lastError":error.to_string()})).await?;
                    results.push(json!({"orderId":id,"environment":env,"error":error.to_string()}));
                }
            }
        }
    }
    Ok(json!({"results":results}))
}

async fn cancel_native_protection(client: &Exchange, symbol: &str, ps: &str) -> Result<()> {
    let rows = client
        .signed("GET", "/fapi/v1/openAlgoOrders", &json!({"symbol":symbol}))
        .await?;
    for algo in rows.as_array().context("未取得完整保护单列表")? {
        if !algo["clientAlgoId"]
            .as_str()
            .unwrap_or("")
            .starts_with("nofx")
            || algo["positionSide"].as_str().unwrap_or("BOTH") != ps
        {
            continue;
        }
        client
            .signed(
                "DELETE",
                "/fapi/v1/algoOrder",
                &json!({"algoId":algo["algoId"]}),
            )
            .await?;
    }
    Ok(())
}

fn desired_exit_quantity(order: &Value, link: &Value, emergency: bool) -> f64 {
    let entered = n(link, "executedQty", 0.);
    if emergency || order["status"] == "closed" {
        return entered;
    }
    let realized = n(order, "realizedQty", 0.);
    let original = n(order, "quantity", 0.) + realized;
    if original > 0. {
        entered * (realized / original).clamp(0., 1.)
    } else {
        0.
    }
}

fn needs_exchange_sync(order: &Value, env: &str) -> bool {
    if active(order) {
        return true;
    }
    let link = binding(order, env);
    if matches!(
        link["status"].as_str(),
        Some("submitting" | "unknown" | "new" | "partially_filled" | "submitted")
    ) {
        return true;
    }
    if link["exitReconciled"] == true {
        return false;
    }
    let closed = arr(&link["closeOrders"])
        .iter()
        .map(|a| n(a, "executedQty", 0.))
        .sum::<f64>();
    order["status"] == "closed" && n(link, "executedQty", 0.) > closed + 1e-10
}

/// A strategy owns its entry fill, even when multiple strategies share one exchange position.
/// Persist every close intent before sending; a later tick reconciles that ID instead of resending.
async fn sync_strategy_exit(
    db: &Db,
    client: &Exchange,
    env: &str,
    original: &Value,
    emergency: bool,
) -> Result<()> {
    let id = original["id"].as_str().context("Order id")?;
    let symbol = original["symbol"].as_str().context("Order symbol")?;
    let dir = original["direction"].as_str().context("Direction")?;
    let (dual, ps) = mode(client, dir).await?;
    let _guard = lock_execution(db, env, symbol, &ps).await?;
    for _ in 0..32 {
        let state = db.account(false, Some(id)).await?;
        let order = &state["orders"][0];
        let link = binding(order, env);
        if link["exitReconciled"] == true {
            return Ok(());
        }
        let actions = arr(&link["closeOrders"]);
        if let Some(pending) = actions.iter().find(|a| {
            matches!(
                a["status"].as_str(),
                Some("submitting" | "unknown" | "new" | "partially_filled")
            )
        }) {
            let remote = client
                .signed(
                    "GET",
                    "/fapi/v1/order",
                    &json!({"symbol":symbol,"origClientOrderId":pending["clientOrderId"]}),
                )
                .await
                .context("策略平仓结果尚未确认，保留原请求 ID，未重复发送订单。")?;
            save_strategy_exit(db, id, env, pending, &remote).await?;
            if !matches!(
                remote["status"].as_str(),
                Some("FILLED" | "CANCELED" | "EXPIRED" | "REJECTED")
            ) {
                bail!("策略平仓仍在执行，请稍后同步。");
            }
            continue;
        }
        let desired = desired_exit_quantity(order, link, emergency);
        let closed = actions.iter().map(|a| n(a, "executedQty", 0.)).sum::<f64>();
        if desired <= closed + 1e-10 {
            return Ok(());
        }
        let Some(position) = current_position(client, symbol, &ps, dir).await? else {
            update_link(
                db,
                id,
                env,
                &json!({"exitReconciled":true,"exitReconciledAt":iso(now_ms())}),
            )
            .await?;
            return Ok(());
        };
        let info = symbol_info(client, symbol).await?;
        let remaining = (desired - closed).min(n(&position, "positionAmt", 0.).abs());
        let filters = info["filters"].as_array().context("数量过滤器缺失")?;
        let step = filters
            .iter()
            .find(|f| f["filterType"] == "LOT_SIZE")
            .map(|f| n(f, "stepSize", 0.))
            .unwrap_or(0.);
        if step > 0. && remaining < step {
            return Ok(());
        }
        let quantity = aligned_quantity(&info, remaining, true)?;
        let stage = format!("{desired:.12}:{}", actions.len());
        let cid = client_id("exit", &[env, id, &stage]);
        let intent = json!({"id":cid,"clientOrderId":cid,"status":"submitting","executedQty":0,"quantity":quantity,"reason":if emergency{"emergency_protection"}else if order["status"]=="closed"{order["reason"].as_str().unwrap_or("paper_close")}else{"partial_take_profit"},"submittedAt":iso(now_ms())});
        save_strategy_exit(db, id, env, &intent, &json!({"status":"SUBMITTING"})).await?;
        let mut request = json!({"symbol":symbol,"side":if dir=="OPEN_LONG"{"SELL"}else{"BUY"},"type":"MARKET","quantity":formatted(quantity),"newClientOrderId":cid,"newOrderRespType":"RESULT"});
        if dual {
            request["positionSide"] = json!(ps);
        } else {
            request["reduceOnly"] = json!(true);
        }
        match client.signed("POST", "/fapi/v1/order", &request).await {
            Ok(remote) => {
                save_strategy_exit(db, id, env, &intent, &remote).await?;
                if remote["status"] != "FILLED" {
                    bail!("策略平仓订单尚未完成，请稍后同步。");
                }
            }
            Err(error) => {
                let failure = json!({"status":if uncertain(&error){"UNKNOWN"}else{"REJECTED"},"lastError":error.to_string()});
                save_strategy_exit(db, id, env, &intent, &failure).await?;
                return Err(error);
            }
        }
    }
    bail!("策略平仓达到单次分批上限，请同步后继续。")
}

async fn save_strategy_exit(
    db: &Db,
    id: &str,
    env: &str,
    intent: &Value,
    remote: &Value,
) -> Result<()> {
    db.mutate_order(id, |state| {
        let order = state["orders"]
            .as_array_mut()
            .and_then(|a| a.iter_mut().find(|o| o["id"] == id))
            .context("Order missing")?;
        ensure_links(order);
        let link = &mut order["exchangeSync"][env];
        if !link["closeOrders"].is_array() {
            link["closeOrders"] = json!([]);
        }
        let mut action = intent.clone();
        action["status"] = json!(
            remote["status"]
                .as_str()
                .unwrap_or("UNKNOWN")
                .to_lowercase()
        );
        for key in ["orderId", "executedQty", "avgPrice", "lastError"] {
            if let Some(value) = remote.get(key) {
                action[key] = value.clone();
            }
        }
        action["lastSyncedAt"] = json!(iso(now_ms()));
        let actions = link["closeOrders"].as_array_mut().unwrap();
        if let Some(existing) = actions.iter_mut().find(|a| a["id"] == intent["id"]) {
            *existing = action;
        } else {
            actions.push(action);
        }
        mirror(order);
        Ok(Value::Null)
    })
    .await?;
    Ok(())
}

async fn sync_protection(db: &Db, client: &Exchange, env: &str, order: &Value) -> Result<()> {
    let symbol = order["symbol"].as_str().context("Order symbol")?;
    let id = order["id"].as_str().context("Order id")?;
    let dir = order["direction"].as_str().context("Direction")?;
    let (_, ps) = mode(client, dir).await?;
    let _guard = lock_execution(db, env, symbol, &ps).await?;
    let Some(position) = current_position(client, symbol, &ps, dir).await? else {
        return Ok(());
    };
    let price = n(&position, "markPrice", 0.);
    let info = symbol_info(client, symbol).await?;
    let existing = client
        .signed("GET", "/fapi/v1/openAlgoOrders", &json!({"symbol":symbol}))
        .await?;
    let existing = existing.as_array().context("保护单列表无效")?;
    let side = if dir == "OPEN_LONG" { "SELL" } else { "BUY" };
    for (key, kind) in [
        ("stopLoss", "STOP_MARKET"),
        ("takeProfit", "TAKE_PROFIT_MARKET"),
    ] {
        let raw = n(&order["plan"], key, 0.);
        let trigger = aligned_price(&info, raw)?;
        let crossed = if key == "stopLoss" {
            if dir == "OPEN_LONG" {
                price <= trigger
            } else {
                price >= trigger
            }
        } else if dir == "OPEN_LONG" {
            price >= trigger
        } else {
            price <= trigger
        };
        if crossed {
            drop(_guard);
            sync_strategy_exit(db, client, env, order, true).await?;
            return Ok(());
        }
        let previous: Vec<_> = existing
            .iter()
            .filter(|a| {
                a["symbol"] == symbol
                    && a["positionSide"].as_str().unwrap_or("BOTH") == ps
                    && a["type"] == kind
                    && a["clientAlgoId"].as_str().unwrap_or("").starts_with("nofx")
            })
            .collect();
        if previous.iter().any(|a| {
            (n(a, "triggerPrice", n(a, "stopPrice", 0.)) - trigger).abs() / trigger < 0.000001
                && a["side"] == side
        }) {
            continue;
        }
        let cid = client_id("protect", &[env, id, key, &formatted(trigger)]);
        let remote=client.signed("POST","/fapi/v1/algoOrder",&json!({"algoType":"CONDITIONAL","symbol":symbol,"side":side,"positionSide":ps,"type":kind,"triggerPrice":formatted(trigger),"workingType":"MARK_PRICE","closePosition":"true","priceProtect":"true","clientAlgoId":cid})).await;
        let remote = match remote {
            Ok(remote) => remote,
            Err(error) => {
                if uncertain(&error) {
                    let observed = client
                        .signed("GET", "/fapi/v1/openAlgoOrders", &json!({"symbol":symbol}))
                        .await?;
                    if let Some(row) = observed
                        .as_array()
                        .and_then(|a| a.iter().find(|a| a["clientAlgoId"] == cid))
                    {
                        row.clone()
                    } else {
                        return Err(error);
                    }
                } else {
                    return Err(error);
                }
            }
        };
        // Submit the replacement first; the prior working protection remains until acceptance.
        for old in previous {
            client
                .signed(
                    "DELETE",
                    "/fapi/v1/algoOrder",
                    &json!({"algoId":old["algoId"]}),
                )
                .await?;
        }
        db.mutate_order(id, |state|{let o=state["orders"].as_array_mut().and_then(|a|a.iter_mut().find(|o|o["id"]==id)).context("Order missing")?;ensure_links(o);if !o["exchangeSync"][env]["protection"].is_object(){o["exchangeSync"][env]["protection"]=json!({});}o["exchangeSync"][env]["protection"][key]=json!({"type":kind,"status":"submitted","algoId":remote["algoId"],"clientAlgoId":cid,"triggerPrice":trigger,"submittedAt":iso(now_ms()),"lastSyncedAt":iso(now_ms()),"lastError":""});mirror(o);Ok(Value::Null)}).await?;
    }
    Ok(())
}

async fn record_execution(db: &Db, target: &Value, intent: &Value, remote: &Value) -> Result<()> {
    db.mutate_account_light(|state|{let env=target["environment"].as_str().context("执行环境缺失")?;let key=intent["key"].as_str().context("执行键缺失")?;
        if !state["manualExecutions"].is_object(){state["manualExecutions"]=json!({});}let mut result=intent.clone();patch(&mut result,&json!({"status":remote["status"].as_str().unwrap_or("NEW").to_lowercase(),"orderId":remote["orderId"],"executedQty":n(remote,"executedQty",0.),"updatedAt":iso(now_ms())}));state["manualExecutions"][key]=result;
        for reference in arr(&target["localOrders"]){if let Some(order)=state["orders"].as_array_mut().and_then(|a|a.iter_mut().find(|o|o["id"]==reference["id"])){ensure_links(order);let link=&mut order["exchangeSync"][env];if target["kind"]=="entry_order"{patch(link,&response_link(remote));}else{if !link["closeOrders"].is_array(){link["closeOrders"]=json!([]);}let action=json!({"id":intent["id"],"manual":true,"status":remote["status"].as_str().unwrap_or("NEW").to_lowercase(),"orderId":remote["orderId"],"clientOrderId":intent["clientOrderId"],"executedQty":n(remote,"executedQty",0.),"avgPrice":n(remote,"avgPrice",0.),"lastSyncedAt":iso(now_ms()),"reason":"manual"});let actions=link["closeOrders"].as_array_mut().unwrap();if let Some(existing)=actions.iter_mut().find(|a|a["id"]==intent["id"]){*existing=action;}else{actions.push(action);}}mirror(order);}}
        Ok(Value::Null)
    }).await?;
    Ok(())
}
async fn write_execution(db: &Db, key: &str, intent: &Value) -> Result<()> {
    db.mutate_account_light(|state| {
        if !state["manualExecutions"].is_object() {
            state["manualExecutions"] = json!({});
        }
        state["manualExecutions"][key] = intent.clone();
        Ok(Value::Null)
    })
    .await?;
    Ok(())
}

/// Fresh exchange exposure is authoritative. Ambiguous writes are reconciled by the
/// persisted client ID before any further send, even after a process restart.
async fn execute_remote_close(
    db: &Db,
    store: &Store,
    target: &Value,
    quantity_limit: Option<f64>,
) -> Result<Value> {
    let env = target["environment"].as_str().context("执行环境缺失")?;
    let symbol = target["symbol"].as_str().context("币种缺失")?;
    crate::exchange::valid_symbol(symbol)?;
    let dir = target["direction"].as_str().context("持仓方向缺失")?;
    let client = Exchange::new(&store.read("config").await?, env)?;
    let snapshot = db.account(true, None).await?;
    let snapshot = &snapshot["exchangeAccounts"][env];
    if !client.credentials()
        || snapshot["enabled"] != true
        || snapshot["accountKey"] != client.account_key()
    {
        bail!("执行环境或凭证已变更，请重新同步。");
    }
    let (dual, ps) = mode(&client, dir).await?;
    let _guard = lock_execution(db, env, symbol, &ps).await?;
    let key = format!("nofx-execution:{env}:{symbol}:{ps}");
    if target["kind"] == "entry_order" {
        let params = json!({"symbol":symbol,"orderId":target["orderId"]});
        let mut remote = client.signed("GET", "/fapi/v1/order", &params).await?;
        if matches!(remote["status"].as_str(), Some("NEW" | "PARTIALLY_FILLED")) {
            remote = client.signed("DELETE", "/fapi/v1/order", &params).await?;
        }
        let intent = json!({"key":format!("{key}:cancel:{}",numeric_id(&target["orderId"])),"id":format!("cancel:{}",numeric_id(&target["orderId"]))});
        record_execution(db, target, &intent, &remote).await?;
        return Ok(
            json!({"ok":true,"complete":!matches!(remote["status"].as_str(),Some("NEW"|"PARTIALLY_FILLED")),"environment":env,"symbol":symbol,"status":remote["status"],"executedQty":n(&remote,"executedQty",0.)}),
        );
    }
    let entry_side = if dir == "OPEN_LONG" { "BUY" } else { "SELL" };
    let pending = client
        .signed("GET", "/fapi/v1/openOrders", &json!({"symbol":symbol}))
        .await?;
    for order in pending
        .as_array()
        .context("未能确认待入场订单，暂缓平仓。")?
    {
        if order["side"] == entry_side
            && order["reduceOnly"] != true
            && order["reduceOnly"] != "true"
            && order["closePosition"] != true
            && order["closePosition"] != "true"
            && order["positionSide"].as_str().unwrap_or("BOTH") == ps
        {
            client
                .signed(
                    "DELETE",
                    "/fapi/v1/order",
                    &json!({"symbol":symbol,"orderId":order["orderId"]}),
                )
                .await?;
        }
    }
    let mut final_order = json!({});
    let mut remaining_limit = quantity_limit;
    for _ in 0..32 {
        let position = current_position(&client, symbol, &ps, dir).await?;
        let amount = position
            .as_ref()
            .map(|p| n(p, "positionAmt", 0.).abs())
            .unwrap_or(0.);
        if amount <= 1e-10 || remaining_limit.is_some_and(|q| q <= 1e-10) {
            let cleanup = if amount <= 1e-10 {
                cancel_native_protection(&client, symbol, &ps).await
            } else {
                Ok(())
            };
            return Ok(
                json!({"ok":true,"complete":true,"environment":env,"symbol":symbol,"status":"closed","avgPrice":n(&final_order,"avgPrice",0.),"warning":cleanup.err().map(|e|e.to_string())}),
            );
        }
        let state = db.account(true, None).await?;
        let previous = &state["manualExecutions"][&key];
        let account_key = client.account_key();
        if previous["accountKey"] == account_key
            && matches!(
                previous["status"].as_str(),
                Some("submitting" | "unknown" | "new" | "partially_filled")
            )
        {
            let existing = client
                .signed(
                    "GET",
                    "/fapi/v1/order",
                    &json!({"symbol":symbol,"origClientOrderId":previous["clientOrderId"]}),
                )
                .await
                .context("上次平仓结果尚未确认，请稍后同步重试；未重复发送订单。")?;
            record_execution(db, target, previous, &existing).await?;
            if !matches!(
                existing["status"].as_str(),
                Some("FILLED" | "CANCELED" | "EXPIRED" | "REJECTED")
            ) {
                bail!("平仓订单尚未完成，请稍后同步。");
            }
            final_order = existing;
            continue;
        }
        if previous["accountKey"] == account_key
            && previous["status"] == "filled"
            && !previous["remainingBefore"].is_null()
            && amount
                > (n(previous, "remainingBefore", 0.) - n(previous, "executedQty", 0.)).max(0.)
                    + 1e-10
        {
            return Ok(
                json!({"ok":true,"complete":false,"environment":env,"symbol":symbol,"status":"awaiting_position"}),
            );
        }
        let info = symbol_info(&client, symbol).await?;
        let quantity =
            aligned_quantity(&info, amount.min(remaining_limit.unwrap_or(amount)), true)?;
        let action_id = uuid::Uuid::new_v4().to_string();
        let cid = client_id("close", &[env, symbol, &ps, &action_id]);
        let mut intent = json!({"key":key,"id":action_id,"accountKey":account_key,"status":"submitting","quantity":quantity,"remainingBefore":amount,"clientOrderId":cid,"createdAt":iso(now_ms())});
        write_execution(db, &key, &intent).await?;
        let mut request = json!({"symbol":symbol,"side":if entry_side=="BUY"{"SELL"}else{"BUY"},"type":"MARKET","quantity":formatted(quantity),"newClientOrderId":cid,"newOrderRespType":"RESULT"});
        if dual {
            request["positionSide"] = json!(ps);
        } else {
            request["reduceOnly"] = json!(true);
        }
        final_order = match client.signed("POST", "/fapi/v1/order", &request).await {
            Ok(remote) => remote,
            Err(error) => {
                intent["status"] = json!(if uncertain(&error) {
                    "unknown"
                } else {
                    "rejected"
                });
                intent["error"] = json!(error.to_string());
                write_execution(db, &key, &intent).await?;
                if !uncertain(&error) {
                    return Err(error);
                }
                client
                    .signed(
                        "GET",
                        "/fapi/v1/order",
                        &json!({"symbol":symbol,"origClientOrderId":cid}),
                    )
                    .await
                    .context("币安平仓响应未确认，请稍后同步重试；未重复发送订单。")?
            }
        };
        record_execution(db, target, &intent, &final_order).await?;
        if final_order["status"] != "FILLED" {
            return Ok(
                json!({"ok":true,"complete":false,"environment":env,"symbol":symbol,"status":final_order["status"],"orderId":final_order["orderId"]}),
            );
        }
        if let Some(limit) = remaining_limit.as_mut() {
            *limit = (*limit - n(&final_order, "executedQty", 0.)).max(0.);
        }
    }
    bail!("分批平仓达到单次上限，请同步查看剩余持仓。")
}

async fn close_internal(db: &Db, store: &Store, id: &str, synchronize: bool) -> Result<Value> {
    if synchronize {
        exchange_refresh(db, store).await?;
    }
    let state = db.account(true, None).await?;
    let rows = fused_orders(&state);
    let row = arr(&rows["activeOrders"])
        .into_iter()
        .find(|r| {
            r["id"] == id
                || arr(&r["localOrders"])
                    .iter()
                    .any(|reference| reference["id"] == id)
        })
        .context("订单已结束或列表已更新，请同步后重试。")?;
    let refs = arr(&row["localOrders"]);
    db.mutate_account_light(|state| {
        for order in state["orders"].as_array_mut().into_iter().flatten() {
            if refs.iter().any(|r| r["id"] == order["id"]) {
                order[if row["status"] == "open" {
                    "manualCloseRequested"
                } else {
                    "manualEntryCancelled"
                }] = json!(true);
            }
        }
        Ok(Value::Null)
    })
    .await?;
    let targets = arr(&row["executionTargets"]);
    let mut results = vec![];
    if targets.is_empty() {
        if row["status"] == "open" {
            refresh(db, store).await?;
        }
        let order = db
            .mutate_account_light(|state| {
                let order = state["orders"]
                    .as_array_mut()
                    .and_then(|a| a.iter_mut().find(|o| o["id"] == row["id"]))
                    .context("模拟订单不存在。")?;
                if order["status"] == "pending" {
                    order["status"] = json!("cancelled");
                    order["reason"] = json!("strategy_cancelled");
                } else if order["status"] == "open" {
                    let tf = order["interval"].as_str().unwrap_or("1m");
                    let duration = interval_ms(tf).context("无效订单周期")?;
                    if !order["error"].as_str().unwrap_or("").is_empty()
                        || timestamp(&order["markAt"])
                            != Some(now_ms().div_euclid(duration) * duration)
                    {
                        bail!("行情未更新，不能用过期价格模拟平仓，请先刷新。");
                    }
                    let closed = simulator::close_order(
                        order,
                        n(order, "markPrice", 0.),
                        now_ms(),
                        "manual",
                        &json!({"mode":"account"}),
                    )?;
                    patch(order, &closed);
                }
                Ok(order.clone())
            })
            .await?;
        results.push(json!({"ok":true,"complete":true,"source":"paper","symbol":row["symbol"],"status":order["status"]}));
    } else {
        for target in targets {
            results.push(match execute_remote_close(db,store,&target,None).await{Ok(result)=>result,Err(error)=>json!({"ok":false,"environment":target["environment"],"symbol":target["symbol"],"error":error.to_string()})});
        }
        if results
            .iter()
            .all(|r| r["ok"] == true && r["complete"] == true)
        {
            db.mutate_account_light(|state| {
                for order in state["orders"]
                    .as_array_mut()
                    .into_iter()
                    .flatten()
                    .filter(|o| refs.iter().any(|r| r["id"] == o["id"]))
                {
                    ensure_links(order);
                    let filled = ["live", "demo"].iter().find_map(|env| {
                        let l = &order["exchangeSync"][env];
                        if n(l, "executedQty", 0.) > 0. {
                            Some(l.clone())
                        } else {
                            None
                        }
                    });
                    if order["status"] == "pending"
                        && let Some(link) = filled
                    {
                        order["status"] = json!("open");
                        order["entry"] = json!(n(&link, "avgPrice", n(order, "entry", 0.)));
                        order["quantity"] = link["executedQty"].clone();
                        if order["entryAt"].is_null() {
                            order["entryAt"] = json!(iso(now_ms()));
                        }
                    } else {
                        order["status"] = json!(if row["status"] == "pending" {
                            "cancelled"
                        } else {
                            "closed"
                        });
                        order["reason"] = json!(if row["status"] == "pending" {
                            "strategy_cancelled"
                        } else {
                            "manual"
                        });
                        order["exitAt"] = json!(iso(now_ms()));
                        order["exit"] = results
                            .iter()
                            .find(|r| n(r, "avgPrice", 0.) > 0.)
                            .map(|r| r["avgPrice"].clone())
                            .unwrap_or_else(|| row["markPrice"].clone());
                    }
                }
                Ok(Value::Null)
            })
            .await?;
        }
    }
    if synchronize {
        exchange_refresh(db, store).await?;
    }
    Ok(
        json!({"ok":results.iter().all(|r|r["ok"]!=false),"results":results,"account":status(db).await?}),
    )
}
pub async fn close(db: &Db, store: &Store, id: &str) -> Result<Value> {
    close_internal(db, store, id, true).await
}
pub async fn close_all(db: &Db, store: &Store) -> Result<Value> {
    let _guard = lock_execution(db, "system", "close-all", "ALL").await?;
    db.mutate_account_light(|state| {
        state["entriesPaused"] = json!(true);
        Ok(Value::Null)
    })
    .await?;
    exchange_refresh(db, store).await?;
    let mut results = vec![];
    for status in ["pending", "open"] {
        let state = db.account(true, None).await?;
        for row in arr(&fused_orders(&state)["activeOrders"])
            .into_iter()
            .filter(|r| r["status"] == status)
        {
            let id = row["id"].as_str().context("活动订单无 ID")?;
            let mut result = close_internal(db, store, id, false)
                .await
                .unwrap_or_else(|e| json!({"ok":false,"error":e.to_string()}));
            result["id"] = row["id"].clone();
            result["symbol"] = row["symbol"].clone();
            result.as_object_mut().unwrap().remove("account");
            results.push(result);
        }
        exchange_refresh(db, store).await?;
    }
    Ok(
        json!({"ok":results.iter().all(|r|r["ok"]==true),"entriesPaused":true,"results":results,"account":status(db).await?}),
    )
}
async fn direct_client(store: &Store) -> Result<(Exchange, &'static str)> {
    let config = store.read("config").await?;
    let env = if crate::exchange::is_demo(&config["binance"]) {
        "demo"
    } else {
        "live"
    };
    Ok((Exchange::new(&config, env)?, env))
}
pub async fn place_exchange_order(db: &Db, store: &Store, input: &Value) -> Result<Value> {
    let symbol = input["symbol"]
        .as_str()
        .context("须指定币种")?
        .to_uppercase();
    crate::exchange::valid_symbol(&symbol)?;
    let side = input["side"].as_str().unwrap_or("").to_uppercase();
    if !matches!(side.as_str(), "BUY" | "SELL") {
        bail!("side 只能是 BUY / SELL");
    }
    let kind = input["type"].as_str().unwrap_or("LIMIT").to_uppercase();
    if !matches!(kind.as_str(), "LIMIT" | "MARKET") {
        bail!("type 只能是 LIMIT / MARKET");
    }
    let quantity = n(input, "quantity", f64::NAN);
    if !quantity.is_finite() || quantity <= 0. {
        bail!("quantity 必须为正数");
    }
    let (client, env) = direct_client(store).await?;
    let dir = if side == "BUY" {
        "OPEN_LONG"
    } else {
        "OPEN_SHORT"
    };
    let (dual, inferred) = mode(&client, dir).await?;
    let requested = input["positionSide"].as_str().unwrap_or("").to_uppercase();
    if !matches!(requested.as_str(), "" | "LONG" | "SHORT" | "BOTH") {
        bail!("positionSide 只能是 LONG / SHORT / BOTH");
    }
    let ps = if requested.is_empty() || requested == "BOTH" {
        inferred
    } else {
        requested
    };
    if !dual && ps != "BOTH" {
        bail!("单向账户只允许 BOTH 持仓方向。");
    }
    let reduce = input["reduceOnly"] == true || input["reduceOnly"] == "true";
    let closing = reduce || (ps == "LONG" && side == "SELL") || (ps == "SHORT" && side == "BUY");
    let cid = input["clientOrderId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| client_id("entry", &[&uuid::Uuid::new_v4().to_string()]));
    if cid.len() > 36
        || !cid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/'))
    {
        bail!("clientOrderId 格式无效");
    }
    if !closing {
        exchange_refresh(db, store).await?;
    }
    let _guard = lock_execution(db, env, &symbol, &ps).await?;
    let price = if kind == "LIMIT" {
        n(input, "price", f64::NAN)
    } else {
        n(
            &client
                .public_request("/fapi/v1/ticker/price", &json!({"symbol":symbol}))
                .await?,
            "price",
            f64::NAN,
        )
    };
    if !price.is_finite() || price <= 0. {
        bail!("price 必须为正数");
    }
    let mut args = json!({"symbol":symbol,"side":side,"quantity":formatted(quantity),"type":kind,"newClientOrderId":cid,"newOrderRespType":"RESULT"});
    if dual {
        args["positionSide"] = json!(ps);
    } else if reduce {
        args["reduceOnly"] = json!(true);
    }
    if kind == "LIMIT" {
        args["price"] = json!(formatted(price));
        args["timeInForce"] = json!("GTC");
    }
    let reservation = if !closing {
        let positions = client
            .signed("GET", "/fapi/v2/positionRisk", &json!({"symbol":symbol}))
            .await?;
        let leverage = positions
            .as_array()
            .and_then(|a| {
                a.iter()
                    .find(|p| p["positionSide"].as_str().unwrap_or("BOTH") == ps)
            })
            .map(|p| n(p, "leverage", 0.))
            .unwrap_or(0.);
        if leverage <= 0. {
            bail!("未能取得实际杠杆");
        }
        let notional = quantity * price * if kind == "MARKET" { 1.01 } else { 1. };
        let margin = notional / leverage;
        let fee = notional * 12. / 10000.;
        let key = format!("direct:{env}:{cid}");
        let created=db.mutate_account_light(|state|{if !state["capitalReservations"].is_object(){state["capitalReservations"]=json!({});}
if state["capitalReservations"][&key].is_object(){bail!("该 clientOrderId 已有执行记录，请查询后再操作。");}let funds=account_summary(state,now_ms());if funds["canOpen"]!=true||n(&funds,"available",0.)+1e-8<margin+fee{bail!("统一资金池同步未完成、已暂停或可用资金不足。");}state["capitalReservations"][&key]=json!({"environment":env,"symbol":symbol,"accountKey":client.account_key(),"clientOrderId":cid,"direction":dir,"margin":margin,"feeReserve":fee,"status":"submitting","createdAt":iso(now_ms())});Ok(json!(key))}).await?;
        Some(created.as_str().unwrap().to_owned())
    } else {
        None
    };
    let result = client.signed("POST", "/fapi/v1/order", &args).await;
    if let Some(key) = reservation {
        let fields = match &result {
            Ok(remote) => json!({"status":"submitted","orderId":remote["orderId"]}),
            Err(error) => {
                json!({"status":if uncertain(error){"unknown"}else{"rejected"},"error":error.to_string()})
            }
        };
        db.mutate_account_light(|state| {
            patch(&mut state["capitalReservations"][&key], &fields);
            Ok(Value::Null)
        })
        .await?;
    }
    let order = result?;
    drop(_guard);
    let _ = exchange_refresh(db, store).await;
    Ok(json!({"ok":true,"order":order}))
}
pub async fn cancel_exchange_order(db: &Db, store: &Store, input: &Value) -> Result<Value> {
    let symbol = input["symbol"]
        .as_str()
        .context("须指定币种")?
        .to_uppercase();
    crate::exchange::valid_symbol(&symbol)?;
    let order_id = n(input, "orderId", f64::NAN);
    if !order_id.is_finite() || order_id <= 0. || order_id.fract() != 0. {
        bail!("orderId 必须为正整数");
    }
    let (client, env) = direct_client(store).await?;
    let order = client
        .signed(
            "GET",
            "/fapi/v1/order",
            &json!({"symbol":symbol,"orderId":order_id as i64}),
        )
        .await?;
    let ps = order["positionSide"].as_str().unwrap_or("BOTH");
    let _guard = lock_execution(db, env, &symbol, ps).await?;
    let result = client
        .signed(
            "DELETE",
            "/fapi/v1/order",
            &json!({"symbol":symbol,"orderId":order_id as i64}),
        )
        .await?;
    drop(_guard);
    let _ = exchange_refresh(db, store).await;
    Ok(json!({"ok":true,"result":result}))
}
