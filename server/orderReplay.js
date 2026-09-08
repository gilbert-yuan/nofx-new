/**
 * 订单复盘分析系统
 *
 * 功能：
 * 1. 获取订单完整生命周期的K线数据
 * 2. 分析策略方向准确性
 * 3. 分析止盈止损点位合理性
 * 4. 分析入场价格质量
 * 5. 生成优化建议
 */

import { candleOpenAt, nextOpenTime } from './research.js';

/**
 * 获取订单复盘数据
 */
export async function getOrderReplayData(order, market, marketDb) {
  const { symbol, interval, createdAt, entry, exit, plan, direction } = order;

  if (!entry) {
    return { error: '订单未入场，无法复盘' };
  }

  const isLong = direction === 'OPEN_LONG';
  const entryTime = Date.parse(order.entryAt);
  const exitTime = order.exitAt ? Date.parse(order.exitAt) : Date.now();

  // 获取入场前K线（20根，用于判断趋势背景）
  const beforeEntryStart = entryTime - 20 * getIntervalMs(interval);

  // 获取完整周期K线（入场前20根 + 持仓期间 + 出场后5根）
  const afterExitEnd = exitTime + 5 * getIntervalMs(interval);

  let klines = [];

  try {
    // 从市场数据库或API获取K线
    if (marketDb) {
      // 使用listKlines获取所有K线，然后根据时间范围筛选
      const allKlines = await marketDb.listKlines({
        symbol: symbol,
        interval,
        limit: 1000
      });

      // 筛选出需要的时间范围
      klines = allKlines.filter(k =>
        k.openTime >= beforeEntryStart && k.openTime <= afterExitEnd
      );
    } else {
      klines = await market.klines({
        symbol,
        interval,
        startTime: beforeEntryStart,
        endTime: afterExitEnd,
        limit: 500
      });
    }
  } catch (error) {
    return { error: `获取K线失败: ${error.message}` };
  }

  if (klines.length === 0) {
    return { error: '无K线数据' };
  }

  // 标注关键K线
  const entryIndex = klines.findIndex(k => k.openTime >= entryTime);
  const exitIndex = order.exitAt ? klines.findIndex(k => k.openTime >= exitTime) : klines.length - 1;

  // 分析各个维度
  const directionAnalysis = analyzeDirection(klines, entryIndex, exitIndex, isLong, entry);
  const stopLossAnalysis = analyzeStopLoss(klines, entryIndex, exitIndex, plan.stopLoss, isLong, entry);
  const takeProfitAnalysis = analyzeTakeProfit(klines, entryIndex, exitIndex, plan.takeProfit, isLong, entry);
  const entryAnalysis = analyzeEntry(klines, entryIndex, plan, isLong);

  // 综合诊断
  const diagnosis = generateDiagnosis({
    order,
    directionAnalysis,
    stopLossAnalysis,
    takeProfitAnalysis,
    entryAnalysis
  });

  return {
    order: {
      id: order.id,
      symbol: order.symbol,
      direction: order.direction,
      entry: order.entry,
      exit: order.exit,
      net: order.net,
      status: order.status,
      reason: order.reason
    },
    klines: klines.map((k, idx) => ({
      ...k,
      isEntry: idx === entryIndex,
      isExit: idx === exitIndex,
      beforeEntry: idx < entryIndex,
      holding: idx >= entryIndex && idx <= exitIndex,
      afterExit: idx > exitIndex
    })),
    analysis: {
      direction: directionAnalysis,
      stopLoss: stopLossAnalysis,
      takeProfit: takeProfitAnalysis,
      entry: entryAnalysis
    },
    diagnosis,
    timestamp: new Date().toISOString()
  };
}

/**
 * 分析方向准确性
 */
function analyzeDirection(klines, entryIndex, exitIndex, isLong, entryPrice) {
  if (entryIndex < 0 || entryIndex >= klines.length) {
    return { error: '入场K线索引无效' };
  }

  // 计算入场后的价格走势
  const holdingKlines = klines.slice(entryIndex, exitIndex + 1);
  const prices = holdingKlines.map(k => k.close);

  // 最高点和最低点
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);

  // 有利价差（favorable excursion）
  const favorableMove = isLong
    ? (maxPrice - entryPrice) / entryPrice
    : (entryPrice - minPrice) / entryPrice;

  // 不利价差（adverse excursion）
  const adverseMove = isLong
    ? (entryPrice - minPrice) / entryPrice
    : (maxPrice - entryPrice) / entryPrice;

  // 最终价差
  const finalMove = isLong
    ? (prices[prices.length - 1] - entryPrice) / entryPrice
    : (entryPrice - prices[prices.length - 1]) / entryPrice;

  // 方向正确性判断
  const directionCorrect = favorableMove > Math.abs(adverseMove) * 1.5;

  // 趋势强度（入场前20根K线）
  const trendStrength = analyzeTrendStrength(klines.slice(Math.max(0, entryIndex - 20), entryIndex), isLong);

  return {
    correct: directionCorrect,
    favorableMove: favorableMove * 100, // 转换为百分比
    adverseMove: adverseMove * 100,
    finalMove: finalMove * 100,
    maxPrice,
    minPrice,
    trendStrength,
    summary: directionCorrect
      ? `方向正确，有利价差${(favorableMove * 100).toFixed(2)}%超过不利价差`
      : `方向可能有误，不利价差${(adverseMove * 100).toFixed(2)}%过大`
  };
}

/**
 * 分析止损点位
 */
function analyzeStopLoss(klines, entryIndex, exitIndex, stopLoss, isLong, entryPrice) {
  const holdingKlines = klines.slice(entryIndex, exitIndex + 1);

  // 计算到止损的距离
  const stopLossDistance = Math.abs(entryPrice - stopLoss) / entryPrice;

  // 找到最接近止损但未触及的K线
  let minDistanceToSL = Infinity;
  let slTouched = false;

  for (const k of holdingKlines) {
    if (isLong) {
      if (k.low <= stopLoss) {
        slTouched = true;
        break;
      }
      minDistanceToSL = Math.min(minDistanceToSL, (k.low - stopLoss) / entryPrice);
    } else {
      if (k.high >= stopLoss) {
        slTouched = true;
        break;
      }
      minDistanceToSL = Math.min(minDistanceToSL, (stopLoss - k.high) / entryPrice);
    }
  }

  // 计算ATR作为参考
  const atr = calculateATR(klines.slice(Math.max(0, entryIndex - 14), entryIndex + 1), 14);
  const atrRatio = Math.abs(entryPrice - stopLoss) / atr;

  // 判断止损是否合理
  let assessment = '';
  let optimal = false;

  if (stopLossDistance < 0.005) {
    assessment = '止损过紧（<0.5%），容易被正常波动触发';
  } else if (stopLossDistance > 0.05) {
    assessment = '止损过宽（>5%），风险暴露过大';
  } else if (atrRatio < 1) {
    assessment = '止损距离小于1倍ATR，可能过紧';
  } else if (atrRatio > 3) {
    assessment = '止损距离大于3倍ATR，可能过宽';
  } else {
    assessment = '止损点位设置合理';
    optimal = true;
  }

  return {
    stopLoss,
    distance: stopLossDistance * 100,
    touched: slTouched,
    minDistanceToSL: minDistanceToSL * 100,
    atr,
    atrRatio,
    optimal,
    assessment
  };
}

/**
 * 分析止盈点位
 */
function analyzeTakeProfit(klines, entryIndex, exitIndex, takeProfit, isLong, entryPrice) {
  const holdingKlines = klines.slice(entryIndex, exitIndex + 1);

  // 计算到止盈的距离
  const takeProfitDistance = Math.abs(takeProfit - entryPrice) / entryPrice;

  // 找到最接近止盈的K线
  let minDistanceToTP = Infinity;
  let tpTouched = false;

  for (const k of holdingKlines) {
    if (isLong) {
      if (k.high >= takeProfit) {
        tpTouched = true;
        break;
      }
      minDistanceToTP = Math.min(minDistanceToTP, (takeProfit - k.high) / entryPrice);
    } else {
      if (k.low <= takeProfit) {
        tpTouched = true;
        break;
      }
      minDistanceToTP = Math.min(minDistanceToTP, (k.low - takeProfit) / entryPrice);
    }
  }

  // 计算实际最大有利价差
  const prices = holdingKlines.map(k => isLong ? k.high : k.low);
  const bestPrice = isLong ? Math.max(...prices) : Math.min(...prices);
  const maxFavorable = Math.abs(bestPrice - entryPrice) / entryPrice;

  // 判断止盈是否过于保守或激进
  let assessment = '';
  let optimal = false;

  if (tpTouched && maxFavorable > takeProfitDistance * 1.5) {
    assessment = '止盈过早，后续还有较大空间';
  } else if (!tpTouched && minDistanceToTP < 0.01) {
    assessment = '止盈略显激进，仅差临门一脚';
  } else if (!tpTouched && minDistanceToTP > 0.05) {
    assessment = '止盈过于激进，价格未能接近目标';
  } else {
    assessment = '止盈点位设置合理';
    optimal = true;
  }

  return {
    takeProfit,
    distance: takeProfitDistance * 100,
    touched: tpTouched,
    minDistanceToTP: minDistanceToTP * 100,
    maxFavorable: maxFavorable * 100,
    optimal,
    assessment
  };
}

/**
 * 分析入场价格
 */
function analyzeEntry(klines, entryIndex, plan, isLong) {
  if (entryIndex < 1) {
    return { error: '入场K线索引无效' };
  }

  const entryKline = klines[entryIndex];
  const prevKlines = klines.slice(Math.max(0, entryIndex - 10), entryIndex);

  // 计算入场价格在K线中的位置（0=最低，1=最高）
  const range = entryKline.high - entryKline.low;
  const entryPosition = range > 0 ? (entryKline.open - entryKline.low) / range : 0.5;

  // 判断是否在计划区间内
  const inPlanRange = entryKline.open >= plan.entryMin && entryKline.open <= plan.entryMax;

  // 分析入场时机
  let timing = '';
  let optimal = false;

  if (isLong) {
    if (entryPosition < 0.3) {
      timing = '入场价格接近K线低点，时机较好';
      optimal = true;
    } else if (entryPosition > 0.7) {
      timing = '入场价格接近K线高点，追高风险';
    } else {
      timing = '入场价格处于K线中部，中性';
      optimal = true;
    }
  } else {
    if (entryPosition > 0.7) {
      timing = '入场价格接近K线高点，时机较好';
      optimal = true;
    } else if (entryPosition < 0.3) {
      timing = '入场价格接近K线低点，追低风险';
    } else {
      timing = '入场价格处于K线中部，中性';
      optimal = true;
    }
  }

  // 检查入场前波动
  const recentVolatility = calculateVolatility(prevKlines);

  return {
    entryPrice: entryKline.open,
    entryPosition: entryPosition * 100,
    inPlanRange,
    recentVolatility,
    timing,
    optimal,
    planRange: {
      min: plan.entryMin,
      max: plan.entryMax
    }
  };
}

/**
 * 生成综合诊断
 */
function generateDiagnosis({ order, directionAnalysis, stopLossAnalysis, takeProfitAnalysis, entryAnalysis }) {
  const issues = [];
  const strengths = [];
  const recommendations = [];

  // 方向问题
  if (!directionAnalysis.correct) {
    issues.push({
      type: 'direction',
      severity: 'high',
      description: '策略方向判断可能有误',
      detail: `不利价差(${directionAnalysis.adverseMove.toFixed(2)}%)超过有利价差(${directionAnalysis.favorableMove.toFixed(2)}%)`
    });
    recommendations.push('建议审查趋势判断逻辑，考虑增加趋势确认条件或过滤器');
  } else {
    strengths.push('方向判断正确');
  }

  // 止损问题
  if (!stopLossAnalysis.optimal) {
    const severity = stopLossAnalysis.touched ? 'high' : 'medium';
    issues.push({
      type: 'stopLoss',
      severity,
      description: stopLossAnalysis.assessment,
      detail: `止损距离${stopLossAnalysis.distance.toFixed(2)}%，ATR比率${stopLossAnalysis.atrRatio.toFixed(2)}`
    });

    if (stopLossAnalysis.distance < 0.5) {
      recommendations.push('建议放宽止损距离至1.5-2倍ATR，避免被正常波动扫损');
    } else if (stopLossAnalysis.distance > 5) {
      recommendations.push('建议收紧止损距离至2-3倍ATR，控制单笔风险');
    }
  } else {
    strengths.push('止损设置合理');
  }

  // 止盈问题
  if (!takeProfitAnalysis.optimal) {
    issues.push({
      type: 'takeProfit',
      severity: 'medium',
      description: takeProfitAnalysis.assessment,
      detail: `止盈距离${takeProfitAnalysis.distance.toFixed(2)}%，最大有利价差${takeProfitAnalysis.maxFavorable.toFixed(2)}%`
    });

    if (takeProfitAnalysis.touched && takeProfitAnalysis.maxFavorable > takeProfitAnalysis.distance * 1.5) {
      recommendations.push('考虑使用移动止盈或分批止盈，捕捉更多利润');
    } else if (!takeProfitAnalysis.touched && takeProfitAnalysis.minDistanceToTP > 5) {
      recommendations.push('止盈目标过于激进，建议降低盈亏比预期');
    }
  } else {
    strengths.push('止盈设置合理');
  }

  // 入场问题
  if (!entryAnalysis.optimal) {
    issues.push({
      type: 'entry',
      severity: 'low',
      description: entryAnalysis.timing,
      detail: `入场价格位于K线${entryAnalysis.entryPosition.toFixed(0)}%位置`
    });
    recommendations.push('优化入场时机，在回调/反弹时进场可降低成本');
  } else {
    strengths.push('入场时机良好');
  }

  // 综合评分
  const score = calculateScore({ directionAnalysis, stopLossAnalysis, takeProfitAnalysis, entryAnalysis, order });

  // 主要问题诊断
  let primaryIssue = 'unknown';
  if (order.net < 0) {
    if (!directionAnalysis.correct) {
      primaryIssue = 'direction';
    } else if (stopLossAnalysis.touched && stopLossAnalysis.distance < 1) {
      primaryIssue = 'stopLoss_too_tight';
    } else if (!takeProfitAnalysis.touched && directionAnalysis.favorableMove > 2) {
      primaryIssue = 'takeProfit_too_far';
    } else {
      primaryIssue = 'timing';
    }
  }

  return {
    score,
    primaryIssue,
    issues,
    strengths,
    recommendations,
    summary: generateSummary(order, issues, strengths, primaryIssue)
  };
}

/**
 * 计算综合评分
 */
function calculateScore({ directionAnalysis, stopLossAnalysis, takeProfitAnalysis, entryAnalysis, order }) {
  let score = 0;

  // 方向（40分）
  if (directionAnalysis.correct) score += 40;
  else if (directionAnalysis.favorableMove > 0) score += 20;

  // 止损（20分）
  if (stopLossAnalysis.optimal) score += 20;
  else if (!stopLossAnalysis.touched) score += 10;

  // 止盈（20分）
  if (takeProfitAnalysis.optimal) score += 20;
  else if (takeProfitAnalysis.touched) score += 15;

  // 入场（20分）
  if (entryAnalysis.optimal) score += 20;
  else score += 10;

  return score;
}

/**
 * 生成摘要
 */
function generateSummary(order, issues, strengths, primaryIssue) {
  const result = order.net > 0 ? '盈利' : order.net < 0 ? '亏损' : '持平';
  const issueCount = issues.length;

  if (issueCount === 0) {
    return `订单${result}，策略执行优秀，无明显问题`;
  }

  const issueTypes = {
    direction: '策略方向判断',
    stopLoss_too_tight: '止损过紧',
    takeProfit_too_far: '止盈过远',
    timing: '入场时机'
  };

  const mainIssue = issueTypes[primaryIssue] || '综合因素';

  return `订单${result}，发现${issueCount}个问题，主要原因：${mainIssue}`;
}

/**
 * 辅助函数：计算ATR
 */
function calculateATR(klines, period = 14) {
  if (klines.length < period) return 0;

  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  return trs.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
}

/**
 * 辅助函数：分析趋势强度
 */
function analyzeTrendStrength(klines, isLong) {
  if (klines.length < 5) return 'insufficient_data';

  const closes = klines.map(k => k.close);
  let upCount = 0;
  let downCount = 0;

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) upCount++;
    else if (closes[i] < closes[i - 1]) downCount++;
  }

  const trendRatio = isLong ? upCount / closes.length : downCount / closes.length;

  if (trendRatio > 0.7) return 'strong';
  if (trendRatio > 0.5) return 'moderate';
  return 'weak';
}

/**
 * 辅助函数：计算波动率
 */
function calculateVolatility(klines) {
  if (klines.length < 2) return 0;

  const returns = [];
  for (let i = 1; i < klines.length; i++) {
    returns.push((klines[i].close - klines[i - 1].close) / klines[i - 1].close);
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

  return Math.sqrt(variance);
}

/**
 * 辅助函数：获取周期毫秒数
 */
function getIntervalMs(interval) {
  const units = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const match = interval.match(/^(\d+)([mhdw])$/);
  if (!match) return 60000;
  return parseInt(match[1]) * units[match[2]];
}

/**
 * 批量分析订单
 */
export async function batchAnalyzeOrders(orders, market, marketDb) {
  const results = [];

  for (const order of orders) {
    try {
      const analysis = await getOrderReplayData(order, market, marketDb);
      results.push(analysis);
    } catch (error) {
      results.push({
        order: { id: order.id },
        error: error.message
      });
    }
  }

  // 汇总统计
  const summary = summarizeBatchAnalysis(results);

  return {
    results,
    summary,
    timestamp: new Date().toISOString()
  };
}

/**
 * 汇总批量分析结果
 */
function summarizeBatchAnalysis(results) {
  const validResults = results.filter(r => !r.error && r.diagnosis);

  if (validResults.length === 0) {
    return { error: '无有效分析结果' };
  }

  const issueStats = {
    direction: 0,
    stopLoss: 0,
    takeProfit: 0,
    entry: 0
  };

  const primaryIssueStats = {};

  for (const result of validResults) {
    for (const issue of result.diagnosis.issues) {
      if (issueStats[issue.type] !== undefined) {
        issueStats[issue.type]++;
      }
    }

    const primary = result.diagnosis.primaryIssue;
    primaryIssueStats[primary] = (primaryIssueStats[primary] || 0) + 1;
  }

  const avgScore = validResults.reduce((sum, r) => sum + r.diagnosis.score, 0) / validResults.length;

  return {
    totalAnalyzed: validResults.length,
    averageScore: avgScore,
    issueFrequency: issueStats,
    primaryIssues: primaryIssueStats,
    topRecommendation: generateTopRecommendation(issueStats, primaryIssueStats)
  };
}

/**
 * 生成首要建议
 */
function generateTopRecommendation(issueStats, primaryIssueStats) {
  const sortedIssues = Object.entries(issueStats).sort((a, b) => b[1] - a[1]);

  if (sortedIssues.length === 0 || sortedIssues[0][1] === 0) {
    return '策略整体表现良好，保持当前设置';
  }

  const topIssue = sortedIssues[0][0];
  const recommendations = {
    direction: '优先优化趋势判断逻辑，考虑增加多周期确认或过滤震荡市',
    stopLoss: '优化止损距离设置，建议使用1.5-2倍ATR动态止损',
    takeProfit: '调整止盈策略，考虑使用移动止盈或分批获利',
    entry: '改进入场时机，等待回调/反弹确认后进场'
  };

  return recommendations[topIssue] || '继续监控和优化策略参数';
}
