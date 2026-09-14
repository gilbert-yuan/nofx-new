import pg from 'pg';

/**
 * 币种最大杠杆持久化（"获取币种时记录最大杠杆数"需求）。
 *
 * 数据源：币安 U 本位永续 exchangeInfo 中每个 symbol 的 filters.LEVERAGE_FILTER.maxLeverage。
 * 落库目的：① 跨重启保留历史值，消除冷启动空窗；② 可 SQL 查询"哪些币杠杆偏低"。
 * 下单前由 binanceMarket.getMaxLeverage 读取，截断超过币种上限的杠杆，规避
 * Binance `400: Leverage N is not valid`（如 ARKUSDT 在 Demo 最大杠杆 < 12）。
 *
 * ⚠️ 连接：复用 process.env.DATABASE_URL（PM2 运行时注入 = nofx_lite）。DAO 默认串
 * postgres:postgres@localhost:5432/nofx 连不上，但运行时由 env 覆盖，不会用到 fallback。
 */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

let ensurePromise = null;

export async function ensureSymbolLeverageTable() {
  if (ensurePromise) return ensurePromise;
  // 用 promise 缓存防并发 CREATE（多个调用并发时只真正建一次，避免 pg_type 唯一约束冲突）。
  ensurePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS symbol_leverage (
        symbol text PRIMARY KEY,
        max_leverage integer NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  })();
  return ensurePromise;
}

/**
 * 批量 upsert 币种最大杠杆。rows: [{ symbol, maxLeverage }]。
 * 用 unnest 参数化（防注入）；非有限/<=0 的行会被跳过。
 * @returns 实际写入行数
 */
export async function upsertSymbolLeverage(rows) {
  const valid = (rows || []).filter(
    r => r && typeof r.symbol === 'string' && r.symbol &&
      Number.isFinite(Number(r.maxLeverage)) && Number(r.maxLeverage) > 0
  );
  if (!valid.length) return 0;
  await ensureSymbolLeverageTable();
  const symbols = valid.map(r => r.symbol);
  const levs = valid.map(r => Math.floor(Number(r.maxLeverage)));
  await pool.query(
    `INSERT INTO symbol_leverage (symbol, max_leverage)
     SELECT * FROM unnest($1::text[], $2::int[])
     ON CONFLICT (symbol) DO UPDATE SET max_leverage = EXCLUDED.max_leverage, updated_at = now()`,
    [symbols, levs]
  );
  return valid.length;
}

/** 全量读取（用于启动预热内存缓存）。 */
export async function loadAllSymbolLeverage() {
  await ensureSymbolLeverageTable();
  const r = await pool.query('SELECT symbol, max_leverage FROM symbol_leverage');
  return r.rows.map(row => ({ symbol: row.symbol, maxLeverage: Number(row.max_leverage) }));
}

/** 单币种读取（按需）。 */
export async function getSymbolLeverage(symbol) {
  const r = await pool.query('SELECT max_leverage FROM symbol_leverage WHERE symbol = $1', [symbol]);
  return r.rows.length ? Number(r.rows[0].max_leverage) : null;
}
