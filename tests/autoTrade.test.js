import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_TRADE } from '../shared/autoTradeDefaults.js';
import { screenSymbol, screenUniverse, checkBookLiquidity } from '../server/shared/liquidityScreen.js';
import { mapScoreToSize, constrainByMaxLoss, sizeSignal, signalScore } from '../server/shared/scoreSizing.js';
import { shouldHaltNewEntries, consecutiveLossStreak } from '../server/shared/lossCircuit.js';
import { GlobalAutomation } from '../server/globalAutomation.js';

test('defaults keep the unconfirmed exchange, cost and capital choices in one place', () => {
  assert.equal(AUTO_TRADE.exchange, 'binance');
  assert.equal(AUTO_TRADE.initialCapital, 100);
  assert.equal(AUTO_TRADE.interval, '15m');
  assert.equal(AUTO_TRADE.feeBps, 6);
  assert.equal(AUTO_TRADE.scoreSizingEnabled, false);
});

test('liquidity screen fails closed when quote volume is missing', () => {
  const result = screenSymbol({ symbol: 'ABCUSDT', atrPct: 0.01 });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some(item => item.includes('成交额')));
});

test('liquidity screen keeps liquid names and records reject reasons', () => {
  const universe = screenUniverse([
    { symbol: 'BTCUSDT', quoteVolume: 9_000_000, atrPct: 0.01, bidPrice: 100, askPrice: 100.02 },
    { symbol: 'DEADUSDT', quoteVolume: 1000, atrPct: 0.01, bidPrice: 1, askPrice: 1.01 }
  ]);
  assert.deepEqual(universe.filtered, ['BTCUSDT']);
  assert.equal(universe.rejected.length, 1);
});

test('book check skips when depth cannot cover the order', () => {
  const check = checkBookLiquidity({
    bid: 100, ask: 100.01,
    bids: [[100, 0.1], [99.9, 0.1]],
    asks: [[100.01, 0.1], [100.02, 0.1]],
    notional: 500
  });
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some(item => item.includes('深度')));
});

test('higher scores map to higher leverage and margin within caps', () => {
  const low = mapScoreToSize(40);
  const high = mapScoreToSize(90);
  assert.ok(high.leverage >= low.leverage);
  assert.ok(high.marginPct >= low.marginPct);
  assert.equal(signalScore({ plan: { trendStrengthScore: 72 } }), 72);
});

test('max-loss constraint cuts leverage before rejecting the trade', () => {
  const limited = constrainByMaxLoss({ leverage: 10, marginPct: 0.1, stopDistancePct: 0.05 });
  assert.equal(limited.ok, true);
  assert.ok(limited.expectedLossPct <= AUTO_TRADE.maxLossPct + 1e-9);
  assert.ok(limited.leverage < 10);
});

test('sizeSignal respects the concurrent position cap', () => {
  const result = sizeSignal({ plan: { trendStrengthScore: 80, stopLoss: 95, entryLimit: 100 } }, {
    equity: 100, openCount: AUTO_TRADE.maxPositions
  });
  assert.equal(result.ok, false);
  assert.equal(result.action, 'SKIP_MAX_POSITIONS');
});

test('four consecutive closed losses trip the circuit', () => {
  const orders = [1, 2, 3, 4].map(i => ({
    status: 'closed', net: -1, exitAt: `2026-10-0${i}T00:00:00.000Z`
  }));
  assert.equal(consecutiveLossStreak(orders).streak, 4);
  const halt = shouldHaltNewEntries(orders);
  assert.equal(halt.halt, true);
});

test('backtest fills without status still count toward the loss circuit', () => {
  const fills = [1, 2, 3, 4].map(i => ({
    net: -1, exitAt: `2026-10-0${i}T00:00:00.000Z`
  }));
  assert.equal(consecutiveLossStreak(fills).streak, 4);
  assert.equal(shouldHaltNewEntries(fills).halt, true);
});

test('submitSignal skips when the consecutive-loss circuit is open', async () => {
  const automation = new GlobalAutomation({
    simulation: {
      readLight: async () => ({
        initialBalance: 100,
        orders: [1, 2, 3, 4].map(i => ({
          status: 'closed', symbol: 'XUSDT', net: -2, exitAt: `2026-10-0${i}T00:00:00.000Z`
        }))
      }),
      submit: async () => { throw new Error('should not submit'); }
    },
    market: {}, marketDb: {}, archive: {}, store: {}
  });
  const result = await automation.submitSignal({
    symbol: 'BTCUSDT',
    signal: { action: 'BUY', strategyId: 't', plan: { entryLimit: 100, stopLoss: 95, takeProfit: 110 } },
    shouldContinue: () => true,
    config: { trader: {} }
  });
  assert.equal(result.action, 'SKIP_LOSS_CIRCUIT');
});
