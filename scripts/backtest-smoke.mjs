/** Offline integrity checks for the Node backtest pipeline; no exchange orders or live config writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TradingSimulator } from '../server/tradingSimulator.js';
import { getStrategy, listStrategies } from '../server/strategies/index.js';
import { normalizePlan } from '../server/research.js';
import { CandleSeries, readCandles, resample, closedWindow, findFiles } from './backtest/data.mjs';
import { loadConfig, validateParams, writeJSON, DAY, MINUTE } from './backtest/config.mjs';
import { summarize, objective, learnFeatures } from './backtest/stats.mjs';
import { candidateRound, trialId, spaceFor } from './backtest/search.mjs';
import { klineFeatures, matchFeatureRules } from '../shared/strategyFeatureFilter.js';
import { backtestEntryFilter } from '../server/shared/backtestFeatureFilters.js';
import { enhancedWindowBars } from '../server/enhancedAnalysis.js';
import { assessDeployment } from './backtest/deployment.mjs';

const directory = path.resolve('output/backtest-integrity-smoke');
fs.mkdirSync(directory, { recursive: true });
const origin = Date.parse('2025-01-01T00:00:00Z'), series = new CandleSeries(4);
for (let i = 0; i < 240; i++) series.push([origin + i * MINUTE, 100 + i, 101 + i, 99 + i, 100.5 + i, i + 1, (i + 1) * 100, 3, 1, 100]);
const h1 = resample(series, '1h');
assert.equal(h1.length, 4); assert.equal(h1.at(0).open, 100); assert.equal(h1.at(0).close, 159.5);
assert.equal(h1.at(0).volume, 1830);
assert.equal(closedWindow(h1, '1h', origin + 59 * MINUTE, 1), null);
assert.equal(closedWindow(h1, '1h', origin + 60 * MINUTE, 1).at(-1).close, 159.5);
assert.equal(closedWindow(h1, '1h', origin + 119 * MINUTE, 1).at(-1).close, 159.5);
const broken = new CandleSeries(4);
for (let i = 0; i < series.length; i++) if (i !== 20) broken.push(series.columns.map(c => c[i]));
assert.equal(resample(broken, '1h').length, 3, 'incomplete hour must not become a candle');
const file = path.join(directory, 'fixture.ndjson');
fs.writeFileSync(file, 'open_time,open,high,low,close,volume\n' + `${origin},100,102,99,101,1\n${origin + MINUTE},101,103,100,102,2,${origin + 2 * MINUTE - 1},204,4,1,102,0\n`);
const loaded = await readCandles(file);
assert.equal(loaded.data.length, 2); assert.equal(loaded.quality.quoteRows, 1);
assert.equal(loaded.data.at(1).quoteVolume, 204); assert.ok(Number.isNaN(loaded.data.at(0).quoteVolume));
assert.equal(loaded.quality.availableRows.tradeCount, 1);
assert.ok(enhancedWindowBars({ macdSlowPeriod: 78, macdSignalPeriod: 78 }) >= 155);
assert.equal(summarize([{ status: 'excluded' }]).meanReturn, null, 'missing data must not look like zero profit');
assert.equal(objective(summarize([{ status: 'excluded' }]), { minTrades: 1 }), null);
const params = validateParams(getStrategy('h4-mean-reversion-v1'), { stopAtr: 1.5 });
assert.throws(() => validateParams(getStrategy('h4-mean-reversion-v1'), { wrongParameter: 1 }));
assert.throws(() => validateParams(getStrategy('h4-mean-reversion-v1'), { longOnly: 'false' }));
assert.throws(() => loadConfig(null, { data: { allowPartialHistory: 'false' } }));
const unicodeDirectory = path.join(directory, 'unicode');
fs.mkdirSync(path.join(unicodeDirectory, 'klines'), { recursive: true });
fs.writeFileSync(path.join(unicodeDirectory, 'klines', '币安人生USDT.ndjson'), '');
assert.ok(findFiles(loadConfig(null, { data: { symbols: ['币安人生USDT'], directory: unicodeDirectory, legacyDirectories: [] } })).has('币安人生USDT'));
assert.throws(() => validateParams(getStrategy('h4-mean-reversion-v1'), { meanPeriod: 1.5 }));
assert.throws(() => loadConfig(null, { optimization: { trainFraction: 0.8, validationFraction: 0.3 } }));
assert.throws(() => loadConfig(null, { data: { unrelatedKey: 'never-write-this-value' } }), /未知配置项/);
const plan = { entryStyle: 'market', entryMin: 100, entryMax: 101, stopLoss: 99, takeProfit: 108, maxHoldBars: 200 };
const signalMarket = { symbol: 'BTCUSDT', interval: '1m', dataAsOf: new Date(origin).toISOString() };
const raw = { action: 'BUY', confidence: 0.8, plan };
assert.equal(normalizePlan(raw, signalMarket, origin).eligible, false);
assert.equal(normalizePlan(raw, signalMarket, origin, { feeBps: 0, slippageBps: 0, fundingBpsPer8h: 0 }, { maxHoldBarsLimit: 480 }).eligible, true);
const pending = { symbol: 'BTCUSDT', direction: 'OPEN_LONG', interval: '1m', createdAt: new Date(origin).toISOString(),
  nextTime: origin + 2 * MINUTE, notional: 100, margin: 100, leverage: 1,
  costs: { feeBps: 0, slippageBps: 0, fundingBpsPer8h: 0 }, plan };
const simulator = new TradingSimulator({ pendingOrderTtlMs: 2 * MINUTE });
assert.equal(simulator.evaluate(pending, [], origin + 3 * MINUTE).status, 'expired');
assert.equal(new TradingSimulator().config.pendingOrderTtlMs, DAY);
const features = klineFeatures(series.slice(0, 100), { lookbackBars: 72, trendBars: 24, atrPeriod: 14, volumePeriod: 20 });
assert.ok(features.trendReturn > 0); assert.equal(features.trendEfficiency, 1);
assert.equal(matchFeatureRules(features, [{ feature: 'atrPct', min: 0, max: 1 }]).passed, true);
assert.equal(matchFeatureRules(null, [{ feature: 'atrPct', min: 0, max: 1 }]).passed, false);
assert.throws(() => matchFeatureRules(features, [{ feature: 'fake', min: 0, max: 1 }]));
const training = Array.from({ length: 10 }, (_, i) => ({ symbol: `C${i}`, status: 'ok', metrics: { trades: 10, net: i < 5 ? 10 : -10 },
  featureSamples: [{ features: { atrPct: i < 5 ? 0.01 + i / 10000 : 0.04 + i / 10000 } }] }));
const learned = learnFeatures(training, { minCoinsPerGroup: 5, minTradesPerCoin: 5, minEffect: 0.25, lowerQuantile: 0.1, upperQuantile: 0.9, maxRules: 1 });
assert.equal(learned.rules[0].feature, 'atrPct'); assert.ok(learned.rules[0].max < 0.02);
const profileFile = path.join(directory, 'profiles.json');
writeJSON(profileFile, { strategies: { 'h4-mean-reversion-v1': { enabled: true, rules: learned.rules,
  featureConfig: { interval: '1h', lookbackBars: 72 } } } });
assert.equal(backtestEntryFilter({}, 'h4-mean-reversion-v1'), null);
assert.equal(backtestEntryFilter({ analysis: { backtestFeatureFilters: { enabled: true, file: profileFile } } }, 'h4-mean-reversion-v1').rules.length, 1);
const config = loadConfig(null, { optimization: { autoSpace: false, method: 'grid', trialsPerRound: 2 },
  strategies: { 'h4-mean-reversion-v1': { searchSpace: { stopAtr: [1.2, 1.5, 1.8] } } } });
const base = { params, execution: config.execution, costs: config.costs }, space = spaceFor(getStrategy('h4-mean-reversion-v1'), base, config), seen = new Set();
const a = candidateRound(base, base, space, config.optimization, 0, seen); a.forEach(t => seen.add(trialId(t)));
const b = candidateRound(base, base, space, config.optimization, 1, seen);
assert.equal(new Set([...a, ...b].map(t => t.params.stopAtr)).size, 3);
const oneOptions = { ...config.optimization, trialsPerRound: 1 }, oneSeen = new Set(), oneTrials = [];
for (let round = 0; round < 4; round++) {
  const next = candidateRound(base, base, space, oneOptions, round, oneSeen);
  next.forEach(t => { oneSeen.add(trialId(t)); oneTrials.push(t); });
}
assert.equal(new Set(oneTrials.map(t => t.params.stopAtr)).size, 3);
assert.equal(listStrategies().length, 7);
const candidateRows = Array.from({ length: 10 }, (_, i) => ({ symbol: `C${i}`, status: 'ok', coverage: { coverage: 1 },
  metrics: { trades: 20, wins: 12, net: 10, returnRate: 0.1, maxDrawdown: 0.05, grossProfit: 20, grossLoss: 10 } }));
const oldRows = candidateRows.map(r => ({ ...r, metrics: { ...r.metrics, net: 2, returnRate: 0.02 } }));
const deployReport = { selectionStatus: 'best_within_search_budget', bestParameters: { params: { stopAtr: 2 }, execution: {}, costs: {} },
  baseline: { parameters: { params: { stopAtr: 1.5 }, execution: {}, costs: {} },
    coins: oldRows.map(r => ({ symbol: r.symbol, validation: r, test: r })) },
  filter: { appliedRules: [] }, summary: { test: { errorCoins: 0 }, full: { errorCoins: 0 } },
  periods: { test: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' } },
  coins: candidateRows.map(r => ({ symbol: r.symbol, validation: r, test: r })) };
assert.equal(assessDeployment(deployReport).eligible, true);
deployReport.coins[0].test = { ...candidateRows[0], metrics: { ...candidateRows[0].metrics, maxDrawdown: 0.4 } };
assert.equal(assessDeployment(deployReport).eligible, false);
assert.ok(assessDeployment(deployReport).reasons.includes('test_drawdown_limit'));
deployReport.coins[0].test = candidateRows[0];
// Mature coins remain profitable, while a partial-history coin makes the complete universe lose.
const recentLoss = { symbol: 'RECENTUSDT', status: 'ok', coverage: { coverage: 0.5 },
  metrics: { trades: 200, wins: 0, net: -1000, returnRate: -2, maxDrawdown: 0.2, grossProfit: 0, grossLoss: 1000 } };
deployReport.coins.push({ symbol: recentLoss.symbol, validation: recentLoss, test: recentLoss });
const wholeUniverseDecision = assessDeployment(deployReport);
assert.equal(wholeUniverseDecision.eligible, false);
assert.ok(wholeUniverseDecision.comparisons.test.candidate.meanReturn > 0);
assert.ok(wholeUniverseDecision.reasons.includes('test_overall_not_profitable'));
assert.ok(wholeUniverseDecision.reasons.includes('test_overall_profit_factor_below_threshold'));
console.log('通过：闭合周期/无未来K线/缺口/完整字段/未知参数/期限/成本/缺失指标/训练特征/运行时筛选/网格续轮。');
