import { BinanceClient } from './binanceClient.js';
import { normalizeBinanceKline } from './marketDb.js';
import { nextOpenTime, toBybitInterval } from './research.js';
import { upsertSymbolLeverage, loadAllSymbolLeverage } from './symbolLeverageStore.js';

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
    this.ticker24hCache = null;
    this.ticker24hAt = 0;
    /** 币种 → 最大杠杆（来自 exchangeInfo 的 LEVERAGE_FILTER）；下单前用于截断超限杠杆。 */
    this.leverageBySymbol = new Map();
  }

  /** 存储键：合约与现货同为 `BINANCE_` 命名空间（provider 不变），无需迁移历史 key。 */
  storageSymbol(symbol) { return `BINANCE_${symbol}`; }

  /** USDT 本位永续合约清单（TRADING & PERPETUAL & quoteAsset=USDT & marginAsset=USDT）。 */
  async perpetualUsdtContracts({ refresh = false } = {}) {
    if (!refresh && this.rows.length && Date.now() - Date.parse(this.updatedAt) < 3600000) return this.rows;
    if (this.pending) return this.pending;
    this.pending = this.client.exchangeInfo().then(info => {
      const symbols = (info.symbols || [])
        .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.marginAsset === 'USDT');
      this.rows = symbols
        .map(s => {
          // 仅提取真实盘最大杠杆供行情展示；**下单截断用的权威来源是 Demo 端 applyDemoLeverage**
          // （真实盘上限对 Demo 不可靠：如 ARKUSDT 真实盘支持高杠杆，但 Demo 上限更低才会被 400 拒）。
          const maxLeverage = Number(s.filters?.find(f => f.filterType === 'LEVERAGE_FILTER')?.maxLeverage) || null;
          return { symbol: s.symbol, baseCoin: s.baseAsset, quoteCoin: s.quoteAsset, filters: s.filters, maxLeverage, marketProvider: this.provider };
        })
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

  /** 读取某币种支持的最大杠杆（已落库 + 内存缓存）。找不到返回 null（调用方应降级到全局上限）。 */
  getMaxLeverage(symbol) {
    return this.leverageBySymbol.get(symbol) || null;
  }

  /** 启动预热：从 symbol_leverage 表把历史值载入内存，消除冷启动首单空窗。 */
  async loadLeverageCache() {
    try {
      const rows = await loadAllSymbolLeverage();
      for (const r of rows) this.leverageBySymbol.set(r.symbol, Number(r.maxLeverage));
      return rows.length;
    } catch (e) {
      console.warn('[BinanceMarket] 加载币种杠杆缓存失败:', e.message);
      return 0;
    }
  }

  /**
   * Demo（下单目标环境）批量写入币种最大杠杆：覆盖内存缓存 + 落库。
   * 调用方为拿 Demo exchangeInfo 的代码（如下单镜像 paperLimitParams），它才是准确来源；
   * 真实盘行情刷新不写此字段，避免用真实盘高上限覆盖 Demo 低上限导致仍被 400 拒单。
   * @param rows [{ symbol, maxLeverage }]
   */
  applyDemoLeverage(rows) {
    const valid = (rows || []).filter(r => r && typeof r.symbol === 'string' && r.symbol
      && Number.isFinite(Number(r.maxLeverage)) && Number(r.maxLeverage) > 0);
    for (const r of valid) this.leverageBySymbol.set(r.symbol, Number(r.maxLeverage));
    if (valid.length) upsertSymbolLeverage(valid).catch(e => console.warn('[BinanceMarket] Demo 币种最大杠杆落库失败:', e.message));
    return valid.length;
  }

  async klines({ symbol, interval = '15m', limit = 80, startTime, endTime }) {
    toBybitInterval(interval);
    if (!/^[\p{L}\p{N}]+USDT$/u.test(symbol)) throw Object.assign(new Error('请选择有效的 Binance USDT 合约。'), { status: 422 });
    const count = Math.min(this.maxPageSize, Math.max(1, Number(limit) || 80));
    const rows = await this.client.klines({ symbol, interval, limit: count, startTime, endTime });
    return rows.map(row => ({ ...normalizeBinanceKline(row), confirmed: nextOpenTime(Number(row[0]), interval) <= Date.now() }));
  }

  /**
   * 批量读取 USDT 永续合约 24h ticker。
   * 妖币预测每轮只需要一份全市场快照，短缓存也能避免状态页刷新重复打交易所。
   */
  async ticker24hAll({ refresh = false } = {}) {
    if (!refresh && this.ticker24hCache && Date.now() - this.ticker24hAt < 60000) {
      return new Map(this.ticker24hCache);
    }
    if (typeof this.client.ticker24hr !== 'function') return new Map();
    const response = await this.client.ticker24hr();
    const rows = Array.isArray(response) ? response : response ? [response] : [];
    const map = new Map(rows
      .filter(row => row?.symbol)
      .map(row => [row.symbol, row]));
    this.ticker24hCache = map;
    this.ticker24hAt = Date.now();
    return new Map(map);
  }

  /**
   * Load the public derivatives context required by the supplied crypto SKILLs.
   * Individual endpoints are allowed to fail so the strategy can fail closed
   * with an explicit data-quality reason instead of silently inventing values.
   */
  async skillContext(symbol) {
    const calls = {
      premium: () => this.client.premiumIndex(symbol),
      funding: () => this.client.fundingRate({ symbol, limit: 200 }),
      oi: () => this.client.openInterestHist({ symbol, period: '15m', limit: 200 }),
      globalRatio: () => this.client.globalLongShortAccountRatio({ symbol, period: '15m', limit: 30 }),
      topRatio: () => this.client.topLongShortPositionRatio({ symbol, period: '15m', limit: 30 }),
      takerRatio: () => this.client.takerLongShortRatio({ symbol, period: '15m', limit: 30 })
    };
    const results = await Promise.all(Object.entries(calls).map(async ([key, fn]) => {
      try { return [key, await fn(), null]; }
      catch (error) { return [key, null, error.message]; }
    }));
    return {
      symbol,
      premium: results.find(([key]) => key === 'premium')?.[1] || null,
      funding: results.find(([key]) => key === 'funding')?.[1] || [],
      oi: results.find(([key]) => key === 'oi')?.[1] || [],
      globalRatio: results.find(([key]) => key === 'globalRatio')?.[1] || [],
      topRatio: results.find(([key]) => key === 'topRatio')?.[1] || [],
      takerRatio: results.find(([key]) => key === 'takerRatio')?.[1] || [],
      errors: Object.fromEntries(results.filter(([, , error]) => error).map(([key, , error]) => [key, error]))
    };
  }

  /**
   * 机会报告所需的轻量衍生品上下文。
   * 每个公开接口独立失败，价格判断仍可生成，同时把失败原因显式返回。
   */
  async opportunityContext(symbol) {
    const calls = {
      ticker24h: () => this.client.ticker24hr(symbol),
      premium: () => this.client.premiumIndex(symbol),
      funding: () => this.client.fundingRate({ symbol, limit: 1 }),
      oi: () => this.client.openInterestHist({ symbol, period: '15m', limit: 2 })
    };
    const results = await Promise.all(Object.entries(calls).map(async ([key, fn]) => {
      try { return [key, await fn(), null]; }
      catch (error) { return [key, null, error.message]; }
    }));
    return {
      symbol,
      ticker24h: results.find(([key]) => key === 'ticker24h')?.[1] || null,
      premium: results.find(([key]) => key === 'premium')?.[1] || null,
      funding: results.find(([key]) => key === 'funding')?.[1] || [],
      oi: results.find(([key]) => key === 'oi')?.[1] || [],
      errors: Object.fromEntries(results.filter(([, , error]) => error).map(([key, , error]) => [key, error]))
    };
  }
}

export const binanceMarket = new BinanceMarket();
