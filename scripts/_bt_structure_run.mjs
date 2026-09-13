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
 *     杠杆 = 生产同款 recommendedLeverage(plan, dir)（受 NOFX_MAX_LEVERAGE / NOFX_RISK_BUDGET_PCT 冻结）。
 *   · 挂单失效：15m 收盘有效突破 stopLoss（引擎 RISK_NOTE 的失效条件）或 24h 未成交；
 *     平仓后冷却 30 分钟 / 止损后 60 分钟（生产默认 NOFX_SYMBOL_COOLDOWN_MIN / NOFX_STOP_COOLDOWN_MIN）。
 *   · 简化（报告中披露）：未实现 decoratePlan 的分批止盈与 R 阶梯移动止损
 *     （两策略生产上 smartExit 默认关闭；trailing 属增益项，不影响 alpha 定性）。
 *
 * 用法（由 _bt_structure.mjs 分片调度，也可单跑）：
 *   BT_SYMBOLS=BTCUSDT,ETHUSDT BT_STRATEGY=structure-short BT_OUT=out.json \
 *   NOFX_MAX_LEVERAGE=12 NOFX_RISK_BUDGET_PCT=0.18 node scripts/_bt_structure_run.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { structureShortAnalysis } from '../server/structureShortAnalysis.js';
import { structureLongAnalysis } from '../server/structureLongAnalysis.js';
import { PAPER_COSTS } from '../server/research.js';
import { recommendedLeverage } from '../server/localAnalysis.js';
import { LONG_ONLY } from '../server/shared/strategyGuards.js';

const STRATEGY = process.env.BT_STRATEGY || 'structure-short';
if (!['structure-short', 'structure-long'].includes(STRATEGY)) {
  console.error(`BT_STRATEGY 必须是 structure-short | structure-long，得到 ${STRATEGY}`);
  process.exit(1);
}
const analyze = STRATEGY === 'structure-short' ? structureShortAnalysis : structureLongAnalysis;

const D1M = path.resolve(process.env.BT_DIR_1M || 'data/backtest/bf90-1m');
const D15 = path.resolve(process.env.BT_DIR_15M || 'data/backtest/bf90-15mrs');
const D1H = path.resolve(process.env.BT_DIR_1H || 'data/backtest/bf90-1hrs');
const D4H = path.resolve(process.env.BT_DIR_4H || 'data/backtest/bf90-4h');
const TF1M = 60000, TF15 = 900000, TF1H = 3600000, TF4H = 14400000;
const WINDOW = 80;                    // 与生产 getFreshMarket 的 80 根窗口一致
const MARGIN = 100;
const MAX_HOLD_1M = 96 * 15;          // plan.maxHoldBars(15m 根) × 15 = 1440 根 1m
const PENDING_TTL_1M = 96 * 15;       // 挂单 24h 未成交 → 撤
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

console.log(`== ${STRATEGY} 回测 worker ==  币种 ${files.length}  LONG_ONLY=${LONG_ONLY.enabled}  LEV≤${process.env.NOFX_MAX_LEVERAGE ?? 5} RISK=${process.env.NOFX_RISK_BUDGET_PCT ?? 0.1}`);
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

function runSymbol(symbol) {
  const bars1m = loadRows(D1M, `${symbol}.ndjson`, TF1M, true);
  const bars15 = loadRows(D15, `${symbol}.ndjson`, TF15);
  const bars1h = loadRows(D1H, `${symbol}.ndjson`, TF1H);
  const bars4h = loadRows(D4H, `${symbol}.ndjson`, TF4H);
  const N = bars1m.length;
  const trades = [], placed = [], cancels = [];
  let signalCount = 0;

  const hi15 = { i: 0 }, hi1h = { i: 0 }, hi4h = { i: 0 };
  let order = null;          // { plan, dir, status:'pending'|'open', ... }
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
      const invalid = order.dir === 1 ? bars15[j].close <= order.plan.stopLoss : bars15[j].close >= order.plan.stopLoss;
      const expired = decisionTime - Date.parse(order.createdAt) > PENDING_TTL_1M * 60000;
      if (invalid || expired) {
        cancels.push({
          symbol, direction: order.dir === 1 ? 'OPEN_LONG' : 'OPEN_SHORT', at: decisionTime,
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
        const sig = analyze({ symbol, interval: '1m', klines: [] }, {
          params: {},
          auxMarkets: {
            '15m': { symbol, interval: '15m', klines: w15, dataAsOf },
            '1h': { symbol, interval: '1h', klines: w1h, dataAsOf },
            '4h': { symbol, interval: '4h', klines: w4h, dataAsOf }
          }
        });
        if (sig && sig.action !== 'WAIT' && sig.plan) {
          signalCount++;
          const dir = sig.action === 'BUY' ? 1 : -1;
          const leverage = recommendedLeverage(sig.plan, dir === 1 ? 'OPEN_LONG' : 'OPEN_SHORT');
          order = {
            symbol, dir, plan: sig.plan, status: 'pending',
            notional: MARGIN * leverage, leverage, margin: MARGIN,
            score: sig.score ?? null, entryQuality: sig.entryQuality ?? null,
            createdAt: new Date(decisionTime).toISOString(),
            mStart: firstBarAtOrAfter(decisionTime)   // 决策后第一根 1m 才可能成交（无前视）
          };
          placed.push({ symbol, direction: dir === 1 ? 'OPEN_LONG' : 'OPEN_SHORT', at: bars15[j].openTime, score: order.score, entryQuality: order.entryQuality });
        }
      }
    }

    // ── 3. 推进 1m 执行（把 mIdx 推到下一个 15m 决策点为止）──
    const nextDecision = j + 1 < bars15.length ? bars15[j + 1].openTime + TF15 : Infinity;
    while (order && mIdx < N && bars1m[mIdx].openTime < nextDecision) {
      if (mIdx < order.mStart) { mIdx++; continue; }
      const row = bars1m[mIdx];
      const long = order.dir === 1;
      const plan = order.plan;
      const nowMs = row.openTime + TF1M;

      if (order.status === 'pending') {
        // 限价触达（_tryEntry.limit 语义）：多头 low≤entryLimit / 空头 high≥entryLimit
        const reached = long ? row.low <= plan.entryLimit : row.high >= plan.entryLimit;
        if (reached) {
          const slipped = plan.entryLimit * (1 + order.dir * PAPER_COSTS.slippageBps / 10000);
          const valid = long ? (slipped > plan.stopLoss && slipped < plan.takeProfit)
            : (slipped < plan.stopLoss && slipped > plan.takeProfit);
          if (valid) {
            order.status = 'open';
            order.entry = slipped;
            order.entryAt = new Date(row.openTime).toISOString();
            order.entryMs = row.openTime;
            order.entryFee = order.notional * PAPER_COSTS.feeBps / 10000;
            order.quantity = order.notional / slipped;
            order.held = 0;
            order.initialStop = plan.stopLoss;
            // 成交当根保守口径：触止损即按止损结算（_checkExit 的 ctx.entryBar 分支）
            const hitStop = long ? row.low <= plan.stopLoss : row.high >= plan.stopLoss;
            if (hitStop) { settle(order, plan.stopLoss, row.openTime + TF1M, 1, 'stop_loss', true); order = null; mIdx++; continue; }
          }
        }
        // 24h 未成交撤单（在 1m 粒度上兜底，防 15m 判定的边界漏网）
        if (order && order.status === 'pending' && row.openTime - Date.parse(order.createdAt) > PENDING_TTL_1M * 60000) {
          cancels.push({ symbol, direction: long ? 'OPEN_LONG' : 'OPEN_SHORT', at: nowMs, reason: 'pending_expired', waitMin: (row.openTime - Date.parse(order.createdAt)) / 60000 });
          order = null;
        }
      } else if (order.status === 'open') {
        order.held += 1;
        const hitStop = long ? row.low <= plan.stopLoss : row.high >= plan.stopLoss;
        const hitTarget = long ? row.high >= plan.takeProfit : row.low <= plan.takeProfit;
        if (hitStop && hitTarget) {
          // 同根双触发：开盘已越过止盈 → 按更优价止盈；否则保守按止损
          const openedBeyondTarget = long ? row.open >= plan.takeProfit : row.open <= plan.takeProfit;
          if (openedBeyondTarget) settle(order, long ? Math.max(row.open, plan.takeProfit) : Math.min(row.open, plan.takeProfit), nowMs, order.held, 'take_profit', true);
          else settle(order, long ? Math.min(row.open, plan.stopLoss) : Math.max(row.open, plan.stopLoss), nowMs, order.held, 'stop_loss', true);
          order = null;
        } else if (hitStop) {
          settle(order, long ? Math.min(row.open, plan.stopLoss) : Math.max(row.open, plan.stopLoss), nowMs, order.held, 'stop_loss', false);
          order = null;
        } else if (hitTarget) {
          settle(order, plan.takeProfit, nowMs, order.held, 'take_profit', false);
          order = null;
        } else if (order.held >= MAX_HOLD_1M) {
          settle(order, row.close, nowMs, order.held, 'timeout', false);
          order = null;
        }
      }
      if (!order) {
        cooldownUntilTs = Date.parse(trades.at(-1)?.exitAt || '') + (trades.at(-1)?.reason === 'stop_loss' ? STOP_COOLDOWN_1M : COOLDOWN_1M) * 60000;
      }
      mIdx++;
    }
  }
  if (order) trades.push({ symbol, status: order.status, unfinished: true });

  function settle(o, exitRaw, exitMs, held, reason, ambiguous) {
    const long = o.dir === 1;
    const exit = exitRaw * (1 - o.dir * PAPER_COSTS.slippageBps / 10000);
    const qty = o.quantity;
    const gross = o.dir * (exit - o.entry) * qty;
    const exitFee = exit * qty * PAPER_COSTS.feeBps / 10000;
    const funding = o.notional * PAPER_COSTS.fundingBpsPer8h / 10000 * (exitMs - o.entryMs) / 28800000;
    const net = gross - o.entryFee - exitFee - funding;
    trades.push({
      symbol, direction: long ? 'OPEN_LONG' : 'OPEN_SHORT',
      entry: o.entry, exit, entryAt: o.entryAt, exitAt: new Date(exitMs).toISOString(),
      heldBars: held, held15m: held / 15,
      reason, ambiguous,
      net, gross, fee: o.entryFee + exitFee, funding,
      roi: net / o.margin, leverage: o.leverage, margin: o.margin, notional: o.notional,
      waitBars: (o.entryMs - Date.parse(o.createdAt)) / 60000,
      score: o.score, entryQuality: o.entryQuality
    });
  }

  return { symbol, bars: N, signalCount, placed, trades, cancels };
}

// ───────────────────────── 执行 ─────────────────────────
const t0 = Date.now();
const all = [];
for (const f of files) {
  const symbol = f.replace(/\.ndjson$/, '');
  const t = Date.now();
  const r = runSymbol(symbol);
  all.push(r);
  const closed = r.trades.filter(x => !x.unfinished);
  const net = closed.reduce((a, x) => a + x.net, 0);
  console.log(`${symbol.padEnd(14)} 挂单=${String(r.placed.length).padStart(3)} 撤=${String(r.cancels.length).padStart(3)} 成交=${String(closed.length).padStart(3)} 净=${net.toFixed(1).padStart(8)}U  ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const trades = all.flatMap(r => r.trades.filter(x => !x.unfinished));
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  config: { strategy: STRATEGY, window: WINDOW, margin: MARGIN, decisionTf: '15m', execTf: '1m',
    maxHold1m: MAX_HOLD_1M, pendingTtlMin: PENDING_TTL_1M,
    longOnly: LONG_ONLY.enabled,
    maxLeverage: Number(process.env.NOFX_MAX_LEVERAGE ?? 5),
    riskBudgetPct: Number(process.env.NOFX_RISK_BUDGET_PCT ?? 0.1) },
  symbols: all.map(r => ({ symbol: r.symbol, bars: r.bars, placed: r.placed.length, cancelled: r.cancels.length, filled: r.trades.filter(x => !x.unfinished).length })),
  trades, placed: all.flatMap(r => r.placed), cancels: all.flatMap(r => r.cancels)
}, null, 1));

const net = trades.reduce((a, x) => a + x.net, 0);
const wins = trades.filter(x => x.net > 0);
const gl = Math.abs(trades.filter(x => x.net <= 0).reduce((a, x) => a + x.net, 0));
console.log(`\n[${STRATEGY}] 挂单 ${all.flatMap(r => r.placed).length}  成交 ${trades.length}  净 ${net.toFixed(1)}U  胜率 ${(100 * wins.length / (trades.length || 1)).toFixed(1)}%  PF ${gl > 0 ? (net + gl) / gl : '∞'}  用时 ${((Date.now() - t0) / 60000).toFixed(1)}min`);
