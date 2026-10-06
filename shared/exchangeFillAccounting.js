import { exchangeBinding } from './fusedPaperAccount.js';

const num = value => Number(value) || 0;
const key = (symbol, direction) => `${symbol}:${direction}`;
const blank = () => ({ entryQty: 0, entryNotional: 0, filledQty: 0, filledNotional: 0,
  exitQty: 0, exitNotional: 0, remainingQty: 0, realized: 0, commission: 0, funding: 0 });

/** Assign exact fills by order ID. Native/manual aggregate exits and symbol funding are split by remaining quantities. */
export function deriveExchangeMetrics({ orders, environment, fills, funding, adoptedPositions = [], startedAt }) {
  const metrics = {}, entries = new Map(), external = {};
  for (const order of orders) {
    const link = exchangeBinding(order, environment);
    if (!link?.orderId) continue;
    metrics[order.id] = { ...blank(), symbol: order.symbol, direction: order.direction };
    entries.set(`${order.symbol}:${link.orderId}`, order.id);
  }
  const startTime = Date.parse(startedAt), events = [
    ...fills.map(row => ({ ...row, kind: 'fill' })), ...funding.map(row => ({ ...row, kind: 'funding' })),
    { kind: 'adopt', time: startTime }
  ].sort((a, b) => num(a.time) - num(b.time) || (a.kind === 'adopt' ? -1 : b.kind === 'adopt' ? 1 : 0));
  const externalOf = (symbol, direction) => external[key(symbol, direction)] ||= { ...blank(), symbol, direction, openRealized: 0,
    cycleQty: 0, cycleNotional: 0, closedCycles: [] };
  const owners = (symbol, direction, ids) => Object.entries(metrics)
    .filter(([id, metric]) => metric.symbol === symbol && (!direction || metric.direction === direction)
      && metric.remainingQty > 1e-10 && (!ids || ids.includes(id)))
    .map(([id, metric]) => ({ id, metric }));
  for (const row of events) {
    const time = num(row.time);
    if (row.kind === 'adopt') {
      // Demo resets, liquidations, and expired historical records can leave a fill
      // journal without an observable final exit. The actual position snapshot is
      // authoritative for exposure; do not display those old entries as positions.
      const groups = new Map();
      for (const [id, metric] of Object.entries(metrics)) if (metric.remainingQty > 1e-10) {
        const groupKey = key(metric.symbol, metric.direction);
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey).push({ id, metric });
      }
      for (const [groupKey, group] of groups) {
        const actual = adoptedPositions.filter(position => key(position.symbol,
          num(position.positionAmt) < 0 || position.positionSide === 'SHORT' ? 'OPEN_SHORT' : 'OPEN_LONG') === groupKey)
          .reduce((sum, position) => sum + Math.abs(num(position.positionAmt)), 0);
        const known = group.reduce((sum, owner) => sum + owner.metric.remainingQty, 0);
        if (known > actual + 1e-8) for (const { metric } of group) {
          const remaining = metric.remainingQty * actual / known;
          metric.missingExitQty = metric.remainingQty - remaining;
          metric.remainingQty = remaining; metric.closedByObservation = remaining <= 1e-10;
          metric.observedClosedAt = new Date(time).toISOString();
        }
      }
      // Pre-adoption external quantities participate in historical allocation, but
      // their old cash flows are outside the pool. Rebase them to the actual snapshot.
      for (const metric of Object.values(external)) Object.assign(metric, { ...blank(), openRealized: 0, cycleQty: 0, cycleNotional: 0 });
      for (const position of adoptedPositions) {
        const direction = num(position.positionAmt) < 0 || position.positionSide === 'SHORT' ? 'OPEN_SHORT' : 'OPEN_LONG';
        const known = owners(position.symbol, direction).reduce((sum, owner) => sum + owner.metric.remainingQty, 0);
        const remainingQty = Math.max(0, Math.abs(num(position.positionAmt)) - known);
        if (!remainingQty) continue;
        const metric = externalOf(position.symbol, direction);
        metric.entryQty += remainingQty;
        metric.entryNotional += remainingQty * num(position.entryPrice);
        metric.remainingQty += remainingQty;
        metric.cycleQty += remainingQty; metric.cycleNotional += remainingQty * num(position.entryPrice);
        metric.entryAt = new Date(time).toISOString(); metric.leverage = num(position.leverage) || 1;
      }
      continue;
    }
    if (row.kind === 'funding') {
      if (row.asset !== 'USDT' && num(row.income) !== 0) throw new Error('资金费包含非 USDT 资产，无法计入统一资金池。');
      const allocation = owners(row.symbol);
      for (const metric of Object.values(external)) if (metric.symbol === row.symbol && metric.remainingQty > 0) allocation.push({ metric, external: true });
      const quantity = allocation.reduce((sum, owner) => sum + owner.metric.remainingQty, 0);
      for (const owner of allocation) {
        if (owner.external && time < startTime) continue;
        const amount = quantity > 0 ? num(row.income) * owner.metric.remainingQty / quantity : 0;
        owner.metric.realized += amount; owner.metric.funding += amount;
        if (owner.external) owner.metric.openRealized += amount;
      }
      continue;
    }
    if (![row.price, row.quantity, row.realizedPnl, row.commission].every(value => Number.isFinite(Number(value)))) throw new Error('成交金额或收益数据无效。');
    if (row.commissionAsset !== 'USDT' && num(row.commission) !== 0) throw new Error('手续费包含非 USDT 资产，无法计入统一资金池。');
    const fee = num(row.commission), quantity = num(row.quantity), gross = num(row.realizedPnl), price = num(row.price);
    const entryId = entries.get(`${row.symbol}:${row.orderId}`);
    const entryMetric = entryId ? metrics[entryId] : null;
    if (entryMetric) {
      if (row.side !== (entryMetric.direction === 'OPEN_LONG' ? 'BUY' : 'SELL')) throw new Error('历史入口订单方向与币安成交不一致，需重新核对绑定。');
      entryMetric.filledQty += quantity; entryMetric.filledNotional += quantity * price;
      entryMetric.entryAt ||= new Date(time).toISOString();
    }
    const closingDirection = row.side === 'SELL' ? 'OPEN_LONG' : 'OPEN_SHORT';
    const canClose = !row.positionSide || row.positionSide === 'BOTH'
      || (row.positionSide === 'LONG' && row.side === 'SELL') || (row.positionSide === 'SHORT' && row.side === 'BUY');
    // Futures positions are aggregated by symbol/side. Older close orders may have
    // flattened several entries while being attached to only one local order.
    // Split the exchange's exact total by the quantities held at that instant.
    let allocation = canClose ? owners(row.symbol, closingDirection) : [];
    const ext = externalOf(row.symbol, closingDirection);
    if (canClose && ext.remainingQty > 0) allocation.push({ metric: ext, external: true });
    const available = allocation.reduce((sum, owner) => sum + owner.metric.remainingQty, 0);
    const closingQty = Math.min(quantity, available);
    if (closingQty > 0) for (const owner of allocation) {
      const qty = closingQty * owner.metric.remainingQty / available;
      const ratio = quantity > 0 ? qty / quantity : 0;
      const income = gross * qty / closingQty - fee * ratio;
      owner.metric.remainingQty = Math.max(0, owner.metric.remainingQty - qty);
      owner.metric.exitQty += qty; owner.metric.exitNotional += qty * price;
      if (!owner.external || time >= startTime) { owner.metric.realized += income; owner.metric.commission += fee * ratio; }
      owner.metric.allocationMethod = 'remaining_quantity';
      owner.metric.exitAt = new Date(time).toISOString();
      if (owner.external) {
        if (time < startTime) continue;
        owner.metric.openRealized += income;
        if (owner.metric.remainingQty <= 1e-10) {
          owner.metric.closedCycles.push({ entryQty: owner.metric.cycleQty, entryNotional: owner.metric.cycleNotional,
            entryAt: owner.metric.entryAt, exitAt: owner.metric.exitAt, realized: owner.metric.openRealized,
            leverage: owner.metric.leverage || 1 });
          owner.metric.cycleQty = 0; owner.metric.cycleNotional = 0; owner.metric.openRealized = 0;
        }
      }
    }
    const openingQty = Math.max(0, quantity - closingQty);
    if (openingQty > 1e-10) {
      const direction = row.positionSide === 'SHORT' || (row.positionSide === 'BOTH' && row.side === 'SELL') ? 'OPEN_SHORT' : 'OPEN_LONG';
      const metric = entryMetric || externalOf(row.symbol, direction);
      // Nonzero realized P&L with no known opposing quantity means an older
      // position was reduced before our journal starts. Keep its observed cash
      // flow without inventing a new position for a known strategy entry.
      if (entryMetric && canClose && closingQty === 0 && gross !== 0) {
        entryMetric.realized += gross - fee; entryMetric.commission += fee;
        entryMetric.offsetEntry = true; entryMetric.exitAt = new Date(time).toISOString();
        continue;
      }
      if (metric.remainingQty < 1e-10) { metric.openRealized = 0; metric.entryAt = new Date(time).toISOString(); }
      metric.remainingQty += openingQty; metric.entryQty += openingQty; metric.entryNotional += openingQty * price;
      if (!entryMetric) { metric.cycleQty += openingQty; metric.cycleNotional += openingQty * price; }
      if (!entryMetric && time < startTime) continue;
      const amount = (closingQty === 0 ? gross : 0) - fee * openingQty / quantity;
      metric.realized += amount; metric.commission += fee * openingQty / quantity;
      if (!entryMetric) metric.openRealized += amount;
    } else if (entryMetric) {
      entryMetric.offsetEntry = true; entryMetric.exitAt = new Date(time).toISOString();
    }
  }
  return { orderMetrics: metrics, externalMetrics: external };
}
