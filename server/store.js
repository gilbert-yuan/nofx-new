import fs from 'node:fs/promises';
import path from 'node:path';

const defaultConfig = {
  binance: {
    apiKey: '',
    secretKey: '',
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
    maxLeverage: 3,
    maxPositionNotionalPct: 0.2,
    maxTotalNotionalPct: 0.3,
    minConfidence: 0.65,
    allowEntryOrders: false,
    allowCloseOrders: false,
    allowProtectionUpdates: true,
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

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.strategyPath = path.join(dataDir, 'strategy.json');
    this.statePath = path.join(dataDir, 'state.json');
    this.writeQueues = new Map();
    this.stateQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.ensureFile(this.configPath, defaultConfig);
    await this.ensureFile(this.strategyPath, defaultStrategy);
    await this.ensureFile(this.statePath, defaultState);
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
      apiKey: maskSecret(config.binance.apiKey),
      secretKey: maskSecret(config.binance.secretKey)
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
  const model = { ...current.model, ...(patch.model || {}) };
  return {
    binance: { ...current.binance, ...(patch.binance || {}) },
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
