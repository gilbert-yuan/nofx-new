const { Client } = require('pg');
const c = new Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
(async () => {
  await c.connect();
  console.log('=== manual / smart_exit 最近 30 笔 ===');
  const r = await c.query(`
    SELECT symbol, direction, reason, held_bars, round(net::numeric,3) net,
      to_char(created_at,'MM-DD HH24:MI') c, to_char(entry_at,'MM-DD HH24:MI') e
    FROM simulated_orders WHERE status='closed' AND reason IN ('manual','smart_exit_ma','smart_exit')
    ORDER BY created_at DESC LIMIT 30`);
  r.rows.forEach(x => console.log(`${x.symbol} ${x.direction} ${x.reason} held=${x.held_bars} net=${x.net} 建${x.c} 入${x.e}`));

  console.log('\n=== 最近 14h 按 reason ===');
  const r2 = await c.query(`
    SELECT reason, count(*) n, min(held_bars) minh, round(avg(held_bars)::numeric,1) avgh
    FROM simulated_orders WHERE status='closed' AND entry_at >= now() - interval '14 hours'
    GROUP BY 1 ORDER BY n DESC`);
  r2.rows.forEach(x => console.log(`${x.reason}: ${x.n}单 minHeld=${x.minh} avgHeld=${x.avgh}`));

  console.log('\n=== 全部 manual 记录（含时间）===');
  const r3 = await c.query(`
    SELECT count(*) n, min(to_char(created_at,'MM-DD HH24:MI')) f, max(to_char(created_at,'MM-DD HH24:MI')) l
    FROM simulated_orders WHERE reason='manual'`);
  console.log(r3.rows[0]);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
