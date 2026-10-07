import { getStrategy } from '../../server/strategies/index.js';
import { normalizePlan } from '../../server/research.js';
import { duration, validateParams, hash } from './config.mjs';
import { resample, closedWindow } from './data.mjs';

export function validateConfirmation(value) {
  if (value == null) return null;
  if (!['all', 'any', 'atLeast', 'audit'].includes(value.mode)) throw new Error('confirmation.mode 必须为 all/any/atLeast/audit');
  if (!Array.isArray(value.members) || !value.members.length) throw new Error('确认策略不能为空');
  const ids = new Set();
  const members = value.members.map(m => {
    const def = getStrategy(m.strategyId);
    if (!def || def.id === 'enhanced-trend-v1' || ids.has(def.id)) throw new Error(`确认策略未知、重复或与执行策略相同：${m.strategyId}`);
    ids.add(def.id);
    const lookbackBars = m.lookbackBars ?? 0, minScore = m.minScore ?? 0;
    if (!Number.isInteger(lookbackBars) || lookbackBars < 0 || lookbackBars > 100) throw new Error('确认 lookbackBars 必须为 0~100 整数');
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw new Error('确认 minScore 必须为 0~100');
    return { strategyId: def.id, params: validateParams(def, m.params || {}), lookbackBars, minScore };
  });
  const minMatches = value.mode === 'all' ? members.length : value.mode === 'atLeast' ? value.minMatches : 1;
  if (!Number.isInteger(minMatches) || minMatches < 1 || minMatches > members.length) throw new Error('minMatches 超出确认策略数');
  return { mode: value.mode, minMatches, members };
}

// Only closed native candles are inspected. A 4h signal first exists at its close;
// lookbackBars=0 holds that observation until the next native candle closes.
export function createConfirmationGate({ confirmation, loaded, symbol, costs, execution, profileAt }) {
  const recipe = validateConfirmation(confirmation);
  if (!recipe) return null;
  loaded.confirmationCaches ||= new Map();
  const states = recipe.members.map(member => {
    const def = getStrategy(member.strategyId), tf = def.planInterval || '1m';
    for (const interval of ['1m', tf, ...def.needsAux]) {
      if (!loaded.intervals.has(interval)) loaded.intervals.set(interval, resample(loaded.data, interval));
    }
    const key = hash({ id: def.id, params: member.params, costs, balance: execution.initialBalance });
    if (!loaded.confirmationCaches.has(key)) {
      // Bound memory when a worker searches many confirmation parameter sets.
      if (loaded.confirmationCaches.size >= 48) loaded.confirmationCaches.delete(loaded.confirmationCaches.keys().next().value);
      loaded.confirmationCaches.set(key, new Map());
    }
    return { member, def, tf, ms: duration(tf), cache: loaded.confirmationCaches.get(key) };
  });
  const getMarket = (tf, time, count) => {
    const klines = closedWindow(loaded.intervals.get(tf), tf, time, count);
    return klines ? { symbol, exchange: 'binance', marketProvider: 'binance', interval: tf,
      dataAsOf: new Date(Math.floor(time / duration(tf)) * duration(tf)).toISOString(), klines } : null;
  };
  async function observation(state, time) {
    if (state.cache.has(time)) return state.cache.get(time);
    const { def, member, tf } = state, params = member.params;
    const row = { asOf: new Date(time).toISOString(), eligible: false, direction: null, score: null, unavailable: null };
    const primary = getMarket('1m', time, def.marketWindow), auxMarkets = {};
    for (const interval of def.needsAux) auxMarkets[interval] = getMarket(interval, time, def.marketWindows?.[interval] || def.marketWindow);
    if (!primary || Object.values(auxMarkets).some(m => !m)) row.unavailable = 'insufficient_closed_history';
    else if (def.prefilter && params.marketUniverseEnabled !== false) {
      const profile = profileAt?.(time);
      if (!profile) row.unavailable = 'historical_market_profiles_missing';
      else {
        const selection = await def.prefilter([symbol], { params, deps: { superAnalysis: { getMarketDataBatch: async () => [profile] } } });
        if (selection.unavailable) row.unavailable = 'historical_market_profiles_unavailable';
        else if (!(Array.isArray(selection) ? selection : selection.filtered)?.includes(symbol)) row.unavailable = 'historical_profile_rejected';
      }
    }
    if (!row.unavailable) {
      const ctx = { params, costs, config: {}, interval: '1m', planInterval: tf, auxMarkets,
        skillContext: { requireFiveMinute: Boolean(params.requireFiveMinute ?? def.marketContext?.requireFiveMinute) },
        account: { equity: execution.initialBalance, available: execution.initialBalance }, deps: {} };
      let raw = await def.analyze(primary, ctx);
      if (raw?.plan) {
        if (def.decoratePlan) raw = { ...raw, plan: def.decoratePlan(raw.plan, ctx) };
        const planMarket = tf === '1m' ? primary : auxMarkets[tf] || getMarket(tf, time, def.marketWindows?.[tf] || def.marketWindow);
        if (planMarket) {
          const signal = normalizePlan(raw, planMarket, time, costs,
            { maxHoldBarsLimit: Math.max(120, def.paramSchema.find(p => p.key === 'maxHoldBars')?.max || 120) });
          row.eligible = signal.eligible;
          row.direction = signal.positionRecommendation;
          const score = raw.score ?? raw.entryQuality ?? raw.plan.trendStrengthScore ?? raw.confidence * 100;
          row.score = Number.isFinite(score) ? score : null;
        }
      }
    }
    state.cache.set(time, row);
    return row;
  }
  return async (time, direction) => {
    const members = [];
    for (const state of states) {
      const boundary = Math.floor(time / state.ms) * state.ms;
      let match = null, last = null;
      for (let age = 0; age <= state.member.lookbackBars; age++) {
        const row = await observation(state, boundary - age * state.ms);
        last ||= row;
        if (row.eligible && row.direction === direction && (state.member.minScore === 0 || row.score >= state.member.minScore)) {
          match = { ...row, ageBars: age }; break;
        }
      }
      members.push({ strategyId: state.def.id, matched: Boolean(match), ...(match || last) });
    }
    const matched = members.filter(m => m.matched).length;
    return { passed: recipe.mode === 'audit' || matched >= recipe.minMatches, matched, members };
  };
}

export function overlap(rows, strategyId) {
  const trades = rows.filter(r => r.status === 'ok').flatMap(r => r.trades || []);
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net < 0);
  const matched = t => t.confirmation?.members.find(m => m.strategyId === strategyId)?.matched === true;
  const sum = xs => xs.reduce((s, t) => s + t.net, 0), ratio = (n, d) => d ? n / d : null;
  const profitableCoins = rows.filter(r => r.status === 'ok' && r.metrics?.net > 0);
  const coinsWithWinningMatch = profitableCoins.filter(r => r.trades.some(t => t.net > 0 && matched(t)));
  return { strategyId, trades: trades.length, matchedTrades: trades.filter(matched).length,
    winningTrades: wins.length, retainedWins: wins.filter(matched).length,
    winningTradeCoverage: ratio(wins.filter(matched).length, wins.length),
    losingTrades: losses.length, rejectedLosses: losses.filter(t => !matched(t)).length,
    losingTradeRejection: ratio(losses.filter(t => !matched(t)).length, losses.length),
    retainedWinningNet: sum(wins.filter(matched)), missedWinningNet: sum(wins.filter(t => !matched(t))),
    rejectedLosingNet: sum(losses.filter(t => !matched(t))),
    profitableCoins: profitableCoins.length, profitableCoinsWithWinningMatch: coinsWithWinningMatch.length,
    profitableCoinCoverage: ratio(coinsWithWinningMatch.length, profitableCoins.length),
    everyWinningTradeMatched: wins.length ? wins.every(matched) : null,
    mostWinningTradesMatched: wins.length ? wins.filter(matched).length > wins.length / 2 : null,
    unavailableTrades: trades.filter(t => t.confirmation?.members.find(m => m.strategyId === strategyId)?.unavailable).length,
    interpretation: '盈利币种覆盖=该盈利币种至少一笔盈利交易入场决策时通过同向确认；交易重叠是描述统计，过滤后收益须独立重新撮合。' };
}
