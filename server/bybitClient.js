import { ProxyAgent, fetch, setGlobalDispatcher } from 'undici';
import { nextOpenTime } from './research.js';

const BYBIT_BASE_URL = 'https://api.bybit.com';
const DEFAULT_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
setGlobalDispatcher(new ProxyAgent(DEFAULT_PROXY));

export class BybitClient {
  constructor({ baseUrl = BYBIT_BASE_URL, proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  }

  async perpetualUsdtContracts() {
    const contracts = [];
    let cursor = '';

    do {
      const body = await this.publicRequest('/v5/market/instruments-info', {
        category: 'linear',
        status: 'Trading',
        limit: 1000,
        cursor
      });
      const rows = body.result?.list || [];
      contracts.push(
        ...rows
          .filter((item) => item.contractType === 'LinearPerpetual' && item.quoteCoin === 'USDT')
          .map((item) => ({ symbol: item.symbol, baseCoin: item.baseCoin, quoteCoin: item.quoteCoin }))
      );
      cursor = body.result?.nextPageCursor || '';
    } while (cursor);

    return [...new Map(contracts.map((item) => [item.symbol, item])).values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async perpetualUsdtSymbols() {
    return (await this.perpetualUsdtContracts()).map((item) => item.symbol);
  }

  async klines({ symbol, interval = '240', limit = 80, start, end }) {
    const body = await this.publicRequest('/v5/market/kline', {
      category: 'linear',
      symbol,
      interval,
      limit,
      start,
      end
    });
    return (body.result?.list || [])
      .map((row) => ({
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        quoteVolume: Number(row[6]),
        closeTime: nextOpenTime(Number(row[0]), interval) - 1,
        tradeCount: 0
      }))
      .sort((a, b) => a.openTime - b.openTime);
  }

  async publicRequest(endpoint, params = {}) {
    const query = new URLSearchParams(cleanParams(params)).toString();
    let response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}?${query}`, {
        dispatcher: this.dispatcher || undefined,
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      const details = [error?.cause?.code, error?.cause?.message || error?.message]
        .filter(Boolean)
        .join(': ');
      const requestError = new Error(
        `Unable to reach Bybit public market API at ${this.baseUrl}${endpoint}. ${details || 'Network request failed.'}`
      );
      requestError.status = 502;
      throw requestError;
    }

    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { retMsg: text.slice(0, 300) };
    }
    if (!response.ok || body.retCode !== 0) {
      const error = new Error(`Bybit ${response.status}: ${body.retMsg || response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
}

function cleanParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}
