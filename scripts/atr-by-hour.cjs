/**
 * 按 UTC 小时统计：历史入场点的 ATR/价格 均值与波动率下限通过率，
 * 判断"当前快照几乎全被波动率闸门拦下"是时段效应还是普遍现象。
 * 只读数据库。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const atr14 = bars => {
  if (bars.length < 15) return null;
  let s = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  return s / 14;
};

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT symbol, interval, entry, entry_at, exit_at, net
    FROM simulated_orders WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL
      AND interval='1m' ORDER BY entry_at`)).rows;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 30 * 60000;
  const keyMap = new Map();
  for (const s of [...new Set(orders.map(o => o.symbol))]) {
    const r = await c.query(`SELECT DISTINCT symbol FROM market_klines WHERE symbol=$1 OR symbol=$2`, ['OKX_PUBLIC_' + s, s]);
    keyMap.set(s, r.rows.map(x => x.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0] || null);
  }
  const cache = new Map();
  const getBars = async symbol => {
    if (cache.has(symbol)) return cache.get(symbol);
    const key = keyMap.get(symbol);
    let bars = [];
    if (key) {
      const r = await c.query(`SELECT open_time,open,high,low,close FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time>=$2 AND open_time<=$3 ORDER BY open_time`, [key, minT, maxT]);
      bars = r.rows.map(x => ({ openTime: +x.open_time, open: +x.open, high: +x.high, low: +x.low, close: +x.close }));
    }
    cache.set(symbol, bars);
    return bars;
  };
  const locate = (bars, t) => {
    if (!bars?.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const byHour = new Map();
  let tot = 0;
  for (const o of orders) {
    const bars = await getBars(o.symbol);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const a = atr14(bars.slice(0, idx));
    if (!a) continue;
    const p = a / o.entry;
    const h = new Date(Date.parse(o.entry_at)).getUTCHours();
    if (!byHour.has(h)) byHour.set(h, { n: 0, sum: 0, p20: 0, p30: 0, p35: 0, p40: 0, net: 0, netP30: 0, nP30: 0 });
    const b = byHour.get(h);
    b.n++; b.sum += p; b.net += +o.net;
    if (p >= 0.002) b.p20++;
    if (p >= 0.003) { b.p30++; b.netP30 += +o.net; b.nP30++; }
    if (p >= 0.0035) b.p35++;
    if (p >= 0.004) b.p40++;
    tot++;
  }
  console.log(`1m 已平仓样本 ${tot}`);
  console.log('UTC时  样本  平均ATR%  ≥0.20%  ≥0.30%  ≥0.35%  ≥0.40%   ≥0.30%后均单');
  for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
    const b = byHour.get(h);
    console.log(
      `${String(h).padStart(3)}点 ${String(b.n).padStart(5)}  ${(100 * b.sum / b.n).toFixed(3).padStart(6)}  ` +
      `${(100 * b.p20 / b.n).toFixed(0).padStart(5)}%  ${(100 * b.p30 / b.n).toFixed(0).padStart(5)}%  ` +
      `${(100 * b.p35 / b.n).toFixed(0).padStart(5)}%  ${(100 * b.p40 / b.n).toFixed(0).padStart(5)}%  ` +
      `${b.nP30 ? (b.netP30 / b.nP30).toFixed(2).padStart(7) : '   n/a'}`);
  }
  const T = [...byHour.values()].reduce((a, b) => ({ n: a.n + b.n, p30: a.p30 + b.p30, p35: a.p35 + b.p35, p40: a.p40 + b.p40, p20: a.p20 + b.p20 }), { n: 0, p30: 0, p35: 0, p40: 0, p20: 0 });
  console.log(`\n合计 通过率：≥0.20% ${(100 * T.p20 / T.n).toFixed(1)}% | ≥0.30% ${(100 * T.p30 / T.n).toFixed(1)}% | ≥0.35% ${(100 * T.p35 / T.n).toFixed(1)}% | ≥0.40% ${(100 * T.p40 / T.n).toFixed(1)}%`);
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
