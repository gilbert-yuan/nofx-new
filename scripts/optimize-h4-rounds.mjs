/**
 * One-variable-at-a-time H4 mean-reversion optimizer.
 *
 * Baseline uses production params from data/strategies.json.
 * Each round changes exactly one runtime or strategy field, reruns the
 * existing 4H→1m engine, and keeps the change only if the holdout
 * (last 30%) is still positive with PF ≥ 1.1.
 *
 *   npm run backtest:h4:rounds
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ENV_INFO } from './_h4_live_env.mjs';
import { runBacktest, buildSymbolList, DAY } from './_h4_bt_core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const dir4h = path.resolve(process.env.BT_DIR_4H || 'data/backtest/bf365-4h');
const dir1m = path.resolve(process.env.BT_DIR_1M || 'data/backtest/bf365-1m');
const meta = JSON.parse(fs.readFileSync(path.join(dir4h, 'meta.json'), 'utf8'));
const meta1m = JSON.parse(fs.readFileSync(path.join(dir1m, 'meta.json'), 'utf8'));
const endTs = Date.parse(meta1m.to || meta.to || '') || Date.now();
const days = Math.max(30, Math.floor(Number(process.env.BT_DAYS || 180)));
const startTs = endTs - days * DAY;
const splitTs = startTs + (endTs - startTs) * 0.7;
const seed = 20260915;
const defaultCount = Math.max(5, Math.floor(Number(process.env.BT_SYMBOL_COUNT || 50)));
const windowBars = Math.max(40, Math.floor(Number(process.env.BT_WINDOW_BARS || 80)));

const productionRuntime = {
  initialCapital: 100,
  maxPositions: 10,
  autoMarginPct: 0.05,
  marginCapPct: 0.05,
  minMargin: 5,
  maxPositionNotionalPct: 0.25,
  maxTotalNotionalPct: 1.25,
  pendingExpiryMin: 1440,
  stopCooldownMin: 0,
  normalCooldownMin: 0,
  dailyLossPct: 0,
  consecutiveLossHalt: 0,
  feeBps: 6,
  slippageBps: 5,
  fundingBpsPer8h: 3
};

const ALL_ROUNDS = [
  { id: 'R0', change: '生产参数基线（不改策略）', runtime: {}, params: {} },
  { id: 'R1', change: '只开连续亏损熔断=4', runtime: { consecutiveLossHalt: 4 }, params: {} },
  { id: 'R2', change: '只把 maxAtrPct 从 0.035 收到 0.03', runtime: {}, params: { maxAtrPct: 0.03 } },
  { id: 'R3', change: '只把 rsiOversold 从 30 放到 35', runtime: {}, params: { rsiOversold: 35 } },
  { id: 'R4', change: '只把 maxHoldBars 从 17 收到 14', runtime: {}, params: { maxHoldBars: 14 } },
  { id: 'R5', change: '只关评分杠杆档 scoreLeverageEnabled=false', runtime: {}, params: { scoreLeverageEnabled: false } },
  { id: 'R6', change: '只把 adxMax 从 50 收到 40', runtime: {}, params: { adxMax: 40 } },
  { id: 'R7', change: '只把 minNetRr 从 1.625 放到 1.50', runtime: {}, params: { minNetRr: 1.5 } },
  { id: 'R8', change: '只把 minNetRr 从 1.625 放到 1.40', runtime: {}, params: { minNetRr: 1.4 } },
  { id: 'R9', change: '只把币池从 50 扩到 200（生产参数）', runtime: {}, params: {}, count: 200 },
  { id: 'R10', change: '200 币池上只把 maxAtrPct 从 0.035 放到 0.06', runtime: {}, params: { maxAtrPct: 0.06 }, count: 200 },
  { id: 'R11', change: '200 币池上只把 maxAtrPct 从 0.035 收到 0.025', runtime: {}, params: { maxAtrPct: 0.025 }, count: 200 },
  { id: 'R12', change: '200 币池上只把 maxAtrPct 从 0.035 收到 0.020', runtime: {}, params: { maxAtrPct: 0.02 }, count: 200 },
  { id: 'R13', change: '200 币池上只开连续亏损熔断=4', runtime: { consecutiveLossHalt: 4 }, params: {}, count: 200 },
  { id: 'R14', change: '200 币池上重跑连亏熔断=4（回测成交无 status 已修复）', runtime: { consecutiveLossHalt: 4 }, params: {}, count: 200 },
  { id: 'R15', change: '200 币池上只开连续亏损熔断=6', runtime: { consecutiveLossHalt: 6 }, params: {}, count: 200 },
  { id: 'R16', change: '200 币池上只把 maxAtrPct 从 0.035 收到 0.028', runtime: {}, params: { maxAtrPct: 0.028 }, count: 200 },
  { id: 'R17', change: '200 币池上只把 minNetRr 从 1.625 收到 1.75', runtime: {}, params: { minNetRr: 1.75 }, count: 200 },
  { id: 'R18', change: '200 币池上只把 maxAtrPct 从 0.035 收到 0.026', runtime: {}, params: { maxAtrPct: 0.026 }, count: 200 },
  { id: 'R19', change: '200 币池上只关评分杠杆档 scoreLeverageEnabled=false', runtime: {}, params: { scoreLeverageEnabled: false }, count: 200 },
  { id: 'R20', change: '200 币池上只把 rsiOversold 从 30 收到 25', runtime: {}, params: { rsiOversold: 25 }, count: 200 },
  { id: 'R21', change: '200 币池上只把 adxMax 从 50 收到 45', runtime: {}, params: { adxMax: 45 }, count: 200 },
  { id: 'R22', change: '200 币池上只把单笔保证金从 5% 降到 3%', runtime: { autoMarginPct: 0.03, marginCapPct: 0.03 }, params: {}, count: 200 },
  { id: 'R23', change: '200 币池上只把最低保证金从 5U 降到 1U', runtime: { minMargin: 1 }, params: {}, count: 200 },
  { id: 'R24', change: '200 币池上只把 maxHoldBars 从 17 放到 24', runtime: {}, params: { maxHoldBars: 24 }, count: 200 },
  { id: 'R25', change: '200 币池上只把 maxHoldBars 从 17 收到 12', runtime: {}, params: { maxHoldBars: 12 }, count: 200 },
  { id: 'R26', change: '200 币池上只把 entryExtAtr 从 2.0 收到 2.5', runtime: {}, params: { entryExtAtr: 2.5 }, count: 200 },
  { id: 'R27', change: '200 币池上只把 stopAtr 从 1.5 放到 1.8', runtime: {}, params: { stopAtr: 1.8 }, count: 200 },
  { id: 'R28', change: '200 币池上只把 maxAtrPct 从 0.035 收到 0.024', runtime: {}, params: { maxAtrPct: 0.024 }, count: 200 },
  { id: 'R29', change: '200 币池上只把 rsiOversold 从 30 放到 35', runtime: {}, params: { rsiOversold: 35 }, count: 200 },
  { id: 'R30', change: '200 币池上只把 minAtrPct 从 0.002 收到 0.004', runtime: {}, params: { minAtrPct: 0.004 }, count: 200 },
  { id: 'R31', change: '200 币池上只打开 requireReversalCandle', runtime: {}, params: { requireReversalCandle: true }, count: 200 },
  { id: 'R32', change: '200 币池上只关掉 longOnly（允许做空）', runtime: {}, params: { longOnly: false }, count: 200 },
  { id: 'R33', change: '200 币池上只关掉 tpToMean（改用 R 倍数止盈）', runtime: {}, params: { tpToMean: false }, count: 200 },
  { id: 'R34', change: '200 币池上只把 maxAtrPct 从 0.035 收到 0.027', runtime: {}, params: { maxAtrPct: 0.027 }, count: 200 },
  { id: 'R35', change: '200 币池上只把 scoreLeverageThreshold 从 72 收到 80', runtime: {}, params: { scoreLeverageThreshold: 80 }, count: 200 },
  { id: 'R36', change: '200 币池上只把回测窗口从 180 天拉到 365 天（生产参数）', runtime: {}, params: {}, count: 200, days: 365 },
  { id: 'R37', change: '365 天 200 币上只把 maxAtrPct 从 0.035 收到 0.025', runtime: {}, params: { maxAtrPct: 0.025 }, count: 200, days: 365 },
  { id: 'R38', change: '365 天 200 币上叠加 maxAtrPct=0.025 且关掉评分杠杆', runtime: {}, params: { maxAtrPct: 0.025, scoreLeverageEnabled: false }, count: 200, days: 365 },
  { id: 'R39', change: '365 天 200 币上叠加 maxAtrPct=0.025 且并发从 10 提到 20', runtime: { maxPositions: 20 }, params: { maxAtrPct: 0.025 }, count: 200, days: 365 },
  { id: 'R40', change: '365 天 200 币上叠加 maxAtrPct=0.025 且最低保证金从 5U 降到 1U', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.025 }, count: 200, days: 365 },
  { id: 'R41', change: '365 天 200 币上只把 maxAtrPct 从 0.035 收到 0.026', runtime: {}, params: { maxAtrPct: 0.026 }, count: 200, days: 365 },
  { id: 'R42', change: '365 天 200 币上只把 maxAtrPct 从 0.035 收到 0.024', runtime: {}, params: { maxAtrPct: 0.024 }, count: 200, days: 365 },
  { id: 'R43', change: '365 天 200 币上只把 maxAtrPct 从 0.035 收到 0.023', runtime: {}, params: { maxAtrPct: 0.023 }, count: 200, days: 365 },
  { id: 'R44', change: '365 天 200 币上叠加 maxAtrPct=0.025 且 rsiOversold 从 30 放到 32', runtime: {}, params: { maxAtrPct: 0.025, rsiOversold: 32 }, count: 200, days: 365 },
  { id: 'R45', change: '365 天 200 币 maxAtrPct=0.025 只换选币种子 20260916', runtime: {}, params: { maxAtrPct: 0.025 }, count: 200, days: 365, seed: 20260916 },
  { id: 'R46', change: '365 天全量币池只叠加 maxAtrPct=0.025（生产其余参数）', runtime: {}, params: { maxAtrPct: 0.025 }, all: true, days: 365 },
  { id: 'R47', change: '365 天全量币池只叠加 maxAtrPct=0.026', runtime: {}, params: { maxAtrPct: 0.026 }, all: true, days: 365 },
  { id: 'R48', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且并发从 10 提到 20', runtime: { minMargin: 1, maxPositions: 20 }, params: { maxAtrPct: 0.025 }, count: 200, days: 365 },
  { id: 'R49', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且单笔保证金从 5% 降到 3%', runtime: { minMargin: 1, autoMarginPct: 0.03, marginCapPct: 0.03 }, params: { maxAtrPct: 0.025 }, count: 200, days: 365 },
  { id: 'R50', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且只开连续亏损熔断=4', runtime: { minMargin: 1, consecutiveLossHalt: 4 }, params: { maxAtrPct: 0.025 }, count: 200, days: 365 },
  { id: 'R51', change: '365 天 200 币叠加 minMargin=1 且只把 maxAtrPct 从 0.025 放到 0.026', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.026 }, count: 200, days: 365 },
  { id: 'R52', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且只把 maxHoldBars 从 17 收到 14', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.025, maxHoldBars: 14 }, count: 200, days: 365 },
  { id: 'R53', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且只把 maxHoldBars 从 17 收到 12', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.025, maxHoldBars: 12 }, count: 200, days: 365 },
  { id: 'R54', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且只把 maxHoldBars 从 17 收到 13', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.025, maxHoldBars: 13 }, count: 200, days: 365 },
  { id: 'R55', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且只把 maxHoldBars 从 17 收到 15', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.025, maxHoldBars: 15 }, count: 200, days: 365 },
  { id: 'R56', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1 且只把 maxHoldBars 从 17 收到 16', runtime: { minMargin: 1 }, params: { maxAtrPct: 0.025, maxHoldBars: 16 }, count: 200, days: 365 },
  { id: 'R57', change: '365 天 200 币叠加 maxAtrPct=0.025、minMargin=1、maxHoldBars=16 且并发从 10 提到 20', runtime: { minMargin: 1, maxPositions: 20 }, params: { maxAtrPct: 0.025, maxHoldBars: 16 }, count: 200, days: 365 }
];
const only = String(process.env.BT_ROUND || '').trim().toUpperCase();
const rounds = only ? ALL_ROUNDS.filter(r => r.id === only) : ALL_ROUNDS;
if (!rounds.length) throw new Error(`未知轮次 ${only}`);

function keep(summary) {
  const test = summary.test || {};
  const oosPfOk = test.pf == null
    ? Number(test.n) > 0 && Number(test.net) > 0
    : Number(test.pf) >= 1.1;
  return Number(test.net) > 0
    && oosPfOk
    && Number(summary.net) > 0
    && Number(summary.gross) > 0
    && Number(summary.netExTop3Coins) > 0;
}

const outDir = path.resolve('data/backtest/auto-trade');
fs.mkdirSync(outDir, { recursive: true });

const historyPath = path.join(outDir, 'h4-rounds.json');
const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : { results: [] };
const byId = new Map((history.results || []).map(row => [row.id, row]));
const results = [];
let best = null;
console.log(`4H 逐轮优化 ${new Date(startTs).toISOString()} ~ ${new Date(endTs).toISOString()} 窗口 ${windowBars}`);
console.log(`live env: ${JSON.stringify(LIVE_ENV_INFO)}`);

for (const round of rounds) {
  const t0 = Date.now();
  const runtime = { ...productionRuntime, ...round.runtime };
  const count = Math.max(5, Math.floor(Number(round.count || defaultCount)));
  const roundDays = Math.max(30, Math.floor(Number(round.days || days)));
  const roundStart = endTs - roundDays * DAY;
  const roundSplit = roundStart + (endTs - roundStart) * 0.7;
  const roundSeed = Number.isFinite(Number(round.seed)) ? Number(round.seed) : seed;
  const symbols = buildSymbolList({
    meta, dirs: [dir4h, dir1m], seed: roundSeed, count, all: round.all === true
  });
  if (!symbols.length) throw new Error(`${round.id} 没有可用币种`);
  const result = await runBacktest({
    strategyId: 'h4-mean-reversion-v1',
    symbols,
    params: round.params,
    runtime,
    dir4h,
    dir1m,
    startTs: roundStart,
    endTs,
    splitTs: roundSplit,
    execTf: '1m',
    decisionTf: '4h',
    windowBars,
    quiet: true
  });
  const s = result.summary;
  const row = {
    id: round.id,
    change: round.change,
    seconds: Number(((Date.now() - t0) / 1000).toFixed(1)),
    trades: s.n,
    net: s.net,
    roiPct: s.roiPct,
    winRatePct: s.winRatePct,
    pf: s.pf,
    payoff: s.avgLoss ? Number(Math.abs(s.avgWin / s.avgLoss).toFixed(3)) : null,
    maxDrawdown: s.maxDrawdown,
    maxDrawdownPct: s.maxDrawdownPct,
    gross: s.gross,
    netExTop3Coins: s.netExTop3Coins,
    train: s.train,
    test: s.test,
    funnel: {
      placed: s.funnel?.placed,
      skippedLossCircuit: s.funnel?.skippedLossCircuit,
      skippedDailyLoss: s.funnel?.skippedDailyLoss
    },
    keep: keep(s)
  };
  byId.set(row.id, row);
  const jsonPath = path.join(outDir, `h4-${round.id}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ round, summary: s, config: result.config }, null, 2));
  if (!best || (row.keep && row.test.net > (best.test?.net || -Infinity)) || (!best.keep && row.keep)) {
    if (row.keep) best = row;
  }
  if (!best && round.id === 'R0') best = row;
  console.log(`${round.id} ${round.change}`);
  console.log(`  n=${row.trades} net=${row.net} ROI=${row.roiPct}% WR=${row.winRatePct}% PF=${row.pf} MDD=${row.maxDrawdownPct}% OOS net=${row.test.net} PF=${row.test.pf} keep=${row.keep} ${row.seconds}s`);
}

const merged = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
const kept = merged.filter(row => row.keep);
best = kept.sort((a, b) => Number(b.net) - Number(a.net) || Number(b.test?.net || 0) - Number(a.test?.net || 0))[0]
  || merged.find(row => row.id === 'R0')
  || merged[0];
const md = [
  '# 4H 均值回归逐轮优化',
  '',
  `生成时间：${new Date().toISOString()}`,
  `默认币池：种子 ${seed} 的 ${defaultCount} 币 · ${days} 天 · 窗口 ${windowBars} · 1m 成交 · 本金 100U`,
  `当前最优：${best.id} — ${best.change}`,
  '',
  '| 轮 | 改动 | 成交 | 净U | ROI% | 胜率% | PF | 盈亏比 | MDD% | 样本外净 | 样本外PF | 保留 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...merged.map(r => `| ${r.id} | ${r.change} | ${r.trades} | ${r.net} | ${r.roiPct} | ${r.winRatePct} | ${r.pf ?? '—'} | ${r.payoff ?? '—'} | ${r.maxDrawdownPct} | ${r.test.net} | ${r.test.pf ?? '—'} | ${r.keep ? '是' : '否'} |`),
  '',
  '规则：每轮只改一个变量。保留条件 = 全区间净>0 且毛>0 且剔 Top3 币仍正 且样本外净>0 且样本外 PF≥1.1。',
  '未保留的改动不进入下一轮叠加。'
].join('\n');
fs.writeFileSync(path.join(outDir, 'h4-rounds.md'), md);
fs.writeFileSync(path.join(outDir, 'h4-rounds.json'), JSON.stringify({ best, results: merged }, null, 2));
console.log(`最优 ${best.id} ${best.change} 净 ${best.net}U 样本外 ${best.test.net}U`);
console.log(`报告 data/backtest/auto-trade/h4-rounds.md`);
