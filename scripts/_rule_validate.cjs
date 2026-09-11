/**
 * 候选规则验证（第 2 项快单 / 第 3 项 alpha）
 * 对每个候选入场过滤，输出 训练/测试/全样本 的 n、累计、均单、胜率、t 统计量。
 * **只在训练/测试两段同时改善的规则才算通过**（历史教训：多因子组合训练 +0.46 → 测试 -0.29 过拟合）。
 * 系统已禁空，因此额外给出 long-only 口径。只读数据库。
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
const ma = (bars, n) => bars.length < n ? null : bars.slice(-n).reduce((a, b) => a + b.close, 0) / n;
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

function agg(rows) {
  const n = rows.length;
  if (!n) return { n: 0, sum: 0, avg: 0, wr: 0, t: 0, quickPct: 0 };
  const v = rows.map(r => r.retR);
  const sum = v.reduce((a, b) => a + b, 0), avg = sum / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, sum, avg, wr: 100 * v.filter(x => x > 0).length / n, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0,
    quickPct: 100 * rows.filter(r => r.quick).length / n };
}

const RULES = [
  ['R0 基线(无过滤)', () => true],
  ['R1 atrPct>=0.40', s => s.atrPct >= 0.40],
  ['R2 atrPct>=0.50', s => s.atrPct >= 0.50],
  ['R3 atrPct>=0.60', s => s.atrPct >= 0.60],
  ['R4 atrPct 0.60~1.00', s => s.atrPct >= 0.60 && s.atrPct < 1.00],
  ['R5 atrPct>=0.60 & mom5>=0.3', s => s.atrPct >= 0.60 && s.mom5 >= 0.3],
  ['R6 atrPct>=0.60 & mom5 0.3~3.0', s => s.atrPct >= 0.60 && s.mom5 >= 0.3 && s.mom5 < 3.0],
  ['R7 atrPct>=0.60 & volRatio<1.0', s => s.atrPct >= 0.60 && s.volRatio < 1.0],
  ['R8 atrPct>=0.50 & mom5>=0.3', s => s.atrPct >= 0.50 && s.mom5 >= 0.3],
  ['R9 atrPct>=0.60 & rsi 35~70', s => s.atrPct >= 0.60 && s.rsi >= 35 && s.rsi < 70],
  ['R10 atrPct>=0.60 & ext>=-1.5', s => s.atrPct >= 0.60 && s.ext >= -1.5],
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
    const v5 = before.slice(-5).reduce((a, b) => a + b.volume, 0) / 5;
    const v20 = before.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
    const r = replay(CFG, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, interval === '5m' ? 300000 : 60000);
    S.push({
      t: Date.parse(o.entry_at), long,
      retR: r.net / o.margin, quick: r.reason === 'stop_loss' && r.h < 5,
      atrPct: atr / px * 100,
      mom5: before.length > 5 ? (px / before[before.length - 6].close - 1) * 100 : null,
      rsi: rsi14(before),
      volRatio: v20 > 0 ? v5 / v20 : null,
      ext: (px - ma(before, 20)) / atr,
    });
  }
  S.sort((a, b) => a.t - b.t);
  const mid = S[Math.floor(S.length / 2)].t;
  const TRAIN = S.filter(x => x.t < mid), TEST = S.filter(x => x.t >= mid);
  console.log(`样本 ${S.length} | 训练 ${TRAIN.length} | 测试 ${TEST.length}\n`);

  for (const [scope, pick] of [['全部', s => s], ['仅多单(禁空口径)', s => s.long]]) {
    const trAll = TRAIN.filter(pick), teAll = TEST.filter(pick), alAll = S.filter(pick);
    console.log('='.repeat(120));
    console.log(`【${scope}】`);
    console.log('='.repeat(120));
    console.log('规则'.padEnd(32) + '训练n  训练均单   训练t   测试n  测试均单   测试t   全样本n  全样本均单  全样本t  快损%  判定');
    for (const [name, fn] of RULES) {
      const tr = agg(trAll.filter(fn)), te = agg(teAll.filter(fn)), al = agg(alAll.filter(fn));
      if (tr.n < 20 || te.n < 20) { console.log(name.padEnd(32) + `样本不足 (训练${tr.n}/测试${te.n})`); continue; }
      const pass = tr.avg > 0 && te.avg > 0;
      console.log(name.padEnd(32) +
        `${String(tr.n).padStart(5)}  ${tr.avg.toFixed(4).padStart(8)}  ${tr.t.toFixed(2).padStart(6)}  ` +
        `${String(te.n).padStart(5)}  ${te.avg.toFixed(4).padStart(8)}  ${te.t.toFixed(2).padStart(6)}  ` +
        `${String(al.n).padStart(7)}  ${al.avg.toFixed(4).padStart(10)}  ${al.t.toFixed(2).padStart(6)}  ${al.quickPct.toFixed(1).padStart(5)}  ` +
        (pass ? '  ✔ 两段皆正' : (tr.avg > 0 || te.avg > 0 ? '  △ 仅一段正' : '  ✘')));
    }
    console.log('');
  }
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
