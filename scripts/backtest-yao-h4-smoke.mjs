import assert from 'node:assert/strict';
import { CandleSeries } from './backtest/data.mjs';
import { loadConfig, MINUTE } from './backtest/config.mjs';
import { getStrategy } from '../server/strategies/index.js';
import { TradingSimulator } from '../server/tradingSimulator.js';
import { applyPaperProtectionReview } from '../server/shared/protectionReview.js';
import { simulateOpportunity, portfolio, trendMatches, fastMomentum, screenPrefixes, necessaryActivity, MAIN, FILTER } from './backtest/yao-h4.mjs';
import { extractYaoCoinFeatures } from '../server/yaoCoinPrediction.js';

const config = loadConfig(null, { execution: { initialBalance: 100, leverage: 10, maxLeverage: 10,
  pendingMinutes: 5, dailyLossPct: 0, consecutiveLossLimit: 0, stopCooldownMinutes: 0, cooldownMinutes: 0 } });
const { execution, costs } = config;
const capital = { maxPositions: 1, maxMarginPct: 0.5, minMargin: 0.1, minNotional: 1, pendingCooldownMinutes: 0 };
const base = new CandleSeries();
for (let i = 0; i < 100; i++) {
  const close = i < 85 ? 100 : 100 + (i - 85) * 0.2;
  base.push([i * MINUTE, close, close + 0.25, close - 0.25, close, 10, close * 10]);
}
const time = 80 * MINUTE, until = 100 * MINUTE;
const signal = { positionRecommendation: 'OPEN_LONG', score: 90,
  plan: { entryLimit: 100, entryMin: 99.8, entryMax: 100.2, stopLoss: 98, takeProfit: 110, maxHoldBars: 12 } };
const params = getStrategy(MAIN).paramSchema.reduce((p, s) => ({ ...p, [s.key]: s.default }), {});
const opportunity = await simulateOpportunity({ base, symbol: 'TESTUSDT', time, until, signal, params, execution, costs });
assert.ok(opportunity.filled);
assert.ok(opportunity.end <= until);
// Independent direct invocation of the production engine at 3x collateral must
// match every mark and net of the per-unit tape scaled by three.
const simulator = new TradingSimulator({ mode: 'account', pendingOrderTtlMs: execution.pendingMinutes * MINUTE, costs });
const direct = { symbol: 'TESTUSDT', direction: 'OPEN_LONG', interval: '1m', status: 'pending',
  plan: structuredClone(signal.plan), initialPlan: structuredClone(signal.plan), costs, createdAt: new Date(time).toISOString(),
  nextTime: time, margin: 3, leverage: 10, notional: 30, protectionRevisions: [], reviewHistory: [] };
const bytes = Buffer.from(opportunity.tape, 'base64');
const marks = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
let markIndex = 0;
for (let i = base.lowerBound(time); i < base.length; i++) {
  const row = base.at(i), now = row.openTime + MINUTE;
  Object.assign(direct, simulator.evaluate(direct, [row], now));
  if (direct.status === 'open') {
    const proposal = await getStrategy(MAIN).review(direct, { symbol: 'TESTUSDT', klines: base.slice(i - 79, i + 1) });
    applyPaperProtectionReview(direct, proposal, now, 'yao-ambush');
  }
  if (direct.entry) {
    const total = direct.quantity + Number(direct.realizedQty || 0);
    const equity = direct.status === 'closed' ? direct.net : Number(direct.realizedNet || 0) + Number(direct.unrealized || 0) - direct.entryFee * direct.quantity / total;
    assert.ok(Math.abs(equity - marks[markIndex++] * 3) < 1e-9, '标记权益必须随保证金线性缩放');
  }
  if (direct.status === 'closed') break;
}
assert.ok(Math.abs(direct.net - opportunity.net * 3) < 1e-9);
const shared = { execution: { ...execution, marginPct: 0.1, riskPct: 1 }, costs, capital, from: time, to: until };
const result = portfolio([opportunity, { ...opportunity, symbol: 'OTHERUSDT', score: 80, net: 100000 }], shared);
assert.equal(result.metrics.trades, 1, '共享资金池必须执行并发限制');
assert.equal(result.trades[0].symbol, 'TESTUSDT', '不能按未来收益选币');
assert.ok(Math.abs(result.metrics.net - opportunity.net * 10) < 1e-9);
assert.equal(result.capital.rejected.max_positions, 1);
assert.ok(result.capital.maxMarginRatio <= capital.maxMarginPct);
assert.equal(result.metrics.finalEquity, 100 + result.trades.reduce((s, t) => s + t.net, 0));
const pending = await simulateOpportunity({ base, symbol: 'PENDINGUSDT', time, until,
  signal: { ...signal, plan: { ...signal.plan, entryLimit: 50 } }, params, execution, costs });
assert.equal(pending.filled, false);
assert.equal(pending.end, time + execution.pendingMinutes * MINUTE);
assert.equal(portfolio([pending], shared).metrics.finalEquity, 100);
const crash = new CandleSeries();
for (let i = 0; i < 100; i++) {
  const close = i < 81 ? 100 : 85;
  crash.push([i * MINUTE, close, close + 0.2, close - 0.2, close, 10, close * 10]);
}
const liquidation = await simulateOpportunity({ base: crash, symbol: 'CRASHUSDT', time, until,
  signal: { ...signal, plan: { ...signal.plan, stopLoss: 80, takeProfit: 130 } }, params, execution, costs });
assert.equal(liquidation.reason, 'liquidation');
assert.ok(liquidation.net >= -1 - execution.leverage * costs.feeBps / 10000 - 1e-9, '逐仓损失不能侵占其他保证金');
const isolated = portfolio([liquidation], shared);
assert.equal(isolated.capital.liquidations, 1);
assert.ok(isolated.metrics.finalEquity >= 89.9);
const hparams = Object.fromEntries(getStrategy(FILTER).paramSchema.map(p => [p.key, p.default]));
const metrics = { price: 101, emaFast: 100, emaSlow: 99, atrPct: 0.01, spreadAtr: 1, rsi: 55, adx: 25, volumeRatio: 1.5 };
assert.equal(trendMatches(metrics, 'OPEN_LONG', hparams), true);
assert.equal(trendMatches(metrics, 'OPEN_SHORT', hparams), false);
assert.equal(trendMatches(metrics, 'OPEN_LONG', { ...hparams, adxMin: 30 }), false);
assert.equal(fastMomentum(base, 80, 1, new Uint32Array(base.length + 1)), false);
const zeroPrefix = new Uint32Array(base.length + 1); zeroPrefix.fill(1, 80);
assert.equal(fastMomentum(base, 80, 1, zeroPrefix), true, '零成交量窗口须回退正式特征提取');
const varied = new CandleSeries();
for (let i = 0; i < 800; i++) {
  const open = 100 + Math.sin(i / 7), close = open + Math.sin(i * 1.37) * 0.1;
  const volume = i % 97 && !(i >= 400 && i % 2 === 0) ? 10 + 8 * Math.sin(i / 17) : 0;
  varied.push([i * MINUTE, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close, volume, volume * close]);
}
const prefixes = screenPrefixes(varied);
for (let i = 79; i < varied.length; i++) {
  const f = extractYaoCoinFeatures({ klines: varied.slice(i - 79, i + 1) });
  if (!fastMomentum(varied, i, 1, prefixes)) assert.ok(!f.sufficient || Math.abs(f.recentReturnPct ?? 0) < 1 + 1e-10);
  for (const [volume, consistency] of [[0.5, 20], [1.5, 50], [2.5, 70]]) {
    if (!necessaryActivity(varied, i, volume, consistency, prefixes))
      assert.ok(!f.sufficient || (f.volumeRatio ?? 0) < volume || Math.abs(f.trendConsistencyPct ?? 0) < consistency,
        '必要条件预筛不得拒绝正式逻辑可能通过的窗口');
  }
}
console.log('yao-h4 smoke passed: exact 10x, unit-size engine equivalence, chronological allocation, capital caps, pending TTL, equity reconciliation, trend direction and safe prescreen');
