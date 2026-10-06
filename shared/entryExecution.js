/** Entry semantics shared by opportunity reports, local fills and exchange execution. */
export function isMarketEntryPlan(plan) {
  return plan?.entryStyle === 'market'
    || !(Number.isFinite(Number(plan?.entryLimit)) && Number(plan.entryLimit) > 0);
}

/** A market signal only remains executable inside its original entry and protection bounds. */
export function marketEntryBlock(plan, price, direction) {
  const current = Number(price);
  const [min, max, stop, target] = ['entryMin', 'entryMax', 'stopLoss', 'takeProfit'].map(key => Number(plan?.[key]));
  if (![current, min, max, stop, target].every(value => Number.isFinite(value) && value > 0) || min > max) {
    return '市价或入场计划无效，等待重新分析。';
  }
  const long = direction === 'BUY' || direction === 'OPEN_LONG' || direction === 1;
  if (long ? current <= stop || current >= target : current >= stop || current <= target) {
    return '当前价已越过原计划的止损或止盈，原入场计划失效，等待重新分析。';
  }
  if (current < min || current > max) {
    return '当前价已偏离信号允许的入场区间，等待重新分析。';
  }
  return null;
}
