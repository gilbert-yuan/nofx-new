/**
 * 长周期回测 V2：加入市场中性化 + 更多周期（只读数据库）
 *
 * V1 发现 4h 上「随机入场」显著盈利（t=6.71），怀疑是市场 beta（8/4-9/10 加密普涨）。
 * 本版对每笔交易扣除同期等权市场收益，得到超额收益：
 *   超额 = 交易毛收益 - 同期市场累计收益
 * 若趋势组的超额 ≈ 0 或 < 0，则说明入场逻辑没有 alpha，盈利全靠 beta。
 *
 * 另补充 1h / 1d 周期（自动探测可用周期）。
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const COST = 0.22 / 100;
const OUT = path.join(__dirname, '..', '.workbuddy', 'runs', '20260911-crypto-viability', '08_interval_backtest');

function atrWilder(bars, n, upto) {
  let s = 0, cnt = 0;
  for (let i = Math.max(1, upto - n + 1); i <= upto; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
    cnt++;
  }
  return cnt ? s / cnt : null;
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
      if (want !== null) {
        locked = Math.max(locked, lock);
        const cand = entry + dir * Math.max(want, locked) * risk;
        if (dir > 0) stop = Math.max(stop, cand); else stop = Math.min(stop, cand);
      }
    }
    if (held >= cfg.maxHold) {
      if (k + 1 < bars.length) return { exit: bars[k + 1].open, end: k + 1, reason: 'maxhold' };
      return { exit: b.close, end: k, reason: 'maxhold' };
    }
  }
  return { exit: bars.at(-1).close, end: bars.length - 1, reason: 'eod' };
}
const CFGS = [
  { id: 'B_stop2_tp3_trail', stopAtr: 2.0, tpR: 3.0, trail: true, maxHold: 30 },
  { id: 'D_stop3_tp3_trail', stopAtr: 3.0, tpR: 3.0, trail: true, maxHold: 30 },
  { id: 'F_stop1.5_tp4_trail', stopAtr: 1.5, tpR: 4.0, trail: true, maxHold: 30 },
];
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const stats = a => {
  const n = a.length; if (!n) return { mean: 0, t: 0, win: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1 || 1));
  return { mean, t: sd ? mean / (sd / Math.sqrt(n)) : 0, win: a.filter(x => x > 0).length / n };
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client(DB); await c.connect();
  const ivs = (await c.query(`SELECT interval, count(*) n, count(DISTINCT symbol) s, min(open_time) a, max(open_time) b FROM market_klines GROUP BY interval ORDER BY n DESC`)).rows;
  console.log('库中可用周期：');
  for (const r of ivs) console.log(`  ${String(r.interval).padEnd(5)} rows=${String(r.n).padStart(8)} 币种=${String(r.s).padStart(5)}  ${new Date(+r.a).toISOString().slice(0, 16)} ~ ${new Date(+r.b).toISOString().slice(0, 16)}`);

  const plan = [
    { iv: '15m', minBars: 200, cap: 260 },
    { iv: '1h', minBars: 100, cap: 300 },
    { iv: '4h', minBars: 150, cap: 300 },
    { iv: '1d', minBars: 60, cap: 300 },
  ];
  const outRows = [['interval', 'mode', 'cfg', 'n', 'mean_ret_pct', 't', 'win_pct', 'excess_pct', 'excess_t', 'mkt_pct']];

  for (const { iv, minBars, cap } of plan) {
    const have = ivs.find(x => x.interval === iv);
    if (!have) { console.log(`\n${iv}: 库中无此周期，跳过`); continue; }
    const symRows = (await c.query(
      `SELECT symbol, count(*)::int AS n FROM market_klines WHERE interval=$1 GROUP BY symbol HAVING count(*)>=${minBars} ORDER BY count(*) DESC LIMIT $2`, [iv, cap])).rows;
    if (!symRows.length) { console.log(`\n${iv}: 满足 >=${minBars} 根的币种为 0，跳过`); continue; }
    const symbols = symRows.map(r => r.symbol);
    const { rows } = await c.query(
      `SELECT symbol, open_time, open, high, low, close FROM market_klines WHERE interval=$1 AND symbol=ANY($2::text[]) ORDER BY symbol, open_time ASC`, [iv, symbols]);
    const bySym = new Map();
    for (const r of rows) {
      if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
      bySym.get(r.symbol).push({ t: +r.open_time, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    }
    // ---- 等权市场指数（按 open_time 对齐）----
    const mktMap = new Map();
    for (const [sym, bars] of bySym) {
      for (let i = 1; i < bars.length; i++) {
        const r = bars[i].close / bars[i - 1].close - 1;
        if (!mktMap.has(bars[i].t)) mktMap.set(bars[i].t, []);
        mktMap.get(bars[i].t).push(r);
      }
    }
    const mktRet = new Map();
    for (const [t, arr] of mktMap) mktRet.set(t, arr.reduce((a, b) => a + b, 0) / arr.length);
    const times = [...mktRet.keys()].sort((a, b) => a - b);
    const idxOf = new Map(times.map((t, i) => [t, i]));
    // 前缀累计（对数）
    const prefix = new Float64Array(times.length + 1);
    for (let i = 0; i < times.length; i++) prefix[i + 1] = prefix[i] + Math.log(1 + mktRet.get(times[i]));
    const mktCum = (t0, t1) => {
      const a = idxOf.get(t0), b = idxOf.get(t1);
      if (a == null || b == null) return null;
      return Math.exp(prefix[Math.max(a, b) + 1] - prefix[Math.min(a, b) + 1]) - 1;
    };
    const totalMkt = Math.exp(prefix[times.length] - prefix[1]) - 1;
    console.log(`\n=== ${iv} === 样本币 ${symbols.length}（>=${minBars}根）| 区间 ${new Date(times[0]).toISOString().slice(0, 10)} ~ ${new Date(times.at(-1)).toISOString().slice(0, 10)} | 等权市场累计 ${(totalMkt * 100).toFixed(2)}%`);

    // ---- 信号 ----
    const signals = new Map();
    for (const [sym, bars] of bySym) {
      const list = [];
      for (let i = 62; i < bars.length - 1; i++) {
        const ma20 = sma(bars, 20, i), ma60 = sma(bars, 60, i), rsi = rsiWilder(bars, 14, i), atr = atrWilder(bars, 14, i);
        if (ma20 == null || ma60 == null || rsi == null || !atr) continue;
        const px = bars[i].close;
        if (atr / px < 0.0005) continue;
        const mom5 = (px - bars[i - 5].close) / bars[i - 5].close * 100;
        if (ma20 > ma60 && px > ma20 && rsi >= 50 && mom5 >= 0) list.push({ i, atr });
      }
      const keep = []; for (const s of list) if (!keep.length || s.i - keep.at(-1).i >= 10) keep.push(s);
      signals.set(sym, keep);
    }
    const rnd = mulberry32(20260911);
    const rndS = new Map();
    for (const [sym, bars] of bySym) {
      const k = (signals.get(sym) || []).length; const list = [];
      for (let j = 0; j < k; j++) { const i = 62 + Math.floor(rnd() * (bars.length - 63)); const atr = atrWilder(bars, 14, i); if (atr) list.push({ i, atr }); }
      rndS.set(sym, list);
    }

    for (const mode of ['trend', 'random']) {
      const sigMap = mode === 'trend' ? signals : rndS;
      for (const cfg of CFGS) {
        const rec = [];
        for (const [sym, bars] of bySym) for (const s of (sigMap.get(sym) || [])) {
          const i1 = s.i + 1; if (i1 >= bars.length) continue;
          const entry = bars[i1].open; if (!(entry > 0)) continue;
          const res = simulateExit(bars, i1, entry, 1, s.atr, cfg);
          const gross = (res.exit - entry) / entry;
          const mc = mktCum(bars[i1].t, bars[Math.min(res.end, bars.length - 1)].t);
          rec.push({ ret: gross - COST, gross, exc: mc == null ? null : gross - mc, mkt: mc });
        }
        const S = stats(rec.map(x => x.ret));
        const E = stats(rec.filter(x => x.exc != null).map(x => x.exc));
        const mk = rec.filter(x => x.mkt != null).map(x => x.mkt);
        const mktAvg = mk.length ? mk.reduce((a, b) => a + b, 0) / mk.length : 0;
        console.log(`  ${mode.padEnd(6)} ${cfg.id.padEnd(22)} n=${String(rec.length).padStart(5)}  净收益${(S.mean * 100).toFixed(3).padStart(8)}% t=${S.t.toFixed(2).padStart(6)}  超额${(E.mean * 100).toFixed(3).padStart(8)}% t=${E.t.toFixed(2).padStart(6)}  同期市场${(mktAvg * 100).toFixed(2).padStart(7)}%`);
        outRows.push([iv, mode, cfg.id, rec.length, S.mean, S.t, S.win, E.mean, E.t, mktAvg]);
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'interval_excess.csv'), outRows.map(r => r.join(',')).join('\n'), 'utf8');
  console.log('\n产出：' + path.join(OUT, 'interval_excess.csv'));
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
