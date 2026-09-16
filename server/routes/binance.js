import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { BinanceClient } from '../binanceClient.js';
import { binanceEnvironmentConfig, isBinanceDemo } from '../../shared/binanceEnvironment.js';
import { createBinanceSpotDemoRouter } from './binanceSpotDemo.js';

/**
 * 币安路由（装配层）：
 * - USDⓈ-M 合约：连接测试 / 持仓复核 / 成交流水 / 手动下单撤单 / Demo 冒烟
 * - Spot Demo 订单同步：独立子路由（server/routes/binanceSpotDemo.js）
 */
export function createBinanceRouter(container) {
  const router = express.Router();
  const { store, positionMonitor, clientFactory = config => new BinanceClient(config) } = container;
  router.use(createBinanceSpotDemoRouter({ store }));

  router.get('/api/binance/status', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.status());
  }));

  router.post('/api/binance/test', asyncHandler(async (req, res) => {
    const config = await store.getConfig();
    const environment = isBinanceDemo(config.binance) ? 'demo' : 'live';
    const client = new BinanceClient(binanceEnvironmentConfig(config, environment));
    if (!client.hasCredentials()) {
      throw new ApiError('请填写币安 API Key 和 Secret Key。', 422);
    }
    const [balance, positions, mode] = await Promise.all([client.account(), client.positions(), client.positionMode()]);
    const demo = environment === 'demo';
    res.json({
      ok: true,
      demo,
      testnet: demo,
      environment,
      totalEquity: Number(balance.totalWalletBalance || 0),
      activePositions: positions.filter((p) => Math.abs(Number(p.positionAmt)) > 0).length,
      positionMode: mode.dualSidePosition ? 'hedge' : 'one-way'
    });
  }));

  router.post('/api/binance/review', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.reviewAfterKlines({ interval: '15m' }));
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
    const demo = isBinanceDemo(config.binance);
    res.json({ ok: true, demo, testnet: demo, symbols, syncedAt: new Date().toISOString(), trades, orders, summary: summarizeTotals(orders) });
  }));

  // ── 测试网交易通道（限价/市价下单、撤单、挂单、持仓）──
  // 统一入口：按当前选中环境解析凭证（demoApiKey/liveApiKey → 主 apiKey 回落）。
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

  /**
   * 按绑定关系查询币安订单详情（模拟单 exchangeSync.demo/live.orderId ↔ 币安 orderId）。
   * Query: environment=demo|live（必填）、symbol（必填）、orderId 或 clientOrderId（二选一）。
   * 环境 demo/实盘走同一套凭证解析（binanceEnvironmentConfig）。
   */
  router.get('/api/binance/orderDetail', asyncHandler(async (req, res) => {
    const environment = String(req.query.environment || '').toLowerCase();
    if (!['demo', 'live'].includes(environment)) throw new ApiError('environment 必须是 demo 或 live。', 422);
    const symbol = normalizeSymbol(req.query.symbol);
    const orderId = Number(req.query.orderId);
    const clientOrderId = req.query.clientOrderId ? String(req.query.clientOrderId) : undefined;
    if (!(Number.isInteger(orderId) && orderId > 0) && !clientOrderId) {
      throw new ApiError('必须提供 orderId 或 clientOrderId。', 422);
    }
    const config = await store.getConfig();
    const client = clientFactory(binanceEnvironmentConfig(config, environment));
    if (!client.hasCredentials()) throw new ApiError(`未配置 Binance ${environment === 'demo' ? 'Demo' : '实盘'} API Key / Secret Key。`, 422);
    const remote = Number.isInteger(orderId) && orderId > 0
      ? await client.order({ symbol, orderId })
      : await client.order({ symbol, clientOrderId });
    res.json({
      ok: true,
      environment,
      order: {
        orderId: remote.orderId ?? null,
        clientOrderId: remote.clientOrderId || '',
        symbol: remote.symbol || symbol,
        side: remote.side || '',
        type: remote.type || '',
        status: remote.status || '',
        price: Number(remote.price || 0),
        avgPrice: Number(remote.avgPrice || 0),
        origQty: Number(remote.origQty || remote.origQuantity || 0),
        executedQty: Number(remote.executedQty || 0),
        reduceOnly: remote.reduceOnly === true,
        time: Number(remote.time || 0),
        updateTime: Number(remote.updateTime || 0)
      }
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

      await step('3/5 查挂单', async () => {
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
  }

  return router;
}
