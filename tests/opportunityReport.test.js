import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunityReport } from '../server/opportunityReport.js';

function market(price) {
  return { symbol: 'BRUSDT', interval: '15m', dataAsOf: '2026-09-17T12:00:00.000Z', klines: [{ close: price }] };
}

function longSignal(overrides = {}) {
  return {
    symbol: 'BRUSDT', action: 'BUY', positionRecommendation: 'OPEN_LONG', eligible: true,
    confidence: 0.82, strategyId: 'enhanced-trend-v1', reason: '均线与结构同向。', risk: '跌破止损则计划失效。',
    plan: {
      entryMin: 0.300, entryMax: 0.306, entryLimit: 0.303,
      stopLoss: 0.285, takeProfit1: 0.325, takeProfit2: 0.345, takeProfit3: 0.365,
      riskUnit: 0.018,
      ...overrides
    }
  };
}

test('super confirmation waits for a pullback when pump, OI and funding are crowded', () => {
  const report = buildOpportunityReport({
    signal: longSignal(),
    market: market(0.318),
    strategy: { id: 'enhanced-trend-v1', name: '增强趋势 v1' },
    marketContext: {
      ticker24h: { lastPrice: '0.318', priceChangePercent: '30' },
      premium: { lastFundingRate: '0.0008', markPrice: '0.318' },
      oi: [{ sumOpenInterest: '100' }, { sumOpenInterest: '146' }]
    },
    now: Date.parse('2026-09-17T12:01:00.000Z')
  });

  assert.equal(report.recommendation, 'HOLD');
  assert.equal(report.canProceed, false);
  assert.equal(report.decision.code, 'WAIT_PULLBACK');
  assert.equal(report.current.price, 0.318);
  assert.equal(report.levels.entryRange.min, 0.3);
  assert.deepEqual(report.levels.takeProfits, [0.325, 0.345, 0.365]);
  assert.ok(report.warnings.some(item => item.includes('多头可能拥挤')));
  assert.ok(report.summary.includes('理想入场 0.3～0.306'));
});

test('independent confirmation can continue when the price is already in the plan area', () => {
  const report = buildOpportunityReport({
    signal: longSignal({ entryLimit: 0.303 }),
    market: market(0.303),
    marketContext: { ticker24h: { priceChangePercent: '2' }, oi: [{ sumOpenInterest: '100' }, { sumOpenInterest: '101' }] }
  });

  assert.equal(report.recommendation, 'BUY');
  assert.equal(report.canProceed, true);
  assert.equal(report.decision.code, 'BUY_NOW');
});

test('short opportunities wait for a rebound instead of chasing a decline', () => {
  const report = buildOpportunityReport({
    signal: {
      symbol: 'BRUSDT', action: 'SELL', positionRecommendation: 'OPEN_SHORT', eligible: true,
      plan: { entryMin: 0.300, entryMax: 0.306, entryLimit: 0.303, stopLoss: 0.325, takeProfit: 0.285 }
    },
    market: market(0.294)
  });

  assert.equal(report.decision.code, 'WAIT_REBOUND');
  assert.equal(report.recommendation, 'HOLD');
  assert.equal(report.levels.takeProfits[0], 0.285);
});

test('WAIT or malformed signals do not become opportunities', () => {
  assert.equal(buildOpportunityReport({ signal: { action: 'WAIT', plan: null }, market: market(1) }), null);
  assert.equal(buildOpportunityReport({ signal: { action: 'BUY', plan: {} }, market: market(1) }), null);
});
