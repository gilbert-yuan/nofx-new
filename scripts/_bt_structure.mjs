/**
 * 结构策略 bf90 全量回测编排器 —— structure-short-v1 / structure-long-v1
 *
 * 口径：15m 决策（80 根窗口 15m/1h/4h，同源派生语料）+ 1m 执行（挂单触达成交、
 * SL/TP/超时、同根双触发保守取 SL）。取证纪律：只有 1m 执行可信；结果必须过
 * 集中度审计（剔 Top 币 / 最大 N 笔 / 前后半段）才能谈启用。
 *
 * 用法：
 *   STRUCT_WORKERS=8 node scripts/_bt_structure.mjs                    # 两个引擎各跑一轮
 *   STRUCT_ENGINES=structure-short STRUCT_WORKERS=8 node scripts/_bt_structure.mjs
 *   STRUCT_SAMPLE=60 STRUCT_WORKERS=4 node scripts/_bt_structure.mjs   # 抽样冒烟（确定性）
 *
 * 产物：data/backtest/results/structure-<engine>-bf90.json + .summary.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const D1M = path.resolve(process.env.BT_DIR_1M || 'data/backtest/bf90-1m');
const WORKERS = Math.max(1, Number(process.env.STRUCT_WORKERS || 8));
const SAMPLE = Number(process.env.STRUCT_SAMPLE || 0);
const ENGINES = (process.env.STRUCT_ENGINES || 'structure-short,structure-long').split(',').map(s => s.trim()).filter(Boolean);
const TAG = process.env.STRUCT_TAG || 'bf90';
// 基座 env（铁律：shared/strategyGuards 与 enhancedAnalysis 在**模块加载时**冻结 env，
// 漏注会静默换成代码默认值 —— 与生产口径差很远）。
// ⚠️ 2026-09-14 修正：原先只注入 5 个变量，漏掉了 NOFX_SMART_MA_ATR / NOFX_SMART_MIN_HOLD
//    （默认 1.0 ATR / 0 根），于是「回调挂单入场」与「均线失守退出」几何重叠 → 成交后第 1 根
//    就被 smart_exit_ma 打掉（实测 98% 出场为 smart_exit_ma、heldBars=1），正是生产 P8 注释里
//    已修掉的「入场即出场」结构性冲突。生产用 2.0 ATR + 15 根最小持仓抑制该冲突。
// 唯一来源：ecosystem.config.cjs（生产 P15）。生产改参数时必须同步改这里。
const BASE_ENV = {
  NOFX_LONG_ONLY: 'true',
  NOFX_MIN_TREND_SCORE: '73',
  NOFX_SMART_MA_ATR: '2.0',
  NOFX_SMART_MIN_HOLD: '15',
  NOFX_STOP_ATR: '2.0',
  NOFX_SMART_EXIT: 'false',
  NOFX_MAX_LEVERAGE: '12',
  NOFX_RISK_BUDGET_PCT: '0.18',
  NOFX_MAX_ATR_PCT: '0.012',
  NOFX_MIN_ATR_PCT: '0.007',
  NOFX_PULLBACK_ATR_SHALLOW: '1.9',
  NOFX_PULLBACK_ATR_DEEP: '2.2',
  NOFX_PENDING_GRACE_MIN: '60',
  NOFX_SYMBOL_COOLDOWN_MIN: '30',
  NOFX_STOP_COOLDOWN_MIN: '60'
};

const meta = JSON.parse(fs.readFileSync(path.join(D1M, 'meta.json'), 'utf8'));
const BARS_TARGET = Number(meta.barsTarget) || Math.max(...(meta.symbols || []).map(s => Number(s.bars) || 0));
let syms = (meta.symbols || [])
  .filter(s => Number(s.bars) >= BARS_TARGET * 0.95)
  .filter(s => fs.existsSync(path.join(D1M, 'klines', `${s.symbol}.ndjson`)))
  .sort((a, b) => b.bars - a.bars)
  .map(s => s.symbol);
if (SAMPLE > 0) syms = syms.slice(0, SAMPLE);

console.log(`== 结构策略回测 ==  语料 ${path.basename(D1M)}  达标币 ${syms.length}  并行 ${WORKERS}  引擎 ${ENGINES.join(' + ')}\n`);
fs.mkdirSync('data/backtest/results', { recursive: true });

const t0 = Date.now();
const summaries = [];

for (const engine of ENGINES) {
  console.log(`\n──── ${engine} ────`);
  const shards = Array.from({ length: WORKERS }, () => []);
  syms.forEach((s, i) => shards[i % WORKERS].push(s));

  function runShard(idx, list) {
    const out = `_struct-shard-${idx}.json`;
    return new Promise((resolve) => {
      const r = spawn(process.execPath, ['scripts/_bt_structure_run.mjs'], {
        env: {
          ...process.env, ...BASE_ENV,
          BT_STRATEGY: engine,
          BT_DIR_1M: D1M,
          BT_SYMBOLS: list.join(','),
          BT_OUT: out
        },
        cwd: process.cwd(), stdio: ['ignore', 'inherit', 'pipe']
      });
      let err = '';
      r.stderr.on('data', d => { err += d; });
      r.on('close', (code) => {
        console.log(`  片 ${idx + 1}/${WORKERS} 完成  ${list.length} 币  exit=${code}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        resolve({ idx, out, code, err: err.slice(-600) });
      });
    });
  }

  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (cursor < shards.length) {
      const i = cursor++;
      results.push(await runShard(i, shards[i]));
    }
  }));
  const bad = results.filter(r => r.code !== 0);
  if (bad.length) { console.error(`✗ ${engine} 有分片失败：`); for (const b of bad) console.error(b.err); process.exit(1); }

  const merged = { generatedAt: new Date().toISOString(), config: null, symbols: [], trades: [], placed: [], cancels: [] };
  for (const r of results) {
    const j = JSON.parse(fs.readFileSync(path.join(D1M, r.out), 'utf8'));
    merged.config = j.config;
    merged.symbols.push(...j.symbols);
    merged.trades.push(...j.trades);
    merged.placed.push(...j.placed);
    merged.cancels.push(...j.cancels);
  }
  merged.config.dataset = path.basename(D1M);
  merged.config.baseEnv = BASE_ENV;
  const outFile = `data/backtest/results/structure-${engine}-${TAG}.json`;
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 1));
  for (const r of results) { try { fs.rmSync(path.join(D1M, r.out), { force: true }); } catch { } }

  const S = audit(merged, syms.length, TAG);
  summaries.push({ engine, outFile, ...S });
}

fs.writeFileSync(`data/backtest/results/structure-all-${TAG}.summary.json`, JSON.stringify(summaries, null, 1));
console.log(`\n== 汇总 ==  用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
for (const s of summaries) {
  console.log(`  ${s.engine}: 挂单 ${s.placed}  成交 ${s.filled}  净 ${s.net.toFixed(1)}U  胜率 ${s.wr.toFixed(1)}%  PF ${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}  剔Top3币 ${s.netExTop3.toFixed(1)}U  剔最大5笔 ${s.netExTop5t.toFixed(1)}U  前后半 ${s.h1.toFixed(0)}/${s.h2.toFixed(0)}U`);
}

/**
 * 持仓小时数。
 * ⚠️ 2026-09-14：`held15m` 字段已不再由结果产出（TradingSimulator 只回传 heldBars=分钟），
 * 旧代码直接用 x.held15m 会让所有成交落进同一个桶、中位持仓变成 NaN。改为优先 held15m、
 * 回退 heldBars/60，两个字段都缺才返回 NaN。
 */
function holdHours(x) {
  if (Number.isFinite(x.held15m)) return x.held15m;
  if (Number.isFinite(x.heldBars)) return x.heldBars / 60;
  return NaN;
}

/** 名义成交额（成本拆解的分母）。优先 notional，回退 quantity×entry。 */
function notionalOf(x) {
  if (Number.isFinite(x.notional) && x.notional > 0) return x.notional;
  if (Number.isFinite(x.quantity) && Number.isFinite(x.entry) && x.quantity > 0) return x.quantity * x.entry;
  return NaN;
}

function audit(merged, coinsTested, tag) {
  const T = merged.trades.filter(x => !x.unfinished && Number.isFinite(x.net));
  const net = T.reduce((a, x) => a + x.net, 0);
  const wins = T.filter(x => x.net > 0);
  const gp = wins.reduce((a, x) => a + x.net, 0);
  const gl = Math.abs(T.filter(x => x.net <= 0).reduce((a, x) => a + x.net, 0));
  let acc = 0, pk = 0, mdd = 0;
  for (const x of T.slice().sort((a, b) => Date.parse(a.exitAt) - Date.parse(b.exitAt))) { acc += x.net; pk = Math.max(pk, acc); mdd = Math.max(mdd, pk - acc); }
  const byS = {};
  for (const x of T) byS[x.symbol] = (byS[x.symbol] || 0) + x.net;
  const coins = Object.entries(byS).sort((a, b) => b[1] - a[1]);
  const times = T.map(x => Date.parse(x.entryAt)).sort((a, b) => a - b);
  const mid = times.length ? times[Math.floor(times.length / 2)] : 0;
  const h1 = T.filter(x => Date.parse(x.entryAt) < mid).reduce((a, x) => a + x.net, 0);
  const h2 = T.filter(x => Date.parse(x.entryAt) >= mid).reduce((a, x) => a + x.net, 0);
  const gross = T.reduce((a, x) => a + x.gross, 0);
  const fee = T.reduce((a, x) => a + x.fee, 0);
  const funding = T.reduce((a, x) => a + x.funding, 0);
  const notionalSum = T.reduce((a, x) => a + notionalOf(x), 0);
  const reasons = T.reduce((m, x) => (m[x.reason] = (m[x.reason] || 0) + 1, m), {});
  const evs = [];
  for (const x of T) { evs.push([Date.parse(x.entryAt), 1]); evs.push([Date.parse(x.exitAt) + 1, -1]); }
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of evs) { cur += d; if (cur > peak) peak = cur; }
  const top3 = coins.slice(0, 3).reduce((a, [, v]) => a + v, 0);
  const top10 = coins.slice(0, 10).reduce((a, [, v]) => a + v, 0);
  const top5t = [...T].sort((a, b) => b.net - a.net).slice(0, 5).reduce((a, x) => a + x.net, 0);
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const heldBuckets = {};
  for (const x of T) {
    const h = holdHours(x);
    const k = !Number.isFinite(h) ? '未知' : h < 2 ? '<2h' : h < 8 ? '2-8h' : h < 16 ? '8-16h' : h < 24 ? '16-24h' : '≥24h';
    heldBuckets[k] = (heldBuckets[k] || { n: 0, net: 0 });
    heldBuckets[k].n++; heldBuckets[k].net += x.net;
  }
  const S = {
    dataset: path.basename(D1M), coinsTested, placed: merged.placed.length, cancels: merged.cancels.length,
    filled: T.length, fillRate: merged.placed.length ? 100 * T.length / merged.placed.length : 0,
    net, wr: T.length ? 100 * wins.length / T.length : 0, pf: gl > 0 ? gp / gl : Infinity,
    mdd, avg: T.length ? net / T.length : NaN,
    medHeld15m: med(T.map(holdHours)), medRoi: med(T.map(x => x.roi)) * 100,
    medScore: med(T.map(x => x.score)), medEntryQuality: med(T.map(x => x.entryQuality)),
    reasons, heldBuckets,
    gross, fee, funding, grossBps: notionalSum ? 10000 * gross / notionalSum : NaN,
    h1, h2,
    coinsTraded: coins.length, coinsProfitable: coins.filter(c => c[1] > 0).length,
    top5: coins.slice(0, 5).map(([s, v]) => `${s}:${v.toFixed(0)}`),
    netExTop3: net - top3, netExTop10: net - top10, netExTop5t: net - top5t,
    peakConcurrent: peak, netOnPeakMargin: peak ? 100 * net / (peak * 100) : NaN
  };
  return S;
}
