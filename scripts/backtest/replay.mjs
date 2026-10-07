import fs from 'node:fs';
import { getStrategy } from '../../server/strategies/index.js';
import { TradingSimulator } from '../../server/tradingSimulator.js';
import { normalizePlan } from '../../server/research.js';
import { enhancedWindowBars } from '../../server/enhancedAnalysis.js';
import { settlePaperOrder } from '../../server/simulatedAccount.js';
import { applyPaperProtectionReview } from '../../server/shared/protectionReview.js';
import { klineFeatures, matchFeatureRules } from '../../shared/strategyFeatureFilter.js';
import { abs, DAY, MINUTE, duration, validateParams, validateExecution } from './config.mjs';
import { readCandles, resample, closedWindow, coverage } from './data.mjs';
import { tradeMetrics } from './stats.mjs';
import { createConfirmationGate } from './confirmation.mjs';

let cached = null;
export async function dataset(file, config) {
  const key = `${file}:${config.period.from}:${config.period.to}:${config.period.warmupDays}`;
  if (cached?.key === key) return cached;
  const loaded = await readCandles(file, Date.parse(config.period.from) - config.period.warmupDays * DAY, Date.parse(config.period.to));
  cached = { ...loaded, key, intervals: new Map([['1m', loaded.data]]) };
  return cached;
}
function market(symbol, tf, series, time, count) {
  const klines = closedWindow(series, tf, time, count);
  return klines ? { symbol, exchange: 'binance', marketProvider: 'binance', interval: tf,
    dataAsOf: new Date(Math.floor(time / duration(tf)) * duration(tf)).toISOString(), klines } : null;
}
function profilesAt(profiles, symbol, time, maxAge) {
  const xs = profiles?.[symbol] || [];
  let l = 0, h = xs.length;
  while (l < h) { const m = (l + h) >>> 1; if (Date.parse(xs[m].asOf) <= time) l = m + 1; else h = m; }
  const row = xs[l - 1];
  return row && time - Date.parse(row.asOf) <= maxAge ? row : null;
}
function readProfiles(config) {
  if (!config.data.historicalProfiles) return null;
  const rows = JSON.parse(fs.readFileSync(abs(config.data.historicalProfiles), 'utf8')), out = {};
  if (!Array.isArray(rows)) throw new Error('historicalProfiles 必须为带 symbol/asOf 的历史画像数组');
  for (const row of rows) {
    if (!row.symbol || !Number.isFinite(Date.parse(row.asOf))) throw new Error('历史画像缺少 symbol/asOf');
    (out[row.symbol] ||= []).push(row);
  }
  for (const xs of Object.values(out)) xs.sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return out;
}
export async function replay({ config, strategyId, symbol, file, params, execution, costs,
  from, to, rules = [], keepTrades = true, confirmation = null }) {
  const def = getStrategy(strategyId);
  if (!def) throw new Error(`未知策略 ${strategyId}`);
  params = validateParams(def, params); execution ||= config.execution; costs ||= config.costs;
  validateExecution(execution, costs);
  const profiles = readProfiles(config);
  if (def.prefilter && params.marketUniverseEnabled !== false && !profiles)
    return { strategyId, symbol, period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      params, execution, costs, coverage: null, status: 'excluded', reason: 'historical_market_profiles_missing',
      metrics: null, trades: [], featureSamples: [] };
  const loaded = await dataset(file, config), base = loaded.data;
  const dataCoverage = coverage(base, config, loaded.quality);
  const result = { strategyId, symbol, period: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    params, execution, costs, coverage: dataCoverage, status: 'ok', metrics: null, trades: [], featureSamples: [] };
  if (!dataCoverage.eligible) return { ...result, status: 'excluded', reason: dataCoverage.reason };
  const interval = def.planInterval || '1m', decisionMs = duration(interval) * execution.decisionEveryBars;
  const primaryWindow = def.engine === 'enhanced' ? Math.max(def.marketWindow, enhancedWindowBars(params)) : def.marketWindow;
  const neededTFs = new Set(['1m', interval, ...def.needsAux, config.features.interval]);
  for (const tf of neededTFs) if (!loaded.intervals.has(tf)) loaded.intervals.set(tf, resample(base, tf));
  const confirm = createConfirmationGate({ confirmation, loaded, symbol, costs, execution,
    profileAt: time => profilesAt(profiles, symbol, time, config.data.profileMaxAgeDays * DAY) });
  const simulator = new TradingSimulator({ mode: 'account', unlimitedCapital: false, initialBalance: execution.initialBalance,
    enableLiquidation: execution.enableLiquidation, enableIsolatedMargin: execution.enableIsolatedMargin,
    enableDynamicProtection: execution.enableDynamicProtection, pendingOrderTtlMs: execution.pendingMinutes * MINUTE, costs });
  const start = base.lowerBound(from), end = base.lowerBound(to), trades = [], monthly = {};
  if (end <= start) return { ...result, status: 'excluded', reason: 'no_data_in_segment' };
  const funnel = { decisions: 0, insufficient: 0, analyzed: 0, signals: 0, featureRejected: 0,
    profileRejected: 0, profileMissing: 0, orders: 0, expired: 0, riskRejected: 0, cancelledAtEnd: 0,
    confirmationRejected: 0, confirmationUnavailable: 0 };
  let order = null, realized = 0, peak = execution.initialBalance, drawdown = 0, cooldownUntil = -Infinity;
  let day = -1, dailyOpening = execution.initialBalance, dailyRealized = 0, losses = 0, activeMinutes = 0;
  let firstEquity = execution.initialBalance, analysisErrors = 0, firstError = null;
  let featureTime = -Infinity, featureMarket = null, features = null;
  let monthKey = null, monthEnd = -Infinity;
  const equityOf = () => {
    if (!order?.entry) return execution.initialBalance + realized;
    const totalQty = Number(order.quantity || 0) + Number(order.realizedQty || 0);
    const remainingShare = totalQty > 0 ? order.quantity / totalQty : 1;
    return execution.initialBalance + realized + Number(order.realizedNet || 0) + Number(order.unrealized || 0)
      - Number(order.entryFee || 0) * remainingShare;
  };
  const recordEquity = (time, price) => {
    const equity = equityOf(); peak = Math.max(peak, equity);
    if (peak > 0) drawdown = Math.max(drawdown, (peak - equity) / peak);
    if (monthKey === null || time - 1 >= monthEnd) {
      const date = new Date(time - 1);
      monthKey = date.toISOString().slice(0, 7);
      monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    const key = monthKey;
    monthly[key] ||= { startEquity: firstEquity, endEquity: equity, lastPrice: price };
    monthly[key].endEquity = equity; monthly[key].lastPrice = price; firstEquity = equity;
  };
  const close = time => {
    if (!Number.isFinite(order.net)) throw new Error('撮合引擎返回无效净收益');
    realized += order.net; dailyRealized += order.net;
    losses = order.net < 0 ? losses + 1 : 0;
    const stop = ['stop_loss', 'liquidation'].includes(order.reason);
    cooldownUntil = time + (stop ? execution.stopCooldownMinutes : execution.cooldownMinutes) * MINUTE;
    trades.push({ symbol, strategyId, direction: order.direction, createdAt: order.createdAt,
      entryAt: order.entryAt, exitAt: order.exitAt, entry: order.entry, exit: order.exit, margin: order.margin,
      leverage: order.leverage, notional: order.notional, net: order.net, roi: order.roi,
      gross: order.gross, fees: order.fees ?? order.fee, funding: order.funding, reason: order.reason,
      periodEnd: order.periodEnd || false, ambiguousBar: order.ambiguousBar || false,
      partialFills: order.partialFills ?? order.tpStage ?? 0, features: order.features,
      featureAsOf: order.featureAsOf, entryPlan: order.initialPlan, ...(confirm ? { confirmation: order.confirmation } : {}) });
    order = null;
  };
  for (let i = start; i < end; i++) {
    // With no order, a native 4h/15m strategy cannot change equity or act between decisions.
    // Active and pending orders still receive every one-minute candle from the shared simulator.
    if (!order && decisionMs > MINUTE) {
      const nextDecision = Math.ceil((base.time(i) + MINUTE) / decisionMs) * decisionMs;
      i = base.lowerBound(nextDecision - MINUTE);
      if (i >= end) break;
    }
    const row = base.at(i), time = row.openTime + MINUTE;
    if (i > start && row.openTime !== base.time(i - 1) + MINUTE && order) {
      // Never carry a position across unknown prices: settle at the last observed close and flag the run.
      if (order.entry) { settlePaperOrder(order, base.at(i - 1).close, 'data_gap', base.time(i - 1) + MINUTE); order.reason = 'data_gap'; close(base.time(i - 1) + MINUTE); }
      else { order = null; funnel.expired++; }
      result.status = 'data_gap';
    }
    const currentDay = Math.floor(row.openTime / DAY);
    if (currentDay !== day) { day = currentDay; dailyOpening = equityOf(); dailyRealized = 0; losses = 0; }
    if (order) {
      if (order.entry) activeMinutes++;
      if (!order.entry && row.openTime >= order.pendingDeadline) { order = null; funnel.expired++; }
      else {
        const smart = order.plan.exitRules?.smartExit || order.plan.smartExit;
        const needsHistory = smart && smart.barLevelEnabled !== false && smart.barLevel !== false;
        const rows = needsHistory ? base.slice(Math.max(0, i - Math.max(80, Number(smart.maPeriod) + 2, Number(smart.atrPeriod) + 2)), i + 1) : [row];
        const evaluated = simulator.evaluate(order, rows, time);
        Object.assign(order, evaluated);
        if (order.status === 'closed') close(time);
        else if (order.status === 'expired') { order = null; funnel.expired++; }
        else if (order.status === 'data_gap') throw new Error(`撮合遇到未处理的数据缺口 ${evaluated.missingAt}`);
      }
    }
    recordEquity(time, row.close);
    if (order?.status === 'open' && time % (duration(interval) * execution.reviewEveryBars) === 0 && execution.enableDynamicProtection) {
      const reviewMarket = market(symbol, interval, loaded.intervals.get(interval), time,
        def.marketWindows?.[interval] || def.marketWindow);
      if (reviewMarket) {
        const heldNative = Math.floor(order.heldBars * MINUTE / duration(interval));
        const proposal = await def.review({ ...order, heldBars: heldNative }, reviewMarket,
          { params, config: {}, planInterval: interval });
        if (proposal?.action === 'CLOSE') { settlePaperOrder(order, row.close, proposal.reason || 'smart_exit', time); close(time); recordEquity(time, row.close); }
        else if (proposal) applyPaperProtectionReview(order, proposal, time, def.engine);
      }
    }
    if (time >= to || time % decisionMs !== 0 || order || time < cooldownUntil) continue;
    funnel.decisions++;
    const equity = equityOf();
    const dailyLimit = params.maxDailyLoss ?? execution.dailyLossPct;
    if (equity <= 0 || (dailyLimit > 0 && dailyRealized <= -dailyOpening * dailyLimit)
      || (execution.consecutiveLossLimit > 0 && losses >= execution.consecutiveLossLimit)) { funnel.riskRejected++; continue; }
    const primary = market(symbol, '1m', base, time, primaryWindow), auxMarkets = {};
    if (!primary) { funnel.insufficient++; continue; }
    let missing = false;
    for (const tf of def.needsAux) {
      auxMarkets[tf] = market(symbol, tf, loaded.intervals.get(tf), time, def.marketWindows?.[tf] || def.marketWindow);
      if (!auxMarkets[tf]) missing = true;
    }
    if (missing) { funnel.insufficient++; continue; }
    if (def.prefilter && params.marketUniverseEnabled !== false) {
      const profile = profilesAt(profiles, symbol, time, config.data.profileMaxAgeDays * DAY);
      if (!profile) { funnel.profileMissing++; continue; }
      const selected = await def.prefilter([symbol], { params, deps: { superAnalysis: { getMarketDataBatch: async () => [profile] } } });
      if (selected.unavailable || !(Array.isArray(selected) ? selected : selected.filtered)?.includes(symbol)) { funnel.profileRejected++; continue; }
    }
    const featureBoundary = Math.floor(time / duration(config.features.interval)) * duration(config.features.interval);
    if (featureBoundary !== featureTime) {
      featureTime = featureBoundary;
      featureMarket = market(symbol, config.features.interval, loaded.intervals.get(config.features.interval), time, config.features.lookbackBars);
      features = klineFeatures(featureMarket?.klines, config.features);
    }
    if (!matchFeatureRules(features, rules, config.features.missing).passed) { funnel.featureRejected++; continue; }
    const ctx = { params, costs, config: {}, interval: '1m', planInterval: def.planInterval,
      auxMarkets, skillContext: { requireFiveMinute: Boolean(params.requireFiveMinute ?? def.marketContext?.requireFiveMinute) },
      account: { equity, available: equity }, deps: {} };
    let raw;
    try { raw = await def.analyze(primary, ctx); funnel.analyzed++; }
    catch (e) { analysisErrors++; firstError ||= e.message; continue; }
    if (!raw?.plan) continue;
    if (def.decoratePlan) raw = { ...raw, plan: def.decoratePlan(raw.plan, ctx) };
    const planMarket = interval === '1m' ? primary : auxMarkets[interval]
      || market(symbol, interval, loaded.intervals.get(interval), time, def.marketWindows?.[interval] || def.marketWindow);
    if (!planMarket) { funnel.insufficient++; continue; }
    const signal = normalizePlan(raw, planMarket, time, costs,
      { maxHoldBarsLimit: Math.max(120, def.paramSchema.find(p => p.key === 'maxHoldBars')?.max || 120) });
    if (!signal.eligible) continue;
    funnel.signals++;
    const confirmationResult = confirm ? await confirm(time, signal.positionRecommendation) : null;
    if (confirmationResult?.members.some(m => m.unavailable)) funnel.confirmationUnavailable++;
    if (confirmationResult && !confirmationResult.passed) { funnel.confirmationRejected++; continue; }
    const plan = { ...raw.plan, ...signal.plan }, long = signal.positionRecommendation === 'OPEN_LONG';
    const price = plan.entryLimit || (long ? plan.entryMax : plan.entryMin);
    const leverage = Math.max(1, Math.min(execution.maxLeverage, params.maxLeverage ?? execution.maxLeverage,
      execution.leverage ?? raw.plan.recommendedLeverage ?? signal.recommendedLeverage ?? 1));
    const strategyPct = execution.respectStrategySizing ? params.autoMarginPct ?? execution.marginPct : execution.marginPct;
    const riskPct = execution.respectStrategySizing ? params.riskPerTrade ?? execution.riskPct : execution.riskPct;
    const stopPct = Math.abs(price - plan.stopLoss) / price;
    let margin = execution.fixedMargin ?? equity * strategyPct;
    margin = Math.min(margin, equity * riskPct / Math.max(stopPct * leverage, 1e-12), equity / (1 + leverage * costs.feeBps * 2 / 10000));
    if (!(margin > 0.01) || margin + margin * leverage * costs.feeBps * 2 / 10000 > equity + 1e-8) { funnel.riskRejected++; continue; }
    // The native plan's holding period is preserved while fills use the shared one-minute engine.
    plan.maxHoldBars *= duration(interval) / MINUTE;
    order = { id: `${strategyId}:${symbol}:${time}`, symbol, strategyId, direction: signal.positionRecommendation,
      interval: '1m', status: 'pending', plan, initialPlan: structuredClone(plan), costs: { ...costs },
      createdAt: new Date(time).toISOString(), nextTime: time, margin, leverage, notional: margin * leverage,
      pendingDeadline: time + execution.pendingMinutes * MINUTE, protectionRevisions: [], reviewHistory: [],
      features, featureAsOf: featureMarket?.dataAsOf || null, ...(confirm ? { confirmation: confirmationResult } : {}) };
    funnel.orders++;
  }
  if (order?.entry) { const lastTime = base.time(end - 1) + MINUTE; settlePaperOrder(order, base.at(end - 1).close, 'backtest_period_end', lastTime); order.periodEnd = true; order.reason = 'backtest_period_end'; close(lastTime); recordEquity(lastTime, base.at(end - 1).close); }
  else if (order) { funnel.cancelledAtEnd++; order = null; }
  result.funnel = funnel;
  result.metrics = tradeMetrics(trades, execution.initialBalance, execution.initialBalance + realized, drawdown);
  result.metrics.exposure = activeMinutes / Math.max(1, end - start);
  result.monthly = Object.fromEntries(Object.entries(monthly).map(([k, v]) => [k,
    { ...v, returnRate: v.startEquity > 0 ? v.endEquity / v.startEquity - 1 : null }]));
  result.featureSamples = trades.filter(t => t.features).map(t => ({ symbol, net: t.net, features: t.features, asOf: t.featureAsOf }));
  result.trades = keepTrades ? trades : [];
  result.analysisErrors = analysisErrors; result.firstError = firstError;
  if (analysisErrors) result.status = 'analysis_error';
  if (!result.metrics.trades && funnel.insufficient === funnel.decisions) { result.status = 'excluded'; result.reason = 'insufficient_indicator_warmup'; }
  return result;
}
