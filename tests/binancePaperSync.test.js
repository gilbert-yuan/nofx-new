import test from 'node:test';
import assert from 'node:assert/strict';
import { BinancePaperSync } from '../server/binancePaperSync.js';

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
