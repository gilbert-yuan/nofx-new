/**
 * 分位闸门探针（第 2/3 项的正确实现路径）
 *
 * 背景：绝对 ATR% 阈值会随市况漂移而失效（市况中位数 0.085% 时，0.40% 门槛 → 460 币仅 3.9% 通过 → 停摆）。
 * 因此验证「相对分位闸门」：要求波动率在**同批次候选**中排进前 X%。
 *
 * 本脚本：
 *  1. 查当前全市场 1m 波动率分布（判断市况）
 *  2. 对历史成交样本，按「同小时批次」计算 atrPct 分位，验证分位规则是否稳健（训练/测试两段同号）
 * 只读数据库。
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
function replay(cfg, bars, idx, atr, entry, dir, long, margin, leverage, barMs) {
  const ru = cfg.stopR * atr;
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + cfg.tpR * ru : entry - cfg.tpR * ru;
  for (let h = 0; h < cfg.maxHoldBars && idx + h < bars.length; h++) {
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
    if (profR >= cfg.trailTriggerR) {
      const trail = long ? b.close - cfg.trailAtr * atr : b.close + cfg.trailAtr * atr;
      stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
    }
  }
  const last = bars[Math.min(idx + cfg.maxHoldBars, bars.length) - 1];
  return { ...settle(dir, entry, last.close, margin, leverage, cfg.maxHoldBars, barMs), reason: 'timeout', h: cfg.maxHoldBars };
}
const pct = (arr, q) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
function agg(rows) {
  const n = rows.length;
  if (!n) return { n: 0, avg: 0, t: 0, quickPct: 0, wr: 0 };
  const v = rows.map(r => r.retR);
  const avg = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, quickPct: 100 * rows.filter(r => r.quick).length / n, wr: 100 * v.filter(x => x > 0).length / n };
}

async function main() {
  const c = new Client(DB); await c.connect();

  // ---------- 1. 当前市况波动率分布 ----------
  const now = Date.now();
  const syms = (await c.query(`SELECT DISTINCT symbol FROM market_klines WHERE symbol LIKE 'OKX_PUBLIC_%' AND interval='1m'`)).rows.map(r => r.symbol);
  const vals = [];
  for (const s of syms.slice(0, 200)) {
    const r = await c.query(`SELECT high, low, close FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time>=$2 ORDER BY open_time DESC LIMIT 40`, [s, now - 90 * 60000]);
    const bars = r.rows.reverse().map(x => ({ high: +x.high, low: +x.low, close: +x.close }));
    if (bars.length < 20) continue;
    const atr = atr14(bars);
    if (atr && atr > 0 && bars.at(-1).close > 0) vals.push(atr / bars.at(-1).close * 100);
  }
  vals.sort((a, b) => a - b);
  console.log('='.repeat(100));
  console.log(`当前全市场 1m 波动率分布（n=${vals.length} 个币，最近 90 分钟）`);
  console.log('='.repeat(100));
  for (const q of [0.1, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    console.log(`  p${(q * 100).toFixed(0).padStart(2)}: ${pct(vals, q).toFixed(4)}%`);
  }
  for (const th of [0.20, 0.30, 0.40, 0.50, 0.60]) {
    const pass = vals.filter(v => v >= th).length;
    console.log(`  绝对阈值 ${th.toFixed(2)}%：通过 ${pass}/${vals.length} = ${(100 * pass / vals.length).toFixed(1)}%`);
  }

  // ---------- 2. 历史样本的分位规则验证 ----------
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
      const r = await c.query(`SELECT open_time, open, high, low, close, volume FROM market_klines
        WHERE symbol=$1 AND interval=$2 AND open_time>=$3 AND open_time<=$4 ORDER BY open_time`, [key, interval, minT, maxT]);
      bars = r.rows.map(x => ({ openTime: Number(x.open_time), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }));
    }
    cache.set(k, bars); return bars;
  };
  const locate = (bars, t) => {
    if (!bars?.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const CFG = { stopR: 2.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 1.5, maxHoldBars: 120 };
  const S = [];
  for (const o of orders) {
    const interval = o.interval || '1m';
    const bars = await getBars(o.symbol, interval);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const atr = atr14(before);
    if (!atr || atr <= 0) continue;
    const px = before.at(-1).close;
    const long = o.direction === 'OPEN_LONG';
    const r = replay(CFG, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, interval === '5m' ? 300000 : 60000);
    S.push({
      t: Date.parse(o.entry_at), long, retR: r.net / o.margin,
      quick: r.reason === 'stop_loss' && r.h < 5,
      atrPct: atr / px * 100,
      mom5: before.length > 5 ? (px / before[before.length - 6].close - 1) * 100 : null,
      hourBucket: Math.floor(Date.parse(o.entry_at) / 3600000),
    });
  }
  // 同小时批次内计算分位（模拟扫描时的同批候选）
  const byBucket = new Map();
  for (const x of S) { if (!byBucket.has(x.hourBucket)) byBucket.set(x.hourBucket, []); byBucket.get(x.hourBucket).push(x); }
  for (const [bk, arr] of byBucket) {
    const vs = arr.map(x => x.atrPct).sort((a, b) => a - b);
    for (const x of arr) {
      let rank = 0; while (rank < vs.length && vs[rank] < x.atrPct) rank++;
      x.atrQ = vs.length > 1 ? rank / (vs.length - 1) : 1;
    }
  }
  S.sort((a, b) => a.t - b.t);
  const mid = S[Math.floor(S.length / 2)].t;
  const TRAIN = S.filter(x => x.t < mid), TEST = S.filter(x => x.t >= mid);

  console.log('\n' + '='.repeat(100));
  console.log('分位闸门验证（atrQ = 波动率在同小时批次内的百分位，1.0 = 该批最高）');
  console.log('='.repeat(100));
  console.log('规则'.padEnd(34) + '训练n 训练均单  训练t  测试n 测试均单  测试t  全n  全均单  全t  快损%  判定');
  const RULES = [
    ['Q0 基线', () => true],
    ['Q1 atrQ>=0.50', s => s.atrQ >= 0.50],
    ['Q2 atrQ>=0.60', s => s.atrQ >= 0.60],
    ['Q3 atrQ>=0.70', s => s.atrQ >= 0.70],
    ['Q4 atrQ>=0.80', s => s.atrQ >= 0.80],
    ['Q5 atrQ>=0.60 & mom5>=0.3', s => s.atrQ >= 0.60 && s.mom5 >= 0.3],
    ['Q6 atrQ>=0.70 & mom5>=0.3', s => s.atrQ >= 0.70 && s.mom5 >= 0.3],
    ['Q7 atrQ>=0.80 & mom5>=0.3', s => s.atrQ >= 0.80 && s.mom5 >= 0.3],
    ['Q8 仅多 & atrQ>=0.60', s => s.long && s.atrQ >= 0.60],
    ['Q9 仅多 & atrQ>=0.70', s => s.long && s.atrQ >= 0.70],
    ['Q10 仅多 & atrQ>=0.60&mom5>=0.3', s => s.long && s.atrQ >= 0.60 && s.mom5 >= 0.3],
    ['Q11 仅多 & atrQ>=0.70&mom5>=0.3', s => s.long && s.atrQ >= 0.70 && s.mom5 >= 0.3],
  ];
  for (const [name, fn] of RULES) {
    const tr = agg(TRAIN.filter(fn)), te = agg(TEST.filter(fn)), al = agg(S.filter(fn));
    if (tr.n < 20 || te.n < 20) { console.log(name.padEnd(34) + `样本不足 (训练${tr.n}/测试${te.n})`); continue; }
    const pass = tr.avg > 0 && te.avg > 0;
    console.log(name.padEnd(34) +
      `${String(tr.n).padStart(5)} ${tr.avg.toFixed(4).padStart(8)} ${tr.t.toFixed(2).padStart(6)} ` +
      `${String(te.n).padStart(5)} ${te.avg.toFixed(4).padStart(8)} ${te.t.toFixed(2).padStart(6)} ` +
      `${String(al.n).padStart(5)} ${al.avg.toFixed(4).padStart(8)} ${al.t.toFixed(2).padStart(6)} ${al.quickPct.toFixed(1).padStart(6)}  ` +
      (pass ? '✔ 两段皆正' : (tr.avg > 0 || te.avg > 0 ? '△ 仅一段' : '✘')));
  }
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
