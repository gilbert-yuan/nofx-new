import { candleOpenAt, nextOpenTime } from '../research.js';
import { recommendedLeverage } from '../localAnalysis.js';
import { PENDING_REVIEW } from './strategyGuards.js';

// 挂单复核：只做「保留」或「取消」两件事。
//
// 旧行为：只要 `!signal.eligible || 方向不匹配` 就立刻 strategy_cancelled，
// 且每轮复核都会按新计划「改价（repriced）」。
// 实测问题（2026-09-11）：取消原因绝大多数是量比 / 波动率这类**每根 1m K 线重算**的
// 软门槛在门槛线抖动（量比 0.71 / 0.74 / 0.78 / 0.79 均 < 0.8），挂单平均活 18.9 分钟
// 就被砍 —— 禁空上线后 18 笔挂单成交 0 笔，系统事实停摆。
// 改价同样无效：16 次改价全部落在最终被取消的单上，无一次救回。
//
// 新行为：
//   1. 方向反转 → 立即取消（真正的「策略不再支持原挂单方向」）；
//   2. 软门槛不合格 → 累计到宽限阈值（连续 N 轮 或 持续 M 分钟）才取消；
//   3. 默认不再改价（NOFX_PENDING_NO_REPRICE=false 可回退）。

// 宽限期内的保留动作名。与 'held' 区分，便于在 reviewHistory 里观察「正在宽限」。
export const HELD_INELIGIBLE = 'held_ineligible';

const isOppositeDirection = (recommendation, direction) =>
  typeof recommendation === 'string'
  && recommendation.startsWith('OPEN_')
  && recommendation !== direction;

// Apply only to orders that have already replayed through the latest closed bar.
export function applyPendingReview(order, signal, now = Date.now()) {
  if (order.status !== 'pending') return { action: 'held' };
  const report = { at: new Date(now).toISOString(), action: 'held', reason: signal?.reason || '保留原挂单。' };
  const record = () => {
    order.reviewHistory = [...(order.reviewHistory || []), report].slice(-50);
    return report;
  };
  const cancel = reason => {
    order.status = 'cancelled';
    order.reason = 'strategy_cancelled';
    order.cancelledAt = report.at;
    order.ineligibleRounds = 0;
    order.ineligibleSince = null;
    report.action = 'cancelled';
    report.reason = reason;
  };
  // 信号重新合格 / 取消后都要清零宽限计数，避免旧计数影响下一次判定。
  const clearGrace = () => {
    order.ineligibleRounds = 0;
    order.ineligibleSince = null;
  };

  if (order.error || order.nextTime < candleOpenAt(now, order.interval)
    || !signal || signal.validationIssues?.length
    || Date.parse(signal.dataAsOf) !== candleOpenAt(now, order.interval)) {
    report.reason = '行情或分析尚未就绪，保留原挂单。';
    return record();
  }

  // 1) 方向反转：立即取消。这是唯一「不打折」的取消条件。
  if (PENDING_REVIEW.cancelOnReversal
    && isOppositeDirection(signal.positionRecommendation, order.direction)) {
    cancel(`策略推荐方向已反转为 ${signal.positionRecommendation}，立即取消原挂单。`);
    return record();
  }

  // 2) 软门槛不合格：累计宽限，达到阈值才取消。
  if (!signal.eligible) {
    order.ineligibleRounds = (Number(order.ineligibleRounds) || 0) + 1;
    if (!Number(order.ineligibleSince)) order.ineligibleSince = now;
    const elapsed = now - Number(order.ineligibleSince);
    const elapsedMin = elapsed / 60000;
    const graceMs = PENDING_REVIEW.graceMinutes * 60000;
    if (order.ineligibleRounds >= PENDING_REVIEW.graceRounds || elapsed >= graceMs) {
      cancel(`连续 ${order.ineligibleRounds} 轮 / 持续 ${elapsedMin.toFixed(1)} 分钟不合格，`
        + `已达宽限上限（${PENDING_REVIEW.graceRounds} 轮 或 ${PENDING_REVIEW.graceMinutes} 分钟），取消挂单。`
        + `原因：${signal.reason || '信号不再合格'}`);
      return record();
    }
    report.action = HELD_INELIGIBLE;
    report.reason = `第 ${order.ineligibleRounds}/${PENDING_REVIEW.graceRounds} 轮不合格，宽限期内保留挂单`
      + `（已持续 ${elapsedMin.toFixed(1)}/${PENDING_REVIEW.graceMinutes} 分钟）：${signal.reason || ''}`;
    return record();
  }

  // 3) 信号合格：清零宽限计数。
  clearGrace();

  // 4) 默认不再改价：挂单挂出后价格与杠杆锁定，只保留或取消。
  if (PENDING_REVIEW.noReprice) {
    report.reason = '信号仍然合格，保留原挂单（挂出后不改价）。';
    return record();
  }

  // ↓↓↓ 以下为旧改价逻辑，仅在 NOFX_PENDING_NO_REPRICE=false 时生效（回退用）
  const plan = signal.plan;
  const long = order.direction === 'OPEN_LONG';
  if (!plan || ![plan.entryMin, plan.entryMax, plan.stopLoss, plan.takeProfit].every(v => Number.isFinite(v) && v > 0)
    || plan.entryMin > plan.entryMax
    || (long ? !(plan.stopLoss < plan.entryMin && plan.takeProfit > plan.entryMax)
      : !(plan.takeProfit < plan.entryMin && plan.stopLoss > plan.entryMax))
    || (plan.entryLimit != null && (!Number.isFinite(plan.entryLimit) || plan.entryLimit <= 0
      || (long ? !(plan.stopLoss < plan.entryLimit && plan.entryLimit < plan.takeProfit)
        : !(plan.takeProfit < plan.entryLimit && plan.entryLimit < plan.stopLoss))))) {
    report.reason = '新计划价格无效，保留原挂单。';
    return record();
  }
  const keys = ['entryMin', 'entryMax', 'entryLimit', 'stopLoss', 'takeProfit', 'maxHoldBars', 'riskUnit'];
  if (keys.every(key => plan[key] === order.plan[key])) return record();
  const effectiveFrom = nextOpenTime(candleOpenAt(now, order.interval), order.interval);
  Object.assign(report, { action: 'repriced', previous: { ...order.plan }, plan: { ...plan }, effectiveFrom });
  order.plan = { ...plan };
  order.initialPlan = { ...plan };
  order.protectionRevisions = [];
  order.leverage = Math.min(order.leverage, recommendedLeverage(plan, order.direction));
  order.notional = order.margin * order.leverage;
  order.nextTime = Math.max(order.nextTime, effectiveFrom);
  return record();
}
