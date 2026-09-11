const { Client } = require('pg');
const c = new Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
const Q = async (label, sql) => { const r = await c.query(sql); console.log(`\n=== ${label} ===`); r.rows.forEach(x => console.log(JSON.stringify(x))); };

(async () => {
  await c.connect();
  await Q('全量成本拆解（closed）', `
    SELECT count(*) n, round(sum(gross)::numeric,2) gross, round(sum(fees)::numeric,2) fees,
      round(sum(funding)::numeric,2) funding, round(sum(net)::numeric,2) net,
      round(avg(gross)::numeric,4) avg_gross, round(avg(fees)::numeric,4) avg_fees
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL`);

  await Q('P4 后干净样本（09-10 14:00+08 起）', `
    SELECT count(*) n, round(sum(gross)::numeric,2) gross, round(sum(fees)::numeric,2) fees,
      round(sum(funding)::numeric,2) funding, round(sum(net)::numeric,2) net,
      round(avg(gross)::numeric,4) avg_gross, round(avg(fees)::numeric,4) avg_fees,
      round(avg(notional)::numeric,2) avg_notional, round(avg(leverage)::numeric,2) avg_lev
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL AND entry_at >= '2026-09-10 14:00+08'`);

  await Q('按方向成本（干净样本）', `
    SELECT direction, count(*) n, round(sum(gross)::numeric,2) gross, round(sum(fees)::numeric,2) fees,
      round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL AND entry_at >= '2026-09-10 14:00+08'
    GROUP BY 1`);

  await Q('毛盈亏符号分布（全量）', `
    SELECT CASE WHEN gross>0 THEN 'gross>0' ELSE 'gross<=0' END g, count(*) n,
      round(avg(net)::numeric,3) avg_net, round(avg(fees)::numeric,3) avg_fees
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL GROUP BY 1`);

  await Q('保证金/杠杆分布', `
    SELECT round(margin::numeric,0) margin, round(leverage::numeric,1) lev, count(*) n,
      round(avg(net)::numeric,3) avg_net, round(100.0*count(*) FILTER (WHERE net>0)/count(*),1) wr
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL GROUP BY 1,2 ORDER BY n DESC LIMIT 12`);

  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
