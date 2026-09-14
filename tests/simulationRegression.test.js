import test from 'node:test';
import assert from 'node:assert/strict';
import { advancePaperOrder, submitPaperOrder, initialPaperAccount, accountSummary } from '../server/simulatedAccount.js';
import { candleOpenAt, normalizePlan, prepareMarket, PAPER_COSTS, MAIN_INTERVAL, nextOpenTime } from '../server/research.js';
import { GlobalAutomation } from '../server/globalAutomation.js';
import { defineStrategy } from '../server/strategies/registry.js';

// 2026-09-14：super-trend-v1 的注册已从 builtins.js 移除。本文件需要一个「分析器可注入」
// 的策略来测自动化的归档/下单漏斗，故注册一个与原 super 策略同构的测试专用策略
//（analyze / prefilter 都走 ctx.deps 注入），并通过 store 显式启用它。
defineStrategy({
  id: 'test-inject-v1',
  name: '测试注入策略',
  description: '仅测试用：分析器通过 ctx.deps.superAnalysis 注入。',
  engine: 'super',
  modelId: 'test-inject-v1',
  priority: 99,
  analyze: (market, ctx = {}) => ctx.deps.superAnalysis.analyze(market, ctx.params),
  review: (order, market, ctx = {}) => ctx.deps.superAnalysis.reviewPosition(order, market),
  prefilter: (symbols, ctx = {}) => ctx.deps?.superAnalysis?.preFilter?.(symbols)
});

const bar = 60000;
const candle = (n, fields = {}) => ({ openTime: n * bar, open: 100, high: 101, low: 99, close: 100, volume: 10, confirmed: true, ...fields });
const plan = { entryMin: 99, entryMax: 101, stopLoss: 90, takeProfit: 120, validForBars: 3, maxHoldBars: 10 };
function pending() {
  return submitPaperOrder(initialPaperAccount(), { id: 'r', analyses: [{ symbol: 'BTCUSDT', marketProvider: 'okx', interval: '1m',
    eligible: true, positionRecommendation: 'OPEN_LONG', firstEntryAt: new Date(11 * bar).toISOString(), expiresAt: new Date(14 * bar).toISOString(), plan }] },
  { symbol: 'BTCUSDT', margin: 100, leverage: 3 }, 10 * bar);
}

test('all pending orders expire after 24 hours even without a new candle', () => {
  const order = pending();
  advancePaperOrder(order, [], 10 * bar + 24 * 60 * 60 * 1000 + 1);
  assert.equal(order.status, 'expired');
  assert.equal(order.reason, 'pending_expired');
});

test('unfinished and out-of-order rows never advance the checkpoint or mark price', () => {
  const order = pending();
  advancePaperOrder(order, [candle(11, { close: 101 }), candle(12, { close: 110, high: 111 })], 12 * bar + 1);
  assert.equal(order.nextTime, 12 * bar);
  assert.equal(order.markPrice, 101);
  assert.equal(order.markAt, new Date(12 * bar).toISOString());
  assert.ok(order.liquidationPrice > 0);
  advancePaperOrder(order, [candle(13), candle(12, { close: 102, high: 103 }), candle(11)], 13 * bar);
  assert.equal(order.nextTime, 13 * bar);
  assert.equal(order.markPrice, 102);
  assert.equal(order.heldBars, 2);
});

test('entry before a data gap persists and restart produces the same settlement as uninterrupted evaluation', () => {
  const order = pending(), uninterrupted = structuredClone(order);
  advancePaperOrder(order, [candle(11), candle(13)], 14 * bar);
  assert.equal(order.status, 'open');
  assert.equal(order.nextTime, 12 * bar);
  assert.equal(order.heldBars, 1);
  assert.match(order.error, /缺少/);
  const restored = JSON.parse(JSON.stringify(order));
  const tail = [candle(12), candle(13, { high: 121 })];
  advancePaperOrder(restored, tail, 14 * bar);
  advancePaperOrder(uninterrupted, [candle(11), ...tail], 14 * bar);
  for (const key of ['status', 'entry', 'entryAt', 'entryFee', 'quantity', 'net', 'heldBars', 'nextTime']) {
    assert.equal(restored[key], uninterrupted[key], key);
  }
});

test('same-bar entry and exit retain ledger fields and invested margin', () => {
  const order = pending();
  advancePaperOrder(order, [candle(11, { high: 121 })], 12 * bar);
  assert.equal(order.status, 'closed');
  assert.ok(order.entry > 0 && order.quantity > 0 && order.entryFee > 0);
  assert.equal(order.heldBars, 1);
  const summary = accountSummary({ initialBalance: 10000, orders: [order] });
  assert.equal(summary.investedMargin, 100);
  assert.equal(summary.balance, 10000 + order.net);
});

test('a candle cached before its close is a gap, even after wall time passes', () => {
  const order = pending();
  advancePaperOrder(order, [candle(11, { refreshedAt: new Date(11 * bar + 1000).toISOString() })], 12 * bar);
  assert.equal(order.status, 'pending');
  assert.equal(order.nextTime, 11 * bar);
  assert.match(order.error, /缺少/);
});

test('funding estimate uses full holding bars regardless of generation time within the candle', () => {
  const market = { symbol: 'BTCUSDT', interval: '1h', dataAsOf: new Date(0).toISOString() };
  const raw = { action: 'BUY', confidence: 0.8, plan };
  const costs = { ...PAPER_COSTS, fundingBpsPer8h: 100 };
  const early = normalizePlan(raw, market, 1, costs);
  const late = normalizePlan(raw, market, 3599999, costs);
  assert.equal(early.plan.netRewardRisk, late.plan.netRewardRisk);
});

test('analysis windows respect small requested limits and tolerate at most two missing leading bars', () => {
  const rows = Array.from({ length: 200 }, (_, i) => candle(i));
  const args = { symbol: 'BTCUSDT', interval: '1m', now: 200 * bar };
  assert.equal(prepareMarket({ ...args, rows, limit: 20 }).klines.length, 20);
  assert.equal(prepareMarket({ ...args, rows: rows.slice(122), limit: 80 }).klines.length, 78);
  assert.throws(() => prepareMarket({ ...args, rows: rows.slice(123), limit: 80 }), /不足/);
  assert.throws(() => prepareMarket({ ...args, rows: rows.slice(3), limit: 200 }), /不足/);
});

test('global automation archives all signals and only submits normalized, fresh plans', async () => {
  const records = new Map(), submitted = [];
  const automation = new GlobalAutomation({
    store: {
      getConfig: async () => ({ model: {}, analysis: { useSuperEnhanced: true } }),
      getStrategy: async () => ({ interval: '15m', rules: 'test' }),
      // 显式启用测试注入策略（缺省推导会落到 enhanced-trend-v1 的真实引擎）
      getStrategies: async () => ({ version: 1, enabled: ['test-inject-v1'], overrides: {}, notes: {}, updatedAt: null }),
      saveStrategies: async (s) => s
    },
    market: { perpetualUsdtContracts: async () => ['BTCUSDT', 'SHORTUSDT', 'BADUSDT', 'OLDUSDT', 'WAITUSDT'].map(symbol => ({ symbol })) },
    marketDb: {}, archive: { save: async record => records.set(record.id, record) },
    simulation: { submit: async input => {
      const record = records.get(input.recordId);
      submitted.push(submitPaperOrder(initialPaperAccount(), record, input));
    } }
  });
  automation.getFreshMarket = async symbol => ({ symbol, interval: MAIN_INTERVAL, marketProvider: 'okx',
    dataAsOf: new Date(candleOpenAt(Date.now(), MAIN_INTERVAL) - (symbol === 'OLDUSDT' ? nextOpenTime(0, MAIN_INTERVAL) : 0)).toISOString(), klines: [candle(0)] });
  automation.superAnalysis = {
    preFilter: async symbols => ({ filtered: symbols, removed: 0 }),
    analyze: async market => ({ symbol: market.symbol, action: market.symbol === 'WAITUSDT' ? 'WAIT' : market.symbol === 'SHORTUSDT' ? 'SELL' : 'BUY', confidence: 0.8,
      plan: market.symbol === 'BADUSDT' ? { ...plan, stopLoss: 110 } : market.symbol === 'SHORTUSDT' ? { ...plan, stopLoss: 110, takeProfit: 80 } : plan })
  };
  await automation.runAnalysis();
  assert.equal(records.size, 5);
  assert.equal(submitted.length, 2);
  assert.equal(submitted[0].symbol, 'BTCUSDT');
  assert.equal(submitted.find(order => order.symbol === 'SHORTUSDT').direction, 'OPEN_SHORT');
  for (const record of records.values()) {
    assert.ok(record.snapshot && record.strategyVersion);
    assert.equal(record.interval, MAIN_INTERVAL);
    assert.equal(record.marketProvider, 'okx');
    assert.ok(record.symbols.includes(record.symbol));
    if (!['BTCUSDT', 'SHORTUSDT'].includes(record.symbol)) assert.equal(record.analyses[0].eligible, false);
  }
});
