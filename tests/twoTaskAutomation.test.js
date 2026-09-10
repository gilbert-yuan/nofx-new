import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalAutomation } from '../server/globalAutomation.js';
import { SimulatedAccount, accountSummary, advancePaperOrder } from '../server/simulatedAccount.js';
import { applyPendingReview } from '../server/shared/pendingReview.js';
import { candleOpenAt, nextOpenTime, PAPER_COSTS } from '../server/research.js';

const minute = 60000;
const now = candleOpenAt(Date.now(), '1m');
const plan = { entryMin: 99, entryMax: 101, entryLimit: 98, stopLoss: 90, takeProfit: 120, maxHoldBars: 120, riskUnit: 8 };
const pending = (extra = {}) => ({ id: 'p1', symbol: 'BTCUSDT', interval: '1m', marketProvider: 'okx', status: 'pending',
  direction: 'OPEN_LONG', nextTime: now, margin: 100, leverage: 3, notional: 300, costs: { ...PAPER_COSTS },
  plan: { ...plan }, initialPlan: { ...plan }, heldBars: 0, reviewHistory: [], ...extra });
const signal = (extra = {}) => ({ eligible: true, positionRecommendation: 'OPEN_LONG', plan: { ...plan, entryLimit: 97 },
  validationIssues: [], dataAsOf: new Date(now).toISOString(), ...extra });
const candle = (t, extra = {}) => ({ openTime: t, open: 105, high: 106, low: 104, close: 105, volume: 10, confirmed: true, ...extra });
const makeAutomation = (extra = {}) => new GlobalAutomation({ simulation: {}, market: {}, marketDb: {}, archive: {}, store: {}, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('only two tasks exist; each symbol is fetched and analyzed before the next fetch', async () => {
  const events = [];
  const automation = makeAutomation({ market: { perpetualUsdtContracts: async () => ['A', 'B', 'C'].map(symbol => ({ symbol })) } });
  assert.deepEqual(Object.keys(automation.tasks), ['klineSync', 'positionReview']);
  automation.getFreshMarket = async (symbol, interval, force) => {
    assert.equal(force, true); events.push(`fetch:${symbol}`);
    if (symbol === 'B') throw Error('market unavailable');
    return { symbol };
  };
  automation.runAnalysis = async ({ symbols, preparedMarket }) => {
    assert.equal(preparedMarket.symbol, symbols[0]);
    events.push(`analyze:${symbols[0]}`); events.push(`submit:${symbols[0]}`);
  };
  await automation.syncKlines();
  assert.deepEqual(events, ['fetch:A', 'analyze:A', 'submit:A', 'fetch:B', 'fetch:C', 'analyze:C', 'submit:C']);
  assert.equal(automation.tasks.klineSync.progress.failed, 1);
  assert.equal(automation.tasks.klineSync.progress.completed, 3);
  assert.throws(() => automation.configure('analysis', { enabled: true }), /Unknown/);
});

test('stop after fetch prevents analysis or submission for that symbol', async () => {
  const automation = makeAutomation({ market: { perpetualUsdtContracts: async () => [{ symbol: 'BTCUSDT' }] } });
  let active = true, analyzed = false;
  automation.getFreshMarket = async () => { active = false; return {}; };
  automation.runAnalysis = async () => { analyzed = true; };
  await automation.syncKlines(() => active);
  assert.equal(analyzed, false);
});

test('duplicate manual triggers share one run and stop invalidates the current run', async () => {
  const automation = makeAutomation();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let calls = 0, committed = 0;
  automation.syncKlines = async guard => { calls++; entered(); await gate; if (guard()) committed++; };
  const first = automation.triggerTask('klineSync');
  await ready;
  const second = automation.triggerTask('klineSync');
  automation.stop(); release();
  await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(committed, 0);
  assert.equal(automation.tasks.klineSync.running, false);
});

test('start is idempotent and stop clears both schedules', async () => {
  const automation = makeAutomation();
  let scans = 0, reviews = 0;
  automation.syncKlines = async () => { scans++; };
  automation.reviewPositions = async () => { reviews++; };
  try {
    automation.start(); automation.start();
    await tick(); await tick();
    assert.equal(scans, 1); assert.equal(reviews, 1);
    assert.equal(Object.values(automation.timers).filter(Boolean).length, 2);
  } finally { automation.stop(); }
  assert.equal(Object.values(automation.timers).filter(Boolean).length, 0);
});

test('pending repricing preserves id and margin, lowers risk and cannot fill retroactively', () => {
  const order = pending();
  const beforeNotional = order.notional;
  const result = applyPendingReview(order, signal(), now + 1000);
  assert.equal(result.action, 'repriced');
  assert.equal(order.id, 'p1'); assert.equal(order.margin, 100);
  assert.ok(order.notional <= beforeNotional);
  assert.equal(order.plan.entryLimit, 97);
  assert.equal(order.nextTime, now + minute);
  advancePaperOrder(order, [candle(now, { low: 96 })], now + minute);
  assert.equal(order.status, 'pending');
  advancePaperOrder(order, [candle(now + minute, { low: 96 })], now + 2 * minute);
  assert.equal(order.status, 'open');
  assert.equal(order.entryAt, new Date(now + minute).toISOString());
});

test('WAIT and opposite direction cancel pending orders and release reserves', () => {
  for (const replacement of [signal({ eligible: false, positionRecommendation: 'WAIT', plan: null }),
    signal({ positionRecommendation: 'OPEN_SHORT' })]) {
    const order = pending();
    const state = { initialBalance: 10000, orders: [order] };
    assert.ok(accountSummary(state).available < 10000);
    assert.equal(applyPendingReview(order, replacement, now).action, 'cancelled');
    assert.equal(order.reason, 'strategy_cancelled');
    assert.equal(accountSummary(state).available, 10000);
  }
});

test('missing, stale, invalid or incomplete analysis never cancels or reprices', () => {
  const cases = [null, signal({ validationIssues: ['missing data'] }),
    signal({ dataAsOf: new Date(now - minute).toISOString() }), signal({ plan: { ...plan, stopLoss: 110 } })];
  for (const replacement of cases) {
    const order = pending();
    assert.equal(applyPendingReview(order, replacement, now).action, 'held');
    assert.equal(order.status, 'pending'); assert.deepEqual(order.plan, plan);
  }
  const gap = pending({ nextTime: now - minute });
  assert.equal(applyPendingReview(gap, signal({ eligible: false }), now).action, 'held');
});

test('refresh pulls paginated active-order candles, ignores closed symbols and updates PnL', async () => {
  const calls = [], saved = [];
  const state = { initialBalance: 10000, orders: [pending({ nextTime: now - 4 * minute }),
    pending({ id: 'p2', nextTime: now - 2 * minute }), pending({ id: 'closed', symbol: 'ETHUSDT', status: 'closed', net: 12 })] };
  const sim = new SimulatedAccount({ pool: {}, marketDb: { saveKlines: async input => saved.push(input) },
    archive: { candles: () => { throw Error('Must not rely on stale local-only candles'); } },
    market: { maxPageSize: 2, storageSymbol: symbol => `OKX_PUBLIC_${symbol}`,
      klines: async args => {
        calls.push(args);
        return Array.from({ length: 2 }, (_, i) => candle(args.startTime + i * minute, { low: 97, close: 104 }));
      } } });
  sim.readLight = async () => structuredClone(state);
  sim.mutateLight = async fn => fn(state);
  sim.status = async () => accountSummary(state);
  const result = await sim.refresh();
  assert.equal(calls.length, 2); assert.equal(saved.length, 2);
  assert.ok(calls.every(call => call.symbol === 'BTCUSDT'));
  assert.ok(state.orders.slice(0, 2).every(order => order.status === 'open' && order.nextTime === now));
  assert.ok(result.unrealized > 0); assert.equal(result.realized, 12);
});

test('order management refreshes each active symbol once before pending review', async () => {
  const state = { orders: [pending(), pending({ id: 'p2' }), pending({ id: 'c', symbol: 'ETHUSDT', status: 'closed' })] };
  const events = [];
  const automation = makeAutomation({ store: { getConfig: async () => ({ analysis: { engine: 'local' } }) },
    simulation: { read: async () => structuredClone(state), getOrder: async id => state.orders.find(o => o.id === id),
      refresh: async ({ symbols }) => events.push(`refresh:${symbols[0]}`) } });
  automation.getFreshMarket = async symbol => { events.push(`market:${symbol}`); return {}; };
  automation.reviewPendingOrder = async order => events.push(`review:${order.id}`);
  await automation.reviewPositions();
  assert.deepEqual(events, ['refresh:BTCUSDT', 'market:BTCUSDT', 'review:p1', 'review:p2']);
  assert.equal(automation.tasks.positionReview.progress.completed, 2);
});
