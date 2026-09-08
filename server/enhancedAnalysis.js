/**
 * 增强版本地分析引擎
 *
 * 集成指标：
 * 基础: 20/50均线, ATR
 * 动量: MACD, RSI
 * 波动: 布林带
 * 成交量: Volume分析
 * 支撑阻力: 动态识别
 *
 * 高级指标:
 * - Ichimoku Cloud (一目均衡表)
 * - DMI/ADX (方向指标)
 * - Supertrend (超级趋势)
 * - OBV (能量潮)
 * - CMF (资金流量)
 * - Williams %R
 */

import { request } from 'undici';
import {
  calculateIchimoku,
  calculateDMI,
  calculateSupertrend,
  calculateOBV,
  calculateCMF,
  calculateWilliamsR,
  calculateTrendScore
} from './advancedIndicators.js';

// 计算EMA（指数移动平均）
function ema(data, period) {
  if (data.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

// 计算MACD
function calculateMACD(closes) {
  if (closes.length < 26) return null;

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12 || !ema26) return null;

  const macdLine = ema12 - ema26;
  const macdValues = closes.slice(-9).map((_, i) => {
    const e12 = ema(closes.slice(0, closes.length - 9 + i + 1), 12);
    const e26 = ema(closes.slice(0, closes.length - 9 + i + 1), 26);
    return e12 - e26;
  });
  const signalLine = ema(macdValues, 9);
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

// 计算RSI
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

// 计算布林带
function calculateBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const mean = slice.reduce((sum, val) => sum + val, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: mean + stdDev * std,
    middle: mean,
    lower: mean - stdDev * std,
    bandwidth: (2 * stdDev * std) / mean
  };
}

// 成交量分析
function analyzeVolume(volumes) {
  if (volumes.length < 20) return null;

  const recent = volumes.slice(-5);
  const baseline = volumes.slice(-20, -5);

  const recentAvg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const baselineAvg = baseline.reduce((sum, v) => sum + v, 0) / baseline.length;

  const volumeRatio = recentAvg / baselineAvg;
  const trend = volumeRatio > 1.5 ? 'increasing' : volumeRatio < 0.7 ? 'decreasing' : 'stable';

  return { volumeRatio, trend, strong: volumeRatio > 1.8 };
}

// 寻找支撑阻力位
function findSupportResistance(klines) {
  if (klines.length < 50) return null;

  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);

  // 最近的高点和低点
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));

  // 历史关键位（出现频率高的价格区域）
  const priceRanges = {};
  const binSize = (recentHigh - recentLow) / 20;

  klines.slice(-50).forEach(k => {
    const bin = Math.floor((k.high - recentLow) / binSize);
    priceRanges[bin] = (priceRanges[bin] || 0) + 1;
  });

  const keyLevels = Object.entries(priceRanges)
    .filter(([_, count]) => count >= 3)
    .map(([bin, count]) => ({
      price: recentLow + (Number(bin) + 0.5) * binSize,
      strength: count
    }))
    .sort((a, b) => b.strength - a.strength);

  return {
    resistance: keyLevels.filter(l => l.price > klines.at(-1).close)[0]?.price || recentHigh,
    support: keyLevels.filter(l => l.price < klines.at(-1).close).reverse()[0]?.price || recentLow,
    keyLevels
  };
}

// 趋势强度评分
function calculateTrendStrength(market) {
  let score = 0;
  const reasons = [];

  const rows = market.klines;
  const closes = rows.map(r => r.close);
  const highs = rows.map(r => r.high);
  const lows = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  // 基础指标权重总计：70分
  // 高级指标权重总计：30分
  // 总分：100分

  // 1. 均线排列 (20分)
  const ma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
  const ma50 = closes.slice(-50).reduce((sum, c) => sum + c, 0) / 50;
  const close = rows.at(-1).close;

  if (ma20 > ma50 && close > ma20) {
    score += 20;
    reasons.push('多头均线排列完美');
  } else if (ma20 < ma50 && close < ma20) {
    score += 20;
    reasons.push('空头均线排列完美');
  } else if (Math.abs(ma20 - ma50) < ma50 * 0.005) {
    reasons.push('均线纠缠，趋势不明');
  } else {
    score += 8;
    reasons.push('均线排列一般');
  }

  // 2. MACD (15分)
  const macd = calculateMACD(closes);
  if (macd) {
    if (Math.abs(macd.histogram) > Math.abs(closes[closes.length - 10] - closes[closes.length - 1]) * 0.002) {
      if (macd.histogram > 0 && macd.macdLine > macd.signalLine) {
        score += 15;
        reasons.push('MACD金叉且柱状图扩大');
      } else if (macd.histogram < 0 && macd.macdLine < macd.signalLine) {
        score += 15;
        reasons.push('MACD死叉且柱状图扩大');
      } else {
        score += 8;
        reasons.push('MACD信号中等');
      }
    } else {
      score += 5;
      reasons.push('MACD信号较弱');
    }
  }

  // 3. RSI (12分)
  const rsi = calculateRSI(closes);
  if (rsi) {
    if (rsi > 50 && rsi < 70) {
      score += 12;
      reasons.push(`RSI健康多头区(${rsi.toFixed(1)})`);
    } else if (rsi < 50 && rsi > 30) {
      score += 12;
      reasons.push(`RSI健康空头区(${rsi.toFixed(1)})`);
    } else if (rsi >= 70) {
      score += 5;
      reasons.push(`RSI超买(${rsi.toFixed(1)})`);
    } else if (rsi <= 30) {
      score += 5;
      reasons.push(`RSI超卖(${rsi.toFixed(1)})`);
    } else {
      score += 8;
      reasons.push(`RSI中性(${rsi.toFixed(1)})`);
    }
  }

  // 4. 布林带 (10分)
  const bb = calculateBollinger(closes);
  if (bb) {
    const position = (close - bb.lower) / (bb.upper - bb.lower);
    if (position > 0.3 && position < 0.7) {
      score += 10;
      reasons.push('价格在布林带中轨');
    } else if (position > 0.8) {
      score += 6;
      reasons.push('价格接近布林带上轨');
    } else if (position < 0.2) {
      score += 6;
      reasons.push('价格接近布林带下轨');
    } else {
      score += 8;
      reasons.push('价格在布林带正常区域');
    }
  }

  // 5. 成交量 (13分)
  const volumeAnalysis = analyzeVolume(volumes);
  if (volumeAnalysis) {
    if (volumeAnalysis.strong) {
      score += 13;
      reasons.push(`成交量大幅放大(${volumeAnalysis.volumeRatio.toFixed(2)}倍)`);
    } else if (volumeAnalysis.trend === 'increasing') {
      score += 9;
      reasons.push(`成交量温和放大(${volumeAnalysis.volumeRatio.toFixed(2)}倍)`);
    } else if (volumeAnalysis.trend === 'stable') {
      score += 7;
      reasons.push('成交量平稳');
    } else {
      score += 3;
      reasons.push('成交量萎缩');
    }
  }

  // ========== 高级指标 (30分) ==========

  // 6. Ichimoku一目均衡表 (10分)
  try {
    const ichimoku = calculateIchimoku(highs, lows, closes);
    if (ichimoku) {
      const ichimokuScore = ichimoku.strength / 7; // 转换为10分制
      score += ichimokuScore;
      reasons.push(`Ichimoku${ichimoku.signal}(${ichimoku.strength}/70)`);
    }
  } catch (e) {
    // 数据不足，跳过
  }

  // 7. DMI/ADX趋势强度 (8分)
  try {
    const dmi = calculateDMI(highs, lows, closes);
    if (dmi) {
      if (dmi.trendStrength === 'STRONG') {
        score += 8;
        reasons.push(`ADX强趋势(${dmi.adx.toFixed(1)})`);
      } else if (dmi.trendStrength === 'MODERATE') {
        score += 5;
        reasons.push(`ADX中等趋势(${dmi.adx.toFixed(1)})`);
      } else {
        score += 2;
        reasons.push(`ADX弱趋势(${dmi.adx.toFixed(1)})`);
      }
    }
  } catch (e) {
    // 数据不足，跳过
  }

  // 8. Supertrend超级趋势 (7分)
  try {
    const supertrend = calculateSupertrend(highs, lows, closes);
    if (supertrend) {
      if (supertrend.trend === 'BULLISH' || supertrend.trend === 'BEARISH') {
        score += 7;
        reasons.push(`Supertrend${supertrend.trend}`);
      } else {
        score += 3;
        reasons.push('Supertrend中性');
      }
    }
  } catch (e) {
    // 数据不足，跳过
  }

  // 9. OBV能量潮 (5分)
  try {
    const obv = calculateOBV(closes, volumes);
    if (obv) {
      if (obv.signal === 'BULLISH' || obv.signal === 'BEARISH') {
        score += 5;
        reasons.push(`OBV${obv.trend}`);
      } else {
        score += 2;
        reasons.push('OBV中性');
      }
    }
  } catch (e) {
    // 数据不足，跳过
  }

  return { score, reasons, maxScore: 100 };
}

/**
 * 增强版本地分析
 */
export function enhancedAnalysis(market) {
  const rows = market.klines;
  const symbol = market.symbol;

  const wait = (reason, risks = [], trendScore = null) => ({
    symbol,
    action: 'WAIT',
    confidence: 0,
    reason,
    risk: risks.length ? risks.join(' ') : '市场条件不满足开仓要求。',
    plan: null,
    trendScore  // 添加趋势评分
  });

  // 最低数据要求
  if (rows.length < 50) {
    return wait('需要至少50根K线数据，当前数据不足。', ['数据不足，无法可靠分析。']);
  }

  // 基础数据提取
  const closes = rows.map(r => r.close);
  const highs = rows.map(r => r.high);
  const lows = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);
  const close = rows.at(-1).close;

  // 计算所有指标
  const ma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
  const ma50 = closes.slice(-50).reduce((sum, c) => sum + c, 0) / 50;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;

  const macd = calculateMACD(closes);
  const rsi = calculateRSI(closes);
  const bb = calculateBollinger(closes);
  const volumeAnalysis = analyzeVolume(volumes);
  const srLevels = findSupportResistance(rows);
  const trendStrength = calculateTrendStrength(market);

  // 波动率过滤
  const volatility = atr / close;
  if (volatility > 0.08) {
    return wait(
      '波动率过高（>8%），等待市场稳定。',
      [`当前波动率${(volatility * 100).toFixed(2)}%，风险极大。`],
      trendStrength
    );
  }

  // 趋势判断
  const isBullish = ma20 > ma50 && close > ma20;
  const isBearish = ma20 < ma50 && close < ma20;

  // 趋势不明
  if (Math.abs(ma20 - ma50) < atr * 0.3) {
    return wait(
      '均线纠缠，趋势不明确，等待突破方向。',
      ['均线距离小于0.3倍ATR，缺乏明确趋势。'],
      trendStrength
    );
  }

  // MACD确认
  let macdConfirm = false;
  if (macd) {
    if (isBullish && macd.histogram > 0) macdConfirm = true;
    if (isBearish && macd.histogram < 0) macdConfirm = true;
  }

  // RSI过滤
  let rsiWarning = '';
  if (rsi) {
    if (rsi > 70) rsiWarning = 'RSI超买，注意回调风险';
    if (rsi < 30) rsiWarning = 'RSI超卖，注意反弹风险';
    if (isBullish && rsi < 40) return wait('多头信号但RSI偏弱，等待确认。', [rsiWarning]);
    if (isBearish && rsi > 60) return wait('空头信号但RSI偏强，等待确认。', [rsiWarning]);
  }

  // 成交量确认
  let volumeConfirm = volumeAnalysis && volumeAnalysis.volumeRatio > 0.8;  // 降低门槛

  // 综合评分过滤（需要至少60分）
  if (trendStrength.score < 60) {
    return wait(
      `综合信号强度不足（${trendStrength.score}/100），等待更强信号。`,
      [`当前评分：${trendStrength.reasons.join('; ')}`],
      trendStrength
    );
  }

  // 确定方向
  let direction = null;
  if (isBullish && (macdConfirm || trendStrength.score >= 70)) {
    direction = 'long';
  } else if (isBearish && (macdConfirm || trendStrength.score >= 70)) {
    direction = 'short';
  } else {
    return wait(
      '缺少关键确认信号，等待。',
      ['建议等待更多确认信号后再入场。'],
      trendStrength
    );
  }

  // 计算入场区间
  const entryMin = close - atr * 0.5;
  const entryMax = close + atr * 0.5;

  // 动态止损止盈（基于ATR和支撑阻力）
  let stopLoss, takeProfit1, takeProfit2, takeProfit3;

  if (direction === 'long') {
    // 止损：均线支撑或2倍ATR
    const maSupportStop = Math.max(ma20, ma50) - atr * 0.5;
    const atrStop = entryMin - atr * 2.0;
    stopLoss = Math.max(maSupportStop, atrStop);

    // 使用支撑阻力优化止损
    if (srLevels && srLevels.support > stopLoss && srLevels.support < entryMin) {
      stopLoss = srLevels.support - atr * 0.3;
    }

    // 多级止盈
    takeProfit1 = entryMax + atr * 2.0;  // 保守目标
    takeProfit2 = entryMax + atr * 4.0;  // 主要目标
    takeProfit3 = entryMax + atr * 6.0;  // 激进目标

    // 使用阻力位优化止盈
    if (srLevels && srLevels.resistance < takeProfit3 && srLevels.resistance > takeProfit1) {
      takeProfit2 = srLevels.resistance;
      takeProfit3 = srLevels.resistance + atr * 2.0;
    }
  } else {
    // 止损：均线阻力或2倍ATR
    const maResistanceStop = Math.min(ma20, ma50) + atr * 0.5;
    const atrStop = entryMax + atr * 2.0;
    stopLoss = Math.min(maResistanceStop, atrStop);

    // 使用支撑阻力优化止损
    if (srLevels && srLevels.resistance < stopLoss && srLevels.resistance > entryMax) {
      stopLoss = srLevels.resistance + atr * 0.3;
    }

    // 多级止盈
    takeProfit1 = entryMin - atr * 2.0;
    takeProfit2 = entryMin - atr * 4.0;
    takeProfit3 = entryMin - atr * 6.0;

    // 使用支撑位优化止盈
    if (srLevels && srLevels.support > takeProfit3 && srLevels.support < takeProfit1) {
      takeProfit2 = srLevels.support;
      takeProfit3 = srLevels.support - atr * 2.0;
    }
  }

  // 计算风险收益比
  const riskDistance = Math.abs(entryMax - stopLoss) / entryMax;
  const reward1Distance = Math.abs(takeProfit1 - entryMax) / entryMax;
  const reward2Distance = Math.abs(takeProfit2 - entryMax) / entryMax;
  const riskRewardRatio = reward2Distance / riskDistance;

  // 风险收益比过滤（至少1.2:1，降低门槛）
  if (riskRewardRatio < 1.2) {
    return wait(
      `风险收益比不足（${riskRewardRatio.toFixed(2)}:1），等待更好位置。`,
      ['建议等待回调或突破至更优风险收益位置。']
    );
  }

  // 推荐杠杆（保守）
  const recommendedLeverage = Math.max(1, Math.min(5, Math.floor(0.08 / riskDistance)));

  // 置信度（基于综合评分）
  const confidence = Math.min(0.90, 0.60 + trendStrength.score / 250);

  // 组装信号
  return {
    symbol,
    action: direction === 'long' ? 'BUY' : 'SELL',
    confidence,
    reason: `增强分析(${trendStrength.score}/100分)：${trendStrength.reasons.slice(0, 3).join('；')}`,
    risk: [
      rsiWarning,
      `波动率${(volatility * 100).toFixed(2)}%`,
      `风险收益比${riskRewardRatio.toFixed(2)}:1`,
      `推荐杠杆${recommendedLeverage}x`
    ].filter(Boolean).join('；'),
    plan: {
      entryMin,
      entryMax,
      stopLoss,
      takeProfit: takeProfit2,  // 主要目标
      takeProfit1,
      takeProfit2,
      takeProfit3,
      validForBars: 6,
      maxHoldBars: 120,
      riskRewardRatio,
      recommendedLeverage,
      trendStrengthScore: trendStrength.score,
      indicators: {
        ma20,
        ma50,
        atr,
        rsi,
        macd: macd ? { histogram: macd.histogram } : null,
        bollinger: bb,
        volumeRatio: volumeAnalysis?.volumeRatio,
        support: srLevels?.support,
        resistance: srLevels?.resistance
      }
    }
  };
}

/**
 * 增强版持仓复核
 */
export function enhancedProtectionReview(order, market) {
  const rows = market.klines;
  if (rows.length < 30) {
    return { action: 'HOLD', reason: '数据不足，保留当前保护价格。' };
  }

  const close = rows.at(-1).close;
  const long = order.direction === 'OPEN_LONG';

  // 重新计算技术指标
  const closes = rows.map(r => r.close);
  const ma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;

  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const trendStrength = calculateTrendStrength(market);

  // 评估当前趋势
  const trendValid = long ? (close > ma20) : (close < ma20);
  const profit = long ? (close - order.entry) / order.entry : (order.entry - close) / order.entry;

  // 检查是否应该提前退出
  let shouldExit = false;
  let exitReason = '';

  // 1. 趋势反转（更严格的条件）
  if (!trendValid && Math.abs(close - ma20) > atr * 1.0 && profit < 0.05) {
    shouldExit = true;
    exitReason = '均线失守且未盈利超过5%，趋势可能反转';
  }

  // 2. RSI极值（更严格）
  if (rsi) {
    if (long && rsi > 80 && profit > 0.05) {
      shouldExit = true;
      exitReason = `RSI严重超买(${rsi.toFixed(1)})且已盈利5%+，建议获利了结`;
    }
    if (!long && rsi < 20 && profit > 0.05) {
      shouldExit = true;
      exitReason = `RSI严重超卖(${rsi.toFixed(1)})且已盈利5%+，建议获利了结`;
    }
  }

  // 3. MACD背离（需要更多盈利）
  if (macd && profit > 0.05) {
    if (long && macd.histogram < 0 && close > order.entry * 1.05) {
      shouldExit = true;
      exitReason = 'MACD死叉，盈利5%+，建议止盈';
    }
    if (!long && macd.histogram > 0 && close < order.entry * 0.95) {
      shouldExit = true;
      exitReason = 'MACD金叉，盈利5%+，建议止盈';
    }
  }

  // 如果应该退出，返回市价平仓建议
  if (shouldExit) {
    return {
      action: 'CLOSE',
      reason: exitReason,
      closePrice: close,
      confidence: 0.80
    };
  }

  // 动态止损（移动止损）
  let newStopLoss = order.plan.stopLoss;
  let newTakeProfit = order.plan.takeProfit;

  if (profit > 0.02) {
    // 盈利超过2%，启用移动止损
    if (long) {
      // 多头：止损移至成本或盈利保护位
      const breakEvenStop = order.entry + atr * 0.2;
      const trailingStop = close - atr * 1.5;
      newStopLoss = Math.max(order.plan.stopLoss, breakEvenStop, trailingStop);

      // 动态扩展止盈
      newTakeProfit = Math.max(order.plan.takeProfit, close + atr * 3.0);
    } else {
      // 空头：止损移至成本或盈利保护位
      const breakEvenStop = order.entry - atr * 0.2;
      const trailingStop = close + atr * 1.5;
      newStopLoss = Math.min(order.plan.stopLoss, breakEvenStop, trailingStop);

      // 动态扩展止盈
      newTakeProfit = Math.min(order.plan.takeProfit, close - atr * 3.0);
    }
  } else {
    // 未盈利，使用标准止损
    if (long) {
      newStopLoss = Math.max(order.plan.stopLoss, close - atr * 1.8);
      newTakeProfit = Math.max(order.plan.takeProfit, close + atr * 3.5);
    } else {
      newStopLoss = Math.min(order.plan.stopLoss, close + atr * 1.8);
      newTakeProfit = Math.min(order.plan.takeProfit, close - atr * 3.5);
    }
  }

  // 验证止损是否收紧
  const stopTightened = long ? newStopLoss > order.plan.stopLoss : newStopLoss < order.plan.stopLoss;

  if (!stopTightened) {
    return {
      action: 'HOLD',
      reason: '当前位置无需调整，保持原保护价格。',
      trendScore: trendStrength.score
    };
  }

  return {
    action: 'UPDATE_PROTECTION',
    stopLoss: newStopLoss,
    takeProfit: newTakeProfit,
    confidence: 0.75,
    reason: profit > 0.02
      ? `已盈利${(profit * 100).toFixed(2)}%，启用移动止损保护盈利`
      : `按最新ATR(${atr.toFixed(2)})调整，趋势评分${trendStrength.score}/100`,
    trendScore: trendStrength.score,
    profitPercent: profit * 100
  };
}
