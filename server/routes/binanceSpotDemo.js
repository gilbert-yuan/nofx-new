import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { BinanceSpotClient } from '../binanceSpotClient.js';

/** Spot Demo 订单同步路由：账户相关交易对自动发现 + 成交/历史订单拉取与现货盈亏统计。 */
export function createBinanceSpotDemoRouter({ store }) {
  const router = express.Router();

  router.get('/api/binance/spot-demo/orders', asyncHandler(async (req, res) => {
    const config = await store.getConfig();
    const spotConfig = {
      apiKey: config.binance?.spotApiKey || config.binance?.apiKey,
      secretKey: config.binance?.spotSecretKey || config.binance?.secretKey,
      demo: true,
      proxyUrl: config.binance?.proxyUrl
    };
    const client = new BinanceSpotClient(spotConfig);
    if (!client.hasCredentials()) throw new ApiError('请填写 Binance Spot Demo API Key 和 Secret Key。', 422);

    const from = parseSpotDate(req.query.from, '开始日期');
    const to = parseSpotDate(req.query.to, '结束日期', true);
    if (from && to && from > to) throw new ApiError('开始日期不能晚于结束日期。', 422);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 1000));
    const requested = parseSpotSymbols(req.query.symbols);
    const automatic = requested.length === 0 || requested.includes('ALL');
    const discovery = automatic ? await discoverSpotDemoSymbols(client) : { mode: 'manual', symbols: requested, candidateCount: requested.length, sources: [] };
    const symbolCandidates = automatic ? [...discovery.symbols, ...requested.filter(symbol => symbol !== 'ALL')] : requested;
    const symbols = [...new Set(symbolCandidates.map(normalizeSpotSymbol))];
    const windows = spotTimeWindows(from, to);

    const datasets = await mapWithConcurrency(symbols, 3, async symbol => {
      const results = await mapWithConcurrency(windows, 1, async window => {
        const range = { symbol, limit, ...window };
        const [trades, orders] = await Promise.all([client.myTrades(range), client.allOrders(range)]);
        return { trades, orders };
      });
      return {
        symbol,
        trades: uniqueBy(results.flatMap(result => result.trades), row => `${row.id}:${row.orderId}`),
        orders: uniqueBy(results.flatMap(result => result.orders), row => `${row.orderId}`)
      };
    });
    const trades = datasets.flatMap(({ symbol, trades: rows }) => rows.map(row => normalizeSpotTrade(symbol, row)))
      .sort((a, b) => a.time - b.time);
    const historyOrders = datasets.flatMap(({ symbol, orders: rows }) => rows.map(row => normalizeSpotOrder(symbol, row)))
      .sort((a, b) => b.time - a.time);
    const report = summarizeSpotTrades(trades);
    const reachedPerWindowLimit = datasets.some(dataset => dataset.trades.length >= limit || dataset.orders.length >= limit);
    res.json({
      ok: true,
      product: 'spot',
      demo: true,
      baseUrl: 'https://demo-api.binance.com/api',
      symbols,
      syncedAt: new Date().toISOString(),
      trades,
      orders: report.orders,
      historyOrders,
      discovery: { ...discovery, mode: automatic ? 'auto-account' : 'manual', windows: windows.length, reachedPerWindowLimit },
      summary: { ...report.summary, historyOrders: historyOrders.length }
    });
  }));

  return router;
}

function normalizeSpotSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new ApiError(`非法币种：${value}`, 422);
  return symbol;
}

const SPOT_DAY_MS = 24 * 60 * 60 * 1000;
const SPOT_AUTO_SYMBOL_LIMIT = 120;
const SPOT_PREFERRED_QUOTES = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'BTC', 'ETH', 'BNB']);

function parseSpotSymbols(value) {
  return [...new Set(String(value || '').split(',')
    .map(item => String(item).trim().toUpperCase()).filter(Boolean))];
}

function parseSpotDate(value, label, endOfDay = false) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new ApiError(`${label}格式无效。`, 422);
  return endOfDay ? timestamp + SPOT_DAY_MS - 1 : timestamp;
}

function spotTimeWindows(from, to) {
  if (!from && !to) return [{}];
  const start = from || Math.max(0, to - SPOT_DAY_MS + 1);
  const end = to || Date.now();
  const windows = [];
  for (let cursor = start; cursor <= end; cursor += SPOT_DAY_MS) {
    windows.push({ startTime: cursor, endTime: Math.min(end, cursor + SPOT_DAY_MS - 1) });
  }
  return windows;
}

async function discoverSpotDemoSymbols(client) {
  const [account, exchangeInfo, openOrders, orderLists] = await Promise.all([
    client.account({ omitZeroBalances: true }),
    client.exchangeInfo(),
    client.openOrders().catch(() => []),
    client.allOrderLists().catch(() => [])
  ]);
  const activeAssets = new Set((account.balances || [])
    .filter(balance => Number(balance.free || 0) > 0 || Number(balance.locked || 0) > 0)
    .map(balance => String(balance.asset || '').toUpperCase()).filter(Boolean));
  const eligible = (exchangeInfo.symbols || []).filter(row => row.status === 'TRADING' && row.isSpotTradingAllowed !== false);
  const accountSymbols = eligible
    .filter(row => activeAssets.has(row.baseAsset) && (SPOT_PREFERRED_QUOTES.has(row.quoteAsset) || activeAssets.has(row.quoteAsset)))
    .map(row => row.symbol);
  const openSymbols = (openOrders || []).map(row => row.symbol).filter(Boolean);
  const orderListSymbols = (orderLists || []).map(row => row.symbol).filter(Boolean);
  const symbols = [...new Set([...openSymbols, ...orderListSymbols, ...accountSymbols])].sort();
  return {
    symbols: symbols.slice(0, SPOT_AUTO_SYMBOL_LIMIT),
    candidateCount: symbols.length,
    truncated: symbols.length > SPOT_AUTO_SYMBOL_LIMIT,
    activeAssets: [...activeAssets].sort(),
    sources: ['当前挂单', '订单列表', '非零账户资产']
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return result;
}

function uniqueBy(rows, key) {
  const seen = new Map();
  for (const row of rows || []) seen.set(key(row), row);
  return [...seen.values()];
}
function normalizeSpotTrade(symbol, row) {
  return {
    symbol, tradeId: Number(row.id), orderId: Number(row.orderId), time: Number(row.time),
    side: row.isBuyer ? 'BUY' : 'SELL', price: Number(row.price), quantity: Number(row.qty),
    quoteQuantity: Number(row.quoteQty || Number(row.price) * Number(row.qty)),
    commission: Number(row.commission || 0), commissionAsset: row.commissionAsset || '',
    maker: Boolean(row.isMaker)
  };
}
function normalizeSpotOrder(symbol, row) {
  return {
    symbol, orderId: Number(row.orderId), clientOrderId: row.clientOrderId || '',
    time: Number(row.updateTime || row.time || 0), side: String(row.side || '').toUpperCase(),
    type: String(row.type || ''), status: String(row.status || ''),
    price: Number(row.price || 0), avgPrice: Number(row.executedQty) > 0 ? Number(row.cummulativeQuoteQty || 0) / Number(row.executedQty) : 0,
    origQty: Number(row.origQty || 0), executedQty: Number(row.executedQty || 0),
    quoteOrderQty: Number(row.cummulativeQuoteQty || 0), reduceOnly: false, closePosition: false
  };
}
function summarizeSpotTrades(trades) {
  const groups = new Map();
  const inventory = new Map();
  const summary = { orders: 0, closed: 0, fees: 0, realizedPnl: 0, netPnl: 0, buyQuote: 0, sellQuote: 0, totalQuote: 0 };
  const feeInQuote = trade => {
    if (trade.commissionAsset === 'USDT' || trade.commissionAsset === 'USDC' || trade.commissionAsset === 'BUSD') return trade.commission;
    return trade.commission * trade.price;
  };
  for (const trade of trades) {
    const key = trade.symbol + ':' + trade.orderId;
    const item = groups.get(key) || { id: key, symbol: trade.symbol, orderId: trade.orderId, buyQty: 0, sellQty: 0, buyQuote: 0, sellQuote: 0, fees: 0, realizedPnl: 0, firstTime: trade.time, lastTime: trade.time, fills: 0 };
    const fee = feeInQuote(trade);
    const isBuy = trade.side === 'BUY';
    if (isBuy) {
      item.buyQty += trade.quantity; item.buyQuote += trade.quoteQuantity;
      const lots = inventory.get(trade.symbol) || [];
      lots.push({ quantity: trade.quantity, price: trade.price });
      inventory.set(trade.symbol, lots);
      summary.buyQuote += trade.quoteQuantity;
    } else {
      item.sellQty += trade.quantity; item.sellQuote += trade.quoteQuantity;
      summary.sellQuote += trade.quoteQuantity;
      let remaining = trade.quantity;
      const lots = inventory.get(trade.symbol) || [];
      while (remaining > 0 && lots.length) {
        const lot = lots[0];
        const matched = Math.min(remaining, lot.quantity);
        const pnl = (trade.price - lot.price) * matched;
        item.realizedPnl += pnl; summary.realizedPnl += pnl;
        lot.quantity -= matched; remaining -= matched;
        if (lot.quantity <= 1e-12) lots.shift();
      }
      inventory.set(trade.symbol, lots);
    }
    item.fees += fee; summary.fees += fee; item.firstTime = Math.min(item.firstTime, trade.time); item.lastTime = Math.max(item.lastTime, trade.time); item.fills += 1; groups.set(key, item);
  }
  const orders = [...groups.values()].map(item => ({ ...item, buyPrice: item.buyQty ? item.buyQuote / item.buyQty : null, sellPrice: item.sellQty ? item.sellQuote / item.sellQty : null, netPnl: item.realizedPnl - item.fees, status: item.buyQty && item.sellQty ? 'closed' : 'filled' })).sort((a, b) => b.lastTime - a.lastTime);
  summary.orders = orders.length; summary.closed = orders.filter(order => order.status === 'closed').length; summary.totalQuote = summary.buyQuote + summary.sellQuote; summary.netPnl = summary.realizedPnl - summary.fees;
  return { orders, summary };
}
