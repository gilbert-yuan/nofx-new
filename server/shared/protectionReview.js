/**
 * 持仓保护复核（Protection Review）—— 跨引擎单一事实源
 *
 * 抽出的原因（2026-09-10 策略审计）：
 *   `localProtectionReview` 与 `applyPaperProtectionReview` 此前在
 *   paperAutomation.js（模块函数）与 globalAutomation.js（类方法）各存一份，
 *   两份几乎逐行相同。这种双份实现已经真实产生过口径漂移：
 *     - 移动止损距离出现过硬编码 2.5（未引用 TRAILING_RULE.stopAtr）；
 *     - 顺势扩盈出现过 4 ATR（本地规则引擎）与 3.0（enhanced 的 extendTpAtr）两种口径。
 *   现统一到本模块：止损 / 止盈距离一律引用 server/shared/strategyGuards.js → TRAILING_RULE，
 *   两个自动化引擎（PaperAutomation / GlobalAutomation）只保留薄封装或直接调用。
 */

import { candleOpenAt, nextOpenTime } from '../research.js';
import { TRAILING_RULE } from './strategyGuards.js';

/**
 * 最近 N 根 K 线的平均真实波幅（ATR，Wilder 的 TR 简化平均）。
 * 数据不足（少于 period + 1 根，无法取得前一根收盘价）时返回 NaN，
 * 交由调用方按「波动率无效」处理，而不是抛异常。
 *
 * @param {Array<{high:number,low:number,close:number}>} rows
 * @param {number} [period=14]
 * @returns {number} ATR，或 NaN
 */
export function averageTrueRange(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length < period + 1) return NaN;
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const row = rows[rows.length - period + i];
    const previous = rows[rows.length - period - 1 + i].close;
    sum += Math.max(row.high - row.low, Math.abs(row.high - previous), Math.abs(row.low - previous));
  }
  return sum / period;
}

/**
 * 本地规则复核持仓：只在「已盈利超过 2%」时才动保护价，
 * 避免把止损棘轮式推向现价、被 1m 噪声扫出。
 *
 * @param {object} order   模拟订单（需 direction / entry / plan.stopLoss / plan.takeProfit）
 * @param {object} market  行情（需 klines）
 * @returns {{action:'HOLD'|'UPDATE_PROTECTION', reason:string, stopLoss?:number, takeProfit?:number, confidence?:number}}
 */
export function localProtectionReview(order, market) {
  const rows = market.klines;
  const price = rows.at(-1).close;
  const atr = averageTrueRange(rows, 14);

  if (!(atr > 0)) return { action: 'HOLD', reason: '波动率无效，保留当前保护价格。' };

  const long = order.direction === 'OPEN_LONG';
  const profit = long ? (price - order.entry) / order.entry : (order.entry - price) / order.entry;
  if (!(profit > 0.02)) {
    return { action: 'HOLD', reason: '持仓未盈利超过2%，保持初始保护价格，避免噪声止损。' };
  }

  // 移动止损距离：与 enhancedAnalysis / 旧 local 实现共用 TRAILING_RULE.stopAtr（2.5 ATR）
  const stopLoss = long
    ? Math.max(order.plan.stopLoss, price - TRAILING_RULE.stopAtr * atr)
    : Math.min(order.plan.stopLoss, price + TRAILING_RULE.stopAtr * atr);

  // 顺势扩盈距离：与 enhancedAnalysis 的 TRAIL_TP_ATR 取同一常量（extendTpAtr = 3.0）。
  // 此前本地规则这里硬编码 4，两个引擎口径不一致；现统一，只放宽不收窄。
  const takeProfit = long
    ? Math.max(order.plan.takeProfit, price + TRAILING_RULE.extendTpAtr * atr)
    : Math.min(order.plan.takeProfit, price - TRAILING_RULE.extendTpAtr * atr);

  return {
    action: 'UPDATE_PROTECTION',
    stopLoss,
    takeProfit,
    confidence: 0.75,
    reason: '盈利超过2%，按最新 14 根真实波幅复核；只收紧止损，顺势调整止盈。'
  };
}

/**
 * 应用持仓保护复核建议：做全套校验后写回 order.plan，并在 reviewHistory 留痕。
 * 非 UPDATE_PROTECTION（含 HOLD / CLOSE）一律只记录、不改保护价 ——
 * CLOSE 的平仓动作由调用方（reviewPositions）负责，本函数不越权。
 *
 * @param {object} order     模拟订单
 * @param {object} proposal  复核建议
 * @param {number} [now]     当前时间戳
 * @param {string} [engine]  引擎标识，用于 AI 置信度校验与留痕
 */
export function applyPaperProtectionReview(order, proposal, now = Date.now(), engine = 'local') {
  if (order.status !== 'open') return { action: 'held', reason: '订单尚未入场或已经结束。' };

  const report = { at: new Date(now).toISOString(), engine, action: 'held', reason: proposal.reason || '保留当前保护价格。' };
  const record = () => { order.reviewHistory = [...(order.reviewHistory || []), report].slice(-50); return report; };

  // 行情未连续结算到最新收盘时间时不动保护价（避免用过期价格改止损）
  if (order.error || Date.parse(order.markAt) !== candleOpenAt(now, order.interval)) {
    report.reason = '行情尚未连续结算到最新收盘时间，暂不修改。';
    return record();
  }

  if (proposal.action !== 'UPDATE_PROTECTION') return record();

  if (engine === 'ai') {
    const confidence = Number(proposal.confidence);
    if (!Number.isFinite(confidence) || confidence < 0.65 || confidence > 1) {
      report.reason = 'AI 自评分无效或低于复核阈值，保留原保护。';
      return record();
    }
  }

  const stopLoss = Number(proposal.stopLoss);
  const takeProfit = Number(proposal.takeProfit);
  const price = Number(order.markPrice);
  const long = order.direction === 'OPEN_LONG';

  if (![stopLoss, takeProfit, price].every(v => Number.isFinite(v) && v > 0)
    || (long ? !(stopLoss < price && price < takeProfit) : !(takeProfit < price && price < stopLoss))
    || (long ? stopLoss < order.plan.stopLoss : stopLoss > order.plan.stopLoss)) {
    report.reason = '建议价格无效、已被穿越或扩大了止损风险，保留原保护。';
    return record();
  }

  // 变化过小（< 1bp）视为无实质调整，不产生修订记录
  if (Math.abs(stopLoss - order.plan.stopLoss) / price < 0.0001
    && Math.abs(takeProfit - order.plan.takeProfit) / price < 0.0001) return record();

  order.initialPlan ||= { ...order.plan };
  const effectiveFrom = nextOpenTime(candleOpenAt(now, order.interval), order.interval);
  const revision = { stopLoss, takeProfit, effectiveFrom, at: report.at };
  order.protectionRevisions = [...(order.protectionRevisions || []), revision];

  Object.assign(report, {
    action: 'updated',
    previous: { stopLoss: order.plan.stopLoss, takeProfit: order.plan.takeProfit },
    stopLoss,
    takeProfit,
    effectiveFrom
  });
  order.plan = { ...order.plan, stopLoss, takeProfit };
  return record();
}
