import { createStrategyRuntime, listStrategies } from '../server/strategies/index.js';

// 回归（2026-09-12）：defineStrategy 必须原样保留 decoratePlan / prefilter 这类**可选钩子**。
// 此前 decoratePlan 在归一化时被丢弃，导致自动化里「补该策略出场规则」的分支恒不执行。
const mustKeepHooks = ['pin-fade-v1'];
let hookFail = 0;
for (const id of mustKeepHooks) {
  const def = listStrategies().find((s) => s.id === id);
  const ok = def && typeof def.decoratePlan === 'function';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} 的 decoratePlan 已保留`);
  if (!ok) hookFail++;
}

const mkStore = () => ({
  _s: { version: 1, enabled: null, overrides: {}, updatedAt: null },
  async getStrategies() { return JSON.parse(JSON.stringify(this._s)); },
  async saveStrategies(s) { this._s = JSON.parse(JSON.stringify(s)); return this._s; }
});

let switchFail = 0;
const expectEngine = { enhanced: 'enhanced-trend-v1', super: 'super-trend-v1', ai: 'ai-model-v1', pin: 'pin-fade-v1' };
for (const [engine, expected] of Object.entries(expectEngine)) {
  const rt = createStrategyRuntime({ store: mkStore(), resolveEngine: () => engine });
  const res = await rt.list({ analysis: { engine } });
  const on = res.strategies.filter((x) => x.enabled).map((x) => x.id);
  const ok = res.strategies.length === 4 && on.join(',') === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  engine=${engine} → enabled=[${on.join(',')}] total=${res.strategies.length}`);
  if (!ok) switchFail++;
}

// 回归（2026-09-12）：本地多周期 v1 下线后，老配置遗留的 engine='local'
// 必须回落到 enhanced-trend-v1，而不是「一个策略都不启用」。
{
  const rt = createStrategyRuntime({ store: mkStore(), resolveEngine: () => 'local' });
  const res = await rt.list({ analysis: { engine: 'local' } });
  const on = res.strategies.filter((x) => x.enabled).map((x) => x.id).join(',');
  const ok = on === 'enhanced-trend-v1';
  console.log(`${ok ? 'PASS' : 'FAIL'}  已下线引擎 local 回落 enhanced-trend-v1 (enabled=[${on}])`);
  if (!ok) switchFail++;
}

// 回归：已删除策略残留在 data/strategies.json 的启用集里时，
// list() 的 enabled 与前端「启用 N / M」计数都不应被污染。
{
  const store = mkStore();
  store._s = { version: 1, enabled: ['local-mtf-v1', 'enhanced-trend-v1'], overrides: {}, notes: {}, updatedAt: null };
  const rt = createStrategyRuntime({ store, resolveEngine: () => 'enhanced' });
  const res = await rt.list({ analysis: { engine: 'enhanced' } });
  const ok = JSON.stringify(res.enabled) === '["enhanced-trend-v1"]'
    && !res.strategies.some((x) => x.id === 'local-mtf-v1');
  console.log(`${ok ? 'PASS' : 'FAIL'}  已下线策略的残留启用 id 被清理 (enabled=${JSON.stringify(res.enabled)})`);
  if (!ok) switchFail++;
}

const ids = listStrategies().map((s) => s.id + '(p' + s.priority + ')').join(', ');
console.log('registry ids: ' + ids);

const store = mkStore();
const rt = createStrategyRuntime({ store, resolveEngine: () => 'enhanced' });
const before = await rt.describe('enhanced-trend-v1');
console.log('paramSchema size =', before.paramSchema.length);

const upd = await rt.update('enhanced-trend-v1', { enabled: true, params: { maxHoldBars: 60, minTrendScore: 9999 } });
console.log('update -> maxHoldBars=', upd.strategy.params.maxHoldBars, 'minTrendScore(越界回退)=', upd.strategy.params.minTrendScore);
console.log('rejected =', JSON.stringify(upd.rejected));
console.log('persisted overrides =', JSON.stringify(store._s.overrides));

const r2 = await rt.reset('enhanced-trend-v1');
console.log('after reset maxHoldBars =', r2.strategy.params.maxHoldBars, 'enabled still =', r2.strategy.enabled);

// 订单归属解析：①未标记策略 → 回退默认；②所属策略已被删除（本地多周期 v1 下线）
// 也必须安全回退，否则这些存量订单的复核/结算会取不到策略而报错。
const strategies = (await rt.list({ analysis: { engine: 'enhanced' } })).strategies.map((s) => ({ id: s.id }));
const gone = rt.resolveForOrder({ analysisContext: { strategyId: 'local-mtf-v1' } }, strategies, { analysis: { engine: 'enhanced' } });
const miss = rt.resolveForOrder({ analysisContext: {} }, strategies, { analysis: { engine: 'enhanced' } });
const resolveOk = gone?.id === 'enhanced-trend-v1' && miss?.id === 'enhanced-trend-v1';
console.log(`${resolveOk ? 'PASS' : 'FAIL'}  resolveForOrder 回退：已删策略=${gone && gone.id} / 未标记=${miss && miss.id}`);
if (!resolveOk) switchFail++;

const totalFail = hookFail + switchFail;
console.log(totalFail ? `\n❌ ${totalFail} 项失败` : '\n✅ 策略注册表冒烟全部通过');
process.exit(totalFail ? 1 : 0);
