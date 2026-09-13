import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { BinanceClient } from '../binanceClient.js';

/** 币安账户连接状态 / 连通性测试 / K线复盘 / 测试网交易通道 */
export function createBinanceRouter(container) {
  const router = express.Router();
  const { store, positionMonitor, clientFactory = config => new BinanceClient(config) } = container;

  router.get('/api/binance/status', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.status());
  }));

  router.post('/api/binance/test', asyncHandler(async (req, res) => {
    const config = await store.getConfig();
    const client = new BinanceClient(config.binance);
    if (!client.hasCredentials()) {
      throw new ApiError('请填写币安 API Key 和 Secret Key。', 422);
    }
    const [balance, positions, mode] = await Promise.all([client.account(), client.positions(), client.positionMode()]);
    res.json({
      ok: true,
      testnet: Boolean(config.binance?.testnet),
      totalEquity: Number(balance.totalWalletBalance || 0),
      activePositions: positions.filter((p) => Math.abs(Number(p.positionAmt)) > 0).length,
      positionMode: mode.dualSidePosition ? 'hedge' : 'one-way'
    });
  }));

  router.post('/api/binance/review', asyncHandler(async (req, res) => {
    res.json(await positionMonitor.reviewAfterKlines({ interval: '15m' }));
  }));

  // ── 测试网交易通道（限价/市价下单、撤单、挂单、持仓）──
  const tradeClient = async () => {
    const config = await store.getConfig();
    const client = clientFactory(config.binance);
    if (!client.hasCredentials()) {
      throw new ApiError('请先在「币安交易配置」里保存 API Key / Secret Key（测试网 key 请在 testnet.binancefuture.com 注册获取）。', 422);
    }
    return { config, client };
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
    res.json({ ok: true, positions: positions.filter(p => Math.abs(Number(p.positionAmt)) > 0) });
  }));

  router.post('/api/binance/order', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const symbol = normalizeSymbol(body.symbol);
    const side = String(body.side || '').toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) throw new ApiError('side 只能是 BUY / SELL', 422);
    const type = String(body.type || 'LIMIT').toUpperCase();
    if (!['LIMIT', 'MARKET'].includes(type)) throw new ApiError('type 只能是 LIMIT / MARKET', 422);
    const quantity = positiveNumber(body.quantity, 'quantity');
    const { client } = await tradeClient();
    const order = type === 'LIMIT'
      ? await client.limitOrder({ symbol, side, quantity, price: positiveNumber(body.price, 'price') })
      : await client.marketOrder({ symbol, side, quantity });
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

      res.json({ ok: true, testnet: Boolean(config.binance?.testnet), symbol, orderId, steps });
    } catch (error) {
      // 冒烟中断时兜底撤单，避免残留挂单
      if (orderId) { try { await client.cancelOrder({ symbol, orderId }); } catch { /* 尽力而为 */ } }
      res.status(error.status && error.status >= 400 && error.status < 500 ? error.status : 502)
        .json({ ok: false, testnet: Boolean(config.binance?.testnet), symbol, steps, error: error.message });
    }
  }));

  return router;
}
