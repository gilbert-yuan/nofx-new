// 只读：当前挂单/持仓状态 + 成本占比 + 禁空后成交情况
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const BAN_SHORT_AT = '2026-09-10 17:12:00+00'; // 01:12 本地 = 17:12 UTC

async function main() {
  const c = new Client(DB); await c.connect();

  const st = await c.query(`SELECT status, count(*) n FROM simulated_orders GROUP BY 1 ORDER BY n DESC`);
  console.log('=== 订单状态分布 ===');
  st.rows.forEach(r => console.log(`  ${r.status}: ${r.n}`));

  const last = await c.query(`SELECT max(exit_at) last_exit, max(created_at) last_created FROM simulated_orders`);
  console.log(`\n最后平仓 ${last.rows[0].last_exit} | 最后建单 ${last.rows[0].last_created}`);
  console.log(`当前时间 ${new Date().toISOString()}`);

  const after = await c.query(
    `SELECT count(*) n, count(*) FILTER (WHERE status='closed') closed FROM simulated_orders WHERE created_at >= $1`, [BAN_SHORT_AT]);
  console.log(`\n=== 禁空(${BAN_SHORT_AT})之后 ===`);
  console.log(`  新建单 ${after.rows[0].n} 笔，其中已成交 ${after.rows[0].closed} 笔`);

  const pend = await c.query(
    `SELECT count(*) n, round(avg(extract(epoch from (now()-created_at))/60)::numeric,1) avg_age_min
     FROM simulated_orders WHERE status='pending'`);
  console.log(`  当前挂单 ${pend.rows[0].n} 笔，平均存活 ${pend.rows[0].avg_age_min} 分钟`);

  // 成本占比
  const cost = await c.query(`
    SELECT count(*) n, sum(gross)::numeric gross, sum(fees)::numeric fees,
           sum(funding)::numeric funding, sum(net)::numeric net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL`);
  const k = cost.rows[0];
  console.log(`\n=== 成本结构（全部已平仓 ${k.n} 笔）===`);
  const g = Number(k.gross), f = Number(k.fees), fu = Number(k.funding);
  console.log(`  毛利 ${g.toFixed(2)}U | 手续费 ${f.toFixed(2)}U | 资金费 ${fu.toFixed(2)}U | 净 ${Number(k.net).toFixed(2)}U`);
  console.log(`  成本/|毛利| = ${(100 * (f + fu) / Math.abs(g)).toFixed(1)}%`);

  // 毛口径下是否已经亏损（扣除成本前）
  console.log(`  扣成本前毛利 = ${k.gross}U → ${Number(k.gross) > 0 ? '正' : '负'}`);

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
