// 模拟下单结果胜率分析脚本（只读数据库，不做任何修改）
const { Client } = require('pg');

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

async function main() {
  const c = new Client(DB);
  await c.connect();

  // 状态分布
  const status = await c.query(`
    SELECT status, count(*) n, round(sum(coalesce(net,0))::numeric,2) net
    FROM simulated_orders GROUP BY status ORDER BY n DESC`);
  console.log('=== 状态分布 ===');
  status.rows.forEach(r => console.log(`${r.status}: ${r.n} 单, 净盈亏 ${r.net}`));

  // 已平仓订单整体胜率
  const closed = await c.query(`
    SELECT count(*) n,
      count(*) FILTER (WHERE net > 0) wins,
      count(*) FILTER (WHERE net = 0) flats,
      count(*) FILTER (WHERE net < 0) losses,
      round(sum(net)::numeric,2) total_net,
      round(avg(net)::numeric,4) avg_net,
      round(avg(held_bars)::numeric,1) avg_held,
      round(avg(CASE WHEN net>0 THEN net END)::numeric,2) avg_win,
      round(avg(CASE WHEN net<0 THEN net END)::numeric,2) avg_loss
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL`);
  const w = closed.rows[0];
  console.log('\n=== 已平仓整体 ===');
  console.log(`总单数 ${w.n} | 胜 ${w.wins} | 平 ${w.flats} | 亏 ${w.losses} | 胜率 ${(100*w.wins/w.n).toFixed(1)}%`);
  console.log(`总净盈亏 ${w.total_net} USDT | 平均每单 ${w.avg_net} | 平均持仓 ${w.avg_held} 根`);
  console.log(`平均盈利单 ${w.avg_win} | 平均亏损单 ${w.avg_loss} | 盈亏比 ${w.avg_loss!=0?Math.abs(w.avg_win/w.avg_loss).toFixed(2):'N/A'}`);

  const wr = `100.0*count(*) FILTER (WHERE net>0)/nullif(count(*),0)`;

  // 按方向
  const dir = await c.query(`
    SELECT direction, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL GROUP BY direction`);
  console.log('\n=== 按方向 ===');
  dir.rows.forEach(r => console.log(`${r.direction}: ${r.n} 单, 胜率 ${r.wr}%, 净盈亏 ${r.net}`));

  // 按月份
  const month = await c.query(`
    SELECT to_char(date_trunc('month', entry_at),'YYYY-MM') m, count(*) n,
      count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL AND entry_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  console.log('\n=== 按月份 ===');
  month.rows.forEach(r => console.log(`${r.m}: ${r.n} 单, 胜率 ${r.wr}%, 净盈亏 ${r.net}`));

  // 按币种（订单数>=10）
  const sym = await c.query(`
    SELECT symbol, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY symbol HAVING count(*)>=10 ORDER BY sum(net) ASC`);
  console.log('\n=== 币种（>=10单, 按净盈亏升序, 前25差） ===');
  sym.rows.slice(0, 25).forEach(r => console.log(`${r.symbol}: ${r.n} 单, 胜率 ${r.wr}%, 净盈亏 ${r.net}`));

  // 0胜率币种统计
  const zero = await c.query(`
    SELECT count(*) n FROM (
      SELECT symbol FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
      GROUP BY symbol HAVING count(*)>=5 AND count(*) FILTER (WHERE net>0)=0
    ) t`);
  const totSyms = await c.query(`
    SELECT count(DISTINCT symbol) n FROM simulated_orders WHERE status='closed' AND net IS NOT NULL`);
  console.log(`\n0胜率币种(>=5单): ${zero.rows[0].n} / 全部币种 ${totSyms.rows[0].n}`);

  // 持仓时长分桶
  const held = await c.query(`
    SELECT CASE WHEN held_bars<5 THEN 'a.<5' WHEN held_bars<15 THEN 'b.5-14'
      WHEN held_bars<30 THEN 'c.15-29' WHEN held_bars<45 THEN 'd.30-44'
      WHEN held_bars<60 THEN 'e.45-59' ELSE 'f.>=60' END bucket,
      count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  console.log('\n=== 持仓时长分桶 ===');
  held.rows.forEach(r => console.log(`${r.bucket}: ${r.n} 单, 胜率 ${r.wr}%, 平均每单 ${r.avg_net}`));

  // ROI 分布
  const roi = await c.query(`
    SELECT CASE WHEN roi<=-0.09 THEN 'a.roi<=-9%(近止损)' WHEN roi<-0.02 THEN 'b.-9%<roi<-2%'
      WHEN roi<0.02 THEN 'c.-2%~2%' WHEN roi<0.06 THEN 'd.2%~6%' ELSE 'e.>6%' END bucket,
      count(*) n
    FROM simulated_orders WHERE status='closed' AND roi IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  console.log('\n=== ROI 分布（roi 相对保证金）===');
  roi.rows.forEach(r => console.log(`${r.bucket}: ${r.n} 单`));

  // 亏损总额 vs 盈利总额
  const gl = await c.query(`
    SELECT round(sum(CASE WHEN net>0 THEN net ELSE 0 END)::numeric,2) gross_win,
      round(sum(CASE WHEN net<0 THEN net ELSE 0 END)::numeric,2) gross_loss
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL`);
  console.log(`\n盈利总额 ${gl.rows[0].gross_win} | 亏损总额 ${gl.rows[0].gross_loss}`);

  // 自动 vs 手动
  const auto = await c.query(`
    SELECT automatic, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL GROUP BY 1`);
  console.log('\n=== 自动 vs 手动 ===');
  auto.rows.forEach(r => console.log(`automatic=${r.automatic}: ${r.n} 单, 胜率 ${r.wr}%, 净盈亏 ${r.net}`));

  // 最近 200 笔表现
  const recent = await c.query(`
    SELECT count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net
    FROM (SELECT * FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
      ORDER BY exit_at DESC NULLS LAST LIMIT 200) t`);
  console.log(`\n=== 最近200笔已平仓 ===`);
  const r200 = recent.rows[0];
  console.log(`胜率 ${r200.wr}% | 净盈亏 ${r200.net}`);

  // 按周看最近8周
  const week = await c.query(`
    SELECT to_char(date_trunc('week', coalesce(exit_at,entry_at)),'MM-DD') wk, count(*) n,
      count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
    GROUP BY date_trunc('week', coalesce(exit_at,entry_at)), 1
    ORDER BY date_trunc('week', coalesce(exit_at,entry_at)) DESC LIMIT 8`);
  console.log('\n=== 按周（最近8周，新→旧）===');
  week.rows.forEach(r => console.log(`${r.wk}: ${r.n} 单, 胜率 ${r.wr}%, 净盈亏 ${r.net}`));

  await c.end();
}

main().catch(e => { console.error('ERR', e); process.exit(1); });
