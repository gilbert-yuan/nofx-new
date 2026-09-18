/**
 * 4H 趋势突破引擎（h4-trend-breakout-v1）
 * —— 以 4H 已收盘 K 线为**唯一决策周期**的趋势跟随策略（双向）
 *
 * ## 假设
 * 「4H 收盘价有效突破近 N 根通道边界，且均线呈同向排列时，趋势会延续一段。」
 * 这是最经典、最经得起检验的一类边际；与既有的 enhanced-trend-v1（1m 限价回调挂单）
 * 和结构类策略（多周期结构回踩）在**方向暴露与入场时机上完全不同** ——
 * 它不做回调、不等确认 K 线，只做突破当根本身的动能延续。
 *
 * ## 决策顺序（顺序即优先级）
 *   1. 数据不足（含指标周期在 80 根窗口下的降级）→ WAIT
 *   2. ATR% 越界（死水 or 极端波动）→ WAIT
 *   3. 均线排列与方向不一致（requireTrendAlign）→ WAIT
 *   4. 均线间距 / ATR < trendSepAtr（趋势不够强）→ WAIT
 *   5. ADX < adxMin（可选动能闸门）→ WAIT
 *   6. 收盘价未突破通道边界 + breakoutBufAtr×ATR → WAIT
 *   7. 量比 < volumeMult（可选）→ WAIT
 *   8. RSI 不在方向允许区间 → WAIT
 *   9. 成本后净盈亏比 < minNetRr → WAIT
 *   10. 全通过 → BUY / SELL（**市价**，下一根 K 线开盘成交）
 *
 * ## 出场
 *   初始止损 = max(stopAtr×ATR, minStopPct×价格)；
 *   止盈 = 入场 ± tpR×R（或 tpByAtr 时 = 入场 ± tpAtr×ATR）；
 *   移动止损 / 分批止盈沿用 enhanced 的 R 口径阶梯（plan.exitRules 快照）。
 *
 * ## 状态
 *   2026-09-17 新建。默认关闭，参数与三阶段验证结果见 output/h4-strategy-report.html。
 *   指标周期全部 ≤ 78，满足线上 80 根实时窗口；实际生效周期写入信号 trend 字段。
 *
 * @see server/shared/h4StrategyCommon.js  （入场用市价的原因 / 污染取证说明）
 */

import {
  H4_EXIT_DEFAULTS, H4_EXIT_PARAM_SCHEMA, H4_RISK_DEFAULTS, H4_RISK_PARAM_SCHEMA, H4_MAX_PERIOD,
  h4ExitRules, h4ProtectionReview, resolveH4Params, effectivePeriod, costAwareRr, resolveH4Market,
  h4WaitSignal, buildH4Plan, planIsSane, numSpec, boolSpec, clamp01
} from './shared/h4StrategyCommon.js';
import { ema, rsi, atrSeries, skillAdx, isFiniteCandle } from './shared/marketStructure.js';
import { PAPER_COSTS } from './research.js';

const RISK_NOTE = '4H 趋势突破（单向跟随）：4H 收盘突破近 N 根通道边界 + 均线同向排列时市价顺势入场，'
  + '止损按 ATR，止盈按 R 倍数，移动止损阶梯保护利润。'
  + '规则强度是信号分，不是胜率；三阶段回测结论见 output/h4-strategy-report.html。';

/** 参数默认值（字段与 H4_BREAKOUT_PARAM_SCHEMA 一一对应） */
export const H4_BREAKOUT_DEFAULTS = Object.freeze({
  // ── 指标周期 ──
  emaFast: 12,
  emaSlow: 26,
  atrPeriod: 14,
  channelPeriod: 20,
  volPeriod: 20,
  rsiPeriod: 14,
  adxPeriod: 14,
  // ── 波动率闸门 ──
  minAtrPct: 0.002,
  maxAtrPct: 0.15,
  // ── 趋势/突破闸门 ──
  requireTrendAlign: true,
  trendSepAtr: 0.0,
  breakoutBufAtr: 0.05,
  adxMin: 0,
  volumeMult: 0,
  rsiLongMin: 50,
  rsiLongMax: 100,
  rsiShortMin: 0,
  rsiShortMax: 50,
  // ── 方向开关 ──
  longOnly: false,
  shortOnly: false,
  // ── 计划几何 ──
  entryBandAtr: 0.2,
  stopAtr: 2.0,
  minStopPct: 0.008,
  tpByAtr: false,
  tpR: 3.0,
  tpAtr: 4.0,
  minNetRr: 1.0,
  maxHoldBars: 30,
  // ── 风控 / 出场规则 ──
  ...H4_RISK_DEFAULTS,
  ...H4_EXIT_DEFAULTS
});

const N = H4_BREAKOUT_DEFAULTS;

const BREAKOUT_PARAM_SCHEMA = [
  // 指标周期
  numSpec(N, 'emaFast', '快线周期（4H）', 'filter', 2, 60, 1, 'EMA 快线周期。与慢线的排列决定趋势方向。'),
  numSpec(N, 'emaSlow', '慢线周期（4H）', 'filter', 3, 78, 1, 'EMA 慢线周期。必须大于快线。80 根实时窗口下上限 78。'),
  numSpec(N, 'atrPeriod', 'ATR 周期（4H）', 'filter', 2, 60, 1, '真实波幅均线周期，用于止损距离与波动率闸门。'),
  numSpec(N, 'channelPeriod', '通道周期（4H）', 'filter', 3, 78, 1, '唐奇安通道回看根数。突破 = 收盘价越过该窗口的最高/最低。'),
  numSpec(N, 'volPeriod', '量能均线周期（4H）', 'filter', 2, 60, 1, '成交量基准均线周期（不含当前根）。'),
  numSpec(N, 'rsiPeriod', 'RSI 周期（4H）', 'filter', 2, 60, 1, 'RSI 周期。'),
  numSpec(N, 'adxPeriod', 'ADX 周期（4H）', 'filter', 2, 60, 1, 'ADX 周期，衡量趋势强度。'),
  // 波动率
  numSpec(N, 'minAtrPct', '波动率下限（ATR/价格）', 'filter', 0, 0.05, 0.0005, '低于该值视为死水行情，突破多为噪声。'),
  numSpec(N, 'maxAtrPct', '波动率上限（ATR/价格）', 'filter', 0.001, 0.5, 0.001, '高于该值视为极端波动，止损会被跳空穿越。'),
  // 趋势/突破
  boolSpec(N, 'requireTrendAlign', '要求均线同向排列', 'filter', '开启后多头必须 EMA 快线 > 慢线，空头相反。关闭即纯通道突破。'),
  numSpec(N, 'trendSepAtr', '均线间距下限（ATR）', 'filter', 0, 5, 0.05, '(快线−慢线)/ATR 的下限，用于过滤均线粘合的伪趋势。0 = 仅要求方向。'),
  numSpec(N, 'breakoutBufAtr', '突破缓冲（ATR）', 'filter', 0, 3, 0.05, '收盘价需越过通道边界 N×ATR 才算有效突破。0 = 接触即算。'),
  numSpec(N, 'adxMin', 'ADX 下限', 'filter', 0, 60, 1, '低于该值视为无趋势，跳过。0 = 不启用。'),
  numSpec(N, 'volumeMult', '量能倍数下限', 'filter', 0, 5, 0.05, '当前成交量 ÷ 量能均线的下限。0 = 不启用。'),
  numSpec(N, 'rsiLongMin', '多单 RSI 下限', 'filter', 0, 100, 1, '多头要求 RSI ≥ 该值。'),
  numSpec(N, 'rsiLongMax', '多单 RSI 上限', 'filter', 0, 100, 1, '多头要求 RSI ≤ 该值（防止追顶）。'),
  numSpec(N, 'rsiShortMin', '空单 RSI 下限', 'filter', 0, 100, 1, '空头要求 RSI ≥ 该值。'),
  numSpec(N, 'rsiShortMax', '空单 RSI 上限', 'filter', 0, 100, 1, '空头要求 RSI ≤ 该值。'),
  boolSpec(N, 'longOnly', '仅做多', 'filter', '开启后所有空头信号被拦截。'),
  boolSpec(N, 'shortOnly', '仅做空', 'filter', '开启后所有多头信号被拦截。'),
  // 计划几何
  numSpec(N, 'entryBandAtr', '市价成交区间半宽（ATR）', 'entry', 0.05, 0.25, 0.05,
    '市价单的 sanity 区间半宽，必须窄于止损距离（stopAtr 最小 0.3），不是挂单价。'),
  numSpec(N, 'stopAtr', '止损距离（ATR）', 'risk', 0.3, 6, 0.1, '初始止损 = max(N×ATR, 最小止损%)。'),
  numSpec(N, 'minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001, '止损绝对下限，兜底成本与低波动噪声。'),
  boolSpec(N, 'tpByAtr', '止盈按 ATR 计算', 'protection', '关闭时止盈 = 入场 ± tpR×R；开启时按 tpAtr×ATR。'),
  numSpec(N, 'tpR', '止盈（R 倍数）', 'protection', 0.2, 20, 0.1, 'tpByAtr 关闭时生效。3R 搭配 2ATR 止损 ≈ 6ATR 目标。'),
  numSpec(N, 'tpAtr', '止盈（ATR 倍数）', 'protection', 0.2, 30, 0.1, 'tpByAtr 开启时生效。'),
  numSpec(N, 'minNetRr', '最低净盈亏比', 'protection', 0, 10, 0.1, '成本后盈亏比闸门。目标太近直接不出手。'),
  numSpec(N, 'maxHoldBars', '最长持仓（4H 根）', 'position', 1, 120, 1,
    '超时按收盘价结算。30 根 = 5 天。上限 120 根 = 20 天，与 normalizePlan 的订单校验一致。'),
  ...H4_RISK_PARAM_SCHEMA,
  ...H4_EXIT_PARAM_SCHEMA
];

/**
 * 对外暴露的参数 schema。
 *
 * ⚠️ 这里的 default 必须与 H4_BREAKOUT_DEFAULTS 逐字段一致 —— 而且不只是「为了好看」：
 * `strategies/runtime.js#defaultParams(paramSchema)` 是从 **schema** 取默认值的，
 * 回测 `_h4_bt_core.mjs` 也走 `loadConfiguredStrategy` → `effectiveParams` → schema 默认值。
 * 也就是说：schema 与引擎 H4_*_DEFAULTS 一旦不一致，**引擎自己的默认值根本不会被用上**，
 * 运行期与回测都按 schema 跑。共用件 H4_RISK_PARAM_SCHEMA / H4_EXIT_PARAM_SCHEMA 的默认值
 * 来自全局口径（maxLeverage 12 / riskBudgetPct 0.18 / partialTp 1R·2R），
 * 与本策略声明的 5 / 0.1 / 3R 不同，因此这里统一按 H4_BREAKOUT_DEFAULTS 回填。
 */
export const H4_BREAKOUT_PARAM_SCHEMA = Object.freeze(BREAKOUT_PARAM_SCHEMA.map(spec =>
  Object.prototype.hasOwnProperty.call(H4_BREAKOUT_DEFAULTS, spec.key)
    ? { ...spec, default: H4_BREAKOUT_DEFAULTS[spec.key] }
    : spec));

/** 解析策略参数（越界回退默认并告警） */
export function resolveH4BreakoutParams(overrides) {
  return resolveH4Params(H4_BREAKOUT_DEFAULTS, H4_BREAKOUT_PARAM_SCHEMA, overrides, 'h4BreakoutAnalysis');
}

/**
 * 4H 趋势突破分析。
 * @param {{symbol:string, interval:string, klines:Array, dataAsOf?:string}} market 4H 行情（已收盘）
 * @param {{params?:object, auxMarkets?:object, planInterval?:string}} [ctx]
 * @param {{feeBps?:number, slippageBps?:number, fundingBpsPer8h?:number}} [costs]
 */
export function h4BreakoutAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  const p = resolveH4BreakoutParams(ctx?.params);
  const feed = resolveH4Market(market, ctx);
  const rows = feed.k;

  // 实际生效周期（80 根实时窗口下按需缩短，并显式披露）
  const pe = {
    emaFast: effectivePeriod(p.emaFast, rows),
    emaSlow: effectivePeriod(p.emaSlow, rows),
    atrPeriod: effectivePeriod(p.atrPeriod, rows),
    channelPeriod: effectivePeriod(p.channelPeriod, rows),
    volPeriod: effectivePeriod(p.volPeriod, rows),
    rsiPeriod: effectivePeriod(p.rsiPeriod, rows),
    adxPeriod: effectivePeriod(p.adxPeriod, rows)
  };
  const windowInfo = {
    interval: '4h',
    bars: rows.length,
    dataAsOf: feed.dataAsOf,
    source: feed.source,
    periods: Object.fromEntries(Object.entries(pe).map(([k, v]) => [k, v.actual])),
    periodRequested: Object.fromEntries(Object.entries(pe).map(([k, v]) => [k, v.requested])),
    degradedPeriods: Object.entries(pe).filter(([, v]) => v.degraded).map(([k]) => k),
    dataGap: false
  };
  const wait = (reason, extra = {}) => h4WaitSignal({
    symbol: market?.symbol, reason, riskNote: RISK_NOTE, windowInfo, extra
  });

  // 闸门 0：4H 行情来源（线上在 ctx.auxMarkets['4h']，主行情是 1m）
  if (!rows.length) {
    return wait('未获取到 4H 行情（线上需 needsAux=["4h"] 就绪；回测需 interval="4h" 的语料），本轮观望。',
      { dataGap: true, trend: { ...windowInfo, dataGap: true } });
  }

  // 闸门 1a：参数自洽性。快线周期 ≥ 慢线时均线排列判定无意义，
  // 必须显式拒绝而不是「碰巧产出信号」——否则一维扫描会把这种死组合当成一个正常取值。
  if (pe.emaFast.actual >= pe.emaSlow.actual) {
    return wait(`参数冲突：快线周期 ${pe.emaFast.actual} ≥ 慢线周期 ${pe.emaSlow.actual}，均线排列无意义，本轮观望。`,
      { paramConflict: 'emaFast>=emaSlow' });
  }

  // 闸门 1b：最少根数（慢线 + 通道 + 2 根「已收盘 + 前一根」）
  const needBars = Math.max(pe.emaSlow.actual, pe.channelPeriod.actual, pe.atrPeriod.actual) + 2;
  if (!rows.length || rows.length < needBars) {
    return wait(`4H 数据不足：需要 ${needBars} 根，实际 ${rows.length} 根（实时窗口固定 80 根）。`,
      { dataGap: true, trend: { ...windowInfo, dataGap: true } });
  }
  if (!rows.every(isFiniteCandle)) return wait('4H K 线存在坏打印（OHLC 非法），本轮观望。');

  const close = rows.map(r => r.close);
  const volume = rows.map(r => r.volume);
  const last = rows.at(-1);
  const price = last.close;

  const eFast = ema(close, pe.emaFast.actual)?.at(-1);
  const eSlow = ema(close, pe.emaSlow.actual)?.at(-1);
  const atr = atrSeries(rows, pe.atrPeriod.actual)?.at(-1);
  const rsiNow = rsi(close, pe.rsiPeriod.actual)?.at(-1);
  const adxNow = skillAdx(rows, pe.adxPeriod.actual)?.adx?.at(-1);
  if (![eFast, eSlow, atr].every(Number.isFinite) || !(atr > 0)) {
    return wait('4H 指标未就绪（EMA/ATR 无效），本轮观望。', { dataGap: true });
  }
  const atrPct = atr / price;

  // 通道（不含当前根）与量能基准
  const chanRows = rows.slice(-1 - pe.channelPeriod.actual, -1);
  const channelHigh = Math.max(...chanRows.map(r => r.high));
  const channelLow = Math.min(...chanRows.map(r => r.low));
  const volPrev = volume.slice(-1 - pe.volPeriod.actual, -1);
  const volMean = volPrev.length ? volPrev.reduce((s, v) => s + v, 0) / volPrev.length : NaN;
  const volumeRatio = Number.isFinite(volMean) && volMean > 0 ? volume.at(-1) / volMean : NaN;

  const spreadAtr = (eFast - eSlow) / atr;
  const metrics = {
    price, emaFast: eFast, emaSlow: eSlow, atr, atrPct,
    channelHigh, channelLow, spreadAtr, rsi: rsiNow, adx: Number.isFinite(adxNow) ? adxNow : null, volumeRatio
  };

  // 闸门 2：波动率区间
  if (atrPct < p.minAtrPct) return wait(`4H ATR ${(atrPct * 100).toFixed(3)}% 低于下限 ${(p.minAtrPct * 100).toFixed(3)}%（死水行情），本轮观望。`, { metrics });
  if (atrPct > p.maxAtrPct) return wait(`4H ATR ${(atrPct * 100).toFixed(3)}% 高于上限 ${(p.maxAtrPct * 100).toFixed(3)}%（极端波动），本轮观望。`, { metrics });

  const bullishBreak = price > channelHigh + p.breakoutBufAtr * atr;
  const bearishBreak = price < channelLow - p.breakoutBufAtr * atr;
  const longDirection = bullishBreak && !bearishBreak;
  const shortDirection = bearishBreak && !bullishBreak;
  const direction = longDirection ? 1 : shortDirection ? -1 : 0;

  if (!direction) {
    return wait(`4H 收盘 ${price.toPrecision(6)} 未有效突破通道 [${channelLow.toPrecision(6)}, ${channelHigh.toPrecision(6)}]`
      + `（需越过边界 ${p.breakoutBufAtr}×ATR），本轮观望。`, { metrics, channel: { channelHigh, channelLow } });
  }
  if (direction === 1 && p.shortOnly) return wait('多头信号被 shortOnly 拦截。', { metrics });
  if (direction === -1 && p.longOnly) return wait('空头信号被 longOnly 拦截。', { metrics });

  // 闸门 3：均线排列
  const alignLong = eFast > eSlow && price > eSlow;
  const alignShort = eFast < eSlow && price < eSlow;
  if (p.requireTrendAlign && !(direction === 1 ? alignLong : alignShort)) {
    return wait(`突破方向与均线排列不一致（快线 ${eFast.toPrecision(6)} / 慢线 ${eSlow.toPrecision(6)}），`
      + `要求同向排列才跟随，本轮观望。`, { metrics });
  }

  // 闸门 4：趋势强度
  const signedSpread = direction === 1 ? spreadAtr : -spreadAtr;
  if (p.trendSepAtr > 0 && signedSpread < p.trendSepAtr) {
    return wait(`均线间距 ${signedSpread.toFixed(3)}×ATR 低于门槛 ${p.trendSepAtr}（趋势未成型），本轮观望。`, { metrics });
  }

  // 闸门 5：ADX
  if (p.adxMin > 0 && (!Number.isFinite(adxNow) || adxNow < p.adxMin)) {
    return wait(`ADX ${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NA'} 低于门槛 ${p.adxMin}，本轮观望。`, { metrics });
  }

  // 闸门 6：量能
  if (p.volumeMult > 0 && (!Number.isFinite(volumeRatio) || volumeRatio < p.volumeMult)) {
    return wait(`量比 ${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : 'NA'} 低于门槛 ${p.volumeMult}，本轮观望。`, { metrics });
  }

  // 闸门 7：RSI 区间
  if (direction === 1 && Number.isFinite(rsiNow) && (rsiNow < p.rsiLongMin || rsiNow > p.rsiLongMax)) {
    return wait(`多单 RSI ${rsiNow.toFixed(1)} 不在 [${p.rsiLongMin}, ${p.rsiLongMax}]，本轮观望。`, { metrics });
  }
  if (direction === -1 && Number.isFinite(rsiNow) && (rsiNow < p.rsiShortMin || rsiNow > p.rsiShortMax)) {
    return wait(`空单 RSI ${rsiNow.toFixed(1)} 不在 [${p.rsiShortMin}, ${p.rsiShortMax}]，本轮观望。`, { metrics });
  }

  // 计划几何
  const riskUnit = Math.max(p.stopAtr * atr, p.minStopPct * price);
  const takeProfit = p.tpByAtr
    ? price + direction * p.tpAtr * atr
    : price + direction * p.tpR * riskUnit;
  const plan = buildH4Plan({
    direction, refPrice: price, atr, stopAtr: p.stopAtr, minStopPct: p.minStopPct,
    takeProfit, maxHoldBars: p.maxHoldBars, entryBandAtr: p.entryBandAtr,
    exitRules: h4ExitRules(p), params: p,
    targetSource: p.tpByAtr ? `tpAtr=${p.tpAtr}` : `tpR=${p.tpR}`,
    extra: { channelHigh, channelLow, atrPct, spreadAtr }
  });
  if (!planIsSane(plan, direction)) {
    return wait(`计划几何非法（止损 ${plan.stopLoss.toPrecision(6)} / 区间 [${plan.entryMin.toPrecision(6)}, `
      + `${plan.entryMax.toPrecision(6)}] / 止盈 ${plan.takeProfit.toPrecision(6)}）——`
      + `入场区间半宽 entryBandAtr=${p.entryBandAtr} 必须窄于止损 stopAtr=${p.stopAtr}。`, { metrics });
  }

  // 闸门 8：成本后净盈亏比
  // 用**最不利入场价**（多头取区间上沿、空头取区间下沿）估算 —— 与 research.normalizePlan
  // 的入场基准口径一致，否则回测通过、线上被 normalizePlan 判为「成本后盈亏比低于 1」而静默不出单。
  const worstEntry = direction === 1 ? plan.entryMax : plan.entryMin;
  const rr = costAwareRr({ entry: worstEntry, stopLoss: plan.stopLoss, takeProfit, maxHoldBars: p.maxHoldBars, costs });
  if (!(rr.netRr >= p.minNetRr)) {
    return wait(`成本后净盈亏比 ${rr.netRr.toFixed(2)} 低于门槛 ${p.minNetRr}`
      + `（最不利入场 ${worstEntry.toPrecision(6)}、毛 ${rr.grossRr.toFixed(2)}R、成本 ${(rr.costAbs / worstEntry * 10000).toFixed(1)}bps），本轮观望。`,
    { metrics, rr: { grossRr: rr.grossRr, netRr: rr.netRr } });
  }

  // 候选排序分（0~100）：只在同轮多币竞争仓位时决定先后，不代表胜率
  const edgeDistance = direction === 1
    ? (price - channelHigh) / atr
    : (channelLow - price) / atr;
  const score = Math.round(Math.max(0, Math.min(100,
    10
    + 25 * clamp01(signedSpread / 3)
    + 25 * clamp01(edgeDistance / 1.5)
    + 15 * (Number.isFinite(volumeRatio) ? clamp01((volumeRatio - 0.8) / 1.2) : 0.5)
    + 15 * (Number.isFinite(adxNow) ? clamp01(adxNow / 40) : 0.4)
    + 10 * clamp01(1 - Math.abs(atrPct - 0.01) / 0.02)
  )));
  const confidence = Math.max(0, Math.min(0.95, score / 100));

  const dirText = direction === 1 ? '多' : '空';
  const reason = `4H 趋势突破·${dirText}：收盘 ${price.toPrecision(6)} 突破${direction === 1 ? '上' : '下'}轨`
    + `（通道 [${channelLow.toPrecision(6)}, ${channelHigh.toPrecision(6)}]，越过 ${edgeDistance.toFixed(2)}×ATR）；`
    + `快线 EMA${pe.emaFast.actual} ${eFast.toPrecision(6)} / 慢线 EMA${pe.emaSlow.actual} ${eSlow.toPrecision(6)}`
    + `（间距 ${signedSpread.toFixed(2)}×ATR）；ATR${pe.atrPeriod.actual} ${(atrPct * 100).toFixed(2)}%、`
    + `RSI ${Number.isFinite(rsiNow) ? rsiNow.toFixed(1) : 'NA'}、ADX ${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NA'}、`
    + `量比 ${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : 'NA'}；`
    + `市价入场≈${price.toPrecision(6)}，止损 ${plan.stopLoss.toPrecision(6)}（${p.stopAtr}×ATR = −${(plan.stopDistancePct * 100).toFixed(2)}%），`
    + `止盈 ${takeProfit.toPrecision(6)}（毛 ${rr.grossRr.toFixed(2)}R / 成本后 ${rr.netRr.toFixed(2)}R），`
    + `持仓上限 ${plan.maxHoldBars} 根 4H = ${(plan.maxHoldBars * 4 / 24).toFixed(1)} 天，推荐杠杆 ${plan.recommendedLeverage}x。`
    + `失效条件：4H 收盘跌破 ${plan.stopLoss.toPrecision(6)} 或触发移动止损。`
    + (windowInfo.degradedPeriods.length ? `⚠️ 周期降级：${windowInfo.degradedPeriods.join(',')}。` : '');

  return {
    symbol: market.symbol,
    action: direction === 1 ? 'BUY' : 'SELL',
    decision: direction === 1 ? 'LONG_ALLOWED' : 'SHORT_ALLOWED',
    state: 'ALLOWED',
    confidence,
    reason,
    risk: RISK_NOTE,
    score,
    entryQuality: score,
    metrics,
    trend: windowInfo,
    plan
  };
}

/** 持仓复核：移动止损阶梯（订单快照口径） */
export const h4BreakoutReview = h4ProtectionReview;

export const H4_BREAKOUT_MAX_PERIOD = H4_MAX_PERIOD;
