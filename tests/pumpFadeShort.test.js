/**
 * 冲高回落空引擎（pumpFadeShortAnalysis）测试
 *
 * 覆盖：无 15m 数据出 WAIT / 合成冲高出 SELL / 空头计划的价格关系与 normalizePlan
 * 集成（SELL → OPEN_SHORT 且 eligible）/ 坏打印与新鲜度过滤。
 * 注：pump-fade-short-v1 的注册已于 2026-09-14 移除（引擎文件保留，回测工具链仍引用），
 *     注册元数据用例随之下线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pumpFadeShortAnalysis, resolvePumpShortParams, PUMP_SHORT_PARAM_SCHEMA, PUMP_SHORT_DEFAULTS } from '../server/pumpFadeShortAnalysis.js';
import { prepareMarket, candleOpenAt, normalizePlan } from '../server/research.js';

const TF = 15 * 60 * 1000;

/** 构造 80 根对齐 15m 网格的合成 K 线；override 按数组下标（0=最老，79=最新）覆写 */
function buildRows({ count = 80, now = Date.now(), override = {} } = {}) {
  const lastClosedOpen = candleOpenAt(now, '15m') - TF;
  const rows = [];
  for (let idx = 0; idx < count; idx++) {
    const openTime = lastClosedOpen - (count - 1 - idx) * TF;
    const base = { openTime, open: 100, high: 101.2, low: 99.4, close: 100.5, volume: 1000, confirmed: true };
    rows.push({ ...base, ...(override[idx] || {}) });
  }
  return rows;
}

function preparedMarket(now) {
  const prepared = prepareMarket({
    symbol: 'TESTUSDT', interval: '15m', rows: buildRows({ now }), limit: 80,
    marketProvider: 'okx', now, throwOnInsufficient: false
  });
  assert.equal(prepared.insufficient, undefined, '合成行情应通过 prepareMarket 校验');
  return prepared;
}

const ctxWith = m15 => ({ params: {}, auxMarkets: { '15m': m15 } });

/** 合成冲高覆写（下标 79 = 最新一根）：冲高当根自身会抬高 ATR14（与研究口径一致），针要足够大才过硬门槛 */
const PUMP_OVERRIDE = { 79: { open: 100.5, high: 108.5, low: 100, close: 108 } };

test('无 15m 数据 / 根数不足 → WAIT 且不带计划', () => {
  const market = { symbol: 'TESTUSDT', interval: '1m', klines: [] };
  const noAux = pumpFadeShortAnalysis(market, { params: {} });
  assert.equal(noAux.action, 'WAIT');
  assert.equal(noAux.plan, null);

  const tooFew = pumpFadeShortAnalysis({ symbol: 'TESTUSDT', interval: '1m', klines: [] },
    ctxWith({ symbol: 'TESTUSDT', interval: '15m', klines: buildRows({ count: 20, now: Date.now() }), dataAsOf: new Date(candleOpenAt(Date.now(), '15m')).toISOString() }));
  assert.equal(tooFew.action, 'WAIT');
  assert.match(tooFew.reason, /15m K 线/);

  const noPump = pumpFadeShortAnalysis({ symbol: 'TESTUSDT', interval: '1m', klines: [] },
    ctxWith({ symbol: 'TESTUSDT', interval: '15m', klines: buildRows({ count: 40, now: Date.now() }), dataAsOf: new Date(candleOpenAt(Date.now(), '15m')).toISOString() }));
  assert.equal(noPump.action, 'WAIT');
  assert.match(noPump.reason, /没有合格冲高/);
});

test('合成冲高 → SELL，空头计划价格关系正确', () => {
  const now = Date.now();
  const rows = buildRows({ now, override: PUMP_OVERRIDE });
  const m15 = { symbol: 'TESTUSDT', interval: '15m', klines: rows, dataAsOf: new Date(candleOpenAt(now, '15m')).toISOString() };
  const signal = pumpFadeShortAnalysis({ symbol: 'TESTUSDT', interval: '1m', klines: [] }, ctxWith(m15));

  assert.equal(signal.action, 'SELL');
  const plan = signal.plan;
  assert.ok(plan, '应有开仓计划');
  assert.ok(Number.isFinite(plan.entryLimit));
  // 空头关系：止盈 < entryMin < entryMax < 止损
  assert.ok(plan.takeProfit < plan.entryMin, '止盈应低于入场区间下沿');
  assert.ok(plan.stopLoss > plan.entryMax, '止损应高于入场区间上沿');
  assert.ok(plan.riskUnit > 0 && Number.isFinite(plan.riskUnit));
  // 止损挂冲高高点上方；止盈 = 3R
  const last = rows.at(-1);
  assert.ok(plan.stopLoss > last.high);
  assert.ok(Math.abs((plan.entryLimit - plan.takeProfit) / plan.riskUnit - 3) < 1e-9, '止盈应为 3R');
  assert.ok(plan.maxHoldBars <= 120);
  // 窗口披露
  assert.equal(signal.trend.interval, '15m');
});

test('SELL 计划通过 normalizePlan（OPEN_SHORT 且 eligible）', () => {
  const now = Date.now();
  const rows = buildRows({ now, override: PUMP_OVERRIDE });
  const m15 = prepareMarket({
    symbol: 'TESTUSDT', interval: '15m', rows, limit: 80, marketProvider: 'okx',
    now, throwOnInsufficient: false
  });
  const signal = pumpFadeShortAnalysis({ symbol: 'TESTUSDT', interval: '1m', klines: [] }, ctxWith(m15));
  assert.equal(signal.action, 'SELL');

  const record = normalizePlan(signal, m15, now);
  assert.equal(record.positionRecommendation, 'OPEN_SHORT');
  assert.equal(record.action, 'SELL');
  assert.deepEqual(record.validationIssues, []);
  assert.ok(record.eligible && record.plan, `计划应有效：${JSON.stringify(record.validationIssues)}`);
  assert.equal(record.interval, '15m');
});

test('无冲高（平盘）→ WAIT；坏打印（振幅 > 8ATR）不出手', () => {
  const now = Date.now();
  const flat = pumpFadeShortAnalysis({ symbol: 'TESTUSDT', interval: '1m', klines: [] },
    ctxWith({ symbol: 'TESTUSDT', interval: '15m', klines: buildRows({ now }), dataAsOf: new Date(candleOpenAt(now, '15m')).toISOString() }));
  assert.equal(flat.action, 'WAIT');

  const glitch = pumpFadeShortAnalysis({ symbol: 'TESTUSDT', interval: '1m', klines: [] },
    ctxWith({
      symbol: 'TESTUSDT', interval: '15m',
      klines: buildRows({ now, override: { 79: { open: 100, high: 135, low: 99, close: 133 } } }),
      dataAsOf: new Date(candleOpenAt(now, '15m')).toISOString()
    }));
  assert.equal(glitch.action, 'WAIT');
});

test('参数解析：越界回退默认值', () => {
  const p = resolvePumpShortParams({ pumpAtrMin: 99, takeProfitR: 'abc', stopBufferAtr: 2 });
  assert.equal(p.pumpAtrMin, PUMP_SHORT_DEFAULTS.pumpAtrMin);
  assert.equal(p.takeProfitR, PUMP_SHORT_DEFAULTS.takeProfitR);
  assert.equal(p.stopBufferAtr, 2);
  assert.equal(PUMP_SHORT_PARAM_SCHEMA.length > 5, true);
});
