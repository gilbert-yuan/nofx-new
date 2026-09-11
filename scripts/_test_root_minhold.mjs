// 根级最小持仓保护回归测试（2026-09-11，P8 补丁）
//
// 背景：P8 主提交（5e40831）只在复核层（enhancedProtectionReview）加了最小持仓闸门，
// 但「根级逐根均线失守」（tradingSimulator._simulate）——被平单的大头——没有闸门，
// 52% 订单 1 根内被平的结构性矛盾在根级依然存在。本测试锁死根级闸门的三项性质：
//   1. 保护期内（held < minHoldBars）根级均线失守不得平仓（status 保持 open）
//   2. minHoldBars=0（旧行为）时照常平仓，reason=smart_exit_ma
//   3. 持仓满 minHoldBars 后，根级均线失守恢复平仓
//
// 用法：node scripts/_test_root_minhold.mjs
import { createAccountSimulator } from '../server/tradingSimulator.js';
import { normalizePlan } from '../server/research.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label} ${extra}`); failures++; }
};

// ── 几何设计（多头限价挂单 entryLimit=100.05）────────────────────────────────
// 挂单价 100.05，止损 99.2（R=0.85），主止盈 102.9。
// 阶段一（20 根）低位悬空：low=100.2 永不触及挂单价 → 不入场，攒出 MA20/ATR。
// 阶段二第 21 根触价入场；之后每根 held 递增。
// 跌破 K 线：close 远低于 MA20 且偏离 > 1 ATR、low 不触及初始止损。
const LIMIT = 100.05, STOP = 99.2, TP = 102.9, R = 0.85;

const k = (openTime, o, h, l, c) => ({ openTime, open: o, high: h, low: l, close: c, volume: 1000 });

/** 20 根悬空（不成交）+ 1 根入场；返回 [rows, entryBarIndex] */
function buildRows(first, breakAtHeld) {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(k(first + i * 60000, 100.3, 100.4, 100.2, 100.3));
  // 第 21 根：low 触及 100.05 → 入场（held=1）
  rows.push(k(first + 20 * 60000, 100.1, 100.15, 100.0, 100.1));
  return rows;
}

/** 在入场后第 heldBar 根插入跌破 K 线（heldBar 从 1 计，1=入场当根） */
function withBreak(rows, first, heldBar) {
  // heldBar 根平静 K 线已在 rows 中（入场根算第 1 根），补到 heldBar-1 根平静后插跌破根
  const extra = heldBar - 1;
  for (let i = 0; i < extra; i++) {
    const t = first + (21 + i) * 60000;
    rows.push(k(t, 100.2, 100.3, 100.1, 100.2));
  }
  const t = first + (21 + extra) * 60000;
  rows.push(k(t, 100.2, 100.25, 99.85, 99.9));   // 跌破 MA20 超 1 ATR
  return rows;
}

function makeRec(rows, now, minHoldBars) {
  const market = { symbol: 'TESTUSDT', interval: '1m', dataAsOf: new Date(now).toISOString(), klines: rows };
  return normalizePlan(
    {
      positionRecommendation: 'OPEN_LONG', action: 'BUY', confidence: 0.8, reason: '', risk: '',
      plan: {
        entryMin: 99.5, entryMax: 100.5, entryLimit: LIMIT, stopLoss: STOP, takeProfit: TP,
        validForBars: 0, maxHoldBars: 120, riskUnit: R,
        smartExit: { barLevel: true, maPeriod: 20, maBreakAtr: 1.0, maExitMaxProfitR: 0.4, minHoldBars }
      }
    }, market, now);
}

const run = (rows, now, minHoldBars) =>
  createAccountSimulator().evaluate(makeRec(rows, now, minHoldBars), rows, rows.at(-1).openTime + 60000);

console.log('\n[#1] 保护期内（held=2 < 15）根级均线失守不得平仓');
{
  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = withBreak(buildRows(first), first, 2);
  const r = run(rows, now, 15);
  ok(r.status !== 'closed', '未平仓（status=' + r.status + '）', `status=${r.status} reason=${r.reason}`);
  ok(r.reason !== 'smart_exit_ma', 'reason 不是 smart_exit_ma', `reason=${r.reason}`);
  ok((r.heldBars || 0) >= 1, '已入场且在持仓中', `heldBars=${r.heldBars}`);
}

console.log('\n[#2] minHoldBars=0（旧行为）：同场景必须照常平仓');
{
  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = withBreak(buildRows(first), first, 2);
  const r = run(rows, now, 0);
  ok(r.status === 'closed' && r.reason === 'smart_exit_ma', '根级均线失守平仓', `status=${r.status} reason=${r.reason}`);
  ok((r.heldBars || 0) < 15, '平仓发生在保护期内（证明旧行为确实会被闸门拦住）', `heldBars=${r.heldBars}`);
}

console.log('\n[#3] 持仓满 15 根后：根级均线失守恢复平仓');
{
  const now = 60000 * Math.ceil(Date.now() / 60000);
  const first = now + 60000;
  const rows = withBreak(buildRows(first), first, 16);
  const r = run(rows, now, 15);
  ok(r.status === 'closed' && r.reason === 'smart_exit_ma', '保护期满后照常平仓', `status=${r.status} reason=${r.reason}`);
  ok((r.heldBars || 0) >= 15, `平仓时持仓 ${r.heldBars} 根 ≥ 15`, `heldBars=${r.heldBars}`);
}

console.log(failures ? `\n❌ ${failures} 项失败` : '\n✅ 全部通过');
process.exit(failures ? 1 : 0);
