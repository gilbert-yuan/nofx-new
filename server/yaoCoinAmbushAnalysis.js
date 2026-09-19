/**
 * 妖币埋伏策略（yao-coin-ambush-v1）。
 *
 * 这不是“已经涨了 50% 再追”的筛选器，而是把 yaoCoinPrediction 的启动前
 * 规则落成可回测、可挂限价单的策略：
 *   1. 1m 最近窗口提取动量、量能、波动和突破特征；
 *   2. 15m 最近 96 根构造严格向后看的 24h 代理快照；
 *   3. 只接受 PRE_LAUNCH，不接受已经达到 ±50% 的 TRIGGERED 候选；
 *   4. 等回踩/反弹到参考价成交，使用统一 TradingSimulator 结算。
 *
 * 预测器中的 rawProbabilityPct 是可解释规则分数，probabilityPct 是历史校准后的
 * 经验概率。该策略默认关闭，必须先看样本外回测与 shadow 结果再启用。
 */

import { PAPER_COSTS } from './research.js';
import { localProtectionReview } from './shared/protectionReview.js';
import { predictYaoCoin } from './yaoCoinPrediction.js';

const RISK_NOTE = '妖币埋伏：只在 24h 涨跌幅/振幅尚未达到 ±50% 时，依据短线动量、量能和波动放大特征提前埋伏；等待回踩/反弹限价成交，不追涨杀跌。';

export const YAO_AMBUSH_DEFAULTS = Object.freeze({
  targetAmplitudePct: 50,
  // 回测最终采用的保守候选档：策略仍默认关闭，启用前必须继续 shadow；
  // 这里的严格门槛用于防止用户启用时误跑早期宽松版本。
  minProbabilityPct: 50,
  minRawProbabilityPct: 90,
  minAuxBars: 96,
  minCurrentAmplitudePct: 12,
  maxCurrentAmplitudePct: 48,
  minRecentReturnPct: 2,
  minVolumeRatio: 2.5,
  minRangeRatio: 1.5,
  minTrendConsistencyPct: 70,
  entryPullbackAtr: 1,
  entryBandAtr: 0.5,
  require15mTrend: true,
  trend15EmaFast: 8,
  trend15EmaSlow: 21,
  minTrend15SepAtr: 0.3,
  stopAtr: 0.5,
  minStopPct: 0.008,
  tp1R: 1.5,
  tp2R: 2.5,
  tp3R: 3.5,
  minNetRr: 1.2,
  maxHoldBars: 60,
  trailingTriggerR: 1,
  trailingProfitTriggerPct: 0.04,
  trailingExtendTpAtr: 3,
  longOnly: false,
  shortOnly: false,
  maxLeverage: 2
});

const N = YAO_AMBUSH_DEFAULTS;
const numSpec = (key, label, group, min, max, step, description) => ({
  key, label, group, type: 'number', default: N[key], min, max, step, description
});
const boolSpec = (key, label, description) => ({
  key, label, group: 'filter', type: 'boolean', default: N[key], description
});

export const YAO_AMBUSH_PARAM_SCHEMA = Object.freeze([
  numSpec('targetAmplitudePct', '妖币目标振幅', 'filter', 20, 100, 1,
    '24h 涨跌幅绝对值或高低振幅达到该值即视为已触发；埋伏策略只交易触发前。'),
  numSpec('minProbabilityPct', '校准方向概率下限', 'filter', 40, 99, 1,
    '历史校准后的方向经验概率下限；不是未来收益保证。'),
  numSpec('minRawProbabilityPct', '原始规则分数下限', 'filter', 50, 99, 1,
    '启动前规则原始分数下限，仅用于筛选候选，必须与校准概率门槛同时通过。'),
  numSpec('minAuxBars', '24h 代理最少15m根数', 'filter', 96, 150, 1,
    '96 根 15m = 24 小时；不足时 fail-closed。'),
  numSpec('minCurrentAmplitudePct', '当前最小波动', 'filter', 0, 49, 0.5,
    '当前 24h 涨跌/振幅低于该值时不认为已经进入启动阶段。'),
  numSpec('maxCurrentAmplitudePct', '当前最大波动', 'filter', 1, 49.9, 0.5,
    '超过该值仍未达到目标时也不追入，避免把晚期信号当埋伏。'),
  numSpec('minRecentReturnPct', '短线动量下限', 'filter', 0, 10, 0.1,
    '最近 1m K 线窗口必须出现与预测方向一致的动量。'),
  numSpec('minVolumeRatio', '量能放大下限', 'filter', 0, 10, 0.05,
    '最近窗口成交量相对基线的最低倍数。'),
  numSpec('minRangeRatio', '波动放大下限', 'filter', 0, 10, 0.05,
    '最近窗口真实波幅相对基线的最低倍数。'),
  numSpec('minTrendConsistencyPct', '同向K线占比下限', 'filter', 0, 100, 1,
    '最近窗口多空同向 K 线净占比下限。'),
  numSpec('entryPullbackAtr', '参考入场回撤 ATR', 'entry', 0.05, 2, 0.05,
    '相对当前价的回踩/反弹参考深度；越小越接近追踪，越大越难成交。'),
  numSpec('entryBandAtr', '入场区间半宽 ATR', 'entry', 0.1, 2, 0.05,
    '最佳入场价上下的挂单区间宽度。'),
  boolSpec('require15mTrend', '要求15m趋势同向', '要求 15m EMA 快慢线与预测方向一致，减少 1m 噪声信号。'),
  numSpec('trend15EmaFast', '15m快线周期', 'filter', 2, 50, 1, '15m 趋势确认快线。'),
  numSpec('trend15EmaSlow', '15m慢线周期', 'filter', 3, 100, 1, '15m 趋势确认慢线。'),
  numSpec('minTrend15SepAtr', '15m均线最小间距', 'filter', 0, 5, 0.05, '快慢线间距相对 15m ATR 的最小值。'),
  numSpec('stopAtr', '止损 ATR 倍数', 'risk', 0.5, 6, 0.1,
    '按 1m ATR 计算初始止损，并与最小止损比例取大。'),
  numSpec('minStopPct', '最小止损比例', 'risk', 0, 0.05, 0.001,
    '防止低波动时止损过窄。'),
  numSpec('tp1R', '第一档止盈 R', 'protection', 0.5, 10, 0.25, '第一档分批止盈。'),
  numSpec('tp2R', '第二档止盈 R', 'protection', 0.75, 15, 0.25, '第二档分批止盈。'),
  numSpec('tp3R', '主止盈 R', 'protection', 1, 20, 0.25, '主止盈/最后一档止盈。'),
  numSpec('minNetRr', '最低成本后盈亏比', 'protection', 0, 10, 0.1,
    '按最不利入场价和项目手续费/滑点/资金费预估。'),
  numSpec('trailingTriggerR', '移动止损触发 R', 'protection', 0.2, 3, 0.1,
    '浮盈达到该 R 后才启用订单级移动止损，减少刚入场即被噪声切出的情况。'),
  numSpec('trailingProfitTriggerPct', '移动止损百分比触发', 'protection', 0, 0.2, 0.005,
    '移动止损的百分比兜底触发线；与 R 触发线取先到者。'),
  numSpec('trailingExtendTpAtr', '趋势延伸止盈 ATR', 'protection', 0.5, 10, 0.5,
    '移动保护时顺势放宽主止盈的 ATR 倍数。'),
  numSpec('maxHoldBars', '最长持仓 1m 根数', 'position', 1, 120, 1,
    '超过该时间按统一模拟器规则超时结算；上限遵守 normalizePlan。'),
  boolSpec('longOnly', '仅做多', '关闭时同时允许上涨和下跌方向。'),
  boolSpec('shortOnly', '仅做空', '关闭时同时允许上涨和下跌方向。'),
  numSpec('maxLeverage', '策略杠杆上限', 'risk', 1, 5, 1,
    '推荐杠杆上限；最终仍受系统硬上限、币种上限和总敞口约束。')
]);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = finite(value);
  return n != null && n > 0 ? n : null;
}

function resolveParams(overrides = {}) {
  const params = { ...N };
  for (const spec of YAO_AMBUSH_PARAM_SCHEMA) {
    const raw = overrides?.[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (spec.type === 'boolean') {
      if (typeof raw === 'boolean') params[spec.key] = raw;
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= spec.min && n <= spec.max) params[spec.key] = n;
  }
  return params;
}

function finiteRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row =>
    ['openTime', 'open', 'high', 'low', 'close', 'volume'].every(key => Number.isFinite(Number(row?.[key])))
    && Number(row.high) >= Math.max(Number(row.open), Number(row.close))
    && Number(row.low) <= Math.min(Number(row.open), Number(row.close))
  );
}

/** 从已收盘 15m 数据构造只使用过去信息的 24h 快照。 */
export function buildYaoAmbushTicker(market, auxMarket, minAuxBars = N.minAuxBars) {
  const mainRows = finiteRows(market?.klines);
  const auxRows = finiteRows(auxMarket?.klines);
  if (auxRows.length < minAuxBars || !mainRows.length) return null;
  const window = auxRows.slice(-minAuxBars);
  const first = window[0];
  const last = mainRows.at(-1);
  const price = positive(last?.close);
  const high = Math.max(...window.map(row => Number(row.high)), Number(last?.high) || 0);
  const low = Math.min(...window.map(row => Number(row.low)), Number(last?.low) || Infinity);
  const open = positive(first.open);
  if (price == null || open == null || !Number.isFinite(high) || !Number.isFinite(low) || high < low) return null;
  return {
    symbol: market?.symbol || auxMarket?.symbol || null,
    lastPrice: price,
    openPrice: open,
    highPrice: high,
    lowPrice: low,
    priceChangePercent: (price / open - 1) * 100,
    dataSource: '15m-rolling-24h+1m-close'
  };
}

function directionAligned(prediction, minimum) {
  const recent = Number(prediction?.features?.recentReturnPct);
  if (!Number.isFinite(recent)) return false;
  return prediction.direction === 'UP' ? recent >= minimum : recent <= -minimum;
}

function emaLast(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 2) return null;
  const alpha = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + Number(value), 0) / period;
  for (let i = period; i < values.length; i++) ema = Number(values[i]) * alpha + ema * (1 - alpha);
  return Number.isFinite(ema) ? ema : null;
}

function atrLast(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length < period + 1) return null;
  const start = rows.length - period;
  let sum = 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    const previous = rows[i - 1]?.close;
    const tr = Math.max(Number(row.high) - Number(row.low),
      Math.abs(Number(row.high) - Number(previous)), Math.abs(Number(row.low) - Number(previous)));
    sum += tr;
  }
  return sum / period;
}

export function trend15Snapshot(aux, p, direction) {
  const rows = finiteRows(aux?.klines);
  if (!p.require15mTrend) return { enabled: false };
  if (p.trend15EmaFast >= p.trend15EmaSlow || rows.length < Math.max(p.trend15EmaSlow, 15) + 1) {
    return { enabled: true, ok: false, reason: '15m趋势数据不足或均线周期冲突' };
  }
  const closes = rows.map(row => Number(row.close));
  const fast = emaLast(closes, p.trend15EmaFast);
  const slow = emaLast(closes, p.trend15EmaSlow);
  const atr = atrLast(rows, 14);
  const sepAtr = atr > 0 ? (fast - slow) / atr : null;
  const aligned = direction === 'UP' ? fast > slow : fast < slow;
  const separated = Number.isFinite(sepAtr) && Math.abs(sepAtr) >= p.minTrend15SepAtr;
  return {
    enabled: true, ok: aligned && separated, fast, slow, atr, sepAtr,
    aligned, separated, minSepAtr: p.minTrend15SepAtr
  };
}

function costAwareRr({ entry, stopLoss, takeProfit, maxHoldBars, costs = PAPER_COSTS }) {
  const risk = Math.abs(entry - stopLoss);
  const holdHours = Math.max(0, Number(maxHoldBars) || 0) / 60;
  const costAbs = entry * (2 * (Number(costs.feeBps) + Number(costs.slippageBps))
    + Number(costs.fundingBpsPer8h) * holdHours / 8) / 10000;
  const reward = Math.abs(takeProfit - entry) - costAbs;
  return { grossRr: risk > 0 ? Math.abs(takeProfit - entry) / risk : 0, netRr: risk + costAbs > 0 ? reward / (risk + costAbs) : 0, costAbs };
}

/** 妖币埋伏订单级保护快照，避免回测/实盘回退到其它策略的全局出场规则。 */
function buildYaoExitRules(p) {
  return {
    trailing: {
      triggerR: p.trailingTriggerR,
      profitTriggerPct: p.trailingProfitTriggerPct,
      extendTpAtr: p.trailingExtendTpAtr,
      lockMinRoomAtr: 1,
      useBreakEven: false,
      breakEvenFloorAtr: 0.2,
      breakEvenCostBufferBps: 4,
      ladder: [
        { atR: 0, trailR: 0.7, lockR: 0 },
        { atR: 1, trailR: 0.5, lockR: 0.3 },
        { atR: 2, trailR: 0.4, lockR: 0.8 }
      ]
    },
    // 埋伏单有自己的形态止损；关闭均线失守，避免回踩入场后被根级均线条件立即砍掉。
    smartExit: {
      enabled: false,
      barLevelEnabled: false,
      barLevel: false,
      maPeriod: 20,
      maBreakAtr: 1,
      maExitMaxProfitR: p.trailingTriggerR,
      tpMinR: 2,
      minHoldBars: 0
    },
    partialTp: {
      enabled: true,
      tp1R: p.tp1R,
      tp2R: p.tp2R,
      tp1ClosePct: 0.4,
      tp2ClosePct: 0.4,
      moveStopToBreakEven: false
    }
  };
}

function waitSignal(market, reason, extra = {}) {
  return {
    symbol: market?.symbol,
    action: 'WAIT',
    positionRecommendation: 'WAIT',
    confidence: 0,
    score: 0,
    state: 'WAIT',
    reason,
    risk: RISK_NOTE,
    suggestion: '等待新的启动前特征组合，不追已经达到阈值的行情。',
    ...extra
  };
}

/**
 * 生成一个可由生产订单链路和 TradingSimulator 共同消费的妖币埋伏信号。
 * @param {{symbol:string, interval:string, klines:Array}} market 1m 已收盘窗口
 * @param {{params?:object, auxMarkets?:object}} ctx
 */
export function yaoCoinAmbushAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  const p = resolveParams(ctx?.params);
  const aux = ctx?.auxMarkets?.['15m'];
  const ticker = buildYaoAmbushTicker(market, aux, p.minAuxBars);
  if (!ticker) return waitSignal(market, `妖币埋伏需要至少 ${p.minAuxBars} 根已收盘 15m K 线构造 24h 快照，数据不足，观望。`, { dataGap: true });

  const prediction = predictYaoCoin({
    market,
    ticker,
    options: {
      targetAmplitudePct: p.targetAmplitudePct,
      minProbabilityPct: p.minProbabilityPct,
      minRawProbabilityPct: p.minRawProbabilityPct,
      minBars: 40,
      recentBars: 12,
      baselineBars: 30,
      breakoutBars: 40,
      atrBars: 14,
      pullbackAtr: p.entryPullbackAtr,
      entryBandAtr: p.entryBandAtr
    },
    now: Date.parse(market?.dataAsOf) || Date.now()
  });
  const observedAmplitude = Math.max(Math.abs(Number(ticker.priceChangePercent) || 0),
    (ticker.highPrice - ticker.lowPrice) / ticker.openPrice * 100);
  const predictionSnapshot = prediction ? {
    direction: prediction.direction,
    stage: prediction.stage,
    probabilityPct: prediction.probabilityPct,
    rawProbabilityPct: prediction.rawProbabilityPct,
    calibratedDirectionProbabilityPct: prediction.calibratedDirectionProbabilityPct,
    calibratedTargetProbabilityPct: prediction.calibratedTargetProbabilityPct,
    predictedMovePct: prediction.predictedMovePct,
    predictedTargetPrice: prediction.predictedTargetPrice,
    observedAmplitudePct: observedAmplitude,
    currentPrice: ticker.lastPrice,
    features: prediction.features
  } : null;
  const trend = predictionSnapshot ? { source: 'yao-coin-prediction-v1', ...predictionSnapshot } : undefined;

  if (!prediction) return waitSignal(market, '启动前特征未达到妖币埋伏置信度门槛，观望。', { trend });
  if (prediction.stage !== 'PRE_LAUNCH') {
    return waitSignal(market, `当前 24h 涨跌/振幅已达到 ${p.targetAmplitudePct}% 阈值，已进入触发后阶段，埋伏策略不追入。`, { trend });
  }
  if (prediction.probabilityPct < p.minProbabilityPct) {
    return waitSignal(market,
      `历史校准方向概率 ${Number(prediction.probabilityPct).toFixed(2)}% 低于门槛 ${p.minProbabilityPct}%，观望。`,
      { trend });
  }
  if (observedAmplitude < p.minCurrentAmplitudePct || observedAmplitude > p.maxCurrentAmplitudePct) {
    return waitSignal(market, `当前观察振幅 ${observedAmplitude.toFixed(2)}% 不在埋伏区间 ${p.minCurrentAmplitudePct}%～${p.maxCurrentAmplitudePct}% 内，观望。`, { trend });
  }
  if ((prediction.features.volumeRatio ?? 0) < p.minVolumeRatio) {
    return waitSignal(market, `量能比 ${Number(prediction.features.volumeRatio || 0).toFixed(2)} 低于埋伏门槛 ${p.minVolumeRatio}，观望。`, { trend });
  }
  if ((prediction.features.rangeRatio ?? 0) < p.minRangeRatio) {
    return waitSignal(market, `波动比 ${Number(prediction.features.rangeRatio || 0).toFixed(2)} 低于埋伏门槛 ${p.minRangeRatio}，观望。`, { trend });
  }
  if (Math.abs(Number(prediction.features.trendConsistencyPct) || 0) < p.minTrendConsistencyPct) {
    return waitSignal(market, `同向 K 线净占比不足 ${p.minTrendConsistencyPct}%，观望。`, { trend });
  }
  if (!directionAligned(prediction, p.minRecentReturnPct)) {
    return waitSignal(market, `最近动量未与预测方向一致（门槛 ${p.minRecentReturnPct}%），观望。`, { trend });
  }
  if (prediction.direction === 'UP' && p.shortOnly) return waitSignal(market, '上涨预测被 shortOnly 拦截。', { trend });
  if (prediction.direction === 'DOWN' && p.longOnly) return waitSignal(market, '下跌预测被 longOnly 拦截。', { trend });

  const trend15 = trend15Snapshot(aux, p, prediction.direction);
  if (!trend15.ok) {
    return waitSignal(market, `15m 趋势未与${prediction.direction === 'UP' ? '上涨' : '下跌'}预测一致或间距不足，观望。`, {
      trend: trend ? { ...trend, trend15 } : { trend15 }
    });
  }

  const long = prediction.direction === 'UP';
  const levels = prediction.levels;
  const entryMin = positive(levels?.entryRange?.min);
  const entryMax = positive(levels?.entryRange?.max);
  const entryLimit = positive(levels?.optimalEntry);
  const price = positive(ticker.lastPrice);
  const atr = price != null
    ? (positive(prediction.features?.atrPct) ? price * Number(prediction.features.atrPct) / 100 : price * 0.01)
    : null;
  if (![entryMin, entryMax, entryLimit, price, atr].every(value => value != null && value > 0) || entryMin > entryMax) {
    return waitSignal(market, '妖币埋伏价格或 ATR 无效，观望。', { trend });
  }

  const riskUnit = Math.max(atr * p.stopAtr, entryLimit * p.minStopPct);
  const stopLoss = long
    ? Math.min(entryLimit - riskUnit, entryMin - atr * 0.1)
    : Math.max(entryLimit + riskUnit, entryMax + atr * 0.1);
  const tpR = [p.tp1R, p.tp2R, p.tp3R].sort((a, b) => a - b);
  const takeProfits = tpR.map(r => long ? entryLimit + riskUnit * r : entryLimit - riskUnit * r);
  const takeProfit = takeProfits.at(-1);
  const worstEntry = long ? entryMax : entryMin;
  const rr = costAwareRr({ entry: worstEntry, stopLoss, takeProfit, maxHoldBars: p.maxHoldBars, costs });
  if (!(rr.netRr >= p.minNetRr)) {
    return waitSignal(market, `埋伏计划成本后盈亏比 ${rr.netRr.toFixed(2)} 低于门槛 ${p.minNetRr}，观望。`, {
      trend, rr: { grossRr: rr.grossRr, netRr: rr.netRr }
    });
  }

  const action = long ? 'BUY' : 'SELL';
  const moveText = `${prediction.predictedMovePct >= 0 ? '+' : ''}${prediction.predictedMovePct.toFixed(1)}%`;
  const plan = {
    entryMin, entryMax, entryLimit, stopLoss, takeProfit, maxHoldBars: Math.trunc(p.maxHoldBars),
    riskUnit, takeProfit1: takeProfits[0], takeProfit2: takeProfits[1], takeProfit3: takeProfits[2],
    trendStrengthScore: prediction.score,
    predictedTargetPrice: prediction.predictedTargetPrice,
    yaoPrediction: predictionSnapshot,
    exitRules: buildYaoExitRules(p)
  };
  return {
    symbol: market?.symbol,
    action,
    positionRecommendation: action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT',
    confidence: Math.max(0, Math.min(0.99, prediction.probabilityPct / 100)),
    score: prediction.score,
    state: 'PRE_LAUNCH',
    decision: 'AMBUSH_PRE_LAUNCH',
    trend: trend ? { ...trend, trend15 } : { trend15 },
    reason: `妖币埋伏${long ? '做多' : '做空'}：当前24h涨跌 ${Number(ticker.priceChangePercent).toFixed(2)}%，`
      + `振幅 ${observedAmplitude.toFixed(2)}%，预测 ${moveText}，目标价 ${prediction.predictedTargetPrice.toPrecision(8)}；`
      + `最佳${long ? '买入' : '做空'} ${entryMin.toPrecision(8)}～${entryMax.toPrecision(8)}，参考 ${entryLimit.toPrecision(8)}，`
      + `止损 ${stopLoss.toPrecision(8)}，止盈 ${takeProfits.map(value => value.toPrecision(8)).join(' / ')}。`,
    risk: `${RISK_NOTE} 原始规则分数 ${prediction.rawProbabilityPct}，历史校准方向概率 ${prediction.probabilityPct.toFixed(2)}%，`
      + `50%目标经验概率 ${Number(prediction.calibratedTargetProbabilityPct || 0).toFixed(2)}%，成本后盈亏比 ${rr.netRr.toFixed(2)}。`,
    suggestion: `等待${long ? '回踩买入区间' : '反弹做空区间'}成交；若 24h 振幅达到 ${p.targetAmplitudePct}% 则取消埋伏，不追单。`,
    recommendedLeverage: Math.max(1, Math.min(5, Math.trunc(p.maxLeverage))),
    plan
  };
}

export function yaoCoinAmbushReview(order, market) {
  return localProtectionReview(order, market);
}
