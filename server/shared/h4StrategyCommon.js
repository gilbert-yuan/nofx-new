/**
 * 4H 原生策略共用件（h4-trend-breakout-v1 / h4-mean-reversion-v1）
 *
 * ## 为什么单独抽一份
 * 这两个策略以 **4H 已收盘 K 线为唯一决策周期**，与项目既有的「多周期结构」类引擎
 * （4H 定方向 + 1H 定位 + 15m 确认，见 structureShortAnalysis / structureLongAnalysis）
 * 不是一回事，因此：
 *   · 指标只从 4H 窗口算，不读 ctx.auxMarkets（回测里也不会准备 1H/15m）；
 *   · 指标周期必须 ≤ 78 —— 线上实时窗口固定 80 根（globalAutomation.getFreshMarket），
 *     这里再用 Math.min(配置值, rows.length - 2) 兜底，并把实际生效周期写进信号；
 *   · 出场规则沿用 enhancedAnalysis.buildExitRules（同一份 R 口径阶梯 / 分批止盈），
 *     但「智能退出」与「根级均线失守」默认关闭 —— 突破与均值回归都自带形态失效止损，
 *     均线失守这类主动离场会在刚入场时就砍单（与「等突破确认」的前提冲突）；
 *   · 持仓复核复用 localProtectionReview（按订单快照 order.plan.exitRules.trailing 推进）。
 *
 * ## ⚠️ 入场一律走市价（计划里**不写 entryLimit**）
 * 限价挂单在粗粒度 K 线上会触发「成交当根污染」：模拟器把整根 K 线当成一个时间点，
 * 成交**之前**这根 K 线的高点会被误判成「进场后的止盈机会」。本项目已实测过同一批 4H
 * 信号、同一挂单深度下 4h 粒度 +313U / 1m 粒度 −74U 的系统性虚高。
 * 市价入场时成交价 = 下一根 K 线开盘价，与该根 K 线的 high/low 有明确先后关系，
 * 因此不存在这一类偏差（同根内 high/low 谁先到仍不可知，但那是所有粒度共有的经典歧义，
 * 模拟器按「保护优先」保守处理）。
 * `scripts/_bt_h4_run.mjs` 的 `BT_EXEC_TF=4h` 给出同一批信号在 4H 粒度下的结果，
 * 与 1m 口径的差值就是污染上界 —— 任何「粗粒度更优」都必须先过这一关。
 */

import { ENHANCED_PARAM_SCHEMA, ENHANCED_DEFAULTS, buildExitRules } from '../enhancedAnalysis.js';
import { localProtectionReview } from './protectionReview.js';
import { STRATEGY_RISK_DEFAULTS, STRATEGY_RISK_PARAM_SCHEMA } from '../strategies/commonParams.js';
import { RISK_RULE } from './strategyGuards.js';

/** 4H 决策周期下 1 根计划 K 线 = 240 根 1m K 线（结算口径换算用） */
export const H4_PLAN_BAR_MINUTES = 240;

/** 线上实时窗口固定 80 根：指标周期硬上限（留 2 根给「已收盘」判定） */
export const H4_MAX_PERIOD = 78;

// ───────────────────────── 出场规则（复用 enhanced 的单一事实源） ─────────────────────────

const EXIT_SPECS = ENHANCED_PARAM_SCHEMA.filter(spec => spec.group === 'exit');

/**
 * 本类策略强制改写的出场默认值。
 * 理由：突破/均值回归自带形态失效止损（通道回落 / 极端延伸修复），
 * 均线失守与 RSI·MACD 力竭止盈会在刚入场阶段就把单砍掉。
 * 需要时仍可在「策略管理」页逐策略勾上，不影响其它策略。
 */
const FORCED_EXIT_DEFAULTS = Object.freeze({
  smartExitEnabled: false,
  smartExitBarLevelEnabled: false
});

export const H4_EXIT_DEFAULTS = Object.freeze(Object.fromEntries(EXIT_SPECS.map(spec => [
  spec.key,
  Object.prototype.hasOwnProperty.call(FORCED_EXIT_DEFAULTS, spec.key)
    ? FORCED_EXIT_DEFAULTS[spec.key]
    : spec.default
])));

export const H4_EXIT_PARAM_SCHEMA = Object.freeze(EXIT_SPECS.map(spec =>
  Object.prototype.hasOwnProperty.call(FORCED_EXIT_DEFAULTS, spec.key)
    ? {
      ...spec,
      default: FORCED_EXIT_DEFAULTS[spec.key],
      description: String(spec.description || '') + '（本 4H 策略默认关闭：自带形态失效止损）'
    }
    : spec));

// ───────────────────────────── 风险参数（与其它策略同一套） ─────────────────────────────

export const H4_RISK_DEFAULTS = Object.freeze({
  ...STRATEGY_RISK_DEFAULTS,
  // 4H 策略持仓时间长、单笔波动大，默认杠杆取比全局硬上限更保守的一档
  maxLeverage: 5,
  riskBudgetPct: 0.1
});

export const H4_RISK_PARAM_SCHEMA = STRATEGY_RISK_PARAM_SCHEMA;

/**
 * 构造订单级出场规则快照（写进 plan.exitRules）。
 * 与 enhanced 共用 buildExitRules，因此模拟器/复核读到的字段完全一致。
 */
export function h4ExitRules(params) {
  return buildExitRules({ ...ENHANCED_DEFAULTS, ...H4_EXIT_DEFAULTS, ...(params || {}) });
}

/**
 * 持仓复核：R 口径移动止损阶梯 / 顺势扩盈，规则从 order.plan.exitRules.trailing 读。
 * 直接复用跨引擎单一事实源，避免 4H 策略出现第二套保护口径。
 */
export function h4ProtectionReview(order, market) {
  return localProtectionReview(order, market);
}

// ────────────────────────────────── 参数工具 ──────────────────────────────────

export const numSpec = (defaults, key, label, group, min, max, step, description) =>
  ({ key, label, group, type: 'number', default: defaults[key], min, max, step, description });

export const boolSpec = (defaults, key, label, group, description) =>
  ({ key, label, group, type: 'boolean', default: defaults[key], description });

/**
 * 按参数模式解析：默认值为底 + 逐字段覆盖，越界回退默认并告警。
 * 与 registry.resolveParams 同规则，但额外打印引擎名便于定位。
 */
export function resolveH4Params(defaults, schema, overrides, engineName) {
  const params = { ...defaults };
  if (!overrides || typeof overrides !== 'object') return params;
  for (const spec of schema) {
    const raw = overrides[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (spec.type === 'boolean') {
      if (typeof raw === 'boolean') { params[spec.key] = raw; continue; }
      const text = String(raw).trim();
      if (/^(true|1|yes)$/i.test(text)) { params[spec.key] = true; continue; }
      if (/^(false|0|no)$/i.test(text)) { params[spec.key] = false; continue; }
      console.warn(`[${engineName}] 参数 ${spec.key}=${raw} 非法（需布尔），回退默认 ${spec.default}`);
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[spec.key] = value;
    else console.warn(`[${engineName}] 参数 ${spec.key}=${raw} 非法（需在 ${spec.min}~${spec.max}），回退默认 ${spec.default}`);
  }
  return params;
}

/**
 * 指标周期落到「窗口内实际可用」的取值。
 *
 * ⚠️ 静默降级是历史事故来源（插针引擎 trendMaPeriod=200 装到 80 根窗口上，
 * 线上永远 WAIT 且日志只说「K 线不够」）。这里返回实际生效值并与请求值一起
 * 写进信号，调用方**必须**把它透出到 reason / trend 字段。
 */
export function effectivePeriod(requested, rows, minBars = 3) {
  const want = Math.max(2, Math.floor(Number(requested) || 2));
  const usable = Math.max(minBars, Number(rows?.length || 0) - 2);
  const actual = Math.min(want, usable);
  return { requested: want, actual, degraded: actual !== want };
}

// ───────────────────────────────── 计划几何 ─────────────────────────────────

/**
 * 成本后的净盈亏比。
 * 与 research.normalizePlan 的判定同源：成本 = 2×(手续费+滑点) + 资金费。
 * @param {object} p
 * @param {number} p.entry        参考入场价（4H 收盘价，市价成交近似）
 * @param {number} p.stopLoss
 * @param {number} p.takeProfit
 * @param {number} p.maxHoldBars  计划根数（4H）
 */
export function costAwareRr({ entry, stopLoss, takeProfit, maxHoldBars, costs }) {
  const feeBps = Number(costs?.feeBps ?? 6);
  const slipBps = Number(costs?.slippageBps ?? 5);
  const fundingBpsPer8h = Number(costs?.fundingBpsPer8h ?? 3);
  const hours = Math.max(0, Number(maxHoldBars) || 0) * H4_PLAN_BAR_MINUTES / 60;
  const costPct = (2 * (feeBps + slipBps) + fundingBpsPer8h * hours / 8) / 10000;
  const costAbs = entry * costPct;
  const stopDistance = Math.abs(entry - stopLoss);
  const netReward = Math.abs(takeProfit - entry) - costAbs;
  const netRisk = stopDistance + costAbs;
  return {
    stopDistance,
    costAbs,
    grossRr: stopDistance > 0 ? Math.abs(takeProfit - entry) / stopDistance : 0,
    netRr: netRisk > 0 ? netReward / netRisk : 0
  };
}

/**
 * 由止损距离反推推荐杠杆：杠杆 ≈ 风险预算 ÷ 止损距离，受 maxLeverage 与全局硬上限双重截断。
 * 与 localAnalysis.recommendedLeverage 同公式，但不依赖 planRefEntry（市价单没有 entryLimit）。
 */
export function h4Leverage(stopDistancePct, params) {
  const cap = Math.max(1, Math.min(
    RISK_RULE.maxLeverage,
    Math.floor(Number(params?.maxLeverage) || RISK_RULE.maxLeverage)
  ));
  const budget = Number.isFinite(Number(params?.riskBudgetPct)) ? Number(params.riskBudgetPct) : RISK_RULE.riskBudgetPct;
  if (!(stopDistancePct > 0)) return 1;
  return Math.max(1, Math.min(cap, Math.floor(budget / stopDistancePct)));
}

/**
 * 统一的等待信号（与其它引擎同构，保证自动化/前端字段不漂移）。
 */
export function h4WaitSignal({ symbol, reason, riskNote, windowInfo, extra = {} }) {
  return {
    symbol, action: 'WAIT', decision: 'HOLD', state: 'HOLD', confidence: 0,
    reason, risk: riskNote, plan: null, trend: windowInfo, ...extra
  };
}

/**
 * 解析 4H 行情来源。
 *
 * ⚠️ 这是本类策略最容易踩空的一处：线上自动化的主行情永远是 1m
 * （`globalAutomation` 第 373 行 `getFreshMarket(symbol, interval)`，interval = MAIN_INTERVAL = '1m'），
 * 而 `strategy.analyze(market, ctx)` 收到的也是**主行情**（不是 planInterval 那根）。
 * 4H 数据只存在于 `ctx.auxMarkets['4h']`，因此引擎必须自己取。
 * 回测里则相反：直接喂 `interval='4h'` 的 market。
 * 两条路径都支持，优先级 auxMarkets['4h'] > market（当 market 本身就是 4h）。
 *
 * @returns {{k:Array, dataAsOf:string|null, source:'aux'|'main'|'none'}}
 */
export function resolveH4Market(market, ctx) {
  const aux = ctx?.auxMarkets?.['4h'];
  if (aux && Array.isArray(aux.klines) && aux.klines.length) {
    return { k: aux.klines, dataAsOf: aux.dataAsOf || null, source: 'aux' };
  }
  if (market && market.interval === '4h' && Array.isArray(market.klines) && market.klines.length) {
    return { k: market.klines, dataAsOf: market.dataAsOf || null, source: 'main' };
  }
  return { k: [], dataAsOf: null, source: 'none' };
}

/**
 * 组装计划对象。
 *
 * entry 用**市价**：只给一个足够宽的 entryMin/entryMax 区间，
 * 不写 entryLimit —— `TradingSimulator._tryEntry` 见到有限 entryLimit 会走限价路径并
 * 打开「成交当根保护」，而市价路径在下一根开盘成交，与决策 K 线无时间重叠。
 *
 * @param {object} p
 * @param {1|-1}   p.direction     1 多 / -1 空
 * @param {number} p.refPrice      决策价（4H 收盘）
 * @param {number} p.atr
 * @param {number} p.stopAtr       止损距离（ATR 倍数）
 * @param {number} p.minStopPct    止损绝对下限（占价格）
 * @param {number} p.takeProfit    止盈价
 * @param {number} p.maxHoldBars   计划根数（4H）
 * @param {number} p.entryBandAtr  市价成交区间半宽（ATR 倍数，仅作 sanity 边界）
 * @param {object} p.exitRules
 */
export function buildH4Plan({
  direction, refPrice, atr, stopAtr, minStopPct, takeProfit, maxHoldBars,
  entryBandAtr, exitRules, params, targetSource = null, extra = {}
}) {
  const long = direction === 1;
  const rawStop = Math.max(Number(stopAtr) * Number(atr), Number(minStopPct) * refPrice);
  const stopLoss = long ? refPrice - rawStop : refPrice + rawStop;
  const stopDistancePct = rawStop / refPrice;
  const leverage = h4Leverage(stopDistancePct, params);
  const band = Math.max(0.01, Number(entryBandAtr) || 0.5) * Number(atr);
  // 策略级仓位/资金池参数（09-17 平衡档上线）：随 plan 下发，globalAutomation 读取。
  // 非法/缺省时置 null，下单链路回落全局默认 —— 旧策略 plan 里没有这两个字段，行为不变。
  const marginPct = Number(params?.autoMarginPct);
  const maxPos = Math.floor(Number(params?.maxPositions));
  return {
    // 市价入口：区间只为通过「下一根开盘价在区间内」的 sanity 检查，不构成挂单。
    // 宽度取 ATR 倍数（必须窄于止损距离，否则 planIsSane 会拒绝）。
    entryMin: refPrice - band,
    entryMax: refPrice + band,
    stopLoss,
    takeProfit,
    riskUnit: rawStop,
    stopDistancePct,
    maxHoldBars: Math.round(Number(maxHoldBars)),
    recommendedLeverage: leverage,
    marginRiskPct: leverage * stopDistancePct,
    autoMarginPct: Number.isFinite(marginPct) && marginPct > 0 && marginPct <= 1 ? marginPct : null,
    maxPositions: Number.isFinite(maxPos) && maxPos >= 1 ? maxPos : null,
    targetSource,
    entryStyle: 'market',
    exitRules,
    ...extra
  };
}

/** 计划几何的合法性自检（回测/实盘都会用到，避免把 NaN 送到下单链路） */
export function planIsSane(plan, direction) {
  if (!plan) return false;
  const long = direction === 1;
  const nums = [plan.entryMin, plan.entryMax, plan.stopLoss, plan.takeProfit, plan.riskUnit, plan.maxHoldBars];
  if (!nums.every(v => Number.isFinite(v))) return false;
  if (plan.riskUnit <= 0 || plan.maxHoldBars < 1) return false;
  if (!(plan.entryMin > 0 && plan.entryMax > plan.entryMin)) return false;
  return long
    ? plan.stopLoss < plan.entryMin && plan.takeProfit > plan.entryMax
    : plan.stopLoss > plan.entryMax && plan.takeProfit < plan.entryMin;
}

/** 数组工具：Clamp */
export const clamp01 = v => Math.max(0, Math.min(1, v));
