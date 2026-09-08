import { OkxClient } from './okxClient.js';
import { nextOpenTime, toBybitInterval } from './research.js';

// Public market data never receives trading credentials. Namespaces keep venues apart.
export function marketStorageSymbol(symbol, provider = 'okx') {
  if (!['okx', 'binance'].includes(provider)) throw new Error(`未知行情来源：${provider}`);
  return `${provider === 'okx' ? 'OKX_PUBLIC' : 'BINANCE'}_${symbol}`;
}

export class OkxMarket {
  constructor({ client = new OkxClient({ demo: false }), requestSpacingMs = 120 } = {}) {
    Object.assign(this, { client, provider: 'okx', maxPageSize: 300, rows: [], updatedAt: null, lastError: '', pending: null, requestSpacingMs, nextRequestAt: 0 });
  }
  storageSymbol(symbol) { return marketStorageSymbol(symbol, this.provider); }
  async request(path, params) {
    const start = Math.max(Date.now(), this.nextRequestAt);
    this.nextRequestAt = start + this.requestSpacingMs;
    if (start > Date.now()) await new Promise(resolve => setTimeout(resolve, start - Date.now()));
    return this.client.publicRequest(path, params);
  }
  async perpetualUsdtContracts({ refresh = false } = {}) {
    if (!refresh && this.rows.length && Date.now() - Date.parse(this.updatedAt) < 3600000) return this.rows;
    if (this.pending) return this.pending;
    this.pending = this.request('/api/v5/public/instruments', { instType: 'SWAP' }).then(rows => {
      this.rows = rows.filter(row => row.state === 'live' && row.settleCcy === 'USDT' && row.instId.endsWith('-USDT-SWAP'))
        .map(row => ({ symbol: row.instId.replace('-USDT-SWAP', 'USDT'), instId: row.instId, baseCoin: row.ctValCcy, quoteCoin: 'USDT', marketProvider: this.provider }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      this.updatedAt = new Date().toISOString(); this.lastError = '';
      return this.rows;
    }).catch(error => { this.lastError = error.message; throw error; }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async perpetualUsdtSymbols() { return (await this.perpetualUsdtContracts()).map(row => row.symbol); }
  status() { return { provider: this.provider, count: this.rows.length, updatedAt: this.updatedAt, busy: Boolean(this.pending), lastError: this.lastError }; }
  async klines({ symbol, interval = '15m', limit = 80, startTime, endTime }) {
    toBybitInterval(interval);
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) throw Object.assign(new Error('该币种没有对应的 OKX USDT 永续行情。'), { status: 422 });
    const count = Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 80));
    const bar = ({ '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc', '1M': '1Mutc' })[interval] || interval;
    let upper = endTime;
    if (startTime != null) {
      let bound = Number(startTime);
      for (let i = 0; i < count; i++) bound = nextOpenTime(bound, interval);
      upper = Math.min(upper ?? Date.now(), bound - 1);
    }
    const rows = new Map();
    let after = upper == null ? undefined : Number(upper) + 1;
    while (rows.size < count) {
      const raw = await this.request(after == null ? '/api/v5/market/candles' : '/api/v5/market/history-candles', {
        instId: `${symbol.slice(0, -4)}-USDT-SWAP`, bar, limit: Math.min(100, count - rows.size), after
      });
      if (!raw.length) break;
      const oldest = Math.min(...raw.map(row => Number(row[0])));
      if (!Number.isFinite(oldest) || (after != null && oldest >= after)) throw new Error('OKX 历史 K 线分页未前进，请稍后重试。');
      for (const row of raw) {
        const openTime = Number(row[0]);
        if ((startTime != null && openTime < startTime) || (upper != null && openTime > upper)) continue;
        rows.set(openTime, { openTime, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
          volume: Number(row[6]), quoteVolume: Number(row[7]), closeTime: nextOpenTime(openTime, interval) - 1,
          tradeCount: 0, confirmed: String(row[8]) === '1' });
      }
      if (startTime != null && oldest <= startTime) break;
      after = oldest;
    }
    return [...rows.values()].sort((a, b) => a.openTime - b.openTime).slice(-count);
  }
}

export const marketData = new OkxMarket();
