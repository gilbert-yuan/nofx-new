import test from 'node:test';
import assert from 'node:assert/strict';
import { ResearchStore } from '../server/researchStore.js';

test('PostgreSQL archive migration, immutable snapshots, pagination and candle windows', { skip: process.env.RESEARCH_DB_TEST !== '1' }, async () => {
  await import('dotenv/config');
  const { MarketDb } = await import('../server/marketDb.js');
  const db = new MarketDb();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // Temporary tables shadow production tables and are rolled back after verification.
    await client.query(`CREATE TEMP TABLE research_records(id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, record JSONB NOT NULL);
      CREATE TEMP TABLE market_klines(symbol TEXT, interval TEXT, open_time BIGINT, open DOUBLE PRECISION, high DOUBLE PRECISION,
        low DOUBLE PRECISION, close DOUBLE PRECISION, volume DOUBLE PRECISION, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    const archive = new ResearchStore(client);
    const legacy = { id: 'legacy-test', at: '2026-09-05T01:00:00Z', researchOnly: true, symbol: 'BTCUSDT', analyses: [] };
    await archive.init([legacy]);
    await archive.init([legacy]);
    assert.equal((await archive.list()).length, 1);
    const record = { id: 'new-test', at: '2026-09-05T02:00:00Z', symbols: ['BTCUSDT', 'ETHUSDT'], market: [{ klines: [1] }], snapshot: { model: 'test' } };
    await archive.save(record);
    await archive.save({ ...record, snapshot: { model: 'mutated' } });
    assert.equal((await archive.get(record.id)).snapshot.model, 'test');
    const filtered = await archive.list({ symbol: 'ETHUSDT', date: '2026-09-05' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].snapshot, undefined);
    assert.equal(filtered[0].market, undefined);
    assert.equal((await archive.list({ date: '2026-09-04' })).length, 0);
    await client.query(`INSERT INTO research_records SELECT 'test-' || i, '2026-09-05T03:00:00Z'::timestamptz,
      jsonb_build_object('id', 'test-' || i) FROM generate_series(1, 105) AS i`);
    assert.equal((await archive.list({ limit: 100 })).length, 100);
    assert.equal((await archive.list({ limit: 100, offset: 100 })).length, 7);
    await client.query(`INSERT INTO market_klines(symbol,interval,open_time,open,high,low,close,volume) VALUES ('BINANCE_BTCUSDT','1h',100,100,101,99,100,1), ('BTCUSDT','1h',100,1,2,1,2,1), ('BINANCE_BTCUSDT','1h',200,100,101,99,100,1)`);
    const candles = await archive.candles('BTCUSDT', '1h', 100, 200);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].openTime, 100);
    assert.equal(candles[0].close, 100);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.pool.end();
  }
});
