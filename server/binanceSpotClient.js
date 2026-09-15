import crypto from 'node:crypto';
import { fetch, ProxyAgent } from 'undici';

const SPOT_BASE_URL = 'https://api.binance.com';
const SPOT_DEMO_BASE_URL = 'https://demo-api.binance.com';

export class BinanceSpotClient {
  constructor({ apiKey = '', secretKey = '', demo = true, proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.secretKey = String(secretKey || '').trim();
    this.demo = demo !== false;
    this.baseUrl = this.demo ? SPOT_DEMO_BASE_URL : SPOT_BASE_URL;
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  }

  hasCredentials() { return Boolean(this.apiKey && this.secretKey); }

  async exchangeInfo() { return this.publicRequest('/api/v3/exchangeInfo'); }
  async price(symbol) { return this.publicRequest('/api/v3/ticker/price', { symbol }); }
  async klines({ symbol, interval = '15m', limit = 80, startTime, endTime }) {
    return this.publicRequest('/api/v3/klines', { symbol, interval, limit, startTime, endTime });
  }
  async account({ omitZeroBalances = false } = {}) {
    return this.signedRequest('GET', '/api/v3/account', { omitZeroBalances });
  }
  async openOrders({ symbol } = {}) {
    return this.signedRequest('GET', '/api/v3/openOrders', { symbol });
  }
  async allOrderLists({ fromId, startTime, endTime, limit = 1000 } = {}) {
    return this.signedRequest('GET', '/api/v3/allOrderList', { fromId, startTime, endTime, limit });
  }
  async allOrders({ symbol, limit = 500, orderId, startTime, endTime }) {
    return this.signedRequest('GET', '/api/v3/allOrders', { symbol, limit, orderId, startTime, endTime });
  }
  async myTrades({ symbol, limit = 500, fromId, startTime, endTime }) {
    return this.signedRequest('GET', '/api/v3/myTrades', { symbol, limit, fromId, startTime, endTime });
  }
  async order({ symbol, side, type = 'LIMIT', quantity, quoteOrderQty, price, timeInForce = 'GTC', newClientOrderId, newOrderRespType = 'RESULT' }) {
    return this.signedRequest('POST', '/api/v3/order', { symbol, side, type, quantity, quoteOrderQty, price, timeInForce, newClientOrderId, newOrderRespType });
  }
  async cancelOrder({ symbol, orderId, origClientOrderId }) {
    return this.signedRequest('DELETE', '/api/v3/order', { symbol, orderId, origClientOrderId });
  }

  async publicRequest(endpoint, params = {}) {
    return this.request('GET', endpoint, params, false);
  }
  async signedRequest(method, endpoint, params = {}) {
    if (!this.hasCredentials()) throw new Error('Binance Spot Demo API key and secret are required.');
    const signedParams = { ...params, timestamp: Date.now(), recvWindow: 5000 };
    const query = new URLSearchParams(cleanParams(signedParams)).toString();
    const signature = crypto.createHmac('sha256', this.secretKey).update(query).digest('hex');
    return this.request(method, endpoint, { ...signedParams, signature }, true);
  }
  async request(method, endpoint, params = {}, signed = false) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    const url = this.baseUrl + endpoint + (query ? '?' + query : '');
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: signed ? { 'X-MBX-APIKEY': this.apiKey } : undefined,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(30000)
      });
    } catch (cause) {
      const error = new Error('Unable to reach Binance Spot ' + this.baseUrl + endpoint + ': ' + (cause?.message || 'network failure'), { cause });
      error.status = 502;
      throw error;
    }
    const bodyText = await response.text();
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = { msg: bodyText.slice(0, 300) }; }
    if (!response.ok || body.code < 0) {
      const error = new Error('Binance Spot ' + response.status + ': ' + (body.msg || response.statusText));
      error.status = response.status;
      error.code = body.code;
      throw error;
    }
    return body;
  }
}

function cleanParams(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}