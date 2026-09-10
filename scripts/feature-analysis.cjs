// 特征分析：在新规则回放结果上，按入场特征分桶统计胜率/净盈亏，找有预测力的过滤器
const { Client } = require('pg');

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3, MAX_HOLD = 120;

function atr14(bars) {
  if (bars.length < 15) return null;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
  }
  return sum / 14;
}
function ma20(bars) { return bars.length < 20 ? null : bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20; }
function rsi14(bars) {
  if (bars.length < 15) return null;
  let g = 0, l = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch > 0) g += ch; else l -= ch;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function volRatio(bars) {
  if (bars.length < 20) return null;
  const recent = bars.slice(-5).reduce((a, b) => a + b.volume, 0) / 5;
  const base = bars.slice(-20, -5).reduce((a, b) => a + b.volume, 0) / 15;
  return base > 0 ? recent / base : null;
}
function settle(dir, entry, rawExit, margin, leverage, held, reason) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const notional = margin * leverage;
  const gross = dir * (exit - entry) * (notional / entry);
  const entryFee = notional * FEE_BPS / 10000;
  const exitFee = exit * (notional / entry) * FEE_BPS / 10000;
  const funding = notional * FUNDING_BPS_8H / 10000 * held * 60000 / 28800000;
  let net = gross - entryFee - exitFee - funding;
  const maxLoss = -margin - entryFee;
  if (net < maxLoss) net = maxLoss;
  return { net, reason, held };
}
function replay(o, bars, startIdx) {
  const long = o.direction === 'OPEN_LONG';
  const dir = long ? 1 : -1;
  const entry = o.entry;
  const a0 = atr14(bars.slice(0, startIdx));
  if (!a0 || a0 <= 0) return null;
  const ru = Math.max(2 * a0, entry * 0.008);
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + 2 * ru : entry - 2 * ru;
  for (let held = 0; held < MAX_HOLD && startIdx + held < bars.length; held++) {
    const row = bars[startIdx + held];
    if (long ? row.low <= stop : row.high >= stop) {
      const p = long ? Math.min(row.open, stop) : Math.max(row.open, stop);
      return settle(dir, entry, p, o.margin, o.leverage, held, 'stop_loss');
    }
    if (long ? row.high >= tp : row.low <= tp) return settle(dir, entry, tp, o.margin, o.leverage, held, 'take_profit');
    if (held > 0 && held % 5 === 0) {
      const a = atr14(bars.slice(0, startIdx + held + 1));
      const profit = long ? (row.close - entry) / entry : (entry - row.close) / entry;
      if (a > 0 && profit > 0.02) {
        stop = long ? Math.max(stop, entry + 0.2 * a, row.close - 1.5 * a) : Math.min(stop, entry - 0.2 * a, row.close + 1.5 * a);
      }
    }
  }
  const last = bars[Math.min(startIdx + MAX_HOLD, bars.length) - 1];
  return settle(dir, entry, last.close, o.margin, o.leverage, MAX_HOLD, 'timeout');
}

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT o.order_id, o.symbol, o.direction, o.entry, o.entry_at, o.exit_at, o.leverage, o.margin, o.net, o.reason, o.created_at
    FROM simulated_orders o
    WHERE o.status='closed' AND o.entry IS NOT NULL AND o.entry_at IS NOT NULL ORDER BY o.created_at`)).rows;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 22 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + (MAX_HOLD + 10) * 60000;
  const symbols = [...new Set(orders.map(o => o.symbol))];
  const klineMap = new Map();
  for (const symbol of symbols) {
    const like = await c.query(`SELECT symbol FROM (SELECT DISTINCT symbol FROM market_klines WHERE interval='1m') t WHERE symbol=$1 OR symbol=$2`, ['OKX_PUBLIC_' + symbol, symbol]);
    const key = like.rows.map(r => r.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0];
    if (!key) { klineMap.set(symbol, null); continue; }
    const rows = await c.query(`SELECT open_time, open, high, low, close, volume FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time>=$2 AND open_time<=$3 ORDER BY open_time`, [key, minT, maxT]);
    klineMap.set(symbol, rows.rows.map(r => ({ openTime: Number(r.open_time), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })));
  }
  const locate = (bars, t) => {
    if (!bars || !bars.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  // 特征 + 新规则回放结果（不做过滤，全部订单，供分桶观察）
  const rowsAll = [];
  for (const o of orders) {
    const bars = klineMap.get(o.symbol);
    const idx = bars ? locate(bars, Date.parse(o.entry_at)) : -1;
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const a = atr14(before), m = ma20(before);
    if (!a || !m || a <= 0) continue;
    const ext = (before[before.length - 1].close - m) / a;
    const r = replay(o, bars, idx);
    if (!r) continue;
    rowsAll.push({
      net: r.net, reason: r.reason, long: o.direction === 'OPEN_LONG',
      ext, vol: a / o.entry, rsi: rsi14(before), vr: volRatio(before),
      hour: new Date(Date.parse(o.entry_at)).getUTCHours(),
      symbol: o.symbol
    });
  }
  console.log('样本:', rowsAll.length);

  const bucket = (name, fn, labels) => {
    console.log('\n=== ' + name + '（新规则回放） ===');
    for (let i = 0; i < labels.length; i++) {
      const sub = rowsAll.filter(fn(i));
      if (!sub.length) continue;
      const wins = sub.filter(x => x.net > 0).length;
      const net = sub.reduce((a, x) => a + x.net, 0);
      console.log(`${labels[i].padEnd(14)} n=${String(sub.length).padStart(4)} 胜率=${(100 * wins / sub.length).toFixed(1)}% 平均净=${(net / sub.length).toFixed(2)}`);
    }
  };

  bucket('方向', i => i === 0 ? x => x.long : x => !x.long, ['做多', '做空']);
  bucket('波动率(ATR/价格)', i => {
    const edges = [0, 0.001, 0.0015, 0.0025, 0.005, Infinity];
    return x => x.vol >= edges[i] && x.vol < edges[i + 1];
  }, ['<0.10%', '0.10-0.15%', '0.15-0.25%', '0.25-0.50%', '>=0.50%']);
  bucket('偏离MA20(ATR)', i => {
    const e = [-Infinity, -1.0, -0.5, 0.5, 1.0, Infinity];
    return x => x.ext >= e[i] && x.ext < e[i + 1];
  }, ['<-1.0', '-1.0~-0.5', '-0.5~0.5', '0.5~1.0', '>1.0']);
  bucket('RSI', i => {
    const e = [0, 30, 40, 60, 70, 100];
    return x => x.rsi >= e[i] && x.rsi < e[i + 1];
  }, ['<30', '30-40', '40-60', '60-70', '>=70']);
  bucket('量比(5/15)', i => {
    const e = [0, 0.8, 1.2, 1.8, Infinity];
    return x => x.vr != null && x.vr >= e[i] && x.vr < e[i + 1];
  }, ['<0.8', '0.8-1.2', '1.2-1.8', '>=1.8']);
  bucket('UTC小时', i => x => x.hour === i, Array.from({ length: 24 }, (_, h) => `${h}点`));

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
