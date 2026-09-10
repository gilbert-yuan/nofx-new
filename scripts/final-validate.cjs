/**
 * P5 第三轮：锁定候选方案的精细验证（只读数据库）
 *
 * 前两轮结论：
 *  - 多因子组合过拟合，弃用
 *  - 稳健因子1：波动率 ATR/价格 >= 0.40%（保留 34.6%，训练/测试双改善）
 *  - 稳健因子2：移动止损触发从 1.0R 提前到 0.5R（胜率 +11.5pt，训练/测试双改善）
 *  - 出场端「止盈 3R / 移动止损」改善的是测试段，训练段反而变差 → 需谨慎
 *
 * 本轮：
 *  1. 移动触发阈值精细扫描（0.2R~1.0R），确认 0.5R 附近是否存在平台
 *  2. 移动止损距离 trailAtr 扫描
 *  3. 波动率阈值 0.40% vs 0.50% vs 0.60% 的取舍（保留率 vs 均单）
 *  4. 逐小时/逐币种稳健性检查，确认不是少数币种撑起来的
 *  5. 最终方案与「当前线上参数」的对照（含 90% 置信区间估计，用 bootstrap）
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
function settle(dir, entry, rawExit, margin, leverage, held) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const notional = margin * leverage;
  const qty = notional / entry;
  const gross = dir * (exit - entry) * qty;
  const net = gross - notional * FEE_BPS / 10000 - exit * qty * FEE_BPS / 10000
    - notional * FUNDING_BPS_8H / 10000 * held * 60000 / 28800000;
  return Math.max(net, -margin - notional * FEE_BPS / 10000);
}
function replay(cfg, o, bars, idx, atr) {
  const long = o.direction === 'OPEN_LONG';
  const dir = long ? 1 : -1;
  const entry = o.entry;
  const ru = Math.max(cfg.stopR * atr, entry * 0.008);
  const tp = long ? entry + cfg.tpR * ru : entry - cfg.tpR * ru;
  let stop = long ? entry - ru : entry + ru;
  for (let h = 0; h < cfg.maxHoldBars && idx + h < bars.length; h++) {
    const b = bars[idx + h];
    const hitStop = long ? b.low <= stop : b.high >= stop;
    const hitTp = long ? b.high >= tp : b.low <= tp;
    if (hitStop && hitTp) {
      const beyond = long ? b.open >= tp : b.open <= tp;
      if (beyond) return { net: settle(dir, entry, tp, o.margin, o.leverage, h), reason: 'take_profit', held: h };
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { net: settle(dir, entry, sp, o.margin, o.leverage, h), reason: 'stop_loss', held: h };
    }
    if (hitStop) {
      const sp = long ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return { net: settle(dir, entry, sp, o.margin, o.leverage, h), reason: 'stop_loss', held: h };
    }
    if (hitTp) return { net: settle(dir, entry, tp, o.margin, o.leverage, h), reason: 'take_profit', held: h };
    const profR = (long ? b.close - entry : entry - b.close) / ru;
    if (cfg.trailTriggerR != null && profR >= cfg.trailTriggerR) {
      const trail = long ? b.close - cfg.trailAtr * atr : b.close + cfg.trailAtr * atr;
      const be = long ? entry + (cfg.beAtR || 0) * ru : entry - (cfg.beAtR || 0) * ru;
      stop = long ? Math.max(stop, trail, be) : Math.min(stop, trail, be);
    }
  }
  const last = bars[Math.min(idx + cfg.maxHoldBars, bars.length) - 1];
  return { net: settle(dir, entry, last.close, o.margin, o.leverage, cfg.maxHoldBars), reason: 'timeout', held: cfg.maxHoldBars };
}
const stat = rows => {
  if (!rows.length) return null;
  const wins = rows.filter(x => x.net > 0).length;
  const net = rows.reduce((a, x) => a + x.net, 0);
  return { n: rows.length, wr: 100 * wins / rows.length, net, avg: net / rows.length };
};
const fmt = (lb, s) => s
  ? `${lb.padEnd(26)} n=${String(s.n).padStart(4)} 胜率=${s.wr.toFixed(1).padStart(5)}% 净=${s.net.toFixed(0).padStart(6)} 均单=${s.avg.toFixed(3)}`
  : `${lb.padEnd(26)} 无样本`;
/** bootstrap 均单 95% 置信区间（判断「与 0 无显著差异」还是「显著为负」）*/
function bootAvg(rows, iter = 600) {
  if (rows.length < 20) return null;
  const v = rows.map(x => x.net);
  const out = [];
  for (let i = 0; i < iter; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[(Math.random() * v.length) | 0];
    out.push(s / v.length);
  }
  out.sort((a, b) => a - b);
  return { lo: out[(0.025 * iter) | 0], hi: out[(0.975 * iter) | 0] };
}

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, entry, entry_at, exit_at, leverage, margin
    FROM simulated_orders WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL AND leverage>0
    ORDER BY entry_at`)).rows;
  const MAXH = 120;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 22 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + (MAXH + 10) * 60000;
  const symbols = [...new Set(orders.map(o => o.symbol))];
  const km = new Map();
  for (const symbol of symbols) {
    const k = await c.query(`SELECT symbol FROM (SELECT DISTINCT symbol FROM market_klines WHERE interval='1m') t WHERE symbol=$1 OR symbol=$2`, ['OKX_PUBLIC_' + symbol, symbol]);
    const key = k.rows.map(r => r.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0];
    if (!key) { km.set(symbol, []); continue; }
    const rows = await c.query(`SELECT open_time,open,high,low,close,volume FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time>=$2 AND open_time<=$3 ORDER BY open_time`, [key, minT, maxT]);
    km.set(symbol, rows.rows.map(r => ({ openTime: +r.open_time, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })));
  }
  const locate = (bars, t) => {
    if (!bars?.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };
  const S = [];
  for (const o of orders) {
    const bars = km.get(o.symbol);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const atr = atr14(bars.slice(0, idx));
    if (!atr || atr <= 0) continue;
    S.push({ o, bars, idx, atr, vol: atr / o.entry, t: Date.parse(o.entry_at), symbol: o.symbol });
  }
  S.sort((a, b) => a.t - b.t);
  const cut = S[Math.floor(S.length * 0.6)].t;
  const TR = S.filter(x => x.t < cut), TE = S.filter(x => x.t >= cut);
  console.log(`样本 ${S.length}（训练 ${TR.length} / 测试 ${TE.length}）`);

  const CUR = { stopR: 2, tpR: 2, trailTriggerR: 1.0, trailAtr: 1.5, beAtR: 0.2, maxHoldBars: 120 };
  const HI = S.filter(s => s.vol >= 0.004), HI_TR = TR.filter(s => s.vol >= 0.004), HI_TE = TE.filter(s => s.vol >= 0.004);

  console.log('\n===== 1. 移动止损触发阈值精细扫描（子集 vol>=0.40%）=====');
  for (const tr of [null, 1.0, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2]) {
    const cfg = { ...CUR, trailTriggerR: tr };
    const run = arr => stat(arr.map(s => replay(cfg, s.o, s.bars, s.idx, s.atr)));
    console.log(`触发=${tr === null ? '关闭' : tr + 'R'}`.padEnd(14) + ` | 训练 ${fmt('', run(HI_TR))}`);
    console.log(`${''.padEnd(14)} | 测试 ${fmt('', run(HI_TE))}`);
  }

  console.log('\n===== 2. 移动止损距离 trailAtr 扫描（触发 0.5R）=====');
  for (const ta of [0.8, 1.0, 1.5, 2.0, 2.5]) {
    const cfg = { ...CUR, trailTriggerR: 0.5, trailAtr: ta };
    const run = arr => stat(arr.map(s => replay(cfg, s.o, s.bars, s.idx, s.atr)));
    console.log(`trailAtr=${ta}`.padEnd(14) + ` | 训练 ${fmt('', run(HI_TR))}`);
    console.log(`${''.padEnd(14)} | 测试 ${fmt('', run(HI_TE))}`);
  }

  console.log('\n===== 3. 波动率阈值取舍（配置=触发0.5R/trailAtr1.5/止盈3R）=====');
  const BEST = { ...CUR, trailTriggerR: 0.5, trailAtr: 1.5, tpR: 3 };
  for (const v of [0.003, 0.004, 0.005, 0.006, 0.008]) {
    const run = arr => stat(arr.filter(s => s.vol >= v).map(s => replay(BEST, s.o, s.bars, s.idx, s.atr)));
    const keep = (100 * S.filter(s => s.vol >= v).length / S.length).toFixed(1);
    console.log(`vol>=${(100 * v).toFixed(1)}% 保留${keep.padStart(5)}%`.padEnd(26) + ` | 训练 ${fmt('', run(TR))}`);
    console.log(`${''.padEnd(26)} | 测试 ${fmt('', run(TE))}`);
  }

  console.log('\n===== 4. 稳健性：按方向 / 按小时段 =====');
  const runBest = arr => stat(arr.map(s => replay(BEST, s.o, s.bars, s.idx, s.atr)));
  const runCur = arr => stat(arr.map(s => replay(CUR, s.o, s.bars, s.idx, s.atr)));
  console.log('-- 方向（子集 vol>=0.40%）--');
  console.log(fmt('多单 现状', runCur(HI.filter(s => s.o.direction === 'OPEN_LONG'))));
  console.log(fmt('多单 新方案', runBest(HI.filter(s => s.o.direction === 'OPEN_LONG'))));
  console.log(fmt('空单 现状', runCur(HI.filter(s => s.o.direction === 'OPEN_SHORT'))));
  console.log(fmt('空单 新方案', runBest(HI.filter(s => s.o.direction === 'OPEN_SHORT'))));
  console.log('-- 时段（UTC，子集 vol>=0.40%）--');
  for (const [lb, lo, hi] of [['UTC 0-3', 0, 4], ['UTC 4-7', 4, 8], ['UTC 8-11', 8, 12], ['UTC 12-15', 12, 16], ['UTC 16-19', 16, 20], ['UTC 20-23', 20, 24]]) {
    const sub = HI.filter(s => { const h = new Date(s.t).getUTCHours(); return h >= lo && h < hi; });
    console.log(`${lb}`.padEnd(10) + ` 现状 ${fmt('', runCur(sub))}`);
    console.log(`${''.padEnd(10)} 新方案 ${fmt('', runBest(sub))}`);
  }

  console.log('\n===== 5. 最终对照 + bootstrap 95%CI（均单）=====');
  const finals = [
    ['现状（全部订单）', CUR, () => true],
    ['现状（vol>=0.40%）', CUR, s => s.vol >= 0.004],
    ['新方案（全部订单）', BEST, () => true],
    ['新方案（vol>=0.40%）', BEST, s => s.vol >= 0.004],
    ['新方案（vol>=0.50%）', BEST, s => s.vol >= 0.005],
  ];
  for (const [name, cfg, f] of finals) {
    const rows = S.filter(f).map(s => replay(cfg, s.o, s.bars, s.idx, s.atr));
    const s = stat(rows), ci = bootAvg(rows);
    console.log(`${name.padEnd(22)} n=${String(s.n).padStart(4)} 胜率=${s.wr.toFixed(1)}% 均单=${s.avg.toFixed(3)} 95%CI=[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] 保留${(100 * rows.length / S.length).toFixed(1)}%`);
  }

  console.log('\n===== 6. 币种集中度检查（新方案 vol>=0.40% 的净盈亏贡献）=====');
  const rows = HI.map(s => ({ ...replay(BEST, s.o, s.bars, s.idx, s.atr), symbol: s.symbol }));
  const bySym = new Map();
  for (const r of rows) { const a = bySym.get(r.symbol) || { n: 0, net: 0, w: 0 }; a.n++; a.net += r.net; if (r.net > 0) a.w++; bySym.set(r.symbol, a); }
  const arr = [...bySym.entries()].sort((a, b) => a[1].net - b[1].net);
  console.log(`参与币种 ${arr.length} 个；最差 8 个：`);
  arr.slice(0, 8).forEach(([s2, a]) => console.log(`  ${s2}: ${a.n} 单 胜率${(100 * a.w / a.n).toFixed(0)}% 净${a.net.toFixed(1)}`));
  console.log(`最好 8 个：`);
  arr.slice(-8).reverse().forEach(([s2, a]) => console.log(`  ${s2}: ${a.n} 单 胜率${(100 * a.w / a.n).toFixed(0)}% 净${a.net.toFixed(1)}`));

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
