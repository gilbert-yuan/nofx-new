import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { BinanceAccountSync } from '../server/binanceAccountSync.js';
import { buildPaperActivity, normalizeBinanceAccount } from '../shared/paperOrderActivity.js';
import { registerSimulationRoutes, SimulatedAccount, accountSummary } from '../server/simulatedAccount.js';
import { projectAccount, hydrateAccount } from '../server/simulatedAccountRepository.js';
import { isolatedSimulatedDatabase } from './helpers/simulatedDatabase.js';
import { normalizeBinanceFunds, summarizeBinanceIncome, selectPaperOverview } from '../shared/paperAccountMetrics.js';
import { BinanceClient } from '../server/binanceClient.js';

const config = { binance: { demo: true, demoApiKey: 'demo-key', demoSecretKey: 'demo-secret' }, trader: { syncPaperOrdersToDemo: true } };
const position = overrides => ({ symbol: 'ADAUSDT', positionSide: 'BOTH', positionAmt: '42', entryPrice: '0.28', markPrice: '0.27', leverage: '5', unRealizedProfit: '-0.42', ...overrides });
const entry = overrides => ({ symbol: 'ADAUSDT', orderId: 123, clientOrderId: 'nofxpaperlocal1', positionSide: 'BOTH', side: 'BUY', type: 'LIMIT', status: 'NEW', origQty: '50', executedQty: '0', price: '0.28', ...overrides });
const local = overrides => ({ id: 'local-1', symbol: 'ADAUSDT', direction: 'OPEN_LONG', status: 'pending', exchangeSync: { demo: { orderId: 123, executedQty: 42, status: 'filled', positionSide: 'BOTH' } }, ...overrides });
const account = (positions, orders = []) => ({ demo: { enabled: true, configured: true, environment: 'demo', syncedAt: '2026-10-06T10:00:00Z', ...normalizeBinanceAccount(positions, orders) } });
const funds = overrides => ({ totalWalletBalance: '1000', availableBalance: '899.58', totalMarginBalance: '999.58',
  totalUnrealizedProfit: '-0.42', totalInitialMargin: '100', totalPositionInitialMargin: '80', totalOpenOrderInitialMargin: '20', ...overrides });
const flow = overrides => ({ incomeType: 'REALIZED_PNL', tranId: '1', income: '10', asset: 'USDT', time: Date.now() - 1000, ...overrides });

test('filled Demo entry displays an actual holding while the local candle simulation is pending', () => {
  const order = local(), before = structuredClone(order);
  const rows = buildPaperActivity([order], account([position()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'binance-demo');
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].quantity, 42);
  assert.equal(rows[0].entry, 0.28);
  assert.equal(rows[0].unrealized, -0.42);
  assert.deepEqual(rows[0].localOrders, [{ id: order.id, symbol: order.symbol, status: 'pending' }]);
  assert.deepEqual(order, before, 'exchange observations must not alter the simulated ledger or create new trade intents');
});

test('partial entry displays the filled holding and remaining pending quantity without a third local duplicate', () => {
  const snapshot = account([position()], [entry({ status: 'PARTIALLY_FILLED', executedQty: '42' })]);
  const rows = buildPaperActivity([local()], snapshot);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.status === 'pending').quantity, 8);
  assert.equal(rows.find(row => row.status === 'pending').remoteStatus, 'partially_filled');
  assert.equal(new Set(rows.map(row => row.id)).size, 2);
  assert.deepEqual(buildPaperActivity([local()], snapshot), rows, 'repeated reconciliation is idempotent');
});

test('unbound holdings are visible; hedge sides and exchange environments remain separate', () => {
  const snapshot = account([position({ positionSide: 'LONG' }), position({ positionSide: 'SHORT', positionAmt: '-3' })]);
  snapshot.live = { ...snapshot.demo, environment: 'live' };
  const rows = buildPaperActivity([], snapshot);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
  assert.equal(rows.filter(row => row.direction === 'OPEN_SHORT').length, 2);
  assert.ok(rows.every(row => row.localOrders.length === 0));
});

test('open entry binds by deterministic client ID even when old summary metadata is missing', () => {
  const rows = buildPaperActivity([local({ exchangeSync: undefined, status: 'closed' })], account([], [entry()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].localOrders[0].id, 'local-1');
  assert.equal(rows[0].status, 'pending', 'remote active orders must not disappear under a local terminal status');
});

test('protection orders and hedge exits are excluded from pending entries; invalid snapshots fail', () => {
  const data = normalizeBinanceAccount([], [entry(), entry({ orderId: 2, reduceOnly: true }), entry({ orderId: 3, positionSide: 'LONG', side: 'SELL' }), entry({ orderId: 4, positionSide: 'SHORT', side: 'BUY' })]);
  assert.equal(data.orders.length, 1);
  assert.throws(() => normalizeBinanceAccount(null, []), /完整/);
  assert.throws(() => normalizeBinanceAccount([position({ positionAmt: 'bad' })], []), /无效/);
});

function syncFixture() {
  const state = { orders: [] }, calls = [];
  let positions = [position()], orders = [entry()], failure = '', currentConfig = structuredClone(config);
  let wallet = funds(), income = [flow()], incomeFailure = '';
  const sync = new BinanceAccountSync({
    simulation: { mutateLight: async fn => fn(state) },
    store: { getConfig: async () => currentConfig },
    clientFactory: resolved => {
      calls.push(resolved.environment);
      return { positions: async () => { if (failure) throw new Error(failure); return positions; }, openOrders: async () => orders,
        account: async () => wallet, incomeHistory: async () => { if (incomeFailure) throw new Error(incomeFailure); return income; } };
    }
  });
  return { sync, state, calls, set: values => { positions = values.positions ?? positions; orders = values.orders ?? orders; failure = values.failure ?? failure; currentConfig = values.config ?? currentConfig;
    wallet = values.wallet ?? wallet; income = values.income ?? income; incomeFailure = values.incomeFailure ?? incomeFailure; } };
}

test('account reconciliation is persisted, coalesced and read-only; successful empty responses clear stale entries', async () => {
  const { sync, state, calls, set } = syncFixture();
  await Promise.all([sync.refresh(), sync.refresh(), sync.refresh()]);
  assert.deepEqual(calls, ['demo'], 'only the configured Demo is queried, once');
  assert.equal(state.exchangeAccounts.demo.positions.length, 1);
  assert.deepEqual(hydrateAccount(projectAccount(state)), state, 'snapshots survive the normalized SQL projection');
  set({ positions: [], orders: [] });
  await sync.refresh();
  assert.equal(buildPaperActivity([], state.exchangeAccounts).length, 0);
});

test('network failure preserves last good state and marks it stale; a changed account never inherits old holdings', async () => {
  const { sync, state, set } = syncFixture();
  await sync.refresh();
  const syncedAt = state.exchangeAccounts.demo.syncedAt;
  set({ failure: 'network timeout' });
  await sync.refresh();
  assert.equal(state.exchangeAccounts.demo.syncedAt, syncedAt);
  assert.equal(buildPaperActivity([], state.exchangeAccounts)[0].stale, true);
  set({ config: { ...config, binance: { ...config.binance, demoApiKey: 'another-account' } } });
  await sync.refresh();
  assert.equal(state.exchangeAccounts.demo.syncedAt, undefined);
  assert.equal(buildPaperActivity([], state.exchangeAccounts).length, 0);
});

test('summary status includes the same activity rows and counts used by the list', async () => {
  const sim = new SimulatedAccount({ pool: {}, market: {} });
  sim.repository.read = async () => ({ initialBalance: 1000, orders: [local({ margin: 10, notional: 50, costs: { feeBps: 6 } })], exchangeAccounts: account([position()]) });
  const result = await sim.status({ summary: true });
  assert.equal(result.orders[0].status, 'pending');
  assert.deepEqual(result.activityCounts, { positions: 1, pending: 0 });
  assert.equal(result.activeOrders.length, result.activityCounts.positions + result.activityCounts.pending);
});

test('background reconciliation invalidates an already cached account response', async () => {
  let state = { orders: [], activeOrders: [] };
  const sim = { stateRevision: 0, status: async () => structuredClone(state) };
  const app = express(); registerSimulationRoutes(app, sim);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/paper/account?view=summary`;
  try {
    assert.equal((await (await fetch(url)).json()).activeOrders.length, 0);
    state.activeOrders.push({ id: 'new-order', status: 'open' });
    sim.stateRevision++;
    assert.equal((await (await fetch(url)).json()).activeOrders.length, 1, 'new orders appear immediately, without waiting for the 30-second cache');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('PostgreSQL persists exchange activity and active bindings across service instances', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const options = { pool: db.pool, market: {}, store: { getConfig: async () => config },
      clientFactory: () => ({ positions: async () => [position()], openOrders: async () => [], account: async () => funds(), incomeHistory: async () => [flow()] }) };
    const simulation = new SimulatedAccount(options);
    await simulation.init();
    await simulation.mutateLight(state => state.orders.push(local({ margin: 10, notional: 50, costs: { feeBps: 6 } })));
    await simulation.accountSync.refresh();
    const restarted = new SimulatedAccount(options);
    const result = await restarted.status({ summary: true });
    assert.deepEqual(result.activityCounts, { positions: 1, pending: 0 });
    assert.equal(result.activeOrders[0].localOrders[0].id, 'local-1');
    assert.equal(result.orders[0].status, 'pending');
    assert.equal(result.exchangeAccounts.demo.accountKey, undefined, 'internal account fingerprint is not exposed');
    assert.equal(selectPaperOverview(result).available, 899.58);
    assert.equal(selectPaperOverview(result).realized, 10);
    await simulation.mutateLight(state => state.orders.push({ id: 'partial', symbol: 'LTCUSDT', status: 'open',
      margin: 100, quantity: 6, realizedQty: 4, realizedNet: 20, entryFee: 3, unrealized: 30 }));
    const full = accountSummary(await restarted.readLight()), summary = await restarted.status({ summary: true });
    for (const key of ['realized', 'available', 'equity', 'net', 'usedMargin']) assert.equal(summary[key], full[key], `summary must retain partial-exit ${key}`);
  } finally { await db.close(); }
});

test('exchange financial overview uses exchange balances and excludes transfers from net profit', async () => {
  const { sync, state, set } = syncFixture();
  set({ income: [flow(), flow({ incomeType: 'COMMISSION', tranId: '2', income: '-1' }),
    flow({ incomeType: 'FUNDING_FEE', tranId: '3', income: '-0.5' }), flow({ incomeType: 'TRANSFER', tranId: '4', income: '1000' })] });
  await sync.refresh();
  const overview = selectPaperOverview({ ...state, equity: 100, available: 20, realized: 0 });
  assert.equal(overview.source, 'binance-demo');
  assert.equal(overview.available, 899.58);
  assert.equal(overview.equity, 999.58);
  assert.equal(overview.realized, 8.5);
  assert.equal(overview.net, 8.08);
  assert.equal(overview.equity, overview.balance + overview.unrealized);
  assert.equal(overview.usedMargin, overview.positionMargin + overview.orderMargin);
  set({ wallet: funds({ totalWalletBalance: '1100', totalMarginBalance: '1099.58', availableBalance: '999.58' }) });
  await sync.refresh();
  assert.equal(selectPaperOverview(state).available, 999.58, 'wallet refresh is not blocked by the income cache');
});

test('income failure preserves prior profit while wallet balances continue to update', async () => {
  const { sync, state, set } = syncFixture();
  await sync.refresh();
  const asOf = state.exchangeAccounts.demo.income.asOf;
  set({ wallet: funds({ availableBalance: '888' }), incomeFailure: 'income timeout' });
  await sync.refresh({ forceIncome: true });
  const overview = selectPaperOverview(state);
  assert.equal(overview.available, 888);
  assert.equal(overview.realized, 10);
  assert.equal(overview.incomeAsOf, asOf);
  assert.match(overview.incomeError, /timeout/);
  set({ incomeFailure: '', income: [] });
  await sync.refresh({ forceIncome: true });
  assert.equal(selectPaperOverview(state).realized, 0);
  assert.equal(selectPaperOverview(state).incomeError, '');
});

test('income pagination covers every page with a fixed time range and deduplicates flow IDs', async () => {
  const { sync, state } = syncFixture();
  const calls = [];
  sync.clientFactory = () => ({ positions: async () => [], openOrders: async () => [], account: async () => funds(),
    incomeHistory: async params => {
      calls.push(params);
      return params.page === 1 ? Array.from({ length: 1000 }, (_, i) => flow({ tranId: String(i), income: '1' }))
        : [flow({ tranId: '999', income: '1' }), flow({ tranId: '1000', income: '2' })];
    } });
  await sync.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].endTime, calls[1].endTime);
  assert.equal(state.exchangeAccounts.demo.income.count, 1001);
  assert.equal(selectPaperOverview(state).realized, 1002);
});

test('invalid funds preserve a complete snapshot; missing funds never fall back to the paper balance', async () => {
  const { sync, state, set } = syncFixture();
  await sync.refresh();
  const prior = state.exchangeAccounts.demo.funds;
  set({ wallet: funds({ availableBalance: null }) });
  await sync.refresh();
  assert.deepEqual(state.exchangeAccounts.demo.funds, prior);
  assert.match(selectPaperOverview(state).error, /不完整/);
  const noFunds = selectPaperOverview({ equity: 10, available: 2, exchangeAccounts: account([position()]) });
  assert.equal(noFunds.equity, null);
  assert.equal(noFunds.available, null);
  assert.equal(selectPaperOverview({ equity: 10, orders: [] }, 'paper').equity, 10);
});

test('profit has an explicit window and currency; foreign-asset flows are not silently added', () => {
  const row = flow({ time: 100 });
  const income = summarizeBinanceIncome([row, row, flow({ time: 100, asset: 'BNB' }), flow({ time: 1, tranId: '2' })], { startTime: 50, endTime: 150 });
  assert.equal(income.realized, 10);
  assert.equal(income.count, 1);
  assert.deepEqual(income.excludedAssets, ['BNB']);
  const snapshots = account([]); snapshots.demo.funds = normalizeBinanceFunds(funds()); snapshots.demo.income = income;
  const overview = selectPaperOverview({ exchangeAccounts: snapshots });
  assert.equal(overview.realized, null);
  assert.equal(overview.net, null);
  assert.match(overview.incomeWarning, /BNB/);
  assert.equal(normalizeBinanceFunds(funds({ multiAssetsMargin: true })).unit, 'USD');
  assert.throws(() => summarizeBinanceIncome([flow({ income: 'bad' })], { startTime: 0, endTime: Date.now() }), /无效/);
});

test('income history client uses the read-only signed endpoint with pagination parameters', async () => {
  const client = new BinanceClient({ demo: true }), calls = [];
  client.signedRequest = async (...args) => { calls.push(args); return []; };
  await client.incomeHistory({ startTime: 1, endTime: 2, page: 3, limit: 1000 });
  assert.deepEqual(calls, [['GET', '/fapi/v1/income', { startTime: 1, endTime: 2, page: 3, limit: 1000 }]]);
});
