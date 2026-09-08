import { marketStorageSymbol } from './marketData.js';
// PostgreSQL archive is independent of the bounded operational decision log.
export class ResearchStore {
  constructor(pool) { this.pool = pool; }
  async init(legacy = []) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS research_records (
      id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, record JSONB NOT NULL
    ); CREATE INDEX IF NOT EXISTS research_records_time ON research_records(created_at DESC);`);
    for (const record of legacy.filter(r => r.researchOnly && r.id && r.at)) await this.save(record);
  }
  async save(record) {
    await this.pool.query('INSERT INTO research_records(id, created_at, record) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [record.id, record.at, JSON.stringify(record)]);
  }
  async list({ date = '', symbol = '', limit = 100, offset = 0, snapshots = false } = {}) {
    const result = await this.pool.query(`SELECT ${snapshots ? 'record' : "record - 'market' - 'snapshot'"} AS record FROM research_records
      WHERE ($1 = '' OR to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = $1)
      AND ($2 = '' OR record->>'symbol' = $2 OR record->'symbols' ? $2)
      ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`, [date, symbol, limit, offset]);
    return result.rows.map(r => r.record);
  }
  async get(id) {
    return (await this.pool.query('SELECT record FROM research_records WHERE id=$1', [id])).rows[0]?.record;
  }
  async candles(symbol, interval, start, end, provider = 'binance') {
    const result = await this.pool.query(`SELECT open_time AS "openTime", open, high, low, close, volume, updated_at AS "refreshedAt"
      FROM market_klines WHERE symbol=$1 AND interval=$2 AND open_time >= $3 AND open_time < $4 ORDER BY open_time`,
    [marketStorageSymbol(symbol, provider), interval, start, end]);
    return result.rows.map(row => ({ ...row, openTime: Number(row.openTime) }));
  }
}
