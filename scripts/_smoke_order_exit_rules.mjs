/**
 * 冒烟：验证「订单按自己策略的出场规则结算」
 *   1) tradingSimulator 读 plan.exitRules.partialTp（分批止盈档位随订单走）
 *   2) localProtectionReview 读 plan.exitRules.trailing（移动止损触发线随订单走）
 *   3) 无快照的旧订单 → 回退全局默认，行为与改造前一致
 */
import { TradingSimulator } from '../server/tradingSimulator.js';
import { localProtectionReview } from '../server/shared/protectionReview.js';
import { PARTIAL_TP, TRAILING_RULE } from '../server/shared/strategyGuards.js';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const bar = (i, o, h, l, c) => ({ openTime: T0 + i * 60000, open: o, high: h, low: l, close: c, volume: 10, confirmed: true });

// 入场 100.05（entryLimit=100 + 5bps 滑点），riskUnit=0.5 → TP1=100.55 / TP2=101.05 / 主止盈=103
const rows = [
  bar(0, 100.30, 100.40, 99.90, 100.20),
  bar(1, 100.40, 100.70, 100.30, 100.60),  // 触 TP1
  bar(2, 100.60, 101.20, 100.50, 101.10),  // 触 TP2
  bar(3, 101.10, 103.50, 101.00, 103.40),  // 触主止盈
  bar(4, 103.40, 103.60, 103.10, 103.30),
  bar(5, 103.30, 103.50, 103.00, 103.20)
];
const NOW = T0 + 10 * 60000;

const basePlan = { entryLimit: 100, stopLoss: 99.55, takeProfit: 103, riskUnit: 0.5, maxHoldBars: 200 };
const mkOrder = (plan) => ({
  direction: 'OPEN_LONG', symbol: 'BTCUSDT', interval: '1m',
  nextTime: T0, notional: 1000, leverage: 1, margin: 1000,
  costs: { feeBps: 6, slippageBps: 5, fundingBpsPer8h: 1, notional: 1000 },
  plan
});

const sim = new TradingSimulator({ mode: 'account', enableLiquidation: false });

const run = (label, plan) => {
  const res = sim.evaluate(mkOrder(plan), rows, NOW);
  console.log(`[${label}] status=${res.status} reason=${res.reason} heldBars=${res.heldBars} partialFills=${res.partialFills} net=${Number(res.net).toFixed(4)} entry=${res.entry}`);
  return res;
};

console.log('--- 1) 无 exitRules（旧订单）→ 回退全局 PARTIAL_TP ---');
const a = run('default', { ...basePlan });

console.log('--- 2) exitRules.partialTp.enabled=false → 不分批 ---');
const b = run('tp-off', { ...basePlan, exitRules: { partialTp: { enabled: false } } });

console.log('--- 3) exitRules.partialTp.tp1R=0.5 → 分批提前 ---');
const c = run('tp-early', { ...basePlan, exitRules: { partialTp: { enabled: true, tp1R: 0.5, tp2R: 1.5, tp1ClosePct: 0.4, tp2ClosePct: 0.4 } } });

const ok1 = a.partialFills === 2 && b.partialFills === 0 && c.partialFills === 2;
console.log('断言1 分批档位随订单 exitRules 变化:', ok1 ? 'PASS' : 'FAIL');

console.log('\n--- 4) localProtectionReview 读 plan.exitRules.trailing ---');
const protOrder = (trailing) => ({
  direction: 'OPEN_LONG', entry: 100.05, quantity: 10, costs: { feeBps: 6, slippageBps: 5 },
  plan: { stopLoss: 99.55, takeProfit: 103, riskUnit: 0.5, ...(trailing ? { exitRules: { trailing } } : {}) }
});
// 价格 100.6 → 浮盈 (100.6-100.05)/0.5 = 1.1R。ATR(14) 需要 ≥15 根，故给 20 根带振幅的 K 线。
const protRows = [];
for (let i = 0; i < 19; i++) protRows.push(bar(i, 100.5, 100.8, 100.3, 100.6));
protRows.push(bar(19, 100.5, 100.8, 100.4, 100.6));
const market = { klines: protRows };

const pDefault = localProtectionReview(protOrder(null), market);
const pLoose = localProtectionReview(protOrder({ triggerR: 5 }), market);
console.log('默认(triggerR=' + TRAILING_RULE.triggerR + '):', pDefault.action, '|', pDefault.reason);
console.log('订单级 triggerR=5       :', pLoose.action, '|', pLoose.reason);
const ok2 = pDefault.action === 'UPDATE_PROTECTION' && pLoose.action === 'HOLD';
console.log('断言2 移动止损触发线随订单 trailing 变化:', ok2 ? 'PASS' : 'FAIL');

console.log('\n默认全局 PARTIAL_TP.tp1R =', PARTIAL_TP.tp1R, '/ triggerR =', TRAILING_RULE.triggerR);
console.log(ok1 && ok2 ? '\n✅ 冒烟全部通过' : '\n❌ 冒烟失败');
process.exit(ok1 && ok2 ? 0 : 1);
