/**
 * 前后端共享 API 契约（单一事实源）
 * - 后端 routes/* 与前端 api/client.js 统一从这里取路径，杜绝两端硬编码漂移
 * - 纯 ESM，不依赖任何 Node / Vite 专有 API，前后端都可 import
 *
 * 约定：路径常量只读；请求/响应结构用 JSDoc typedef 描述，供 IDE 提示与后续代码生成。
 */

/** @typedef {Object} ApiErrorBody
 *  @property {string} error 人类可读错误信息（中文）
 */

export const API = {
  health: '/api/health',

  config: {
    get: '/api/config',
    put: '/api/config'
  },

  binance: {
    status: '/api/binance/status',
    test: '/api/binance/test',
    review: '/api/binance/review'
  },

  strategy: {
    get: '/api/strategy',
    put: '/api/strategy'
  },

  // 策略管理（多策略体系）：列表 / 详情 / 更新（启用+参数）/ 恢复默认
  // 带 :id 的路径由前端 api/client.js 用 `base` 拼接（契约只固化基址）
  strategies: {
    base: '/api/strategies'
  },

  // 模拟账户（paper）：每日趋势为单条 SQL 聚合（服务端 dailyTrend.js）
  //   GET  → 缓存读取；POST → 强制刷新（前端「刷新」按钮）
  paper: {
    dailyTrend: '/api/paper/daily-trend'
  },

  market: {
    symbols: '/api/market/symbols',
    refresh: '/api/market/symbols/refresh',
    status: '/api/market/symbols/status',
    klines: '/api/market/klines'
  },

  history: {
    fetch: '/api/history/fetch',
    klines: '/api/history/klines',
    summary: '/api/history/summary',
    syncStatus: '/api/history/sync/status',
    syncStart: '/api/history/sync/start',
    syncStop: '/api/history/sync/stop'
  }
};

/**
 * 长耗时接口基线超时（毫秒）
 * - 分析类任务（research / performance refresh / history fetch）可能跑数分钟
 * - 普通请求 45s 足够
 */
export const TIMEOUT = {
  short: 45000,
  analyze: 180000,
  longRunning: 1800000
};

/** 判断某路径是否应走长耗时超时档 */
export function timeoutFor(path) {
  if (path.includes('analyze-') || path === API.history.fetch || path.includes('performance/refresh')) return TIMEOUT.longRunning;
  if (path.includes('analyze') || path.includes('/binance/review')) return TIMEOUT.analyze;
  return TIMEOUT.short;
}

/** @typedef {Object} HealthResponse
 *  @property {boolean} ok
 *  @property {string} name
 */

/** @typedef {Object} BinanceTestResponse
 *  @property {boolean} ok
 *  @property {boolean} testnet
 *  @property {number} totalEquity
 *  @property {number} activePositions
 *  @property {'hedge'|'one-way'} positionMode
 */
