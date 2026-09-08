// Deterministic reference strategy; scores are rule strength, never win probabilities.
export function localAnalysis(market) {
  const rows = market.klines;
  const wait = reason => ({ symbol: market.symbol, action: 'WAIT', confidence: 0, reason, risk: '本地规则仅使用均线和波动率，不代表盈利保证。', plan: null });
  if (rows.length < 50) return wait('本地规则需要至少 50 根已收盘 K 线，请将数量设为 80 或更多。');
  const mean = n => rows.slice(-n).reduce((sum, r) => sum + r.close, 0) / n;
  const fast = mean(20), slow = mean(50), close = rows.at(-1).close;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;
  if (!(atr > 0) || atr / close > 0.08 || Math.abs(fast - slow) < atr * 0.3) return wait('趋势不清晰或波动过大，暂不生成开仓计划。');
  const long = fast > slow;
  if (long ? close < fast : close > fast) return wait('价格与均线趋势不一致，等待确认。');

  // 优化调整：基于历史数据分析
  // 1. 做空表现差（0%胜率），暂时禁用做空
  if (!long) return wait('做空信号暂时禁用，历史表现不佳。');

  const entryMin = close - atr * 0.35, entryMax = close + atr * 0.35;
  return { symbol: market.symbol, action: long ? 'BUY' : 'SELL', confidence: Math.min(0.85, 0.65 + Math.abs(fast - slow) / atr * 0.03),
    reason: `本地规则：20 根均线${long ? '高于' : '低于'}50 根均线，收盘价与趋势同向。`,
    risk: '均线趋势可能反转；以 14 根平均真实波幅设置保护价格。规则分数不是胜率。',
    // 优化调整：
    // 2. 止损从 1.5 ATR 放宽到 2.5 ATR（减少过早止损）
    // 3. 止盈从 3 ATR 扩大到 4 ATR（匹配更大止损的盈亏比）
    // 4. maxHoldBars 从 12 缩短到 30（实际平均持仓17根，给予适当缓冲）
    plan: { entryMin, entryMax, stopLoss: long ? entryMin - atr * 2.5 : entryMax + atr * 2.5,
      takeProfit: long ? entryMax + atr * 4 : entryMin - atr * 4, validForBars: 3, maxHoldBars: 30 } };
}

// 多周期分析版本：引入15分钟、1小时、4小时辅助判断
export function localAnalysisMultiTimeframe(market, auxMarkets = {}) {
  const rows = market.klines;
  const wait = reason => ({ symbol: market.symbol, action: 'WAIT', confidence: 0, reason, risk: '多周期规则使用均线和波动率，不代表盈利保证。', plan: null });

  // 主周期检查
  if (rows.length < 50) return wait('主周期需要至少 50 根已收盘 K 线。');

  const mean = (data, n) => data.slice(-n).reduce((sum, r) => sum + r.close, 0) / n;
  const calcATR = (data, periods = 14) => {
    if (data.length < periods + 1) return null;
    return data.slice(-periods).reduce((sum, r, i) => {
      const previous = data[data.length - periods - 1 + i].close;
      return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
    }, 0) / periods;
  };

  // 主周期指标
  const fast = mean(rows, 20), slow = mean(rows, 50), close = rows.at(-1).close;
  const atr = calcATR(rows);

  if (!(atr > 0) || atr / close > 0.08) return wait('主周期波动过大或ATR计算失败。');
  if (Math.abs(fast - slow) < atr * 0.3) return wait('主周期趋势不清晰。');

  const mainTrend = fast > slow ? 'long' : 'short';
  if (mainTrend === 'long' ? close < fast : close > fast) return wait('主周期价格与均线趋势不一致。');

  // 辅助周期分析
  const auxAnalysis = {};
  const intervals = ['15m', '1h', '4h'];

  for (const interval of intervals) {
    if (!auxMarkets[interval] || !auxMarkets[interval].klines || auxMarkets[interval].klines.length < 50) {
      auxAnalysis[interval] = { trend: 'unknown', reason: '数据不足' };
      continue;
    }

    const auxRows = auxMarkets[interval].klines;
    const auxFast = mean(auxRows, 20);
    const auxSlow = mean(auxRows, 50);
    const auxClose = auxRows.at(-1).close;
    const auxATR = calcATR(auxRows);

    if (!auxATR || auxATR / auxClose > 0.08) {
      auxAnalysis[interval] = { trend: 'unknown', reason: '波动过大' };
      continue;
    }

    const auxTrendDirection = auxFast > auxSlow ? 'long' : 'short';
    const auxTrendStrength = Math.abs(auxFast - auxSlow) / auxATR;
    const priceAlignment = auxTrendDirection === 'long' ? auxClose >= auxFast : auxClose <= auxFast;

    auxAnalysis[interval] = {
      trend: auxTrendDirection,
      strength: auxTrendStrength,
      aligned: priceAlignment,
      reason: `${auxTrendDirection === 'long' ? '上升' : '下降'}趋势，强度${auxTrendStrength.toFixed(2)}`
    };
  }

  // 多周期共振判断
  const higherTimeframes = ['1h', '4h'];
  const alignedCount = higherTimeframes.filter(int => auxAnalysis[int]?.trend === mainTrend).length;
  const strongAligned = higherTimeframes.filter(int =>
    auxAnalysis[int]?.trend === mainTrend &&
    auxAnalysis[int]?.aligned &&
    auxAnalysis[int]?.strength > 0.5
  ).length;

  // 趋势过滤规则
  if (alignedCount === 0) {
    return wait(`主周期${mainTrend === 'long' ? '多头' : '空头'}，但1小时和4小时周期均不支持，等待多周期共振。`);
  }

  // 做空仍然禁用
  if (mainTrend === 'short') return wait('做空信号暂时禁用，历史表现不佳。');

  // 计算置信度：基于多周期共振
  let baseConfidence = 0.65;
  baseConfidence += Math.abs(fast - slow) / atr * 0.03; // 主周期趋势强度
  baseConfidence += alignedCount * 0.05; // 每个共振周期+5%
  baseConfidence += strongAligned * 0.05; // 每个强共振周期+5%

  const confidence = Math.min(0.95, baseConfidence);

  const entryMin = close - atr * 0.35, entryMax = close + atr * 0.35;
  const long = mainTrend === 'long';

  const reasonDetail = [
    `主周期：20MA${long ? '>' : '<'}50MA`,
    `15分钟：${auxAnalysis['15m']?.reason || '无数据'}`,
    `1小时：${auxAnalysis['1h']?.reason || '无数据'}`,
    `4小时：${auxAnalysis['4h']?.reason || '无数据'}`,
    `共振度：${alignedCount}/2个高级周期一致`
  ].join('；');

  return {
    symbol: market.symbol,
    action: long ? 'BUY' : 'SELL',
    confidence,
    reason: `多周期分析：${reasonDetail}`,
    risk: '多周期共振可提高胜率但不保证盈利；止损止盈基于主周期ATR设置。',
    multiTimeframeAnalysis: auxAnalysis,
    plan: {
      entryMin,
      entryMax,
      stopLoss: long ? entryMin - atr * 2.5 : entryMax + atr * 2.5,
      takeProfit: long ? entryMax + atr * 4 : entryMin - atr * 4,
      validForBars: 3,
      maxHoldBars: 30
    }
  };
}

export function recommendedLeverage(plan, direction) {
  if (!plan) return 1;
  const entry = direction === 'OPEN_SHORT' ? plan.entryMin : plan.entryMax;
  const distance = Math.abs(entry - plan.stopLoss) / entry;
  // Target a <=10% margin loss at the planned stop before costs, capped at 5x.
  return Number.isFinite(distance) && distance > 0 ? Math.max(1, Math.min(5, Math.floor(0.1 / distance))) : 1;
}
