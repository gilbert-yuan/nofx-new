// 参数扫描器（2026-09-11）
//
// 自动循环：每组参数跑一次 50 币×30 天回测，输出净盈亏/胜率/笔数。
// 用于系统化定位"能让策略转正"的参数组合（用户诉求：直至收益为正）。
//
// 用法：
//   node scripts/_bt_sweep.mjs <baseEnv> <paramSweepSpec>
//   例：node scripts/_bt_sweep.mjs "NOFX_LONG_ONLY=true" "MIN_TREND_SCORE:75,80,85;PULLBACK_SHALLOW:0.5,0.8,1.0;MIN_ATR_PCT:0.003,0.004"
//
// 输出：每组一行汇总到 stdout，并写 data/backtest/sweep-YYYY-MM-DD-HHMM.json。
//
// 复用 _bt_run.mjs：env 变量即配置；BT_OUT 切换结果文件。50 币约 50s/组。

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'data/backtest';
const KDIR = join(DIR, 'klines');
const NODE = process.execPath;
const SCRIPT = 'scripts/_bt_run.mjs';

if (process.argv.length < 4) {
  console.error('用法: node scripts/_bt_sweep.mjs <baseEnv> "K1:V1,V2;K2:V1,V2"');
  process.exit(2);
}

const parseEnv = s => Object.fromEntries(
  s.split(/\s+/).filter(Boolean).map(kv => {
    const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)];
  })
);
const baseEnv = parseEnv(process.argv[2]);
const sweep = process.argv[3].split(';').filter(Boolean).map(spec => {
  const [k, vs] = spec.split(':');
  return { k, values: vs.split(',').map(v => v.trim()) };
});

// 笛卡尔积
const cartesian = arrs => arrs.reduce((a, vs) => a.flatMap(x => vs.map(v => [...x, v])), [[]]);
const grid = cartesian(sweep.map(s => s.values));
const N = grid.length;
const total = N * 50; // ~50s each

console.log(`\n[扫描] 组合 ${N} 组 × 50 币 ≈ ${(N * 50 / 60).toFixed(0)} min`);
console.log('基线 env:', JSON.stringify(baseEnv));
console.log('扫描维度:', sweep.map(s => `${s.k}∈{${s.values.join(',')}}`).join('; '), '\n');

const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const sweepFile = join(DIR, `sweep-${ts}.json`);
const results = [];

for (let i = 0; i < grid.length; i++) {
  const combo = grid[i];
  const envExtra = {};
  const label = sweep.map((s, j) => `${s.k}=${combo[j]}`).join(' ');
  for (let j = 0; j < sweep.length; j++) {
    // 自动加 NOFX_ 前缀（用户写 MIN_TREND_SCORE → NOFX_MIN_TREND_SCORE）；
    // 已带前缀或完全以 NOFX_ 开头的跳过。
    const k = sweep[j].k.startsWith('NOFX_') ? sweep[j].k : `NOFX_${sweep[j].k}`;
    envExtra[k] = combo[j];
  }
  const fullEnv = { ...baseEnv, ...envExtra, BT_OUT: `sweep-${i}.json` };

  const t0 = Date.now();
  const r = spawnSync(NODE, [SCRIPT], { env: { ...process.env, ...fullEnv }, encoding: 'utf8' });
  const dt = (Date.now() - t0) / 1000;
  if (r.status !== 0) {
    console.log(`[${i + 1}/${N}] ✗ ${label} (exit ${r.status}) stderr=${(r.stderr || '').slice(-200)}`);
    continue;
  }
  // 解析 _bt_run.mjs 末行：净盈亏 NNN.U USDT 胜率 NN% 笔数 NNN
  const m = r.stdout.match(/净盈亏\s+(-?\d+\.\d+)\s+USDT\s+胜率\s+(\d+\.\d+)%\s+均单\s+(-?\d+\.\d+)U/);
  const trades = (() => {
    try {
      const d = JSON.parse(readFileSync(join(DIR, fullEnv.BT_OUT), 'utf8'));
      return d.trades.filter(x => !x.unfinished);
    } catch { return []; }
  })();
  const placed = (() => { try { return JSON.parse(readFileSync(join(DIR, fullEnv.BT_OUT), 'utf8')).placed.length; } catch { return 0; } })();

  const summary = {
    i, label, env: envExtra,
    net: m ? +m[1] : NaN, winRate: m ? +m[2] : NaN, avg: m ? +m[3] : NaN,
    trades: trades.length, placed, seconds: +dt.toFixed(1)
  };
  results.push(summary);
  console.log(`[${i + 1}/${N}] ${label.padEnd(60)} n=${summary.trades.toString().padStart(3)} 净${summary.net.toFixed(1).padStart(8)} 胜率${summary.winRate.toFixed(1).padStart(5)}%  均单${summary.avg.toFixed(3).padStart(7)}  ${dt.toFixed(0)}s`);
  writeFileSync(sweepFile, JSON.stringify(results, null, 2));
}

results.sort((a, b) => b.net - a.net);
console.log('\n=== Top 5 ===');
for (const r of results.slice(0, 5)) {
  console.log(`净${r.net.toFixed(1).padStart(8)} 胜率${r.winRate.toFixed(1).padStart(5)}%  n=${r.trades.toString().padStart(3)}  ${r.label}`);
}
console.log(`\n结果写入: ${sweepFile}`);
