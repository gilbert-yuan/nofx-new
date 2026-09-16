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

test('4h optimization parameters change plan geometry, target and leverage', () => {
  const base = makeSkillTradePlan({
    long: true, price: 110, atr: 10, support: 100, resistance: 140,
    balance: 100, risk: 0.01, volatility: 0.5, leverage: 5
  });
  const tuned = makeSkillTradePlan({
    long: true, price: 110, atr: 10, support: 100, resistance: 140,
    balance: 100, risk: 0.01, volatility: 0.5, leverage: 5,
    entryBufAtr: 0.5, stopBufferAtr: 0.7, minStopPct: 0.02,
    targetR: 3, maxLeverage: 2, riskBudgetPct: null
  });
  assert.notEqual(tuned.entryLimit, base.entryLimit);
  assert.notEqual(tuned.stopLoss, base.stopLoss);
  assert.equal(tuned.riskReward, 3);
  assert.equal(tuned.position.leverage, 2);
});

test('strict mode only checks candle evidence after environment removal', () => {
  const market = { symbol: 'TESTUSDT', interval: '15m', klines: [] };
  const long = structureLongAnalysis(market, { params: { strictSkillData: true } });
  const short = structureShortAnalysis(market, { params: { strictSkillData: true } });
  assert.equal(long.action, 'WAIT');
  assert.equal(short.action, 'WAIT');
  assert.equal(long.dataQuality, 'DEGRADED');
  assert.ok(long.missingData.includes('4h>=200'));
  assert.ok(!long.missingData.includes('premium'));
  assert.ok(!long.missingData.includes('BTC 4h>=200'));
  assert.ok(!short.missingData.includes('funding'));
  assert.ok(!short.missingData.includes('BTC 4h>=200'));
});

test('SKILL boolean and risk parameters restore from configuration values', () => {
  const defaultLong = resolveStructureLongParams();
  const defaultShort = resolveStructureShortParams();
  const long = resolveStructureLongParams({ strictSkillData: 'false', riskPerTrade: 0.012, defaultLeverage: 4 });
  const short = resolveStructureShortParams({ strictSkillData: false, maxDailyLoss: 0.05, requireFiveMinute: true });
  assert.equal(defaultLong.strictSkillData, false);
  assert.equal(defaultShort.strictSkillData, false);
  assert.equal(long.strictSkillData, false);
  assert.equal(long.riskPerTrade, 0.012);
  assert.equal(long.defaultLeverage, 4);
  assert.equal(defaultLong.nearLevelAtr, 1.2);
  assert.equal(defaultShort.volumeRatioMin, 1.1);
  assert.equal(short.strictSkillData, false);
  assert.equal(short.maxDailyLoss, 0.05);
  assert.equal(short.requireFiveMinute, true);
});

test('structure signals expose numeric ranking diagnostics and honor extendedAtr in chase bounds', () => {
  const candle = (openTime, close) => ({
    openTime, open: close - 0.05, high: close + 0.2, low: close - 0.2, close, volume: 100
  });
  const rows15 = Array.from({ length: 80 }, (_, i) => candle(i * 900000, 100 + i * 0.12));
  const rows1h = Array.from({ length: 80 }, (_, i) => candle(i * 3600000, 100 + i * 0.2));
  const rows4h = Array.from({ length: 80 }, (_, i) => candle(i * 14400000, 100 + i * 0.8));
  const result = structureLongAnalysis({ symbol: 'TESTUSDT', interval: '15m', klines: rows15 }, {
    params: { strictSkillData: false, extendedAtr: 1.5 },
    auxMarkets: {
      '15m': { klines: rows15 }, '1h': { klines: rows1h }, '4h': { klines: rows4h }
    }
  });
  assert.ok(Number.isFinite(result.score));
  assert.ok(Number.isFinite(result.entryQuality));
  assert.equal(result.doNotChaseAbove,
    Number((result.indicators['4h'].ema20 + 1.5 * result.indicators['4h'].atr).toFixed(4)));
});
