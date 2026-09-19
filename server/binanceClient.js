import crypto from 'node:crypto';
import { fetch, ProxyAgent } from 'undici';

// ⚠️ 合约基址不用 fapi.binance.com：该域名对**受限地区**直接返回 451（本机代理出口即受限地区，实测）。
// 币安官网前端的 /fapi/v1/* 边缘路由（www.binance.com）提供**同一套合约接口**且不被地区封锁
// （实测 exchangeInfo/klines/ping 均 200），故公开行情与正式盘交易统一走 www.binance.com。
// 如需回官方域可用 BINANCE_FUTURES_BASE 覆盖。
const FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE || 'https://www.binance.com';
// Binance 当前 USDⓈ-M Futures 文档给出的 Testnet / Demo REST 基址。
// Demo key 在 demo.binance.com 的 API 管理页创建，同时适配现货(demo-api)与合约(demo-fapi)。
const FUTURES_TESTNET_BASE_URL = 'https://demo-fapi.binance.com';

export class BinanceClient {
  constructor({ apiKey = '', secretKey = '', testnet = true, demo, proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY } = {}) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    // demo 是新字段；没有它时兼容旧配置中的 testnet。当前官方 Testnet
    // 文档使用 Demo Trading 基址，不再回退到已过时的 testnet.binancefuture.com。
    this.demo = demo === undefined ? testnet !== false : Boolean(demo);
    this.baseUrl = this.demo ? FUTURES_TESTNET_BASE_URL : FUTURES_BASE_URL;
    // testnet 保留为旧响应字段，语义与 demo 对齐，避免前端旧版本误显示为实盘。
    this.testnet = this.demo;
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.secretKey);
  }

  async ping() {
    return this.publicRequest('/fapi/v1/ping');
  }

  async exchangeInfo() {
    return this.publicRequest('/fapi/v1/exchangeInfo');
  }

  /** 杠杆阶梯（含每个 symbol 的最大杠杆 = brackets[0].initialLeverage）。Binance USER_DATA 接口，必须使用 API Key + HMAC 签名。
   *  注意：新版币安已把 maxLeverage 从 exchangeInfo.filters(LEVERAGE_FILTER) 移到此接口。 */
  async leverageBracket({ symbol } = {}) {
    return this.signedRequest('GET', '/fapi/v1/leverageBracket', symbol ? { symbol } : {});
  }

  async perpetualUsdtSymbols() {
    const info = await this.exchangeInfo();
    return (info.symbols || [])
      .filter(
        (symbol) =>
          symbol.status === 'TRADING' &&
          symbol.contractType === 'PERPETUAL' &&
          symbol.quoteAsset === 'USDT'
      )
      .map((symbol) => symbol.symbol)
      .sort();
  }

  async price(symbol) {
    return this.publicRequest('/fapi/v1/ticker/price', { symbol });
  }

  async ticker24hr(symbol) {
    // Binance accepts an omitted symbol to return the full 24h ticker list.
    // Keep the single-symbol call compatible while allowing one batched scan
    // for the妖币 predictor instead of issuing one request per contract.
    return this.publicRequest('/fapi/v1/ticker/24hr', symbol ? { symbol } : {});
  }

  async klines({ symbol, interval = '4h', limit = 80, startTime, endTime }) {
    return this.publicRequest('/fapi/v1/klines', { symbol, interval, limit, startTime, endTime });
  }

  // Binance USD-M public derivatives context used by the deterministic SKILL engines.
  async premiumIndex(symbol) { return this.publicRequest('/fapi/v1/premiumIndex', { symbol }); }
  async fundingRate({ symbol, limit = 200 } = {}) { return this.publicRequest('/fapi/v1/fundingRate', { symbol, limit }); }
  async openInterest({ symbol } = {}) { return this.publicRequest('/fapi/v1/openInterest', { symbol }); }
  async openInterestHist({ symbol, period = '15m', limit = 200 } = {}) {
    return this.publicRequest('/futures/data/openInterestHist', { symbol, period, limit });
  }
  async globalLongShortAccountRatio({ symbol, period = '15m', limit = 30 } = {}) {
    return this.publicRequest('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
  }
  async topLongShortPositionRatio({ symbol, period = '15m', limit = 30 } = {}) {
    return this.publicRequest('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
  }
  async takerLongShortRatio({ symbol, period = '15m', limit = 30 } = {}) {
    return this.publicRequest('/futures/data/takerlongshortRatio', { symbol, period, limit });
  }

  async account() {
    return this.signedRequest('GET', '/fapi/v2/account');
  }

  async positions(symbol) {
    return this.signedRequest('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {});
  }

  async userTrades({ symbol, limit = 500, fromId, startTime, endTime }) {
    return this.signedRequest('GET', '/fapi/v1/userTrades', {
      symbol,
      limit,
      fromId,
      startTime,
      endTime
    });
  }

  async setLeverage({ symbol, leverage }) {
    return this.signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  async marketOrder({ symbol, side, quantity, reduceOnly = false, positionSide, clientOrderId }) {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      ...positionSideFields(reduceOnly, positionSide),
      newClientOrderId: clientOrderId,
      newOrderRespType: 'RESULT'
    });
  }

  async limitOrder({ symbol, side, quantity, price, timeInForce = 'GTC', reduceOnly = false, positionSide, clientOrderId }) {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      quantity,
      price,
      timeInForce,
      ...positionSideFields(reduceOnly, positionSide),
      newClientOrderId: clientOrderId,
      newOrderRespType: 'RESULT'
    });
  }

  async cancelOrder({ symbol, orderId, clientOrderId }) {
    return this.signedRequest('DELETE', '/fapi/v1/order', {
      symbol,
      ...(Number.isInteger(Number(orderId)) && Number(orderId) > 0 ? { orderId: Number(orderId) } : { origClientOrderId: clientOrderId })
    });
  }

  async order({ symbol, orderId, clientOrderId }) {
    return this.signedRequest('GET', '/fapi/v1/order', {
      symbol,
      ...(Number.isInteger(Number(orderId)) && Number(orderId) > 0
        ? { orderId: Number(orderId) }
        : { origClientOrderId: clientOrderId })
    });
  }

  async positionMode() { return this.signedRequest('GET', '/fapi/v1/positionSide/dual'); }

  /**
   * 账户是否「双向持仓」（Hedge Mode），带实例级缓存。
   *
   * 为什么必须知道：合约下单的 positionSide 与 reduceOnly 是**互斥**的两种表达（见 positionSideFields）。
   * 单向账户发 positionSide=LONG/SHORT 会被 400 拒绝；双向账户不发 positionSide 同样被 400 拒绝
   * ——「Order's position side does not match user's setting.」正是双向账户收到单向参数时的报错。
   *
   * 持仓模式是账户级设置、运行期不会变，故缓存首个结果；探测失败按单向处理
   * （保守：与本模块历史行为一致，不会把单向账户误判成双向反而发错参数）。
   */
  async dualSidePosition() {
    if (this.dualSideCache === undefined) {
      try { this.dualSideCache = (await this.positionMode())?.dualSidePosition === true; }
      catch { this.dualSideCache = false; }
    }
    return this.dualSideCache;
  }
  async openOrders(symbol) { return this.signedRequest('GET', '/fapi/v1/openOrders', { symbol }); }
  async openAlgoOrders(symbol) { return this.signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol }); }
  async cancelAlgo(algoId) { return this.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId }); }
  async protectionOrder({ symbol, side, type, triggerPrice, positionSide, clientAlgoId }) {
    return this.signedRequest('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol, side, positionSide: positionSide || 'BOTH', type,
      triggerPrice, closePosition: 'true', workingType: 'MARK_PRICE', clientAlgoId
    });
  }

  async publicRequest(endpoint, params = {}) {
    // Market data requests are idempotent. Retry transient exchange and proxy failures,
    // but never retry a signed trading request because it could duplicate an order.
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await this.request(this.url(endpoint, params), {}, endpoint);
        if ((res.status === 429 || res.status >= 500) && attempt < 2) {
          await delay(350 * 2 ** attempt);
          continue;
        }
        return await parseBinanceResponse(res);
      } catch (error) {
        lastError = error;
        if (Number(error.status) !== 502 || attempt === 2) throw error;
        await delay(350 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async signedRequest(method, endpoint, params = {}, retried = false) {
    if (!this.hasCredentials()) {
      throw new Error('Binance API key and secret are required.');
    }
    // 本机时钟与币安服务器可能偏差数秒 → recvWindow 报错；首次签名前同步一次偏移量
    if (this.timeOffset === undefined) await this.syncTime();

    const signedParams = {
      ...params,
      timestamp: Date.now() + this.timeOffset,
      recvWindow: 5000
    };
    const query = new URLSearchParams(cleanParams(signedParams)).toString();
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(query)
      .digest('hex');

    const res = await this.request(
      `${this.baseUrl}${endpoint}?${query}&signature=${signature}`,
      {
        method,
        headers: {
          'X-MBX-APIKEY': this.apiKey
        }
      },
      endpoint
    );
    try {
      return await parseBinanceResponse(res);
    } catch (error) {
      // -1021 时钟偏差：重新同步偏移后重试一次
      if (error.code === -1021 && !retried) {
        this.timeOffset = undefined;
        return this.signedRequest(method, endpoint, params, true);
      }
      throw error;
    }
  }

  /** 同步本地时钟与币安服务器的偏移量（毫秒） */
  async syncTime() {
    try {
      const t = await this.publicRequest('/fapi/v1/time');
      this.timeOffset = (Number(t.serverTime) || Date.now()) - Date.now();
    } catch {
      this.timeOffset = 0;
    }
    return this.timeOffset;
  }

  async request(url, options, endpoint) {
    try {
      return await fetch(url, { ...options, dispatcher: this.dispatcher, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      const cause = error?.cause;
      const details = [cause?.code, cause?.message || error?.message].filter(Boolean).join(': ');
      const requestError = new Error(
        `Unable to reach Binance Futures at ${this.baseUrl}${endpoint}. ${details || 'Network request failed.'} ` +
          'Check outbound HTTPS access, proxy settings, DNS, or regional network restrictions.'
      );
      requestError.status = 502;
      throw requestError;
    }
  }

  url(endpoint, params = {}) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    return `${this.baseUrl}${endpoint}${query ? `?${query}` : ''}`;
  }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function parseBinanceResponse(res) {
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = body.msg || body.message || res.statusText;
    // 地区法律封锁：连代理都过不去，真实盘交易不可用，给出明确指引而非裸 451。
    if (res.status === 451) {
      const error = new Error(
        'Binance 返回 451（地区法律封锁）：真实盘交易不可用。' +
        '请保持模拟盘，或改用合规交易所/数据源，或更换代理地区后重试。'
      );
      error.status = 451;
      error.regionBlocked = true;
      throw error;
    }
    const responseError = new Error(`Binance ${res.status}: ${msg}`);
    responseError.status = res.status;
    if (body.code !== undefined) responseError.code = body.code;
    throw responseError;
  }
  return body;
}

/**
 * 单向 / 双向持仓模式的下单参数互斥规则（两类账户能共用同一套下单代码的关键）。
 *
 *   · 单向（One-way）：平仓靠 reduceOnly=true；带 positionSide=LONG/SHORT 会被 400 拒绝。
 *   · 双向（Hedge）  ：必须带 positionSide=LONG/SHORT 指明要操作哪一侧仓位，且**禁止** reduceOnly
 *                      （币安在 Hedge Mode 下会直接拒绝该参数）。
 *
 * 调用方给出 LONG/SHORT 即视为双向账户：用 positionSide 表达方向，并丢掉 reduceOnly。
 * 双向账户上省略 positionSide 会让「平仓」被当成**反向开仓**，所以宁可少传 reduceOnly，
 * 也绝不能在双向账户上漏掉 positionSide。
 */
function positionSideFields(reduceOnly, positionSide) {
  const hedge = positionSide === 'LONG' || positionSide === 'SHORT';
  return hedge ? { positionSide } : { reduceOnly };
}

function cleanParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}
