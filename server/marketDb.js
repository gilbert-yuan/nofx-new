import pg from 'pg';

const { Pool } = pg;

export class MarketDb {
  constructor(options = {}) {
    this.pool = new Pool(resolvePgConfig(options));
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS market_klines (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        open_time BIGINT NOT NULL,
        open DOUBLE PRECISION NOT NULL,
        high DOUBLE PRECISION NOT NULL,
        low DOUBLE PRECISION NOT NULL,
        close DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        close_time BIGINT NOT NULL,
        quote_volume DOUBLE PRECISION NOT NULL,
        trade_count INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (symbol, interval, open_time)
      );

      CREATE INDEX IF NOT EXISTS idx_market_klines_lookup
        ON market_klines (symbol, interval, open_time);

      CREATE TABLE IF NOT EXISTS account_trades (
        symbol TEXT NOT NULL,
        trade_id BIGINT NOT NULL,
        order_id BIGINT NOT NULL,
        trade_time BIGINT NOT NULL,
        side TEXT NOT NULL,
        position_side TEXT,
        price DOUBLE PRECISION NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        quote_quantity DOUBLE PRECISION NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL,
        commission DOUBLE PRECISION NOT NULL,
        commission_asset TEXT NOT NULL,
        buyer BOOLEAN NOT NULL,
        maker BOOLEAN NOT NULL,
        raw JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (symbol, trade_id)
      );

      CREATE INDEX IF NOT EXISTS idx_account_trades_time
        ON account_trades (symbol, trade_time);

      CREATE INDEX IF NOT EXISTS idx_account_trades_analysis
        ON account_trades (symbol, side, trade_time);

      CREATE TABLE IF NOT EXISTS kline_sync_state (
        symbol TEXT NOT NULL,
        interval TEXT NOT NULL,
        last_open_time BIGINT,
        last_sync_at TIMESTAMPTZ,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (symbol, interval)
      );

      CREATE TABLE IF NOT EXISTS trade_sync_state (
        symbol TEXT PRIMARY KEY,
        last_trade_id BIGINT,
        last_trade_time BIGINT,
        last_sync_at TIMESTAMPTZ,
        last_status TEXT NOT NULL DEFAULT 'idle',
        last_error TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  async saveKlines({ symbol, interval, rows }) {
    if (!rows.length) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A page is committed atomically. One statement per 500 rows replaces
      // one database round trip per candle; duplicate timestamps keep the last value.
      const unique = [...new Map(rows.map(row => [Number(row.openTime), row])).values()];
      for (let offset = 0; offset < unique.length; offset += 500) {
        const batch = unique.slice(offset, offset + 500);
        const values = [];
        const tuples = batch.map(row => {
          const start = values.length;
          values.push(symbol, interval, row.openTime, row.open, row.high, row.low, row.close,
            row.volume, row.closeTime, row.quoteVolume, row.tradeCount);
          return '(' + Array.from({ length: 11 }, (_, i) => '$' + (start + i + 1)).join(',') + ')';
        });
        await client.query(`
          INSERT INTO market_klines(symbol, interval, open_time, open, high, low, close,
            volume, close_time, quote_volume, trade_count)
          VALUES ${tuples.join(',')}
          ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
            close = EXCLUDED.close, volume = EXCLUDED.volume, close_time = EXCLUDED.close_time,
            quote_volume = EXCLUDED.quote_volume, trade_count = EXCLUDED.trade_count, updated_at = NOW()
        `, values);
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listKlines({ symbol, interval, limit = 300 }) {
    const result = await this.pool.query(
      `
        SELECT
          symbol,
          interval,
          open_time AS "openTime",
          open,
          high,
          low,
          close,
          volume,
          close_time AS "closeTime",
          quote_volume AS "quoteVolume",
          trade_count AS "tradeCount"
        FROM market_klines
        WHERE symbol = $1 AND interval = $2
        ORDER BY open_time DESC
        LIMIT $3
      `,
      [symbol, interval, limit]
    );

    return result.rows.reverse().map(normalizePgRow);
  }

  async summary() {
    const result = await this.pool.query(`
        SELECT
          symbol,
          interval,
          COUNT(*)::INTEGER AS rows,
          MIN(open_time) AS "firstOpenTime",
          MAX(open_time) AS "lastOpenTime"
        FROM market_klines
        GROUP BY symbol, interval
        ORDER BY symbol, interval
      `);
    return result.rows.map(normalizePgRow);
  }

  async getKlineResumeTime({ symbol, interval }) {
    const result = await this.pool.query(`
      WITH candles AS (
        SELECT open_time, close_time, LEAD(open_time) OVER (ORDER BY open_time) AS next_time
        FROM market_klines WHERE symbol = $1 AND interval = $2
      )
      SELECT MIN(open_time) FILTER (WHERE next_time > close_time + 1) AS gap,
             MAX(open_time) AS latest FROM candles
    `, [symbol, interval]);
    const row = result.rows[0];
    const value = row?.gap ?? row?.latest;
    return value == null ? undefined : Number(value);
  }

  async getKlineSyncState({ symbol, interval }) {
    const result = await this.pool.query(
      `
      SELECT
        symbol,
        interval,
        last_open_time AS "lastOpenTime",
        last_sync_at AS "lastSyncAt",
        last_status AS "lastStatus",
        last_error AS "lastError"
      FROM kline_sync_state
      WHERE symbol = $1 AND interval = $2
    `,
      [symbol, interval]
    );
    return result.rows[0] ? normalizePgRow(result.rows[0]) : null;
  }

  async updateKlineSyncState({ symbol, interval, lastOpenTime, status = 'ok', error = '' }) {
    await this.pool.query(
      `
      INSERT INTO kline_sync_state (
        symbol, interval, last_open_time, last_sync_at, last_status, last_error
      )
      VALUES ($1, $2, $3, NOW(), $4, $5)
      ON CONFLICT(symbol, interval) DO UPDATE SET
        last_open_time = COALESCE(EXCLUDED.last_open_time, kline_sync_state.last_open_time),
        last_sync_at = NOW(),
        last_status = EXCLUDED.last_status,
        last_error = EXCLUDED.last_error
    `,
      [symbol, interval, lastOpenTime ?? null, status, error]
    );
  }

  async klineSyncStates() {
    const result = await this.pool.query(`
      SELECT
        symbol,
        interval,
        last_open_time AS "lastOpenTime",
        last_sync_at AS "lastSyncAt",
        last_status AS "lastStatus",
        last_error AS "lastError"
      FROM kline_sync_state
      ORDER BY symbol, interval
    `);
    return result.rows.map(normalizePgRow);
  }

  async saveTrades({ symbol, rows }) {
    if (!rows.length) return 0;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        await client.query(
          `
          INSERT INTO account_trades (
            symbol, trade_id, order_id, trade_time, side, position_side,
            price, quantity, quote_quantity, realized_pnl, commission,
            commission_asset, buyer, maker, raw, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
          ON CONFLICT(symbol, trade_id) DO UPDATE SET
            order_id = EXCLUDED.order_id,
            trade_time = EXCLUDED.trade_time,
            side = EXCLUDED.side,
            position_side = EXCLUDED.position_side,
            price = EXCLUDED.price,
            quantity = EXCLUDED.quantity,
            quote_quantity = EXCLUDED.quote_quantity,
            realized_pnl = EXCLUDED.realized_pnl,
            commission = EXCLUDED.commission,
            commission_asset = EXCLUDED.commission_asset,
            buyer = EXCLUDED.buyer,
            maker = EXCLUDED.maker,
            raw = EXCLUDED.raw,
            updated_at = NOW()
        `,
          [
            symbol,
            row.tradeId,
            row.orderId,
            row.time,
            row.side,
            row.positionSide,
            row.price,
            row.quantity,
            row.quoteQuantity,
            row.realizedPnl,
            row.commission,
            row.commissionAsset,
            row.buyer,
            row.maker,
            JSON.stringify(row.raw)
          ]
        );
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getTradeSyncState(symbol) {
    const result = await this.pool.query(
      `
      SELECT
        symbol,
        last_trade_id AS "lastTradeId",
        last_trade_time AS "lastTradeTime",
        last_sync_at AS "lastSyncAt",
        last_status AS "lastStatus",
        last_error AS "lastError"
      FROM trade_sync_state
      WHERE symbol = $1
    `,
      [symbol]
    );
    return result.rows[0] ? normalizePgRow(result.rows[0]) : null;
  }

  async updateTradeSyncState({ symbol, lastTradeId, lastTradeTime, status = 'ok', error = '' }) {
    await this.pool.query(
      `
      INSERT INTO trade_sync_state (
        symbol, last_trade_id, last_trade_time, last_sync_at, last_status, last_error
      )
      VALUES ($1, $2, $3, NOW(), $4, $5)
      ON CONFLICT(symbol) DO UPDATE SET
        last_trade_id = COALESCE(EXCLUDED.last_trade_id, trade_sync_state.last_trade_id),
        last_trade_time = COALESCE(EXCLUDED.last_trade_time, trade_sync_state.last_trade_time),
        last_sync_at = NOW(),
        last_status = EXCLUDED.last_status,
        last_error = EXCLUDED.last_error
    `,
      [symbol, lastTradeId || null, lastTradeTime || null, status, error]
    );
  }

  async listTrades({ symbol, limit = 500 }) {
    const params = [];
    let where = '';
    if (symbol) {
      params.push(symbol);
      where = `WHERE symbol = $${params.length}`;
    }
    params.push(limit);
    const result = await this.pool.query(
      `
      SELECT
        symbol,
        trade_id AS "tradeId",
        order_id AS "orderId",
        trade_time AS "time",
        side,
        position_side AS "positionSide",
        price,
        quantity,
        quote_quantity AS "quoteQuantity",
        realized_pnl AS "realizedPnl",
        commission,
        commission_asset AS "commissionAsset",
        buyer,
        maker
      FROM account_trades
      ${where}
      ORDER BY trade_time DESC
      LIMIT $${params.length}
    `,
      params
    );
    return result.rows.map(normalizePgRow);
  }

  async tradeSummary() {
    const result = await this.pool.query(`
      SELECT
        symbol,
        COUNT(*)::INTEGER AS trades,
        MIN(trade_time) AS "firstTradeTime",
        MAX(trade_time) AS "lastTradeTime",
        SUM(realized_pnl) AS "realizedPnl",
        SUM(commission) AS commission,
        SUM(quote_quantity) AS "quoteQuantity",
        SUM(CASE WHEN side = 'BUY' THEN quote_quantity ELSE 0 END) AS "buyQuoteQuantity",
        SUM(CASE WHEN side = 'SELL' THEN quote_quantity ELSE 0 END) AS "sellQuoteQuantity",
        AVG(price) AS "avgPrice"
      FROM account_trades
      GROUP BY symbol
      ORDER BY symbol
    `);
    return result.rows.map(normalizePgRow);
  }

  async tradeSyncStates() {
    const result = await this.pool.query(`
      SELECT
        symbol,
        last_trade_id AS "lastTradeId",
        last_trade_time AS "lastTradeTime",
        last_sync_at AS "lastSyncAt",
        last_status AS "lastStatus",
        last_error AS "lastError"
      FROM trade_sync_state
      ORDER BY symbol
    `);
    return result.rows.map(normalizePgRow);
  }

  /**
   * 清理未下单币种的旧K线数据
   * @param {Array} symbolsWithOrders - 有订单的币种列表
   * @param {number} daysToKeep - 保留最近几天的数据，默认3天
   * @returns {Object} 清理统计信息
   */
  async cleanOldKlines(symbolsWithOrders = [], daysToKeep = 3) {
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    let deletedCount = 0;
    let symbolsCleaned = [];

    if (symbolsWithOrders.length === 0) {
      // 如果没有任何订单，清理所有币种的旧数据
      const result = await this.pool.query(
        `DELETE FROM market_klines WHERE open_time < $1`,
        [cutoffTime]
      );
      deletedCount = result.rowCount;
    } else {
      // 清理未下单币种的旧数据
      const result = await this.pool.query(
        `
        DELETE FROM market_klines
        WHERE open_time < $1
          AND symbol NOT IN (${symbolsWithOrders.map((_, i) => `$${i + 2}`).join(',')})
        RETURNING DISTINCT symbol
        `,
        [cutoffTime, ...symbolsWithOrders]
      );
      deletedCount = result.rowCount;
      symbolsCleaned = [...new Set(result.rows.map(r => r.symbol))];
    }

    return {
      deletedCount,
      symbolsCleaned,
      cutoffTime,
      cutoffDate: new Date(cutoffTime).toISOString()
    };
  }
}

export function normalizeBinanceKline(row) {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    tradeCount: Number(row[8])
  };
}

export function normalizeBinanceUserTrade(row) {
  const quantity = Number(row.qty);
  const price = Number(row.price);
  return {
    symbol: row.symbol,
    tradeId: Number(row.id),
    orderId: Number(row.orderId),
    time: Number(row.time),
    side: row.side,
    positionSide: row.positionSide || '',
    price,
    quantity,
    quoteQuantity: Number(row.quoteQty || quantity * price),
    realizedPnl: Number(row.realizedPnl || 0),
    commission: Number(row.commission || 0),
    commissionAsset: row.commissionAsset || '',
    buyer: Boolean(row.buyer),
    maker: Boolean(row.maker),
    raw: row
  };
}

function resolvePgConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: parseBool(process.env.PGSSL) ? { rejectUnauthorized: false } : false
    };
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'nofx_lite',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    ssl: parseBool(process.env.PGSSL) ? { rejectUnauthorized: false } : false
  };
}

function normalizePgRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' || /^[0-9]+$/.test(String(value)) ? Number(value) : value
    ])
  );
}

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}
