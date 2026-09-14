/**
 * 结构策略（structure-short-v1 / structure-long-v1）专用回测 worker
 *
 * 口径（对齐取证工作流铁律）：
 *   · 决策在 15m 收盘时刻（planInterval='15m'），窗口 = 已收盘 80 根 15m / 1h / 4h
 *     —— 全部按绝对 epoch 过滤（closeTime ≤ 决策时刻），跨周期同源（bf90 派生语料同出自 1m）。
 *   · 执行在 1m：限价触达成交（多头 low≤entryLimit / 空头 high≥entryLimit，成交价含滑点）、
 *     SL/TP 逐根判定、同根双触发取 SL（保守）、成交当根触 SL 即按 SL 结算
 *     —— 与 server/tradingSimulator._tryEntry/_checkExit 的语义逐位一致。
 *   · 记账与 _settle 一致：qty=notional/entry，入场费=notional×fee，出场滑点，资金费按时长；
 *     杠杆 = 正式策略 plan.recommendedLeverage（由 data/strategies.json 的风险参数计算）。
 *   · 挂单失效：15m 收盘有效突破 stopLoss（引擎 RISK_NOTE 的失效条件）或 24h 未成交；
 *     平仓后冷却 30 分钟 / 止损后 60 分钟（生产默认 NOFX_SYMBOL_COOLDOWN_MIN / NOFX_STOP_COOLDOWN_MIN）。
 *   · 策略分析、参数解析、计划装饰和持仓复核均直接调用 server/strategies 注册定义；
 *     回测只负责时间推进与成交撮合，不复制正式策略逻辑。
 *
 * 用法（由 _bt_structure.mjs 分片调度，也可单跑）：
 *   BT_SYMBOLS=BTCUSDT,ETHUSDT BT_STRATEGY=structure-short BT_OUT=out.json \
 *   NOFX_MAX_LEVERAGE=12 NOFX_RISK_BUDGET_PCT=0.18 node scripts/_bt_structure_run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfiguredStrategy } from '../server/strategies/loader.js';
import { PAPER_COSTS } from '../server/research.js';
import { recommendedLeverage } from '../server/localAnalysis.js';
import { createAccountSimulator } from '../server/tradingSimulator.js';
import { applyPaperProtectionReview } from '../server/shared/protectionReview.js';
import { LONG_ONLY, RISK_RULE } from '../server/shared/strategyGuards.js';

const STRATEGY_ALIASES = {
  'structure-short': 'structure-short-v1',
  'structure-long': 'structure-long-v1'
};
const STRATEGY = STRATEGY_ALIASES[process.env.BT_STRATEGY || 'structure-short-v1']
  || process.env.BT_STRATEGY
  || 'structure-short-v1';
if (!['structure-short-v1', 'structure-long-v1'].includes(STRATEGY)) {
  console.error(`BT_STRATEGY 必须是 structure-short-v1 | structure-long-v1，得到 ${STRATEGY}`);
  process.exit(1);
}
const STRATEGY_CONFIG_PATH = process.env.BT_STRATEGY_CONFIG || 'data/strategies.json';
const { strategy: STRATEGY_DEF, config: STRATEGY_CONFIG } = await loadConfiguredStrategy(STRATEGY, {
  strategyPath: STRATEGY_CONFIG_PATH,
  configPath: process.env.BT_CONFIG || 'data/config.json'
});
const STRATEGY_PARAMS = STRATEGY_DEF.params;
const PLAN_INTERVAL = STRATEGY_DEF.planInterval || '15m';
const EXECUTION_INTERVAL = process.env.BT_EXECUTION_INTERVAL || '1m';

const D1M = path.resolve(process.env.BT_DIR_1M || 'data/backtest/bf90-1m');
const D15 = path.resolve(process.env.BT_DIR_15M || 'data/backtest/bf90-15mrs');
const D1H = path.resolve(process.env.BT_DIR_1H || 'data/backtest/bf90-1hrs');
const D4H = path.resolve(process.env.BT_DIR_4H || 'data/backtest/bf90-4h');
const TF1M = 60000, TF15 = 900000, TF1H = 3600000, TF4H = 14400000;
const WINDOW = 80;                    // 与生产 getFreshMarket 的 80 根窗口一致
const MARGIN = 100;
const PENDING_TTL_1M = 24 * 60;       // 生产统一挂单 TTL：24h
const COOLDOWN_1M = 30;               // 平仓后 30 分钟（1m 根）
const STOP_COOLDOWN_1M = 60;          // 止损后 60 分钟
const OUT = path.join(D1M, process.env.BT_OUT || 'structure-result.json');

const meta = JSON.parse(fs.readFileSync(path.join(D1M, 'meta.json'), 'utf8'));
const BARS_TARGET = Number(meta.barsTarget) || Math.max(...(meta.symbols || []).map(s => Number(s.bars) || 0));
const goodBars = new Map((meta.symbols || []).filter(s => Number(s.bars) >= BARS_TARGET * 0.95).map(s => [s.symbol, Number(s.bars)]));
const SYMBOL_FILTER = (process.env.BT_SYMBOLS || '').split(',').map(s => s.trim()).filter(Boolean);
const files = fs.readdirSync(path.join(D1M, 'klines')).filter(f => f.endsWith('.ndjson'))
  .filter(f => !SYMBOL_FILTER.length || SYMBOL_FILTER.includes(f.replace(/\.ndjson$/, '')))
  .filter(f => goodBars.has(f.replace(/\.ndjson$/, '')));

console.log(`== ${STRATEGY} 回测 worker ==  币种 ${files.length}  LONG_ONLY=${LONG_ONLY.enabled}`);
console.log(`  正式配置 ${STRATEGY_CONFIG_PATH}  参数=${JSON.stringify(STRATEGY_PARAMS)}`);
console.log(`  成本 fee=${PAPER_COSTS.feeBps}bps slip=${PAPER_COSTS.slippageBps}bps funding=${PAPER_COSTS.fundingBpsPer8h}bps/8h  保证金 ${MARGIN}U/单`);

function loadRows(dir, file, tf, fillGaps = false) {
  const txt = fs.readFileSync(path.join(dir, 'klines', file), 'utf8');
  const rows = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    const [t, o, h, l, c, v] = line.split(',').map(Number);
    rows.push({ openTime: t, open: o, high: h, low: l, close: c, volume: v });
  }
  rows.sort((a, b) => a.openTime - b.openTime);
  if (!fillGaps) return rows;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i && rows[i].openTime !== rows[i - 1].openTime + tf) {
      let t = rows[i - 1].openTime + tf;
      const prev = rows[i - 1].close;
      while (t < rows[i].openTime) { out.push({ openTime: t, open: prev, high: prev, low: prev, close: prev, volume: 0 }); t += tf; }
    }
    out.push(rows[i]);
  }
  return out;
}

/** 已收盘窗口：openTime + tf ≤ decisionTime 的最后 n 根（hi 指针单调推进，均摊 O(1)） */
function windowClosed(rows, hiRef, tf, decisionTime, n) {
  while (hiRef.i < rows.length && rows[hiRef.i].openTime + tf <= decisionTime) hiRef.i++;
  const end = hiRef.i;
  return end >= n ? rows.slice(end - n, end) : null;
}

/**
 * 执行窗口裁剪的等价性取证（默认关闭）
 *
 * 背景：simulator._simulate 只通过 byTime 索引与 MA20/ATR14 序列读取 rows，
 * 且两者的取值时刻都落在 [order.startTime, now] 内（MA/ATR 另需该区间之前 20 根）。
 * 故把 evaluate 的 rows 从「全量 129,600 根」裁到「挂单前 200 根起」后结果应逐位不变。
 *
 * 开法：STRUCT_VERIFY_FULL=N（N=1 全量对拍，N>1 表示每 N 次 evaluate 抽一次）。
 * 成本：被抽到的调用会额外跑一遍**全量** evaluate（很慢），仅用于取证，勿用于正式回测。
 */
const VERIFY_FULL = Math.max(0, Number(process.env.STRUCT_VERIFY_FULL || 0));
let verifyCalls = 0, verifyChecked = 0, verifyMismatch = 0;
const normJson = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x)) ? `__num:${x}` : x);
function verifyWindowEquivalence(simulator, order, bars1m, lo, hi, nowMs) {
  verifyCalls++;
  if (VERIFY_FULL > 1 && verifyCalls % VERIFY_FULL !== 0) return;
  const cloneA = JSON.parse(JSON.stringify(order));
  const cloneB = JSON.parse(JSON.stringify(order));
  let full, win;
  try { full = simulator.evaluate(cloneA, bars1m, nowMs); } catch (e) { full = { error: String(e.message) }; }
  try { win = simulator.evaluate(cloneB, bars1m.slice(lo, hi), nowMs); } catch (e) { win = { error: String(e.message) }; }
  verifyChecked++;
  if (normJson(full) !== normJson(win)) {
    verifyMismatch++;
    if (verifyMismatch <= 3) {
      console.error(`\n❌ 窗口不等价 ${order.symbol} now=${new Date(nowMs).toISOString()}`);
      console.error('   全量:', normJson(full).slice(0, 400));
      console.error('   窗口:', normJson(win).slice(0, 400));
    }
  }
}

async function runSymbol(symbol) {
  const bars1m = loadRows(D1M, `${symbol}.ndjson`, TF1M, true);
  const bars15 = loadRows(D15, `${symbol}.ndjson`, TF15);
  const bars1h = loadRows(D1H, `${symbol}.ndjson`, TF1H);
  const bars4h = loadRows(D4H, `${symbol}.ndjson`, TF4H);
  const N = bars1m.length;
  const trades = [], placed = [], cancels = [];
  let signalCount = 0;
  const simulator = createAccountSimulator({
    enableLiquidation: true,
    enableIsolatedMargin: true,
    enableDynamicProtection: true,
    initialBalance: 100000000
  });

  const hi15 = { i: 0 }, hi1h = { i: 0 }, hi4h = { i: 0 };
  let order = null;          // 生产模拟器输入订单
  let cooldownUntilTs = -1;  // 决策时刻戳（15m 收盘时刻）口径的冷却
  let mIdx = 0;              // 1m 推进指针

  const firstBarAtOrAfter = (t) => {
    let lo = 0, hi = N;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bars1m[mid].openTime < t) lo = mid + 1; else hi = mid; }
    return lo;
  };

  for (let j = WINDOW - 1; j < bars15.length; j++) {
    const decisionTime = bars15[j].openTime + TF15;

    // ── 1. 挂单失效判定（15m 收盘有效突破止损 = 引擎声明的失效条件）──
    if (order && order.status === 'pending') {
      const long = order.direction === 'OPEN_LONG';
      const invalid = long ? bars15[j].close <= order.plan.stopLoss : bars15[j].close >= order.plan.stopLoss;
      const expired = decisionTime - Date.parse(order.createdAt) > PENDING_TTL_1M * 60000;
      if (invalid || expired) {
        cancels.push({
          symbol, direction: order.direction, at: decisionTime,
          reason: invalid ? 'invalidated' : 'pending_expired',
          waitMin: (decisionTime - Date.parse(order.createdAt)) / 60000
        });
        order = null;
      }
    }

    // ── 2. 无持仓/挂单 且 过冷却 → 决策 ──
    if (!order && decisionTime >= cooldownUntilTs) {
      const w15 = windowClosed(bars15, hi15, TF15, decisionTime, WINDOW);
      const w1h = windowClosed(bars1h, hi1h, TF1H, decisionTime, WINDOW);
      const w4h = windowClosed(bars4h, hi4h, TF4H, decisionTime, WINDOW);
      if (w15 && w1h && w4h) {
        const dataAsOf = new Date(decisionTime).toISOString();
        const sig = await STRATEGY_DEF.analyze({ symbol, interval: PLAN_INTERVAL, klines: w15, dataAsOf }, {
          params: STRATEGY_PARAMS,
          config: STRATEGY_CONFIG,
          interval: PLAN_INTERVAL,
          planInterval: PLAN_INTERVAL,
          auxMarkets: {
            '15m': { symbol, interval: '15m', klines: w15, dataAsOf },
            '1h': { symbol, interval: '1h', klines: w1h, dataAsOf },
            '4h': { symbol, interval: '4h', klines: w4h, dataAsOf }
          }
        });
        if (sig && sig.action !== 'WAIT' && sig.plan) {
          signalCount++;
          const dir = sig.action === 'BUY' ? 1 : -1;
          let plan = { ...sig.plan };
          if (typeof STRATEGY_DEF.decoratePlan === 'function') {
            plan = await STRATEGY_DEF.decoratePlan(plan, {
              params: STRATEGY_PARAMS,
              config: STRATEGY_CONFIG,
              interval: PLAN_INTERVAL,
              planInterval: PLAN_INTERVAL
            });
          }
          const strategyLeverage = Number(plan.recommendedLeverage ?? sig.recommendedLeverage);
          const requestedLeverage = Number.isFinite(strategyLeverage) && strategyLeverage > 0
            ? Math.floor(strategyLeverage)
            : recommendedLeverage(plan, dir === 1 ? 'OPEN_LONG' : 'OPEN_SHORT', STRATEGY_PARAMS);
          const leverage = Math.max(1, Math.min(RISK_RULE.maxLeverage, requestedLeverage));
          const executionPlan = {
            ...plan,
            maxHoldBars: Math.round((Number(plan.maxHoldBars) || 96) * 15)
          };
          const createdAt = new Date(decisionTime).toISOString();
          order = {
            id: `${symbol}-${decisionTime}`,
            symbol, direction: dir === 1 ? 'OPEN_LONG' : 'OPEN_SHORT', interval: EXECUTION_INTERVAL,
            plan: executionPlan,
            initialPlan: { ...executionPlan }, status: 'pending',
            notional: MARGIN * leverage, leverage, margin: MARGIN,
            costs: { ...PAPER_COSTS }, createdAt,
            nextTime: firstBarAtOrAfter(decisionTime) < N ? bars1m[firstBarAtOrAfter(decisionTime)].openTime : decisionTime,
            score: sig.score ?? null, entryQuality: sig.entryQuality ?? null,
            analysisContext: { strategyId: STRATEGY, strategyParams: STRATEGY_PARAMS },
            protectionRevisions: [], reviewHistory: []
          };
          placed.push({ symbol, direction: dir === 1 ? 'OPEN_LONG' : 'OPEN_SHORT', at: bars15[j].openTime, score: order.score, entryQuality: order.entryQuality });
        }
      }
    }

    // ── 3. 推进 1m 执行：每根 K 线直接调用生产 TradingSimulator ──
    // ⚡ 执行窗口下界（性能关键）：simulator._simulate 会**按传入的 rows 重建**
    // byTime 索引表，并在 barLevelMaExit 时按整段重算 MA20/ATR14 序列。若照原样
    // 传全量 129,600 根，则每根 1m 都要重建一次全量索引（实测 ~7 分钟/币）。
    // 而 _simulate 只会读取 [order.startTime, now] 区间的时间戳，MA/ATR 也只需
    // 该区间之前的 20 根。故下界取「挂单创建时刻的 1m 索引 − 200 根」（200 根余量
    // 覆盖 MA20/ATR14 及其它可能的前视），结果与全量传入逐位一致。
    const execLo = order ? Math.max(0, firstBarAtOrAfter(Date.parse(order.createdAt)) - 200) : 0;
    const nextDecision = j + 1 < bars15.length ? bars15[j + 1].openTime + TF15 : Infinity;
    while (order && mIdx < N && bars1m[mIdx].openTime < nextDecision) {
      const row = bars1m[mIdx];
      const nowMs = row.openTime + TF1M;
      const result = simulator.evaluate(order, bars1m.slice(execLo, mIdx + 1), nowMs);
      if (VERIFY_FULL) verifyWindowEquivalence(simulator, order, bars1m, execLo, mIdx + 1, nowMs);
      for (const key of ['nextTime', 'entry', 'entryAt', 'heldBars', 'quantity', 'entryFee',
        'liquidationPrice', 'markPrice', 'markAt', 'unrealized', 'tpStage', 'tpStopFloor',
        'realizedGross', 'realizedFee', 'realizedFunding', 'realizedNet', 'realizedQty']) {
        if (result[key] !== undefined && result[key] !== null) order[key] = result[key];
      }
      if (result.status === 'open' && order.entry) {
        const market = { symbol, interval: EXECUTION_INTERVAL, klines: bars1m.slice(Math.max(0, mIdx - 80), mIdx + 1) };
        const proposal = await STRATEGY_DEF.review(order, market, {
          params: STRATEGY_PARAMS,
          config: STRATEGY_CONFIG,
          interval: EXECUTION_INTERVAL,
          planInterval: PLAN_INTERVAL
        });
        applyPaperProtectionReview(order, proposal, nowMs, STRATEGY_DEF.engine);
      }
      if (result.status === 'closed') {
        const trade = { symbol, direction: order.direction, ...result,
          // 成本拆解必需：TradingSimulator 的结果里没有 notional/leverage（旧结果有），
          // 缺了它「毛/名义 vs 往返成本」这条核心诊断会退化成 NaN（报告显示 –）。
          notional: order.notional, leverage: order.leverage, margin: order.margin,
          waitBars: result.entryAt ? (Date.parse(result.entryAt) - Date.parse(order.createdAt)) / 60000 : null,
          score: order.score, entryQuality: order.entryQuality, unfinished: false };
        trades.push(trade);
        const cooldown = result.reason === 'stop_loss' || result.reason === 'trailing_stop' || result.reason === 'break_even_stop'
          ? STOP_COOLDOWN_1M : COOLDOWN_1M;
        cooldownUntilTs = Date.parse(result.exitAt) + cooldown * 60000;
        order = null;
      } else if (result.status === 'expired') {
        cancels.push({ symbol, direction: order.direction, at: nowMs, reason: result.reason,
          waitMin: (nowMs - Date.parse(order.createdAt)) / 60000 });
        order = null;
      } else {
        order = { ...order, status: result.status };
        const next = Number(result.nextTime);
        const advanced = Number.isFinite(next) ? firstBarAtOrAfter(next) : mIdx + 1;
        mIdx = Math.max(mIdx + 1, advanced);
      }
    }
  }
  if (order) trades.push({ symbol, status: order.status, unfinished: true });

  return { symbol, bars: N, signalCount, placed, trades, cancels };
}

// ───────────────────────── 执行 ─────────────────────────
const t0 = Date.now();
const all = [];
for (const f of files) {
  const symbol = f.replace(/\.ndjson$/, '');
  const t = Date.now();
  const r = await runSymbol(symbol);
  all.push(r);
  const closed = r.trades.filter(x => !x.unfinished);
  const net = closed.reduce((a, x) => a + x.net, 0);
  console.log(`${symbol.padEnd(14)} 挂单=${String(r.placed.length).padStart(3)} 撤=${String(r.cancels.length).padStart(3)} 成交=${String(closed.length).padStart(3)} 净=${net.toFixed(1).padStart(8)}U  ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const trades = all.flatMap(r => r.trades.filter(x => !x.unfinished));
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  config: { strategy: STRATEGY, strategyConfigPath: STRATEGY_CONFIG_PATH, strategyParams: STRATEGY_PARAMS,
    window: WINDOW, margin: MARGIN, decisionTf: PLAN_INTERVAL, execTf: EXECUTION_INTERVAL,
    maxHold1m: 'plan.maxHoldBars × 15 (生产模拟器)', pendingTtlMin: PENDING_TTL_1M,
    longOnly: LONG_ONLY.enabled,
    maxLeverage: Number(STRATEGY_PARAMS.maxLeverage),
    systemMaxLeverage: RISK_RULE.maxLeverage,
    riskBudgetPct: Number(STRATEGY_PARAMS.riskBudgetPct) },
  symbols: all.map(r => ({ symbol: r.symbol, bars: r.bars, placed: r.placed.length, cancelled: r.cancels.length, filled: r.trades.filter(x => !x.unfinished).length })),
  trades, placed: all.flatMap(r => r.placed), cancels: all.flatMap(r => r.cancels)
}, null, 1));

const net = trades.reduce((a, x) => a + x.net, 0);
const wins = trades.filter(x => x.net > 0);
const gl = Math.abs(trades.filter(x => x.net <= 0).reduce((a, x) => a + x.net, 0));
console.log(`\n[${STRATEGY}] 挂单 ${all.flatMap(r => r.placed).length}  成交 ${trades.length}  净 ${net.toFixed(1)}U  胜率 ${(100 * wins.length / (trades.length || 1)).toFixed(1)}%  PF ${gl > 0 ? (net + gl) / gl : '∞'}  用时 ${((Date.now() - t0) / 60000).toFixed(1)}min`);
if (VERIFY_FULL) {
  console.log(`[verify] 全量对拍抽样 ${verifyChecked}/${verifyCalls} 次 evaluate → 不一致 ${verifyMismatch} 次  ${verifyMismatch === 0 ? '✅ 窗口裁剪与全量逐位等价' : '❌ 存在差异，裁剪不可用'}`);
}
