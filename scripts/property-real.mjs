// 属性测试（真实数据版）：取历史上真实出过单的行情窗口重放新代码
// 验证：1) 出 plan 时止损距离满足噪声下限 2) RR>=1.2 3) 新过滤器能拦截部分历史入场
import { enhancedAnalysis } from '../server/enhancedAnalysis.js';
import { Client } from 'pg';

const c = new Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
await c.connect();
const orders = (await c.query(`
  SELECT symbol, entry, direction, entry_at FROM simulated_orders
  WHERE status='closed' AND entry IS NOT NULL ORDER BY random() LIMIT 120`)).rows;

const locate = (bars, t) => {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
};

let planOk = 0, planBad = 0, blocked = 0, otherWait = 0, noData = 0;
const blockReasons = {};
for (const o of orders) {
  const like = await c.query(`SELECT symbol FROM (SELECT DISTINCT symbol FROM market_klines WHERE interval='1m') t WHERE symbol=$1 OR symbol=$2`, ['OKX_PUBLIC_' + o.symbol, o.symbol]);
  const key = like.rows.map(r => r.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0];
  if (!key) { noData++; continue; }
  const entryT = Date.parse(o.entry_at);
  const rows = await c.query(`SELECT open_time, open, high, low, close, volume FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time < $2 ORDER BY open_time DESC LIMIT 80`, [key, entryT]);
  if (rows.rows.length < 60) { noData++; continue; }
  const klines = rows.rows.map(r => ({ openTime: Number(r.open_time), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })).reverse();
  const r = enhancedAnalysis({ symbol: o.symbol, interval: '1m', klines });
  if (r.plan) {
    const atr = r.plan.indicators.atr;
    const lastClose = klines[klines.length - 1].close;
    // 空头止损=riskUnit(从close起算)，多头止损=riskUnit+0.5ATR(从entryMax起算)
    const stopDist = Math.abs(r.plan.entryMax - r.plan.stopLoss);
    const floor = Math.max(2 * atr, lastClose * 0.008) - lastClose * 0.008 * 0.5 * atr / lastClose; // 容差: 0.004*ATR
    const risk = stopDist / r.plan.entryMax;
    const reward = Math.abs(r.plan.takeProfit2 - r.plan.entryMax) / r.plan.entryMax;
    if (stopDist + 1e-9 < floor || reward / risk < 1.2 - 1e-9) { planBad++; console.log('违规:', o.symbol, stopDist, floor, reward / risk); }
    else planOk++;
  } else if (r.reason.includes('追高') || r.reason.includes('追空') || r.reason.includes('放量')) {
    blocked++; blockReasons[r.reason.slice(0, 14)] = (blockReasons[r.reason.slice(0, 14)] || 0) + 1;
  } else otherWait++;
}
console.log(`真实窗口120个: 出plan且合规 ${planOk}, 违规 ${planBad}, 被新过滤器拦截 ${blocked}, 其他WAIT ${otherWait}, 无数据 ${noData}`);
console.log('拦截原因:', blockReasons);
await c.end();
