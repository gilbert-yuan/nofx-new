import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrderReplayData } from '../server/orderReplay.js';
import { MarketDb } from '../server/marketDb.js';

const minute = 60000;
const start = Date.UTC(2026, 0, 1);
const order = { id: 'replay', symbol: 'ARBUSDT', marketProvider: 'okx', interval: '1m',
  entry: 100, entryAt: new Date(start + 20 * minute).toISOString(),
  exitAt: new Date(start + 30 * minute + 30000).toISOString(),
  direction: 'OPEN_LONG', status: 'closed', net: 1,
  plan: { entryMin: 99, entryMax: 101, stopLoss: 98, takeProfit: 104 } };
const candles = count => Array.from({ length: count }, (_, i) => ({
  openTime: start + i * minute, open: 100, high: 102, low: 99, close: 101, volume: 10
}));

test('replay queries provider namespace and historical range without latest-row cap', async () => {
  let query;
  const result = await getOrderReplayData(order, null, { listKlines: async args => {
    query = args; return candles(36);
  } });
  assert.equal(query.symbol, 'OKX_PUBLIC_ARBUSDT');
  assert.equal(query.startTime, start);
  assert.equal(query.endTime, start + 35 * minute);
  assert.equal(query.limit, null);
  assert.equal(result.error, undefined);
  assert.equal(result.klines.find(k => k.isExit).openTime, start + 30 * minute);
  assert.ok(Number.isFinite(result.diagnosis.score));
});

test('empty database falls back with pagination covering more than 1000 candles', async () => {
  const all = candles(1100), calls = [];
  const result = await getOrderReplayData({ ...order, exitAt: new Date(start + 1090 * minute).toISOString() }, {
    provider: 'okx', klines: async args => {
      calls.push(args);
      return all.filter(k => k.openTime >= args.startTime && k.openTime <= args.endTime);
    }
  }, { listKlines: async () => [] });
  assert.equal(result.error, undefined);
  assert.equal(calls.length, 4);
  assert.equal(result.klines.length, 1096);
});

test('fallback never mixes venues and empty data identifies requested market', async () => {
  const mismatch = await getOrderReplayData(order, { provider: 'binance', klines: async () => assert.fail() }, { listKlines: async () => [] });
  assert.match(mismatch.error, /当前行情来源为 binance/);
  const empty = await getOrderReplayData(order, { provider: 'okx', klines: async () => [] }, null);
  assert.match(empty.error, /无K线数据: okx ARBUSDT 1m/);
});

test('invalid timestamps and missing holding candles cannot generate a diagnosis', async () => {
  const badTime = await getOrderReplayData({ ...order, entryAt: 'invalid' }, null, null);
  assert.match(badTime.error, /时间无效/);
  for (const rows of [candles(10), candles(36).filter((_, i) => i !== 25)]) {
    const result = await getOrderReplayData(order, null, { listKlines: async () => rows });
    assert.match(result.error, /K线数据不完整/);
    assert.equal(result.diagnosis, undefined);
  }
});

test('MarketDb filters range before limit and retains default latest query behavior', async () => {
  const calls = [];
  const db = { pool: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } } };
  await MarketDb.prototype.listKlines.call(db, { symbol: 'OKX_PUBLIC_ARBUSDT', interval: '1m', startTime: start, endTime: start + minute, limit: null });
  assert.deepEqual(calls[0].params, ['OKX_PUBLIC_ARBUSDT', '1m', null, start, start + minute]);
  assert.match(calls[0].sql, /open_time >= \$4/);
  assert.match(calls[0].sql, /open_time <= \$5/);
  await MarketDb.prototype.listKlines.call(db, { symbol: 'BTCUSDT', interval: '1m' });
  assert.deepEqual(calls[1].params, ['BTCUSDT', '1m', 300, null, null]);
});
