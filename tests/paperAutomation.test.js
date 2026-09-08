import test from 'node:test';
import assert from 'node:assert/strict';
import { automationDefaults, claimAutomationJob, applyPaperProtectionReview, PaperAutomation } from '../server/paperAutomation.js';
import { initialPaperAccount, submitPaperOrder, accountSummary, advancePaperOrder } from '../server/simulatedAccount.js';
import { candleOpenAt, PAPER_COSTS } from '../server/research.js';

const minute = 60000;
const candle = (time, extra = {}) => ({ openTime: time, open: 105, high: 110, low: 100, close: 105, volume: 10, confirmed: true, ...extra });
const currentWindow = () => {
  const end = candleOpenAt(Date.now(), '1m');
  return Array.from({ length: 80 }, (_, i) => candle(end - (80 - i) * minute, { open: 100 + i * 0.5, close: 100 + i * 0.5, high: 101 + i * 0.5, low: 99 + i * 0.5 }));
};
function openOrder(end = candleOpenAt(Date.now(), '1m')) {
  return { id: 'held-1', symbol: 'BTCUSDT', marketProvider: 'okx', interval: '1m', status: 'open', direction: 'OPEN_LONG',
    entry: 100, entryAt: new Date(end - minute).toISOString(), entryFee: 0.18, quantity: 3, margin: 100, notional: 300, leverage: 3,
    markPrice: 105, markAt: new Date(end).toISOString(), nextTime: end, heldBars: 1, liquidationPrice: 67.2,
    plan: { entryMin: 99, entryMax: 101, stopLoss: 90, takeProfit: 150, maxHoldBars: 120 }, costs: { ...PAPER_COSTS }, protectionRevisions: [] };
}

test('durable 2-hour and 5-minute schedules lease once and resume the same run after a crash', () => {
  const state = { automation: automationDefaults(100000) };
  const first = claimAutomationJob(state, 'scan', 'process-a', 100000);
  assert.equal(first.nextAt, 7300000);
  assert.equal(claimAutomationJob(state, 'scan', 'process-b', 100001), null);
  state.automation.scan.index = 35;
  const resumed = claimAutomationJob(state, 'scan', 'process-b', 280001);
  assert.equal(resumed.runId, first.runId); assert.equal(resumed.index, 35);
  assert.equal(claimAutomationJob(state, 'review', 'process-b', 399999), null);
  assert.ok(claimAutomationJob(state, 'review', 'process-b', 400000));
  state.automation.enabled = false;
  assert.equal(claimAutomationJob(state, 'scan', 'process-c', 9000000, true), null);
});

test('unlimited capital accepts over 20 orders and over initial balance, but retries do not duplicate signals', () => {
  const state = initialPaperAccount(); state.unlimitedCapital = true;
  const now = Date.now(), end = candleOpenAt(now, '1m');
  const record = { id: 'r0', analyses: [{ symbol: 'BTCUSDT', eligible: true, marketProvider: 'okx', interval: '1m', positionRecommendation: 'OPEN_LONG',
    firstEntryAt: new Date(end + minute).toISOString(), expiresAt: new Date(end + 7 * minute).toISOString(),
    plan: { entryMin: 99, entryMax: 101, stopLoss: 90, takeProfit: 120, maxHoldBars: 120 }, recommendedLeverage: 3 }] };
  for (let i = 0; i < 150; i++) submitPaperOrder(state, { ...record, id: `r${i}` }, { symbol: 'BTCUSDT', margin: 100, automatic: true }, now);
  submitPaperOrder(state, record, { symbol: 'BTCUSDT', margin: 100, automatic: true }, now);
  const summary = accountSummary(state);
  assert.equal(state.orders.length, 150); assert.equal(summary.usedMargin, 15000); assert.equal(summary.available, null);
  assert.equal(summary.investedMargin, 0); assert.equal(summary.realizedReturn, null);
  state.orders[0].status = 'closed'; Object.assign(state.orders[0], { entry: 100, net: 8 });
  assert.equal(accountSummary(state).investedMargin, 100); assert.equal(accountSummary(state).realizedReturn, 0.08);
});

test('protection revision applies only to a future unopened candle, preserving already observed ranges', () => {
  const end = 100 * minute, order = openOrder(end);
  const report = applyPaperProtectionReview(order, { action: 'UPDATE_PROTECTION', stopLoss: 98, takeProfit: 140, reason: 'trail' }, end + 10000);
  assert.equal(report.action, 'updated'); assert.equal(report.effectiveFrom, end + minute);
  assert.equal(order.initialPlan.stopLoss, 90); assert.equal(order.plan.stopLoss, 98);
  advancePaperOrder(order, [candle(end, { low: 95 })], end + minute);
  assert.equal(order.status, 'open');
  advancePaperOrder(order, [candle(end + minute, { low: 97 })], end + 2 * minute);
  assert.equal(order.reason, 'stop_loss'); assert.ok(Math.abs(order.exit - 98 * 0.9995) < 1e-9);
});

test('review refuses wider stops, stale data, bad levels and weak AI proposals', () => {
  const end = 100 * minute;
  for (const proposal of [{ stopLoss: 80, takeProfit: 140 }, { stopLoss: 110, takeProfit: 140 }, { stopLoss: NaN, takeProfit: 140 }]) {
    const order = openOrder(end);
    assert.equal(applyPaperProtectionReview(order, { action: 'UPDATE_PROTECTION', ...proposal }, end + 1000).action, 'held');
    assert.equal(order.plan.stopLoss, 90);
  }
  const order = openOrder(end);
  assert.equal(applyPaperProtectionReview(order, { action: 'UPDATE_PROTECTION', stopLoss: 98, takeProfit: 140, confidence: 0.2 }, end + 1000, 'ai').action, 'held');
  assert.equal(applyPaperProtectionReview(order, { action: 'UPDATE_PROTECTION', stopLoss: 98, takeProfit: 140 }, end + minute).action, 'held');
});

test('complete key-free scan uses cached minute data, archives every symbol and automatically submits fixed 100 margin', async () => {
  const state = initialPaperAccount(), records = new Map();
  const simulation = { mutate: async fn => fn(state), read: async () => structuredClone(state), refresh: async () => {} };
  const market = { provider: 'okx', storageSymbol: symbol => `OKX_PUBLIC_${symbol}`, perpetualUsdtContracts: async () => ['BTCUSDT', 'ETHUSDT'].map(symbol => ({ symbol })), klines: async () => { throw new Error('No external fetch required with fresh cache'); } };
  const archive = { get: async id => records.get(id), save: async record => records.set(record.id, record) };
  const automation = new PaperAutomation({ simulation, market, archive, store: { getConfig: async () => ({ model: {} }), getStrategy: async () => ({ interval: '1m' }) }, marketDb: { listKlines: async () => currentWindow() }, analyze: async () => { throw Error('No model key is used'); } });
  await automation.init(); await automation.run('scan');
  assert.equal(records.size, 2); assert.equal(state.orders.length, 2);
  assert.ok(state.orders.every(o => o.margin === 100 && o.automatic && o.interval === '1m'));
  assert.equal(state.automation.scan.submitted, 2); assert.equal(state.automation.scan.failed, 0); assert.equal(state.automation.scan.running, false);
  await automation.run('scan'); assert.equal(state.orders.length, 2);
  const order = openOrder(); order.markPrice = currentWindow().at(-1).close; state.orders = [order];
  await automation.run('review', true);
  assert.equal(state.automation.review.total, 1); assert.equal(state.automation.review.updated, 1);
  assert.equal(state.orders[0].reviewHistory.at(-1).action, 'updated');
});
