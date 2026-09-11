/**
 * Alpha 探针（第 2 项快单 / 第 3 项换 alpha 源）
 *
 * 设计要点：
 *  1. 用统一出场规则回放，隔离"入场质量"，避免出场参数混进来。
 *  2. 标签有两个：
 *     - retR   : 回放的归一化收益（net / margin）
 *     - quick  : 是否前 5 根内就止损（第 2 项目的：快进快出单）
 *  3. 时间切分：按入场时间前 50% 训练 / 后 50% 测试。
 *     **只有在两段同时改善的因子才算数**（历史教训：多因子组合训练 +0.46 → 测试 -0.29 过拟合）。
 * 只读数据库。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const OUT = 'D:/UGit/nofx-new/.workbuddy/runs/20260911-crypto-viability/03_alpha';
const fs = require('fs');

const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3;
const QUICK_BARS = 5;

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
  return { net, exit };
}

// 统一出场：2ATR 止损 / 3R 止盈 / 1R 后移动 1.5ATR / 最长 120 根
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

// ---------- 入场特征 ----------
function features(before) {
  const atr = atr14(before);
  const px = before.at(-1).close;
  const m20 = ma(before, 20), m5 = ma(before, 5);
  const mom = n => before.length > n ? (px / before[before.length - 1 - n].close - 1) * 100 : null;
  const vol5 = before.slice(-5).reduce((a, b) => a + b.volume, 0) / 5;
  const vol20 = before.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
  const hi20 = Math.max(...before.slice(-20).map(b => b.high));
  const lo20 = Math.min(...before.slice(-20).map(b => b.low));
  const atr5 = atr14(before.slice(-19));
  return {
    atrPct: atr / px * 100,
    ext: (px - m20) / atr,
    rsi: rsi14(before),
    volRatio: vol20 > 0 ? vol5 / vol20 : null,
    mom5: mom(5), mom10: mom(10), mom20: mom(20),
    maAlign: (m5 - m20) / atr,
    rangePos: hi20 > lo20 ? (px - lo20) / (hi20 - lo20) : null,
    atrTrend: atr5 ? atr / atr5 : null,
    lastBarRet: (before.at(-1).close / before.at(-2).close - 1) * 100,
  };
}

const FEATS = [
  { k: 'atrPct', label: '波动率 ATR%', buckets: [0, 0.15, 0.25, 0.40, 0.60, 1.0, 999] },
  { k: 'ext', label: '偏离MA20(ATR)', buckets: [-99, -1.5, -0.5, 0.5, 1.5, 3, 99] },
  { k: 'rsi', label: 'RSI14', buckets: [0, 35, 45, 55, 65, 75, 100] },
  { k: 'volRatio', label: '量比 5/20', buckets: [0, 0.6, 0.8, 1.0, 1.3, 2.0, 999] },
  { k: 'mom5', label: '近5根动量%', buckets: [-99, -1.0, -0.3, 0.3, 1.0, 3, 99] },
  { k: 'mom20', label: '近20根动量%', buckets: [-99, -2, -0.5, 0.5, 2, 5, 99] },
  { k: 'maAlign', label: 'MA5-MA20(ATR)', buckets: [-99, -1, -0.3, 0.3, 1, 3, 99] },
  { k: 'rangePos', label: '20根区间位置', buckets: [0, 0.2, 0.4, 0.6, 0.8, 1.01] },
  { k: 'atrTrend', label: 'ATR 放大倍数', buckets: [0, 0.8, 1.0, 1.2, 1.5, 2.0, 999] },
  { k: 'lastBarRet', label: '前一根涨跌%', buckets: [-99, -0.5, -0.15, 0.15, 0.5, 1.5, 99] },
];

function agg(rows) {
  if (!rows.length) return { n: 0 };
  const n = rows.length;
  const sum = rows.reduce((a, r) => a + r.retR, 0);
  const wins = rows.filter(r => r.retR > 0).length;
  const quick = rows.filter(r => r.quick).length;
  return { n, sum: sum, avg: sum / n, wr: 100 * wins / n, quickPct: 100 * quick / n };
}

const f2 = v => (v === null || v === undefined || Number.isNaN(v)) ? 'n/a' : v.toFixed(2);

async function main() {
  const c = new Client(DB); await c.connect();
  fs.mkdirSync(OUT, { recursive: true });

  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, net, held_bars, entry_at, reason, leverage, margin
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
    const long = o.direction === 'OPEN_LONG';
    const r = replay(CFG, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, interval === '5m' ? 300000 : 60000);
    S.push({
      order_id: o.order_id, t: Date.parse(o.entry_at), long, symbol: o.symbol,
      retR: r.net / o.margin,
      quick: r.reason === 'stop_loss' && r.h < QUICK_BARS,
      held: r.h,
      ...features(before),
      hour: new Date(Date.parse(o.entry_at) + 8 * 3600000).getUTCHours(),
    });
  }
  S.sort((a, b) => a.t - b.t);
  const mid = S[Math.floor(S.length / 2)].t;
  const TRAIN = S.filter(x => x.t < mid), TEST = S.filter(x => x.t >= mid);
  console.log(`样本 ${S.length} | 训练 ${TRAIN.length} | 测试 ${TEST.length}`);
  console.log(`统一出场(2ATR止损/3R止盈/1R后移动1.5ATR/120根) 回放：累计收益 ${S.reduce((a, x) => a + x.retR, 0).toFixed(1)}，快损(${QUICK_BARS}根内)占比 ${(100 * S.filter(x => x.quick).length / S.length).toFixed(1)}%\n`);

  // 全局基准
  for (const [nm, set] of [['全样本', S], ['训练', TRAIN], ['测试', TEST]]) {
    const a = agg(set);
    console.log(`基准[${nm}] n=${a.n} 累计=${f2(a.sum)} 均单=${a.avg.toFixed(4)} 胜率=${a.wr.toFixed(1)}% 快损占比=${a.quickPct.toFixed(1)}%`);
  }
  console.log('\n' + '='.repeat(112));
  console.log('单因子分桶（R = 该桶累计收益 - 全段基准均单×桶样本数，即"相对基准的超额"）');
  console.log('='.repeat(112));

  const results = [];
  for (const F of FEATS) {
    const b = F.buckets;
    console.log(`\n--- ${F.label} (${F.k}) ---`);
    console.log('  区间'.padEnd(20) + '训练 n  训练均单   测试 n  测试均单   训练快损%  测试快损%  两段同号');
    for (let i = 0; i < b.length - 1; i++) {
      const lo = b[i], hi = b[i + 1];
      const inB = x => x[F.k] !== null && !Number.isNaN(x[F.k]) && x[F.k] >= lo && x[F.k] < hi;
      const tr = agg(TRAIN.filter(inB)), te = agg(TEST.filter(inB));
      if (tr.n < 30 || te.n < 30) continue;
      const baseTr = agg(TRAIN).avg, baseTe = agg(TEST).avg;
      const exTr = tr.avg - baseTr, exTe = te.avg - baseTe;
      const same = Math.sign(exTr) === Math.sign(exTe) && Math.abs(exTr) > 0.01 && Math.abs(exTe) > 0.01;
      console.log(`  [${f2(lo)},${f2(hi)})`.padEnd(20) +
        `${String(tr.n).padStart(5)}  ${tr.avg.toFixed(4).padStart(8)}  ${String(te.n).padStart(6)}  ${te.avg.toFixed(4).padStart(8)}  ` +
        `${tr.quickPct.toFixed(1).padStart(8)}%  ${te.quickPct.toFixed(1).padStart(8)}%  ${same ? '  ✔ ' + (exTr > 0 ? '同为佳' : '同为差') : ''}`);
      results.push({ feat: F.k, label: F.label, lo, hi, trN: tr.n, trAvg: tr.avg, teN: te.n, teAvg: te.avg, exTr, exTe, same, trQuick: tr.quickPct, teQuick: te.quickPct });
    }
  }

  // 第 2 项：快损的独立画像
  console.log('\n' + '='.repeat(112));
  console.log(`第 2 项：快损单(${QUICK_BARS}根内止损) vs 其余 —— 入场特征均值对比`);
  console.log('='.repeat(112));
  const Q = S.filter(x => x.quick), NQ = S.filter(x => !x.quick);
  console.log(`快损 ${Q.length} 笔 (${(100 * Q.length / S.length).toFixed(1)}%)，累计收益贡献 ${Q.reduce((a, x) => a + x.retR, 0).toFixed(1)}`);
  console.log(`其余 ${NQ.length} 笔，累计收益贡献 ${NQ.reduce((a, x) => a + x.retR, 0).toFixed(1)}\n`);
  const mean = (arr, k) => { const v = arr.map(x => x[k]).filter(x => x !== null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  console.log('特征'.padEnd(20) + '快损均值'.padStart(12) + '其余均值'.padStart(12) + '   差异');
  for (const F of FEATS) {
    const a = mean(Q, F.k), b2 = mean(NQ, F.k);
    if (a === null || b2 === null) continue;
    console.log(`${F.label}(${F.k})`.padEnd(28) + f2(a).padStart(10) + f2(b2).padStart(12) + `   ${(a - b2 > 0 ? '+' : '')}${f2(a - b2)}`);
  }

  fs.writeFileSync(OUT + '/alpha_buckets.csv',
    'feat,label,lo,hi,train_n,train_avg,test_n,test_avg,excess_train,excess_test,same_sign,train_quick_pct,test_quick_pct\n' +
    results.map(r => [r.feat, r.label, r.lo, r.hi, r.trN, r.trAvg, r.teN, r.teAvg, r.exTr, r.exTe, r.same, r.trQuick, r.teQuick].join(',')).join('\n') + '\n');
  console.log(`\n写出 ${OUT}/alpha_buckets.csv`);
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
