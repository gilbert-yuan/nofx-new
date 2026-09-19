/**
 * 4H 均值回归引擎（h4-mean-reversion-v1）
 * —— 以 4H 已收盘 K 线为**唯一决策周期**的逆势策略（双向）
 *
 * ## 假设
 * 「价格相对 4H 均线偏离超过 N 倍 ATR、且 RSI 进入极端区时，短期存在向均线回归的动能。」
 * 与 h4-trend-breakout-v1 是**互补假设**：突破策略在趋势市赚钱、震荡市被反复打脸；
 * 均值回归反之。两者同时只应有一个处于适配行情，因此放在一起是为了对照，
 * 而不是为了叠加（回测里各自独立跑、独立验证）。
 *
 * ## 决策顺序（顺序即优先级）
 *   1. 数据不足 → WAIT
 *   2. ATR% 越界 → WAIT
 *   3. ADX 高于 adxMax（趋势太强，逆势危险）→ WAIT
 *   4. 偏离 |价格−均线|/ATR < entryExtAtr → WAIT
 *   5. RSI 未进入极端区 → WAIT
 *   6. 缺反向企稳 K 线确认（requireReversalCandle）→ WAIT
 *   7. 成本后净盈亏比 < minNetRr（或止盈已穿过均线）→ WAIT
 *   8. 全通过 → BUY / SELL（**市价**，下一根 K 线开盘成交）
 *
 * ## 出场
 *   止损 = 入场 ± max(stopAtr×ATR, minStopPct×价格)；
 *   止盈默认**回到入场时的 4H 均线**（均值回归的自然目标），
 *   也可切换为 R 倍数 / ATR 倍数；移动止损与分批止盈沿用 enhanced 的 R 口径阶梯。
 *
 * ## 状态
 *   2026-09-17 新建。默认关闭，参数与三阶段验证结果见 output/h4-strategy-report.html。
 *
 * @see server/shared/h4StrategyCommon.js
 */

import {
  H4_EXIT_DEFAULTS, H4_EXIT_PARAM_SCHEMA, H4_RISK_DEFAULTS, H4_RISK_PARAM_SCHEMA,
  h4ExitRules, h4ProtectionReview, resolveH4Params, effectivePeriod, costAwareRr, resolveH4Market,
  h4WaitSignal, buildH4Plan, planIsSane, numSpec, boolSpec, clamp01
} from './shared/h4StrategyCommon.js';
import { ema, rsi, atrSeries, skillAdx, isFiniteCandle } from './shared/marketStructure.js';
import { PAPER_COSTS } from './research.js';

const RISK_NOTE = '4H 均值回归（逆势）：4H 价格偏离均线超过 N×ATR 且 RSI 进入极端区、并出现反向企稳 K 线时'
  + '市价逆势入场，目标回归 4H 均线，止损按 ATR。'
  + '规则强度是信号分，不是胜率；三阶段回测结论见 output/h4-strategy-report.html。';

/** 参数默认值（字段与 H4_REVERSION_PARAM_SCHEMA 一一对应） */
export const H4_REVERSION_DEFAULTS = Object.freeze({
  // ── 指标周期 ──
  meanPeriod: 20,
  // atrPeriod 9：平衡档定案值（09-17 全量 428 币 × 365d 扫参，ATR 用短周期对偏离更敏感）。
  atrPeriod: 9,
  rsiPeriod: 14,
  adxPeriod: 14,
  // ── 波动率闸门 ──
  minAtrPct: 0.002,
  // maxAtrPct 0.035：收益档仍限制极端波动；高波动超卖更容易是单边下跌起点。
  maxAtrPct: 0.035,
  // ── 极端偏离闸门 ──
  entryExtAtr: 2.0,
  // RSI 30：只保留更极端的回撤，减少普通噪声信号。
  rsiOversold: 30,
  rsiOverbought: 70,
  // ADX 50：收益档允许更多中等强度回归机会，但仍挡住极端单边行情。
  // 0 = 关闭该闸门。
  adxMax: 50,
  // requireReversalCandle false：要求「当根收阳/收阴且收在上/下半部」等于等反弹启动后才进，
  // 4H 粒度下价格已经回归一半，入场价与目标均线之间的空间被吃掉。证伪：开启后成交样本 82 → 3 笔。
  requireReversalCandle: false,
  // ── 方向开关 ──
  // longOnly true：空头侧在 365 天语料上没有边际；且本项目生产口径本身即 LONG_ONLY。
  longOnly: true,
  shortOnly: false,
  // ── 计划几何 ──
  entryBandAtr: 0.2,
  stopAtr: 1.5,
  minStopPct: 0.008,
  tpToMean: true,
  tpR: 1.5,
  tpAtr: 2.0,
  // minNetRr 1.625：本策略**最重要的闸门**。它按「成本后净盈亏比」筛单 ——
  // 回归目标离入场价太近的单子，毛收益盖不住 手续费 12bp + 资金费 ~9bp，
  // 这一类单子正是全部亏损的来源。1.625 是内部驻点（全量口径）；1.875 起零成交。
  minNetRr: 1.625,
  // maxHoldBars 17：收益顶点（三证据同向：配对反事实 / 闸门随动 / 补偿闸门 12 组无优）。
  // 放长不会更高；17 根 4H ≈ 2.8 天。上限 120 根 = 20 天，与 normalizePlan 的订单校验一致。
  maxHoldBars: 17,
  // ── 仓位 / 资金池（100U 账户、Binance 最低 5U）──
  // 每笔基础保证金 = 权益 × 0.05；交易链路仍会把低于 5U 的结果补足到 5U。
  autoMarginPct: 0.05,
  // 收益档允许 10 笔并发，名义敞口由 trader 的单仓/总额上限二次约束。
  maxPositions: 10,
  // ── 风控 / 出场规则 ──
  ...H4_RISK_DEFAULTS,
  ...H4_EXIT_DEFAULTS,
  // 普通信号使用 2 倍杠杆；高分信号单独进入评分杠杆档，避免把整个信号池一起放大。
  maxLeverage: 2,
  riskBudgetPct: 0.5,
  scoreLeverageEnabled: true,
  scoreLeverageThreshold: 72,
  scoreLeverageMax: 4,
  // ⚠️ 以下两项必须在 H4_EXIT_DEFAULTS 之后：分批止盈的目标必须**排在 minNetRr 之后**。
  // minNetRr 抬到 1.5 后，若第一档仍挂在 1.0R、第二档仍挂在 2.0R，
  // 第一档就会在「还没跑回成本门槛」时先落袋，把已经通过闸门的好单提前拆散。
  partialTp1R: 1.5,
  partialTp2R: 3.0
});

const N = H4_REVERSION_DEFAULTS;

const REVERSION_PARAM_SCHEMA = [
  numSpec(N, 'meanPeriod', '均值线周期（4H）', 'filter', 3, 78, 1, '回归目标均线（EMA）周期。'),
  numSpec(N, 'atrPeriod', 'ATR 周期（4H）', 'filter', 2, 60, 1, '真实波幅均线周期，用于衡量「偏离多少」。'),
  numSpec(N, 'rsiPeriod', 'RSI 周期（4H）', 'filter', 2, 60, 1, 'RSI 周期。'),
  numSpec(N, 'adxPeriod', 'ADX 周期（4H）', 'filter', 2, 60, 1, 'ADX 周期，用于回避强趋势行情。'),
  numSpec(N, 'minAtrPct', '波动率下限（ATR/价格）', 'filter', 0, 0.05, 0.0005, '低于该值视为死水行情，回归空间不足。'),
  numSpec(N, 'maxAtrPct', '波动率上限（ATR/价格）', 'filter', 0.001, 0.5, 0.001, '高于该值视为极端波动，逆势风险不可控。'),
  numSpec(N, 'entryExtAtr', '入场偏离门槛（ATR）', 'filter', 0.2, 8, 0.1, '|价格 − 均线| ÷ ATR 必须 ≥ 该值才认为超调。'),
  numSpec(N, 'rsiOversold', '超卖阈值（做多）', 'filter', 0, 60, 1, '做多要求 RSI ≤ 该值。'),
  numSpec(N, 'rsiOverbought', '超买阈值（做空）', 'filter', 40, 100, 1, '做空要求 RSI ≥ 该值。'),
  numSpec(N, 'adxMax', 'ADX 上限', 'filter', 0, 100, 1, 'ADX 高于该值时视为强趋势，禁止逆势。0 = 不启用。'),
  boolSpec(N, 'requireReversalCandle', '要求反向企稳 K 线', 'filter', '开启后做多需当根收阳且收在当根上半部，做空相反。'),
  boolSpec(N, 'longOnly', '仅做多', 'filter', '开启后所有空头信号被拦截。'),
  boolSpec(N, 'shortOnly', '仅做空', 'filter', '开启后所有多头信号被拦截。'),
  numSpec(N, 'entryBandAtr', '市价成交区间半宽（ATR）', 'entry', 0.05, 0.25, 0.05,
    '市价单的 sanity 区间半宽，必须窄于止损距离（stopAtr 最小 0.3），不是挂单价。'),
  numSpec(N, 'stopAtr', '止损距离（ATR）', 'risk', 0.3, 6, 0.1, '初始止损 = max(N×ATR, 最小止损%)。'),
  numSpec(N, 'minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001, '止损绝对下限。'),
  boolSpec(N, 'tpToMean', '止盈回均线', 'protection', '开启时止盈 = 入场时的 4H 均线价（均值回归的自然目标）；关闭时按 tpR/tpAtr。'),
  numSpec(N, 'tpR', '止盈（R 倍数）', 'protection', 0.2, 20, 0.1, 'tpToMean 关闭且未启用 ATR 目标时生效。'),
  numSpec(N, 'tpAtr', '止盈（ATR 倍数）', 'protection', 0.2, 20, 0.1, 'tpToMean 关闭时按 ATR 计目标（优先级低于 tpR 的 R 口径时请自行对齐）。'),
  numSpec(N, 'minNetRr', '最低净盈亏比', 'protection', 0, 10, 0.1, '成本后盈亏比闸门。回归空间太小直接不出手。'),
  numSpec(N, 'maxHoldBars', '最长持仓（4H 根）', 'position', 1, 120, 1,
    '超时按收盘价结算。17 根 ≈ 2.8 天。上限 120 根 = 20 天，与 normalizePlan 的订单校验一致。'),
  numSpec(N, 'maxPositions', '最大并发持仓数', 'position', 1, 200, 1,
    '本策略同时持有的未平仓订单上限（按策略 id 计数；多策略共用资金池时防单策略占满保证金）。'),
  numSpec(N, 'autoMarginPct', '单笔保证金占权益比例', 'position', 0.005, 1, 0.005,
    '每笔保证金 = 当前账户权益 × 该比例（多策略共用一个资金池，按权益复利）。'
    + '由 globalAutomation 优先采用，未提供时回落全局 NOFX_AUTO_MARGIN_PCT。'),
  ...H4_RISK_PARAM_SCHEMA,
  boolSpec(N, 'scoreLeverageEnabled', '高评分杠杆档', 'risk',
    '开启后仅当信号评分达到门槛时，才允许使用 scoreLeverageMax；普通信号仍使用策略杠杆上限。'),
  numSpec(N, 'scoreLeverageThreshold', '高评分门槛', 'risk', 50, 100, 1,
    '信号 score ≥ 该值时进入高评分杠杆档。评分只是排序强度，不代表胜率。'),
  numSpec(N, 'scoreLeverageMax', '高评分杠杆上限', 'risk', 1, 5, 1,
    '高评分信号可用的最大杠杆，仍受系统硬上限、交易所配置和名义敞口约束。'),
  ...H4_EXIT_PARAM_SCHEMA
];

/**
 * 对外暴露的参数 schema。
 *
 * ⚠️ 这里的 default **必须**与 H4_REVERSION_DEFAULTS 逐字段一致：schema 是「策略管理」页
 * 展示默认值、以及「恢复默认」按钮的重置目标。共用件 H4_EXIT_PARAM_SCHEMA / H4_RISK_PARAM_SCHEMA
 * 的默认值是给「突破」策略用的，本策略对 partialTp1R / partialTp2R 有自己的定案值；
 * 若只改 H4_REVERSION_DEFAULTS 而不回填 schema，界面会把参数悄悄重置回旧值。
 * 统一按 H4_REVERSION_DEFAULTS 回填，从机制上杜绝两者的漂移。
 */
export const H4_REVERSION_PARAM_SCHEMA = Object.freeze(REVERSION_PARAM_SCHEMA.map(spec =>
  Object.prototype.hasOwnProperty.call(H4_REVERSION_DEFAULTS, spec.key)
    ? { ...spec, default: H4_REVERSION_DEFAULTS[spec.key] }
    : spec));

/** 解析策略参数（越界回退默认并告警） */
export function resolveH4ReversionParams(overrides) {
  return resolveH4Params(H4_REVERSION_DEFAULTS, H4_REVERSION_PARAM_SCHEMA, overrides, 'h4ReversionAnalysis');
}

/**
 * 4H 均值回归分析。
 * @param {{symbol:string, interval:string, klines:Array, dataAsOf?:string}} market 4H 行情（已收盘）
 * @param {{params?:object, auxMarkets?:object, planInterval?:string}} [ctx]
 */
export function h4ReversionAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  const p = resolveH4ReversionParams(ctx?.params);
  const feed = resolveH4Market(market, ctx);
  const rows = feed.k;

  const pe = {
    meanPeriod: effectivePeriod(p.meanPeriod, rows),
    atrPeriod: effectivePeriod(p.atrPeriod, rows),
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

  // 闸门 1a：参数自洽性（超卖阈值必须低于超买阈值，否则多空条件互相覆盖）
  if (p.rsiOversold >= p.rsiOverbought) {
    return wait(`参数冲突：超卖阈值 ${p.rsiOversold} ≥ 超买阈值 ${p.rsiOverbought}，多空条件互相覆盖，本轮观望。`,
      { paramConflict: 'rsiOversold>=rsiOverbought' });
  }

  const needBars = Math.max(pe.meanPeriod.actual, pe.atrPeriod.actual, pe.rsiPeriod.actual) + 2;
  if (!rows.length || rows.length < needBars) {
    return wait(`4H 数据不足：需要 ${needBars} 根，实际 ${rows.length} 根（实时窗口固定 80 根）。`,
      { dataGap: true, trend: { ...windowInfo, dataGap: true } });
  }
  if (!rows.every(isFiniteCandle)) return wait('4H K 线存在坏打印（OHLC 非法），本轮观望。');

  const close = rows.map(r => r.close);
  const last = rows.at(-1);
  const price = last.close;

  const mean = ema(close, pe.meanPeriod.actual)?.at(-1);
  const atr = atrSeries(rows, pe.atrPeriod.actual)?.at(-1);
  const rsiNow = rsi(close, pe.rsiPeriod.actual)?.at(-1);
  const adxNow = skillAdx(rows, pe.adxPeriod.actual)?.adx?.at(-1);
  if (![mean, atr].every(Number.isFinite) || !(atr > 0)) {
    return wait('4H 指标未就绪（EMA/ATR 无效），本轮观望。', { dataGap: true });
  }
  const atrPct = atr / price;
  const extension = (price - mean) / atr;
  const metrics = { price, mean, atr, atrPct, extension, rsi: rsiNow, adx: Number.isFinite(adxNow) ? adxNow : null };

  // 闸门 2：波动率区间
  if (atrPct < p.minAtrPct) return wait(`4H ATR ${(atrPct * 100).toFixed(3)}% 低于下限 ${(p.minAtrPct * 100).toFixed(3)}%（死水行情），回归空间不足。`, { metrics });
  if (atrPct > p.maxAtrPct) return wait(`4H ATR ${(atrPct * 100).toFixed(3)}% 高于上限 ${(p.maxAtrPct * 100).toFixed(3)}%（极端波动），逆势风险不可控。`, { metrics });

  // 闸门 3：趋势强度（强趋势中禁止逆势）
  if (p.adxMax > 0 && Number.isFinite(adxNow) && adxNow > p.adxMax) {
    return wait(`ADX ${adxNow.toFixed(1)} 高于上限 ${p.adxMax}（强趋势市），禁止逆势入场。`, { metrics });
  }

  // 闸门 4+5：偏离 + RSI 双确认
  const longSetup = extension <= -p.entryExtAtr && (!Number.isFinite(rsiNow) || rsiNow <= p.rsiOversold);
  const shortSetup = extension >= p.entryExtAtr && (!Number.isFinite(rsiNow) || rsiNow >= p.rsiOverbought);
  if (!longSetup && !shortSetup) {
    const side = extension <= -p.entryExtAtr ? '偏低于均线但 RSI 未到超卖'
      : extension >= p.entryExtAtr ? '偏高于均线但 RSI 未到超买' : '未出现足够偏离';
    return wait(`4H 偏离 ${extension.toFixed(2)}×ATR（门槛 ±${p.entryExtAtr}）、RSI `
      + `${Number.isFinite(rsiNow) ? rsiNow.toFixed(1) : 'NA'}（超卖 ${p.rsiOversold} / 超买 ${p.rsiOverbought}）——${side}，本轮观望。`,
    { metrics });
  }
  const direction = longSetup ? 1 : -1;
  if (direction === 1 && p.shortOnly) return wait('多头信号被 shortOnly 拦截。', { metrics });
  if (direction === -1 && p.longOnly) return wait('空头信号被 longOnly 拦截。', { metrics });

  // 闸门 6：反向企稳 K 线
  const upperWickMid = (last.high + last.low) / 2;
  const reversalOk = direction === 1
    ? (last.close > last.open && last.close >= upperWickMid)
    : (last.close < last.open && last.close <= upperWickMid);
  if (p.requireReversalCandle && !reversalOk) {
    return wait(`偏离与 RSI 已达标（${extension.toFixed(2)}×ATR / RSI ${Number.isFinite(rsiNow) ? rsiNow.toFixed(1) : 'NA'}），`
      + `但 4H 当根未出现${direction === 1 ? '收阳且收在上半部' : '收阴且收在下半部'}的企稳确认，等待反转 K 线。`,
    { metrics });
  }

  // 候选排序分（0~100）。在组装计划之前计算，使评分杠杆与评分本身使用同一个快照；
  // 回测、自动化下单和订单审计都能看到同一 score → leverage 映射。
  const score = Math.round(Math.max(0, Math.min(100,
    10
    + 30 * clamp01((Math.abs(extension) - p.entryExtAtr) / 2)
    + ((direction === 1 ? (p.rsiOversold - (rsiNow ?? p.rsiOversold)) : ((rsiNow ?? p.rsiOverbought) - p.rsiOverbought)) > 0 ? 20 : 5)
    + (reversalOk ? 15 : 5)
    + 15 * (Number.isFinite(adxNow) ? clamp01(1 - adxNow / 50) : 0.5)
    + 10 * clamp01(1 - Math.abs(atrPct - 0.01) / 0.02)
  )));
  const confidence = Math.max(0, Math.min(0.95, score / 100));

  // 计划几何
  const riskUnit = Math.max(p.stopAtr * atr, p.minStopPct * price);
  let takeProfit;
  let targetSource;
  if (p.tpToMean) {
    takeProfit = mean;
    targetSource = `mean=EMA${pe.meanPeriod.actual}`;
  } else if (p.tpAtr > 0 && p.tpR <= 0) {
    takeProfit = price + direction * p.tpAtr * atr;
    targetSource = `tpAtr=${p.tpAtr}`;
  } else {
    takeProfit = price + direction * p.tpR * riskUnit;
    targetSource = `tpR=${p.tpR}`;
  }
  // 目标必须在盈利侧（回均线时若均线已在不利侧，说明判定异常）
  if (direction === 1 ? !(takeProfit > price) : !(takeProfit < price)) {
    return wait(`止盈目标 ${takeProfit.toPrecision(6)} 不在盈利侧（现价 ${price.toPrecision(6)}、均线 ${mean.toPrecision(6)}），本轮观望。`,
      { metrics, targetSource });
  }

  const plan = buildH4Plan({
    direction, refPrice: price, atr, stopAtr: p.stopAtr, minStopPct: p.minStopPct,
    takeProfit, maxHoldBars: p.maxHoldBars, entryBandAtr: p.entryBandAtr,
    exitRules: h4ExitRules(p), params: p, signalScore: score, targetSource,
    extra: { mean, extension, atrPct, trendStrengthScore: score }
  });
  if (!planIsSane(plan, direction)) {
    return wait(`计划几何非法（止损 ${plan.stopLoss.toPrecision(6)} / 区间 [${plan.entryMin.toPrecision(6)}, `
      + `${plan.entryMax.toPrecision(6)}] / 止盈 ${plan.takeProfit.toPrecision(6)}）——`
      + `入场区间半宽 entryBandAtr=${p.entryBandAtr} 必须窄于止损 stopAtr=${p.stopAtr}。`, { metrics });
  }

  // 闸门 7：成本后净盈亏比
  // 用**最不利入场价**估算，与 research.normalizePlan 的入场基准口径一致
  // （否则回测通过、线上被判「成本后盈亏比低于 1」而静默不出单）。
  const worstEntry = direction === 1 ? plan.entryMax : plan.entryMin;
  const rr = costAwareRr({ entry: worstEntry, stopLoss: plan.stopLoss, takeProfit, maxHoldBars: p.maxHoldBars, costs });
  if (!(rr.netRr >= p.minNetRr)) {
    return wait(`成本后净盈亏比 ${rr.netRr.toFixed(2)} 低于门槛 ${p.minNetRr}`
      + `（最不利入场 ${worstEntry.toPrecision(6)}、毛 ${rr.grossRr.toFixed(2)}R、成本 ${(rr.costAbs / worstEntry * 10000).toFixed(1)}bps），本轮观望。`,
    { metrics, rr: { grossRr: rr.grossRr, netRr: rr.netRr } });
  }

  const dirText = direction === 1 ? '多' : '空';
  const reason = `4H 均值回归·${dirText}：收盘 ${price.toPrecision(6)} 偏离 EMA${pe.meanPeriod.actual} `
    + `${mean.toPrecision(6)} 达 ${extension.toFixed(2)}×ATR（门槛 ±${p.entryExtAtr}）；`
    + `RSI${pe.rsiPeriod.actual} ${Number.isFinite(rsiNow) ? rsiNow.toFixed(1) : 'NA'}、`
    + `ADX ${Number.isFinite(adxNow) ? adxNow.toFixed(1) : 'NA'}、ATR ${(atrPct * 100).toFixed(2)}%；`
    + `企稳确认：${reversalOk ? '是' : '否（已按参数关闭该要求时可忽略）'}；`
    + `市价入场≈${price.toPrecision(6)}，止损 ${plan.stopLoss.toPrecision(6)}（${p.stopAtr}×ATR = −${(plan.stopDistancePct * 100).toFixed(2)}%），`
    + `止盈 ${takeProfit.toPrecision(6)}（${targetSource}，毛 ${rr.grossRr.toFixed(2)}R / 成本后 ${rr.netRr.toFixed(2)}R）；`
    + `持仓上限 ${plan.maxHoldBars} 根 4H = ${(plan.maxHoldBars * 4 / 24).toFixed(1)} 天，推荐杠杆 ${plan.recommendedLeverage}x。`
    + `失效条件：4H 收盘跌破 ${plan.stopLoss.toPrecision(6)}（多头）或触发移动止损。`
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
export const h4ReversionReview = h4ProtectionReview;
