import { BinanceClient } from './binanceClient.js';
import { normalizeBinanceKline } from './marketDb.js';
import { nextOpenTime, toBybitInterval } from './research.js';

/**
 * 币安 U 本位永续（USDT-M Futures）公开行情源 —— 生产唯一行情来源（合约口径）。
 *
 * ⚠️ 为什么基址不是 fapi.binance.com：该域名对受限地区返回 451（本机代理出口即受限地区，实测）。
 *    币安官网前端的 /fapi/v1/* 边缘路由（www.binance.com）提供**同一套公开合约数据**且不被地区封锁，
 *    因此 BinanceClient 的默认合约基址指向 https://www.binance.com（见 binanceClient.js）。
 *
 * ⚠️ 本类只负责**公开行情**（symbols / klines），不下单；执行侧走 BinanceClient 的签名接口。
 *    存储前缀固定 `BINANCE_`（provider 仍是 binance，与既有命名空间一致，无 provider 迁移成本）。
 */
export class BinanceMarket {
  constructor({ client = new BinanceClient({ testnet: false }) } = {}) {
    this.client = client;
    this.provider = 'binance';
    this.marketType = 'futures';
    this.maxPageSize = 1000;
    this.rows = [];
    this.updatedAt = null;
    this.lastError = '';
    this.pending = null;
  }

  /** 存储键：合约与现货同为 `BINANCE_` 命名空间（provider 不变），无需迁移历史 key。 */
  storageSymbol(symbol) { return `BINANCE_${symbol}`; }

  /** USDT 本位永续合约清单（TRADING & PERPETUAL & quoteAsset=USDT & marginAsset=USDT）。 */
  async perpetualUsdtContracts({ refresh = false } = {}) {
    if (!refresh && this.rows.length && Date.now() - Date.parse(this.updatedAt) < 3600000) return this.rows;
    if (this.pending) return this.pending;
    this.pending = this.client.exchangeInfo().then(info => {
      this.rows = (info.symbols || [])
        .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.marginAsset === 'USDT')
        .map(s => ({ symbol: s.symbol, baseCoin: s.baseAsset, quoteCoin: s.quoteAsset, filters: s.filters, marketProvider: this.provider }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol));
      this.updatedAt = new Date().toISOString();
      this.lastError = '';
      return this.rows;
    }).catch(error => { this.lastError = error.message; throw error; }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async perpetualUsdtSymbols() { return (await this.perpetualUsdtContracts()).map(s => s.symbol); }

  status() {
    return { provider: this.provider, marketType: this.marketType, count: this.rows.length,
      updatedAt: this.updatedAt, busy: Boolean(this.pending), lastError: this.lastError };
  }

  async klines({ symbol, interval = '15m', limit = 80, startTime, endTime }) {
    toBybitInterval(interval);
    if (!/^[\p{L}\p{N}]+USDT$/u.test(symbol)) throw Object.assign(new Error('请选择有效的 Binance USDT 合约。'), { status: 422 });
    const count = Math.min(this.maxPageSize, Math.max(1, Number(limit) || 80));
    const rows = await this.client.klines({ symbol, interval, limit: count, startTime, endTime });
    return rows.map(row => ({ ...normalizeBinanceKline(row), confirmed: nextOpenTime(Number(row[0]), interval) <= Date.now() }));
  }
}

export const binanceMarket = new BinanceMarket();
