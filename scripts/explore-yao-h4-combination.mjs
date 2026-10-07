import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { getStrategy, loadConfiguredStrategy } from '../server/strategies/index.js';
import { abs, loadConfig, hash, writeJSON, MINUTE } from './backtest/config.mjs';
import { findFiles, selectedSymbols, fileFingerprint } from './backtest/data.mjs';
import { random } from './backtest/search.mjs';
import { engineFingerprint } from './backtest/system.mjs';
import { portfolio, validateTrial, MAIN, FILTER } from './backtest/yao-h4.mjs';
import { YAO_CALIBRATION_MODEL } from '../server/yaoCoinCalibration.js';

class ScanPool {
  constructor(count) {
    this.queue = []; this.closed = false;
    this.slots = Array.from({ length: count }, () => {
      const slot = { worker: new Worker(new URL('./backtest/yao-h4-worker.mjs', import.meta.url)), task: null };
      slot.worker.on('message', result => {
        const task = slot.task; slot.task = null;
        if (result.error) task.reject(new Error(result.error)); else task.resolve(result);
        this.dispatch(slot);
      });
      slot.worker.on('error', error => this.fail(error));
      slot.worker.on('exit', code => { if (!this.closed && code) this.fail(new Error(`scan worker 退出 ${code}`)); });
      return slot;
    });
  }
  fail(error) {
    for (const slot of this.slots) { slot.task?.reject(error); slot.task = null; }
    for (const task of this.queue.splice(0)) task.reject(error);
    this.close();
  }
  dispatch(slot) { if (!slot.task && this.queue.length && !this.closed) { slot.task = this.queue.shift(); slot.worker.postMessage(slot.task.job); } }
  submit(job) { return new Promise((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.slots.forEach(s => this.dispatch(s)); }); }
  async close() { this.closed = true; await Promise.all(this.slots.map(s => s.worker.terminate())); }
}

const percent = n => `${(n * 100).toFixed(2)}%`, number = n => Number.isFinite(n) ? n.toFixed(2) : '—';
const unpack = file => {
  const result = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  // settlePaperOrder's production reason catalogue has no offline-only codes.
  // In this tape format the only manual settlements are period-end and gap
  // closures (Yao's review only HOLDs or UPDATEs). Restore their offline labels.
  for (const rows of result.opportunities) for (const o of rows) if (o.reason === 'manual')
    o.reason = o.periodEnd ? 'backtest_period_end' : 'data_gap';
  return result;
};
const trialId = trial => hash(trial).slice(0, 16);

export async function research(configFile, action = 'run', selectionFile = null, runtimeWorkers = null) {
  const raw = JSON.parse(fs.readFileSync(abs(configFile), 'utf8'));
  const config = loadConfig(null, raw.backtest), capital = raw.capital, search = raw.search;
  if (config.execution.leverage !== 10 || config.execution.maxLeverage !== 10) throw new Error('本次固定 10x');
  if (!capital || !Number.isInteger(capital.maxPositions) || capital.maxPositions < 1 || !(capital.maxMarginPct > 0 && capital.maxMarginPct <= 1)
    || !(capital.minMargin > 0) || !(capital.minNotional > 0) || !(capital.pendingCooldownMinutes >= 0)) throw new Error('无效共享资金配置');
  const current = (await loadConfiguredStrategy(MAIN)).strategy.params;
  const hp = (await loadConfiguredStrategy(FILTER)).strategy.params;
  const base = { ...current, marketUniverseEnabled: false, minProbabilityPct: 40 };
  const trial = (params = {}, filter = {}) => validateTrial({ params: { ...base, ...params },
    filter: { mode: 'trend', params: hp, lookbackBars: 0, ...filter } });
  const rng = random(search.seed), pick = xs => xs[Math.floor(rng() * xs.length)];
  const anchors = [
    trial(),
    trial({ minRecentReturnPct: 1, minCurrentAmplitudePct: 8, minVolumeRatio: 1.5, minRangeRatio: 1.2, minTrendConsistencyPct: 50, minRawProbabilityPct: 80 }),
    trial({ minRecentReturnPct: 1.5, minCurrentAmplitudePct: 10, minVolumeRatio: 2, minTrendConsistencyPct: 60, minRawProbabilityPct: 85, maxHoldBars: 90 }),
    trial({ entryPullbackAtr: 1.5, entryBandAtr: 0.3, minStopPct: 0.01, maxHoldBars: 120 }),
    trial({ entryPullbackAtr: 0.5, minStopPct: 0.005, maxHoldBars: 30 }),
    trial({ minTrendConsistencyPct: 60, minRecentReturnPct: 1, minVolumeRatio: 2, minRangeRatio: 1.2, longOnly: true }),
    trial({ minTrendConsistencyPct: 60, minRecentReturnPct: 1, minVolumeRatio: 2, minRangeRatio: 1.2, shortOnly: true }),
    trial({ minRawProbabilityPct: 80, minRecentReturnPct: 1 }, { mode: 'signal', lookbackBars: 1 })
  ];
  const candidates = new Map(anchors.map(t => [trialId(t), t]));
  while (candidates.size < search.trials) {
    const params = Object.fromEntries(Object.entries(search.mainSpace).map(([k, xs]) => [k, pick(xs)]));
    const hparams = { ...hp, ...Object.fromEntries(Object.entries(search.h4Space).map(([k, xs]) => [k, pick(xs)])) };
    const t = trial(params, { mode: pick(search.filterModes), params: hparams, lookbackBars: pick(search.lookbackBars) });
    candidates.set(trialId(t), t);
  }
  const trials = [...candidates.values()], files = findFiles(config), symbols = selectedSymbols(config, files);
  const metaFile = abs(path.join(config.data.directory, 'meta.json'));
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;
  // Empty archive placeholders cannot supply a research sample. Membership is
  // based on historical availability, never coin profitability or future prices.
  const available = meta ? symbols.filter(s => meta.symbols.find(r => r.symbol === s)?.bars > 0) : symbols;
  const sample = [...available].sort((a, b) => hash(`${search.seed}:${a}`).localeCompare(hash(`${search.seed}:${b}`))).slice(0, search.sampleSymbols).sort();
  const from = Date.parse(config.period.from), to = Date.parse(config.period.to), span = to - from;
  const trainEnd = Math.floor((from + span * config.optimization.trainFraction) / MINUTE) * MINUTE;
  const validationEnd = Math.floor((from + span * (config.optimization.trainFraction + config.optimization.validationFraction)) / MINUTE) * MINUTE;
  const identity = { config, capital, search, trials, sample, engine: engineFingerprint(),
    script: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    files: symbols.map(s => fileFingerprint(files.get(s))), calibration: YAO_CALIBRATION_MODEL };
  const runId = hash(identity).slice(0, 16), directory = abs(path.join(config.output.directory, runId));
  fs.mkdirSync(directory, { recursive: true });
  writeJSON(path.join(directory, 'manifest.json'), identity);
  const status = patch => writeJSON(path.join(directory, 'status.json'), { runId, directory, updatedAt: new Date().toISOString(), ...patch });
  console.log(JSON.stringify({ runId, directory, symbols: symbols.length, sample, trials: trials.length, trainEnd, validationEnd }));
  if (action === 'prepare') { status({ state: 'prepared' }); return directory; }
  if (runtimeWorkers != null && (!Number.isInteger(runtimeWorkers) || runtimeWorkers < 1 || runtimeWorkers > 8)) throw new Error('--workers 为 1~8 整数');
  const pool = new ScanPool(runtimeWorkers ?? config.output.workers);
  let finished = 0, stage = 'search';
  const pulse = setInterval(() => console.log(`[${stage}] 完成 ${finished} 币种；${directory}`), 30000);
  const scan = async (names, recipes, phase, a, b, boundaries) => {
    finished = 0; stage = phase;
    const cacheId = hash({ engine: identity.engine, config, recipes, a, b, boundaries, files: names.map(s => fileFingerprint(files.get(s))) }).slice(0, 16);
    // Reuse an identical scan after report-only changes as well. The cache id
    // contains the full engine, effective trials, periods, settings and data.
    const cacheName = `scan-${phase}-${cacheId}`;
    const prior = fs.readdirSync(abs(config.output.directory)).map(name => path.join(abs(config.output.directory), name, cacheName))
      .find(candidate => fs.existsSync(candidate));
    const cache = prior || path.join(directory, cacheName); fs.mkdirSync(cache, { recursive: true });
    const result = await Promise.all(names.map(async symbol => {
      const output = path.join(cache, `${symbol}.json.gz`);
      let info;
      if (config.output.resume && fs.existsSync(output)) { const old = unpack(output); info = { symbol, audit: old.audit, funnel: old.funnel, counts: old.opportunities.map(xs => xs.length) }; }
      else info = await pool.submit({ config, symbol, file: files.get(symbol), trials: recipes, from: a, to: b, boundaries, output });
      finished++; status({ state: 'running', stage: phase, finished, total: names.length, symbol });
      console.log(`[${phase}] ${finished}/${names.length} ${symbol} ${info.counts.reduce((x, y) => x + y, 0)} opportunities`);
      return { ...info, output };
    }));
    writeJSON(path.join(directory, `${phase}-coverage.json`), result.map(({ output, ...item }) => item));
    return result;
  };
  const shared = { execution: config.execution, costs: config.costs, capital };
  try {
    const locked = selectionFile ? JSON.parse(fs.readFileSync(abs(selectionFile), 'utf8')) : null;
    if (locked) {
      const priorManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(abs(selectionFile)), 'manifest.json'), 'utf8'));
      if (hash(priorManifest.config) !== hash(config) || hash(priorManifest.files) !== hash(identity.files)
        || hash(priorManifest.search) !== hash(search) || hash(priorManifest.sample) !== hash(sample)
        || trialId(validateTrial(locked.trial)) !== locked.id) throw new Error('冻结选择与当前数据或研究设置不一致');
      writeJSON(path.join(directory, 'frozen-selection-source.json'), { file: selectionFile, selection: locked,
        trainingEngine: priorManifest.engine, replayEngine: identity.engine, reason: '仅优化必要条件预筛性能；参数与留出期继续锁定' });
    }
    const scanned = locked ? [] : await scan(sample, trials, 'search', from, validationEnd, [trainEnd, validationEnd]);
    const rows = scanned.map(s => unpack(s.output));
    const evaluate = (recipes, sourceRows) => recipes.map((t, i) => {
      const xs = sourceRows.flatMap(r => r.opportunities[i]), training = portfolio(xs, { ...shared, from, to: trainEnd }, false);
      const validation = portfolio(xs, { ...shared, from: trainEnd, to: validationEnd }, false);
      const qualifies = training.metrics.trades >= config.optimization.minTrades && validation.metrics.trades >= config.optimization.minTrades
        && training.metrics.maxDrawdown <= config.optimization.maxDrawdown && validation.metrics.maxDrawdown <= config.optimization.maxDrawdown;
      return { id: trialId(t), trial: t, training, validation, qualifies };
    });
    const evaluation = locked ? [] : evaluate(trials, rows);
    const rank = xs => xs.filter(x => x.qualifies).sort((a, b) => b.validation.metrics.returnRate - a.validation.metrics.returnRate || b.training.metrics.returnRate - a.training.metrics.returnRate || a.id.localeCompare(b.id));
    const firstBest = rank(evaluation)[0];
    if (firstBest && search.refinementTrials) {
      const extras = new Map(), refineRng = random(search.seed + 104729), choose = xs => xs[Math.floor(refineRng() * xs.length)];
      while (extras.size < search.refinementTrials) {
        const params = { ...firstBest.trial.params, ...Object.fromEntries(Object.entries(search.refinementSpace).map(([k, xs]) => [k, choose(xs)])) };
        const direction = choose(['both', 'long', 'short']); params.longOnly = direction === 'long'; params.shortOnly = direction === 'short';
        const t = validateTrial({ params, filter: { ...firstBest.trial.filter, mode: choose(['trend', 'signal']) } });
        if (!candidates.has(trialId(t))) extras.set(trialId(t), t);
      }
      const recipes = [...extras.values()];
      writeJSON(path.join(directory, 'refinement-proposals.json'), { anchor: firstBest.id, recipes });
      rows.length = 0;
      const refined = await scan(sample, recipes, 'refinement', from, validationEnd, [trainEnd, validationEnd]);
      const refinementRows = refined.map(s => unpack(s.output));
      evaluation.push(...evaluate(recipes, refinementRows)); refinementRows.length = 0;
      writeJSON(path.join(directory, 'manifest.json'), { ...identity, refinement: recipes });
    }
    if (locked) {
      const sourceDirectory = path.dirname(abs(selectionFile));
      fs.copyFileSync(path.join(sourceDirectory, 'trials.json'), path.join(directory, 'trials.json'));
      const priorManifest = JSON.parse(fs.readFileSync(path.join(sourceDirectory, 'manifest.json'), 'utf8'));
      writeJSON(path.join(directory, 'manifest.json'), { ...identity, refinement: priorManifest.refinement,
        frozenSelectionSource: { file: selectionFile, engine: priorManifest.engine, hash: hash(locked) } });
    } else writeJSON(path.join(directory, 'trials.json'), evaluation);
    const ranked = rank(evaluation);
    const fallback = [...evaluation].sort((a, b) => b.validation.metrics.trades - a.validation.metrics.trades)[0];
    const best = locked ? { id: locked.id, trial: validateTrial(locked.trial), qualifies: locked.qualified,
      training: { metrics: locked.training }, validation: { metrics: locked.validation } } : ranked[0] ?? fallback;
    // Freeze before opening held-out final 20% or all-universe final replay.
    const selected = { id: best.id, trial: best.trial, qualified: best.qualifies, frozenAt: locked?.frozenAt ?? new Date().toISOString(),
      selectedBy: '固定随机币种样本上，训练/验证交易数与回撤通过门槛后，按验证收益选择；测试数据未参与调参',
      sample, trials: locked?.trials ?? evaluation.length, training: best.training.metrics, validation: best.validation.metrics };
    writeJSON(path.join(directory, 'selection.json'), selected);
    // Drop large search tapes before collecting the all-universe tapes.
    rows.length = 0;
    if (action === 'search') { status({ state: 'search_complete', selected }); return directory; }
    const baseline = trial({}, { mode: 'none' });
    const noFilter = { ...best.trial, filter: { ...best.trial.filter, mode: 'none' } };
    const finalTrials = [best.trial, noFilter, baseline];
    const fullScan = await scan(symbols, finalTrials, 'full', from, to, []);
    let outcomes = fullScan.map(s => unpack(s.output));
    const full = finalTrials.map((t, i) => ({ trial: t, ...portfolio(outcomes.flatMap(r => r.opportunities[i]), { ...shared, from, to }) }));
    // All signal candidates are independent of portfolio state. Replaying only
    // those created in test, with a fresh shared account, is an exact test run;
    // it needs no second 39GB parse or second evaluation of identical orders.
    const test = portfolio(outcomes.flatMap(r => r.opportunities[0]), { ...shared, from: validationEnd, to });
    outcomes.length = 0;
    const report = { generatedAt: new Date().toISOString(), runId, period: config.period,
      universe: { files: symbols.length, valid: fullScan.filter(x => x.audit.eligible).length,
        fullHistory: fullScan.filter(x => x.audit.eligible && x.audit.historyStatus === 'full_history').length,
        partialHistory: fullScan.filter(x => x.audit.eligible && x.audit.historyStatus === 'partial_history').length,
        excluded: fullScan.filter(x => !x.audit.eligible).map(x => ({ symbol: x.symbol, reason: x.audit.reason })),
        dataGapTrades: full[0].trades.filter(t => t.reason === 'data_gap').length,
        sha256: fullScan.map(x => ({ symbol: x.symbol, sha256: x.audit.quality.sha256 })) },
      execution: config.execution, costs: config.costs, capital, selection: selected, full: full[0], test,
      comparisons: { selectedWithoutH4: full[1], thresholdFixedBaseline: full[2], productionDefault: { trades: 0, finalEquity: 100,
        reason: '默认 minProbabilityPct=50，高于全部校准分数 46.34；市值历史画像另外缺失' } },
      caveats: [
        '妖币埋伏关闭动态市值候选池；仅为原生 K 线逻辑消融研究，不能宣称完整生产策略已通过。',
        '固定 10x 是用户指定的执行覆盖，超过妖币策略原生推荐上限；撮合启用逐仓损失限制和爆仓。',
        '一年 full 包含训练与验证，是描述性重放；最终 20% test 独立从 100U 开始。',
        '校准表训练时间晚于回测起点。候选统一 minProbabilityPct=40，使常数方向校准表不参与筛选；不把 46.34% 称为无泄漏历史胜率。',
        '资金费使用固定 3 bps/8h 情景而非真实逐期历史费率；滑点是固定 5 bps。',
        '最小名义金额与保证金是研究统一约束，未恢复各币历史 LOT_SIZE / MIN_NOTIONAL / 维持保证金档位与真实盘口。',
        'K 线只在收盘后可见；信号之后一分钟才开始撮合；每分钟收盘盯市仍不能恢复分钟内全部资金轨迹。',
        '有限搜索结果仅代表给定样本和搜索预算的候选优胜；不保证未来收益。'
      ] };
    writeJSON(path.join(directory, 'report.json'), report);
    writeJSON(path.join(directory, 'selected-parameters.json'), { strategyId: MAIN, params: selected.trial.params, filter: selected.trial.filter,
      execution: config.execution, costs: config.costs, capital });
    const headings = ['优化组合', '同妖币参数去掉4H', '仅修复概率门槛的原参数', '最终20%测试组合'];
    const results = [...full, test];
    const markdown = [ '# 妖币埋伏 + 4H 趋势过滤：100U / 固定10倍', '',
      `实际区间：${config.period.from} 至 ${config.period.to}，结束端点不含。${report.universe.files} 个历史合约文件，${report.universe.valid} 个有可用历史；完整覆盖 ${report.universe.fullHistory}，上市/下架部分历史 ${report.universe.partialHistory}。`, '',
      `初始全部币种共享100 USDT；保证金占权益${percent(config.execution.marginPct)}，单笔初始止损风险上限${percent(config.execution.riskPct)}，最多${capital.maxPositions}个活动挂单/持仓，总占用不超过${percent(capital.maxMarginPct)}。`, '',
      '| 情景 | 最终资金U | 净赚U | 收益率 | 最大回撤 | 交易数 | 胜率 | PF | 爆仓 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...results.map((r, i) => `| ${headings[i]} | ${number(r.metrics.finalEquity)} | ${number(r.metrics.net)} | ${percent(r.metrics.returnRate)} | ${percent(r.metrics.maxDrawdown)} | ${r.metrics.trades} | ${r.metrics.winRate == null ? '—' : percent(r.metrics.winRate)} | ${number(r.metrics.profitFactor)} | ${r.capital.liquidations} |`), '',
      `参数选择：${selected.trials}组候选，${sample.length}个固定随机样本币，按前60%训练、随后20%验证选择，剩余20%测试；合格=${selected.qualified}。`, '',
      '```json', JSON.stringify({ params: selected.trial.params, h4: selected.trial.filter }, null, 2), '```', '',
      '| 月份 | 期初U | 期末U | 当月收益 |', '|---|---:|---:|---:|',
      ...Object.entries(report.full.monthly).map(([m, r]) => `| ${m} | ${number(r.startEquity)} | ${number(r.endEquity)} | ${percent(r.returnRate)} |`), '',
      ...report.caveats.map(c => `- ${c}`), '', `原始成交、权益曲线和成本：[report.json](report.json)。复现：node scripts/explore-yao-h4-combination.mjs --config ${configFile}`
    ].join('\n');
    fs.writeFileSync(path.join(directory, 'report.md'), markdown + '\n');
    status({ state: 'complete', selectedId: selected.id, result: report.full.metrics, test: report.test.metrics });
    console.log(JSON.stringify({ directory, full: report.full.metrics, test: report.test.metrics, comparisons: full.slice(1).map(r => r.metrics) }));
    return directory;
  } catch (e) { status({ state: 'failed', stage, error: e.stack }); throw e; }
  finally { clearInterval(pulse); await pool.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), file = args[args.indexOf('--config') + 1];
  if (!file || !args.includes('--config')) throw new Error('用法: node scripts/explore-yao-h4-combination.mjs --config configs/yao-h4-100u-10x.json [--prepare|--search-only]');
  const selectionFile = args.includes('--selection') ? args[args.indexOf('--selection') + 1] : null;
  const runtimeWorkers = args.includes('--workers') ? Number(args[args.indexOf('--workers') + 1]) : null;
  research(file, args.includes('--prepare') ? 'prepare' : args.includes('--search-only') ? 'search' : 'run', selectionFile, runtimeWorkers).catch(e => { console.error(e.stack); process.exitCode = 1; });
}
