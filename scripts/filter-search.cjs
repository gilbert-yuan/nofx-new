/**
 * 过滤器搜索：在真实已平仓订单上，按入场特征做贪心/网格搜索，找净盈亏最优的过滤组合。
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
const volRatio = bars => {
  if (bars.length < 20) return null;
  const rec = bars.slice(-5).reduce((a, b) => a + b.volume, 0) / 5;
  const base = bars.slice(-20, -5).reduce((a, b) => a + b.volume, 0) / 15;
  return base > 0 ? rec / base : null;
};

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, net, roi, held_bars, entry_at, exit_at, reason, leverage, margin, created_at
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL
    ORDER BY entry_at`)).rows;

  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 30 * 60000;
  const symbols = [...new Set(orders.map(o => o.symbol))];
  const keyMap = new Map();
  for (const s of symbols) {
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
      bars = r.rows.map(x => ({ openTime: Number(x.open_time), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }));
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
    if (!atr || !m || atr <= 0) continue;
    F.push({
      net: +o.net, long: o.direction === 'OPEN_LONG', interval,
      atrPct: atr / o.entry,
      ext: (before.at(-1).close - m) / atr,
      rsi: rsi14(before),
      vr: volRatio(before),
      hour: new Date(Date.parse(o.entry_at)).getUTCHours(),
      held: +o.held_bars,
      lev: +o.leverage
    });
  }
  console.log('样本:', F.length);

  const ev = sub => {
    if (!sub.length) return { n: 0, wr: 0, net: 0, avg: 0 };
    const wins = sub.filter(x => x.net > 0).length;
    const net = sub.reduce((a, x) => a + x.net, 0);
    return { n: sub.length, wr: 100 * wins / sub.length, net, avg: net / sub.length };
  };
  const show = (label, sub) => {
    const e = ev(sub);
    console.log(`${label.padEnd(46)} n=${String(e.n).padStart(4)} 胜率=${e.wr.toFixed(1).padStart(5)}% 净=${e.net.toFixed(0).padStart(7)} 均单=${e.avg.toFixed(3)}`);
    return e;
  };

  console.log('\n=== 单因子：ATR/价格 下限 ===');
  for (const t of [0, 0.0015, 0.002, 0.0025, 0.003, 0.0035, 0.004, 0.0045, 0.005, 0.006]) {
    show(`atrPct>=${(100 * t).toFixed(2)}%`, F.filter(x => x.atrPct >= t));
  }

  console.log('\n=== 单因子：|偏离MA20| 下限 ===');
  for (const t of [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5]) {
    show(`|ext|>=${t}`, F.filter(x => Math.abs(x.ext) >= t));
  }

  console.log('\n=== 单因子：RSI ===');
  for (const t of [0, 45, 50, 55, 60]) show(`rsi>=${t}`, F.filter(x => x.rsi >= t));
  for (const t of [70, 75, 80]) show(`rsi<=${t}`, F.filter(x => x.rsi <= t));

  console.log('\n=== 单因子：量比上限 ===');
  for (const t of [2.0, 1.8, 1.5, 1.2, 1.0]) show(`vr<=${t}`, F.filter(x => x.vr != null && x.vr <= t));

  console.log('\n=== 单因子：持仓时间（不可预知，仅参考） ===');
  for (const t of [5, 10, 15]) show(`held>=${t}`, F.filter(x => x.held >= t));

  console.log('\n=== 组合：atrPct下限 x |ext|下限 ===');
  for (const a of [0.0025, 0.003, 0.004, 0.005]) {
    for (const e of [0, 0.5, 1.0]) {
      show(`atr>=${(100 * a).toFixed(2)}% & |ext|>=${e}`, F.filter(x => x.atrPct >= a && Math.abs(x.ext) >= e));
    }
  }

  console.log('\n=== 组合：atrPct下限 x RSI下限 ===');
  for (const a of [0.0025, 0.004, 0.005]) {
    for (const r of [0, 50, 55]) {
      show(`atr>=${(100 * a).toFixed(2)}% & rsi>=${r}`, F.filter(x => x.atrPct >= a && x.rsi >= r));
    }
  }

  console.log('\n=== 组合：atrPct下限 x 方向 ===');
  for (const a of [0.0025, 0.004, 0.005]) {
    show(`atr>=${(100 * a).toFixed(2)}% & 多`, F.filter(x => x.atrPct >= a && x.long));
    show(`atr>=${(100 * a).toFixed(2)}% & 空`, F.filter(x => x.atrPct >= a && !x.long));
  }

  console.log('\n=== 组合：atrPct>=0.4% x |ext| x 方向 ===');
  for (const e of [0, 0.5, 1.0]) {
    for (const dir of [null, true, false]) {
      let sub = F.filter(x => x.atrPct >= 0.004 && Math.abs(x.ext) >= e);
      if (dir !== null) sub = sub.filter(x => x.long === dir);
      show(`atr>=0.40% & |ext|>=${e}${dir === null ? '' : (dir ? ' & 多' : ' & 空')}`, sub);
    }
  }

  console.log('\n=== 组合：atrPct>=0.4% x rsi x 方向 ===');
  for (const r of [0, 50, 55, 60]) {
    for (const dir of [null, true, false]) {
      let sub = F.filter(x => x.atrPct >= 0.004 && x.rsi >= r);
      if (dir !== null) sub = sub.filter(x => x.long === dir);
      show(`atr>=0.40% & rsi>=${r}${dir === null ? '' : (dir ? ' & 多' : ' & 空')}`, sub);
    }
  }

  console.log('\n=== 组合：atrPct>=0.4% x 方向 x |ext| 上限 ===');
  for (const e of [1.0, 1.5, 2.0]) {
    show(`atr>=0.40% & |ext|<=${e}`, F.filter(x => x.atrPct >= 0.004 && Math.abs(x.ext) <= e));
  }

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
