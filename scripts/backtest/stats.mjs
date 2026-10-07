import { FEATURE_NAMES } from '../../shared/strategyFeatureFilter.js';
export const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export function quantile(xs, q) {
  const sorted = [...xs].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, a = Math.floor(i), b = Math.ceil(i);
  return sorted[a] + (sorted[b] - sorted[a]) * (i - a);
}
export function tradeMetrics(trades, initialBalance, finalEquity, maxDrawdown) {
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net < 0);
  const sum = (rows, key) => rows.reduce((a, b) => a + Number(b[key] || 0), 0);
  const profit = sum(wins, 'net'), loss = -sum(losses, 'net');
  return { initialBalance, finalEquity, net: finalEquity - initialBalance, returnRate: finalEquity / initialBalance - 1,
    maxDrawdown, trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null, profitFactor: loss > 0 ? profit / loss : null,
    noLosses: loss === 0 && profit > 0, fees: sum(trades, 'fees'), funding: sum(trades, 'funding'),
    turnover: sum(trades, 'notional'), grossProfit: profit, grossLoss: loss,
    ambiguousTrades: trades.filter(t => t.ambiguousBar).length,
    forcedClosures: trades.filter(t => t.periodEnd).length };
}
export function summarize(rows) {
  const valid = rows.filter(r => r.status === 'ok' && r.metrics);
  const trades = valid.reduce((s, r) => s + r.metrics.trades, 0), wins = valid.reduce((s, r) => s + r.metrics.wins, 0);
  const profit = valid.reduce((s, r) => s + r.metrics.grossProfit, 0), loss = valid.reduce((s, r) => s + r.metrics.grossLoss, 0);
  return { evaluatedCoins: rows.length, validCoins: valid.length, excludedCoins: rows.filter(r => r.status === 'excluded').length,
    errorCoins: rows.filter(r => !['ok', 'excluded'].includes(r.status)).length,
    profitableCoins: valid.filter(r => r.metrics.net > 0).length,
    meanReturn: valid.length ? mean(valid.map(r => r.metrics.returnRate)) : null, medianReturn: quantile(valid.map(r => r.metrics.returnRate), 0.5),
    meanDrawdown: valid.length ? mean(valid.map(r => r.metrics.maxDrawdown)) : null, worstDrawdown: valid.length ? Math.max(0, ...valid.map(r => r.metrics.maxDrawdown)) : null,
    trades, winRate: trades ? wins / trades : null, profitFactor: loss > 0 ? profit / loss : null,
    net: valid.reduce((s, r) => s + r.metrics.net, 0),
    accounting: '每币种独立初始资金；均值为等权横截面统计，不代表共享资金池的组合收益或回撤' };
}
export function objective(summary, options) {
  if (!summary.validCoins || summary.errorCoins || summary.trades < options.minTrades || summary.worstDrawdown > options.maxDrawdown) return null;
  if (options.objective === 'return') return summary.meanReturn;
  return summary.meanReturn - options.drawdownPenalty * summary.meanDrawdown
    - options.instabilityPenalty * Math.abs(summary.meanReturn - (summary.medianReturn || 0));
}
export function learnFeatures(training, options) {
  const positive = [], negative = [];
  for (const row of training) {
    if (row.status !== 'ok' || row.metrics.trades < options.minTradesPerCoin) continue;
    const target = row.metrics.net > 0 ? positive : negative;
    target.push({ symbol: row.symbol, samples: row.featureSamples });
  }
  const comparison = FEATURE_NAMES.map(feature => {
    // Each coin gets one vote, avoiding domination by a high-frequency symbol.
    const values = group => group.map(c => quantile(c.samples.map(s => s.features[feature]).filter(Number.isFinite), 0.5)).filter(Number.isFinite);
    const good = values(positive), bad = values(negative);
    const pooled = [...good, ...bad], spread = (quantile(pooled, 0.75) ?? 0) - (quantile(pooled, 0.25) ?? 0);
    const effect = spread > 0 ? Math.abs((quantile(good, 0.5) ?? 0) - (quantile(bad, 0.5) ?? 0)) / spread : 0;
    return { feature, profitableCoins: good.length, nonProfitableCoins: bad.length,
      profitableMedian: quantile(good, 0.5), nonProfitableMedian: quantile(bad, 0.5), effect,
      min: quantile(good, options.lowerQuantile), max: quantile(good, options.upperQuantile) };
  });
  const candidates = comparison.filter(r => r.profitableCoins >= options.minCoinsPerGroup && r.nonProfitableCoins >= options.minCoinsPerGroup
    && r.effect >= options.minEffect && r.min != null && r.max != null && r.max > r.min).sort((a, b) => b.effect - a.effect).slice(0, options.maxRules);
  return { trainingOnly: true, profitableSymbols: positive.map(c => c.symbol), nonProfitableSymbols: negative.map(c => c.symbol),
    comparison, rules: candidates.map(({ feature, min, max }) => ({ feature, min, max })),
    status: candidates.length ? 'candidate' : 'insufficient_or_no_discriminative_features',
    interpretation: '盈利币种入场时特征中位数的分位区间；描述性差异，不是因果证据或盈利概率' };
}
