use super::*;
use anyhow::{Result, bail};
use chrono::Timelike;
use std::collections::HashMap;

pub fn adaptive_config(overrides: &Value) -> Value {
    let mut defaults: Value =
        serde_json::from_str(include_str!("../adaptive_defaults.json")).unwrap();
    for key in [
        "symbolFilter",
        "hourFilter",
        "holdingPeriodOptimization",
        "symbolLevelParams",
        "volatilityAdaptive",
        "logging",
    ] {
        if let Some(patch) = overrides[key].as_object() {
            for (k, v) in patch {
                defaults[key][k] = v.clone();
            }
        }
    }
    defaults
}
pub fn validate_adaptive_config(input: &Value) -> Result<()> {
    for (category, key) in [
        ("symbolFilter", "minWinRate"),
        ("hourFilter", "minWinRate"),
        ("holdingPeriodOptimization", "autoApplyThreshold"),
    ] {
        if !input[category][key].is_null() {
            let value = number(&input[category][key], f64::NAN);
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                bail!("{category}.{key} 必须在 0-1 之间");
            }
        }
    }
    Ok(())
}
fn enabled(options: &Value) -> bool {
    options["enabled"] != false
}
pub fn filter_symbols(symbols: &[String], rows: &[Value], options: &Value) -> Value {
    if !enabled(options) || rows.is_empty() {
        return json!({"filtered":symbols,"stats":{},"filteredOut":[]});
    }
    let closed: Vec<Value> = rows
        .iter()
        .filter(|o| o["status"] == "closed")
        .cloned()
        .collect();
    let grouped = group(&closed, |o| text(o, "symbol", "undefined").into());
    let sample = number(&options["minSampleSize"], 5.0);
    let exclude = number(&options["minSampleSizeToExclude"], 10.0);
    let exclude = if exclude > 0.0 {
        exclude.max(sample)
    } else {
        sample.max(10.0)
    };
    let mut stats = json!({});
    let mut filtered = Vec::new();
    let mut removed = Vec::new();
    for (symbol, orders) in &grouped {
        if orders.len() as f64 >= sample {
            let total_roi = orders
                .iter()
                .map(|o| {
                    o.get("roi")
                        .map(|v| {
                            if v.is_null() {
                                0.0
                            } else {
                                number(v, f64::NAN)
                            }
                        })
                        .filter(|v| v.is_finite())
                        .unwrap_or_else(|| {
                            if num(o, "margin") > 0.0 {
                                num(o, "net") / num(o, "margin")
                            } else {
                                num(o, "net")
                            }
                        })
                })
                .sum::<f64>();
            let mut v = base(orders);
            v["symbol"] = json!(symbol);
            v["totalRoi"] = json!(total_roi);
            v["avgRoi"] = json!(total_roi / orders.len() as f64);
            v["orders"] = json!(orders);
            stats[symbol] = v;
        }
    }
    for symbol in symbols {
        let v = &stats[symbol];
        if v.is_null() || num(v, "avgRoi") > 0.0 || num(v, "count") < exclude {
            filtered.push(symbol.clone());
        } else {
            removed.push(json!({"symbol":symbol,"winRate":v["winRate"],"avgNet":v["avgNet"],"avgRoi":v["avgRoi"],"count":v["count"],"reason":format!("归一化期望收益 {:.3}%/单为负（绝对均值{:.2}U，胜率{:.1}%，样本{}），停止交易",num(v,"avgRoi")*100.0,num(v,"avgNet"),num(v,"winRate")*100.0,num(v,"count"))}));
        }
    }
    json!({"filtered":filtered,"filteredOut":removed,"stats":stats,"summary":{"total":symbols.len(),"filtered":filtered.len(),"removed":removed.len(),"minSampleSize":sample,"minSampleSizeToExclude":exclude,"reason":if removed.is_empty(){"无需过滤".into()}else{format!("过滤了{}个负期望值币种",removed.len())}}})
}
pub fn hour_analysis(rows: &[Value], options: &Value) -> Value {
    if !enabled(options) || rows.is_empty() {
        return json!({"highProbHours":[],"hourStats":[],"enabled":false});
    }
    let min = number(&options["minSampleSize"], 5.0);
    let closed: Vec<Value> = rows
        .iter()
        .filter(|o| o["status"] == "closed")
        .cloned()
        .collect();
    let scored: Vec<Value> = closed
        .iter()
        .filter(|o| !o["net"].is_null())
        .cloned()
        .collect();
    let threshold = (1.2 * win_rate(&scored)).max(0.3);
    let mut hours = Vec::new();
    let mut high = Vec::new();
    let mut total = 0;
    for hour in 0..24 {
        let members: Vec<Value> = closed
            .iter()
            .filter(|o| {
                timestamp(
                    o.get("entryAt")
                        .filter(|v| !v.is_null() && *v != "")
                        .unwrap_or(&o["createdAt"]),
                )
                .and_then(chrono::DateTime::from_timestamp_millis)
                .is_some_and(|t| t.hour() == hour)
            })
            .cloned()
            .collect();
        if members.is_empty() {
            continue;
        }
        let mut v = base(&members);
        v["hour"] = json!(hour);
        if members.len() as f64 >= min {
            total += 1;
            if win_rate(&members) >= threshold {
                high.push(hour);
            }
        }
        hours.push(v);
    }
    let recommendation = if high.is_empty() {
        "样本不足或无明显高胜率时段".into()
    } else {
        format!(
            "建议在{}时(UTC)交易",
            high.iter()
                .map(|h| h.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    json!({"highProbHours":high,"hourStats":hours,"enabled":true,"summary":{"totalHours":total,"highProbHours":high.len(),"recommendation":recommendation}})
}
pub fn current_hour_check(hour: u32, rows: &[Value], options: &Value) -> Value {
    if !enabled(options) {
        return json!({"shouldTrade":true,"reason":"时段过滤未启用","currentHourStats":null});
    }
    let analysis = hour_analysis(rows, options);
    let current = analysis["hourStats"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v["hour"] == hour));
    let closed: Vec<Value> = rows
        .iter()
        .filter(|o| o["status"] == "closed" && !o["net"].is_null())
        .cloned()
        .collect();
    let overall = win_rate(&closed);
    let min = number(&options["minSampleSize"], 5.0);
    if let Some(current) = current
        && num(current, "count") >= min
        && num(current, "winRate") < 0.8 * overall.max(0.01)
    {
        return json!({"shouldTrade":false,"reason":format!("当前时段{hour}:00 UTC胜率{:.1}%低于整体胜率{:.1}%的0.8倍，建议等待",num(current,"winRate")*100.0,overall*100.0),"currentHourStats":current,"highProbHours":analysis["highProbHours"]});
    }
    let high = analysis["highProbHours"].as_array().unwrap();
    if analysis["enabled"] != true || high.is_empty() {
        return json!({"shouldTrade":true,"reason":"时段过滤数据不足，允许交易","currentHourStats":null});
    }
    let allowed = high.iter().any(|v| v == hour);
    json!({"shouldTrade":allowed,"reason":if allowed{format!("当前时段{hour}:00 UTC为高胜率时段（胜率{:.1}%）",current.map(|v|num(v,"winRate")*100.0).unwrap_or(0.0))}else{format!("当前时段{hour}:00 UTC非高胜率时段，建议等待")},"currentHourStats":current,"highProbHours":high})
}
pub fn symbol_parameters(symbol: &str, rows: &[Value], defaults: &Value) -> Value {
    let min = number(&defaults["minSampleSize"], 10.0);
    let default_sl = number(&defaults["defaultStopLossATR"], 2.5);
    let default_tp = number(&defaults["defaultTakeProfitATR"], 4.0);
    let default_hold = number(&defaults["defaultMaxHoldBars"], 30.0);
    let members: Vec<Value> = rows
        .iter()
        .filter(|o| o["symbol"] == symbol && o["status"] == "closed" && !o["heldBars"].is_null())
        .cloned()
        .collect();
    if (members.len() as f64) < min {
        return json!({"stopLossATR":default_sl,"takeProfitATR":default_tp,"maxHoldBars":default_hold,"confidence":0,"reason":format!("样本不足（{}/{min}），使用默认参数",members.len())});
    }
    let old_stop =
        |s: &str| s.contains("stop_loss") || s.contains("stop loss") || s.contains("止损");
    let old_tp =
        |s: &str| s.contains("take_profit") || s.contains("take profit") || s.contains("止盈");
    let stops = members
        .iter()
        .filter(|o| old_stop(&text(o, "reason", "").to_lowercase()))
        .count() as f64
        / members.len() as f64;
    let tps = members
        .iter()
        .filter(|o| old_tp(&text(o, "reason", "").to_lowercase()))
        .count() as f64
        / members.len() as f64;
    let hold = average(&members, "heldBars");
    let win = win_rate(&members);
    let mut sl = default_sl;
    let mut tp = default_tp;
    let mut max_hold = default_hold;
    let mut changes = Vec::new();
    if stops > 0.4 {
        sl = (default_sl * 1.3).min(3.5);
        changes.push(format!(
            "止损放宽至{sl:.1}x ATR（触发率{:.1}%过高）",
            stops * 100.0
        ));
    }
    if tps < 0.3 {
        tp = (default_tp * 0.8).max(2.5);
        changes.push(format!(
            "止盈收紧至{tp:.1}x ATR（触及率{:.1}%过低）",
            tps * 100.0
        ));
    }
    if hold > default_hold * 0.8 && win < 0.5 {
        max_hold = (hold * 0.9).floor();
        changes.push(format!(
            "最大持仓缩短至{max_hold}根（平均{hold:.1}根接近上限且胜率{:.1}%偏低）",
            win * 100.0
        ));
    }
    json!({"stopLossATR":sl,"takeProfitATR":tp,"maxHoldBars":max_hold,"confidence":(members.len() as f64/min).min(1.0),"reason":if changes.is_empty(){format!("基于{}笔历史订单，参数保持默认",members.len())}else{changes.join("；")},"stats":{"sampleSize":members.len(),"winRate":win,"stopLossTouchRate":stops,"takeProfitTouchRate":tps,"avgHoldBars":hold}})
}
pub fn should_open_position(
    symbol: &str,
    hour: Option<u32>,
    rows: &[Value],
    options: &Value,
) -> Value {
    let mut result = json!({"shouldOpen":true,"reasons":[],"filters":{}});
    let mut reasons = Vec::new();
    if options["symbolFilter"]["enabled"] == true {
        let v = filter_symbols(&[symbol.to_owned()], rows, &options["symbolFilter"]);
        if !v["filtered"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == symbol)
        {
            result["shouldOpen"] = json!(false);
            reasons.push(format!(
                "币种{symbol}被过滤：{}",
                text(&v["filteredOut"][0], "reason", "表现不佳")
            ));
        }
        result["filters"]["symbol"] = v;
    }
    if options["hourFilter"]["enabled"] == true
        && let Some(hour) = hour
    {
        let v = current_hour_check(hour, rows, &options["hourFilter"]);
        if v["shouldTrade"] != true {
            result["shouldOpen"] = json!(false);
            reasons.push(text(&v, "reason", "").to_owned());
        }
        result["filters"]["hour"] = v;
    }
    result["reasons"] = json!(reasons);
    result
}
pub fn adaptive(path: &str, state: &Value, query: &HashMap<String, String>) -> Result<Value> {
    let rows = closed_orders(state);
    let config = adaptive_config(&state["adaptiveConfig"]);
    let path = path.strip_prefix("/api/adaptive/").unwrap_or(path);
    Ok(match path {
        "config" => config,
        "symbol-filter" => {
            let symbols: Vec<String> = query
                .get("symbols")
                .map(|s| {
                    s.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_else(|| {
                    let mut v: Vec<String> = rows
                        .iter()
                        .filter_map(|o| o["symbol"].as_str().map(str::to_owned))
                        .collect();
                    v.sort();
                    v.dedup();
                    v
                });
            let mut opt = config["symbolFilter"].clone();
            opt["enabled"] = json!(true);
            filter_symbols(&symbols, &rows, &opt)
        }
        "hour-analysis" => {
            let mut opt = config["hourFilter"].clone();
            opt["enabled"] = json!(true);
            hour_analysis(&rows, &opt)
        }
        "current-hour-check" => {
            current_hour_check(chrono::Utc::now().hour(), &rows, &config["hourFilter"])
        }
        "holding-optimization" => {
            let a = holding_analysis(&rows);
            if a["sufficient"] != true {
                a
            } else {
                json!({"sufficient":true,"analysis":a,"optimizedParams":optimized_parameters(&a,30.0),"timestamp":iso(now_ms())})
            }
        }
        "report" => {
            let holding = holding_analysis(&rows);
            let hour = hour_analysis(&rows, &config["hourFilter"]);
            let mut top = group_stats(
                &rows,
                |o| text(o, "symbol", "unknown").into(),
                "symbol",
                false,
            );
            top.retain(|v| num(v, "count") >= 5.0);
            top.sort_by(|a, b| num(b, "winRate").total_cmp(&num(a, "winRate")));
            let mut bottom = top.clone();
            bottom.sort_by(|a, b| num(a, "winRate").total_cmp(&num(b, "winRate")));
            top.truncate(10);
            bottom.truncate(10);
            let mut top_hours = hour["hourStats"].as_array().cloned().unwrap_or_default();
            top_hours.retain(|v| num(v, "count") >= 5.0);
            top_hours.sort_by(|a, b| num(b, "winRate").total_cmp(&num(a, "winRate")));
            top_hours.truncate(5);
            json!({"summary":{"totalOrders":rows.len(),"totalWins":rows.iter().filter(|o|num(o,"net")>0.0).count(),"overallWinRate":win_rate(&rows),"totalNet":rows.iter().map(|o|num(o,"net")).sum::<f64>(),"avgNet":average(&rows,"net"),"timestamp":iso(now_ms())},"holdingOptimization":if holding["sufficient"]==true{optimized_parameters(&holding,30.0)}else{Value::Null},"hourAnalysis":{"highProbHours":hour["highProbHours"],"summary":hour["summary"],"topHours":top_hours},"symbolPerformance":{"topSymbols":top,"worstSymbols":bottom},"config":config})
        }
        other if other.starts_with("symbol-params/") => symbol_parameters(
            &other[14..],
            &rows,
            &json!({"minSampleSize":config["symbolLevelParams"]["minSampleSize"]}),
        ),
        _ => bail!("未知自适应接口。"),
    })
}
pub fn adaptive_update(path: &str, state: &mut Value, input: &Value) -> Result<Value> {
    match path.strip_prefix("/api/adaptive/").unwrap_or(path) {
        "config" => {
            validate_adaptive_config(input)?;
            state["adaptiveConfig"] = adaptive_config(input);
            Ok(json!({"success":true,"config":input}))
        }
        "apply-optimization" => {
            let mut updates = json!({});
            for (key, min, max) in [
                ("maxHoldBars", 10.0, 200.0),
                ("stopLossATR", 1.0, 5.0),
                ("takeProfitATR", 1.5, 10.0),
            ] {
                if let Some(v) = input[key].as_f64()
                    && (min..=max).contains(&v)
                {
                    updates[key] = json!(v);
                }
            }
            if updates.as_object().unwrap().is_empty() {
                bail!("无有效的优化参数");
            }
            if !state["adaptiveOverrides"].is_object() {
                state["adaptiveOverrides"] = json!({});
            }
            for (key, v) in updates.as_object().unwrap() {
                state["adaptiveOverrides"][key] = v.clone();
            }
            Ok(
                json!({"success":true,"applied":updates,"message":"优化参数已保存，将在下次自动扫描时生效","timestamp":iso(now_ms())}),
            )
        }
        "reset-overrides" => {
            state.as_object_mut().unwrap().remove("adaptiveOverrides");
            Ok(json!({"success":true,"message":"已重置为默认参数","timestamp":iso(now_ms())}))
        }
        _ => bail!("未知自适应接口。"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalized_expectation_protects_profitable_low_win_rate_symbols() {
        let rows:Vec<Value>=(0..10).map(|i|json!({"status":"closed","symbol":"TESTUSDT","net":if i==0{100.0}else{-1.0},"margin":if i==0{10000.0}else{1.0}})).collect();
        let out = filter_symbols(&["TESTUSDT".into()], &rows, &json!({}));
        assert!(out["filtered"].as_array().unwrap().is_empty());
        assert_eq!(out["filteredOut"][0]["count"], 10);
        let fewer = filter_symbols(&["TESTUSDT".into()], &rows[..9], &json!({}));
        assert_eq!(fewer["filtered"][0], "TESTUSDT");
    }
    #[test]
    fn hours_attribute_actual_fill_and_config_off_allows() {
        let rows = vec![
            json!({"status":"closed","entryAt":"2026-10-01T05:00:00Z","createdAt":"2026-10-01T01:00:00Z","net":1}),
        ];
        let a = hour_analysis(&rows, &json!({"minSampleSize":1}));
        assert_eq!(a["hourStats"][0]["hour"], 5);
        assert_eq!(
            current_hour_check(1, &rows, &json!({"enabled":false}))["shouldTrade"],
            true
        );
    }
}
