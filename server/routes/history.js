import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { mergeConfig } from '../store.js';
import { clamp } from '../core/http.js';

/** 历史 K线抓取 / 查询 / 同步控制 */
export function createHistoryRouter(container) {
  const router = express.Router();
  const { store, klineSync, marketDb, marketData } = container;

  router.post('/api/history/fetch', asyncHandler(async (req, res) => {
    const client = marketData;
    const requested = String(req.body.symbols || req.body.symbolsText || req.body.symbol || 'ALL')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const symbols = requested.includes('ALL') ? await client.perpetualUsdtSymbols() : requested;
    const interval = String(req.body.interval || '15m');
    const limit = clamp(Number(req.body.limit || 80), 1, 1000);
    if (klineSync.running) throw new ApiError('K 线正在同步，可在行情面板查看进度。', 409);
    const result = await klineSync.fetchSymbols({ symbols, interval, limit, review: false });
    res.json({ source: client.provider, ...result });
  }));

  router.get('/api/history/klines', asyncHandler(async (req, res) => {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = String(req.query.interval || '15m');
    const limit = clamp(Number(req.query.limit || 300), 1, 1000);
    res.json({
      symbol,
      interval,
      rows: await marketDb.listKlines({
        symbol: marketData.storageSymbol(symbol.replace(/^(BINANCE_|OKX_PUBLIC_)/, '')),
        interval,
        limit
      })
    });
  }));

  router.get('/api/history/summary', asyncHandler(async (req, res) => {
    res.json(await marketDb.summary());
  }));

  router.get('/api/history/sync/status', asyncHandler(async (req, res) => {
    res.json(await klineSync.status());
  }));

  router.post('/api/history/sync/start', asyncHandler(async (req, res) => {
    const current = await store.getConfig();
    await store.saveConfig(mergeConfig(current, { marketSync: { enabled: true } }));
    res.json(await klineSync.start());
  }));

  router.post('/api/history/sync/stop', asyncHandler(async (req, res) => {
    const current = await store.getConfig();
    await store.saveConfig(mergeConfig(current, { marketSync: { enabled: false } }));
    res.json(await klineSync.stop());
  }));

  return router;
}
