import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStructure, pivots, selectPivotTarget } from '../server/shared/marketStructure.js';

const row = (i, close, high = close + 0.2, low = close - 0.2) => ({
  openTime: i * 60000, open: close, high, low, close, volume: 10, confirmed: true
});

function structureRows({ bullish = true, breakLevel = null } = {}) {
  const rows = [];
  const points = bullish
    ? [[100, 102, 98], [101, 103, 99], [99, 101, 97], [102, 104, 100], [101, 103, 99]]
    : [[100, 102, 98], [99, 101, 97], [101, 103, 99], [98, 100, 96], [99, 101, 97]];
  for (let i = 0; i < 30; i++) rows.push(row(i, 100 + (i % 2 ? 0.1 : -0.1)));
  for (const [close, high, low] of points) rows.push(row(rows.length, close, high, low));
  if (breakLevel != null) rows.push(row(rows.length, breakLevel, breakLevel + 0.1, breakLevel - 0.1));
  return rows;
}

test('pivots expose confirmed swing prices and indices', () => {
  const rows = [row(0, 10), row(1, 12, 14, 11), row(2, 11), row(3, 10), row(4, 9)];
  const p = pivots(rows, 1, 1);
  assert.equal(p.highs.at(-1).price, 14);
  assert.equal(p.highs.at(-1).index, 1);
  assert.equal(p.highs.at(-1).time, 60000);
});

test('CHOCH requires prior opposite trend plus completed structure and BOS', () => {
  const bullish = marketStructure(structureRows({ bullish: true }));
  assert.equal(bullish.trend, 'NEUTRAL');
  const continuation = marketStructure(structureRows({ bullish: true, breakLevel: 103 }));
  assert.equal(continuation.chochBearish, false, 'trend continuation must not be CHOCH');
  assert.equal(continuation.chochBullish, false);
  const bearish = marketStructure(structureRows({ bullish: false, breakLevel: 95 }));
  assert.equal(typeof bearish.structureShiftBearish, 'boolean');
  assert.equal(bearish.chochBullish, false);
});

test('selectPivotTarget chooses nearest real pivot meeting minimum RR', () => {
  const target = selectPivotTarget({ long: true, entry: 100, stopDistance: 2, minRealRR: 2,
    structures: [{ interval: '1h', structure: { highs: [{ price: 102.5, index: 10 }, { price: 106, index: 20 }] } }] });
  assert.deepEqual(target, { price: 106, rr: 3, source: '1h', pivotIndex: 20 });
  assert.equal(selectPivotTarget({ long: true, entry: 100, stopDistance: 2, minRealRR: 4,
    structures: [{ interval: '1h', structure: { highs: [{ price: 106, index: 20 }] } }] }), null);
});
