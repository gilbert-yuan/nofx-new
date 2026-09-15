import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSkillTradePlan } from '../server/shared/skillStrategy.js';
import { structureLongAnalysis, resolveStructureLongParams } from '../server/structureLongAnalysis.js';
import { structureShortAnalysis, resolveStructureShortParams } from '../server/structureShortAnalysis.js';

test('SKILL trade plan keeps the supplied long geometry and volatility risk reduction', () => {
  const plan = makeSkillTradePlan({
    long: true, price: 110, atr: 10, support: 100, resistance: 140,
    balance: 100, risk: 0.01, volatility: 0.95, leverage: 5
  });
  assert.equal(plan.entryMin, 98.5);
  assert.equal(plan.entryMax, 102.5);
  assert.equal(plan.entryLimit, 100.5);
  assert.equal(plan.stopLoss, 96.5);
  assert.equal(plan.takeProfit1, 140);
  assert.equal(plan.takeProfit2, 108.5);
  assert.equal(plan.takeProfit3, 112.5);
  assert.equal(plan.riskReward, 2);
  assert.equal(plan.adjustedRisk, 0.005);
  assert.equal(plan.position.leverage, 5);
  assert.equal(plan.liquidationSafety.stopBeforeEstimatedLiquidation, true);
});

test('strict SKILL mode fails closed when BTC and derivatives evidence is absent', () => {
  const market = { symbol: 'TESTUSDT', interval: '15m', klines: [] };
  const long = structureLongAnalysis(market, { params: { strictSkillData: true } });
  const short = structureShortAnalysis(market, { params: { strictSkillData: true } });
  assert.equal(long.action, 'WAIT');
  assert.equal(short.action, 'WAIT');
  assert.equal(long.dataQuality, 'DEGRADED');
  assert.ok(long.missingData.includes('4h>=200'));
  assert.ok(long.missingData.includes('premium'));
  assert.ok(short.missingData.includes('BTC 4h>=200'));
});

test('SKILL boolean and risk parameters restore from configuration values', () => {
  const long = resolveStructureLongParams({ strictSkillData: 'false', riskPerTrade: 0.012, defaultLeverage: 4 });
  const short = resolveStructureShortParams({ strictSkillData: false, maxDailyLoss: 0.05, requireFiveMinute: true });
  assert.equal(long.strictSkillData, false);
  assert.equal(long.riskPerTrade, 0.012);
  assert.equal(long.defaultLeverage, 4);
  assert.equal(short.strictSkillData, false);
  assert.equal(short.maxDailyLoss, 0.05);
  assert.equal(short.requireFiveMinute, true);
});

