import express from 'express';
import { asyncHandler } from '../core/errors.js';
import { maskConfig, mergeConfig } from '../store.js';
import { stripMaskedSecrets } from '../core/http.js';

/** 配置读写：GET 返回脱敏配置，PUT 合并并保留未改动的密钥 */
export function createConfigRouter(container) {
  const router = express.Router();
  const { store, klineSync } = container;

  router.get('/api/config', asyncHandler(async (req, res) => {
    res.json(maskConfig(await store.getConfig()));
  }));

  router.put('/api/config', asyncHandler(async (req, res) => {
    const current = await store.getConfig();
    const nextConfig = mergeConfig(current, stripMaskedSecrets(current, req.body || {}));
    await store.saveConfig(nextConfig);
    // 配置文件落盘后通知全局自动化丢弃当前轮的配置快照，
    // 让下一枚币种/下一笔复核读取新配置，不需要重启 API 进程。
    container.globalAutomation?.invalidateRuntimeConfig();
    if (req.body.marketSync) await klineSync.configureFromStore();
    res.json(maskConfig(nextConfig));
  }));

  return router;
}
