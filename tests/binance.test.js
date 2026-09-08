import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceMarket } from '../server/binanceMarket.js';
import { BinanceClient } from '../server/binanceClient.js';
import { BinancePositionMonitor, normalizeQuantity, protectionLevels } from '../server/binancePositionMonitor.js';
import { candleOpenAt } from '../server/research.js';

const instrument = { symbol: 'BTCUSDT', filters: [
  { filterType: 'MARKET_LOT_SIZE', minQty: '0.001', maxQty: '100', stepSize: '0.001' },
  { filterType: 'PRICE_FILTER', minPrice: '0.1', maxPrice: '1000000', tickSize: '0.1' },
  { filterType: 'MIN_NOTIONAL', notional: '5' }
] };
const candles = () => ({ dataAsOf: new Date(candleOpenAt(Date.now(), '15m')).toISOString() });
const config = { binance: { testnet: true }, trader: { exchange: 'binance', enabled: true, dryRun: true, allowEntryOrders: true, allowProtectionUpdates: true, allowCloseOrders: true, maxLeverage: 3, minConfidence: 0.65, maxPositionNotionalPct: 0.2, maxTotalNotionalPct: 0.3 } };
function store(initial = config) {
  let state = { decisions: [] };
  return { getConfig: async () => initial, getState: async () => state, mutateState: async f => { state = f(state); }, addDecision: async d => { state.decisions.push(d); } };
}

test('symbols use exchangeInfo only; cache coalesces refreshes and candles do not depend on symbol API', async () => {
  let calls = 0, candleCalls = 0;
  const client = {
    exchangeInfo: async () => { calls++; return { symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT', baseAsset: 'BTC', filters: [] },
      { symbol: 'OLDUSDT', status: 'SETTLING', contractType: 'PERPETUAL', quoteAsset: 'USDT' }
    ] }; },
    klines: async () => { candleCalls++; return [[0, '100', '102', '98', '101', '9', 899999, '900', 4]]; }
  };
  const market = new BinanceMarket({ client });
  await Promise.all([market.perpetualUsdtContracts(), market.perpetualUsdtContracts()]);
  assert.equal(calls, 1);
  assert.deepEqual(await market.perpetualUsdtSymbols(), ['BTCUSDT']);
  client.exchangeInfo = async () => { throw new Error('symbols unavailable'); };
  await assert.rejects(market.perpetualUsdtContracts({ refresh: true }));
  const rows = await market.klines({ symbol: 'BTCUSDT' });
  assert.equal(rows[0].close, 101);
  assert.equal(candleCalls, 1);
  assert.equal((await market.klines({ symbol: '币安人生USDT' })).length, 1);
  assert.match(market.status().lastError, /unavailable/);
});

test('Binance request signing uses the selected environment and correct algo/close parameters', async () => {
  const client = new BinanceClient({ apiKey: 'fake', secretKey: 'fake', testnet: true });
  const calls = [];
  client.request = async (url, options) => { calls.push({ url: new URL(url), options }); return { ok: true, text: async () => '{"algoId":1}' }; };
  await client.protectionOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: 90, clientAlgoId: 'nofx123' });
  await client.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, reduceOnly: true });
  assert.match(calls[0].url.hostname, /binancefuture/);
  assert.equal(calls[0].url.pathname, '/fapi/v1/algoOrder');
  assert.equal(calls[0].url.searchParams.get('closePosition'), 'true');
  assert.equal(calls[0].url.searchParams.has('quantity'), false);
  assert.equal(calls[0].url.searchParams.has('reduceOnly'), false);
  assert.equal(calls[0].url.searchParams.get('workingType'), 'MARK_PRICE');
  assert.equal(calls[0].url.searchParams.get('signature').length, 64);
  assert.equal(calls[1].url.searchParams.get('reduceOnly'), 'true');
});

test('base-asset quantities and TP/SL obey Binance filters; invalid numbers never pass', () => {
  assert.equal(normalizeQuantity(0.0019, instrument), 0.001);
  assert.equal(normalizeQuantity(0.0009, instrument), 0);
  assert.equal(normalizeQuantity(Infinity, instrument), 0);
  assert.equal(normalizeQuantity(101, instrument), 0);
  assert.deepEqual(protectionLevels({ stopLoss: 90.03, takeProfit: 110.09 }, 100, true, instrument), { stopLoss: 90, takeProfit: 110 });
  assert.equal(protectionLevels({ stopLoss: -1, takeProfit: 110 }, 100, true, instrument), null);
});

test('automation is disabled without explicit Binance activation and refuses hedge accounts', async () => {
  const monitor = new BinancePositionMonitor({ store: store({ trader: {} }), marketDb: {}, clientFactory: () => { throw new Error('must not connect'); } });
  assert.equal((await monitor.reviewAfterKlines({ interval: '15m' })).status, 'disabled');
  monitor.store = store();
  monitor.clientFactory = () => ({ hasCredentials: () => true, positionMode: async () => ({ dualSidePosition: true }) });
  assert.equal((await monitor.reviewAfterKlines({ interval: '15m' })).status, 'blocked');
});

test('one candle claim survives a new monitor instance', async () => {
  const sharedStore = store();
  assert.equal(await new BinancePositionMonitor({ store: sharedStore }).claim('BTCUSDT', candles()), true);
  assert.equal(await new BinancePositionMonitor({ store: sharedStore }).claim('BTCUSDT', candles()), false);
});

test('replacement failure preserves the old stop and never cancels it first', async () => {
  const monitor = new BinancePositionMonitor({ store: store() });
  let canceled = 0;
  const client = { openAlgoOrders: async () => [{ orderType: 'STOP_MARKET', triggerPrice: '80', clientAlgoId: 'nofxold', algoId: 1 }],
    protectionOrder: async () => { throw new Error('rejected'); }, cancelAlgo: async () => { canceled++; } };
  await assert.rejects(monitor.replaceProtection({ client, symbol: 'BTCUSDT', side: 'SELL', levels: { stopLoss: 90, takeProfit: 110 } }), /rejected/);
  assert.equal(canceled, 0);
});

test('dry-run entry makes no mutation and cumulative exposure blocks a second proposal', async () => {
  const monitor = new BinancePositionMonitor({ store: store() });
  const client = { price: async () => ({ price: '100' }), openOrders: async () => [], openAlgoOrders: async () => [], marketOrder: async () => { throw new Error('must not trade'); }, setLeverage: async () => { throw new Error('must not change leverage'); } };
  const args = { client, config, market: { perpetualUsdtContracts: async () => [instrument] }, candles: candles(), symbol: 'BTCUSDT', decision: { action: 'BUY', symbol: 'BTCUSDT', quantity: 2, leverage: 2, confidence: 0.8, stopLoss: 90, takeProfit: 110 }, account: { totalWalletBalance: 1000 }, positions: [] };
  assert.equal((await monitor.applyEntry(args)).status, 'dry_run');
  const action = await monitor.applyEntry({ ...args, positions: [{ symbol: 'ETHUSDT', positionAmt: 2, markPrice: 100 }] });
  assert.equal(action.status, 'rejected');
  args.decision.confidence = NaN;
  assert.equal((await monitor.applyEntry(args)).status, 'rejected');
});
