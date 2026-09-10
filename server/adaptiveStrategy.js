/**
 * 自适应策略优化 - 基于持仓时长胜率分析动态调整策略参数
 */

/**
 * 分析持仓时长数据，提取最优参数
 */
export function analyzeHoldingPeriodPerformance(orders) {
  const closed = orders.filter(o => o.status === 'closed' && o.heldBars != null);

  if (closed.length < 20) {
    return {
      sufficient: false,
      message: '样本量不足（需要至少20笔已平仓订单），暂不调整策略',
      sampleSize: closed.length
    };
  }

  // 按持仓时长分组统计
  const holdingBarsDistribution = {};
  for (const order of closed) {
    const bucket = Math.floor(order.heldBars / 5) * 5;
    if (!holdingBarsDistribution[bucket]) {
      holdingBarsDistribution[bucket] = {
        bars: bucket,
        count: 0,
        wins: 0,
        totalNet: 0,
        totalRoi: 0,
        orders: []
      };
    }
    const group = holdingBarsDistribution[bucket];
    group.count++;
    if (order.net > 0) group.wins++;
    group.totalNet += order.net;
    group.totalRoi += order.roi || 0;
    group.orders.push(order);
  }

  // 计算每个区间的统计数据
  const stats = Object.values(holdingBarsDistribution)
    .map(h => ({
      bars: h.bars,
      count: h.count,
      winRate: h.count > 0 ? h.wins / h.count : 0,
      avgNet: h.count > 0 ? h.totalNet / h.count : 0,
      avgRoi: h.count > 0 ? h.totalRoi / h.count : 0,
      totalNet: h.totalNet,
      orders: h.orders
    }))
    .filter(h => h.count >= 3) // 只考虑样本量>=3的区间
    .sort((a, b) => a.bars - b.bars);

  if (stats.length === 0) {
    return {
      sufficient: false,
      message: '没有足够样本量的持仓区间（每个区间需要至少3笔订单）',
      sampleSize: closed.length
    };
  }

  // 找出高胜率区间（>=60%）
  const highWinRateRegions = stats.filter(s => s.winRate >= 0.6);

  // 找出低胜率区间（<40%）
  const lowWinRateRegions = stats.filter(s => s.winRate < 0.4);

  // 找出最优盈利区间
  const bestProfitRegion = stats.reduce((best, current) =>
    current.avgNet > best.avgNet ? current : best
  );

  // 找出最高胜率区间
  const bestWinRateRegion = stats.reduce((best, current) =>
    current.winRate > best.winRate ? current : best
  );

  // 计算整体胜率
  const totalWins = closed.filter(o => o.net > 0).length;
  const overallWinRate = totalWins / closed.length;

  // 计算平均持仓时长
  const avgHoldingBars = closed.reduce((sum, o) => sum + o.heldBars, 0) / closed.length;

  return {
    sufficient: true,
    sampleSize: closed.length,
    overallWinRate,
    avgHoldingBars,
    stats,
    highWinRateRegions,
    lowWinRateRegions,
    bestProfitRegion,
    bestWinRateRegion
  };
}

/**
 * 基于分析结果生成优化后的策略参数
 */
export function generateOptimizedParameters(analysis, currentMaxHoldBars = 120) {
  if (!analysis.sufficient) {
    return {
      optimized: false,
      reason: analysis.message,
      recommendations: []
    };
  }

  const recommendations = [];
  let suggestedMaxHoldBars = currentMaxHoldBars;
  let confidence = 0;

  // 策略1: 如果存在高胜率区间，将maxHoldBars设置在最高的高胜率区间附近
  if (analysis.highWinRateRegions.length > 0) {
    const maxHighWinRateBars = Math.max(...analysis.highWinRateRegions.map(r => r.bars + 4));

    // 如果最高的高胜率区间明显低于当前maxHoldBars，建议缩短
    if (maxHighWinRateBars < currentMaxHoldBars * 0.7) {
      suggestedMaxHoldBars = Math.ceil(maxHighWinRateBars * 1.2); // 留20%余量
      confidence += 0.3;

      recommendations.push({
        type: 'maxHoldBars_reduction',
        priority: 'high',
        message: `高胜率区间集中在 ${maxHighWinRateBars} 根K线内，建议缩短 maxHoldBars 至 ${suggestedMaxHoldBars}`,
        data: {
          currentMaxHoldBars,
          suggestedMaxHoldBars,
          highWinRateRegions: analysis.highWinRateRegions.map(r => ({
            bars: `${r.bars}-${r.bars + 4}`,
            winRate: r.winRate,
            avgNet: r.avgNet
          }))
        }
      });
    }
  }

  // 策略2: 如果低胜率区间占比高，且主要集中在后期，建议缩短持仓
  if (analysis.lowWinRateRegions.length > 0) {
    const avgLowWinRateBars = analysis.lowWinRateRegions.reduce((sum, r) => sum + r.bars, 0) / analysis.lowWinRateRegions.length;

    if (avgLowWinRateBars > analysis.avgHoldingBars) {
      recommendations.push({
        type: 'avoid_long_hold',
        priority: 'high',
        message: `持仓时间过长（>${Math.floor(avgLowWinRateBars)}根K线）容易导致亏损，建议提前止盈`,
        data: {
          lowWinRateRegions: analysis.lowWinRateRegions.map(r => ({
            bars: `${r.bars}-${r.bars + 4}`,
            winRate: r.winRate,
            avgNet: r.avgNet
          }))
        }
      });

      // 如果低胜率区间的起始点明显早于当前maxHoldBars，建议调整
      const minLowWinRateBars = Math.min(...analysis.lowWinRateRegions.map(r => r.bars));
      if (minLowWinRateBars < currentMaxHoldBars * 0.8) {
        const adjusted = Math.floor(minLowWinRateBars * 0.9);
        if (adjusted < suggestedMaxHoldBars) {
          suggestedMaxHoldBars = adjusted;
          confidence += 0.25;
        }
      }
    }
  }

  // 策略3: 如果整体胜率低，且平均持仓时长接近maxHoldBars，说明经常持有到期
  if (analysis.overallWinRate < 0.45 && analysis.avgHoldingBars > currentMaxHoldBars * 0.7) {
    recommendations.push({
      type: 'overall_performance',
      priority: 'critical',
      message: `整体胜率 ${(analysis.overallWinRate * 100).toFixed(1)}% 偏低，平均持仓 ${analysis.avgHoldingBars.toFixed(1)} 根K线接近上限，建议收紧止盈或缩短持仓时间`,
      data: {
        overallWinRate: analysis.overallWinRate,
        avgHoldingBars: analysis.avgHoldingBars,
        currentMaxHoldBars
      }
    });

    // 激进缩短持仓时间
    const adjusted = Math.floor(currentMaxHoldBars * 0.6);
    if (adjusted < suggestedMaxHoldBars) {
      suggestedMaxHoldBars = adjusted;
      confidence += 0.2;
    }
  }

  // 策略4: 基于最优盈利区间调整止盈止损
  if (analysis.bestProfitRegion && analysis.bestProfitRegion.avgNet > 0) {
    const optimalBars = analysis.bestProfitRegion.bars + 2; // 取区间中点
    const optimalRoi = analysis.bestProfitRegion.avgRoi;

    recommendations.push({
      type: 'optimal_target',
      priority: 'medium',
      message: `最优盈利区间在 ${analysis.bestProfitRegion.bars}-${analysis.bestProfitRegion.bars + 4} 根K线，平均ROI ${(optimalRoi * 100).toFixed(2)}%`,
      data: {
        optimalBars,
        optimalRoi,
        suggestedTakeProfit: Math.max(0.015, Math.abs(optimalRoi * 0.8)) // 设置止盈略低于平均盈利
      }
    });

    confidence += 0.15;
  }

  // 策略5: 基于最高胜率区间优化
  if (analysis.bestWinRateRegion && analysis.bestWinRateRegion.winRate >= 0.6) {
    recommendations.push({
      type: 'high_probability_zone',
      priority: 'high',
      message: `持仓 ${analysis.bestWinRateRegion.bars}-${analysis.bestWinRateRegion.bars + 4} 根K线时胜率最高（${(analysis.bestWinRateRegion.winRate * 100).toFixed(1)}%），建议在此区间内平仓`,
      data: {
        optimalBars: analysis.bestWinRateRegion.bars + 2,
        winRate: analysis.bestWinRateRegion.winRate,
        avgNet: analysis.bestWinRateRegion.avgNet
      }
    });

    confidence += 0.1;
  }

  // 确保suggestedMaxHoldBars在合理范围内
  suggestedMaxHoldBars = Math.max(20, Math.min(200, suggestedMaxHoldBars));

  // 如果建议的maxHoldBars与当前值差异不大（<15%），保持不变
  const changePct = Math.abs(suggestedMaxHoldBars - currentMaxHoldBars) / currentMaxHoldBars;
  if (changePct < 0.15) {
    suggestedMaxHoldBars = currentMaxHoldBars;
  }

  return {
    optimized: true,
    confidence: Math.min(1, confidence),
    currentMaxHoldBars,
    suggestedMaxHoldBars,
    changePct,
    shouldApply: changePct >= 0.15 && confidence >= 0.3,
    recommendations,
    summary: {
      sampleSize: analysis.sampleSize,
      overallWinRate: analysis.overallWinRate,
      avgHoldingBars: analysis.avgHoldingBars,
      highWinRateRegions: analysis.highWinRateRegions.length,
      lowWinRateRegions: analysis.lowWinRateRegions.length
    }
  };
}

/**
 * 应用优化参数到策略规则（修改自动交易的maxHoldBars）
 */
export function applyOptimizedStrategy(optimizedParams) {
  if (!optimizedParams.optimized || !optimizedParams.shouldApply) {
    return {
      applied: false,
      reason: optimizedParams.reason || '优化参数不满足应用条件'
    };
  }

  // 生成策略规则补充说明
  const rules = [];

  rules.push(`## 自适应策略优化（基于 ${optimizedParams.summary.sampleSize} 笔历史订单）`);
  rules.push(`- 最大持仓时长调整: ${optimizedParams.currentMaxHoldBars} → ${optimizedParams.suggestedMaxHoldBars} 根K线`);
  rules.push(`- 整体胜率: ${(optimizedParams.summary.overallWinRate * 100).toFixed(1)}%`);
  rules.push(`- 平均持仓: ${optimizedParams.summary.avgHoldingBars.toFixed(1)} 根K线`);
  rules.push('');

  if (optimizedParams.summary.highWinRateRegions > 0) {
    rules.push(`✓ 发现 ${optimizedParams.summary.highWinRateRegions} 个高胜率区间（≥60%）`);
  }

  if (optimizedParams.summary.lowWinRateRegions > 0) {
    rules.push(`⚠ 发现 ${optimizedParams.summary.lowWinRateRegions} 个低胜率区间（<40%），建议避免`);
  }

  rules.push('');
  rules.push('### 优化建议：');
  for (const rec of optimizedParams.recommendations) {
    rules.push(`- [${rec.priority.toUpperCase()}] ${rec.message}`);
  }

  return {
    applied: true,
    maxHoldBars: optimizedParams.suggestedMaxHoldBars,
    confidence: optimizedParams.confidence,
    rulesAddendum: rules.join('\n')
  };
}

/**
 * 完整的策略优化流程
 */
export function optimizeStrategyFromOrders(orders, currentMaxHoldBars = 120) {
  // 1. 分析持仓时长表现
  const analysis = analyzeHoldingPeriodPerformance(orders);

  // 2. 生成优化参数
  const optimizedParams = generateOptimizedParameters(analysis, currentMaxHoldBars);

  // 3. 应用优化
  const result = applyOptimizedStrategy(optimizedParams);

  return {
    analysis,
    optimizedParams,
    result
  };
}
