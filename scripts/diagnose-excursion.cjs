/**
 * 诊断脚本：MAE / MFE 分析
 *
 * 目的：区分"入场时机差"与"止损/持仓管理差"。
 *  - MFE = 入场后最大有利偏移（价格朝我们方向走的最大幅度）
 *  - MAE = 入场后最大不利偏移
 * 若亏损单大多先出现过正 MFE（例如 >0.5R）再回落到止损 → 问题在止损过紧/未保护盈利；
 * 若亏损单几乎没有正 MFE，一入场就朝反方向走 → 问题在入场时机（追势/反向）。
 *
 * 只读数据库，不做任何修改。
 */
const { Client } = require('pg');

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

const atr14 = bars => {
  if (bars.length < 15) return null;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  return sum / 14;
};
const ma20 = bars => bars.length < 20 ? null : bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20;
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

async function main() {
  const c = new Client(DB);
  await c.connect();

  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, exit, net, roi, held_bars,
           entry_at, exit_at, reason, leverage, margin, created_at
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL
    ORDER BY entry_at`)).rows;
  console.log('已平仓样本:', orders.length);

  // 按 symbol+interval 批量取 K 线
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 60 * 60000;

  const symbols = [...new Set(orders.map(o => o.symbol))];
  const keyMap = new Map();
  for (const s of symbols) {
    const r = await c.query(`SELECT DISTINCT symbol FROM market_klines WHERE symbol=$1 OR symbol=$2`,
      ['OKX_PUBLIC_' + s, s]);
    const keys = r.rows.map(x => x.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0));
    keyMap.set(s, keys[0] || null);
  }
  const klineCache = new Map(); // key|interval -> bars
  const getBars = async (symbol, interval) => {
    const k = keyMap.get(symbol) + '|' + interval;
    if (klineCache.has(k)) return klineCache.get(k);
    const key = keyMap.get(symbol);
    let bars = [];
    if (key) {
      const r = await c.query(
        `SELECT open_time, open, high, low, close, volume FROM market_klines
         WHERE symbol=$1 AND interval=$2 AND open_time>=$3 AND open_time<=$4 ORDER BY open_time`,
        [key, interval, minT, maxT]);
      bars = r.rows.map(x => ({ openTime: Number(x.open_time), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }));
    }
    klineCache.set(k, bars);
    return bars;
  };
  const locate = (bars, t) => {
    if (!bars || !bars.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const rows = [];
  let skipped = 0;
  for (const o of orders) {
    const bars = await getBars(o.symbol, o.interval || '1m');
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) { skipped++; continue; }
    const before = bars.slice(0, idx);
    const a = atr14(before), m = ma20(before);
    if (!a || !m || a <= 0) { skipped++; continue; }
    const entry = o.entry;
    const long = o.direction === 'OPEN_LONG';
    const dir = long ? 1 : -1;
    const ru = Math.max(2 * a, entry * 0.008);
    const stop = long ? entry - ru : entry + ru;

    // 入场后逐根统计 MFE/MAE（以 R 为单位）
    const horizon = Math.min(48, bars.length - idx);
    let mfe = 0, mae = 0, mfeBars = 0, maeBars = 0;
    for (let h = 0; h < horizon; h++) {
      const b = bars[idx + h];
      const fav = long ? (b.high - entry) / ru : (entry - b.low) / ru;
      const adv = long ? (entry - b.low) / ru : (b.high - entry) / ru;
      if (fav > mfe) { mfe = fav; mfeBars = h + 1; }
      if (adv > mae) { mae = adv; maeBars = h + 1; }
    }
    rows.push({
      symbol: o.symbol, long, net: +o.net, roi: +o.roi, reason: o.reason,
      held: +o.held_bars, mfe, mae, mfeBars, maeBars,
      ext: (before.at(-1).close - m) / a,
      rsi: rsi14(before), atrPct: a / entry,
      interval: o.interval || '1m'
    });
  }
  console.log('有效样本:', rows.length, ' 跳过:', skipped);

  const stat = (label, sub) => {
    if (!sub.length) return;
    const wins = sub.filter(x => x.net > 0).length;
    const net = sub.reduce((a, x) => a + x.net, 0);
    const mfe = sub.reduce((a, x) => a + x.mfe, 0) / sub.length;
    const mae = sub.reduce((a, x) => a + x.mae, 0) / sub.length;
    console.log(`${label.padEnd(26)} n=${String(sub.length).padStart(4)} 胜率=${(100 * wins / sub.length).toFixed(1).padStart(5)}% 净=${net.toFixed(0).padStart(7)} 平均MFE=${mfe.toFixed(2)}R 平均MAE=${mae.toFixed(2)}R`);
  };

  console.log('\n=== 总体 ===');
  stat('全部', rows);
  stat('盈利单', rows.filter(x => x.net > 0));
  stat('亏损单', rows.filter(x => x.net <= 0));
  stat('多单', rows.filter(x => x.long));
  stat('空单', rows.filter(x => !x.long));

  console.log('\n=== 亏损单：入场后最大有利偏移(MFE) 分布 ===');
  const losers = rows.filter(x => x.net <= 0);
  const edges = [0, 0.1, 0.25, 0.5, 1.0, 2.0, Infinity];
  const labels = ['MFE≈0(从未盈利)', '0~0.25R', '0.25~0.5R', '0.5~1.0R', '1.0~2.0R', '>=2.0R'];
  for (let i = 0; i < labels.length; i++) {
    const sub = losers.filter(x => x.mfe >= edges[i] && x.mfe < edges[i + 1]);
    if (sub.length) console.log(`${labels[i].padEnd(18)} n=${String(sub.length).padStart(4)} 占比=${(100 * sub.length / losers.length).toFixed(1)}%`);
  }

  console.log('\n=== 按平仓原因 ===');
  for (const reason of ['stop_loss', 'take_profit', 'timeout']) {
    stat(reason, rows.filter(x => x.reason === reason));
  }

  console.log('\n=== 按周期 ===');
  stat('1m', rows.filter(x => x.interval === '1m'));
  stat('5m', rows.filter(x => x.interval === '5m'));

  console.log('\n=== 偏离MA20 (ATR) 分桶 ===');
  const extEdges = [-Infinity, -1.0, -0.5, 0, 0.5, 1.0, 1.5, Infinity];
  const extLabels = ['<-1.0', '-1.0~-0.5', '-0.5~0', '0~0.5', '0.5~1.0', '1.0~1.5', '>=1.5'];
  for (let i = 0; i < extLabels.length; i++) {
    stat(extLabels[i], rows.filter(x => x.ext >= extEdges[i] && x.ext < extEdges[i + 1]));
  }

  console.log('\n=== RSI 分桶 ===');
  const rsiEdges = [0, 30, 40, 50, 60, 70, 100];
  const rsiLabels = ['<30', '30-40', '40-50', '50-60', '60-70', '>=70'];
  for (let i = 0; i < rsiLabels.length; i++) {
    stat(rsiLabels[i], rows.filter(x => x.rsi != null && x.rsi >= rsiEdges[i] && x.rsi < rsiEdges[i + 1]));
  }

  console.log('\n=== 波动率 ATR/价格 分桶 ===');
  const volEdges = [0, 0.001, 0.0015, 0.0025, 0.004, Infinity];
  const volLabels = ['<0.10%', '0.10-0.15%', '0.15-0.25%', '0.25-0.40%', '>=0.40%'];
  for (let i = 0; i < volLabels.length; i++) {
    stat(volLabels[i], rows.filter(x => x.atrPct >= volEdges[i] && x.atrPct < volEdges[i + 1]));
  }

  console.log('\n=== 方向 x 偏离MA20 ===');
  for (const long of [true, false]) {
    for (let i = 0; i < extLabels.length; i++) {
      stat((long ? '多 ' : '空 ') + extLabels[i],
        rows.filter(x => x.long === long && x.ext >= extEdges[i] && x.ext < extEdges[i + 1]));
    }
  }

  // 核心结论：亏损单中"曾达到过 >=1R 浮盈"的比例
  const hadProfit = losers.filter(x => x.mfe >= 1.0).length;
  console.log(`\n=== 核心结论 ===`);
  console.log(`亏损单中曾出现 >=1R 浮盈的比例: ${(100 * hadProfit / losers.length).toFixed(1)}% (${hadProfit}/${losers.length})`);
  console.log(`亏损单中 MFE<0.25R（几乎一入场就逆行）比例: ${(100 * losers.filter(x => x.mfe < 0.25).length / losers.length).toFixed(1)}%`);

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
