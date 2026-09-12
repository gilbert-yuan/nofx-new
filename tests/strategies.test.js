/**
 * 策略运行时测试：启用集 / 参数覆盖 / 备注（notes）
 *
 * 备注是纯展示字段（不参与任何分析计算），这里覆盖它的读写、清除、限长与脏数据兜底。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrategyRuntime, normalizeNotes, MAX_NOTES_LENGTH } from '../server/strategies/runtime.js';
import '../server/strategies/builtins.js';

const makeStore = (initial = null) => ({
  value: initial,
  async getStrategies() { return this.value; },
  async saveStrategies(next) { this.value = JSON.parse(JSON.stringify(next)); }
});

const runtime = (store) => new StrategyRuntime({ store, resolveEngine: () => 'enhanced' });

test('normalizeNotes 折叠空白、限长，非字符串归为空串', () => {
  assert.equal(normalizeNotes('  做多  '), '做多');
  assert.equal(normalizeNotes('做多\n禁止  做空'), '做多 禁止 做空');
  assert.equal(normalizeNotes('x'.repeat(500)).length, MAX_NOTES_LENGTH);
  assert.equal(normalizeNotes(123), '');
  assert.equal(normalizeNotes(null), '');
  assert.equal(normalizeNotes(undefined), '');
});

test('默认无备注，写入后 list 与持久化文件都能读到', async () => {
  const store = makeStore();
  const rt = runtime(store);
  const before = await rt.list({});
  const target = before.strategies.find((s) => s.id === 'enhanced-trend-v1');
  assert.equal(target.notes, '');

  const updated = await rt.update('enhanced-trend-v1', { notes: '做多' }, {});
  assert.equal(updated.strategy.notes, '做多');
  assert.equal(store.value.notes['enhanced-trend-v1'], '做多');

  const after = await rt.list({});
  assert.equal(after.strategies.find((s) => s.id === 'enhanced-trend-v1').notes, '做多');
});

test('空串清除备注，且不影响其它策略的备注', async () => {
  const store = makeStore();
  const rt = runtime(store);
  await rt.update('enhanced-trend-v1', { notes: '做多' }, {});
  await rt.update('super-trend-v1', { notes: '备用' }, {});
  await rt.update('enhanced-trend-v1', { notes: '' }, {});

  const list = await rt.list({});
  assert.equal(list.strategies.find((s) => s.id === 'enhanced-trend-v1').notes, '');
  assert.equal(list.strategies.find((s) => s.id === 'super-trend-v1').notes, '备用');
  assert.equal('enhanced-trend-v1' in store.value.notes, false);
});

test('读状态丢弃脏备注（数字 / 数组 / 空串）而不是抛错', async () => {
  const store = makeStore({
    version: 1,
    enabled: ['enhanced-trend-v1'],
    overrides: {},
    notes: { 'enhanced-trend-v1': '做多', 'pin-fade-v1': 123, 'ai-model-v1': '', 'super-trend-v1': ['x'] }
  });
  const list = await runtime(store).list({});
  assert.equal(list.strategies.find((s) => s.id === 'enhanced-trend-v1').notes, '做多');
  assert.equal(list.strategies.find((s) => s.id === 'pin-fade-v1').notes, '');
  assert.equal(list.strategies.find((s) => s.id === 'ai-model-v1').notes, '');
  assert.equal(list.strategies.find((s) => s.id === 'super-trend-v1').notes, '');
});

test('notes 不是数组时（旧文件结构）也能安全读取', async () => {
  const store = makeStore({ version: 1, enabled: ['enhanced-trend-v1'], overrides: {}, notes: '做多' });
  const list = await runtime(store).list({});
  assert.equal(list.strategies.find((s) => s.id === 'enhanced-trend-v1').notes, '');
});

test('恢复默认参数不会清掉备注，改备注也不会动参数', async () => {
  const store = makeStore();
  const rt = runtime(store);
  await rt.update('enhanced-trend-v1', { notes: '做多', params: { minTrendScore: 80 } }, {});
  await rt.reset('enhanced-trend-v1', {});
  const afterReset = await rt.list({});
  const item = afterReset.strategies.find((s) => s.id === 'enhanced-trend-v1');
  assert.equal(item.notes, '做多', 'reset 只清参数覆盖，备注应保留');
  assert.notEqual(item.params.minTrendScore, 80);

  await rt.update('enhanced-trend-v1', { params: { minTrendScore: 80 } }, {});
  await rt.update('enhanced-trend-v1', { notes: '只做多（禁空）' }, {});
  const final = await rt.list({});
  const kept = final.strategies.find((s) => s.id === 'enhanced-trend-v1');
  assert.equal(kept.notes, '只做多（禁空）');
  assert.equal(kept.params.minTrendScore, 80, '改备注不应丢失已保存的参数覆盖');
});

test('显式设置的参数即使等于默认值也落盘（保留意图），未提交的键保持原样', async () => {
  const store = makeStore();
  const rt = runtime(store);
  const current = (await rt.list({})).strategies.find((s) => s.id === 'enhanced-trend-v1');
  const sameAsDefault = current.defaults.minTrendScore;

  await rt.update('enhanced-trend-v1', { params: { minTrendScore: sameAsDefault } }, {});
  assert.equal(
    store.value.overrides['enhanced-trend-v1'].minTrendScore,
    sameAsDefault,
    '显式设过的项要写进文件，不能因为等于默认值就被抹掉'
  );

  // 之后只提交另一项，先前显式设置的覆盖不应被清掉
  await rt.update('enhanced-trend-v1', { params: { stopAtr: 2.5 } }, {});
  assert.equal(store.value.overrides['enhanced-trend-v1'].minTrendScore, sameAsDefault);
  assert.equal(store.value.overrides['enhanced-trend-v1'].stopAtr, 2.5);
});

test('越界参数被拒绝且不落盘，已有覆盖保持不动', async () => {
  const store = makeStore();
  const rt = runtime(store);
  await rt.update('enhanced-trend-v1', { params: { stopAtr: 2.5 } }, {});
  const res = await rt.update('enhanced-trend-v1', { params: { minTrendScore: 9999 } }, {});
  assert.ok(res.rejected.some((r) => r.key === 'minTrendScore'), '越界值应记入 rejected');
  assert.equal(res.strategy.params.minTrendScore, res.strategy.defaults.minTrendScore, '生效值回退默认');
  assert.equal(store.value.overrides['enhanced-trend-v1'].stopAtr, 2.5, '已有覆盖不受影响');
  assert.equal('minTrendScore' in store.value.overrides['enhanced-trend-v1'], false, '非法值不写文件');
});

test('未知策略返回 404 状态', async () => {
  await assert.rejects(
    () => runtime(makeStore()).update('nope-v1', { notes: 'x' }, {}),
    (err) => err.status === 404
  );
});
