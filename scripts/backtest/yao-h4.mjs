import { getStrategy } from '../../server/strategies/index.js';
import { TradingSimulator } from '../../server/tradingSimulator.js';
import { normalizePlan } from '../../server/research.js';
import { settlePaperOrder } from '../../server/simulatedAccount.js';
import { applyPaperProtectionReview } from '../../server/shared/protectionReview.js';
import { buildYaoAmbushTicker } from '../../server/yaoCoinAmbushAnalysis.js';
import { extractYaoCoinFeatures, scoreYaoCoinFeatures } from '../../server/yaoCoinPrediction.js';
import { readCandles, resample, closedWindow, coverage } from './data.mjs';
import { MINUTE, DAY, duration, validateParams, hash } from './config.mjs';
import { tradeMetrics } from './stats.mjs';

export const MAIN = 'yao-coin-ambush-v1', FILTER = 'h4-trend-breakout-v1';

export function validateTrial(trial) {
  const params = validateParams(getStrategy(MAIN), trial.params);
  if (params.marketUniverseEnabled) throw new Error('本研究是明确关闭市值候选池的 K 线消融；不能冒充完整策略');
  if (!['trend', 'signal', 'none'].includes(trial.filter.mode)) throw new Error('filter.mode 必须为 trend/signal/none');
  const hp = validateParams(getStrategy(FILTER), trial.filter.params || {});
  if (hp.emaFast >= hp.emaSlow) throw new Error('4H 快线必须小于慢线');
  const lookbackBars = trial.filter.lookbackBars ?? 0;
  if (!Number.isInteger(lookbackBars) || lookbackBars < 0 || lookbackBars > 3) throw new Error('4H 回看根数必须为 0~3');
  return { params, filter: { mode: trial.filter.mode, params: hp, lookbackBars } };
}

export function trendMatches(metrics, direction, p) {
  if (!metrics || ![metrics.price, metrics.emaFast, metrics.emaSlow, metrics.atrPct, metrics.spreadAtr].every(Number.isFinite)) return false;
  if (metrics.atrPct < p.minAtrPct || metrics.atrPct > p.maxAtrPct) return false;
  const long = direction === 'OPEN_LONG';
  if (long ? !(metrics.emaFast > metrics.emaSlow && metrics.price > metrics.emaSlow) : !(metrics.emaFast < metrics.emaSlow && metrics.price < metrics.emaSlow)) return false;
  if ((long ? metrics.spreadAtr : -metrics.spreadAtr) < p.trendSepAtr) return false;
  if (p.adxMin > 0 && (!Number.isFinite(metrics.adx) || metrics.adx < p.adxMin)) return false;
  if (p.volumeMult > 0 && (!Number.isFinite(metrics.volumeRatio) || metrics.volumeRatio < p.volumeMult)) return false;
  if (Number.isFinite(metrics.rsi) && (long ? metrics.rsi < p.rsiLongMin || metrics.rsi > p.rsiLongMax : metrics.rsi < p.rsiShortMin || metrics.rsi > p.rsiShortMax)) return false;
  return !(long ? p.shortOnly : p.longOnly);
}

function market(symbol, tf, series, time, count) {
  const klines = closedWindow(series, tf, time, count);
  // Older six-column caches have no quoteVolume. Missing values must be omitted,
  // so production's quoteVolume ?? volume fallback remains available.
  if (klines) for (const row of klines) if (!Number.isFinite(row.quoteVolume)) delete row.quoteVolume;
  return klines ? { symbol, interval: tf, marketProvider: 'binance', exchange: 'binance',
    dataAsOf: new Date(time).toISOString(), klines } : null;
}

// Necessary conditions use the same positive-volume rows as production. The
// legacy zero-prefix argument conservatively falls back for zero-volume windows.
export function fastMomentum(series, i, minimum, zeroPrefix) {
  if (i < 79) return false;
  if (zeroPrefix.validCount) {
    const end = zeroPrefix.validCount[i + 1], count = end - zeroPrefix.validCount[i - 79];
    if (count < 40) return false; // Native prediction requires 40 positive-volume rows.
    const last = zeroPrefix.validIndices[end - 1], previous = zeroPrefix.validIndices[end - 13];
    return Math.abs((series.columns[4][last] / series.columns[4][previous] - 1) * 100) + 1e-10 >= minimum;
  }
  if (zeroPrefix[i + 1] !== zeroPrefix[i - 79]) return true;
  return Math.abs((series.columns[4][i] / series.columns[4][i - 12] - 1) * 100) + 1e-10 >= minimum;
}

export function screenPrefixes(base) {
  const zero = new Uint32Array(base.length + 1), volume = new Float64Array(base.length + 1);
  const up = new Uint32Array(base.length + 1), down = new Uint32Array(base.length + 1);
  const validCount = new Uint32Array(base.length + 1), validIndices = new Uint32Array(base.length);
  let count = 0, sum = 0, compensation = 0;
  for (let i = 0; i < base.length; i++) {
    zero[i + 1] = zero[i] + (base.columns[5][i] <= 0 ? 1 : 0);
    if (base.columns[5][i] > 0) {
      validIndices[count] = i;
      const value = (Number.isFinite(base.columns[6][i]) ? base.columns[6][i] : base.columns[5][i]) - compensation;
      const next = sum + value; compensation = (next - sum) - value; sum = next;
      volume[count + 1] = sum;
      up[count + 1] = up[count] + (base.columns[4][i] > base.columns[1][i] ? 1 : 0);
      down[count + 1] = down[count] + (base.columns[4][i] < base.columns[1][i] ? 1 : 0);
      count++;
    }
    validCount[i + 1] = count;
  }
  return { zero, volume, up, down, validCount, validIndices };
}

export function necessaryActivity(base, i, minimumVolume, minimumConsistency, prefix) {
  if (i < 79) return false;
  const end = prefix.validCount[i + 1], count = end - prefix.validCount[i - 79];
  if (count < 40) return false;
  // Exact production windows: recent=12, preceding baseline up to31, including
  // recentStart. Kahan sums plus a conservative error guard protect boundaries.
  const baselineCount = Math.min(31, count - 12);
  const recent = (prefix.volume[end] - prefix.volume[end - 12]) / 12;
  const baseline = (prefix.volume[end - 12] - prefix.volume[end - 12 - baselineCount]) / baselineCount;
  const error = Number.EPSILON * Math.max(1, prefix.volume[end]) * 16;
  if (baseline > error && recent + error < minimumVolume * (baseline - error)) return false;
  const up = prefix.up[end] - prefix.up[end - 12], down = prefix.down[end] - prefix.down[end - 12];
  const consistency = up + down ? Math.abs(up - down) / (up + down) * 100 : 0;
  return consistency + 1e-10 >= minimumConsistency;
}

export async function simulateOpportunity({ base, symbol, time, until, signal, params, execution, costs }) {
  const def = getStrategy(MAIN), plan = structuredClone(signal.plan);
  const leverage = execution.leverage; // User's fixed leverage overrides advisory strategy maxLeverage.
  if (!Number.isInteger(leverage) || leverage !== execution.maxLeverage) throw new Error('研究要求固定杠杆');
  const simulator = new TradingSimulator({ mode: 'account', unlimitedCapital: false,
    initialBalance: 100, enableLiquidation: true, enableIsolatedMargin: true,
    enableDynamicProtection: execution.enableDynamicProtection,
    pendingOrderTtlMs: execution.pendingMinutes * MINUTE, costs });
  const order = { symbol, strategyId: MAIN, direction: signal.positionRecommendation, interval: '1m',
    status: 'pending', plan, initialPlan: structuredClone(plan), costs, createdAt: new Date(time).toISOString(),
    nextTime: time, margin: 1, leverage, notional: leverage, protectionRevisions: [], reviewHistory: [] };
  const marks = []; let markStart = null, terminal = time;
  const record = t => {
    if (order.status === 'closed') { markStart ??= t; marks.push(order.net); return; }
    if (!order.entry) return;
    markStart ??= t;
    const total = Number(order.quantity || 0) + Number(order.realizedQty || 0);
    marks.push(Number(order.realizedNet || 0) + Number(order.unrealized || 0)
      - Number(order.entryFee || 0) * (total > 0 ? order.quantity / total : 1));
  };
  for (let i = base.lowerBound(time); i < base.length && base.time(i) < until; i++) {
    const row = base.at(i), now = row.openTime + MINUTE;
    if (row.openTime !== terminal) {
      if (order.entry) { settlePaperOrder(order, base.at(i - 1).close, 'data_gap', terminal); marks[marks.length - 1] = order.net; }
      else { order.status = 'expired'; order.reason = 'data_gap'; }
      break;
    }
    if (!order.entry && row.openTime >= time + execution.pendingMinutes * MINUTE) {
      order.status = 'expired'; order.reason = 'pending_expired'; terminal = row.openTime; break;
    }
    Object.assign(order, simulator.evaluate(order, [row], now)); terminal = now;
    if (order.status === 'data_gap' || order.status === 'excluded') throw new Error(`无效撮合 ${symbol} ${order.status}`);
    if (order.status === 'open' && execution.enableDynamicProtection && now % (execution.reviewEveryBars * MINUTE) === 0) {
      const feed = market(symbol, '1m', base, now, def.marketWindow);
      if (feed) {
        const proposal = await def.review(order, feed, { params, config: {}, planInterval: '1m' });
        if (proposal?.action === 'CLOSE') settlePaperOrder(order, row.close, proposal.reason || 'smart_exit', now);
        else if (proposal) applyPaperProtectionReview(order, proposal, now, def.engine);
      }
    }
    record(now);
    if (['closed', 'expired'].includes(order.status)) break;
  }
  if (!['closed', 'expired'].includes(order.status)) {
    if (order.entry) {
      const i = base.lowerBound(terminal) - 1;
      settlePaperOrder(order, base.at(i).close, 'backtest_period_end', terminal);
      order.periodEnd = true; marks[marks.length - 1] = order.net;
    } else { order.status = 'expired'; order.reason = 'period_end_pending'; }
  }
  if (order.entry && !Number.isFinite(order.net)) throw new Error('无效盈亏');
  const price = plan.entryLimit || (signal.positionRecommendation === 'OPEN_LONG' ? plan.entryMax : plan.entryMin);
  return { symbol, time, end: terminal, direction: signal.positionRecommendation, score: signal.score ?? signal.confidence * 100,
    stopPct: Math.abs(price - plan.stopLoss) / price, leverage,
    filled: Boolean(order.entry), entryAt: order.entryAt, entry: order.entry ?? null, exit: order.exit ?? null,
    net: order.entry ? order.net : 0, gross: order.gross ?? 0, fees: order.fees ?? order.fee ?? 0,
    funding: order.funding ?? 0, reason: order.reason, periodEnd: order.periodEnd || false,
    ambiguousBar: order.ambiguousBar || false, markStart,
    tape: marks.length ? Buffer.from(Float64Array.from(marks).buffer).toString('base64') : '',
    prediction: { raw: signal.plan.yaoPrediction?.rawProbabilityPct, calibrated: signal.plan.yaoPrediction?.probabilityPct },
    plan: { entryLimit: price, stopLoss: signal.plan.stopLoss, takeProfit: signal.plan.takeProfit, maxHoldBars: params.maxHoldBars } };
}

export async function scanCoin({ file, symbol, config, trials, from, to, boundaries = [] }) {
  trials = trials.map(validateTrial);
  const loaded = await readCandles(file, from - config.period.warmupDays * DAY, to), base = loaded.data;
  const scanConfig = structuredClone(config);
  scanConfig.period.from = new Date(from).toISOString(); scanConfig.period.to = new Date(to).toISOString();
  const audit = coverage(base, scanConfig, loaded.quality);
  const opportunities = trials.map(() => []), funnel = { minutes: 0, momentum: 0, features: 0, signals: 0, passed: 0 };
  if (!audit.eligible) return { symbol, audit, opportunities, funnel };
  const def = getStrategy(MAIN), hdef = getStrategy(FILTER), aux = resample(base, '15m'), h4 = resample(base, '4h');
  const prefix = screenPrefixes(base);
  const lower = key => Math.min(...trials.map(t => t.params[key]));
  const minMomentum = lower('minRecentReturnPct'), costs = config.costs, execution = config.execution;
  const minVolume = lower('minVolumeRatio'), minConsistency = lower('minTrendConsistencyPct');
  const minAmplitude = lower('minCurrentAmplitudePct'), maxAmplitude = Math.max(...trials.map(t => t.params.maxCurrentAmplitudePct));
  const paramKeys = trials.map(t => hash(t.params)), filterKeys = new Map(trials.map(t => [t.filter, hash(t.filter.params)]));
  const hCache = new Map(), auxCache = new Map();
  async function hmatch(filter, time, direction) {
    if (filter.mode === 'none') return { passed: true, asOf: null };
    const boundary = Math.floor(time / duration('4h')) * duration('4h');
    for (let age = 0; age <= filter.lookbackBars; age++) {
      const at = boundary - age * duration('4h'), key = `${filterKeys.get(filter)}:${at}`;
      if (!hCache.has(key)) {
        const feed = market(symbol, '4h', h4, at, hdef.marketWindows['4h']);
        const primary = market(symbol, '1m', base, at, hdef.marketWindow);
        let raw = null, signal = null;
        if (feed && primary) {
          raw = await hdef.analyze(primary, { params: filter.params, costs, config: {}, auxMarkets: { '4h': feed },
            account: { equity: 100, available: 100 } });
          if (raw?.plan) signal = normalizePlan(raw, feed, at, costs, { maxHoldBarsLimit: 120 });
        }
        hCache.set(key, { raw, signal });
      }
      const { raw, signal } = hCache.get(key);
      const passed = filter.mode === 'trend' ? trendMatches(raw?.metrics, direction, filter.params)
        : signal?.eligible && signal.positionRecommendation === direction;
      if (passed) return { passed: true, asOf: at, age };
    }
    return { passed: false, asOf: boundary };
  }
  const end = base.lowerBound(to);
  for (let i = base.lowerBound(from); i < end; i++) {
    const time = base.time(i) + MINUTE;
    if (time >= to || time % (execution.decisionEveryBars * MINUTE)) continue;
    funnel.minutes++;
    if (!fastMomentum(base, i, minMomentum, prefix)) continue;
    funnel.momentum++;
    if (!necessaryActivity(base, i, minVolume, minConsistency, prefix)) continue;
    const primary = market(symbol, '1m', base, time, def.marketWindow);
    if (!primary) continue;
    const boundary = Math.floor(time / duration('15m')) * duration('15m');
    if (!auxCache.has(boundary)) {
      auxCache.clear(); auxCache.set(boundary, market(symbol, '15m', aux, time, def.marketWindows['15m']));
    }
    const auxMarket = auxCache.get(boundary);
    if (!auxMarket) continue;
    const ticker = buildYaoAmbushTicker(primary, auxMarket, 96);
    if (!ticker) continue;
    const amplitude = Math.max(Math.abs(ticker.priceChangePercent), (ticker.highPrice - ticker.lowPrice) / ticker.openPrice * 100);
    if (amplitude < minAmplitude || amplitude > maxAmplitude) continue;
    const features = extractYaoCoinFeatures(primary, ticker), scored = scoreYaoCoinFeatures(features);
    funnel.features++;
    if (features.volumeRatio < lower('minVolumeRatio') || features.rangeRatio < lower('minRangeRatio')
      || Math.abs(features.trendConsistencyPct) < lower('minTrendConsistencyPct') || scored.rawProbabilityPct < lower('minRawProbabilityPct')) continue;
    const direction = scored.direction === 'UP' ? 'OPEN_LONG' : 'OPEN_SHORT';
    const outcomes = new Map();
    for (let index = 0; index < trials.length; index++) {
      const trial = trials[index], p = trial.params;
      if (amplitude < p.minCurrentAmplitudePct || amplitude > p.maxCurrentAmplitudePct || scored.rawProbabilityPct < p.minRawProbabilityPct
        || features.volumeRatio < p.minVolumeRatio || features.rangeRatio < p.minRangeRatio || Math.abs(features.trendConsistencyPct) < p.minTrendConsistencyPct
        || (direction === 'OPEN_LONG' ? features.recentReturnPct < p.minRecentReturnPct || p.shortOnly : features.recentReturnPct > -p.minRecentReturnPct || p.longOnly)) continue;
      const filter = await hmatch(trial.filter, time, direction);
      if (!filter.passed) continue;
      const raw = await def.analyze(primary, { params: p, costs, config: {}, auxMarkets: { '15m': auxMarket },
        account: { equity: 100, available: 100 } });
      if (!raw?.plan) continue;
      const normalized = normalizePlan(raw, primary, time, costs, { maxHoldBarsLimit: 120 });
      if (!normalized.eligible) continue;
      funnel.signals++; funnel.passed++;
      const until = boundaries.find(b => b > time) ?? to;
      const key = paramKeys[index];
      if (!outcomes.has(key)) outcomes.set(key, await simulateOpportunity({ base, symbol, time, until,
        signal: { ...raw, ...normalized, plan: { ...raw.plan, ...normalized.plan } }, params: p, execution, costs }));
      opportunities[index].push({ ...outcomes.get(key), h4AsOf: filter.asOf, h4Age: filter.age });
    }
  }
  return { symbol, audit, opportunities, funnel };
}

// Counterfactual per-unit order tapes are consumed chronologically. Future fills,
// outcomes and marks NEVER participate in admission, ranking, sizing or risk checks.
// This is valid for this engine because fills/reviews/costs/isolated-loss caps are
// homogeneous in notional; scale equivalence is checked by the smoke script.
export function portfolio(opportunities, { execution, costs, capital, from, to }, keepTrades = true) {
  const candidates = opportunities.filter(o => o.time >= from && o.time < to)
    .sort((a, b) => a.time - b.time || b.score - a.score || a.symbol.localeCompare(b.symbol));
  const active = new Map(), cooldown = new Map(), trades = [], monthly = {}, curve = [];
  const initial = execution.initialBalance, maxPositions = capital.maxPositions;
  let cash = initial, peak = initial, maxDrawdown = 0, used = 0, index = 0, now = from;
  let day = Math.floor(from / DAY), dayOpening = initial, dayNet = 0, consecutiveLosses = 0;
  const rejected = {}, reject = reason => { rejected[reason] = (rejected[reason] || 0) + 1; };
  let placed = 0, expired = 0, maxConcurrent = 0, maxMarginRatio = 0, lastEquity = initial;
  const equity = () => cash + [...active.values()].reduce((s, a) => s + a.mark * a.margin, 0);
  const mark = t => {
    const e = equity(); peak = Math.max(peak, e); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - e) / peak : 0);
    const key = new Date(Math.max(from, t - 1)).toISOString().slice(0, 7);
    monthly[key] ||= { startEquity: lastEquity, endEquity: e };
    monthly[key].endEquity = e;
    lastEquity = e;
    if (!curve.length || t % DAY === 0 || t === to) curve.push({ time: t, equity: e });
  };
  while (index < candidates.length || active.size) {
    const nextCandidate = candidates[index]?.time ?? Infinity;
    const nextMark = active.size ? Math.min(...[...active.values()].map(a => a.next)) : Infinity;
    now = Math.min(nextCandidate, nextMark, to);
    if (!Number.isFinite(now)) break;
    if (Math.floor(now / DAY) !== day) { day = Math.floor(now / DAY); dayOpening = equity(); dayNet = 0; consecutiveLosses = 0; }
    for (const [symbol, a] of active) {
      if (a.next !== now) continue;
      const o = a.order;
      if (o.markStart != null && now >= o.markStart) {
        const k = Math.round((now - o.markStart) / MINUTE);
        if (k < a.marks.length) a.mark = a.marks[k];
      }
      if (now >= o.end) {
        active.delete(symbol); used -= a.reserved;
        if (o.filled) {
          const net = o.net * a.margin; cash += net; dayNet += net;
          consecutiveLosses = net < 0 ? consecutiveLosses + 1 : 0;
          const stop = ['stop_loss', 'liquidation', 'data_gap'].includes(o.reason);
          cooldown.set(symbol, now + (stop ? execution.stopCooldownMinutes : execution.cooldownMinutes) * MINUTE);
          const { tape, ...details } = o;
          trades.push({ ...details, createdAt: new Date(o.time).toISOString(), exitAt: new Date(o.end).toISOString(),
            margin: a.margin, notional: a.margin * o.leverage, net, gross: o.gross * a.margin,
            fees: o.fees * a.margin, funding: o.funding * a.margin });
        } else { expired++; cooldown.set(symbol, now + capital.pendingCooldownMinutes * MINUTE); }
      } else a.next = Math.min(o.end, now + MINUTE);
    }
    mark(now);
    if (now >= to) break;
    while (candidates[index]?.time === now) {
      const o = candidates[index++], e = equity();
      if (active.has(o.symbol)) { reject('symbol_busy'); continue; }
      if (now < (cooldown.get(o.symbol) ?? -Infinity)) { reject('cooldown'); continue; }
      if (active.size >= maxPositions) { reject('max_positions'); continue; }
      if (e <= 0 || (execution.dailyLossPct > 0 && dayNet <= -dayOpening * execution.dailyLossPct)
        || (execution.consecutiveLossLimit > 0 && consecutiveLosses >= execution.consecutiveLossLimit)) { reject('loss_circuit'); continue; }
      const reserveRatio = 1 + o.leverage * costs.feeBps * 2 / 10000;
      const free = Math.max(0, Math.min(cash, e) - used);
      const margin = Math.min(e * execution.marginPct, e * execution.riskPct / Math.max(o.stopPct * o.leverage, 1e-12),
        free / reserveRatio, Math.max(0, e * capital.maxMarginPct - used) / reserveRatio);
      if (margin < capital.minMargin || margin * o.leverage < capital.minNotional) { reject('insufficient_margin'); continue; }
      const bytes = Buffer.from(o.tape, 'base64'), marks = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const reserved = margin * reserveRatio;
      active.set(o.symbol, { order: o, margin, reserved, marks, mark: 0, next: Math.min(o.end, o.markStart ?? o.end) });
      used += reserved; placed++; maxConcurrent = Math.max(maxConcurrent, active.size);
      maxMarginRatio = Math.max(maxMarginRatio, used / e);
    }
  }
  mark(to);
  const metrics = tradeMetrics(trades, initial, cash, maxDrawdown);
  return { metrics, capital: { placed, expired, maxConcurrent, maxMarginRatio, rejected,
    liquidations: trades.filter(t => t.reason === 'liquidation').length },
    monthly: Object.fromEntries(Object.entries(monthly).map(([k, m]) => [k, { ...m, returnRate: m.endEquity / m.startEquity - 1 }])),
    equityCurve: curve, trades: keepTrades ? trades : [], accounting: '全部币种共享同一个资金池，按分钟盯市、比例复利，订单和费用复用 TradingSimulator' };
}
