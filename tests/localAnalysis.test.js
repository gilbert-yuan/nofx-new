import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_STRATEGY, localAnalysis, localAnalysisMultiTimeframe } from '../server/localAnalysis.js';

function market(slope = 0.2, interval = '1m') {
  return { symbol: 'BTCUSDT', interval, klines: Array.from({ length: 80 }, (_, i) => {
    const close = 100 + i * slope;
    return { open: close, close, high: close + 1, low: close - 1 };
  }) };
}
const auxiliary = () => Object.fromEntries(['15m', '1h', '4h'].map(i => [i, market(0.2, i)]));

test('single and multi-timeframe engines produce protected short plans', () => {
  const bearishAux = Object.fromEntries(['15m', '1h', '4h'].map(i => [i, market(-0.2, i)]));
  for (const result of [localAnalysis(market(-0.2)), localAnalysisMultiTimeframe(market(-0.2), bearishAux)]) {
    assert.equal(result.action, 'SELL');
    assert.ok(result.plan.stopLoss > result.plan.entryMax);
    assert.ok(result.plan.takeProfit < result.plan.entryMin);
    assert.ok((result.plan.entryMin - result.plan.takeProfit) / (result.plan.stopLoss - result.plan.entryMin) >= 1.249);
  }
  assert.equal(localAnalysis(market(-1)).action, 'WAIT', 'overextended shorts must be filtered');
  assert.equal(localAnalysisMultiTimeframe(market(-0.2), auxiliary()).action, 'WAIT', 'conflicting higher timeframes must be filtered');
});

test('confirmed multi-timeframe trend generates a bounded long plan', () => {
  const result = localAnalysisMultiTimeframe(market(), auxiliary());
  assert.equal(result.action, 'BUY');
  assert.equal(result.plan.maxHoldBars, LOCAL_STRATEGY.maxHoldBars);
  assert.ok(result.plan.stopLoss < result.plan.entryMin);
});

test('each auxiliary timeframe is required and must agree', () => {
  for (const interval of ['15m', '1h', '4h']) {
    for (const replacement of [undefined, market(-0.2, interval), market(0, interval)]) {
      const aux = auxiliary(); aux[interval] = replacement;
      assert.equal(localAnalysisMultiTimeframe(market(), aux).action, 'WAIT', interval);
    }
  }
  assert.equal(localAnalysisMultiTimeframe(market(), {}).plan, null);
});

test('rising averages do not suffice when higher-timeframe price falls below fast average', () => {
  const aux = auxiliary();
  Object.assign(aux['4h'].klines.at(-1), { open: 112, close: 112, high: 113, low: 111 });
  assert.equal(localAnalysisMultiTimeframe(market(), aux).action, 'WAIT');
});

test('overextended and malformed prices never produce an entry', () => {
  for (const analyze of [localAnalysis, m => localAnalysisMultiTimeframe(m, auxiliary())]) {
    assert.equal(analyze(market(1)).action, 'WAIT');
    for (const value of [NaN, Infinity, -1]) {
      const m = market(); m.klines.at(-1).close = value;
      assert.equal(analyze(m).plan, null);
    }
  }
});

test('main timeframe supplies its own auxiliary confirmation', () => {
  const aux = auxiliary(); delete aux['15m'];
  assert.equal(localAnalysisMultiTimeframe(market(0.2, '15m'), aux).action, 'BUY');
});

test('adaptive parameters cannot reduce the planned risk reward below the floor', () => {
  const result = localAnalysisMultiTimeframe(market(), auxiliary(), { stopLossATR: 3.5, takeProfitATR: 3 });
  const risk = result.plan.entryMax - result.plan.stopLoss;
  const reward = result.plan.takeProfit - result.plan.entryMax;
  assert.ok(reward / risk >= 1.249);
  assert.equal(result.adaptiveParamsUsed.targetAdjustedForRisk, true);
});
