/**
 * 回填历史平仓理由（dry-run 默认，加 --apply 才落库）
 *
 * 背景：2026-09-11 之前「智能退出」平仓被硬编码记成 `manual`，
 *       但中文原因存在 reviewHistory 里（`均线失守…` / `RSI…` / `MACD…`）。
 *       本脚本从 reviewHistory 找回那句话，归一成机器码写回 `reason`，
 *       让历史数据也能按平仓理由统计。
 *
 * 用法：
 *   node scripts/backfill-close-reasons.mjs           # 只看会改什么
 *   node scripts/backfill-close-reasons.mjs --apply   # 真正写库
 */

import pg from 'pg';
import { normalizeCloseReason, closeReasonLabel } from '../shared/closeReasons.js';

const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  connectionString: process.env.NOFX_PG_URL || 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite'
});

// 已平仓、理由为 manual（或空）、且有复核历史记录明细的订单
const CANDIDATES = `
  SELECT o.order_id, o.symbol, o.reason, o.net, o.exit_at,
         r.reason AS review_reason, r.action, r.at
  FROM simulated_orders o
  JOIN simulated_order_reviews r ON r.order_id = o.order_id
  WHERE o.status = 'closed'
    AND (o.reason IS NULL OR o.reason = '' OR o.reason = 'manual')
    AND r.action = 'smart_exit'
  ORDER BY o.exit_at
`;

try {
  const { rows } = await pool.query(CANDIDATES);
  const plan = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.order_id)) continue; // 一单可能有多条复核记录，取第一条
    seen.add(r.order_id);
    const next = normalizeCloseReason(r.review_reason);
    if (next === 'manual') continue; // 这句中文也认不出来，跳过
    plan.push({ order_id: r.order_id, symbol: r.symbol, from: r.reason || '(空)', to: next, net: r.net, exitAt: r.exit_at });
  }

  console.log(`候选 ${rows.length} 条复核记录 → 可回填 ${plan.length} 单\n`);
  const byNext = {};
  for (const p of plan) byNext[p.to] = (byNext[p.to] || 0) + 1;
  for (const [code, n] of Object.entries(byNext)) console.log(`  ${code.padEnd(18)} ${closeReasonLabel(code)}  ${n} 单`);

  if (!plan.length) {
    console.log('\n无需回填。');
    await pool.end();
    process.exit(0);
  }

  console.log('\n样例：');
  for (const p of plan.slice(0, 8)) {
    console.log(`  ${p.order_id}  ${p.symbol}  ${p.from} → ${p.to}  net=${p.net}`);
  }

  if (!APPLY) {
    console.log('\n[dry-run] 未写库。确认无误后加 --apply 执行。');
    await pool.end();
    process.exit(0);
  }

  let done = 0;
  for (const p of plan) {
    const { rowCount } = await pool.query(
      'UPDATE simulated_orders SET reason = $1 WHERE order_id = $2 AND status = $3',
      [p.to, p.order_id, 'closed']
    );
    done += rowCount;
  }
  console.log(`\n已回填 ${done} 单。`);
} catch (err) {
  console.error('失败：', err.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
