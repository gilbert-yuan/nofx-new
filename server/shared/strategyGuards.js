/**
 * 跨分析引擎共享的策略护栏（Strategy Guards）
 *
 * 初衷（参见《策略优化分析报告》P2-1）：
 *   localAnalysis / localAnalysisMultiTimeframe / enhancedAnalysis 各自为政，
 *   方向限制、移动止损和止损距离应使用一致的规则。
 *
 * 抽出以下跨引擎一致 / 应保持一致的规则：
 *   1. `LONG_ONLY`              — 可选的本地规则引擎禁空开关，默认双向
 *   2. `TRAILING_RULE`          — 持仓复核阶段移动止损距离（P0-1 一致性建议）
 *   3. `ENHANCED_RR_FLOOR`      — enhanced 引擎专用 RR 门槛 + 最小止损距离
 *
 * **不抽出**：localAnalysis 的 `MIN_REWARD_TO_RISK` —— 它 (1.25) 与 enhanced 的
 * `MIN_RISK_REWARD_RATIO` (2.5) 看似都是「最低盈亏比」，但口径截然不同：
 *   - local 用「最不利入场价 → 止盈 ÷ 最不利入场价 → 止损」（含入场带宽）
 *   - enhanced 用「现价 → 主止盈 ÷ 现价 → 止损」（不含入场带宽）
 * 两者**不可机械对齐**——把 local 抬到 2.5 会出 0 单，把 enhanced 压到 1.25 会
 * 漏过大量低胜率信号。语义不同，门槛各自保留为引擎内部常量。
 */

// ─────────────────────────── 禁空政策 ───────────────────────────
//
// 单一事实源：本字段被 localAnalysis / localAnalysisMultiTimeframe /
// enhancedAnalysis 三处 wait() 调用消费，避免出现「enhanced 文本漏写
// 『与本地策略保持一致』」之类的退化式漂移。
export const LONG_ONLY = Object.freeze({
  enabled: /^(true|1)$/i.test((process.env.NOFX_LONG_ONLY || '').trim()),
  reason: '当前配置 NOFX_LONG_ONLY 已启用，仅允许做多。'
});

// ───────────────────────── 移动止损（trailing）规则 ─────────────────────────
//
// P0-1 一致性建议：把移动止损距离从原来的 ~1.5 ATR 放宽到 2.5 ATR（避免在趋势
// 中段被均值回归扫掉）。enhanced 已实施，本模块固化以便后续 local 引擎复用。
export const TRAILING_RULE = Object.freeze({
  // 持仓复核时，移动止损跟随价格的最远距离（单位 ATR，多头 close - N*ATR）
  stopAtr: 2.5,
  // 顺势扩展止盈（只放宽不收窄）：与主止盈 3.5R 经验上同档
  extendTpAtr: 3.0,
  // 上移到盈亏平衡位的最小浮盈触发（单位 ATR），防止一盈利就锁死
  breakEvenFloorAtr: 0.2
});

// ───────────────── enhanced 引擎专用护栏（API 兼容期保留） ─────────────────
export const ENHANCED_RR_FLOOR = Object.freeze({
  minRiskReward: 2.5,
  // P2-2 报告衍生：止损距离不得低于 1.2 ATR，避免「maSupportStop 离现价 < 1 ATR」
  // 之类导致被正常波动扫掉。当前 enhanced 已通过 `Math.max(atr * 2.0, close * 0.008)`
  // 隐式保证（2.0 ATR >= 1.2 ATR）。
  minStopDistanceAtr: 1.2
});

// ─────────────────────────── 工具函数 ───────────────────────────

/**
 * 把「禁空命中」翻译成 wait() 返回结构。
 * @param {(reason: string, suggestions?: string[], trend?: object) => object} wait
 *   wait 工厂函数，由调用方在各自作用域构造，以保持原代码风格一致。
 * @param {object} [trendStrength] 趋势强度对象（如有），透传给 wait
 */
export function longOnlyWait(wait, trendStrength) {
  return wait(LONG_ONLY.reason, [], trendStrength);
}

/**
 * 通用快捷检查：方向是否应被禁。
 * @param {string} direction  'long' | 'short'
 * @returns {boolean}
 */
export function isDirectionBlocked(direction) {
  return LONG_ONLY.enabled && direction === 'short';
}
