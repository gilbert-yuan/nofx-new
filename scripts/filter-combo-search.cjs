/**
 * P5 过滤器组合搜索 + 样本外验证（只读数据库）
 *
 * 目的：P4 之后仍净亏（胜率 21.7%、均单 -1.23）。本轮诊断出新事实：
 *   1. MFE 诊断：亏损单出场前平均只走到 0.33R，38.8% 连 0.1R 都到不了
 *      → 亏损主因是「入场就错」，不是「止损太紧」（V5 把止损放到 3ATR 反而更差）
 *   2. 83.2% 的订单死于 stop_loss，其胜率仅 11.7%
 *   3. 波动率(ATR/价格) 与结果单调：<0.10% 胜率 14.9%/均 -2.55；>=0.50% 胜率 38.8%/均 -0.29
 *   4. 量比 >1.2（放量追势）胜率反而更差 → 追势入场有害
 *
 * 本脚本：对候选过滤器做单因子 / 组合搜索，并用「时间切分样本外」验证稳健性，
 * 避免像 P4 那样在全体样本上调参过拟合。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const FEE_BPS = 6, SLIP_BPS = 5, FUNDING_BPS_8H = 3, MAX_HOLD = 120;

function atr14(bars) {
  if (bars.length < 15) return null;
  let s = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  return s / 14;
}
const ma20 = b => b.length < 20 ? null : b.slice(-20).reduce((a, x) => a + x.close, 0) / 20;
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
function settle(dir, entry, rawExit, margin, leverage, held) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const notional = margin * leverage;
  const qty = notional / entry;
  const gross = dir * (exit - entry) * qty;
  const net = gross - notional * FEE_BPS / 10000 - exit * qty * FEE_BPS / 10000
    - notional * FUNDING_BPS_8H / 10000 * held * 60000 / 28800000;
  return Math.max(net, -margin - notional * FEE_BPS / 10000);
}
/** 与线上 enhancedAnalysis 当前规则一致的回放（2ATR 止损 / 2R 止盈 / 顺势 1.5ATR 移动） */
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
      return { net: settle(dir, entry, p, o.margin, o.leverage, held), reason: 'stop_loss', held };
    }
    if (long ? row.high >= tp : row.low >= tp || false) { /* noop */ }
    if (long ? row.high >= tp : row.low <= tp) {
      return { net: settle(dir, entry, tp, o.margin, o.leverage, held), reason: 'take_profit', held };
    }
    if (held > 0 && held % 5 === 0) {
      const a = atr14(bars.slice(0, startIdx + held + 1));
      const profit = long ? (row.close - entry) / entry : (entry - row.close) / entry;
      if (a > 0 && profit > 0.02) {
        stop = long ? Math.max(stop, entry + 0.2 * a, row.close - 1.5 * a) : Math.min(stop, entry - 0.2 * a, row.close + 1.5 * a);
      }
    }
  }
  const last = bars[Math.min(startIdx + MAX_HOLD, bars.length) - 1];
  return { net: settle(dir, entry, last.close, o.margin, o.leverage, MAX_HOLD), reason: 'timeout', held: MAX_HOLD };
}

const stat = rows => {
  if (!rows.length) return null;
  const wins = rows.filter(x => x.net > 0).length;
  const net = rows.reduce((a, x) => a + x.net, 0);
  return { n: rows.length, wr: 100 * wins / rows.length, net, avg: net / rows.length };
};
const fmt = (lb, s) => s
  ? `${lb.padEnd(34)} n=${String(s.n).padStart(4)} 胜率=${s.wr.toFixed(1).padStart(5)}% 净=${s.net.toFixed(0).padStart(6)} 均单=${s.avg.toFixed(3)}`
  : `${lb.padEnd(34)} 无样本`;

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, entry, entry_at, exit_at, leverage, margin, created_at
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL AND leverage>0
    ORDER BY entry_at`)).rows;

  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 22 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + (MAX_HOLD + 10) * 60000;
  const symbols = [...new Set(orders.map(o => o.symbol))];
  const klineMap = new Map();
  for (const symbol of symbols) {
    const k = await c.query(`SELECT symbol FROM (SELECT DISTINCT symbol FROM market_klines WHERE interval='1m') t WHERE symbol=$1 OR symbol=$2`, ['OKX_PUBLIC_' + symbol, symbol]);
    const key = k.rows.map(r => r.symbol).sort((a, b) => (b.startsWith('OKX_PUBLIC_') ? 1 : 0) - (a.startsWith('OKX_PUBLIC_') ? 1 : 0))[0];
    if (!key) { klineMap.set(symbol, []); continue; }
    const rows = await c.query(`SELECT open_time,open,high,low,close,volume FROM market_klines WHERE symbol=$1 AND interval='1m' AND open_time>=$2 AND open_time<=$3 ORDER BY open_time`, [key, minT, maxT]);
    klineMap.set(symbol, rows.rows.map(r => ({ openTime: +r.open_time, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume })));
  }
  const locate = (bars, t) => {
    if (!bars?.length) return -1;
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].openTime >= t) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  const S = [];
  for (const o of orders) {
    const bars = klineMap.get(o.symbol);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const a = atr14(before), m = ma20(before);
    if (!a || !m || a <= 0) continue;
    const r = replay(o, bars, idx);
    if (!r) continue;
    S.push({
      net: r.net, reason: r.reason, held: r.held,
      long: o.direction === 'OPEN_LONG',
      vol: a / o.entry,                        // 波动率
      ext: (before.at(-1).close - m) / a,      // 偏离 MA20
      rsi: rsi14(before),
      vr: volRatio(before),
      hour: new Date(Date.parse(o.entry_at)).getUTCHours(),
      t: Date.parse(o.entry_at),
      symbol: o.symbol
    });
  }
  S.sort((x, y) => x.t - y.t);
  console.log(`样本 ${S.length} 笔 | ${new Date(S[0].t).toLocaleString()} ~ ${new Date(S.at(-1).t).toLocaleString()}`);
  console.log(fmt('【全体基线】', stat(S)));

  // ---------- 单因子 ----------
  console.log('\n===== 单因子（阈值扫描，找拐点）=====');
  const SCANS = [
    ['波动率 vol >=', [0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005], v => x => x.vol >= v],
    ['量比 vr <=',     [0.7, 0.8, 1.0, 1.2, 1.5],                            v => x => x.vr != null && x.vr <= v],
    ['量比 vr >',      [1.0, 1.2, 1.5, 1.8],                                 v => x => x.vr != null && x.vr > v],
    ['RSI >=',         [30, 35, 40, 45, 50],                                 v => x => x.rsi != null && x.rsi >= v],
    ['偏离 |ext| <=',  [0.5, 0.8, 1.0, 1.5, 2.0],                            v => x => Math.abs(x.ext) <= v],
  ];
  for (const [name, vals, make] of SCANS) {
    console.log(`--- ${name} 阈值 ---`);
    for (const v of vals) console.log(fmt(`  ${name} ${v}`, stat(S.filter(make(v)))));
  }

  // ---------- 组合搜索 ----------
  console.log('\n===== 组合搜索（波动率 x 量比 x RSI）=====');
  const combos = [];
  for (const volMin of [0, 0.0015, 0.002, 0.0025, 0.003])
    for (const vrMax of [Infinity, 0.8, 1.0, 1.2])
      for (const rsiMin of [0, 30, 35, 40])
        for (const extMax of [Infinity, 1.0, 1.5])
          combos.push({ volMin, vrMax, rsiMin, extMax });

  const evalCombo = (rows, cb) => stat(rows.filter(x =>
    x.vol >= cb.volMin && (cb.vrMax === Infinity || (x.vr != null && x.vr <= cb.vrMax))
    && (cb.rsiMin === 0 || (x.rsi != null && x.rsi >= cb.rsiMin))
    && (cb.extMax === Infinity || Math.abs(x.ext) <= cb.extMax)));

  const scored = combos.map(cb => ({ cb, s: evalCombo(S, cb) }))
    .filter(x => x.s && x.s.n >= 150)
    .sort((a, b) => b.s.avg - a.s.avg);
  scored.slice(0, 12).forEach(x => console.log(fmt(
    `vol>=${(100 * x.cb.volMin).toFixed(2)}% vr<=${x.cb.vrMax} rsi>=${x.cb.rsiMin} |ext|<=${x.cb.extMax}`, x.s)));

  // ---------- 样本外验证（前 60% 训练 / 后 40% 测试）----------
  const cut = S[Math.floor(S.length * 0.6)].t;
  const TR = S.filter(x => x.t < cut), TE = S.filter(x => x.t >= cut);
  console.log(`\n===== 样本外验证（训练 ${TR.length} / 测试 ${TE.length}）=====`);
  console.log(fmt('训练集基线', stat(TR)));
  console.log(fmt('测试集基线', stat(TE)));
  console.log('--- 在训练集上最优的 8 个组合，在测试集上的表现 ---');
  const trScored = combos.map(cb => ({ cb, s: evalCombo(TR, cb) }))
    .filter(x => x.s && x.s.n >= 120).sort((a, b) => b.s.avg - a.s.avg).slice(0, 8);
  for (const { cb, s } of trScored) {
    console.log(fmt(`[训练] vol>=${(100 * cb.volMin).toFixed(2)}% vr<=${cb.vrMax} rsi>=${cb.rsiMin} |ext|<=${cb.extMax}`, s));
    console.log(fmt(`[测试] 同组合`, evalCombo(TE, cb)));
  }

  // ---------- 候选方案的稳健性（全样本 / 训练 / 测试 三段）----------
  const CAND = [
    { name: 'A 仅波动率>=0.25%',            f: x => x.vol >= 0.0025 },
    { name: 'B 仅波动率>=0.40%',            f: x => x.vol >= 0.004 },
    { name: 'C 波动率>=0.25% + 量比<=1.2',  f: x => x.vol >= 0.0025 && x.vr != null && x.vr <= 1.2 },
    { name: 'D 波动率>=0.25% + |ext|<=1.0', f: x => x.vol >= 0.0025 && Math.abs(x.ext) <= 1.0 },
    { name: 'E 波动率>=0.25% + RSI>=35',    f: x => x.vol >= 0.0025 && x.rsi != null && x.rsi >= 35 },
    { name: 'F vol>=0.25%+vr<=1.2+|ext|<=1.0', f: x => x.vol >= 0.0025 && x.vr != null && x.vr <= 1.2 && Math.abs(x.ext) <= 1.0 },
  ];
  console.log('\n===== 候选方案三段稳健性 =====');
  for (const { name, f } of CAND) {
    const a = stat(S.filter(f)), b = stat(TR.filter(f)), d = stat(TE.filter(f));
    console.log(`${name}`);
    console.log(`   全样本 ${fmt('', a)}`);
    console.log(`   训练集 ${fmt('', b)}`);
    console.log(`   测试集 ${fmt('', d)}`);
  }

  // ---------- 通过率（对交易频率的影响）----------
  console.log('\n===== 对交易频率的影响 =====');
  for (const { name, f } of CAND) {
    const pass = S.filter(f).length;
    console.log(`${name.padEnd(34)} 保留 ${pass}/${S.length} = ${(100 * pass / S.length).toFixed(1)}%`);
  }

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
