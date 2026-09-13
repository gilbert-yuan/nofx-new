/**
 * 随机 50 币 × 近 30 天 1m K 线 —— 当前线上策略全量回测
 *
 * 保真口径（全部复用生产代码，零重写策略逻辑）：
 *   信号生成   server/enhancedAnalysis.js  → enhancedAnalysis()      （engine=enhanced，与 data/config.json 一致）
 *   挂单复核   server/shared/pendingReview.js → applyPendingReview() （方向反转立即撤 / 软门槛 30 分钟宽限）
 *   持仓复核   server/enhancedAnalysis.js  → enhancedProtectionReview()（移动止损阶梯 + 智能退出 CLOSE）
 *   保护写回   server/shared/protectionReview.js → applyPaperProtectionReview()
 *   逐根结算   server/tradingSimulator.js  → _simulate()/_settle()   （分批止盈 / 止损止盈 / 根级均线失守 / 超时）
 *
 * 与线上一致的工程约束：
 *   · 主周期 1m，分析窗口 80 根（globalAutomation limit=80）
 *   · 信号在 bar[i] 收盘产生，入场最早从 bar[i+2] 开始（firstEntryAt 口径）
 *   · 同币种同时只允许 1 笔 pending/open
 *   · 平仓后冷却 30 分钟；止损平仓后冷却 60 分钟（SYMBOL_COOLDOWN_MIN / STOP_COOLDOWN_MIN）
 *   · 每单保证金 100 USDT，杠杆由 recommendedLeverage(plan) 决定（≤5x）
 *
 * 运行前需设置（与 ecosystem.config.cjs 完全一致）：
 *   NOFX_LONG_ONLY=true  NOFX_MIN_TREND_SCORE=70
 */
import fs from 'node:fs';
import path from 'node:path';
import { enhancedAnalysis, enhancedProtectionReview } from '../server/enhancedAnalysis.js';
import { applyPaperProtectionReview } from '../server/shared/protectionReview.js';
import { applyPendingReview } from '../server/shared/pendingReview.js';
import { TradingSimulator } from '../server/tradingSimulator.js';
import { PAPER_COSTS } from '../server/research.js';
import { recommendedLeverage } from '../server/localAnalysis.js';
import { LONG_ONLY } from '../server/shared/strategyGuards.js';
import { pumpFadeShortAnalysis } from '../server/pumpFadeShortAnalysis.js';
import { localProtectionReview } from '../server/shared/protectionReview.js';

// 策略开关（2026-09-13）：enhanced = 线上做多主策略 enhanced-trend-v1（默认，老行为零变化）；
// pump-short = 冲高回落空 v1（15m，线上 engine='pump-short'），信号/复核全走生产函数。
// pump-short 用法：BT_STRATEGY=pump-short BT_TF_MS=900000 BT_DIR=data/backtest/bf90-15mrs
const STRATEGY = process.env.BT_STRATEGY || 'enhanced';

const DIR = path.resolve(process.env.BT_DIR || 'data/backtest');
const KDIR = path.join(DIR, 'klines');
const WINDOW = 80;
const MARGIN = 100;
// 周期参数化（2026-09-12）：BT_TF_MS 默认 60000(1m) 与老链路完全一致；15m 传 900000。
// 冷却线上口径是分钟（平仓30分/止损60分），按周期折算成根数。
const TF = Number(process.env.BT_TF_MS || 60000);
const TF_MIN = TF / 60000;
const INTERVAL = TF === 60000 ? '1m' : TF === 900000 ? '15m' : TF === 3600000 ? '1h' : TF === 14400000 ? '4h' : `${TF / 60000}m`;
const SYMBOL_COOLDOWN = Math.max(1, Math.round(30 / TF_MIN));   // NOFX_SYMBOL_COOLDOWN_MIN 默认 30
const STOP_COOLDOWN = Math.max(1, Math.round(60 / TF_MIN));     // NOFX_STOP_COOLDOWN_MIN 默认 60
const MIN_HOLD = Number(process.env.NOFX_MIN_HOLD_BARS ?? 0); // 实验：最小持仓根数（智能退出保护）

const OUT_NAME = process.env.BT_OUT || 'result.json';
// 参数覆盖（仅回测 harness，生产未用）：JSON 形式的 ENHANCED_PARAM_SCHEMA 字段。
// 例：BT_PARAM_OVERRIDES='{"pullbackAtrShallow":2,"pullbackAtrDeep":2}' → 限价挂单深度
// 钉死在 2 ATR（不再随评分在 1.5~2.0 之间滑动）。不设则完全走 env 默认值，老行为零变化。
let PARAM_OVERRIDES = null;
try {
  PARAM_OVERRIDES = process.env.BT_PARAM_OVERRIDES ? JSON.parse(process.env.BT_PARAM_OVERRIDES) : null;
} catch (e) {
  console.error('BT_PARAM_OVERRIDES 解析失败:', e.message);
  process.exit(1);
}
// 实验开关（仅回测 harness，生产未用）：入场 N 根内浮亏 ≤ -cutoffR 时市价减半一次。
const EARLY_CUT_R = Number(process.env.NOFX_BT_EARLY_CUT_R ?? 0);
const EARLY_CUT_BARS = Number(process.env.NOFX_BT_EARLY_CUT_BARS ?? 5);
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
// 只回测数据完整的币种（补齐替换后，原数据不足的币仍留在磁盘上）
// 派生语料（bf90-15mrs 等）meta 没有 barsTarget —— 用样本最大根数兜底。
const BARS_TARGET_BT = Number(meta.barsTarget) || Math.max(...(meta.symbols || []).map(s => Number(s.bars) || 0));
const goodBars = new Map((meta.symbols || []).filter(s => Number(s.bars) >= BARS_TARGET_BT * 0.95).map(s => [s.symbol, Number(s.bars)]));
const allFilesRaw = process.argv[2] ? [process.argv[2]] : fs.readdirSync(KDIR).filter(f => f.endsWith('.ndjson'));
// BT_SYMBOLS：可选币种子集（逗号分隔，不含 .ndjson）。用于分片并行回测；不设则跑全量（老行为零变化）。
const SYMBOL_FILTER = (process.env.BT_SYMBOLS || '').split(',').map(s => s.trim()).filter(Boolean);
const allFiles = SYMBOL_FILTER.length
  ? allFilesRaw.filter(f => SYMBOL_FILTER.includes(f.replace(/\.ndjson$/, '')))
  : allFilesRaw;
const skipped = [];
const files = allFiles.filter(f => {
  const s = f.replace(/\.ndjson$/, '');
  if (goodBars.has(s)) return true;
  skipped.push(s);
  return false;
});

console.log('== 回测配置 ==');
console.log(`  禁空 LONG_ONLY=${LONG_ONLY.enabled}   评分门槛 NOFX_MIN_TREND_SCORE=${process.env.NOFX_MIN_TREND_SCORE ?? '(默认66)'}`);
console.log(`  周期 ${INTERVAL}  窗口 ${WINDOW} 根  保证金 ${MARGIN}U/单  冷却 平仓${SYMBOL_COOLDOWN}根(${Math.round(SYMBOL_COOLDOWN * TF_MIN)}分)/止损${STOP_COOLDOWN}根(${Math.round(STOP_COOLDOWN * TF_MIN)}分)`);
console.log(`  成本 fee=${PAPER_COSTS.feeBps}bps slip=${PAPER_COSTS.slippageBps}bps funding=${PAPER_COSTS.fundingBpsPer8h}bps/8h`);
console.log(`  币种数 ${files.length}\n`);

function loadBars(file) {
  const txt = fs.readFileSync(path.join(KDIR, file), 'utf8');
  const rows = txt.split('\n').filter(Boolean).map(line => {
    const [t, o, h, l, c, v] = line.split(',').map(Number);
    return { openTime: t, open: o, high: h, low: l, close: c, volume: v, closeTime: t + TF - 1 };
  }).sort((a, b) => a.openTime - b.openTime);
  // 补齐缺口：K 线序列必须连续，否则 simulator 会 data_gap
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i && rows[i].openTime !== rows[i - 1].openTime + TF) {
      let t = rows[i - 1].openTime + TF;
      const prev = rows[i - 1].close;
      while (t < rows[i].openTime) {
        out.push({ openTime: t, open: prev, high: prev, low: prev, close: prev, volume: 0, closeTime: t + TF - 1 });
        t += TF;
      }
    }
    out.push(rows[i]);
  }
  return out;
}

function runSymbol(symbol, bars) {
  const sim = new TradingSimulator({ mode: 'account', maxPositions: Infinity, allowDuplicateSymbol: false });
  const trades = [], cancels = [], placed = [];
  let active = null, cooldownUntil = -1, signalCount = 0;
  const N = bars.length;

  for (let i = WINDOW; i < N; i++) {
    const now = bars[i].openTime + TF;

    // ── A. 推进活跃单一根（simulator 内部：入场/分批止盈/止损止盈/根级均线失守/超时）
    if (active && active.nextTime === bars[i].openTime) {
      const ev = sim.evaluate(active, [bars[i]], now);
      if (ev.status === 'closed') {
        const t = finalizeTrade(active, ev, 'sim');
        if (t) trades.push(t);
        cooldownUntil = ev.reason === 'stop_loss' ? i + STOP_COOLDOWN : i + SYMBOL_COOLDOWN;
        active = null;
      } else if (ev.status === 'data_gap') {
        active = null;
      } else {
        Object.assign(active, {
          nextTime: ev.nextTime,
          entry: ev.entry ?? active.entry,
          entryAt: ev.entryAt ?? active.entryAt,
          heldBars: ev.heldBars,
          quantity: ev.quantity,
          entryFee: ev.entryFee,
          tpStage: ev.tpStage,
          tpStopFloor: ev.tpStopFloor,
          realizedGross: ev.realizedGross, realizedFee: ev.realizedFee,
          realizedFunding: ev.realizedFunding, realizedNet: ev.realizedNet, realizedQty: ev.realizedQty,
          status: ev.status,
          markPrice: bars[i].close,
          markAt: new Date(now).toISOString()
        });
      }
    }

    // ── A2. 实验性提前减半（仅回测）：入场 N 根内浮亏超过 cutoffR → 市价减半一次 ──
    // 账目口径与 tradingSimulator._settle 一致（滑点/双边手续费/资金费按 share 分摊），
    // 减半部分直接并入 realized 累计器，最终平仓时 _settle 自动汇总，避免双算。
    if (active && active.status === 'open' && EARLY_CUT_R > 0 && !active._earlyCut
        && Number(active.heldBars || 0) >= 1 && Number(active.heldBars || 0) <= EARLY_CUT_BARS) {
      const entryPx = Number(active.entry);
      const stopPx = Number(active.plan?.stopLoss);
      const ru = Number(active.plan?.riskUnit)
        || (Number.isFinite(entryPx) && Number.isFinite(stopPx) ? Math.abs(entryPx - stopPx) : NaN);
      const long = active.direction === 'OPEN_LONG';
      const px = bars[i].close;
      if (Number.isFinite(entryPx) && Number.isFinite(ru) && ru > 0 && px > 0) {
        const profitR = (long ? px - entryPx : entryPx - px) / ru;
        if (profitR <= -EARLY_CUT_R) {
          const costs = active.costs;
          const dirSign = long ? 1 : -1;
          const halfQty = Number(active.quantity) / 2;
          const exitPx = px * (1 - dirSign * costs.slippageBps / 10000);
          const priorQty = Number(active.realizedQty) || 0;
          const origQty = priorQty + Number(active.quantity);
          const share = origQty > 0 ? halfQty / origQty : 0;
          const grossCut = dirSign * (exitPx - entryPx) * halfQty;
          const entryFeeCut = (Number(active.entryFee) || 0) * share;
          const exitFeeCut = exitPx * halfQty * costs.feeBps / 10000;
          const entryMs = Date.parse(active.entryAt);
          const nowMs = bars[i].openTime + TF;
          const fundCut = (Number(active.notional) * share) * costs.fundingBpsPer8h / 10000
            * Math.max(0, nowMs - entryMs) / 28800000;
          const netCut = grossCut - entryFeeCut - exitFeeCut - fundCut;
          active.realizedGross = (Number(active.realizedGross) || 0) + grossCut;
          active.realizedFee = (Number(active.realizedFee) || 0) + entryFeeCut + exitFeeCut;
          active.realizedFunding = (Number(active.realizedFunding) || 0) + fundCut;
          active.realizedNet = (Number(active.realizedNet) || 0) + netCut;
          active.realizedQty = priorQty + halfQty;
          active.quantity = Number(active.quantity) - halfQty;
          active._earlyCut = true;
        }
      }
    }

    const needSignal = !active || active.status === 'pending';
    let sig = null;
    if (needSignal) {
      sig = STRATEGY === 'pump-short'
        ? pumpFadeShortAnalysis({ symbol, interval: INTERVAL, klines: bars.slice(i - WINDOW + 1, i + 1) },
            PARAM_OVERRIDES ? { params: PARAM_OVERRIDES } : {})
        : enhancedAnalysis({ symbol, interval: INTERVAL, klines: bars.slice(i - WINDOW + 1, i + 1) }, PARAM_OVERRIDES || undefined);
    }

    // ── B. 挂单复核（方向反转立即撤 / 软门槛连续不合格 30 分钟宽限）
    if (active && active.status === 'pending' && sig) {
      const rec = sig.action === 'WAIT' ? 'WAIT' : sig.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT';
      applyPendingReview(active, {
        positionRecommendation: rec,
        eligible: rec !== 'WAIT' && !!sig.plan,
        reason: sig.reason,
        dataAsOf: new Date(bars[i].openTime + TF).toISOString(),
        validationIssues: []
      }, now);
      if (active.status === 'cancelled') {
        const last = (active.reviewHistory || []).at(-1);
        cancels.push({
          symbol, direction: active.direction, at: now, createdAt: active.createdAt,
          reason: active.reason, detail: String(last?.reason || '').slice(0, 160),
          waitBars: (now - Date.parse(active.createdAt)) / 60000
        });
        active = null;
      }
    }

    // ── C. 持仓复核（智能退出 CLOSE + 移动止损写回）
    if (active && active.status === 'open') {
      const market = { symbol, interval: INTERVAL, klines: bars.slice(Math.max(0, i - WINDOW + 1), i + 1) };
      // pump-short 用生产同款 localProtectionReview（R 口径移动止损阶梯，方向对称），
      // 它只出 HOLD/REVISE，不出 CLOSE —— 该策略生产上 SMART_EXIT 也是关闭的，口径一致。
      const proposal = STRATEGY === 'pump-short'
        ? localProtectionReview(active, market)
        : enhancedProtectionReview(active, market);
      // 最小持仓保护（实验用）：入场后 MIN_HOLD 根内不允许「智能退出」直接平仓，
      // 移动止损 / 止损止盈 / 超时照常生效。用于验证「过早离场」的修复空间。
      const inMinHold = Number(active.heldBars || 0) < MIN_HOLD;
      if (proposal.action === 'CLOSE' && !inMinHold) {
        const settled = sim._settle(
          active,
          { reason: 'smart_exit', price: bars[i].close, ambiguous: false },
          Number(active.entry),
          Date.parse(active.entryAt),
          now,
          Number(active.heldBars) || 0,
          active.direction === 'OPEN_LONG' ? 1 : -1,
          0,
          {
            gross: Number(active.realizedGross) || 0, fee: Number(active.realizedFee) || 0,
            funding: Number(active.realizedFunding) || 0, net: Number(active.realizedNet) || 0,
            qty: Number(active.realizedQty) || 0, fills: Number(active.tpStage) || 0
          }
        );
        const t = finalizeTrade(active, settled, 'smart_exit');
        if (t) trades.push(t);
        cooldownUntil = i + SYMBOL_COOLDOWN;
        active = null;
      } else {
        applyPaperProtectionReview(active, proposal, now, STRATEGY === 'pump-short' ? 'local' : 'enhanced');
      }
    }

    // ── D. 新信号下单（入场最早 bar[i+2]，与 firstEntryAt 口径一致）
    if (!active && sig && sig.action !== 'WAIT' && sig.plan && i >= cooldownUntil && i + 2 < N) {
      const dir = sig.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT';
      const plan = { ...sig.plan };
      const leverage = recommendedLeverage(plan, dir);
      const close = bars[i].close;
      signalCount++;
      // ⚠️ 不能带 eligible 字段：tradingSimulator._normalizeInput 用「eligible !== undefined && plan」
      // 区分「信号」与「订单」，带了该字段会走信号分支 → direction 丢失、startTime=NaN（实测挂单永不成交）。
      active = {
        plan, initialPlan: { ...plan }, direction: dir, symbol, interval: INTERVAL,
        nextTime: bars[i + 2].openTime,
        notional: MARGIN * leverage, leverage, margin: MARGIN,
        costs: { ...PAPER_COSTS }, protectionRevisions: [],
        status: 'pending', error: '', ineligibleRounds: 0, ineligibleSince: null,
        createdAt: new Date(now).toISOString(), nextTimeIdx: i + 2,
        _score: plan.trendStrengthScore ?? null,
        _atrPct: plan.indicators?.atr ? plan.indicators.atr / close : null,
        _hour: new Date(bars[i].openTime + 8 * 3600000).getUTCHours()
      };
      placed.push({ symbol, direction: dir, at: bars[i].openTime, score: active._score, atrPct: active._atrPct });
    }
  }
  if (active) trades.push({ symbol, status: active.status, unfinished: true });
  return { symbol, bars: bars.length, signalCount, placed, trades, cancels };
}

function finalizeTrade(order, ev, kind) {
  if (!Number.isFinite(ev.net)) return null;
  const created = Date.parse(order.createdAt);
  const entered = Date.parse(ev.entryAt);
  return {
    waitBars: Number.isFinite(created) && Number.isFinite(entered) ? (entered - created) / 60000 : null,
    symbol: order.symbol,
    direction: order.direction,
    entry: ev.entry,
    exit: ev.exit,
    entryAt: ev.entryAt,
    exitAt: ev.exitAt,
    heldBars: ev.heldBars,
    reason: ev.reason,
    net: ev.net,
    gross: ev.gross,
    fee: ev.fees ?? ev.fee,
    funding: ev.funding ?? ev.fundingReserve,
    roi: ev.roi,
    leverage: order.leverage,
    margin: order.margin,
    notional: order.notional,
    partialFills: ev.partialFills ?? 0,
    earlyCut: !!order._earlyCut,
    score: order._score,
    atrPct: order._atrPct,
    hour: order._hour,
    exitKind: kind
  };
}

// ───────────────────────── 执行 ─────────────────────────
const t0 = Date.now();
const all = [];
for (const f of files) {
  const symbol = f.replace(/\.ndjson$/, '');
  const bars = loadBars(f);
  const t = Date.now();
  const r = runSymbol(symbol, bars);
  all.push(r);
  const closed = r.trades.filter(x => !x.unfinished);
  const net = closed.reduce((a, x) => a + x.net, 0);
  console.log(`${symbol.padEnd(12)} bars=${String(bars.length).padStart(5)} 挂单=${String(r.placed.length).padStart(3)} 撤单=${String(r.cancels.length).padStart(3)} 成交=${String(closed.length).padStart(3)} 净=${net.toFixed(1).padStart(8)}U  ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const trades = all.flatMap(r => r.trades.filter(x => !x.unfinished));
const placed = all.flatMap(r => r.placed);
const cancels = all.flatMap(r => r.cancels);

fs.writeFileSync(path.join(DIR, OUT_NAME), JSON.stringify({
  generatedAt: new Date().toISOString(),
  config: {
    interval: INTERVAL, window: WINDOW, margin: MARGIN,
    longOnly: LONG_ONLY.enabled,
    minTrendScore: process.env.NOFX_MIN_TREND_SCORE ?? null,
    days: meta.days, seed: meta.seed, minHoldBars: MIN_HOLD,
    earlyCutR: EARLY_CUT_R, earlyCutBars: EARLY_CUT_BARS,
    paramOverrides: PARAM_OVERRIDES,
    symbolCooldown: SYMBOL_COOLDOWN, stopCooldown: STOP_COOLDOWN
  },
  symbols: all.map(r => ({ symbol: r.symbol, bars: r.bars, placed: r.placed.length, cancelled: r.cancels.length, filled: r.trades.filter(x => !x.unfinished).length })),
  trades, placed, cancels
}, null, 2));

console.log(`\n总用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
console.log(`挂单 ${placed.length} 笔 / 撤单 ${cancels.length} 笔 / 成交并平仓 ${trades.length} 笔`);
const net = trades.reduce((a, x) => a + x.net, 0);
const wins = trades.filter(x => x.net > 0);
console.log(`净盈亏 ${net.toFixed(2)} USDT   胜率 ${(100 * wins.length / trades.length).toFixed(1)}%   均单 ${(net / trades.length).toFixed(3)}U`);
