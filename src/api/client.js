/**
 * 契约驱动的类型化 API 客户端（前端单一出口）
 * - 路径全部来自 shared/api-contract.js，杜绝字符串硬编码漂移
 * - 底层复用既有 api() 传输层（超时/取消/错误规范化）
 * - 研究类接口（/analyses、/market/analyze-*）暂未纳入契约，仍走 api() 原路径
 */
import { API } from '../../shared/api-contract.js';
import { api } from '../api.js';

/** 剔除 undefined/null 的查询参数 */
function qs(params = {}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.append(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const configApi = {
  get: () => api(API.config.get),
  put: (body) => api(API.config.put, { method: 'PUT', body })
};

export const strategyApi = {
  get: () => api(API.strategy.get),
  put: (body) => api(API.strategy.put, { method: 'PUT', body })
};

/** 策略管理（多策略体系）：启用勾选 + 参数覆盖 + 恢复默认 */
export const strategiesApi = {
  list: () => api(API.strategies.base),
  detail: (id) => api(`${API.strategies.base}/${encodeURIComponent(id)}`),
  update: (id, body) => api(`${API.strategies.base}/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  reset: (id) => api(`${API.strategies.base}/${encodeURIComponent(id)}/reset`, { method: 'POST' })
};

/** 模拟账户：每日趋势（服务端单条 SQL 聚合；refresh=true 走 POST 强制刷新） */
export const paperApi = {
  dailyTrend: (refresh = false) => api(API.paper.dailyTrend, refresh ? { method: 'POST' } : {})
};

export const binanceApi = {
  status: () => api(API.binance.status),
  test: () => api(API.binance.test, { method: 'POST' }),
  review: () => api(API.binance.review, { method: 'POST' })
};

export const marketApi = {
  symbols: () => api(API.market.symbols),
  refresh: () => api(API.market.refresh, { method: 'POST' }),
  status: () => api(API.market.status),
  klines: (params) => api(`${API.market.klines}${qs(params)}`)
};

export const historyApi = {
  fetch: (body) => api(API.history.fetch, { method: 'POST', body }),
  klines: (params) => api(`${API.history.klines}${qs(params)}`),
  summary: () => api(API.history.summary),
  syncStatus: () => api(API.history.syncStatus),
  syncStart: () => api(API.history.syncStart, { method: 'POST' }),
  syncStop: () => api(API.history.syncStop, { method: 'POST' })
};
