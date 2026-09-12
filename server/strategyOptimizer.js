/**
 * 策略优化器 - 根据成交记录优化本地策略参数
 */

import { isStopReason, isTakeProfitReason } from '../shared/closeReasons.js';

/**
 * 分析已平仓订单，提取优化建议
 */
export function analyzeClosedOrders(orders) {
  const closed = orders.filter(o => o.status === 'closed' && o.analysisContext);

  if (closed.length === 0) {
    return {
      error: '没有可分析的已平仓订单',
      stats: null,
      suggestions: []
    };
  }

  // 按策略版本分组统计
  const byStrategy = groupBy(closed, o => o.analysisContext?.strategyVersion || 'unknown');
  const bySymbol = groupBy(closed, o => o.symbol);
  const byDirection = groupBy(closed, o => o.direction);
  const byReason = groupBy(closed, o => o.reason);

  // 整体统计
  const stats = {
    total: closed.length,
    profitable: closed.filter(o => o.net > 0).length,
    breakeven: closed.filter(o => Math.abs(o.net) < 0.01).length,
    losing: closed.filter(o => o.net < 0).length,
    winRate: closed.filter(o => o.net > 0).length / closed.length,
    averageRoi: closed.reduce((sum, o) => sum + o.roi, 0) / closed.length,
    averageHoldBars: closed.reduce((sum, o) => sum + (o.heldBars || 0), 0) / closed.length,
    totalNet: closed.reduce((sum, o) => sum + o.net, 0),

    byStrategy: Object.entries(byStrategy).map(([key, orders]) => ({
      strategyVersion: key,
      count: orders.length,
      winRate: orders.filter(o => o.net > 0).length / orders.length,
      averageRoi: orders.reduce((sum, o) => sum + o.roi, 0) / orders.length,
      totalNet: orders.reduce((sum, o) => sum + o.net, 0)
    })),

    bySymbol: Object.entries(bySymbol).map(([key, orders]) => ({
      symbol: key,
      count: orders.length,
      winRate: orders.filter(o => o.net > 0).length / orders.length,
      averageRoi: orders.reduce((sum, o) => sum + o.roi, 0) / orders.length,
      totalNet: orders.reduce((sum, o) => sum + o.net, 0)
    })).sort((a, b) => b.totalNet - a.totalNet),

    byDirection: Object.entries(byDirection).map(([key, orders]) => ({
      direction: key,
      count: orders.length,
      winRate: orders.filter(o => o.net > 0).length / orders.length,
      averageRoi: orders.reduce((sum, o) => sum + o.roi, 0) / orders.length,
      totalNet: orders.reduce((sum, o) => sum + o.net, 0)
    })),

    byReason: Object.entries(byReason).map(([key, orders]) => ({
      reason: key,
      count: orders.length,
      winRate: orders.filter(o => o.net > 0).length / orders.length,
      averageRoi: orders.reduce((sum, o) => sum + o.roi, 0) / orders.length,
      totalNet: orders.reduce((sum, o) => sum + o.net, 0)
    }))
  };

  // 生成优化建议
  const suggestions = generateSuggestions(closed, stats);

  return { stats, suggestions, sampleSize: closed.length };
}

/**
 * 生成具体的优化建议
 */
function generateSuggestions(orders, stats) {
  const suggestions = [];

  // 1. 止损止盈分析
  // 按「类」统计：移动止损 / 保本止损同属止损，分批止盈同属止盈。
  // 细分平仓理由后若仍只认 `stop_loss` 字面量，这里会系统性少算一大半止损单。
  const stopLossHit = orders.filter(o => isStopReason(o.reason));
  const takeProfitHit = orders.filter(o => isTakeProfitReason(o.reason));
  const timeout = orders.filter(o => o.reason === 'timeout');

  if (stopLossHit.length > 0) {
    const slWinRate = stopLossHit.filter(o => o.net > 0).length / stopLossHit.length;
    if (slWinRate < 0.1) {
      suggestions.push({
        type: 'stop_loss',
        severity: 'high',
        message: `止损命中率 ${(stopLossHit.length / orders.length * 100).toFixed(1)}%，胜率仅 ${(slWinRate * 100).toFixed(1)}%，建议放宽止损距离`,
        data: {
          stopLossCount: stopLossHit.length,
          winRate: slWinRate,
          averageRoi: stopLossHit.reduce((sum, o) => sum + o.roi, 0) / stopLossHit.length
        }
      });
    }
  }

  if (takeProfitHit.length > 0) {
    const tpWinRate = takeProfitHit.filter(o => o.net > 0).length / takeProfitHit.length;
    suggestions.push({
      type: 'take_profit',
      severity: 'info',
      message: `止盈命中率 ${(takeProfitHit.length / orders.length * 100).toFixed(1)}%，胜率 ${(tpWinRate * 100).toFixed(1)}%`,
      data: {
        takeProfitCount: takeProfitHit.length,
        winRate: tpWinRate,
        averageRoi: takeProfitHit.reduce((sum, o) => sum + o.roi, 0) / takeProfitHit.length
      }
    });
  }

  if (timeout.length > orders.length * 0.3) {
    suggestions.push({
      type: 'hold_duration',
      severity: 'medium',
      message: `${(timeout.length / orders.length * 100).toFixed(1)}% 的订单持有到期，建议缩短 maxHoldBars 或调整止盈距离`,
      data: {
        timeoutCount: timeout.length,
        averageHoldBars: timeout.reduce((sum, o) => sum + (o.heldBars || 0), 0) / timeout.length
      }
    });
  }

  // 2. 方向偏好分析
  const longOrders = orders.filter(o => o.direction === 'OPEN_LONG');
  const shortOrders = orders.filter(o => o.direction === 'OPEN_SHORT');

  if (longOrders.length > 0 && shortOrders.length > 0) {
    const longWinRate = longOrders.filter(o => o.net > 0).length / longOrders.length;
    const shortWinRate = shortOrders.filter(o => o.net > 0).length / shortOrders.length;
    const diff = Math.abs(longWinRate - shortWinRate);

    if (diff > 0.2) {
      suggestions.push({
        type: 'direction_bias',
        severity: 'medium',
        message: `多空表现差异显著：做多胜率 ${(longWinRate * 100).toFixed(1)}%，做空胜率 ${(shortWinRate * 100).toFixed(1)}%`,
        data: {
          longWinRate,
          shortWinRate,
          longCount: longOrders.length,
          shortCount: shortOrders.length
        }
      });
    }
  }

  // 3. 币种表现分析
  const topSymbols = stats.bySymbol.slice(0, 5);
  const bottomSymbols = stats.bySymbol.slice(-5);

  if (bottomSymbols.some(s => s.count >= 3 && s.winRate < 0.3)) {
    const badSymbols = bottomSymbols.filter(s => s.count >= 3 && s.winRate < 0.3);
    suggestions.push({
      type: 'symbol_filter',
      severity: 'high',
      message: `以下币种胜率较低，建议排除：${badSymbols.map(s => s.symbol).join(', ')}`,
      data: { symbols: badSymbols }
    });
  }

  // 4. 整体胜率分析
  if (stats.winRate < 0.4 && orders.length >= 10) {
    suggestions.push({
      type: 'overall_performance',
      severity: 'critical',
      message: `整体胜率 ${(stats.winRate * 100).toFixed(1)}% 偏低，建议重新审视策略规则或提高入场门槛`,
      data: {
        winRate: stats.winRate,
        sampleSize: orders.length
      }
    });
  } else if (stats.winRate > 0.6 && orders.length >= 10) {
    suggestions.push({
      type: 'overall_performance',
      severity: 'positive',
      message: `整体胜率 ${(stats.winRate * 100).toFixed(1)}%，策略表现良好`,
      data: {
        winRate: stats.winRate,
        sampleSize: orders.length
      }
    });
  }

  // 5. 持仓时长分析
  const avgHoldBars = stats.averageHoldBars;
  const maxHoldBarsFromOrders = orders
    .filter(o => o.analysisContext?.signal?.plan?.maxHoldBars)
    .map(o => o.analysisContext.signal.plan.maxHoldBars);

  if (maxHoldBarsFromOrders.length > 0) {
    const avgMaxHold = maxHoldBarsFromOrders.reduce((sum, v) => sum + v, 0) / maxHoldBarsFromOrders.length;
    const utilization = avgHoldBars / avgMaxHold;

    if (utilization < 0.3) {
      suggestions.push({
        type: 'hold_duration',
        severity: 'low',
        message: `平均持仓 ${avgHoldBars.toFixed(1)} 根K线，仅占最大持仓时长的 ${(utilization * 100).toFixed(0)}%，可以缩短 maxHoldBars`,
        data: { avgHoldBars, avgMaxHold, utilization }
      });
    }
  }

  return suggestions;
}

/**
 * 根据优化建议生成可执行的策略调整
 */
export function generateStrategyAdjustments(suggestions, currentRules) {
  const adjustments = [];

  for (const suggestion of suggestions) {
    switch (suggestion.type) {
      case 'stop_loss':
        if (suggestion.severity === 'high') {
          adjustments.push({
            field: 'atrMultiplierStopLoss',
            current: '从规则中提取',
            suggested: '增加 0.5-1.0 倍',
            reason: suggestion.message
          });
        }
        break;

      case 'symbol_filter':
        adjustments.push({
          field: 'symbolBlacklist',
          current: '无',
          suggested: suggestion.data.symbols.map(s => s.symbol),
          reason: suggestion.message
        });
        break;

      case 'hold_duration':
        if (suggestion.data.avgMaxHold && suggestion.data.utilization < 0.3) {
          adjustments.push({
            field: 'maxHoldBars',
            current: suggestion.data.avgMaxHold.toFixed(0),
            suggested: Math.ceil(suggestion.data.avgMaxHold * 0.6),
            reason: suggestion.message
          });
        }
        break;
    }
  }

  return adjustments;
}

/**
 * 辅助函数：按字段分组
 */
function groupBy(array, keyFn) {
  return array.reduce((groups, item) => {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
    return groups;
  }, {});
}
