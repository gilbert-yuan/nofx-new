// 参数化「某个时间点之后」的模拟订单诊断（只读 DB）
// 用法: node scripts/_post_p8_check.cjs "2026-09-11 08:35:00+08"
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const SINCE = process.argv[2] || '2026-09-11 08:35:00+08';

async function main() {
  const c = new Client(DB);
  await c.connect();
  const wr = `100.0*count(*) FILTER (WHERE net>0)/nullif(count(*),0)`;

  // 全局：按小时看最近 24 小时
  const hr = await c.query(`
    SELECT to_char(entry_at,'MM-DD HH24') hh, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE status='closed' AND net IS NOT NULL
      AND entry_at >= now() - interval '24 hours'
    GROUP BY 1 ORDER BY 1`);
  console.log('=== 最近24h 按入场小时 ===');
  hr.rows.forEach(r => console.log(`${r.hh}: ${r.n}单 胜率${r.wr}% 净${r.net} 均单${r.avg_net} 持仓${r.held}`));

  const base = `status='closed' AND net IS NOT NULL AND entry_at >= $1`;
  const tot = await c.query(
    `SELECT count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) avg_held
     FROM simulated_orders WHERE ${base}`, [SINCE]);
  const t = tot.rows[0];
  console.log(`\n=== SINCE ${SINCE} ===`);
  console.log(`总单数 ${t.n} | 胜率 ${t.wr}% | 净盈亏 ${t.net} | 均单 ${t.avg_net} | 平均持仓 ${t.avg_held} 根`);

  const dir = await c.query(
    `SELECT direction, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
     FROM simulated_orders WHERE ${base} GROUP BY direction`, [SINCE]);
  console.log('\n=== 按方向 ===');
  dir.rows.forEach(r => console.log(`${r.direction}: ${r.n} 单, 胜率 ${r.wr}%, 净 ${r.net}, 均单 ${r.avg_net}`));

  const reason = await c.query(
    `SELECT COALESCE(reason,'(空)') reason, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
     FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY n DESC`, [SINCE]);
  console.log('\n=== 平仓原因 ===');
  reason.rows.forEach(r => console.log(`${r.reason}: ${r.n} 单, 胜率 ${r.wr}%, 净 ${r.net}, 均单 ${r.avg_net}`));

  const hold = await c.query(
    `SELECT CASE WHEN held_bars<5 THEN 'a.<5' WHEN held_bars<15 THEN 'b.5-14'
      WHEN held_bars<30 THEN 'c.15-29' WHEN held_bars<45 THEN 'd.30-44'
      WHEN held_bars<60 THEN 'e.45-59' ELSE 'f.>=60' END bucket,
      count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(avg(net)::numeric,3) avg_net
     FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY 1`, [SINCE]);
  console.log('\n=== 持仓时长分桶 ===');
  hold.rows.forEach(r => console.log(`${r.bucket}: ${r.n} 单, 胜率 ${r.wr}%, 均单 ${r.avg_net}`));

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
