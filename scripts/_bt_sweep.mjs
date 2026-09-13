// 参数网格扫参运行器（2026-09-13 重写；旧版指向已删语料已废弃）：
// 逐 cell 调 _bt_live.mjs（分片并行），汇总各 cell 审计指标并排名。
// 用法：
//   node scripts/_bt_sweep.mjs --preset pump               # pump-short 全量 15m 网格（每 cell ~12s）
//   node scripts/_bt_sweep.mjs --preset enhanced           # enhanced 1m 单轴网格（LIVE_SAMPLE=120）
//   node scripts/_bt_sweep.mjs --cells '<JSON数组>'        # 自定义 cell
//   SWEEP_SAMPLE=0 SWEEP_IV=15m SWEEP_WORKERS=8 可覆盖采样/周期/并行
// cell 形状：{ tag, overrides?, env? }  overrides → BT_PARAM_OVERRIDES；env → 进程环境变量注入
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const preset = arg('preset');
const IV = process.env.SWEEP_IV || (preset === 'pump' ? '15m' : '1m');
const SAMPLE = process.env.SWEEP_SAMPLE ?? (preset === 'pump' ? '0' : '120');
const WORKERS = process.env.SWEEP_WORKERS || '8';

const PRESETS = {
  // pump-short：单轴粗扫（全部为生产默认的邻域）
  pump: [
    { tag: 'p-base' },
    { tag: 'p-pump35', overrides: { pumpAtrMin: 3.5 } },
    { tag: 'p-pump45', overrides: { pumpAtrMin: 4.5 } },
    { tag: 'p-tp45', overrides: { takeProfitR: 4.5 } },
    { tag: 'p-tp60', overrides: { takeProfitR: 6 } },
    { tag: 'p-pull08', overrides: { pullbackAtr: 0.8 } },
    { tag: 'p-pull12', overrides: { pullbackAtr: 1.2 } },
    { tag: 'p-hold48', overrides: { maxHoldBars: 48 } },
    { tag: 'p-stop30', overrides: { stopBufferAtr: 3.0 } },
  ],
  // enhanced：单轴扫（基于 P13 基线）
  enhanced: [
    { tag: 'e-base' },
    { tag: 'e-score78', overrides: { minTrendScore: 78 } },
    { tag: 'e-score82', overrides: { minTrendScore: 82 } },
    { tag: 'e-hold5', env: { NOFX_MIN_HOLD_BARS: '5' } },
    { tag: 'e-hold10', env: { NOFX_MIN_HOLD_BARS: '10' } },
    { tag: 'e-stop26', overrides: { stopAtr: 2.6 } },
    { tag: 'e-pull17', overrides: { pullbackAtrShallow: 1.7, pullbackAtrDeep: 2.0 } },
    { tag: 'e-tp4', overrides: { mainTpR: 4 } },
    { tag: 'e-atr10', overrides: { maxAtrPct: 0.010 } },
  ],
};

const cells = arg('cells') ? JSON.parse(arg('cells')) : PRESETS[preset];
if (!cells) { console.error('未知 preset 或缺 --cells'); process.exit(1); }

console.log(`== 扫参 ${cells.length} cells · 语料 ${IV === '15m' ? (process.env.LIVE_DIR || 'data/backtest/bf90-15mrs') : 'data/backtest/bf90-1m'} · 采样 ${SAMPLE} · 并行 ${WORKERS} ==\n`);
const rows = [];
for (let i = 0; i < cells.length; i++) {
  const cell = cells[i];
  const env = {
    ...process.env,
    BT_STRATEGY: IV === '15m' ? 'pump-short' : 'enhanced',   // ⚠️ 必传：不传子进程默认 enhanced，pump 参数会被忽略
    LIVE_TAG: cell.tag,
    LIVE_WORKERS: WORKERS,
    LIVE_SAMPLE: String(SAMPLE),
    LIVE_TF_MS: IV === '15m' ? '900000' : '60000',
    ...(IV === '15m' ? { LIVE_DIR: process.env.LIVE_DIR || 'data/backtest/bf90-15mrs' } : {}),
    ...(cell.overrides ? { BT_PARAM_OVERRIDES: JSON.stringify(cell.overrides) } : {}),
    ...(cell.env || {}),
  };
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['scripts/_bt_live.mjs'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dur = ((Date.now() - t0) / 1000).toFixed(0);
  const sumFile = `data/backtest/results/live-${cell.tag}-${IV}.summary.json`;
  if (r.status !== 0 || !fs.existsSync(sumFile)) {
    console.error(`[${i + 1}/${cells.length}] ${cell.tag} ✗ exit=${r.status}\n${(r.stderr || '').slice(-500)}`);
    continue;
  }
  const s = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
  rows.push({ tag: cell.tag, ...s });
  console.log(`[${i + 1}/${cells.length}] ${cell.tag.padEnd(12)} 净${s.net.toFixed(0).padStart(7)}U  胜率${s.wr.toFixed(0).padStart(3)}%  PF${(s.pf === Infinity ? '∞' : s.pf.toFixed(2)).padStart(5)}  笔数${String(s.filled).padStart(5)}  剔T3${s.netExTop3.toFixed(0).padStart(7)}  h1/h2 ${s.h1.toFixed(0)}/${s.h2.toFixed(0)}  (${dur}s)`);
}

rows.sort((a, b) => b.net - a.net);
console.log('\n===== 排名（按净盈亏）=====');
for (const [i, r] of rows.entries()) {
  console.log(`${String(i + 1).padStart(2)}. ${r.tag.padEnd(12)} 净${r.net.toFixed(1).padStart(9)}U  PF${(r.pf === Infinity ? '∞' : r.pf.toFixed(2)).padStart(5)}  胜率${r.wr.toFixed(1).padStart(5)}%  笔${String(r.filled).padStart(5)}  MDD${r.mdd.toFixed(0).padStart(6)}  剔T3${r.netExTop3.toFixed(0).padStart(8)}  剔T10${r.netExTop10.toFixed(0).padStart(8)}  h1/h2 ${r.h1.toFixed(0)}/${r.h2.toFixed(0)}`);
}
fs.writeFileSync(`data/backtest/results/sweep-${preset || 'custom'}-${IV}.json`, JSON.stringify({ at: new Date().toISOString(), iv: IV, sample: SAMPLE, rows }, null, 1));
console.log(`\n明细 data/backtest/results/sweep-${preset || 'custom'}-${IV}.json`);
