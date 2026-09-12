import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceSpotMarket, marketStorageSymbol } from '../server/marketData.js';
import { fetchContinuousKlines } from '../server/continuousKlines.js';
import { KlineSync } from '../server/klineSync.js';
import { ResearchStore } from '../server/researchStore.js';
import { createResearchRecord, prepareMarket, candleOpenAt } from '../server/research.js';
import { BinancePositionMonitor, compatibleMarketPrice } from '../server/binancePositionMonitor.js';

const bar = 900000;
const raw = t => [t, '100', '105', '95', '102', '10', t + bar - 1, '1020', '100', '5', '510', '0'];
const response = payload => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload });

function fixture(count = 705) {
  const calls = [], all = Array.from({ length: count }, (_, i) => raw(i * bar));
  const fetchImpl = async url => {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    calls.push({ path: parsed.pathname, args: Object.fromEntries(params) });
    if (parsed.pathname.endsWith('/exchangeInfo')) return response({ symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', status: 'BREAK', isSpotTradingAllowed: true },
      { symbol: 'HIDDENUSDT', baseAsset: 'HIDDEN', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: false }
    ] });
    const start = params.has('startTime') ? Number(params.get('startTime')) : undefined;
    const end = params.has('endTime') ? Number(params.get('endTime')) : undefined;
    const limit = Number(params.get('limit'));
    let rows = all.filter(row => (start == null || row[0] >= start) && (end == null || row[0] <= end));
    if (start == null) rows = rows.slice(-limit); else rows = rows.slice(0, limit);
    return response(rows);
  };
  return { market: new BinanceSpotMarket({ fetchImpl, requestSpacingMs: 0 }), calls };
}

test('Binance Spot symbols coalesce and candles normalize base volume', async () => {
  const { market, calls } = fixture();
  await Promise.all([market.spotUsdtContracts(), market.spotUsdtContracts()]);
  assert.deepEqual(await market.spotUsdtSymbols(), ['BTCUSDT']);
  assert.equal(calls.length, 1);
  const rows = await market.klines({ symbol: 'BTCUSDT', limit: 1 });
  assert.equal(rows[0].volume, 10);
  assert.equal(rows[0].quoteVolume, 1020);
  assert.equal(rows[0].tradeCount, 100);
  assert.equal(market.status().provider, 'binance');
  assert.equal(market.status().marketType, 'spot');
  await assert.rejects(market.klines({ symbol: 'BTC-USDT' }), /现货币种/);
});

test('Binance forward pagination preserves inclusive start/end over multiple pages', async () => {
  const { market, calls } = fixture();
  const rows = await market.klines({ symbol: 'BTCUSDT', limit: 305, startTime: 100 * bar, endTime: 405 * bar - 1 });
  assert.equal(rows.length, 305);
  assert.equal(rows[0].openTime, 100 * bar);
  assert.equal(rows.at(-1).openTime, 404 * bar);
  assert.ok(rows.every((r, i) => !i || r.openTime - rows[i - 1].openTime === bar));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v3/klines');
  assert.equal(Number(calls[0].args.startTime), 100 * bar);
});

test('continuous catch-up honours Binance provider page size and resumes entire gap', async () => {
  const { market } = fixture();
  const pages = [];
  await fetchContinuousKlines({ client: market, symbol: 'BTCUSDT', interval: '15m', startTime: 0, now: 705 * bar, savePage: async rows => pages.push(rows) });
  assert.deepEqual(pages.map(page => page.length), [705]);
  assert.equal(pages.at(-1).at(-1).openTime, 704 * bar);
});

test('sync and archive use Binance provider namespace', async () => {
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
  assert.ok(keys.every(key => key === 'BINANCE_BTCUSDT'));
  const archive = new ResearchStore({ query: async (sql, args) => { keys.push(args[0]); return { rows: [] }; } });
  await archive.candles('BTCUSDT', '15m', 0, bar);
  assert.equal(keys.at(-1), 'BINANCE_BTCUSDT');
  assert.throws(() => marketStorageSymbol('BTCUSDT', 'unknown'));
});

test('source is frozen into analysis while execution venue stays Binance', () => {
  const now = 100 * bar;
  const market = prepareMarket({ symbol: 'BTCUSDT', interval: '15m', rows: [{ openTime: 99 * bar, open: 100, high: 105, low: 95, close: 102, volume: 10 }], limit: 1, now, marketProvider: 'binance' });
  const args = { config: { model: {} }, strategy: { interval: '15m' }, market: [market], result: { analyses: [{ symbol: 'BTCUSDT', action: 'WAIT', confidence: 0.5 }] }, type: 'single', scope: { limit: 1 }, now };
  const record = createResearchRecord(args);
  assert.equal(record.snapshot.marketProvider, 'binance');
  assert.equal(record.analyses[0].exchange, 'binance');
});

test('position review obtains reference candles from Binance public provider', async () => {
  const end = candleOpenAt(Date.now(), '15m');
  const publicMarket = { provider: 'binance', storageSymbol: symbol => marketStorageSymbol(symbol), klines: async () => Array.from({ length: 80 }, (_, i) => ({ openTime: end - (80 - i) * bar, open: 100, high: 105, low: 95, close: 100, volume: 10 })) };
  let key;
  const monitor = new BinancePositionMonitor({ publicMarket, marketDb: { saveKlines: async args => { key = args.symbol; } } });
  const data = await monitor.candles({ klines: () => { throw new Error('must not fetch execution-client candles'); } }, 'BTCUSDT', {});
  assert.equal(key, 'BINANCE_BTCUSDT');
  assert.equal(compatibleMarketPrice(data, 101), true);
  assert.equal(compatibleMarketPrice(data, 200), true);
});

test('provider pagination cannot loop forever on repeated boundaries', async () => {
  const { market } = fixture();
  market.fetchImpl = async () => response([raw(10 * bar), raw(10 * bar)]);
  await assert.rejects(market.klines({ symbol: 'BTCUSDT', limit: 2, startTime: 0 }), /未前进/);
});