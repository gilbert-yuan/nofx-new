import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MarketDb } from '../../server/marketDb.js';

export async function isolatedSimulatedDatabase() {
  const admin = new MarketDb();
  const schema = `sim_test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...admin.pool.options, options: `-c search_path=${schema}`, max: 8 });
  return { pool, schema, async close() {
    await pool.end();
    // schema is generated above, never derived from user input or production names.
    await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.pool.end();
  } };
}
