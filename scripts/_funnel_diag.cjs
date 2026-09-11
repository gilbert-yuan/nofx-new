// 最近 24h 逐小时：方向拆分 + 成交/挂单漏斗
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

async function main() {
  const c = new Client(DB);
  await c.connect();
  const wr = `100.0*count(*) FILTER (WHERE net>0)/nullif(count(*),0)`;

  console.log('=== A. 最近24h 逐小时 × 方向（已平仓） ===');
  const h = await c.query(`
    SELECT to_char(entry_at,'MM-DD HH24') hh,
      count(*) FILTER (WHERE direction='OPEN_LONG') L,
      count(*) FILTER (WHERE direction='OPEN_SHORT') S,
      count(*) n,
      round(${wr},1) wr, round(sum(net)::numeric,2) net,
      round(avg(held_bars) FILTER (WHERE direction='OPEN_LONG')::numeric,1) heldL,
      round(avg(held_bars) FILTER (WHERE direction='OPEN_SHORT')::numeric,1) heldS
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
      AND entry_at >= now() - interval '26 hours'
    GROUP BY 1 ORDER BY 1`);
  h.rows.forEach(r => console.log(`${r.hh}: 多${r.L} 空${r.S} | 胜率${r.wr}% 净${r.net} | 持仓 多${r.heldL} 空${r.heldS}`));

  console.log('\n=== B. 下单漏斗（按 created_at 小时，所有状态） ===');
  const f = await c.query(`
    SELECT to_char(created_at,'MM-DD HH24') hh, count(*) all_n,
      count(*) FILTER (WHERE status='closed') closed,
      count(*) FILTER (WHERE status IN ('pending','open')) live,
      count(*) FILTER (WHERE status='cancelled') canc,
      count(*) FILTER (WHERE status='expired') exp
    FROM simulated_orders WHERE created_at >= now() - interval '26 hours'
    GROUP BY 1 ORDER BY 1`);
  f.rows.forEach(r => console.log(`${r.hh}: 建单${r.all_n} 成交平仓${r.closed} 在途${r.live} 撤销${r.canc} 过期${r.exp}`));

  console.log('\n=== C. 禁空前后对比（多单口径） ===');
  const b = await c.query(`
    SELECT CASE WHEN entry_at >= '2026-09-11 01:15+08' THEN '禁空后' ELSE '禁空前(09-10 14:00起)' END seg,
      count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
      AND direction='OPEN_LONG' AND entry_at >= '2026-09-10 14:00+08'
    GROUP BY 1 ORDER BY 1`);
  b.rows.forEach(r => console.log(`${r.seg}: ${r.n}单 胜率${r.wr}% 净${r.net} 均单${r.avg_net} 持仓${r.held}`));

  console.log('\n=== D. 当前在途/挂单明细 ===');
  const live = await c.query(`
    SELECT symbol, direction, status, to_char(created_at,'HH24:MI') c,
      round(coalesce(quantity,0)::numeric,6) qty
    FROM simulated_orders WHERE status IN ('pending','open') ORDER BY created_at`);
  live.rows.forEach(r => console.log(`${r.symbol} ${r.direction} ${r.status} 建单${r.c} qty${r.qty}`));

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
