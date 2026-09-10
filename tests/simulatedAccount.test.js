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
  return { id: short ? 'short' : 'long', marketProvider: 'okx', analyses: [{ symbol: 'BTCUSDT', marketProvider: 'okx', interval: '15m', eligible: true,
    positionRecommendation: short ? 'OPEN_SHORT' : 'OPEN_LONG', firstEntryAt: new Date(11 * bar).toISOString(), expiresAt: new Date(14 * bar).toISOString(), recommendedLeverage: 3,
    plan: { entryMin: 99, entryMax: 101, stopLoss: short ? 110 : 90, takeProfit: short ? 80 : 120, maxHoldBars: 12 } }] };
}
function order(short = false, input = {}) {
  const state = initialPaperAccount();
  const o = submitPaperOrder(state, record(short), { symbol: 'BTCUSDT', margin: 100, leverage: 3, ...input }, now);
  return { state, o };
}
const almost = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('paper reservation is funded, idempotent and refuses stale or invalid plans without credentials', () => {
  const { state, o } = order();
  assert.equal(o.notional, 300);
  almost(accountSummary(state).available, 10000 - 100 - 0.18);
  assert.equal(submitPaperOrder(state, record(), { symbol: 'BTCUSDT' }, now).id, o.id);
  assert.equal(state.orders.length, 1);
  for (const input of [{ margin: 10001 }, { margin: -1 }, { leverage: 6 }, { leverage: NaN }, { stopLoss: 105 }, { takeProfit: 95 }]) assert.throws(() => order(false, input));
  assert.throws(() => submitPaperOrder(initialPaperAccount(), record(), { symbol: 'BTCUSDT' }, 14 * bar), /过期/);
  const invalid = record(); invalid.analyses[0].eligible = false;
  assert.throws(() => submitPaperOrder(initialPaperAccount(), invalid, { symbol: 'BTCUSDT' }, now), /观望/);
});

test('no retroactive or unfinished-bar fills; pending reserves are released on expiry', () => {
  const { state, o } = order();
  advancePaperOrder(o, [candle(10 * bar), candle(11 * bar)], 11 * bar + 1);
  assert.equal(o.status, 'pending');
  advancePaperOrder(o, [11, 12, 13].map(t => candle(t * bar, { open: 105, high: 106, low: 104, close: 105 })), 14 * bar);
  assert.equal(o.status, 'expired');
  assert.equal(accountSummary(state).available, 10000);
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
