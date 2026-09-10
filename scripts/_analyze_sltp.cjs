/**
 * 止损单「先盈利后亏损」量化分析
 * 只读 nofx_lite.simulated_orders + market_klines，不改任何数据。
 *
 * 定义：
 *   R  = 止损距离 = |entry - exit|（对 reason='stop_loss' 单，exit 即止损价）
 *   MFE = 入场后最大有利偏移（以 R 为单位；>0 表示该单曾浮盈）
 *   MAE = 入场后最大不利偏移（以 R 为单位）
 * 「先盈利后亏损」= reason='stop_loss' 且 MFE > 0（曾浮盈，最终仍被止损打掉）
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
const locate = (bars, t) => {
  if (!bars || !bars.length) return -1;
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
};

(async () => {
  const c = new Client(DB);
  await c.connect();

  const orders = (await c.query(`
    SELECT order_id, symbol, direction, interval, entry, exit, net, roi, held_bars,
           entry_at, exit_at, reason, leverage, margin
    FROM simulated_orders
    WHERE status='closed' AND reason='stop_loss' AND entry IS NOT NULL AND entry_at IS NOT NULL
    ORDER BY entry_at`)).rows;
  console.log('止损单总数:', orders.length);

  // 时间窗口 & 符号
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 40 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + 120 * 60000;
  const symbols = [...new Set(orders.map(o => o.symbol))];
  console.log('涉及符号数:', symbols.length, ' 时间跨度:', new Date(minT).toISOString(), '~', new Date(maxT).toISOString());

  // 解析每个 symbol 在 market_klines 里的真实 key
  const keyMap = new Map();
  for (const s of symbols) {
    const r = await c.query(`SELECT DISTINCT symbol FROM market_klines WHERE symbol=$1 OR symbol=$2`,
      ['OKX_PUBLIC_' + s, s]);
    const keys = r.rows.map(x => x.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0));
    keyMap.set(s, keys[0] || null);
  }

  const klineCache = new Map();
  const getBars = async (symbol, interval) => {
    const kkey = symbol + '|' + interval;
    if (klineCache.has(kkey)) return klineCache.get(kkey);
    const key = keyMap.get(symbol);
    let bars = [];
    if (key) {
      const r = await c.query(
        `SELECT open_time, open, high, low, close, volume FROM market_klines
         WHERE symbol=$1 AND interval=$2 AND open_time>=$3 AND open_time<=$4 ORDER BY open_time`,
        [key, interval, minT, maxT]);
      bars = r.rows.map(x => ({ openTime: Number(x.open_time), open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume }));
    }
    klineCache.set(kkey, bars);
    return bars;
  };

  let skippedNoKline = 0, skippedShort = 0, skippedNoR = 0;
  const rows = [];
  for (const o of orders) {
    const bars = await getBars(o.symbol, o.interval || '1m');
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) { skippedNoKline++; continue; }
    const before = bars.slice(0, idx);
    const a = atr14(before);
    if (!a || a <= 0) { skippedShort++; continue; }
    const entry = +o.entry;
    const long = o.direction === 'OPEN_LONG';
    const R = Math.abs(entry - (+o.exit));
    if (!R || !Number.isFinite(R) || R <= 0) { skippedNoR++; continue; }
    const horizon = Math.min(48, bars.length - idx);
    let mfe = 0, mae = 0, mfeBars = 0;
    for (let h = 0; h < horizon; h++) {
      const b = bars[idx + h];
      const fav = long ? (b.high - entry) / R : (entry - b.low) / R;
      const adv = long ? (entry - b.low) / R : (b.high - entry) / R;
      if (fav > mfe) { mfe = fav; mfeBars = h + 1; }
      if (adv > mae) { mae = adv; }
    }
    // 峰值浮盈净额（按 R 折算到 margin 量级）：notional = margin*leverage；peakNet ≈ mfe*R*notional/entry
    const notional = (+o.margin) * (+o.leverage || 1);
    const peakNet = mfe * R * notional / entry; // 正=曾浮盈金额
    rows.push({
      symbol: o.symbol, long, net: +o.net, roi: +o.roi, reason: o.reason,
      held: +o.held_bars, mfe, mae, mfeBars, R, peakNet,
      interval: o.interval || '1m'
    });
  }
  console.log('有效样本:', rows.length, ' 跳过(无K线/太短/无R):', skippedNoKline + skippedShort + skippedNoR,
    `(noKline=${skippedNoKline}, short=${skippedShort}, noR=${skippedNoR})`);

  const losers = rows; // 全部是 stop_loss
  const hadProfit = losers.filter(x => x.mfe > 0);          // 曾浮盈
  const hadProfit05 = losers.filter(x => x.mfe >= 0.5);     // 曾浮盈 >=0.5R
  const hadProfit1 = losers.filter(x => x.mfe >= 1.0);      // 曾浮盈 >=1R
  const hadProfit2 = losers.filter(x => x.mfe >= 2.0);      // 曾浮盈 >=2R
  const neverProfit = losers.filter(x => x.mfe <= 0);

  const sum = a => a.reduce((s, x) => s + x, 0);
  const sumNet = a => a.reduce((s, x) => s + x.net, 0);
  const sumPeak = a => a.reduce((s, x) => s + x.peakNet, 0);

  console.log('\n========== 止损单「先盈利后亏损」分析 ==========');
  console.log(`有效止损单 n=${losers.length}`);
  console.log(`  从未盈利 (MFE<=0)        : ${neverProfit.length}  (${(100*neverProfit.length/losers.length).toFixed(1)}%)  净=${sumNet(neverProfit).toFixed(1)}`);
  console.log(`  曾浮盈 (MFE>0)           : ${hadProfit.length}  (${(100*hadProfit.length/losers.length).toFixed(1)}%)  净=${sumNet(hadProfit).toFixed(1)}  峰值浮盈合计=${sumPeak(hadProfit).toFixed(1)}`);
  console.log(`  曾浮盈>=0.5R            : ${hadProfit05.length}  (${(100*hadProfit05.length/losers.length).toFixed(1)}%)  净=${sumNet(hadProfit05).toFixed(1)}  峰值浮盈合计=${sumPeak(hadProfit05).toFixed(1)}`);
  console.log(`  曾浮盈>=1R              : ${hadProfit1.length}  (${(100*hadProfit1.length/losers.length).toFixed(1)}%)  净=${sumNet(hadProfit1).toFixed(1)}  峰值浮盈合计=${sumPeak(hadProfit1).toFixed(1)}`);
  console.log(`  曾浮盈>=2R              : ${hadProfit2.length}  (${(100*hadProfit2.length/losers.length).toFixed(1)}%)  净=${sumNet(hadProfit2).toFixed(1)}  峰值浮盈合计=${sumPeak(hadProfit2).toFixed(1)}`);

  // 若把「曾浮盈>=X」的单改为「在峰值附近平掉」（上限估计，非实时可达成）
  console.log('\n--- 假设性上限：若这些单在峰值浮盈处平仓（非实时可达成，仅为上限）---');
  for (const [lab, subset] of [['曾浮盈>0', hadProfit], ['曾浮盈>=0.5R', hadProfit05], ['曾浮盈>=1R', hadProfit1]]) {
    const actualLoss = sumNet(subset);          // 实际净（负）
    const peakGain = sumPeak(subset);           // 峰值浮盈合计（正）
    console.log(`  ${lab}: 实际净=${actualLoss.toFixed(1)}  峰值浮盈上限=${peakGain.toFixed(1)}  「见浮盈即平」可挽回≈${(-actualLoss + peakGain).toFixed(1)}`);
  }

  // 一致性自检
  console.log('\n[自检] rows.length=%d  hadProfit(>0)=%d  neverProfit(<=0)=%d  和=%d',
    losers.length, hadProfit.length, neverProfit.length, hadProfit.length + neverProfit.length);

  // MFE 分布（区间与标签一一对应，避免错位）
  console.log('\n--- MFE 分布（占有效止损单）---');
  const buckets = [
    ['<=0 (从未盈利)', -Infinity, 0],
    ['(0, 0.1R]', 0, 0.1],
    ['(0.1, 0.25R]', 0.1, 0.25],
    ['(0.25, 0.5R]', 0.25, 0.5],
    ['(0.5, 1.0R]', 0.5, 1.0],
    ['(1.0, 2.0R]', 1.0, 2.0],
    ['(2.0R, +inf)', 2.0, Infinity]
  ];
  for (const [lab, lo, hi] of buckets) {
    const sub = losers.filter(x => x.mfe > lo && x.mfe <= hi);
    console.log(`  ${lab.padEnd(16)} n=${String(sub.length).padStart(4)} (${(100*sub.length/losers.length).toFixed(1)}%)`);
  }

  // 多/空分别
  console.log('\n--- 多/空分别 ---');
  for (const [lab, sub] of [['多单', rows.filter(x=>x.long)], ['空单', rows.filter(x=>!x.long)]]) {
    const hp = sub.filter(x=>x.mfe>0).length;
    console.log(`  ${lab}: n=${sub.length}  曾浮盈=${hp} (${(100*hp/sub.length).toFixed(1)}%)  净=${sumNet(sub).toFixed(1)}`);
  }

  // 按周期
  console.log('\n--- 按周期 ---');
  for (const iv of ['1m','5m','15m']) {
    const sub = rows.filter(x=>x.interval===iv);
    if (!sub.length) continue;
    const hp = sub.filter(x=>x.mfe>0).length;
    console.log(`  ${iv}: n=${sub.length}  曾浮盈=${hp} (${(100*hp/sub.length).toFixed(1)}%)  净=${sumNet(sub).toFixed(1)}`);
  }

  await c.end();
})().catch(e => { console.error('ERR', e); process.exit(1); });
