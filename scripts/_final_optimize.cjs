/**
 * 第 2 项最终方案验证：同币种冷却 × 止损宽度
 * 逻辑：快单常来自同一标的短时间内反复触发。加冷却可直接砍掉一批，
 *      且不依赖市况波动率（不会像绝对 ATR 阈值那样在清淡市况停摆）。
 * 时间切分：训练/测试两段同时改善才算数。只读数据库。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3;

const atr14 = bars => {
  if (bars.length < 15) return null;
  let s = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  return s / 14;
};
function settle(dir, entry, rawExit, margin, leverage, heldBars, barMs) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const notional = margin * leverage;
  const qty = notional / entry;
  const gross = dir * (exit - entry) * qty;
  const entryFee = notional * FEE_BPS / 10000;
  const exitFee = exit * qty * FEE_BPS / 10000;
  const funding = notional * FUNDING_BPS_8H / 10000 * (heldBars * barMs) / 28800000;
  let net = gross - entryFee - exitFee - funding;
  const maxLoss = -margin - entryFee;
  if (net < maxLoss) net = maxLoss;
  return { net };
}
function replay(stopR, bars, idx, atr, entry, dir, long, margin, leverage, barMs) {
  const ru = stopR * atr;
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + 3.0 * ru : entry - 3.0 * ru;
  for (let h = 0; h < 120 && idx + h < bars.length; h++) {
    const b = bars[idx + h];
    const hitStop = long ? b.low <= stop : b.high >= stop;
    const hitTp = long ? b.high >= tp : b.low <= tp;
    if (hitStop && hitTp) {
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { ...settle(dir, entry, sp, margin, leverage, h, barMs), reason: 'stop_loss', h };
    }
    if (hitStop) {
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { ...settle(dir, entry, sp, margin, leverage, h, barMs), reason: 'stop_loss', h };
    }
    if (hitTp) return { ...settle(dir, entry, tp, margin, leverage, h, barMs), reason: 'take_profit', h };
    const profR = (long ? b.close - entry : entry - b.close) / ru;
    if (profR >= 1.0) {
      const trail = long ? b.close - 1.5 * atr : b.close + 1.5 * atr;
      stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
    }
  }
  const last = bars[Math.min(idx + 120, bars.length) - 1];
  return { ...settle(dir, entry, last.close, margin, leverage, 120, barMs), reason: 'timeout', h: 120 };
}
function agg(rows) {
  const n = rows.length;
  if (!n) return { n: 0, sum: 0, avg: 0, t: 0, quickPct: 0 };
  const v = rows.map(r => r.retR);
  const sum = v.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, sum, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, quickPct: 100 * rows.filter(r => r.quick).length / n };
}

async function main() {
  const c = new Client(DB); await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, entry_at, leverage, margin
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL AND leverage > 0 AND margin > 0
    ORDER BY entry_at`)).rows;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.entry_at))) + 60 * 60000;
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
      const r = await c.query(`SELECT open_time, open, high, low, close FROM market_klines
        WHERE symbol=$1 AND interval=$2 AND open_time>=$3 AND open_time<=$4 ORDER BY open_time`, [key, interval, minT, maxT]);
      bars = r.rows.map(x => ({ openTime: Number(x.open_time), open: +x.open, high: +x.high, low: +x.low, close: +x.close }));
    }
    cache.set(k, bars); return bars;
  };
  const locate = (bars, t) => {
    if (!bars?.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const S = [];
  for (const o of orders) {
    const interval = o.interval || '1m';
    const bars = await getBars(o.symbol, interval);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const atr = atr14(before);
    if (!atr || atr <= 0) continue;
    const long = o.direction === 'OPEN_LONG';
    const barMs = interval === '5m' ? 300000 : 60000;
    const r15 = replay(1.5, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, barMs);
    const r20 = replay(2.0, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, barMs);
    S.push({
      t: Date.parse(o.entry_at), symbol: o.symbol, long,
      v15: { retR: r15.net / o.margin, quick: r15.reason === 'stop_loss' && r15.h < 5 },
      v20: { retR: r20.net / o.margin, quick: r20.reason === 'stop_loss' && r20.h < 5 },
    });
  }
  S.sort((a, b) => a.t - b.t);
  const mid = S[Math.floor(S.length / 2)].t;
  const TRAIN = S.filter(x => x.t < mid), TEST = S.filter(x => x.t >= mid);

  // 冷却：同 symbol 在 cdMs 内只保留第一笔
  const applyCooldown = (arr, cdMs) => {
    const last = new Map();
    return arr.filter(x => {
      const p = last.get(x.symbol);
      if (p !== undefined && x.t - p < cdMs) return false;
      last.set(x.symbol, x.t);
      return true;
    });
  };

  console.log(`样本 ${S.length} | 训练 ${TRAIN.length} | 测试 ${TEST.length}\n`);
  for (const [vname, key] of [['止损 2.0ATR(现状)', 'v20'], ['止损 1.5ATR', 'v15']]) {
    console.log('='.repeat(112));
    console.log(`【${vname}】`);
    console.log('='.repeat(112));
    console.log('同币种冷却'.padEnd(16) + '训练n 训练均单  训练t  测试n 测试均单  测试t   全n  全累计   全均单   全t   快损%  保留率');
    for (const cd of [0, 15, 30, 60, 120]) {
      const cdMs = cd * 60000;
      const tr = applyCooldown(TRAIN, cdMs), te = applyCooldown(TEST, cdMs), al = applyCooldown(S, cdMs);
      const a = agg(tr.map(x => x[key])), b = agg(te.map(x => x[key])), al2 = agg(al.map(x => x[key]));
      console.log(`${cd === 0 ? '无冷却' : cd + ' 分钟'}`.padEnd(16) +
        `${String(a.n).padStart(5)} ${a.avg.toFixed(4).padStart(8)} ${a.t.toFixed(2).padStart(6)} ` +
        `${String(b.n).padStart(5)} ${b.avg.toFixed(4).padStart(8)} ${b.t.toFixed(2).padStart(6)} ` +
        `${String(al2.n).padStart(5)} ${al2.sum.toFixed(1).padStart(8)} ${al2.avg.toFixed(4).padStart(8)} ${al2.t.toFixed(2).padStart(6)} ${al2.quickPct.toFixed(1).padStart(6)}% ${(100 * al2.n / S.length).toFixed(0).padStart(5)}%`);
    }
    console.log('');
  }
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
