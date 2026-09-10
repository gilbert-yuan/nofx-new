import express from 'express';
import { asyncHandler } from '../core/errors.js';
import { normalizeStrategy } from '../core/http.js';

/** 策略配置读写 */
export function createStrategyRouter(container) {
  const router = express.Router();
  const { store } = container;

  router.get('/api/strategy', asyncHandler(async (req, res) => {
    res.json(await store.getStrategy());
  }));

  router.put('/api/strategy', asyncHandler(async (req, res) => {
    const strategy = normalizeStrategy(req.body || {});
    await store.saveStrategy(strategy);
    res.json(strategy);
  }));

  return router;
}
