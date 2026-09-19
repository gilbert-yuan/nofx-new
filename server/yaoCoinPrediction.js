/**
 * 妖币启动前预测。
 *
 * 这里的“妖币”不是事后简单筛选涨幅，而是先从最近已收盘 K 线提取
 * 启动前特征，再给出方向、预测幅度和入场参考。目标定义为：
 *   - 24h 涨跌幅绝对值 >= 50%；或
 *   - Binance 24h 高低振幅 >= 50%。
 *
 * 预测器先产生可解释的规则原始分数，再通过历史样本校准为经验概率。
 * rawProbabilityPct 保留规则分数，probabilityPct 是校准后的方向概率，二者不能混用。
 */

import { calibrateYaoProbability } from './yaoCoinCalibration.js';

export const YAO_COIN_DEFAULTS = Object.freeze({
  targetAmplitudePct: 50,
  minProbabilityPct: 60,
  minRawProbabilityPct: 60,
  minBars: 40,
  recentBars: 12,
  baselineBars: 30,
  breakoutBars: 40,
  atrBars: 14,
  maxCandidates: 50
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
};
const average = values => {
  const finiteValues = values.map(finite).filter(value => value != null);
  return finiteValues.length ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length : null;
};
const pctChange = (current, previous) => {
  const a = positive(current), b = positive(previous);
  return a != null && b != null ? (a / b - 1) * 100 : null;
};
const signed = (value, fallback = 0) => finite(value) ?? fallback;

function validRows(market) {
  return (Array.isArray(market?.klines) ? market.klines : [])
    .filter(row => [row?.open, row?.high, row?.low, row?.close, row?.volume].every(value => positive(value) != null))
    .sort((a, b) => signed(a.openTime) - signed(b.openTime));
}

function trueRange(row, previousClose) {
  const high = positive(row?.high), low = positive(row?.low), close = positive(previousClose);
  if (high == null || low == null) return null;
  return Math.max(high - low, close == null ? 0 : Math.abs(high - close), close == null ? 0 : Math.abs(low - close));
}

function directionName(direction) {
  return direction === 'UP' ? '预计上涨' : direction === 'DOWN' ? '预计下跌' : '方向不明';
}

function directionLabel(direction) {
  return direction === 'UP' ? '上涨' : direction === 'DOWN' ? '下跌' : '方向不明';
}

function featureDirectionScore(features) {
  // 各项都先归一化，避免不同币种价格量纲影响方向判断。
  const change24h = clamp(signed(features.change24hPct) / 50, -1, 1) * 25;
  const recent = clamp(signed(features.recentReturnPct) / 5, -1, 1) * 25;
  const acceleration = clamp(signed(features.accelerationPct) / 5, -1, 1) * 15;
  const consistency = clamp(signed(features.trendConsistencyPct) / 100, -1, 1) * 20;
  const breakout = clamp(signed(features.breakoutDirection), -1, 1) * 15;
  return change24h + recent + acceleration + consistency + breakout;
}

/**
 * 从一份币种市场快照提取启动前特征。
 * @param {{klines?: Array, symbol?: string}} market
 * @param {object} [ticker]
 * @param {object} [options]
 */
export function extractYaoCoinFeatures(market, ticker = {}, options = {}) {
  const p = { ...YAO_COIN_DEFAULTS, ...options };
  const rows = validRows(market);
  const last = rows.at(-1);
  const features = {
    symbol: market?.symbol || ticker?.symbol || null,
    barCount: rows.length,
    sufficient: rows.length >= p.minBars,
    currentPrice: positive(ticker?.lastPrice) ?? positive(last?.close),
    change24hPct: finite(ticker?.priceChangePercent),
    amplitude24hPct: null,
    dayOpen: positive(ticker?.openPrice),
    dayHigh: positive(ticker?.highPrice),
    dayLow: positive(ticker?.lowPrice),
    recentReturnPct: null,
    previousReturnPct: null,
    accelerationPct: null,
    volumeRatio: null,
    rangeRatio: null,
    trendConsistencyPct: null,
    breakoutPositionPct: null,
    breakoutDirection: 0,
    atr: null,
    atrPct: null,
    dataSource: ticker?.priceChangePercent != null ? 'ticker24h+klines' : 'klines-only'
  };

  if (features.dayOpen != null && features.dayHigh != null && features.dayLow != null && features.dayHigh >= features.dayLow) {
    features.amplitude24hPct = (features.dayHigh - features.dayLow) / features.dayOpen * 100;
  }

  if (!last || rows.length < 2) return features;

  const recentBars = Math.max(3, Math.min(rows.length - 1, Math.trunc(Number(p.recentBars) || 12)));
  const baselineBars = Math.max(3, Math.min(rows.length - recentBars - 1, Math.trunc(Number(p.baselineBars) || 30)));
  const breakoutBars = Math.max(5, Math.min(rows.length - 1, Math.trunc(Number(p.breakoutBars) || 40)));

  const recentStart = rows.length - recentBars - 1;
  const previousStart = Math.max(0, recentStart - recentBars);
  const baselineStart = Math.max(0, recentStart - baselineBars);
  const recentRows = rows.slice(recentStart + 1);
  const previousRows = rows.slice(previousStart, recentStart + 1);
  const baselineRows = rows.slice(baselineStart, recentStart + 1);
  const breakoutRows = rows.slice(Math.max(0, rows.length - breakoutBars - 1), -1);

  features.recentReturnPct = pctChange(last.close, rows[recentStart]?.close);
  features.previousReturnPct = pctChange(rows[recentStart]?.close, rows[previousStart]?.close);
  features.accelerationPct = features.recentReturnPct != null && features.previousReturnPct != null
    ? features.recentReturnPct - features.previousReturnPct : null;

  const recentVolume = average(recentRows.map(row => row.quoteVolume ?? row.volume));
  const baselineVolume = average(baselineRows.map(row => row.quoteVolume ?? row.volume));
  features.volumeRatio = recentVolume != null && baselineVolume > 0 ? recentVolume / baselineVolume : null;

  const ranges = rows.map((row, index) => trueRange(row, rows[index - 1]?.close));
  const recentRange = average(recentRows.map((_, index) => ranges[recentStart + 1 + index]));
  const baselineRange = average(baselineRows.map((_, index) => ranges[baselineStart + index]));
  features.rangeRatio = recentRange != null && baselineRange > 0 ? recentRange / baselineRange : null;
  features.atr = average(ranges.slice(-Math.max(3, Math.min(rows.length, Math.trunc(Number(p.atrBars) || 14)))));
  features.atrPct = features.atr != null && features.currentPrice > 0 ? features.atr / features.currentPrice * 100 : null;

  const directionalBars = recentRows.filter(row => row.close !== row.open);
  if (directionalBars.length) {
    const up = directionalBars.filter(row => row.close > row.open).length;
    const down = directionalBars.filter(row => row.close < row.open).length;
    features.trendConsistencyPct = (up - down) / directionalBars.length * 100;
  }

  const priorHigh = Math.max(...breakoutRows.map(row => signed(row.high)));
  const priorLow = Math.min(...breakoutRows.map(row => signed(row.low)));
  const span = priorHigh - priorLow;
  if (Number.isFinite(priorHigh) && Number.isFinite(priorLow) && span > 0) {
    features.breakoutPositionPct = (last.close - priorLow) / span * 100;
    const upBreakout = priorHigh > 0 ? (last.close - priorHigh) / priorHigh * 100 : 0;
    const downBreakout = priorLow > 0 ? (priorLow - last.close) / priorLow * 100 : 0;
    features.breakoutDirection = upBreakout > 0 ? clamp(upBreakout / 2, 0, 1) : downBreakout > 0 ? -clamp(downBreakout / 2, 0, 1) : 0;
  }

  return features;
}

function amplitudeReached(features, targetAmplitudePct) {
  const values = [Math.abs(signed(features.change24hPct)), signed(features.amplitude24hPct)].filter(value => value > 0);
  return values.length ? Math.max(...values) >= targetAmplitudePct : false;
}

function chooseDirection(features) {
  const score = featureDirectionScore(features);
  if (Math.abs(score) >= 5) return score > 0 ? 'UP' : 'DOWN';
  if (signed(features.change24hPct) !== 0) return signed(features.change24hPct) > 0 ? 'UP' : 'DOWN';
  if (signed(features.recentReturnPct) !== 0) return signed(features.recentReturnPct) > 0 ? 'UP' : 'DOWN';
  return null;
}

function activityScore(features, direction) {
  const signedRecent = signed(features.recentReturnPct) * (direction === 'UP' ? 1 : -1);
  const signedAcceleration = signed(features.accelerationPct) * (direction === 'UP' ? 1 : -1);
  const signedConsistency = signed(features.trendConsistencyPct) * (direction === 'UP' ? 1 : -1);
  const signedBreakout = signed(features.breakoutDirection) * (direction === 'UP' ? 1 : -1);
  const progress = clamp((Math.abs(signed(features.change24hPct)) - 5) / 35, 0, 1);
  const momentum = clamp(signedRecent / 5, 0, 1);
  const acceleration = clamp(signedAcceleration / 5, 0, 1);
  const consistency = clamp(signedConsistency / 100, 0, 1);
  const breakout = clamp(signedBreakout, 0, 1);
  const volume = features.volumeRatio == null ? 0 : clamp((features.volumeRatio - 1) / 3, 0, 1);
  const range = features.rangeRatio == null ? 0 : clamp((features.rangeRatio - 1) / 2, 0, 1);
  return {
    value: 35 * progress + 25 * momentum + 15 * acceleration + 15 * consistency + 10 * breakout
      + 20 * volume + 10 * range,
    components: { progress, momentum, acceleration, consistency, breakout, volume, range }
  };
}

/**
 * 只计算预测器的原始特征分数，不生成入场价，也不读取未来数据。
 * 校准脚本和线上预测共用这段计算，避免离线训练重新实现一套打分逻辑。
 */
export function scoreYaoCoinFeatures(features = {}) {
  const direction = chooseDirection(features);
  if (!direction) {
    return {
      direction: null,
      directionScore: 0,
      activityScore: 0,
      rawProbabilityPct: 0
    };
  }
  const directionScore = featureDirectionScore(features);
  const activity = activityScore(features, direction);
  const directionStrength = clamp(Math.abs(directionScore) / 100, 0, 1);
  const rawProbabilityPct = Math.round(clamp(35 + directionStrength * 35 + activity.value, 0, 99));
  return {
    direction,
    directionScore,
    activityScore: activity.value,
    activityComponents: activity.components,
    rawProbabilityPct
  };
}

function makeEntryLevels(features, direction, predictedMovePct, options = {}) {
  const price = positive(features.currentPrice);
  const atr = positive(features.atr) ?? (price != null ? price * 0.01 : null);
  if (price == null || atr == null) return null;

  const recentRows = features._rows || [];
  const recent = recentRows.slice(-Math.min(20, recentRows.length));
  const recentLow = recent.length ? Math.min(...recent.map(row => signed(row.low))) : price - atr;
  const recentHigh = recent.length ? Math.max(...recent.map(row => signed(row.high))) : price + atr;
  const pullbackAtr = Number.isFinite(Number(options.pullbackAtr))
    ? Math.max(0.05, Math.min(2, Number(options.pullbackAtr)))
    : 0.65;
  const entryBandAtr = Number.isFinite(Number(options.entryBandAtr))
    ? Math.max(0.1, Math.min(2, Number(options.entryBandAtr)))
    : 0.45;
  const pullback = clamp(atr * pullbackAtr, price * 0.002, price * 0.03);
  const support = Math.max(price * 0.97, Math.min(price, recentLow + atr * 0.35));
  const resistance = Math.min(price * 1.03, Math.max(price, recentHigh - atr * 0.35));
  const bestEntry = direction === 'UP' ? Math.min(price, Math.max(price - pullback, support))
    : Math.max(price, Math.min(price + pullback, resistance));
  const halfRange = Math.max(atr * entryBandAtr, bestEntry * 0.002);
  // 入场参考只给有利方向的回调区间：多头不把追高价放进区间，
  // 空头不把追空价放进区间。这样“最佳买入/做空”不会退化成当前市价追单。
  const entryMin = direction === 'UP'
    ? Math.max(price * 0.9, bestEntry - halfRange)
    : Math.max(price, bestEntry - halfRange);
  const entryMax = direction === 'UP'
    ? Math.min(price, bestEntry + halfRange)
    : Math.min(price * 1.1, bestEntry + halfRange);
  const riskUnit = Math.max(atr * 1.5, bestEntry * 0.01);
  const stopLoss = direction === 'UP'
    ? Math.min(bestEntry - riskUnit, recentLow - atr * 0.25)
    : Math.max(bestEntry + riskUnit, recentHigh + atr * 0.25);
  const targets = [1.5, 2.5, 3.5].map(multiplier => direction === 'UP'
    ? bestEntry + riskUnit * multiplier
    : bestEntry - riskUnit * multiplier);
  const predictedTargetPrice = direction === 'UP'
    ? price * (1 + predictedMovePct / 100)
    : price * (1 - predictedMovePct / 100);
  return {
    entryRange: { min: Math.min(entryMin, entryMax), max: Math.max(entryMin, entryMax) },
    optimalEntry: bestEntry,
    entryMode: 'PULLBACK_REFERENCE',
    stopLoss,
    takeProfits: targets,
    riskUnit,
    predictedTargetPrice
  };
}

/**
 * 预测一个币种是否接近妖币启动，返回 null 表示数据不足或方向不明确。
 */
export function predictYaoCoin({ market, ticker = {}, now = Date.now(), options = {} } = {}) {
  const p = { ...YAO_COIN_DEFAULTS, ...options };
  const features = extractYaoCoinFeatures(market, ticker, p);
  // 仅在内部计算入场区间时使用 K 线，不把整份 K 线返回给前端或归档。
  features._rows = validRows(market);
  if (!features.sufficient || features.currentPrice == null) return null;

  const scored = scoreYaoCoinFeatures(features);
  const direction = scored.direction;
  if (!direction) return null;
  const targetReached = amplitudeReached(features, p.targetAmplitudePct);
  const rawProbabilityPct = scored.rawProbabilityPct;
  const calibratedDirectionProbabilityPct = calibrateYaoProbability(rawProbabilityPct, 'direction');
  const calibratedTargetProbabilityPct = calibrateYaoProbability(rawProbabilityPct, 'target');
  const probabilityPct = Math.round(calibratedDirectionProbabilityPct * 100) / 100;
  const currentAmplitudePct = Math.max(Math.abs(signed(features.change24hPct)), signed(features.amplitude24hPct), 0);
  const expectedMovePct = Math.round(clamp(
    Math.max(p.targetAmplitudePct, currentAmplitudePct + 5 + Math.max(0, probabilityPct - p.minProbabilityPct) * 0.35),
    p.targetAmplitudePct,
    85
  ) * 10) / 10;
  const rawThreshold = Number.isFinite(Number(p.minRawProbabilityPct))
    ? Number(p.minRawProbabilityPct) : Number(p.minProbabilityPct);
  const candidate = targetReached || rawProbabilityPct >= rawThreshold;
  if (!candidate) return null;

  const levels = makeEntryLevels(features, direction, expectedMovePct, p);
  const reasons = [];
  if (features.volumeRatio != null && features.volumeRatio >= 1.5) reasons.push(`近${p.recentBars}根成交量约为基线${features.volumeRatio.toFixed(1)}倍`);
  if (features.rangeRatio != null && features.rangeRatio >= 1.3) reasons.push(`波动放大${features.rangeRatio.toFixed(1)}倍`);
  if (Math.abs(signed(features.recentReturnPct)) >= 1) reasons.push(`短线动量${features.recentReturnPct >= 0 ? '+' : ''}${features.recentReturnPct.toFixed(2)}%`);
  if (Math.abs(signed(features.accelerationPct)) >= 0.5) reasons.push(`动量加速度${features.accelerationPct >= 0 ? '+' : ''}${features.accelerationPct.toFixed(2)}%`);
  if (Math.abs(signed(features.trendConsistencyPct)) >= 45) reasons.push(`同向K线占优${features.trendConsistencyPct >= 0 ? '偏多' : '偏空'}`);
  if (targetReached) reasons.push(`已达到±${p.targetAmplitudePct}%妖币振幅阈值`);
  if (!reasons.length) reasons.push('启动前特征组合达到观察门槛');

  const signedExpectedMovePct = direction === 'UP' ? expectedMovePct : -expectedMovePct;
  const stage = targetReached ? 'TRIGGERED' : 'PRE_LAUNCH';
  const stageLabel = targetReached ? '已触发妖币阈值' : '启动前候选';
  const result = {
    generatedAt: new Date(now).toISOString(),
    symbol: features.symbol || market?.symbol || ticker?.symbol || null,
    direction,
    directionLabel: directionName(direction),
    sideLabel: directionLabel(direction),
    stage,
    stageLabel,
    targetAmplitudePct: p.targetAmplitudePct,
    targetDefinition: '24h涨跌幅绝对值或24h高低振幅达到阈值',
    probabilityPct,
    score: Math.round(clamp(rawProbabilityPct, 0, 100)),
    rawProbabilityPct,
    calibratedDirectionProbabilityPct: probabilityPct,
    calibratedTargetProbabilityPct: Math.round(calibratedTargetProbabilityPct * 100) / 100,
    predictedMovePct: signedExpectedMovePct,
    predictedMoveAbsPct: expectedMovePct,
    predictedTargetPrice: levels?.predictedTargetPrice ?? null,
    current: {
      price: features.currentPrice,
      change24hPct: features.change24hPct,
      amplitude24hPct: features.amplitude24hPct,
      high24h: features.dayHigh,
      low24h: features.dayLow
    },
    levels: levels ? {
      ...levels,
      side: direction === 'UP' ? 'BUY' : 'SELL_SHORT'
    } : null,
    features: {
      barCount: features.barCount,
      recentReturnPct: features.recentReturnPct,
      previousReturnPct: features.previousReturnPct,
      accelerationPct: features.accelerationPct,
      volumeRatio: features.volumeRatio,
      rangeRatio: features.rangeRatio,
      trendConsistencyPct: features.trendConsistencyPct,
      breakoutPositionPct: features.breakoutPositionPct,
      atrPct: features.atrPct,
      dataSource: features.dataSource
    },
    reasons,
    warnings: [
      targetReached ? '该币已达到妖币阈值，不属于提前预测；追涨杀跌风险很高。' : '这是启动前规则预测，不代表一定达到目标；请等待入场价区间。',
      '妖币预测仅用于观察，不会绕过现有策略、保证金和止损风控。'
    ]
  };
  delete features._rows;
  return result;
}

/**
 * 批量预测并稳定排序：先显示已达到阈值的币，再显示启动前候选。
 */
export function predictYaoCoins({ symbols = [], preparedMarkets = {}, tickers = new Map(), now = Date.now(), options = {} } = {}) {
  const p = { ...YAO_COIN_DEFAULTS, ...options };
  const rows = [];
  for (const symbol of symbols) {
    const market = preparedMarkets?.[symbol];
    const ticker = tickers instanceof Map ? tickers.get(symbol) || {} : tickers?.[symbol] || {};
    const prediction = predictYaoCoin({ market, ticker, now, options: p });
    if (prediction) rows.push(prediction);
  }
  return rows.sort((a, b) => {
    const stageDiff = Number(b.stage === 'TRIGGERED') - Number(a.stage === 'TRIGGERED');
    if (stageDiff) return stageDiff;
    return b.probabilityPct - a.probabilityPct
      || Math.abs(b.predictedMovePct) - Math.abs(a.predictedMovePct)
      || String(a.symbol).localeCompare(String(b.symbol));
  }).slice(0, Math.max(1, Math.trunc(Number(p.maxCandidates) || YAO_COIN_DEFAULTS.maxCandidates)));
}
