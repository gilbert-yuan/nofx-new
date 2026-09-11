import pg from 'pg';
const c = new pg.Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
await c.connect();
const q = async sql => (await c.query(sql)).rows;
console.log('=== 实盘已平仓：按出场原因（近 7 天）===');
for (const r of await q(`SELECT reason, count(*) n, round(avg(net)::numeric,3) avg_net, round(avg(held_bars)::numeric,1) avg_held,
  round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win
  FROM simulated_orders WHERE status='closed' AND exit_at > now() - interval '7 days' GROUP BY reason ORDER BY n DESC`))
  console.log(String(r.reason).padEnd(16), 'n=' + String(r.n).padStart(5), '胜率' + String(r.win).padStart(6) + '%', '均单' + String(r.avg_net).padStart(8), '均持仓' + r.avg_held);
console.log('=== 整体（近 7 天 / 近 3 天）===');
for (const d of [7, 3]) {
  for (const r of await q(`SELECT count(*) n, round(sum(net)::numeric,1) net, round(avg(net)::numeric,3) avg_net,
    round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win, round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE status='closed' AND exit_at > now() - interval '${d} days'`))
    console.log(`近${d}天 n=${r.n} 净=${r.net} 均单=${r.avg_net} 胜率=${r.win}% 均持仓=${r.held}`);
}
console.log('=== 持仓根数分布（近 7 天）===');
for (const r of await q(`SELECT width_bucket(held_bars, ARRAY[0,5,15,30,45,75]) b, count(*) n,
  round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win, round(sum(net)::numeric,1) net
  FROM simulated_orders WHERE status='closed' AND exit_at > now() - interval '7 days' GROUP BY b ORDER BY b`))
  console.log(`bucket=${r.b} n=${r.n} 胜率=${r.win}% 净=${r.net}`);
console.log('=== 方向（近 7 天）===');
for (const r of await q(`SELECT direction, count(*) n, round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win,
  round(sum(net)::numeric,1) net FROM simulated_orders WHERE status='closed' AND exit_at > now() - interval '7 days' GROUP BY direction`))
  console.log(`${r.direction} n=${r.n} 胜率=${r.win}% 净=${r.net}`);
console.log('=== 挂单成交情况（全部 pending 订单）===');
for (const r of await q(`SELECT status, count(*) n FROM simulated_orders WHERE created_at > now() - interval '7 days' GROUP BY status ORDER BY n DESC`))
  console.log(`${r.status}: ${r.n}`);
await c.end();
