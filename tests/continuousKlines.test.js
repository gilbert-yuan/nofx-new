import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchContinuousKlines } from '../server/continuousKlines.js';
import { KlineSync } from '../server/klineSync.js';
import { MarketDb } from '../server/marketDb.js';
const bar = 900000;
const candle = openTime => ({ openTime, open: 100, high: 102, low: 98, close: 101, volume: 10, quoteVolume: 1000, tradeCount: 1, closeTime: openTime + bar - 1 });
function exchange(end, failPage = 0) {
  const calls = [];
  return { calls, klines: async args => {
    calls.push(args);
    if (calls.length === failPage) throw new Error('exchange unavailable');
    const start = args.startTime ?? Math.max(0, end - args.limit * bar);
    const rows = [];
    for (let t = start; t < end && t <= args.endTime && rows.length < args.limit; t += bar) rows.push(candle(t));
    return rows;
  } };
}
test('multi-page catch-up starts at the old checkpoint, includes overlap, reaches frozen close boundary', async () => {
  const end = 2505 * bar, client = exchange(end), saved = [];
  await fetchContinuousKlines({ client, symbol: 'BTCUSDT', interval: '15m', startTime: 0, now: end + 100, savePage: async rows => saved.push(...rows) });
  assert.deepEqual(client.calls.map(c => c.startTime), [0, 1000 * bar, 2000 * bar]);
  assert.equal(saved.length, 2505);
  assert.equal(saved.at(-1).closeTime, end - 1);
  assert.ok(saved.every((r, i) => r.openTime === i * bar));
});
test('initial fetch uses the requested closed window; no forming candle is persisted', async () => {
  const end = 100 * bar, client = exchange(end), saved = [];
  await fetchContinuousKlines({ client, symbol: 'BTCUSDT', interval: '15m', limit: 80, now: end + 100, savePage: async rows => saved.push(...rows) });
  assert.equal(saved.length, 80);
  assert.equal(client.calls[0].startTime, undefined);
  assert.equal(client.calls[0].endTime, end - 1);
});
test('a missing candle or empty page is an error, never a successful checkpoint advance', async () => {
  for (const rows of [[], [candle(0), candle(2 * bar)]]) {
    let saves = 0;
    await assert.rejects(fetchContinuousKlines({ client: { klines: async () => rows }, symbol: 'BTCUSDT', interval: '15m', startTime: 0, now: 4 * bar, savePage: async () => saves++ }));
    assert.equal(saves, 0);
  }
});
test('failed second page retains the first committed checkpoint and retries from it', async () => {
  const end = Math.floor(Date.now() / bar) * bar, start = end - 2005 * bar;
  let state = { lastOpenTime: start };
  const stored = new Map();
  const marketDb = {
    getKlineSyncState: async () => state,
    getKlineResumeTime: async () => state.lastOpenTime,
    saveKlines: async ({ rows }) => { rows.forEach(r => stored.set(r.openTime, r)); return rows.length; },
    updateKlineSyncState: async value => { state = value; }
  };
  const client = exchange(end, 2);
  const sync = new KlineSync({ store: {}, marketDb, client });
  const failed = await sync.fetchSymbols({ symbols: ['BTCUSDT'] });
  assert.equal(failed.datasets[0].saved, 1000);
  assert.equal(state.lastOpenTime, start + 999 * bar);
  assert.equal(state.status, 'error');
  sync.client = exchange(end);
  await sync.fetchSymbols({ symbols: ['BTCUSDT'] });
  assert.equal(sync.client.calls[0].startTime, start + 999 * bar);
  assert.equal(state.status, 'ok');
  assert.equal(stored.size, 2005);
});
test('database resume uses earliest existing gap before the latest row', async () => {
  const db = Object.create(MarketDb.prototype);
  db.pool = { query: async () => ({ rows: [{ gap: '900000', latest: '9000000' }] }) };
  assert.equal(await db.getKlineResumeTime({ symbol: 'BINANCE_BTCUSDT', interval: '15m' }), bar);
  db.pool.query = async () => ({ rows: [{ gap: null, latest: '9000000' }] });
  assert.equal(await db.getKlineResumeTime({ symbol: 'BINANCE_BTCUSDT', interval: '15m' }), 10 * bar);
});
