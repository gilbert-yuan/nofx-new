use super::*;

pub fn holding_analysis(rows: &[Value]) -> Value {
    let closed: Vec<Value> = rows
        .iter()
        .filter(|o| o["status"] == "closed" && !o["heldBars"].is_null())
        .cloned()
        .collect();
    if closed.len() < 20 {
        return json!({"sufficient":false,"message":"样本量不足（需要至少20笔已平仓订单），暂不调整策略","sampleSize":closed.len()});
    }
    let mut stats:Vec<Value>=group(&closed,|o|((num(o,"heldBars")/5.0).floor()*5.0).to_string()).into_iter().filter(|(_,v)|v.len()>=3).map(|(bars,rows)|json!({"bars":bars.parse::<f64>().unwrap_or(0.0),"count":rows.len(),"winRate":win_rate(&rows),"avgNet":average(&rows,"net"),"avgRoi":average(&rows,"roi"),"totalNet":rows.iter().map(|o|num(o,"net")).sum::<f64>(),"orders":rows})).collect();
    stats.sort_by(|a, b| num(a, "bars").total_cmp(&num(b, "bars")));
    if stats.is_empty() {
        return json!({"sufficient":false,"message":"没有足够样本量的持仓区间（每个区间需要至少3笔订单）","sampleSize":closed.len()});
    }
    let best_profit = stats
        .iter()
        .reduce(|best, v| {
            if num(v, "avgNet") > num(best, "avgNet") {
                v
            } else {
                best
            }
        })
        .unwrap();
    let best_win = stats
        .iter()
        .reduce(|best, v| {
            if num(v, "winRate") > num(best, "winRate") {
                v
            } else {
                best
            }
        })
        .unwrap();
    json!({"sufficient":true,"sampleSize":closed.len(),"overallWinRate":win_rate(&closed),"avgHoldingBars":average(&closed,"heldBars"),"highWinRateRegions":stats.iter().filter(|v|num(v,"winRate")>=0.6).collect::<Vec<_>>(),"lowWinRateRegions":stats.iter().filter(|v|num(v,"winRate")<0.4).collect::<Vec<_>>(),"bestProfitRegion":best_profit,"bestWinRateRegion":best_win,"stats":stats})
}
pub fn optimized_parameters(analysis: &Value, current: f64) -> Value {
    if analysis["sufficient"] != true {
        return json!({"optimized":false,"reason":analysis["message"],"recommendations":[]});
    }
    let high = analysis["highWinRateRegions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let low = analysis["lowWinRateRegions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut recommended = current;
    let mut confidence: f64 = 0.0;
    let mut recommendations = Vec::new();
    let display = |rows: &[Value]| {
        rows.iter().map(|v|json!({"bars":format!("{}-{}",num(v,"bars"),num(v,"bars")+4.0),"winRate":v["winRate"],"avgNet":v["avgNet"]})).collect::<Vec<_>>()
    };
    if !high.is_empty() {
        let max = high
            .iter()
            .map(|v| num(v, "bars") + 4.0)
            .fold(f64::NEG_INFINITY, f64::max);
        if max < current * 0.7 {
            recommended = (max * 1.2).ceil();
            confidence += 0.3;
            recommendations.push(json!({"type":"maxHoldBars_reduction","priority":"high","message":format!("高胜率区间集中在 {max} 根K线内，建议缩短 maxHoldBars 至 {recommended}"),"data":{"currentMaxHoldBars":current,"suggestedMaxHoldBars":recommended,"highWinRateRegions":display(&high)}}));
        }
    }
    if !low.is_empty() {
        let avg = average(&low, "bars");
        if avg > num(analysis, "avgHoldingBars") {
            recommendations.push(json!({"type":"avoid_long_hold","priority":"high","message":format!("持仓时间过长（>{}根K线）容易导致亏损，建议提前止盈",avg.floor()),"data":{"lowWinRateRegions":display(&low)}}));
            let min = low
                .iter()
                .map(|v| num(v, "bars"))
                .fold(f64::INFINITY, f64::min);
            if min < current * 0.8 && (min * 0.9).floor() < recommended {
                recommended = (min * 0.9).floor();
                confidence += 0.25;
            }
        }
    }
    if num(analysis, "overallWinRate") < 0.45 && num(analysis, "avgHoldingBars") > current * 0.7 {
        recommendations.push(json!({"type":"overall_performance","priority":"critical","message":format!("整体胜率 {:.1}% 偏低，平均持仓 {:.1} 根K线接近上限，建议收紧止盈或缩短持仓时间",num(analysis,"overallWinRate")*100.0,num(analysis,"avgHoldingBars")),"data":{"overallWinRate":analysis["overallWinRate"],"avgHoldingBars":analysis["avgHoldingBars"],"currentMaxHoldBars":current}}));
        if (current * 0.6).floor() < recommended {
            recommended = (current * 0.6).floor();
            confidence += 0.2;
        }
    }
    let best = &analysis["bestProfitRegion"];
    if num(best, "avgNet") > 0.0 {
        recommendations.push(json!({"type":"optimal_target","priority":"medium","message":format!("最优盈利区间在 {}-{} 根K线，平均ROI {:.2}%",num(best,"bars"),num(best,"bars")+4.0,num(best,"avgRoi")*100.0),"data":{"optimalBars":num(best,"bars")+2.0,"optimalRoi":best["avgRoi"],"suggestedTakeProfit":(num(best,"avgRoi")*0.8).abs().max(0.015)}}));
        confidence += 0.15;
    }
    let best = &analysis["bestWinRateRegion"];
    if num(best, "winRate") >= 0.6 {
        recommendations.push(json!({"type":"high_probability_zone","priority":"high","message":format!("持仓 {}-{} 根K线时胜率最高（{:.1}%），建议在此区间内平仓",num(best,"bars"),num(best,"bars")+4.0,num(best,"winRate")*100.0),"data":{"optimalBars":num(best,"bars")+2.0,"winRate":best["winRate"],"avgNet":best["avgNet"]}}));
        confidence += 0.1;
    }
    recommended = recommended.clamp(20.0, 200.0);
    let change = (recommended - current).abs() / current;
    if change < 0.15 {
        recommended = current;
    }
    json!({"optimized":true,"confidence":confidence.min(1.0),"currentMaxHoldBars":current,"suggestedMaxHoldBars":recommended,"changePct":change,"shouldApply":change>=0.15&&confidence>=0.3,"recommendations":recommendations,"summary":{"sampleSize":analysis["sampleSize"],"overallWinRate":analysis["overallWinRate"],"avgHoldingBars":analysis["avgHoldingBars"],"highWinRateRegions":high.len(),"lowWinRateRegions":low.len()}})
}
pub fn optimize_strategy(rows: &[Value], current: f64) -> Value {
    let analysis = holding_analysis(rows);
    let opt = optimized_parameters(&analysis, current);
    let result = if opt["optimized"] != true || opt["shouldApply"] != true {
        json!({"applied":false,"reason":opt["reason"].as_str().unwrap_or("优化参数不满足应用条件")})
    } else {
        let mut rules = vec![
            format!(
                "## 自适应策略优化（基于 {} 笔历史订单）",
                num(&opt["summary"], "sampleSize")
            ),
            format!(
                "- 最大持仓时长调整: {} → {} 根K线",
                num(&opt, "currentMaxHoldBars"),
                num(&opt, "suggestedMaxHoldBars")
            ),
            format!(
                "- 整体胜率: {:.1}%",
                num(&opt["summary"], "overallWinRate") * 100.0
            ),
            format!(
                "- 平均持仓: {:.1} 根K线",
                num(&opt["summary"], "avgHoldingBars")
            ),
            String::new(),
        ];
        for (key, label) in [
            ("highWinRateRegions", "个高胜率区间（≥60%）"),
            ("lowWinRateRegions", "个低胜率区间（<40%），建议避免"),
        ] {
            if num(&opt["summary"], key) > 0.0 {
                rules.push(format!(
                    "{} 发现 {} {label}",
                    if key == "highWinRateRegions" {
                        "✓"
                    } else {
                        "⚠"
                    },
                    num(&opt["summary"], key)
                ));
            }
        }
        rules.extend([String::new(), "### 优化建议：".into()]);
        for rec in opt["recommendations"].as_array().unwrap() {
            rules.push(format!(
                "- [{}] {}",
                text(rec, "priority", "").to_uppercase(),
                text(rec, "message", "")
            ));
        }
        json!({"applied":true,"maxHoldBars":opt["suggestedMaxHoldBars"],"confidence":opt["confidence"],"rulesAddendum":rules.join("\n")})
    };
    json!({"analysis":analysis,"optimizedParams":opt,"result":result})
}
pub fn optimize_orders(rows: &[Value]) -> Value {
    let closed: Vec<Value> = rows
        .iter()
        .filter(|o| o["status"] == "closed" && o["analysisContext"].is_object())
        .cloned()
        .collect();
    if closed.is_empty() {
        return json!({"error":"没有可分析的已平仓订单","stats":null,"suggestions":[]});
    }
    let stat = |rows: &[Value]| json!({"count":rows.len(),"winRate":win_rate(rows),"averageRoi":average(rows,"roi"),"totalNet":rows.iter().map(|o|num(o,"net")).sum::<f64>()});
    let grouped = |key: fn(&Value) -> String, label: &str| {
        group(&closed, key)
            .into_iter()
            .map(|(k, rows)| {
                let mut v = stat(&rows);
                v[label] = json!(k);
                v
            })
            .collect::<Vec<_>>()
    };
    let by_strategy = grouped(
        |o| text(&o["analysisContext"], "strategyVersion", "unknown").into(),
        "strategyVersion",
    );
    let mut by_symbol = grouped(|o| text(o, "symbol", "undefined").into(), "symbol");
    by_symbol.sort_by(|a, b| num(b, "totalNet").total_cmp(&num(a, "totalNet")));
    let stats = json!({"total":closed.len(),"profitable":closed.iter().filter(|o|num(o,"net")>0.0).count(),"breakeven":closed.iter().filter(|o|num(o,"net").abs()<0.01).count(),"losing":closed.iter().filter(|o|num(o,"net")<0.0).count(),"winRate":win_rate(&closed),"averageRoi":average(&closed,"roi"),"averageHoldBars":average(&closed,"heldBars"),"totalNet":closed.iter().map(|o|num(o,"net")).sum::<f64>(),"byStrategy":by_strategy,"bySymbol":by_symbol,"byDirection":grouped(|o|text(o,"direction","undefined").into(),"direction"),"byReason":grouped(|o|text(o,"reason","undefined").into(),"reason")});
    let sl: Vec<Value> = closed
        .iter()
        .filter(|o| is_stop(text(o, "reason", "")))
        .cloned()
        .collect();
    let tp: Vec<Value> = closed
        .iter()
        .filter(|o| is_tp(text(o, "reason", "")))
        .cloned()
        .collect();
    let timeout: Vec<Value> = closed
        .iter()
        .filter(|o| o["reason"] == "timeout")
        .cloned()
        .collect();
    let mut suggestions = Vec::new();
    if !sl.is_empty() && win_rate(&sl) < 0.1 {
        suggestions.push(json!({"type":"stop_loss","severity":"high","message":format!("止损命中率 {:.1}%，胜率仅 {:.1}%，建议放宽止损距离",sl.len() as f64/closed.len() as f64*100.0,win_rate(&sl)*100.0),"data":{"stopLossCount":sl.len(),"winRate":win_rate(&sl),"averageRoi":average(&sl,"roi")}}));
    }
    if !tp.is_empty() {
        suggestions.push(json!({"type":"take_profit","severity":"info","message":format!("止盈命中率 {:.1}%，胜率 {:.1}%",tp.len() as f64/closed.len() as f64*100.0,win_rate(&tp)*100.0),"data":{"takeProfitCount":tp.len(),"winRate":win_rate(&tp),"averageRoi":average(&tp,"roi")}}));
    }
    if timeout.len() as f64 > closed.len() as f64 * 0.3 {
        suggestions.push(json!({"type":"hold_duration","severity":"medium","message":format!("{:.1}% 的订单持有到期，建议缩短 maxHoldBars 或调整止盈距离",timeout.len() as f64/closed.len() as f64*100.0),"data":{"timeoutCount":timeout.len(),"averageHoldBars":average(&timeout,"heldBars")}}));
    }
    let longs: Vec<Value> = closed
        .iter()
        .filter(|o| o["direction"] == "OPEN_LONG")
        .cloned()
        .collect();
    let shorts: Vec<Value> = closed
        .iter()
        .filter(|o| o["direction"] == "OPEN_SHORT")
        .cloned()
        .collect();
    if !longs.is_empty() && !shorts.is_empty() && (win_rate(&longs) - win_rate(&shorts)).abs() > 0.2
    {
        suggestions.push(json!({"type":"direction_bias","severity":"medium","message":format!("多空表现差异显著：做多胜率 {:.1}%，做空胜率 {:.1}%",win_rate(&longs)*100.0,win_rate(&shorts)*100.0),"data":{"longWinRate":win_rate(&longs),"shortWinRate":win_rate(&shorts),"longCount":longs.len(),"shortCount":shorts.len()}}));
    }
    let bad: Vec<Value> = by_symbol
        .iter()
        .skip(by_symbol.len().saturating_sub(5))
        .filter(|o| num(o, "count") >= 3.0 && num(o, "winRate") < 0.3)
        .cloned()
        .collect();
    if !bad.is_empty() {
        suggestions.push(json!({"type":"symbol_filter","severity":"high","message":format!("以下币种胜率较低，建议排除：{}",bad.iter().map(|o|text(o,"symbol","")).collect::<Vec<_>>().join(", ")),"data":{"symbols":bad}}));
    }
    let win = win_rate(&closed);
    if closed.len() >= 10 && (win < 0.4 || win > 0.6) {
        suggestions.push(json!({"type":"overall_performance","severity":if win<0.4{"critical"}else{"positive"},"message":if win<0.4{format!("整体胜率 {:.1}% 偏低，建议重新审视策略规则或提高入场门槛",win*100.0)}else{format!("整体胜率 {:.1}%，策略表现良好",win*100.0)},"data":{"winRate":win,"sampleSize":closed.len()}}));
    }
    let holds: Vec<f64> = closed
        .iter()
        .filter_map(|o| {
            o["analysisContext"]["signal"]["plan"]["maxHoldBars"]
                .as_f64()
                .filter(|v| *v != 0.0)
        })
        .collect();
    if !holds.is_empty() {
        let max = holds.iter().sum::<f64>() / holds.len() as f64;
        let avg = average(&closed, "heldBars");
        let utilization = avg / max;
        if utilization < 0.3 {
            suggestions.push(json!({"type":"hold_duration","severity":"low","message":format!("平均持仓 {avg:.1} 根K线，仅占最大持仓时长的 {:.0}%，可以缩短 maxHoldBars",utilization*100.0),"data":{"avgHoldBars":avg,"avgMaxHold":max,"utilization":utilization}}));
        }
    }
    let mut adjustments = Vec::new();
    for suggestion in &suggestions {
        match text(suggestion,"type",""){
        "stop_loss" if suggestion["severity"]=="high"=>adjustments.push(json!({"field":"atrMultiplierStopLoss","current":"从规则中提取","suggested":"增加 0.5-1.0 倍","reason":suggestion["message"]})),
        "symbol_filter"=>adjustments.push(json!({"field":"symbolBlacklist","current":"无","suggested":suggestion["data"]["symbols"].as_array().unwrap().iter().map(|v|v["symbol"].clone()).collect::<Vec<_>>(),"reason":suggestion["message"]})),
        "hold_duration" if num(&suggestion["data"],"avgMaxHold")!=0.0&&num(&suggestion["data"],"utilization")<0.3=>adjustments.push(json!({"field":"maxHoldBars","current":format!("{:.0}",num(&suggestion["data"],"avgMaxHold")),"suggested":(num(&suggestion["data"],"avgMaxHold")*0.6).ceil(),"reason":suggestion["message"]})),_=>{}}
    }
    json!({"stats":stats,"suggestions":suggestions,"sampleSize":closed.len(),"adjustments":adjustments,"timestamp":iso(now_ms())})
}
