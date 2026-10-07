import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { abs, ROOT, DAY, hash, writeJSON } from './backtest/config.mjs';
import { engineFingerprint } from './backtest/system.mjs';
import { compareRows, monthlyComparison } from './backtest-structure-confirmation-v1.mjs';

const pct = n => n == null ? '—' : `${(100 * n).toFixed(3)}%`;
const money = n => n.toFixed(2);
// A concurrent research task can add unrelated files to the broad engine hash.
// Removing explicitly listed additions must reproduce the recorded hash exactly;
// this cannot bypass any change to an original engine file.
function fingerprintWithoutAdditions(additions) {
  const excluded = new Set(additions.map(p => path.relative(ROOT, abs(p)).replaceAll('\\', '/')));
  const digest = createHash('sha256');
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = path.relative(ROOT, file);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (/\.(js|mjs)$/.test(name) && !excluded.has(relative.replaceAll('\\', '/')))
        digest.update(relative).update(fs.readFileSync(file));
    }
  }
  for (const directory of ['scripts/backtest', 'server', 'shared']) walk(abs(directory));
  for (const file of fs.readdirSync(abs('scripts')).sort()) if (/^backtest-(?:system|campaign|deploy|.*-v1)\.mjs$/.test(file)
    && !excluded.has(`scripts/${file}`)) digest.update(file).update(fs.readFileSync(abs(`scripts/${file}`)));
  if (fs.existsSync(abs('package-lock.json'))) digest.update(fs.readFileSync(abs('package-lock.json')));
  return digest.digest('hex');
}
export function summarizeExpansion(file, additions = []) {
  const input = abs(file), sourceText = fs.readFileSync(input, 'utf8'), r = JSON.parse(sourceText);
  const directory = path.dirname(input), manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const currentEngine = engineFingerprint(), originalEngine = additions.length ? fingerprintWithoutAdditions(additions) : currentEngine;
  assert.equal(manifest.engine, originalEngine, '原有引擎文件发生变化；请使用原运行代码审计或重新回放');
  assert.equal(hash(r.recipe).slice(0, 16), r.source.trialId, '参数不是上轮冻结候选');
  const sufficientlyWarmed = r.symbols.filter(s => r.eligibility.selectedBounds[s].first != null
    && r.eligibility.selectedBounds[s].first <= Date.parse(r.config.period.from) - r.config.period.warmupDays * DAY);
  const pick = rows => rows.filter(row => sufficientlyWarmed.includes(row.symbol));
  const diagnostics = {};
  for (const [variant, rows] of Object.entries(r.rows)) {
    const valid = rows.filter(row => row.status === 'ok'), trades = valid.flatMap(row => row.trades), reasons = {};
    for (const row of valid) {
      const closedNet = row.trades.reduce((s, t) => s + t.net, 0);
      const monthlyNet = Object.values(row.monthly).reduce((s, m) => s + m.endEquity - m.startEquity, 0);
      assert.ok(Math.abs(closedNet - row.metrics.net) < 1e-6, `${row.symbol} 平仓收益不一致`);
      assert.ok(Math.abs(monthlyNet - row.metrics.net) < 1e-6, `${row.symbol} 月度权益不一致`);
      assert.equal(row.analysisErrors, 0);
    }
    for (const t of trades) {
      assert.equal(t.strategyId, 'enhanced-trend-v1'); assert.equal(t.direction, 'OPEN_LONG');
      assert.ok(Date.parse(t.createdAt) <= Date.parse(t.entryAt));
      assert.ok(Date.parse(t.entryAt) <= Date.parse(t.exitAt));
      for (const member of t.confirmation.members) if (member.asOf)
        assert.ok(Date.parse(member.asOf) <= Date.parse(t.createdAt), '使用了未来结构信号');
      if (variant === 'withStructure') {
        assert.equal(t.confirmation.passed, true);
        assert.ok(t.confirmation.members.some(m => m.matched && m.direction === 'OPEN_LONG' && m.ageBars <= 1));
      }
      assert.ok(Math.abs(t.net - (t.gross - t.fees - t.funding)) < 1e-6, '成本结算不一致');
      const reason = reasons[t.reason] ||= { trades: 0, net: 0 }; reason.trades++; reason.net += t.net;
    }
    const sum = key => trades.reduce((s, t) => s + Number(t[key] || 0), 0);
    diagnostics[variant] = { trades: trades.length, net: sum('net'), gross: sum('gross'), fees: sum('fees'), funding: sum('funding'),
      averageNetPerTrade: trades.length ? sum('net') / trades.length : null,
      coverageBelowOne: valid.filter(row => row.coverage.coverage < 1).map(row => row.symbol),
      invalidDataRows: valid.reduce((s, row) => s + row.coverage.quality.invalidRows, 0),
      duplicateDataRows: valid.reduce((s, row) => s + row.coverage.quality.duplicateRows, 0),
      dataGapRuns: valid.reduce((s, row) => s + row.coverage.quality.gapRuns, 0), reasons };
  }
  const supplemental = { runId: r.runId, sourceHash: hash(sourceText), scriptHash: hash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    engineConsistency: { recorded: manifest.engine, current: currentEngine, originalFilesVerified: originalEngine, unrelatedAdditions: additions },
    warmupCriterionDays: r.config.period.warmupDays, fullyWarmed: compareRows(pick(r.rows.withoutFilter), pick(r.rows.withStructure)),
    fullyWarmedMonthly: monthlyComparison(pick(r.rows.withoutFilter), pick(r.rows.withStructure)),
    insufficientStartingWarmupSymbols: r.symbols.filter(s => !sufficientlyWarmed.includes(s)),
    diagnostics, verification: '执行策略/方向、结构观察时间、冻结参数、逐笔成本、平仓净额和分月权益一致性均通过' };
  writeJSON(path.join(directory, 'supplemental-report.json'), supplemental);
  const marker = '\n## 完整暖机子集与结算核对\n', reportFile = path.join(directory, 'report.md');
  const original = fs.readFileSync(reportFile, 'utf8').split(marker)[0];
  const a = supplemental.fullyWarmed;
  fs.writeFileSync(reportFile, original + marker + '\n' + [
    `要求评估起点前已有 ${supplemental.warmupCriterionDays} 天历史；同币有效样本 ${a.pairedCoins} 个。`, '',
    `- 同参数无过滤平均收益 ${pct(a.withoutFilter.meanReturn)}；结构确认平均收益 ${pct(a.withStructure.meanReturn)}。`,
    `- 结构确认交易 ${a.withStructure.trades} 笔，净盈利币种 ${a.withStructure.profitableCoins} 个，最大单币回撤 ${pct(a.withStructure.worstDrawdown)}。`,
    `- 起点暖机不足币种：${supplemental.insufficientStartingWarmupSymbols.join(', ')}。`, '',
    '| 成本与期望（全部有效样本） | 无过滤 | 结构确认 |', '| --- | ---: | ---: |',
    ...[['毛收益', 'gross'], ['手续费', 'fees'], ['资金费', 'funding'], ['净收益', 'net'], ['平均单笔净收益', 'averageNetPerTrade']]
      .map(([label, key]) => `| ${label} USDT | ${money(diagnostics.withoutFilter[key])} | ${money(diagnostics.withStructure[key])} |`), '',
    supplemental.verification, ''
  ].join('\n'));
  console.log(JSON.stringify({ fullyWarmed: { withoutFilter: a.withoutFilter, withStructure: a.withStructure }, diagnostics, verification: supplemental.verification }, null, 2));
  return supplemental;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--exclude-new-files')) throw new Error('node scripts/summarize-structure-expansion.mjs <report.json> [--exclude-new-files comma,separated,paths]');
    summarizeExpansion(args[0], args[2] ? args[2].split(',') : []);
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
