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

const DIR = path.resolve('data/backtest');
const KDIR = path.join(DIR, 'klines');
const WINDOW = 80;
const MARGIN = 100;
const SYMBOL_COOLDOWN = 30;   // NOFX_SYMBOL_COOLDOWN_MIN 默认 30
const STOP_COOLDOWN = 60;     // NOFX_STOP_COOLDOWN_MIN 默认 60
const MIN_HOLD = Number(process.env.NOFX_MIN_HOLD_BARS ?? 0); // 实验：最小持仓根数（智能退出保护）

const OUT_NAME = process.env.BT_OUT || 'result.json';
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
// 只回测数据完整的币种（补齐替换后，原数据不足的币仍留在磁盘上）
const goodBars = new Map((meta.symbols || []).filter(s => Number(s.bars) >= meta.barsTarget * 0.95).map(s => [s.symbol, Number(s.bars)]));
const allFiles = process.argv[2] ? [process.argv[2]] : fs.readdirSync(KDIR).filter(f => f.endsWith('.ndjson'));
const skipped = [];
const files = allFiles.filter(f => {
  const s = f.replace(/\.ndjson$/, '');
  if (goodBars.has(s)) return true;
  skipped.push(s);
  return false;
});

console.log('== 回测配置 ==');
console.log(`  禁空 LONG_ONLY=${LONG_ONLY.enabled}   评分门槛 NOFX_MIN_TREND_SCORE=${process.env.NOFX_MIN_TREND_SCORE ?? '(默认66)'}`);
console.log(`  周期 1m  窗口 ${WINDOW} 根  保证金 ${MARGIN}U/单  冷却 平仓${SYMBOL_COOLDOWN}分/止损${STOP_COOLDOWN}分`);
console.log(`  成本 fee=${PAPER_COSTS.feeBps}bps slip=${PAPER_COSTS.slippageBps}bps funding=${PAPER_COSTS.fundingBpsPer8h}bps/8h`);
console.log(`  币种数 ${files.length}\n`);

function loadBars(file) {
  const txt = fs.readFileSync(path.join(KDIR, file), 'utf8');
  const rows = txt.split('\n').filter(Boolean).map(line => {
    const [t, o, h, l, c, v] = line.split(',').map(Number);
    return { openTime: t, open: o, high: h, low: l, close: c, volume: v, closeTime: t + 59999 };
  }).sort((a, b) => a.openTime - b.openTime);
  // 补齐缺口：1m 序列必须连续，否则 simulator 会 data_gap
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i && rows[i].openTime !== rows[i - 1].openTime + 60000) {
      let t = rows[i - 1].openTime + 60000;
      const prev = rows[i - 1].close;
      while (t < rows[i].openTime) {
        out.push({ openTime: t, open: prev, high: prev, low: prev, close: prev, volume: 0, closeTime: t + 59999 });
        t += 60000;
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
    const now = bars[i].openTime + 60000;

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

    const needSignal = !active || active.status === 'pending';
    let sig = null;
    if (needSignal) {
      sig = enhancedAnalysis({ symbol, interval: '1m', klines: bars.slice(i - WINDOW + 1, i + 1) });
    }

    // ── B. 挂单复核（方向反转立即撤 / 软门槛连续不合格 30 分钟宽限）
    if (active && active.status === 'pending' && sig) {
      const rec = sig.action === 'WAIT' ? 'WAIT' : sig.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT';
      applyPendingReview(active, {
        positionRecommendation: rec,
        eligible: rec !== 'WAIT' && !!sig.plan,
        reason: sig.reason,
        dataAsOf: new Date(bars[i].openTime + 60000).toISOString(),
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
      const market = { symbol, interval: '1m', klines: bars.slice(Math.max(0, i - WINDOW + 1), i + 1) };
      const proposal = enhancedProtectionReview(active, market);
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
        applyPaperProtectionReview(active, proposal, now, 'enhanced');
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
        plan, initialPlan: { ...plan }, direction: dir, symbol, interval: '1m',
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
    interval: '1m', window: WINDOW, margin: MARGIN,
    longOnly: LONG_ONLY.enabled,
    minTrendScore: process.env.NOFX_MIN_TREND_SCORE ?? null,
    days: meta.days, seed: meta.seed, minHoldBars: MIN_HOLD,
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
