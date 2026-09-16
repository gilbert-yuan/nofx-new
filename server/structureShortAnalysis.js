/**
 * 结构做空引擎（Structure-Short，多周期）
 * —— server/strategies/builtins.js 注册的第 8 个内置策略引擎（engine = 'structure-short'）
 *
 * 来源（2026-09-14）：老板提供的 crypto-short-skill-node.zip（Binance U 本位永续的
 * 「4H 找空头趋势 → 等反弹 → 1H 找压力 → 15m 确认转弱 → 再开空」确定性规则引擎）。
 * 移植其 rules.md 的决策顺序与评分权重，适配 NOFX 自动化运行时（见下方「适配点」）。
 *
 * 决策闸门（照搬 references/rules.md，顺序即优先级）：
 *   1. 数据不足 → WAIT
 *   2. 4H 强上涨趋势（结构 BULLISH 且 EMA20>EMA50）→ WAIT（禁空）
 *   3. 空头评分 < bearishScoreMin（默认 70）→ WAIT
 *   4. 价格低于 4H EMA20 超过 extendedAtr×ATR → WAIT（过度延伸，禁追空）
 *   5. 入场质量 < entryQualityMin（默认 70）→ WAIT
 *   6. 成本后净盈亏比 < 1 → WAIT（pump-short 同源闸门）
 *   7. 无 15m CHOCH+BOS 确认 → WAIT
 *   8. 全部通过 → SELL（限价空单挂在 1H 阻力位下方，等反弹入场）
 *
 * 评分权重（照搬 rules.md「Score weights」，结构满分 85）：
 *   4H 趋势 20 / 1H 结构 15 / 15m 确认 10 / 阻力汇合或假突破 10 / EMA 空头排列 10 /
 *   量能 10 / 盈亏比（≥3R +10，≥2R +7）
 *
 * 入场质量（50 基础）：近阻力 +15 / CHOCH +12 / BOS +8 / 假突破 +10 /
 *   过度延伸 −35 / RSI<30 超卖 −20 / ATR 分位 >0.9 高波动 −15
 *
 * 当前正式入口已与 SKILL 规则保持确定性一致：
 *   1. 决策窗口为 4H/1H/15m=500 根、5m=300 根，EMA200 与多周期结构完整可用。
 *   2. 只使用 K 线结构、均线、ATR、RSI、量能和多周期确认，不依赖衍生环境或 BTC 外部环境。
 *   3. 评分、延伸过滤、RR≥2 及 15m CHOCH+BOS 按 rules.md 的顺序执行。
 *   4. 计划几何、风险金额、波动降风险、仓位与预估爆仓安全检查统一由
 *      shared/skillStrategy.js 生成。
 *   5. 导出的正式函数调用 shared/skillStructureAnalysis.js，文件内旧实现仅保留作历史兼容参考。
 *
 * ⚠️ 尚无回测证据：按项目纪律（先证伪再落地），本策略**默认不启用**，落地为可参数化的
 *    对照实验；启用前请在 bf90 语料上跑真实回测（1m 执行 + 派生 15m/1h/4h 决策序列），
 *    并先 shadow 验证 ≥2 周。结构做空是趋势跟随形态，与已证伪的「插针回补/4h 冲高回落」
 *    逻辑族不同，但同样必须过成本关。
 *
 * 参数化约定与注册表一致：默认值只作未传参兜底，策略完整参数由
 * data/strategies.json 读取（前端「策略管理」页）。
 */
import { PAPER_COSTS } from './research.js';
import { marketStructure, summarize, isFiniteCandle, summarizeStructure, selectPivotTarget } from './shared/marketStructure.js';
import { recommendedLeverage } from './localAnalysis.js';
import { STRATEGY_RISK_DEFAULTS, STRATEGY_RISK_PARAM_SCHEMA } from './strategies/commonParams.js';
import { analyzeSkillStructure } from './shared/skillStructureAnalysis.js';

/** 规则强度说明（写进信号的 risk 字段；⚠️ 尚无回测证据，默认关闭） */
const RISK_NOTE = '结构做空（多周期）：4H 定方向、1H 定位置、15m 定确认，反弹进阻力区才开空，不追空。'
  + '⚠️ 移植自 crypto-short-skill 规则引擎，尚未在 bf90 语料回测，默认关闭；规则分数是信号强度，不是胜率。';

/** 参数默认值（字段与 STRUCTURE_SHORT_PARAM_SCHEMA 一一对应） */
export const STRUCTURE_SHORT_DEFAULTS = Object.freeze({
  // 评分/质量闸门（skill 原值 70/70）
  bearishScoreMin: 70,
  entryQualityMin: 70,
  // 过度延伸：价格低于 4H EMA20 超过 N×ATR 禁追空（skill：2 ATR → WAIT_FOR_PULLBACK）
  extendedAtr: 2,
  // 位置/量能/超卖阈值：从共享引擎中的固定值提取为可回测参数
  nearLevelAtr: 1.2,
  volumeRatioMin: 1.1,
  rsiExtreme: 70,
  highVolatilityPercentile: 0.9,
  // 入场：限价 = 1H 阻力 − N×ATR4h（skill entryZone 下沿 0.25 ATR）
  entryBufAtr: 0.25,
  // 止损：1H 阻力 + N×ATR4h（skill 0.35 ATR）；R 绝对下限兜底成本
  stopBufferAtr: 0.35,
  minStopPct: 0.008,
  // 真实 pivot 目标最低 RR；找不到达标目标直接 HOLD
  minRealRR: 2.0,
  riskPerTrade: 0.01,
  maxDailyLoss: 0.03,
  extremeAtr: 3,
  defaultLeverage: 5,
  strictSkillData: false,
  requireFiveMinute: false,
  // 持仓约束（15m 根：96 根 = 24h；计划校验上限 120 根）
  maxHoldBars: 96,
  ...STRATEGY_RISK_DEFAULTS,
  // SKILL defaults are independent from legacy global environment overrides.
  maxLeverage: 5,
  riskBudgetPct: 0.1
});

const numSpec = (key, label, group, min, max, step, description) =>
  ({ key, label, group, type: 'number', default: STRUCTURE_SHORT_DEFAULTS[key], min, max, step, description });
const boolSpec = (key, label, group, description) =>
  ({ key, label, group, type: 'boolean', default: STRUCTURE_SHORT_DEFAULTS[key], description });
const STRUCTURE_RISK_PARAM_SCHEMA = STRATEGY_RISK_PARAM_SCHEMA.map(spec => ({
  ...spec, default: spec.key === 'maxLeverage' ? 5 : 0.1
}));

/** 参数模式（不含出场规则 —— 出场规则在 builtins.js 展开 EXIT_PARAM_SCHEMA） */
export const STRUCTURE_SHORT_PARAM_SCHEMA = Object.freeze([
  numSpec('bearishScoreMin', '空头评分门槛', 'filter', 40, 90, 1,
    '低于门槛观望。结构满分 85（4H 20 + 1H 15 + 15m 确认 10 + 阻力 10 + EMA 10 + 量能 10 + RR 10），skill 原值 70。'),
  numSpec('entryQualityMin', '入场质量门槛', 'filter', 40, 90, 1,
    '低于门槛视为位置不好（离阻力太远/过度延伸/超卖），宁可等反弹。skill 原值 70。'),
  numSpec('extendedAtr', '过度延伸门槛（ATR）', 'filter', 0.5, 5, 0.1,
    '价格低于 4H EMA20 超过 N×ATR 视为跌过头，禁止追空（skill：2 ATR → WAIT_FOR_PULLBACK）。'),
  numSpec('nearLevelAtr', '支撑/阻力距离（ATR）', 'filter', 0, 5, 0.1,
    '4H 价格距离 1H 支撑/阻力不超过 N×ATR 时计入位置共振。'),
  numSpec('volumeRatioMin', '最低量比', 'filter', 0, 5, 0.05,
    '4H 最近量能相对基准量能达到该倍数才计入放量确认。'),
  numSpec('rsiExtreme', 'RSI 极值门槛', 'filter', 50, 100, 1,
    '多头高于该值、空头低于其对称值时扣减入场质量。'),
  numSpec('highVolatilityPercentile', '高波动分位阈值', 'filter', 0.5, 1, 0.01,
    'ATR 分位超过该值时进入高波动状态并扣减入场质量。'),
  numSpec('entryBufAtr', '入场位缓冲（ATR）', 'entry', 0, 2, 0.05,
    '限价 = 1H 阻力 − N×ATR4h。0.25 = skill 原值（反弹进入阻力区下沿即挂空）。'),
  numSpec('minRealRR', '真实目标最低 RR', 'protection', 1, 10, 0.1,
    '使用 1H/4H 已确认摆动低点作为止盈，目标距离不足该 RR 时直接 HOLD。默认 2R。'),
  numSpec('stopBufferAtr', '止损缓冲（ATR）', 'risk', 0, 3, 0.05,
    '止损 = 1H 阻力 + N×ATR4h。0.35 = skill 原值（阻力被有效突破即逻辑失效）。'),
  numSpec('minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001,
    'R 的绝对下限，兜底成本约束（低于它时止损距离被抬高）。'),
  numSpec('maxHoldBars', '最长持仓（15m 根）', 'position', 10, 120, 1,
    '超时未触发的订单按收盘价结算。96 根 = 24h（计划校验上限 120 根 = 30h）。'),
  numSpec('riskPerTrade', '单笔风险比例', 'risk', 0.001, 0.02, 0.001,
    '按账户权益 × 风险比例计算止损允许亏损，SKILL 默认 1%。'),
  numSpec('maxDailyLoss', '每日亏损上限', 'risk', 0.005, 0.2, 0.005,
    '达到账户权益该比例的当日已实现亏损后停止新开仓，SKILL 默认 3%。'),
  numSpec('extremeAtr', '极端波动 ATR 门槛', 'filter', 1, 6, 0.1,
    '为后续策略扩展保留的极端波动门槛，SKILL 默认 3 ATR。'),
  numSpec('defaultLeverage', '默认杠杆', 'risk', 1, 20, 1,
    'SKILL 风险计划的默认杠杆；下单仍受系统全局硬上限约束。'),
  boolSpec('strictSkillData', '严格数据完整性', 'filter',
    '启用后要求更长的多周期 K 线；不再检查 BTC、衍生品或 taker 环境数据。'),
  boolSpec('requireFiveMinute', '强制 5m 数据', 'filter',
    '启用后额外要求 5m 历史；原始 SKILL 会加载但默认不消费 5m。'),
  ...STRUCTURE_RISK_PARAM_SCHEMA
]);

/** 解析策略参数：默认值为底，params 逐字段覆盖（越界回退默认并告警） */
export function resolveStructureShortParams(overrides) {
  const params = { ...STRUCTURE_SHORT_DEFAULTS };
  if (!overrides || typeof overrides !== 'object') return params;
  for (const spec of STRUCTURE_SHORT_PARAM_SCHEMA) {
    const raw = overrides[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (spec.type === 'boolean') {
      if (typeof raw === 'boolean') params[spec.key] = raw;
      else if (/^(true|1|yes)$/i.test(String(raw).trim())) params[spec.key] = true;
      else if (/^(false|0|no)$/i.test(String(raw).trim())) params[spec.key] = false;
      else console.warn(`[structureShortAnalysis] 策略参数 ${spec.key}=${raw} 非法，回退默认值 ${spec.default}`);
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[spec.key] = value;
    else console.warn(`[structureShortAnalysis] 策略参数 ${spec.key}=${raw} 非法（需在 ${spec.min}~${spec.max}），回退默认值 ${spec.default}`);
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* 指标与结构：已抽至 shared/marketStructure.js（与结构做多引擎共用）      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 分析入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 结构做空分析：返回与其它引擎同构的信号对象（action: 'SELL' | 'WAIT'）。
 * @param {{symbol:string, interval:string, klines:Array}} market  自动化主周期行情（1m）；
 *   挂单复核路径（reviewPendingOrder）直接传 15m 行情（market.interval === '15m'）
 * @param {object} [ctx]  策略上下文：多周期行情取 ctx.auxMarkets['15m'|'1h'|'4h']
 * @param {{feeBps?:number, slippageBps?:number, fundingBpsPer8h?:number}} [costs]
 */
function legacyStructureShortAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  // 计划周期固定 15m（builtins 声明 planInterval='15m'）：订单与止损止盈按 15m 根数结算。
  const PLAN_TF = '15m';
  const source15 = market?.interval === PLAN_TF ? market : ctx?.auxMarkets?.[PLAN_TF];
  const source1h = ctx?.auxMarkets?.['1h'];
  const source4h = ctx?.auxMarkets?.['4h'];
  const p = resolveStructureShortParams(ctx?.params);
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

  // 闸门 1：紧凑 4H 模式最低 10 根；EMA50/EMA200 仅在较长窗口时参与评分。
  if (!source4h || !source1h) {
    return wait('未获取到 1h/4h 辅助行情（needsAux=["15m","1h","4h"] 未就绪），本轮观望。');
  }
  const MIN = { '15m': 30, '1h': 30, '4h': 10 };
  for (const [tf, rows] of [['15m', rows15], ['1h', rows1h], ['4h', rows4h]]) {
    if (rows.length < MIN[tf]) {
      return wait(`结构做空需要至少 ${MIN[tf]} 根已收盘 ${tf} K 线（实时窗口固定 80 根），实际 ${rows.length} 根。`);
    }
  }
  if (!rows15.every(isFiniteCandle) || !rows1h.every(isFiniteCandle) || !rows4h.every(isFiniteCandle)) {
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

  // 闸门 2：4H 强上涨趋势禁空（rules.md 第 2 关；EMA200 不可用 → 结构+均线组合判定）
  if (s4.trend === 'BULLISH' && i4.ema20 > i4.ema50) {
    return wait(`4H 强上涨趋势（结构 BULLISH + EMA20>EMA50），禁空。`, { structure: summarizeStructure(s4, s1, s15) });
  }

  // 近阻力（skill：1H 阻力在 1.2×ATR4h 内）与假突破
  const nearResistance = s1.resistance != null && Math.abs(i4.price - s1.resistance) <= 1.2 * i4.atr;
  // 纯 K 线量能：15m 放量收阴
  const volBearish = last15.close < last15.open && i15.volumeRatio > 1.1;

  // 计划：入场/止损先定，再从 1H/4H 真实已确认 pivot 选择止盈。
  const resistance = s1.resistance ?? s4.resistance ?? last15.close + 0.8 * i4.atr;
  const entryLimit = Math.max(last15.close, resistance - p.entryBufAtr * i4.atr);
  let stopDistance = (resistance + p.stopBufferAtr * i4.atr) - entryLimit;
  stopDistance = Math.max(stopDistance, p.minStopPct * entryLimit);
  const stopLoss = entryLimit + stopDistance;
  const target = selectPivotTarget({ long: false, entry: entryLimit, stopDistance, minRealRR: p.minRealRR,
    structures: [{ interval: '1h', structure: s1 }, { interval: '4h', structure: s4 }] });
  if (!target) {
    return wait(`1H/4H 真实摆动低点不足最低 ${p.minRealRR.toFixed(2)}R，直接 HOLD，不使用虚构固定止盈。`,
      { structure: summarizeStructure(s4, s1, s15), entryLimit, stopLoss, minRealRR: p.minRealRR });
  }
  const takeProfit = target.price;
  const grossRR = target.rr;

  // 成本后盈亏比（与 research.normalizePlan 判定同源；成本 = 2×(费+滑) + 资金费）
  const hours = p.maxHoldBars * 15 / 60;
  const costPct = (2 * (costs.feeBps + costs.slippageBps) + costs.fundingBpsPer8h * hours / 8) / 10000;
  const costAbs = entryLimit * costPct;
  const netReward = (entryLimit - takeProfit) - costAbs;
  const netRisk = stopDistance + costAbs;
  const netRewardRisk = netRisk > 0 ? netReward / netRisk : 0;

  // 评分（结构满分 85；衍生品/BTC 成分不可用已剔除，见文件头适配点 2）
  let score = 0;
  const reasons = [];
  if (s4.trend === 'BEARISH') { score += 20; reasons.push('4H 形成 LH+LL'); }
  if (s1.trend === 'BEARISH') { score += 15; reasons.push('1H 空头结构'); }
  if (s15.chochBearish && s15.bosBearish) { score += 10; reasons.push('15m CHOCH+BOS 确认'); }
  if (nearResistance || s15.failedBreakout) { score += 10; reasons.push(nearResistance ? '价格接近 1H 阻力' : '15m 假突破'); }
  if (i4.price < i4.ema20 && i4.ema20 < i4.ema50) { score += 10; reasons.push('4H EMA 空头排列'); }
  if (volBearish) { score += 10; reasons.push(`15m 放量收阴（量比 ${i15.volumeRatio.toFixed(2)}）`); }
  if (grossRR >= 3) { score += 10; } else if (grossRR >= 2) { score += 7; }
  score = Math.max(0, Math.min(85, score));

  // 入场质量（skill 口径）
  let entryQuality = 50;
  if (nearResistance) entryQuality += 15;
  if (s15.chochBearish) entryQuality += 12;
  if (s15.bosBearish) entryQuality += 8;
  if (s15.failedBreakout) entryQuality += 10;
  // 过度延伸惩罚跟随 extendedAtr 参数（与闸门 4 同源；此前硬编码 -2，调参时两处会分裂）
  if (distanceAtr < -p.extendedAtr) entryQuality -= 35;
  if (i4.rsi != null && i4.rsi < 30) entryQuality -= 20;
  if (i4.atrPct > 0.9) entryQuality -= 15;
  entryQuality = Math.max(0, Math.min(100, entryQuality));

  // 闸门 3：评分不足
  if (score < p.bearishScoreMin) {
    return wait(`空头评分 ${score} 低于门槛 ${p.bearishScoreMin}（${reasons.length ? reasons.join('；') : '无合格结构成分'}）。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }
  // 闸门 4：过度延伸禁追空（skill：> 2 ATR 低于 EMA20 → WAIT_FOR_PULLBACK）
  if (distanceAtr <= -p.extendedAtr) {
    return wait(`价格低于 4H EMA20 达 ${Math.abs(distanceAtr).toFixed(2)}×ATR（≥ ${p.extendedAtr}），跌势过度延伸，禁止追空，等反弹。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }
  // 闸门 5：入场质量不足
  if (entryQuality < p.entryQualityMin) {
    return wait(`入场质量 ${entryQuality} 低于门槛 ${p.entryQualityMin}，当前位置不适合开空。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }
  // 闸门 6：成本后净盈亏比
  if (!(netRewardRisk >= 1)) {
    const minTpR = stopDistance > 0 ? 1 + 2 * costAbs / stopDistance : Infinity;
    return wait(`成本后盈亏比 ${netRewardRisk.toFixed(2)} 低于 1（真实目标 ${grossRR.toFixed(2)}R 太近，`
      + `当前止损距离 ${(stopDistance / entryLimit * 100).toFixed(3)}% 下需 ≥ ${minTpR.toFixed(2)}R），不出手。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality, targetSource: target.source, targetPivotIndex: target.pivotIndex, realRR: grossRR });
  }
  // 闸门 7：15m 确认（rules.md 最后一关：CHOCH + BOS）
  if (!(s15.chochBearish && s15.bosBearish)) {
    return wait(`方向与位置合格（评分 ${score} / 质量 ${entryQuality}），但缺 15m CHOCH+BOS 转弱确认，等待确认后再开空。`,
      { structure: summarizeStructure(s4, s1, s15), score, entryQuality });
  }

  const confidence = Math.max(0, Math.min(0.95, score / 100));
  const leverage = recommendedLeverage({ entryLimit, stopLoss }, 'OPEN_SHORT', p);
  const marginRiskPct = leverage * stopDistance / entryLimit;
  const reason = `结构做空（4H→1H→15m）：${reasons.join('；')}；`
    + `评分 ${score}/85、入场质量 ${entryQuality}/100、4H RSI ${i4.rsi == null ? 'NA' : i4.rsi.toFixed(1)}、`
    + `距 4H EMA20 ${distanceAtr.toFixed(2)}×ATR；`
    + `在 1H 阻力 ${resistance.toPrecision(6)} 下方 ${p.entryBufAtr}ATR 挂限价空 ${entryLimit.toPrecision(6)} 等反弹，`
    + `止损 ${stopLoss.toPrecision(6)}（+${p.stopBufferAtr}ATR / R=${(stopDistance / entryLimit * 100).toFixed(3)}%），`
    + `止盈 ${takeProfit.toPrecision(6)}（真实 ${grossRR.toFixed(2)}R，来源 ${target.source}#${target.pivotIndex}，成本后净盈亏比 ${netRewardRisk.toFixed(2)}），`
    + `15m 持仓上限 ${p.maxHoldBars} 根 = ${(p.maxHoldBars * 15 / 60).toFixed(0)}h。`
    + `失效条件：15m 收盘有效突破 ${stopLoss.toPrecision(6)}。`;

  return {
    symbol: market.symbol,
    action: 'SELL',
    decision: 'SHORT_ALLOWED',
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

/** 正式入口：使用与 crypto-short-skill-node 同口径的公共确定性引擎。 */
export function structureShortAnalysis(market, ctx = {}) {
  return analyzeSkillStructure(market, ctx, {
    long: false,
    params: resolveStructureShortParams(ctx?.params)
  });
}
