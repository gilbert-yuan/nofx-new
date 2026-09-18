import test from 'node:test';
import assert from 'node:assert/strict';
import { BinancePaperSync, paperLimitParams } from '../server/binancePaperSync.js';

/** 构造一笔 paper 订单（cancel 场景只需最小字段） */
function makeOrder(overrides = {}) {
  return {
    id: '6f1c2a34-1111-4222-8333-444455556666',
    symbol: 'BTCUSDT',
    marketProvider: 'binance',
    status: 'cancelled',
    direction: 'OPEN_LONG',
    quantity: 1,
    leverage: 5,
    exchangeSync: {
      demo: { status: 'not_submitted' },
      live: { status: 'not_submitted' }
    },
    ...overrides
  };
}

/** 内存 simulation stub：exchangeSyncOrders / getOrder / mutateLight 最小实现 */
function makeSimulation(order) {
  return {
    exchangeSyncOrders: async () => ({ orders: [order] }),
    getOrder: async () => order,
    mutateLight: async (fn) => {
      fn({ orders: [order] });
      return order.exchangeSync.demo;
    }
  };
}

const store = {
  getConfig: async () => ({
    binance: { demo: true, demoApiKey: 'k', demoSecretKey: 's' },
    trader: { syncPaperOrdersToDemo: true }
  })
};

test('cancel_error link is terminal: poll neither re-enqueues nor re-sends the cancel request', async () => {
  const order = makeOrder({
    exchangeSync: {
      demo: { status: 'cancel_error', orderId: 999, clientOrderId: 'nofxpaperx', lastError: 'Binance 400: Unknown order sent.', retryCount: 5 },
      live: { status: 'not_submitted' }
    }
  });
  let cancelCalls = 0;
  const client = { cancelOrder: async () => { cancelCalls += 1; return {}; }, order: async () => { throw new Error('should not pull'); } };
  const sync = new BinancePaperSync({ simulation: makeSimulation(order), store, clientFactory: () => client, intervalMs: 60000 });
  sync.started = true; // 绕过 start() 的定时器；poll 首行有 started 守卫，必须先置位
  await sync.poll();
  sync.stop();
  assert.equal(cancelCalls, 0, 'cancel_error 不应重发撤单请求');
  assert.equal(sync.pending.size, 0, 'poll 不应把 cancel_error 订单重新入队');
  assert.equal(order.exchangeSync.demo.status, 'cancel_error', '状态保持 cancel_error，供人工排查');
});

test('normal cancel path is untouched: cancel_requested entry gets cancelled once', async () => {
  const order = makeOrder({
    exchangeSync: {
      demo: { status: 'cancel_requested', orderId: 888, clientOrderId: 'nofxpapery' },
      live: { status: 'not_submitted' }
    }
  });
  let cancelCalls = 0;
  const client = {
    cancelOrder: async () => { cancelCalls += 1; return { orderId: 888, status: 'CANCELED' }; },
    order: async () => ({ orderId: 888, status: 'CANCELED' })
  };
  const sync = new BinancePaperSync({ simulation: makeSimulation(order), store, clientFactory: () => client, intervalMs: 60000 });
  sync.started = true;
  await sync.poll();
  sync.stop();
  assert.equal(cancelCalls, 1, '正常撤单请求恰好发送一次');
  assert.equal(order.exchangeSync.demo.status, 'canceled', '撤单结果写回 link 状态');
});

test('unsupported symbol is terminal: link marked unsupported_symbol and pending order self-cancels', async () => {
  // 场景：实盘有、Demo 没上的合约（含中文 ticker 的 meme 永续）。Demo exchangeInfo 无此 symbol，
  // paperLimitParams 抛「不支持合约」——确定性错误，不得进入重试队列，挂单应被自动取消。
  const order = makeOrder({
    status: 'pending',
    symbol: '龙虾USDT',
    notional: 500,
    plan: { entryLimit: 100 },
    exchangeSync: {
      demo: { status: 'not_submitted' },
      live: { status: 'not_submitted' }
    }
  });
  let limitOrderCalls = 0;
  const client = {
    exchangeInfo: async () => ({
      symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', filters: [] }]
    }),
    limitOrder: async () => { limitOrderCalls += 1; return { orderId: 1, status: 'NEW' }; }
  };
  const sync = new BinancePaperSync({ simulation: makeSimulation(order), store, clientFactory: () => client, intervalMs: 60000 });
  await sync.process(order.id, { submit: true, closeActions: new Set() });
  assert.equal(limitOrderCalls, 0, '不支持的合约不应发出任何真实下单请求');
  assert.equal(order.exchangeSync.demo.status, 'unsupported_symbol', 'link 置终态 unsupported_symbol');
  assert.equal(order.exchangeSync.demo.retryAt, null, '确定性错误不设置重试时间');
  assert.equal(order.status, 'cancelled', '唯一启用环境不支持时挂单自动取消');
  assert.equal(order.reason, 'exchange_unsupported', '取消原因可追溯');
});

test('unsupported symbol alone does not cancel when other enabled env may still submit', async () => {
  // 双环境：demo 判不支持，live 尚未尝试（not_submitted）——此时不得取消订单。
  const config2 = {
    binance: { demo: true, demoApiKey: 'k', demoSecretKey: 's', liveApiKey: 'k2', liveSecretKey: 's2' },
    trader: { syncPaperOrdersToDemo: true, syncPaperOrdersToLive: true }
  };
  const order = makeOrder({
    status: 'pending',
    symbol: '龙虾USDT',
    notional: 500,
    plan: { entryLimit: 100 },
    exchangeSync: {
      demo: { status: 'unsupported_symbol', lastError: 'Binance Demo 不支持合约 龙虾USDT，已跳过同步。', retryAt: null },
      live: { status: 'not_submitted' }
    }
  });
  const client = {
    exchangeInfo: async () => ({
      symbols: [{ symbol: '龙虾USDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', filters: [] }]
    })
  };
  const sync = new BinancePaperSync({ simulation: makeSimulation(order), store: { getConfig: async () => config2 }, clientFactory: () => client, intervalMs: 60000 });
  await sync.process(order.id, { submit: true, closeActions: new Set() });
  assert.equal(order.status, 'pending', '另一环境仍在提交流程中，挂单保持 pending');
});

/** 双向（Hedge）账户的 client stub：默认返回 BTCUSDT 的下单过滤器、标记价与杠杆阶梯。 */
const hedgeClient = (overrides = {}) => ({
  dualSidePosition: async () => true,
  premiumIndex: async () => ({ markPrice: '100' }),
  leverageBracket: async () => [{ brackets: [{ initialLeverage: 20 }] }],
  exchangeInfo: async () => ({
    symbols: [{
      symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.1' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', notional: '5' }
      ]
    }]
  }),
  ...overrides
});

test('paperLimitParams maps the strategy direction to positionSide on hedge accounts', async () => {
  // positionSide 直接跟随策略已设置的 direction：OPEN_LONG → LONG、OPEN_SHORT → SHORT，不改策略逻辑。
  const long = await paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_LONG', plan: { entryLimit: 100 }, notional: 100 }, hedgeClient(), 'live', new Map());
  assert.equal(long.side, 'BUY');
  assert.equal(long.positionSide, 'LONG');

  const short = await paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_SHORT', plan: { entryLimit: 100 }, notional: 100 }, hedgeClient(), 'live', new Map());
  assert.equal(short.side, 'SELL');
  assert.equal(short.positionSide, 'SHORT');

  const oneWay = await paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_LONG', plan: { entryLimit: 100 }, notional: 100 },
    hedgeClient({ dualSidePosition: async () => false }), 'demo', new Map());
  assert.equal(oneWay.positionSide, undefined, '单向账户不传 positionSide，保持原行为');
});

test('market-entry orders (4H strategies, no entryLimit) sync as MARKET orders', async () => {
  // 4H 均值回归/突破是市价策略：plan 只有 entryMin/entryMax sanity 区间，没有 entryLimit。
  // 此前被「缺少有效 entryLimit」判死；现在应镜像为 MARKET 单，数量 = notional ÷ 标记价。
  const order = makeOrder({
    status: 'pending',
    notional: 500,
    plan: { entryMin: 98, entryMax: 102, entryStyle: 'market' },
    exchangeSync: { demo: { status: 'not_submitted' }, live: { status: 'not_submitted' } }
  });
  const marketCalls = [];
  let limitCalls = 0;
  const client = hedgeClient({
    marketOrder: async params => { marketCalls.push(params); return { orderId: 7, status: 'NEW' }; },
    limitOrder: async () => { limitCalls += 1; return { orderId: 8, status: 'NEW' }; },
    price: async () => ({ price: '100' })
  });
  const sync = new BinancePaperSync({ simulation: makeSimulation(order), store, clientFactory: () => client, intervalMs: 60000 });
  await sync.process(order.id, { submit: true, closeActions: new Set() });
  assert.equal(limitCalls, 0, '市价单不应走 limitOrder');
  assert.equal(marketCalls.length, 1, '恰好发出一笔 MARKET 单');
  assert.equal(marketCalls[0].quantity, 5, '数量 = notional 500 ÷ 标记价 100，按 stepSize 0.001 对齐');
  assert.equal(marketCalls[0].side, 'BUY');
  assert.equal(marketCalls[0].positionSide, 'LONG', '双向账户跟随订单方向');
  assert.equal(marketCalls[0].reduceOnly, undefined, '开仓单不得带 reduceOnly');
  assert.equal(marketCalls[0].market, undefined, '内部 market 标记必须剥掉，不得发给交易所');
  assert.equal(order.exchangeSync.demo.status, 'new', '下单结果写回 link 状态');
});

test('limit price outside the PERCENT_PRICE band is rejected on live, ignored on demo', async () => {
  // 实盘 PERCENT_PRICE 比 Demo 严：限价必须落在 [multiplierDown, multiplierUp] × 标记价 之内。
  const bandClient = () => hedgeClient({
    exchangeInfo: async () => ({
      symbols: [{
        symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT',
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.1' },
          { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
          { filterType: 'MIN_NOTIONAL', notional: '5' },
          { filterType: 'PERCENT_PRICE', multiplierUp: '1.05', multiplierDown: '0.95', multiplierDecimal: '4' }
        ]
      }]
    })
  });

  // 标记价 100 → 允许 [95, 105]。限价 105.2 越上限：不夹取（夹到 105 会把「等回调」变成「追高」），
  // 直接拒单留给下轮重算——标记价会变，下轮可能就落回区间内。
  await assert.rejects(
    paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_SHORT', plan: { entryLimit: 105.2 }, notional: 100 }, bandClient(), 'live', new Map()),
    /涨跌幅区间/
  );

  // 限价 130 同样越界被拒。
  await assert.rejects(
    paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_SHORT', plan: { entryLimit: 130 }, notional: 100 }, bandClient(), 'live', new Map()),
    /涨跌幅区间/
  );

  // 区间内限价照常放行。
  const ok = await paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_SHORT', plan: { entryLimit: 104 }, notional: 100 }, bandClient(), 'live', new Map());
  assert.equal(ok.price, 104);

  // Demo 实测不强制该过滤器（远超区间的价单也能挂出）→ 不做校验，避免误伤。
  const demo = await paperLimitParams({ symbol: 'BTCUSDT', direction: 'OPEN_SHORT', plan: { entryLimit: 130 }, notional: 100 }, bandClient(), 'demo', new Map());
  assert.equal(demo.price, 130);
});
