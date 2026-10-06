/**
 * Optional H4 round runner. Off unless data/backtest/auto-trade/.run-round exists.
 * The file content is the round id (R0/R1/...). Normal `npm test` stays skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const flag = path.resolve('data/backtest/auto-trade/.run-round');
const requested = fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8').trim().toUpperCase() : '';
const runAll = requested === 'ALL';
const runOne = /^R\d+$/.test(requested);

test('run H4 optimization round when requested', { skip: !runAll && !runOne, timeout: 540_000 }, async () => {
  if (runOne) process.env.BT_ROUND = requested;
  else delete process.env.BT_ROUND;
  process.env.BT_SYMBOL_COUNT = process.env.BT_SYMBOL_COUNT || '50';
  process.env.BT_DAYS = process.env.BT_DAYS || '180';
  await import('../scripts/optimize-h4-rounds.mjs');
});
