import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { listStrategies, getStrategy } from '../../server/strategies/index.js';
import { loadConfiguredStrategy } from '../../server/strategies/loader.js';
import { validateFeatureRules } from '../../shared/strategyFeatureFilter.js';
import { ROOT, abs, DAY, MINUTE, loadConfig, initialConfig, schemaDocument, writeJSON, hash, merge, validateParams, validateExecution } from './config.mjs';
import { findFiles, selectedSymbols, fileFingerprint, downloadData } from './data.mjs';
import { ReplayPool } from './pool.mjs';
import { summarize, objective, learnFeatures } from './stats.mjs';
import { spaceFor, candidateRound, trialId, validateTrial } from './search.mjs';
import { writeReport, writeIndex, RISK_NOTE } from './report.mjs';
import { assessDeployment } from './deployment.mjs';

export function engineFingerprint() {
  const digest = createHash('sha256');
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (/\.(js|mjs)$/.test(name)) digest.update(path.relative(ROOT, file)).update(fs.readFileSync(file));
    }
  }
  for (const directory of ['scripts/backtest', 'server', 'shared']) walk(abs(directory));
  for (const file of fs.readdirSync(abs('scripts')).sort()) if (/^backtest-(?:system|campaign|deploy|.*-v1)\.mjs$/.test(file))
    digest.update(file).update(fs.readFileSync(abs(`scripts/${file}`)));
  if (fs.existsSync(abs('package-lock.json'))) digest.update(fs.readFileSync(abs('package-lock.json')));
  return digest.digest('hex');
}
function periods(config) {
  const from = Date.parse(config.period.from), to = Date.parse(config.period.to), span = to - from;
  const trainEnd = Math.floor((from + span * config.optimization.trainFraction) / MINUTE) * MINUTE;
  const validationEnd = Math.floor((from + span * (config.optimization.trainFraction + config.optimization.validationFraction)) / MINUTE) * MINUTE;
  return { training: { from, to: trainEnd }, validation: { from: trainEnd, to: validationEnd },
    test: { from: validationEnd, to }, full: { from, to } };
}
function isoPeriods(p) { return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { from: new Date(v.from).toISOString(), to: new Date(v.to).toISOString() }])); }
function publicConfig(c) { return merge(c, { data: { proxy: c.data.proxy ? '[configured]' : null } }); }
function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
async function strategyBase(id, config) {
  const def = getStrategy(id);
  let parameters = Object.fromEntries(def.paramSchema.map(s => [s.key, s.default]));
  if (config.parameterSource === 'configured') parameters = (await loadConfiguredStrategy(id)).strategy.params;
  const specific = config.strategies[id] || {};
  const base = { params: validateParams(def, { ...parameters, ...specific.params }),
    execution: merge(config.execution, specific.execution || {}), costs: merge(config.costs, specific.costs || {}) };
  validateExecution(base.execution, base.costs); return base;
}
export async function runSystem(config, { strategyIds = listStrategies().map(s => s.id), optimize = false } = {}) {
  const files = findFiles(config), symbols = selectedSymbols(config, files), engine = engineFingerprint(), p = periods(config);
  const fingerprints = Object.fromEntries(symbols.map(s => [s, fileFingerprint(files.get(s))]));
  const bases = Object.fromEntries(await Promise.all(strategyIds.map(async id => [id, await strategyBase(id, config)])));
  const historicalProfilesFingerprint = config.data.historicalProfiles && fs.existsSync(abs(config.data.historicalProfiles))
    ? hash(fs.readFileSync(abs(config.data.historicalProfiles), 'utf8')) : null;
  const runId = hash({ config, engine, fingerprints, bases, historicalProfilesFingerprint, optimize, strategyIds }).slice(0, 20);
  const directory = path.join(abs(config.output.directory), runId), pool = new ReplayPool(config.output.workers), reports = [];
  const statusFile = path.join(directory, 'status.json');
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; log('收到停止信号；当前试验完成后保留检查点。'); };
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  writeJSON(path.join(directory, 'run.json'), { runId, engineFingerprint: engine, config: publicConfig(config),
    dataFingerprints: fingerprints, historicalProfilesFingerprint, parameterSnapshots: bases, periods: isoPeriods(p), startedAt: new Date().toISOString() });
  writeJSON(path.join(directory, 'parameter-schema.json'), schemaDocument());
  let completedJobs = 0, pulse;
  function status(value) { writeJSON(statusFile, { runId, updatedAt: new Date().toISOString(), completedJobs, ...value }); }
  let currentStage = 'starting';
  pulse = setInterval(() => log(`${currentStage} · 已完成 ${completedJobs} 个逐币任务`), 45000);
  async function evaluate(strategyId, trial, segment, rules, keepTrades = false) {
    const jobs = symbols.map(async symbol => {
      const file = files.get(symbol);
      if (!file) return { symbol, strategyId, status: 'excluded', reason: 'file_missing', metrics: null, params: trial.params,
        execution: trial.execution, costs: trial.costs, trades: [], featureSamples: [] };
      const id = hash({ strategyId, trial, segment, rules, symbol, fingerprint: fingerprints[symbol], engine, historicalProfilesFingerprint });
      const checkpoint = path.join(directory, 'checkpoints', `${id}.json`);
      if (config.output.resume && fs.existsSync(checkpoint)) { completedJobs++; return JSON.parse(fs.readFileSync(checkpoint, 'utf8')); }
      let result;
      try { result = await pool.submit({ config, strategyId, symbol, file, ...trial, ...segment, rules,
        keepTrades: keepTrades && config.output.saveTrades }); }
      catch (e) { result = { symbol, strategyId, status: 'error', reason: e.message, params: trial.params, execution: trial.execution,
        costs: trial.costs, metrics: null, trades: [], featureSamples: [] }; }
      // Failures remain retryable on a resumed run.
      if (result.status !== 'error' && result.status !== 'analysis_error') writeJSON(checkpoint, result);
      completedJobs++; return result;
    });
    return Promise.all(jobs);
  }
  async function evaluateBatch(strategyId, requests) {
    const results = requests.map(() => new Map());
    await Promise.all(symbols.map(async symbol => {
      const file = files.get(symbol), pending = [];
      for (let index = 0; index < requests.length; index++) {
        const { trial, segment, rules, keepTrades = false } = requests[index];
        const id = hash({ strategyId, trial, segment, rules, symbol, fingerprint: fingerprints[symbol], engine, historicalProfilesFingerprint });
        const checkpoint = path.join(directory, 'checkpoints', `${id}.json`);
        if (!file) results[index].set(symbol, { symbol, strategyId, status: 'excluded', reason: 'file_missing', metrics: null, trades: [], featureSamples: [] });
        else if (config.output.resume && fs.existsSync(checkpoint)) {
          results[index].set(symbol, JSON.parse(fs.readFileSync(checkpoint, 'utf8'))); completedJobs++;
        } else pending.push({ index, checkpoint, job: { config, strategyId, symbol, file, ...trial, ...segment, rules,
          keepTrades: keepTrades && config.output.saveTrades } });
      }
      if (!pending.length) return;
      const rows = await pool.submit({ kind: 'batch', jobs: pending.map(p => p.job) });
      for (let i = 0; i < pending.length; i++) {
        const row = rows[i], task = pending[i];
        if (!['error', 'analysis_error'].includes(row.status)) writeJSON(task.checkpoint, row);
        results[task.index].set(symbol, row); completedJobs++;
      }
    }));
    return results.map(rows => symbols.map(symbol => rows.get(symbol)));
  }
  try {
    for (const strategyId of strategyIds) {
      if (interrupted) break;
      const def = getStrategy(strategyId), base = bases[strategyId], opts = config.optimization;
      const strategyDirectory = path.join(directory, strategyId), manualRules = validateFeatureRules(config.features.manualRules);
      const space = optimize ? spaceFor(def, base, config) : {};
      const trials = [], seen = new Set(), coinBest = new Map();
      let best = base, bestId = trialId(base), bestScore = null, bestTraining, bestValidation, baselineTraining, baselineValidation,
        stale = 0, stopReason = optimize ? 'max_rounds' : 'single_configuration';
      for (let round = 0; round < (optimize ? opts.maxRounds : 1); round++) {
        const proposals = optimize ? candidateRound(base, best, space, opts, round, seen) : [base];
        if (!proposals.length) { stopReason = 'search_space_exhausted'; break; }
        const previousBest = bestScore;
        for (const trial of proposals) {
          validateTrial(def, trial); const id = trialId(trial); seen.add(id);
          currentStage = `${strategyId} 第 ${round + 1} 轮 ${id} 训练/验证`;
          status({ state: 'running', stage: currentStage });
          const [trainRows, validationRows] = await evaluateBatch(strategyId, [
            { trial, segment: p.training, rules: manualRules }, { trial, segment: p.validation, rules: manualRules }]);
          if (id === trialId(base)) { baselineTraining = trainRows; baselineValidation = validationRows; }
          const training = summarize(trainRows), validation = summarize(validationRows);
          const validationScore = objective(validation, opts);
          // A candidate must also meet the configured trade/drawdown guard on training data.
          const score = objective(training, opts) == null ? null : validationScore;
          trials.push({ id, round, parameters: trial, training, validation, score });
          for (const row of validationRows) {
            const train = trainRows.find(t => t.symbol === row.symbol);
            if (row.status !== 'ok' || train?.status !== 'ok' || row.metrics.trades < opts.minTradesPerCoin || train.metrics.trades < opts.minTradesPerCoin
              || row.metrics.maxDrawdown > opts.maxDrawdown || train.metrics.maxDrawdown > opts.maxDrawdown) continue;
            const score = row.metrics.returnRate - (opts.objective === 'return' ? 0 : opts.drawdownPenalty * row.metrics.maxDrawdown);
            if (!coinBest.has(row.symbol) || score > coinBest.get(row.symbol).score)
              coinBest.set(row.symbol, { score, id, parameters: trial });
          }
          if (!bestTraining || (score != null && (bestScore == null || score > bestScore + opts.minImprovement))) {
            best = trial; bestId = id; bestScore = score; bestTraining = trainRows; bestValidation = validationRows;
          }
          writeJSON(path.join(strategyDirectory, 'optimization-history.json'), { round, trials, bestId, bestScore,
            bestParameters: best, testUsedForSelection: false, space, searchBudget: { rounds: opts.maxRounds, trialsPerRound: opts.trialsPerRound } });
          const validationReturn = validation.meanReturn == null ? '无有效数据' : `${(validation.meanReturn * 100).toFixed(2)}%`;
          log(`${strategyId} ${id}: 验证均值 ${validationReturn}，交易 ${validation.trades}，目标 ${score == null ? '证据不足/约束未满足' : score.toFixed(5)}`);
          if (trainRows.length && trainRows.every(r => r.reason === 'historical_market_profiles_missing')) {
            stopReason = 'historical_market_profiles_missing'; break;
          }
          if (interrupted) break;
        }
        if (interrupted) break;
        if (stopReason === 'historical_market_profiles_missing') break;
        stale = previousBest == null ? (bestScore == null ? stale + 1 : 0) : bestScore > previousBest + opts.minImprovement ? 0 : stale + 1;
        if (optimize && stale >= opts.patience) { stopReason = bestScore == null ? 'insufficient_evidence' : 'no_improvement'; break; }
      }
      if (interrupted) break;
      // Freeze candidate rules from training before looking at validation; test is read only after selection.
      const learned = config.features.enabled ? learnFeatures(bestTraining, config.features)
        : { status: 'disabled', rules: [], comparison: [], trainingOnly: true };
      let appliedRules = [...manualRules], filteredValidation = bestValidation, accepted = false, reason = learned.status;
      if (learned.rules.length) {
        currentStage = `${strategyId} 验证训练期特征条件`;
        const candidateRules = [...manualRules, ...learned.rules];
        const candidateRows = await evaluate(strategyId, best, p.validation, candidateRules);
        const baseline = summarize(bestValidation), candidate = summarize(candidateRows);
        const baselineScore = objective(baseline, opts), candidateScore = objective(candidate, opts);
        accepted = candidateScore != null && candidate.trades >= config.features.minValidationTrades
          && candidate.worstDrawdown <= config.features.maxValidationDrawdown
          && candidate.meanReturn > 0 && candidateScore >= (baselineScore ?? -Infinity) + config.features.minValidationImprovement;
        if (accepted) { appliedRules = candidateRules; filteredValidation = candidateRows; reason = 'training_rules_passed_validation'; }
        else reason = 'training_rules_failed_validation; learning filter not applied';
      }
      currentStage = `${strategyId} 冻结参数后的最终测试/全年重放`;
      status({ state: 'running', stage: currentStage });
      const finalRequests = [
        { trial: best, segment: p.test, rules: appliedRules, keepTrades: true },
        { trial: best, segment: p.full, rules: appliedRules, keepTrades: true }];
      const sameBaseline = bestId === trialId(base) && hash(appliedRules) === hash(manualRules);
      if (!sameBaseline) finalRequests.push({ trial: base, segment: p.test, rules: manualRules }, { trial: base, segment: p.full, rules: manualRules });
      const finalRows = await evaluateBatch(strategyId, finalRequests);
      const [testRows, fullRows] = finalRows, baselineTest = sameBaseline ? testRows : finalRows[2], baselineFull = sameBaseline ? fullRows : finalRows[3];
      const coinTests = await Promise.all(symbols.map(async symbol => {
        const cb = coinBest.get(symbol);
        if (!cb || cb.id === bestId) return testRows.find(r => r.symbol === symbol);
        const singleConfig = merge(config, { data: { symbols: [symbol] } });
        // Per-coin selection is also frozen on validation; no parameter decision sees test data.
        const file = files.get(symbol), id = hash({ symbol, coinTrial: cb.id, p: p.test, appliedRules, engine, fingerprint: fingerprints[symbol] });
        const checkpoint = path.join(directory, 'checkpoints', `${id}.json`);
        if (config.output.resume && fs.existsSync(checkpoint)) return JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
        try {
          const row = await pool.submit({ config: singleConfig, strategyId, symbol, file, ...cb.parameters, ...p.test,
            rules: appliedRules, keepTrades: config.output.saveTrades });
          if (!['error', 'analysis_error'].includes(row.status)) writeJSON(checkpoint, row);
          completedJobs++; return row;
        } catch (e) { return { symbol, status: 'error', reason: e.message }; }
      }));
      const report = { runId, engineFingerprint: engine, generatedAt: new Date().toISOString(), strategyId,
        strategyName: def.name, periods: isoPeriods(p), bestTrialId: bestId, bestParameters: best,
        selectionStatus: bestScore == null ? 'insufficient_evidence; baseline_parameters' : 'best_within_search_budget',
        stopReason, trials, featureConfig: config.features,
        filter: { learned, accepted, manual: manualRules.length > 0, appliedRules, reason, testUsedForSelection: false },
        summary: { training: summarize(bestTraining), validation: summarize(filteredValidation),
          test: summarize(testRows), full: summarize(fullRows), coinBestTest: summarize(coinTests) },
        baseline: { parameters: base, summary: { training: summarize(baselineTraining), validation: summarize(baselineValidation),
          test: summarize(baselineTest), full: summarize(baselineFull) },
          coins: symbols.map(symbol => ({ symbol, validation: baselineValidation.find(r => r.symbol === symbol),
            test: baselineTest.find(r => r.symbol === symbol), full: baselineFull.find(r => r.symbol === symbol) })) },
        coins: symbols.map(symbol => ({ symbol, training: bestTraining.find(r => r.symbol === symbol),
          validation: filteredValidation.find(r => r.symbol === symbol), test: testRows.find(r => r.symbol === symbol),
          full: fullRows.find(r => r.symbol === symbol), coinBestTest: coinTests.find(r => r.symbol === symbol),
          bestTrialId: coinBest.get(symbol)?.id || bestId, bestParameters: coinBest.get(symbol)?.parameters || best,
          parameterSelection: coinBest.has(symbol) ? 'coin_validation_best' : 'insufficient_coin_evidence; strategy_parameters' })),
        assumptions: { market: config.data.market, symbols: '所有已发现的 USDT 永续币种；包含历史归档及本地缓存币种。仅本地缓存时不能保证退市币完整。',
          decisionInterval: def.planInterval || '1m', executionInterval: '1m', indicators: '仅使用当时已收盘且连续的 K 线；暖机数据可来自评估期之前',
          dataCoverage: '覆盖率是全年请求区间实际 K 线比例；不填补缺失 K 线，不虚构新币上市前价格',
          costs: '手续费/滑点/资金费使用显式情景参数；资金费固定年化时间累计，不代表历史交易所实际费率。优化费用的结果属于不同成本情景。',
          featureLearning: '训练期盈利/非盈利币种按币等权比较；特征是入场时特征，不使用整年未来数据。验证通过后固定，测试不参与优化。',
          allYearReplay: '全年 full 包含用于调参的数据，只作描述性重放；可信度以最终 test 为主',
          holding: '每币种每策略独立资金、最多一笔活动订单；maxPositions 为多币共享组合参数，在逐币模式不产生影响',
          risk: '保证金与往返手续费预留不超过权益；止损风险预算限制仓位。收盘盯市回撤，无法包含一分钟内的真实权益路径。',
          periodBoundary: '各时间段独立起始资金，不跨分段传递仓位；分段末仍持仓按最后已观察到的收盘价格计成本平仓并单独标记',
          historicalProfiles: config.data.historicalProfiles || '缺失。需要历史市场画像的策略将被排除；可明确关闭其 marketUniverseEnabled 做 K 线消融实验。',
          optimization: '有限搜索并按 patience/预算停止，不能保证全局最大收益；多次查看同一测试期后重新调参会污染样本外结果，应换新保留期。',
          riskNote: RISK_NOTE } };
      report.deployment = assessDeployment(report);
      writeReport(strategyDirectory, report); reports.push(report);
      writeIndex(directory, reports, { runId, period: config.period, complete: false });
      log(`${strategyId} 报告完成：${path.relative(ROOT, strategyDirectory)} · 测试 ${report.summary.test.trades} 笔`);
    }
    const state = interrupted ? 'paused' : reports.some(r => r.summary.test.errorCoins || r.summary.full.errorCoins) ? 'completed_with_errors' : 'complete';
    status({ state, stage: currentStage, strategiesCompleted: reports.map(r => r.strategyId), requestedStrategies: strategyIds });
    writeIndex(directory, reports, { runId, period: config.period, complete: state === 'complete', state });
    log(`运行 ${state}：${path.relative(ROOT, path.join(directory, 'index.html'))}`);
    return { directory, runId, state, reports };
  } catch (e) { status({ state: 'failed', stage: currentStage, error: e.message }); throw e; }
  finally { clearInterval(pulse); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt); await pool.close(); }
}
export async function auditData(config) {
  const pool = new ReplayPool(config.output.workers), files = findFiles(config), symbols = selectedSymbols(config, files), rows = [];
  try {
    await Promise.all(symbols.map(async symbol => {
      const file = files.get(symbol);
      if (!file) rows.push({ symbol, eligible: false, reason: 'file_missing' });
      else try { rows.push(await pool.submit({ kind: 'audit', config, symbol, file })); }
      catch (e) { rows.push({ symbol, eligible: false, reason: 'error', error: e.message }); }
      if (rows.length % 25 === 0 || rows.length === symbols.length) log(`覆盖审计 ${rows.length}/${symbols.length}`);
    }));
    const report = { period: config.period, generatedAt: new Date().toISOString(),
      eligible: rows.filter(r => r.eligible).length, total: symbols.length, rows: rows.sort((a, b) => a.symbol.localeCompare(b.symbol)) };
    const file = path.join(abs(config.output.directory), `coverage-${hash(config.period).slice(0, 12)}.json`);
    writeJSON(file, report); log(`审计报告：${path.relative(ROOT, file)}`); return report;
  } finally { await pool.close(); }
}
function argumentsOf(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'run', options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`未知参数 ${argv[i]}`);
    const key = argv[i].slice(2), value = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    if (!['config', 'strategy', 'symbols', 'from', 'to', 'workers', 'rounds', 'trials', 'output', 'data-dir', 'allow-partial', 'no-resume', 'help'].includes(key)) throw new Error(`未知选项 --${key}`);
    options[key] = value;
  }
  return { command, options };
}
export async function main(argv = process.argv.slice(2), forcedStrategy = null) {
  const { command, options: o } = argumentsOf([...argv]);
  if (command === 'help' || o.help) {
    console.log(`Node.js 年度多策略回测\n\nnode scripts/backtest-system.mjs init --config configs/crypto-backtest.json\nnode scripts/backtest-system.mjs data --config configs/crypto-backtest.json\nnode scripts/backtest-system.mjs audit --config configs/crypto-backtest.json\nnode scripts/backtest-system.mjs run --config configs/crypto-backtest.json\nnode scripts/backtest-system.mjs optimize --config configs/crypto-backtest.json\nnode scripts/backtest-system.mjs all --config configs/crypto-backtest.json\nnode scripts/backtest-h4-mean-reversion-v1.mjs optimize --config configs/crypto-backtest.json\n\n选项：--strategy ID/逗号列表/all --symbols BTCUSDT,ETHUSDT --from ISO --to ISO\n      --workers 2 --rounds 5 --trials 8 --output DIR --data-dir DIR --allow-partial --no-resume\nall = 更新数据 + 覆盖审计 + 所有策略多轮优化。run = 当前参数 + 特征训练/验证/最终测试。\n默认最近 365 天，全部本地已发现币种；data/all 包含官方历史归档退市币。\n文档：docs/crypto-backtest-system.md`); return;
  }
  if (command === 'init') {
    const file = abs(o.config || 'configs/crypto-backtest.json');
    if (fs.existsSync(file)) throw new Error(`配置已存在：${file}`);
    writeJSON(file, initialConfig()); writeJSON(file.replace(/\.json$/, '.schema.json'), schemaDocument());
    log(`配置已生成（全部 7 策略参数）：${path.relative(ROOT, file)}`); return;
  }
  if (!['schema', 'data', 'audit', 'run', 'optimize', 'all'].includes(command)) throw new Error(`未知命令 ${command}`);
  const patch = {};
  if (o.from || o.to) patch.period = { ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}) };
  if (o.symbols || o['data-dir'] || o['allow-partial']) patch.data = { ...(o.symbols ? { symbols: String(o.symbols).split(',') } : {}),
    ...(o['data-dir'] ? { directory: o['data-dir'] } : {}), ...(o['allow-partial'] ? { allowPartialHistory: true } : {}) };
  if (o.workers || o.output || o['no-resume']) patch.output = { ...(o.workers ? { workers: Number(o.workers) } : {}),
    ...(o.output ? { directory: o.output } : {}), ...(o['no-resume'] ? { resume: false } : {}) };
  if (o.rounds || o.trials) patch.optimization = { ...(o.rounds ? { maxRounds: Number(o.rounds) } : {}), ...(o.trials ? { trialsPerRound: Number(o.trials) } : {}) };
  const config = loadConfig(o.config || (fs.existsSync(abs('configs/crypto-backtest.json')) ? 'configs/crypto-backtest.json' : null), patch);
  if (command === 'schema') { const file = path.join(abs(config.output.directory), 'parameter-schema.json'); writeJSON(file, schemaDocument()); log(file); return; }
  if (command === 'data' || command === 'all') { const download = await downloadData(config, log); if (!download.complete) throw new Error('数据更新含失败币种；检查 download-status.json 并重跑 data 后继续回测'); }
  if (command === 'data') return;
  if (command === 'audit' || command === 'all') { await auditData(config); if (command === 'audit') return; }
  const ids = forcedStrategy ? [forcedStrategy] : !o.strategy || o.strategy === 'all' ? listStrategies().map(s => s.id) : String(o.strategy).split(',');
  for (const id of ids) if (!getStrategy(id)) throw new Error(`策略 ${id} 不存在`);
  const result = await runSystem(config, { strategyIds: ids, optimize: command !== 'run' });
  if (result.state === 'failed' || result.state === 'completed_with_errors') process.exitCode = 1;
  if (result.state === 'paused') process.exitCode = 130;
  return result;
}
