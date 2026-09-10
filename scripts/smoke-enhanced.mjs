import { enhancedAnalysis } from '../server/enhancedAnalysis.js';

// 冒烟1：放量场景应 WAIT（量比过滤）
const k1 = []; let p1 = 100;
for (let i = 0; i < 80; i++) {
  p1 *= 1.001; const o = p1 * (1 - 0.0008); const vol = i > 70 ? 500 : 100;
  k1.push({ openTime: i * 60000, open: o, high: p1 * 1.001, low: o * 0.999, close: p1, volume: vol, closeTime: i * 60000 + 59999, confirmed: true });
}
const r1 = enhancedAnalysis({ symbol: 'T1USDT', interval: '1m', klines: k1 });
console.log('放量场景 action:', r1.action, '| reason:', r1.reason.slice(0, 40));

// 冒烟2：温和趋势应给出 plan，且止损距离>=0.8%价格
const k2 = []; let p2 = 100;
for (let i = 0; i < 80; i++) {
  p2 *= i < 60 ? 1.001 : 0.9995; const o = p2 * (1 - 0.0008);
  k2.push({ openTime: i * 60000, open: o, high: p2 * 1.0008, low: o * 0.9992, close: p2, volume: 100, closeTime: i * 60000 + 59999, confirmed: true });
}
const r2 = enhancedAnalysis({ symbol: 'T2USDT', interval: '1m', klines: k2 });
if (r2.plan) {
  const stopDist = Math.abs(r2.plan.stopLoss - r2.plan.entryMin) / r2.plan.entryMin;
  console.log('温和趋势 action:', r2.action, '| 止损距离:', (stopDist * 100).toFixed(2) + '%', '| RR:', r2.plan.riskRewardRatio.toFixed(2), '| 杠杆:', r2.plan.recommendedLeverage);
} else {
  console.log('温和趋势 action:', r2.action, '| reason:', r2.reason.slice(0, 40));
}
