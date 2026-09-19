import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeBinanceDemo } from '../shared/binanceEnvironment.js';

const defaultConfig = {
  binance: {
    apiKey: '',
    secretKey: '',
    demoApiKey: '',
    demoSecretKey: '',
    liveApiKey: '',
    liveSecretKey: '',
    demo: true,
    testnet: true
  },
  okx: {
    apiKey: '',
    secretKey: '',
    passphrase: '',
    demo: true,
    tdMode: 'isolated'
  },
  model: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    maxConcurrentRequests: 5
  },
  trader: {
    exchange: 'binance',
    enabled: false,
    dryRun: true,
    scanIntervalSeconds: 900,
    quoteAsset: 'USDT',
    maxLeverage: 5,
    maxPositionNotionalPct: 0.25,
    maxTotalNotionalPct: 1.25,
    minOrderMargin: 5,
    minConfidence: 0.65,
    allowEntryOrders: false,
    allowCloseOrders: false,
    allowProtectionUpdates: true,
    syncPaperOrdersToDemo: false,
    syncPaperOrdersToLive: false,
    entrySymbolsText: '',
    maxNewEntriesPerCycle: 1,
    maxPositionsToReview: 10,
    minProtectionMoveBps: 25
  },
  marketSync: {
    enabled: true,
    symbolsText: 'ALL',
    interval: '15m',
    intervalSeconds: 60,
    limit: 80
  },
  tradeSync: {
    enabled: false,
    symbolsText: 'BTCUSDT, ETHUSDT',
    intervalSeconds: 300,
    limit: 500,
    initialLookbackDays: 30
  },
  analysis: {
    engine: 'local'
  }
};

const defaultStrategy = {
  name: 'OKX USDT perpetual contracts, 15-minute research',
  symbols: ['ALL'],
  interval: '15m',
  klineLimit: 80,
  systemPrompt:
    'You are a cautious crypto futures market analyst. Analyze every symbol independently and return strict JSON only. This is research, not an order.',
  rules:
    'Use the configured candle interval and supplied OHLCV data. Give BUY, SELL, or HOLD research suggestions with confidence, reasons, risks, and invalidation conditions. Prefer HOLD when evidence is weak. Never promise returns.'
};

const defaultState = {
  running: false,
  lastRunAt: null,
  lastError: '',
  decisions: []
};

// 多策略体系：每个策略的启用状态、完整有效参数和备注放在同一条记录中。
// initialized=false 表示「尚未初始化」，由 StrategyRuntime 按 config.analysis.engine 推导后落盘。
const defaultStrategies = {
  version: 2,
  initialized: false,
  strategies: {},
  updatedAt: null
};

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.strategyPath = path.join(dataDir, 'strategy.json');
    this.statePath = path.join(dataDir, 'state.json');
    this.strategiesPath = path.join(dataDir, 'strategies.json');
    this.writeQueues = new Map();
    this.stateQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.ensureFile(this.configPath, defaultConfig);
    await this.ensureFile(this.strategyPath, defaultStrategy);
    await this.ensureFile(this.statePath, defaultState);
    await this.ensureFile(this.strategiesPath, defaultStrategies);
    const current = await this.getConfig();
    if (current.trader?.exchange !== 'binance') {
      await this.saveConfig(mergeConfig(current, {
        trader: { exchange: 'binance', enabled: false, dryRun: true },
        marketSync: { interval: '15m', intervalSeconds: 900 }
      }));
    }
    const upgraded = await this.getConfig();
    if (upgraded.paperAutomationVersion !== 1) {
      await this.saveConfig(mergeConfig(upgraded, { paperAutomationVersion: 1, marketSync: { enabled: true, symbolsText: 'ALL', interval: '15m', intervalSeconds: 60, limit: 80 } }));
      await this.saveStrategy({ ...await this.getStrategy(), interval: '15m' });
    }
  }

  async ensureFile(filePath, value) {
    try {
      await fs.access(filePath);
    } catch {
      await this.writeJson(filePath, value);
    }
  }

  async readJson(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  async writeJson(filePath, value) {
    const previous = this.writeQueues.get(filePath) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await fs.rename(tempPath, filePath);
      });
    this.writeQueues.set(filePath, next);
    try {
      await next;
    } finally {
      if (this.writeQueues.get(filePath) === next) {
        this.writeQueues.delete(filePath);
      }
    }
  }

  getConfig() {
    return this.readJson(this.configPath);
  }

  saveConfig(config) {
    return this.writeJson(this.configPath, config);
  }

  getStrategy() {
    return this.readJson(this.strategyPath);
  }

  saveStrategy(strategy) {
    return this.writeJson(this.strategyPath, strategy);
  }

  /** 多策略：按策略保存启用状态、完整参数和备注（data/strategies.json） */
  getStrategies() {
    return this.readJson(this.strategiesPath);
  }

  saveStrategies(strategies) {
    return this.writeJson(this.strategiesPath, strategies);
  }

  getState() {
    return this.readJson(this.statePath);
  }

  saveState(state) {
    return this.writeJson(this.statePath, state);
  }

  async mutateState(mutator) {
    const nextRun = this.stateQueue
      .catch(() => {})
      .then(async () => {
        const state = await this.getState();
        const next = await mutator(state);
        await this.saveState(next);
        return next;
      });
    this.stateQueue = nextRun;
    return nextRun;
  }

  patchState(patch) {
    return this.mutateState((state) => ({ ...state, ...patch }));
  }

  addDecision(decision) {
    return this.mutateState((state) => ({
      ...state,
      decisions: [decision, ...state.decisions].slice(0, 100)
    }));
  }
}

export function maskConfig(config) {
  return {
    ...config,
    binance: {
      ...config.binance,
      apiKey: maskSecret(config.binance?.apiKey),
      secretKey: maskSecret(config.binance?.secretKey),
      demoApiKey: maskSecret(config.binance?.demoApiKey),
      demoSecretKey: maskSecret(config.binance?.demoSecretKey),
      liveApiKey: maskSecret(config.binance?.liveApiKey),
      liveSecretKey: maskSecret(config.binance?.liveSecretKey)
    },
    okx: {
      ...config.okx,
      apiKey: maskSecret(config.okx?.apiKey),
      secretKey: maskSecret(config.okx?.secretKey),
      passphrase: maskSecret(config.okx?.passphrase)
    },
    model: {
      ...config.model,
      apiKey: maskSecret(config.model.apiKey)
    }
  };
}

export function mergeConfig(current, patch) {
  const patchBinance = patch.binance || {};
  const binance = { ...current.binance, ...patchBinance };
  // 新客户端以 demo 为准；旧客户端显式提交 testnet 时仍应能切换环境。
  // 判定唯一实现在 shared/binanceEnvironment.js（此前为内联四层三元，与
  // binancePaperSync/routes/binance/前端各写一份，口径易漂移）。
  const demo = mergeBinanceDemo(patchBinance, binance);
  binance.demo = demo;
  // testnet is retained as a compatibility alias for older config files/API clients.
  binance.testnet = demo;
  const model = { ...current.model, ...(patch.model || {}) };
  return {
    binance,
    okx: { ...current.okx, ...(patch.okx || {}) },
    model: {
      ...model,
      maxConcurrentRequests: normalizeModelConcurrency(model.maxConcurrentRequests)
    },
    trader: { ...current.trader, ...(patch.trader || {}) },
    marketSync: { ...current.marketSync, ...(patch.marketSync || {}) },
    tradeSync: { ...current.tradeSync, ...(patch.tradeSync || {}) },
    // 保留分析引擎选择（enhanced/super/local）。此前该字段不在白名单里，
    // 每次配置升级/保存都会把它清掉，导致全局自动化悄悄回落到 local 引擎。
    analysis: { ...(current.analysis || {}), ...(patch.analysis || {}) }
  };
}

function normalizeModelConcurrency(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 5;
  return Math.min(20, Math.max(1, Math.trunc(requested)));
}

function maskSecret(value) {
  if (!value) return '';
  if (value.includes('...')) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
