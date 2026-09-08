import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketDb } from '../server/marketDb.js';
test('bulk candle persistence is atomic, updates overlaps and detects old gaps', { skip: process.env.RESEARCH_DB_TEST !== '1' }, async () => {
  await import('dotenv/config');
  const db = new MarketDb();
  const client = await db.pool.connect();
  const target = Object.create(MarketDb.prototype);
  target.pool = {
    connect: async () => ({ query: (...args) => client.query(...args), release() {} }),
    query: (...args) => client.query(...args)
  };
  try {
    await client.query('CREATE TEMP TABLE market_klines (LIKE public.market_klines INCLUDING ALL)');
    const rows = Array.from({ length: 1200 }, (_, i) => ({ openTime: i * 900000, closeTime: (i + 1) * 900000 - 1, open: 100, high: 102, low: 99, close: 101, volume: 1, quoteVolume: 101, tradeCount: 1 }));
    await target.saveKlines({ symbol: 'TESTUSDT', interval: '15m', rows });
    assert.equal(Number((await client.query('SELECT COUNT(*) FROM market_klines')).rows[0].count), 1200);
    await target.saveKlines({ symbol: 'TESTUSDT', interval: '15m', rows: [{ ...rows[0], close: 102 }, { ...rows[0], close: 100 }] });
    assert.equal((await client.query('SELECT close FROM market_klines WHERE open_time=0')).rows[0].close, 100);
    await client.query('DELETE FROM market_klines WHERE open_time=900000');
    assert.equal(await target.getKlineResumeTime({ symbol: 'TESTUSDT', interval: '15m' }), 0);
    await assert.rejects(target.saveKlines({ symbol: 'BROKEN', interval: '15m', rows: [...rows.slice(0, 501), { ...rows[501], close: null }] }));
    assert.equal(Number((await client.query("SELECT COUNT(*) FROM market_klines WHERE symbol='BROKEN'")).rows[0].count), 0);
  } finally {
    // TEMP table belongs only to this connection and disappears on disconnect.
    client.release(true);
    await db.pool.end();
  }
});
