/**
 * Paper Trading 数据访问层
 * 使用关系表替代 JSONB 存储
 */

import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/nofx'
});

/**
 * 账户配置操作
 */
export class PaperAccountConfigDAO {
  /**
   * 获取账户配置
   */
  static async get() {
    const result = await pool.query(`
      SELECT initial_balance, unlimited_capital, automation
      FROM paper_account_config
      WHERE id = 1
    `);

    if (result.rows.length === 0) {
      // 初始化默认配置
      await pool.query(`
        INSERT INTO paper_account_config (id, initial_balance, unlimited_capital, automation)
        VALUES (1, 10000, false, '{}'::jsonb)
      `);
      return { initialBalance: 10000, unlimitedCapital: false, automation: {} };
    }

    const row = result.rows[0];
    return {
      initialBalance: Number(row.initial_balance),
      unlimitedCapital: row.unlimited_capital,
      automation: row.automation
    };
  }

  /**
   * 更新账户配置
   */
  static async update(config) {
    await pool.query(`
      UPDATE paper_account_config
      SET initial_balance = $1,
          unlimited_capital = $2,
          automation = $3,
          updated_at = NOW()
      WHERE id = 1
    `, [
      config.initialBalance,
      config.unlimitedCapital,
      JSON.stringify(config.automation || {})
    ]);
  }
}

/**
 * 订单操作
 */
export class PaperOrderDAO {
  /**
   * 创建订单
   */
  static async create(order) {
    const result = await pool.query(`
      INSERT INTO paper_orders (
        id, record_id, symbol, interval, direction, status,
        margin, leverage, notional,
        created_at, next_time, expires_at,
        automatic, market_provider,
        plan, initial_plan, costs, analysis_context,
        held_bars, error
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14,
        $15, $16, $17, $18,
        $19, $20
      )
      RETURNING *
    `, [
      order.id, order.recordId, order.symbol, order.interval, order.direction, order.status,
      order.margin, order.leverage, order.notional,
      order.createdAt, order.nextTime, order.expiresAt,
      order.automatic, order.marketProvider || 'okx',
      JSON.stringify(order.plan), JSON.stringify(order.initialPlan), JSON.stringify(order.costs),
      order.analysisContext ? JSON.stringify(order.analysisContext) : null,
      order.heldBars || 0, order.error || ''
    ]);

    return this._mapRow(result.rows[0]);
  }

  /**
   * 获取所有订单
   */
  static async getAll() {
    const result = await pool.query(`
      SELECT * FROM paper_orders
      ORDER BY created_at DESC
    `);

    return result.rows.map(row => this._mapRow(row));
  }

  /**
   * 获取活跃订单（pending 或 open）
   */
  static async getActive() {
    const result = await pool.query(`
      SELECT * FROM paper_orders
      WHERE status IN ('pending', 'open')
      ORDER BY next_time ASC
    `);

    return result.rows.map(row => this._mapRow(row));
  }

  /**
   * 根据 ID 获取订单
   */
  static async getById(id) {
    const result = await pool.query(`
      SELECT * FROM paper_orders
      WHERE id = $1
    `, [id]);

    return result.rows.length > 0 ? this._mapRow(result.rows[0]) : null;
  }

  /**
   * 根据币种获取订单
   */
  static async getBySymbol(symbol) {
    const result = await pool.query(`
      SELECT * FROM paper_orders
      WHERE symbol = $1
      ORDER BY created_at DESC
    `, [symbol]);

    return result.rows.map(row => this._mapRow(row));
  }

  /**
   * 获取已平仓订单
   */
  static async getClosed(limit = 100) {
    const result = await pool.query(`
      SELECT * FROM paper_orders
      WHERE status = 'closed'
      ORDER BY exit_at DESC
      LIMIT $1
    `, [limit]);

    return result.rows.map(row => this._mapRow(row));
  }

  /**
   * 更新订单
   */
  static async update(order) {
    const result = await pool.query(`
      UPDATE paper_orders
      SET
        status = $2,
        entry = $3,
        entry_at = $4,
        entry_fee = $5,
        quantity = $6,
        exit = $7,
        exit_at = $8,
        reason = $9,
        gross = $10,
        fees = $11,
        funding = $12,
        net = $13,
        roi = $14,
        mark_price = $15,
        mark_at = $16,
        unrealized = $17,
        liquidation_price = $18,
        held_bars = $19,
        next_time = $20,
        error = $21,
        ambiguous_bar = $22,
        isolated_loss_adjustment = $23,
        plan = $24,
        protection_revisions = $25,
        review_history = $26
      WHERE id = $1
      RETURNING *
    `, [
      order.id,
      order.status,
      order.entry || null,
      order.entryAt || null,
      order.entryFee || null,
      order.quantity || null,
      order.exit || null,
      order.exitAt || null,
      order.reason || null,
      order.gross || null,
      order.fees || null,
      order.funding || null,
      order.net || null,
      order.roi || null,
      order.markPrice || null,
      order.markAt || null,
      order.unrealized || 0,
      order.liquidationPrice || null,
      order.heldBars || 0,
      order.nextTime,
      order.error || '',
      order.ambiguousBar || false,
      order.isolatedLossAdjustment || 0,
      JSON.stringify(order.plan),
      JSON.stringify(order.protectionRevisions || []),
      JSON.stringify(order.reviewHistory || [])
    ]);

    return this._mapRow(result.rows[0]);
  }

  /**
   * 批量更新订单
   */
  static async updateBatch(orders) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const results = [];
      for (const order of orders) {
        const result = await client.query(`
          UPDATE paper_orders
          SET
            status = $2,
            entry = $3,
            entry_at = $4,
            entry_fee = $5,
            quantity = $6,
            exit = $7,
            exit_at = $8,
            reason = $9,
            gross = $10,
            fees = $11,
            funding = $12,
            net = $13,
            roi = $14,
            mark_price = $15,
            mark_at = $16,
            unrealized = $17,
            liquidation_price = $18,
            held_bars = $19,
            next_time = $20,
            error = $21,
            ambiguous_bar = $22,
            isolated_loss_adjustment = $23,
            plan = $24,
            protection_revisions = $25,
            review_history = $26
          WHERE id = $1
          RETURNING *
        `, [
          order.id,
          order.status,
          order.entry || null,
          order.entryAt || null,
          order.entryFee || null,
          order.quantity || null,
          order.exit || null,
          order.exitAt || null,
          order.reason || null,
          order.gross || null,
          order.fees || null,
          order.funding || null,
          order.net || null,
          order.roi || null,
          order.markPrice || null,
          order.markAt || null,
          order.unrealized || 0,
          order.liquidationPrice || null,
          order.heldBars || 0,
          order.nextTime,
          order.error || '',
          order.ambiguousBar || false,
          order.isolatedLossAdjustment || 0,
          JSON.stringify(order.plan),
          JSON.stringify(order.protectionRevisions || []),
          JSON.stringify(order.reviewHistory || [])
        ]);

        results.push(this._mapRow(result.rows[0]));
      }

      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 删除订单
   */
  static async delete(id) {
    await pool.query(`
      DELETE FROM paper_orders
      WHERE id = $1
    `, [id]);
  }

  /**
   * 检查币种是否已有活跃订单
   */
  static async hasActiveOrder(symbol) {
    const result = await pool.query(`
      SELECT EXISTS(
        SELECT 1 FROM paper_orders
        WHERE symbol = $1 AND status IN ('pending', 'open')
      ) as exists
    `, [symbol]);

    return result.rows[0].exists;
  }

  /**
   * 统计活跃订单数量
   */
  static async countActive() {
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM paper_orders
      WHERE status IN ('pending', 'open')
    `);

    return parseInt(result.rows[0].count);
  }

  /**
   * 映射数据库行到订单对象
   */
  static _mapRow(row) {
    return {
      id: row.id,
      recordId: row.record_id,
      symbol: row.symbol,
      interval: row.interval,
      direction: row.direction,
      status: row.status,
      margin: Number(row.margin),
      leverage: row.leverage,
      notional: Number(row.notional),
      entry: row.entry ? Number(row.entry) : null,
      entryAt: row.entry_at,
      entryFee: row.entry_fee ? Number(row.entry_fee) : null,
      quantity: row.quantity ? Number(row.quantity) : null,
      exit: row.exit ? Number(row.exit) : null,
      exitAt: row.exit_at,
      reason: row.reason,
      gross: row.gross ? Number(row.gross) : null,
      fees: row.fees ? Number(row.fees) : null,
      funding: row.funding ? Number(row.funding) : null,
      net: row.net ? Number(row.net) : null,
      roi: row.roi ? Number(row.roi) : null,
      markPrice: row.mark_price ? Number(row.mark_price) : null,
      markAt: row.mark_at,
      unrealized: Number(row.unrealized || 0),
      liquidationPrice: row.liquidation_price ? Number(row.liquidation_price) : null,
      heldBars: row.held_bars,
      createdAt: row.created_at,
      nextTime: row.next_time,
      expiresAt: row.expires_at,
      automatic: row.automatic,
      marketProvider: row.market_provider,
      error: row.error,
      ambiguousBar: row.ambiguous_bar,
      isolatedLossAdjustment: Number(row.isolated_loss_adjustment || 0),
      plan: row.plan,
      initialPlan: row.initial_plan,
      costs: row.costs,
      protectionRevisions: row.protection_revisions || [],
      reviewHistory: row.review_history || [],
      analysisContext: row.analysis_context
    };
  }
}

/**
 * 完整状态操作（兼容旧接口）
 */
export class PaperAccountStateDAO {
  /**
   * 读取完整状态（兼容旧的 read 方法）
   */
  static async read() {
    const [config, orders] = await Promise.all([
      PaperAccountConfigDAO.get(),
      PaperOrderDAO.getAll()
    ]);

    return {
      ...config,
      orders
    };
  }

  /**
   * 写入完整状态（兼容旧的 write 方法）
   */
  static async write(state) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 更新配置
      await client.query(`
        UPDATE paper_account_config
        SET initial_balance = $1,
            unlimited_capital = $2,
            automation = $3,
            updated_at = NOW()
        WHERE id = 1
      `, [
        state.initialBalance,
        state.unlimitedCapital,
        JSON.stringify(state.automation || {})
      ]);

      // 获取现有订单ID
      const existingResult = await client.query('SELECT id FROM paper_orders');
      const existingIds = new Set(existingResult.rows.map(r => r.id));

      // 删除不在新状态中的订单
      const newIds = new Set(state.orders.map(o => o.id));
      for (const id of existingIds) {
        if (!newIds.has(id)) {
          await client.query('DELETE FROM paper_orders WHERE id = $1', [id]);
        }
      }

      // 更新或插入订单
      for (const order of state.orders) {
        if (existingIds.has(order.id)) {
          // 更新
          await client.query(`
            UPDATE paper_orders
            SET
              status = $2, entry = $3, entry_at = $4, entry_fee = $5, quantity = $6,
              exit = $7, exit_at = $8, reason = $9, gross = $10, fees = $11,
              funding = $12, net = $13, roi = $14, mark_price = $15, mark_at = $16,
              unrealized = $17, liquidation_price = $18, held_bars = $19, next_time = $20,
              error = $21, ambiguous_bar = $22, isolated_loss_adjustment = $23,
              plan = $24, protection_revisions = $25, review_history = $26
            WHERE id = $1
          `, [
            order.id, order.status, order.entry || null, order.entryAt || null,
            order.entryFee || null, order.quantity || null, order.exit || null,
            order.exitAt || null, order.reason || null, order.gross || null,
            order.fees || null, order.funding || null, order.net || null,
            order.roi || null, order.markPrice || null, order.markAt || null,
            order.unrealized || 0, order.liquidationPrice || null, order.heldBars || 0,
            order.nextTime, order.error || '', order.ambiguousBar || false,
            order.isolatedLossAdjustment || 0, JSON.stringify(order.plan),
            JSON.stringify(order.protectionRevisions || []),
            JSON.stringify(order.reviewHistory || [])
          ]);
        } else {
          // 插入
          await client.query(`
            INSERT INTO paper_orders (
              id, record_id, symbol, interval, direction, status,
              margin, leverage, notional, entry, entry_at, entry_fee, quantity,
              exit, exit_at, reason, gross, fees, funding, net, roi,
              mark_price, mark_at, unrealized, liquidation_price, held_bars,
              created_at, next_time, expires_at, automatic, market_provider,
              error, ambiguous_bar, isolated_loss_adjustment,
              plan, initial_plan, costs, protection_revisions, review_history, analysis_context
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
              $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
              $31, $32, $33, $34, $35, $36, $37, $38, $39, $40
            )
          `, [
            order.id, order.recordId, order.symbol, order.interval, order.direction, order.status,
            order.margin, order.leverage, order.notional, order.entry || null, order.entryAt || null,
            order.entryFee || null, order.quantity || null, order.exit || null, order.exitAt || null,
            order.reason || null, order.gross || null, order.fees || null, order.funding || null,
            order.net || null, order.roi || null, order.markPrice || null, order.markAt || null,
            order.unrealized || 0, order.liquidationPrice || null, order.heldBars || 0,
            order.createdAt, order.nextTime, order.expiresAt, order.automatic, order.marketProvider || 'okx',
            order.error || '', order.ambiguousBar || false, order.isolatedLossAdjustment || 0,
            JSON.stringify(order.plan), JSON.stringify(order.initialPlan), JSON.stringify(order.costs),
            JSON.stringify(order.protectionRevisions || []), JSON.stringify(order.reviewHistory || []),
            order.analysisContext ? JSON.stringify(order.analysisContext) : null
          ]);
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
