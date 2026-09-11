// 导出真实模拟盘成交收益序列，用于统计审计（只读，不写库）
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const OUT = process.argv[2] || 'D:/UGit/nofx-new/.workbuddy/runs/20260911-crypto-viability/05_statistical_audit';

async function main() {
  const c = new Client(DB);
  await c.connect();
  fs.mkdirSync(OUT, { recursive: true });

  const rows = await c.query(`
    SELECT order_id, symbol, direction, reason, status,
           entry, exit, margin, leverage, notional, net, roi, gross, fees, funding,
           held_bars, entry_at, exit_at
    FROM simulated_orders
    WHERE status='closed' AND net IS NOT NULL AND exit_at IS NOT NULL
    ORDER BY exit_at ASC
  `);
  console.log(`总成交 ${rows.rows.length} 笔`);
  if (rows.rows.length) {
    const first = rows.rows[0].exit_at, last = rows.rows[rows.rows.length - 1].exit_at;
    console.log(`区间 ${new Date(first).toISOString()} ~ ${new Date(last).toISOString()}`);
  }

  // 逐笔收益率：以 margin 为风险本金归一（net / margin）
  const clean = rows.rows.filter(r => r.margin && Number(r.margin) > 0);
  console.log(`有效 margin 记录 ${clean.length} 笔`);

  const lines = ['date,return'];
  for (const r of clean) {
    const ret = Number(r.net) / Number(r.margin);
    lines.push(`${new Date(r.exit_at).toISOString().slice(0, 10)},${ret.toFixed(8)}`);
  }
  fs.writeFileSync(path.join(OUT, 'selected_returns.csv'), lines.join('\n') + '\n');
  console.log(`写出 selected_returns.csv: ${clean.length} 行`);

  // 原始逐笔明细（含方向/原因，供分组诊断）
  const detail = ['order_id,exit_iso,symbol,direction,reason,net,margin,roi,held_bars'];
  for (const r of clean) {
    detail.push([r.order_id, new Date(r.exit_at).toISOString(), r.symbol, r.direction, r.reason,
      Number(r.net).toFixed(4), Number(r.margin).toFixed(4), Number(r.roi || 0).toFixed(6), r.held_bars].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'trade_detail.csv'), detail.join('\n') + '\n');
  console.log(`写出 trade_detail.csv: ${clean.length} 行`);

  // 汇总
  const n = clean.length;
  const tot = clean.reduce((s, r) => s + Number(r.net), 0);
  const wins = clean.filter(r => Number(r.net) > 0).length;
  const rets = clean.map(r => Number(r.net) / Number(r.margin));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  console.log(`\n净盈亏 ${tot.toFixed(2)} U | 胜率 ${(100 * wins / n).toFixed(1)}%`);
  console.log(`逐笔收益均值 ${mean.toFixed(5)} | 标准差 ${sd.toFixed(5)} | 单笔 Sharpe ${(mean / sd).toFixed(4)}`);

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
