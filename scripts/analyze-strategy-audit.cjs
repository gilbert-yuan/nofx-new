// 临时策略审计：输出 JSON 报告（只读）
const { Client } = require('pg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

async function main() {
  const c = new Client(DB);
  await c.connect();
  const out = {};
  const wr = `100.0*count(*) FILTER (WHERE net>0)/nullif(count(*),0)`;
  const base = `status='closed' AND net IS NOT NULL`;

  out.reason = (await c.query(`
    SELECT COALESCE(reason,'(null)') reason, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) avg_held
    FROM simulated_orders WHERE ${base}
    GROUP BY 1 ORDER BY n DESC`)).rows;

  out.byInterval = (await c.query(`
    SELECT COALESCE(interval,'(null)') interval, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY n DESC`)).rows;

  out.leverage = (await c.query(`
    SELECT leverage, count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(${wr},1) wr, round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net
    FROM simulated_orders WHERE ${base} GROUP BY 1 ORDER BY 1`)).rows;

  out.byDay = (await c.query(`
    SELECT to_char(date_trunc('hour', exit_at),'MM-DD HH24:00') h, count(*) n,
      count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE ${base} AND exit_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`)).rows;

  out.ev = (await c.query(`
    SELECT count(*) n, count(*) FILTER (WHERE net>0) wins,
      round(sum(CASE WHEN net>0 THEN net ELSE 0 END)::numeric,2) gross_win,
      round(sum(CASE WHEN net<0 THEN net ELSE 0 END)::numeric,2) gross_loss,
      round(avg(CASE WHEN net>0 THEN net END)::numeric,2) avg_win,
      round(avg(CASE WHEN net<0 THEN net END)::numeric,2) avg_loss,
      round(avg(roi)::numeric,4) avg_roi,
      round(avg(margin)::numeric,2) avg_margin
    FROM simulated_orders WHERE ${base}`)).rows[0];

  out.reasonHeld = (await c.query(`
    SELECT COALESCE(reason,'(null)') reason,
      CASE WHEN held_bars<15 THEN 'fast(<15)' ELSE 'slow(>=15)' END speed,
      count(*) n, round(${wr},1) wr, round(avg(net)::numeric,3) avg_net, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE ${base} GROUP BY 1,2 ORDER BY 1,2`)).rows;

  out.worstSymbols = (await c.query(`
    SELECT symbol, count(*) n, round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE ${base} GROUP BY symbol HAVING count(*)>=10 ORDER BY sum(net) ASC LIMIT 20`)).rows;
  out.bestSymbols = (await c.query(`
    SELECT symbol, count(*) n, round(${wr},1) wr, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE ${base} GROUP BY symbol HAVING count(*)>=10 ORDER BY sum(net) DESC LIMIT 10`)).rows;

  // 亏损集中度：累计净亏损曲线（按币种净盈亏排序累计）
  out.symbolAgg = (await c.query(`
    SELECT count(DISTINCT symbol) symbols, count(*) n FROM simulated_orders WHERE ${base}`)).rows[0];

  // 最近 100 / 300 笔
  out.recent = (await c.query(`
    SELECT '100' k, count(*) n, round(${wr},1) wr, round(sum(net)::numeric,2) net FROM
      (SELECT * FROM simulated_orders WHERE ${base} ORDER BY exit_at DESC NULLS LAST LIMIT 100) t
    UNION ALL
    SELECT '300', count(*), round(${wr},1), round(sum(net)::numeric,2) FROM
      (SELECT * FROM simulated_orders WHERE ${base} ORDER BY exit_at DESC NULLS LAST LIMIT 300) t2
    UNION ALL
    SELECT '1000', count(*), round(${wr},1), round(sum(net)::numeric,2) FROM
      (SELECT * FROM simulated_orders WHERE ${base} ORDER BY exit_at DESC NULLS LAST LIMIT 1000) t3`)).rows;

  // 手续费/资金费侵蚀
  out.cost = (await c.query(`
    SELECT round(sum(gross)::numeric,2) gross, round(sum(fees)::numeric,2) fees,
      round(sum(funding)::numeric,2) funding, round(sum(net)::numeric,2) net,
      round(sum(isolated_loss_adjustment)::numeric,2) iso_adj
    FROM simulated_orders WHERE ${base}`)).rows[0];

  // 出场原因 × 价差(gross) 拆分：价差层面赢/亏 vs 成本
  out.grossSplit = (await c.query(`
    SELECT round(sum(CASE WHEN gross>0 THEN gross ELSE 0 END)::numeric,2) gross_win,
      round(sum(CASE WHEN gross<0 THEN gross ELSE 0 END)::numeric,2) gross_loss,
      round(avg(CASE WHEN gross>0 THEN gross END)::numeric,3) avg_gwin,
      round(avg(CASE WHEN gross<0 THEN gross END)::numeric,3) avg_gloss,
      round(avg(fees)::numeric,4) avg_fee
    FROM simulated_orders WHERE ${base}`)).rows[0];

  // P4 批次对比（2026-09-10 10:16 部署）
  out.batch = {};
  out.batch.p4 = (await c.query(`
    SELECT 'P4(0910 10:16~)' k, count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net, round(avg(held_bars)::numeric,1) avg_held
    FROM simulated_orders WHERE ${base} AND entry_at >= '2026-09-10 10:16:00+08'`)).rows[0];
  out.batch.preP4 = (await c.query(`
    SELECT 'pre-P4' k, count(*) n, count(*) FILTER (WHERE net>0) wins, round(${wr},1) wr,
      round(sum(net)::numeric,2) net, round(avg(net)::numeric,3) avg_net, round(avg(held_bars)::numeric,1) avg_held
    FROM simulated_orders WHERE ${base} AND entry_at < '2026-09-10 10:16:00+08'`)).rows[0];

  // P4 后的出场原因
  out.p4reason = (await c.query(`
    SELECT COALESCE(reason,'(null)') reason, count(*) n, round(${wr},1) wr,
      round(avg(net)::numeric,3) avg_net, round(sum(net)::numeric,2) net
    FROM simulated_orders WHERE ${base} AND entry_at >= '2026-09-10 10:16:00+08'
    GROUP BY 1 ORDER BY n DESC`)).rows;

  await c.end();
  const f = path.join(os.tmpdir(), 'nofx_strategy_audit.json');
  fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
}
main().catch(e => {
  try { fs.writeFileSync(path.join(os.tmpdir(), 'nofx_strategy_audit_err.txt'), (e && e.stack) || String(e), 'utf8'); } catch (_) {}
  process.exit(1);
});
