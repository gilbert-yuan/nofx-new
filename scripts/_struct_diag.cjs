// 结构性诊断：expired 来源、平仓原因 × 持仓分桶、止损/止盈几何
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

async function main() {
  const c = new Client(DB);
  await c.connect();
  const wr = `100.0*count(*) FILTER (WHERE net>0)/nullif(count(*),0)`;

  console.log('=== 1. 非 closed 状态的时间分布（判断是否为遗留） ===');
  const st = await c.query(`
    SELECT status, count(*) n,
      to_char(min(created_at),'MM-DD HH24:MI') first_at,
      to_char(max(created_at),'MM-DD HH24:MI') last_at
    FROM simulated_orders WHERE status <> 'closed' GROUP BY status ORDER BY n DESC`);
  st.rows.forEach(r => console.log(`${r.status}: ${r.n} 单  [${r.first_at} ~ ${r.last_at}]`));

  console.log('\n=== 2. 已平仓：平仓原因 × 持仓分桶 ===');
  const x = await c.query(`
    SELECT COALESCE(reason,'(空)') reason,
      count(*) n, count(*) FILTER (WHERE held_bars<5) lt5,
      count(*) FILTER (WHERE held_bars<15) lt15,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY 1 ORDER BY n DESC LIMIT 15`);
  x.rows.forEach(r => console.log(`${r.reason}: ${r.n}单 (其中<5根${r.lt5}, <15根${r.lt15}) 胜率${r.wr}% 净${r.net} 均单${r.avg_net}`));

  console.log('\n=== 3. reason × direction（多单/空单分别看） ===');
  const xd = await c.query(`
    SELECT direction, COALESCE(reason,'(空)') reason, count(*) n, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY 1,2 HAVING count(*)>=15 ORDER BY direction, sum(net) ASC`);
  xd.rows.forEach(r => console.log(`${r.direction} / ${r.reason}: ${r.n}单 胜率${r.wr}% 净${r.net} 均单${r.avg_net}`));

  console.log('\n=== 4. 最近 12h 与 P8 前 12h 对比 ===');
  const cmp = await c.query(`
    SELECT CASE WHEN entry_at >= '2026-09-11 05:35+08' THEN 'P8后(05:35起)'
                WHEN entry_at >= '2026-09-10 17:35+08' THEN 'P8前12h' ELSE '更早' END seg,
      count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL AND entry_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  cmp.rows.forEach(r => console.log(`${r.seg}: ${r.n}单 胜率${r.wr}% 净${r.net} 均单${r.avg_net} 持仓${r.held}`));

  console.log('\n=== 5. 手续费占比（毛盈亏 vs 净） ===');
  const fee = await c.query(`
    SELECT round(sum(coalesce(fee,0))::numeric,2) fee, round(sum(coalesce(net,0))::numeric,2) net,
      count(*) n FROM simulated_orders WHERE status='closed' AND net IS NOT NULL`);
  console.log(`手续费合计 ${fee.rows[0].fee} | 净 ${fee.rows[0].net} | 毛 ${(Number(fee.rows[0].net)+Number(fee.rows[0].fee)).toFixed(2)} (${fee.rows[0].n}单)`);

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
