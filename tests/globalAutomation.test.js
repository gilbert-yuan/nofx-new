import { test } from 'node:test';
import assert from 'node:assert';
import { GlobalAutomation } from '../server/globalAutomation.js';

test('GlobalAutomation - 初始化', () => {
  const mockSimulation = {
    refresh: async () => ({}),
    mutate: async (fn) => fn({}),
    read: async () => ({ orders: [], automation: { enabled: true } }),
    submit: async () => ({})
  };

  const mockMarket = {
    perpetualUsdtContracts: async () => [{ symbol: 'BTCUSDT' }],
    klines: async () => [],
    storageSymbol: (symbol) => `OKX_PUBLIC_${symbol}`,
    provider: 'okx'
  };

  const mockMarketDb = {
    saveKlines: async () => {},
    listKlines: async () => []
  };

  const mockArchive = {
    save: async () => {},
    get: async () => null,
    candles: async () => []
  };

  const mockStore = {
    getConfig: async () => ({
      model: { enabled: false, apiKey: '' }
    }),
    getStrategy: async () => ({
      interval: '1m',
      rules: 'Test rules'
    })
  };

  const automation = new GlobalAutomation({
    simulation: mockSimulation,
    market: mockMarket,
    marketDb: mockMarketDb,
    archive: mockArchive,
    store: mockStore
  });

  assert.ok(automation, 'GlobalAutomation 实例已创建');
  assert.ok(automation.tasks, '任务配置已初始化');
  assert.ok(automation.tasks.klineSync, 'K线同步任务已配置');
  assert.ok(automation.tasks.analysis, '分析任务已配置');
  assert.ok(automation.tasks.positionReview, '持仓复核任务已配置');
});

test('GlobalAutomation - 任务配置', () => {
  const mockSimulation = {
    read: async () => ({ orders: [] })
  };

  const automation = new GlobalAutomation({
    simulation: mockSimulation,
    market: {},
    marketDb: {},
    archive: {},
    store: {}
  });

  // 测试启用/禁用任务
  automation.configure('klineSync', { enabled: false });
  assert.strictEqual(automation.tasks.klineSync.enabled, false, 'K线同步任务已禁用');

  automation.configure('klineSync', { enabled: true });
  assert.strictEqual(automation.tasks.klineSync.enabled, true, 'K线同步任务已启用');

  // 测试修改间隔
  automation.configure('analysis', { interval: 300000 });
  assert.strictEqual(automation.tasks.analysis.interval, 300000, '分析任务间隔已更新');
});

test('GlobalAutomation - 本地规则复核', () => {
  const automation = new GlobalAutomation({
    simulation: {},
    market: {},
    marketDb: {},
    archive: {},
    store: {}
  });

  // 模拟持仓
  const order = {
    status: 'open',
    direction: 'OPEN_LONG',
    plan: {
      stopLoss: 90,
      takeProfit: 110
    }
  };

  // 模拟行情数据（14根K线用于计算ATR）
  const market = {
    klines: Array.from({ length: 15 }, (_, i) => ({
      openTime: Date.now() - (15 - i) * 60000,
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1000
    }))
  };

  const proposal = automation.localProtectionReview(order, market);

  assert.ok(proposal, '复核建议已生成');
  assert.ok(['HOLD', 'UPDATE_PROTECTION'].includes(proposal.action), '复核动作有效');
  assert.ok(proposal.reason, '包含复核理由');
});

console.log('✓ GlobalAutomation 测试通过');
