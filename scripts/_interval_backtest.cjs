/**
 * 长周期可行性回测（只读数据库，不写任何表）
 *
 * 目的：验证「把主周期从 1m 换到 15m/1h/4h」是否真能带来正期望，
 *       而不是仅仅让成本占比变小。
 *
 * 关键设计：
 *  1. 同一套趋势跟踪入场 + R 阶梯出场，跨周期参数一致（只调 maxHold 的 bar 数）。
 *  2. 加「随机入场对照组」：同样数量、同样出场、随机时点。
 *     若趋势组 ≈ 随机组，说明入场逻辑无 alpha，换周期只是换亏法。
 *  3. 严格无前视：信号在 bar i 收盘计算，bar i+1 开盘成交；同一根 K 线
 *     同时触及止损/止盈时按止损先成交（保守）。
 *  4. 时间切分：按入场时间中位数切 train/test，分别给 t 统计量。
 *  5. 不做参数优选 —— 只预注册固定配置，全部上报。
 *
 * 成本口径：往返 0.22%（手续费 6bps×2 + 滑点 5bps×2）
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const COST = 0.22 / 100; // 往返成本（占入场价比例）
const OUT = path.join(__dirname, '..', '.workbuddy', 'runs', '20260911-crypto-viability', '08_interval_backtest');

// ---------- 指标 ----------
function atrWilder(bars, n, upto) {
  // upto 为闭区间上界（含）
  let s = 0, cnt = 0;
  for (let i = Math.max(1, upto - n + 1); i <= upto; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
    cnt++;
  }
  return cnt ? s / cnt : null;
}
function sma(bars, n, upto, key = 'close') {
  if (upto + 1 < n) return null;
  let s = 0;
  for (let i = upto - n + 1; i <= upto; i++) s += bars[i][key];
  return s / n;
}
function rsiWilder(bars, n, upto) {
  if (upto < n) return null;
  let g = 0, l = 0;
  for (let i = upto - n + 1; i <= upto; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d >= 0) g += d; else l -= d;
  }
  g /= n; l /= n;
  if (g + l === 0) return 50;
  return 100 * g / (g + l);
}

// ---------- 出场 ----------
// cfg: { stopAtr, tpR, trail:bool, maxHold }
function simulateExit(bars, i0, entry, dir, atr, cfg) {
  // i0 = 入场 bar 索引（已成交），从 i0 开始逐根推进
  const risk = cfg.stopAtr * atr;
  let stop = entry - dir * risk;
  let tp = entry + dir * cfg.tpR * risk;
  let locked = 0; // 已锁定 R（用于阶梯）
  for (let k = i0; k < bars.length; k++) {
    const b = bars[k];
    const held = k - i0;
    // 先判止损/止盈（保守：同根先止损）
    if (dir > 0) {
      if (b.low <= stop) return { exit: stop, bars: held, reason: locked > 0 ? 'trail' : 'stop' };
      if (b.high >= tp) return { exit: tp, bars: held, reason: 'tp' };
    } else {
      if (b.high >= stop) return { exit: stop, bars: held, reason: locked > 0 ? 'trail' : 'stop' };
      if (b.low <= tp) return { exit: tp, bars: held, reason: 'tp' };
    }
    // 收盘后推进移动止损（R 阶梯，与生产一致）
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
      // 下一根开盘强平（若有）
      if (k + 1 < bars.length) return { exit: bars[k + 1].open, bars: held + 1, reason: 'maxhold' };
      return { exit: b.close, bars: held, reason: 'maxhold' };
    }
  }
  const last = bars.at(-1);
  return { exit: last.close, bars: bars.length - 1 - i0, reason: 'eod' };
}

const EXIT_CFGS = [
  { id: 'A_stop2_tp3_notrail', stopAtr: 2.0, tpR: 3.0, trail: false, maxHold: 30 },
  { id: 'B_stop2_tp3_trail', stopAtr: 2.0, tpR: 3.0, trail: true, maxHold: 30 },
  { id: 'C_stop2_tp3_trail_hold12', stopAtr: 2.0, tpR: 3.0, trail: true, maxHold: 12 },
  { id: 'D_stop3_tp3_trail', stopAtr: 3.0, tpR: 3.0, trail: true, maxHold: 30 },
  { id: 'E_stop2_tp2_trail', stopAtr: 2.0, tpR: 2.0, trail: true, maxHold: 30 },
  { id: 'F_stop1.5_tp4_trail', stopAtr: 1.5, tpR: 4.0, trail: true, maxHold: 30 },
];

const INTERVALS = [
  { iv: '15m', minBars: 220, cap: 260 },
  { iv: '1h', minBars: 200, cap: 260 },
  { iv: '4h', minBars: 180, cap: 300 },
];

// 简单可复现 RNG
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client(DB); await c.connect();

  const allTrades = [];   // 用于汇总
  const summary = [];

  for (const { iv, minBars, cap } of INTERVALS) {
    const symRows = (await c.query(
      `SELECT symbol, count(*)::int AS n FROM market_klines WHERE interval=$1 GROUP BY symbol HAVING count(*)>=${minBars} ORDER BY count(*) DESC LIMIT $2`, [iv, cap])
    ).rows;
    if (!symRows.length) { console.log(`${iv}: 满足条件(>=${minBars}根)的币种为 0，跳过`); continue; }
    const symbols = symRows.map(r => r.symbol);
    console.log(`\n=== ${iv} === 样本币 ${symbols.length}，最少 ${symRows.at(-1).n} 根`);

    const { rows } = await c.query(
      `SELECT symbol, open_time, open, high, low, close FROM market_klines
       WHERE interval=$1 AND symbol = ANY($2::text[]) ORDER BY symbol, open_time ASC`, [iv, symbols]);
    const bySym = new Map();
    for (const r of rows) {
      if (!bySym.has(r.symbol)) bySym.set(r.symbol, []);
      bySym.get(r.symbol).push({ t: +r.open_time, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    }

    // 预计算信号（趋势：MA20>MA60 且 close>MA20 且 RSI>=50 且 mom5>=0；只做多，与 NOFX_LONG_ONLY 一致）
    const signals = new Map(); // symbol -> [barIdx,...] 可入场 bar（信号在 i 收盘产生，i+1 开盘成交）
    for (const [sym, bars] of bySym) {
      const list = [];
      for (let i = 62; i < bars.length - 1; i++) {
        const ma20 = sma(bars, 20, i), ma60 = sma(bars, 60, i);
        const rsi = rsiWilder(bars, 14, i), atr = atrWilder(bars, 14, i);
        if (ma20 == null || ma60 == null || rsi == null || !atr) continue;
        const px = bars[i].close;
        if (atr / px < 0.0005) continue;              // 波动过小
        const mom5 = (px - bars[i - 5].close) / bars[i - 5].close * 100;
        if (ma20 > ma60 && px > ma20 && rsi >= 50 && mom5 >= 0) list.push({ i, atr });
      }
      // 去重叠：同一信号后 10 根内不重复入场
      const keep = [];
      for (const s of list) { if (!keep.length || s.i - keep.at(-1).i >= 10) keep.push(s); }
      signals.set(sym, keep);
    }
    const nSig = [...signals.values()].reduce((a, b) => a + b.length, 0);
    console.log(`  趋势信号数 ${nSig}`);

    // 随机对照组：每个币取与信号数相同的随机 bar（保持出场口径一致）
    const rnd = mulberry32(20260911);
    const rndSignals = new Map();
    for (const [sym, bars] of bySym) {
      const k = (signals.get(sym) || []).length;
      const list = [];
      for (let j = 0; j < k; j++) {
        const i = 62 + Math.floor(rnd() * (bars.length - 63));
        const atr = atrWilder(bars, 14, i);
        if (!atr) continue;
        list.push({ i, atr });
      }
      rndSignals.set(sym, list);
    }

    for (const mode of ['trend', 'random']) {
      const sigMap = mode === 'trend' ? signals : rndSignals;
      for (const cfg of EXIT_CFGS) {
        const trades = [];
        for (const [sym, bars] of bySym) {
          for (const s of (sigMap.get(sym) || [])) {
            const i1 = s.i + 1;
            if (i1 >= bars.length) continue;
            const entry = bars[i1].open;
            if (!(entry > 0)) continue;
            const res = simulateExit(bars, i1, entry, 1, s.atr, cfg);
            const gross = (res.exit - entry) / entry;
            const ret = gross - COST;
            trades.push({ t: bars[i1].t, ret, gross, r: gross * entry / (cfg.stopAtr * s.atr), reason: res.bars !== undefined ? res.reason : '?', hold: res.bars, sym });
          }
        }
        const key = `${iv}|${mode}|${cfg.id}`;
        allTrades.push({ key, iv, mode, cfg: cfg.id, trades });
        const st = stats(trades.map(x => x.ret));
        const stR = stats(trades.map(x => x.r));
        const ts = timeSplit(trades.map(x => ({ t: x.t, r: x.ret })));
        summary.push({ key, iv, mode, cfg: cfg.id, n: trades.length, ...st, rMean: stR.mean, ...ts });
        console.log(`  ${mode.padEnd(6)} ${cfg.id.padEnd(24)} n=${String(trades.length).padStart(5)}  均值R=${(stR.mean).toFixed(4).padStart(8)}  均值%${(st.mean * 100).toFixed(4).padStart(9)}  t=${st.t.toFixed(2).padStart(7)}  胜率${(st.win * 100).toFixed(1).padStart(5)}%  最大持有${Math.max(...trades.map(x => x.hold))}`);
      }
    }
  }

  // 写出
  const rowsOut = [['key', 'interval', 'mode', 'exit_cfg', 'n', 'mean_ret', 't_stat', 'win_rate', 'mean_R', 'train_mean', 'train_t', 'test_mean', 'test_t']];
  for (const s of summary) rowsOut.push([s.key, s.iv, s.mode, s.cfg, s.n, s.mean, s.t, s.win, s.rMean, s.trainMean, s.trainT, s.testMean, s.testT]);
  fs.writeFileSync(path.join(OUT, 'interval_summary.csv'), rowsOut.map(r => r.join(',')).join('\n'), 'utf8');

  // 逐笔明细（供过拟合审计用收益矩阵）
  const maxLen = Math.max(...allTrades.map(a => a.trades.length));
  const matrixCols = allTrades.map(a => a.trades.map(x => x.ret));
  const lines = [];
  for (let r = 0; r < maxLen; r++) lines.push(matrixCols.map(col => (r < col.length ? col[r].toFixed(8) : '')).join(','));
  fs.writeFileSync(path.join(OUT, 'trials_matrix_interval.csv'), allTrades.map(a => a.key).join(',') + '\n' + lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'trials_keys.json'), JSON.stringify(allTrades.map(a => a.key), null, 2), 'utf8');

  console.log('\n产出：' + path.join(OUT, 'interval_summary.csv'));
  console.log('      ' + path.join(OUT, 'trials_matrix_interval.csv'));
  await c.end();
}

function stats(a) {
  const n = a.length;
  if (!n) return { mean: 0, t: 0, win: 0, sd: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / n;
  const varr = a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1 || 1);
  const sd = Math.sqrt(varr);
  const win = a.filter(x => x > 0).length / n;
  return { mean, sd, win, t: sd ? mean / (sd / Math.sqrt(n)) : 0 };
}
function timeSplit(rows) {
  const s = [...rows].sort((a, b) => a.t - b.t);
  const mid = Math.floor(s.length / 2);
  const cut = s.length ? s[mid].t : 0;
  const tr = s.slice(0, mid).map(x => x.r), te = s.slice(mid).map(x => x.r);
  const A = stats(tr), B = stats(te);
  return { cutAt: new Date(cut).toISOString(), trainMean: A.mean, trainT: A.t, testMean: B.mean, testT: B.t };
}

main().catch(e => { console.error('ERR', e); process.exit(1); });
