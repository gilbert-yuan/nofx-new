/**
 * 探针：智能退出（enhancedProtectionReview 的 CLOSE 规则）会对当前持仓造成什么影响。
 *
 * 背景：globalAutomation.reviewPositions 的 CLOSE 分支此前只记录不平仓（死逻辑），
 *       2026-09-10 修正为真正平仓后，需要在下一次复核前预判「会有几个持仓被立刻平掉」。
 *
 * 用法（服务需在线，且本地 market_klines 有数据）：
 *   node scripts/probe-smart-exit-impact.mjs
 * 输出：动作分布（CLOSE/HOLD/UPDATE_PROTECTION）+ 每个持仓的浮盈与命中理由。
 *
 * ⚠️ 只能当「快照」，不能当「预测」：CLOSE 的「均线失守且未盈利5%」是滚动条件，
 *    每根 1m K 线都会让 MA20/ATR 漂移、命中集合随之变化。
 *    实测教训：某次探针（20 持仓）预测 CLOSE 5 个，6 分钟后线上首轮只平了 1 个。
 *    另外本脚本用 API 原始 rows（可能含未收盘那根），线上走 prepareMarket（仅已收盘），
 *    两者存在少量口径差。做决策时请以线上日志为准。
 *
 * 注意：数据源为本地 market_klines（getFreshMarket 的首选源），与线上实际复核口径一致。
 */
import fs from 'node:fs';
import pg from 'pg';
import { enhancedProtectionReview } from '../server/enhancedAnalysis.js';

const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const conn = env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx';

const acct = await (await fetch('http://127.0.0.1:3100/api/paper/account')).json();
const open = acct.orders.filter(o => o.status === 'open');
console.log(`持仓数: ${open.length}`);

const pool = new pg.Pool({ connectionString: conn });
const tally = {};
const detail = [];

for (const o of open) {
  const candidates = [`OKX_PUBLIC_${o.symbol}`, o.symbol];
  let rows = [];
  for (const sym of candidates) {
    const r = await pool.query(
      `SELECT open_time AS "openTime", open, high, low, close, volume
         FROM market_klines WHERE symbol = $1 AND interval = $2
        ORDER BY open_time DESC LIMIT 80`, [sym, o.interval]);
    if (r.rows.length) { rows = r.rows.reverse().map(x => ({ ...x, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume, openTime: Number(x.openTime) })); break; }
  }

  if (rows.length < 30) {
    tally['数据不足'] = (tally['数据不足'] || 0) + 1;
    detail.push(`${'数据不足'.padEnd(18)} ${o.symbol.padEnd(12)} ${o.direction} 本地K线仅 ${rows.length} 根`);
    continue;
  }

  const proposal = enhancedProtectionReview(
    { direction: o.direction, entry: o.entry, plan: { stopLoss: o.plan.stopLoss, takeProfit: o.plan.takeProfit } },
    { symbol: o.symbol, interval: o.interval, klines: rows }
  );
  tally[proposal.action] = (tally[proposal.action] || 0) + 1;
  const profit = o.direction === 'OPEN_LONG' ? (rows.at(-1).close - o.entry) / o.entry : (o.entry - rows.at(-1).close) / o.entry;
  detail.push(`${proposal.action.padEnd(18)} ${o.symbol.padEnd(12)} ${o.direction} 浮盈${(profit * 100).toFixed(2)}%  ${proposal.reason || ''}`);
}

await pool.end();
console.log('\n动作分布: ' + JSON.stringify(tally));
console.log('\n明细:');
for (const d of detail) console.log(d);
