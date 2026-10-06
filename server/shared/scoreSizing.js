/**
 * 信号综合评分 → 杠杆档与保证金比例，并约束单笔最大亏损。
 * 缺评分时回落基础档，不编造分数。
 */
import { AUTO_TRADE } from '../../shared/autoTradeDefaults.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function signalScore(signal = {}) {
  const plan = signal.plan || {};
  const candidates = [plan.trendStrengthScore, plan.signalScore, signal.score, signal.entryQuality];
  for (const value of candidates) {
    const n = finite(value);
    if (n != null) return n > 1 ? n : n * 100;
  }
  const confidence = finite(signal.confidence);
  if (confidence == null) return null;
  return confidence > 1 ? confidence : confidence * 100;
}

export function mapScoreToSize(score, params = AUTO_TRADE) {
  const s = finite(score);
  if (s == null) {
    return {
      leverage: Math.max(1, Math.floor(params.baseLeverage)),
      marginPct: params.baseMarginPct,
      usedScore: null,
      t: null
    };
  }
  const span = Math.max(1e-9, params.scoreCeil - params.scoreFloor);
  const t = clamp((s - params.scoreFloor) / span, 0, 1);
  const leverage = Math.max(1, Math.round(params.minLeverage + t * (params.maxLeverage - params.minLeverage)));
  const marginPct = params.minMarginPct + t * (params.maxMarginPct - params.minMarginPct);
  return { leverage: clamp(leverage, params.minLeverage, params.maxLeverage), marginPct, usedScore: s, t };
}

export function stopDistancePct(plan = {}, price = null) {
  const entry = finite(plan.entryLimit) ?? finite(plan.entry) ?? finite(price);
  const stop = finite(plan.stopLoss);
  if (!(entry > 0) || !(stop > 0)) return null;
  return Math.abs(entry - stop) / entry;
}

/**
 * 单笔亏损占比 ≈ marginPct × leverage × stopDistancePct。
 * 超限时先降杠杆，再降保证金；仍超限则拒绝。
 */
export function constrainByMaxLoss({ leverage, marginPct, stopDistancePct: stopPct, params = AUTO_TRADE }) {
  const maxLoss = params.maxLossPct;
  if (!(stopPct > 0)) return { ok: true, leverage, marginPct, expectedLossPct: null };
  let lev = Math.max(1, Math.floor(leverage));
  let margin = marginPct;
  const loss = () => margin * lev * stopPct;
  while (loss() > maxLoss && lev > 1) lev -= 1;
  if (loss() > maxLoss) {
    margin = maxLoss / (lev * stopPct);
  }
  if (!(margin >= params.minMarginPct / 4) || loss() > maxLoss + 1e-9) {
    return {
      ok: false,
      leverage: lev,
      marginPct: margin,
      expectedLossPct: loss(),
      reason: `单笔预期亏损 ${(loss() * 100).toFixed(2)}% 超过上限 ${maxLoss * 100}%`
    };
  }
  return { ok: true, leverage: lev, marginPct: margin, expectedLossPct: loss() };
}

export function sizeSignal(signal, { price, params = AUTO_TRADE, equity, openCount } = {}) {
  if (Number.isFinite(openCount) && openCount >= params.maxPositions) {
    return { ok: false, action: 'SKIP_MAX_POSITIONS', reason: `并发持仓已达 ${params.maxPositions}` };
  }
  const mapped = mapScoreToSize(signalScore(signal), params);
  const stopPct = stopDistancePct(signal.plan, price);
  const limited = constrainByMaxLoss({
    leverage: mapped.leverage,
    marginPct: mapped.marginPct,
    stopDistancePct: stopPct,
    params
  });
  if (!limited.ok) return { ok: false, action: 'SKIP_MAX_LOSS', reason: limited.reason, ...limited, ...mapped };
  const margin = finite(equity) && equity > 0 ? Math.floor(equity * limited.marginPct * 100) / 100 : null;
  return {
    ok: true,
    leverage: limited.leverage,
    marginPct: limited.marginPct,
    margin,
    expectedLossPct: limited.expectedLossPct,
    usedScore: mapped.usedScore
  };
}
