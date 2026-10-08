use super::*;

fn atr(rows: &[Value]) -> f64 {
    if rows.len() < 14 {
        return 0.0;
    }
    let trs: Vec<f64> = rows
        .windows(2)
        .map(|v| {
            (num(&v[1], "high") - num(&v[1], "low"))
                .max((num(&v[1], "high") - num(&v[0], "close")).abs())
                .max((num(&v[1], "low") - num(&v[0], "close")).abs())
        })
        .collect();
    trs[trs.len().saturating_sub(14)..].iter().sum::<f64>() / 14.0
}
fn volatility(rows: &[Value]) -> f64 {
    if rows.len() < 2 {
        return 0.0;
    }
    let returns: Vec<f64> = rows
        .windows(2)
        .map(|v| (num(&v[1], "close") - num(&v[0], "close")) / num(&v[0], "close"))
        .collect();
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    (returns.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / returns.len() as f64).sqrt()
}
pub fn replay(order: &Value, rows: &[Value]) -> Value {
    let entry = num(order, "entry");
    if entry == 0.0 {
        return json!({"error":"订单未入场，无法复盘"});
    }
    let Some(entry_time) = timestamp(&order["entryAt"]) else {
        return json!({"error":"订单入场或出场时间无效，无法复盘"});
    };
    let exit_time = if order["exitAt"].is_null() {
        now_ms()
    } else {
        timestamp(&order["exitAt"]).unwrap_or(-1)
    };
    if exit_time < entry_time {
        return json!({"error":"订单入场或出场时间无效，无法复盘"});
    }
    let duration = crate::interval_ms(text(order, "interval", "1m")).unwrap_or(60_000);
    let entry_open = entry_time.div_euclid(duration) * duration;
    let exit_open = exit_time.div_euclid(duration) * duration;
    let before = entry_open - 20 * duration;
    let after = (exit_open + 5 * duration).min(now_ms());
    let mut unique = BTreeMap::new();
    for row in rows {
        let t = num(row, "openTime") as i64;
        if t >= before && t <= after {
            unique.insert(t, row.clone());
        }
    }
    let mut candles: Vec<Value> = unique.into_values().collect();
    let symbol = text(order, "symbol", "");
    let provider = text(order, "marketProvider", "binance");
    let interval = text(order, "interval", "1m");
    if candles.is_empty() {
        return json!({"error":format!("无K线数据: {provider} {symbol} {interval}，{} 至 {}",iso(before),iso(after))});
    }
    let entry_index = candles
        .iter()
        .position(|v| num(v, "openTime") as i64 == entry_open);
    let exit_index = if order["exitAt"].is_null() {
        Some(candles.len() - 1)
    } else {
        candles
            .iter()
            .position(|v| num(v, "openTime") as i64 == exit_open)
    };
    let (Some(e), Some(x)) = (entry_index, exit_index) else {
        return json!({"error":format!("K线数据不完整: {provider} {symbol} 缺少入场前、入场或出场K线")});
    };
    if e < 1 || x < e {
        return json!({"error":format!("K线数据不完整: {provider} {symbol} 缺少入场前、入场或出场K线")});
    }
    if candles[e..=x]
        .windows(2)
        .any(|v| num(&v[1], "openTime") as i64 != num(&v[0], "openTime") as i64 + duration)
    {
        return json!({"error":format!("K线数据不完整: {provider} {symbol} 持仓期间存在缺口")});
    }
    let long = order["direction"] == "OPEN_LONG";
    let holding = &candles[e..=x];
    let max = holding
        .iter()
        .map(|v| num(v, "close"))
        .fold(f64::NEG_INFINITY, f64::max);
    let min = holding
        .iter()
        .map(|v| num(v, "close"))
        .fold(f64::INFINITY, f64::min);
    let favorable = if long {
        (max - entry) / entry
    } else {
        (entry - min) / entry
    };
    let adverse = if long {
        (entry - min) / entry
    } else {
        (max - entry) / entry
    };
    let final_move = if long {
        (num(holding.last().unwrap(), "close") - entry) / entry
    } else {
        (entry - num(holding.last().unwrap(), "close")) / entry
    };
    let correct = favorable > adverse.abs() * 1.5;
    let before_rows = &candles[e.saturating_sub(20)..e];
    let trend = if before_rows.len() < 5 {
        "insufficient_data"
    } else {
        let count = before_rows
            .windows(2)
            .filter(|v| {
                if long {
                    num(&v[1], "close") > num(&v[0], "close")
                } else {
                    num(&v[1], "close") < num(&v[0], "close")
                }
            })
            .count();
        let ratio = count as f64 / before_rows.len() as f64;
        if ratio > 0.7 {
            "strong"
        } else if ratio > 0.5 {
            "moderate"
        } else {
            "weak"
        }
    };
    let direction = json!({"correct":correct,"favorableMove":favorable*100.0,"adverseMove":adverse*100.0,"finalMove":final_move*100.0,"maxPrice":max,"minPrice":min,"trendStrength":trend,"summary":if correct{format!("方向正确，有利价差{:.2}%超过不利价差",favorable*100.0)}else{format!("方向可能有误，不利价差{:.2}%过大",adverse*100.0)}});
    let stop = num(&order["plan"], "stopLoss");
    let target = num(&order["plan"], "takeProfit");
    let sl_dist = (entry - stop).abs() / entry;
    let tp_dist = (target - entry).abs() / entry;
    let mut sl_touched = false;
    let mut tp_touched = false;
    let mut sl_near = f64::INFINITY;
    let mut tp_near = f64::INFINITY;
    for row in holding {
        if if long {
            num(row, "low") <= stop
        } else {
            num(row, "high") >= stop
        } {
            sl_touched = true;
            break;
        }
        sl_near = sl_near.min(if long {
            (num(row, "low") - stop) / entry
        } else {
            (stop - num(row, "high")) / entry
        });
    }
    for row in holding {
        if if long {
            num(row, "high") >= target
        } else {
            num(row, "low") <= target
        } {
            tp_touched = true;
            break;
        }
        tp_near = tp_near.min(if long {
            (target - num(row, "high")) / entry
        } else {
            (num(row, "low") - target) / entry
        });
    }
    let a = atr(&candles[e.saturating_sub(14)..=e]);
    let a_ratio = (entry - stop).abs() / a;
    let sl_assessment = if sl_dist < 0.005 {
        "止损过紧（<0.5%），容易被正常波动触发"
    } else if sl_dist > 0.05 {
        "止损过宽（>5%），风险暴露过大"
    } else if a_ratio < 1.0 {
        "止损距离小于1倍ATR，可能过紧"
    } else if a_ratio > 3.0 {
        "止损距离大于3倍ATR，可能过宽"
    } else {
        "止损点位设置合理"
    };
    let sl_optimal = sl_assessment == "止损点位设置合理";
    let stop_loss = json!({"stopLoss":stop,"distance":sl_dist*100.0,"touched":sl_touched,"minDistanceToSL":if sl_near.is_finite(){Some(sl_near*100.0)}else{None},"atr":a,"atrRatio":a_ratio,"optimal":sl_optimal,"assessment":sl_assessment});
    let best = if long {
        holding
            .iter()
            .map(|v| num(v, "high"))
            .fold(f64::NEG_INFINITY, f64::max)
    } else {
        holding
            .iter()
            .map(|v| num(v, "low"))
            .fold(f64::INFINITY, f64::min)
    };
    let max_favorable = (best - entry).abs() / entry;
    let tp_assessment = if tp_touched && max_favorable > tp_dist * 1.5 {
        "止盈过早，后续还有较大空间"
    } else if !tp_touched && tp_near < 0.01 {
        "止盈略显激进，仅差临门一脚"
    } else if !tp_touched && tp_near > 0.05 {
        "止盈过于激进，价格未能接近目标"
    } else {
        "止盈点位设置合理"
    };
    let tp_optimal = tp_assessment == "止盈点位设置合理";
    let take_profit = json!({"takeProfit":target,"distance":tp_dist*100.0,"touched":tp_touched,"minDistanceToTP":if tp_near.is_finite(){Some(tp_near*100.0)}else{None},"maxFavorable":max_favorable*100.0,"optimal":tp_optimal,"assessment":tp_assessment});
    let row = &candles[e];
    let range = num(row, "high") - num(row, "low");
    let entry_pos = if range > 0.0 {
        (num(row, "open") - num(row, "low")) / range
    } else {
        0.5
    };
    let mut entry_optimal = true;
    let timing = if long {
        if entry_pos < 0.3 {
            "入场价格接近K线低点，时机较好"
        } else if entry_pos > 0.7 {
            entry_optimal = false;
            "入场价格接近K线高点，追高风险"
        } else {
            "入场价格处于K线中部，中性"
        }
    } else if entry_pos > 0.7 {
        "入场价格接近K线高点，时机较好"
    } else if entry_pos < 0.3 {
        entry_optimal = false;
        "入场价格接近K线低点，追低风险"
    } else {
        "入场价格处于K线中部，中性"
    };
    let entry_analysis = json!({"entryPrice":num(row,"open"),"entryPosition":entry_pos*100.0,"inPlanRange":num(row,"open")>=num(&order["plan"],"entryMin")&&num(row,"open")<=num(&order["plan"],"entryMax"),"recentVolatility":volatility(&candles[e.saturating_sub(10)..e]),"timing":timing,"optimal":entry_optimal,"planRange":{"min":order["plan"]["entryMin"],"max":order["plan"]["entryMax"]}});
    let mut issues = Vec::new();
    let mut strengths = Vec::new();
    let mut recommendations = Vec::new();
    if !correct {
        issues.push(json!({"type":"direction","severity":"high","description":"策略方向判断可能有误","detail":format!("不利价差({:.2}%)超过有利价差({:.2}%)",adverse*100.0,favorable*100.0)}));
        recommendations.push("建议审查趋势判断逻辑，考虑增加趋势确认条件或过滤器");
    } else {
        strengths.push("方向判断正确");
    }
    if !sl_optimal {
        issues.push(json!({"type":"stopLoss","severity":if sl_touched{"high"}else{"medium"},"description":sl_assessment,"detail":format!("止损距离{:.2}%，ATR比率{a_ratio:.2}",sl_dist*100.0)}));
        if sl_dist < 0.005 {
            recommendations.push("建议放宽止损距离至1.5-2倍ATR，避免被正常波动扫损");
        } else if sl_dist > 0.05 {
            recommendations.push("建议收紧止损距离至2-3倍ATR，控制单笔风险");
        }
    } else {
        strengths.push("止损设置合理");
    }
    if !tp_optimal {
        issues.push(json!({"type":"takeProfit","severity":"medium","description":tp_assessment,"detail":format!("止盈距离{:.2}%，最大有利价差{:.2}%",tp_dist*100.0,max_favorable*100.0)}));
        if tp_touched && max_favorable > tp_dist * 1.5 {
            recommendations.push("考虑使用移动止盈或分批止盈，捕捉更多利润");
        } else if !tp_touched && tp_near > 0.05 {
            recommendations.push("止盈目标过于激进，建议降低盈亏比预期");
        }
    } else {
        strengths.push("止盈设置合理");
    }
    if !entry_optimal {
        issues.push(json!({"type":"entry","severity":"low","description":timing,"detail":format!("入场价格位于K线{:.0}%位置",entry_pos*100.0)}));
        recommendations.push("优化入场时机，在回调/反弹时进场可降低成本");
    } else {
        strengths.push("入场时机良好");
    }
    let score = (if correct {
        40
    } else if favorable > 0.0 {
        20
    } else {
        0
    }) + (if sl_optimal {
        20
    } else if !sl_touched {
        10
    } else {
        0
    }) + (if tp_optimal {
        20
    } else if tp_touched {
        15
    } else {
        0
    }) + (if entry_optimal { 20 } else { 10 });
    let primary = if num(order, "net") < 0.0 {
        if !correct {
            "direction"
        } else if sl_touched && sl_dist < 0.01 {
            "stopLoss_too_tight"
        } else if !tp_touched && favorable > 0.02 {
            "takeProfit_too_far"
        } else {
            "timing"
        }
    } else {
        "unknown"
    };
    let result = if num(order, "net") > 0.0 {
        "盈利"
    } else if num(order, "net") < 0.0 {
        "亏损"
    } else {
        "持平"
    };
    let issue_name = match primary {
        "direction" => "策略方向判断",
        "stopLoss_too_tight" => "止损过紧",
        "takeProfit_too_far" => "止盈过远",
        "timing" => "入场时机",
        _ => "综合因素",
    };
    let summary = if issues.is_empty() {
        format!("订单{result}，策略执行优秀，无明显问题")
    } else {
        format!(
            "订单{result}，发现{}个问题，主要原因：{issue_name}",
            issues.len()
        )
    };
    for (idx, row) in candles.iter_mut().enumerate() {
        row["isEntry"] = json!(idx == e);
        row["isExit"] = json!(idx == x);
        row["beforeEntry"] = json!(idx < e);
        row["holding"] = json!(idx >= e && idx <= x);
        row["afterExit"] = json!(idx > x);
    }
    let mut order_summary = json!({});
    for key in [
        "id",
        "symbol",
        "direction",
        "entry",
        "exit",
        "net",
        "status",
        "reason",
    ] {
        if let Some(v) = order.get(key) {
            order_summary[key] = v.clone();
        }
    }
    json!({"order":order_summary,"klines":candles,"analysis":{"direction":direction,"stopLoss":stop_loss,"takeProfit":take_profit,"entry":entry_analysis},"diagnosis":{"score":score,"primaryIssue":primary,"issues":issues,"strengths":strengths,"recommendations":recommendations,"summary":summary},"timestamp":iso(now_ms())})
}
pub fn batch_replay(results: &[Value]) -> Value {
    let valid: Vec<Value> = results
        .iter()
        .filter(|v| v["error"].is_null() && v["diagnosis"].is_object())
        .cloned()
        .collect();
    let summary = if valid.is_empty() {
        json!({"error":"无有效分析结果"})
    } else {
        let mut counts = json!({"direction":0,"stopLoss":0,"takeProfit":0,"entry":0});
        let mut primary = json!({});
        for v in &valid {
            for issue in v["diagnosis"]["issues"].as_array().unwrap() {
                if let Some(key) = issue["type"].as_str()
                    && counts.get(key).is_some()
                {
                    counts[key] = json!(num(&counts, key) + 1.0);
                }
            }
            let key = text(&v["diagnosis"], "primaryIssue", "unknown");
            primary[key] = json!(num(&primary, key) + 1.0);
        }
        let top = ["direction", "stopLoss", "takeProfit", "entry"]
            .iter()
            .reduce(|best, next| {
                if num(&counts, next) > num(&counts, best) {
                    next
                } else {
                    best
                }
            })
            .unwrap();
        let recommendation = if num(&counts, top) == 0.0 {
            "策略整体表现良好，保持当前设置"
        } else {
            match *top {
                "direction" => "优先优化趋势判断逻辑，考虑增加多周期确认或过滤震荡市",
                "stopLoss" => "优化止损距离设置，建议使用1.5-2倍ATR动态止损",
                "takeProfit" => "调整止盈策略，考虑使用移动止盈或分批获利",
                _ => "改进入场时机，等待回调/反弹确认后进场",
            }
        };
        json!({"totalAnalyzed":valid.len(),"averageScore":valid.iter().map(|v|num(&v["diagnosis"],"score")).sum::<f64>()/valid.len() as f64,"issueFrequency":counts,"primaryIssues":primary,"topRecommendation":recommendation})
    };
    json!({"results":results,"summary":summary,"timestamp":iso(now_ms())})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_never_accepts_holding_data_gaps() {
        let rows:Vec<Value>=(0..30).filter(|i|*i!=21).map(|i|json!({"openTime":i*60_000,"open":100,"high":101,"low":99,"close":100,"volume":10})).collect();
        let order = json!({"symbol":"TESTUSDT","interval":"1m","entry":100,"entryAt":iso(20*60_000),"exitAt":iso(25*60_000),"plan":{"stopLoss":98,"takeProfit":105}});
        assert!(
            replay(&order, &rows)["error"]
                .as_str()
                .unwrap()
                .contains("缺口")
        );
    }
}
