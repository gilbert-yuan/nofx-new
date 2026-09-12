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
import { analyzeMarkets, reviewPosition } from '../ai.js';
import { pinFadeAnalysis, PIN_PARAM_SCHEMA } from '../pinFadeAnalysis.js';

/** 出场规则参数（移动止损 / 智能退出 / 分批止盈）—— 各策略共用同一套，避免重复定义。 */
const EXIT_PARAM_SCHEMA = ENHANCED_PARAM_SCHEMA.filter(spec => spec.group === 'exit');

/**
 * 插针回补专用出场规则参数：与 enhanced 同一套，唯一差别是「智能退出」默认关闭。
 * 理由：均线失守（close 跌破 MA20×N ATR）与「逆势接针」的前提直接冲突 ——
 * 插针发生时价格本来就在均线下方，逐根判定会把刚成交的单立刻砍掉。
 * 需要时可在「策略管理」页单独勾上，不影响其它策略。
 */
const PIN_EXIT_PARAM_SCHEMA = EXIT_PARAM_SCHEMA.map(spec => spec.key === 'smartExitEnabled'
  ? { ...spec, default: false, description: '均线失守 / RSI 极值 / MACD 背离三条主动离场规则的总开关。插针回补是逆势均值回归，「均线失守」与前提冲突，故本策略默认关闭。' }
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
  review: (order, market) => enhancedProtectionReview(order, market)
});

/**
 * 策略 2：超级增强（默认关闭）
 * 在增强趋势之上叠加 CoinGecko 市值/流动性、恐惧贪婪指数、AlphaVantage 等外部数据。
 * 需要注入宿主的 superAnalysis 实例（依赖 store），故通过 ctx.deps 提供。
 */
defineStrategy({
  id: 'super-trend-v1',
  name: '超级增强 v1',
  description: '在增强趋势基础上叠加 CoinGecko 市值与流动性、恐惧贪婪指数、AlphaVantage 外部数据做二次过滤与权重调整。需要联网获取行情外数据。',
  engine: 'super',
  modelId: 'super-rules-v1',
  priority: 30,
  paramSchema: ENHANCED_PARAM_SCHEMA,
  prefilter: (symbols, ctx = {}) => ctx.deps?.superAnalysis?.preFilter?.(symbols),
  analyze: (market, ctx = {}) => ctx.deps.superAnalysis.analyze(market, ctx.params),
  review: (order, market, ctx = {}) => ctx.deps.superAnalysis.reviewPosition(order, market)
});

/**
 * 策略 3：AI 模型（仅在配置了可用模型时才应勾选）
 * 交给大模型按提示词出研究结论，成本与不确定性最高，默认不启用。
 */
defineStrategy({
  id: 'ai-model-v1',
  name: 'AI 模型分析',
  description: '把行情与提示词交给已配置的大模型，由模型给出方向、入场区间、止损止盈与理由。需要模型已启用且填好 API Key。',
  engine: 'ai',
  modelId: 'ai-model-v1',
  priority: 40,
  paramSchema: [],
  analyze: async (market, ctx = {}) => {
    const result = await analyzeMarkets({
      config: ctx.config,
      strategy: { ...(ctx.strategyPrompt || {}), interval: ctx.interval || market.interval },
      market: [market]
    });
    if (result?.error) throw new Error(result.error);
    return result?.analyses?.[0] || { symbol: market.symbol, action: 'WAIT', confidence: 0, reason: '模型结果缺失。', plan: null };
  },
  review: (order, market, ctx = {}) => reviewPosition({
    config: ctx.config,
    strategy: { ...(ctx.strategyPrompt || {}), interval: order.interval },
    market,
    position: {
      symbol: order.symbol,
      positionAmt: order.quantity * (order.direction === 'OPEN_LONG' ? 1 : -1),
      entryPrice: order.entry,
      markPrice: market.klines.at(-1).close,
      stopLoss: order.plan.stopLoss,
      takeProfit: order.plan.takeProfit,
      simulated: true
    }
  })
});

/**
 * 策略 4：插针回补（默认关闭）
 * 引擎 pinFadeAnalysis：主流币 1m 长下影插针 → 在影线内预埋限价买单 → 止损放针脚下方，吃回补反弹。
 *
 * ⚠️ 90 天 × 1m × 24 主流币、560 组参数网格实测：扣费前毛收益为正的仅 4/560 组（最好 +0.028%/笔），
 *   扣费后全部为负，中位数与样本外同样为负 —— 1m 插针后没有可提取的方向性 alpha。
 *   故 priority 排在最后且**默认不启用**；证据见 data/backtest/pin-study.json。
 */
defineStrategy({
  id: 'pin-fade-v1',
  name: '插针回补 v1',
  description: '主流币 1 分钟长下影插针：针收盘后在影线内预埋限价买单（不追价），止损放针脚下方缓冲，'
    + '止盈按 R 倍数（默认 2.5R），跌穿针脚即失效。只做多，天然满足禁空政策。'
    + '⚠️ 90 天 1m 回测（24 主流币 / 560 组参数）扣费后为负期望，默认关闭，仅供对照实验。',
  engine: 'pin',
  modelId: 'pin-fade-v1',
  priority: 50,
  needsAux: [],
  paramSchema: [...PIN_PARAM_SCHEMA, ...PIN_EXIT_PARAM_SCHEMA],
  analyze: (market, ctx = {}) => pinFadeAnalysis(market, ctx.params),
  // 本地规则复核：用该订单快照在 plan.exitRules 的移动止损阶梯推进保护价
  review: (order, market) => localProtectionReview(order, market),
  // 引擎原生不带 exitRules，这里补一份「该策略的」出场规则（含关闭的智能退出）
  decoratePlan: (plan, ctx = {}) => ({
    ...plan,
    exitRules: buildExitRules({ ...ENHANCED_DEFAULTS, ...(ctx.params || {}) })
  })
});

/**
 * 引擎 → 默认策略映射（用于首次运行时把既有 config.analysis.engine 平移为启用集）
 *
 * ⚠️ `local`（本地多周期 v1）已于 2026-09-12 下线，故此处**不再有 local 映射**：
 *    老配置里 `config.analysis.engine === 'local'` 时，运行时统一回落到 enhanced-trend-v1。
 *    `server/localAnalysis.js` 的引擎实现本身仍保留 —— 行情工作台的手动分析与旧版
 *    paperAutomation / researchRoutes 仍在用，删除策略不等于删除引擎。
 */
export const ENGINE_DEFAULT_STRATEGY = Object.freeze({
  enhanced: 'enhanced-trend-v1',
  super: 'super-trend-v1',
  ai: 'ai-model-v1',
  pin: 'pin-fade-v1'
});
