import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { clamp } from '../core/http.js';
import { nextOpenTime } from '../research.js';

/** 合约列表 / 行情 K线 */
export function createMarketRouter(container) {
  const router = express.Router();
  const { marketData, marketDb } = container;

  router.get('/api/market/symbols', asyncHandler(async (req, res) => {
    const search = String(req.query.search || '').trim().toUpperCase();
    const limit = clamp(Number(req.query.limit || 2000), 1, 2000);
    const symbols = (await marketData.perpetualUsdtContracts())
      .filter((item) => item.symbol.includes(search) || item.baseCoin.includes(search));
    res.json(symbols.slice(0, limit));
  }));

  router.post('/api/market/symbols/refresh', asyncHandler(async (req, res) => {
    const symbols = await marketData.perpetualUsdtContracts({ refresh: true });
    res.json({ symbols, ...marketData.status() });
  }));

  router.get('/api/market/symbols/status', (req, res) => res.json(marketData.status()));

  router.get('/api/market/klines', asyncHandler(async (req, res) => {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase().replace(/^BINANCE_/, '');
    const interval = String(req.query.interval || '15m');
    const limit = clamp(Number(req.query.limit || 80), 20, 200);
    const storageSymbol = marketData.storageSymbol(symbol);
    const endTime = req.query.endTime === undefined ? undefined : Number(req.query.endTime);
    if (endTime !== undefined && (!Number.isSafeInteger(endTime) || endTime < 0 || endTime > Date.now())) {
      throw new ApiError('请选择不晚于当前时间的有效日期。', 400);
    }
    const rows = await marketData.klines({ symbol, interval, limit, endTime });
    await marketDb.saveKlines({ symbol: storageSymbol, interval, rows: rows.filter((row) => nextOpenTime(row.openTime, interval) <= Date.now()) });
    res.json({ symbol, interval, rows, provider: marketData.provider });
  }));

  return router;
}
