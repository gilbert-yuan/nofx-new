import fs from 'node:fs';
import path from 'node:path';
const DIR = path.resolve('data/backtest');

function load(f) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  return { cfg: j.config, trades: j.trades, placed: j.placed, cancels: j.cancels };
}
const stats = (rows) => {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter(r => r.net > 0).length;
  const net = rows.reduce((s, r) => s + r.net, 0);
  const gross = rows.reduce((s, r) => s + r.gross, 0);
  const fee = rows.reduce((s, r) => s + r.fee, 0);
  const held = rows.reduce((s, r) => s + r.heldBars, 0) / n;
  return { n, wr: 100 * wins / n, net, avg: net / n, gross, fee, held, pf: (() => { const g = rows.filter(r => r.net > 0).reduce((s, r) => s + r.net, 0); const l = Math.abs(rows.filter(r => r.net <= 0).reduce((s, r) => s + r.net, 0)); return l ? g / l : Infinity; })() };
};
const fmt = (label, s) => {
  if (!s || !s.n) return `${label.padEnd(26)}    0单`;
  return `${label.padEnd(26)} ${String(s.n).padStart(4)}单 胜率${s.wr.toFixed(1).padStart(5)}% 净${s.net.toFixed(1).padStart(8)} 均单${s.avg.toFixed(3).padStart(8)} 毛${s.gross.toFixed(1).padStart(8)} 费${s.fee.toFixed(1).padStart(6)} 持仓${s.held.toFixed(1).padStart(5)} PF${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}`;
};

const file = process.argv[2] || 'r70.json';
const { cfg, trades, placed, cancels } = load(file);
console.log(`\n#### ${file}  cfg=${JSON.stringify(cfg)}`);
console.log(`挂单${placed.length} 撤单${cancels.length} 成交${trades.length}`);
console.log(fmt('全部', stats(trades)));

console.log('\n-- A. 按 atrPct（入场波动率）--');
const aB = [0.002, 0.003, 0.004, 0.005, 0.007, 0.01, 0.02];
let prev = 0;
for (const b of aB) { console.log(fmt(`atrPct ${prev.toFixed(3)}~${b.toFixed(3)}`, stats(trades.filter(t => t.atrPct >= prev && t.atrPct < b)))); prev = b; }
console.log(fmt(`atrPct >=${prev}`, stats(trades.filter(t => t.atrPct >= prev))));

console.log('\n-- B. 按 score --');
for (const [lo, hi] of [[70, 75], [75, 80], [80, 85], [85, 90], [90, 100]]) {
  console.log(fmt(`score ${lo}~${hi}`, stats(trades.filter(t => t.score >= lo && t.score < hi))));
}

console.log('\n-- C. 按杠杆 --');
[5, 4, 3, 2, 1].forEach(l => console.log(fmt(`lev ${l}`, stats(trades.filter(t => t.leverage === l)))));

console.log('\n-- D. 按持仓时长 --');
for (const [lo, hi] of [[0, 5], [5, 15], [15, 30], [30, 45], [45, 60], [60, 500]]) {
  console.log(fmt(`held ${lo}~${hi}`, stats(trades.filter(t => t.heldBars >= lo && t.heldBars < hi))));
}

console.log('\n-- E. 按出场原因 --');
const reasons = [...new Set(trades.map(t => t.reason))];
reasons.forEach(r => console.log(fmt(r, stats(trades.filter(t => t.reason === r)))));

console.log('\n-- F. 分批止盈触发（partialFills>0）--');
console.log(fmt('partialFills=0', stats(trades.filter(t => !t.partialFills))));
console.log(fmt('partialFills>0', stats(trades.filter(t => t.partialFills > 0))));

console.log('\n-- G. 按 UTC 小时 --');
for (let h = 0; h < 24; h++) { const s = stats(trades.filter(t => t.hour === h)); if (s.n) console.log(fmt(`UTC${String(h).padStart(2, '0')}`, s)); }

console.log('\n-- H. 等待成交根数 waitBars --');
for (const [lo, hi] of [[0, 2], [2, 5], [5, 15], [15, 31], [31, 999]]) {
  console.log(fmt(`wait ${lo}~${hi}`, stats(trades.filter(t => t.waitBars >= lo && t.waitBars < hi))));
}

console.log('\n-- I. atrPct × 盈亏（不设组合门槛）--');
const hiAtr = trades.filter(t => t.atrPct >= 0.004);
const loAtr = trades.filter(t => t.atrPct < 0.004);
console.log(fmt('atrPct>=0.004', stats(hiAtr)));
console.log(fmt('atrPct<0.004', stats(loAtr)));
console.log(fmt('atrPct>=0.004 且 score>=80', stats(hiAtr.filter(t => t.score >= 80))));
