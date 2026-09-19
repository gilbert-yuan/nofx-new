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
import { h4BreakoutAnalysis, h4BreakoutReview, H4_BREAKOUT_PARAM_SCHEMA } from '../h4BreakoutAnalysis.js';
import { h4ReversionAnalysis, h4ReversionReview, H4_REVERSION_PARAM_SCHEMA } from '../h4ReversionAnalysis.js';
import { yaoCoinAmbushAnalysis, yaoCoinAmbushReview, YAO_AMBUSH_PARAM_SCHEMA } from '../yaoCoinAmbushAnalysis.js';

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
  // 15m 趋势闸门（2026-09-17 上线，t15-e48s96 两阶段验证）：主行情 1m，
  // 15m 决策窗口由 needsAux 提供 → ctx.auxMarkets['15m']。闸门 fail-closed：
  // 15m 数据缺失/不足时该币种本轮观望（engine 内 trend15Enabled 控制，见策略参数）。
  needsAux: ['15m'],
  marketWindows: { '15m': 200 },
  paramSchema: ENHANCED_PARAM_SCHEMA,
  // 第三参透传整个 ctx（含 auxMarkets['15m']）：仅当策略参数 trend15Enabled=true 时
  // 引擎才会读它（15m 趋势闸门）；默认关闭，行为与改造前逐位一致。
  analyze: (market, ctx = {}) => enhancedAnalysis(market, ctx.params, ctx),
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
  needsAux: ['5m', '15m', '1h', '4h'],
  marketWindow: 500,
  marketWindows: { '5m': 300, '15m': 500, '1h': 500, '4h': 500 },
  // 仅保留 K 线数据要求；不配置 derivatives / btc，避免衍生品环境判断链路。
  marketContext: { requireFiveMinute: false },
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
  needsAux: ['5m', '15m', '1h', '4h'],
  marketWindow: 500,
  marketWindows: { '5m': 300, '15m': 500, '1h': 500, '4h': 500 },
  // 仅保留 K 线数据要求；不配置 derivatives / btc，避免衍生品环境判断链路。
  marketContext: { requireFiveMinute: false },
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
 * 策略 12：妖币埋伏（默认关闭 —— 必须先经过样本外回测与 shadow 验证）
 * 1m 负责启动前动量/量能/波动特征，15m 最近 96 根负责构造不含未来数据的 24h 快照；
 * 只做 PRE_LAUNCH 候选，达到 ±50% 后不追，方向上下双向，参考价以回踩/反弹限价成交。
 */
defineStrategy({
  id: 'yao-coin-ambush-v1',
  name: '妖币埋伏 v1',
  description: '【1m 埋伏】用 1m 动量/量能/波动放大 + 15m 滚动24h快照预测上涨或下跌方向；'
    + '只在达到 ±50% 目标前挂回踩/反弹限价单，给出预测幅度、目标价、止损与分档止盈。'
    + '默认关闭，必须先通过样本外回测与 shadow 验证；规则置信度不是统计学胜率。',
  engine: 'yao-ambush',
  modelId: 'yao-coin-ambush-v1',
  priority: 70,
  needsAux: ['15m'],
  marketWindow: 80,
  marketWindows: { '15m': 150 },
  planInterval: '1m',
  paramSchema: YAO_AMBUSH_PARAM_SCHEMA,
  analyze: (market, ctx = {}) => yaoCoinAmbushAnalysis(market, ctx),
  review: (order, market) => yaoCoinAmbushReview(order, market)
});

/**
 * 策略 10：4H 趋势突破（默认关闭 —— 2026-09-17 新建，三阶段回测见 output/h4-strategy-report.html）
 * 引擎 h4BreakoutAnalysis：**只吃 4H 已收盘 K 线**，不依赖 1H/15m 结构确认。
 * 收盘突破近 N 根通道边界 + 均线同向排列 + 可选 ADX/量能闸门 → **市价**顺势入场，
 * 止损按 ATR、止盈按 R 倍数、移动止损阶梯保护利润。
 *
 * ⚠️ 入场刻意用市价而非限价：本项目实测过限价挂单在粗粒度 K 线上会被「成交当根污染」
 *    系统性虚高（同一批 4H 信号 4h 粒度 +313U / 1m 粒度 −74U）。市价在下一根开盘成交，
 *    与决策 K 线无时间重叠，不存在该偏差。
 * ⚠️ 线上依赖：主行情是 1m，4H 数据由 needsAux=['4h'] 提供（引擎从 ctx.auxMarkets['4h'] 取）。
 */
defineStrategy({
  id: 'h4-trend-breakout-v1',
  name: '4H 趋势突破 v1',
  description: '【4H 决策】4H 收盘有效突破近 N 根唐奇安通道边界 + EMA 快慢线同向排列（可选 ADX/量能确认）'
    + '时，市价顺势开仓（可做多/做空，longOnly·shortOnly 可锁方向）。'
    + '止损 = max(stopAtr×ATR, minStopPct)；止盈按 R 倍数或 ATR 倍数；移动止损阶梯 + 分批止盈。'
    + '与 enhanced-trend-v1（1m 限价回调）方向暴露与入场时机完全不同：不做回调、不等确认 K 线。'
    + '⚠️ 默认关闭；参数与三阶段验证结论见 output/h4-strategy-report.html。',
  engine: 'h4-breakout',
  modelId: 'h4-trend-breakout-v1',
  priority: 60,
  // 主行情是 1m，4H 决策数据必须显式声明为辅助周期，否则线上拿不到 4H 窗口
  needsAux: ['4h'],
  marketWindow: 120,
  marketWindows: { '4h': 300 },
  planInterval: '4h',
  paramSchema: H4_BREAKOUT_PARAM_SCHEMA,
  analyze: (market, ctx = {}) => h4BreakoutAnalysis(market, ctx),
  // 订单自带的 exitRules 快照决定移动止损阶梯；复核直接复用跨引擎单一事实源
  review: (order, market) => h4BreakoutReview(order, market)
});

/**
 * 策略 11：4H 均值回归（默认关闭 —— 2026-09-17 新建，与策略 10 互补假设）
 * 引擎 h4ReversionAnalysis：价格偏离 4H EMA 超 N×ATR 且 RSI 进入极端区、并出现反向企稳 K 线时
 * 市价逆势入场，目标回归 4H 均线。与「4H 趋势突破」在行情适配上是镜像关系，
 * 两者独立回测、独立验证，**不应视为可叠加的组合**。
 */
defineStrategy({
  id: 'h4-mean-reversion-v1',
  name: '4H 均值回归 v1',
  description: '【4H 决策】价格偏离 4H EMA 超过 N×ATR 且 RSI 进入极端区（默认 35/70），'
    + '市价逆势开仓，止盈回到 4H 均线，止损按 ATR。可选 ADX 上限过滤强趋势市。'
    + '09-17 平衡档定案（全量 428 币 × 365d）：maxAtrPct=0.06 低波动分层、minNetRr=1.625、'
    + 'maxHoldBars=17、买入金额=权益×1.5%（autoMarginPct）、并发上限 50（maxPositions）。'
    + '与 4H 趋势突破是互补假设，不应叠加。'
    + '⚠️ 默认关闭，勾选即按平衡档参数运行；验证结论见 output/h4-leverage-optimization-report.html。',
  engine: 'h4-reversion',
  modelId: 'h4-mean-reversion-v1',
  priority: 65,
  needsAux: ['4h'],
  marketWindow: 120,
  marketWindows: { '4h': 300 },
  planInterval: '4h',
  paramSchema: H4_REVERSION_PARAM_SCHEMA,
  analyze: (market, ctx = {}) => h4ReversionAnalysis(market, ctx),
  review: (order, market) => h4ReversionReview(order, market)
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
  enhanced: 'enhanced-trend-v1',
  // 4H 原生引擎（2026-09-17 新增）：仅当配置里的 engine 显式写成它们时才作为默认启用项。
  'h4-breakout': 'h4-trend-breakout-v1',
  'h4-reversion': 'h4-mean-reversion-v1'
});
