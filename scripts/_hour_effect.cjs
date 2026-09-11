// 时段效应验证：按 UTC 小时统计（含样本量与净期望），并做前后半段稳定性检验
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

async function main() {
  const c = new Client(DB);
  await c.connect();
  const wr = `100.0*count(*) FILTER (WHERE net>0)/nullif(count(*),0)`;
  // DB 时区 Asia/Irkutsk(+08)。entry_at 转 UTC 小时。
  const base = `status='closed' AND net IS NOT NULL AND entry_at IS NOT NULL`;

  console.log('=== 1. 全量：按 UTC 小时（entry_at） ===');
  const h = await c.query(`
    SELECT extract(hour from (entry_at AT TIME ZONE 'Asia/Irkutsk') AT TIME ZONE 'UTC')::int uh,
      count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY 1`);
  h.rows.forEach(r => {
    const lh = (r.uh + 8) % 24;
    console.log(`UTC${String(r.uh).padStart(2,'0')} (本地${String(lh).padStart(2,'0')}点): ${String(r.n).padStart(4)}单 胜率${String(r.wr).padStart(5)}% 净${String(r.net).padStart(9)} 均单${r.avg_net}`);
  });

  console.log('\n=== 2. 稳定性检验：按 UTC 小时拆前后两段（以 09-10 14:00+08 为界） ===');
  const s = await c.query(`
    SELECT extract(hour from (entry_at AT TIME ZONE 'Asia/Irkutsk') AT TIME ZONE 'UTC')::int uh,
      count(*) FILTER (WHERE entry_at < '2026-09-10 14:00+08') n1,
      round(100.0*count(*) FILTER (WHERE entry_at < '2026-09-10 14:00+08' AND net>0)/nullif(count(*) FILTER (WHERE entry_at < '2026-09-10 14:00+08'),0),1) wr1,
      count(*) FILTER (WHERE entry_at >= '2026-09-10 14:00+08') n2,
      round(100.0*count(*) FILTER (WHERE entry_at >= '2026-09-10 14:00+08' AND net>0)/nullif(count(*) FILTER (WHERE entry_at >= '2026-09-10 14:00+08'),0),1) wr2
    FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY 1`);
  console.log('UTC时 | 旧段(样本/胜率) | 新段(样本/胜率)');
  s.rows.forEach(r => console.log(`  ${String(r.uh).padStart(2,'0')}  | ${String(r.n1).padStart(4)} / ${String(r.wr1).padStart(5)}% | ${String(r.n2).padStart(4)} / ${String(r.wr2).padStart(5)}%`));

  console.log('\n=== 3. 分时段汇总（本地 09-13 高密时段 vs 其余） ===');
  const seg = await c.query(`
    SELECT CASE WHEN extract(hour from (entry_at AT TIME ZONE 'Asia/Irkutsk') AT TIME ZONE 'UTC')::int BETWEEN 1 AND 5
                THEN '本地09-13(UTC01-05)' ELSE '其余时段' END seg,
      count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY 1`);
  seg.rows.forEach(r => console.log(`${r.seg}: ${r.n}单 胜率${r.wr}% 净${r.net} 均单${r.avg_net} 持仓${r.held}`));

  console.log('\n=== 4. 只取 P4 之后干净样本（09-10 14:00+08 起）按时段 ===');
  const seg2 = await c.query(`
    SELECT CASE WHEN extract(hour from (entry_at AT TIME ZONE 'Asia/Irkutsk') AT TIME ZONE 'UTC')::int BETWEEN 1 AND 5
                THEN '本地09-13(UTC01-05)' ELSE '其余时段' END seg,
      count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE ${base} AND entry_at >= '2026-09-10 14:00+08' GROUP BY 1 ORDER BY 1`);
  seg2.rows.forEach(r => console.log(`${r.seg}: ${r.n}单 胜率${r.wr}% 净${r.net} 均单${r.avg_net}`));

  await c.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
