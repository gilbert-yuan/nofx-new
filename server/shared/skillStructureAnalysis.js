/**
 * Common adapter for the two crypto-long/short skill engines.
 *
 * The supplied skills are deterministic multi-timeframe rule engines.  This
 * module keeps their scoring, decision order and plan geometry in one place so
 * the long and short strategy entries cannot drift apart over time.
 */
import { summarizeSkill, skillStructure, isFiniteCandle } from './marketStructure.js';
import { btcEnvironment, makeSkillTradePlan, skillDataQuality, skillRegime, summarizeSkillDerivatives } from './skillStrategy.js';

const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const pct = (a, b) => finite(a) && finite(b) && Number(b) !== 0 ? (Number(a) - Number(b)) / Number(b) : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 4) => finite(value) ? Number(Number(value).toFixed(digits)) : null;

function structureView(s4, s1, s15) {
  return {
    '4h': { trend: s4.trend, highPattern: s4.highPattern, lowPattern: s4.lowPattern },
    '1h': { trend: s1.trend, highPattern: s1.highPattern, lowPattern: s1.lowPattern,
      resistance: s1.resistance, support: s1.support },
    '15m': {
      trend: s15.trend,
      chochBullish: s15.chochBullish, bosBullish: s15.bosBullish,
      chochBearish: s15.chochBearish, bosBearish: s15.bosBearish,
      failedBreakout: s15.failedBreakout, failedBreakdown: s15.failedBreakdown
    }
  };
}

function waitSignal({ market, windowInfo, reason, extra = {}, riskNote, quality }) {
  return {
    symbol: market?.symbol,
    action: 'WAIT',
    decision: 'HOLD',
    state: 'HOLD',
    confidence: 0,
    reason,
    risk: riskNote,
    dataQuality: quality?.good === false ? 'DEGRADED' : 'GOOD',
    plan: null,
    trend: windowInfo,
    ...(quality ? { quality: { ...quality } } : {}),
    ...extra
  };
}

/**
 * Run the original skill decision tree against prepared NOFX market objects.
 * `long` selects the mirrored long/short branch; all other rules remain shared.
 */
export function analyzeSkillStructure(market, ctx = {}, { long, params = {}, costs = {} } = {}) {
  const planInterval = '15m';
  const aux = ctx.auxMarkets || {};
  // Auxiliary data wins even when the main review market happens to be 15m:
  // the runtime deliberately loads the configured 500-bar decision window.
  const source15 = aux[planInterval] || (market?.interval === planInterval ? market : null);
  const source1h = aux['1h'];
  const source4h = aux['4h'];
  const source5 = aux['5m'];
  const rows15 = Array.isArray(source15?.klines) ? source15.klines : [];
  const rows1h = Array.isArray(source1h?.klines) ? source1h.klines : [];
  const rows4h = Array.isArray(source4h?.klines) ? source4h.klines : [];
  const rows5 = Array.isArray(source5?.klines) ? source5.klines : [];
  const windowInfo = {
    interval: planInterval,
    bars: { '5m': rows5.length, '15m': rows15.length, '1h': rows1h.length, '4h': rows4h.length },
    dataAsOf: source15?.dataAsOf || null
  };
  const riskNote = long
    ? '结构做多（SKILL parity）：4H 定方向、1H 定位置、15m 定确认；按止损风险计算仓位，不追涨。'
    : '结构做空（SKILL parity）：4H 定方向、1H 定位置、15m 定确认；按止损风险计算仓位，不追空。';
  const wait = (reason, extra = {}, quality) => waitSignal({ market, windowInfo, reason, extra, riskNote, quality });

  const strict = params.strictSkillData !== false;
  const rawDerivatives = ctx.derivatives || ctx.skillContext?.derivatives || {};
  const btcMarket = ctx.btcMarket || ctx.skillContext?.btcMarket || null;
  const quality = skillDataQuality({
    rows4h, rows1h, rows15, rows5, btcMarket, rawDerivatives,
    requireFiveMinute: Boolean(params.requireFiveMinute || ctx.skillContext?.requireFiveMinute)
  });
  if (strict && !quality.good) {
    return wait(`SKILL 所需市场数据不完整，保持 HOLD：${quality.missing.join('、') || 'unknown'}`,
      { missingData: quality.missing }, quality);
  }

  // Non-strict mode is an explicit diagnostic/backtest fallback only.  It
  // still refuses malformed or obviously undersized candles.
  const minimum = { '15m': 30, '1h': 30, '4h': 55 };
  for (const [tf, rows] of Object.entries({ '15m': rows15, '1h': rows1h, '4h': rows4h })) {
    if (rows.length < minimum[tf]) return wait(`结构策略需要至少 ${minimum[tf]} 根 ${tf} K 线，实际 ${rows.length} 根。`, {}, quality);
  }
  if (![rows15, rows1h, rows4h].every(rows => rows.every(isFiniteCandle))) {
    return wait('K 线存在坏打印（OHLC 非法），本轮 HOLD。', {}, quality);
  }

  const s4 = skillStructure(rows4h);
  const s1 = skillStructure(rows1h);
  const s15 = skillStructure(rows15);
  const i4 = summarizeSkill(rows4h);
  const i1 = summarizeSkill(rows1h);
  const i15 = summarizeSkill(rows15);
  const d = summarizeSkillDerivatives(rawDerivatives);
  const btc = btcEnvironment(btcMarket);
  if (!(i4.atr > 0) || !finite(i4.price) || !finite(i4.ema20)) {
    return wait('4H SKILL 指标未就绪（ATR/EMA20 无效），本轮 HOLD。', { structure: structureView(s4, s1, s15) }, quality);
  }

  const marketRegime = skillRegime(i4, s4);
  const distanceAtr = (i4.price - i4.ema20) / i4.atr;
  const recentChange = pct(i4.price, rows4h.at(-5)?.close);
  const dPriceChange = pct(i4.price, rows4h.at(-2)?.close);
  const liquidationRisk = long
    ? ((d.fundingZ > 2 && d.oiChange15m > 0 && recentChange <= 0)
      || (s4.trend === 'BEARISH' && i4.volumeRatio > 1.5 && d.oiChange15m > 0)
      ? 'HIGH' : d.fundingZ > 1 ? 'MEDIUM' : 'LOW')
    : ((d.fundingZ < -2 && d.oiChange15m > 0 && recentChange >= 0)
      || (s4.trend === 'BULLISH' && i4.volumeRatio > 1.5 && d.oiChange15m > 0)
      ? 'HIGH' : d.fundingZ < -1 ? 'MEDIUM' : 'LOW');

  const nearSupport = s1.support != null && Math.abs(i4.price - s1.support) <= 1.2 * i4.atr;
  const nearResistance = s1.resistance != null && Math.abs(i4.price - s1.resistance) <= 1.2 * i4.atr;
  const confirmed = long ? s15.chochBullish && s15.bosBullish : s15.chochBearish && s15.bosBearish;
  const confluence = long ? nearSupport || s15.failedBreakdown : nearResistance || s15.failedBreakout;
  const emaAligned = long
    ? i4.price > i4.ema20 && i4.ema20 > i4.ema50 && i4.ema50 > i4.ema200
    : i4.price < i4.ema20 && i4.ema20 < i4.ema50 && i4.ema50 < i4.ema200;
  const volumeAligned = long
    ? i4.volumeRatio > 1.1 && i4.takerSellRatio < 0.5
    : i4.volumeRatio > 1.1 && i4.takerSellRatio > 0.5;
  const trendAligned = long ? s4.trend === 'BULLISH' : s4.trend === 'BEARISH';
  const locationAligned = long ? s1.trend === 'BULLISH' : s1.trend === 'BEARISH';
  const reasons = [];
  let score = 0;
  if (trendAligned) { score += 20; reasons.push(long ? '4H形成HH+HL' : '4H形成LH+LL'); }
  if (locationAligned) { score += 15; reasons.push(long ? '1H多头结构' : '1H空头结构'); }
  if (confirmed) { score += 10; reasons.push('15m CHOCH+BOS确认'); }
  if (confluence) { score += 10; reasons.push(long ? '价格接近支撑或出现假跌破' : '价格接近阻力或出现假突破'); }
  if (emaAligned) { score += 10; reasons.push(long ? 'EMA多头排列' : 'EMA空头排列'); }
  if (volumeAligned) { score += 10; reasons.push(long ? '放量买盘确认' : '放量卖盘确认'); }
  if (long ? d.fundingZ < 0 : d.fundingZ > 1) { score += 5; reasons.push('资金费率支持方向'); }
  if (d.oiChange15m > 0 && (long ? dPriceChange > 0 : dPriceChange < 0)) { score += 5; reasons.push('OI与价格同向'); }
  if (long ? btc === 'BULLISH' : btc === 'BEARISH') { score += 5; reasons.push('BTC 4H支持方向'); }
  else if (long ? btc === 'BEARISH' : btc === 'BULLISH') { score -= 15; reasons.push('BTC 4H与方向相反'); }
  score = clamp(score, 0, 90);

  const support = long ? s1.support : s4.support;
  const resistance = long ? s4.resistance : s1.resistance;
  const balance = [ctx.account?.equity, ctx.account?.balance, ctx.state?.initialBalance, ctx.balance]
    .map(Number).find(Number.isFinite) ?? 10000;
  const plan = makeSkillTradePlan({
    long, price: i4.price, atr: i4.atr, resistance, support,
    balance,
    risk: params.riskPerTrade ?? 0.01,
    volatility: i4.atrPercentile,
    leverage: params.defaultLeverage ?? 5
  });
  if (!plan) return wait('SKILL 无法建立有效入场/止损计划，本轮 HOLD。', { structure: structureView(s4, s1, s15), score }, quality);
  if (plan.riskReward >= 3) score += 10;
  else if (plan.riskReward >= 2) score += 7;
  score = clamp(score, 0, 100);

  let entryQuality = 50;
  if (long ? nearSupport : nearResistance) entryQuality += 15;
  if (long ? s15.chochBullish : s15.chochBearish) entryQuality += 12;
  if (long ? s15.bosBullish : s15.bosBearish) entryQuality += 8;
  if (long ? s15.failedBreakdown : s15.failedBreakout) entryQuality += 10;
  if (long ? distanceAtr > 2 : distanceAtr < -2) entryQuality -= 35;
  if (long ? i4.rsi > 70 : i4.rsi < 30) entryQuality -= 20;
  if (i4.atrPercentile > 0.9) entryQuality -= 15;
  entryQuality = clamp(entryQuality, 0, 100);

  const oppositeRegime = long ? marketRegime === 'TREND_DOWN' : marketRegime === 'TREND_UP';
  const extended = long ? distanceAtr >= 2 : distanceAtr <= -2;
  const minScore = params[long ? 'bullishScoreMin' : 'bearishScoreMin'] ?? 70;
  const minQuality = params.entryQualityMin ?? 70;
  let decision = long ? 'LONG_ALLOWED' : 'SHORT_ALLOWED';
  let state = long ? 'LONG_TRIGGERED' : 'SHORT_TRIGGERED';
  const blockers = [];
  if (oppositeRegime) {
    decision = 'HOLD'; state = 'NO_SETUP'; blockers.push(long ? '4H强下跌趋势' : '4H强上涨趋势');
  } else if (liquidationRisk === 'HIGH') {
    decision = 'HOLD'; state = 'RISK_OFF'; blockers.push(long ? '多头爆仓风险高' : '挤空风险高');
  } else if (score < minScore) {
    decision = 'HOLD'; state = 'NO_SETUP'; blockers.push(`${long ? '多头' : '空头'}评分不足${minScore}`);
  } else if (extended || entryQuality < minQuality) {
    decision = 'WAIT_FOR_PULLBACK'; state = 'WAITING_PULLBACK'; blockers.push(long ? '当前位置不适合追涨' : '当前位置不适合追空');
  } else if (plan.riskReward < 2) {
    decision = 'HOLD'; state = 'NO_SETUP'; blockers.push('预期盈亏比低于1:2');
  } else if (!confirmed) {
    decision = 'WAIT_FOR_CONFIRMATION'; state = 'WAITING_CONFIRMATION'; blockers.push('等待15m CHOCH+BOS');
  }

  const risks = [];
  if (i4.atrPercentile > 0.8) risks.push('波动率偏高，应降低仓位');
  if (long ? btc === 'BEARISH' : btc === 'BULLISH') risks.push(`BTC 4H ${long ? '偏空' : '偏多'}`);
  if (long ? i4.rsi > 70 : i4.rsi < 30) risks.push(long ? 'RSI超买，存在回调风险' : 'RSI超卖，存在反弹风险');
  if (d.oiChange15m < 0) risks.push(long ? 'OI下降，上涨可能以空头平仓为主' : 'OI下降，下跌可能以多头平仓为主');
  const planWithMetadata = {
    ...plan,
    maxHoldBars: Math.round(params.maxHoldBars ?? 96),
    riskPerTrade: params.riskPerTrade ?? 0.01,
    maxDailyLoss: params.maxDailyLoss ?? 0.03,
    extremeAtr: params.extremeAtr ?? 3
  };
  const confidence = clamp(score / 100, 0, 0.95);
  const directionName = long ? '做多' : '做空';
  const directionLabel = long ? 'BUY' : 'SELL';
  const allowed = decision === (long ? 'LONG_ALLOWED' : 'SHORT_ALLOWED');
  const reason = `${directionName}（4H→1H→15m）：${reasons.join('；') || '暂无合格成分'}；`
    + `评分 ${score}/100、入场质量 ${entryQuality}/100、4H RSI ${finite(i4.rsi) ? i4.rsi.toFixed(1) : 'NA'}、`
    + `${long ? '距' : '距'} 4H EMA20 ${distanceAtr.toFixed(2)}×ATR；`
    + `SKILL ${allowed ? '满足' : '未满足'}开仓条件${blockers.length ? `（${blockers.join('；')}）` : ''}。`;
  const common = {
    symbol: market?.symbol,
    action: allowed ? directionLabel : 'WAIT',
    decision,
    state,
    confidence: allowed ? confidence : 0,
    dataQuality: quality.good ? 'GOOD' : 'DEGRADED',
    quality: { ...quality },
    reason,
    risk: risks.length ? `${riskNote} ${risks.join('；')}` : riskNote,
    marketRegime,
    currentPrice: round(i4.price),
    markPrice: round(d.markPrice),
    indexPrice: round(d.indexPrice),
    ...(long ? { bullishProbability: score, longLiquidationRisk: liquidationRisk,
      doNotChaseAbove: round(i4.ema20 + 2 * i4.atr), primaryLongZone: [plan.entryMin, plan.entryMax] }
      : { bearishProbability: score, squeezeRisk: liquidationRisk,
        doNotChaseBelow: round(i4.ema20 - 2 * i4.atr), primaryShortZone: [plan.entryMin, plan.entryMax] }),
    secondaryZone: plan.secondaryZone,
    confirmationRequired: '15m CHOCH + BOS + Retest',
    stopLoss: plan.stopLoss,
    tp1: plan.takeProfit1,
    tp2: plan.takeProfit2,
    tp3: plan.takeProfit3,
    riskReward: plan.riskReward,
    suggestedRisk: `${(plan.adjustedRisk * 100).toFixed(2)}%`,
    position: plan.position,
    liquidationSafety: plan.liquidationSafety,
    invalidation: `${long ? '1H/4H收盘有效跌破' : '1H/4H收盘有效突破'} ${round(plan.stopLoss)}`,
    indicators: { '4h': i4, '1h': i1, '15m': i15 },
    derivatives: d,
    btcEnvironment: btc,
    structure: structureView(s4, s1, s15),
    mainReasons: reasons,
    blockers,
    risks,
    trend: windowInfo,
    plan: allowed ? planWithMetadata : null
  };
  return common;
}
