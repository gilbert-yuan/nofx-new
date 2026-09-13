import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceMarket } from '../server/binanceMarket.js';
import { marketStorageSymbol } from '../server/marketData.js';
import { fetchContinuousKlines } from '../server/continuousKlines.js';
import { KlineSync } from '../server/klineSync.js';
import { ResearchStore } from '../server/researchStore.js';
import { createResearchRecord, prepareMarket, candleOpenAt } from '../server/research.js';
import { BinancePositionMonitor, compatibleMarketPrice } from '../server/binancePositionMonitor.js';

const bar = 900000;
const raw = t => [t, '100', '105', '95', '102', '10', t + bar - 1, '1020', '100', '5', '510', '0'];

// 合约行情源的下游依赖 BinanceClient（exchangeInfo / klines），测试用桩客户端替代真实网络。
function fixture(count = 705) {
  const all = Array.from({ length: count }, (_, i) => raw(i * bar));
  let exchangeCalls = 0;
  const client = {
    exchangeInfo: async () => {
      exchangeCalls++;
      return { symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', marginAsset: 'USDT', filters: [] },
        { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', status: 'BREAK', contractType: 'PERPETUAL', marginAsset: 'USDT' },
        { symbol: 'QUARTERUSDT', baseAsset: 'Q', quoteAsset: 'USDT', status: 'TRADING', contractType: 'CURRENT_QUARTER', marginAsset: 'USDT' }
      ] };
    },
    klines: async ({ startTime, endTime, limit }) => {
      const start = startTime == null ? undefined : Number(startTime);
      const end = endTime == null ? undefined : Number(endTime);
      let rows = all.filter(row => (start == null || row[0] >= start) && (end == null || row[0] <= end));
      rows = start == null ? rows.slice(-limit) : rows.slice(0, limit);
      return rows;
    }
  };
  return { market: new BinanceMarket({ client }), exchangeCalls: () => exchangeCalls };
}

test('Binance Futures symbols drop non-perpetual contracts and coalesce refreshes', async () => {
  const { market, exchangeCalls } = fixture();
  await Promise.all([market.perpetualUsdtContracts(), market.perpetualUsdtContracts()]);
  assert.deepEqual(await market.perpetualUsdtSymbols(), ['BTCUSDT']);
  assert.equal(exchangeCalls(), 1);
  const rows = await market.klines({ symbol: 'BTCUSDT', limit: 1 });
  assert.equal(rows[0].volume, 10);
  assert.equal(rows[0].quoteVolume, 1020);
  assert.equal(rows[0].tradeCount, 100);
  assert.equal(market.status().provider, 'binance');
  assert.equal(market.status().marketType, 'futures');
  assert.equal(market.storageSymbol('BTCUSDT'), 'BINANCE_BTCUSDT');
  await assert.rejects(market.klines({ symbol: 'BTC-USDT' }), /USDT 合约/);
});

test('Binance Futures klines honour inclusive start/end and normalize rows', async () => {
  const { market } = fixture();
  const rows = await market.klines({ symbol: 'BTCUSDT', limit: 305, startTime: 100 * bar, endTime: 405 * bar - 1 });
  assert.equal(rows.length, 305);
  assert.equal(rows[0].openTime, 100 * bar);
  assert.equal(rows.at(-1).openTime, 404 * bar);
  assert.ok(rows.every((r, i) => !i || r.openTime - rows[i - 1].openTime === bar));
});

test('continuous catch-up honours Binance provider page size and resumes entire gap', async () => {
  const { market } = fixture();
  const pages = [];
  await fetchContinuousKlines({ client: market, symbol: 'BTCUSDT', interval: '15m', startTime: 0, now: 705 * bar, savePage: async rows => pages.push(rows) });
  assert.deepEqual(pages.map(page => page.length), [705]);
  assert.equal(pages.at(-1).at(-1).openTime, 704 * bar);
});

test('continuous catch-up refuses to loop when provider yields no rows', async () => {
  const market = new BinanceMarket({ client: { exchangeInfo: async () => ({ symbols: [] }), klines: async () => [] } });
  await assert.rejects(
    fetchContinuousKlines({ client: market, symbol: 'BTCUSDT', interval: '15m', startTime: 0, now: 10 * bar, savePage: async () => {} }),
    /缺少|没有已收盘 K 线/
  );
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
