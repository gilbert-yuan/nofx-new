import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceMarket } from '../server/binanceMarket.js';
import { BinanceClient } from '../server/binanceClient.js';
import { BinancePositionMonitor, normalizeQuantity, protectionLevels } from '../server/binancePositionMonitor.js';
import { candleOpenAt } from '../server/research.js';
import { mergeConfig } from '../server/store.js';
import { binanceEnvironmentConfig } from '../server/binancePaperSync.js';

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

test('legacy Binance testnet patches still control the normalized demo environment', () => {
  const current = { binance: { demo: true, testnet: true } };
  const live = mergeConfig(current, { binance: { testnet: false } });
  assert.equal(live.binance.demo, false);
  assert.equal(live.binance.testnet, false);

  const demo = mergeConfig(live, { binance: { demo: true } });
  assert.equal(demo.binance.demo, true);
  assert.equal(demo.binance.testnet, true);
});

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
  client.timeOffset = 0; // 跳过时间同步，避免多一次 request 调用
  const calls = [];
  client.request = async (url, options) => { calls.push({ url: new URL(url), options }); return { ok: true, text: async () => '{"algoId":1}' }; };
  await client.protectionOrder({ symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', triggerPrice: 90, clientAlgoId: 'nofx123' });
  await client.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001, reduceOnly: true });
  assert.equal(calls[0].url.hostname, 'demo-fapi.binance.com');
  assert.equal(calls[0].url.pathname, '/fapi/v1/algoOrder');
  assert.equal(calls[0].url.searchParams.get('closePosition'), 'true');
  assert.equal(calls[0].url.searchParams.has('quantity'), false);
  assert.equal(calls[0].url.searchParams.has('reduceOnly'), false);
  assert.equal(calls[0].url.searchParams.get('workingType'), 'MARK_PRICE');
  assert.equal(calls[0].url.searchParams.get('signature').length, 64);
  assert.equal(calls[1].url.searchParams.get('reduceOnly'), 'true');
});

test('limit order and cancel target Binance Demo with correct signed parameters', async () => {
  const client = new BinanceClient({ apiKey: 'fake', secretKey: 'fake', testnet: true });
  client.timeOffset = 0; // 跳过时间同步
  const calls = [];
  client.request = async (url, options) => { calls.push({ url: new URL(url), options }); return { ok: true, text: async () => '{"orderId":1}' }; };
  await client.limitOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.002, price: 25000.5 });
  await client.cancelOrder({ symbol: 'BTCUSDT', orderId: 42, clientOrderId: 'nofxpaper123' });
  assert.equal(calls[0].url.hostname, 'demo-fapi.binance.com');
  assert.equal(calls[0].url.pathname, '/fapi/v1/order');
  assert.equal(calls[0].url.searchParams.get('type'), 'LIMIT');
  assert.equal(calls[0].url.searchParams.get('timeInForce'), 'GTC');
  assert.equal(calls[0].url.searchParams.get('price'), '25000.5');
  assert.equal(calls[0].url.searchParams.get('quantity'), '0.002');
  assert.equal(calls[1].url.pathname, '/fapi/v1/order');
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].url.searchParams.get('orderId'), '42');
  assert.equal(calls[1].url.searchParams.has('origClientOrderId'), false);
  await client.cancelOrder({ symbol: 'BTCUSDT', clientOrderId: 'nofxpaper123' });
  assert.equal(calls[2].url.searchParams.get('origClientOrderId'), 'nofxpaper123');
  await client.order({ symbol: 'BTCUSDT', clientOrderId: 'nofxpaper123' });
  assert.equal(calls[3].options.method, 'GET');
  assert.equal(calls[3].url.searchParams.get('origClientOrderId'), 'nofxpaper123');
});

test('Demo and live paper-sync credentials resolve independently', () => {
  const config = { binance: {
    demo: true, demoApiKey: 'demo-key', demoSecretKey: 'demo-secret', liveApiKey: 'live-key', liveSecretKey: 'live-secret'
  } };
  assert.deepEqual(
    [binanceEnvironmentConfig(config, 'demo').apiKey, binanceEnvironmentConfig(config, 'demo').secretKey],
    ['demo-key', 'demo-secret']
  );
  assert.deepEqual(
    [binanceEnvironmentConfig(config, 'live').apiKey, binanceEnvironmentConfig(config, 'live').secretKey],
    ['live-key', 'live-secret']
  );
});

test('testnet smoke walks place→query→cancel→recheck and rolls back on failure', async () => {
  const { createBinanceRouter } = await import('../server/routes/binance.js');
  const storeStub = { getConfig: async () => ({ binance: { apiKey: 'k', secretKey: 's', testnet: true } }) };
  // asyncHandler 是 fire-and-forget（.catch(next) 不返回 promise），
  // 测试里用 deferred 等 res.json / next 真正被调。
  const callHandler = (clientStub, body) => new Promise((resolve, reject) => {
    const router = createBinanceRouter({ store: storeStub, positionMonitor: {}, clientFactory: () => clientStub });
    const handler = router.stack.find(l => l.route?.path === '/api/binance/smoke').route.stack[0].handle;
    const lastRes = { json: null, status: 200 };
    handler({ body }, {
      json: async (b) => { lastRes.json = b; resolve(lastRes); return b; },
      status(code) { lastRes.status = code; return this; }
    }, (e) => reject(e));
  });

  // ── 成功路径：挂单 → 查到 → 撤单 → 复核（5 步全过）──
  let calls = [];
  let openList = [{ orderId: 7, price: '50000', status: 'NEW' }];
  const goodClient = {
    hasCredentials: () => true,
    price: async () => ({ price: '100000' }),
    limitOrder: async ({ price }) => { calls.push(['place', price]); return { orderId: 7 }; },
    openOrders: async () => openList,
    cancelOrder: async ({ orderId }) => { calls.push(['cancel', orderId]); openList = openList.filter(o => o.orderId !== orderId); return { orderId }; }
  };
  const res1 = await callHandler(goodClient, { symbol: 'BTCUSDT' });
  assert.equal(res1.json.ok, true);
  assert.equal(res1.json.steps.length, 5);
  assert.ok(res1.json.steps.every(s => s.ok), '所有步骤应为 ok');
  assert.equal(res1.json.steps[1].detail.orderId, 7);
  assert.deepEqual(calls[1], ['cancel', 7]); // 第 4 步撤单
  assert.equal(Math.abs(calls[0][1] - 50000) < 0.01, true); // 远价 = 现价 × 0.5

  // ── 失败路径：查单不到挂单 → 兜底撤单，不留残留 ──
  calls = [];
  const badClient = {
    hasCredentials: () => true,
    price: async () => ({ price: '100000' }),
    limitOrder: async () => ({ orderId: 8 }),
    openOrders: async () => [],
    cancelOrder: async ({ orderId }) => { calls.push(['rollback', orderId]); return { orderId }; }
  };
  const res2 = await callHandler(badClient, { symbol: 'BTCUSDT' });
  assert.equal(res2.json.ok, false);
  assert.equal(res2.status, 502);
  assert.equal(res2.json.steps.filter(s => !s.ok).length, 1); // 只在查单一步断掉
  assert.deepEqual(calls, [['rollback', 8]]); // 兜底撤单已执行
});

test('manual order route forwards reduceOnly and positions expose the account mode', async () => {
  const { createBinanceRouter } = await import('../server/routes/binance.js');
  const storeStub = { getConfig: async () => ({ binance: { apiKey: 'k', secretKey: 's', demo: true } }) };
  let submitted;
  const clientStub = {
    hasCredentials: () => true,
    marketOrder: async args => { submitted = args; return { orderId: 21, status: 'FILLED' }; },
    positions: async () => [{ symbol: 'BTCUSDT', positionAmt: '0.001' }],
    positionMode: async () => ({ dualSidePosition: false })
  };
  const router = createBinanceRouter({ store: storeStub, positionMonitor: {}, clientFactory: () => clientStub });
  const invoke = (path, req) => new Promise((resolve, reject) => {
    const handler = router.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
    const response = { statusCode: 200, body: null, json(body) { this.body = body; resolve(this); return body; }, status(code) { this.statusCode = code; return this; } };
    handler(req, response, reject);
  });

  const orderResponse = await invoke('/api/binance/order', { body: { symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.001, reduceOnly: true } });
  assert.equal(orderResponse.body.order.orderId, 21);
  assert.equal(submitted.reduceOnly, true);
  const positionsResponse = await invoke('/api/binance/positions', { query: { symbol: 'BTCUSDT' } });
  assert.equal(positionsResponse.body.positionMode, 'one-way');
  assert.equal(positionsResponse.body.positions.length, 1);
});

test('smoke rejects before trading when credentials are missing', async () => {
  const { createBinanceRouter } = await import('../server/routes/binance.js');
  const storeStub = { getConfig: async () => ({ binance: { apiKey: '', secretKey: '', testnet: true } }) };
  let traded = false;
  const router = createBinanceRouter({
    store: storeStub, positionMonitor: {},
    clientFactory: () => ({ hasCredentials: () => false, limitOrder: async () => { traded = true; } })
  });
  const handler = router.stack.find(l => l.route?.path === '/api/binance/smoke').route.stack[0].handle;
  const error = await new Promise((resolve) => {
    handler({ body: { symbol: 'BTCUSDT' } }, {
      json: async (b) => { resolve(null); return b; },
      status() { return this; }
    }, (e) => resolve(e));
  });
  assert.ok(error, '应走 next 抛错');
  assert.equal(error.status, 422);
  assert.match(error.message, /API Key/);
  assert.equal(traded, false);
});

test('clock skew (-1021) resyncs server time and retries the signed request once', async () => {
  const client = new BinanceClient({ apiKey: 'fake', secretKey: 'fake', testnet: true });
  client.timeOffset = 0;
  const calls = [];
  client.request = async (url, options) => {
    calls.push(url);
    if (calls.length === 1) {
      const error = new Error('Binance 400: Timestamp for this request is outside of the recvWindow.');
      error.status = 400; error.code = -1021;
      return { ok: false, text: async () => JSON.stringify({ code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }) };
    }
    return { ok: true, text: async () => JSON.stringify({ orderId: 9 }) };
  };
  const order = await client.marketOrder({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.001 });
  assert.equal(order.orderId, 9);
  assert.equal(calls.length, 3, '调用序列：首次下单(-1021) → syncTime → 重试下单');
  assert.equal(client.timeOffset !== undefined, true, '重试前应重新同步偏移量');
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
