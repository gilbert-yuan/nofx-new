/**
 * 入场限价模型：按评分预测的「回调最优价」挂单
 *
 * 背景（老板 2026-09-10 需求）：
 *   原策略在「下一根开盘价落入 close ± ENTRY_BAND_ATR 带内」即入场 —— 本质是市价追入。
 *   现改为「限价挂单，等价格回调触达 entryLimit 才成交」：
 *     - 多头：entryLimit = close - pullbackAtr * atr（等回调到更低价）
 *     - 空头：entryLimit = close + pullbackAtr * atr（等反弹到更高价）
 *   pullbackAtr 由趋势评分映射：评分越高→回调越浅（越急于入场），评分越低→回调越深（越耐心等更好价）。
 *
 * 有效期：validForBars === 0 表示 GTC（永不退市），由 NOFX_ENTRY_NO_EXPIRY 控制（默认开启，
 * 因为老板明确要求「取消下单有效期限制」）。实盘由 tradingSimulator 忽略 expiresAt 真正等待；
 * 研究回测用 ENTRY_EVAL_BARS 有界窗口，避免把 GTC 信号评估到无穷远。
 */

export const ENTRY_NO_EXPIRY = process.env.NOFX_ENTRY_NO_EXPIRY !== 'false';
// 研究回测用的有界评估窗口（根）。1m 下 240 根 = 4 小时。仅用于回测评估收敛，不影响实盘 GTC。
export const ENTRY_EVAL_BARS = Number(process.env.NOFX_ENTRY_EVAL_BARS ?? 240);

const PULLBACK_ATR_DEEP = Number(process.env.NOFX_PULLBACK_ATR_DEEP ?? 1.5);     // 低评分时的回撤深度(ATR)
const PULLBACK_ATR_SHALLOW = Number(process.env.NOFX_PULLBACK_ATR_SHALLOW ?? 0.3); // 高评分时的回撤深度(ATR)
const SCORE_FLOOR = Number(process.env.NOFX_SCORE_FLOOR ?? 70);  // 入场门槛评分（与 NOFX_MIN_TREND_SCORE 对齐）
const SCORE_CEIL = Number(process.env.NOFX_SCORE_CEIL ?? 100);

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * 把趋势评分映射成回调深度（单位 ATR）。
 * 高分(t=1)→浅回调(PULLBACK_ATR_SHALLOW)，低分(t=0)→深回调(PULLBACK_ATR_DEEP)。
 */
export function scoreToPullbackAtr(score) {
  if (!Number.isFinite(score)) return (PULLBACK_ATR_DEEP + PULLBACK_ATR_SHALLOW) / 2;
  const t = clamp((score - SCORE_FLOOR) / (SCORE_CEIL - SCORE_FLOOR), 0, 1);
  return PULLBACK_ATR_DEEP + (PULLBACK_ATR_SHALLOW - PULLBACK_ATR_DEEP) * t;
}

/** 按评分算出预测回调最优限价 */
export function computeEntryLimit({ close, atr, direction, score }) {
  const depth = scoreToPullbackAtr(score);
  return direction === 'long' ? close - depth * atr : close + depth * atr;
}

/**
 * 本地规则引擎没有 100 分趋势评分，用 |快线-慢线|/ATR 强度代理成 0~100，
 * 以便复用同一套评分→回调深度映射。趋势越清晰，代理评分越高，回调越浅。
 */
export function trendProxyToScore(proxy) {
  if (!Number.isFinite(proxy)) return SCORE_FLOOR;
  return clamp(SCORE_FLOOR + (proxy - 0.3) * 20, SCORE_FLOOR, SCORE_CEIL);
}
