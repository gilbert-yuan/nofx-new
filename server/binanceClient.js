import crypto from 'node:crypto';
import { fetch, ProxyAgent } from 'undici';

// ⚠️ 合约基址不用 fapi.binance.com：该域名对**受限地区**直接返回 451（本机代理出口即受限地区，实测）。
// 币安官网前端的 /fapi/v1/* 边缘路由（www.binance.com）提供**同一套合约接口**且不被地区封锁
// （实测 exchangeInfo/klines/ping 均 200），故公开行情与合约交易统一走 www.binance.com。
// 如需回官方域可用 BINANCE_FUTURES_BASE 覆盖。
const FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE || 'https://www.binance.com';
const FUTURES_TESTNET_BASE_URL = 'https://testnet.binancefuture.com';
// ⭐ Demo Trading（demo.binance.com，统一模拟盘，已取代 Spot/Futures Testnet）的合约 REST 基址。
// Demo key 在 demo.binance.com 的 API 管理页创建，同时适配现货(demo-api)与合约(demo-fapi)。
const FUTURES_DEMO_BASE_URL = 'https://demo-fapi.binance.com';

export class BinanceClient {
  constructor({ apiKey = '', secretKey = '', testnet = true, demo = false, proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY } = {}) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    // demo 优先于 testnet（testnet 为遗留环境）
    this.baseUrl = demo ? FUTURES_DEMO_BASE_URL : (testnet ? FUTURES_TESTNET_BASE_URL : FUTURES_BASE_URL);
    this.testnet = testnet;
    this.demo = demo;
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

  /** 杠杆阶梯（含每个 symbol 的最大杠杆 = brackets[0].initialLeverage）。公开接口，无需签名。
   *  注意：新版币安已把 maxLeverage 从 exchangeInfo.filters(LEVERAGE_FILTER) 移到此接口。 */
  async leverageBracket({ symbol } = {}) {
    return this.publicRequest('/fapi/v1/leverageBracket', symbol ? { symbol } : {});
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

  async klines({ symbol, interval = '4h', limit = 80, startTime, endTime }) {
    return this.publicRequest('/fapi/v1/klines', { symbol, interval, limit, startTime, endTime });
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

  async marketOrder({ symbol, side, quantity, reduceOnly = false, clientOrderId }) {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly,
      newClientOrderId: clientOrderId,
      newOrderRespType: 'RESULT'
    });
  }

  async limitOrder({ symbol, side, quantity, price, timeInForce = 'GTC', reduceOnly = false, clientOrderId }) {
    return this.signedRequest('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'LIMIT',
      quantity,
      price,
      timeInForce,
      reduceOnly,
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

  async positionMode() { return this.signedRequest('GET', '/fapi/v1/positionSide/dual'); }
  async openOrders(symbol) { return this.signedRequest('GET', '/fapi/v1/openOrders', { symbol }); }
  async openAlgoOrders(symbol) { return this.signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol }); }
  async cancelAlgo(algoId) { return this.signedRequest('DELETE', '/fapi/v1/algoOrder', { algoId }); }
  async protectionOrder({ symbol, side, type, triggerPrice, clientAlgoId }) {
    return this.signedRequest('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL', symbol, side, positionSide: 'BOTH', type,
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

function cleanParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}
