/**
 * 内置策略定义（多策略体系的实例）
 *
 * 每个策略把「引擎实现」包成一个带参数模式的实体：
 *   analyze(market, ctx)  —— 生成信号（参数由 ctx.params 注入）
 *   review(order, market, ctx) —— 持仓复核（出场规则从 order.plan.exitRules 读，天然按订单归属）
 *
 * ⚠️ 新增策略只需在本文件追加一个 defineStrategy 调用（或用同样的方式在别处注册），
 *    API /data/strategies、前端策略管理页、自动化分派都会自动识别，无需改动其它代码。
 */
import { defineStrategy } from './registry.js';
import { enhancedAnalysis, enhancedProtectionReview, ENHANCED_PARAM_SCHEMA, ENHANCED_DEFAULTS, buildExitRules } from '../enhancedAnalysis.js';
import { localProtectionReview } from '../shared/protectionReview.js';
import { structureShortAnalysis, STRUCTURE_SHORT_PARAM_SCHEMA } from '../structureShortAnalysis.js';
import { structureLongAnalysis, STRUCTURE_LONG_PARAM_SCHEMA } from '../structureLongAnalysis.js';

/** 出场规则参数（移动止损 / 智能退出 / 分批止盈）—— 各策略共用同一套，避免重复定义。 */
const EXIT_PARAM_SCHEMA = ENHANCED_PARAM_SCHEMA.filter(spec => spec.group === 'exit');

/**
 * 「原生不带 exitRules 的策略」专用出场规则参数：与 enhanced 同一套，唯一差别是
 * 「智能退出」默认关闭。这类策略自带形态失效止损（冲高高点上方 / 阻力上方 / 支撑下方），
 * 均线失守类主动离场与「等回踩入场」的前提冲突 —— 刚挂单时价格本就在均线下方/上方，
 * 逐根判定会把单砍掉。需要时可在「策略管理」页单独勾上，不影响其它策略。
 * （沿用历史命名 PUMP_SHORT_EXIT_PARAM_SCHEMA：最初为冲高回落空引入，现由结构多空共用。）
 */
const PUMP_SHORT_EXIT_PARAM_SCHEMA = EXIT_PARAM_SCHEMA.map(spec => spec.key === 'smartExitEnabled'
  ? { ...spec, default: false, description: '均线失守 / RSI 极值 / MACD 背离三条主动离场规则的总开关。本策略自带形态失效止损，主动离场默认关闭；需要时可在策略参数里单独勾上。' }
  : spec);

/**
 * 策略 1：增强趋势（当前生产策略）
 * 引擎 enhancedAnalysis：MA/MACD/RSI/布林/量能 + Ichimoku/DMI/Supertrend/OBV 综合评分，
 * 限价回调挂单入场，R 口径主止盈 + 分批止盈 + 逐根均线失守智能退出。
 */
defineStrategy({
  id: 'enhanced-trend-v1',
  name: '增强趋势 v1',
  description: '多指标综合评分（均线/MACD/RSI/布林/量能 + Ichimoku/DMI/Supertrend/OBV），限价回调挂单入场，R 口径止盈止损 + 分批止盈 + 均线失守智能退出。当前生产策略。',
  engine: 'enhanced',
  modelId: 'enhanced-rules-v1',
  priority: 10,
  paramSchema: ENHANCED_PARAM_SCHEMA,
  analyze: (market, ctx = {}) => enhancedAnalysis(market, ctx.params),
  review: (order, market, ctx = {}) => enhancedProtectionReview(order, market, ctx)
});

/**
 * 策略 2：结构做空（默认关闭 —— 尚无回测证据，落地为对照实验）
 * 引擎 structureShortAnalysis：移植 crypto-short-skill-node（老板 2026-09-14 提供）的多周期
 * 做空规则 —— 4H 定方向（LH+LL 空头结构 + EMA 空头排列）、1H 定位置（阻力区反弹入场）、
 * 15m 定确认（CHOCH+BOS 转弱），评分 ≥70 + 入场质量 ≥70 + 成本后净盈亏比 ≥1 才出手。
 *
 * ⚠️ 默认不启用：按「先证伪再落地」纪律，启用前需在 bf90 语料（1m 执行 + 派生
 *   15m/1h/4h 决策序列）跑真实回测，并先 shadow 验证 ≥2 周。详见 server/structureShortAnalysis.js 文件头。
 */
defineStrategy({
  id: 'structure-short-v1',
  name: '结构做空 v1（多周期）',
  description: '【15m 计划周期】多周期结构化做空：4H 空头结构（LH+LL+EMA 排列）定方向、1H 阻力区定位置、'
    + '15m CHOCH+BOS 定确认；评分与入场质量双门槛（默认 70/70），反弹进阻力区挂限价空，不追空。'
    + '只做空 —— NOFX_LONG_ONLY 禁空政策的显式白名单例外。'
    + '移植自 crypto-short-skill 规则引擎（适配 80 根窗口与本地数据字段）；'
    + '⚠️ 尚无回测证据，默认关闭，启用前先回测 + shadow 验证。',
  engine: 'structure-short',
  modelId: 'structure-short-v1',
  priority: 80,
  // 信号需要三个周期：15m（确认 + 计划周期）、1h（结构/阻力）、4h（趋势/指标）
  needsAux: ['15m', '1h', '4h'],
  // 订单落在 15m 周期：maxHoldBars=96 根 = 24h
  planInterval: '15m',
  paramSchema: [...STRUCTURE_SHORT_PARAM_SCHEMA, ...PUMP_SHORT_EXIT_PARAM_SCHEMA],
  analyze: (market, ctx = {}) => structureShortAnalysis(market, ctx),
  // 本地规则复核：R 口径移动止损阶梯（方向对称，空头取 min 侧）
  // 移动止损规则已经在订单 plan.exitRules 中快照；第三参不是 ctx，而是旧版
  // localProtectionReview 的 trailingRule 兼容参数，不能把整个 ctx 误传进去。
  review: (order, market) => localProtectionReview(order, market),
  // 引擎原生不带 exitRules，这里补一份「该策略的」出场规则（智能退出默认关闭）
  decoratePlan: (plan, ctx = {}) => ({
    ...plan,
    exitRules: buildExitRules({ ...ENHANCED_DEFAULTS, ...(ctx.params || {}) })
  })
});

/**
 * 策略 9：结构做多（默认关闭 —— 尚无回测证据，落地为对照实验）
 * 引擎 structureLongAnalysis：移植 crypto-long-skill-node（老板 2026-09-14 提供，与
 * 结构做空同源的 多头镜像）—— 4H 定方向（HH+HL 多头结构 + EMA 多头排列）、1H 支撑区
 * 定位置（回踩入场）、15m 多头 CHOCH+BOS 定确认；评分 ≥70 + 入场质量 ≥70 +
 * 成本后净盈亏比 ≥1 才出手。与生产 enhanced-trend-v1 同向，同币种竞争由 priority
 * 仲裁（本策略 85 排在其后）。
 * ⚠️ 默认不启用：启用前需在 bf90 语料跑真实回测 + shadow 验证 ≥2 周。
 *   详见 server/structureLongAnalysis.js 文件头。
 */
defineStrategy({
  id: 'structure-long-v1',
  name: '结构做多 v1（多周期）',
  description: '【15m 计划周期】多周期结构化做多：4H 多头结构（HH+HL+EMA 排列）定方向、1H 支撑区定位置、'
    + '15m CHOCH+BOS 定确认；评分与入场质量双门槛（默认 70/70），回踩进支撑区挂限价多，不追涨。'
    + '与 enhanced-trend-v1 同向，同币种竞争按优先级排在其后。'
    + '移植自 crypto-long-skill 规则引擎（适配 80 根窗口与本地数据字段）；'
    + '⚠️ 尚无回测证据，默认关闭，启用前先回测 + shadow 验证。',
  engine: 'structure-long',
  modelId: 'structure-long-v1',
  priority: 85,
  // 信号需要三个周期：15m（确认 + 计划周期）、1h（结构/支撑）、4h（趋势/指标）
  needsAux: ['15m', '1h', '4h'],
  // 订单落在 15m 周期：maxHoldBars=96 根 = 24h
  planInterval: '15m',
  paramSchema: [...STRUCTURE_LONG_PARAM_SCHEMA, ...PUMP_SHORT_EXIT_PARAM_SCHEMA],
  analyze: (market, ctx = {}) => structureLongAnalysis(market, ctx),
  // 本地规则复核：R 口径移动止损阶梯（方向对称，多头取 max 侧）
  // 同上：复核必须按订单快照恢复规则，不能用运行时 ctx 覆盖订单归属。
  review: (order, market) => localProtectionReview(order, market),
  // 引擎原生不带 exitRules，这里补一份「该策略的」出场规则（智能退出默认关闭）
  decoratePlan: (plan, ctx = {}) => ({
    ...plan,
    exitRules: buildExitRules({ ...ENHANCED_DEFAULTS, ...(ctx.params || {}) })
  })
});

/**
 * 引擎 → 默认策略映射（用于首次运行时把既有 config.analysis.engine 平移为启用集）
 *
 * ⚠️ 历史下线记录：`local`（本地多周期 v1）2026-09-12 下线；`super`/`ai`/`pin`/
 *    `pump-short` 注册策略 2026-09-14 应老板要求从注册表移除（引擎文件保留：
 *    回测脚本与存量订单的 strategy_version 映射仍需引用）。这些引擎的旧配置
 *    统一回落到 enhanced-trend-v1（runtime.defaultEnabled 的兜底行为）。
 */
export const ENGINE_DEFAULT_STRATEGY = Object.freeze({
  enhanced: 'enhanced-trend-v1'
});
