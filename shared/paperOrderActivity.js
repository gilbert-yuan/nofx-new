const active = order => ['pending', 'open'].includes(order.status);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positionKey = row => `${row.symbol}:${row.positionSide || 'BOTH'}`;
const binding = (order, env) => order.exchangeSync?.[env] || (env === 'demo' ? order.exchange : null);
const expectedClientId = (order, env) => `${env === 'demo' ? 'nofxpaper' : 'nofxlive'}${String(order.id).replaceAll('-', '').slice(0, 20)}`;
const direction = row => row.positionSide === 'SHORT' || number(row.positionAmt) < 0 ? 'OPEN_SHORT' : 'OPEN_LONG';

/** Keep exchange observations separate from the candle-driven simulation ledger. */
export function normalizeBinanceAccount(positions, orders) {
  if (!Array.isArray(positions) || !Array.isArray(orders)) throw new Error('币安未返回完整的持仓和挂单列表。');
  for (const row of positions) {
    if (!row.symbol || !Number.isFinite(Number(row.positionAmt))) throw new Error('币安持仓数据无效，保留上次同步结果。');
  }
  for (const row of orders) {
    if (!row.symbol || row.orderId == null || !Number.isFinite(Number(row.origQty)) || !Number.isFinite(Number(row.executedQty))) {
      throw new Error('币安挂单数据无效，保留上次同步结果。');
    }
  }
  const leverageBySide = new Map(positions.map(row => [positionKey(row), number(row.leverage, 1)]));
  return {
    positions: positions.filter(row => number(row.positionAmt) !== 0).map(row => ({
      symbol: row.symbol, positionSide: row.positionSide || 'BOTH', positionAmt: number(row.positionAmt),
      entryPrice: number(row.entryPrice), markPrice: number(row.markPrice), leverage: number(row.leverage, 1),
      notional: Math.abs(number(row.notional)) || Math.abs(number(row.positionAmt) * number(row.markPrice)),
      unrealized: number(row.unRealizedProfit ?? row.unrealizedProfit), isolatedMargin: number(row.isolatedMargin),
      liquidationPrice: number(row.liquidationPrice), updateTime: number(row.updateTime)
    })),
    orders: orders.filter(row => {
      // Reduce-only orders and hedge-mode exits are protection/close orders, not entries.
      const side = String(row.side).toUpperCase(), ps = row.positionSide || 'BOTH';
      return row.reduceOnly !== true && row.reduceOnly !== 'true' && row.closePosition !== true && row.closePosition !== 'true'
        && !(ps === 'LONG' && side === 'SELL') && !(ps === 'SHORT' && side === 'BUY')
        && ['NEW', 'PARTIALLY_FILLED'].includes(String(row.status).toUpperCase());
    }).map(row => ({
      symbol: row.symbol, orderId: String(row.orderId), clientOrderId: row.clientOrderId || '',
      positionSide: row.positionSide || 'BOTH', side: String(row.side).toUpperCase(), type: row.type,
      status: String(row.status).toLowerCase(), price: number(row.price), avgPrice: number(row.avgPrice),
      origQty: number(row.origQty), executedQty: number(row.executedQty), time: number(row.time),
      updateTime: number(row.updateTime), leverage: leverageBySide.get(positionKey(row)) || 1
    }))
  };
}

export function buildPaperActivity(orders = [], accounts = {}) {
  const represented = new Set(), exchangeRows = [];
  const references = matches => matches.map(order => ({ id: order.id, status: order.status, symbol: order.symbol }));
  for (const env of ['demo', 'live']) {
    const snapshot = accounts[env];
    if (!snapshot?.enabled || !snapshot.configured || !snapshot.syncedAt) continue;
    const common = {
      source: `binance-${env}`, sourceLabel: env === 'demo' ? '币安 Demo' : '币安实盘', environment: env,
      syncedAt: snapshot.syncedAt, syncError: snapshot.error || '', stale: Boolean(snapshot.error)
    };
    for (const position of snapshot.positions || []) {
      const matches = orders.filter(order => {
        const link = binding(order, env);
        return active(order) && order.symbol === position.symbol && order.direction === direction(position)
          && link && number(link.executedQty) > 0
          && (link.positionSide || (position.positionSide === 'BOTH' ? 'BOTH' : order.direction === 'OPEN_LONG' ? 'LONG' : 'SHORT')) === position.positionSide;
      });
      matches.forEach(order => represented.add(order.id));
      exchangeRows.push({
        ...common, id: `${common.source}:position:${positionKey(position)}`, kind: 'position',
        symbol: position.symbol, direction: direction(position), positionSide: position.positionSide, status: 'open',
        entry: position.entryPrice, markPrice: position.markPrice, quantity: Math.abs(position.positionAmt),
        notional: position.notional, leverage: position.leverage,
        margin: position.isolatedMargin || position.notional / Math.max(1, position.leverage),
        unrealized: position.unrealized, liquidationPrice: position.liquidationPrice,
        createdAt: position.updateTime ? new Date(position.updateTime).toISOString() : snapshot.syncedAt,
        localOrders: references(matches)
      });
    }
    for (const remote of snapshot.orders || []) {
      const matches = orders.filter(order => {
        if (order.symbol !== remote.symbol) return false;
        const link = binding(order, env);
        return (link?.orderId != null && String(link.orderId) === remote.orderId)
          || (remote.clientOrderId && (link?.clientOrderId || expectedClientId(order, env)) === remote.clientOrderId);
      });
      matches.forEach(order => represented.add(order.id));
      const quantity = Math.max(0, remote.origQty - remote.executedQty);
      if (!quantity) continue;
      exchangeRows.push({
        ...common, ...remote, id: `${common.source}:order:${remote.symbol}:${remote.orderId}`, kind: 'entry_order',
        status: 'pending', remoteStatus: remote.status, direction: remote.side === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT',
        entry: remote.price || null, quantity, notional: quantity * remote.price,
        margin: quantity * remote.price / Math.max(1, remote.leverage),
        createdAt: remote.time ? new Date(remote.time).toISOString() : snapshot.syncedAt,
        localOrders: references(matches)
      });
    }
  }
  const localRows = orders.filter(order => active(order) && !represented.has(order.id))
    .map(order => ({ ...order, source: 'paper', sourceLabel: '本地模拟', kind: order.status === 'open' ? 'position' : 'entry_order' }));
  return [...exchangeRows, ...localRows];
}
