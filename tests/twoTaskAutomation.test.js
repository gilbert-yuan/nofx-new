import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalAutomation } from '../server/globalAutomation.js';
import { SimulatedAccount, accountSummary, advancePaperOrder } from '../server/simulatedAccount.js';
import { applyPendingReview, HELD_INELIGIBLE } from '../server/shared/pendingReview.js';
import { PENDING_REVIEW } from '../server/shared/strategyGuards.js';
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
// 软门槛不合格（量能/波动率类）的信号：eligible=false、无 plan、方向为 WAIT
const ineligibleAt = (t, extra = {}) => signal({ eligible: false, positionRecommendation: 'WAIT', plan: null,
  dataAsOf: new Date(candleOpenAt(t, '1m')).toISOString(), ...extra });
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

test('pending orders keep their original limit and leverage; repricing is off by default', () => {
  const order = pending();
  const result = applyPendingReview(order, signal(), now + 1000);
  assert.equal(result.action, 'held');
  assert.equal(order.status, 'pending');
  assert.equal(order.plan.entryLimit, 98);   // 未被改成信号里的 97
  assert.equal(order.leverage, 3);
  assert.equal(order.notional, 300);
  assert.deepEqual(order.initialPlan, plan); // 改价会重置 initialPlan，默认不允许
});

test('opposite direction cancels pending orders immediately and releases reserves', () => {
  const order = pending();
  const state = { initialBalance: 10000, orders: [order] };
  assert.ok(accountSummary(state).available < 10000);
  assert.equal(applyPendingReview(order, signal({ positionRecommendation: 'OPEN_SHORT' }), now).action, 'cancelled');
  assert.equal(order.reason, 'strategy_cancelled');
  assert.equal(accountSummary(state).available, 10000);
});

test('soft ineligibility is held within grace and only cancels after the grace is exhausted', () => {
  const rounds = PENDING_REVIEW.graceRounds;
  // 轮数宽限：每轮只推进 1 秒，避免时间阈值提前触发，单独验证轮数上限
  const byRounds = pending();
  for (let round = 1; round < rounds; round++) {
    const t = now + round * 1000;
    byRounds.nextTime = candleOpenAt(t, '1m');
    assert.equal(applyPendingReview(byRounds, ineligibleAt(t), t).action, HELD_INELIGIBLE, `第 ${round} 轮应在宽限内`);
    assert.equal(byRounds.status, 'pending');
  }
  const last = now + rounds * 1000;
  byRounds.nextTime = candleOpenAt(last, '1m');
  assert.equal(applyPendingReview(byRounds, ineligibleAt(last), last).action, 'cancelled');
  assert.equal(byRounds.reason, 'strategy_cancelled');

  // 时间宽限：第 1 轮保留，超过 graceMinutes 后第 2 轮即取消
  const byTime = pending();
  byTime.nextTime = candleOpenAt(now, '1m');
  assert.equal(applyPendingReview(byTime, ineligibleAt(now), now).action, HELD_INELIGIBLE);
  const later = now + (PENDING_REVIEW.graceMinutes + 5) * minute;
  byTime.nextTime = candleOpenAt(later, '1m');
  assert.equal(applyPendingReview(byTime, ineligibleAt(later), later).action, 'cancelled');

  // 未超过时间阈值时，即使多轮也必须保留
  const withinTime = pending();
  for (let round = 0; round < 20; round++) {
    const t = now + round * 60_000;
    withinTime.nextTime = candleOpenAt(t, '1m');
    assert.equal(applyPendingReview(withinTime, ineligibleAt(t), t).action, HELD_INELIGIBLE);
  }
  assert.equal(withinTime.status, 'pending');
});

test('grace counter resets once the signal becomes eligible again', () => {
  const order = pending();
  const t1 = now + minute;
  order.nextTime = candleOpenAt(t1, '1m');
  applyPendingReview(order, ineligibleAt(t1), t1);
  assert.equal(order.ineligibleRounds, 1);

  const t2 = now + 2 * minute;
  order.nextTime = candleOpenAt(t2, '1m');
  applyPendingReview(order, signal({ dataAsOf: new Date(candleOpenAt(t2, '1m')).toISOString() }), t2);
  assert.equal(order.ineligibleRounds, 0);
  assert.equal(order.ineligibleSince, null);

  // 重新不合格后从 1 开始数，不继承旧计数
  const t3 = now + 3 * minute;
  order.nextTime = candleOpenAt(t3, '1m');
  assert.equal(applyPendingReview(order, ineligibleAt(t3), t3).action, HELD_INELIGIBLE);
  assert.equal(order.ineligibleRounds, 1);
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
