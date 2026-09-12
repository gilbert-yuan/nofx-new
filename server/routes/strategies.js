/**
 * 策略管理 API（多策略体系）
 *
 *   GET    /api/strategies            全量策略：启用状态 + 有效参数 + 默认值 + 参数模式
 *   GET    /api/strategies/:id        单个策略快照
 *   PUT    /api/strategies/:id        勾选/取消启用（enabled）+ 覆盖参数（params）+ 备注（notes）
 *   POST   /api/strategies/:id/reset  参数恢复默认（不影响启用状态与备注）
 *
 * 落盘在 data/strategies.json；运行时不缓存，改动下一轮自动化立即生效。
 */
import express from 'express';
import { asyncHandler } from '../core/errors.js';
import { PARAM_GROUP_LABELS } from '../enhancedAnalysis.js';

export function createStrategiesRouter({ strategies, store }) {
  const router = express.Router();

  const config = () => store.getConfig();

  router.get('/api/strategies', asyncHandler(async (req, res) => {
    const data = await strategies.list(await config());
    // 参数分组的中文名随响应下发，前端无需硬编码、也不用 import 服务端模块
    res.json({ ...data, groupLabels: PARAM_GROUP_LABELS });
  }));

  router.get('/api/strategies/:id', asyncHandler(async (req, res) => {
    const item = await strategies.describe(req.params.id, await config());
    if (!item) return res.status(404).json({ error: `未知策略：${req.params.id}` });
    res.json(item);
  }));

  router.put('/api/strategies/:id', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (body.params && typeof body.params === 'object') patch.params = body.params;
    if (typeof body.notes === 'string' || body.notes === null) patch.notes = body.notes ?? '';
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: '请求体需包含 enabled（布尔）、params（对象）或 notes（字符串）。' });
    }
    const result = await strategies.update(req.params.id, patch, await config());
    res.json(result);
  }));

  router.post('/api/strategies/:id/reset', asyncHandler(async (req, res) => {
    res.json(await strategies.reset(req.params.id, await config()));
  }));

  return router;
}
