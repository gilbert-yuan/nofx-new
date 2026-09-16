import { BinanceClient } from './binanceClient.js';
import { binanceMarket } from './binanceMarket.js';
// 环境判定/凭证解析的唯一实现在 shared/binanceEnvironment.js；这里 re-export 保持旧引用（含测试）兼容。
import { isBinanceDemo, binanceEnvironmentConfig } from '../shared/binanceEnvironment.js';
export { binanceEnvironmentConfig };

export const BINANCE_SYNC_ENVIRONMENTS = ['demo', 'live'];
const CLOSE_ACTIVE = new Set(['submitting', 'submitted', 'new', 'partially_filled', 'unknown']);
const CLOSE_TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'skipped_no_fill']);
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

const environmentToggle = environment => environment === 'demo'
  ? 'syncPaperOrdersToDemo'
  : 'syncPaperOrdersToLive';
const environmentPrefix = environment => environment === 'demo' ? 'demo' : 'live';
const environmentLabel = environment => environment === 'demo' ? 'Demo' : '实盘';

export function binanceSyncEnabled(config = {}, environment = 'demo') {
  return config?.trader?.[environmentToggle(environment)] === true;
}

export function binanceEnvironmentHasCredentials(config = {}, environment = 'demo') {
  const resolved = binanceEnvironmentConfig(config, environment);
  return Boolean(resolved.apiKey && resolved.secretKey);
}

export function paperClientOrderId(order, environment = 'demo') {
  const base = String(order.id).replaceAll('-', '').slice(0, 20);
  return (environment === 'demo' ? 'nofxpaper' : 'nofxlive') + base;
}

export function paperCloseClientOrderId(order, environment, sequence) {
  const base = String(order.id).replaceAll('-', '').slice(0, 16);
  return ((environment === 'demo' ? 'nofxpaper' : 'nofxlive') + base + 'c' + String(sequence).padStart(2, '0')).slice(0, 36);
}

export function createExchangeSyncState(environment) {
  return {
    environment,
    provider: 'binance-' + environment,
    status: 'not_submitted',
    clientOrderId: null,
    orderId: null,
    origQty: null,
    executedQty: 0,
    avgPrice: null,
    price: null,
    submittedAt: null,
    lastSyncedAt: null,
    lastError: '',
    retryAt: null,
    retryCount: 0,
    closeOrders: []
  };
}

function copyLegacyDemoState(legacy) {
  if (!legacy || typeof legacy !== 'object') return null;
  return {
    ...createExchangeSyncState('demo'),
    ...legacy,
    environment: 'demo',
    provider: legacy.provider || 'binance-demo',
    closeOrders: Array.isArray(legacy.closeOrders) ? legacy.closeOrders : []
  };
}

/**
 * Normalize old single-environment order metadata into the new two-environment
 * shape. exchange remains a Demo compatibility alias for existing UI/tests.
 */
export function ensureExchangeSync(order) {
  if (!order || typeof order !== 'object') return {};
  if (!order.exchangeSync || typeof order.exchangeSync !== 'object') order.exchangeSync = {};
  const legacyDemo = copyLegacyDemoState(order.exchange);
  for (const environment of BINANCE_SYNC_ENVIRONMENTS) {
    const current = order.exchangeSync[environment];
    order.exchangeSync[environment] = current && typeof current === 'object'
      ? { ...createExchangeSyncState(environment), ...current, environment, provider: current.provider || 'binance-' + environment,
          closeOrders: Array.isArray(current.closeOrders) ? current.closeOrders : [] }
      : environment === 'demo' && legacyDemo
        ? legacyDemo
        : createExchangeSyncState(environment);
  }
  mirrorLegacyDemo(order);
  return order.exchangeSync;
}

export function mirrorLegacyDemo(order) {
  if (!order?.exchangeSync?.demo) return order;
  order.exchange = { ...order.exchangeSync.demo, closeOrders: order.exchangeSync.demo.closeOrders || [] };
  return order;
}

function normalizeStatus(value, fallback = 'unknown') {
  return String(value || fallback).toLowerCase();
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function floorStep(value, step) {
  return Number((Math.floor((value + step * 1e-9) / step) * step).toFixed(12));
}

function errorRetryAt(target) {
  const retryCount = Math.min(Number(target.retryCount || 0) + 1, 6);
  target.retryCount = retryCount;
  return Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (retryCount - 1));
}

function isRetryDue(target) {
  return !target?.retryAt || Date.parse(target.retryAt) <= Date.now();
}

function isUnknownExecution(error) {
  return Number(error?.status) === 503
    || /unknown error|execution status is unknown|timed out/i.test(String(error?.message || ''));
}

// 确定性失败：目标环境（Demo/实盘）的 exchangeInfo 里没有该合约。
// 典型场景：实盘已上线、Demo 未同步的合约（含中文 ticker 的 meme 永续，
// 如 龙虾USDT / 牛来USDT / 我踏马来了USDT —— 币安合法 symbol，非脏数据）。
// 这类错误重试永远不会成功，必须与瞬时错误区分开。
function isUnsupportedSymbolError(error) {
  return /不支持合约|Invalid symbol/i.test(String(error?.message || error || ''));
}

function shortError(error) {
  return String(error?.message || error || 'Binance 同步失败').slice(0, 500);
}

function applyOrderResult(target, result, now = new Date().toISOString()) {
  target.status = normalizeStatus(result.status, target.status || 'unknown');
  target.orderId = result.orderId ?? target.orderId ?? null;
  target.clientOrderId = result.clientOrderId || target.clientOrderId || null;
  target.origQty = finiteNumber(result.origQty ?? result.origQuantity, target.origQty);
  target.executedQty = finiteNumber(result.executedQty, target.executedQty || 0);
  target.avgPrice = finiteNumber(result.avgPrice, target.avgPrice);
  target.price = finiteNumber(result.price, target.price);
  target.updateTime = finiteNumber(result.updateTime ?? result.time, target.updateTime);
  target.lastSyncedAt = now;
  target.lastError = '';
  target.retryAt = null;
  target.retryCount = 0;
  return target;
}

function applyCloseResult(action, result, now = new Date().toISOString()) {
  action.status = normalizeStatus(result.status, action.status || 'unknown');
  action.orderId = result.orderId ?? action.orderId ?? null;
  action.clientOrderId = result.clientOrderId || action.clientOrderId || null;
  action.origQty = finiteNumber(result.origQty ?? result.origQuantity, action.origQty);
  action.executedQty = finiteNumber(result.executedQty, action.executedQty || 0);
  action.avgPrice = finiteNumber(result.avgPrice, action.avgPrice);
  action.updateTime = finiteNumber(result.updateTime ?? result.time, action.updateTime);
  action.lastSyncedAt = now;
  action.lastError = '';
  action.retryAt = null;
  action.retryCount = 0;
  return action;
}

async function loadSymbolInfo(client, symbol) {
  const info = await client.exchangeInfo();
  const symbolInfo = (info.symbols || []).find(item => item.symbol === symbol);
  if (!symbolInfo || symbolInfo.status !== 'TRADING' || symbolInfo.contractType !== 'PERPETUAL' || symbolInfo.quoteAsset !== 'USDT') {
    throw new Error('Binance 未找到可交易的 ' + symbol + ' USDT 永续合约。');
  }
  return symbolInfo;
}

export async function paperLimitParams(order, client, environment = 'demo', leverageCache = new Map()) {
  const rawPrice = Number(order.plan?.entryLimit);
  const rawQuantity = Number(order.notional) / rawPrice;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0 || !Number.isFinite(rawQuantity) || rawQuantity <= 0) {
    throw new Error('模拟订单缺少有效 entryLimit 或数量，无法同步 Binance ' + environmentLabel(environment) + '。');
  }
  const info = await client.exchangeInfo();
  const symbolInfo = (info.symbols || []).find(item => item.symbol === order.symbol);
  if (!symbolInfo || symbolInfo.status !== 'TRADING' || symbolInfo.contractType !== 'PERPETUAL' || symbolInfo.quoteAsset !== 'USDT') {
    throw new Error('Binance ' + environmentLabel(environment) + ' 不支持合约 ' + order.symbol + '，已跳过同步。');
  }
  if (!leverageCache.has(order.symbol) && typeof client.leverageBracket === 'function') {
    try {
      const response = await client.leverageBracket({ symbol: order.symbol });
      const row = Array.isArray(response) ? response[0] : response;
      const maxLeverage = Number(row?.brackets?.[0]?.initialLeverage || row?.maxLeverage);
      if (Number.isFinite(maxLeverage) && maxLeverage > 0) leverageCache.set(order.symbol, maxLeverage);
    } catch (error) {
      console.warn('[paper-sync] ' + environmentLabel(environment) + ' leverageBracket unavailable:', shortError(error));
    }
  }
  const fallbackLeverage = Number(symbolInfo.filters?.find(filter => filter.filterType === 'LEVERAGE_FILTER')?.maxLeverage);
  if (!leverageCache.has(order.symbol) && Number.isFinite(fallbackLeverage) && fallbackLeverage > 0) leverageCache.set(order.symbol, fallbackLeverage);

  const priceFilter = symbolInfo.filters?.find(item => item.filterType === 'PRICE_FILTER');
  const lotFilter = symbolInfo.filters?.find(item => item.filterType === 'LOT_SIZE' || item.filterType === 'MARKET_LOT_SIZE');
  const minNotional = Number(symbolInfo.filters?.find(item => item.filterType === 'MIN_NOTIONAL')?.notional || 0);
  const side = order.direction === 'OPEN_LONG' ? 'BUY' : 'SELL';
  const priceStep = Number(priceFilter?.tickSize);
  const quantityStep = Number(lotFilter?.stepSize);
  if (!(priceStep > 0) || !(quantityStep > 0)) throw new Error('Binance ' + environmentLabel(environment) + ' 未返回 ' + order.symbol + ' 的价格/数量过滤器。');
  const price = side === 'BUY' ? floorStep(rawPrice, priceStep) : Number((Math.ceil((rawPrice - priceStep * 1e-9) / priceStep) * priceStep).toFixed(12));
  const quantity = floorStep(rawQuantity, quantityStep);
  if (!(price > 0) || !(quantity > 0) || quantity < Number(lotFilter.minQty || 0) || (minNotional > 0 && quantity * price < minNotional)) {
    throw new Error('模拟订单 ' + order.symbol + ' 对齐 Binance ' + environmentLabel(environment) + ' 过滤器后低于最小下单要求。');
  }
  return { symbol: order.symbol, side, quantity, price };
}

export async function safeSetLeverageForEnvironment(client, symbol, desired, leverageCache = new Map(), environment = 'demo') {
  if (typeof client.setLeverage !== 'function') return desired;
  const cached = Number(leverageCache.get(symbol));
  const start = cached > 0 ? Math.min(desired, cached) : desired;
  const ladder = [start];
  for (const value of [10, 5, 3, 2, 1]) if (value < start) ladder.push(value);
  const tries = Array.from(new Set(ladder)).sort((a, b) => b - a);
  let lastError;
  for (const leverage of tries) {
    try {
      await client.setLeverage({ symbol, leverage });
      leverageCache.set(symbol, leverage);
      if (environment === 'demo') binanceMarket.applyDemoLeverage([{ symbol, maxLeverage: leverage }]);
      return leverage;
    } catch (error) {
      const message = shortError(error);
      if (!/leverage/i.test(message) || !/(not valid|exceed|max|invalid)/i.test(message)) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('币种 ' + symbol + ' 无法设置杠杆 ' + desired);
}

export async function safeSetLeverage(client, symbol, desired) {
  const cache = new Map();
  const cached = binanceMarket.getMaxLeverage(symbol);
  if (cached) cache.set(symbol, cached);
  return safeSetLeverageForEnvironment(client, symbol, desired, cache, 'demo');
}

function closeActionFromEvent(order, event, environment) {
  const closeOrders = ensureExchangeSync(order)[environment].closeOrders || [];
  const sequence = closeOrders.length;
  return {
    id: event.actionId || ('close-' + String(order.id) + '-' + String(event.reason || 'paper') + '-' + String(event.paperQuantity || order.quantity || 0)),
    reason: event.reason || 'paper_close',
    paperQuantity: finiteNumber(event.paperQuantity, finiteNumber(order.quantity, 0)),
    originalPaperQuantity: finiteNumber(event.originalPaperQuantity, finiteNumber(order.quantity, 0) + finiteNumber(order.realizedQty, 0)),
    status: 'not_requested',
    clientOrderId: event.clientOrderId || paperCloseClientOrderId(order, environment, sequence),
    orderId: null,
    origQty: null,
    executedQty: 0,
    avgPrice: null,
    requestedAt: null,
    lastSyncedAt: null,
    lastError: '',
    retryAt: null,
    retryCount: 0
  };
}

function linkHasRemoteOrder(link) {
  return Boolean(link && (link.orderId || link.clientOrderId) && !['not_submitted', 'not_configured', 'skipped_closed'].includes(link.status));
}

function linkCanRetry(link) {
  return isRetryDue(link) && !['filled', 'canceled', 'cancelled', 'expired'].includes(link.status);
}

export class BinancePaperSync {
  constructor({ simulation, store, clientFactory = config => new BinanceClient(config), intervalMs = process.env.BINANCE_PAPER_SYNC_INTERVAL_MS } = {}) {
    this.simulation = simulation;
    this.store = store;
    this.clientFactory = clientFactory;
    const requested = Number(intervalMs);
    this.intervalMs = Number.isFinite(requested) ? Math.min(60000, Math.max(2000, requested)) : 5000;
    this.pending = new Map();
    this.drainPromise = null;
    this.timer = null;
    this.started = false;
    this.lastPollAt = null;
    this.lastError = '';
    this.leverageCaches = { demo: new Map(), live: new Map() };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedulePoll(250);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status() {
    return {
      started: this.started,
      pending: this.pending.size,
      running: Boolean(this.drainPromise),
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError
    };
  }

  enqueue(orderId, event = { type: 'submit' }) {
    if (!orderId) return;
    const item = this.pending.get(orderId) || { submit: false, cancel: false, pull: false, closeActions: new Map() };
    if (event.type === 'close') {
      const actionId = event.actionId || ('close-' + orderId + '-' + String(event.reason || 'paper'));
      item.closeActions.set(actionId, { ...event, actionId });
    } else if (event.type === 'cancel') {
      item.cancel = true;
    } else if (event.type === 'pull') {
      item.pull = true;
    } else {
      item.submit = true;
    }
    this.pending.set(orderId, item);
    void this.drain().catch(error => {
      this.lastError = shortError(error);
      console.error('[paper-sync] queue failed:', this.lastError);
    });
  }

  async flush() {
    while (this.pending.size || this.drainPromise) {
      if (this.drainPromise) await this.drainPromise;
      else await this.drain();
    }
  }

  schedulePoll(delay = this.intervalMs) {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().catch(error => {
        this.lastError = shortError(error);
        console.error('[paper-sync] poll failed:', this.lastError);
      });
    }, delay);
    this.timer.unref?.();
  }

  async poll() {
    if (!this.started) return;
    this.lastPollAt = new Date().toISOString();
    try {
      const config = await this.store?.getConfig?.() || {};
      const enabledEnvironments = BINANCE_SYNC_ENVIRONMENTS.filter(environment =>
        binanceSyncEnabled(config, environment) && binanceEnvironmentHasCredentials(config, environment));
      if (!enabledEnvironments.length) return;
      const state = await this.simulation.exchangeSyncOrders();
      for (const order of state.orders || []) {
        for (const environment of enabledEnvironments) {
          const link = ensureExchangeSync(order)[environment];
          if (order.status === 'pending' && (!linkHasRemoteOrder(link) || link.status === 'submit_error' || link.status === 'not_configured') && linkCanRetry(link)) {
            this.enqueue(order.id, { type: 'submit' });
          }
          if (order.status === 'closed' && ['not_submitted', 'submit_error', 'not_configured', 'unknown'].includes(link.status)
            && (link.closeOrders || []).some(action => !CLOSE_TERMINAL.has(action.status) && isRetryDue(action))) {
            this.enqueue(order.id, { type: 'submit' });
          }
          if (['cancelled', 'expired'].includes(order.status) && linkHasRemoteOrder(link) && !['canceled', 'cancelled', 'expired', 'cancel_error'].includes(link.status)) {
            // cancel_error：撤单已失败，按「失败不重试」策略不再重新入队，保留状态与错误信息供人工排查。
            this.enqueue(order.id, { type: 'cancel' });
          }
          if (order.status === 'closed' && (link.status === 'filled' || Number(link.executedQty) > 0) && !(link.closeOrders || []).length) {
            this.enqueue(order.id, {
              type: 'close',
              actionId: 'close-' + order.id + '-' + String(order.exitAt || order.reason || 'paper'),
              reason: order.reason || 'paper_close',
              paperQuantity: finiteNumber(order.quantity, 0),
              originalPaperQuantity: finiteNumber(order.quantity, 0) + finiteNumber(order.realizedQty, 0)
            });
          }
          if (linkHasRemoteOrder(link) || (link.closeOrders || []).some(action =>
            (!CLOSE_TERMINAL.has(action.status) && isRetryDue(action)) || CLOSE_ACTIVE.has(action.status) || action.status === 'submit_error')) {
            this.enqueue(order.id, { type: 'pull' });
          }
        }
      }
      await this.drain();
    } finally {
      this.schedulePoll();
    }
  }

  async drain() {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = (async () => {
      while (this.pending.size) {
        const [orderId, item] = this.pending.entries().next().value;
        this.pending.delete(orderId);
        try {
          await this.process(orderId, item);
        } catch (error) {
          this.lastError = shortError(error);
          console.error('[paper-sync] order ' + orderId + ' failed:', this.lastError);
        }
      }
    })().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  async process(orderId, item) {
    if (item.closeActions.size) await this.registerCloseActions(orderId, [...item.closeActions.values()]);
    let order = await this.simulation.getOrder(orderId);
    if (!order || order.marketProvider !== 'binance') return;
    const config = await this.store?.getConfig?.() || {};

    for (const environment of BINANCE_SYNC_ENVIRONMENTS) {
      if (!binanceSyncEnabled(config, environment)) continue;
      const environmentConfig = binanceEnvironmentConfig(config, environment);
      if (!environmentConfig.apiKey || !environmentConfig.secretKey) {
        await this.updateLink(orderId, environment, link => {
          if (link.status === 'not_submitted' || link.status === 'submit_error' || link.status === 'not_configured') {
            link.status = 'not_configured';
            link.lastError = '未配置 Binance ' + environmentLabel(environment) + ' API Key / Secret Key。';
          }
        });
        continue;
      }
      const client = this.clientFactory(environmentConfig);
      const link = ensureExchangeSync(order)[environment];

      if (item.submit && ['pending', 'closed'].includes(order.status) && ['not_submitted', 'submit_error', 'not_configured', 'unknown'].includes(link.status) && linkCanRetry(link)) {
        await this.submitEntry(order, environment, client);
        order = await this.simulation.getOrder(orderId);
      }

      if ((item.cancel || ['cancelled', 'expired'].includes(order.status)) && linkHasRemoteOrder(ensureExchangeSync(order)[environment])) {
        await this.cancelEntry(order, environment, client);
        order = await this.simulation.getOrder(orderId);
      }

      await this.pullEntryIfNeeded(order, environment, client);
      order = await this.simulation.getOrder(orderId);

      const currentLink = ensureExchangeSync(order)[environment];
      for (const action of currentLink.closeOrders || []) {
        if (!CLOSE_TERMINAL.has(action.status) && isRetryDue(action)) {
          await this.submitClose(order, environment, client, action);
          order = await this.simulation.getOrder(orderId);
        }
      }
      await this.pullCloseOrders(order, environment, client);
    }

    // 环境错配自愈：所有「已启用同步且已配置凭证」的环境都判定不支持该合约时，
    // 这笔挂单永远不可能镜像到任何交易所，立即取消终态化 ——
    // 否则会以 pending 滞留在复核循环里（历史上曾出现 7 笔滞留一天以上的死单）。
    if (order && order.status === 'pending') {
      const links = ensureExchangeSync(order);
      const enabledEnvs = BINANCE_SYNC_ENVIRONMENTS.filter(env =>
        binanceSyncEnabled(config, env) && binanceEnvironmentHasCredentials(config, env));
      if (enabledEnvs.length > 0 && enabledEnvs.every(env => links[env]?.status === 'unsupported_symbol')) {
        const cancelledAt = new Date().toISOString();
        await this.simulation.mutateLight(state => {
          const target = state.orders.find(item => item.id === orderId);
          if (!target || target.status !== 'pending') return;
          target.status = 'cancelled';
          target.reason = 'exchange_unsupported';
          target.error = links[enabledEnvs[0]]?.lastError || '目标交易环境不支持该合约。';
          target.cancelledAt = cancelledAt;
        });
        console.warn(`[paper-sync] ${order.symbol} 所有启用环境均不支持该合约，挂单已自动取消（exchange_unsupported）。`);
      }
    }
  }

  async registerCloseActions(orderId, events) {
    await this.simulation.mutateLight(state => {
      const order = state.orders.find(item => item.id === orderId);
      if (!order) return;
      const links = ensureExchangeSync(order);
      for (const environment of BINANCE_SYNC_ENVIRONMENTS) {
        const link = links[environment];
        for (const event of events) {
          const action = closeActionFromEvent(order, event, environment);
          if (!(link.closeOrders || []).some(existing => existing.id === action.id)) link.closeOrders.push(action);
        }
      }
      mirrorLegacyDemo(order);
    }, { exchangeSync: true });
  }

  async submitEntry(order, environment, client) {
    const links = ensureExchangeSync(order);
    const link = links[environment];
    if (!['pending', 'closed'].includes(order.status) || ['filled', 'new', 'partially_filled', 'submitted'].includes(link.status)) return;
    const clientOrderId = link.clientOrderId || paperClientOrderId(order, environment);
    if (link.status === 'unknown') {
      const existing = await this.findExistingOrder(client, order.symbol, clientOrderId);
      if (existing) {
        await this.updateLink(order.id, environment, current => applyOrderResult(current, existing, new Date().toISOString()));
        return;
      }
    }
    await this.updateLink(order.id, environment, current => {
      current.clientOrderId = clientOrderId;
      current.status = 'submitting';
      current.submittedAt = current.submittedAt || new Date().toISOString();
      current.lastError = '';
    });
    try {
      const params = await paperLimitParams(order, client, environment, this.leverageCaches[environment]);
      await safeSetLeverageForEnvironment(client, order.symbol, order.leverage, this.leverageCaches[environment], environment);
      const result = await client.limitOrder({ ...params, timeInForce: 'GTC', clientOrderId });
      await this.updateLink(order.id, environment, current => applyOrderResult(current, result, new Date().toISOString()));
    } catch (error) {
      const resolved = isUnknownExecution(error) ? await this.findExistingOrder(client, order.symbol, clientOrderId) : null;
      if (resolved) {
        await this.updateLink(order.id, environment, current => applyOrderResult(current, resolved, new Date().toISOString()));
        return;
      }
      await this.updateLink(order.id, environment, current => {
        if (isUnsupportedSymbolError(error)) {
          // 环境无此合约：确定性失败，置终态不再重试（否则每轮 backoff 重试、订单永久滞留 pending）。
          current.status = 'unsupported_symbol';
          current.lastError = shortError(error);
          current.retryAt = null;
          return;
        }
        current.status = isUnknownExecution(error) ? 'unknown' : 'submit_error';
        current.lastError = shortError(error);
        current.retryAt = new Date(errorRetryAt(current)).toISOString();
      });
    }
  }

  async findExistingOrder(client, symbol, clientOrderId) {
    if (!clientOrderId || typeof client.order !== 'function') return null;
    try { return await client.order({ symbol, clientOrderId }); } catch { return null; }
  }

  async pullEntryIfNeeded(order, environment, client) {
    const link = ensureExchangeSync(order)[environment];
    if (!linkHasRemoteOrder(link) || !['submitting', 'submitted', 'new', 'partially_filled', 'unknown', 'cancel_requested'].includes(link.status)) return;
    if (typeof client.order !== 'function') return;
    try {
      const result = await client.order({ symbol: order.symbol, orderId: link.orderId, clientOrderId: link.orderId ? undefined : link.clientOrderId });
      await this.updateLink(order.id, environment, current => applyOrderResult(current, result, new Date().toISOString()));
    } catch (error) {
      await this.updateLink(order.id, environment, current => {
        current.lastError = shortError(error);
        current.retryAt = new Date(errorRetryAt(current)).toISOString();
      });
    }
  }

  async cancelEntry(order, environment, client) {
    const link = ensureExchangeSync(order)[environment];
    // cancel_error 属终态（失败不重试）：避免历史残留单（远端订单已不存在）每轮轮询无限重发撤单请求。
    if (!linkHasRemoteOrder(link) || ['filled', 'canceled', 'cancelled', 'expired', 'cancel_error'].includes(link.status)) return;
    await this.updateLink(order.id, environment, current => {
      current.status = 'cancel_requested';
      current.lastError = '';
    });
    try {
      const result = await client.cancelOrder({ symbol: order.symbol, orderId: link.orderId, clientOrderId: link.clientOrderId });
      await this.updateLink(order.id, environment, current => applyOrderResult(current, result, new Date().toISOString()));
    } catch (error) {
      await this.updateLink(order.id, environment, current => {
        current.status = 'cancel_error';
        current.lastError = shortError(error);
        current.retryAt = new Date(errorRetryAt(current)).toISOString();
      });
    }
  }

  async submitClose(order, environment, client, action) {
    let link = ensureExchangeSync(order)[environment];
    if (CLOSE_TERMINAL.has(action.status) || !isRetryDue(action)) return;
    if (!linkHasRemoteOrder(link)) {
      await this.updateCloseAction(order.id, environment, action.id, current => {
        current.status = 'skipped_no_fill';
        current.lastError = '入口单尚未在 Binance ' + environmentLabel(environment) + ' 成交，未发送平仓单。';
      });
      return;
    }
    if (['new', 'submitted', 'partially_filled', 'cancel_requested', 'submitting'].includes(link.status)) {
      await this.cancelEntry(order, environment, client);
      order = await this.simulation.getOrder(order.id);
      link = ensureExchangeSync(order)[environment];
    }
    const entryStatus = link.status;
    if (!['filled', 'partially_filled'].includes(entryStatus) && !(Number(link.executedQty) > 0)) {
      await this.updateCloseAction(order.id, environment, action.id, current => {
        current.status = 'skipped_no_fill';
        current.lastError = '入口单没有已成交数量，未发送平仓单。';
      });
      return;
    }
    const entryQty = Number(link.executedQty || link.origQty);
    const paperQuantity = Number(action.paperQuantity);
    const originalPaperQuantity = Number(action.originalPaperQuantity) || paperQuantity;
    const ratio = originalPaperQuantity > 0 ? Math.min(1, Math.max(0, paperQuantity / originalPaperQuantity)) : 1;
    const requestedQuantity = entryQty > 0 ? entryQty * ratio : Number(order.quantity);
    const symbolInfo = await loadSymbolInfo(client, order.symbol);
    const lotFilter = symbolInfo.filters?.find(item => item.filterType === 'LOT_SIZE' || item.filterType === 'MARKET_LOT_SIZE');
    const step = Number(lotFilter?.stepSize);
    const minQty = Number(lotFilter?.minQty || 0);
    const quantity = step > 0 ? floorStep(requestedQuantity, step) : requestedQuantity;
    if (!(quantity > 0) || quantity < minQty) {
      await this.updateCloseAction(order.id, environment, action.id, current => {
        current.status = 'skipped_no_fill';
        current.lastError = '平仓数量对齐 Binance ' + environmentLabel(environment) + ' 过滤器后低于最小下单数量。';
      });
      return;
    }
    const side = order.direction === 'OPEN_LONG' ? 'SELL' : 'BUY';
    const prepared = await this.updateCloseAction(order.id, environment, action.id, current => {
      current.status = 'submitting';
      current.requestedAt = current.requestedAt || new Date().toISOString();
      current.clientOrderId = current.clientOrderId || paperCloseClientOrderId(order, environment, (link.closeOrders || []).findIndex(item => item.id === action.id));
      current.paperQuantity = paperQuantity;
      current.remoteQuantity = quantity;
      current.lastError = '';
    });
    const clientOrderId = prepared?.clientOrderId || action.clientOrderId || paperCloseClientOrderId(order, environment, 0);
    try {
      const result = await client.marketOrder({
        symbol: order.symbol,
        side,
        quantity,
        reduceOnly: true,
        clientOrderId
      });
      await this.updateCloseAction(order.id, environment, action.id, current => applyCloseResult(current, result, new Date().toISOString()));
    } catch (error) {
      const resolved = isUnknownExecution(error) ? await this.findExistingOrder(client, order.symbol, clientOrderId) : null;
      if (resolved) {
        await this.updateCloseAction(order.id, environment, action.id, current => applyCloseResult(current, resolved, new Date().toISOString()));
        return;
      }
      await this.updateCloseAction(order.id, environment, action.id, current => {
        current.status = isUnknownExecution(error) ? 'unknown' : 'submit_error';
        current.lastError = shortError(error);
        current.retryAt = new Date(errorRetryAt(current)).toISOString();
      });
    }
  }

  async pullCloseOrders(order, environment, client) {
    const link = ensureExchangeSync(order)[environment];
    if (typeof client.order !== 'function') return;
    for (const action of link.closeOrders || []) {
      if (!CLOSE_ACTIVE.has(action.status) || !(action.orderId || action.clientOrderId)) continue;
      try {
        const result = await client.order({
          symbol: order.symbol,
          orderId: action.orderId,
          clientOrderId: action.orderId ? undefined : action.clientOrderId
        });
        await this.updateCloseAction(order.id, environment, action.id, current => applyCloseResult(current, result, new Date().toISOString()));
      } catch (error) {
        await this.updateCloseAction(order.id, environment, action.id, current => {
          current.lastError = shortError(error);
          current.retryAt = new Date(errorRetryAt(current)).toISOString();
        });
      }
    }
  }

  async updateLink(orderId, environment, update) {
    return this.simulation.mutateLight(state => {
      const order = state.orders.find(item => item.id === orderId);
      if (!order) return null;
      const link = ensureExchangeSync(order)[environment];
      update(link, order);
      mirrorLegacyDemo(order);
      return link;
    }, { exchangeSync: true });
  }

  async updateCloseAction(orderId, environment, actionId, update) {
    return this.simulation.mutateLight(state => {
      const order = state.orders.find(item => item.id === orderId);
      if (!order) return null;
      const link = ensureExchangeSync(order)[environment];
      const action = (link.closeOrders || []).find(item => item.id === actionId);
      if (!action) return null;
      update(action, order, link);
      mirrorLegacyDemo(order);
      return action;
    }, { exchangeSync: true });
  }
}
