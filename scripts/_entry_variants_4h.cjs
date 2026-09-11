/**
 * 入场逻辑定向探测（4h，只读数据库）
 *
 * V2 已证明现有趋势入场在 15m/1h/4h 上超额收益≈0或为负，且跑输随机入场。
 * 本脚本预注册 5 种「不同性质」的入场逻辑（不是同一逻辑调参），
 * 在 4h（唯一有 30 天跨度的周期）上做时间切分 train/test，全部上报。
 *
 * 铁律：不挑最优。全部结果列出，交过拟合审计。
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const COST = 0.22 / 100;
const OUT = path.join(__dirname, '..', '.workbuddy', 'runs', '20260911-crypto-viability', '08_interval_backtest');

function atrWilder(bars, n, upto) {
  let s = 0, c = 0;
  for (let i = Math.max(1, upto - n + 1); i <= upto; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)); c++;
  }
  return c ? s / c : null;
}
const sma = (b, n, u) => (u + 1 < n ? null : (() => { let s = 0; for (let i = u - n + 1; i <= u; i++) s += b[i].close; return s / n; })());
function rsiWilder(bars, n, upto) {
  if (upto < n) return null;
  let g = 0, l = 0;
  for (let i = upto - n + 1; i <= upto; i++) { const d = bars[i].close - bars[i - 1].close; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n; return g + l === 0 ? 50 : 100 * g / (g + l);
}
function simulateExit(bars, i0, entry, dir, atr, cfg) {
  const risk = cfg.stopAtr * atr;
  let stop = entry - dir * risk, tp = entry + dir * cfg.tpR * risk, locked = 0;
  for (let k = i0; k < bars.length; k++) {
    const b = bars[k], held = k - i0;
    if (dir > 0) {
      if (b.low <= stop) return { exit: stop, end: k, reason: locked > 0 ? 'trail' : 'stop' };
      if (b.high >= tp) return { exit: tp, end: k, reason: 'tp' };
    } else {
      if (b.high >= stop) return { exit: stop, end: k, reason: locked > 0 ? 'trail' : 'stop' };
      if (b.low <= tp) return { exit: tp, end: k, reason: 'tp' };
    }
    if (cfg.trail) {
      const rNow = dir * (b.close - entry) / risk;
      let want = null, lock = null;
      if (rNow >= 2) { want = rNow - 0.40; lock = 0.80; }
      else if (rNow >= 1) { want = rNow - 0.50; lock = 0.30; }
      else if (rNow >= 0) { want = rNow - 0.70; lock = 0; }
      if (want !== null) { locked = Math.max(locked, lock); const cand = entry + dir * Math.max(want, locked) * risk; if (dir > 0) stop = Math.max(stop, cand); else stop = Math.min(stop, cand); }
    }
    if (held >= cfg.maxHold) { if (k + 1 < bars.length) return { exit: bars[k + 1].open, end: k + 1, reason: 'maxhold' }; return { exit: b.close, end: k, reason: 'maxhold' }; }
  }
  return { exit: bars.at(-1).close, end: bars.length - 1, reason: 'eod' };
}
const stats = a => {
  const n = a.length; if (!n) return { mean: 0, t: 0, win: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1 || 1));
  return { mean, t: sd ? mean / (sd / Math.sqrt(n)) : 0, win: a.filter(x => x > 0).length / n };
};

// ---- 预注册 5 种入场逻辑（性质不同）----
const ENTRIES = {
  E1_trend: (bars, i, ind) => ind.ma20 > ind.ma60 && ind.px > ind.ma20 && ind.rsi >= 50 && ind.mom5 >= 0,
  E2_pullback: (bars, i, ind) => ind.ma20 > ind.ma60 && ind.px < ind.ma20 && ind.px > ind.ma60 && ind.rsi < 45,
  E3_breakout: (bars, i, ind) => ind.px > ind.hh20 && ind.mom5 > 0,
  E4_oversold_bounce: (bars, i, ind) => ind.rsi < 30 && ind.mom5 < -2,
  E5_vol_expand: (bars, i, ind) => ind.atrPct > 0.015 && ind.mom5 > 0 && ind.px > ind.ma20,
};
const CFGS = [
  { id: 'stop2_tp3_trail', stopAtr: 2.0, tpR: 3.0, trail: true, maxHold: 30 },
  { id: 'stop3_tp3_trail', stopAtr: 3.0, tpR: 3.0, trail: true, maxHold: 30 },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client(DB); await c.connect();
  const symRows = (await c.query(
    `SELECT symbol, count(*)::int AS n FROM market_klines WHERE interval='4h' GROUP BY symbol HAVING count(*)>=150 ORDER BY count(*) DESC LIMIT 300`)).rows;
  const symbols = symRows.map(r => r.symbol);
  const { rows } = await c.query(
    `SELECT symbol, open_time, open, high, low, close FROM market_klines WHERE interval='4h' AND symbol=ANY($1::text[]) ORDER BY symbol, open_time ASC`, [symbols]);
  const bySym = new Map();
  for (const r of rows) {
    if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
    bySym.get(r.symbol).push({ t: +r.open_time, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
  }
  const mktMap = new Map();
  for (const [, bars] of bySym) for (let i = 1; i < bars.length; i++) {
    const r = bars[i].close / bars[i - 1].close - 1;
    if (!mktMap.has(bars[i].t)) mktMap.set(bars[i].t, []); mktMap.get(bars[i].t).push(r);
  }
  const times = [...mktMap.keys()].sort((a, b) => a - b);
  const idxOf = new Map(times.map((t, i) => [t, i]));
  const prefix = new Float64Array(times.length + 1);
  for (let i = 0; i < times.length; i++) { const a = mktMap.get(times[i]); prefix[i + 1] = prefix[i] + Math.log(1 + a.reduce((x, y) => x + y, 0) / a.length); }
  const mktCum = (t0, t1) => { const a = idxOf.get(t0), b = idxOf.get(t1); if (a == null || b == null) return null; return Math.exp(prefix[Math.max(a, b) + 1] - prefix[Math.min(a, b) + 1]) - 1; };

  console.log(`4h 样本币 ${symbols.length}  区间 ${new Date(times[0]).toISOString().slice(0, 10)} ~ ${new Date(times.at(-1)).toISOString().slice(0, 10)}`);
  console.log('\n入场逻辑                出场配置              n    净值%     t     胜率   超额%     t    | 前半均值%  t    后半均值%  t');
  console.log('-'.repeat(132));

  const outRows = [['entry', 'cfg', 'n', 'mean_pct', 't', 'win', 'excess_pct', 'excess_t', 'train_mean', 'train_t', 'test_mean', 'test_t']];
  for (const [ename, fn] of Object.entries(ENTRIES)) {
    for (const cfg of CFGS) {
      const rec = [];
      for (const [sym, bars] of bySym) {
        for (let i = 62; i < bars.length - 1; i++) {
          const atr = atrWilder(bars, 14, i), ma20 = sma(bars, 20, i), ma60 = sma(bars, 60, i), rsi = rsiWilder(bars, 14, i);
          if (!atr || ma20 == null || ma60 == null || rsi == null) continue;
          const px = bars[i].close, atrPct = atr / px;
          // 前 20 根最高价（不含当根，否则 close>max(high) 恒不成立）
          let hh20 = -Infinity; for (let j = i - 20; j <= i - 1; j++) if (j >= 0) hh20 = Math.max(hh20, bars[j].high);
          const mom5 = (px - bars[i - 5].close) / bars[i - 5].close * 100;
          const ind = { atr, atrPct, ma20, ma60, rsi, px, hh20, mom5 };
          if (atrPct < 0.0005) continue;
          if (!fn(bars, i, ind)) continue;
          if (rec.length && rec.at(-1).sym === sym && i - rec.at(-1).i < 10) continue; // 同币 10 根内不重复
          const i1 = i + 1, entry = bars[i1].open;
          if (!(entry > 0)) continue;
          const res = simulateExit(bars, i1, entry, 1, atr, cfg);
          const gross = (res.exit - entry) / entry;
          const mc = mktCum(bars[i1].t, bars[Math.min(res.end, bars.length - 1)].t);
          rec.push({ sym, i, t: bars[i1].t, ret: gross - COST, exc: mc == null ? null : gross - mc });
        }
      }
      const S = stats(rec.map(x => x.ret));
      const E = stats(rec.filter(x => x.exc != null).map(x => x.exc));
      const s = [...rec].sort((a, b) => a.t - b.t), mid = Math.floor(s.length / 2);
      const A = stats(s.slice(0, mid).map(x => x.ret)), B = stats(s.slice(mid).map(x => x.ret));
      console.log(
        ename.padEnd(22) + cfg.id.padEnd(20) + String(rec.length).padStart(5) +
        (S.mean * 100).toFixed(3).padStart(9) + S.t.toFixed(2).padStart(7) + (S.win * 100).toFixed(1).padStart(7) + '%' +
        (E.mean * 100).toFixed(3).padStart(9) + E.t.toFixed(2).padStart(7) +
        '  |' + (A.mean * 100).toFixed(3).padStart(9) + A.t.toFixed(2).padStart(7) +
        (B.mean * 100).toFixed(3).padStart(9) + B.t.toFixed(2).padStart(7));
      outRows.push([ename, cfg.id, rec.length, S.mean, S.t, S.win, E.mean, E.t, A.mean, A.t, B.mean, B.t]);
      fs.writeFileSync(path.join(OUT, `trades_4h_${ename}_${cfg.id}.csv`),
        't,ret,exc\n' + rec.map(x => `${x.t},${x.ret},${x.exc == null ? '' : x.exc}`).join('\n'), 'utf8');
    }
  }
  fs.writeFileSync(path.join(OUT, 'entry_variants_4h.csv'), outRows.map(r => r.join(',')).join('\n'), 'utf8');
  console.log('\n注：净值% 已扣往返成本 0.22%；超额% = 毛收益 − 同期等权市场收益（未扣成本）。');
  console.log('前半/后半按入场时间中位数切分。两段同号且 |t|>2 才有资格谈「可能存在 alpha」。');
  console.log('产出：' + path.join(OUT, 'entry_variants_4h.csv'));
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
