import { BinanceClient } from './binanceClient.js';
import { normalizeBinanceKline } from './marketDb.js';
import { nextOpenTime, toBybitInterval } from './research.js';

// Public symbols and candles are independent of the account's trading keys/environment.
export class BinanceMarket {
  constructor({ client = new BinanceClient({ testnet: false }) } = {}) {
    this.client = client;
    this.rows = [];
    this.updatedAt = null;
    this.lastError = '';
    this.pending = null;
  }

  async perpetualUsdtContracts({ refresh = false } = {}) {
    if (!refresh && this.rows.length && Date.now() - Date.parse(this.updatedAt) < 3600000) return this.rows;
    if (this.pending) return this.pending;
    this.pending = this.client.exchangeInfo().then(info => {
      this.rows = info.symbols.filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.marginAsset === 'USDT')
        .map(s => ({ symbol: s.symbol, baseCoin: s.baseAsset, quoteCoin: s.quoteAsset, filters: s.filters }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      this.updatedAt = new Date().toISOString();
      this.lastError = '';
      return this.rows;
    }).catch(error => { this.lastError = error.message; throw error; }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async perpetualUsdtSymbols() { return (await this.perpetualUsdtContracts()).map(s => s.symbol); }
  status() { return { provider: 'binance', count: this.rows.length, updatedAt: this.updatedAt, busy: Boolean(this.pending), lastError: this.lastError }; }
  async klines({ symbol, interval = '15m', limit = 80, startTime, endTime }) {
    toBybitInterval(interval);
    if (!/^[\p{L}\p{N}]+USDT$/u.test(symbol)) throw Object.assign(new Error('请选择有效的 USDT 合约。'), { status: 400 });
    const rows = await this.client.klines({ symbol, interval, limit: Math.min(1000, Math.max(1, Number(limit))), startTime, endTime });
    return rows.map(row => ({ ...normalizeBinanceKline(row), confirmed: nextOpenTime(Number(row[0]), interval) <= Date.now() }));
  }
}

export const binanceMarket = new BinanceMarket();
