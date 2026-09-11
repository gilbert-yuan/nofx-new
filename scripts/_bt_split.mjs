// 时间切分样本外验证：把 trades 按 entryAt 排序，前 60% 为训练段、后 40% 为测试段，
// 分别统计基线配置与候选配置的表现。用于判断改进是否只是对单一时段的拟合。
import fs from 'node:fs';
import path from 'node:path';
const DIR = path.resolve('data/backtest');

const stats = (rows) => {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter(r => r.net > 0).length;
  const net = rows.reduce((s, r) => s + r.net, 0);
  return { n, wr: 100 * wins / n, net, avg: net / n };
};

function load(f) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  return j.trades.filter(t => !t.unfinished).map(t => ({ ...t, ts: Date.parse(t.entryAt) })).sort((a, b) => a.ts - b.ts);
}

const files = process.argv.slice(2);
if (files.length < 2) { console.error('用法: _bt_split.mjs <基线.json> <候选1.json> [候选2.json ...]'); process.exit(2); }

const base = load(files[0]);
const cut = base[Math.floor(base.length * 0.6)].ts;
console.log(`切分点(UTC): ${new Date(cut).toISOString()}`);
console.log(`基线 ${files[0]}: ${base.length} 笔\n`);

const fmt = (label, s) => `${label.padEnd(30)} ${String(s.n).padStart(4)}笔 胜率${s.wr.toFixed(1).padStart(5)}% 净${s.net.toFixed(1).padStart(8)} 均单${s.avg.toFixed(3).padStart(7)}`;

for (const f of files) {
  const t = load(f);
  const tr = t.filter(x => x.ts < cut), te = t.filter(x => x.ts >= cut);
  console.log(`#### ${f}`);
  console.log(fmt('  全段', stats(t)));
  console.log(fmt('  段1(前60% 训练)', stats(tr)));
  console.log(fmt('  段2(后40% 测试)', stats(te)));
  console.log('');
}
