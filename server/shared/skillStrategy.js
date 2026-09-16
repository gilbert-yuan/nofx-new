/**
 * Shared deterministic primitives ported from crypto-long/short-skill-node.
 *
 * This module deliberately contains no model calls. It is the single source
 * of truth for the two SKILL-derived strategies' candle-data quality, regime
 * and risk/plan geometry.
 */
export function skillRegime(indicators, structure, options = {}) {
  const highVolatilityPercentile = Number.isFinite(Number(options.highVolatilityPercentile))
    ? Number(options.highVolatilityPercentile) : 0.9;
  const lowVolatilityPercentile = Number.isFinite(Number(options.lowVolatilityPercentile))
    ? Number(options.lowVolatilityPercentile) : 0.2;
  if (indicators?.atrPercentile > highVolatilityPercentile) return 'HIGH_VOLATILITY';
  if (structure?.trend === 'BULLISH'
    && indicators?.ema20 > indicators?.ema50
    && indicators?.ema50 > indicators?.ema200) return 'TREND_UP';
  if (structure?.trend === 'BEARISH'
    && indicators?.ema20 < indicators?.ema50
    && indicators?.ema50 < indicators?.ema200) return 'TREND_DOWN';
  if (indicators?.atrPercentile < lowVolatilityPercentile) return 'LOW_VOLATILITY';
  return 'RANGE';
}

/** Validate only candle evidence used by the strategy. Derivatives and BTC
 * environment data are intentionally not a strategy prerequisite. */
export function skillDataQuality({ rows4h, rows1h, rows15, rows5, requireFiveMinute = false } = {}) {
  const missing = [];
  if (!Array.isArray(rows4h) || rows4h.length < 200) missing.push('4h>=200');
  if (!Array.isArray(rows1h) || rows1h.length < 50) missing.push('1h>=50');
  if (!Array.isArray(rows15) || rows15.length < 30) missing.push('15m>=30');
  if (requireFiveMinute && (!Array.isArray(rows5) || rows5.length < 30)) missing.push('5m>=30');
  return { good: missing.length === 0, missing };
}

/** Exact risk/plan geometry from src/risk/plan.js in the supplied SKILLs. */
export function makeSkillTradePlan({ long, price, atr, resistance, support, balance = 10000, risk = 0.01,
  volatility = 0.5, leverage = 5, maxLeverage = 20, riskBudgetPct = null,
  entryBufAtr = 0.25, stopBufferAtr = 0.35, minStopPct = 0, targetR = 2,
  highVolatilityPercentile = 0.9, mediumVolatilityPercentile = 0.8 } = {}) {
  const current = Number(price), range = Number(atr);
  if (!(current > 0) || !(range > 0)) return null;
  const entryBuffer = Math.max(0, Number(entryBufAtr) || 0);
  const stopBuffer = Math.max(0, Number(stopBufferAtr) || 0);
  const minimumStopPct = Math.max(0, Number(minStopPct) || 0);
  const targetMultiple = Math.max(1, Number(targetR) || 2);
  if (long) {
    support = support && support < current ? support : current - range * 0.8;
    resistance = resistance && resistance > current ? resistance : current + range * 2;
    const entryLow = support - range * entryBuffer * 0.6;
    const entryHigh = Math.min(current, support + range * entryBuffer);
    const entry = (entryLow + entryHigh) / 2;
    const stopCandidate = support - range * stopBuffer;
    const stopLoss = Math.min(stopCandidate, entry - entry * minimumStopPct);
    const riskDistance = entry - stopLoss;
    const tp1 = Math.max(resistance, entry + riskDistance);
    const tp2 = entry + riskDistance * targetMultiple;
    const tp3 = entry + riskDistance * Math.max(3, targetMultiple + 1);
    return {
      ...finishSkillPlan({ long, entryLow, entryHigh, entry, stopLoss, tp1, tp2, tp3,
        riskDistance, balance, risk, volatility, leverage, maxLeverage, riskBudgetPct,
        highVolatilityPercentile, mediumVolatilityPercentile }),
      secondaryZone: [support - range, support - range * 0.5]
    };
  }
  resistance = resistance && resistance > current ? resistance : current + range * 0.8;
  support = support && support < current ? support : current - range * 2;
  const entryLow = Math.max(current, resistance - range * entryBuffer);
  const entryHigh = resistance + range * entryBuffer * 0.6;
  const entry = (entryLow + entryHigh) / 2;
  const stopCandidate = resistance + range * stopBuffer;
  const stopLoss = Math.max(stopCandidate, entry + entry * minimumStopPct);
  const riskDistance = stopLoss - entry;
  const tp1 = Math.min(support, entry - riskDistance);
  const tp2 = entry - riskDistance * targetMultiple;
  const tp3 = entry - riskDistance * Math.max(3, targetMultiple + 1);
  return {
    ...finishSkillPlan({ long, entryLow, entryHigh, entry, stopLoss, tp1, tp2, tp3,
      riskDistance, balance, risk, volatility, leverage, maxLeverage, riskBudgetPct,
      highVolatilityPercentile, mediumVolatilityPercentile }),
    secondaryZone: [resistance + range * 0.5, resistance + range]
  };
}

function finishSkillPlan({ long, entryLow, entryHigh, entry, stopLoss, tp1, tp2, tp3,
  riskDistance, balance, risk, volatility, leverage, maxLeverage = 20, riskBudgetPct = null,
  highVolatilityPercentile = 0.9, mediumVolatilityPercentile = 0.8 }) {
  if (!(entry > 0) || !(riskDistance > 0)) return null;
  const riskReward = Math.abs(tp2 - entry) / riskDistance;
  const volFactor = volatility > highVolatilityPercentile ? 0.5
    : volatility > mediumVolatilityPercentile ? 0.7 : 1;
  const adjustedRisk = Math.min(0.02, Math.max(0, Number(risk) * volFactor));
  const riskAmount = Number(balance) * adjustedRisk;
  const stopPercent = riskDistance / entry;
  const notional = stopPercent > 0 ? riskAmount / stopPercent : 0;
  const leverageCap = Math.max(1, Number(maxLeverage) || 20);
  const defaultLeverage = Math.max(1, Number(leverage) || 5);
  const budgetLeverage = Number(riskBudgetPct) > 0 && stopPercent > 0
    ? Number(riskBudgetPct) / stopPercent : null;
  const requestedLeverage = Number.isFinite(budgetLeverage) && budgetLeverage > 0
    ? Math.min(defaultLeverage, budgetLeverage) : defaultLeverage;
  const effectiveLeverage = Math.min(leverageCap, Math.max(1, requestedLeverage || 5));
  const maintenanceMarginRateEstimate = 0.005;
  const estimatedLiquidationPrice = long
    ? entry * (1 - 1 / effectiveLeverage + maintenanceMarginRateEstimate)
    : entry * (1 + 1 / effectiveLeverage - maintenanceMarginRateEstimate);
  return {
    entryMin: entryLow,
    entryMax: entryHigh,
    entryLimit: entry,
    secondaryZone: long ? [entryLow - Math.abs(entry - entryLow), entryLow] : [entryHigh, entryHigh + Math.abs(entryHigh - entry)],
    stopLoss, takeProfit: tp2, takeProfit1: tp1, takeProfit2: tp2, takeProfit3: tp3,
    riskReward,
    riskUnit: riskDistance,
    adjustedRisk,
    position: {
      accountBalance: Number(balance), riskAmount,
      stopDistancePercent: stopPercent * 100, notional,
      leverage: effectiveLeverage, estimatedMargin: notional / effectiveLeverage
    },
    liquidationSafety: {
      estimatedLiquidationPrice,
      distanceFromStopPercent: long
        ? (stopLoss - estimatedLiquidationPrice) / stopLoss * 100
        : (estimatedLiquidationPrice - stopLoss) / stopLoss * 100,
      stopBeforeEstimatedLiquidation: long
        ? stopLoss > estimatedLiquidationPrice
        : stopLoss < estimatedLiquidationPrice,
      note: '近似估算；实际强平价受保证金模式、维持保证金阶梯、费用及其他仓位影响。'
    },
    recommendedLeverage: effectiveLeverage,
    marginRiskPct: effectiveLeverage * stopPercent
  };
}
