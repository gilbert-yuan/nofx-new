import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defineStrategy, getStrategy } from '../server/strategies/index.js';
import { CandleSeries } from './backtest/data.mjs';
import { createConfirmationGate, validateConfirmation, overlap } from './backtest/confirmation.mjs';
import { MINUTE, abs, loadConfig } from './backtest/config.mjs';
import { replay } from './backtest/replay.mjs';

const observations = [];
// A tiny registered strategy isolates timing and gate integration while still
// using the real normalizePlan and candle resampling implementations.
defineStrategy({ id: 'confirmation-fixture', name: 'fixture', engine: 'fixture', planInterval: '4h',
  marketWindow: 2, marketWindows: { '4h': 2 }, needsAux: ['4h'], paramSchema: [],
  analyze: (market, ctx) => {
    const tf = ctx.auxMarkets['4h']; observations.push({ primary: market.klines.at(-1).openTime, native: tf.klines.at(-1).openTime });
    const long = tf.klines.at(-1).close < 120;
    return { action: long ? 'BUY' : 'SELL', confidence: 0.8, score: 80,
      plan: { entryMin: 100, entryMax: 101, stopLoss: long ? 90 : 110, takeProfit: long ? 125 : 75, maxHoldBars: 1 } };
  }, review: () => ({ action: 'HOLD' }) });
const data = new CandleSeries();
for (let i = 0; i < 104 * 60; i++) {
  const price = i < 92 * 60 ? 100 : 130;
  data.push([i * MINUTE, price, price + 1, price - 1, price, 100]);
}
const loaded = { data, intervals: new Map([['1m', data]]) }, costs = { feeBps: 6, slippageBps: 5, fundingBpsPer8h: 3 };
const member = { strategyId: 'confirmation-fixture', params: {}, lookbackBars: 0, minScore: 70 };
const gate = confirmation => createConfirmationGate({ confirmation, loaded, symbol: 'TESTUSDT', costs, execution: { initialBalance: 1000 } });
const basic = gate({ mode: 'all', members: [member] });
const origin = 80 * 60 * MINUTE;
const before = await basic(origin + 15 * 60 * MINUTE, 'OPEN_LONG');
assert.equal(before.passed, true, `12h 后尚未收盘的 4h 涨幅不得泄露到 15h 信号：${JSON.stringify(before)}`);
assert.equal(observations.at(-1).native, origin + 8 * 60 * MINUTE);
assert.equal(observations.at(-1).primary, origin + 12 * 60 * MINUTE - MINUTE, '原生决策时主周期也必须截断');
assert.equal((await basic(origin + 16 * 60 * MINUTE, 'OPEN_LONG')).passed, false, '16h 收盘后应看到相反方向');
assert.equal((await gate({ mode: 'all', members: [{ ...member, lookbackBars: 1 }] })(origin + 16 * 60 * MINUTE, 'OPEN_LONG')).passed, true, '回看 1 根可保留此前同向信号');
assert.equal((await gate({ mode: 'all', members: [{ ...member, minScore: 90 }] })(origin + 15 * 60 * MINUTE, 'OPEN_LONG')).passed, false);
assert.equal((await basic(4 * 60 * MINUTE, 'OPEN_LONG')).members[0].unavailable, 'insufficient_closed_history');
assert.equal((await gate({ mode: 'audit', members: [member] })(origin + 16 * 60 * MINUTE, 'OPEN_LONG')).passed, true, 'audit 必须只记录而不拒单');
assert.throws(() => validateConfirmation({ mode: 'all', members: [member, member] }), /重复/);
assert.throws(() => validateConfirmation({ mode: 'all', members: [{ ...member, lookbackBars: -1 }] }), /lookbackBars/);
const stats = overlap([{ status: 'ok', metrics: { net: 1 }, trades: [
  { net: 2, confirmation: before }, { net: -1, confirmation: await basic(origin + 16 * 60 * MINUTE, 'OPEN_LONG') }
] }], member.strategyId);
assert.equal(stats.winningTradeCoverage, 1); assert.equal(stats.losingTradeRejection, 1); assert.equal(stats.profitableCoinCoverage, 1);
defineStrategy({ id: 'confirmation-opposite', name: 'opposite', engine: 'fixture', planInterval: '4h',
  marketWindow: 20, needsAux: [], paramSchema: [], analyze: () => ({ action: 'SELL', confidence: 0.8,
    plan: { entryMin: 100, entryMax: 101, stopLoss: 110, takeProfit: 75, maxHoldBars: 1 } }), review: () => ({ action: 'HOLD' }) });
const opposite = { strategyId: 'confirmation-opposite', params: {} };
assert.equal((await gate({ mode: 'all', members: [member, opposite] })(origin + 15 * 60 * MINUTE, 'OPEN_LONG')).passed, false);
assert.equal((await gate({ mode: 'any', members: [member, opposite] })(origin + 15 * 60 * MINUTE, 'OPEN_LONG')).passed, true);

// The audit mode must preserve actual fills and settlements, while a rejecting
// confirmation must act BEFORE creating an enhanced-trend order.
const original = getStrategy('enhanced-trend-v1');
const directory = fs.mkdtempSync(abs('output/confirmation-smoke-'));
try {
  defineStrategy({ ...original, engine: 'fixture', paramSchema: [], marketWindow: 20, needsAux: [],
    analyze: market => { const price = market.klines.at(-1).close; return { action: 'BUY', confidence: 0.8,
      plan: { entryMin: price, entryMax: price + 0.1, stopLoss: price - 2, takeProfit: price + 6, maxHoldBars: 2 } }; },
    review: () => ({ action: 'HOLD' }) });
  const file = path.join(directory, 'TESTUSDT.csv');
  fs.writeFileSync(file, Array.from({ length: data.length }, (_, i) => {
    const r = data.at(i); return [r.openTime, r.open, r.high, r.low, r.close, r.volume].join(',');
  }).join('\n'));
  const config = loadConfig(null, { period: { from: new Date(origin).toISOString(), to: new Date(104 * 60 * MINUTE).toISOString(), warmupDays: 4 },
    features: { enabled: false }, execution: { dailyLossPct: 0, consecutiveLossLimit: 0 } });
  const job = { config, strategyId: original.id, symbol: 'TESTUSDT', file, params: {}, from: origin, to: 104 * 60 * MINUTE };
  const baseline = await replay(job);
  const audit = await replay({ ...job, confirmation: { mode: 'audit', members: [member] } });
  assert.ok(baseline.trades.length > 0);
  assert.deepEqual(audit.metrics, baseline.metrics);
  assert.deepEqual(audit.trades.map(({ confirmation, ...trade }) => trade), baseline.trades);
  const rejected = await replay({ ...job, confirmation: { mode: 'all', members: [{ ...member, minScore: 90 }] } });
  assert.equal(rejected.funnel.orders, 0); assert.equal(rejected.metrics.trades, 0);
  assert.ok(rejected.funnel.confirmationRejected > 0);
} finally { defineStrategy(original); fs.rmSync(directory, { recursive: true, force: true }); }
console.log('confirmation smoke: timing, lookback, AND/OR, score, missing history, overlap, unchanged audit fills and entry rejection passed');
