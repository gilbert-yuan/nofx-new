// 诊断：挂单到底能不能成交？若不撤单，多久能成交？
import fs from 'node:fs';
import path from 'node:path';
import { enhancedAnalysis } from '../server/enhancedAnalysis.js';
import { PAPER_COSTS } from '../server/research.js';

const KDIR = path.resolve('data/backtest/klines');
const file = process.argv[2] || fs.readdirSync(KDIR)[0];
const txt = fs.readFileSync(path.join(KDIR, file), 'utf8');
const bars = txt.split('\n').filter(Boolean).map(l => {
  const [t, o, h, lo, c, v] = l.split(',').map(Number);
  return { openTime: t, open: o, high: h, low: lo, close: c, volume: v };
});
const symbol = file.replace('.ndjson', '');
const W = 80;
let sigs = 0;
const hitAt = [0, 0, 0, 0, 0, 0]; // 1,3,5,15,30,60 根内成交
let sample = null;
for (let i = W; i < bars.length - 240; i++) {
  const sig = enhancedAnalysis({ symbol, interval: '1m', klines: bars.slice(i - W + 1, i + 1) });
  if (sig.action === 'WAIT' || !sig.plan) continue;
  sigs++;
  const long = sig.action === 'BUY';
  const limit = sig.plan.entryLimit;
  if (!Number.isFinite(limit)) { console.log('!! entryLimit 非法', limit); continue; }
  const first = {};
  for (const h of [1, 3, 5, 15, 30, 60, 120]) {
    let ok = false;
    for (let k = 2; k <= 2 + h && i + k < bars.length; k++) {
      const b = bars[i + k];
      if (long ? b.low <= limit : b.high >= limit) { ok = true; break; }
    }
    first[h] = ok;
  }
  for (const [idx, h] of [1, 3, 5, 15, 30, 60].entries()) if (first[h]) hitAt[idx]++;
  if (!sample && sigs <= 3) {
    const ind = sig.plan.indicators;
    sample = { i, t: new Date(bars[i].openTime + 8 * 3600000).toISOString(), action: sig.action, close: bars[i].close,
      atr: ind?.atr, atrPct: ind ? ind.atr / bars[i].close : null, score: sig.plan.trendStrengthScore,
      limit, entryMin: sig.plan.entryMin, entryMax: sig.plan.entryMax, stop: sig.plan.stopLoss, tp: sig.plan.takeProfit,
      next10low: bars.slice(i + 2, i + 12).map(b => b.low), first };
  }
}
console.log(`币种 ${symbol}  信号数 ${sigs}`);
console.log('若不撤单，挂单在 N 根内成交的比例：');
[1, 3, 5, 15, 30, 60].forEach((h, idx) => {
  console.log(`  ≤${String(h).padStart(2)} 根(${String(h).padStart(2)}分钟): ${hitAt[idx]} 笔  ${(100 * hitAt[idx] / sigs).toFixed(1)}%`);
});
console.log('\n样例信号:', JSON.stringify(sample, null, 1));
