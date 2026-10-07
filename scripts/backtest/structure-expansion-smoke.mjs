import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { abs } from './config.mjs';
import { tradeMetrics } from './stats.mjs';
import { historyBounds, prepare, compareRows, monthlyComparison, runExpansion } from '../backtest-structure-confirmation-v1.mjs';

const directory = fs.mkdtempSync(abs('output/structure-expansion-smoke-'));
try {
  const csv = path.join(directory, 'bounds.csv'), json = path.join(directory, 'bounds.json');
  fs.writeFileSync(csv, 'open_time,open,high,low,close,volume\n1791158400000,1,1,1,1,1\n1791158460000,1,1,1,1,1\n');
  fs.writeFileSync(json, '{"openTime":1791158400000}\n{"openTime":1791158460000}\n');
  assert.deepEqual(historyBounds(csv), { first: 1791158400000, last: 1791158460000 });
  assert.deepEqual(historyBounds(json), historyBounds(csv));
  fs.writeFileSync(csv, ''); assert.deepEqual(historyBounds(csv), { first: null, last: null });
  const fixture = (symbol, net, matched = false) => ({ symbol, status: 'ok',
    metrics: tradeMetrics([{ net }], 1000, 1000 + net, 0.01),
    trades: [{ net, exitAt: '2026-10-06T00:00:00.000Z', confirmation: { members: [{ strategyId: 'structure-long-v1', matched }] } }],
    monthly: { '2026-10': { startEquity: 1000, endEquity: 1000 + net, returnRate: net / 1000 } } });
  const a = [fixture('BTCUSDT', -10), fixture('ETHUSDT', 5, true), { symbol: 'SOLUSDT', status: 'error' }];
  const b = [fixture('BTCUSDT', 2), fixture('ETHUSDT', -1), fixture('SOLUSDT', 8)];
  const comparison = compareRows(a, b);
  assert.equal(comparison.pairedCoins, 2); assert.equal(comparison.withStructure.net, 1);
  assert.equal(comparison.improvedCoins, 1); assert.equal(comparison.worsenedCoins, 1);
  assert.equal(comparison.overlap.retainedWins, 1); assert.equal(comparison.overlap.rejectedLosses, 1);
  assert.equal(monthlyComparison(a, b)[0].withStructure.net, 1);
  const config = JSON.parse(fs.readFileSync(abs('scripts/backtest/structure-expansion.json'), 'utf8'));
  const prepared = prepare('scripts/backtest/structure-expansion.json');
  assert.equal(prepared.symbols.length, 64); assert.equal(new Set(prepared.symbols).size, 64);
  assert.ok(config.selection.priorSymbols.every(s => prepared.symbols.includes(s)));
  config.backtest.period = { from: '2026-10-05T00:00:00.000Z', to: '2026-10-05T01:00:00.000Z', warmupDays: 90 };
  config.backtest.data.symbols = ['GIGGLEUSDT']; config.backtest.data.minObservedDays = 0;
  config.backtest.output.directory = path.join(directory, 'results'); config.backtest.output.workers = 1;
  config.selection = { seed: 1, maxSymbols: 1, includeSymbols: ['GIGGLEUSDT'], priorSymbols: [] };
  const file = path.join(directory, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  const report = await runExpansion(file);
  assert.equal(report.all.pairedCoins, 1); assert.equal(report.excludedOrErrors.length, 0);
  assert.ok(fs.existsSync(path.join(report.directory, 'report.md')));
  assert.equal(report.rows.withoutFilter[0].strategyId, 'enhanced-trend-v1');
  console.log('structure expansion smoke passed');
} finally {
  // Only this process's newly allocated fixture directory is removed.
  assert.ok(directory.startsWith(abs('output') + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
