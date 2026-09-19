import test from 'node:test';
import assert from 'node:assert/strict';
import { yaoCoinAmbushAnalysis, buildYaoAmbushTicker, YAO_AMBUSH_DEFAULTS } from '../server/yaoCoinAmbushAnalysis.js';

function makeRows(direction = 'UP', count = 80, step = 60000) {
  let previous = 100;
  return Array.from({ length: count }, (_, index) => {
    const close = index < count - 12
      ? 100 + index * (direction === 'UP' ? 0.02 : -0.02)
      : direction === 'UP'
        ? 101.4 + (index - (count - 13)) * 0.9
        : 101.4 - (index - (count - 13)) * 0.9;
    const open = index === 0 ? close : previous;
    const high = Math.max(open, close) + (index >= count - 12 ? 0.45 : 0.08);
    const low = Math.min(open, close) - (index >= count - 12 ? 0.45 : 0.08);
    previous = close;
    return { openTime: index * step, open, high, low, close, volume: index >= count - 12 ? 5 : 1 };
  });
}

function makeAux(direction = 'UP') {
  const rows = Array.from({ length: 120 }, (_, index) => {
    const close = direction === 'UP' ? 100 + index * 0.15 : 100 - index * 0.15;
    const open = index === 0 ? close : direction === 'UP' ? close - 0.15 : close + 0.15;
    return { openTime: index * 900000, open, high: Math.max(open, close) + 0.4, low: Math.min(open, close) - 0.4, close, volume: 10 };
  });
  return { symbol: `${direction}USDT`, interval: '15m', klines: rows, dataAsOf: new Date(rows.at(-1).openTime + 900000).toISOString() };
}

function context(direction = 'UP', params = {}) {
  const market = { symbol: `${direction}USDT`, interval: '1m', klines: makeRows(direction), dataAsOf: new Date(80 * 60000).toISOString() };
  const aux = makeAux(direction);
  // 该 fixture 的 ATR/入场区间刻意偏宽，单测重点验证原始高分会经过校准层；
  // 成本后 RR 仍使用较低值以便走到概率闸门，正式组合回测仍使用 1.2。
  return {
    market,
    ctx: {
      params: { ...YAO_AMBUSH_DEFAULTS, minNetRr: 0.5, ...params },
      auxMarkets: { '15m': aux }
    }
  };
}

test('constructs a rolling 24h ticker without using future rows', () => {
  const { market, ctx } = context('UP');
  const ticker = buildYaoAmbushTicker(market, ctx.auxMarkets['15m']);
  assert.ok(ticker);
  assert.equal(ticker.lastPrice, market.klines.at(-1).close);
  assert.equal(ticker.dataSource, '15m-rolling-24h+1m-close');
  assert.ok(ticker.highPrice >= ticker.lastPrice);
  assert.ok(ticker.lowPrice <= ticker.lastPrice);
});

test('raw high-score upward signal is rejected by calibrated probability', () => {
  const { market, ctx } = context('UP');
  const signal = yaoCoinAmbushAnalysis(market, ctx);
  assert.equal(signal.action, 'WAIT');
  assert.equal(signal.trend.rawProbabilityPct, 99);
  assert.ok(signal.trend.probabilityPct < YAO_AMBUSH_DEFAULTS.minProbabilityPct);
  assert.match(signal.reason, /校准方向概率/);
});

test('raw high-score downward signal is also rejected by calibrated probability', () => {
  const { market, ctx } = context('DOWN');
  const signal = yaoCoinAmbushAnalysis(market, ctx);
  assert.equal(signal.action, 'WAIT');
  assert.equal(signal.trend.rawProbabilityPct, 99);
  assert.ok(signal.trend.calibratedTargetProbabilityPct > 0);
  assert.match(signal.reason, /校准方向概率/);
});

test('triggered ±50% candidates are rejected instead of chased', () => {
  const { market, ctx } = context('UP');
  const triggeredAux = makeAux('UP');
  const rows = triggeredAux.klines.slice(-96);
  rows[0] = { ...rows[0], open: 100, low: 99.6 };
  rows[rows.length - 1] = { ...rows.at(-1), close: 160, high: 160 };
  const signal = yaoCoinAmbushAnalysis(market, { ...ctx, auxMarkets: { '15m': { ...triggeredAux, klines: rows } } });
  assert.equal(signal.action, 'WAIT');
  assert.match(signal.reason, /达到.*阈值/);
});

test('missing auxiliary 24h data fails closed', () => {
  const { market } = context('UP');
  const signal = yaoCoinAmbushAnalysis(market, { params: YAO_AMBUSH_DEFAULTS, auxMarkets: { '15m': { klines: [] } } });
  assert.equal(signal.action, 'WAIT');
  assert.equal(signal.dataGap, true);
});
