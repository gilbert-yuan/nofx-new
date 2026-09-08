import 'dotenv/config';
import { MarketDb } from '../server/marketDb.js';
import { migrateSimulatedAccount } from '../server/migrateSimulatedAccount.js';

const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) {
  throw new Error('Usage: node scripts/migrate-simulated-account.js [--dry-run|--apply]');
}
const db = new MarketDb();
try {
  console.log(JSON.stringify(await migrateSimulatedAccount(db.pool, { dryRun: !args.includes('--apply') }), null, 2));
} finally { await db.pool.end(); }
