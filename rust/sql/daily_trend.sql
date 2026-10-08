
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
    count(*) FILTER (WHERE reason IN ('stop_loss', 'trailing_stop', 'break_even_stop'))::int    AS stopped_count,
    count(*) FILTER (WHERE reason IN ('take_profit', 'partial_take_profit'))::int      AS take_profit_count
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

