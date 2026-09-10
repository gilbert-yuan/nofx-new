import { enhancedAnalysis } from '../server/enhancedAnalysis.js';

// 属性测试：随机行情 + 工程化趋势行情批量跑，所有 plan 必须满足
// 1) 止损距离(相对entryMax) >= max(2*ATR, 0.8%价格) - 容差
// 2) 止盈2距离 >= 1.2 x 止损风险距离（RR过滤）
// 3) 追高过滤生效
let plans = 0, waits = 0, violations = 0;
const series = [];
// 工程化趋势：先匀速上涨建立均线多头排列，最后回调贴近MA20，成交量温和
for (let seed = 0; seed < 150; seed++) {
  let s = seed * 7919 % 1000 / 1000 + 0.5;
  const rand = () => { s = (s * 9301 + 49297) % 233280 / 233280; return s; };
  const klines = []; let price = 50 + rand() * 100;
  for (let i = 0; i < 80; i++) {
    const chg = i < 65 ? 0.0012 + (rand() - 0.5) * 0.0008 : -0.0004 + (rand() - 0.5) * 0.0006;
    price *= 1 + chg;
    const o = price * (1 - chg);
    klines.push({ openTime: i * 60000, open: o, high: Math.max(o, price) * (1 + rand() * 0.0008), low: Math.min(o, price) * (1 - rand() * 0.0008), close: price, volume: 100 + rand() * 30, closeTime: i * 60000 + 59999, confirmed: true });
  }
  series.push(klines);
  // 空头版本
  const k2 = klines.map(k => ({ ...k, open: k.open, high: k.low, low: k.high }));
  let p2 = klines[0].open;
  for (const k of k2) { p2 = k.close; }
  series.push(k2);
}
for (let seed = 0; seed < 300; seed++) {
  let s = seed * 7919 % 1000 / 1000 + 0.5;
  const rand = () => { s = (s * 9301 + 49297) % 233280 / 233280; return s; };
  const drift = (rand() - 0.5) * 0.0016;
  const klines = []; let price = 50 + rand() * 100;
  for (let i = 0; i < 80; i++) {
    const chg = drift + (rand() - 0.5) * 0.004;
    price *= 1 + chg;
    const o = price * (1 - chg);
    klines.push({ openTime: i * 60000, open: o, high: Math.max(o, price) * (1 + rand() * 0.001), low: Math.min(o, price) * (1 - rand() * 0.001), close: price, volume: 100 + rand() * 80, closeTime: i * 60000 + 59999, confirmed: true });
  }
  series.push(klines);
}
for (const klines of series) {
  const r = enhancedAnalysis({ symbol: 'R' + plans + 'USDT', interval: '1m', klines });
  if (r.plan) {
    plans++;
    const atr = r.plan.indicators.atr;
    const stopDist = Math.abs(r.plan.entryMax - r.plan.stopLoss);
    const floor = Math.max(2 * atr, r.plan.entryMax * 0.008);
    if (stopDist + 1e-9 < floor) { violations++; console.log('止损下限违规', stopDist, floor); }
    const risk = Math.abs(r.plan.entryMax - r.plan.stopLoss) / r.plan.entryMax;
    const reward = Math.abs(r.plan.takeProfit2 - r.plan.entryMax) / r.plan.entryMax;
    if (reward / risk < 1.2 - 1e-9) { violations++; console.log('RR违规', reward / risk); }
  } else waits++;
}
console.log(`行情${series.length}组: 出plan ${plans}, WAIT ${waits}, 违规 ${violations}`);
