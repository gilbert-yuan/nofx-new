/**
 * 模拟账户仓储层性能基准：分解 repo.mutate() 各阶段耗时，定位瓶颈。
 * 用法: node scripts/bench-sim-repo.mjs
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { SimulatedAccountRepository, projectAccount } from '../server/simulatedAccountRepository.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const repo = new SimulatedAccountRepository(pool);
await repo.init();

const time = async (label, fn) => {
  const t = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${label.padEnd(36)} ${ms.toFixed(0).padStart(7)} ms`);
  return out;
};

const state = await time('read() 全量', () => repo.read());
const orderCount = state.orders?.length ?? 0;
const extCount = (state.orders || []).reduce((n, o) => n + (o.extensions ? Object.keys(o.extensions).length : 0), 0);
console.log(`  ↳ orders=${orderCount}, extensions 键≈${extCount}`);

await time('  └ structuredClone(state)', async () => structuredClone(state));
await time('  └ projectAccount(state) ×1', async () => projectAccount(state));
const projected = await time('    └ projectAccount ×2 合计', async () => {
  projectAccount(state);
  return projectAccount(state);
});
console.log(`    ↳ 投影行数: ${Object.entries(projected).map(([k, v]) => `${k}=${v.length}`).join(' ')}`);

await time('mutate() 空改动（全量）', () => repo.mutate(() => 'noop'));
await time('mutate() 空改动（light）', () => repo.mutate(() => 'noop', { light: true }));
await time('mutate() 改1个订单（light）', () =>
  repo.mutate((s) => {
    const o = s.orders?.[0];
    if (o) o.__bench = Date.now();
    return 'ok';
  }, { light: true })
);

await pool.end();
