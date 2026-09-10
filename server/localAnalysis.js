// Deterministic reference strategy; scores are rule strength, never win probabilities.
// 优化调整：基于2081笔历史订单分析（整体胜率22.1%，最优区间45-49根胜率100%）
import { LONG_ONLY, RISK_RULE, planRefEntry, planRiskUnit } from './shared/strategyGuards.js';
import { computeEntryLimit, trendProxyToScore } from './shared/entryModel.js';

export const LOCAL_STRATEGY = Object.freeze({
  modelId: 'local-mtf-trend-atr-v2',
  maxEntryDistanceAtr: 1.0,  // 从1.5收紧至1.0，避免追高
  maxHoldBars: 120,          // 1m 主周期：默认持仓 120 根（2 小时）；P5 周期回退同步修正
  stopLossAtr: 2.5,
  takeProfitAtr: 4.0,
});
const MIN_REWARD_TO_RISK = 1.25;
const validRows = rows => Array.isArray(rows) && rows.length >= 50 && rows.every(r =>
  [r.open, r.high, r.low, r.close].every(v => Number.isFinite(v) && v > 0)
  && r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close));
export function localAnalysis(market) {
  const rows = market.klines;
  const wait = reason => ({ symbol: market.symbol, action: 'WAIT', confidence: 0, reason, risk: '本地规则仅使用均线和波动率，不代表盈利保证。', plan: null });
  if (!validRows(rows)) return wait('本地规则需要至少 50 根有效的已收盘 K 线。');
  const mean = n => rows.slice(-n).reduce((sum, r) => sum + r.close, 0) / n;
  const fast = mean(20), slow = mean(50), close = rows.at(-1).close;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;
  // P0-2：加波动率下限，死水行情（ATR/close < 0.05%）被成本磨死，直接 WAIT
  if (!(atr > 0) || atr / close > 0.08 || atr / close < 0.0005 || Math.abs(fast - slow) < atr * 0.3) return wait('趋势不清晰或波动异常（过大或过小），暂不生成开仓计划。');
  const long = fast > slow;
  if (long ? close < fast : close > fast) return wait('价格与均线趋势不一致，等待确认。');

  if (LONG_ONLY.enabled && !long) return wait(LONG_ONLY.reason);
  if (Math.abs(close - fast) / atr > LOCAL_STRATEGY.maxEntryDistanceAtr) return wait(`价格偏离20均线超过${LOCAL_STRATEGY.maxEntryDistanceAtr} ATR，等待回归确认，避免追涨杀跌。`);

  const entryMin = close - atr * 0.35, entryMax = close + atr * 0.35;
  // 按评分预测的回调最优限价：市价追入 → 限价挂单，等价格回调触达 entryLimit 才成交。
  // 评分越高（趋势越清晰）回调越浅，评分越低越耐心等更深回调。
  const score = trendProxyToScore(Math.abs(fast - slow) / atr);
  const entryLimit = computeEntryLimit({ close, atr, direction: long ? 'long' : 'short', score });
  return { symbol: market.symbol, action: long ? 'BUY' : 'SELL', confidence: Math.min(0.85, 0.65 + Math.abs(fast - slow) / atr * 0.03),
    reason: `本地规则：20 根均线${long ? '高于' : '低于'}50 根均线，收盘价与趋势同向。`,
    risk: '均线趋势可能反转；以 14 根平均真实波幅设置保护价格。规则分数不是胜率。',
    plan: { entryMin, entryMax, entryLimit,
      stopLoss: long ? entryMin - atr * LOCAL_STRATEGY.stopLossAtr : entryMax + atr * LOCAL_STRATEGY.stopLossAtr,
      takeProfit: long ? entryMax + atr * LOCAL_STRATEGY.takeProfitAtr : entryMin - atr * LOCAL_STRATEGY.takeProfitAtr,
      // R 口径基准（实际成交锚点 → 初始止损），供移动止损 / 复核统一换算浮盈。
      riskUnit: Math.abs(entryLimit - (long ? entryMin - atr * LOCAL_STRATEGY.stopLossAtr : entryMax + atr * LOCAL_STRATEGY.stopLossAtr)),
      maxHoldBars: LOCAL_STRATEGY.maxHoldBars } };
}

// 多周期分析版本：引入15分钟、1小时、4小时辅助判断
export function localAnalysisMultiTimeframe(market, auxMarkets = {}, adaptiveParams = {}) {
  const rows = market.klines;
  const wait = reason => ({ symbol: market.symbol, action: 'WAIT', confidence: 0, reason, risk: '多周期规则使用均线和波动率，不代表盈利保证。', plan: null });

  // 主周期检查
  if (!validRows(rows)) return wait('主周期需要至少 50 根有效的已收盘 K 线。');

  const mean = (data, n) => data.slice(-n).reduce((sum, r) => sum + r.close, 0) / n;
  const calcATR = (data, periods = 14) => {
    if (data.length < periods + 1) return null;
    return data.slice(-periods).reduce((sum, r, i) => {
      const previous = data[data.length - periods - 1 + i].close;
      return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
    }, 0) / periods;
  };

  // 主周期指标
  const fast = mean(rows, 20), slow = mean(rows, 50), close = rows.at(-1).close;
  const atr = calcATR(rows);

  // P0-2：波动率下限，死水行情直接 WAIT（避免被成本磨死）
  if (!(atr > 0) || atr / close > 0.08 || atr / close < 0.0005) return wait('主周期波动异常（过大或过小），ATR计算失败或死水行情。');
  if (Math.abs(fast - slow) < atr * 0.3) return wait('主周期趋势不清晰。');

  const mainTrend = fast > slow ? 'long' : 'short';
  if (mainTrend === 'long' ? close < fast : close > fast) return wait('主周期价格与均线趋势不一致。');
  if (Math.abs(close - fast) / atr > LOCAL_STRATEGY.maxEntryDistanceAtr) return wait(`价格偏离20均线超过${LOCAL_STRATEGY.maxEntryDistanceAtr} ATR，等待回落确认，避免追涨。`);

  // 辅助周期分析
  const auxAnalysis = {};
  const intervals = ['15m', '1h', '4h'];

  for (const interval of intervals) {
    const auxiliary = market.interval === interval ? market : auxMarkets[interval];
    if (!validRows(auxiliary?.klines)) {
      auxAnalysis[interval] = { trend: 'unknown', reason: '数据不足' };
      continue;
    }

    const auxRows = auxiliary.klines;
    const auxFast = mean(auxRows, 20);
    const auxSlow = mean(auxRows, 50);
    const auxClose = auxRows.at(-1).close;
    const auxATR = calcATR(auxRows);

    if (!auxATR || auxATR / auxClose > 0.08) {
      auxAnalysis[interval] = { trend: 'unknown', reason: '波动过大' };
      continue;
    }

    const auxTrendDirection = auxFast > auxSlow ? 'long' : 'short';
    const auxTrendStrength = Math.abs(auxFast - auxSlow) / auxATR;
    const priceAlignment = auxTrendDirection === 'long' ? auxClose >= auxFast : auxClose <= auxFast;

    auxAnalysis[interval] = {
      trend: auxTrendDirection,
      strength: auxTrendStrength,
      aligned: priceAlignment,
      reason: `${auxTrendDirection === 'long' ? '上升' : '下降'}趋势，强度${auxTrendStrength.toFixed(2)}`
    };
  }

  // 多周期共振判断
  const higherTimeframes = ['1h', '4h'];
  const alignedCount = higherTimeframes.filter(int => auxAnalysis[int]?.trend === mainTrend).length;
  const strongAligned = higherTimeframes.filter(int =>
    auxAnalysis[int]?.trend === mainTrend &&
    auxAnalysis[int]?.aligned &&
    auxAnalysis[int]?.strength > 0.5
  ).length;

  // 趋势过滤规则
  if (strongAligned !== 2) {
    return wait('需要1小时和4小时均同向、价格与趋势一致且趋势强度超过0.5 ATR；数据不足或冲突时等待。');
  }
  if (auxAnalysis['15m']?.trend !== mainTrend || !auxAnalysis['15m']?.aligned || auxAnalysis['15m']?.strength <= 0.3) return wait('15分钟趋势未确认或数据不足，等待。');

  // 优化调整：跨引擎共享禁空政策（同一事实源 LONG_ONLY，禁止单边文本漂移）
  if (LONG_ONLY.enabled && mainTrend === 'short') return wait(LONG_ONLY.reason);

  // 计算置信度：基于多周期共振
  let baseConfidence = 0.65;
  baseConfidence += Math.abs(fast - slow) / atr * 0.03; // 主周期趋势强度
  baseConfidence += alignedCount * 0.05; // 每个共振周期+5%
  baseConfidence += strongAligned * 0.05; // 每个强共振周期+5%

  const confidence = Math.min(0.95, baseConfidence);

  const entryMin = close - atr * 0.35, entryMax = close + atr * 0.35;
  const long = mainTrend === 'long';
  // 按评分预测的回调最优限价（市价追入 → 限价挂单，GTC 无有效期限制）
  const score = trendProxyToScore(Math.abs(fast - slow) / atr);
  const entryLimit = computeEntryLimit({ close, atr, direction: long ? 'long' : 'short', score });

  // 自适应参数必须保留最低 1.25:1 的计划风险收益比（从最坏入场价计算）。
  const stopLossATR = Math.min(3.5, Math.max(1, Number(adaptiveParams.stopLossATR ?? LOCAL_STRATEGY.stopLossAtr)));
  const requestedTargetATR = Math.min(6, Math.max(1.5, Number(adaptiveParams.takeProfitATR ?? LOCAL_STRATEGY.takeProfitAtr)));
  const takeProfitATR = Math.max(requestedTargetATR, Number((MIN_REWARD_TO_RISK * (stopLossATR + 0.7)).toFixed(2)));
  const maxHoldBars = Math.min(200, Math.max(1, Math.round(Number(adaptiveParams.maxHoldBars ?? LOCAL_STRATEGY.maxHoldBars))));
  const adaptiveReason = adaptiveParams.reason || '';

  const reasonDetail = [
    `主周期：20MA${long ? '>' : '<'}50MA`,
    `15分钟：${auxAnalysis['15m']?.reason || '无数据'}`,
    `1小时：${auxAnalysis['1h']?.reason || '无数据'}`,
    `4小时：${auxAnalysis['4h']?.reason || '无数据'}`,
    `共振度：${alignedCount}/2个高级周期一致`
  ].join('；');

  const fullReason = adaptiveReason
    ? `多周期分析：${reasonDetail}\n自适应调整：${adaptiveReason}`
    : `多周期分析：${reasonDetail}`;

  return {
    symbol: market.symbol,
    action: long ? 'BUY' : 'SELL',
    confidence,
    reason: fullReason,
    risk: '多周期过滤效果需要独立验证；止损止盈基于主周期ATR设置，规则分数不是胜率。',
    multiTimeframeAnalysis: auxAnalysis,
    adaptiveParamsUsed: { stopLossATR, takeProfitATR, maxHoldBars, confidence: adaptiveParams.confidence || 0,
      targetAdjustedForRisk: takeProfitATR !== requestedTargetATR },
    plan: {
      entryMin,
      entryMax,
      entryLimit,
      stopLoss: long ? entryMin - atr * stopLossATR : entryMax + atr * stopLossATR,
      takeProfit: long ? entryMax + atr * takeProfitATR : entryMin - atr * takeProfitATR,
      // R 口径基准（实际成交锚点 → 初始止损）
      riskUnit: Math.abs(entryLimit - (long ? entryMin - atr * stopLossATR : entryMax + atr * stopLossATR)),
      maxHoldBars
    }
  };
}

/**
 * 计划的风险单位 R（价格单位）。统一委托给 strategyGuards.planRiskUnit，
 * 保证本地引擎 / enhanced / 复核侧对「R」的定义完全一致。
 */
export function planRisk(plan, direction) {
  return planRiskUnit(plan, direction);
}

/**
 * 推荐杠杆：以 RISK_RULE.riskBudgetPct（目标保证金风险预算）反推，硬上限 RISK_RULE.maxLeverage。
 *
 * 修复要点（Task #5，2026-09-10）：
 *   旧实现 `Math.min(5, floor(0.1/distance))` 里的 0.1 与 5 是散落魔数，
 *   且 research.js 会用本函数**覆盖所有引擎**（含 enhanced）自算的杠杆，
 *   于是 enhanced 里那套基于 riskDistance 的推荐被静默丢弃，两处口径长期不一致。
 *   现在预算/上限都来自 strategyGuards 单一事实源，且入参口径与计划一致
 *   （优先 entryLimit = 实际成交锚点）。置 NOFX_MAX_LEVERAGE / NOFX_RISK_BUDGET_PCT 可调。
 */
export function recommendedLeverage(plan, direction) {
  if (!plan) return 1;
  const entry = planRefEntry(plan, direction);
  const distance = Math.abs(entry - plan.stopLoss) / entry;
  return Number.isFinite(distance) && distance > 0
    ? Math.max(1, Math.min(RISK_RULE.maxLeverage, Math.floor(RISK_RULE.riskBudgetPct / distance)))
    : 1;
}

/**
 * 真实保证金风险（占保证金比例）= 杠杆 × 止损距离。
 * 用于替代「暗示 10% 预算已被用满」的模糊表述：实际值几乎总被 maxLeverage 截断而上不满。
 * @returns {number} 例如 0.043 = 4.3%
 */
export function plannedMarginRiskPct(plan, direction, leverage) {
  const lev = Number(leverage);
  if (!plan || !Number.isFinite(lev) || lev <= 0) return 0;
  const entry = planRefEntry(plan, direction);
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  return lev * Math.abs(entry - plan.stopLoss) / entry;
}
