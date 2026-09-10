import { marketStorageSymbol } from './marketData.js';
// PostgreSQL archive is independent of the bounded operational decision log.
export class ResearchStore {
  constructor(pool) { this.pool = pool; }
  async init(legacy = []) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS research_records (
      id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, record JSONB NOT NULL
    ); CREATE INDEX IF NOT EXISTS research_records_time ON research_records(created_at DESC);`);
    await this.pool.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS research_records_time_id_idx ON research_records(created_at DESC, id DESC)');
    for (const record of legacy.filter(r => r.researchOnly && r.id && r.at)) await this.save(record);
  }
  async save(record) {
    await this.pool.query('INSERT INTO research_records(id, created_at, record) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [record.id, record.at, JSON.stringify(record)]);
  }
  async list({ date = '', symbol = '', limit = 100, offset = 0, snapshots = false } = {}) {
    const params = [];
    const conditions = [];
    if (date) {
      const start = new Date(`${date}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) return [];
      params.push(start, new Date(start.getTime() + 86400000));
      conditions.push('created_at >= $1 AND created_at < $2');
    }
    if (symbol) {
      params.push(symbol);
      conditions.push(`(record->>'symbol' = $${params.length} OR record->'symbols' ? $${params.length})`);
    }
    params.push(limit, offset);
    const result = await this.pool.query(`SELECT ${snapshots ? 'record' : "record - 'market' - 'snapshot'"} AS record FROM research_records
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
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
  /**
   * 清理未下单的旧分析记录
   * @param {Array} recordIdsWithOrders - 有订单的分析记录ID列表
   * @param {number} minutesToKeep - 保留最近几分钟的记录，默认30分钟
   * @returns {Object} 清理统计信息
   */
  async cleanOldRecords(recordIdsWithOrders = [], minutesToKeep = 30) {
    const cutoffTime = new Date(Date.now() - minutesToKeep * 60 * 1000);

    let deletedCount = 0;

    if (recordIdsWithOrders.length === 0) {
      // 如果没有任何订单，清理所有旧记录
      const result = await this.pool.query(
        `DELETE FROM research_records WHERE created_at < $1`,
        [cutoffTime]
      );
      deletedCount = result.rowCount;
    } else {
      // 清理未下单的旧记录
      const result = await this.pool.query(
        `
        DELETE FROM research_records
        WHERE created_at < $1
          AND id NOT IN (${recordIdsWithOrders.map((_, i) => `$${i + 2}`).join(',')})
        `,
        [cutoffTime, ...recordIdsWithOrders]
      );
      deletedCount = result.rowCount;
    }

    return {
      deletedCount,
      cutoffTime: cutoffTime.toISOString(),
      protectedRecords: recordIdsWithOrders.length
    };
  }
}
