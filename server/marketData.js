import { binanceMarket } from './binanceMarket.js';

/**
 * 行情命名空间：把「交易对」映射到数据库/归档里的存储键。
 * 目的：不同交易所（venue）的同一交易对互不覆盖。
 *
 * ⚠️ 现货源（BinanceSpotMarket）已于 2026-09-13 随「项目整体切合约」移除；
 *    生产行情源唯一实例 = 币安 U 本位永续（见 binanceMarket.js）。
 */
export function marketStorageSymbol(symbol, provider = 'binance') {
  if (!['okx', 'binance'].includes(provider)) throw new Error(`未知行情来源：${provider}`);
  return `${provider === 'okx' ? 'OKX_PUBLIC' : 'BINANCE'}_${symbol}`;
}

/**
 * 生产行情源单例 —— 币安 U 本位永续（USDT-M Futures，合约口径）。
 * 整条链路（行情 / 回测语料 / 策略 / 成本模型）都按合约语义设计。
 */
export const marketData = binanceMarket;
