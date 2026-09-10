import { test } from 'node:test';
import assert from 'node:assert';
import { GlobalAutomation, selectAnalysisEngine } from '../server/globalAutomation.js';
import { localProtectionReview, averageTrueRange } from '../server/shared/protectionReview.js';
import { TRAILING_RULE } from '../server/shared/strategyGuards.js';

test('GlobalAutomation - 默认使用本地策略，其他引擎必须显式选择', () => {
  assert.equal(selectAnalysisEngine({ model: { enabled: false } }), 'local');
  assert.equal(selectAnalysisEngine({ analysis: { engine: 'enhanced' }, model: { enabled: false } }), 'enhanced');
  assert.equal(selectAnalysisEngine({ analysis: { engine: 'super' }, model: { enabled: false } }), 'super');
  assert.equal(selectAnalysisEngine({ analysis: { useSuperEnhanced: true }, model: { enabled: false } }), 'super');
  assert.equal(selectAnalysisEngine({ analysis: { engine: 'ai' }, model: { enabled: false } }), 'local');
  assert.equal(selectAnalysisEngine({ analysis: { engine: 'ai' }, model: { enabled: true, apiKey: 'configured' } }), 'ai');
});

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

test('持仓保护复核 - 本地规则（已下沉到 shared/protectionReview）', () => {
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

  const proposal = localProtectionReview(order, market);

  assert.ok(proposal, '复核建议已生成');
  assert.ok(['HOLD', 'UPDATE_PROTECTION'].includes(proposal.action), '复核动作有效');
  assert.ok(proposal.reason, '包含复核理由');
});

test('持仓保护复核 - 止损/扩盈距离引用 TRAILING_RULE（防再次漂移为硬编码）', () => {
  // 15 根 K 线，最后一根收 110、入场 100 → 浮盈 10% 触发保护复核
  const rows = Array.from({ length: 15 }, () => ({ high: 101, low: 99, close: 100 }));
  rows[rows.length - 1] = { high: 111, low: 109, close: 110 };
  const price = 110;
  const atr = averageTrueRange(rows, 14);
  const order = {
    status: 'open',
    direction: 'OPEN_LONG',
    entry: 100,
    plan: { stopLoss: 90, takeProfit: 105 }  // 低于扩展目标，确保取扩展值
  };

  const proposal = localProtectionReview(order, { klines: rows });

  assert.equal(proposal.action, 'UPDATE_PROTECTION');
  assert.ok(Math.abs(proposal.stopLoss - (price - TRAILING_RULE.stopAtr * atr)) < 1e-9,
    '止损距离应等于 TRAILING_RULE.stopAtr × ATR');
  assert.ok(Math.abs(proposal.takeProfit - (price + TRAILING_RULE.extendTpAtr * atr)) < 1e-9,
    '扩盈距离应等于 TRAILING_RULE.extendTpAtr × ATR');
  // 回归守卫：扩盈口径与 enhancedAnalysis 统一为 extendTpAtr(3.0)，不得再回到硬编码 4 ATR
  assert.notEqual(proposal.takeProfit, price + 4 * atr, '扩盈不得使用硬编码 4 ATR');
});

console.log('✓ GlobalAutomation 测试通过');
