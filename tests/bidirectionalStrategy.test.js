import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancedAnalysis, enhancedProtectionReview } from '../server/enhancedAnalysis.js';
import { createResearchRecord } from '../server/research.js';
import { initialPaperAccount, submitPaperOrder, advancePaperOrder } from '../server/simulatedAccount.js';
import { RISK_RULE } from '../server/shared/strategyGuards.js';
import { execFileSync } from 'node:child_process';

const bar = 900000;
function bearishMarket() {
  return { symbol: 'BTCUSDT', interval: '15m', marketProvider: 'okx', dataAsOf: new Date(80 * bar).toISOString(),
    klines: Array.from({ length: 80 }, (_, i) => {
      const close = 100 - i * 0.12 + 0.5 * Math.sin(i * 1.7);
      return { openTime: i * bar, open: close, close, high: close + 1, low: close - 1, volume: 1000, confirmed: true };
    }) };
}

test('enhanced bearish signal survives validation, submits short and settles profit on a decline', () => {
  const market = bearishMarket();
  const signal = enhancedAnalysis(market);
  assert.equal(signal.action, 'SELL', signal.reason);
  const plan = signal.plan;
  assert.ok(plan.stopLoss > plan.entryMax);
  assert.ok(plan.takeProfit3 < plan.takeProfit2 && plan.takeProfit2 < plan.takeProfit1 && plan.takeProfit1 < plan.entryMin);
  // 杠杆公式已抽到 shared RISK_RULE（riskBudgetPct 默认 0.1），ref 与生产一致：优先 entryLimit
  const levRef = Number.isFinite(plan.entryLimit) ? plan.entryLimit : plan.entryMin;
  assert.equal(plan.recommendedLeverage, Math.max(1, Math.min(RISK_RULE.maxLeverage, Math.floor(RISK_RULE.riskBudgetPct / ((plan.stopLoss - levRef) / levRef)))));
  const now = 80 * bar;
  const record = createResearchRecord({ config: { model: { model: 'enhanced-rules-v1', baseUrl: 'local://rules' } },
    strategy: { interval: '15m' }, market: [market], result: { analyses: [signal] }, type: 'single', scope: { limit: 80 }, now });
  assert.equal(record.analyses[0].eligible, true, JSON.stringify(record.analyses[0].validationIssues));
  assert.equal(record.analyses[0].interval, '15m');
  // 持仓上限按 K 线根数计算；挂单不设入场期限。
  assert.equal(plan.maxHoldBars, 120);
  assert.equal(plan.validForBars, undefined);
  assert.equal(record.analyses[0].plan.entryRule, 'limit_pullback');
  assert.equal(Date.parse(record.analyses[0].firstEntryAt), now + bar);
  assert.equal(record.analyses[0].expiresAt, undefined);
  const order = submitPaperOrder(initialPaperAccount(), record, { symbol: market.symbol, margin: 100, leverage: 2, automatic: true }, now);
  assert.equal(order.direction, 'OPEN_SHORT');
  const open = market.klines.at(-1).close;
  // 限价挂单（空头）：需当根 high 触达 entryLimit 才成交；随后 low 跌破 takeProfit 止盈。
  advancePaperOrder(order, [{ openTime: order.nextTime, open, high: plan.entryLimit + 0.1, low: plan.takeProfit - 0.1,
    close: plan.takeProfit, volume: 1000, confirmed: true }], order.nextTime + bar);
  assert.equal(order.reason, 'take_profit');
  assert.ok(order.net > 0);
});

test('enhanced analysis still allows bullish signals', () => {
  const market = bearishMarket();
  market.klines = market.klines.map(row => ({ ...row, open: 200 - row.open, close: 200 - row.close, high: 200 - row.low, low: 200 - row.high }));
  const signal = enhancedAnalysis(market);
  assert.equal(signal.action, 'BUY', signal.reason);
});

test('zero RSI is treated as oversold for short entries and protection reviews', () => {
  const market = bearishMarket();
  market.klines = market.klines.map((row, i) => ({ ...row, open: 100 - i * 0.1, close: 100 - i * 0.1, high: 101 - i * 0.1, low: 99 - i * 0.1 }));
  assert.match(enhancedAnalysis(market).reason, /RSI超卖/);
  const review = enhancedProtectionReview({ direction: 'OPEN_SHORT', entry: 110, plan: { stopLoss: 115, takeProfit: 80, entryMin: 110, entryMax: 110 } }, market);
  assert.equal(review.action, 'CLOSE');
  assert.match(review.reason, /RSI严重超卖/);
});

test('explicit long-only configuration is honored by all local rule entry points', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { localAnalysis, localAnalysisMultiTimeframe } from './server/localAnalysis.js';
    import { enhancedAnalysis } from './server/enhancedAnalysis.js';
    const market = { symbol: 'BTCUSDT', interval: '5m', klines: Array.from({ length: 80 }, (_, i) => {
      const close = 100 - i * 0.12 + 0.5 * Math.sin(i * 1.7);
      return { open: close, close, high: close + 1, low: close - 1, volume: 1000 };
    }) };
    const aux = Object.fromEntries(['15m', '1h', '4h'].map(interval => [interval, { ...market, interval }]));
    console.log(JSON.stringify([localAnalysis(market), localAnalysisMultiTimeframe(market, aux), enhancedAnalysis(market)]));
  `], { cwd: new URL('..', import.meta.url), env: { ...process.env, NOFX_LONG_ONLY: 'true' }, encoding: 'utf8' });
  for (const signal of JSON.parse(output.trim())) {
    assert.equal(signal.action, 'WAIT');
    assert.match(signal.reason, /NOFX_LONG_ONLY/);
  }
});
