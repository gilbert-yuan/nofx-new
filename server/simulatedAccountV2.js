/**
 * SimulatedAccount 类的新实现
 * 使用 paper_orders 和 paper_account_config 表
 */

import { PaperAccountConfigDAO, PaperOrderDAO, PaperAccountStateDAO } from './paperTradingDAO.js';
import { accountSummary, submitPaperOrder, advancePaperOrder } from './simulatedAccount.js';
import { candleOpenAt } from './research.js';

const active = order => ['pending', 'open'].includes(order.status);

export class SimulatedAccountV2 {
  constructor({ pool, market, archive, marketDb }) {
    Object.assign(this, { pool, market, archive, marketDb, busy: false, lastError: '', lastRunAt: null });
  }

  async init() {
    // 表已经在迁移脚本中创建，这里确保配置存在
    try {
      await PaperAccountConfigDAO.get();
    } catch (error) {
      console.error('初始化账户配置失败:', error);
    }
  }

  /**
   * 读取完整状态（兼容旧接口）
   */
  async read() {
    return await PaperAccountStateDAO.read();
  }

  /**
   * 原子性更新状态
   */
  async mutate(fn) {
    // 读取当前状态
    const state = await this.read();

    // 执行修改函数
    const result = fn(state);

    // 写回数据库
    await PaperAccountStateDAO.write(state);

    return result;
  }

  /**
   * 获取账户状态
   */
  async status() {
    const state = await this.read();
    return {
      ...accountSummary(state),
      automation: state.automation,
      orders: state.orders,
      busy: this.busy,
      lastRunAt: this.lastRunAt,
      error: this.lastError
    };
  }

  /**
   * 提交新订单
   */
  async submit(input) {
    const record = await this.archive.get(String(input.recordId || ''));
    return this.mutate(state => submitPaperOrder(state, record, input));
  }

  /**
   * 刷新所有活跃订单
   */
  async refresh() {
    if (this.busy) return this.status();
    this.busy = true;

    try {
      const state = await this.read();
      const now = Date.now();
      const updates = [];
      const cache = new Map();

      for (const order of state.orders.filter(active).sort((a, b) => a.nextTime - b.nextTime)) {
        try {
          const end = candleOpenAt(now, order.interval);
          const key = `${order.symbol}:${order.interval}`;

          if (!cache.has(key)) {
            const rows = order.nextTime >= end ? [] : this.marketDb && order.interval === '1m'
              ? await this.archive.candles(order.symbol, order.interval, order.nextTime, end, order.marketProvider)
              : await this.market.klines({ symbol: order.symbol, interval: order.interval, startTime: order.nextTime, endTime: end - 1, limit: 200 });
            cache.set(key, rows);
          }

          const rows = cache.get(key);
          updates.push({ id: order.id, cursor: order.nextTime, rows });
        } catch (error) {
          updates.push({ id: order.id, cursor: order.nextTime, error: error.message });
        }
      }

      await this.mutate(current => {
        for (const update of updates) {
          const order = current.orders.find(o => o.id === update.id);
          if (!order || !active(order) || order.nextTime !== update.cursor) continue;
          if (update.error) order.error = update.error;
          else advancePaperOrder(order, update.rows, now);
        }
      });

      this.lastRunAt = new Date().toISOString();
      this.lastError = '';
    } catch (error) {
      this.lastError = error.message;
      console.error('刷新订单失败:', error);
    } finally {
      this.busy = false;
    }

    return this.status();
  }

  /**
   * 更新订单
   */
  async updateOrder(orderId, updates) {
    return this.mutate(state => {
      const order = state.orders.find(o => o.id === orderId);
      if (!order) throw new Error('订单不存在');
      Object.assign(order, updates);
      return order;
    });
  }

  /**
   * 取消订单
   */
  async cancelOrder(orderId) {
    return this.mutate(state => {
      const order = state.orders.find(o => o.id === orderId);
      if (!order) throw new Error('订单不存在');
      if (!active(order)) throw new Error('只能取消待入场或持仓中的订单');
      order.status = 'cancelled';
      return order;
    });
  }

  /**
   * 重置账户
   */
  async reset() {
    const config = await PaperAccountConfigDAO.get();

    // 删除所有订单
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM paper_orders');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return this.status();
  }

  /**
   * 更新配置
   */
  async updateConfig(updates) {
    const config = await PaperAccountConfigDAO.get();
    const newConfig = { ...config, ...updates };
    await PaperAccountConfigDAO.update(newConfig);
    return this.status();
  }

  /**
   * 获取订单详情
   */
  async getOrder(orderId) {
    const order = await PaperOrderDAO.getById(orderId);
    if (!order) throw new Error('订单不存在');
    return order;
  }

  /**
   * 获取所有订单
   */
  async getOrders() {
    return await PaperOrderDAO.getAll();
  }

  /**
   * 获取活跃订单
   */
  async getActiveOrders() {
    return await PaperOrderDAO.getActive();
  }

  /**
   * 获取已平仓订单
   */
  async getClosedOrders(limit = 100) {
    return await PaperOrderDAO.getClosed(limit);
  }

  /**
   * 按币种获取订单
   */
  async getOrdersBySymbol(symbol) {
    return await PaperOrderDAO.getBySymbol(symbol);
  }
}
