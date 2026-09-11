import pg from 'pg';
const c = new pg.Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
await c.connect();
const q = async sql => (await c.query(sql)).rows;

console.log('=== 按天：出场原因分布（近 5 天，UTC+8）===');
const rows = await q(`
  SELECT to_char(exit_at AT TIME ZONE 'Asia/Irkutsk','MM-DD') d,
         count(*) n,
         round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win,
         round(avg(net)::numeric,3) avg_net,
         round(avg(held_bars)::numeric,1) held,
         sum(case when reason='stop_loss' then 1 else 0 end) sl,
         sum(case when reason='take_profit' then 1 else 0 end) tp,
         sum(case when reason='timeout' then 1 else 0 end) to_,
         sum(case when reason='manual' then 1 else 0 end) manual,
         sum(case when reason like 'smart%' then 1 else 0 end) smart
  FROM simulated_orders
  WHERE status='closed' AND exit_at > now() - interval '5 days'
  GROUP BY d ORDER BY d DESC`);
for (const r of rows) console.log(`${r.d}  n=${String(r.n).padStart(4)} 胜率${String(r.win).padStart(5)}% 均单${String(r.avg_net).padStart(8)} 持仓${String(r.held).padStart(5)} | 止损${String(r.sl).padStart(4)} 止盈${String(r.tp).padStart(3)} 超时${String(r.to_).padStart(3)} manual${String(r.manual).padStart(3)} smart${r.smart}`);

console.log('\n=== 今天的挂单命运（09-11 起）===');
for (const r of await q(`SELECT status, count(*) n FROM simulated_orders
  WHERE created_at > now() - interval '1 days' GROUP BY status ORDER BY n DESC`)) console.log(` ${r.status}: ${r.n}`);

console.log('\n=== 最近 10 笔已平仓（看 reason/held/net）===');
for (const r of await q(`SELECT symbol, direction, reason, held_bars, round(net::numeric,2) net,
  to_char(entry_at AT TIME ZONE 'Asia/Irkutsk','MM-DD HH24:MI') e, to_char(exit_at AT TIME ZONE 'Asia/Irkutsk','MM-DD HH24:MI') x
  FROM simulated_orders WHERE status='closed' ORDER BY exit_at DESC LIMIT 10`))
  console.log(` ${r.symbol.padEnd(11)} ${r.direction.padEnd(11)} ${String(r.reason).padEnd(12)} held=${String(r.held_bars).padStart(4)} net=${String(r.net).padStart(8)} ${r.e} → ${r.x}`);
await c.end();
