/**
 * 连续亏损熔断：最近已平仓单从最新往回数，连亏达到阈值则暂停新开仓。
 */
import { AUTO_TRADE } from '../../shared/autoTradeDefaults.js';

export function consecutiveLossStreak(orders = [], lookback = AUTO_TRADE.consecutiveLossLookback) {
  const closed = (orders || [])
    .filter(order => Number.isFinite(Number(order.net))
      && (order?.status === 'closed' || order?.status == null)
      && order?.exitAt)
    .sort((a, b) => Date.parse(b.exitAt || 0) - Date.parse(a.exitAt || 0))
    .slice(0, lookback);
  let streak = 0;
  for (const order of closed) {
    if (Number(order.net) > 0) break;
    streak += 1;
  }
  return { streak, sample: closed.length };
}

export function shouldHaltNewEntries(orders = [], params = AUTO_TRADE) {
  const { streak, sample } = consecutiveLossStreak(orders, params.consecutiveLossLookback);
  if (streak >= params.consecutiveLossHalt) {
    return {
      halt: true,
      streak,
      sample,
      reason: `连续亏损 ${streak} 笔，达到熔断阈值 ${params.consecutiveLossHalt}`
    };
  }
  return { halt: false, streak, sample, reason: '' };
}
