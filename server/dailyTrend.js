/**
 * 每日趋势聚合（SQL 版 · 单条查询）
 *
 * 背景：原先 `/api/paper/statistics` 把全部已平仓订单读进 Node 内存后跑多遍 O(N) JS 统计，
 * 冷加载约 6s，且随订单量线性变慢。而「每日趋势」页只需要**按出场日分桶的日级指标** ——
 * 这恰好是 SQL 的强项：一次 GROUP BY 就能同时算出全部指标。
 *
 * 设计要点
 *  1. **多指标 = 单条 SQL**：日级 14 项 + 汇总 8 项全部在同一条语句内用
 *     CTE + `count(*) FILTER (...)` + `jsonb_build_object` 一次产出，前后端只往返一次，
 *     不做「一个指标一条 SQL」的 N 次查询。
 *  2. **分桶口径与旧 JS 完全一致**：按 `exitAt`（UTC 瞬时）+8h 取 localDate。
 *     这里用 `AT TIME ZONE 'UTC'` 显式换算成 UTC 墙钟再 +8h，
 *     不依赖数据库会话时区（将来 DB 时区变更也不会串味）。
 *  3. 无效/缺失 `exitAt` 归入 `unknown` 桶，与旧实现一致。
 *  4. 指标定义（与旧 `computeStatistics().byDay` 逐字段对齐）：
 *       count / wins / winRate / totalNet / avgNet / avgWin /
 *       totalGross / totalFees / totalFunding /
 *       longCount / shortCount / stoppedCount / takeProfitCount
 *  5. **byReason（平仓理由统计）**：同一次查询里顺带按 `reason` 分组，
 *     一次往返拿到「每种平仓理由各占多少单、胜率、净盈亏」——
 *     这正是策略调优最需要、而改造前完全拿不到的数字
 *     （当时 2243 笔止损混成一个 `stop_loss`、26 笔智能退出被记成 `manual`）。
 */

import { STOP_REASON_CODES, TAKE_PROFIT_REASON_CODES } from '../shared/closeReasons.js';

// 常量插值进 IN 列表：来源是本仓库冻结常量，非用户输入，无注入风险
const STOP_IN = STOP_REASON_CODES.map(c => `'${c}'`).join(', ');
const TP_IN = TAKE_PROFIT_REASON_CODES.map(c => `'${c}'`).join(', ');

/** 每日趋势聚合：单条 SQL 同时返回 byDay（日级指标）与 summary（整体指标） */
export const DAILY_TREND_SQL = `
WITH closed AS (
  SELECT
    ((exit_at AT TIME ZONE 'UTC') + INTERVAL '8 hours')::date AS day,
    net, gross, fees, funding, direction, reason
  FROM simulated_orders
  WHERE account_id = 1 AND status = 'closed'
),
per_day AS (
  SELECT
    day,
    count(*)::int                                          AS order_count,
    count(*) FILTER (WHERE net > 0)::int                   AS wins,
    coalesce(sum(net), 0)                                  AS total_net,
    coalesce(sum(net) FILTER (WHERE net > 0), 0)           AS wins_net,
    coalesce(sum(gross), 0)                                AS total_gross,
    coalesce(sum(fees), 0)                                 AS total_fees,
    coalesce(sum(funding), 0)                              AS total_funding,
    count(*) FILTER (WHERE direction = 'OPEN_LONG')::int   AS long_count,
    count(*) FILTER (WHERE direction = 'OPEN_SHORT')::int  AS short_count,
    count(*) FILTER (WHERE reason IN (${STOP_IN}))::int    AS stopped_count,
    count(*) FILTER (WHERE reason IN (${TP_IN}))::int      AS take_profit_count
  FROM closed
  GROUP BY day
),
day_rows AS (
  SELECT
    coalesce(to_char(day, 'YYYY-MM-DD'), 'unknown')                      AS "date",
    order_count                                                         AS "count",
    wins                                                                AS "wins",
    CASE WHEN order_count > 0 THEN wins::float8 / order_count ELSE 0 END AS "winRate",
    total_net                                                           AS "totalNet",
    CASE WHEN order_count > 0 THEN total_net / order_count ELSE 0 END    AS "avgNet",
    CASE WHEN wins > 0 THEN wins_net / wins ELSE 0 END                   AS "avgWin",
    total_gross                                                         AS "totalGross",
    total_fees                                                          AS "totalFees",
    total_funding                                                       AS "totalFunding",
    long_count                                                          AS "longCount",
    short_count                                                         AS "shortCount",
    stopped_count                                                       AS "stoppedCount",
    take_profit_count                                                   AS "takeProfitCount"
  FROM per_day
),
by_reason AS (
  SELECT
    coalesce(reason, 'unknown')                                         AS reason,
    count(*)::int                                                       AS "count",
    count(*) FILTER (WHERE net > 0)::int                                AS wins,
    coalesce(sum(net), 0)                                               AS total_net,
    coalesce(sum(net) FILTER (WHERE net > 0), 0)                        AS wins_net,
    coalesce(sum(fees), 0)                                              AS total_fees
  FROM closed
  GROUP BY coalesce(reason, 'unknown')
),
reason_rows AS (
  SELECT
    reason                                                              AS "reason",
    "count"                                                             AS "count",
    wins                                                                AS "wins",
    CASE WHEN "count" > 0 THEN wins::float8 / "count" ELSE 0 END        AS "winRate",
    total_net                                                           AS "totalNet",
    total_fees                                                          AS "totalFees",
    CASE WHEN "count" > 0 THEN total_net / "count" ELSE 0 END            AS "avgNet",
    CASE WHEN wins > 0 THEN wins_net / wins ELSE 0 END                   AS "avgWin"
  FROM by_reason
)
SELECT jsonb_build_object(
  'byDay', (
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r."date" DESC), '[]'::jsonb)
    FROM day_rows r
  ),
  'byReason', (
    SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r."count" DESC, r."reason"), '[]'::jsonb)
    FROM reason_rows r
  ),
  'summary', jsonb_build_object(
    'totalOrders',      (SELECT count(*)::int FROM simulated_orders WHERE account_id = 1),
    'closedOrders',     (SELECT count(*)::int FROM closed),
    'activeOrders',     (SELECT count(*)::int FROM simulated_orders WHERE account_id = 1 AND status IN ('pending','open')),
    'dayCount',         (SELECT count(*)::int FROM day_rows r WHERE r."date" <> 'unknown'),
    'totalNetDailySum', (SELECT coalesce(sum(r."totalNet"), 0) FROM day_rows r),
    'firstCloseDay',    (SELECT min(r."date") FROM day_rows r WHERE r."date" <> 'unknown'),
    'lastCloseDay',     (SELECT max(r."date") FROM day_rows r WHERE r."date" <> 'unknown'),
    'avgDailyWinRate',  (SELECT coalesce(avg(r."winRate"), 0) FROM day_rows r WHERE r."date" <> 'unknown')
  )
) AS payload
`;

const EMPTY_SUMMARY = Object.freeze({
  totalOrders: 0, closedOrders: 0, activeOrders: 0, dayCount: 0,
  totalNetDailySum: 0, firstCloseDay: null, lastCloseDay: null, avgDailyWinRate: 0
});

/**
 * 执行每日趋势聚合。
 * @param {import('pg').Pool} pool
 * @returns {Promise<{byDay: object[], summary: object, generatedAt: string, source: 'sql'}>}
 */
export async function queryDailyTrend(pool) {
  const { rows } = await pool.query(DAILY_TREND_SQL);
  const payload = rows[0]?.payload;
  return {
    byDay: payload?.byDay || [],
    byReason: payload?.byReason || [],
    summary: { ...EMPTY_SUMMARY, ...(payload?.summary || {}) },
    generatedAt: new Date().toISOString(),
    source: 'sql'
  };
}
