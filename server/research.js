import { createHash, randomUUID } from 'node:crypto';
import { recommendedLeverage } from './localAnalysis.js';

export const RESEARCH_VERSION = 'closed-candle-plan-v1';
// Scenario assumptions, not exchange fee quotes. Frozen into every new record.
export const PAPER_COSTS = Object.freeze({ feeBps: 6, slippageBps: 5, fundingBpsPer8h: 3, notional: 10 });
const intervals = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M' };

// 主交易周期（P5 复盘结论：回退到 1m）。
//
// 历史证据（均为 status='closed' 的真实模拟订单统计）：
//   · 1m  ：2232 单，胜率 22.8%，均单 -0.913 USDT
//   · 5m  ： 265 单，胜率 14.0%，均单 -3.690 USDT
//   · 15m ：  54 单，胜率 14.8%，均单 -2.347 USDT
// 两次「放大周期」的尝试（1m→5m、1m→15m）都被证伪，且都是「胜率下降 + 单笔亏损放大」
// 的双重恶化。原因：周期放大并未提高信号质量，只是把 ATR 同步放大 ~2~4 倍，
// 于是止损距离和单笔绝对亏损被等比放大；而 15m/5m 上每根 K 线要承担 3~15 倍的
// 信息量，收盘确认反而更滞后，入场点更差。
//
// 1m 的高频噪声问题应该用「信号过滤器 + 出场管理」解决（见 enhancedAnalysis.js 的
// MIN_ATR_PCT 波动率闸门 / 移动止损提前触发），而不是用放大周期这种粗放手段。
// 回退只需改这一处（扫描/下单/复核全部走这个常量）。
export const MAIN_INTERVAL = '1m';

// 如需临时切回 15m 做对照实验，请同时把 enhancedAnalysis.js 的 NOFX_MIN_ATR_PCT
// 从 0.003 重标到 ~0.010（15m 的 ATR/价格约为 1m 的 3 倍，沿用 1m 阈值会几乎不过滤）。

export function toBybitInterval(interval) {
  if (!intervals[interval]) throw Object.assign(new Error(`不支持的周期：${interval}`), { status: 400 });
  return intervals[interval];
}

export function nextOpenTime(time, interval) {
  const provider = intervals[interval] || interval;
  if (provider === 'M') {
    const date = new Date(Number(time));
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  const minutes = provider === 'D' ? 1440 : provider === 'W' ? 10080 : Number(provider);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`Invalid interval: ${interval}`);
  return Number(time) + minutes * 60000;
}

export function candleOpenAt(time, interval) {
  toBybitInterval(interval);
  const date = new Date(time);
  if (interval === '1M') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const duration = nextOpenTime(0, interval);
  const anchor = interval === '1w' ? 4 * 86400000 : 0; // Monday, UTC.
  return Math.floor((time - anchor) / duration) * duration + anchor;
}

export function validCandle(row) {
  return Number.isFinite(Number(row.openTime)) && ['open', 'high', 'low', 'close'].every(k => Number.isFinite(Number(row[k])) && Number(row[k]) > 0)
    && Number(row.low) <= Math.min(Number(row.open), Number(row.close))
    && Number(row.high) >= Math.max(Number(row.open), Number(row.close))
    && Number.isFinite(Number(row.volume)) && Number(row.volume) >= 0;
}

export function prepareMarket({ symbol, interval, rows, limit, now = Date.now(), marketProvider = 'binance', throwOnInsufficient = true }) {
  toBybitInterval(interval);
  const closed = rows.filter(row => row.confirmed !== false && nextOpenTime(row.openTime, interval) <= now)
    .sort((a, b) => a.openTime - b.openTime).slice(-limit)
    .map(row => ({ ...row, closeTime: nextOpenTime(row.openTime, interval) - 1 }));
  const fail = message => { throw Object.assign(new Error(`${symbol}：${message}`), { status: 422 }); };

  // 小窗口必须齐全；大窗口最多少两根，指标所需的最少根数由分析器检查。
  const minRequired = Math.min(limit, Math.max(50, limit - 2));
  if (closed.length < minRequired) {
    if (!throwOnInsufficient) {
      // 返回需要更多数据的标记，而不是抛出错误
      return {
        insufficient: true,
        symbol,
        interval,
        required: minRequired,
        actual: closed.length,
        needMore: minRequired - closed.length
      };
    }
    fail(`已收盘K线不足，需要至少 ${minRequired} 根，实际 ${closed.length} 根`);
  }

  for (let i = 0; i < closed.length; i++) {
    if (!validCandle(closed[i]) || candleOpenAt(Number(closed[i].openTime), interval) !== Number(closed[i].openTime)) fail('K线数值或时间无效');
    if (i && nextOpenTime(closed[i - 1].openTime, interval) !== Number(closed[i].openTime)) fail('K线缺失或重复，请重新同步');
  }
  const end = nextOpenTime(closed.at(-1).openTime, interval);
  if (end !== candleOpenAt(now, interval)) fail('行情已过期，缺少最新已收盘K线');
  return { symbol, exchange: 'binance', marketProvider, interval, dataAsOf: new Date(end).toISOString(), klines: closed };
}

export function normalizePlan(raw, market, now, costs = PAPER_COSTS) {
  const issues = [];
  if (Date.parse(market.dataAsOf) !== candleOpenAt(now, market.interval)) issues.push('分析完成时行情已跨周期，请重新分析');
  const requestedAction = String(raw?.positionRecommendation || raw?.action || 'WAIT').toUpperCase();
  let action = ({ BUY: 'OPEN_LONG', SELL: 'OPEN_SHORT', HOLD: 'WAIT' })[requestedAction] || requestedAction;
  const confidence = typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;
  if (confidence === null) issues.push('模型自评分必须为 0～1 的数值');
  if (['CLOSE_LONG', 'CLOSE_SHORT'].includes(action)) issues.push('未接入持仓，平仓建议仅供已有对应持仓者参考');
  else if (!['OPEN_LONG', 'OPEN_SHORT', 'WAIT'].includes(action)) issues.push('未知交易方向');
  const plan = raw?.plan;
  let normalized = null;
  if (['OPEN_LONG', 'OPEN_SHORT'].includes(action)) {
    const fields = ['entryMin', 'entryMax', 'stopLoss', 'takeProfit', 'validForBars', 'maxHoldBars'];
    if (!plan || fields.some(k => typeof plan[k] !== 'number' || !Number.isFinite(plan[k]) || plan[k] <= 0)) issues.push('缺少有效入场区间、止损、止盈或持有期限');
    else {
      const { entryMin, entryMax, stopLoss, takeProfit, validForBars, maxHoldBars } = plan;
      const long = action === 'OPEN_LONG';
      if (entryMin > entryMax || (long ? !(stopLoss < entryMin && takeProfit > entryMax) : !(takeProfit < entryMin && stopLoss > entryMax))) issues.push('入场、止损、止盈价格关系无效');
      if (!Number.isInteger(validForBars) || validForBars > 6 || !Number.isInteger(maxHoldBars) || maxHoldBars > 120) issues.push('入场期限须为1～6根，持有期限须为1～120根');
      if (!issues.length) {
        const entry = long ? entryMax : entryMin;
        const holdStart = nextOpenTime(candleOpenAt(now, market.interval), market.interval);
        let holdEnd = holdStart;
        for (let i = 0; i < maxHoldBars; i++) holdEnd = nextOpenTime(holdEnd, market.interval);
        const hours = (holdEnd - holdStart) / 3600000;
        const cost = entry * (2 * (costs.feeBps + costs.slippageBps) + costs.fundingBpsPer8h * hours / 8) / 10000;
        const reward = Math.abs(takeProfit - entry) - cost;
        const risk = Math.abs(entry - stopLoss) + cost;
        const netRewardRisk = reward / risk;
        if (netRewardRisk < 1) issues.push('按最不利入场价估算，成本后盈亏比低于1');
        normalized = { entryMin, entryMax, stopLoss, takeProfit, validForBars, maxHoldBars, netRewardRisk, entryRule: 'next_candle_open_in_range' };
      }
    }
  }
  if (issues.length) action = 'WAIT';
  let firstEntryAt = nextOpenTime(candleOpenAt(now, market.interval), market.interval);
  let expiresAt = firstEntryAt;
  for (let i = 0; i < (normalized?.validForBars || 1); i++) expiresAt = nextOpenTime(expiresAt, market.interval);
  return {
    symbol: market.symbol, exchange: 'binance', marketProvider: market.marketProvider || 'binance', interval: market.interval, dataAsOf: market.dataAsOf,
    generatedAt: new Date(now).toISOString(), firstEntryAt: new Date(firstEntryAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
    positionRecommendation: action, action: action === 'OPEN_LONG' ? 'BUY' : action === 'OPEN_SHORT' ? 'SELL' : 'HOLD',
    confidence, confidenceType: 'model_self_assessment', reason: String(raw?.reason || ''), risk: String(raw?.risk || ''), suggestion: String(raw?.suggestion || ''),
    recommendedLeverage: issues.length ? 1 : recommendedLeverage(normalized, action),
    validationIssues: issues, eligible: !issues.length && !!normalized, plan: issues.length ? null : normalized
  };
}

export function createResearchRecord({ config, strategy, market, result, type, scope, now = Date.now() }) {
  const snapshot = { version: RESEARCH_VERSION, exchange: 'binance', marketProvider: market[0]?.marketProvider || 'binance', model: config.model.model,
    providerFingerprint: createHash('sha256').update(String(config.model.baseUrl || '')).digest('hex').slice(0, 16), temperature: 0.2,
    strategy: { name: strategy.name, interval: strategy.interval, klineLimit: scope.limit, systemPrompt: strategy.systemPrompt, rules: strategy.rules }, costs: { ...PAPER_COSTS } };
  const strategyVersion = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
  const incoming = result.analyses || [];
  const errors = [result.error];
  const analyses = market.map(item => {
    const matching = incoming.filter(raw => String(raw.symbol || '').toUpperCase() === item.symbol);
    if (matching.length !== 1) errors.push(`${item.symbol}：模型结果缺失或重复`);
    const raw = matching.length === 1 ? matching[0] : { action: 'WAIT', confidence: 0, reason: '模型结果缺失或重复' };
    return normalizePlan(raw, item, now);
  });
  if (incoming.some(raw => !market.some(m => m.symbol === String(raw.symbol || '').toUpperCase()))) errors.push('已丢弃非请求币种的模型结果');
  return { id: `analysis-${randomUUID()}`, at: new Date(now).toISOString(), type, symbol: type === 'single' ? market[0].symbol : undefined,
    symbols: market.map(m => m.symbol), interval: strategy.interval, scope, marketCount: market.length, klineCount: market[0]?.klines.length,
    analyses, marketProvider: snapshot.marketProvider, error: errors.filter(Boolean).join(' | '), researchOnly: true, strategyVersion, snapshot, market };
}
