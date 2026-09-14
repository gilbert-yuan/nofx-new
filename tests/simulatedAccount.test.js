import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary, initialPaperAccount, submitPaperOrder, advancePaperOrder, settlePaperOrder, SimulatedAccount, registerSimulationRoutes } from '../server/simulatedAccount.js';
import express from 'express';
import { localAnalysis, recommendedLeverage } from '../server/localAnalysis.js';
import 'dotenv/config';
import { isolatedSimulatedDatabase } from './helpers/simulatedDatabase.js';

const bar = 900000, now = 10 * bar;
const candle = (time, overrides = {}) => ({ openTime: time, open: 100, high: 101, low: 99, close: 100, volume: 10, confirmed: true, ...overrides });
function record(short = false) {
  return { id: short ? 'short' : 'long', marketProvider: 'binance', analyses: [{ symbol: 'BTCUSDT', marketProvider: 'binance', interval: '15m', eligible: true,
    positionRecommendation: short ? 'OPEN_SHORT' : 'OPEN_LONG', firstEntryAt: new Date(11 * bar).toISOString(), expiresAt: new Date(14 * bar).toISOString(), recommendedLeverage: 3,
    // 显式关闭分批止盈：本文件断言的是「整笔止盈」的老费率/ROI 算术；
    // 分批出场自身的行为在 bidirectional/paperAutomation 等用例覆盖。
    plan: { entryMin: 99, entryMax: 101, stopLoss: short ? 110 : 90, takeProfit: short ? 80 : 120, maxHoldBars: 12,
      exitRules: { partialTp: { enabled: false } } } }] };
}
function order(short = false, input = {}) {
  const state = initialPaperAccount();
  const o = submitPaperOrder(state, record(short), { symbol: 'BTCUSDT', margin: 100, leverage: 3, ...input }, now);
  return { state, o };
}
const almost = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('paper reservation is funded, idempotent and refuses invalid plans without credentials', () => {
  const { state, o } = order();
  assert.equal(o.notional, 300);
  almost(accountSummary(state).available, 10000 - 100 - 0.18);
  assert.equal(submitPaperOrder(state, record(), { symbol: 'BTCUSDT' }, now).id, o.id);
  assert.equal(state.orders.length, 1);
  const binanceRecord = record(); binanceRecord.marketProvider = 'binance'; binanceRecord.analyses[0].marketProvider = 'binance';
  const binanceOrder = submitPaperOrder(initialPaperAccount(), binanceRecord, { symbol: 'BTCUSDT' }, now);
  assert.equal(binanceOrder.marketProvider, 'binance');
  for (const input of [{ margin: 10001 }, { margin: -1 }, { leverage: 6 }, { leverage: NaN }, { stopLoss: 105 }, { takeProfit: 95 }]) assert.throws(() => order(false, input));
  const late = submitPaperOrder(initialPaperAccount(), record(), { symbol: 'BTCUSDT' }, 14 * bar);
  assert.equal(late.status, 'pending');
  assert.equal(late.nextTime, 15 * bar);
  assert.equal(late.expiresAt, new Date(14 * bar + 24 * 60 * 60 * 1000).toISOString());
  const noDeadline = record(); delete noDeadline.analyses[0].expiresAt;
  assert.equal(submitPaperOrder(initialPaperAccount(), noDeadline, { symbol: 'BTCUSDT' }, now).status, 'pending');
  const invalid = record(); invalid.analyses[0].eligible = false;
  assert.throws(() => submitPaperOrder(initialPaperAccount(), invalid, { symbol: 'BTCUSDT' }, now), /观望/);
});

test('new paper pending orders mirror to Binance Demo as idempotent limit orders', async () => {
  const state = initialPaperAccount();
  const calls = [];
  const config = { binance: { apiKey: 'demo-key', secretKey: 'demo-secret', demo: true, testnet: false },
    trader: { enabled: true, dryRun: false, syncPaperOrdersToDemo: true } };
  const client = {
    exchangeInfo: async () => ({ symbols: [{ symbol: 'BTCUSDT', filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', minQty: '0.001', stepSize: '0.001' },
      { filterType: 'MIN_NOTIONAL', notional: '5' }
    ] }] }),
    setLeverage: async input => { calls.push({ leverage: true, ...input }); },
    limitOrder: async input => { calls.push(input); return { orderId: 321, status: 'NEW' }; },
    cancelOrder: async input => { calls.push({ cancel: true, ...input }); return { status: 'CANCELED', orderId: 321 }; }
  };
  const simulation = new SimulatedAccount({
    pool: {}, archive: { get: async () => { const r = record(); r.analyses[0].plan.entryLimit = 100; return r; } }, market: { provider: 'binance' },
    store: { getConfig: async () => config }, clientFactory: () => client
  });
  simulation.mutateLight = async fn => fn(state);
  const created = await simulation.submit({ recordId: 'long', symbol: 'BTCUSDT', margin: 100, leverage: 3 });
  assert.equal(created.status, 'pending');
  assert.equal(created.exchange.status, 'new');
  assert.equal(created.exchange.orderId, 321);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { leverage: true, symbol: 'BTCUSDT', leverage: 3 });
  assert.deepEqual(calls[1], { symbol: 'BTCUSDT', side: 'BUY', quantity: 3, price: 100, timeInForce: 'GTC', clientOrderId: created.exchange.clientOrderId });
  await simulation.close(created.id, { refresh: false });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].cancel, true);
  assert.equal(calls[2].clientOrderId, created.exchange.clientOrderId);
  assert.equal(created.exchange.status, 'canceled');
});

test('old-provider orders are isolated instead of replayed with Binance candles', async () => {
  const { o } = order();
  o.marketProvider = 'okx';
  const state = { initialBalance: 10000, orders: [o] };
  const simulation = Object.create(SimulatedAccount.prototype);
  Object.assign(simulation, {
    market: { provider: 'binance', klines: async () => { throw new Error('must not fetch cross-provider candles'); } },
    readLight: async () => state,
    mutateLight: async fn => fn(state),
    status: async () => ({ orders: state.orders })
  });
  await simulation.refreshOrders();
  assert.match(o.error, /旧订单不会使用不同交易所的 K 线推进/);
  assert.equal(o.status, 'pending');
});
test('all pending orders expire after the unified 24-hour TTL', () => {
  const { state, o } = order();
  assert.equal(o.expiresAt, new Date(now + 24 * 60 * 60 * 1000).toISOString());
  advancePaperOrder(o, [candle(11 * bar)], 11 * bar + 1);
  assert.equal(o.status, 'pending');
  advancePaperOrder(o, [], now + 24 * 60 * 60 * 1000 + 1);
  assert.equal(o.status, 'expired');
  assert.equal(o.reason, 'pending_expired');
  assert.equal(o.expiresAt, new Date(now + 24 * 60 * 60 * 1000).toISOString());
  almost(accountSummary(state).available, 10000);
});

test('3x changes position size once; long TP books exact gross, fees, funding and margin ROI', () => {
  const { state, o } = order();
  advancePaperOrder(o, [candle(11 * bar, { high: 121, low: 99, close: 120 })], 12 * bar);
  assert.equal(o.reason, 'take_profit');
  const entry = 100 * 1.0005, exit = 120 * 0.9995, quantity = 300 / entry;
  const gross = (exit - entry) * quantity, fees = 0.18 + exit * quantity * 0.0006, funding = 300 * 0.0003 / 32;
  almost(o.gross, gross); almost(o.fees, fees); almost(o.funding, funding); almost(o.net, gross - fees - funding);
  almost(o.roi, o.net / 100); almost(accountSummary(state).balance, 10000 + o.net);
  almost(accountSummary(state).available, 10000 + o.net);
  const saved = JSON.stringify(o); advancePaperOrder(o, [candle(11 * bar)], 20 * bar); assert.equal(JSON.stringify(o), saved);
});

test('short TP profits and simultaneous TP/SL stops conservatively', () => {
  const { o } = order(true);
  advancePaperOrder(o, [candle(11 * bar, { low: 79, high: 101, close: 80 })], 12 * bar);
  assert.equal(o.reason, 'take_profit'); assert.ok(o.net > 0);
  const both = order().o;
  advancePaperOrder(both, [candle(11 * bar, { low: 89, high: 121 })], 12 * bar);
  assert.equal(both.reason, 'stop_loss'); assert.equal(both.ambiguousBar, true); assert.ok(both.net < 0);
});

test('gaps freeze checkpoints; restart resumes once and gap-through stops use worse opening price', () => {
  const { o } = order();
  advancePaperOrder(o, [], 12 * bar);
  assert.equal(o.nextTime, 11 * bar); assert.match(o.error, /缺少/);
  const resumed = JSON.parse(JSON.stringify(o));
  advancePaperOrder(resumed, [candle(11 * bar)], 12 * bar);
  assert.equal(resumed.status, 'open');
  advancePaperOrder(resumed, [candle(12 * bar, { open: 85, high: 88, low: 84, close: 86 })], 13 * bar);
  assert.equal(resumed.reason, 'stop_loss'); almost(resumed.exit, 85 * 0.9995);
});

test('isolated liquidation caps collateral loss and cannot spend another order margin', () => {
  const { state, o } = order(false, { leverage: 5, stopLoss: 50 });
  advancePaperOrder(o, [candle(11 * bar)], 12 * bar);
  advancePaperOrder(o, [candle(12 * bar, { open: 10, high: 15, low: 5, close: 10 })], 13 * bar);
  assert.equal(o.reason, 'liquidation');
  almost(o.net, -100 - o.entryFee); assert.ok(o.isolatedLossAdjustment > 0);
  almost(accountSummary(state).balance, 10000 - 100 - o.entryFee);
});

test('timeout, mark-to-market and manual close update ledger without double fees', () => {
  const { state, o } = order(); o.plan.maxHoldBars = 2;
  advancePaperOrder(o, [candle(11 * bar, { close: 101 })], 12 * bar);
  almost(accountSummary(state).balance, 10000 - o.entryFee);
  almost(accountSummary(state).equity, 10000 - o.entryFee + o.unrealized);
  advancePaperOrder(o, [candle(12 * bar)], 13 * bar); assert.equal(o.reason, 'timeout');
  const manual = order().o; advancePaperOrder(manual, [candle(11 * bar)], 12 * bar);
  settlePaperOrder(manual, 105, 'manual', 12 * bar); assert.equal(manual.reason, 'manual'); assert.ok(manual.net > 0);
});

test('key-free local analysis emits transparent trend/ATR plans, flat markets WAIT, leverage is capped', () => {
  const rows = Array.from({ length: 80 }, (_, i) => candle(i * bar, { open: 100 + i * 0.2, close: 100 + i * 0.2, high: 101 + i * 0.2, low: 99 + i * 0.2 }));
  const result = localAnalysis({ symbol: 'BTCUSDT', klines: rows });
  assert.equal(result.action, 'BUY'); assert.ok(result.plan.stopLoss < result.plan.entryMin && result.plan.takeProfit > result.plan.entryMax);
  assert.equal(localAnalysis({ symbol: 'BTCUSDT', klines: rows.map(r => candle(r.openTime)) }).action, 'WAIT');
  assert.equal(recommendedLeverage({ entryMin: 99, entryMax: 100, stopLoss: 99.9 }, 'OPEN_LONG'), 5);
  assert.equal(recommendedLeverage({ entryMin: 99, entryMax: 100, stopLoss: 50 }, 'OPEN_LONG'), 1);
});

test('plan candidates include legacy deadlines and plans without deadlines', async () => {
  const legacy = record();
  const current = record(true); delete current.analyses[0].expiresAt;
  const excluded = record(); excluded.analyses[0].eligible = false;
  const app = express();
  registerSimulationRoutes(app, { archive: { list: async () => [legacy, current, excluded] } });
  let server;
  try {
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/paper/plans`);
    assert.equal(response.status, 200);
    const plans = await response.json();
    assert.deepEqual(plans.map(p => p.recordId), ['long', 'short']);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
  }
});

test('PostgreSQL simulation ledger persists changes atomically and survives a service restart', { skip: process.env.RESEARCH_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const pool = db.pool;
    const sim = new SimulatedAccount({ pool });
    await sim.init();
    await sim.mutate(state => { submitPaperOrder(state, record(), { symbol: 'BTCUSDT' }, now); });
    await assert.rejects(sim.mutate(state => { state.initialBalance = 1; throw Error('rollback'); }), /rollback/);
    const restored = new SimulatedAccount({ pool });
    const status = await restored.status();
    assert.equal(status.initialBalance, 10000); assert.equal(status.orders.length, 1); assert.equal(status.openCount, 1);
  } finally { await db.close(); }
});

test('key-free HTTP order submit, duplicate retry, cancel and refresh preserve the isolated test ledger', { skip: process.env.RESEARCH_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  let server;
  try {
    const pool = db.pool;
    const sample = record(), next = Math.floor(Date.now() / bar) * bar + bar;
    sample.analyses[0].firstEntryAt = new Date(next).toISOString(); sample.analyses[0].expiresAt = new Date(next + 3 * bar).toISOString();
    const sim = new SimulatedAccount({ pool, archive: { get: async () => sample }, market: { klines: async () => { throw Error('Future candles must not be requested'); } } });
    await sim.init();
    const app = express(); app.use(express.json()); registerSimulationRoutes(app, sim);
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/api/paper`;
    const post = async (path, body = {}) => { const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); return r.json(); };
    const first = await post('/orders', { recordId: sample.id, symbol: 'BTCUSDT', margin: 100, leverage: 3 });
    assert.equal(first.status, 'pending');
    const again = await post('/orders', { recordId: sample.id, symbol: 'BTCUSDT', margin: 100, leverage: 3 });
    assert.equal(again.id, first.id);
    almost((await (await fetch(url + '/account')).json()).available, 9899.82);
    assert.equal((await post(`/orders/${first.id}/close`)).status, 'cancelled');
    const result = await post('/refresh');
    assert.equal(result.balance, 10000); assert.equal(result.available, 10000); assert.equal(result.orders.length, 1); assert.equal(result.openCount, 0);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); }
});

test('autoMarginPct sizes margin from current equity and compounds with the account', () => {
  // 10000U 默认账户 × 5% = 500 保证金
  const { state, o } = order(false, { autoMarginPct: 0.05, margin: undefined, leverage: 3 });
  assert.equal(o.margin, 500);
  assert.equal(o.notional, 1500);
  // 显式 margin 优先于 autoMarginPct
  const explicit = submitPaperOrder(initialPaperAccount(), record(), { symbol: 'BTCUSDT', margin: 100, autoMarginPct: 0.05, leverage: 3 }, now);
  assert.equal(explicit.margin, 100);
  // 权益过小：自动仓位不足 1U 时明确拒绝
  const tiny = initialPaperAccount(); tiny.initialBalance = 10;
  assert.throws(() => submitPaperOrder(tiny, record(), { symbol: 'BTCUSDT', autoMarginPct: 0.05, leverage: 3 }, now), /不足 1 USDT/);
  // 浮动盈亏计入权益：持仓浮盈 100 → 权益 10100 → 下一单 505
  state.orders[0].status = 'open'; state.orders[0].entry = 100; state.orders[0].quantity = 10;
  state.orders[0].notional = 1000; state.orders[0].unrealized = 100; state.orders[0].entryFee = 0;
  const rec2 = { ...record(), id: 'long-2', analyses: [{ ...record().analyses[0], symbol: 'ETHUSDT' }] };
  const o2 = submitPaperOrder(state, rec2, { symbol: 'ETHUSDT', autoMarginPct: 0.05, leverage: 3 }, now);
  assert.equal(o2.margin, Math.floor(10100 * 0.05 * 100) / 100);
});

test('PUT /api/paper/capital re-bases initial balance and persists it', { skip: process.env.RESEARCH_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  let server;
  try {
    const pool = db.pool;
    const sim = new SimulatedAccount({ pool });
    await sim.init();
    const app = express(); app.use(express.json()); registerSimulationRoutes(app, sim);
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/api/paper`;
    const put = async (path, body) => { const r = await fetch(url + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); return r.json(); };
    const bad = await fetch(url + '/capital', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initialBalance: 0 }) });
    assert.equal(bad.status, 400);
    const result = await put('/capital', { initialBalance: 100 });
    assert.equal(result.initialBalance, 100);
    const status = await (await fetch(url + '/account')).json();
    assert.equal(status.initialBalance, 100); assert.equal(status.balance, 100);
    const restored = new SimulatedAccount({ pool }); await restored.init();
    assert.equal((await restored.status()).initialBalance, 100);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await db.close(); }
});
