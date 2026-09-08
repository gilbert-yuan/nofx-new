import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxMarket, marketStorageSymbol } from '../server/marketData.js';
import { fetchContinuousKlines } from '../server/continuousKlines.js';
import { KlineSync } from '../server/klineSync.js';
import { ResearchStore } from '../server/researchStore.js';
import { createResearchRecord, prepareMarket, candleOpenAt } from '../server/research.js';
import { BinancePositionMonitor, compatibleMarketPrice } from '../server/binancePositionMonitor.js';

const bar = 900000;
const raw = t => [String(t), '100', '105', '95', '102', '1000', '10', '1020', '1'];
function fixture(count = 705) {
  const calls = [], all = Array.from({ length: count }, (_, i) => raw(i * bar));
  const client = { publicRequest: async (path, args) => {
    calls.push({ path, args });
    if (path.includes('/instruments')) return [
      { instId: 'BTC-USDT-SWAP', state: 'live', settleCcy: 'USDT', ctValCcy: 'BTC' },
      { instId: 'OLD-USDT-SWAP', state: 'suspend', settleCcy: 'USDT' }
    ];
    return all.filter(r => args.after == null || Number(r[0]) < args.after).reverse().slice(0, args.limit);
  } };
  return { market: new OkxMarket({ client, requestSpacingMs: 0 }), calls };
}

test('public symbols coalesce, require no Binance client, and candles normalize base volume independently', async () => {
  const { market, calls } = fixture();
  await Promise.all([market.perpetualUsdtContracts(), market.perpetualUsdtContracts()]);
  assert.deepEqual(await market.perpetualUsdtSymbols(), ['BTCUSDT']);
  assert.equal(calls.length, 1);
  market.client.publicRequest = async path => { assert.ok(path.includes('/candles')); return [raw(0)]; };
  const rows = await market.klines({ symbol: 'BTCUSDT', limit: 1 });
  assert.equal(rows[0].volume, 10); // Base units, not contract count 1000.
  assert.equal(rows[0].quoteVolume, 1020);
  assert.equal(rows[0].confirmed, true);
  assert.equal(market.status().provider, 'okx');
  await assert.rejects(market.klines({ symbol: 'BTC-USDT-SWAP' }), /没有对应/);
});

test('OKX exclusive reverse pagination preserves inclusive start/end over multiple pages', async () => {
  const { market, calls } = fixture();
  const rows = await market.klines({ symbol: 'BTCUSDT', limit: 305, startTime: 100 * bar, endTime: 405 * bar - 1 });
  assert.equal(rows.length, 305);
  assert.equal(rows[0].openTime, 100 * bar);
  assert.equal(rows.at(-1).openTime, 404 * bar);
  assert.ok(rows.every((r, i) => !i || r.openTime - rows[i - 1].openTime === bar));
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.path.endsWith('/history-candles') && c.args.limit <= 100));
  assert.equal(calls[0].args.after, 405 * bar);
});

test('continuous catch-up honours public provider page size and resumes entire 705-candle gap', async () => {
  const { market } = fixture();
  const pages = [];
  await fetchContinuousKlines({ client: market, symbol: 'BTCUSDT', interval: '15m', startTime: 0, now: 705 * bar, savePage: async rows => pages.push(rows) });
  assert.deepEqual(pages.map(p => p.length), [300, 300, 105]);
  assert.equal(pages.at(-1).at(-1).openTime, 704 * bar);
});

test('sync and archive use independent provider namespaces without overwriting Binance history', async () => {
  const latest = candleOpenAt(Date.now(), '15m') - bar;
  const { market } = fixture();
  market.klines = async () => [{ openTime: latest, open: 100, high: 105, low: 95, close: 102, volume: 10, confirmed: true }];
  const keys = [];
  const db = {
    getKlineSyncState: async ({ symbol }) => { keys.push(symbol); return {}; },
    getKlineResumeTime: async ({ symbol }) => { keys.push(symbol); },
    saveKlines: async ({ symbol, rows }) => { keys.push(symbol); return rows.length; },
    updateKlineSyncState: async ({ symbol }) => { keys.push(symbol); }
  };
  const sync = new KlineSync({ store: {}, marketDb: db, client: market });
  const result = await sync.fetchSymbols({ symbols: ['BTCUSDT'] });
  assert.equal(result.datasets[0].error, undefined);
  assert.ok(keys.every(k => k === 'OKX_PUBLIC_BTCUSDT'));
  const archive = new ResearchStore({ query: async (sql, args) => { keys.push(args[0]); return { rows: [] }; } });
  await archive.candles('BTCUSDT', '15m', 0, bar, 'okx');
  await archive.candles('BTCUSDT', '15m', 0, bar);
  assert.deepEqual(keys.slice(-2), ['OKX_PUBLIC_BTCUSDT', 'BINANCE_BTCUSDT']);
  assert.throws(() => marketStorageSymbol('BTCUSDT', 'unknown'));
});

test('source is frozen into analysis and strategy version, while execution venue stays Binance', () => {
  const now = 100 * bar;
  const market = prepareMarket({ symbol: 'BTCUSDT', interval: '15m', rows: [{ openTime: 99 * bar, open: 100, high: 105, low: 95, close: 102, volume: 10 }], limit: 1, now, marketProvider: 'okx' });
  const args = { config: { model: {} }, strategy: { interval: '15m' }, market: [market], result: { analyses: [{ symbol: 'BTCUSDT', action: 'WAIT', confidence: 0.5 }] }, type: 'single', scope: { limit: 1 }, now };
  const record = createResearchRecord(args);
  assert.equal(record.snapshot.marketProvider, 'okx');
  assert.equal(record.analyses[0].marketProvider, 'okx');
  assert.equal(record.analyses[0].exchange, 'binance');
  assert.notEqual(record.strategyVersion, createResearchRecord({ ...args, market: [{ ...market, marketProvider: 'binance' }] }).strategyVersion);
});

test('position review obtains reference candles only from public provider and rejects divergent execution prices', async () => {
  const end = candleOpenAt(Date.now(), '15m');
  const publicMarket = { provider: 'okx', storageSymbol: s => marketStorageSymbol(s), klines: async () => Array.from({ length: 80 }, (_, i) => ({ openTime: end - (80 - i) * bar, open: 100, high: 105, low: 95, close: 100, volume: 10 })) };
  let key;
  const monitor = new BinancePositionMonitor({ publicMarket, marketDb: { saveKlines: async args => { key = args.symbol; } } });
  const data = await monitor.candles({ klines: () => { throw new Error('must not fetch Binance candles'); } }, 'BTCUSDT', {});
  assert.equal(key, 'OKX_PUBLIC_BTCUSDT');
  assert.equal(compatibleMarketPrice(data, 101), true);
  assert.equal(compatibleMarketPrice(data, 120), false);
  assert.equal(compatibleMarketPrice(data, NaN), false);
});

test('provider pagination cannot loop forever on repeated boundaries', async () => {
  const { market } = fixture();
  market.client.publicRequest = async () => [raw(10 * bar)];
  await assert.rejects(market.klines({ symbol: 'BTCUSDT', limit: 2, endTime: 11 * bar }), /未前进/);
});
