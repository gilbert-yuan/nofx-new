/**
 * 第 3 项：止盈倍数（盈亏比）扫描
 * 动机：打平胜率 p=(s+c)/(s+t)。当前 t=6ATR(k=3) 时，即使 ATR=1% 也需 27.8% 胜率，
 *      而实际仅 22.8% → 结构上不可能盈利。提高 k 可把打平线压到 22.8% 以下。
 * ⚠️ 本回放基于「已成交入场点」，绕过了 RR 闸门，因此高估了效果：
 *    实盘提高 NOFX_MAIN_TP_R 必须联动 NOFX_MIN_RR（硬约束 k >= MIN_RR + 0.5(MIN_RR-1)/stopAtr），
 *    否则信号会在闸门处被挡掉。此处只回答「提高盈亏比是否真的改善收益」。
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
function replay(tpR, bars, idx, atr, entry, dir, long, margin, leverage, barMs) {
  const ru = 2.0 * atr;
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + tpR * ru : entry - tpR * ru;
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
  if (!n) return { n: 0, avg: 0, t: 0, wr: 0 };
  const v = rows.map(r => r.retR);
  const avg = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0, wr: 100 * v.filter(x => x > 0).length / n };
}

const TPS = [2.0, 3.0, 4.0, 5.0, 6.0, 8.0];
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
    const rec = { t: Date.parse(o.entry_at) };
    for (const tpR of TPS) {
      const r = replay(tpR, bars, idx, atr, o.entry, long ? 1 : -1, long, o.margin, o.leverage, barMs);
      rec['tp' + tpR] = { retR: r.net / o.margin, reason: r.reason };
    }
    S.push(rec);
  }
  S.sort((a, b) => a.t - b.t);
  const mid = S[Math.floor(S.length / 2)].t;
  const TRAIN = S.filter(x => x.t < mid), TEST = S.filter(x => x.t >= mid);
  console.log(`样本 ${S.length} | 训练 ${TRAIN.length} | 测试 ${TEST.length}`);
  console.log('止盈R  打平胜率*  训练均单   训练t   测试均单   测试t   全样本均单  全t    实际胜率  止盈命中率');
  for (const tpR of TPS) {
    const k = 'tp' + tpR;
    const cCost = 0.22;
    const sPct = 0.158, tPct = tpR * 0.158;
    const breakeven = (sPct + cCost) / (sPct + tPct);
    const tr = agg(TRAIN.map(x => x[k])), te = agg(TEST.map(x => x[k])), al = agg(S.map(x => x[k]));
    const tpHit = 100 * S.filter(x => x[k].reason === 'take_profit').length / S.length;
    console.log(`${tpR.toFixed(1)}R`.padEnd(7) + `${(breakeven * 100).toFixed(1)}%`.padEnd(10) +
      `${tr.avg.toFixed(4).padStart(9)} ${tr.t.toFixed(2).padStart(6)}  ${te.avg.toFixed(4).padStart(9)} ${te.t.toFixed(2).padStart(6)}  ` +
      `${al.avg.toFixed(4).padStart(10)} ${al.t.toFixed(2).padStart(6)}  ${al.wr.toFixed(1)}%`.padStart(10) + `    ${tpHit.toFixed(1)}%`);
  }
  console.log('\n* 打平胜率按当前市况中位数 ATR=0.0792% 估算（止损 0.158%、成本 0.22%）');
  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
