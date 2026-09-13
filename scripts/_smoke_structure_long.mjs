/**
 * 冒烟：验证结构做多策略（structure-long-v1）的注册契约与信号链路
 *   · 注册字段：engine='structure-long'、planInterval='15m'、needsAux=['15m','1h','4h']、priority=85
 *   · decoratePlan 补的出场规则里「智能退出」默认关闭
 *   · analyze 全链路：缺数据 → WAIT；4H 强下跌 → WAIT；完整多头结构 → BUY 且计划自洽
 *   · 80 根窗口回归：辅助行情窗口与生产一致（每个周期恰好 80 根），不出现「K 线不够」
 *
 * 合成 K 线：与 _smoke_structure_short.mjs 同一套多尺度生成器的多头镜像 ——
 * 慢周期（10 快段 ×12 根 + 回调 30 根）决定 1h/4h 大结构（HH+HL）；快段
 * （10 阳 +0.1% + 2 阴 −0.34%，净 +0.32%）喂 15m 摆动点。收尾截断在快段上升中途
 * （最后一根收盘 > 最近摆动高点 → 15m BOS），不触发「过度延伸」闸门。
 */
import '../server/strategies/builtins.js';
import { getStrategy, defaultParams } from '../server/strategies/registry.js';

const M15 = 15 * 60 * 1000;

function pushCandle(rows, pct, vol) {
  const prev = rows.length ? rows.at(-1).close : 100;
  const open = prev;
  const close = open * (1 + pct);
  const isUp = pct > 0;
  const high = isUp ? close * 1.0006 : open * 1.0002;
  const low = isUp ? open * 0.9999 : close * 0.9996;
  rows.push({ openTime: rows.length * M15, open, high, low, close, volume: vol, confirmed: true });
}

/** 多尺度多头序列：慢周期决定大结构，快段喂 15m 摆动点，末段截断在上升中途制造 15m BOS */
function bullishMultiScale({ cycles = 10, finalUpBars = 9 }) {
  const rows = [];
  const up = (vol = 2000) => pushCandle(rows, 0.001, vol);
  const dn = (vol = 800) => pushCandle(rows, -0.0034, vol);
  const pullback = () => { for (let i = 0; i < 30; i++) pushCandle(rows, -0.0008, 1000); };
  const seg = (upVol = 2000) => { for (let i = 0; i < 10; i++) up(upVol); dn(); dn(); };
  for (let c = 0; c < cycles; c++) { for (let s = 0; s < 10; s++) seg(); pullback(); }
  for (let s = 0; s < 6; s++) seg();
  for (let i = 0; i < finalUpBars; i++) up(4000);
  return rows;
}

/** 多尺度空头序列（4H 强下跌用）：与 _smoke_structure_short.mjs 相同 */
function bearishMultiScale({ cycles = 8 }) {
  const rows = [];
  const seg = () => { for (let i = 0; i < 10; i++) pushCandle(rows, -0.001, 2000); for (let i = 0; i < 2; i++) pushCandle(rows, 0.0034, 800); };
  const upLeg = () => { for (let i = 0; i < 30; i++) pushCandle(rows, 0.0008, 1200); };
  for (let c = 0; c < cycles; c++) { for (let s = 0; s < 10; s++) seg(); upLeg(); }
  for (let s = 0; s < 6; s++) seg();
  for (let i = 0; i < 9; i++) pushCandle(rows, -0.001, 4000);
  return rows;
}

/** 15m → 1h（×4）/ 4h（×16）聚合：OHLC 归并、量能求和，取末尾 limit 根 */
function aggregate(rows15, groupBars, limit) {
  const out = [];
  for (let i = 0; i + groupBars <= rows15.length; i += groupBars) {
    const g = rows15.slice(i, i + groupBars);
    out.push({
      openTime: g[0].openTime,
      open: g[0].open,
      close: g.at(-1).close,
      high: Math.max(...g.map(x => x.high)),
      low: Math.min(...g.map(x => x.low)),
      volume: g.reduce((s, x) => s + x.volume, 0),
      confirmed: true
    });
  }
  return out.slice(-limit);
}

const mkMarket = (interval, klines, symbol = 'BINANCE_TESTUSDT') =>
  ({ symbol, interval, klines, dataAsOf: klines.at(-1)?.openTime + M15 - 1 || null });

let fail = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' :: ' + extra : ''}`); if (!cond) fail++; };

/* ---------- 1. 注册契约 ---------- */
const def = getStrategy('structure-long-v1');
check('策略已注册', !!def);
if (def) {
  console.log('id          :', def.id);
  console.log('engine      :', def.engine);
  console.log('planInterval:', def.planInterval);
  console.log('needsAux    :', JSON.stringify(def.needsAux));
  console.log('priority    :', def.priority);
  check("engine === 'structure-long'", def.engine === 'structure-long');
  check("planInterval === '15m'", def.planInterval === '15m');
  check("needsAux === ['15m','1h','4h']", JSON.stringify(def.needsAux) === '["15m","1h","4h"]');
  check('priority === 85', def.priority === 85);
  check('has decoratePlan', typeof def.decoratePlan === 'function');
  check('has review', typeof def.review === 'function');

  const p = defaultParams(def.paramSchema);
  const expect = { bullishScoreMin: 70, entryQualityMin: 70, extendedAtr: 2, entryBufAtr: 0.25,
    stopBufferAtr: 0.35, minStopPct: 0.008, takeProfitR: 2, maxHoldBars: 96 };
  for (const k of Object.keys(expect)) {
    check(`默认参数 ${k} = ${expect[k]}`, Math.abs((p[k] ?? NaN) - expect[k]) < 1e-9, `实际 ${p[k]}`);
  }
  const { buildExitRules } = await import('../server/enhancedAnalysis.js');
  const decorated = def.decoratePlan({ entryLimit: 100, stopLoss: 99, takeProfit: 102, riskUnit: 1, maxHoldBars: 96 }, { params: p });
  check('decoratePlan.exitRules.smartExit.enabled === false',
    decorated?.exitRules?.smartExit?.enabled === false, JSON.stringify(decorated?.exitRules?.smartExit));
}

/* ---------- 2. analyze 链路 ---------- */
const p = def ? defaultParams(def.paramSchema) : {};
const ctx = params => ({ params, auxMarkets: {} });

// 2a. 缺辅助行情 → WAIT
{
  const market = mkMarket('1m', bullishMultiScale({ cycles: 1 }).slice(-80));
  const r = def.analyze(market, ctx(p));
  check('缺辅助行情 → WAIT', r.action === 'WAIT' && r.plan === null, r.reason);
}

// 2b. 完整多头结构 → BUY
let buyResult = null;
{
  const rows15 = bullishMultiScale({});
  const rows1h = aggregate(rows15, 4, 80);
  const rows4h = aggregate(rows15, 16, 80);
  const market = mkMarket('1m', rows15.slice(-5));
  const r = def.analyze(market, { params: p, auxMarkets: {
    '15m': mkMarket('15m', rows15.slice(-80)), '1h': mkMarket('1h', rows1h), '4h': mkMarket('4h', rows4h)
  } });
  console.log('\n--- 多头结构用例诊断 ---');
  console.log('action   :', r.action);
  console.log('score    :', r.score, ' entryQuality:', r.entryQuality);
  console.log('structure:', JSON.stringify(r.structure));
  console.log('reason   :', r.reason);
  buyResult = r;
}

// 2c. 4H 强下跌 → WAIT（禁多）
{
  const rows15 = bearishMultiScale({});
  const rows1h = aggregate(rows15, 4, 80);
  const rows4h = aggregate(rows15, 16, 80);
  const market = mkMarket('1m', rows15.slice(-5));
  const r = def.analyze(market, { params: p, auxMarkets: {
    '15m': mkMarket('15m', rows15.slice(-80)), '1h': mkMarket('1h', rows1h), '4h': mkMarket('4h', rows4h)
  } });
  check('4H 强下跌 → WAIT（禁多）', r.action === 'WAIT' && /强下跌/.test(r.reason), r.reason);
}

if (buyResult) {
  const r = buyResult;
  if (r.action === 'BUY') {
    check('完整多头结构 → BUY', r.action === 'BUY');
    const plan = r.plan;
    check('计划自洽：takeProfit > entryLimit > stopLoss > 0',
      plan.takeProfit > plan.entryLimit && plan.entryLimit > plan.stopLoss && plan.stopLoss > 0,
      JSON.stringify({ entry: plan.entryLimit, sl: plan.stopLoss, tp: plan.takeProfit }));
    check('计划自洽：entryMin ≤ entryLimit ≤ entryMax', plan.entryMin <= plan.entryLimit && plan.entryLimit <= plan.entryMax);
    check('riskUnit ≥ minStopPct×entry', plan.riskUnit >= p.minStopPct * plan.entryLimit - 1e-9, `riskUnit=${plan.riskUnit}`);
    check('maxHoldBars = 96（15m 根）', plan.maxHoldBars === 96);
    check('窗口 80 根（生产窗口回归）', r.trend?.bars && r.trend.bars['15m'] === 80 && r.trend.bars['1h'] === 80 && r.trend.bars['4h'] === 80,
      JSON.stringify(r.trend?.bars));
    check('信号带结构摘要与评分', !!r.structure && Number.isFinite(r.score) && Number.isFinite(r.entryQuality));
    check('confidence ∈ (0, 1]', r.confidence > 0 && r.confidence <= 1, `confidence=${r.confidence}`);
  } else {
    check('完整多头结构 → BUY（合成序列需调参）', false, `实际 ${r.action}`);
  }
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ structure-long-v1 冒烟全部通过');
process.exit(fail ? 1 : 0);
