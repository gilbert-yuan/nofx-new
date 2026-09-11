/**
 * 构建真实试验矩阵（过拟合审计输入）
 * 在同一批真实入场点 + 真实历史 1m K 线上，回放 N 种参数组合，
 * 输出 T x N 的逐笔收益率矩阵。只读数据库。
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const OUT = 'D:/UGit/nofx-new/.workbuddy/runs/20260911-crypto-viability/05_statistical_audit';
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
const ma20 = bars => bars.length < 20 ? null : bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20;

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
  return { net, exit, heldBars };
}

function replay(cfg, bars, idx, atr, entry, dir, long, margin, leverage, barMs) {
  const ru = cfg.stopR * atr;
  const tpDist = cfg.tpR * ru;
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + tpDist : entry - tpDist;
  for (let h = 0; h < cfg.maxHoldBars && idx + h < bars.length; h++) {
    const b = bars[idx + h];
    const hitStop = long ? b.low <= stop : b.high >= stop;
    const hitTp = long ? b.high >= tp : b.low <= tp;
    if (hitStop && hitTp) {
      const openedBeyondTp = long ? b.open >= tp : b.open <= tp;
      if (openedBeyondTp) return { ...settle(dir, entry, tp, margin, leverage, h, barMs), reason: 'take_profit' };
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { ...settle(dir, entry, sp, margin, leverage, h, barMs), reason: 'stop_loss' };
    }
    if (hitStop) {
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { ...settle(dir, entry, sp, margin, leverage, h, barMs), reason: 'stop_loss' };
    }
    if (hitTp) return { ...settle(dir, entry, tp, margin, leverage, h, barMs), reason: 'take_profit' };
    const profR = (long ? b.close - entry : entry - b.close) / ru;
    if (profR >= cfg.trailTriggerR) {
      const trail = long ? b.close - cfg.trailAtr * atr : b.close + cfg.trailAtr * atr;
      const be = long ? entry + (cfg.beAtR || 0) * ru : entry - (cfg.beAtR || 0) * ru;
      stop = long ? Math.max(stop, trail, be) : Math.min(stop, trail, be);
    }
  }
  const last = bars[Math.min(idx + cfg.maxHoldBars, bars.length) - 1];
  return { ...settle(dir, entry, last.close, margin, leverage, cfg.maxHoldBars, barMs), reason: 'timeout' };
}

const VARIANTS = [
  { id: 'V0_base_2atr_3p5R', stopR: 2.0, tpR: 3.5, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
  { id: 'V1_tp2R', stopR: 2.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
  { id: 'V2_tp1p5R', stopR: 2.0, tpR: 1.5, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
  { id: 'V3_tp1R', stopR: 2.0, tpR: 1.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
  { id: 'V4_tp2R_be0p2', stopR: 2.0, tpR: 2.0, trailTriggerR: 0.5, trailAtr: 1.5, beAtR: 0.2, maxHoldBars: 48 },
  { id: 'V5_stop3atr_tp2R', stopR: 3.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
  { id: 'V6_stop1p5atr_tp2R', stopR: 1.5, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
  { id: 'V7_tp2R_trail1atr', stopR: 2.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 1.0, maxHoldBars: 48 },
  { id: 'V8_tp2R_trail0p5_1atr', stopR: 2.0, tpR: 2.0, trailTriggerR: 0.5, trailAtr: 1.0, maxHoldBars: 48 },
  { id: 'V9_hold120_tp3R', stopR: 2.0, tpR: 3.0, trailTriggerR: 1.0, trailAtr: 2.0, maxHoldBars: 120 },
  { id: 'V10_hold120_tp2R', stopR: 2.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.0, maxHoldBars: 120 },
  { id: 'V11_stop2p5_tp2p5', stopR: 2.5, tpR: 2.5, trailTriggerR: 1.0, trailAtr: 2.0, maxHoldBars: 120 },
];

const FILTERS = [
  ['all', () => true],
  ['longonly', s => s.long],
  ['shortonly', s => !s.long],
  ['atrpct_ge_0p25', s => s.atrPct >= 0.0025],
  ['atrpct_ge_0p40', s => s.atrPct >= 0.004],
  ['ext_ge_0p5', s => Math.abs(s.ext) >= 0.5],
  ['atr25_ext05', s => s.atrPct >= 0.0025 && Math.abs(s.ext) >= 0.5],
  ['atr40_long', s => s.atrPct >= 0.004 && s.long],
];

async function main() {
  const c = new Client(DB);
  await c.connect();
  fs.mkdirSync(OUT, { recursive: true });

  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, exit, net, roi, held_bars, entry_at, exit_at,
           reason, leverage, margin
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL AND leverage > 0 AND margin > 0
    ORDER BY entry_at`)).rows;

  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 120 * 60000;
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
        `SELECT open_time, open, high, low, close FROM market_klines
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
    S.push({ o, bars, idx, atr, entry: o.entry, long, dir: long ? 1 : -1,
      margin: o.margin, leverage: o.leverage, interval,
      barMs: interval === '5m' ? 300000 : 60000,
      ext: (before.at(-1).close - ma20(before)) / atr, atrPct: atr / o.entry });
  }
  console.log(`可回放样本 ${S.length} / ${orders.length}`);

  // 组合 = 变体 x 过滤
  const combos = [];
  for (const v of VARIANTS) for (const [fname, fn] of FILTERS) combos.push({ id: `${v.id}__${fname}`, cfg: v, fn });
  console.log(`试验配置数 ${combos.length}`);

  // T x N 矩阵：行=样本，列=配置
  const T = S.length, N = combos.length;
  const M = Array.from({ length: T }, () => new Array(N).fill(0));
  for (let j = 0; j < N; j++) {
    const cb = combos[j];
    for (let i = 0; i < T; i++) {
      const s = S[i];
      if (!cb.fn(s)) { M[i][j] = 0; continue; }          // 被过滤掉的样本记 0（不持仓）
      const r = replay(cb.cfg, s.bars, s.idx, s.atr, s.entry, s.dir, s.long, s.margin, s.leverage, s.barMs);
      M[i][j] = r.net / s.margin;
    }
  }

  const header = ['date'].concat(combos.map(x => x.id));
  const lines = [header.join(',')];
  for (let i = 0; i < T; i++) {
    const d = new Date(S[i].o.entry_at).toISOString().slice(0, 10);
    lines.push([d].concat(M[i].map(v => v.toFixed(8))).join(','));
  }
  fs.writeFileSync(path.join(OUT, 'trials_matrix.csv'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'sample_order_ids.txt'), S.map(s => s.o.order_id).join('\n') + '\n');
  console.log(`写出 trials_matrix.csv: ${T} 行 x ${N} 列`);

  // 每个配置的汇总（净/胜率），用于观察最优配置
  const summary = combos.map((cb, j) => {
    let n = 0, wins = 0, sum = 0, sumAbs = 0;
    for (let i = 0; i < T; i++) {
      const v = M[i][j];
      if (v === 0) continue;
      n++; sum += v; sumAbs += Math.abs(v); if (v > 0) wins++;
    }
    return { id: cb.id, n, wr: n ? 100 * wins / n : 0, sumRet: sum, avgRet: n ? sum / n : 0 };
  });
  summary.sort((a, b) => b.sumRet - a.sumRet);
  fs.writeFileSync(path.join(OUT, 'trials_summary.csv'),
    'config_id,n_trades,win_rate_pct,sum_return,avg_return\n' +
    summary.map(r => `${r.id},${r.n},${r.wr.toFixed(2)},${r.sumRet.toFixed(4)},${r.avgRet.toFixed(6)}`).join('\n') + '\n');
  console.log('\n最优 8 个配置:');
  summary.slice(0, 8).forEach(r => console.log(`  ${r.id.padEnd(40)} n=${String(r.n).padStart(4)} 胜率=${r.wr.toFixed(1)}% 累计收益=${r.sumRet.toFixed(2)}`));
  console.log('最差 5 个配置:');
  summary.slice(-5).forEach(r => console.log(`  ${r.id.padEnd(40)} n=${String(r.n).padStart(4)} 胜率=${r.wr.toFixed(1)}% 累计收益=${r.sumRet.toFixed(2)}`));

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
