/**
 * 候选配置评估：把"1m 周期 + 波动率下限 + RSI/偏离过滤"等候选组合，
 * 在真实已平仓订单上量化其胜率与净盈亏，用于决定落地参数。
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
const ma20 = bars => bars.length < 20 ? null : bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20;
const rsi14 = bars => {
  if (bars.length < 15) return null;
  let g = 0, l = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch > 0) g += ch; else l -= ch;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
};

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, net, held_bars, entry_at, exit_at, reason
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL ORDER BY entry_at`)).rows;

  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 30 * 60000;
  const keyMap = new Map();
  for (const s of [...new Set(orders.map(o => o.symbol))]) {
    const r = await c.query(`SELECT DISTINCT symbol FROM market_klines WHERE symbol=$1 OR symbol=$2`, ['OKX_PUBLIC_' + s, s]);
    const keys = r.rows.map(x => x.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0));
    keyMap.set(s, keys[0] || null);
  }
  const cache = new Map();
  const getBars = async (symbol, interval) => {
    const k = keyMap.get(symbol) + '|' + interval;
    if (cache.has(k)) return cache.get(k);
    let bars = [];
    const key = keyMap.get(symbol);
    if (key) {
      const r = await c.query(
        `SELECT open_time, open, high, low, close, volume FROM market_klines
         WHERE symbol=$1 AND interval=$2 AND open_time>=$3 AND open_time<=$4 ORDER BY open_time`,
        [key, interval, minT, maxT]);
      bars = r.rows.map(x => ({ openTime: Number(x.open_time), open: +x.open, high: +x.high, low: +x.low, close: +x.close }));
    }
    cache.set(k, bars);
    return bars;
  };
  const locate = (bars, t) => {
    if (!bars?.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const F = [];
  for (const o of orders) {
    const interval = o.interval || '1m';
    const bars = await getBars(o.symbol, interval);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const atr = atr14(before), m = ma20(before);
    if (!atr || !m) continue;
    F.push({
      net: +o.net, long: o.direction === 'OPEN_LONG', interval,
      atrPct: atr / o.entry, ext: (before.at(-1).close - m) / atr, rsi: rsi14(before)
    });
  }

  const ev = (label, sub) => {
    if (!sub.length) { console.log(`${label.padEnd(52)} n=0`); return; }
    const wins = sub.filter(x => x.net > 0).length;
    const net = sub.reduce((a, x) => a + x.net, 0);
    const gw = sub.filter(x => x.net > 0).reduce((a, x) => a + x.net, 0);
    const gl = sub.filter(x => x.net < 0).reduce((a, x) => a + x.net, 0);
    console.log(`${label.padEnd(52)} n=${String(sub.length).padStart(4)} 胜率=${(100 * wins / sub.length).toFixed(1).padStart(5)}% 净=${net.toFixed(0).padStart(7)} 均单=${(net / sub.length).toFixed(3).padStart(6)} 盈亏比=${gl ? (gw / -gl).toFixed(2) : 'n/a'}`);
  };

  console.log('总样本:', F.length);
  console.log('\n=== 候选配置 ===');
  ev('C0 现状（1m+5m 全部）', F);
  ev('C1 仅1m', F.filter(x => x.interval === '1m'));
  ev('C2 仅1m & atr>=0.30%', F.filter(x => x.interval === '1m' && x.atrPct >= 0.003));
  ev('C3 仅1m & atr>=0.35%', F.filter(x => x.interval === '1m' && x.atrPct >= 0.0035));
  ev('C4 仅1m & atr>=0.40%', F.filter(x => x.interval === '1m' && x.atrPct >= 0.004));
  ev('C5 仅1m & atr>=0.45%', F.filter(x => x.interval === '1m' && x.atrPct >= 0.0045));
  ev('C6 仅1m & atr>=0.50%', F.filter(x => x.interval === '1m' && x.atrPct >= 0.005));
  ev('C7 仅1m & atr>=0.35% & rsi>=50', F.filter(x => x.interval === '1m' && x.atrPct >= 0.0035 && x.rsi >= 50));
  ev('C8 仅1m & atr>=0.40% & rsi>=50', F.filter(x => x.interval === '1m' && x.atrPct >= 0.004 && x.rsi >= 50));
  ev('C9 仅1m & atr>=0.40% & rsi>=55', F.filter(x => x.interval === '1m' && x.atrPct >= 0.004 && x.rsi >= 55));
  ev('C10 仅1m & atr>=0.35% & |ext|>=0.5', F.filter(x => x.interval === '1m' && x.atrPct >= 0.0035 && Math.abs(x.ext) >= 0.5));
  ev('C11 仅1m & atr>=0.40% & |ext|>=0.5', F.filter(x => x.interval === '1m' && x.atrPct >= 0.004 && Math.abs(x.ext) >= 0.5));
  ev('C12 仅1m & atr>=0.35% & 仅多', F.filter(x => x.interval === '1m' && x.atrPct >= 0.0035 && x.long));
  ev('C13 仅1m & atr>=0.35% & 仅空', F.filter(x => x.interval === '1m' && x.atrPct >= 0.0035 && !x.long));

  // 分半稳健性检验：按时间前后各半，看结论是否稳定
  console.log('\n=== 稳健性：时间前后各半 ===');
  const half = Math.floor(F.length / 2);
  const first = F.slice(0, half), second = F.slice(half);
  for (const [nm, sub] of [['前半段', first], ['后半段', second]]) {
    ev(`${nm} 全部`, sub);
    ev(`${nm} 仅1m & atr>=0.35%`, sub.filter(x => x.interval === '1m' && x.atrPct >= 0.0035));
    ev(`${nm} 仅1m & atr>=0.40%`, sub.filter(x => x.interval === '1m' && x.atrPct >= 0.004));
  }

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
