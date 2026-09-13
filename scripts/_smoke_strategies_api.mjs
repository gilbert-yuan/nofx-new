/**
 * 冒烟：策略管理 API（挂载 createStrategiesRouter 到临时 express，走真实 HTTP 请求）
 */
import express from 'express';
import { createStrategyRuntime } from '../server/strategies/index.js';
import { createStrategiesRouter } from '../server/routes/strategies.js';

const state = { version: 1, enabled: null, overrides: {}, updatedAt: null };
const store = {
  async getStrategies() { return JSON.parse(JSON.stringify(state)); },
  async saveStrategies(s) { Object.assign(state, JSON.parse(JSON.stringify(s))); return state; },
  async getConfig() { return { analysis: { engine: 'enhanced' } }; }
};

const strategies = createStrategyRuntime({ store, resolveEngine: (c) => c?.analysis?.engine || 'local' });

const app = express();
app.use(express.json());
app.use(createStrategiesRouter({ strategies, store }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => { const r = await fetch(base + p); return [r.status, await r.json()]; };
const send = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, await r.json()]; };

let fail = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`); if (!cond) fail++; };

let s, r, list;
[s, list] = await get('/api/strategies');
check('GET /api/strategies 200 且含 3 个策略', s === 200 && list.strategies.length === 3, `total=${list.strategies.length}`);
check('默认仅启用 enhanced-trend-v1', JSON.stringify(list.enabled) === '["enhanced-trend-v1"]', JSON.stringify(list.enabled));
const enh = list.strategies.find((x) => x.id === 'enhanced-trend-v1');
check('带 paramSchema(48) 与 defaults', enh.paramSchema.length === 48 && enh.defaults.maxHoldBars === 120);

// 2026-09-14：super/ai/pin/pump-short 的注册已移除，注册表只剩 3 个策略。
const slong = list.strategies.find((x) => x.id === 'structure-long-v1');
check('注册 structure-long-v1（默认未启用，15m 计划周期）',
  !!slong && slong.enabled === false && slong.engine === 'structure-long' && slong.planInterval === '15m');
check('structure-long 出场规则「智能退出」默认关闭',
  slong.paramSchema.find((x) => x.key === 'smartExitEnabled')?.default === false);

[s, list] = await send('PUT', '/api/strategies/structure-long-v1', { enabled: true });
check('PUT 启用 structure-long-v1', s === 200 && list.strategy.enabled === true);

[, list] = await get('/api/strategies');
check('启用集变为 2 个', list.enabled.length === 2, JSON.stringify(list.enabled));

[s, r] = await send('PUT', '/api/strategies/enhanced-trend-v1', { params: { mainTpR: 99999 } });
check('越界参数被拒并回退默认', s === 200 && r.rejected.length === 1 && r.strategy.params.mainTpR === enh.defaults.mainTpR, JSON.stringify(r.rejected));

[s, r] = await send('PUT', '/api/strategies/not-exist', { enabled: true });
check('未知策略 404', s === 404, r.error);

// 回归（2026-09-12）：本地多周期 v1 已下线，API 层面必须当作未知策略拒绝，
// 避免前端旧书签 / 旧脚本还能把它重新启用。
[s, r] = await send('PUT', '/api/strategies/local-mtf-v1', { enabled: true });
check('已下线策略 local-mtf-v1 返回 404', s === 404, r.error);

// 回归（2026-09-14）：pump-fade-short-v1 注册已移除，同样必须 404。
[s, r] = await send('PUT', '/api/strategies/pump-fade-short-v1', { enabled: true });
check('已移除策略 pump-fade-short-v1 返回 404', s === 404, r.error);

[s, r] = await send('PUT', '/api/strategies/enhanced-trend-v1', {});
check('空 patch 400', s === 400, r.error);

[s, r] = await send('POST', '/api/strategies/structure-long-v1/reset', {});
check('reset 恢复默认但保留启用', s === 200 && r.strategy.params.maxHoldBars === slong.defaults.maxHoldBars && r.strategy.enabled === true, `maxHoldBars=${r.strategy.params.maxHoldBars} enabled=${r.strategy.enabled}`);

[s, r] = await get('/api/strategies/nope');
check('GET 未知策略 404', s === 404, r.error);

server.close();
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 策略 API 冒烟全部通过');
process.exit(fail ? 1 : 0);
