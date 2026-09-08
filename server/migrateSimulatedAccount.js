import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SimulatedAccountRepository, simulatedAccountSchema } from './simulatedAccountRepository.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const accountDigest = state => createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');

export async function migrateSimulatedAccount(pool, { dryRun = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':simulated-account-v2'))");
    const existing = await client.query("SELECT to_regclass('simulated_account_migrations') AS migration");
    if (existing.rows[0].migration) {
      const applied = await client.query('SELECT * FROM simulated_account_migrations WHERE version=2');
      if (applied.rowCount) {
        await client.query('COMMIT');
        return { alreadyApplied: true, migration: applied.rows[0] };
      }
    }
    // The lock covers snapshot, validation and cutover; older writers cannot race it.
    await client.query('LOCK TABLE simulated_account IN ACCESS EXCLUSIVE MODE');
    const { rows } = await client.query('SELECT state FROM simulated_account WHERE id=1');
    if (rows.length !== 1 || !Array.isArray(rows[0].state?.orders)) throw new Error('Expected one legacy account with an orders array');
    const source = rows[0].state;
    await client.query(simulatedAccountSchema);
    if ((await client.query('SELECT 1 FROM simulated_accounts LIMIT 1')).rowCount) throw new Error('Destination is not empty; refusing to overwrite normalized data');
    const repository = new SimulatedAccountRepository(pool);
    await repository.writeChanges(client, null, source);
    const restored = await repository.readFrom(client);
    if (!isDeepStrictEqual(source, restored)) throw new Error('Migration verification failed: reconstructed state differs from the source');
    const digest = accountDigest(source);
    await client.query('INSERT INTO simulated_account_migrations(version,source_order_count,source_digest) VALUES(2,$1,$2)', [source.orders.length, digest]);
    // Preserve the original snapshot, and make stale code fail instead of silently
    // writing to a second ledger after cutover.
    await client.query('ALTER TABLE simulated_account RENAME TO simulated_account_legacy_v1');
    const summary = { dryRun, verified: true, orders: source.orders.length,
      reviews: source.orders.reduce((n, o) => n + (o.reviewHistory?.length || 0), 0),
      revisions: source.orders.reduce((n, o) => n + (o.protectionRevisions?.length || 0), 0),
      digest, backupTable: 'simulated_account_legacy_v1' };
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return summary;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
