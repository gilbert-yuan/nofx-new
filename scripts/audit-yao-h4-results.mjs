import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
if (process.argv[2] === '--compare-scan') {
  const { scanCoin } = await import('./backtest/yao-h4.mjs');
  const { loadConfig, hash } = await import('./backtest/config.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.resolve(process.argv[3])));
  const selection = JSON.parse(fs.readFileSync(path.resolve(process.argv[4])));
  const originalFile = path.resolve(process.argv[5]);
  const original = JSON.parse(zlib.gunzipSync(fs.readFileSync(originalFile)));
  const { getStrategy, loadConfiguredStrategy } = await import('../server/strategies/index.js');
  const current = (await loadConfiguredStrategy('yao-coin-ambush-v1')).strategy.params;
  const hp = (await loadConfiguredStrategy('h4-trend-breakout-v1')).strategy.params;
  const recipes = [selection.trial, { ...selection.trial, filter: { ...selection.trial.filter, mode: 'none' } },
    { params: { ...current, marketUniverseEnabled: false, minProbabilityPct: 40 }, filter: { mode: 'none', params: hp, lookbackBars: 0 } }];
  const config = loadConfig(null, manifest.config), from = Date.parse(config.period.from), to = Date.parse(config.period.to);
  const started = Date.now();
  const result = await scanCoin({ config, file: path.resolve(config.data.directory, 'klines', `${original.symbol}.ndjson`),
    symbol: original.symbol, trials: recipes, from, to, boundaries: [] });
  assert.equal(hash(JSON.parse(JSON.stringify(result.opportunities))), hash(original.opportunities),
    '优化前后逐笔信号、撮合、费用和逐分钟权益必须完全一致');
  console.log(JSON.stringify({ equivalent: true, symbol: original.symbol, milliseconds: Date.now() - started, opportunities: result.opportunities.map(xs => xs.length) }));
  process.exit(0);
}
const target = path.resolve(process.argv[2] || '');
if (fs.statSync(target).isDirectory()) {
  const totals = { files: 0, opportunities: 0, filled: 0, manual: 0, forced: 0, dataGaps: 0 };
  for (const name of fs.readdirSync(target).filter(n => n.endsWith('.json.gz'))) {
    const r = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(target, name)))); totals.files++;
    for (const xs of r.opportunities) for (const o of xs) {
      totals.opportunities++; if (o.filled) totals.filled++;
      if (o.reason === 'manual' && !o.periodEnd) totals.manual++;
      if (o.periodEnd) totals.forced++;
      if (o.reason === 'data_gap') totals.dataGaps++;
      assert.ok(o.h4AsOf == null || o.h4AsOf <= o.time);
      assert.ok(!o.filled || Date.parse(o.entryAt) >= o.time);
      assert.equal(o.leverage, 10);
    }
  }
  console.log(JSON.stringify(totals));
} else {
  const r = JSON.parse(fs.readFileSync(target, 'utf8'));
  const all = [r.full, r.test, r.comparisons.selectedWithoutH4, r.comparisons.thresholdFixedBaseline];
  for (const scenario of all) {
    const sum = key => scenario.trades.reduce((s, t) => s + t[key], 0);
    for (const key of ['net', 'fees', 'funding']) assert.ok(Math.abs(sum(key) - scenario.metrics[key]) < 1e-7, key);
    assert.ok(Math.abs(scenario.metrics.finalEquity - 100 - sum('net')) < 1e-7);
    assert.equal(scenario.trades.length, scenario.metrics.trades);
    assert.ok(scenario.capital.maxConcurrent <= r.capital.maxPositions);
    assert.ok(scenario.capital.maxMarginRatio <= r.capital.maxMarginPct + 1e-9);
    for (const t of scenario.trades) {
      assert.equal(t.leverage, 10);
      assert.ok(t.h4AsOf == null || t.h4AsOf <= t.time);
      assert.ok(Date.parse(t.entryAt) >= t.time);
      assert.ok(t.end >= Date.parse(t.entryAt));
      assert.ok(t.margin >= r.capital.minMargin);
    }
  }
  console.log(JSON.stringify({ state: 'verified', universe: r.universe.valid, trials: r.selection.trials,
    selection: r.selection.id, full: r.full.metrics, test: r.test.metrics,
    monthly: r.full.monthly, comparisons: all.slice(2).map(s => s.metrics) }));
}
