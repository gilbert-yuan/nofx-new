/**
 * 第 2 项核心实验：快损(<5根止损)到底是「噪声打掉」还是「真反向」？
 *
 * 判别方法：改变入场后前 N 根的止损宽度，看结果往哪走。
 *   · 放宽初期止损能改善  → 快损是噪声打掉，该给喘息空间
 *   · 收紧初期止损能改善  → 快损是真反向，该早点砍
 *   · 两者都变差          → 出场端无解，问题确在入场（需换 alpha）
 * 时间切分：训练/测试两段同时改善才算数。只读数据库。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3;
const EARLY_BARS = 5;

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
// earlyR: 前 EARLY_BARS 根使用的止损 ATR 倍数（null = 与常规相同）
function replay(cfg, bars, idx, atr, entry, dir, long, margin, leverage, barMs) {
  const ru = cfg.stopR * atr;
  const earlyRu = (cfg.earlyR ?? cfg.stopR) * atr;
  const tp = long ? entry + cfg.tpR * ru : entry - cfg.tpR * ru;
  let stop = long ? entry - (cfg.earlyR ? earlyRu : ru) : entry + (cfg.earlyR ? earlyRu : ru);
  for (let h = 0; h < cfg.maxHoldBars && idx + h < bars.length; h++) {
    const b = bars[idx + h];
    if (cfg.earlyR && h === EARLY_BARS) {
      const wide = long ? entry - ru : entry + ru;
      stop = long ? Math.min(stop, wide) : Math.max(stop, wide);
    }
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
    if (profR >= cfg.trailTriggerR) {
      const trail = long ? b.close - cfg.trailAtr * atr : b.close + cfg.trailAtr * atr;
      stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
    }
  }
  const last = bars[Math.min(idx + cfg.maxHoldBars, bars.length) - 1];
  return { ...settle(dir, entry, last.close, margin, leverage, cfg.maxHoldBars, barMs), reason: 'timeout', h: cfg.maxHoldBars };
}
function agg(rows) {
  const n = rows.length;
  if (!n) return { n: 0, avg: 0, t: 0, quickPct: 0 };
  const v = rows.map(r => r.retR);
  const avg = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, quickPct: 100 * rows.filter(r => r.quick).length / n };
}

const VARIANTS = [
  ['A 基线 2ATR 全程', { stopR: 2.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
  ['B 前5根放宽 3ATR', { stopR: 2.0, earlyR: 3.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
  ['C 前5根放宽 4ATR', { stopR: 2.0, earlyR: 4.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
  ['D 前5根收紧 1.5ATR', { stopR: 2.0, earlyR: 1.5, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
  ['E 前5根收紧 1.0ATR', { stopR: 2.0, earlyR: 1.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
  ['F 全程 3ATR', { stopR: 3.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
  ['G 全程 1.5ATR', { stopR: 1.5, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 }],
];

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
    const rec = { t: Date.parse(o.entry_at), long };
    for (const [nm, cfg] of VARIANTS) {
      const r = replay(cfg, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, barMs);
      rec[nm[0]] = { retR: r.net / o.margin, quick: r.reason === 'stop_loss' && r.h < EARLY_BARS, h: r.h };
    }
    S.push(rec);
  }
  S.sort((a, b) => a.t - b.t);
  const mid = S[Math.floor(S.length / 2)].t;
  const TRAIN = S.filter(x => x.t < mid), TEST = S.filter(x => x.t >= mid);
  console.log(`样本 ${S.length} | 训练 ${TRAIN.length} | 测试 ${TEST.length}\n`);
  console.log('方案'.padEnd(24) + '训练均单   训练t   测试均单   测试t   全样本均单  全t    5根内止损%  判定');
  for (const [nm] of VARIANTS) {
    const k = nm[0];
    const tr = agg(TRAIN.map(x => ({ retR: x[k].retR, quick: x[k].quick })));
    const te = agg(TEST.map(x => ({ retR: x[k].retR, quick: x[k].quick })));
    const al = agg(S.map(x => ({ retR: x[k].retR, quick: x[k].quick })));
    console.log(nm.padEnd(24) +
      `${tr.avg.toFixed(4).padStart(8)} ${tr.t.toFixed(2).padStart(6)}  ${te.avg.toFixed(4).padStart(8)} ${te.t.toFixed(2).padStart(6)}  ` +
      `${al.avg.toFixed(4).padStart(10)} ${al.t.toFixed(2).padStart(6)}  ${al.quickPct.toFixed(1).padStart(9)}%  ` +
      (tr.avg > 0 && te.avg > 0 ? '✔' : ''));
  }
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
