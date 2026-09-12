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
import { exitRulesFor, computeTrailStop, planRiskUnit, profitRFrom, reachedR } from './strategyGuards.js';

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
 * 本地规则复核持仓：浮盈达到该订单所属策略的触发线（trailingRule.triggerR）才动保护价，
 * 避免把止损棘轮式推向现价、被 1m 噪声扫出。
 *
 * 2026-09-10 修正（Task #6 口径统一）：
 *   旧实现在这里硬编码「已盈利超过 2%」才动保护；而 enhanced 引擎用的是 0.4R。
 *   两者在 1m 上完全不是一回事（R≈0.8% → 0.4R≈0.32%，2%≈2.5R），
 *   于是「本地引擎的订单几乎从不启动移动止损、enhanced 的很早就启动」，
 *   两个引擎的保护行为长期分裂。现统一引用 R 口径触发线与 R 口径渐进阶梯。
 *
 * 多策略化（2026-09）：触发线 / 阶梯 / 扩盈距离不再直接读全局 TRAILING_RULE，
 *   而是读**该订单所属策略**快照在 `order.plan.exitRules.trailing` 的规则；
 *   旧订单无快照时 exitRulesFor 自动回退全局默认值，行为与改造前完全一致。
 *
 * @param {object} order   模拟订单（需 direction / entry / plan.stopLoss / plan.takeProfit）
 * @param {object} market  行情（需 klines）
 * @param {object} [trailingRule] 策略级移动止损规则（订单所属策略的快照）。
 *        不传则从 `order.plan.exitRules` 取；旧订单无快照时自动回退全局 TRAILING_RULE。
 * @returns {{action:'HOLD'|'UPDATE_PROTECTION', reason:string, stopLoss?:number, takeProfit?:number, confidence?:number}}
 */
export function localProtectionReview(order, market, trailingRule) {
  const rows = market.klines;
  const price = rows.at(-1).close;
  const atr = averageTrueRange(rows, 14);

  // 订单所属策略的移动止损规则 —— 多策略并存时每单按自己策略的阶梯推进。
  const rule = trailingRule || exitRulesFor(order?.plan).trailing;

  if (!(atr > 0)) return { action: 'HOLD', reason: '波动率无效，保留当前保护价格。' };

  const long = order.direction === 'OPEN_LONG';
  const riskUnit = planRiskUnit(order.plan, order.direction);
  const profit = long ? (price - order.entry) / order.entry : (order.entry - price) / order.entry;
  const profitR = profitRFrom({ long, entry: Number(order.entry), close: price, riskUnit });
  const profitLabel = Number.isFinite(profitR) ? `${profitR.toFixed(2)}R` : 'R未知';

  // 双通道触发（与 enhanced 一致）：R 通道为主，百分比通道兜底极小 R 的情形。
  const triggered = reachedR(profitR, rule.triggerR)
    || profit > rule.profitTriggerPct;
  if (!triggered) {
    return {
      action: 'HOLD',
      reason: `浮盈 ${profitLabel} 未达保护触发线（${rule.triggerR}R / ${(rule.profitTriggerPct * 100).toFixed(1)}%），保持初始保护价格，避免噪声止损。`
    };
  }

  const baseStop = Number(order.plan?.stopLoss);
  const trail = computeTrailStop({
    long,
    entry: Number(order.entry),
    close: price,
    atr,
    riskUnit,
    profitR: Number.isFinite(profitR) ? profitR : 0,
    baseStop,
    costs: order.costs,
    rule
  });

  if (!Number.isFinite(trail.stop) || trail.reversed) {
    return { action: 'HOLD', reason: '保护计算异常（止损越过现价），保留当前保护价格。' };
  }

  // 顺势扩盈距离：与 enhancedAnalysis 的 TRAIL_TP_ATR 同源（rule.extendTpAtr），只放宽不收窄。
  const takeProfit = long
    ? Math.max(Number(order.plan?.takeProfit) || 0, price + rule.extendTpAtr * atr)
    : Math.min(Number(order.plan?.takeProfit) || Infinity, price - rule.extendTpAtr * atr);

  const tightened = long ? trail.stop > baseStop : trail.stop < baseStop;
  if (!tightened) {
    return { action: 'HOLD', reason: `止损已处于 ${profitLabel} 档对应的最紧位置，无需调整。` };
  }

  return {
    action: 'UPDATE_PROTECTION',
    stopLoss: trail.stop,
    takeProfit,
    confidence: 0.75,
    reason: `浮盈 ${profitLabel} 启用移动止损（阶梯 ${trail.step.atR}R 档 / 跟踪 ${trail.step.trailR}R${trail.lockStop ? ` / 锁盈 ${trail.step.lockR}R` : ''}）。`
  };
}

/**
 * 历史最紧止损（Task #7）：跨 initialPlan / 当前 plan / 全部保护修订取「最紧」。
 *
 * 修复背景：复核建议原先一律以 `order.plan.stopLoss` 为基准校验，
 * 但 `order.plan` 会被每次复核**立即覆盖**，一旦某次写入把止损写松（或基准取错），
 * 后续复核就会在这个被污染的基准上继续推进 —— 棘轮会「反向」松开。
 * 改为始终与历史最紧值比较：多头取最大、空头取最小，保证止损单调只紧不松。
 *
 * @returns {number} 历史最紧止损；无有效历史时回退到当前 plan 的止损
 */
export function tightestStop(order, long) {
  const candidates = [];
  const push = v => { const n = Number(v); if (Number.isFinite(n) && n > 0) candidates.push(n); };
  push(order?.initialPlan?.stopLoss);
  push(order?.plan?.stopLoss);
  for (const revision of order?.protectionRevisions || []) push(revision?.stopLoss);
  if (!candidates.length) return Number(order?.plan?.stopLoss);
  return long ? Math.max(...candidates) : Math.min(...candidates);
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

  // Task #7：以「历史最紧止损」而非「当前 plan.stopLoss」为单调性基准。
  // order.plan 会被每次复核立即覆盖，用它当基准在多次复核后可能被污染（棘轮反向松开）。
  const tightest = tightestStop(order, long);

  if (![stopLoss, takeProfit, price].every(v => Number.isFinite(v) && v > 0)
    || (long ? !(stopLoss < price && price < takeProfit) : !(takeProfit < price && price < stopLoss))
    || (long ? !(stopLoss >= tightest) : !(stopLoss <= tightest))) {
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
