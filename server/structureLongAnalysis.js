/**
 * 结构做多引擎（Structure-Long，多周期）
 * —— server/strategies/builtins.js 注册的第 9 个内置策略引擎（engine = 'structure-long'）
 *
 * 来源（2026-09-14）：老板提供的 crypto-long-skill-node.zip —— 与 crypto-short-skill-node
 * 同构的多头镜像：「4H 找 HH+HL 多头趋势 → 回踩 → 1H 找支撑 → 15m 多头 CHOCH+BOS 确认 → 开多」。
 * 移植其 rules.md 的决策顺序与评分权重，适配 NOFX 自动化运行时（与结构做空引擎同一套适配点，
 * 共享指标/结构实现在 server/shared/marketStructure.js）。
 *
 * 决策闸门（照搬 references/rules.md，顺序即优先级）：
 *   1. 数据不足 → WAIT
 *   2. 4H 强下跌趋势（结构 BEARISH 且 EMA20<EMA50）→ WAIT（禁多）
 *   3. 多头评分 < bullishScoreMin（默认 70）→ WAIT
 *   4. 价格高于 4H EMA20 超过 extendedAtr×ATR → WAIT（过度延伸，禁追涨）
 *   5. 入场质量 < entryQualityMin（默认 70）→ WAIT
 *   6. 成本后净盈亏比 < 1 → WAIT（pump-short 同源闸门）
 *   7. 无 15m 多头 CHOCH+BOS 确认 → WAIT
 *   8. 全部通过 → BUY（限价多单挂在 1H 支撑位上方，等回踩入场）
 *
 * 评分权重（结构满分 85）：4H 趋势 20 / 1H 结构 15 / 15m 确认 10 /
 *   支撑汇合或假跌破 10 / EMA 多头排列 10 / 量能（放量收阳）10 / 盈亏比（≥3R +10，≥2R +7）
 * 入场质量（50 基础）：近支撑 +15 / CHOCH +12 / BOS +8 / 假跌破 +10 /
 *   过度延伸 −35 / RSI>70 超买 −20 / ATR 分位 >0.9 高波动 −15
 *
 * ⚠️ 与结构做空（structure-short-v1）相同的适配与纪律：
 *   · 80 根窗口下 EMA200 不可用 → 趋势/排列判定降为 price/EMA20/EMA50 组合；
 *   · funding/OI/BTC 环境自动化不提供 → 三项评分成分剔除（max 100→85）；
 *   · 库内无 takerBuyVolume → 量能成分 = 15m 放量收阳（volumeRatio>1.1 且 close>open）；
 *   · planInterval='15m'，订单止损止盈按 15m 根数结算（96 根 = 24h）；
 *   · RR 闸门 = 项目统一的「成本后净盈亏比 ≥ 1」，目标先满足真实 pivot 最低 2R，再做成本校验。
 *
 * ⚠️ 尚无回测证据：默认不启用，落地为可参数化对照实验；启用前需在 bf90 语料跑真实回测
 *    并 shadow 验证 ≥2 周。做多方向与生产 enhanced-trend-v1 同向，同币种竞争由 priority
 *    仲裁（本策略 85，排在 enhanced 10 之后；同币种已有单时自动跳过）。
 *
 * 参数化约定与注册表一致：默认值只作未传参兜底，策略完整参数由
 * data/strategies.json 读取（前端「策略管理」页）。
 */
import { PAPER_COSTS } from './research.js';
import { marketStructure, summarize, isFiniteCandle, summarizeStructure, selectPivotTarget } from './shared/marketStructure.js';
import { recommendedLeverage } from './localAnalysis.js';
import { STRATEGY_RISK_DEFAULTS, STRATEGY_RISK_PARAM_SCHEMA } from './strategies/commonParams.js';

/** 规则强度说明（写进信号的 risk 字段；⚠️ 尚无回测证据，默认关闭） */
const RISK_NOTE = '结构做多（多周期）：4H 定方向、1H 定位置、15m 定确认，回踩进支撑区才开多，不追涨。'
  + '⚠️ 移植自 crypto-long-skill 规则引擎，尚未在 bf90 语料回测，默认关闭；规则分数是信号强度，不是胜率。';

/** 参数默认值（字段与 STRUCTURE_LONG_PARAM_SCHEMA 一一对应） */
export const STRUCTURE_LONG_DEFAULTS = Object.freeze({
  // 评分/质量闸门（skill 原值 70/70）
  bullishScoreMin: 70,
  entryQualityMin: 70,
  // 过度延伸：价格高于 4H EMA20 超过 N×ATR 禁追涨（skill：2 ATR → WAIT_FOR_PULLBACK）
  extendedAtr: 2,
  // 入场：限价 = 1H 支撑 + N×ATR4h（skill entryZone 上沿 0.25 ATR）
  entryBufAtr: 0.25,
  // 止损：1H 支撑 − N×ATR4h（skill 0.35 ATR）；R 绝对下限兜底成本
  stopBufferAtr: 0.35,
  minStopPct: 0.008,
  // 真实 pivot 目标最低 RR；找不到达标目标直接 HOLD
  minRealRR: 2.0,
  // 持仓约束（15m 根：96 根 = 24h；计划校验上限 120 根）
  maxHoldBars: 96,
  ...STRATEGY_RISK_DEFAULTS
});

const numSpec = (key, label, group, min, max, step, description) =>
  ({ key, label, group, type: 'number', default: STRUCTURE_LONG_DEFAULTS[key], min, max, step, description });

/** 参数模式（不含出场规则 —— 出场规则在 builtins.js 展开 EXIT_PARAM_SCHEMA） */
export const STRUCTURE_LONG_PARAM_SCHEMA = Object.freeze([
  numSpec('bullishScoreMin', '多头评分门槛', 'filter', 40, 90, 1,
    '低于门槛观望。结构满分 85（4H 20 + 1H 15 + 15m 确认 10 + 支撑 10 + EMA 10 + 量能 10 + RR 10），skill 原值 70。'),
  numSpec('entryQualityMin', '入场质量门槛', 'filter', 40, 90, 1,
    '低于门槛视为位置不好（离支撑太远/过度延伸/超买），宁可等回踩。skill 原值 70。'),
  numSpec('extendedAtr', '过度延伸门槛（ATR）', 'filter', 0.5, 5, 0.1,
    '价格高于 4H EMA20 超过 N×ATR 视为涨过头，禁止追涨（skill：2 ATR → WAIT_FOR_PULLBACK）。'),
  numSpec('entryBufAtr', '入场位缓冲（ATR）', 'entry', 0, 2, 0.05,
    '限价 = 1H 支撑 + N×ATR4h。0.25 = skill 原值（回踩进入支撑区上沿即挂多）。'),
  numSpec('minRealRR', '真实目标最低 RR', 'protection', 1, 10, 0.1,
    '使用 1H/4H 已确认摆动高点作为止盈，目标距离不足该 RR 时直接 HOLD。默认 2R。'),
  numSpec('stopBufferAtr', '止损缓冲（ATR）', 'risk', 0, 3, 0.05,
    '止损 = 1H 支撑 − N×ATR4h。0.35 = skill 原值（支撑被有效跌破即逻辑失效）。'),
  numSpec('minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001,
    'R 的绝对下限，兜底成本约束（低于它时止损距离被抬高）。'),
  numSpec('maxHoldBars', '最长持仓（15m 根）', 'position', 10, 120, 1,
    '超时未触发的订单按收盘价结算。96 根 = 24h（计划校验上限 120 根 = 30h）。'),
  ...STRATEGY_RISK_PARAM_SCHEMA
]);

/** 解析策略参数：默认值为底，params 逐字段覆盖（越界回退默认并告警） */
export function resolveStructureLongParams(overrides) {
  const params = { ...STRUCTURE_LONG_DEFAULTS };
  if (!overrides || typeof overrides !== 'object') return params;
  for (const spec of STRUCTURE_LONG_PARAM_SCHEMA) {
    const raw = overrides[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[spec.key] = value;
    else console.warn(`[structureLongAnalysis] 策略参数 ${spec.key}=${raw} 非法（需在 ${spec.min}~${spec.max}），回退默认值 ${spec.default}`);
  }
  return params;
}

/**
 * 结构做多分析：返回与其它引擎同构的信号对象（action: 'BUY' | 'WAIT'）。
 * @param {{symbol:string, interval:string, klines:Array}} market  自动化主周期行情（1m）；
 *   挂单复核路径（reviewPendingOrder）直接传 15m 行情（market.interval === '15m'）
 * @param {object} [ctx]  策略上下文：多周期行情取 ctx.auxMarkets['15m'|'1h'|'4h']
 * @param {{feeBps?:number, slippageBps?:number, fundingBpsPer8h?:number}} [costs]
 */
export function structureLongAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  // 计划周期固定 15m（builtins 声明 planInterval='15m'）：订单与止损止盈按 15m 根数结算。
  const PLAN_TF = '15m';
  const source15 = market?.interval === PLAN_TF ? market : ctx?.auxMarkets?.[PLAN_TF];
  const source1h = ctx?.auxMarkets?.['1h'];
  const source4h = ctx?.auxMarkets?.['4h'];
  const p = resolveStructureLongParams(ctx?.params);
  const rows15 = Array.isArray(source15?.klines) ? source15.klines : [];
  const rows1h = Array.isArray(source1h?.klines) ? source1h.klines : [];
  const rows4h = Array.isArray(source4h?.klines) ? source4h.klines : [];

  const windowInfo = {
    interval: PLAN_TF,
    bars: { '15m': rows15.length, '1h': rows1h.length, '4h': rows4h.length },
    dataAsOf: source15?.dataAsOf || null
  };
  const wait = (reason, extra = {}) => ({
    symbol: market?.symbol, action: 'WAIT', decision: 'HOLD', state: 'HOLD', confidence: 0, reason, risk: RISK_NOTE, plan: null,
    trend: windowInfo, ...extra
  });

  // 闸门 1：数据不足（4H 至少 55 根才够 EMA50 + 摆动结构；1H/15m 至少 30 根）
  if (!source4h || !source1h) {
    return wait('未获取到 1h/4h 辅助行情（needsAux=["15m","1h","4h"] 未就绪），本轮观望。');
  }
  const MIN = { '15m': 30, '1h': 30, '4h': 55 };
  for (const [tf, rows] of [['15m', rows15], ['1h', rows1h], ['4h', rows4h]]) {
    if (rows.length < MIN[tf]) {
      return wait(`结构做多需要至少 ${MIN[tf]} 根已收盘 ${tf} K 线（实时窗口固定 80 根），实际 ${rows.length} 根。`);
    }
  }
  if (!rows15.every(isFiniteCandle) || !rows4h.every(isFiniteCandle) || !rows1h.every(isFiniteCandle)) {
    return wait('K 线存在坏打印（OHLC 非法），本轮观望。');
  }

  const s4 = marketStructure(rows4h), s1 = marketStructure(rows1h), s15 = marketStructure(rows15);
  const i4 = summarize(rows4h);
  const i15 = summarize(rows15);
  if (!(i4.atr > 0) || !(i4.ema20 != null && i4.ema50 != null)) {
    return wait('4H 指标未就绪（ATR/EMA 无效），本轮观望。');
  }
  const last15 = rows15.at(-1);
  const distanceAtr = (i4.price - i4.ema20) / i4.atr;

  // 闸门 2：4H 强下跌趋势禁多（rules.md 第 2 关；EMA200 不可用 → 结构+均线组合判定）
  if (s4.trend === 'BEARISH' && i4.ema20 < i4.ema50) {
    return wait(`4H 强下跌趋势（结构 BEARISH + EMA20<EMA50），禁多。`, { structure: summarizeStructure(s4, s1, s15) });
  }

  // 近支撑（skill：1H 支撑在 1.2×ATR4h 内）与假跌破
  const nearSupport = s1.support != null && Math.abs(i4.price - s1.support) <= 1.2 * i4.atr;
  // 量能（适配：库内无 takerBuyVolume → 15m 放量收阳）
  const volBullish = last15.close > last15.open && i15.volumeRatio > 1.1;

  // 计划：入场/止损先定，再从 1H/4H 真实已确认 pivot 选择止盈。
  const support = s1.support ?? s4.support ?? last15.close - 0.8 * i4.atr;
  const entryLimit = Math.min(last15.close, support + p.entryBufAtr * i4.atr);
  let stopDistance = entryLimit - (support - p.stopBufferAtr * i4.atr);
  stopDistance = Math.max(stopDistance, p.minStopPct * entryLimit);
  const stopLoss = entryLimit - stopDistance;
  const target = selectPivotTarget({ long: true, entry: entryLimit, stopDistance, minRealRR: p.minRealRR,
    structures: [{ interval: '1h', structure: s1 }, { interval: '4h', structure: s4 }] });
  if (!target) {
    return wait(`1H/4H 真实摆动高点不足最低 ${p.minRealRR.toFixed(2)}R，直接 HOLD，不使用虚构固定止盈。`,
      { structure: summarizeStructure(s4, s1, s15), entryLimit, stopLoss, minRealRR: p.minRealRR });
  }
  const takeProfit = target.price;
  const grossRR = target.rr;

  // 成本后盈亏比（与 research.normalizePlan 判定同源；成本 = 2×(费+滑) + 资金费）
  const hours = p.maxHoldBars * 15 / 60;
  const costPct = (2 * (costs.feeBps + costs.slippageBps) + costs.fundingBpsPer8h * hours / 8) / 10000;
  const costAbs = entryLimit * costPct;
  const netReward = (takeProfit - entryLimit) - costAbs;
  const netRisk = stopDistance + costAbs;
  const netRewardRisk = netRisk > 0 ? netReward / netRisk : 0;

  // 评分（结构满分 85；衍生品/BTC 成分不可用已剔除）
  let score = 0;
  const reasons = [];
  if (s4.trend === 'BULLISH') { score += 20; reasons.push('4H 形成 HH+HL'); }
  if (s1.trend === 'BULLISH') { score += 15; reasons.push('1H 多头结构'); }
  if (s15.chochBullish && s15.bosBullish) { score += 10; reasons.push('15m CHOCH+BOS 确认'); }
  if (nearSupport || s15.failedBreakdown) { score += 10; reasons.push(nearSupport ? '价格接近 1H 支撑' : '15m 假跌破'); }
  if (i4.price > i4.ema20 && i4.ema20 > i4.ema50) { score += 10; reasons.push('4H EMA 多头排列'); }
  if (volBullish) { score += 10; reasons.push(`15m 放量收阳（量比 ${i15.volumeRatio.toFixed(2)}）`); }
  if (grossRR >= 3) { score += 10; } else if (grossRR >= 2) { score += 7; }
  score = Math.max(0, Math.min(85, score));

  // 入场质量（skill 口径）
  let entryQuality = 50;
  if (nearSupport) entryQuality += 15;
  if (s15.chochBullish) entryQuality += 12;
  if (s15.bosBullish) entryQuality += 8;
  if (s15.failedBreakdown) entryQuality += 10;
  // 过度延伸惩罚跟随 extendedAtr 参数（与闸门 4 同源；此前硬编码 2，调参时两处会分裂）
  if (distanceAtr > p.extendedAtr) entryQuality -= 35;
  if (i4.rsi != null && i4.rsi > 70) entryQuality -= 20;
  if (i4.atrPct > 0.9) entryQuality -= 15;
  entryQuality = Math.max(0, Math.min(100, entryQuality));

  // 闸门 3：评分不足
  if (score < p.bullishScoreMin) {
    return wait(`多头评分 ${score} 低于门槛 ${p.bullishScoreMin}（${reasons.length ? reasons.join('；') : '无合格结构成分'}）。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }
  // 闸门 4：过度延伸禁追涨（skill：> 2 ATR 高于 EMA20 → WAIT_FOR_PULLBACK）
  if (distanceAtr >= p.extendedAtr) {
    return wait(`价格高于 4H EMA20 达 ${distanceAtr.toFixed(2)}×ATR（≥ ${p.extendedAtr}），涨势过度延伸，禁止追涨，等回踩。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }
  // 闸门 5：入场质量不足
  if (entryQuality < p.entryQualityMin) {
    return wait(`入场质量 ${entryQuality} 低于门槛 ${p.entryQualityMin}，当前位置不适合开多。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }
  // 闸门 6：成本后净盈亏比
  if (!(netRewardRisk >= 1)) {
    const minTpR = stopDistance > 0 ? 1 + 2 * costAbs / stopDistance : Infinity;
    return wait(`成本后盈亏比 ${netRewardRisk.toFixed(2)} 低于 1（真实目标 ${grossRR.toFixed(2)}R 太近，`
      + `当前止损距离 ${(stopDistance / entryLimit * 100).toFixed(3)}% 下需 ≥ ${minTpR.toFixed(2)}R），不出手。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality, targetSource: target.source, targetPivotIndex: target.pivotIndex, realRR: grossRR });
  }
  // 闸门 7：15m 确认（rules.md 最后一关：多头 CHOCH + BOS）
  if (!(s15.chochBullish && s15.bosBullish)) {
    return wait(`方向与位置合格（评分 ${score} / 质量 ${entryQuality}），但缺 15m 多头 CHOCH+BOS 转强确认，等待确认后再开多。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }

  const confidence = Math.max(0, Math.min(0.95, score / 100));
  const leverage = recommendedLeverage({ entryLimit, stopLoss }, 'OPEN_LONG', p);
  const marginRiskPct = leverage * stopDistance / entryLimit;
  const reason = `结构做多（4H→1H→15m）：${reasons.join('；')}；`
    + `评分 ${score}/85、入场质量 ${entryQuality}/100、4H RSI ${i4.rsi == null ? 'NA' : i4.rsi.toFixed(1)}、`
    + `距 4H EMA20 ${distanceAtr.toFixed(2)}×ATR；`
    + `在 1H 支撑 ${support.toPrecision(6)} 上方 ${p.entryBufAtr}ATR 挂限价多 ${entryLimit.toPrecision(6)} 等回踩，`
    + `止损 ${stopLoss.toPrecision(6)}（−${p.stopBufferAtr}ATR / R=${(stopDistance / entryLimit * 100).toFixed(3)}%），`
    + `止盈 ${takeProfit.toPrecision(6)}（真实 ${grossRR.toFixed(2)}R，来源 ${target.source}#${target.pivotIndex}，成本后净盈亏比 ${netRewardRisk.toFixed(2)}），`
    + `15m 持仓上限 ${p.maxHoldBars} 根 = ${(p.maxHoldBars * 15 / 60).toFixed(0)}h。`
    + `失效条件：15m 收盘有效跌破 ${stopLoss.toPrecision(6)}。`;

  return {
    symbol: market.symbol,
    action: 'BUY',
    decision: 'LONG_ALLOWED',
    state: 'ALLOWED',
    confidence,
    reason,
    risk: RISK_NOTE,
    score,
    entryQuality,
    structure: summarizeStructure(s4, s1, s15),
    trend: windowInfo,
    plan: {
      entryMin: entryLimit - 0.15 * i4.atr,
      entryMax: entryLimit + 0.15 * i4.atr,
      entryLimit,
      stopLoss,
      takeProfit,
      targetSource: target.source,
      targetPivotIndex: target.pivotIndex,
      targetPivotTime: target.pivotTime,
      realRR: target.rr,
      riskUnit: stopDistance,
      maxHoldBars: Math.round(p.maxHoldBars),
      recommendedLeverage: leverage,
      marginRiskPct
    }
  };
}
