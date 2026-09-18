/**
 * 策略机会的二次确认层。
 *
 * 现有策略负责「选币 + 初步方向 + 风控计划」，本模块不重新选币，也不下单；
 * 它只把策略信号和最新价格/24h/OI/资金费率整理成可读的继续或等待结论。
 */

/**
 * 把一个已通过策略计划校验的信号整理成机会报告。
 *
 * @param {Object} args
 * @param {Object} args.signal createResearchRecord 归一化后的信号
 * @param {Object} args.market 使用计划周期的已收盘行情
 * @param {Object} [args.marketContext] BinanceMarket.opportunityContext() 返回值
 * @param {Object} [args.strategy] 策略定义（用于展示名称）
 * @param {number} [args.now=Date.now()]
 * @returns {Object|null} WAIT/无计划信号不生成机会报告
 */
export function buildOpportunityReport({ signal, market, marketContext = {}, strategy = {}, now = Date.now() } = {}) {
  const action = normalizeAction(signal);
  const plan = signal?.plan;
  const closedPrice = finitePositive(market?.klines?.at(-1)?.close);
  if (!['BUY', 'SELL'].includes(action) || !hasUsablePlan(plan) || closedPrice == null) return null;

  const long = action === 'BUY';
  const entryMin = finitePositive(plan.entryMin);
  const entryMax = finitePositive(plan.entryMax);
  const entryLimit = finitePositive(plan.entryLimit);
  const optimalEntry = entryLimit ?? midpoint(entryMin, entryMax) ?? closedPrice;
  const entryRange = entryMin != null && entryMax != null ? { min: entryMin, max: entryMax } : null;
  const context = normalizeMarketContext(marketContext);
  const currentPrice = context.lastPrice ?? context.markPrice ?? closedPrice;
  const takeProfits = collectTakeProfits(plan, long);
  const warnings = buildWarnings(context, action);
  const momentumCrowded = context.change24hPct != null && context.change24hPct >= 10
    && context.oiChangePct != null && context.oiChangePct >= 20
    && context.fundingRate != null && context.fundingRate > 0;
  const priceExtended = entryLimit != null
    ? (long ? currentPrice > entryLimit * 1.001 : currentPrice < entryLimit * 0.999)
    : (long ? currentPrice > entryMax * 1.001 : currentPrice < entryMin * 0.999);
  const waitForBetterPrice = long ? priceExtended || momentumCrowded : priceExtended;
  const decision = resolveDecision({ action, waitForBetterPrice, momentumCrowded });
  const levels = {
    entryRange,
    optimalEntry,
    entryMode: entryLimit != null ? 'LIMIT_PULLBACK' : 'MARKET_OR_NEXT_OPEN',
    stopLoss: finitePositive(plan.stopLoss),
    takeProfits,
    riskUnit: finitePositive(plan.riskUnit)
  };

  const trend = action === 'BUY' ? 'LONG' : 'SHORT';
  const summary = buildSummary({
    symbol: signal.symbol || market.symbol,
    action,
    decision,
    currentPrice,
    optimalEntry,
    entryRange,
    levels,
    context,
    warnings
  });

  return {
    generatedAt: new Date(now).toISOString(),
    dataAsOf: signal.dataAsOf || market.dataAsOf || null,
    symbol: signal.symbol || market.symbol,
    exchange: signal.exchange || market.exchange || 'binance',
    marketProvider: signal.marketProvider || market.marketProvider || 'binance',
    interval: signal.interval || market.interval,
    strategyId: signal.strategyId || strategy.id || null,
    strategyName: strategy.name || signal.strategyName || null,
    action,
    trend,
    confidence: finiteNumber(signal.confidence) ?? 0,
    recommendation: decision.canProceed ? action : 'HOLD',
    canProceed: decision.canProceed,
    decision,
    current: {
      price: currentPrice,
      change24hPct: context.change24hPct,
      oiChangePct: context.oiChangePct,
      fundingRate: context.fundingRate,
      markPrice: context.markPrice
    },
    levels,
    warnings,
    strategyReason: String(signal.reason || ''),
    risk: String(signal.risk || ''),
    summary,
    contextErrors: context.errors
  };
}

/**
 * 把机会报告里的参考价和保护价转换成实际下单使用的计划。
 *
 * 订单仍保留原始策略信号和报告用于审计；这里只生成 executionPlan，
 * 让模拟撮合和 Binance Paper Sync 使用同一组入场、止损、止盈价格。
 */
export function buildExecutionPlanFromOpportunity(signal) {
  const basePlan = signal?.plan;
  const levels = signal?.opportunityReport?.levels;
  if (!basePlan || !levels || typeof levels !== 'object') return null;

  const entry = finitePositive(levels.optimalEntry);
  if (entry == null) return null;

  const plan = { ...basePlan, entryLimit: entry };
  const stopLoss = finitePositive(levels.stopLoss);
  if (stopLoss != null) plan.stopLoss = stopLoss;

  const takeProfits = Array.isArray(levels.takeProfits)
    ? levels.takeProfits.map(finitePositive).filter(value => value != null)
    : [];
  if (takeProfits.length) {
    // 最后一档作为主止盈；前面档位保留给现有分批止盈/复核逻辑。
    plan.takeProfit = takeProfits.at(-1);
    for (const [index, key] of ['takeProfit1', 'takeProfit2', 'takeProfit3'].entries()) {
      if (takeProfits[index] != null) plan[key] = takeProfits[index];
      else delete plan[key];
    }
  }
  return plan;
}

function normalizeAction(signal) {
  const action = String(signal?.action || '').toUpperCase();
  if (action === 'BUY' || action === 'SELL') return action;
  const position = String(signal?.positionRecommendation || '').toUpperCase();
  return position === 'OPEN_LONG' ? 'BUY' : position === 'OPEN_SHORT' ? 'SELL' : 'WAIT';
}

function hasUsablePlan(plan) {
  if (!plan || typeof plan !== 'object') return false;
  const required = ['entryMin', 'entryMax', 'stopLoss'];
  if (required.some(key => finitePositive(plan[key]) == null)) return false;
  const takeProfitKeys = ['takeProfit', 'takeProfit1', 'takeProfit2', 'takeProfit3'];
  if (!takeProfitKeys.some(key => finitePositive(plan[key]) != null)) return false;
  return Number(plan.entryMin) <= Number(plan.entryMax);
}

function resolveDecision({ action, waitForBetterPrice, momentumCrowded }) {
  if (action === 'BUY') {
    if (waitForBetterPrice) return {
      code: 'WAIT_PULLBACK',
      label: '偏多，但不追涨，等待回踩后做多',
      canProceed: false,
      reason: momentumCrowded
        ? '24h 拉升、OI 快速增加且资金费率为正，多头可能拥挤，等待回踩确认。'
        : '当前价高于理想做多价，等待回踩确认，不直接追多。'
    };
    return { code: 'BUY_NOW', label: '可以考虑做多', canProceed: true, reason: '价格已接近策略给出的做多参考区域。' };
  }

  if (waitForBetterPrice) return {
    code: 'WAIT_REBOUND',
    label: '偏空，但不追空，等待反弹后做空',
    canProceed: false,
    reason: '当前价低于理想做空价，等待反弹确认，不直接追空。'
  };
  return { code: 'SELL_NOW', label: '可以考虑做空', canProceed: true, reason: '价格已接近策略给出的做空参考区域。' };
}

function buildSummary({ symbol, action, decision, currentPrice, optimalEntry, entryRange, levels, context, warnings }) {
  const direction = action === 'BUY' ? '做多' : '做空';
  const parts = [
    `${symbol} 初步判断${direction}`,
    `当前价 ${formatPrice(currentPrice)}`,
    `理想入场 ${formatRange(entryRange) || formatPrice(optimalEntry)}`,
    `参考挂单 ${formatPrice(optimalEntry)}`,
    `止损 ${formatPrice(levels.stopLoss)}`,
    `止盈 ${levels.takeProfits.length ? levels.takeProfits.map(formatPrice).join(' / ') : '—'}`
  ];
  if (context.change24hPct != null) parts.splice(1, 0, `24h ${formatSignedPct(context.change24hPct)}`);
  if (context.oiChangePct != null) parts.splice(2, 0, `OI ${formatSignedPct(context.oiChangePct)}`);
  if (context.fundingRate != null) parts.splice(3, 0, `资金费率 ${formatFunding(context.fundingRate)}`);
  parts.push(`结论：${decision.label}`);
  if (warnings.length) parts.push(`风险提示：${warnings.join('；')}`);
  return parts.join('；') + '。';
}

function normalizeMarketContext(raw = {}) {
  const ticker = raw.ticker24h || {};
  const premium = raw.premium || {};
  const fundingRows = Array.isArray(raw.funding) ? raw.funding : [];
  const oiRows = Array.isArray(raw.oi) ? raw.oi : Array.isArray(raw.openInterest) ? raw.openInterest : [];
  const latestFunding = fundingRows.at(-1) || {};
  const latestOi = oiRows.at(-1) || {};
  const previousOi = oiRows.length > 1 ? oiRows.at(-2) : null;
  const oiLatest = finiteNumber(latestOi.sumOpenInterestValue) ?? finiteNumber(latestOi.sumOpenInterest);
  const oiPrevious = finiteNumber(previousOi?.sumOpenInterestValue) ?? finiteNumber(previousOi?.sumOpenInterest);
  const oiChangePct = oiLatest != null && oiPrevious != null && oiPrevious > 0
    ? (oiLatest / oiPrevious - 1) * 100
    : null;
  return {
    lastPrice: finitePositive(ticker.lastPrice),
    change24hPct: finiteNumber(ticker.priceChangePercent),
    oiChangePct,
    fundingRate: finiteNumber(premium.lastFundingRate) ?? finiteNumber(latestFunding.fundingRate),
    markPrice: finitePositive(premium.markPrice),
    errors: raw.errors && typeof raw.errors === 'object' ? raw.errors : {}
  };
}

function buildWarnings(context, action) {
  const warnings = [];
  if (context.change24hPct != null && Math.abs(context.change24hPct) >= 15) {
    warnings.push(`24h 波动 ${formatSignedPct(context.change24hPct)}，高波动风险较高`);
  }
  if (context.change24hPct != null && context.change24hPct >= 10
    && context.oiChangePct != null && context.oiChangePct >= 20) {
    warnings.push('拉升伴随 OI 快速增加，新仓位集中进入，追涨风险较高');
  }
  if (context.fundingRate != null && context.fundingRate > 0.0005) {
    warnings.push(action === 'BUY' ? '资金费率明显为正，多头可能拥挤' : '资金费率为正，空头需注意反向挤压');
  }
  return warnings;
}

function collectTakeProfits(plan, long) {
  const values = ['takeProfit1', 'takeProfit2', 'takeProfit3', 'takeProfit']
    .map(key => finitePositive(plan[key]))
    .filter(value => value != null);
  return [...new Set(values)].sort((a, b) => long ? a - b : b - a);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePositive(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function midpoint(a, b) {
  return a != null && b != null ? (a + b) / 2 : null;
}

function formatRange(range) {
  return range ? `${formatPrice(range.min)}～${formatPrice(range.max)}` : '';
}

function formatPrice(value) {
  return value == null ? '—' : Number(value).toPrecision(8).replace(/\.?(0+)(e|$)/, '$2');
}

function formatSignedPct(value) {
  return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
}

function formatFunding(value) {
  return `${(value * 100).toFixed(4)}%`;
}
