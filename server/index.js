import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, maskConfig, mergeConfig } from './store.js';
import { BinanceClient } from './binanceClient.js';
import { marketData } from './marketData.js';
import { BinancePositionMonitor } from './binancePositionMonitor.js';
import { MarketDb, normalizeBinanceKline } from './marketDb.js';
import { KlineSync } from './klineSync.js';
import { nextOpenTime } from './research.js';
import { registerResearchRoutes } from './researchRoutes.js';
import { GlobalAutomation, registerGlobalAutomationRoutes } from './globalAutomation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || 'data');
const port = Number(process.env.PORT || 3100);

const store = new Store(dataDir);
await store.init();
const marketDb = new MarketDb();
await marketDb.init();

const positionMonitor = new BinancePositionMonitor({ store, marketDb });
const klineSync = new KlineSync({ store, marketDb, positionMonitor });
await klineSync.configureFromStore();

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5173' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'nofx-lite' });
});

app.get('/api/config', async (req, res, next) => {
  try {
    res.json(maskConfig(await store.getConfig()));
  } catch (error) {
    next(error);
  }
});

app.put('/api/config', async (req, res, next) => {
  try {
    const current = await store.getConfig();
    const nextConfig = mergeConfig(current, stripMaskedSecrets(current, req.body || {}));
    await store.saveConfig(nextConfig);
    if (req.body.marketSync) await klineSync.configureFromStore();
    res.json(maskConfig(nextConfig));
  } catch (error) {
    next(error);
  }
});

app.get('/api/binance/status', async (req, res, next) => {
  try {
    res.json(await positionMonitor.status());
  } catch (error) {
    next(error);
  }
});

app.post('/api/binance/test', async (req, res, next) => {
  try {
    const config = await store.getConfig();
    const client = new BinanceClient(config.binance);
    if (!client.hasCredentials()) {
      const error = new Error('请填写币安 API Key 和 Secret Key。');
      error.status = 422;
      throw error;
    }
    const [balance, positions, mode] = await Promise.all([client.account(), client.positions(), client.positionMode()]);
    res.json({
      ok: true,
      testnet: Boolean(config.binance?.testnet),
      totalEquity: Number(balance.totalWalletBalance || 0),
      activePositions: positions.filter(position => Math.abs(Number(position.positionAmt)) > 0).length,
      positionMode: mode.dualSidePosition ? 'hedge' : 'one-way'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/binance/review', async (req, res, next) => {
  try {
    res.json(await positionMonitor.reviewAfterKlines({ interval: '15m' }));
  } catch (error) {
    next(error);
  }
});

app.get('/api/strategy', async (req, res, next) => {
  try {
    res.json(await store.getStrategy());
  } catch (error) {
    next(error);
  }
});

app.put('/api/strategy', async (req, res, next) => {
  try {
    const strategy = normalizeStrategy(req.body || {});
    await store.saveStrategy(strategy);
    res.json(strategy);
  } catch (error) {
    next(error);
  }
});

app.get('/api/market/symbols', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim().toUpperCase();
    const limit = clamp(Number(req.query.limit || 2000), 1, 2000);
    const symbols = (await marketData.perpetualUsdtContracts())
      .filter((item) => item.symbol.includes(search) || item.baseCoin.includes(search));
    res.json(symbols.slice(0, limit));
  } catch (error) {
    next(error);
  }
});

app.post('/api/market/symbols/refresh', async (req, res, next) => {
  try { const symbols = await marketData.perpetualUsdtContracts({ refresh: true }); res.json({ symbols, ...marketData.status() }); }
  catch (error) { next(error); }
});
app.get('/api/market/symbols/status', (req, res) => res.json(marketData.status()));

app.get('/api/market/klines', async (req, res, next) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase().replace(/^BINANCE_/, '');
    const interval = String(req.query.interval || '15m');
    const limit = clamp(Number(req.query.limit || 80), 20, 200);
    const storageSymbol = marketData.storageSymbol(symbol);
    const client = marketData;
    const endTime = req.query.endTime === undefined ? undefined : Number(req.query.endTime);
    if (endTime !== undefined && (!Number.isSafeInteger(endTime) || endTime < 0 || endTime > Date.now())) {
      return res.status(400).json({ error: '请选择不晚于当前时间的有效日期。' });
    }
    const rows = await client.klines({ symbol, interval, limit, endTime });
    await marketDb.saveKlines({ symbol: storageSymbol, interval, rows: rows.filter(row => nextOpenTime(row.openTime, interval) <= Date.now()) });
    res.json({ symbol, interval, rows, provider: marketData.provider });
  } catch (error) {
    next(error);
  }
});

const researchInstances = await registerResearchRoutes({ app, store, marketDb, loadContracts: () => marketData.perpetualUsdtContracts() });

// 初始化全局自动化系统
const globalAutomation = new GlobalAutomation({
  simulation: researchInstances.simulation,
  market: marketData,
  marketDb,
  archive: researchInstances.archive,
  store
});

// 注册全局自动化路由
registerGlobalAutomationRoutes(app, globalAutomation);

// 自动启动全局自动化任务
setTimeout(() => {
  try {
    globalAutomation.start();
    console.log('[GlobalAutomation] 自动启动成功');
  } catch (error) {
    console.error('[GlobalAutomation] 自动启动失败:', error.message);
  }
}, 5000);

console.log('[GlobalAutomation] 系统就绪，将在5秒后自动启动');

// 定时清理旧K线数据（每天凌晨2点执行）
async function cleanOldKlinesTask() {
  try {
    // 获取所有有订单的币种
    const simulation = researchInstances.simulation;
    const state = await simulation.read();
    const symbolsWithOrders = [...new Set(state.orders.map(o => o.symbol))];

    console.log('[KlineCleanup] 开始清理旧K线数据...');
    console.log(`[KlineCleanup] 有订单的币种: ${symbolsWithOrders.join(', ')}`);

    const result = await marketDb.cleanOldKlines(symbolsWithOrders, 3);

    console.log(`[KlineCleanup] 清理完成: 删除了 ${result.deletedCount} 条K线记录`);
    console.log(`[KlineCleanup] 清理的币种: ${result.symbolsCleaned.join(', ') || '无'}`);
    console.log(`[KlineCleanup] 截止时间: ${result.cutoffDate}`);
  } catch (error) {
    console.error('[KlineCleanup] 清理失败:', error.message);
  }
}

// 计算下次凌晨2点的时间
function getNextCleanupTime() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);

  // 如果今天2点已经过了，设置为明天2点
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

// 启动定时任务
function scheduleKlineCleanup() {
  const delay = getNextCleanupTime();
  console.log(`[KlineCleanup] 将在 ${new Date(Date.now() + delay).toLocaleString('zh-CN')} 执行清理任务`);

  setTimeout(async () => {
    await cleanOldKlinesTask();
    // 执行完后安排下一次清理
    scheduleKlineCleanup();
  }, delay);
}

// 启动清理任务调度（延迟10秒，确保系统初始化完成）
setTimeout(() => {
  scheduleKlineCleanup();
  console.log('[KlineCleanup] 定时清理任务已启动');
}, 10000);

// 定时清理未下单的旧分析记录（每小时执行一次）
async function cleanOldAnalysisRecordsTask() {
  try {
    const simulation = researchInstances.simulation;
    const archive = researchInstances.archive;
    const state = await simulation.read();

    // 获取所有有订单的分析记录ID
    const recordIdsWithOrders = [...new Set(state.orders.map(o => o.recordId).filter(Boolean))];

    console.log('[AnalysisCleanup] 开始清理旧分析记录...');
    console.log(`[AnalysisCleanup] 有订单的记录数: ${recordIdsWithOrders.length}`);

    const result = await archive.cleanOldRecords(recordIdsWithOrders, 30);

    console.log(`[AnalysisCleanup] 清理完成: 删除了 ${result.deletedCount} 条分析记录`);
    console.log(`[AnalysisCleanup] 保护的记录: ${result.protectedRecords} 条`);
    console.log(`[AnalysisCleanup] 截止时间: ${result.cutoffTime}`);
  } catch (error) {
    console.error('[AnalysisCleanup] 清理失败:', error.message);
  }
}

// 启动分析记录清理任务（每小时执行一次）
setTimeout(() => {
  // 立即执行一次
  cleanOldAnalysisRecordsTask();

  // 然后每小时执行一次
  setInterval(() => {
    cleanOldAnalysisRecordsTask();
  }, 60 * 60 * 1000); // 1小时

  console.log('[AnalysisCleanup] 定时清理任务已启动（每小时执行一次）');
}, 15000); // 延迟15秒启动

app.post('/api/history/fetch', async (req, res, next) => {
  try {
    const source = marketData.provider;
    const client = marketData;
    const requestedSymbols = req.body.symbols || req.body.symbolsText || req.body.symbol || 'ALL';
    const requested = String(requestedSymbols).split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
    const symbols = requested.includes('ALL') ? await client.perpetualUsdtSymbols() : requested;
    const interval = String(req.body.interval || '15m');
    const limit = clamp(Number(req.body.limit || 80), 1, 1000);
    if (klineSync.running) return res.status(409).json({ error: 'K 线正在同步，可在行情面板查看进度。' });
    const result = await klineSync.fetchSymbols({ symbols, interval, limit, review: false });
    res.json({ source, ...result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/history/klines', async (req, res, next) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = String(req.query.interval || '15m');
    const limit = clamp(Number(req.query.limit || 300), 1, 1000);
    res.json({
      symbol,
      interval,
      rows: await marketDb.listKlines({ symbol: marketData.storageSymbol(symbol.replace(/^(BINANCE_|OKX_PUBLIC_)/, '')), interval, limit })
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/history/summary', async (req, res, next) => {
  try {
    res.json(await marketDb.summary());
  } catch (error) {
    next(error);
  }
});

app.get('/api/history/sync/status', async (req, res, next) => {
  try {
    res.json(await klineSync.status());
  } catch (error) {
    next(error);
  }
});

app.post('/api/history/sync/start', async (req, res, next) => {
  try {
    const current = await store.getConfig();
    await store.saveConfig(mergeConfig(current, { marketSync: { enabled: true } }));
    res.json(await klineSync.start());
  } catch (error) {
    next(error);
  }
});

app.post('/api/history/sync/stop', async (req, res, next) => {
  try {
    const current = await store.getConfig();
    await store.saveConfig(mergeConfig(current, { marketSync: { enabled: false } }));
    res.json(await klineSync.stop());
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API 接口不存在。' }));
app.use(express.static(path.join(rootDir, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(rootDir, 'dist', 'index.html'));
});

app.use((error, req, res, next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  res.status(status).json({ error: error.message || 'Internal server error' });
});

app.listen(port, () => {
  console.log(`NOFX Lite API listening on http://127.0.0.1:${port}`);
});

function normalizeStrategy(input) {
  return {
    name: String(input.name || 'Binance strategy'),
    symbols: String(input.symbolsText || input.symbols || 'BTCUSDT,ETHUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    interval: String(input.interval || '15m'),
    klineLimit: Number(input.klineLimit || 80),
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : String(input.systemPrompt?.content || ''),
    rules: typeof input.rules === 'string' ? input.rules : String(input.rules?.content || input.rules?.rules || '')
  };
}

function normalizeAnalysisScope(input = {}) {
  const symbols = Array.isArray(input.symbols)
    ? input.symbols
    : String(input.symbolsText || '')
        .split(',');
  return {
    symbols: symbols.map((symbol) => String(symbol).trim().toUpperCase().replace(/^(BYBIT|OKX)_/, '')).filter(Boolean),
    interval: String(input.interval || '15m'),
    limit: clamp(Number(input.limit || 80), 20, 200),
    maxSymbols: clamp(Number(input.maxSymbols || 20), 1, 300),
    batchSize: clamp(Number(input.batchSize || 10), 1, 20)
  };
}

function stripMaskedSecrets(current, patch) {
  const next = structuredClone(patch);
  if (isMasked(next.binance?.apiKey)) next.binance.apiKey = current.binance.apiKey;
  if (isMasked(next.binance?.secretKey)) next.binance.secretKey = current.binance.secretKey;
  if (isMasked(next.model?.apiKey)) next.model.apiKey = current.model.apiKey;
  if (isMasked(next.okx?.apiKey)) next.okx.apiKey = current.okx?.apiKey || '';
  if (isMasked(next.okx?.secretKey)) next.okx.secretKey = current.okx?.secretKey || '';
  if (isMasked(next.okx?.passphrase)) next.okx.passphrase = current.okx?.passphrase || '';
  return next;
}

function isMasked(value) {
  return typeof value === 'string' && (value.includes('...') || value === '********');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
