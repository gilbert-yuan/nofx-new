/**
 * Deterministic volume/price pattern analysis.
 * These are configurable pattern matches, not proof of coordinated trading or
 * statistically calibrated probabilities.
 */
export const FLOW_ANALYSIS_INTERVALS = ['1m', '5m', '1h', '1d'];

export const DEFAULT_FLOW_ANALYSIS_PARAMS = Object.freeze({
  lookbackBars: 20,
  recentBars: 5,
  minBars: 30,
  consolidationRangeMaxPct: 8,
  accumulationVolumeRatioMin: 0.65,
  accumulationVolumeRatioMax: 1.4,
  accumulationGentleVolumeRatioMin: 1.05,
  accumulationGentleVolumeRatioMax: 1.8,
  positiveFlowRatioMin: 0.02,
  washoutDropMinPct: 3,
  washoutVolumeRatioMax: 1.05,
  washoutRecoveryRatioMin: 0.65,
  breakoutVolumeRatioMin: 1.5,
  breakoutRiseMinPct: 2,
  distributionVolumeRatioMin: 2,
  distributionStallMaxPct: 1,
  distributionUpperWickMin: 0.45,
  distributionTurnoverRateMinPct: 5,
  largeRiseMinPct: 8,
  forecastMediumScore: 40,
  forecastHighScore: 70,
  lookaheadBarsByInterval: Object.freeze({ '1m': 60, '5m': 48, '1h': 72, '1d': 20 })
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : null;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (value, base) => base > 0 ? (value / base - 1) * 100 : null;

function normalizeParams(input = {}) {
  const p = { ...DEFAULT_FLOW_ANALYSIS_PARAMS };
  const bounds = {
    lookbackBars: [10, 100], recentBars: [2, 12], minBars: [20, 500],
    consolidationRangeMaxPct: [0.5, 40], accumulationVolumeRatioMin: [0.1, 5],
    accumulationVolumeRatioMax: [0.2, 10], positiveFlowRatioMin: [0, 0.8],
    accumulationGentleVolumeRatioMin: [0.5, 10], accumulationGentleVolumeRatioMax: [0.5, 15],
    washoutDropMinPct: [0.5, 30], washoutVolumeRatioMax: [0.1, 5],
    washoutRecoveryRatioMin: [0.1, 1], breakoutVolumeRatioMin: [1, 10],
    breakoutRiseMinPct: [0.1, 30], distributionVolumeRatioMin: [1, 10],
    distributionStallMaxPct: [0.1, 10], distributionUpperWickMin: [0.1, 0.95],
    distributionTurnoverRateMinPct: [0.1, 50],
    largeRiseMinPct: [2, 50], forecastMediumScore: [10, 80], forecastHighScore: [20, 100]
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = numeric(input[key]);
    if (value !== null) p[key] = clamp(value, min, max);
  }
  p.lookbackBars = Math.round(p.lookbackBars);
  p.recentBars = Math.round(p.recentBars);
  p.minBars = Math.round(p.minBars);
  const horizons = input.lookaheadBarsByInterval || {};
  p.lookaheadBarsByInterval = Object.fromEntries(FLOW_ANALYSIS_INTERVALS.map(interval => {
    const value = numeric(horizons[interval]);
    return [interval, value === null
      ? DEFAULT_FLOW_ANALYSIS_PARAMS.lookaheadBarsByInterval[interval]
      : Math.round(clamp(value, 1, 500))];
  }));
  if (p.accumulationVolumeRatioMax < p.accumulationVolumeRatioMin) {
    [p.accumulationVolumeRatioMin, p.accumulationVolumeRatioMax] = [p.accumulationVolumeRatioMax, p.accumulationVolumeRatioMin];
  }
  if (p.accumulationGentleVolumeRatioMax < p.accumulationGentleVolumeRatioMin) {
    [p.accumulationGentleVolumeRatioMin, p.accumulationGentleVolumeRatioMax] = [p.accumulationGentleVolumeRatioMax, p.accumulationGentleVolumeRatioMin];
  }
  if (p.forecastHighScore <= p.forecastMediumScore) p.forecastHighScore = Math.min(100, p.forecastMediumScore + 1);
  return p;
}

function normalizeCandles(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({
      ...row,
      openTime: numeric(row.openTime ?? row.timestamp ?? row.time ?? row.date),
      open: numeric(row.open), high: numeric(row.high), low: numeric(row.low), close: numeric(row.close),
      volume: numeric(row.volume), quoteVolume: numeric(row.quoteVolume ?? row.quote_volume),
      takerBuyVolume: numeric(row.takerBuyVolume ?? row.taker_buy_volume),
      takerBuyQuoteVolume: numeric(row.takerBuyQuoteVolume ?? row.taker_buy_quote_volume),
      turnoverRate: numeric(row.turnoverRate ?? row.turnover_rate),
      netFlow: numeric(row.netFlow ?? row.net_flow)
    }))
    .filter(row => row.open !== null && row.high !== null && row.low !== null && row.close !== null
      && row.volume !== null && row.volume >= 0 && row.open > 0 && row.close > 0)
    .filter(row => row.confirmed !== false)
    .sort((a, b) => (a.openTime ?? 0) - (b.openTime ?? 0))
    .slice(-500);
}

function candleFlow(candle) {
  const quoteVolume = candle.quoteVolume ?? (candle.volume * candle.close);
  const takerBuyQuoteVolume = candle.takerBuyQuoteVolume
    ?? (candle.takerBuyVolume === null ? null : candle.takerBuyVolume * candle.close);
  const netFlow = candle.netFlow ?? (takerBuyQuoteVolume === null ? null : takerBuyQuoteVolume - (quoteVolume - takerBuyQuoteVolume));
  return { quoteVolume, takerBuyQuoteVolume, netFlow };
}

function metricsFor(candles, params) {
  const latest = candles.at(-1);
  const recent = candles.slice(-params.recentBars);
  const previous = candles.slice(-(params.lookbackBars + params.recentBars), -params.recentBars);
  const priorWindow = candles.slice(-(params.lookbackBars + 1), -1);
  const recentVol = average(recent.map(row => row.volume));
  const recentSplit = Math.max(1, Math.floor(recent.length / 2));
  const earlyRecentVolume = average(recent.slice(0, recentSplit).map(row => row.volume));
  const lateRecentVolume = average(recent.slice(recentSplit).map(row => row.volume));
  const gentleVolumeRatio = earlyRecentVolume > 0 && lateRecentVolume !== null ? lateRecentVolume / earlyRecentVolume : null;
  const baselineVol = average(previous.map(row => row.volume));
  const volumeRatio = baselineVol > 0 && recentVol !== null ? recentVol / baselineVol : null;
  const recentQuotes = recent.map(candleFlow);
  const totalQuote = recentQuotes.reduce((sum, row) => sum + (row.quoteVolume || 0), 0);
  const netFlows = recentQuotes.map(row => row.netFlow).filter(value => value !== null);
  const netFlow = netFlows.length ? netFlows.reduce((sum, value) => sum + value, 0) : null;
  const netFlowRatio = netFlow !== null && totalQuote > 0 ? netFlow / totalQuote : null;
  const buyQuote = recentQuotes.reduce((sum, row) => sum + (row.takerBuyQuoteVolume || 0), 0);
  const takerBuyRatio = totalQuote > 0 && recentQuotes.some(row => row.takerBuyQuoteVolume !== null)
    ? buyQuote / totalQuote : null;
  const high = Math.max(...recent.map(row => row.high));
  const low = Math.min(...recent.map(row => row.low));
  const rangePct = low > 0 ? (high / low - 1) * 100 : null;
  const returnPct = candles.length > params.recentBars
    ? pct(latest.close, candles.at(-params.recentBars - 1).close) : null;
  const priorHigh = priorWindow.length ? Math.max(...priorWindow.map(row => row.high)) : null;
  const priorLow = priorWindow.length ? Math.min(...priorWindow.map(row => row.low)) : null;
  const nearHighRatio = priorHigh && priorLow !== null && priorHigh > priorLow
    ? (latest.close - priorLow) / (priorHigh - priorLow) : null;
  const candleRange = Math.max(Number.EPSILON, latest.high - latest.low);
  const upperWickRatio = (latest.high - Math.max(latest.open, latest.close)) / candleRange;
  const latestTurnover = recent.map(row => row.turnoverRate).filter(value => value !== null);
  const averageTurnoverRate = average(latestTurnover);

  return {
    latestPrice: latest.close,
    latestTime: latest.openTime,
    volumeRatio,
    gentleVolumeRatio,
    recentVolume: recentVol,
    baselineVolume: baselineVol,
    recentRangePct: rangePct,
    recentReturnPct: returnPct,
    priorHigh,
    priorLow,
    nearHighRatio,
    upperWickRatio,
    netFlow,
    netFlowRatio,
    takerBuyRatio,
    averageTurnoverRate,
    latestQuoteVolume: candleFlow(latest).quoteVolume,
    hasFlowData: netFlows.length > 0,
    hasTurnoverData: latestTurnover.length > 0
  };
}

function scorePatterns(candles, metrics, params) {
  const { volumeRatio: vr, recentRangePct: range, recentReturnPct: ret, priorHigh, priorLow,
    nearHighRatio, upperWickRatio, netFlowRatio } = metrics;
  const volumeKnown = vr !== null;
  const flowKnown = netFlowRatio !== null;

  const accumulation = Math.round(
    (range !== null && range <= params.consolidationRangeMaxPct ? 30 : 0)
    + (volumeKnown && vr >= params.accumulationVolumeRatioMin && vr <= params.accumulationVolumeRatioMax ? 20 : 0)
    + (metrics.gentleVolumeRatio !== null && metrics.gentleVolumeRatio >= params.accumulationGentleVolumeRatioMin
      && metrics.gentleVolumeRatio <= params.accumulationGentleVolumeRatioMax ? 25 : 0)
    + (flowKnown && netFlowRatio >= params.positiveFlowRatioMin ? 15 : flowKnown ? 0 : 5)
    + (nearHighRatio !== null && nearHighRatio >= 0.35 && nearHighRatio <= 0.85 ? 10 : 0)
  );

  let washoutScore = 0;
  let washout = null;
  if (candles.length >= params.recentBars + 3) {
    const start = Math.max(1, candles.length - Math.min(params.recentBars, 4));
    let troughIndex = start;
    for (let i = start + 1; i < candles.length; i++) if (candles[i].low < candles[troughIndex].low) troughIndex = i;
    const preTrough = candles.slice(Math.max(0, troughIndex - params.lookbackBars), troughIndex);
    const peak = preTrough.length ? Math.max(...preTrough.map(row => row.high)) : null;
    const trough = candles[troughIndex]?.low;
    const dropPct = peak && trough < peak ? (peak - trough) / peak * 100 : 0;
    const recoveryRatio = peak && peak > trough ? (candles.at(-1).close - trough) / (peak - trough) : 0;
    const decliningAtTrough = candles[troughIndex].close < candles[troughIndex].open;
    const troughVolumeRatio = metrics.baselineVolume > 0 ? candles[troughIndex].volume / metrics.baselineVolume : null;
    washoutScore = Math.round(
      (dropPct >= params.washoutDropMinPct ? 35 : 0)
      + (decliningAtTrough && troughVolumeRatio !== null && troughVolumeRatio <= params.washoutVolumeRatioMax ? 25 : 0)
      + (recoveryRatio >= params.washoutRecoveryRatioMin ? 30 : 0)
      + (candles.at(-1).close > candles[troughIndex].close ? 10 : 0)
    );
    washout = { dropPct, recoveryRatio, troughPrice: trough, peakPrice: peak, troughVolumeRatio };
  }

  const breakout = priorHigh !== null && candles.at(-1).close > priorHigh;
  const markup = Math.round(
    (breakout ? 35 : 0)
    + (volumeKnown && vr >= params.breakoutVolumeRatioMin ? 30 : 0)
    + (ret !== null && ret >= params.breakoutRiseMinPct ? 25 : 0)
    + (flowKnown && netFlowRatio > 0 ? 10 : 0)
  );

  const distribution = Math.round(
    (nearHighRatio !== null && nearHighRatio >= 0.75 ? 25 : 0)
    + (volumeKnown && vr >= params.distributionVolumeRatioMin ? 25 : 0)
    + (ret !== null && Math.abs(ret) <= params.distributionStallMaxPct ? 20 : 0)
    + (upperWickRatio >= params.distributionUpperWickMin ? 20 : 0)
    + (metrics.hasTurnoverData && metrics.averageTurnoverRate >= params.distributionTurnoverRateMinPct ? 10 : 0)
  );

  const eligibility = {
    accumulation: range !== null && range <= params.consolidationRangeMaxPct
      && volumeKnown && vr >= params.accumulationVolumeRatioMin && vr <= params.accumulationVolumeRatioMax
      && metrics.gentleVolumeRatio !== null && metrics.gentleVolumeRatio >= params.accumulationGentleVolumeRatioMin
      && metrics.gentleVolumeRatio <= params.accumulationGentleVolumeRatioMax,
    washout: washout !== null && washout.dropPct >= params.washoutDropMinPct
      && washout.troughVolumeRatio !== null && washout.troughVolumeRatio <= params.washoutVolumeRatioMax
      && washout.recoveryRatio >= params.washoutRecoveryRatioMin,
    markup: breakout && volumeKnown && vr >= params.breakoutVolumeRatioMin
      && ret !== null && ret >= params.breakoutRiseMinPct,
    distribution: nearHighRatio !== null && nearHighRatio >= 0.75
      && volumeKnown && vr >= params.distributionVolumeRatioMin
      && (ret !== null && Math.abs(ret) <= params.distributionStallMaxPct
        || upperWickRatio >= params.distributionUpperWickMin)
  };

  return {
    accumulation,
    washout: washoutScore,
    markup,
    distribution,
    eligibility,
    washoutMetrics: washout,
    confirmedBreakout: breakout
  };
}

const PATTERN_LABELS = {
  accumulation: '吸筹型量价特征',
  washout: '洗盘后收复型特征',
  markup: '放量突破型拉升特征',
  distribution: '高位派发风险特征'
};

function analyzeInterval(interval, rawRows, params) {
  const candles = normalizeCandles(rawRows);
  if (!candles.length) return {
    interval, usableBars: 0, label: '数据不足', confidence: 0,
    metrics: {}, patterns: [], warnings: ['该周期没有可用的已收盘 K 线。']
  };
  const metrics = metricsFor(candles, params);
  const scores = scorePatterns(candles, metrics, params);
  const patterns = Object.entries({
    accumulation: scores.accumulation, washout: scores.washout,
    markup: scores.markup, distribution: scores.distribution
  }).map(([key, score]) => ({ key, label: PATTERN_LABELS[key], score, eligible: scores.eligibility[key] }))
    .sort((a, b) => b.score - a.score);
  const primary = candles.length < params.minBars ? null : patterns.find(pattern => pattern.eligible && pattern.score >= 45) || null;
  const washout = scores.washoutMetrics;
  const evidence = [
    {
      key: 'accumulation', label: PATTERN_LABELS.accumulation, score: scores.accumulation,
      conditions: [
        { label: '近端价格窄幅整理', value: metrics.recentRangePct, threshold: params.consolidationRangeMaxPct, unit: '%', matched: metrics.recentRangePct !== null && metrics.recentRangePct <= params.consolidationRangeMaxPct },
        { label: '近端量能处于设定区间', value: metrics.volumeRatio, threshold: `${params.accumulationVolumeRatioMin}–${params.accumulationVolumeRatioMax}`, unit: '倍', matched: metrics.volumeRatio !== null && metrics.volumeRatio >= params.accumulationVolumeRatioMin && metrics.volumeRatio <= params.accumulationVolumeRatioMax },
        { label: '整理后段温和放量', value: metrics.gentleVolumeRatio, threshold: `${params.accumulationGentleVolumeRatioMin}–${params.accumulationGentleVolumeRatioMax}`, unit: '倍', matched: metrics.gentleVolumeRatio !== null && metrics.gentleVolumeRatio >= params.accumulationGentleVolumeRatioMin && metrics.gentleVolumeRatio <= params.accumulationGentleVolumeRatioMax },
        { label: '净流入占成交额比例', value: metrics.netFlowRatio, threshold: params.positiveFlowRatioMin, unit: '比值', available: metrics.netFlowRatio !== null, matched: metrics.netFlowRatio !== null && metrics.netFlowRatio >= params.positiveFlowRatioMin },
        { label: '收盘位于整理区间中上部', value: metrics.nearHighRatio, threshold: '0.35–0.85', unit: '比值', matched: metrics.nearHighRatio !== null && metrics.nearHighRatio >= 0.35 && metrics.nearHighRatio <= 0.85 }
      ]
    },
    {
      key: 'washout', label: PATTERN_LABELS.washout, score: scores.washout,
      conditions: [
        { label: '近端急跌幅度', value: washout?.dropPct ?? null, threshold: params.washoutDropMinPct, unit: '%', matched: (washout?.dropPct ?? 0) >= params.washoutDropMinPct },
        { label: '低点下跌量能 / 基准量', value: washout?.troughVolumeRatio ?? null, threshold: params.washoutVolumeRatioMax, unit: '倍', matched: washout?.troughVolumeRatio !== null && washout?.troughVolumeRatio <= params.washoutVolumeRatioMax },
        { label: '从低点收复回撤比例', value: washout?.recoveryRatio ?? null, threshold: params.washoutRecoveryRatioMin, unit: '比值', matched: (washout?.recoveryRatio ?? 0) >= params.washoutRecoveryRatioMin }
      ]
    },
    {
      key: 'markup', label: PATTERN_LABELS.markup, score: scores.markup,
      conditions: [
        { label: '收盘站上前序区间高点', value: metrics.latestPrice, threshold: metrics.priorHigh, unit: '价格', matched: scores.confirmedBreakout },
        { label: '近端量比', value: metrics.volumeRatio, threshold: params.breakoutVolumeRatioMin, unit: '倍', matched: metrics.volumeRatio !== null && metrics.volumeRatio >= params.breakoutVolumeRatioMin },
        { label: '近端价格涨幅', value: metrics.recentReturnPct, threshold: params.breakoutRiseMinPct, unit: '%', matched: metrics.recentReturnPct !== null && metrics.recentReturnPct >= params.breakoutRiseMinPct },
        { label: '净资金流为正', value: metrics.netFlowRatio, threshold: 0, unit: '比值', available: metrics.netFlowRatio !== null, matched: metrics.netFlowRatio !== null && metrics.netFlowRatio > 0 }
      ]
    },
    {
      key: 'distribution', label: PATTERN_LABELS.distribution, score: scores.distribution,
      conditions: [
        { label: '收盘位于前序区间高位', value: metrics.nearHighRatio, threshold: 0.75, unit: '比值', matched: metrics.nearHighRatio !== null && metrics.nearHighRatio >= 0.75 },
        { label: '近端量比', value: metrics.volumeRatio, threshold: params.distributionVolumeRatioMin, unit: '倍', matched: metrics.volumeRatio !== null && metrics.volumeRatio >= params.distributionVolumeRatioMin },
        { label: '价格滞涨幅度', value: metrics.recentReturnPct === null ? null : Math.abs(metrics.recentReturnPct), threshold: params.distributionStallMaxPct, unit: '%', matched: metrics.recentReturnPct !== null && Math.abs(metrics.recentReturnPct) <= params.distributionStallMaxPct },
        { label: '最新 K 线上影占振幅', value: metrics.upperWickRatio, threshold: params.distributionUpperWickMin, unit: '比值', matched: metrics.upperWickRatio >= params.distributionUpperWickMin },
        { label: '平均换手率', value: metrics.averageTurnoverRate, threshold: params.distributionTurnoverRateMinPct, unit: '%', available: metrics.hasTurnoverData, matched: metrics.hasTurnoverData && metrics.averageTurnoverRate >= params.distributionTurnoverRateMinPct }
      ]
    }
  ];
  const warnings = [];
  if (candles.length < params.minBars) warnings.push(`有效 K 线 ${candles.length} 根，少于规则要求的 ${params.minBars} 根。`);
  if (!metrics.hasFlowData) warnings.push('缺少可计算的主动买卖量/净资金流字段，资金流条件不参与评分。');
  if (!metrics.hasTurnoverData) warnings.push('未提供换手率；此项不参与判定。');
  if (scores.distribution >= 55) warnings.push('出现高位放量滞涨或长上影组合，存在派发风险特征。');
  return {
    interval,
    usableBars: candles.length,
    latestPrice: metrics.latestPrice,
    latestTime: metrics.latestTime,
    label: primary?.label || '量价特征不明显',
    patternKey: primary?.key || null,
    confidence: primary?.score || 0,
    metrics,
    patterns,
    evidence,
    warnings,
    patternDetails: scores
  };
}

function forecastFor(primary, intervals, params) {
  const scoreFor = key => {
    const pattern = primary.patterns.find(item => item.key === key);
    return pattern?.eligible ? pattern.score : 0;
  };
  const distribution = scoreFor('distribution');
  const accumulation = scoreFor('accumulation');
  const washout = scoreFor('washout');
  const markup = scoreFor('markup');
  const flowRatio = primary.metrics.netFlowRatio;
  const aligned = intervals.filter(item => item.interval !== primary.interval
    && item.patternKey && ['accumulation', 'washout', 'markup'].includes(item.patternKey)).length;
  let ruleScore = 15;
  if (accumulation >= 50) ruleScore += 22;
  if (washout >= 55) ruleScore += 20;
  if (markup >= 55) ruleScore += 18;
  if (flowRatio !== null && flowRatio !== undefined && flowRatio >= params.positiveFlowRatioMin) ruleScore += 15;
  if (primary.metrics.volumeRatio !== null && primary.metrics.volumeRatio !== undefined && primary.metrics.volumeRatio >= params.breakoutVolumeRatioMin) ruleScore += 12;
  ruleScore += Math.min(15, aligned * 5);
  if (distribution >= 55) ruleScore -= 35;
  if (flowRatio !== null && flowRatio !== undefined && flowRatio < 0) ruleScore -= 12;
  ruleScore = Math.round(clamp(ruleScore, 0, 100));

  const level = ruleScore >= params.forecastHighScore ? '高'
    : ruleScore >= params.forecastMediumScore ? '中' : '低';
  const interval = primary.interval;
  const bars = params.lookaheadBarsByInterval[interval] || 20;
  const horizon = interval === '1m' ? `未来约 ${bars} 分钟`
    : interval === '5m' ? `未来约 ${Math.round(bars * 5 / 60)} 小时`
      : interval === '1h' ? `未来约 ${Math.round(bars / 24)} 天` : `未来约 ${bars} 个交易日`;
  const triggerConditions = [];
  if (primary.metrics.priorHigh !== null && primary.metrics.priorHigh !== undefined) {
    triggerConditions.push(`收盘价有效站上观察高点 ${primary.metrics.priorHigh}，而非仅盘中刺穿。`);
  }
  triggerConditions.push(`近 ${params.recentBars} 根均量 / 前 ${params.lookbackBars} 根均量达到 ${params.breakoutVolumeRatioMin.toFixed(2)} 倍。`);
  triggerConditions.push(`近端涨幅达到 ${params.breakoutRiseMinPct.toFixed(2)}%，并由主动买入或净流入确认（有字段时）。`);
  const warnings = [];
  if (distribution >= 55) warnings.push('派发风险分较高，拉升评分已扣减。');
  if (aligned === 0) warnings.push('其他周期未出现同向量价阶段，缺少多周期共振。');
  if (primary.usableBars < params.minBars) warnings.push('样本量不足，当前等级仅作低置信度观察。');
  return {
    level,
    ruleScore,
    scoreMeaning: '规则符合度评分，非经历史回测校准的统计概率。',
    referenceWindow: horizon,
    lookaheadBars: bars,
    triggerConditions,
    keyLevels: {
      breakout: primary.metrics.priorHigh,
      support: primary.metrics.priorLow,
      current: primary.metrics.latestPrice,
      largeRiseThresholdPct: params.largeRiseMinPct
    },
    warnings
  };
}

export function analyzeFlowPatterns({ symbol = '', primaryInterval = '1h', datasets = {}, params = {}, source = null, dataWarnings = [] } = {}) {
  const p = normalizeParams(params);
  const validPrimary = FLOW_ANALYSIS_INTERVALS.includes(primaryInterval) ? primaryInterval : '1h';
  const intervals = FLOW_ANALYSIS_INTERVALS
    .filter(interval => Array.isArray(datasets?.[interval]))
    .map(interval => analyzeInterval(interval, datasets[interval], p));
  const primary = intervals.find(item => item.interval === validPrimary)
    || intervals.find(item => item.usableBars > 0)
    || analyzeInterval(validPrimary, [], p);
  const forecast = forecastFor(primary, intervals, p);
  const warnings = [
    ...dataWarnings,
    ...primary.warnings,
    ...forecast.warnings
  ];
  if (!intervals.some(item => item.interval !== primary.interval && item.usableBars >= p.minBars)) {
    warnings.push('缺少足量的其他周期数据；当前判断未获得多周期确认。');
  }
  if (primary.patternKey === 'distribution') warnings.push('当前主周期更接近派发风险形态，避免把高位放量误读为吸筹。');

  return {
    symbol,
    source,
    generatedAt: new Date().toISOString(),
    primaryInterval: primary.interval,
    stage: { label: primary.label, patternKey: primary.patternKey, confidence: primary.confidence },
    forecast,
    primary,
    intervals,
    rules: {
      thresholds: p,
      descriptions: [
        `吸筹：近端价格区间不超过 ${p.consolidationRangeMaxPct}%、量比处于 ${p.accumulationVolumeRatioMin}–${p.accumulationVolumeRatioMax}，整理后段量能较前段温和抬升至 ${p.accumulationGentleVolumeRatioMin}–${p.accumulationGentleVolumeRatioMax} 倍，并结合资金流与区间位置。`,
        `洗盘：近端回撤至少 ${p.washoutDropMinPct}%、下跌量能不高于基准量 ${p.washoutVolumeRatioMax} 倍，且收复回撤幅度至少 ${Math.round(p.washoutRecoveryRatioMin * 100)}%。`,
        `拉升：收盘突破前 ${p.lookbackBars} 根高点、量比至少 ${p.breakoutVolumeRatioMin} 倍、近端涨幅至少 ${p.breakoutRiseMinPct}%。`,
        `派发：价格处于区间高位、量比至少 ${p.distributionVolumeRatioMin} 倍，并出现滞涨或上影线占比不低于 ${Math.round(p.distributionUpperWickMin * 100)}%；提供换手率时，达到 ${p.distributionTurnoverRateMinPct}% 作为辅助条件。`
      ]
    },
    warnings: [...new Set(warnings)],
    riskNotice: '仅依据输入行情按可配置规则匹配量价形态，不代表识别到真实操盘主体，也不构成投资建议。加密资产与股票均可能因流动性、停牌、除权、合约杠杆和突发消息快速反向。'
  };
}
