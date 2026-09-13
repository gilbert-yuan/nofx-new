/**
 * 策略订单统计 API
 *
 *   GET /api/strategy-stats?granularity=day|hour
 *
 * 维度：策略（全部汇总 + 单策略明细）× 时间（按天 / 按小时，+08 时区）
 * 指标：订单数、平仓数、盈利数（net>0）、胜率（盈利/平仓）、累计净盈亏
 *
 * 关联：simulated_orders.record_id → research_records.id → record->>'strategyId'
 * 复用 container.marketDb.pool（与行情 K 线同一连接池，零额外连接）。
 */
import express from 'express';
import { asyncHandler } from '../core/errors.js';

export function createStatsRouter(container) {
  const router = express.Router();
  const pool = container.marketDb.pool;

  // 策略汇总（全部策略一行）
  const summarySql = `
    SELECT COALESCE(rr.record->>'strategyId', 'unknown')      AS sid,
           COALESCE(rr.record->>'strategyName', '(未知)')       AS sname,
           COUNT(*)                                            AS orders,
           COUNT(*) FILTER (WHERE o.status = 'closed')         AS closed,
           COUNT(*) FILTER (WHERE o.net > 0)                    AS profit,
           COALESCE(SUM(o.net), 0)::numeric(12, 2)             AS net
    FROM simulated_orders o
    LEFT JOIN research_records rr ON rr.id = o.record_id
    GROUP BY 1, 2
    ORDER BY orders DESC`;

  // 时间轴（按天 / 按小时分桶，每桶再按策略拆分）
  const timelineSql = (gran) => {
    const bucketExpr = gran === 'hour'
      ? `EXTRACT(HOUR FROM o.created_at AT TIME ZONE 'UTC' + INTERVAL '8 hours')::int`
      : `(o.created_at AT TIME ZONE 'UTC' + INTERVAL '8 hours')::date`;
    return `
      SELECT ${bucketExpr}                                      AS bucket,
             COALESCE(rr.record->>'strategyId', 'unknown')      AS sid,
             COUNT(*)                                            AS orders,
             COUNT(*) FILTER (WHERE o.status = 'closed')         AS closed,
             COUNT(*) FILTER (WHERE o.net > 0)                    AS profit,
             COALESCE(SUM(o.net), 0)::numeric(12, 2)             AS net
      FROM simulated_orders o
      LEFT JOIN research_records rr ON rr.id = o.record_id
      GROUP BY 1, 2
      ORDER BY 1, 2`;
  };

  const num = (v) => (v === null || v === undefined ? 0 : Number(v));
  const winRate = (profit, closed) => (closed > 0 ? profit / closed : 0);

  router.get('/api/strategy-stats', asyncHandler(async (req, res) => {
    const gran = req.query.granularity === 'hour' ? 'hour' : 'day';

    const [sumRes, tlRes] = await Promise.all([
      pool.query(summarySql),
      pool.query(timelineSql(gran))
    ]);

    // ── 汇总（每策略一行）──────────────────────────────
    const byStrategy = sumRes.rows.map((r) => {
      const orders = num(r.orders);
      const closed = num(r.closed);
      const profit = num(r.profit);
      const net = num(r.net);
      return {
        id: r.sid,
        name: r.sname,
        orders,
        closed,
        profit,
        winRate: winRate(profit, closed),
        net
      };
    });

    // ── 总览（全部策略合计）────────────────────────────
    const overview = byStrategy.reduce((acc, s) => {
      acc.orders += s.orders;
      acc.closed += s.closed;
      acc.profit += s.profit;
      acc.net += s.net;
      return acc;
    }, { orders: 0, closed: 0, profit: 0, net: 0 });
    overview.winRate = winRate(overview.profit, overview.closed);

    // ── 时间轴（分桶 → 总量 + 每策略拆分）────────────────
    const buckets = [];
    const index = new Map();
    for (const r of tlRes.rows) {
      const bucket = String(r.bucket);
      let b = index.get(bucket);
      if (!b) {
        b = { bucket, total: 0, closed: 0, profit: 0, net: 0, byStrategy: {} };
        index.set(bucket, b);
        buckets.push(b);
      }
      const orders = num(r.orders);
      const closed = num(r.closed);
      const profit = num(r.profit);
      const net = num(r.net);
      b.total += orders;
      b.closed += closed;
      b.profit += profit;
      b.net += net;
      b.byStrategy[r.sid] = { orders, closed, profit, net };
    }
    // 数值化时间分桶（按天已是日期字符串，按小时转数字便于排序）
    if (gran === 'hour') buckets.sort((a, b) => Number(a.bucket) - Number(b.bucket));

    res.json({
      generatedAt: new Date().toISOString(),
      filters: { granularity: gran },
      overview,
      byStrategy,
      timeline: { granularity: gran, buckets }
    });
  }));

  return router;
}
