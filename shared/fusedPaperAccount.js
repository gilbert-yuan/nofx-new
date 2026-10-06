import { buildPaperActivity } from './paperOrderActivity.js';

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const active = order => ['pending', 'open'].includes(order.status);
export const exchangeBinding = (order, env) => order.exchangeSync?.[env] || (env === 'demo' ? order.exchange : null);
const sideKey = row => `${row.symbol}:${row.direction}`;
const priority = source => source === 'binance-live' ? 3 : source === 'binance-demo' ? 2 : 1;
const share = order => num(order.realizedQty) > 0 ? num(order.quantity) / Math.max(1e-12, num(order.quantity) + num(order.realizedQty)) : 1;

export function preferredOrderMetrics(order, accounts = {}) {
  for (const env of ['live', 'demo']) {
    const snapshot = accounts[env], metric = snapshot?.orderMetrics?.[order.id];
    if (snapshot?.enabled && snapshot.configured && (metric?.filledQty > 0 || metric?.entryQty > 0)) return { ...metric, environment: env, source: `binance-${env}` };
  }
  return null;
}

/** Reconcile terminal execution back into the strategy ledger, including late fills
 * on cancelled entries. This also keeps automation's active counts consistent. */
export function reconcileFusedLocalOrders(state) {
  const accounts = state.exchangeAccounts || {};
  for (const order of state.orders || []) {
    const metric = preferredOrderMetrics(order, accounts);
    if (!metric || !(metric.filledQty > 0) || !Number.isFinite(metric.filledNotional)
      || metric.remainingQty > 1e-10 || !(metric.exitQty > 0 || metric.offsetEntry || metric.closedByObservation)) continue;
    const hasPending = Object.entries(accounts).some(([env, snapshot]) => snapshot?.enabled && snapshot.orders?.some(remote =>
      order.symbol === remote.symbol && (String(exchangeBinding(order, env)?.orderId) === String(remote.orderId))));
    if (hasPending) continue;
    const leverage = num(exchangeBinding(order, metric.environment)?.actualLeverage) || num(order.leverage) || 1;
    Object.assign(order, { status: 'closed', reason: ['cancelled', 'expired'].includes(order.status) ? 'manual' : order.reason || 'manual',
      net: metric.realized, fees: metric.commission, funding: metric.funding,
      gross: metric.realized + metric.commission - metric.funding,
      exitAt: metric.exitAt || order.exitAt || metric.observedClosedAt,
      entry: metric.filledQty > 0 ? metric.filledNotional / metric.filledQty : order.entry,
      margin: metric.filledNotional / leverage, notional: metric.filledNotional,
      roi: metric.filledNotional > 0 ? metric.realized / (metric.filledNotional / leverage) : null,
      ...(metric.missingExitQty > 1e-8 ? {} : metric.exitQty > 0 ? { exit: metric.exitNotional / metric.exitQty } : {}) });
  }
}

/** A merged row retains every execution target, while money and profit use only the highest priority observation. */
export function fusedPaperOrders(state) {
  const accounts = state.exchangeAccounts || {}, orders = state.orders || [];
  const observed = buildPaperActivity(orders, accounts).filter(row => row.source !== 'paper');
  const groups = new Map(), represented = new Set();
  for (const row of observed) {
    const extra = row.status === 'open' ? orders.filter(order => {
      const metric = accounts[row.environment]?.orderMetrics?.[order.id];
      return order.symbol === row.symbol && order.direction === row.direction && metric?.remainingQty > 1e-10;
    }).map(order => ({ id: order.id, status: order.status, symbol: order.symbol })) : [];
    const refs = [...new Map([...(row.localOrders || []), ...extra].map(ref => [ref.id, ref])).values()];
    const groupKey = row.status === 'open' ? `position:${sideKey(row)}`
      : refs.length ? `entry:${refs.map(ref => ref.id).sort().join(',')}` : `entry:${row.environment}:${row.symbol}:${row.orderId}`;
    const target = { environment: row.environment, symbol: row.symbol, positionSide: row.positionSide || 'BOTH',
      kind: row.kind, orderId: row.orderId, clientOrderId: row.clientOrderId, quantity: row.quantity,
      direction: row.direction, updateTime: row.updateTime, entry: row.entry, markPrice: row.markPrice, localOrders: refs };
    const previous = groups.get(groupKey);
    const selected = !previous || priority(row.source) > priority(previous.source) ? row : previous;
    const localOrders = [...new Map([...(previous?.localOrders || []), ...refs].map(ref => [ref.id, ref])).values()];
    localOrders.forEach(ref => represented.add(ref.id));
    const buyAmount = num(selected.quantity) * num(selected.entry);
    const realized = localOrders.reduce((sum, ref) => sum + num(accounts[selected.environment]?.orderMetrics?.[ref.id]?.realized), 0);
    const external = accounts[selected.environment]?.externalMetrics?.[sideKey(selected)];
    groups.set(groupKey, { ...selected, id: `fused:${groupKey}`, localOrders,
      executionTargets: [...(previous?.executionTargets || []), target],
      buyAmount, margin: buyAmount / Math.max(1, num(selected.leverage)),
      realized: realized + num(external?.openRealized), net: realized + num(external?.openRealized) + num(selected.unrealized),
      roi: buyAmount > 0 ? (realized + num(external?.openRealized) + num(selected.unrealized)) / (buyAmount / Math.max(1, num(selected.leverage))) : null,
      strategyNames: localOrders.map(ref => orders.find(order => order.id === ref.id)?.strategyId || orders.find(order => order.id === ref.id)?.analysisContext?.strategyName).filter(Boolean) });
  }
  const closedOrders = [], localRows = [];
  for (const order of orders) {
    const metric = preferredOrderMetrics(order, accounts);
    const remoteClosed = metric && metric.remainingQty <= 1e-10 && (metric.exitQty > 0 || metric.offsetEntry || metric.closedByObservation);
    if (remoteClosed || (order.status === 'closed' && !metric)) {
      const net = metric ? metric.realized : num(order.net);
      const buyAmount = metric?.filledNotional ?? metric?.entryNotional ?? (num(order.notional) || num(order.quantity) * num(order.entry));
      const leverage = metric ? num(exchangeBinding(order, metric.environment)?.actualLeverage) || num(order.leverage) : num(order.leverage);
      const margin = buyAmount / Math.max(1, leverage);
      closedOrders.push({ ...order, status: remoteClosed ? 'closed' : order.status,
        source: metric?.source || 'paper', sourceLabel: metric ? metric.environment === 'live' ? '币安实盘' : '币安模拟盘' : '本地策略',
        entry: metric?.filledQty > 0 ? metric.filledNotional / metric.filledQty : order.entry,
        exit: metric?.missingExitQty > 0 ? null : metric?.exitQty > 0 ? metric.exitNotional / metric.exitQty : order.exit,
        entryAt: metric?.entryAt || order.entryAt, fees: metric?.commission ?? order.fees, funding: metric?.funding ?? order.funding,
        gross: metric ? metric.realized + metric.commission - metric.funding : order.gross,
        allocationMethod: metric?.allocationMethod,
        accountingIncomplete: num(metric?.missingExitQty) > 1e-8,
        buyAmount, margin, leverage,
        net, realized: net, roi: margin > 0 ? net / margin : null,
        exitAt: metric?.exitAt || order.exitAt || metric?.observedClosedAt, reason: order.reason || (remoteClosed ? 'manual' : '') });
    } else if (!represented.has(order.id) && metric?.remainingQty > 1e-10) {
      // Position and fill endpoints can become visible at different times. Reserve the
      // known remaining exposure until both observations agree; never free it early.
      const entry = metric.entryNotional / metric.entryQty, buyAmount = metric.remainingQty * entry;
      localRows.push({ ...order, id: `reconciling:${order.id}`, status: 'open', kind: 'position', source: metric.source,
        sourceLabel: metric.environment === 'live' ? '币安实盘' : '币安模拟盘', environment: metric.environment,
        quantity: metric.remainingQty, entry, buyAmount, margin: buyAmount / Math.max(1, num(order.leverage)),
        unrealized: 0, realized: metric.realized, net: metric.realized, stale: true, reconciliationPending: true,
        executionTargets: [{ environment: metric.environment, symbol: order.symbol, positionSide: 'BOTH',
          kind: 'position', direction: order.direction, localOrders: [{ id: order.id, status: order.status }] }],
        localOrders: [{ id: order.id, status: order.status }] });
    } else if (active(order) && !represented.has(order.id)) {
      const remainingShare = order.status === 'open' ? share(order) : 1;
      const buyAmount = num(order.notional) * remainingShare;
      localRows.push({ ...order, source: 'paper', sourceLabel: '本地策略',
        kind: order.status === 'open' ? 'position' : 'entry_order', buyAmount,
        margin: num(order.margin) * remainingShare,
        net: order.status === 'open' ? num(order.realizedNet) - num(order.entryFee) * remainingShare + num(order.unrealized) : 0,
        executionTargets: [], localOrders: [{ id: order.id, status: order.status, symbol: order.symbol }] });
    }
  }
  const externalHistory = new Set();
  for (const env of ['live', 'demo']) {
    const snapshot = accounts[env];
    if (!snapshot?.enabled || !snapshot.configured) continue;
    for (const [key, metric] of Object.entries(snapshot.externalMetrics || {})) {
      if (externalHistory.has(key)) continue;
      externalHistory.add(key);
      for (const cycle of metric.closedCycles || []) {
        const leverage = num(cycle.leverage) || 1, margin = cycle.entryNotional / leverage;
        closedOrders.push({ ...cycle, id: `external:${env}:${key}:${cycle.exitAt}`, symbol: metric.symbol,
          direction: metric.direction, source: `binance-${env}`, sourceLabel: env === 'live' ? '币安实盘' : '币安模拟盘',
          status: 'closed', kind: 'external_closed', entry: cycle.entryNotional / cycle.entryQty,
          buyAmount: cycle.entryNotional, margin, leverage, net: cycle.realized, roi: margin > 0 ? cycle.realized / margin : null,
          reason: 'manual', createdAt: cycle.entryAt, entryAt: cycle.entryAt });
      }
    }
  }
  return { activeOrders: [...groups.values(), ...localRows], closedOrders };
}

export function fusedAccountSummary(state, activity = fusedPaperOrders(state)) {
  const accounts = state.exchangeAccounts || {}, orders = state.orders || [];
  let realized = 0, entryFees = 0;
  const warnings = new Set();
  let syncReady = true;
  for (const order of orders) {
    const metric = preferredOrderMetrics(order, accounts);
    if (metric) realized += num(metric.realized);
    else if (order.status === 'closed') realized += num(order.net);
    else if (order.status === 'open') {
      const fee = num(order.entryFee) * share(order);
      realized += num(order.realizedNet) - fee;
      entryFees += fee;
    }
  }
  const external = new Map();
  for (const env of ['live', 'demo']) {
    const snapshot = accounts[env];
    if (!snapshot?.enabled) continue;
    if (!snapshot.configured) { syncReady = false; warnings.add('已启用的币安执行环境缺少凭证，暂不新增订单。'); continue; }
    if (snapshot.error || snapshot.metricsError) warnings.add(`${env === 'live' ? '实盘' : '模拟盘'}：${snapshot.error || snapshot.metricsError}`);
    if (!snapshot.metricsSyncedAt) warnings.add(`${env === 'live' ? '实盘' : '模拟盘'}成交收益正在同步，暂不新增订单。`);
    else if (Date.now() - Date.parse(snapshot.metricsSyncedAt) > 120000) warnings.add('成交收益同步已超过两分钟，暂不新增订单。');
    if (snapshot.error || snapshot.metricsError || !snapshot.metricsSyncedAt
      || !Number.isFinite(Date.parse(snapshot.metricsSyncedAt)) || Date.now() - Date.parse(snapshot.metricsSyncedAt) > 120000
      || !snapshot.syncedAt || Date.now() - Date.parse(snapshot.syncedAt) > 120000) syncReady = false;
    for (const [key, metric] of Object.entries(snapshot.externalMetrics || {})) if (!external.has(key)) external.set(key, metric);
  }
  realized += [...external.values()].reduce((sum, metric) => sum + num(metric.realized), 0);
  const open = activity.activeOrders.filter(row => row.status === 'open'), pending = activity.activeOrders.filter(row => row.status === 'pending');
  const unrealized = open.reduce((sum, row) => sum + num(row.unrealized), 0);
  const usedMargin = activity.activeOrders.reduce((sum, row) => sum + num(row.margin), 0);
  // Reserve both pending entry fees and eventual closing fees for open positions.
  const feeReserve = activity.activeOrders.reduce((sum, row) => sum + num(row.buyAmount) * num(row.costs?.feeBps ?? 6)
    * (row.status === 'pending' ? 2 : 1) / 10000, 0);
  const reservationMargin = Object.values(state.capitalReservations || {}).filter(row => ['submitting', 'submitted', 'unknown'].includes(row.status))
    .reduce((sum, row) => sum + num(row.margin) + num(row.feeReserve), 0);
  const net = realized + unrealized, initialBalance = num(state.initialBalance), equity = initialBalance + net;
  const committed = usedMargin + feeReserve + reservationMargin, available = equity - committed;
  if (equity <= 0) warnings.add('总权益不为正，资金池不足，不能新增订单。');
  else if (committed > equity + 1e-8) warnings.add('已有持仓与挂单占用超过当前权益，新增订单已暂停。');
  if (activity.activeOrders.some(row => row.reconciliationPending)) { syncReady = false; warnings.add('持仓与成交记录正在对账，保留保证金占用并暂停新增订单。'); }
  if (orders.some(order => ['live', 'demo'].some(env => accounts[env]?.enabled && num(exchangeBinding(order, env)?.executedQty) > 0
    && !(accounts[env]?.orderMetrics?.[order.id]?.filledQty > 0)))) {
    syncReady = false; warnings.add('已成交订单的成交明细尚未完整同步，暂停新增订单。');
  }
  if (state.entriesPaused) warnings.add('已暂停新增订单，可在完成平仓后恢复开仓。');
  const incompleteHistory = activity.closedOrders.filter(order => order.accountingIncomplete).length;
  if (incompleteHistory) warnings.add(`${incompleteHistory} 笔存量订单已按实际持仓确认结束，但历史平仓明细不完整，收益暂为已取得成交记录的净额。`);
  return { fused: true, unlimitedCapital: false, unit: 'USDT', initialBalance, realized, unrealized, net,
    balance: initialBalance + realized, equity, available, usedMargin, entryFees, feeReserve, reservationMargin, committed,
    totalBuyAmount: activity.activeOrders.reduce((sum, row) => sum + num(row.buyAmount), 0),
    positions: open.length, pending: pending.length, openCount: activity.activeOrders.length,
    investedMargin: orders.filter(order => order.entry).reduce((sum, order) => sum + num(order.margin), 0),
    closedMargin: activity.closedOrders.reduce((sum, order) => sum + num(order.margin), 0),
    syncReady, accountingComplete: incompleteHistory === 0, incompleteHistory,
    canOpen: syncReady && !state.entriesPaused && available > 0, warnings: [...warnings], poolStartedAt: state.fusedPoolStartedAt };
}
