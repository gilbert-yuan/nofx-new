/** Closed-candle features used by both offline replay and optional runtime entry filters. */
export const FEATURE_NAMES = Object.freeze(['trendReturn', 'trendEfficiency', 'atrPct', 'returnVolatility',
  'volumeRatio', 'volumeTrend', 'upperWickRatio', 'lowerWickRatio', 'rangePosition']);
const average = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export function klineFeatures(rows, options = {}) {
  const p = { lookbackBars: 72, trendBars: 24, atrPeriod: 14, volumePeriod: 20, ...options };
  const w = (rows || []).slice(-p.lookbackBars);
  if (w.length < Math.max(p.trendBars, p.atrPeriod, p.volumePeriod) + 1) return null;
  if (w.some(r => !['openTime', 'open', 'high', 'low', 'close', 'volume'].every(k => Number.isFinite(Number(r[k]))))) return null;
  const last = w.at(-1), trend = w.slice(-p.trendBars - 1), recent = w.slice(-p.volumePeriod);
  const previous = w.slice(-2 * p.volumePeriod, -p.volumePeriod);
  const returns = trend.slice(1).map((r, i) => Math.log(r.close / trend[i].close));
  const mean = average(returns);
  const travel = trend.slice(1).reduce((s, r, i) => s + Math.abs(r.close - trend[i].close), 0);
  const trueRanges = w.slice(-p.atrPeriod).map((r, i) => {
    const prev = w[w.length - p.atrPeriod - 1 + i].close;
    return Math.max(r.high - r.low, Math.abs(r.high - prev), Math.abs(r.low - prev));
  });
  const range = last.high - last.low, min = Math.min(...trend.map(r => r.low)), max = Math.max(...trend.map(r => r.high));
  const baseline = average(w.slice(-p.volumePeriod - 1, -1).map(r => r.volume));
  return { trendReturn: last.close / trend[0].close - 1,
    trendEfficiency: travel > 0 ? Math.abs(last.close - trend[0].close) / travel : 0,
    atrPct: average(trueRanges) / last.close,
    returnVolatility: Math.sqrt(average(returns.map(x => (x - mean) ** 2))),
    volumeRatio: baseline > 0 ? last.volume / baseline : null,
    volumeTrend: previous.length === p.volumePeriod && average(previous.map(r => r.volume)) > 0
      ? average(recent.map(r => r.volume)) / average(previous.map(r => r.volume)) : null,
    upperWickRatio: range > 0 ? (last.high - Math.max(last.open, last.close)) / range : 0,
    lowerWickRatio: range > 0 ? (Math.min(last.open, last.close) - last.low) / range : 0,
    rangePosition: max > min ? (last.close - min) / (max - min) : 0.5 };
}
export function validateFeatureRules(rules) {
  if (!Array.isArray(rules)) throw new Error('feature rules 必须为数组');
  for (const r of rules) {
    if (!FEATURE_NAMES.includes(r.feature) || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min > r.max)
      throw new Error(`无效特征规则 ${JSON.stringify(r)}`);
  }
  return rules;
}
export function matchFeatureRules(features, rules = [], missing = 'reject') {
  const failures = [];
  for (const rule of validateFeatureRules(rules)) {
    const x = features?.[rule.feature];
    if (!Number.isFinite(x)) { if (missing !== 'pass') failures.push(`${rule.feature}:missing`); }
    else if (x < rule.min || x > rule.max) failures.push(`${rule.feature}:${x} not in [${rule.min},${rule.max}]`);
  }
  return { passed: failures.length === 0, failures };
}
