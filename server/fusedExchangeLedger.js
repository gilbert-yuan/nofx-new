import { deriveExchangeMetrics } from '../shared/exchangeFillAccounting.js';
import { exchangeBinding } from '../shared/fusedPaperAccount.js';

/** Persistent fill journal, isolated by exchange environment and API-key fingerprint. It never imports wallet balances. */
export class FusedExchangeLedger {
  constructor({ simulation, pool }) { Object.assign(this, { simulation, pool }); this.cache = new Map(); }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS simulation_exchange_fills (
        environment TEXT NOT NULL, account_key TEXT NOT NULL, symbol TEXT NOT NULL, trade_id TEXT NOT NULL,
        order_id TEXT NOT NULL, trade_time BIGINT NOT NULL, side TEXT NOT NULL, position_side TEXT NOT NULL,
        price DOUBLE PRECISION NOT NULL, quantity DOUBLE PRECISION NOT NULL,
        realized_pnl DOUBLE PRECISION NOT NULL, commission DOUBLE PRECISION NOT NULL, commission_asset TEXT NOT NULL,
        PRIMARY KEY(environment, account_key, symbol, trade_id)
      );
      CREATE TABLE IF NOT EXISTS simulation_exchange_funding (
        environment TEXT NOT NULL, account_key TEXT NOT NULL, flow_id TEXT NOT NULL, symbol TEXT NOT NULL,
        flow_time BIGINT NOT NULL, income DOUBLE PRECISION NOT NULL, asset TEXT NOT NULL,
        PRIMARY KEY(environment, account_key, flow_id)
      );
      CREATE TABLE IF NOT EXISTS simulation_exchange_cursors (
        environment TEXT NOT NULL, account_key TEXT NOT NULL, symbol TEXT NOT NULL, synced_until BIGINT NOT NULL,
        PRIMARY KEY(environment, account_key, symbol)
      );
    `);
  }
  async tradeWindow(client, symbol, startTime, endTime, depth = 0) {
    const rows = await client.userTrades({ symbol, startTime, endTime, limit: 1000 });
    if (!Array.isArray(rows)) throw new Error('币安未返回完整成交记录。');
    if (rows.length < 1000) return rows;
    if (endTime <= startTime || depth >= 30) throw new Error('同一时间的成交记录超过查询上限，未发布不完整收益。');
    const middle = Math.floor((startTime + endTime) / 2);
    return [...await this.tradeWindow(client, symbol, startTime, middle, depth + 1), ...await this.tradeWindow(client, symbol, middle + 1, endTime, depth + 1)];
  }
  async cursor(environment, accountKey, symbol, firstTime) {
    const result = await this.pool.query('SELECT synced_until FROM simulation_exchange_cursors WHERE environment=$1 AND account_key=$2 AND symbol=$3', [environment, accountKey, symbol]);
    return result.rows[0] ? Math.max(firstTime, Number(result.rows[0].synced_until) - 60000) : firstTime;
  }
  async saveCursor(environment, accountKey, symbol, endTime) {
    await this.pool.query(`INSERT INTO simulation_exchange_cursors VALUES($1,$2,$3,$4)
      ON CONFLICT(environment,account_key,symbol) DO UPDATE SET synced_until=EXCLUDED.synced_until`, [environment, accountKey, symbol, endTime]);
  }
  async journalMetrics({ state, environment, accountKey, adoptedPositions, adoptedAt, activity }) {
    const [fills, funding] = await Promise.all([
      this.pool.query(`SELECT symbol,trade_id AS id,order_id AS "orderId",trade_time AS time,side,position_side AS "positionSide",price,quantity,
        realized_pnl AS "realizedPnl",commission,commission_asset AS "commissionAsset" FROM simulation_exchange_fills WHERE environment=$1 AND account_key=$2 ORDER BY trade_time,trade_id`, [environment, accountKey]),
      this.pool.query('SELECT symbol,flow_time AS time,income,asset FROM simulation_exchange_funding WHERE environment=$1 AND account_key=$2 ORDER BY flow_time', [environment, accountKey])
    ]);
    const metrics = deriveExchangeMetrics({ orders: state.orders, environment, fills: fills.rows, funding: funding.rows, adoptedPositions, startedAt: adoptedAt });
    for (const position of activity.positions) {
      const direction = Number(position.positionAmt) < 0 || position.positionSide === 'SHORT' ? 'OPEN_SHORT' : 'OPEN_LONG';
      const external = metrics.externalMetrics[`${position.symbol}:${direction}`];
      if (external) external.leverage = position.leverage;
    }
    metrics.observedOrderIds = [...new Set(fills.rows.map(row => String(row.orderId)))];
    metrics.metricsVersion = 2;
    return metrics;
  }
  async rebuildStoredMetrics() {
    const [state, linked] = await Promise.all([this.simulation.readLight(), this.simulation.exchangeSyncOrders()]);
    const links = new Map(linked.orders.map(order => [order.id, order]));
    state.orders = state.orders.map(order => ({ ...order, exchangeSync: links.get(order.id)?.exchangeSync || order.exchangeSync,
      exchange: links.get(order.id)?.exchange || order.exchange }));
    for (const environment of ['live', 'demo']) {
      const snapshot = state.exchangeAccounts?.[environment];
      if (!snapshot?.accountKey || !snapshot.adoptedAt || !snapshot.metricsSyncedAt) continue;
      try {
        const metrics = await this.journalMetrics({ state, environment, accountKey: snapshot.accountKey,
          adoptedPositions: snapshot.adoptedPositions || [], adoptedAt: snapshot.adoptedAt, activity: snapshot });
        await this.simulation.mutateLight(current => {
          if (current.exchangeAccounts?.[environment]?.accountKey === snapshot.accountKey) Object.assign(current.exchangeAccounts[environment], metrics);
        });
      } catch (error) {
        await this.simulation.mutateLight(current => { current.exchangeAccounts[environment].metricsError = String(error.message).slice(0, 300); });
      }
    }
  }
  async refresh({ client, environment, accountKey, activity, state, force = false }) {
    const cacheKey = `${environment}:${accountKey}`, now = Date.now(), cached = this.cache.get(cacheKey);
    const bindingVersion = JSON.stringify((state.orders || []).map(order => {
      const link = exchangeBinding(order, environment);
      return [order.id, link?.orderId, link?.executedQty, (link?.closeOrders || []).map(close => close.orderId), link?.emergencyClose?.orderId];
    }));
    if (!force && cached?.bindingVersion === bindingVersion && now - cached.at < 30000) return { ...cached.metrics, metricsSyncedAt: cached.syncedAt, metricsError: '' };
    const orders = state.orders || [], startedAt = state.fusedPoolStartedAt;
    const snapshot = state.exchangeAccounts?.[environment];
    const adoptedPositions = snapshot?.accountKey === accountKey && snapshot.adoptedPositions ? snapshot.adoptedPositions : activity.positions;
    const adoptedAt = snapshot?.accountKey === accountKey && snapshot.adoptedAt ? snapshot.adoptedAt : new Date(now).toISOString();
    const bound = orders.filter(order => exchangeBinding(order, environment)?.orderId);
    const bootstrap = !snapshot?.metricsSyncedAt || snapshot.accountKey !== accountKey;
    const changing = bound.filter(order => ['pending', 'open'].includes(order.status)
      || snapshot?.orderMetrics?.[order.id]?.remainingQty > 1e-10
      || !snapshot?.orderMetrics?.[order.id]
      || Date.now() - Date.parse(order.exitAt || '') < 120000);
    const symbols = [...new Set([...activity.positions.map(row => row.symbol), ...activity.orders.map(row => row.symbol),
      ...(force || bootstrap ? bound : changing).map(row => row.symbol),
      ...Object.values(snapshot?.externalMetrics || {}).filter(row => row.remainingQty > 1e-10).map(row => row.symbol)])];
    try {
      let index = 0;
      const fetched = await Promise.allSettled(Array.from({ length: Math.min(4, symbols.length) }, async () => {
        while (index < symbols.length) {
          const symbol = symbols[index++];
          const firstTime = Math.max(now - 89 * 86400000, Math.min(Date.parse(startedAt), ...bound.filter(order => order.symbol === symbol).map(order => Date.parse(order.createdAt)).filter(Number.isFinite)));
          let start = await this.cursor(environment, accountKey, symbol, firstTime);
          while (start <= now) {
            const end = Math.min(now, start + 7 * 86400000 - 1), rows = await this.tradeWindow(client, symbol, start, end);
            const values = rows.map(row => ({ symbol: row.symbol || symbol, trade_id: String(row.id), order_id: String(row.orderId),
              trade_time: Number(row.time), side: row.side, position_side: row.positionSide || 'BOTH', price: Number(row.price),
              quantity: Number(row.qty), realized_pnl: Number(row.realizedPnl || 0), commission: Number(row.commission || 0), commission_asset: row.commissionAsset || '' }));
            if (values.some(row => !['BUY', 'SELL'].includes(row.side) || ['undefined', 'null'].includes(row.trade_id)
              || ['undefined', 'null'].includes(row.order_id) || !Number.isFinite(row.trade_time)
              || ![row.price,row.quantity,row.realized_pnl,row.commission].every(Number.isFinite) || row.quantity <= 0 || row.price <= 0)) throw new Error('成交记录缺少数量、时间或收益。');
            if (values.length) await this.pool.query(`INSERT INTO simulation_exchange_fills
              SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(symbol text,trade_id text,order_id text,trade_time bigint,side text,position_side text,price float8,quantity float8,realized_pnl float8,commission float8,commission_asset text)
              ON CONFLICT(environment,account_key,symbol,trade_id) DO NOTHING`, [environment, accountKey, JSON.stringify(values)]);
            await this.saveCursor(environment, accountKey, symbol, end); start = end + 1;
          }
        }
      }));
      const failed = fetched.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const earliest = Math.max(now - 89 * 86400000, Math.min(Date.parse(startedAt), ...bound.map(order => Date.parse(order.createdAt)).filter(Number.isFinite)));
      const startTime = await this.cursor(environment, accountKey, '__funding', earliest);
      let complete = false;
      for (let page = 1; page <= 20; page++) {
        const rows = await client.incomeHistory({ incomeType: 'FUNDING_FEE', startTime, endTime: now, page, limit: 1000 });
        if (!Array.isArray(rows)) throw new Error('币安资金费流水不完整。');
        const values = rows.filter(row => row.incomeType === 'FUNDING_FEE').map(row => ({ flow_id: String(row.tranId), symbol: row.symbol, flow_time: Number(row.time), income: Number(row.income), asset: row.asset }));
        if (values.some(row => !row.symbol || !Number.isFinite(row.flow_time) || !Number.isFinite(row.income))) throw new Error('资金费流水金额或时间无效。');
        if (values.length) await this.pool.query(`INSERT INTO simulation_exchange_funding
          SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) AS x(flow_id text,symbol text,flow_time bigint,income float8,asset text)
          ON CONFLICT(environment,account_key,flow_id) DO NOTHING`, [environment, accountKey, JSON.stringify(values)]);
        if (rows.length < 1000) { complete = true; break; }
      }
      if (!complete) throw new Error('资金费流水超过查询上限，保留上次收益。');
      await this.saveCursor(environment, accountKey, '__funding', now);
      const metrics = await this.journalMetrics({ state, environment, accountKey, adoptedPositions, adoptedAt, activity });
      // Used to release direct-order reservations only after the corresponding fill
      // or open order is visible, avoiding temporary double spending during API lag.
      const syncedAt = new Date(now).toISOString();
      this.cache.set(cacheKey, { at: now, metrics, syncedAt, bindingVersion });
      return { ...metrics, metricsSyncedAt: syncedAt, metricsError: '', adoptedPositions, adoptedAt };
    } catch (error) {
      this.cache.delete(cacheKey);
      return { metricsError: String(error.message || error).slice(0, 300), adoptedPositions, adoptedAt };
    }
  }
}
