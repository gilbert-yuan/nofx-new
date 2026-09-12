import { fetch } from 'undici';
import { nextOpenTime, toBybitInterval } from './research.js';

const BINANCE_SPOT_DATA_URL = 'https://data-api.binance.vision';

// Public market data never receives trading credentials. Namespaces keep venues apart.
export function marketStorageSymbol(symbol, provider = 'binance') {
  if (!['okx', 'binance'].includes(provider)) throw new Error(`未知行情来源：${provider}`);
  return `${provider === 'okx' ? 'OKX_PUBLIC' : 'BINANCE'}_${symbol}`;
}

/** Binance Spot public market-data provider. */
export class BinanceSpotMarket {
  constructor({ baseUrl = BINANCE_SPOT_DATA_URL, fetchImpl = fetch, requestSpacingMs = 120 } = {}) {
    Object.assign(this, {
      baseUrl: baseUrl.replace(/\/$/, ''), fetchImpl, provider: 'binance', maxPageSize: 1000,
      rows: [], updatedAt: null, lastError: '', pending: null, requestSpacingMs, nextRequestAt: 0
    });
  }

  storageSymbol(symbol) { return marketStorageSymbol(symbol, this.provider); }

  async request(path, params = {}) {
    const start = Math.max(Date.now(), this.nextRequestAt);
    this.nextRequestAt = start + this.requestSpacingMs;
    if (start > Date.now()) await new Promise(resolve => setTimeout(resolve, start - Date.now()));
    const query = new URLSearchParams(Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, String(value)])).toString();
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}${query ? `?${query}` : ''}`, { signal: AbortSignal.timeout(30000) });
    } catch (cause) {
      const error = new Error(`Unable to reach Binance Spot ${path}: ${cause?.message || 'network failure'}`, { cause });
      error.status = 502;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Binance Spot ${response.status}: ${payload.msg || payload.message || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async spotUsdtContracts({ refresh = false } = {}) {
    if (!refresh && this.rows.length && Date.now() - Date.parse(this.updatedAt) < 3600000) return this.rows;
    if (this.pending) return this.pending;
    this.pending = this.request('/api/v3/exchangeInfo').then(info => {
      this.rows = (info.symbols || [])
        .filter(row => row.status === 'TRADING' && row.quoteAsset === 'USDT' && row.isSpotTradingAllowed !== false)
        .map(row => ({ symbol: row.symbol, baseCoin: row.baseAsset, quoteCoin: row.quoteAsset, filters: row.filters, marketProvider: this.provider }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      this.updatedAt = new Date().toISOString();
      this.lastError = '';
      return this.rows;
    }).catch(error => { this.lastError = error.message; throw error; }).finally(() => { this.pending = null; });
    return this.pending;
  }

  // Retained while callers migrate from the former perpetual-provider name.
  async perpetualUsdtContracts(options) { return this.spotUsdtContracts(options); }
  async spotUsdtSymbols() { return (await this.spotUsdtContracts()).map(row => row.symbol); }
  async perpetualUsdtSymbols() { return this.spotUsdtSymbols(); }
  status() { return { provider: this.provider, marketType: 'spot', count: this.rows.length, updatedAt: this.updatedAt, busy: Boolean(this.pending), lastError: this.lastError }; }

  async klines({ symbol, interval = '15m', limit = 80, startTime, endTime }) {
    toBybitInterval(interval);
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) throw Object.assign(new Error('请选择有效的 Binance USDT 现货币种。'), { status: 422 });
    const count = Math.min(this.maxPageSize, Math.max(1, Math.trunc(Number(limit)) || 80));
    const lower = startTime == null ? undefined : Number(startTime);
    const upper = endTime == null ? undefined : Number(endTime);
    if ((lower != null && !Number.isFinite(lower)) || (upper != null && !Number.isFinite(upper))) throw new Error('K 线时间范围无效。');

    const rows = new Map();
    let cursor = lower;
    while (rows.size < count) {
      const pageLimit = Math.min(this.maxPageSize, count - rows.size);
      const raw = await this.request('/api/v3/klines', { symbol, interval, limit: pageLimit, startTime: cursor, endTime: upper });
      if (!Array.isArray(raw) || !raw.length) break;
      const newest = Number(raw.at(-1)?.[0]);
      if (!Number.isFinite(newest) || (cursor != null && newest < cursor)) throw new Error('Binance 历史 K 线分页未前进，请稍后重试。');
      for (const row of raw) {
        const openTime = Number(row[0]);
        if ((lower != null && openTime < lower) || (upper != null && openTime > upper)) continue;
        rows.set(openTime, {
          openTime, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
          volume: Number(row[5]), quoteVolume: Number(row[7]), closeTime: Number(row[6]), tradeCount: Number(row[8]),
          confirmed: nextOpenTime(openTime, interval) <= Date.now()
        });
      }
      if (cursor == null || raw.length < pageLimit) break;
      const next = nextOpenTime(newest, interval);
      if (next <= cursor) throw new Error('Binance 历史 K 线分页未前进，请稍后重试。');
      cursor = next;
      if (upper != null && cursor > upper) break;
    }
    return [...rows.values()].sort((a, b) => a.openTime - b.openTime).slice(-count);
  }
}

export const marketData = new BinanceSpotMarket();