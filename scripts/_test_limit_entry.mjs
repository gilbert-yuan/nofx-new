// 验证：市价→限价挂单（entryLimit 触价成交）+ GTC（实盘不退市）。
import { localAnalysis } from '../server/localAnalysis.js';
import { normalizePlan } from '../server/research.js';
import { createAccountSimulator, createBacktestSimulator } from '../server/tradingSimulator.js';

// 构造「先涨后回踩到 20 均线附近」的行情，让 localAnalysis 触发 BUY。
function pullbackMarket() {
  const rows = [];
  let c = 100;
  // 前 40 根缓慢上涨到 ~105
  for (let i = 0; i < 40; i++) { rows.push({ open: c, high: c + 0.15, low: c - 0.15, close: c + 0.125, volume: 1000 }); c += 0.125; }
  // 后 20 根在 105 附近震荡（close≈20MA，且 atr/close 落在合法区间）
  for (let i = 0; i < 20; i++) {
    const wob = 0.12 * Math.sin(i * 0.7);
    const close = 105 + wob;
    rows.push({ open: c, high: close + 0.12, low: close - 0.12, close, volume: 1000 });
    c = close;
  }
  return rows;
}

const now = 60000 * Math.ceil(Date.now() / 60000);
const market = { symbol: 'BTCUSDT', interval: '1m', dataAsOf: new Date(now).toISOString(), klines: pullbackMarket() };

const sig = localAnalysis(market);
console.log('LOCAL action:', sig.action, 'entryLimit:', sig.plan?.entryLimit?.toFixed(4), 'validForBars:', sig.plan?.validForBars,
  'entryMin:', sig.plan?.entryMin?.toFixed(4), 'stopLoss:', sig.plan?.stopLoss?.toFixed(4), 'takeProfit:', sig.plan?.takeProfit?.toFixed(4));

function runSimPlan(plan, entryLimit, takeProfit, label) {
  const rec = normalizePlan(
    { positionRecommendation: 'OPEN_LONG', action: 'BUY', confidence: 0.8, reason: '', risk: '', plan },
    market, now);
  console.log(`[${label}] eligible:`, rec.eligible, 'issues:', JSON.stringify(rec.validationIssues), 'entryRule:', rec.plan?.entryRule, 'validForBars:', rec.plan?.validForBars);

  const firstEntryAt = Date.parse(rec.firstEntryAt);
  const bars = [];
  for (let i = 0; i < 8; i++) {
    const t = firstEntryAt + i * 60000;
    if (i === 0) bars.push({ openTime: t, open: entryLimit + 1, high: entryLimit + 2, low: entryLimit - 0.2, close: entryLimit + 0.5, volume: 1000 });
    else if (i === 3) bars.push({ openTime: t, open: entryLimit + 1, high: takeProfit + 2, low: entryLimit - 0.5, close: takeProfit + 1, volume: 1000 });
    else bars.push({ openTime: t, open: entryLimit + 1, high: entryLimit + 1.5, low: entryLimit - 0.5, close: entryLimit + 0.8, volume: 1000 });
  }
  const sim = createAccountSimulator();
  const r = sim.evaluate(rec, bars, bars.at(-1).openTime);
  console.log(`[${label}] ACCOUNT:`, r.status, r.reason, 'entry≈', r.entry?.toFixed(4), 'exit≈', r.exit?.toFixed(4));
  return { rec, r };
}

// 用 localAnalysis 真实计划测试（若它生成了 BUY）
if (sig.action === 'BUY' && sig.plan) {
  const { r } = runSimPlan(sig.plan, sig.plan.entryLimit, sig.plan.takeProfit, 'localAnalysis');
  if (r.status !== 'closed' || r.reason !== 'take_profit') { console.error('FAIL(local): 限价单未以 take_profit 平仓, status=', r.status, 'reason=', r.reason); process.exit(1); }
  if (Math.abs(r.entry - sig.plan.entryLimit) > sig.plan.entryLimit * 0.01) { console.error('FAIL(local): 入场价偏离 entryLimit'); process.exit(1); }
} else {
  console.log('[localAnalysis] 本次合成行情未触发 BUY（已回退到手工计划测试）');
}

// 手工计划测试（解耦 localAnalysis 过滤，直接验证 normalizePlan+simulator 接线）
const el = 100.5, tp = 113.0, sl = 91.0, emin = 100.15, emax = 100.85;
const { rec: rec2, r: r2 } = runSimPlan(
  { entryMin: emin, entryMax: emax, entryLimit: el, stopLoss: sl, takeProfit: tp, validForBars: 0, maxHoldBars: 120 },
  el, tp, 'handbuilt');
if (r2.status !== 'closed' || r2.reason !== 'take_profit') { console.error('FAIL(hand): 限价单未以 take_profit 平仓'); process.exit(1); }
if (rec2.plan?.entryRule !== 'limit_pullback') { console.error('FAIL(hand): entryRule 应为 limit_pullback'); process.exit(1); }

// GTC 验证：价格永不回调到 entryLimit → 实盘应一直 pending（不 expired）
const noPullback = [];
const firstEntryAt2 = Date.parse(rec2.firstEntryAt);
for (let i = 0; i < 5; i++) {
  const t = firstEntryAt2 + i * 60000;
  noPullback.push({ openTime: t, open: el + 5, high: el + 6, low: el + 3, close: el + 4, volume: 1000 });
}
const r3 = createAccountSimulator().evaluate(rec2, noPullback, noPullback.at(-1).openTime);
console.log('[GTC] no-pullback status:', r3.status);
if (r3.status === 'expired') { console.error('FAIL(GTC): 实盘 GTC 不应 expired'); process.exit(1); }

// 回测有界窗口：validForBars=0 在回测下收敛（不报错）
const bars = [];
for (let i = 0; i < 8; i++) {
  const t = firstEntryAt2 + i * 60000;
  if (i === 0) bars.push({ openTime: t, open: el + 1, high: el + 2, low: el - 1, close: el + 0.5, volume: 1000 });
  else if (i === 3) bars.push({ openTime: t, open: el + 1, high: tp + 2, low: el - 0.5, close: tp + 1, volume: 1000 });
  else bars.push({ openTime: t, open: el + 1, high: el + 1.5, low: el - 0.5, close: el + 0.8, volume: 1000 });
}
const r4 = createBacktestSimulator().evaluate(rec2, bars, bars.at(-1).openTime);
console.log('[BACKTEST] status:', r4.status, r4.reason);

console.log('\nALL CHECKS PASSED');
