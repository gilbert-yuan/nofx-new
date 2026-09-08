import test from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import { projectAccount, hydrateAccount, SimulatedAccountRepository, simulatedAccountSchema } from '../server/simulatedAccountRepository.js';
import { migrateSimulatedAccount, accountDigest } from '../server/migrateSimulatedAccount.js';
import { isolatedSimulatedDatabase } from './helpers/simulatedDatabase.js';

function fixture() {
  return { initialBalance: 10000, unlimitedCapital: true,
    automation: { enabled: true, version: 1, interval: '1m', margin: 100, engine: 'local',
      scan: { index: 2, owner: 'worker', leaseUntil: 1700000000000, nextAt: 1800000000000,
        running: false, finishedAt: null, symbols: ['BTCUSDT', 'ETHUSDT'], errors: ['timeout'], submitted: 1 },
      review: { symbols: [], errors: [], running: false } },
    orders: [{ id: 'order-1', recordId: 'record-1', symbol: 'BTCUSDT', status: 'closed', direction: 'OPEN_LONG',
      createdAt: '2026-09-08T16:00:00.123Z', nextTime: 1780000000000, entry: 100.005, entryFee: 0,
      net: -1.23456789012345, margin: 100, leverage: 3, notional: 300, error: '', automatic: false,
      plan: { entryMin: 99, entryMax: 101, stopLoss: 90, takeProfit: 120, maxHoldBars: 10 },
      initialPlan: null, costs: { feeBps: 0, slippageBps: 5, fundingBpsPer8h: 3 },
      analysisContext: { confidence: 0, confidenceType: 'rule_strength', strategyVersion: 'v1',
        signal: { symbol: 'BTCUSDT', eligible: true, confidence: null, plan: { stopLoss: 90 }, validationIssues: [] },
        scope: { interval: '1m', limit: 80, symbols: ['BTCUSDT', 'ETHUSDT'] }, validationIssues: ['sample'] },
      protectionRevisions: [{ at: '2026-09-08T16:01:00.000Z', effectiveFrom: 1780000000000, stopLoss: 95, takeProfit: 125 }],
      reviewHistory: [{ action: 'updated', previous: { stopLoss: 90, takeProfit: 120 }, reason: '', confidence: null }],
      extraIndicator: { values: [0, false, '', null, {}, []] }
    }] };
}

test('relational projection round-trips every value, including nulls, zero, ordering and extension scalars', () => {
  const state = fixture();
  assert.deepEqual(hydrateAccount(projectAccount(state)), state);
  assert.doesNotMatch(simulatedAccountSchema, /\bJSONB?\b/i);
  const tables = projectAccount(state);
  assert.equal(tables.simulated_order_plans.length, 2);
  assert.equal(tables.simulated_automation_symbols.length, 2);
  assert.equal(tables.simulated_order_reviews[0].previous_stop_loss, 90);
  assert.equal(tables.simulated_orders[0].net, state.orders[0].net);
});

test('duplicate order IDs are rejected before writing any row', () => {
  const state = fixture(); state.orders.push(structuredClone(state.orders[0]));
  assert.throws(() => projectAccount(state), /duplicate/);
});

test('PostgreSQL migration is lossless, transactional, repeatable and preserves its original snapshot', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const source = fixture();
    await db.pool.query('CREATE TABLE simulated_account(id INTEGER PRIMARY KEY CHECK(id=1), state JSONB NOT NULL)');
    await db.pool.query('INSERT INTO simulated_account VALUES(1,$1)', [JSON.stringify(source)]);
    assert.equal((await migrateSimulatedAccount(db.pool)).verified, true);
    assert.equal((await db.pool.query("SELECT to_regclass('simulated_accounts') AS name")).rows[0].name, null);
    assert.deepEqual((await db.pool.query('SELECT state FROM simulated_account')).rows[0].state, source);
    const result = await migrateSimulatedAccount(db.pool, { dryRun: false });
    assert.equal(result.digest, accountDigest(source));
    const repo = new SimulatedAccountRepository(db.pool);
    await repo.init();
    assert.deepEqual(await repo.read(), source);
    assert.deepEqual((await db.pool.query('SELECT state FROM simulated_account_legacy_v1')).rows[0].state, source);
    assert.equal((await migrateSimulatedAccount(db.pool, { dryRun: false })).alreadyApplied, true);
    assert.equal((await db.pool.query("SELECT to_regclass('simulated_account') AS name")).rows[0].name, null);
    const json = await db.pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema=$1 AND table_name <> 'simulated_account_legacy_v1' AND data_type IN ('json','jsonb')", [db.schema]);
    assert.equal(json.rowCount, 0);
  } finally { await db.close(); }
});

test('normalized mutations serialize concurrent reservations, rollback failures and leave unchanged orders untouched', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const repo = new SimulatedAccountRepository(db.pool);
    await repo.init();
    await repo.mutate(state => Object.assign(state, fixture()));
    const rowVersion = () => db.pool.query("SELECT xmin::text AS version FROM simulated_orders WHERE order_id='order-1'");
    const beforeVersion = (await rowVersion()).rows[0].version;
    await Promise.all(Array.from({ length: 8 }, () => repo.mutate(state => { state.initialBalance += 1; })));
    assert.equal((await repo.read()).initialBalance, 10008);
    assert.equal((await rowVersion()).rows[0].version, beforeVersion);
    const before = await repo.read();
    await assert.rejects(repo.mutate(state => { state.initialBalance = 0; throw Error('rollback'); }), /rollback/);
    assert.deepEqual(await repo.read(), before);
    // A database constraint error after other writes rolls back the entire transaction.
    await assert.rejects(repo.mutate(state => { state.initialBalance = 0; state.orders[0].status = 'invalid'; }));
    assert.deepEqual(await repo.read(), before);
    await repo.mutate(state => {
      state.orders[0].reviewHistory.push({ action: 'held', reason: 'new', previous: { stopLoss: 95 } });
      state.automation.scan.errors = [];
    });
    const updated = await repo.read();
    assert.equal(updated.orders[0].reviewHistory.length, 2);
    assert.deepEqual(updated.automation.scan.errors, []);
    await repo.mutate(state => { state.orders = []; });
    assert.equal((await db.pool.query('SELECT count(*)::integer AS count FROM simulated_order_reviews')).rows[0].count, 0);
  } finally { await db.close(); }
});

test('invalid legacy data aborts migration without removing the source or leaving partial tables', { skip: process.env.SIMULATED_DB_TEST !== '1' }, async () => {
  const db = await isolatedSimulatedDatabase();
  try {
    const source = fixture(); source.orders.push(structuredClone(source.orders[0]));
    await db.pool.query('CREATE TABLE simulated_account(id INTEGER PRIMARY KEY, state JSONB NOT NULL)');
    await db.pool.query('INSERT INTO simulated_account VALUES(1,$1)', [JSON.stringify(source)]);
    await assert.rejects(migrateSimulatedAccount(db.pool, { dryRun: false }), /duplicate/);
    assert.deepEqual((await db.pool.query('SELECT state FROM simulated_account')).rows[0].state, source);
    assert.equal((await db.pool.query("SELECT to_regclass('simulated_accounts') AS name")).rows[0].name, null);
  } finally { await db.close(); }
});
