import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancedAnalysis, enhancedProtectionReview } from '../server/enhancedAnalysis.js';
import { createResearchRecord } from '../server/research.js';
import { initialPaperAccount, submitPaperOrder, advancePaperOrder } from '../server/simulatedAccount.js';
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
  assert.equal(plan.recommendedLeverage, Math.max(1, Math.min(5, Math.floor(0.08 / ((plan.stopLoss - plan.entryMin) / plan.entryMin)))));
  const now = 80 * bar;
  const record = createResearchRecord({ config: { model: { model: 'enhanced-rules-v1', baseUrl: 'local://rules' } },
    strategy: { interval: '15m' }, market: [market], result: { analyses: [signal] }, type: 'single', scope: { limit: 80 }, now });
  assert.equal(record.analyses[0].eligible, true, JSON.stringify(record.analyses[0].validationIssues));
  assert.equal(record.analyses[0].interval, '15m');
  // P5：周期上限/有效期改为「按主周期根数」语义，不再硬编码 15m 的小时数。
  // 断言改为「与引擎常量一致 + 换算后的挂单时间正确」，这样周期回退 1m 时不会假失败。
  assert.equal(plan.maxHoldBars, 120);
  assert.equal(plan.validForBars, 6);
  assert.equal(Date.parse(record.analyses[0].firstEntryAt), now + bar);
  // 有效期从「首个可入场根」起算：firstEntryAt + validForBars 根。
  assert.equal(Date.parse(record.analyses[0].expiresAt), now + (1 + plan.validForBars) * bar);
  const order = submitPaperOrder(initialPaperAccount(), record, { symbol: market.symbol, margin: 100, leverage: 2, automatic: true }, now);
  assert.equal(order.direction, 'OPEN_SHORT');
  const open = market.klines.at(-1).close;
  advancePaperOrder(order, [{ openTime: order.nextTime, open, high: open + 0.1, low: plan.takeProfit - 0.1,
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
  const review = enhancedProtectionReview({ direction: 'OPEN_SHORT', entry: 110, plan: { stopLoss: 115, takeProfit: 80 } }, market);
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
