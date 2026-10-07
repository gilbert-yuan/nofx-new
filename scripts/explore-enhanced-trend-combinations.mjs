import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listStrategies, getStrategy, loadConfiguredStrategy } from '../server/strategies/index.js';
import { abs, loadConfig, hash, writeJSON, validateParams, validateExecution, MINUTE } from './backtest/config.mjs';
import { findFiles, selectedSymbols, fileFingerprint } from './backtest/data.mjs';
import { ReplayPool } from './backtest/pool.mjs';
import { summarize, objective } from './backtest/stats.mjs';
import { spaceFor, candidateRound, random } from './backtest/search.mjs';
import { engineFingerprint } from './backtest/system.mjs';
import { validateConfirmation, overlap } from './backtest/confirmation.mjs';

const MAIN = 'enhanced-trend-v1';
export const DEFAULT_SEARCH = {
  seed: 20261007, mainTrials: 16, singleTrials: 8, pairTrials: 8, topMain: 3, topSingles: 3,
  strategyIds: 'disabled', modes: ['all', 'any'], lookbackBars: [0, 1, 3], minScores: [0, 60, 70],
  maxSymbols: 24, yaoKlineOnly: false,
  mainSpace: {
    minTrendScore: [60, 65, 70, 73, 78], minAtrPct: [0.001, 0.002, 0.004, 0.007],
    maxAtrPct: [0.012, 0.02, 0.035], minRsiLong: [45, 50, 55], minVolumeRatio: [0.6, 0.8, 1.2],
    trend15Enabled: [false, true], trend15EmaFast: [20, 32, 48], trend15EmaSlow: [64, 96, 144],
    trend15MinSepAtr: [0, 0.5, 1], pullbackAtrShallow: [0.8, 1.3, 1.9], pullbackAtrDeep: [1.5, 2.2, 2.8],
    mainTpR: [2, 3, 4], stopAtr: [1.5, 2, 2.5], maxHoldBars: [60, 120, 180],
    partialTpEnabled: [false, true], trailingTriggerR: [0.4, 0.7, 1]
  },
  confirmationSpaces: {
    'h4-trend-breakout-v1': { channelPeriod: [10, 20, 40], emaFast: [12, 20], emaSlow: [26, 50],
      breakoutBufAtr: [0, 0.05, 0.2], adxMin: [0, 15, 25], volumeMult: [0, 0.8, 1.2], trendSepAtr: [0, 0.5] },
    'h4-chandelier-breakout-v1': { channelPeriod: [20, 35, 55], emaFast: [12, 20], emaSlow: [50, 78],
      breakoutBufAtr: [0, 0.1, 0.25], adxMin: [0, 15, 20], volumeMult: [0, 0.8, 1.2], rsiLongMax: [80, 90, 100] },
    'h4-mean-reversion-v1': { meanPeriod: [12, 20, 35], entryExtAtr: [1, 1.5, 2.5],
      rsiOversold: [30, 40, 50], adxMax: [25, 50, 75], requireReversalCandle: [false, true],
      maxAtrPct: [0.035, 0.06, 0.1], minNetRr: [1, 1.625, 2] },
    'structure-long-v1': { bullishScoreMin: [50, 60, 70], entryQualityMin: [50, 60, 70],
      volumeRatioMin: [0.8, 1.1, 1.5], nearLevelAtr: [0.8, 1.2, 2], extendedAtr: [1.5, 2, 3], minRealRR: [1, 1.5, 2] },
    'yao-coin-ambush-v1': { minRawProbabilityPct: [60, 75, 90], minProbabilityPct: [40, 50, 60],
      minCurrentAmplitudePct: [4, 8, 12], minRecentReturnPct: [1, 2, 4], minVolumeRatio: [1, 1.5, 2.5],
      minRangeRatio: [1, 1.5, 2], minTrendConsistencyPct: [50, 60, 70], minTrend15SepAtr: [0, 0.3, 0.7] }
  }
};

function searchOptions(patch = {}) {
  const unknown = Object.keys(patch).filter(k => !(k in DEFAULT_SEARCH));
  if (unknown.length) throw new Error(`未知 search 配置：${unknown.join(', ')}`);
  const value = { ...structuredClone(DEFAULT_SEARCH), ...patch,
    mainSpace: { ...DEFAULT_SEARCH.mainSpace, ...patch.mainSpace },
    confirmationSpaces: { ...DEFAULT_SEARCH.confirmationSpaces, ...patch.confirmationSpaces } };
  for (const key of ['seed', 'mainTrials', 'singleTrials', 'pairTrials', 'topMain', 'topSingles', 'maxSymbols'])
    if (!Number.isInteger(value[key]) || value[key] < (key === 'maxSymbols' ? 0 : 1)) throw new Error(`search.${key} 必须为正整数（maxSymbols=0 表示全量）`);
  if (!Array.isArray(value.modes) || !value.modes.length || value.modes.some(m => !['all', 'any'].includes(m))) throw new Error('modes 只支持 all/any');
  for (const key of ['lookbackBars', 'minScores']) if (!Array.isArray(value[key]) || !value[key].length) throw new Error(`${key} 不能为空`);
  for (const v of value.lookbackBars) if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error('lookbackBars 超出 0~100');
  for (const v of value.minScores) if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error('minScores 超出 0~100');
  if (typeof value.yaoKlineOnly !== 'boolean') throw new Error('yaoKlineOnly 必须为布尔值');
  return value;
}
function split(config) {
  const from = Date.parse(config.period.from), to = Date.parse(config.period.to), span = to - from;
  const a = Math.floor((from + span * config.optimization.trainFraction) / MINUTE) * MINUTE;
  const b = Math.floor((a + span * config.optimization.validationFraction) / MINUTE) * MINUTE;
  return { train: { from, to: a }, validation: { from: a, to: b }, test: { from: b, to } };
}
function sampleParams(def, base, space, rng) {
  const params = { ...base }, keys = Object.keys(space);
  for (const key of keys) if (rng() < 0.5) params[key] = space[key][Math.floor(rng() * space[key].length)];
  return validateParams(def, params);
}
function validateSpaces(id, params, space) {
  for (const [key, values] of Object.entries(space)) {
    if (!Array.isArray(values) || !values.length) throw new Error(`${id}.${key} 搜索空间必须为非空数组`);
    for (const v of values) validateParams(getStrategy(id), { ...params, [key]: v });
  }
}
const idOf = trial => hash(trial).slice(0, 16);
const percent = v => v == null ? '—' : `${(v * 100).toFixed(2)}%`;
const scoreOf = row => row.validationScore ?? -Infinity;
const rank = rows => rows.filter(r => r.trainScore != null && r.validationScore != null)
  .sort((a, b) => scoreOf(b) - scoreOf(a) || a.id.localeCompare(b.id));
function combinationOverlap(rows, recipe) {
  // Feed the same overlap accounting a composite match predicate. Execution
  // results are still obtained exclusively from replay, never from this audit.
  const projected = rows.map(r => ({ ...r, trades: r.trades.map(t => ({ ...t, confirmation: { members: [{
    strategyId: 'combination', matched: (t.confirmation?.members.filter(m => m.matched).length || 0) >= recipe.minMatches,
    unavailable: t.confirmation?.members.some(m => m.unavailable) ? 'member_unavailable' : null
  }] } })) }));
  return { ...overlap(projected, 'combination'), recipe };
}

export async function runResearch(file) {
  const raw = JSON.parse(fs.readFileSync(abs(file), 'utf8'));
  if (Object.keys(raw).some(k => !['backtest', 'search'].includes(k))) throw new Error('顶层仅支持 backtest/search');
  const search = searchOptions(raw.search), config = loadConfig(null, raw.backtest || {}), periods = split(config);
  config.execution = { ...config.execution, ...config.strategies[MAIN]?.execution };
  config.costs = { ...config.costs, ...config.strategies[MAIN]?.costs };
  validateExecution(config.execution, config.costs);
  const all = findFiles(config), requested = selectedSymbols(config, all);
  // Choose coins by seeded name hash, never by future returns or trade outcomes.
  const symbols = requested.sort((a, b) => hash(`${search.seed}:${a}`).localeCompare(hash(`${search.seed}:${b}`)))
    .slice(0, search.maxSymbols || requested.length).sort();
  for (const symbol of symbols) if (!all.has(symbol)) throw new Error(`没有 ${symbol} 的历史文件`);
  const state = JSON.parse(fs.readFileSync(abs('data/strategies.json'), 'utf8'));
  const configured = {};
  for (const def of listStrategies()) {
    const source = config.parameterSource === 'configured' ? (await loadConfiguredStrategy(def.id)).strategy.params : {};
    configured[def.id] = validateParams(def, { ...source, ...config.strategies[def.id]?.params });
  }
  const productionParams = structuredClone(configured);
  let secondary = search.strategyIds === 'disabled'
    ? listStrategies().filter(d => d.id !== MAIN && state.strategies?.[d.id]?.enabled === false).map(d => d.id)
    : search.strategyIds;
  if (!Array.isArray(secondary) || !secondary.length || secondary.some(id => !getStrategy(id) || id === MAIN)) throw new Error('strategyIds 没有可用的确认策略');
  secondary = [...new Set(secondary)];
  const exclusions = [], compatible = [];
  for (const id of secondary) {
    if (id === 'structure-short-v1' && configured[MAIN].longOnly) exclusions.push({ strategyId: id, reason: '执行策略只做多，结构做空不可能提供同向确认' });
    else if (getStrategy(id).prefilter && configured[id].marketUniverseEnabled !== false && !config.data.historicalProfiles && !search.yaoKlineOnly)
      exclusions.push({ strategyId: id, reason: '缺少历史市值画像；完整策略不可验证，可显式设置 yaoKlineOnly:true 研究纯 K 线消融版本' });
    else {
      if (id === 'yao-coin-ambush-v1' && search.yaoKlineOnly) configured[id].marketUniverseEnabled = false;
      compatible.push(id);
    }
  }
  validateSpaces(MAIN, configured[MAIN], search.mainSpace);
  for (const id of compatible) validateSpaces(id, configured[id], search.confirmationSpaces[id] || {});
  const fingerprint = { version: 1, engine: engineFingerprint(), script: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    config, search, symbols, params: configured, productionParams, secondary, files: symbols.map(s => fileFingerprint(all.get(s))),
    profiles: config.data.historicalProfiles ? fileFingerprint(abs(config.data.historicalProfiles)) : null };
  const runId = hash(fingerprint).slice(0, 16), directory = abs(path.join(config.output.directory, runId));
  // Replay identity does not depend on search budget or candidate selection code.
  // This allows expanding the search without discarding completed identical jobs.
  const cacheId = hash({ engine: fingerprint.engine, config, files: fingerprint.files, profiles: fingerprint.profiles }).slice(0, 16);
  const cacheDirectory = abs(path.join(config.output.directory, `replays-${cacheId}`));
  fs.mkdirSync(directory, { recursive: true });
  writeJSON(path.join(directory, 'manifest.json'), fingerprint);
  const pool = new ReplayPool(config.output.workers), summaries = new Map(), rng = random(search.seed);
  const pulse = setInterval(() => console.log(`[组合回测] ${summaries.size} 个试验已完成，结果目录 ${directory}`), 45000);
  const status = patch => writeJSON(path.join(directory, 'status.json'), { runId, updatedAt: new Date().toISOString(), ...patch });
  function makeTrial(params, members = [], mode = 'all') {
    return { params: validateParams(getStrategy(MAIN), params), confirmation: members.length ? validateConfirmation({ mode, members }) : null };
  }
  async function evaluate(trials, phase, keepTrades = false) {
    const batches = new Map(), rowsById = new Map();
    for (const trial of trials) rowsById.set(idOf(trial), []);
    for (const symbol of symbols) {
      const pending = [];
      for (const trial of trials) {
        const id = idOf(trial), cache = path.join(cacheDirectory, `${id}-${phase}-${symbol}-${keepTrades ? 'trades' : 'stats'}.json`);
        if (config.output.resume && fs.existsSync(cache)) rowsById.get(id).push(JSON.parse(fs.readFileSync(cache, 'utf8')));
        else pending.push({ id, cache, job: { config, strategyId: MAIN, symbol, file: all.get(symbol), params: trial.params,
          execution: config.execution, costs: config.costs, ...periods[phase], confirmation: trial.confirmation, keepTrades } });
      }
      if (pending.length) batches.set(symbol, pending);
    }
    await Promise.all([...batches].map(async ([symbol, pending]) => {
      const results = await pool.submit({ kind: 'batch', jobs: pending.map(p => p.job) });
      for (let i = 0; i < pending.length; i++) {
        const row = results[i];
        writeJSON(pending[i].cache, row); rowsById.get(pending[i].id).push(row);
      }
      console.log(`[${phase}] ${symbol} 完成 ${pending.length} 个回放`);
    }));
    return new Map([...rowsById].map(([id, rows]) => [id, { summary: summarize(rows), rows: rows.sort((a, b) => a.symbol.localeCompare(b.symbol)) }]));
  }
  async function select(trials, family) {
    const unique = [...new Map(trials.map(t => [idOf(t), t])).values()];
    status({ stage: family, trials: unique.length });
    const train = await evaluate(unique, 'train'), validation = await evaluate(unique, 'validation');
    const entries = unique.map(trial => {
      const id = idOf(trial), a = train.get(id).summary, b = validation.get(id).summary;
      const row = { id, family, trial, train: a, validation: b, trainScore: objective(a, config.optimization), validationScore: objective(b, config.optimization) };
      summaries.set(id, row); return row;
    });
    writeJSON(path.join(directory, 'trials.json'), [...summaries.values()]);
    return entries;
  }
  function member(id, base = null, mutate = false) {
    return { strategyId: id, params: mutate ? sampleParams(getStrategy(id), base?.params || configured[id], search.confirmationSpaces[id] || {}, rng) : base?.params || configured[id],
      lookbackBars: mutate ? search.lookbackBars[Math.floor(rng() * search.lookbackBars.length)] : base?.lookbackBars ?? search.lookbackBars[0],
      minScore: mutate ? search.minScores[Math.floor(rng() * search.minScores.length)] : base?.minScore ?? search.minScores[0] };
  }
  try {
    const base = makeTrial(configured[MAIN]);
    const mainConfig = structuredClone(config);
    mainConfig.optimization.autoSpace = false;
    mainConfig.strategies[MAIN] = { searchSpace: search.mainSpace };
    const baseSearch = { params: base.params, execution: config.execution, costs: config.costs };
    const space = spaceFor(getStrategy(MAIN), baseSearch, mainConfig);
    const randomProposals = candidateRound(baseSearch, baseSearch, space,
      { ...config.optimization, seed: search.seed, method: 'adaptive-random', trialsPerRound: search.mainTrials }, 0, new Set()).map(t => makeTrial(t.params));
    // Explicit anchors cover decisive filter dimensions even with a small budget.
    // Every value comes from the declared space; no hidden out-of-space relaxation.
    const anchor = index => {
      const params = { ...base.params };
      for (const key of ['minAtrPct', 'minTrendScore', 'pullbackAtrShallow', 'pullbackAtrDeep', 'minRsiLong', 'minVolumeRatio']) {
        const values = search.mainSpace[key];
        if (values?.length) params[key] = values[Math.min(index, values.length - 1)];
      }
      if (search.mainSpace.trend15Enabled?.includes(index !== 1)) params.trend15Enabled = index !== 1;
      return makeTrial(params);
    };
    const proposals = [...new Map([base, ...[0, 1, 2].map(anchor), ...randomProposals].map(t => [idOf(t), t])).values()].slice(0, search.mainTrials);
    const mainEntries = await select(proposals, 'main'), mainRanking = rank(mainEntries);
    const mainBest = mainRanking[0] || summaries.get(idOf(base));
    const mainCandidates = mainRanking.slice(0, search.topMain).map(r => r.trial.params);
    if (!mainCandidates.length) mainCandidates.push(base.params);
    const singleWinners = [], singleLeaders = [];
    for (const id of compatible) {
      const trials = [makeTrial(mainBest.trial.params, [member(id)])];
      for (let i = 1; i < search.singleTrials; i++) {
        const chosen = mainCandidates[i % mainCandidates.length];
        trials.push(makeTrial(sampleParams(getStrategy(MAIN), chosen, search.mainSpace, rng), [member(id, null, true)]));
      }
      const entries = await select(trials, id), ranking = rank(entries);
      if (ranking[0]) singleWinners.push(ranking[0]);
      // Sparse families are still explored in pairs and reported, but can never
      // become the selected winner unless the actual pair passes all gates.
      const leader = ranking[0] || entries.filter(r => !r.validation.errorCoins && r.validation.validCoins)
        .sort((a, b) => (b.validation.meanReturn ?? -Infinity) - (a.validation.meanReturn ?? -Infinity) || b.validation.trades - a.validation.trades)[0];
      if (leader) singleLeaders.push(leader);
    }
    const top = singleLeaders.sort((a, b) => scoreOf(b) - scoreOf(a) || b.validation.trades - a.validation.trades).slice(0, search.topSingles), pairWinners = [], pairLeaders = [];
    for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++) for (const mode of search.modes) {
      const ids = [top[a].trial.confirmation.members[0], top[b].trial.confirmation.members[0]];
      const trials = [makeTrial(mainBest.trial.params, ids, mode)];
      for (let i = 1; i < search.pairTrials; i++) trials.push(makeTrial(
        sampleParams(getStrategy(MAIN), mainCandidates[i % mainCandidates.length], search.mainSpace, rng), ids.map(m => member(m.strategyId, m, true)), mode));
      const entries = await select(trials, `${ids.map(m => m.strategyId).join('+')}:${mode}`), ranking = rank(entries);
      if (ranking[0]) pairWinners.push(ranking[0]);
      const leader = ranking[0] || entries.filter(r => !r.validation.errorCoins && r.validation.validCoins)
        .sort((a, b) => (b.validation.meanReturn ?? -Infinity) - (a.validation.meanReturn ?? -Infinity) || b.validation.trades - a.validation.trades)[0];
      if (leader) pairLeaders.push(leader);
    }
    // Freeze ALL selection decisions before any held-out replay is submitted.
    const combinationRanking = rank([...singleWinners, ...pairWinners]);
    const comboBest = combinationRanking[0] || null;
    const selected = comboBest && scoreOf(comboBest) > scoreOf(mainBest) ? comboBest : mainBest;
    const frozen = { selectedId: selected.id, mainId: mainBest.id, combinationId: comboBest?.id || null,
      selectedQualified: selected.trainScore != null && selected.validationScore != null,
      frozenAt: new Date().toISOString(), selectedBy: '训练门槛合格后，按验证集目标排序；测试集不参与选择' };
    writeJSON(path.join(directory, 'selection.json'), frozen);
    status({ stage: 'held_out_test', ...frozen });
    const finalists = [...new Map([summaries.get(idOf(base)), mainBest, ...singleLeaders, ...pairLeaders].filter(Boolean).map(r => [r.id, r])).values()];
    const auditMembers = compatible.map(id => member(id, singleLeaders.find(r => r.trial.confirmation.members[0].strategyId === id)?.trial.confirmation.members[0]));
    const auditTrial = auditMembers.length ? makeTrial(mainBest.trial.params, auditMembers, 'audit') : mainBest.trial;
    const configuredAudit = makeTrial(mainBest.trial.params, secondary.map(strategyId => ({
      strategyId, params: productionParams[strategyId], lookbackBars: 0, minScore: 0
    })), 'audit');
    const pairedBase = comboBest ? makeTrial(comboBest.trial.params) : mainBest.trial;
    const pairedAudit = comboBest ? makeTrial(comboBest.trial.params, comboBest.trial.confirmation.members, 'audit') : null;
    const familyControls = finalists.filter(r => r.trial.confirmation && r.trainScore != null && r.validationScore != null).map(r => ({
      record: r, baseline: makeTrial(r.trial.params), audit: makeTrial(r.trial.params, r.trial.confirmation.members, 'audit')
    }));
    const testTrials = [...new Map([...finalists.map(r => r.trial), auditTrial, configuredAudit, pairedBase, pairedAudit,
      ...familyControls.flatMap(c => [c.baseline, c.audit])].filter(Boolean).map(t => [idOf(t), t])).values()];
    const test = await evaluate(testTrials, 'test', true);
    const overlapRows = compatible.map(id => overlap(test.get(idOf(auditTrial)).rows, id));
    const configuredOverlap = secondary.map(id => overlap(test.get(idOf(configuredAudit)).rows, id));
    const comparisons = new Map(familyControls.map(c => [c.record.id, {
      withoutFilter: test.get(idOf(c.baseline)).summary,
      overlap: combinationOverlap(test.get(idOf(c.audit)).rows, c.record.trial.confirmation),
      unfilteredProfitableCoins: test.get(idOf(c.baseline)).rows.filter(r => r.status === 'ok' && r.metrics.net > 0).map(r => r.symbol),
      filteredProfitableCoins: test.get(c.record.id).rows.filter(r => r.status === 'ok' && r.metrics.net > 0).map(r => r.symbol)
    }]));
    const profitableCoinMatches = test.get(idOf(auditTrial)).rows.filter(r => r.status === 'ok' && r.metrics.net > 0).map(r => {
      const wins = r.trades.filter(t => t.net > 0);
      return { symbol: r.symbol, net: r.metrics.net, winningTrades: wins.length, matches: compatible.map(strategyId => {
        const count = wins.filter(t => t.confirmation.members.find(m => m.strategyId === strategyId)?.matched).length;
        return { strategyId, matchedWinningTrades: count, everyWinningTradeMatched: wins.length > 0 && count === wins.length };
      }) };
    });
    const report = { runId, generatedAt: new Date().toISOString(), directory, config, search, symbols,
      periods: Object.fromEntries(Object.entries(periods).map(([k, p]) => [k, { from: new Date(p.from).toISOString(), to: new Date(p.to).toISOString() }])),
      disabledSnapshot: secondary, exclusions, selection: frozen, trialCount: summaries.size,
      selected: { ...selected, test: test.get(selected.id).summary },
      mainBest: { ...mainBest, test: test.get(mainBest.id).summary },
      combinationBest: comboBest ? { ...comboBest, test: test.get(comboBest.id).summary,
        sameMainWithoutFilter: test.get(idOf(pairedBase)).summary,
        overlap: combinationOverlap(test.get(idOf(pairedAudit)).rows, comboBest.trial.confirmation) } : null,
      finalists: finalists.map(r => ({ ...r, qualified: r.trainScore != null && r.validationScore != null,
        test: test.get(r.id).summary, comparison: comparisons.get(r.id) || null })),
      overlap: overlapRows, configuredOverlap, profitableCoinMatches,
      configuredBaseline: test.get(idOf(base)).summary,
      testRows: Object.fromEntries([...test].map(([id, v]) => [id, v.rows])),
      limitations: [
        '有限随机搜索得到的是已扫描范围内的候选最优参数，不能保证全局最优；训练/验证筛选，不按测试结果换参数。',
        '每币种独立初始资金，等权平均收益；没有模拟线上多币共享资金、最低保证金及总敞口限制。',
        '确认仅判断同币同向原生策略完整可交易信号，最近已收盘原生 K 线及 lookbackBars 以内；不继承确认策略的订单、退出或资金分配。',
        '确认分析使用独立影子账户的初始余额，不模拟确认策略自身的持仓、可用保证金与账户风控；实际成交仓位仍由增强趋势回放决定。',
        '盈利币种至少有一笔盈利交易匹配不代表全部盈利入场都匹配；交易覆盖率与币种覆盖率分别报告。',
        '固定费率/滑点/资金费率场景；相同 K 线内止盈止损冲突使用共享撮合引擎规则，分段末尾强平。',
        '抽样币种按种子和名称哈希选择，包含零交易币种，未按未来盈利筛选；单个留出窗口证据有限。',
        ...(search.yaoKlineOnly ? ['妖币埋伏关闭历史市值候选池，只研究 K 线消融版本，不能当作完整生产策略的结果。'] : [])
      ] };
    writeJSON(path.join(directory, 'report.json'), report);
    writeJSON(path.join(directory, 'best-parameters.json'), { ...frozen, executionStrategy: MAIN,
      selected: selected.trial, enhancedOnly: mainBest.trial, combination: comboBest?.trial || null,
      familyCandidates: report.finalists.filter(r => r.trial.confirmation).map(r => ({
        id: r.id, family: r.family, qualified: r.qualified, trainTrades: r.train.trades, validationTrades: r.validation.trades, trial: r.trial
      })) });
    const lines = ['# 增强趋势 v1 与其他策略确认：参数探索', '', `运行 ${runId}；${symbols.length} 币；${summaries.size} 个参数/组合试验。`, '',
      ...Object.entries(report.periods).map(([k, p]) => `- ${k}: ${p.from} → ${p.to}`), '',
      '全部成交、退出和仓位规则归属增强趋势 v1，其他策略仅决定是否允许其入场。', '',
      '| 方案 | 训练/验证门槛 | 验证均值收益 | 测试均值收益 | 同参数无过滤测试收益 | 测试交易数 | 测试最差单币回撤 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      `| 当前线上参数 | 基准 | ${percent(summaries.get(idOf(base)).validation.meanReturn)} | ${percent(report.configuredBaseline.meanReturn)} | — | ${report.configuredBaseline.trades} | ${percent(report.configuredBaseline.worstDrawdown)} |`,
      ...report.finalists.filter(r => r.id !== idOf(base)).map(r => `| ${r.family} (${r.id}) | ${r.qualified ? '合格' : '未达标，仅描述'} | ${percent(r.validation.meanReturn)} | ${percent(r.test.meanReturn)} | ${percent(r.comparison?.withoutFilter.meanReturn)} | ${r.test.trades} | ${percent(r.test.worstDrawdown)} |`), '',
      `验证集锁定选择：${selected.family} (${selected.id})；${frozen.selectedQualified ? '通过训练/验证门槛' : '没有合格候选，保留当前参数基准'}。`, '',
      ...(comboBest ? [`组合与相同增强趋势参数的无过滤对照：测试收益 ${percent(report.combinationBest.test.meanReturn)} 对 ${percent(report.combinationBest.sameMainWithoutFilter.meanReturn)}。`,
        `该组合的精确规则对同参数无过滤成交：保留盈利交易 ${percent(report.combinationBest.overlap.winningTradeCoverage)}，过滤亏损交易 ${percent(report.combinationBest.overlap.losingTradeRejection)}，覆盖盈利币种 ${percent(report.combinationBest.overlap.profitableCoinCoverage)}。`, ''] : ['没有组合达到训练/验证最低交易量与回撤门槛。', '']),
      '所有通过训练/验证门槛的确认方案，都提供自己的同参数无过滤对照和精确规则覆盖（report.json 的 finalists[].comparison）。测试表现不改变验证集选择。', '',
      '## 盈利样本的同向确认覆盖（优化后增强趋势、测试期）', '',
      '| 确认策略 | 盈利交易保留 | 亏损交易过滤 | 盈利币种覆盖 | 全部盈利交易匹配 |', '| --- | ---: | ---: | ---: | --- |',
      ...overlapRows.map(r => `| ${r.strategyId} | ${r.retainedWins}/${r.winningTrades} (${percent(r.winningTradeCoverage)}) | ${r.rejectedLosses}/${r.losingTrades} (${percent(r.losingTradeRejection)}) | ${r.profitableCoinsWithWinningMatch}/${r.profitableCoins} (${percent(r.profitableCoinCoverage)}) | ${r.everyWinningTradeMatched == null ? '无样本' : r.everyWinningTradeMatched ? '是' : '否'} |`), '',
      '## 未开启策略当前参数的覆盖（同一无过滤成交样本）', '',
      '| 策略 | 盈利交易覆盖 | 盈利币种覆盖 | 确认数据不足交易数 |', '| --- | ---: | ---: | ---: |',
      ...configuredOverlap.map(r => `| ${r.strategyId} | ${percent(r.winningTradeCoverage)} | ${percent(r.profitableCoinCoverage)} | ${r.unavailableTrades}/${r.trades} |`), '',
      '画像缺失或暖机不足的确认不能被解释为策略本身不满足。当前参数只检查最新已闭合原生信号，不追加评分门槛。', '',
      '## 盈利币种与优化确认条件', '',
      '| 币种 | 净收益 USDT | 盈利交易数 | 至少匹配一笔盈利交易的策略（匹配数） |', '| --- | ---: | ---: | --- |',
      ...profitableCoinMatches.map(r => `| ${r.symbol} | ${r.net.toFixed(4)} | ${r.winningTrades} | ${r.matches.filter(m => m.matchedWinningTrades).map(m => `${m.strategyId} (${m.matchedWinningTrades}/${r.winningTrades})`).join(', ') || '无'} |`), '',
      ...exclusions.map(r => `- ${r.strategyId}：${r.reason}`), '', '## 参数、结果与复现', '',
      '- best-parameters.json：完整增强趋势参数、确认策略参数、确认回看范围和评分门槛、AND/OR 关系。',
      '- trials.json：所有训练/验证结果，包括不满足样本量或回撤门槛的试验。',
      '- report.json：测试成交、逐币统计、覆盖率与样本重叠。', '',
      '```powershell', `node scripts/explore-enhanced-trend-combinations.mjs --config ${file}`, '```', '',
      '## 解释范围', '', ...report.limitations.map(s => `- ${s}`), ''];
    fs.writeFileSync(path.join(directory, 'report.md'), lines.join('\n'));
    status({ stage: 'completed', report: path.join(directory, 'report.md'), ...frozen });
    console.log(JSON.stringify({ directory, trials: report.trialCount, selected: selected.family,
      baselineTest: report.configuredBaseline, mainTest: report.mainBest.test, combinationTest: report.combinationBest?.test }, null, 2));
    return report;
  } catch (error) { status({ stage: 'failed', error: error.message }); throw error; }
  finally { clearInterval(pulse); await pool.close(); }
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('node scripts/explore-enhanced-trend-combinations.mjs --config scripts/enhanced-combinations.example.json\n配置为 {backtest:既有回测配置, search:主策略/确认策略/组合搜索配置}。仅写回测输出目录，不改线上配置。'); return;
  }
  if (args.length !== 2 || args[0] !== '--config') throw new Error('用法：node scripts/explore-enhanced-trend-combinations.mjs --config scripts/enhanced-combinations.example.json');
  await runResearch(args[1]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(e => { console.error(e.stack); process.exitCode = 1; });
