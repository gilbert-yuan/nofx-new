/**
 * 变体回放：在真实入场点上，回放不同的止损/止盈/移动止损参数，找最优组合。
 * 同时做"出场前 MFE"诊断（只统计到实际平仓那根为止），区分"入场时机差"与"止损管理差"。
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

/**
 * 通用回放：从 entryIdx 起，用给定参数模拟
 * cfg: { stopR, tpR, trailTriggerR, trailAtr, beAtR, maxHoldBars, atrMult }
 */
function replay(cfg, o, bars, idx, atr, entry, dir, long, margin, leverage, barMs) {
  const ru = cfg.stopR * atr;                 // 止损距离（价格）
  const tpDist = cfg.tpR * ru;
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + tpDist : entry - tpDist;
  let bestFav = 0;                            // 最大有利偏移（价格）
  for (let h = 0; h < cfg.maxHoldBars && idx + h < bars.length; h++) {
    const b = bars[idx + h];
    // 有利/不利偏移
    const fav = long ? b.high - entry : entry - b.low;
    const adv = long ? entry - b.low : b.high - entry;
    if (fav > bestFav) bestFav = fav;
    // 止损
    const hitStop = long ? b.low <= stop : b.high >= stop;
    const hitTp = long ? b.high >= tp : b.low <= tp;
    if (hitStop && hitTp) {
      const openedBeyondTp = long ? b.open >= tp : b.open <= tp;
      if (openedBeyondTp) return { ...settle(dir, entry, tp, margin, leverage, h, barMs), reason: 'take_profit', mfeR: bestFav / ru };
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { ...settle(dir, entry, sp, margin, leverage, h, barMs), reason: 'stop_loss', mfeR: bestFav / ru };
    }
    if (hitStop) {
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { ...settle(dir, entry, sp, margin, leverage, h, barMs), reason: 'stop_loss', mfeR: bestFav / ru };
    }
    if (hitTp) return { ...settle(dir, entry, tp, margin, leverage, h, barMs), reason: 'take_profit', mfeR: bestFav / ru };
    // 移动止损
    const profR = (long ? b.close - entry : entry - b.close) / ru;
    if (profR >= cfg.trailTriggerR) {
      const curAtr = atr; // 简化：用入场时 ATR
      const trail = long ? b.close - cfg.trailAtr * curAtr : b.close + cfg.trailAtr * curAtr;
      const be = long ? entry + (cfg.beAtR || 0) * ru : entry - (cfg.beAtR || 0) * ru;
      stop = long ? Math.max(stop, trail, be) : Math.min(stop, trail, be);
    }
  }
  const last = bars[Math.min(idx + cfg.maxHoldBars, bars.length) - 1];
  return { ...settle(dir, entry, last.close, margin, leverage, cfg.maxHoldBars, barMs), reason: 'timeout', mfeR: bestFav / ru };
}

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, exit, net, roi, held_bars, entry_at, exit_at,
           reason, leverage, margin
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL AND leverage > 0
    ORDER BY entry_at`)).rows;

  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 60 * 60000;
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

  // 组装样本
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
    S.push({
      o, bars, idx, atr, entry: o.entry, long, dir: long ? 1 : -1,
      margin: o.margin, leverage: o.leverage, interval,
      barMs: interval === '5m' ? 300000 : 60000,
      ext: (before.at(-1).close - ma20(before)) / atr,
      atrPct: atr / o.entry
    });
  }
  console.log('可回放样本:', S.length, '/', orders.length);

  // ---- 诊断1：出场前 MFE（只算到实际平仓根）----
  console.log('\n=== 诊断：出场前最大有利偏移（按实际持仓根数截断）===');
  const withMfe = [];
  for (const s of S) {
    const ru = Math.max(2 * s.atr, s.entry * 0.008);
    const hb = Math.max(1, Math.round(+s.o.held_bars || 1));
    let mfe = 0;
    for (let h = 0; h < hb && s.idx + h < s.bars.length; h++) {
      const b = s.bars[s.idx + h];
      const fav = s.long ? b.high - s.entry : s.entry - b.low;
      if (fav > mfe) mfe = fav;
    }
    withMfe.push({ ...s, mfeR: mfe / ru, net: +s.o.net });
  }
  const L = withMfe.filter(x => x.net <= 0);
  const W = withMfe.filter(x => x.net > 0);
  console.log(`亏损单 n=${L.length} 平均出场前MFE=${(L.reduce((a, x) => a + x.mfeR, 0) / L.length).toFixed(2)}R`);
  console.log(`盈利单 n=${W.length} 平均出场前MFE=${(W.reduce((a, x) => a + x.mfeR, 0) / W.length).toFixed(2)}R`);
  for (const [lo, hi, lb] of [[0, 0.1, 'MFE<0.1R'], [0.1, 0.25, '0.1~0.25R'], [0.25, 0.5, '0.25~0.5R'], [0.5, 1, '0.5~1R'], [1, 2, '1~2R'], [2, Infinity, '>=2R']]) {
    const sub = L.filter(x => x.mfeR >= lo && x.mfeR < hi);
    console.log(`  ${lb.padEnd(12)} n=${String(sub.length).padStart(4)} 占比=${(100 * sub.length / L.length).toFixed(1)}%`);
  }

  // ---- 变体测试 ----
  const variants = [
    { name: 'V0 基线(2ATR止损/3.5R止盈/2.5ATR移动@2%)', stopR: 2.0, tpR: 3.5, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
    { name: 'V1 止盈降到2R', stopR: 2.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
    { name: 'V2 止盈1.5R', stopR: 2.0, tpR: 1.5, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
    { name: 'V3 止盈1.0R', stopR: 2.0, tpR: 1.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
    { name: 'V4 2R止盈+0.5R保本', stopR: 2.0, tpR: 2.0, trailTriggerR: 0.5, trailAtr: 1.5, beAtR: 0.2, maxHoldBars: 48 },
    { name: 'V5 止损3ATR/止盈2R', stopR: 3.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
    { name: 'V6 止损1.5ATR/止盈2R', stopR: 1.5, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 2.5, maxHoldBars: 48 },
    { name: 'V7 2R止盈+1R移动1ATR', stopR: 2.0, tpR: 2.0, trailTriggerR: 1.0, trailAtr: 1.0, maxHoldBars: 48 },
    { name: 'V8 2R止盈+0.5R移动1ATR', stopR: 2.0, tpR: 2.0, trailTriggerR: 0.5, trailAtr: 1.0, maxHoldBars: 48 },
  ];

  console.log('\n=== 变体回放（同一批真实入场点，固定杠杆/保证金）===');
  for (const cfg of variants) {
    let n = 0, wins = 0, net = 0;
    for (const s of S) {
      const r = replay(cfg, s.o, s.bars, s.idx, s.atr, s.entry, s.dir, s.long, s.margin, s.leverage, s.barMs);
      if (!r) continue;
      n++; if (r.net > 0) wins++; net += r.net;
    }
    console.log(`${cfg.name.padEnd(42)} n=${n} 胜率=${(100 * wins / n).toFixed(1)}% 净=${net.toFixed(0)} 均单=${(net / n).toFixed(3)}`);
  }

  // ---- 变体 + 入场过滤组合 ----
  console.log('\n=== 最优变体 + 入场过滤（ext=偏离MA20的ATR倍数, atrPct=波动率）===');
  const best = { stopR: 2.0, tpR: 2.0, trailTriggerR: 0.5, trailAtr: 1.5, beAtR: 0.2, maxHoldBars: 48 };
  const filters = [
    ['无过滤', () => true],
    ['仅多单', s => s.long],
    ['仅空单', s => !s.long],
    ['atrPct>=0.25%', s => s.atrPct >= 0.0025],
    ['atrPct>=0.40%', s => s.atrPct >= 0.004],
    ['|ext|>=0.5', s => Math.abs(s.ext) >= 0.5],
    ['atrPct>=0.25% & |ext|>=0.5', s => s.atrPct >= 0.0025 && Math.abs(s.ext) >= 0.5],
    ['仅1m', s => s.interval === '1m'],
    ['仅5m', s => s.interval === '5m'],
  ];
  for (const [name, fn] of filters) {
    let n = 0, wins = 0, net = 0;
    for (const s of S) {
      if (!fn(s)) continue;
      const r = replay(best, s.o, s.bars, s.idx, s.atr, s.entry, s.dir, s.long, s.margin, s.leverage, s.barMs);
      n++; if (r.net > 0) wins++; net += r.net;
    }
    if (!n) continue;
    console.log(`${name.padEnd(30)} n=${String(n).padStart(4)} 胜率=${(100 * wins / n).toFixed(1)}% 净=${net.toFixed(0)} 均单=${(net / n).toFixed(3)}`);
  }

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
