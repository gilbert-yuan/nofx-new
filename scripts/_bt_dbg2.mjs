// 最小复现：单个挂单逐根推进，看为什么不成交
import fs from 'node:fs';
import path from 'node:path';
import { enhancedAnalysis } from '../server/enhancedAnalysis.js';
import { TradingSimulator } from '../server/tradingSimulator.js';
import { PAPER_COSTS } from '../server/research.js';
import { recommendedLeverage } from '../server/localAnalysis.js';

const KDIR = path.resolve('data/backtest/klines');
const file = process.argv[2] || fs.readdirSync(KDIR)[0];
const bars = fs.readFileSync(path.join(KDIR, file), 'utf8').split('\n').filter(Boolean).map(l => {
  const [t, o, h, lo, c, v] = l.split(',').map(Number);
  return { openTime: t, open: o, high: h, low: lo, close: c, volume: v };
});
const symbol = file.replace('.ndjson', '');
const W = 80;

let found = 0;
for (let i = W; i < bars.length - 300 && found < 2; i++) {
  const sig = enhancedAnalysis({ symbol, interval: '1m', klines: bars.slice(i - W + 1, i + 1) });
  if (sig.action === 'WAIT' || !sig.plan) continue;
  found++;
  const dir = sig.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT';
  const plan = { ...sig.plan };
  const lev = recommendedLeverage(plan, dir);
  const order = {
    plan, initialPlan: { ...plan }, direction: dir, symbol, interval: '1m',
    nextTime: bars[i + 2].openTime, notional: 100 * lev, leverage: lev, margin: 100,
    costs: { ...PAPER_COSTS }, protectionRevisions: [], status: 'pending', error: ''
  };
  const sim = new TradingSimulator({ mode: 'account', maxPositions: Infinity, allowDuplicateSymbol: false });
  console.log(`\n=== 信号@${new Date(bars[i].openTime + 8 * 3600000).toISOString()} ${dir} close=${bars[i].close} limit=${plan.entryLimit.toFixed(8)} stop=${plan.stopLoss.toFixed(8)} tp=${plan.takeProfit.toFixed(8)} 杠杆${lev}x`);
  console.log(`    nextTime=${new Date(order.nextTime).toISOString()}  bars[i+2].openTime=${new Date(bars[i + 2].openTime).toISOString()}`);
  for (let k = 2; k < 40; k++) {
    const b = bars[i + k];
    const match = order.nextTime === b.openTime;
    const ev = sim.evaluate(order, [b], b.openTime + 60000);
    if (k <= 4 || ev.status !== 'pending') {
      console.log(`  k=${k} match=${match} low=${b.low.toFixed(8)} 触价=${b.low <= plan.entryLimit} -> ${JSON.stringify(ev).slice(0, 260)}`);
    }
    if (ev.status !== 'pending') { console.log('  结束:', ev.status, ev.reason || '', 'net=', ev.net); break; }
    Object.assign(order, {
      nextTime: ev.nextTime, entry: ev.entry ?? order.entry, entryAt: ev.entryAt ?? order.entryAt,
      heldBars: ev.heldBars, quantity: ev.quantity, entryFee: ev.entryFee,
      tpStage: ev.tpStage, tpStopFloor: ev.tpStopFloor,
      realizedGross: ev.realizedGross, realizedFee: ev.realizedFee, realizedFunding: ev.realizedFunding,
      realizedNet: ev.realizedNet, realizedQty: ev.realizedQty,
      status: ev.status, markPrice: b.close, markAt: new Date(b.openTime + 60000).toISOString()
    });
  }
}
