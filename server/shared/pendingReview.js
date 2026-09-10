import { candleOpenAt, nextOpenTime } from '../research.js';
import { recommendedLeverage } from '../localAnalysis.js';

// Apply only to orders that have already replayed through the latest closed bar.
export function applyPendingReview(order, signal, now = Date.now()) {
  if (order.status !== 'pending') return { action: 'held' };
  const report = { at: new Date(now).toISOString(), action: 'held', reason: signal?.reason || '保留原挂单。' };
  const record = () => {
    order.reviewHistory = [...(order.reviewHistory || []), report].slice(-50);
    return report;
  };
  if (order.error || order.nextTime < candleOpenAt(now, order.interval)
    || !signal || signal.validationIssues?.length
    || Date.parse(signal.dataAsOf) !== candleOpenAt(now, order.interval)) {
    report.reason = '行情或分析尚未就绪，保留原挂单。';
    return record();
  }
  if (!signal.eligible || signal.positionRecommendation !== order.direction) {
    order.status = 'cancelled';
    order.reason = 'strategy_cancelled';
    order.cancelledAt = report.at;
    report.action = 'cancelled';
    report.reason = signal.reason || '当前策略不再支持原挂单方向。';
    return record();
  }
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
