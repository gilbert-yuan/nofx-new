import crypto from 'node:crypto';
import { ProxyAgent, fetch } from 'undici';
import { nextOpenTime } from './research.js';

const OKX_BASE_URL = 'https://www.okx.com';

export class OkxClient {
  constructor({ apiKey = '', secretKey = '', passphrase = '', demo = true, baseUrl = OKX_BASE_URL,
    proxyUrl = process.env.OKX_PROXY_URL ?? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890'),
    fetchImpl = fetch, retryDelayMs = 500 } = {}) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
    this.demo = demo;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    this.connectionMode = proxyUrl ? 'proxy' : 'direct';
    this.fetchImpl = fetchImpl;
    this.retryDelayMs = retryDelayMs;
  }

  hasCredentials() { return Boolean(this.apiKey && this.secretKey && this.passphrase); }
  instId(symbol) { return symbol.includes('-') ? symbol : `${String(symbol).replace(/USDT$/, '')}-USDT-SWAP`; }
  symbol(instId) { return String(instId).replace(/-USDT-SWAP$/, 'USDT'); }

  async perpetualUsdtContracts() {
    const rows = await this.publicRequest('/api/v5/public/instruments', { instType: 'SWAP' });
    return rows.filter(row => row.state === 'live' && row.settleCcy === 'USDT')
      .map(row => ({ symbol: this.symbol(row.instId), instId: row.instId, baseCoin: row.ctValCcy || row.instId.split('-')[0], quoteCoin: 'USDT', lotSize: row.lotSz, minSize: row.minSz, contractValue: row.ctVal, contractValueCurrency: row.ctValCcy }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async perpetualUsdtSymbols() { return (await this.perpetualUsdtContracts()).map(row => row.symbol); }
  async instrument(symbol) { return (await this.perpetualUsdtContracts()).find(row => row.symbol === this.symbol(symbol)); }

  async ticker(symbol) {
    const rows = await this.publicRequest('/api/v5/market/ticker', { instId: this.instId(symbol) });
    const row = rows[0];
    if (!row) throw new Error(`OKX ticker unavailable for ${symbol}.`);
    return { price: Number(row.last), markPrice: Number(row.last), raw: row };
  }

  async klines({ symbol, interval = '15m', limit = 80, after, before }) {
    const rows = await this.publicRequest('/api/v5/market/candles', {
      instId: this.instId(symbol), bar: toOkxBar(interval), limit: clamp(limit, 1, 300), after, before
    });
    return rows.map(row => ({
      openTime: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume: Number(row[5]), quoteVolume: Number(row[7] || 0), closeTime: nextOpenTime(Number(row[0]), interval) - 1,
      tradeCount: 0, confirmed: String(row[8]) === '1'
    })).sort((a, b) => a.openTime - b.openTime);
  }

  async balance() { return (await this.signedRequest('GET', '/api/v5/account/balance'))[0] || {}; }
  async positions() { return this.signedRequest('GET', '/api/v5/account/positions', { instType: 'SWAP' }); }
  async pendingAlgoOrders(instId) { return this.signedRequest('GET', '/api/v5/trade/orders-algo-pending', { ordType: 'conditional', instId }); }

  async setLeverage({ instId, leverage, tdMode = 'isolated' }) {
    return this.signedRequest('POST', '/api/v5/account/set-leverage', { instId, lever: String(leverage), mgnMode: tdMode });
  }

  async placeMarketOrder({ symbol, side, contracts, tdMode = 'isolated', takeProfit, stopLoss, clOrdId }) {
    const attachAlgoOrds = [];
    if (takeProfit) attachAlgoOrds.push({ attachAlgoClOrdId: `${clOrdId}tp`.slice(0, 32), tpTriggerPx: price(takeProfit), tpOrdPx: '-1', tpTriggerPxType: 'mark' });
    if (stopLoss) attachAlgoOrds.push({ attachAlgoClOrdId: `${clOrdId}sl`.slice(0, 32), slTriggerPx: price(stopLoss), slOrdPx: '-1', slTriggerPxType: 'mark' });
    return this.signedRequest('POST', '/api/v5/trade/order', {
      instId: this.instId(symbol), tdMode, side, posSide: 'net', ordType: 'market', sz: String(contracts),
      clOrdId, ...(attachAlgoOrds.length ? { attachAlgoOrds } : {})
    });
  }

  async closePosition({ instId, contracts, tdMode = 'isolated', pos }) {
    return this.signedRequest('POST', '/api/v5/trade/order', {
      instId, tdMode, side: Number(pos) > 0 ? 'sell' : 'buy', posSide: 'net', ordType: 'market',
      sz: String(contracts), reduceOnly: true, clOrdId: `nofxclose${Date.now()}`.slice(0, 32)
    });
  }

  async placeProtection({ instId, pos, tdMode = 'isolated', takeProfit, stopLoss }) {
    const side = Number(pos) > 0 ? 'sell' : 'buy';
    const requests = [];
    // OKX rejects a combined net conditional TP+SL payload; create two protected close orders instead.
    if (takeProfit) requests.push(this.signedRequest('POST', '/api/v5/trade/order-algo', {
      instId, tdMode, side, posSide: 'net', ordType: 'conditional', closeFraction: '1',
      tpTriggerPx: price(takeProfit), tpOrdPx: '-1', tpTriggerPxType: 'mark', algoClOrdId: `nofxtp${Date.now()}`.slice(0, 32)
    }));
    if (stopLoss) requests.push(this.signedRequest('POST', '/api/v5/trade/order-algo', {
      instId, tdMode, side, posSide: 'net', ordType: 'conditional', closeFraction: '1',
      slTriggerPx: price(stopLoss), slOrdPx: '-1', slTriggerPxType: 'mark', algoClOrdId: `nofxsl${Date.now()}`.slice(0, 32)
    }));
    return Promise.all(requests);
  }

  async amendProtection({ instId, algoId, takeProfit, stopLoss }) {
    const payload = { instId, algoId };
    if (takeProfit) Object.assign(payload, { newTpTriggerPx: price(takeProfit), newTpOrdPx: '-1' });
    if (stopLoss) Object.assign(payload, { newSlTriggerPx: price(stopLoss), newSlOrdPx: '-1' });
    return this.signedRequest('POST', '/api/v5/trade/amend-algos', payload);
  }

  async publicRequest(path, params = {}) { return this.request('GET', path, params); }
  async signedRequest(method, path, params = {}) {
    if (!this.hasCredentials()) throw new Error('OKX API key, secret key and passphrase are required.');
    return this.request(method, path, params, true);
  }

  async request(method, path, params = {}, signed = false) {
    // Only public reads can be replayed safely. A failed order may already be accepted.
    const maxAttempts = method === 'GET' && !signed ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.requestOnce(method, path, params, signed);
      } catch (error) {
        if (!error.retryable || attempt === maxAttempts) throw error;
        await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * 2 ** (attempt - 1)));
      }
    }
  }

  async requestOnce(method, path, params = {}, signed = false) {
    const isGet = method === 'GET';
    const query = isGet ? new URLSearchParams(clean(params)).toString() : '';
    const requestPath = `${path}${query ? `?${query}` : ''}`;
    const body = isGet ? '' : JSON.stringify(clean(params));
    const headers = { 'Content-Type': 'application/json' };
    if (this.demo) headers['x-simulated-trading'] = '1';
    if (signed) {
      const timestamp = new Date().toISOString();
      headers['OK-ACCESS-KEY'] = this.apiKey;
      headers['OK-ACCESS-PASSPHRASE'] = this.passphrase;
      headers['OK-ACCESS-TIMESTAMP'] = timestamp;
      headers['OK-ACCESS-SIGN'] = crypto.createHmac('sha256', this.secretKey).update(`${timestamp}${method}${requestPath}${body}`).digest('base64');
    }
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, { method, headers, body: body || undefined, dispatcher: this.dispatcher, signal: AbortSignal.timeout(30000) });
    } catch (cause) {
      const codes = networkErrorCodes(cause);
      const error = new Error(`Unable to reach OKX ${path}: ${cause?.message || 'network failure'} (${this.connectionMode}${codes.length ? `; ${codes.join(', ')}` : ''})`, { cause });
      error.status = 502;
      error.retryable = codes.some(code => RETRYABLE_NETWORK_CODES.has(code));
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== '0') {
      const error = new Error(`OKX ${response.status}: ${payload.msg || payload.code || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return payload.data || [];
  }
}

const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'TimeoutError']);

function networkErrorCodes(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  return [...new Set([
    ...(error.code ? [String(error.code)] : []),
    ...(error.name === 'TimeoutError' ? [error.name] : []),
    ...networkErrorCodes(error.cause, seen),
    ...(Array.isArray(error.errors) ? error.errors.flatMap(item => networkErrorCodes(item, seen)) : [])
  ])];
}

function toOkxBar(interval) { return ({ '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc', '1M': '1Mutc' })[interval] || interval; }
function clean(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')); }
function clamp(value, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : min; }
function price(value) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error('Protection price is invalid.'); return String(number); }
