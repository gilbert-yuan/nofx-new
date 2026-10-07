import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStrategy } from '../server/strategies/index.js';
import { abs, loadConfig, hash, writeJSON, validateParams, DAY, MINUTE } from './backtest/config.mjs';
import { findFiles, selectedSymbols, fileFingerprint } from './backtest/data.mjs';
import { ReplayPool } from './backtest/pool.mjs';
import { summarize, mean } from './backtest/stats.mjs';
import { engineFingerprint } from './backtest/system.mjs';
import { validateConfirmation, overlap } from './backtest/confirmation.mjs';

const MAIN = 'enhanced-trend-v1';
const pct = n => n == null ? '—' : `${(n * 100).toFixed(3)}%`;
const money = n => n == null ? '—' : n.toFixed(2);

// Bounds are used only to avoid selecting additional coins whose files cannot
// cover the requested window and warmup. Replay still audits every actual bar.
export function historyBounds(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, bytes = Math.min(size, 65536);
    if (!bytes) return { first: null, last: null };
    const read = position => {
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, position);
      return buffer.toString('utf8').split(/\r?\n/);
    };
    const time = line => {
      try {
        let t = line.startsWith('{') ? Number(JSON.parse(line).openTime) : Number(line.split(',')[0]);
        if (t > 1e14) t /= 1000;
        return t > 1e11 && t % MINUTE === 0 ? t : null;
      } catch { return null; }
    };
    const first = read(0).map(time).find(t => t != null) ?? null;
    const tail = read(size - bytes);
    if (size > bytes) tail.shift();
    const last = tail.reverse().map(time).find(t => t != null) ?? null;
    return { first, last };
  } finally { fs.closeSync(fd); }
}

export function prepare(file) {
  const raw = JSON.parse(fs.readFileSync(abs(file), 'utf8'));
  for (const key of Object.keys(raw)) if (!['backtest', 'recipe', 'selection', 'source'].includes(key)) throw new Error(`未知配置 ${key}`);
  const config = loadConfig(null, raw.backtest || {});
  const recipe = { params: validateParams(getStrategy(MAIN), raw.recipe?.params || {}), confirmation: validateConfirmation(raw.recipe?.confirmation) };
  if (!recipe.params.longOnly || recipe.confirmation?.mode !== 'all' || recipe.confirmation.members.length !== 1
    || recipe.confirmation.members[0].strategyId !== 'structure-long-v1') throw new Error('此实验要求只做多增强趋势 + 单一结构做多确认');
  if (config.features.enabled || Object.keys(config.strategies).length) throw new Error('冻结参数验证不接受额外特征过滤或 strategies 覆盖');
  const selection = { seed: 20261008, maxSymbols: 64, includeSymbols: [], priorSymbols: [], ...raw.selection };
  for (const key of Object.keys(selection)) if (!['seed', 'maxSymbols', 'includeSymbols', 'priorSymbols'].includes(key)) throw new Error(`未知 selection.${key}`);
  if (!Number.isInteger(selection.seed) || !Number.isInteger(selection.maxSymbols) || selection.maxSymbols < 1) throw new Error('seed/maxSymbols 必须为整数且 maxSymbols > 0');
  for (const key of ['includeSymbols', 'priorSymbols']) if (!Array.isArray(selection[key]) || selection[key].some(s => typeof s !== 'string')) throw new Error(`${key} 必须为币种数组`);
  const files = findFiles(config), requested = selectedSymbols(config, files), required = [...new Set(selection.includeSymbols)].sort();
  if (required.length > selection.maxSymbols || required.some(s => !requested.includes(s) || !files.has(s))) throw new Error('必选币种不存在或超过 maxSymbols');
  const bounds = new Map(requested.filter(s => files.has(s)).map(s => [s, historyBounds(files.get(s))]));
  const from = Date.parse(config.period.from), to = Date.parse(config.period.to), warmupFrom = from - config.period.warmupDays * DAY;
  const candidates = requested.filter(s => !required.includes(s) && bounds.get(s)?.first <= warmupFrom
    && bounds.get(s)?.last >= to - MINUTE && bounds.get(s)?.first != null);
  candidates.sort((a, b) => hash(`${selection.seed}:${a}`).localeCompare(hash(`${selection.seed}:${b}`)));
  const symbols = [...required, ...candidates.slice(0, selection.maxSymbols - required.length)].sort();
  if (symbols.length !== selection.maxSymbols) throw new Error(`完整文件候选不足：只能选 ${symbols.length}/${selection.maxSymbols} 币`);
  return { config, recipe, selection, source: raw.source || null, files, symbols,
    eligibility: { requested: requested.length, additionalCandidatesWithWindowAndWarmup: candidates.length,
      method: '保留预先指定币种；新增币种需文件首尾覆盖评估期及暖机，按种子和名称哈希选择，不按收益筛选',
      selectedBounds: Object.fromEntries(symbols.map(s => [s, bounds.get(s)])) } };
}

export function compareRows(control, filtered) {
  const valid = control.filter(a => a.status === 'ok' && filtered.some(b => b.symbol === a.symbol && b.status === 'ok')).map(r => r.symbol);
  const a = control.filter(r => valid.includes(r.symbol)), b = filtered.filter(r => valid.includes(r.symbol));
  const pairs = a.map(row => {
    const other = b.find(r => r.symbol === row.symbol);
    return { symbol: row.symbol, withoutReturn: row.metrics.returnRate, withReturn: other.metrics.returnRate,
      deltaReturn: other.metrics.returnRate - row.metrics.returnRate, withoutNet: row.metrics.net, withNet: other.metrics.net,
      withoutTrades: row.metrics.trades, withTrades: other.metrics.trades, withDrawdown: other.metrics.maxDrawdown,
      confirmationUnavailable: other.funnel?.confirmationUnavailable || 0 };
  }).sort((x, y) => y.withNet - x.withNet || x.symbol.localeCompare(y.symbol));
  const active = pairs.filter(r => r.withoutTrades || r.withTrades).map(r => r.symbol);
  const positiveNet = pairs.reduce((s, r) => s + Math.max(0, r.withNet), 0), best = pairs[0];
  return { pairedCoins: valid.length, withoutFilter: summarize(a), withStructure: summarize(b),
    deltaMeanReturn: valid.length ? mean(pairs.map(r => r.deltaReturn)) : null,
    improvedCoins: pairs.filter(r => r.deltaReturn > 1e-12).length, worsenedCoins: pairs.filter(r => r.deltaReturn < -1e-12).length,
    unchangedCoins: pairs.filter(r => Math.abs(r.deltaReturn) <= 1e-12).length,
    activeCoinComparison: { coins: active.length, withoutFilter: summarize(a.filter(r => active.includes(r.symbol))),
      withStructure: summarize(b.filter(r => active.includes(r.symbol))) },
    bestCoinShareOfPositiveCoinNet: positiveNet > 0 ? Math.max(0, best.withNet) / positiveNet : null,
    withoutBestFilteredCoin: best ? { symbol: best.symbol, ...summarize(b.filter(r => r.symbol !== best.symbol)) } : null,
    overlap: overlap(a, 'structure-long-v1'), pairs };
}

export function monthlyComparison(control, filtered) {
  const valid = control.filter(a => a.status === 'ok' && filtered.some(b => b.symbol === a.symbol && b.status === 'ok')).map(r => r.symbol);
  const months = [...new Set([...control, ...filtered].flatMap(r => Object.keys(r.monthly || {})))].sort();
  const aggregate = (rows, month) => {
    const selected = rows.filter(r => valid.includes(r.symbol) && r.monthly?.[month]);
    const closed = selected.flatMap(r => r.trades.filter(t => new Date(Date.parse(t.exitAt) - 1).toISOString().slice(0, 7) === month));
    const profit = closed.reduce((s, t) => s + Math.max(0, t.net), 0), loss = closed.reduce((s, t) => s - Math.min(0, t.net), 0);
    return { coins: selected.length, meanReturn: selected.length ? mean(selected.map(r => r.monthly[month].returnRate)) : null,
      net: selected.reduce((s, r) => s + r.monthly[month].endEquity - r.monthly[month].startEquity, 0),
      profitableCoins: selected.filter(r => r.monthly[month].endEquity > r.monthly[month].startEquity).length,
      trades: closed.length, profitFactor: loss > 0 ? profit / loss : null };
  };
  return months.map(month => ({ month, withoutFilter: aggregate(control, month), withStructure: aggregate(filtered, month) }));
}

export async function runExpansion(file) {
  const plan = prepare(file), { config, recipe, selection, symbols, files } = plan;
  const fingerprint = { version: 1, engine: engineFingerprint(), script: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    config, recipe, selection, source: plan.source, symbols, files: symbols.map(s => fileFingerprint(files.get(s))) };
  const runId = hash(fingerprint).slice(0, 16), directory = abs(path.join(config.output.directory, runId));
  const replayId = hash({ engine: fingerprint.engine, config, recipe, files: fingerprint.files }).slice(0, 16);
  const cache = abs(path.join(config.output.directory, `replays-${replayId}`));
  writeJSON(path.join(directory, 'manifest.json'), { ...fingerprint, eligibility: plan.eligibility });
  writeJSON(path.join(directory, 'frozen-parameters.json'), { executionStrategy: MAIN, recipe, execution: config.execution, costs: config.costs, source: plan.source });
  const rows = { withoutFilter: [], withStructure: [] }, pool = new ReplayPool(config.output.workers);
  let completed = 0;
  const status = (stage, extra = {}) => writeJSON(path.join(directory, 'status.json'), { runId, updatedAt: new Date().toISOString(), stage, completedCoins: completed, totalCoins: symbols.length, ...extra });
  status('replaying');
  console.log(JSON.stringify({ directory, period: config.period, coins: symbols.length, workers: config.output.workers, costs: config.costs }));
  const pulse = setInterval(() => console.log(`[扩大结构确认] ${completed}/${symbols.length} 币种完成`), 45000);
  try {
    await Promise.all(symbols.map(async symbol => {
      const pending = [], results = {};
      for (const variant of Object.keys(rows)) {
        const target = path.join(cache, `${symbol}-${variant}.json`);
        if (config.output.resume && fs.existsSync(target)) {
          const value = JSON.parse(fs.readFileSync(target, 'utf8'));
          if (['ok', 'excluded'].includes(value.status)) { results[variant] = value; continue; }
        }
        pending.push({ variant, target, job: { config, strategyId: MAIN, symbol, file: files.get(symbol), params: recipe.params,
          execution: config.execution, costs: config.costs, from: Date.parse(config.period.from), to: Date.parse(config.period.to), keepTrades: true,
          confirmation: variant === 'withoutFilter' ? { ...recipe.confirmation, mode: 'audit' } : recipe.confirmation } });
      }
      if (pending.length) {
        const output = await pool.submit({ kind: 'batch', jobs: pending.map(p => p.job) });
        output.forEach((value, i) => { writeJSON(pending[i].target, value); results[pending[i].variant] = value; });
      }
      for (const variant of Object.keys(rows)) rows[variant].push(results[variant]);
      completed++; status('replaying');
      console.log(`[${completed}/${symbols.length}] ${symbol}: 无过滤 ${pct(results.withoutFilter.metrics?.returnRate)} / 结构 ${pct(results.withStructure.metrics?.returnRate)} (${results.withStructure.status})`);
    }));
    for (const value of Object.values(rows)) value.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const report = { runId, generatedAt: new Date().toISOString(), directory, config, recipe, selection, source: plan.source, symbols,
      eligibility: plan.eligibility, all: compareRows(rows.withoutFilter, rows.withStructure),
      cohorts: Object.fromEntries([['prior', symbols.filter(s => selection.priorSymbols.includes(s))],
        ['additional', symbols.filter(s => !selection.priorSymbols.includes(s))]].map(([key, group]) => [key,
        compareRows(rows.withoutFilter.filter(r => group.includes(r.symbol)), rows.withStructure.filter(r => group.includes(r.symbol)))])),
      monthly: monthlyComparison(rows.withoutFilter, rows.withStructure),
      excludedOrErrors: Object.entries(rows).flatMap(([variant, values]) => values.filter(r => r.status !== 'ok').map(r => ({ variant, symbol: r.symbol, status: r.status, reason: r.reason || r.firstError }))),
      rows, limitations: [
        '冻结上轮结构做多候选的完整参数，不按扩大样本结果再次选择参数。新增币种按名称哈希抽样，包含零交易币种。',
        '扩展较早历史属于回顾性稳健性评估，参数原先已使用后段历史选过；新增币种提供跨币种证据，不是新的未来样本外验证。',
        '每币种独立 1000 USDT（或配置余额）；均值是等权横截面统计，未模拟多币共享资金账户，最差单币回撤不是组合回撤。',
        '下单、退出、风控仍为增强趋势；结构做多只检查已闭合原生同向信号，使用独立初始余额影子账户。',
        '两组连续回放整个评估期；分月从权益变化计算，不按月重置资金或强平，最后一分钟统一强平。',
        '固定手续费、滑点与资金费率；复用项目 1m 逐根撮合和保护规则。文件首尾筛选不替代回放中的实际数据质量检查。',
        '原先必选币种可能缺少完整历史或结构暖机；逐币排除与确认不可用次数单列。比较仅使用两组同时有效的相同币种。',
        '无过滤组以 audit 模式旁观结构信号，不拒绝入场；覆盖率是旧交易的描述统计，过滤组收益通过独立重新撮合得出。'
      ] };
    writeJSON(path.join(directory, 'report.json'), report);
    const summaryRow = (label, r) => `| ${label} | ${r.validCoins} | ${pct(r.meanReturn)} | ${money(r.net)} | ${r.trades} | ${pct(r.winRate)} | ${r.profitFactor?.toFixed(3) ?? '—'} | ${r.profitableCoins} | ${pct(r.worstDrawdown)} |`;
    const sections = ['# 扩大结构做多确认回测', '', `${config.period.from} → ${config.period.to}，${symbols.length} 个请求币种，固定参数 ${plan.source?.trialId || '配置快照'}。`, '',
      '执行策略：增强趋势 v1；结构做多仅为同向入场确认。', '',
      '| 方案 | 有效币种 | 平均收益 | 净收益 USDT | 交易数 | 胜率 | 盈亏比 PF | 盈利币种 | 最差单币回撤 |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      summaryRow('同参数无过滤', report.all.withoutFilter), summaryRow('结构做多确认', report.all.withStructure), '',
      `平均收益改善 ${pct(report.all.deltaMeanReturn)}（百分点）；改善 ${report.all.improvedCoins} 币，变差 ${report.all.worsenedCoins} 币，无变化 ${report.all.unchangedCoins} 币。`, '',
      '## 币种外推', '', '| 样本 | 同参数无过滤平均收益 | 结构确认平均收益 | 结构成交 | 盈利币种 |', '| --- | ---: | ---: | ---: | ---: |',
      ...Object.entries(report.cohorts).map(([k, r]) => `| ${k === 'prior' ? '原先币种' : '新增币种'} (${r.pairedCoins}) | ${pct(r.withoutFilter.meanReturn)} | ${pct(r.withStructure.meanReturn)} | ${r.withStructure.trades} | ${r.withStructure.profitableCoins} |`), '',
      '## 分月（连续账户权益；首尾月份为不完整月份）', '', '| 月份 UTC | 无过滤平均收益 | 结构平均收益 | 无过滤净额 | 结构净额 | 结构平仓交易 |', '| --- | ---: | ---: | ---: | ---: | ---: |',
      ...report.monthly.map(r => `| ${r.month} | ${pct(r.withoutFilter.meanReturn)} | ${pct(r.withStructure.meanReturn)} | ${money(r.withoutFilter.net)} | ${money(r.withStructure.net)} | ${r.withStructure.trades} |`), '',
      '## 盈利集中度与信号覆盖', '',
      `- 最大盈利币占所有盈利币正净额 ${pct(report.all.bestCoinShareOfPositiveCoinNet)}。`,
      `- 移除最大盈利币 ${report.all.withoutBestFilteredCoin?.symbol || '—'} 后，结构组平均收益 ${pct(report.all.withoutBestFilteredCoin?.meanReturn)}。`,
      `- 无过滤成交的盈利交易保留 ${report.all.overlap.retainedWins}/${report.all.overlap.winningTrades} (${pct(report.all.overlap.winningTradeCoverage)})；亏损交易过滤 ${report.all.overlap.rejectedLosses}/${report.all.overlap.losingTrades} (${pct(report.all.overlap.losingTradeRejection)})。`,
      `- 确认数据不足的无过滤成交 ${report.all.overlap.unavailableTrades} 笔。`, '',
      '## 全部逐币对照', '', '| 币种 | 无过滤收益 | 结构收益 | 无过滤成交 | 结构成交 | 结构回撤 | 确认不可用信号 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...report.all.pairs.map(r => `| ${r.symbol} | ${pct(r.withoutReturn)} | ${pct(r.withReturn)} | ${r.withoutTrades} | ${r.withTrades} | ${pct(r.withDrawdown)} | ${r.confirmationUnavailable} |`), '',
      '## 排除或错误', '', ...(report.excludedOrErrors.length ? report.excludedOrErrors.map(r => `- ${r.symbol} / ${r.variant}: ${r.status} / ${r.reason}`) : ['无。']), '',
      '## 复现与范围', '', '```powershell', `node scripts/backtest-structure-confirmation-v1.mjs --config ${file}`, '```', '', ...report.limitations.map(s => `- ${s}`), ''];
    fs.writeFileSync(path.join(directory, 'report.md'), sections.join('\n'));
    const errors = report.excludedOrErrors.filter(r => r.status !== 'excluded');
    status(errors.length ? 'completed_with_errors' : 'completed', { report: path.join(directory, 'report.md'), errorCount: errors.length });
    console.log(JSON.stringify({ directory, comparison: { withoutFilter: report.all.withoutFilter, withStructure: report.all.withStructure }, errors }, null, 2));
    return report;
  } catch (error) { status('failed', { error: error.message }); throw error; }
  finally { clearInterval(pulse); await pool.close(); }
}

async function main(args) {
  const planOnly = args.includes('--plan');
  args = args.filter(s => s !== '--plan');
  if (args.length !== 2 || args[0] !== '--config') throw new Error('node scripts/backtest-structure-confirmation-v1.mjs --config scripts/backtest/structure-expansion.json [--plan]');
  if (planOnly) {
    const p = prepare(args[1]);
    console.log(JSON.stringify({ period: p.config.period, symbols: p.symbols, eligibility: p.eligibility, source: p.source }, null, 2));
  } else await runExpansion(args[1]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(e => { console.error(e.stack); process.exitCode = 1; });
