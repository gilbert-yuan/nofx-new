import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { BinanceClient } from '../binanceClient.js';
import { BinanceSpotClient } from '../binanceSpotClient.js';
import { binanceEnvironmentConfig } from '../binancePaperSync.js';

/** 币安账户连接状态 / 连通性测试 / K线复盘 / 测试网交易通道 */
export function createBinanceRouter(container) {
  const router = express.Router();
  const { store, positionMonitor, clientFactory = config => new BinanceClient(config) } = container;

  router.get('/api/binance/status', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.status());
  }));

  router.post('/api/binance/test', asyncHandler(async (req, res) => {
    const config = await store.getConfig();
    const demo = isBinanceDemo(config.binance);
    const environment = demo ? 'demo' : 'live';
    const client = new BinanceClient(binanceEnvironmentConfig(config, environment));
    if (!client.hasCredentials()) {
      throw new ApiError('请填写币安 API Key 和 Secret Key。', 422);
    }
    const [balance, positions, mode] = await Promise.all([client.account(), client.positions(), client.positionMode()]);
    res.json({
      ok: true,
      demo,
      testnet: demo,
      environment: demo ? 'demo' : 'live',
      totalEquity: Number(balance.totalWalletBalance || 0),
      activePositions: positions.filter((p) => Math.abs(Number(p.positionAmt)) > 0).length,
      positionMode: mode.dualSidePosition ? 'hedge' : 'one-way'
    });
  }));

  router.post('/api/binance/review', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.reviewAfterKlines({ interval: '15m' }));
  }));

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
    const symbols = [...new Set(symbolCandidates.map(normalizeSymbol))];
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

  router.get('/api/binance/trades', asyncHandler(async (req, res) => {
    const { config, client } = await tradeClient();
    const configured = String(req.query.symbols || config.tradeSync?.symbolsText || config.trader?.entrySymbolsText || 'BTCUSDT')
      .split(',').map(value => String(value).trim().toUpperCase()).filter(Boolean);
    const symbols = [...new Set(configured)].slice(0, 20).map(normalizeSymbol);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
    const from = req.query.from ? Date.parse(String(req.query.from)) : null;
    const to = req.query.to ? Date.parse(String(req.query.to)) + 24 * 60 * 60 * 1000 - 1 : null;
    const datasets = await Promise.all(symbols.map(async symbol => ({
      symbol, trades: await client.userTrades({ symbol, limit, ...(from > 0 ? { startTime: from } : {}), ...(to > 0 ? { endTime: to } : {}) })
    })));
    const trades = datasets.flatMap(({ symbol, trades: rows }) => rows.map(row => normalizeTrade(symbol, row)))
      .filter(row => (!from || row.time >= from) && (!to || row.time <= to))
      .sort((a, b) => a.time - b.time);
    const orders = summarizeTrades(trades);
    res.json({ ok: true, demo: Boolean(config.binance?.demo), testnet: Boolean(config.binance?.testnet), symbols, syncedAt: new Date().toISOString(), trades, orders, summary: summarizeTotals(orders) });
  }));
  // ── 测试网交易通道（限价/市价下单、撤单、挂单、持仓）──
  const tradeClient = async () => {
    const config = await store.getConfig();
    const environment = isBinanceDemo(config.binance) ? 'demo' : 'live';
    const client = clientFactory(binanceEnvironmentConfig(config, environment));
    if (!client.hasCredentials()) {
      throw new ApiError('请先在「币安交易配置」里保存 API Key / Secret Key（Demo key 请在 demo.binance.com 创建）。', 422);
    }
    return { config, client, environment };
  };

  const normalizeSymbol = (value) => {
    const symbol = String(value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new ApiError(`非法币种：${value}`, 422);
    return symbol;
  };

  const positiveNumber = (value, name) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new ApiError(`${name} 必须为正数`, 422);
    return n;
  };

  router.get('/api/binance/openOrders', asyncHandler(async (req, res) => {
    const { client } = await tradeClient();
    res.json({ ok: true, orders: await client.openOrders(req.query.symbol ? normalizeSymbol(req.query.symbol) : undefined) });
  }));

  router.get('/api/binance/positions', asyncHandler(async (req, res) => {
    const { client } = await tradeClient();
    const positions = await client.positions(req.query.symbol ? normalizeSymbol(req.query.symbol) : undefined);
    const mode = typeof client.positionMode === 'function' ? await client.positionMode() : null;
    res.json({
      ok: true,
      positions: positions.filter(p => Math.abs(Number(p.positionAmt)) > 0),
      positionMode: mode?.dualSidePosition ? 'hedge' : 'one-way'
    });
  }));

  router.post('/api/binance/order', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const symbol = normalizeSymbol(body.symbol);
    const side = String(body.side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) throw new ApiError('side 只能是 BUY / SELL', 422);
    const type = String(body.type || 'LIMIT').toUpperCase();
    if (!['LIMIT', 'MARKET'].includes(type)) throw new ApiError('type 只能是 LIMIT / MARKET', 422);
    const quantity = positiveNumber(body.quantity, 'quantity');
    const reduceOnly = body.reduceOnly === true || body.reduceOnly === 'true';
    const clientOrderId = body.clientOrderId ? String(body.clientOrderId) : undefined;
    const { client } = await tradeClient();
    const orderArgs = { symbol, side, quantity, reduceOnly, ...(clientOrderId ? { clientOrderId } : {}) };
    const order = type === 'LIMIT'
      ? await client.limitOrder({ ...orderArgs, price: positiveNumber(body.price, 'price') })
      : await client.marketOrder(orderArgs);
    res.json({ ok: true, order });
  }));

  router.delete('/api/binance/order', asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.body?.symbol);
    const orderId = Number(req.body?.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) throw new ApiError('orderId 必须为正整数', 422);
    const { client } = await tradeClient();
    res.json({ ok: true, result: await client.cancelOrder({ symbol, orderId }) });
  }));

  /**
   * 一键冒烟（全链路、零成交风险）：
   *   现价 × 0.5 的远价 BUY 限价单（不可能成交）→ 查挂单命中 → 撤单 → 确认消失。
   * 验证签名鉴权、下单、查询、撤单四件事；失败时逐步骤标明断点。
   */
  router.post('/api/binance/smoke', asyncHandler(async (req, res) => {
    const symbol = normalizeSymbol(req.body?.symbol || 'BTCUSDT');
    const { config, client } = await tradeClient();
    if (!isBinanceDemo(config.binance)) {
      throw new ApiError('冒烟测试仅允许 Binance Demo Trading，当前配置是实盘。', 422);
    }
    const steps = [];
    const step = (name, fn) => Promise.resolve()
      .then(fn)
      .then((data) => { steps.push({ name, ok: true, detail: data }); return data; })
      .catch((error) => { steps.push({ name, ok: false, error: error.message }); throw error; });

    let orderId = null;
    try {
      const ticker = await step('1/5 现价', () => client.price(symbol));
      const refPrice = Number(ticker.price || ticker.bidPrice);
      if (!(refPrice > 0)) throw new ApiError(`测试网未返回 ${symbol} 现价`, 502);
      const farPrice = Math.round(refPrice * 0.5 * 10) / 10; // 现价一半，永不成交
      const quantity = Number(req.body?.quantity) > 0 ? Number(req.body.quantity) : 0.002;

      const placed = await step('2/5 挂远价限价单', () => client.limitOrder({ symbol, side: 'BUY', quantity, price: farPrice }));
      orderId = Number(placed.orderId);

      const found = await step('3/5 查挂单', async () => {
        const open = await client.openOrders(symbol);
        const hit = open.find(o => Number(o.orderId) === orderId);
        if (!hit) throw new ApiError(`挂单 ${orderId} 未出现在 openOrders`, 502);
        return { orderId: hit.orderId, price: hit.price, status: hit.status };
      });

      await step('4/5 撤单', () => client.cancelOrder({ symbol, orderId }));

      await step('5/5 复核撤单', async () => {
        const open = await client.openOrders(symbol);
        if (open.some(o => Number(o.orderId) === orderId)) throw new ApiError(`撤单后 ${orderId} 仍在挂单列表`, 502);
        return { remaining: open.length };
      });

      const demo = isBinanceDemo(config.binance);
      res.json({ ok: true, demo, testnet: demo, environment: demo ? 'demo' : 'live', symbol, orderId, steps });
    } catch (error) {
      // 冒烟中断时兜底撤单，避免残留挂单
      if (orderId) { try { await client.cancelOrder({ symbol, orderId }); } catch { /* 尽力而为 */ } }
      res.status(error.status && error.status >= 400 && error.status < 500 ? error.status : 502)
        .json({ ok: false, demo: true, testnet: true, environment: 'demo', symbol, steps, error: error.message });
    }
  }));


function isBinanceDemo(config = {}) {
  return config.demo !== undefined ? config.demo === true : config.testnet !== false;
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
function normalizeTrade(symbol, row) {
  return { symbol, tradeId: Number(row.id), orderId: Number(row.orderId), time: Number(row.time), side: String(row.side || '').toUpperCase(), price: Number(row.price), quantity: Number(row.qty), quoteQuantity: Number(row.quoteQty || Number(row.price) * Number(row.qty)), realizedPnl: Number(row.realizedPnl || 0), commission: Number(row.commission || 0), commissionAsset: row.commissionAsset || 'USDT', positionSide: row.positionSide || 'BOTH', maker: Boolean(row.maker) };
}
function summarizeTrades(trades) {
  const groups = new Map();
  for (const trade of trades) {
    const key = trade.symbol + ':' + trade.orderId;
    const item = groups.get(key) || { id: key, symbol: trade.symbol, orderId: trade.orderId, buyQty: 0, sellQty: 0, buyQuote: 0, sellQuote: 0, fees: 0, realizedPnl: 0, firstTime: trade.time, lastTime: trade.time, fills: 0 };
    if (trade.side === 'BUY') { item.buyQty += trade.quantity; item.buyQuote += trade.quoteQuantity; } else { item.sellQty += trade.quantity; item.sellQuote += trade.quoteQuantity; }
    item.fees += trade.commission; item.realizedPnl += trade.realizedPnl; item.firstTime = Math.min(item.firstTime, trade.time); item.lastTime = Math.max(item.lastTime, trade.time); item.fills += 1; groups.set(key, item);
  }
  return [...groups.values()].map(item => ({ ...item, buyPrice: item.buyQty ? item.buyQuote / item.buyQty : null, sellPrice: item.sellQty ? item.sellQuote / item.sellQty : null, netPnl: item.realizedPnl - item.fees, status: item.buyQty && item.sellQty ? 'closed' : 'filled' })).sort((a, b) => b.lastTime - a.lastTime);
}
function summarizeTotals(orders) {
  return orders.reduce((total, order) => ({ orders: total.orders + 1, closed: total.closed + (order.status === 'closed' ? 1 : 0), fees: total.fees + order.fees, realizedPnl: total.realizedPnl + order.realizedPnl, netPnl: total.netPnl + order.netPnl, buyQuote: total.buyQuote + order.buyQuote, sellQuote: total.sellQuote + order.sellQuote, totalQuote: total.totalQuote + order.buyQuote + order.sellQuote }), { orders: 0, closed: 0, fees: 0, realizedPnl: 0, netPnl: 0, buyQuote: 0, sellQuote: 0, totalQuote: 0 });
}  return router;
}
