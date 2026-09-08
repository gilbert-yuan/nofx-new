import crypto from 'node:crypto';
import { fetch, ProxyAgent } from 'undici';

const FUTURES_BASE_URL = 'https://fapi.binance.com';
const FUTURES_TESTNET_BASE_URL = 'https://testnet.binancefuture.com';

export class BinanceClient {
  constructor({ apiKey = '', secretKey = '', testnet = true, proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY } = {}) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.baseUrl = testnet ? FUTURES_TESTNET_BASE_URL : FUTURES_BASE_URL;
    this.testnet = testnet;
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
        return parseBinanceResponse(res);
      } catch (error) {
        lastError = error;
        if (Number(error.status) !== 502 || attempt === 2) throw error;
        await delay(350 * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async signedRequest(method, endpoint, params = {}) {
    if (!this.hasCredentials()) {
      throw new Error('Binance API key and secret are required.');
    }

    const signedParams = {
      ...params,
      timestamp: Date.now(),
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
    return parseBinanceResponse(res);
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
    const responseError = new Error(`Binance ${res.status}: ${msg}`);
    responseError.status = res.status;
    throw responseError;
  }
  return body;
}

function cleanParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}
