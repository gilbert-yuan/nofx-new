import test from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { SimulatedAccountRepository } from '../server/simulatedAccountRepository.js';
import { queryDailyTrend, DAILY_TREND_SQL } from '../server/dailyTrend.js';
import { isolatedSimulatedDatabase } from './helpers/simulatedDatabase.js';

/**
 * 每日趋势 SQL 的口径守卫。
 *
 * 最关键的一条：把「旧 computeStatistics().byDay 的 JS 归约」逐字重写一遍，
 * 与 SQL 聚合结果逐字段对拍。SQL 改写最容易踩的坑就是分桶边界、胜率分母、
 * FILTER 条件与 null 处理，只有对拍才能保证页面数字一个都不变。
 */

/** 与旧 computeStatistics 的 byDay 分桶/g归约**逐字等价**的参考实现 */
function jsByDay(closedOrders) {
  const byDayMap = {};
  for (const order of closedOrders) {
    const ts = order.exitAt ? Date.parse(order.exitAt) : Number.NaN;
    const date = Number.isFinite(ts)
      ? new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : 'unknown';
    if (!byDayMap[date]) {
      byDayMap[date] = { date, count: 0, wins: 0, totalNet: 0, totalGross: 0,
        totalFees: 0, totalFunding: 0, longCount: 0, shortCount: 0, stoppedCount: 0, takeProfitCount: 0 };
    }
    const bucket = byDayMap[date];
    bucket.count++;
    if (order.net > 0) bucket.wins++;
    bucket.totalNet += order.net || 0;
    bucket.totalGross += order.gross || 0;
    bucket.totalFees += order.fees || 0;
    bucket.totalFunding += order.funding || 0;
    if (order.direction === 'OPEN_LONG') bucket.longCount++;
    else if (order.direction === 'OPEN_SHORT') bucket.shortCount++;
    if (order.reason === 'stop_loss') bucket.stoppedCount++;
    else if (order.reason === 'take_profit') bucket.takeProfitCount++;
  }
  return Object.values(byDayMap)
    .map(d => ({
      ...d,
      winRate: d.count > 0 ? d.wins / d.count : 0,
      avgNet: d.count > 0 ? d.totalNet / d.count : 0,
      avgWin: d.wins > 0
        ? closedOrders.filter(o => {
          const ts = o.exitAt ? Date.parse(o.exitAt) : Number.NaN;
          const od = Number.isFinite(ts) ? new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : 'unknown';
          return od === d.date && o.net > 0;
        }).reduce((sum, o) => sum + o.net, 0) / d.wins
        : 0
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 用可精确表示的数值，规避 double 求和顺序带来的浮点噪声 */
function order(id, { exitAt, net, direction = 'OPEN_LONG', reason = null, gross = 0, fees = 0, funding = 0, status = 'closed' }) {
  return { id, symbol: 'BTCUSDT', status, direction, net, gross, fees, funding, reason, exitAt,
    margin: 100, leverage: 3, notional: 300, entry: 100, error: '', automatic: false,
    createdAt: exitAt || '2026-09-08T00:00:00.000Z' };
}

const FIXTURE_ORDERS = [
  // 09-08 23:59:59（本地）—— +8h 分桶的**下边界**，必须落在 09-08
  order('o-1', { exitAt: '2026-09-08T15:59:59.000Z', net: 12.5, gross: 13, fees: 0.25, funding: 0.25, reason: 'take_profit' }),
  // 09-09 00:00:00（本地）—— 跨日**上边界**，必须落在 09-09
  order('o-2', { exitAt: '2026-09-08T16:00:00.000Z', net: -5.25, gross: -5, fees: 0.25, reason: 'stop_loss' }),
  order('o-3', { exitAt: '2026-09-09T02:30:00.000Z', net: 0.75, gross: 1, fees: 0.25, direction: 'OPEN_SHORT', reason: 'take_profit' }),
  order('o-4', { exitAt: '2026-09-09T10:00:00.000Z', net: -2.5, gross: -2.25, fees: 0.25, reason: 'timeout' }),
  order('o-5', { exitAt: '2026-09-10T04:00:00.000Z', net: 0, gross: 0.25, fees: 0.25, reason: 'stop_loss' }),
  // 非 closed：只影响 totalOrders / activeOrders，不进任何日桶
  order('o-6', { exitAt: null, net: 0, status: 'open' }),
  order('o-7', { exitAt: null, net: 0, status: 'pending' })
];

test('dailyTrend：单条 SQL 即可，且不得出现多次往返或 N+1 查询', () => {
  assert.match(DAILY_TREND_SQL, /jsonb_build_object/);
  assert.match(DAILY_TREND_SQL, /FILTER \(WHERE/);
  // 模板里只有一条顶层语句（以 WITH ... SELECT 结尾），无分号串联多条
  assert.equal(DAILY_TREND_SQL.trim().replace(/;$/, '').includes(';'), false);
});

test('每日趋势 SQL 与旧 JS byDay 归约逐字段一致（分桶边界 / 胜率 / FILTER / 汇总）', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const repo = new SimulatedAccountRepository(db.pool);
    await repo.init();
    await repo.mutate(state => Object.assign(state, {
      initialBalance: 10000, unlimitedCapital: false, orders: FIXTURE_ORDERS.map(o => ({ ...o }))
    }));

    const actual = await queryDailyTrend(db.pool);
    assert.equal(actual.source, 'sql');
    assert.ok(Array.isArray(actual.byDay));
    assert.equal(typeof actual.generatedAt, 'string');

    const closed = FIXTURE_ORDERS.filter(o => o.status === 'closed');
    const expected = jsByDay(closed);

    assert.deepEqual(
      actual.byDay.map(d => d.date),
      expected.map(d => d.date),
      '日期桶与顺序不一致'
    );
    for (const [i, exp] of expected.entries()) {
      const got = actual.byDay[i];
      for (const key of ['count', 'wins', 'totalNet', 'totalGross', 'totalFees', 'totalFunding',
        'longCount', 'shortCount', 'stoppedCount', 'takeProfitCount', 'winRate', 'avgNet', 'avgWin']) {
        assert.equal(got[key], exp[key], `${exp.date} 的 ${key} 不一致：SQL=${got[key]} JS=${exp[key]}`);
      }
    }

    // 汇总指标
    assert.equal(actual.summary.totalOrders, FIXTURE_ORDERS.length);
    assert.equal(actual.summary.closedOrders, closed.length);
    assert.equal(actual.summary.activeOrders, 2);
    assert.equal(actual.summary.dayCount, expected.length);
    assert.equal(actual.summary.totalNetDailySum, expected.reduce((s, d) => s + d.totalNet, 0));
    assert.equal(actual.summary.firstCloseDay, expected.at(-1).date);
    assert.equal(actual.summary.lastCloseDay, expected[0].date);
    assert.equal(
      actual.summary.avgDailyWinRate,
      expected.reduce((s, d) => s + d.winRate, 0) / expected.length
    );
  } finally { await db.close(); }
});

test('每日趋势 SQL：byReason 按平仓理由聚合，且止损/止盈按「类」计数', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const repo = new SimulatedAccountRepository(db.pool);
    await repo.init();
    // 同一批订单里混用细分理由：验证「止损类 / 止盈类」是并集而非只认字面量
    const orders = [
      order('r-1', { exitAt: '2026-09-09T02:00:00.000Z', net: -10, reason: 'stop_loss' }),
      order('r-2', { exitAt: '2026-09-09T03:00:00.000Z', net: -4, reason: 'trailing_stop' }),
      order('r-3', { exitAt: '2026-09-09T04:00:00.000Z', net: 0.5, reason: 'break_even_stop' }),
      order('r-4', { exitAt: '2026-09-09T05:00:00.000Z', net: 6, reason: 'take_profit' }),
      order('r-5', { exitAt: '2026-09-09T06:00:00.000Z', net: 3, reason: 'partial_take_profit' }),
      order('r-6', { exitAt: '2026-09-09T07:00:00.000Z', net: -2, reason: 'smart_exit_ma' })
    ];
    await repo.mutate(state => Object.assign(state, {
      initialBalance: 10000, unlimitedCapital: false, orders: orders.map(o => ({ ...o }))
    }));

    const { byDay, byReason } = await queryDailyTrend(db.pool);

    // 日桶：止损 3（初始 + 移动 + 保本）、止盈 2（整仓 + 分批）
    assert.equal(byDay[0].stoppedCount, 3, '移动止损 / 保本止损必须计入 stoppedCount');
    assert.equal(byDay[0].takeProfitCount, 2, '分批止盈必须计入 takeProfitCount');
    assert.equal(byDay[0].count, 6);

    // byReason：6 种理由各 1 单，按单数倒序（并列时按 reason 升序）
    const asMap = Object.fromEntries(byReason.map(r => [r.reason, r]));
    assert.equal(byReason.length, 6);
    for (const code of ['stop_loss', 'trailing_stop', 'break_even_stop', 'take_profit', 'partial_take_profit', 'smart_exit_ma']) {
      assert.ok(asMap[code], `byReason 缺少 ${code}`);
      assert.equal(asMap[code].count, 1);
      assert.equal(typeof asMap[code].winRate, 'number');
      assert.equal(typeof asMap[code].avgNet, 'number');
      assert.equal(typeof asMap[code].totalFees, 'number');
    }
    // 胜率口径：亏损单 0、盈利单 1
    assert.equal(asMap.stop_loss.winRate, 0);
    assert.equal(asMap.take_profit.winRate, 1);
    // 净盈亏与源数据一致
    assert.equal(asMap.smart_exit_ma.totalNet, -2);
    assert.equal(asMap.partial_take_profit.totalNet, 3);
  } finally { await db.close(); }
});

test('每日趋势 SQL 在空账户上返回空数组与零值汇总（不抛错）', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const repo = new SimulatedAccountRepository(db.pool);
    await repo.init();
    const result = await queryDailyTrend(db.pool);
    assert.deepEqual(result.byDay, []);
    assert.equal(result.summary.totalOrders, 0);
    assert.equal(result.summary.closedOrders, 0);
    assert.equal(result.summary.activeOrders, 0);
    assert.equal(result.summary.dayCount, 0);
    assert.equal(result.summary.totalNetDailySum, 0);
    assert.equal(result.summary.firstCloseDay, null);
    assert.equal(result.summary.lastCloseDay, null);
    assert.equal(result.summary.avgDailyWinRate, 0);
  } finally { await db.close(); }
});
