const numeric = value => value != null && value !== '' && Number.isFinite(Number(value));
const tradingIncomeTypes = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE', 'INSURANCE_CLEAR', 'COMMISSION_REBATE']);

/** Use exchange balances directly: collateral, leverage and transfers cannot be inferred from the order list. */
export function normalizeBinanceFunds(account) {
  const fields = {
    balance: 'totalWalletBalance', available: 'availableBalance', equity: 'totalMarginBalance',
    unrealized: 'totalUnrealizedProfit', usedMargin: 'totalInitialMargin',
    positionMargin: 'totalPositionInitialMargin', orderMargin: 'totalOpenOrderInitialMargin'
  };
  if (!account || Object.values(fields).some(key => !numeric(account[key]))) {
    throw new Error('币安账户资金数据不完整，保留上次同步结果。');
  }
  return {
    ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, Number(account[field])])),
    unit: account.multiAssetsMargin === true ? 'USD' : 'USDT'
  };
}

/** Signed cash flows include fees and funding; deposits/withdrawals are never trading profit. */
export function summarizeBinanceIncome(rows, { startTime, endTime }) {
  const seen = new Set(), excludedAssets = new Set();
  let gross = 0, commission = 0, funding = 0, adjustments = 0, count = 0;
  for (const row of rows) {
    if (!numeric(row.income) || !numeric(row.time) || row.tranId == null || !row.incomeType || !row.asset) {
      throw new Error('币安收益流水数据无效，保留上次收益统计。');
    }
    if (Number(row.time) < startTime || Number(row.time) > endTime || !tradingIncomeTypes.has(row.incomeType)) continue;
    if (row.asset !== 'USDT') { excludedAssets.add(row.asset); continue; }
    const key = `${row.incomeType}:${row.tranId}:${row.asset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const amount = Number(row.income);
    if (row.incomeType === 'REALIZED_PNL') gross += amount;
    else if (row.incomeType === 'COMMISSION') commission += amount;
    else if (row.incomeType === 'FUNDING_FEE') funding += amount;
    else adjustments += amount;
    count++;
  }
  return { realized: gross + commission + funding + adjustments, gross, commission, funding, adjustments,
    count, excludedAssets: [...excludedAssets], startAt: new Date(startTime).toISOString(), asOf: new Date(endTime).toISOString() };
}

/** The overview shows one account, never the sum of a paper ledger and its mirrored exchange orders. */
export function selectPaperOverview(account, requestedSource = 'auto') {
  const snapshots = account?.exchangeAccounts || {};
  const source = requestedSource === 'auto'
    ? snapshots.demo?.enabled ? 'binance-demo' : snapshots.live?.enabled ? 'binance-live' : 'paper'
    : requestedSource;
  if (source === 'paper') {
    const orders = account?.orders || [];
    return { ...account, source, sourceLabel: '本地模拟', unit: 'USDT',
      positions: orders.filter(row => row.status === 'open').length, pending: orders.filter(row => row.status === 'pending').length };
  }
  const snapshot = snapshots[source === 'binance-demo' ? 'demo' : 'live'];
  const funds = snapshot?.enabled && snapshot.configured ? snapshot.funds : null;
  const income = snapshot?.income;
  const comparable = funds?.unit === 'USDT' && income && !income.excludedAssets?.length;
  const realized = comparable ? income.realized : null;
  return { balance: null, available: null, equity: null, usedMargin: null, unrealized: null, ...funds,
    source, sourceLabel: source === 'binance-demo' ? '币安 Demo' : '币安实盘', unit: funds?.unit || 'USDT',
    realized, net: realized == null || !funds ? null : realized + funds.unrealized,
    positions: snapshot?.enabled ? snapshot.positions?.length || 0 : 0,
    pending: snapshot?.enabled ? snapshot.orders?.length || 0 : 0,
    syncedAt: snapshot?.syncedAt, incomeStartAt: income?.startAt, incomeAsOf: income?.asOf,
    incomeLookbackDays: snapshot?.incomeLookbackDays, incomeIntervalSeconds: snapshot?.incomeIntervalSeconds, incomeError: snapshot?.incomeError,
    incomeWarning: income?.excludedAssets?.length ? `含 ${income.excludedAssets.join('、')} 收益，尚未折算，收益合计暂不展示。`
      : funds?.unit === 'USD' ? '多资产保证金以 USD 计价，USDT 收益尚未折算，收益合计暂不展示。' : '',
    error: snapshot?.error || (!funds ? '尚未取得该账户的资金数据。' : '') };
}
