/**
 * 4H 吊灯突破引擎（h4-chandelier-breakout-v1）
 * —— 海龟式长通道突破入场 + 吊灯移动止损收尾的趋势奔跑策略
 *
 * ## 与 h4-trend-breakout-v1 的本质差异（不是克隆）
 *   1. 通道周期 55（海龟口径）vs 20：信号更少、趋势段更长；
 *   2. 默认开启 ADX≥20 与量比≥1.2 确认（突破 v1 默认关闭）；
 *   3. 出场完全不同：主止盈放在 tpR=12R 的远处（几乎不触发，让利润奔跑），
 *      真实退出靠**吊灯止损**（Chandelier Exit：持仓以来最高价 − mult×ATR(22)，
 *      逐 4H 复核收紧、只紧不松）+ 分批止盈（1R 平 40% 并抬保本 = moon bag，
 *      2R 再平 20%，剩余 40% 纯靠吊灯跑出趋势尾部）+ 45 根 4H 超时。
 *   4. 成本闸门不用远端主止盈算（12R 恒过），改用 tpGateR（默认 2R）评估成本后净盈亏比。
 *
 * ## 依据
 *   外部大规模回测（2870 万次组合）显示趋势类币种上「到目标后追踪止损 / ATR 吊灯」
 *   优于固定止盈；本项目模拟器原生支持分批止盈 + 保本抬升（_simulate 内），
 *   吊灯部分由本引擎 review 逐 4H 推进，复用 applyPaperProtectionReview 的棘轮校验。
 *
 * ## 状态
 *   2026-09-19 新建。默认关闭；启用前须通过 365 天样本回测与 shadow 验证。
 */

import {
  H4_EXIT_PARAM_SCHEMA, H4_RISK_DEFAULTS, H4_RISK_PARAM_SCHEMA, H4_MAX_PERIOD,
  h4ExitRules, resolveH4Params, effectivePeriod, costAwareRr, resolveH4Market,
  h4WaitSignal, buildH4Plan, planIsSane, numSpec, boolSpec, clamp01
} from './shared/h4StrategyCommon.js';
import { tightestStop } from './shared/protectionReview.js';
import { ema, rsi, atrSeries, skillAdx, isFiniteCandle } from './shared/marketStructure.js';
import { PAPER_COSTS } from './research.js';

const H4_MS = 14400000;

const RISK_NOTE = '4H 吊灯突破：55 根通道突破 + EMA/ADX/量能确认后市价顺势入场；'
  + '1R/2R 分批止盈并抬保本（moon bag），剩余仓位由吊灯止损（持仓以来极值 ∓ N×ATR）收尾。'
  + '规则强度是信号分，不是胜率；启用前以样本回测为准。';

/** 参数默认值（字段与 H4_CHANDELIER_PARAM_SCHEMA 一一对应） */
export const H4_CHANDELIER_DEFAULTS = Object.freeze({
  // ── 指标周期 ──
  emaFast: 20,
  emaSlow: 50,
  atrPeriod: 14,
  channelPeriod: 55,
  volPeriod: 20,
  rsiPeriod: 14,
  adxPeriod: 14,
  // ── 波动率闸门 ──
  minAtrPct: 0.002,
  maxAtrPct: 0.15,
  // ── 趋势/突破闸门 ──
  breakoutBufAtr: 0.1,
  adxMin: 20,
  volumeMult: 1.2,
  rsiLongMin: 50,
  rsiLongMax: 80,
  rsiShortMin: 20,
  rsiShortMax: 50,
  // ── 方向开关（默认仅多，与生产 NOFX_LONG_ONLY 一致）──
  longOnly: true,
  shortOnly: false,
  // ── 计划几何 ──
  entryBandAtr: 0.2,
  stopAtr: 2.5,
  minStopPct: 0.008,
  tpR: 12,
  tpGateR: 2.0,
  minNetRr: 1.0,
  maxHoldBars: 45,
  // ── 吊灯止损（review 用，快照进 plan.chandelier）──
  chandelierEnabled: true,
  chandelierAtrPeriod: 22,
  chandelierMult: 3.0,
  // ── 假突破刮单：已收 4H 收回信号通道内 → 贴价止损立即离场 ──
  scratchOnChannelReclose: true,
  scratchBufAtr: 0,
  // ── 风控 / 出场规则 ──
  ...H4_RISK_DEFAULTS,
  // 分批止盈：1R 平 40% 抬保本、2R 再平 20%（剩余 40% 奔跑）；阶梯移动止损不用（吊灯替代）
  ...Object.fromEntries(H4_EXIT_PARAM_SCHEMA.map(spec => [spec.key, spec.default])),
  partialTpEnabled: true,
  partialTp1R: 1,
  partialTp1ClosePct: 0.4,
  partialTp2R: 2,
  partialTp2ClosePct: 0.2,
  partialTpMoveStopToBreakeven: true
});

const N = H4_CHANDELIER_DEFAULTS;

/** 分批止盈默认值与全局不同，schema 默认值必须回填（schema 是运行期/回测唯一事实源） */
const CHANDELIER_EXIT_PARAM_SCHEMA = H4_EXIT_PARAM_SCHEMA.map(spec =>
  Object.prototype.hasOwnProperty.call(N, spec.key) ? { ...spec, default: N[spec.key] } : spec);

const CHANDELIER_PARAM_SCHEMA = [
  numSpec(N, 'emaFast', '快线周期（4H）', 'filter', 2, 60, 1, 'EMA 快线周期。与慢线排列决定趋势方向。'),
  numSpec(N, 'emaSlow', '慢线周期（4H）', 'filter', 3, 78, 1, 'EMA 慢线周期。必须大于快线。80 根实时窗口上限 78。'),
  numSpec(N, 'atrPeriod', 'ATR 周期（4H）', 'filter', 2, 60, 1, '止损距离与波动率闸门用。'),
  numSpec(N, 'channelPeriod', '通道周期（4H）', 'filter', 3, 78, 1, '唐奇安通道回看根数。55 ≈ 海龟慢系统。'),
  numSpec(N, 'volPeriod', '量能均线周期（4H）', 'filter', 2, 60, 1, '成交量基准均线周期（不含当前根）。'),
  numSpec(N, 'rsiPeriod', 'RSI 周期（4H）', 'filter', 2, 60, 1, 'RSI 周期。'),
  numSpec(N, 'adxPeriod', 'ADX 周期（4H）', 'filter', 2, 60, 1, 'ADX 周期。'),
  numSpec(N, 'minAtrPct', '波动率下限（ATR/价格）', 'filter', 0, 0.05, 0.0005, '低于该值视为死水行情。'),
  numSpec(N, 'maxAtrPct', '波动率上限（ATR/价格）', 'filter', 0.001, 0.5, 0.001, '高于该值视为极端波动。'),
  numSpec(N, 'breakoutBufAtr', '突破缓冲（ATR）', 'filter', 0, 3, 0.05, '收盘价需越过通道边界 N×ATR 才算有效突破。'),
  numSpec(N, 'adxMin', 'ADX 下限', 'filter', 0, 60, 1, '低于该值视为无趋势。0 = 不启用。'),
  numSpec(N, 'volumeMult', '量能倍数下限', 'filter', 0, 5, 0.05, '当前成交量 ÷ 量能均线的下限。0 = 不启用。'),
  numSpec(N, 'rsiLongMin', '多单 RSI 下限', 'filter', 0, 100, 1, '多头要求 RSI ≥ 该值。'),
  numSpec(N, 'rsiLongMax', '多单 RSI 上限', 'filter', 0, 100, 1, '多头要求 RSI ≤ 该值（防追顶）。'),
  numSpec(N, 'rsiShortMin', '空单 RSI 下限', 'filter', 0, 100, 1, '空头要求 RSI ≥ 该值。'),
  numSpec(N, 'rsiShortMax', '空单 RSI 上限', 'filter', 0, 100, 1, '空头要求 RSI ≤ 该值。'),
  boolSpec(N, 'longOnly', '仅做多', 'filter', '开启后所有空头信号被拦截。'),
  boolSpec(N, 'shortOnly', '仅做空', 'filter', '开启后所有多头信号被拦截。'),
  numSpec(N, 'entryBandAtr', '市价成交区间半宽（ATR）', 'entry', 0.05, 0.25, 0.05, '市价单 sanity 区间半宽，必须窄于止损距离。'),
  numSpec(N, 'stopAtr', '止损距离（ATR）', 'risk', 0.3, 6, 0.1, '初始止损 = max(N×ATR, 最小止损%)。'),
  numSpec(N, 'minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001, '止损绝对下限。'),
  numSpec(N, 'tpR', '远端主止盈（R 倍数）', 'protection', 2, 40, 0.5,
    '刻意放远（默认 12R）：几乎不触发，真实退出靠吊灯止损；同时保证分批档位严格早于主止盈。'),
  numSpec(N, 'tpGateR', '成本闸门评估目标（R 倍数）', 'protection', 0.5, 10, 0.1,
    '主止盈太远无法做成本闸门，用该 R 倍数的目标评估成本后净盈亏比。'),
  numSpec(N, 'minNetRr', '最低净盈亏比（按 tpGateR）', 'protection', 0, 10, 0.1, '成本后盈亏比闸门。'),
  numSpec(N, 'maxHoldBars', '最长持仓（4H 根）', 'position', 1, 120, 1, '超时按收盘价结算。45 根 = 7.5 天。'),
  boolSpec(N, 'chandelierEnabled', '启用吊灯移动止损', 'protection', '复核时每轮把止损抬到「持仓以来极值 − mult×ATR」，只紧不松。'),
  numSpec(N, 'chandelierAtrPeriod', '吊灯 ATR 周期（4H）', 'protection', 2, 60, 1, 'Chandelier Exit 经典口径 22。'),
  numSpec(N, 'chandelierMult', '吊灯 ATR 倍数', 'protection', 1, 8, 0.1, '止损 = 持仓以来最高价 − N×ATR（多头）。经典口径 3。'),
  boolSpec(N, 'scratchOnChannelReclose', '假突破刮单', 'protection',
    '已收 4H 收回信号时的通道内（多头跌破上轨/空头站回下轨）→ 贴价止损、下一根开盘立即离场。回测实证：收回通道内的单合计净亏，守住的 76% 胜率。'),
  numSpec(N, 'scratchBufAtr', '刮单缓冲（ATR）', 'protection', 0, 2, 0.05, '收回通道内超过该缓冲才触发刮单，0 = 收盘越界即触发。'),
  ...H4_RISK_PARAM_SCHEMA,
  ...CHANDELIER_EXIT_PARAM_SCHEMA
];

export const H4_CHANDELIER_PARAM_SCHEMA = Object.freeze(CHANDELIER_PARAM_SCHEMA.map(spec =>
  Object.prototype.hasOwnProperty.call(H4_CHANDELIER_DEFAULTS, spec.key)
    ? { ...spec, default: H4_CHANDELIER_DEFAULTS[spec.key] }
    : spec));

export function resolveH4ChandelierParams(overrides) {
  return resolveH4Params(H4_CHANDELIER_DEFAULTS, H4_CHANDELIER_PARAM_SCHEMA, overrides, 'h4ChandelierBreakoutAnalysis');
}

/**
 * 4H 吊灯突破分析。
 * @param {{symbol:string, interval:string, klines:Array, dataAsOf?:string}} market 4H 行情（已收盘）
 * @param {{params?:object, auxMarkets?:object}} [ctx]
 * @param {{feeBps?:number, slippageBps?:number, fundingBpsPer8h?:number}} [costs]
 */
export function h4ChandelierBreakoutAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  const p = resolveH4ChandelierParams(ctx?.params);
  const feed = resolveH4Market(market, ctx);
  const rows = feed.k;

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

  if (!rows.length) {
    return wait('未获取到 4H 行情（线上需 needsAux=["4h"] 就绪；回测需 interval="4h" 的语料），本轮观望。',
      { dataGap: true, trend: { ...windowInfo, dataGap: true } });
  }
  if (pe.emaFast.actual >= pe.emaSlow.actual) {
    return wait(`参数冲突：快线周期 ${pe.emaFast.actual} ≥ 慢线周期 ${pe.emaSlow.actual}，本轮观望。`,
      { paramConflict: 'emaFast>=emaSlow' });
  }
  const needBars = Math.max(pe.emaSlow.actual, pe.channelPeriod.actual, pe.atrPeriod.actual) + 2;
  if (rows.length < needBars) {
    return wait(`4H 数据不足：需要 ${needBars} 根，实际 ${rows.length} 根。`,
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

  if (atrPct < p.minAtrPct) return wait(`4H ATR ${(atrPct * 100).toFixed(3)}% 低于下限（死水行情），本轮观望。`, { metrics });
  if (atrPct > p.maxAtrPct) return wait(`4H ATR ${(atrPct * 100).toFixed(3)}% 高于上限（极端波动），本轮观望。`, { metrics });

  const bullishBreak = price > channelHigh + p.breakoutBufAtr * atr;
  const bearishBreak = price < channelLow - p.breakoutBufAtr * atr;
  const direction = bullishBreak && !bearishBreak ? 1 : bearishBreak && !bullishBreak ? -1 : 0;

  if (!direction) {
    return wait(`4H 收盘 ${price.toPrecision(6)} 未有效突破 55 根通道 [${channelLow.toPrecision(6)}, ${channelHigh.toPrecision(6)}]，本轮观望。`,
      { metrics, channel: { channelHigh, channelLow } });
  }
  if (direction === 1 && p.shortOnly) return wait('多头信号被 shortOnly 拦截。', { metrics });
  if (direction === -1 && p.longOnly) return wait('空头信号被 longOnly 拦截。', { metrics });

  // 均线同向排列（本策略恒要求：长通道假突破多，必须拿排列过滤）
  const aligned = direction === 1 ? (eFast > eSlow && price > eSlow) : (eFast < eSlow && price < eSlow);
  if (!aligned) {
    return wait(`突破方向与均线排列不一致（快线 ${eFast.toPrecision(6)} / 慢线 ${eSlow.toPrecision(6)}），本轮观望。`, { metrics });
  }
  if (p.adxMin > 0 && (!Number.isFinite(adxNow) || adxNow < p.adxMin)) {
    return wait(`ADX ${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NA'} 低于门槛 ${p.adxMin}，本轮观望。`, { metrics });
  }
  if (p.volumeMult > 0 && (!Number.isFinite(volumeRatio) || volumeRatio < p.volumeMult)) {
    return wait(`量比 ${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : 'NA'} 低于门槛 ${p.volumeMult}，本轮观望。`, { metrics });
  }
  if (direction === 1 && Number.isFinite(rsiNow) && (rsiNow < p.rsiLongMin || rsiNow > p.rsiLongMax)) {
    return wait(`多单 RSI ${rsiNow.toFixed(1)} 不在 [${p.rsiLongMin}, ${p.rsiLongMax}]，本轮观望。`, { metrics });
  }
  if (direction === -1 && Number.isFinite(rsiNow) && (rsiNow < p.rsiShortMin || rsiNow > p.rsiShortMax)) {
    return wait(`空单 RSI ${rsiNow.toFixed(1)} 不在 [${p.rsiShortMin}, ${p.rsiShortMax}]，本轮观望。`, { metrics });
  }

  const riskUnit = Math.max(p.stopAtr * atr, p.minStopPct * price);
  // 远端主止盈：让利润奔跑，真实退出靠吊灯止损与分批止盈
  const takeProfit = price + direction * p.tpR * riskUnit;
  const plan = buildH4Plan({
    direction, refPrice: price, atr, stopAtr: p.stopAtr, minStopPct: p.minStopPct,
    takeProfit, maxHoldBars: p.maxHoldBars, entryBandAtr: p.entryBandAtr,
    exitRules: h4ExitRules(p), params: p,
    targetSource: `tpR=${p.tpR}(远端)+chandelier`,
    extra: {
      channelHigh, channelLow, atrPct, spreadAtr,
      // 吊灯参数快照：review 只拿得到 order/market，参数必须随 plan 走
      chandelier: {
        enabled: p.chandelierEnabled,
        atrPeriod: p.chandelierAtrPeriod,
        mult: p.chandelierMult,
        // 假突破刮单：信号时刻的通道边界（review 期通道会滑动，必须用信号时刻快照）
        scratchEnabled: p.scratchOnChannelReclose,
        scratchBufAtr: p.scratchBufAtr,
        channelHigh,
        channelLow
      }
    }
  });
  if (!planIsSane(plan, direction)) {
    return wait(`计划几何非法（止损 ${plan.stopLoss.toPrecision(6)} / 止盈 ${plan.takeProfit.toPrecision(6)}），本轮观望。`, { metrics });
  }

  // 成本闸门：用 tpGateR（而非远端主止盈）评估
  const gateTarget = price + direction * p.tpGateR * riskUnit;
  const worstEntry = direction === 1 ? plan.entryMax : plan.entryMin;
  const rr = costAwareRr({ entry: worstEntry, stopLoss: plan.stopLoss, takeProfit: gateTarget, maxHoldBars: p.maxHoldBars, costs });
  if (!(rr.netRr >= p.minNetRr)) {
    return wait(`成本后净盈亏比 ${rr.netRr.toFixed(2)} 低于门槛 ${p.minNetRr}（按 ${p.tpGateR}R 目标评估），本轮观望。`,
      { metrics, rr: { grossRr: rr.grossRr, netRr: rr.netRr } });
  }

  const edgeDistance = direction === 1 ? (price - channelHigh) / atr : (channelLow - price) / atr;
  const score = Math.round(Math.max(0, Math.min(100,
    10
    + 25 * clamp01(Math.abs(spreadAtr) / 3)
    + 25 * clamp01(edgeDistance / 1.5)
    + 15 * (Number.isFinite(volumeRatio) ? clamp01((volumeRatio - 0.8) / 1.2) : 0.5)
    + 15 * (Number.isFinite(adxNow) ? clamp01(adxNow / 40) : 0.4)
    + 10 * clamp01(1 - Math.abs(atrPct - 0.01) / 0.02)
  )));
  const confidence = Math.max(0, Math.min(0.95, score / 100));

  const dirText = direction === 1 ? '多' : '空';
  const reason = `4H 吊灯突破·${dirText}：收盘 ${price.toPrecision(6)} 突破${direction === 1 ? '上' : '下'}轨`
    + `（${pe.channelPeriod.actual} 根通道 [${channelLow.toPrecision(6)}, ${channelHigh.toPrecision(6)}]，越过 ${edgeDistance.toFixed(2)}×ATR）；`
    + `EMA${pe.emaFast.actual} ${eFast.toPrecision(6)} / EMA${pe.emaSlow.actual} ${eSlow.toPrecision(6)}；`
    + `ATR ${(atrPct * 100).toFixed(2)}%、RSI ${Number.isFinite(rsiNow) ? rsiNow.toFixed(1) : 'NA'}、`
    + `ADX ${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NA'}、量比 ${Number.isFinite(volumeRatio) ? volumeRatio.toFixed(2) : 'NA'}；`
    + `市价入场≈${price.toPrecision(6)}，止损 ${plan.stopLoss.toPrecision(6)}（${p.stopAtr}×ATR），`
    + `分批 1R 平 ${p.partialTp1ClosePct * 100}% 抬保本 / ${p.partialTp2R}R 再平 ${p.partialTp2ClosePct * 100}%，`
    + `剩余由吊灯止损（${p.chandelierMult}×ATR${p.chandelierAtrPeriod}）收尾，远端主止盈 ${p.tpR}R 仅作上限，`
    + `超时 ${plan.maxHoldBars} 根 4H = ${(plan.maxHoldBars * 4 / 24).toFixed(1)} 天，推荐杠杆 ${plan.recommendedLeverage}x。`
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

/**
 * 持仓复核：吊灯移动止损（Chandelier Exit）。
 * 止损 = 持仓以来最高价 − mult×ATR（多头）/ 持仓以来最低价 + mult×ATR（空头），
 * 经 tightestStop 棘轮保证只紧不松；takeProfit 原样回传（复核校验需要有效止盈价）。
 * 参数从 order.plan.chandelier 快照读（review 拿不到策略 ctx）。
 */
export function h4ChandelierReview(order, market) {
  const long = order?.direction === 'OPEN_LONG';
  const price = Number(order?.markPrice);
  const entryAt = Date.parse(order?.entryAt || '');
  const snap = order?.plan?.chandelier || {};
  if (snap.enabled === false) return { action: 'HOLD', reason: '吊灯止损未启用。' };
  const rows = (market?.klines || []).filter(isFiniteCandle);
  if (!rows.length || !Number.isFinite(price) || !(price > 0) || !Number.isFinite(entryAt)) {
    return { action: 'HOLD', reason: '行情或订单数据不足，保留当前保护价格。' };
  }
  const atrPeriod = Math.max(2, Math.floor(Number(snap.atrPeriod) || 22));
  const mult = Math.max(0.5, Number(snap.mult) || 3);
  const atrNow = atrSeries(rows, atrPeriod)?.at(-1);
  if (!(atrNow > 0)) return { action: 'HOLD', reason: '吊灯 ATR 未就绪，保留当前保护价格。' };

  // 持仓以来的极值：含成交所在的那根 4H（openTime + 4h > entryAt 即「成交时仍在走的根」）
  const heldRows = rows.filter(r => Number(r.openTime) + H4_MS > entryAt);
  if (!heldRows.length) return { action: 'HOLD', reason: '成交后尚无已收盘 4H，保留当前保护价格。' };

  // 假突破刮单：最新已收 4H 收回信号时刻的通道内 → 突破已被证伪，
  // 贴价止损（次根开盘即触发 ≈ 市价离场），把 2.5ATR 初始止损的亏损截断在早期。
  const chHigh = Number(snap.channelHigh), chLow = Number(snap.channelLow);
  if (snap.scratchEnabled !== false && Number.isFinite(chHigh) && Number.isFinite(chLow)) {
    const buf = Math.max(0, Number(snap.scratchBufAtr) || 0) * atrNow;
    const lastClose = Number(rows.at(-1).close);
    const failed = long ? lastClose < chHigh - buf : lastClose > chLow + buf;
    if (failed) {
      const immediate = long ? price * (1 - 0.0005) : price * (1 + 0.0005);
      const current = tightestStop(order, long);
      if (long ? immediate > current : immediate < current) {
        return {
          action: 'UPDATE_PROTECTION',
          stopLoss: immediate,
          takeProfit: Number(order.plan.takeProfit),
          confidence: 0.8,
          reason: `假突破刮单：4H 收盘 ${lastClose.toPrecision(6)} 收回信号通道${long ? '上' : '下'}轨 ${(long ? chHigh : chLow).toPrecision(6)} 内，贴价止损次根开盘离场。`
        };
      }
    }
  }

  const extreme = long
    ? Math.max(...heldRows.map(r => r.high))
    : Math.min(...heldRows.map(r => r.low));
  const rawStop = long ? extreme - mult * atrNow : extreme + mult * atrNow;

  const current = tightestStop(order, long);
  const tighter = long ? rawStop > current : rawStop < current;
  const valid = long ? rawStop < price : rawStop > price;
  if (!tighter || !valid) {
    return {
      action: 'HOLD',
      reason: `吊灯候选 ${rawStop.toPrecision(6)} 不紧于历史最紧 ${current.toPrecision(6)} 或越过现价，保留当前保护价格。`
    };
  }
  return {
    action: 'UPDATE_PROTECTION',
    stopLoss: rawStop,
    takeProfit: Number(order.plan.takeProfit),
    confidence: 0.75,
    reason: `吊灯止损：持仓以来${long ? '最高' : '最低'} ${extreme.toPrecision(6)} ${long ? '−' : '+'} ${mult}×ATR${atrPeriod}(${atrNow.toPrecision(6)}) = ${rawStop.toPrecision(6)}。`
  };
}

export const H4_CHANDELIER_MAX_PERIOD = H4_MAX_PERIOD;
