import test from 'node:test';
import assert from 'node:assert/strict';
import { predictYaoCoin, predictYaoCoins } from '../server/yaoCoinPrediction.js';

function market(direction = 'UP', symbol = `${direction}USDT`) {
  let previousClose = 100;
  const rows = Array.from({ length: 80 }, (_, index) => {
    const beforeLaunch = 100 + index * (direction === 'UP' ? 0.02 : -0.02);
    const launchStart = 101.4;
    const close = index < 68
      ? beforeLaunch
      : direction === 'UP'
        ? launchStart + (index - 67) * 0.9
        : launchStart - (index - 67) * 0.9;
    const open = index === 0 ? close : previousClose;
    const high = Math.max(open, close) + (index >= 68 ? 0.45 : 0.08);
    const low = Math.min(open, close) - (index >= 68 ? 0.45 : 0.08);
    previousClose = close;
    return {
      openTime: index * 60000,
      open,
      high,
      low,
      close,
      volume: index >= 68 ? 5 : 1
    };
  });
  return { symbol, klines: rows };
}

function ticker(direction = 'UP', overrides = {}) {
  const up = direction === 'UP';
  return {
    symbol: `${direction}USDT`,
    lastPrice: up ? 112.2 : 90.0,
    priceChangePercent: up ? 15 : -10,
    openPrice: 100,
    highPrice: up ? 116 : 102,
    lowPrice: up ? 95 : 84,
    ...overrides
  };
}

test('pre-launch upward candidate includes signed move, target price and pullback buy levels', () => {
  const prediction = predictYaoCoin({ market: market('UP'), ticker: ticker('UP') });
  assert.ok(prediction);
  assert.equal(prediction.direction, 'UP');
  assert.equal(prediction.stage, 'PRE_LAUNCH');
  assert.equal(prediction.rawProbabilityPct, 99);
  assert.equal(prediction.calibratedDirectionProbabilityPct, 46.34);
  assert.equal(prediction.calibratedTargetProbabilityPct, 6.84);
  assert.equal(prediction.probabilityPct, 46.34);
  assert.ok(prediction.predictedMovePct >= 50);
  assert.ok(prediction.predictedTargetPrice > prediction.current.price);
  assert.ok(prediction.levels.optimalEntry <= prediction.current.price);
  assert.ok(prediction.levels.entryRange.max <= prediction.current.price);
  assert.ok(prediction.levels.stopLoss < prediction.levels.optimalEntry);
  assert.ok(prediction.levels.takeProfits.every(value => value > prediction.levels.optimalEntry));
  assert.equal(prediction.levels.side, 'BUY');
  assert.equal(prediction.features.dataSource, 'ticker24h+klines');
});

test('pre-launch downward candidate provides short direction and best short entry', () => {
  const prediction = predictYaoCoin({ market: market('DOWN'), ticker: ticker('DOWN') });
  assert.ok(prediction);
  assert.equal(prediction.direction, 'DOWN');
  assert.equal(prediction.predictedMovePct <= -50, true);
  assert.ok(prediction.predictedTargetPrice < prediction.current.price);
  assert.ok(prediction.levels.optimalEntry >= prediction.current.price);
  assert.ok(prediction.levels.entryRange.min >= prediction.current.price);
  assert.ok(prediction.levels.stopLoss > prediction.levels.optimalEntry);
  assert.ok(prediction.levels.takeProfits.every(value => value < prediction.levels.optimalEntry));
  assert.equal(prediction.levels.side, 'SELL_SHORT');
});

test('24h rise, fall, or high-low amplitude can trigger the ±50%妖币 threshold', () => {
  const up = predictYaoCoin({ market: market('UP'), ticker: ticker('UP', {
    priceChangePercent: 55, highPrice: 160, lowPrice: 100
  }) });
  const down = predictYaoCoin({ market: market('DOWN'), ticker: ticker('DOWN', {
    priceChangePercent: -55, highPrice: 100, lowPrice: 40
  }) });
  const amplitudeOnly = predictYaoCoin({ market: market('UP'), ticker: ticker('UP', {
    priceChangePercent: 5, highPrice: 160, lowPrice: 100
  }) });
  assert.equal(up.stage, 'TRIGGERED');
  assert.equal(down.stage, 'TRIGGERED');
  assert.equal(amplitudeOnly.stage, 'TRIGGERED');
  assert.equal(up.direction, 'UP');
  assert.equal(down.direction, 'DOWN');
});

test('batch predictor accepts a ticker map and ignores insufficient markets', () => {
  const predictions = predictYaoCoins({
    symbols: ['UPUSDT', 'DOWNUSDT', 'EMPTYUSDT'],
    preparedMarkets: {
      UPUSDT: market('UP'),
      DOWNUSDT: market('DOWN'),
      EMPTYUSDT: { symbol: 'EMPTYUSDT', klines: [] }
    },
    tickers: new Map([
      ['UPUSDT', ticker('UP')],
      ['DOWNUSDT', ticker('DOWN')]
    ])
  });
  assert.deepEqual(predictions.map(item => item.symbol).sort(), ['DOWNUSDT', 'UPUSDT']);
});

test('insufficient or directionless data does not produce a false妖币 candidate', () => {
  assert.equal(predictYaoCoin({
    market: { symbol: 'NEWUSDT', klines: Array.from({ length: 10 }, (_, index) => ({
      openTime: index, open: 1, high: 1, low: 1, close: 1, volume: 1
    })) },
    ticker: { symbol: 'NEWUSDT', lastPrice: 1, priceChangePercent: 0 }
  }), null);
});
