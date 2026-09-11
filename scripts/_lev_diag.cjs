const { Client } = require('pg');
const c = new Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
const Q = async (label, sql) => { const r = await c.query(sql); console.log(`\n=== ${label} ===`); r.rows.forEach(x => console.log(JSON.stringify(x))); };

(async () => {
  await c.connect();
  await Q('杠杆 × 时间（判断是否为遗留）', `
    SELECT round(leverage::numeric,0) lev, count(*) n,
      to_char(min(created_at),'MM-DD HH24:MI') first, to_char(max(created_at),'MM-DD HH24:MI') last,
      round(100.0*count(*) FILTER (WHERE net>0)/count(*),1) wr, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY 1 ORDER BY 1`);

  await Q('杠杆 × 时间（仅 P4 后干净样本）', `
    SELECT round(leverage::numeric,0) lev, count(*) n,
      round(100.0*count(*) FILTER (WHERE net>0)/count(*),1) wr, round(avg(net)::numeric,3) avg_net,
      round(avg(gross)::numeric,3) avg_gross, round(avg(fees)::numeric,3) avg_fees
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL AND entry_at >= '2026-09-10 14:00+08'
    GROUP BY 1 ORDER BY 1`);

  await Q('杠杆 × 平仓原因（全量）', `
    SELECT round(leverage::numeric,0) lev, reason, count(*) n, round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY 1,2 HAVING count(*)>=5 ORDER BY 1,3 DESC`);

  await Q('notional / margin 实际分布', `
    SELECT round(notional::numeric,0) notional, round(margin::numeric,0) margin,
      round(leverage::numeric,1) lev, count(*) n
    FROM simulated_orders WHERE status='closed' GROUP BY 1,2,3 ORDER BY n DESC LIMIT 10`);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
