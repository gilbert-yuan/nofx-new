import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { BinanceClient } from '../binanceClient.js';

/** 币安账户连接状态 / 连通性测试 / K线复盘 */
export function createBinanceRouter(container) {
  const router = express.Router();
  const { store, positionMonitor } = container;

  router.get('/api/binance/status', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.status());
  }));

  router.post('/api/binance/test', asyncHandler(async (req, res) => {
    const config = await store.getConfig();
    const client = new BinanceClient(config.binance);
    if (!client.hasCredentials()) {
      throw new ApiError('请填写币安 API Key 和 Secret Key。', 422);
    }
    const [balance, positions, mode] = await Promise.all([client.account(), client.positions(), client.positionMode()]);
    res.json({
      ok: true,
      testnet: Boolean(config.binance?.testnet),
      totalEquity: Number(balance.totalWalletBalance || 0),
      activePositions: positions.filter((p) => Math.abs(Number(p.positionAmt)) > 0).length,
      positionMode: mode.dualSidePosition ? 'hedge' : 'one-way'
    });
  }));

  router.post('/api/binance/review', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.reviewAfterKlines({ interval: '15m' }));
  }));

  return router;
}
