import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMarket, nextOpenTime, candleOpenAt, normalizePlan, createResearchRecord, PAPER_COSTS } from '../server/research.js';
import { evaluateSignal, summarizeResults } from '../server/paperTrading.js';
import { validateOrder } from '../server/risk.js';
import { TraderRunner } from '../server/traderRunner.js';

const hour = 3600000, now = Date.UTC(2026, 8, 5, 10, 15);
const candle = (openTime, fields = {}) => ({ openTime, open: 100, high: 102, low: 98, close: 101, volume: 10, ...fields });
const rows = Array.from({ length: 21 }, (_, i) => candle(candleOpenAt(now, '1h') - (20 - i) * hour));
const market = prepareMarket({ symbol: 'BTCUSDT', interval: '1h', rows, limit: 20, now });
const raw = { symbol: 'BTCUSDT', positionRecommendation: 'OPEN_LONG', confidence: 0.8,
  plan: { entryMin: 99, entryMax: 101, stopLoss: 95, takeProfit: 120, validForBars: 2, maxHoldBars: 3 } };
const signal = normalizePlan(raw, market, now);
const start = Date.parse(signal.firstEntryAt);
const zeroCosts = { feeBps: 0, slippageBps: 0, fundingBpsPer8h: 0, notional: 1000 };

test('closed candles exclude current bar and repair incorrect provider close times', () => {
  assert.equal(market.klines.length, 20);
  assert.equal(market.dataAsOf, '2026-09-05T10:00:00.000Z');
  assert.equal(market.klines.at(-1).closeTime, Date.parse(market.dataAsOf) - 1);
});
test('stale, insufficient, broken and invalid data are refused', () => {
  for (const invalid of [rows.slice(0, 19), rows.filter((_, i) => i !== 5), rows.map((r, i) => i === 5 ? { ...r, high: 1 } : r)]) {
    assert.throws(() => prepareMarket({ symbol: 'BTCUSDT', interval: '1h', rows: invalid, limit: 20, now }));
  }
  assert.throws(() => prepareMarket({ symbol: 'BTCUSDT', interval: '1h', rows, limit: 20, now: now + 2 * hour }), /过期/);
});
test('calendar months and weeks use UTC boundaries', () => {
  assert.equal(nextOpenTime(Date.UTC(2024, 1, 1), 'M'), Date.UTC(2024, 2, 1));
  assert.equal(nextOpenTime(0, '60'), hour);
  assert.equal(candleOpenAt(now, '1w'), Date.UTC(2026, 7, 31));
});
test('validated plans start strictly after generation', () => {
  assert.equal(signal.eligible, true);
  assert.equal(start, Date.UTC(2026, 8, 5, 11));
  assert.equal(signal.expiresAt, undefined);
  assert.equal(signal.plan.validForBars, undefined);
});
test('invalid scores, reversed exits, thin reward and noninteger horizons become WAIT', () => {
  const variants = [
    { ...raw, confidence: '0.8' }, { ...raw, confidence: 90 }, { ...raw, plan: null },
    { ...raw, plan: { ...raw.plan, stopLoss: 102 } },
    { ...raw, plan: { ...raw.plan, takeProfit: 101.1 } },
    { ...raw, plan: { ...raw.plan, maxHoldBars: 1.5 } }
  ];
  for (const input of variants) {
    const result = normalizePlan(input, market, now);
    assert.equal(result.eligible, false);
    assert.equal(result.positionRecommendation, 'WAIT');
    assert.ok(result.validationIssues.length);
  }
});
test('crossing a candle boundary during model response invalidates the signal', () => {
  assert.equal(normalizePlan(raw, market, now + hour).eligible, false);
});
test('position-unaware close signals are not executable recommendations', () => {
  const result = normalizePlan({ ...raw, positionRecommendation: 'CLOSE_SHORT' }, market, now);
  assert.equal(result.positionRecommendation, 'WAIT');
  assert.match(result.validationIssues.join(), /持仓/);
});
test('snapshot version changes with strategy, omits credentials and covers provider identity', () => {
  const args = { config: { model: { model: 'test', apiKey: 'DO_NOT_STORE', baseUrl: 'https://provider.test' } },
    strategy: { interval: '1h', rules: 'A' }, market: [market], result: { analyses: [raw] }, type: 'single', scope: { limit: 20 }, now };
  const a = createResearchRecord(args);
  const b = createResearchRecord({ ...args, strategy: { ...args.strategy, rules: 'B' } });
  assert.notEqual(a.strategyVersion, b.strategyVersion);
  assert.equal(JSON.stringify(a).includes('DO_NOT_STORE'), false);
  assert.equal(a.market[0].klines.length, 20);
  const missing = createResearchRecord({ ...args, result: { analyses: [raw, raw, { ...raw, symbol: 'ETHUSDT' }] } });
  assert.equal(missing.analyses[0].eligible, false);
  assert.match(missing.error, /重复/);
  assert.match(missing.error, /非请求/);
});
test('no look-ahead: pre-generation and unfinished candles cannot close a trade', () => {
  const result = evaluateSignal(signal, [candle(start - hour, { high: 130 }), candle(start, { high: 130 })], zeroCosts, start + 1000);
  assert.equal(result.status, 'pending');
});
test('intrabar touch cannot enter when opening price is outside entry range', () => {
  const result = evaluateSignal(signal, [candle(start, { open: 105, high: 121, low: 99, close: 110 }), candle(start + hour, { open: 105, high: 121, low: 99, close: 110 })], zeroCosts, start + 2 * hour);
  assert.equal(result.status, 'pending');
});

test('long and short backtests ignore legacy entry deadlines and fill later', () => {
  for (const short of [false, true]) {
    const legacy = { ...signal, expiresAt: new Date(start + 2 * hour).toISOString(),
      positionRecommendation: short ? 'OPEN_SHORT' : 'OPEN_LONG',
      plan: { ...signal.plan, validForBars: 2, stopLoss: short ? 120 : 90, takeProfit: short ? 80 : 120 } };
    const waiting = Array.from({ length: 8 }, (_, i) => candle(start + i * hour,
      { open: 105, high: 106, low: 104, close: 105 }));
    assert.equal(evaluateSignal(legacy, waiting, zeroCosts, start + 8 * hour).status, 'pending');
    const filled = evaluateSignal(legacy, [...waiting, candle(start + 8 * hour)], zeroCosts, start + 9 * hour);
    assert.equal(filled.status, 'open');
    assert.equal(filled.entryAt, new Date(start + 8 * hour).toISOString());
  }
});
test('both exits in one bar select stop loss', () => {
  const result = evaluateSignal(signal, [candle(start, { high: 125, low: 90 })], zeroCosts, start + hour);
  assert.equal(result.reason, 'stop_loss');
  assert.equal(result.ambiguousBar, true);
  assert.equal(result.net, -50);
});
test('stop gap uses opening price instead of optimistic stop fill', () => {
  const result = evaluateSignal(signal, [candle(start), candle(start + hour, { open: 90, low: 89, high: 94, close: 92 })], zeroCosts, start + 2 * hour);
  assert.equal(result.exit, 90);
  assert.equal(result.net, -100);
});
test('missing intermediate data cannot produce a profitable outcome', () => {
  const result = evaluateSignal(signal, [candle(start), candle(start + 2 * hour, { high: 130 })], zeroCosts, start + 3 * hour);
  assert.equal(result.status, 'data_gap');
});
test('timeout exits at close and all scenario costs reduce returns', () => {
  const data = [0, 1, 2].map(i => candle(start + i * hour));
  const free = evaluateSignal(signal, data, zeroCosts, start + 3 * hour);
  const paid = evaluateSignal(signal, data, PAPER_COSTS, start + 3 * hour);
  assert.equal(free.reason, 'timeout');
  assert.ok(paid.net < free.net);
  assert.ok(paid.fee > 0 && paid.fundingReserve > 0);
});
test('short direction reverses profit and slippage correctly', () => {
  const short = normalizePlan({ ...raw, positionRecommendation: 'OPEN_SHORT', plan: { ...raw.plan, stopLoss: 105, takeProfit: 80 } }, market, now);
  const free = evaluateSignal(short, [candle(start, { low: 79 })], zeroCosts, start + hour);
  const paid = evaluateSignal(short, [candle(start, { low: 79 })], PAPER_COSTS, start + hour);
  assert.equal(free.net, 200);
  assert.ok(paid.net < free.net);
});
test('win rate denominator includes only closed net outcomes', () => {
  const summary = summarizeResults([{ evaluation: { status: 'closed', net: 10 } }, { evaluation: { status: 'closed', net: -20 } }, { evaluation: { status: 'pending' } }, { evaluation: { status: 'data_gap' } }]);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.averageNet, -5);
  assert.equal(summary.profitFactor, 0.5);
  assert.equal(summarizeResults([]).winRate, null);
});

const config = { trader: { maxLeverage: 3, minConfidence: 0.65, maxPositionNotionalPct: 0.2, maxTotalNotionalPct: 0.3 } };
const order = { symbol: 'BTCUSDT', side: 'BUY', quantity: 1, leverage: 2, confidence: 0.8 };
const riskArgs = { order, config, account: { totalWalletBalance: 1000 }, price: 100, positions: [] };
test('unknown account or positions and invalid numbers fail closed', () => {
  for (const args of [{ ...riskArgs, account: null }, { ...riskArgs, positions: undefined }, { ...riskArgs, order: { ...order, confidence: 'bad' } }, { ...riskArgs, order: { ...order, leverage: NaN } }]) assert.equal(validateOrder(args).ok, false);
  assert.equal(validateOrder(riskArgs).ok, true);
});
test('existing positions and total exposure prevent accumulated entries', () => {
  assert.equal(validateOrder({ ...riskArgs, positions: [{ symbol: 'BTCUSDT', positionAmt: 1, markPrice: 100 }] }).ok, false);
  assert.equal(validateOrder({ ...riskArgs, positions: [{ symbol: 'ETHUSDT', positionAmt: 3, markPrice: 100 }] }).ok, false);
});
test('reduce-only short close bypasses entry confidence and notional limits', () => {
  const close = { ...riskArgs, account: null, positions: [{ symbol: 'BTCUSDT', positionAmt: -10, positionSide: 'BOTH' }], order: { ...order, reduceOnly: true, quantity: 10, confidence: 0 } };
  assert.equal(validateOrder(close).ok, true);
  assert.equal(validateOrder({ ...close, order: { ...close.order, side: 'SELL' } }).ok, false);
  assert.equal(validateOrder({ ...close, order: { ...close.order, quantity: 11 } }).ok, false);
});
test('runner derives short closing side from position and never changes leverage to exit', async () => {
  let sent;
  const runner = new TraderRunner({});
  const client = { marketOrder: async order => { sent = order; return { orderId: 1 }; }, setLeverage: () => assert.fail('Must not change leverage') };
  const result = await runner.executeDecision({ client, config, account: null, decision: { action: 'CLOSE', symbol: 'BTCUSDT', quantity: 1 }, market: [{ symbol: 'BTCUSDT', price: 100 }], positions: [{ symbol: 'BTCUSDT', positionAmt: -1, positionSide: 'BOTH' }] });
  assert.equal(result.status, 'sent');
  assert.equal(sent.side, 'BUY');
  assert.equal(sent.reduceOnly, true);
});
test('live entries cannot bypass missing protective order infrastructure', async () => {
  const runner = new TraderRunner({});
  const result = await runner.executeDecision({ ...riskArgs, client: { marketOrder: () => assert.fail('Must not send entry') }, decision: { ...order, action: 'BUY' }, market: [{ symbol: 'BTCUSDT', price: 100 }] });
  assert.equal(result.status, 'rejected');
});
