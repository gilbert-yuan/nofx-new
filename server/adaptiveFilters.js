/**
 * 自适应过滤器 - 基于历史订单表现动态过滤交易机会
 */

// P3：拉黑（排除）一个币种所需的样本量下限。
// 保留用 minSampleSize（默认5），排除用更严的门槛——避免 5~9 单的短期波动
// 就把一个长期赚钱的币误杀。
const MIN_SAMPLE_SIZE_TO_EXCLUDE = 10;

/**
 * 基于币种历史表现过滤符号列表
 * @param {string[]} symbols - 候选币种列表
 * @param {Array} historicalOrders - 历史订单数组
 * @param {Object} options - 过滤选项
 * @returns {Object} - { filtered: string[], stats: Object }
 */
export function filterSymbolsByPerformance(symbols, historicalOrders, options = {}) {
  const {
    minSampleSize = 5,      // 最小样本量
    minWinRate = 0.35,      // 最低胜率阈值（期望值过滤下仅作统计展示）
    minSampleSizeToExclude = MIN_SAMPLE_SIZE_TO_EXCLUDE,  // 排除所需样本量
    enabled = true          // 是否启用过滤
  } = options;

  if (!enabled || historicalOrders.length === 0) {
    return { filtered: symbols, stats: {}, filteredOut: [] };
  }

  // 统计每个币种的表现
  const symbolStats = {};
  for (const order of historicalOrders.filter(o => o.status === 'closed')) {
    const symbol = order.symbol;
    if (!symbolStats[symbol]) {
      symbolStats[symbol] = {
        symbol,
        count: 0,
        wins: 0,
        totalNet: 0,
        orders: []
      };
    }
    symbolStats[symbol].count++;
    if (order.net > 0) symbolStats[symbol].wins++;
    symbolStats[symbol].totalNet += order.net;
    symbolStats[symbol].orders.push(order);
  }

  // 计算胜率并过滤
  const filtered = [];
  const filteredOut = [];

  // 排除门槛：取配置值与内置下限的较大者，且不小于保留门槛
  const excludeSampleSize = Number.isFinite(minSampleSizeToExclude) && minSampleSizeToExclude > 0
    ? Math.max(minSampleSize, minSampleSizeToExclude)
    : Math.max(minSampleSize, MIN_SAMPLE_SIZE_TO_EXCLUDE);

  const sample = Array.isArray(symbols) ? symbols : [];
  for (const symbol of sample) {
    const stats = symbolStats[symbol];

    if (!stats || stats.count < minSampleSize) {
      // 样本不足，保留
      filtered.push(symbol);
      continue;
    }

    const winRate = stats.wins / stats.count;
    const avgNet = stats.totalNet / stats.count;

    // P1-3：改用期望值(avgNet)过滤，而非单纯胜率。
    // 胜率30%但盈亏比4:1的赚钱币不应被误杀；只有样本足够且净期望为负才排除。
    // P3：排除还要求样本量 >= excludeSampleSize，避免小样本误杀。
    if (avgNet > 0 || stats.count < excludeSampleSize) {
      filtered.push(symbol);
    } else {
      filteredOut.push({
        symbol,
        winRate,
        avgNet,
        count: stats.count,
        reason: `期望收益 ${avgNet.toFixed(2)} USDT/单为负（胜率${(winRate * 100).toFixed(1)}%，样本${stats.count}），停止交易`
      });
    }
  }

  // 增强统计信息
  const enrichedStats = {};
  for (const [symbol, stats] of Object.entries(symbolStats)) {
    if (stats.count >= minSampleSize) {
      enrichedStats[symbol] = {
        ...stats,
        winRate: stats.wins / stats.count,
        avgNet: stats.totalNet / stats.count
      };
    }
  }

  return {
    filtered,
    filteredOut,
    stats: enrichedStats,
    summary: {
      total: symbols.length,
      filtered: filtered.length,
      removed: filteredOut.length,
      minSampleSize,
      minSampleSizeToExclude: excludeSampleSize,
      reason: filteredOut.length > 0 ? `过滤了${filteredOut.length}个负期望值币种` : '无需过滤'
    }
  };
}

/**
 * 识别高胜率时段
 * @param {Array} historicalOrders - 历史订单
 * @param {Object} options - 选项
 * @returns {Object} - { highProbHours: number[], hourStats: Array }
 */
export function identifyHighProbabilityHours(historicalOrders, options = {}) {
  const {
    minSampleSize = 5,
    minWinRate = 0.55,
    enabled = true
  } = options;

  if (!enabled || historicalOrders.length === 0) {
    return { highProbHours: [], hourStats: [], enabled: false };
  }

  const hourStats = Array(24).fill(0).map((_, i) => ({
    hour: i,
    count: 0,
    wins: 0,
    totalNet: 0
  }));

  for (const order of historicalOrders.filter(o => o.status === 'closed')) {
    if (!order.createdAt) continue;
    const hour = new Date(order.createdAt).getUTCHours();
    hourStats[hour].count++;
    if (order.net > 0) hourStats[hour].wins++;
    hourStats[hour].totalNet += order.net;
  }

  // 计算每个时段的胜率
  const enrichedStats = hourStats.map(h => ({
    ...h,
    winRate: h.count > 0 ? h.wins / h.count : 0,
    avgNet: h.count > 0 ? h.totalNet / h.count : 0
  }));

  // P1-3：相对基准——整体胜率的1.2倍才算高胜率时段（避免固定 0.55 阈值封杀一切）
  const closedOrders = historicalOrders.filter(o => o.status === 'closed' && o.net != null);
  const overallWin = closedOrders.length ? closedOrders.filter(o => o.net > 0).length / closedOrders.length : 0;
  const highProbThreshold = Math.max(0.3, 1.2 * overallWin);

  const highProbHours = enrichedStats
    .filter(h => h.count >= minSampleSize && h.winRate >= highProbThreshold)
    .map(h => h.hour);

  return {
    highProbHours,
    hourStats: enrichedStats.filter(h => h.count > 0),
    enabled: true,
    summary: {
      totalHours: enrichedStats.filter(h => h.count >= minSampleSize).length,
      highProbHours: highProbHours.length,
      recommendation: highProbHours.length === 0
        ? '样本不足或无明显高胜率时段'
        : `建议在${highProbHours.join(', ')}时(UTC)交易`
    }
  };
}

/**
 * 检查当前时段是否适合交易
 * @param {number} currentHour - 当前UTC小时
 * @param {Array} historicalOrders - 历史订单
 * @param {Object} options - 选项
 * @returns {Object} - { shouldTrade: boolean, reason: string, currentHourStats: Object }
 */
export function shouldTradeAtCurrentHour(currentHour, historicalOrders, options = {}) {
  const { enabled = true, minSampleSize = 5, minWinRate = 0.55 } = options;

  if (!enabled) {
    return { shouldTrade: true, reason: '时段过滤未启用', currentHourStats: null };
  }

  // P1-3：整体胜率基准（用期望值思路，避免固定 0.55 阈值与整体 22% 胜率脱节）
  const closedOrders = historicalOrders.filter(o => o.status === 'closed' && o.net != null);
  const overallWin = closedOrders.length ? closedOrders.filter(o => o.net > 0).length / closedOrders.length : 0;

  const hourAnalysis = identifyHighProbabilityHours(historicalOrders, options);
  const currentHourStats = hourAnalysis.hourStats.find(h => h.hour === currentHour);

  // 相对基准：当前时段胜率 < 整体胜率×0.8 才封杀（报告P1-3）。整体胜率极低时也不应一刀切全封。
  if (currentHourStats && currentHourStats.count >= minSampleSize && currentHourStats.winRate < 0.8 * Math.max(overallWin, 0.01)) {
    return {
      shouldTrade: false,
      reason: `当前时段${currentHour}:00 UTC胜率${(currentHourStats.winRate * 100).toFixed(1)}%低于整体胜率${(overallWin * 100).toFixed(1)}%的0.8倍，建议等待`,
      currentHourStats,
      highProbHours: hourAnalysis.highProbHours
    };
  }

  if (!hourAnalysis.enabled || hourAnalysis.highProbHours.length === 0) {
    // 无足够数据或无明显高胜率时段，允许交易
    return {
      shouldTrade: true,
      reason: '时段过滤数据不足，允许交易',
      currentHourStats: null
    };
  }

  const isHighProbHour = hourAnalysis.highProbHours.includes(currentHour);

  return {
    shouldTrade: isHighProbHour,
    reason: isHighProbHour
      ? `当前时段${currentHour}:00 UTC为高胜率时段（胜率${(currentHourStats?.winRate * 100 || 0).toFixed(1)}%）`
      : `当前时段${currentHour}:00 UTC非高胜率时段，建议等待`,
    currentHourStats,
    highProbHours: hourAnalysis.highProbHours
  };
}

/**
 * 根据币种历史表现获取自适应参数
 * @param {string} symbol - 币种
 * @param {Array} historicalOrders - 历史订单
 * @param {Object} defaults - 默认参数
 * @returns {Object} - 自适应参数
 */
export function getAdaptiveParametersForSymbol(symbol, historicalOrders, defaults = {}) {
  const {
    defaultStopLossATR = 2.5,
    defaultTakeProfitATR = 4.0,
    defaultMaxHoldBars = 30,
    minSampleSize = 10
  } = defaults;

  const symbolOrders = historicalOrders.filter(
    o => o.symbol === symbol && o.status === 'closed' && o.heldBars != null
  );

  if (symbolOrders.length < minSampleSize) {
    return {
      stopLossATR: defaultStopLossATR,
      takeProfitATR: defaultTakeProfitATR,
      maxHoldBars: defaultMaxHoldBars,
      confidence: 0,
      reason: `样本不足（${symbolOrders.length}/${minSampleSize}），使用默认参数`
    };
  }

  // 分析止损触发率
  const stopLossTouched = symbolOrders.filter(o => isExitReason(o.reason, 'stop')).length;
  const stopLossTouchRate = stopLossTouched / symbolOrders.length;

  // 分析止盈触发率
  const takeProfitTouched = symbolOrders.filter(o => isExitReason(o.reason, 'target')).length;
  const takeProfitTouchRate = takeProfitTouched / symbolOrders.length;

  // 计算平均持仓时长
  const avgHoldBars = symbolOrders.reduce((sum, o) => sum + o.heldBars, 0) / symbolOrders.length;

  // 计算胜率
  const winRate = symbolOrders.filter(o => o.net > 0).length / symbolOrders.length;

  // 自适应调整逻辑
  let stopLossATR = defaultStopLossATR;
  let takeProfitATR = defaultTakeProfitATR;
  let maxHoldBars = defaultMaxHoldBars;
  const adjustments = [];

  // 如果止损触发率过高（>40%），放宽止损
  if (stopLossTouchRate > 0.4) {
    stopLossATR = Math.min(3.5, defaultStopLossATR * 1.3);
    adjustments.push(`止损放宽至${stopLossATR.toFixed(1)}x ATR（触发率${(stopLossTouchRate * 100).toFixed(1)}%过高）`);
  }

  // 如果止盈难以触及（<30%），收紧止盈
  if (takeProfitTouchRate < 0.3) {
    takeProfitATR = Math.max(2.5, defaultTakeProfitATR * 0.8);
    adjustments.push(`止盈收紧至${takeProfitATR.toFixed(1)}x ATR（触及率${(takeProfitTouchRate * 100).toFixed(1)}%过低）`);
  }

  // 如果平均持仓接近上限（>80%），且胜率不佳（<50%），缩短持仓
  if (avgHoldBars > defaultMaxHoldBars * 0.8 && winRate < 0.5) {
    maxHoldBars = Math.floor(avgHoldBars * 0.9);
    adjustments.push(`最大持仓缩短至${maxHoldBars}根（平均${avgHoldBars.toFixed(1)}根接近上限且胜率${(winRate * 100).toFixed(1)}%偏低）`);
  }

  return {
    stopLossATR,
    takeProfitATR,
    maxHoldBars,
    confidence: Math.min(1, symbolOrders.length / minSampleSize),  // P2-3：加1的上限，避免 confidence 越界
    reason: adjustments.length > 0
      ? adjustments.join('；')
      : `基于${symbolOrders.length}笔历史订单，参数保持默认`,
    stats: {
      sampleSize: symbolOrders.length,
      winRate,
      stopLossTouchRate,
      takeProfitTouchRate,
      avgHoldBars
    }
  };
}

function isExitReason(reason, kind) {
  const value = String(reason || '').toLowerCase();
  return kind === 'stop'
    ? value.includes('stop_loss') || value.includes('stop loss') || value.includes('止损')
    : value.includes('take_profit') || value.includes('take profit') || value.includes('止盈');
}

/**
 * 根据市场波动率调整参数
 * @param {number} currentVolatility - 当前波动率
 * @param {number} historicalAvgVolatility - 历史平均波动率
 * @returns {Object} - 调整倍数
 */
export function adjustForVolatility(currentVolatility, historicalAvgVolatility) {
  if (!Number.isFinite(currentVolatility) || !Number.isFinite(historicalAvgVolatility) || historicalAvgVolatility <= 0) {
    return {
      stopLossMultiplier: 1,
      takeProfitMultiplier: 1,
      maxHoldBarsMultiplier: 1,
      reason: '波动率数据无效，不调整参数'
    };
  }

  const volatilityRatio = currentVolatility / historicalAvgVolatility;

  if (volatilityRatio >= 1.5) {
    // 高波动: 放宽止损，缩短持仓
    return {
      stopLossMultiplier: 1.3,
      takeProfitMultiplier: 1.2,
      maxHoldBarsMultiplier: 0.7,
      reason: `市场波动率${(volatilityRatio * 100).toFixed(0)}%高于均值，放宽止损、缩短持仓`
    };
  } else if (volatilityRatio < 0.7) {
    // 低波动: 收紧止损，延长持仓
    return {
      stopLossMultiplier: 0.8,
      takeProfitMultiplier: 0.9,
      maxHoldBarsMultiplier: 1.3,
      reason: `市场波动率${(volatilityRatio * 100).toFixed(0)}%低于均值，收紧止损、延长持仓`
    };
  }

  return {
    stopLossMultiplier: 1,
    takeProfitMultiplier: 1,
    maxHoldBarsMultiplier: 1,
    reason: '市场波动率正常，参数不调整'
  };
}

/**
 * 综合评估是否应该开仓
 * @param {Object} context - 评估上下文
 * @returns {Object} - 评估结果
 */
export function shouldOpenPosition(context) {
  const {
    symbol,
    currentHour,
    historicalOrders,
    options = {}
  } = context;

  const results = {
    shouldOpen: true,
    reasons: [],
    filters: {}
  };

  // 1. 币种过滤
  if (options.symbolFilter?.enabled) {
    const symbolFilter = filterSymbolsByPerformance(
      [symbol],
      historicalOrders,
      options.symbolFilter
    );
    results.filters.symbol = symbolFilter;

    if (!symbolFilter.filtered.includes(symbol)) {
      results.shouldOpen = false;
      results.reasons.push(`币种${symbol}被过滤：${symbolFilter.filteredOut[0]?.reason || '表现不佳'}`);
    }
  }

  // 2. 时段过滤
  if (options.hourFilter?.enabled && currentHour != null) {
    const hourFilter = shouldTradeAtCurrentHour(
      currentHour,
      historicalOrders,
      options.hourFilter
    );
    results.filters.hour = hourFilter;

    if (!hourFilter.shouldTrade) {
      results.shouldOpen = false;
      results.reasons.push(hourFilter.reason);
    }
  }

  return results;
}
