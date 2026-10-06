import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { analyzeFlowPatterns, DEFAULT_FLOW_ANALYSIS_PARAMS } from '../server/flowPatternAnalysis.js';
import { createFlowAnalysisRouter } from '../server/routes/flowAnalysis.js';
import { normalizeBinanceKline } from '../server/marketDb.js';
import { DEFAULT_FLOW_ANALYSIS_PARAMS as sharedDefaults } from '../shared/flowAnalysis.js';

const HOUR = 60 * 60 * 1000;

function candles({ count = 80, start = 1_700_000_000_000, close = 100, volume = 1000, step = 0, volumeStep = 0, confirmed = true } = {}) {
  const rows = [];
  let price = close;
  for (let i = 0; i < count; i++) {
    const open = price;
    price = Math.max(1, price + step);
    const high = Math.max(open, price) * 1.002;
    const low = Math.min(open, price) * 0.998;
    rows.push({
      openTime: start + i * HOUR,
      open, high, low, close: price,
      volume: Math.max(1, volume + i * volumeStep),
      confirmed
    });
  }
  return rows;
}

test('shared flow-analysis defaults are the engine source of truth', () => {
  assert.equal(DEFAULT_FLOW_ANALYSIS_PARAMS.forecastHighScore, sharedDefaults.forecastHighScore);
  assert.deepEqual(DEFAULT_FLOW_ANALYSIS_PARAMS.lookaheadBarsByInterval, sharedDefaults.lookaheadBarsByInterval);
});

test('unconfirmed bars are dropped and empty windows stay labelled as insufficient', () => {
  const report = analyzeFlowPatterns({
    symbol: 'BTCUSDT',
    primaryInterval: '1h',
    datasets: { '1h': candles({ count: 80, confirmed: false }) }
  });
  assert.equal(report.primary.usableBars, 0);
  assert.equal(report.stage.patternKey, null);
  assert.ok(report.warnings.some(item => item.includes('没有可用')));
});

test('clamps inverted volume-ratio bounds and keeps forecastHighScore above medium', () => {
  const report = analyzeFlowPatterns({
    symbol: 'BTCUSDT',
    primaryInterval: '1h',
    datasets: { '1h': candles({ count: 80 }) },
    params: {
      accumulationVolumeRatioMin: 4,
      accumulationVolumeRatioMax: 0.5,
      forecastMediumScore: 90,
      forecastHighScore: 20
    }
  });
  const { thresholds } = report.rules;
  assert.ok(thresholds.accumulationVolumeRatioMax >= thresholds.accumulationVolumeRatioMin);
  assert.ok(thresholds.forecastHighScore > thresholds.forecastMediumScore);
});

test('volume breakout with closed bars is labelled markup, not a calibrated probability', () => {
  const history = candles({ count: 40, close: 100, volume: 100, step: 0 });
  const recent = candles({
    count: 5,
    start: history.at(-1).openTime + HOUR,
    close: history.at(-1).close,
    volume: 400,
    step: 0
  });
  const last = recent.at(-1);
  last.close = Math.max(...history.map(row => row.high)) * 1.04;
  last.high = last.close * 1.01;
  last.open = last.close * 0.99;
  const report = analyzeFlowPatterns({
    symbol: 'BTCUSDT',
    primaryInterval: '1h',
    datasets: { '1h': [...history, ...recent] }
  });
  assert.equal(report.stage.patternKey, 'markup');
  assert.match(report.forecast.scoreMeaning, /非经历史回测校准/);
});

test('high-volume stall near the range high is labelled distribution risk', () => {
  const base = candles({ count: 30, close: 100, volume: 100, step: 0.4 });
  const stall = candles({
    count: 5,
    start: base.at(-1).openTime + HOUR,
    close: base.at(-1).close,
    volume: 400,
    step: 0
  });
  const last = stall.at(-1);
  last.high = last.close * 1.04;
  last.low = last.close * 0.999;
  last.open = last.close * 1.001;
  const report = analyzeFlowPatterns({
    symbol: 'ETHUSDT',
    primaryInterval: '1h',
    datasets: { '1h': [...base, ...stall] }
  });
  assert.equal(report.stage.patternKey, 'distribution');
  assert.ok(report.warnings.some(item => item.includes('派发')));
  assert.ok(report.forecast.ruleScore < 40);
});

test('missing taker/net-flow fields are not invented and stay out of the score', () => {
  const report = analyzeFlowPatterns({
    symbol: 'BTCUSDT',
    primaryInterval: '1h',
    datasets: { '1h': candles({ count: 50 }) }
  });
  assert.equal(report.primary.metrics.hasFlowData, false);
  assert.equal(report.primary.metrics.netFlow, null);
  assert.ok(report.warnings.some(item => item.includes('资金流')));
});

test('normalizeBinanceKline keeps quote taker volume instead of approximating it from close', () => {
  const row = normalizeBinanceKline([1, '100', '105', '95', '102', '10', 2, '1020', '100', '5', '510', '0']);
  assert.equal(row.takerBuyVolume, 5);
  assert.equal(row.takerBuyQuoteVolume, 510);
});

function createTestApp(container) {
  const app = express();
  app.use(express.json());
  app.use(createFlowAnalysisRouter(container));
  app.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: error.message || 'Internal server error' });
  });
  return app;
}

async function listen(app) {
  const server = await new Promise(resolve => {
    const httpServer = app.listen(0, '127.0.0.1', () => resolve(httpServer));
  });
  return { server, port: server.address().port };
}

test('live flow-analysis route is read-only and does not persist klines', async () => {
  const rows = candles({ count: 40 });
  let saved = 0;
  const app = createTestApp({
    marketData: {
      provider: 'binance',
      marketType: 'futures',
      storageSymbol: symbol => `BINANCE_${symbol}`,
      klines: async () => rows
    },
    marketDb: { saveKlines: async () => { saved += 1; } }
  });
  const { server, port } = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/market/flow-analysis?symbol=BTCUSDT&interval=1h`);
    assert.equal(response.ok, true);
    const body = await response.json();
    assert.equal(body.symbol, 'BTCUSDT');
    assert.equal(saved, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('imported datasets reject unknown intervals and oversized arrays', async () => {
  const app = createTestApp({ marketData: {}, marketDb: {} });
  const { server, port } = await listen(app);
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/api/market/flow-analysis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', datasets: { '15m': candles({ count: 40 }) } })
    });
    assert.equal(bad.status, 400);
    const oversized = await fetch(`http://127.0.0.1:${port}/api/market/flow-analysis`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', datasets: { '1h': candles({ count: 501 }) } })
    });
    assert.equal(oversized.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
