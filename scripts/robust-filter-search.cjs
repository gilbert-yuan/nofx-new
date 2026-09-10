/**
 * P5 第二轮验证：稳健单因子 + 出场端改进的交叉验证（只读数据库）
 *
 * 第一轮结论：
 *  - 多因子组合在时间切分样本外严重衰减（训练均单 +0.46 → 测试 -0.29）→ 判定为过拟合，不可用
 *  - 单因子「波动率 ATR/价格 >= 0.40%」是唯一在训练/测试两段都改善的稳健因子
 *  - 亏损主因是「入场就错」（亏损单出场前 MFE 仅 0.33R），不是止损太紧
 *
 * 本轮要回答三个问题：
 *  1. 波动率阈值扫描找稳健拐点（训练/测试两段同时改善的最大通过率点）
 *  2. 出场端：把 2R 止盈改成「让盈利单跑」（更高止盈 + 移动止损），能否利用盈利单 MFE 1.91R 的优势
 *  3. 噪声带剔除（vol < 0.15%）的独立价值
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
const ma20 = b => b.length < 20 ? null : b.slice(-20).reduce((a, x) => a + x.close, 0) / 20;
function settle(dir, entry, rawExit, margin, leverage, held) {
  const exit = rawExit * (1 - dir * SLIP_BPS / 10000);
  const notional = margin * leverage;
  const qty = notional / entry;
  const gross = dir * (exit - entry) * qty;
  const net = gross - notional * FEE_BPS / 10000 - exit * qty * FEE_BPS / 10000
    - notional * FUNDING_BPS_8H / 10000 * held * 60000 / 28800000;
  return Math.max(net, -margin - notional * FEE_BPS / 10000);
}
/** cfg: { stopR, tpR, trailTriggerR, trailAtr, beAtR, maxHoldBars } 基准单位 = ATR（与线上一致）*/
function replay(cfg, o, bars, idx, atr) {
  const long = o.direction === 'OPEN_LONG';
  const dir = long ? 1 : -1;
  const entry = o.entry;
  const ru = Math.max(cfg.stopR * atr, entry * 0.008);
  const tpDist = cfg.tpR * ru;
  let stop = long ? entry - ru : entry + ru;
  const tp = long ? entry + tpDist : entry - tpDist;
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
  ? `${lb.padEnd(30)} n=${String(s.n).padStart(4)} 胜率=${s.wr.toFixed(1).padStart(5)}% 净=${s.net.toFixed(0).padStart(6)} 均单=${s.avg.toFixed(3)}`
  : `${lb.padEnd(30)} 无样本`;

async function main() {
  const c = new Client(DB);
  await c.connect();
  const orders = (await c.query(`
    SELECT order_id, symbol, direction, entry, entry_at, exit_at, leverage, margin
    FROM simulated_orders
    WHERE status='closed' AND entry IS NOT NULL AND entry_at IS NOT NULL AND leverage>0
    ORDER BY entry_at`)).rows;

  const MAXH = 120;
  const minT = Math.min(...orders.map(o => Date.parse(o.entry_at))) - 22 * 60000;
  const maxT = Math.max(...orders.map(o => Date.parse(o.exit_at ?? o.entry_at))) + (MAXH + 10) * 60000;
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

  // 预组装样本（只算一次 ATR/特征）
  const S = [];
  for (const o of orders) {
    const bars = klineMap.get(o.symbol);
    const idx = locate(bars, Date.parse(o.entry_at));
    if (idx < 22 || idx >= bars.length) continue;
    const before = bars.slice(0, idx);
    const atr = atr14(before);
    if (!atr || atr <= 0) continue;
    S.push({ o, bars, idx, atr, vol: atr / o.entry, t: Date.parse(o.entry_at) });
  }
  S.sort((a, b) => a.t - b.t);
  const cut = S[Math.floor(S.length * 0.6)].t;
  const TR = S.filter(x => x.t < cut), TE = S.filter(x => x.t >= cut);
  console.log(`样本 ${S.length}（训练 ${TR.length} / 测试 ${TE.length}）`);

  const BASE = { stopR: 2, tpR: 2, trailTriggerR: 1.0, trailAtr: 1.5, beAtR: 0.2, maxHoldBars: 120 };

  // ---------- 1. 波动率阈值扫描（三段）----------
  console.log('\n===== 1. 波动率阈值扫描（训练/测试须同时改善才算稳健）=====');
  console.log(fmt('全样本基线', stat(S.map(s => replay(BASE, s.o, s.bars, s.idx, s.atr)))));
  for (const v of [0.001, 0.0015, 0.002, 0.0025, 0.003, 0.0035, 0.004, 0.0045, 0.005, 0.006]) {
    const run = arr => stat(arr.filter(s => s.vol >= v).map(s => replay(BASE, s.o, s.bars, s.idx, s.atr)));
    const kept = (100 * S.filter(s => s.vol >= v).length / S.length).toFixed(1);
    console.log(`vol>=${(100 * v).toFixed(2)}% 保留${kept.padStart(5)}% | 训练 ${fmt('', run(TR))}`);
    console.log(`                            | 测试 ${fmt('', run(TE))}`);
  }

  // ---------- 2. 出场参数（在 vol>=0.40% 稳健子集上）----------
  console.log('\n===== 2. 出场参数实验（子集 vol>=0.40%，训练/测试分别看）=====');
  const SUB = { TR: TR.filter(s => s.vol >= 0.004), TE: TE.filter(s => s.vol >= 0.004) };
  console.log(`子集规模：训练 ${SUB.TR.length} / 测试 ${SUB.TE.length}`);
  const EXITS = [
    ['基准 2R止盈/1R触发1.5ATR移动', { ...BASE }],
    ['止盈 3R',                    { ...BASE, tpR: 3 }],
    ['止盈 4R',                    { ...BASE, tpR: 4 }],
    ['止盈 6R(几乎只靠移动止损)',   { ...BASE, tpR: 6 }],
    ['止盈 1.5R',                  { ...BASE, tpR: 1.5 }],
    ['移动触发降到 0.5R',           { ...BASE, trailTriggerR: 0.5 }],
    ['移动触发 0.5R + 3R止盈',      { ...BASE, trailTriggerR: 0.5, tpR: 3 }],
    ['移动触发 0.5R + 全移动',      { ...BASE, trailTriggerR: 0.5, tpR: 10, trailAtr: 2.0 }],
    ['保本 0.3R + 3R止盈',          { ...BASE, beAtR: 0.3, tpR: 3 }],
    ['止损 1.5ATR',                { ...BASE, stopR: 1.5 }],
    ['止损 2.5ATR',                { ...BASE, stopR: 2.5 }],
    ['最大持仓 60 根',              { ...BASE, maxHoldBars: 60 }],
    ['最大持仓 240 根',             { ...BASE, maxHoldBars: 240 }],
  ];
  for (const [name, cfg] of EXITS) {
    const run = arr => stat(arr.map(s => replay(cfg, s.o, s.bars, s.idx, s.atr)));
    console.log(`${name.padEnd(30)} | 训练 ${fmt('', run(SUB.TR))}`);
    console.log(`${''.padEnd(30)} | 测试 ${fmt('', run(SUB.TE))}`);
  }

  // ---------- 3. 噪声带剔除的独立价值 ----------
  console.log('\n===== 3. 噪声带剔除（vol < 0.15% 单独看有多差）=====');
  const runBase = arr => stat(arr.map(s => replay(BASE, s.o, s.bars, s.idx, s.atr)));
  console.log(fmt('vol<0.15%（噪声带）', runBase(S.filter(s => s.vol < 0.0015))));
  console.log(fmt('0.15%~0.40%（过渡带）', runBase(S.filter(s => s.vol >= 0.0015 && s.vol < 0.004))));
  console.log(fmt('>=0.40%（高波动带）', runBase(S.filter(s => s.vol >= 0.004))));

  // ---------- 4. 最终候选：方案B + 最优出场 ----------
  console.log('\n===== 4. 最终候选方案（vol>=0.40% + 各出场组合，全样本/训练/测试）=====');
  const FINAL = [
    ['F1 vol>=0.40% + 基准出场', BASE, s => s.vol >= 0.004],
    ['F2 vol>=0.40% + 止盈3R', { ...BASE, tpR: 3 }, s => s.vol >= 0.004],
    ['F3 vol>=0.40% + 触发0.5R+3R', { ...BASE, trailTriggerR: 0.5, tpR: 3 }, s => s.vol >= 0.004],
    ['F4 vol>=0.30% + 基准出场', BASE, s => s.vol >= 0.003],
  ];
  for (const [name, cfg, f] of FINAL) {
    console.log(name);
    console.log(`   全样本 ${fmt('', stat(S.filter(f).map(s => replay(cfg, s.o, s.bars, s.idx, s.atr))))}`);
    console.log(`   训练集 ${fmt('', stat(TR.filter(f).map(s => replay(cfg, s.o, s.bars, s.idx, s.atr))))}`);
    console.log(`   测试集 ${fmt('', stat(TE.filter(f).map(s => replay(cfg, s.o, s.bars, s.idx, s.atr))))}`);
    console.log(`   保留率 ${(100 * S.filter(f).length / S.length).toFixed(1)}%`);
  }

  await c.end();
}
main().catch(e => { console.error('ERR', e); process.exit(1); });
