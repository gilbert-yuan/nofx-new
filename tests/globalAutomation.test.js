import { test } from 'node:test';
import assert from 'node:assert';
import { GlobalAutomation, rankAutomationCandidates, selectAnalysisEngine, selectAutomationCandidates } from '../server/globalAutomation.js';
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
  assert.deepEqual(Object.keys(automation.tasks), ['klineSync', 'positionReview']);
  assert.ok(automation.tasks.positionReview, '持仓复核任务已配置');
});

test('GlobalAutomation - 全市场机会按质量稳定排序后再分配仓位', () => {
  const ranked = rankAutomationCandidates([
    { symbol: 'SLOWUSDT', strategy: { priority: 60 }, signal: { confidence: 0.99, plan: { trendStrengthScore: 72, netRr: 4 } } },
    { symbol: 'BESTUSDT', strategy: { priority: 60 }, signal: { confidence: 0.80, plan: { trendStrengthScore: 90, netRr: 2 } } },
    { symbol: 'TIE-BUSDT', strategy: { priority: 60 }, signal: { confidence: 0.80, plan: { trendStrengthScore: 90, netRr: 3 } } },
    { symbol: 'TIE-AUSDT', strategy: { priority: 10 }, signal: { confidence: 0.80, plan: { trendStrengthScore: 90, netRr: 3 } } }
  ]);

  assert.deepEqual(ranked.map(item => item.symbol), [
    'TIE-AUSDT', 'TIE-BUSDT', 'BESTUSDT', 'SLOWUSDT'
  ]);
});

test('GlobalAutomation - 同币种候选先按策略优先级仲裁', () => {
  const selected = selectAutomationCandidates([
    { symbol: 'BTCUSDT', strategy: { id: 'late', priority: 60 }, signal: { confidence: 0.99 } },
    { symbol: 'BTCUSDT', strategy: { id: 'primary', priority: 10 }, signal: { confidence: 0.70 } },
    { symbol: 'ETHUSDT', strategy: { id: 'same-priority', priority: 10 }, signal: { confidence: 0.80 } }
  ]);
  assert.deepEqual(selected.map(item => item.strategy.id).sort(), ['primary', 'same-priority']);
});

test('GlobalAutomation - 模拟下单遵守单仓与总敞口上限', async () => {
  const submitted = [];
  const automation = new GlobalAutomation({
    simulation: {
      readLight: async () => ({ initialBalance: 100, orders: [] }),
      submit: async input => { submitted.push(input); return {}; }
    },
    market: {}, marketDb: {}, archive: {}, store: {}
  });
  const signal = {
    action: 'BUY', positionRecommendation: 'OPEN_LONG', strategyId: 'risk-test', recommendedLeverage: 10,
    plan: { entryMin: 99, entryMax: 101, entryLimit: 100, stopLoss: 95, takeProfit: 110, autoMarginPct: 0.5 }
  };

  const first = await automation.submitSignal({
    symbol: 'BTCUSDT', signal, recordId: 'record-1',
    executionPlan: { entryMin: 99, entryMax: 101, entryLimit: 100, stopLoss: 95, takeProfit: 110 },
    shouldContinue: () => true,
    config: { trader: { maxPositionNotionalPct: 0.2, maxTotalNotionalPct: 0.5 } }
  });
  assert.equal(first.action, 'SUBMITTED');
  assert.equal(submitted[0].margin, 4, '单仓 20% 名义价值 ÷ 全局 5 倍杠杆 = 4 USDT 保证金');

  automation.simulation.readLight = async () => ({
    initialBalance: 100,
    orders: [{ status: 'open', symbol: 'SOLUSDT', notional: 40, margin: 4, entryFee: 0, unrealized: 0 }]
  });
  const second = await automation.submitSignal({
    symbol: 'ETHUSDT', signal, recordId: 'record-2', shouldContinue: () => true,
    config: { trader: { maxPositionNotionalPct: 0.8, maxTotalNotionalPct: 0.5 } }
  });
  assert.equal(second.action, 'SUBMITTED');
  assert.equal(submitted[1].margin, 2, '总敞口还剩 10 USDT 名义价值，按全局 5 倍杠杆只允许 2 USDT 保证金');
});

test('GlobalAutomation - 每轮新开仓上限作用于整个市场候选集', async () => {
  const submitted = [];
  const automation = new GlobalAutomation({
    simulation: { readAutomation: async () => ({ orders: [] }) },
    market: {}, marketDb: {}, archive: {},
    store: {
      getConfig: async () => ({ trader: { maxNewEntriesPerCycle: 1 } }),
      getStrategy: async () => ({})
    }
  });
  automation.strategies.enabled = async () => [{ id: 'test-strategy', priority: 10 }];
  automation.scanWithStrategy = async () => ({
    analyzed: 2, eligible: 2, submitted: 0, failed: 0, failures: [], blockedBy: { score: 0, volume: 0, riskReward: 0 },
    signals: [],
    candidates: [
      { symbol: 'LOWUSDT', strategy: { id: 'test-strategy', priority: 10 }, signal: { action: 'BUY', confidence: 0.8, plan: { trendStrengthScore: 80 } } },
      { symbol: 'BESTUSDT', strategy: { id: 'test-strategy', priority: 10 }, signal: { action: 'BUY', confidence: 0.9, plan: { trendStrengthScore: 95 } } }
    ]
  });
  automation.submitSignal = async ({ symbol }) => { submitted.push(symbol); return { action: 'SUBMITTED' }; };

  await automation.runAnalysis({ symbols: ['LOWUSDT', 'BESTUSDT'], shouldContinue: () => true });
  assert.deepEqual(submitted, ['BESTUSDT']);
});

test('配置保存后，自动化 context 会在修订号变化时刷新', async () => {
  let config = { version: 1 };
  let strategy = { rules: 'v1' };
  const automation = new GlobalAutomation({
    simulation: {}, market: {}, marketDb: {}, archive: {},
    store: {
      getConfig: async () => ({ ...config }),
      getStrategy: async () => ({ ...strategy })
    }
  });
  const context = {};

  await automation.loadRuntimeConfig(context);
  assert.equal(context.config.version, 1);
  assert.equal(context.strategyPrompt.rules, 'v1');

  config = { version: 2 };
  strategy = { rules: 'v2' };
  await automation.loadRuntimeConfig(context);
  assert.equal(context.config.version, 1, '没有失效通知时保留当前操作的一致性');

  automation.invalidateRuntimeConfig();
  await automation.loadRuntimeConfig(context);
  assert.equal(context.config.version, 2);
  assert.equal(context.strategyPrompt.rules, 'v2');
});

test('GlobalAutomation - 4h 结构路径忽略残留衍生品/BTC 配置', async () => {
  let capturedContext;
  let derivativeCalls = 0;
  const automation = new GlobalAutomation({
    simulation: {},
    market: {
      skillContext: async () => {
        derivativeCalls++;
        throw new Error('衍生品上下文不应被调用');
      }
    },
    marketDb: {},
    archive: {},
    store: {}
  });

  const result = await automation.runStrategyAnalysis({
    strategy: {
      engine: 'super',
      marketContext: { derivatives: true, btc: '4h', requireFiveMinute: false },
      analyze: async (_market, ctx) => {
        capturedContext = ctx;
        return { action: 'WAIT' };
      }
    },
    symbol: 'BTCUSDT',
    market: { symbol: 'BTCUSDT', interval: '15m', klines: [] },
    submit: true,
    interval: '15m',
    config: {},
    strategyPrompt: '',
    state: { orders: [] },
    adaptiveConfig: {},
    adaptiveOverrides: {},
    localHistory: []
  });

  assert.equal(result.analysis.action, 'WAIT');
  assert.equal(derivativeCalls, 0);
  assert.equal(capturedContext.derivatives, undefined);
  assert.equal(capturedContext.btcMarket, undefined);
  assert.deepEqual(capturedContext.skillContext, { requireFiveMinute: false });
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
  automation.configure('positionReview', { interval: 300000 });
  assert.strictEqual(automation.tasks.positionReview.interval, 300000, '分析任务间隔已更新');
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
    // R 口径复核：ref = entryMax → R = |100 - 90| = 10，浮盈 10 = 1.0R → 阶梯 L1
    plan: { stopLoss: 90, takeProfit: 105, entryMin: 100, entryMax: 100 }
  };

  const proposal = localProtectionReview(order, { klines: rows });

  assert.equal(proposal.action, 'UPDATE_PROTECTION');
  // 止损 = 现价 − 阶梯档 trailR × R（1.0R → L1 档 trailR），不再使用 stopAtr 固定距离
  const riskUnit = Math.abs(order.entry - order.plan.stopLoss);
  const profitR = (price - order.entry) / riskUnit;
  const ladderStep = [...TRAILING_RULE.ladder].reverse().find(s => profitR >= s.atR);
  assert.ok(Math.abs(proposal.stopLoss - (price - ladderStep.trailR * riskUnit)) < 1e-9,
    '止损距离应等于现价 − 阶梯档 trailR × R（TRAILING_RULE.ladder）');
  assert.ok(Math.abs(proposal.takeProfit - (price + TRAILING_RULE.extendTpAtr * atr)) < 1e-9,
    '扩盈距离应等于 TRAILING_RULE.extendTpAtr × ATR');
  // 回归守卫：扩盈口径与 enhancedAnalysis 统一为 extendTpAtr(3.0)，不得再回到硬编码 4 ATR
  assert.notEqual(proposal.takeProfit, price + 4 * atr, '扩盈不得使用硬编码 4 ATR');
});

console.log('✓ GlobalAutomation 测试通过');
