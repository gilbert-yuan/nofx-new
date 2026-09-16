/**
 * 随机 50 币 × 近 30 天 1m K 线 —— 当前线上策略全量回测
 *
 * 保真口径（全部复用生产代码，零重写策略逻辑）：
 *   信号生成   server/strategies 注册定义 → strategy.analyze()      （默认 enhanced-trend-v1）
 *   挂单复核   server/shared/pendingReview.js → applyPendingReview() （方向反转立即撤 / 软门槛 30 分钟宽限）
 *   持仓复核   server/strategies 注册定义 → strategy.review()       （移动止损阶梯 + 智能退出 CLOSE）
 *   保护写回   server/shared/protectionReview.js → applyPaperProtectionReview()
 *   逐根结算   server/tradingSimulator.js  → _simulate()/_settle()   （分批止盈 / 止损止盈 / 根级均线失守 / 超时）
 *
 * 与线上一致的工程约束：
 *   · 主周期 1m，分析窗口 80 根（globalAutomation limit=80）
 *   · 信号在 bar[i] 收盘产生，入场最早从 bar[i+2] 开始（firstEntryAt 口径）
 *   · 同币种同时只允许 1 笔 pending/open
 *   · 平仓后冷却 30 分钟；止损平仓后冷却 60 分钟（SYMBOL_COOLDOWN_MIN / STOP_COOLDOWN_MIN）
 *   · 每单保证金 100 USDT，杠杆由正式策略计划决定（同时受全局风控硬上限约束）
 *
 * 运行默认读取 data/strategies.json；BT_PARAM_OVERRIDES 仅用于显式回测实验，不回写正式配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfiguredStrategy } from '../server/strategies/loader.js';
import { resolveParams } from '../server/strategies/registry.js';
import { applyPaperProtectionReview } from '../server/shared/protectionReview.js';
import { applyPendingReview } from '../server/shared/pendingReview.js';
import { TradingSimulator } from '../server/tradingSimulator.js';
import { buildExitRules } from '../server/enhancedAnalysis.js';
import { PAPER_COSTS } from '../server/research.js';
import { recommendedLeverage } from '../server/localAnalysis.js';
import { LONG_ONLY, RISK_RULE } from '../server/shared/strategyGuards.js';
import { pumpFadeShortAnalysis } from '../server/pumpFadeShortAnalysis.js';
import { localProtectionReview } from '../server/shared/protectionReview.js';

// 正式策略入口：enhanced / enhanced-trend-v1 都解析到注册表策略。
// pump-short 是历史未注册引擎，保留兼容分支供旧实验复现；新策略应先注册再接入此入口。
// pump-short 用法：BT_STRATEGY=pump-short BT_TF_MS=900000 BT_DIR=data/backtest/bf90-15mrs
const STRATEGY_REQUEST = process.env.BT_STRATEGY || 'enhanced';
const STRATEGY = STRATEGY_REQUEST === 'enhanced' ? 'enhanced-trend-v1' : STRATEGY_REQUEST;
const IS_FORMAL_STRATEGY = STRATEGY === 'enhanced-trend-v1';
if (!IS_FORMAL_STRATEGY && STRATEGY !== 'pump-short') {
  console.error('BT_STRATEGY 必须是 enhanced | enhanced-trend-v1 | pump-short，得到 ' + STRATEGY_REQUEST);
  process.exit(1);
}
const STRATEGY_CONFIG_PATH = process.env.BT_STRATEGY_CONFIG || 'data/strategies.json';

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
let STRATEGY_DEF = null;
let STRATEGY_CONFIG = {};
let STRATEGY_PARAMS = {};
if (IS_FORMAL_STRATEGY) {
  const loaded = await loadConfiguredStrategy(STRATEGY, {
    strategyPath: STRATEGY_CONFIG_PATH,
    configPath: process.env.BT_CONFIG || 'data/config.json'
  });
  STRATEGY_DEF = loaded.strategy;
  STRATEGY_CONFIG = loaded.config;
  // BT_PARAM_OVERRIDES 是回测专用实验覆盖；不回写正式策略配置，默认路径仍完全使用配置文件。
  const overrideObject = PARAM_OVERRIDES && typeof PARAM_OVERRIDES === 'object' && !Array.isArray(PARAM_OVERRIDES)
    ? PARAM_OVERRIDES
    : {};
  const resolvedOverrides = resolveParams(STRATEGY_DEF.paramSchema, overrideObject);
  const rejectedKeys = new Set(resolvedOverrides.rejected.map(item => item.key));
  STRATEGY_PARAMS = { ...STRATEGY_DEF.params };
  for (const spec of STRATEGY_DEF.paramSchema) {
    if (!Object.prototype.hasOwnProperty.call(overrideObject, spec.key)) continue;
    const raw = overrideObject[spec.key];
    if (raw === undefined || raw === null || raw === '' || rejectedKeys.has(spec.key)) continue;
    STRATEGY_PARAMS[spec.key] = resolvedOverrides.params[spec.key];
  }
  if (resolvedOverrides.rejected.length) {
    console.warn('BT_PARAM_OVERRIDES 含非法值，已保留正式配置：', JSON.stringify(resolvedOverrides.rejected));
  }
} else {
  STRATEGY_PARAMS = { ...(PARAM_OVERRIDES || {}) };
}
// 实验开关（仅回测 harness，生产未用）：入场 N 根内浮亏 ≤ -cutoffR 时市价减半一次。
const EARLY_CUT_R = Number(process.env.NOFX_BT_EARLY_CUT_R ?? 0);
const EARLY_CUT_BARS = Number(process.env.NOFX_BT_EARLY_CUT_BARS ?? 5);
// 方案A（仅回测 harness）：enhanced-trend-v1 引擎原生不写 exitRules 快照（无 decoratePlan），
// 其订单在模拟器里根级均线失守恒关、复核层回退全局 SMART_EXIT —— 因此 smartExit*
// 参数覆盖（含新独立开关 smartExitBarLevelEnabled）到不了逐根结算。
// 当实验显式覆盖任一 smartExit* 参数时，把该策略解析后的出场参数快照进 plan.exitRules，
// 让覆盖值真正生效（p19 形态：根级均线失守开 + 复核层 CLOSE 关）。
// 不带 smartExit* 覆盖的运行不走此分支，与历史基线逐位一致。线上不经过本文件。
const NEED_EXIT_SNAPSHOT = !!(PARAM_OVERRIDES
  && Object.keys(PARAM_OVERRIDES).some(k => String(k).startsWith('smartExit')));
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
console.log('  策略 ' + STRATEGY + '（请求=' + STRATEGY_REQUEST + '）'
  + (IS_FORMAL_STRATEGY ? '  正式配置 ' + STRATEGY_CONFIG_PATH : '  历史兼容引擎'));
if (IS_FORMAL_STRATEGY) console.log('  参数 ' + JSON.stringify(STRATEGY_PARAMS));
console.log('  禁空 LONG_ONLY=' + (IS_FORMAL_STRATEGY ? STRATEGY_PARAMS.longOnly === true : LONG_ONLY.enabled) + '   评分门槛 NOFX_MIN_TREND_SCORE=' + (process.env.NOFX_MIN_TREND_SCORE ?? '(默认66)'));
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

async function runSymbol(symbol, bars) {
  const sim = new TradingSimulator({ mode: 'account', maxPositions: Infinity, allowDuplicateSymbol: false });
  const trades = [], cancels = [], placed = [];
  let active = null, cooldownUntil = -1, signalCount = 0;
  const N = bars.length;

  for (let i = WINDOW; i < N; i++) {
    const now = bars[i].openTime + TF;

    // ── A. 推进活跃单一根（simulator 内部：入场/分批止盈/止损止盈/根级均线失守/超时）
    // 窗口化喂入：根级均线失守需要 MA20/ATR 历史（≥20 根）才能计算 —— 线上复核
    // 本来就带 80 根窗口，这里补齐同一口径。模拟器从 active.nextTime 起只推进 1 根，
    // 额外历史仅用于均线序列构建；barLevelMaExit=false（现行配置）时不建序列，零变化。
    if (active && active.nextTime === bars[i].openTime) {
      const ev = sim.evaluate(active, bars.slice(Math.max(0, i - 250), i + 1), now);
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
    // 无持仓时，信号只在「已过冷却期且还来得及挂单」的 bar 上被使用（B 需 active、D 有
    // i>=cooldownUntil 与 i+2<N 两道闸）——冷却期内与最后两根 bar 的分析结果必然被丢弃，
    // 直接跳过（精确等价：被跳过的 sig 在该状态下无任何消费方）。币多时冷却 bar 占比可观。
    if (needSignal && !(!active && (i < cooldownUntil || i + 2 >= N))) {
      const market = { symbol, interval: INTERVAL, klines: bars.slice(i - WINDOW + 1, i + 1) };
      if (IS_FORMAL_STRATEGY) {
        sig = await STRATEGY_DEF.analyze(market, {
          params: STRATEGY_PARAMS,
          config: STRATEGY_CONFIG,
          interval: INTERVAL,
          planInterval: STRATEGY_DEF.planInterval || INTERVAL
        });
      } else {
        sig = await pumpFadeShortAnalysis(market, PARAM_OVERRIDES ? { params: PARAM_OVERRIDES } : {});
      }
      if (IS_FORMAL_STRATEGY && sig?.plan && typeof STRATEGY_DEF.decoratePlan === 'function') {
        sig = {
          ...sig,
          plan: await STRATEGY_DEF.decoratePlan(sig.plan, {
            params: STRATEGY_PARAMS,
            config: STRATEGY_CONFIG,
            interval: INTERVAL,
            planInterval: STRATEGY_DEF.planInterval || INTERVAL
          })
        };
      } else if (IS_FORMAL_STRATEGY && sig?.plan && NEED_EXIT_SNAPSHOT) {
        // 方案A 实验通道：仅当 smartExit* 覆盖存在时，给 enhanced 订单补该策略的
        // 出场规则快照（模拟器逐根结算与复核层都从这里读，覆盖值才生效）。
        sig = {
          ...sig,
          plan: { ...sig.plan, exitRules: buildExitRules(STRATEGY_PARAMS) }
        };
      }
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
      const proposal = IS_FORMAL_STRATEGY
        ? await STRATEGY_DEF.review(active, market, {
            params: STRATEGY_PARAMS,
            config: STRATEGY_CONFIG,
            interval: INTERVAL,
            planInterval: STRATEGY_DEF.planInterval || INTERVAL
          })
        : await localProtectionReview(active, market);
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
        applyPaperProtectionReview(active, proposal, now, IS_FORMAL_STRATEGY ? STRATEGY_DEF.engine : 'local');
      }
    }

    // ── D. 新信号下单（入场最早 bar[i+2]，与 firstEntryAt 口径一致）
    if (!active && sig && sig.action !== 'WAIT' && sig.plan && i >= cooldownUntil && i + 2 < N) {
      const dir = sig.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT';
      const plan = { ...sig.plan };
      const strategyLeverage = Number(plan.recommendedLeverage ?? sig.recommendedLeverage);
      const requestedLeverage = Number.isFinite(strategyLeverage) && strategyLeverage > 0
        ? Math.floor(strategyLeverage)
        : recommendedLeverage(plan, dir, STRATEGY_PARAMS);
      const leverage = Math.max(1, Math.min(RISK_RULE.maxLeverage, requestedLeverage));
      const close = bars[i].close;
      signalCount++;
      // ⚠️ 不能带 eligible 字段：tradingSimulator._normalizeInput 用「eligible !== undefined && plan」
      // 区分「信号」与「订单」，带了该字段会走信号分支 → direction 丢失、startTime=NaN（实测挂单永不成交）。
      active = {
        plan, initialPlan: { ...plan }, direction: dir, symbol, interval: INTERVAL,
        nextTime: bars[i + 2].openTime,
        notional: MARGIN * leverage, leverage, margin: MARGIN,
        costs: { ...PAPER_COSTS }, protectionRevisions: [],
        analysisContext: { strategyId: STRATEGY, strategyParams: STRATEGY_PARAMS },
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
  const r = await runSymbol(symbol, bars);
  all.push(r);
  const closed = r.trades.filter(x => !x.unfinished);
  const net = closed.reduce((a, x) => a + x.net, 0);
  console.log(`${symbol.padEnd(12)} bars=${String(bars.length).padStart(5)} 挂单=${String(r.placed.length).padStart(3)} 撤单=${String(r.cancels.length).padStart(3)} 成交=${String(closed.length).padStart(3)} 净=${net.toFixed(1).padStart(8)}U  ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const trades = all.flatMap(r => r.trades.filter(x => !x.unfinished));
const placed = all.flatMap(r => r.placed);
const cancels = all.flatMap(r => r.cancels);

// BT_OUT：相对路径拼在语料目录 DIR 下（老行为不变）；绝对路径原样使用。
// 输出目录不存在时自动创建（此前目录缺失会 ENOENT，回测白算不落盘）。
const OUT_PATH = path.isAbsolute(OUT_NAME) ? OUT_NAME : path.join(DIR, OUT_NAME);
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(),
  config: {
    strategy: STRATEGY,
    strategyRequest: STRATEGY_REQUEST,
    strategyConfigPath: IS_FORMAL_STRATEGY ? STRATEGY_CONFIG_PATH : null,
    strategyParams: STRATEGY_PARAMS,
    interval: INTERVAL, window: WINDOW, margin: MARGIN,
    longOnly: IS_FORMAL_STRATEGY ? STRATEGY_PARAMS.longOnly === true : LONG_ONLY.enabled,
    minTrendScore: process.env.NOFX_MIN_TREND_SCORE ?? null,
    days: meta.days, seed: meta.seed, minHoldBars: MIN_HOLD,
    earlyCutR: EARLY_CUT_R, earlyCutBars: EARLY_CUT_BARS,
    paramOverrides: PARAM_OVERRIDES,
    systemMaxLeverage: RISK_RULE.maxLeverage,
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
