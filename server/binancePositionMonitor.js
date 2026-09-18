import { randomUUID } from 'node:crypto';
import { BinanceClient } from './binanceClient.js';
import { BinanceMarket } from './binanceMarket.js';
import { marketData } from './marketData.js';
import { makeDecision, reviewPosition } from './ai.js';
import { candleOpenAt, prepareMarket } from './research.js';
import { validateOrder } from './risk.js';
import { isBinanceDemo } from '../shared/binanceEnvironment.js';
import {
  acquireBinanceExecutionLock,
  assertBinanceExecutionLock,
  createExecutionOwner,
  deterministicBinanceClientOrderId,
  executionLockKey,
  releaseBinanceExecutionLock,
  startBinanceExecutionLease
} from './binanceExecutionGuard.js';

const owned = order => String(order.clientAlgoId || '').startsWith('nofx');
const id = () => `nofx${randomUUID().replaceAll('-', '').slice(0, 28)}`;
const reject = reason => ({ status: 'rejected', reason });
const positionLifecycle = (position, fallback = 'active') => String(
  position?.entryTime ?? position?.entryTimestamp ?? position?.entryPrice ?? position?.avgEntryPrice ?? fallback
);
const protectionMatchesPosition = (order, { positionSide, side }) => {
  const remotePositionSide = String(order?.positionSide || 'BOTH').toUpperCase();
  const expectedPositionSide = String(positionSide || 'BOTH').toUpperCase();
  if (remotePositionSide !== expectedPositionSide) return false;
  const remoteSide = String(order?.side || '').toUpperCase();
  return !remoteSide || remoteSide === String(side || '').toUpperCase();
};

export class BinancePositionMonitor {
  constructor({ store, marketDb, clientFactory = config => new BinanceClient(config), publicMarket = marketData, decide = makeDecision, review = reviewPosition }) {
    Object.assign(this, {
      store, marketDb, clientFactory, publicMarket, decide, review,
      busy: false, lastRunAt: null, lastResult: null, lastError: '',
      executionOwner: createExecutionOwner('position-monitor')
    });
  }
  async status() {
    const state = await this.store.getState();
    return { running: this.busy, lastRunAt: this.lastRunAt, lastResult: this.lastResult, lastError: this.lastError,
      decisions: (state.decisions || []).filter(d => d.type === 'binance-review').slice(0, 10) };
  }
  async reviewAfterKlines({ interval }) {
    if (this.busy) return { status: 'skipped', reason: '持仓复核正在运行。' };
    this.busy = true;
    let result;
    try {
      const config = await this.store.getConfig();
      if (config.trader.exchange !== 'binance' || config.trader.enabled !== true) return this.finish({ status: 'disabled', reason: '币安自动交易未启用。' });
      if (interval !== '15m') return this.finish({ status: 'skipped', reason: '仅在 15 分钟 K 线后复核。' });
      const client = this.clientFactory(config.binance);
      if (!client.hasCredentials()) return this.finish({ status: 'blocked', reason: '请先配置币安 API Key 和 Secret Key。' });
      // 单向 / 双向持仓模式都支持：下单参数由 BinanceClient 的 positionSideFields 自适应
      //（单向用 reduceOnly、双向用 positionSide，二者互斥）。取不到时按单向处理。
      const dualSide = typeof client.dualSidePosition === 'function' ? await client.dualSidePosition() : false;
      const market = new BinanceMarket({ client }); // Execution rules only; candles come from publicMarket.
      const strategy = { ...await this.store.getStrategy(), interval: '15m' };
      const positions = await client.positions();
      const active = positions.filter(p => Number(p.positionAmt) !== 0 && p.symbol.endsWith('USDT'));
      const reviews = [], entries = [];
      for (const position of active) {
        try {
          const candles = await this.candles(market, position.symbol, config);
          const review = await this.review({ config, strategy, position, market: candles });
          reviews.push({ symbol: position.symbol, review, action: await this.applyReview({ client, config, market, candles, position, review }) });
        } catch (error) { reviews.push({ symbol: position.symbol, action: { status: 'error', reason: error.message } }); }
      }
      if (config.trader.allowEntryOrders === true) {
        const candidates = [...new Set(String(config.trader.entrySymbolsText || '').split(',').map(s => s.trim().toUpperCase()))]
          .filter(s => /^[\p{L}\p{N}]+USDT$/u.test(s) && !active.some(p => p.symbol === s)).slice(0, 20);
        const cap = Math.max(1, Math.min(5, Number(config.trader.maxNewEntriesPerCycle) || 1));
        const reserved = [];
        for (const symbol of candidates) {
          if (reserved.length >= cap) break;
          try {
            const candles = await this.candles(market, symbol, config);
            const account = await client.account();
            const freshPositions = [...await client.positions(), ...reserved];
            const decision = await this.decide({ config, strategy, market: candles, account, positions: freshPositions });
            const action = await this.applyEntry({ client, config, market, candles, symbol, decision, account, positions: freshPositions });
            entries.push({ symbol, decision, action });
            if (['sent', 'dry_run'].includes(action.status)) reserved.push({ symbol, positionAmt: action.quantity, markPrice: action.price, positionSide: dualSide ? (decision.action === 'BUY' ? 'LONG' : 'SHORT') : 'BOTH' });
            if (action.status === 'uncertain') break;
          } catch (error) { entries.push({ symbol, action: { status: 'error', reason: error.message } }); break; }
        }
      }
      result = { status: [...reviews, ...entries].some(r => ['error', 'uncertain'].includes(r.action.status)) ? 'attention' : 'ok', reviewed: reviews.length, reviews, entries, dryRun: config.trader.dryRun !== false };
      await this.store.addDecision({ id: randomUUID(), at: new Date().toISOString(), type: 'binance-review', execution: result });
      return this.finish(result);
    } catch (error) {
      this.lastError = error.message;
      return this.finish({ status: 'error', reason: error.message });
    } finally { this.busy = false; }
  }
  finish(result) { this.lastRunAt = new Date().toISOString(); this.lastResult = result; this.lastError = ['error', 'attention'].includes(result.status) ? result.reason || '部分操作需要检查。' : ''; return result; }
  async candles(market, symbol, config) {
    const data = prepareMarket({ symbol, interval: '15m', limit: 80, marketProvider: this.publicMarket.provider, rows: await this.publicMarket.klines({ symbol, interval: '15m', limit: 82 }) });
    await this.marketDb.saveKlines({ symbol: this.publicMarket.storageSymbol(symbol), interval: '15m', rows: data.klines });
    return data;
  }
  async claim(symbol, candles) {
    let accepted = false;
    const key = `${symbol}:${candles.dataAsOf}`;
    await this.store.mutateState(state => {
      const claims = state.binanceClaims || {};
      if (claims[key]) return state;
      accepted = true;
      return { ...state, binanceClaims: { ...Object.fromEntries(Object.entries(claims).slice(-499)), [key]: new Date().toISOString() } };
    });
    return accepted;
  }

  executionEnvironment(config) {
    return isBinanceDemo(config?.binance) ? 'demo' : 'live';
  }

  executionIntentKey(environment, action, symbol, positionSide = 'BOTH') {
    return [environment, action, String(symbol || '').toUpperCase(), String(positionSide || 'BOTH').toUpperCase()].join(':');
  }

  async getExecutionIntent(key) {
    const state = await this.store.getState();
    return state.binanceExecutionIntents?.[key] || null;
  }

  async findExecutionIntent(prefix, statuses) {
    const state = await this.store.getState();
    const allowed = new Set(statuses);
    return Object.entries(state.binanceExecutionIntents || {})
      .find(([key, intent]) => key.startsWith(prefix) && allowed.has(intent?.status));
  }

  async updateExecutionIntent(key, update) {
    return this.store.mutateState(state => {
      const intents = { ...(state.binanceExecutionIntents || {}) };
      const current = intents[key] || {};
      intents[key] = typeof update === 'function' ? update(current) : { ...current, ...update };
      return { ...state, binanceExecutionIntents: Object.fromEntries(Object.entries(intents).slice(-499)) };
    });
  }

  async beginExecutionIntent(key, metadata) {
    let intent;
    await this.store.mutateState(state => {
      const intents = { ...(state.binanceExecutionIntents || {}) };
      const current = intents[key] || {};
      const next = {
        ...current,
        ...metadata,
        clientOrderId: current.clientOrderId || metadata.clientOrderId,
        status: 'submitting',
        submittedAt: current.submittedAt || new Date().toISOString(),
        lastError: '',
        retryAt: null
      };
      intents[key] = next;
      intent = next;
      return { ...state, binanceExecutionIntents: Object.fromEntries(Object.entries(intents).slice(-499)) };
    });
    return intent;
  }

  async findExistingExecution(client, symbol, intent) {
    if (!intent?.clientOrderId || typeof client.order !== 'function') return null;
    try {
      return await client.order({ symbol, clientOrderId: intent.clientOrderId });
    } catch {
      return null;
    }
  }

  async reconcileExecution(client, symbol, key, intent, action) {
    const result = await this.findExistingExecution(client, symbol, intent);
    if (!result) {
      await this.updateExecutionIntent(key, current => ({
        ...current,
        status: 'unknown',
        lastCheckedAt: new Date().toISOString(),
        retryAt: new Date(Date.now() + 15000).toISOString(),
        lastError: '无法确认 Binance 订单状态，暂不重复提交。'
      }));
      return { status: 'uncertain', reason: 'Binance 订单状态未知，暂不重复下单。' };
    }

    const status = String(result.status || '').toUpperCase();
    const normalized = ['FILLED', 'NEW', 'PARTIALLY_FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(status)
      ? status.toLowerCase()
      : 'unknown';
    await this.updateExecutionIntent(key, current => ({
      ...current,
      status: normalized,
      orderId: result.orderId ?? current.orderId ?? null,
      executedQty: Number(result.executedQty ?? current.executedQty ?? 0),
      avgPrice: Number(result.avgPrice ?? current.avgPrice ?? 0) || null,
      lastCheckedAt: new Date().toISOString(),
      lastError: '',
      retryAt: null
    }));
    if (status === 'FILLED') return { status: 'sent', action, orderId: result.orderId, reconciled: true };
    if (['NEW', 'PARTIALLY_FILLED'].includes(status)) return { status: 'uncertain', reason: 'Binance 订单已存在但尚未完全成交。', orderId: result.orderId };
    return { status: 'rejected', reason: `Binance 订单状态为 ${status || '未知'}。`, orderId: result.orderId };
  }

  async withExecutionLock(config, symbol, positionSide, fn) {
    const environment = this.executionEnvironment(config);
    const key = executionLockKey({ environment, symbol, positionSide });
    const lock = await acquireBinanceExecutionLock(this.store, key, this.executionOwner);
    if (!lock.acquired) return { status: 'skipped', reason: '该币种/持仓方向正在由另一个执行任务处理。' };
    const lease = startBinanceExecutionLease(this.store, lock);
    try {
      if (!await assertBinanceExecutionLock(this.store, lock)) return { status: 'skipped', reason: '执行锁已失效，已停止本次下单。' };
      return await fn({ environment, key, lock, lease });
    } finally {
      await lease.stop();
      await releaseBinanceExecutionLock(this.store, lock);
    }
  }

  async submitReduceOnly({ client, config, symbol, positionSide, side, quantity, action = 'emergency_close', reason = '', identity = '' }) {
    const environment = this.executionEnvironment(config);
    const key = this.executionIntentKey(environment, action, symbol, positionSide) + ':' + identity;
    const clientOrderId = deterministicBinanceClientOrderId(action, environment, symbol, positionSide, identity);
    const existing = await this.getExecutionIntent(key);
    if (existing?.status === 'filled') return { status: 'sent', action, orderId: existing.orderId, reconciled: true };
    if (existing && ['submitting', 'submitted', 'new', 'partially_filled', 'unknown'].includes(existing.status)) {
      return this.reconcileExecution(client, symbol, key, existing, action);
    }

    const intent = await this.beginExecutionIntent(key, { action, symbol, positionSide, side, quantity, clientOrderId, reason });
    try {
      const result = await client.marketOrder({ symbol, side, quantity, reduceOnly: true, positionSide, clientOrderId: intent.clientOrderId });
      const status = String(result?.status || 'unknown').toLowerCase();
      await this.updateExecutionIntent(key, current => ({
        ...current,
        status,
        orderId: result?.orderId ?? null,
        executedQty: Number(result?.executedQty || 0),
        avgPrice: Number(result?.avgPrice || 0) || null,
        lastCheckedAt: new Date().toISOString(),
        lastError: '',
        retryAt: null
      }));
      if (status !== 'filled') return { status: 'uncertain', reason: '减仓订单未确认全部成交，请检查 Binance。', orderId: result?.orderId };
      return { status: 'sent', action, orderId: result.orderId };
    } catch (error) {
      const reconciled = await this.reconcileExecution(client, symbol, key, intent, action);
      if (reconciled.status !== 'uncertain') return reconciled;
      throw new Error(`${reason || '减仓'}执行结果未知，请勿重复下单：${error.message}`);
    }
  }
  async applyReview({ client, config, market, candles, position, review }) {
    if (!['CLOSE', 'UPDATE_PROTECTION'].includes(review?.action)) return { status: 'held', reason: review?.reason || '保持持仓。' };
    if (!validConfidence(review.confidence, config.trader.minConfidence)) return reject('置信度无效或低于阈值。');
    if (!fresh(candles)) return reject('分析期间已跨越 K 线周期，请等待下次复核。');
    const current = (await client.positions(position.symbol)).filter(p => Number(p.positionAmt) !== 0);
    const single = current.length === 1 ? current[0] : null;
    const currentAmount = Number(single?.positionAmt);
    const currentSide = String(single?.positionSide || 'BOTH').toUpperCase();
    // 单向账户 positionSide=BOTH；双向账户为 LONG/SHORT，且必须与实际仓位方向一致
    // ——后续平仓单要靠它指明「操作哪一侧」，传错会变成反向开仓。
    const sideConsistent = currentSide === 'BOTH'
      || ((currentSide === 'LONG' || currentSide === 'SHORT') && (currentSide === 'LONG') === (currentAmount > 0));
    if (!single || !Number.isFinite(currentAmount) || !sideConsistent || Math.sign(currentAmount) !== Math.sign(Number(position.positionAmt))) return reject('持仓已变化或仓位方向不一致。');
    position = single;
    const symbol = position.symbol;
    if (!compatibleMarketPrice(candles, Number(position.markPrice))) return reject('币安价格与参考行情偏差超过 2% 或无效，暂停本次操作。');
    if (review.action === 'CLOSE') {
      if (config.trader.allowCloseOrders !== true) return { status: 'proposed', reason: '自动平仓未开启。' };
      if (config.trader.dryRun !== false) return { status: 'dry_run', action: 'CLOSE' };
      const positionSide = String(position.positionSide || 'BOTH').toUpperCase();
      const environment = this.executionEnvironment(config);
      const lifecycle = positionLifecycle(position, candles.dataAsOf);
      const intentKey = this.executionIntentKey(environment, 'close', symbol, positionSide) + ':' + lifecycle;
      const clientOrderId = deterministicBinanceClientOrderId('close', environment, symbol, positionSide, lifecycle);
      const existing = await this.getExecutionIntent(intentKey);
      if (existing?.status === 'filled') return { status: 'sent', action: 'CLOSE', orderId: existing.orderId, reconciled: true };

      return this.withExecutionLock(config, symbol, positionSide, async () => {
        const currentIntent = await this.getExecutionIntent(intentKey);
        if (currentIntent && ['submitting', 'submitted', 'new', 'partially_filled', 'unknown'].includes(currentIntent.status)) {
          return this.reconcileExecution(client, symbol, intentKey, currentIntent, 'CLOSE');
        }
        if (currentIntent?.status === 'submit_error' && Date.parse(currentIntent.retryAt || '') > Date.now()) {
          return { status: 'uncertain', reason: '上一次平仓请求失败，等待退避后重试。' };
        }
        if (!await this.claim(symbol, candles)) return reject('本根 K 线已提交过操作。');
        const intent = await this.beginExecutionIntent(intentKey, {
          action: 'CLOSE', symbol, positionSide,
          side: Number(position.positionAmt) > 0 ? 'SELL' : 'BUY',
          quantity: Math.abs(Number(position.positionAmt)), clientOrderId, lifecycle
        });
        try {
          const result = await client.marketOrder({
            symbol,
            side: Number(position.positionAmt) > 0 ? 'SELL' : 'BUY',
            quantity: Math.abs(Number(position.positionAmt)),
            reduceOnly: true,
            positionSide,
            clientOrderId: intent.clientOrderId
          });
          const status = String(result?.status || 'unknown').toLowerCase();
          await this.updateExecutionIntent(intentKey, current => ({
            ...current,
            status,
            orderId: result?.orderId ?? null,
            executedQty: Number(result?.executedQty || 0),
            avgPrice: Number(result?.avgPrice || 0) || null,
            lastCheckedAt: new Date().toISOString(),
            lastError: '',
            retryAt: null
          }));
          if (status !== 'filled') return { status: 'uncertain', reason: '平仓未确认全部成交，请检查 Binance。', orderId: result?.orderId };
          const closeSide = Number(position.positionAmt) > 0 ? 'SELL' : 'BUY';
          for (const order of (await client.openAlgoOrders(symbol)).filter(item => owned(item)
            && protectionMatchesPosition(item, { positionSide, side: closeSide }))) await client.cancelAlgo(order.algoId);
          return { status: 'sent', action: 'CLOSE', orderId: result.orderId };
        } catch (error) {
          const reconciled = await this.reconcileExecution(client, symbol, intentKey, intent, 'CLOSE');
          return reconciled.status === 'uncertain'
            ? { status: 'uncertain', reason: '平仓结果未知，已停止重复下单。' }
            : reconciled;
        }
      });
    }
    if (config.trader.allowProtectionUpdates !== true) return { status: 'proposed', reason: '保护单调整未开启。' };
    const instrument = (await market.perpetualUsdtContracts()).find(s => s.symbol === symbol);
    const levels = protectionLevels(review, Number(position.markPrice), Number(position.positionAmt) > 0, instrument);
    if (!levels) return reject('止盈止损价格无效或不符合价格步长。');
    if (config.trader.dryRun !== false) return { status: 'dry_run', action: 'UPDATE_PROTECTION', ...levels };
    const positionSide = String(position.positionSide || 'BOTH').toUpperCase();
    return this.withExecutionLock(config, symbol, positionSide, async ({ environment }) => {
      if (!await this.claim(symbol, candles)) return reject('本根 K 线已提交过操作。');
      return this.replaceProtection({
        client, symbol, side: Number(position.positionAmt) > 0 ? 'SELL' : 'BUY', levels,
        minBps: config.trader.minProtectionMoveBps, positionSide, environment
      });
    });
  }
  async replaceProtection({ client, symbol, side, levels, minBps = 25, positionSide, environment = 'live' }) {
    const pending = await client.openAlgoOrders(symbol);
    if (!Array.isArray(pending)) throw new Error('币安保护单快照无效。');
    const relevant = pending.filter(item => protectionMatchesPosition(item, { positionSide, side }));
    if (relevant.some(o => !owned(o))) throw new Error('存在手动保护单，请先在币安检查，系统不会覆盖。');
    for (const type of ['STOP_MARKET', 'TAKE_PROFIT_MARKET']) {
      if (relevant.filter(o => (o.orderType || o.type) === type).length > 1) throw new Error('发现多个同类保护单，请先检查币安订单。');
    }
    for (const [type, triggerPrice] of [['STOP_MARKET', levels.stopLoss], ['TAKE_PROFIT_MARKET', levels.takeProfit]]) {
      const sameType = relevant.filter(o => (o.orderType || o.type) === type);
      if (sameType.some(o => !owned(o))) throw new Error('存在手动保护单，请先在币安检查，系统不会覆盖。');
      if (sameType.length > 1) throw new Error('发现多个同类保护单，请先检查币安订单。');
      const clientAlgoId = deterministicBinanceClientOrderId('protect', environment, symbol, positionSide || 'BOTH', type);
      const previous = sameType.find(item => String(item.clientAlgoId || '') === clientAlgoId) || sameType[0];
      if (previous && Math.abs(Number(previous.triggerPrice) - triggerPrice) / triggerPrice * 10000 < Math.max(0, Number(minBps) || 0)) continue;
      // Establish replacement first: a rejected new stop must never delete the existing stop.
      await client.protectionOrder({ symbol, side, type, triggerPrice, positionSide, clientAlgoId });
      if (previous) await client.cancelAlgo(previous.algoId);
    }
    return { status: 'sent', action: 'UPDATE_PROTECTION', ...levels };
  }
  async applyEntry({ client, config, market, candles, symbol, decision, account, positions }) {
    if (!['BUY', 'SELL'].includes(decision?.action)) return { status: 'held', reason: decision?.reason || '等待信号。' };
    if (config.trader.allowEntryOrders !== true) return reject('自动开仓未开启。');
    if (decision.symbol !== symbol || !fresh(candles)) return reject('币种不符或信号已跨周期。');
    const instrument = (await market.perpetualUsdtContracts()).find(s => s.symbol === symbol);
    const price = Number((await client.price(symbol)).price);
    if (!compatibleMarketPrice(candles, price)) return reject('币安价格与参考行情偏差超过 2% 或无效，暂停本次操作。');
    const quantity = normalizeQuantity(Number(decision.quantity), instrument);
    const levels = protectionLevels(decision, price, decision.action === 'BUY', instrument);
    if (!levels || !quantity) return reject('数量或保护价格不符合币安交易规则。');
    const risk = validateOrder({ order: { symbol, side: decision.action, quantity, leverage: Number(decision.leverage), confidence: Number(decision.confidence) }, config, account, positions, price });
    if (!risk.ok) return reject(risk.reason);
    const minNotional = Number(instrument.filters.find(f => f.filterType === 'MIN_NOTIONAL')?.notional || 0);
    if (quantity * price < minNotional) return reject('订单低于币安最小名义价值。');
    if ((await client.openOrders(symbol)).length || (await client.openAlgoOrders(symbol)).length) return reject('该币种存在挂单，请等待或检查后再开仓。');
    const proposal = { quantity, price, ...levels, leverage: Number(decision.leverage) };
    if (config.trader.dryRun !== false) return { status: 'dry_run', ...proposal };
    // 开仓方向即仓位方向：双向账户必须显式指明（单向账户传 undefined，由交易所默认 BOTH）。
    const dualSide = typeof client.dualSidePosition === 'function' ? await client.dualSidePosition() : false;
    const positionSide = dualSide ? (decision.action === 'BUY' ? 'LONG' : 'SHORT') : undefined;
    const lockPositionSide = positionSide || 'BOTH';
    return this.withExecutionLock(config, symbol, lockPositionSide, async ({ environment }) => {
      if ((positions || []).some(item => item.symbol === symbol && Number(item.positionAmt) !== 0)) {
        return reject('该币种已有活动仓位，跳过重复开仓。');
      }
      const signalIdentity = candles.dataAsOf || String(Date.now());
      const intentPrefix = this.executionIntentKey(environment, 'entry_' + decision.action, symbol, lockPositionSide) + ':';
      const intentKey = intentPrefix + signalIdentity;
      const clientOrderId = deterministicBinanceClientOrderId('entry', environment, symbol, decision.action, lockPositionSide, signalIdentity);
      const protectEntry = async entryResult => {
        try {
          await this.replaceProtection({
            client, symbol, side: decision.action === 'BUY' ? 'SELL' : 'BUY', levels, positionSide, environment
          });
        } catch (error) {
          // A filled entry without confirmed protection is immediately reduced. The
          // emergency close uses its own durable intent and will never be submitted twice.
          const emergency = await this.submitReduceOnly({
            client, config, symbol, positionSide: lockPositionSide,
            side: decision.action === 'BUY' ? 'SELL' : 'BUY',
            quantity: Number(entryResult.executedQty) > 0 ? Number(entryResult.executedQty) : quantity,
            action: 'emergency_close', reason: '保护单设置失败',
            identity: entryResult.clientOrderId || clientOrderId
          });
          if (emergency.status !== 'sent') throw new Error(`保护单设置失败，紧急平仓未确认，请立即检查 ${symbol}：${error.message}`);
          throw new Error(`保护单设置失败，已发送紧急减仓指令，请检查 ${symbol}：${error.message}`);
        }
        return { status: 'sent', ...proposal, orderId: entryResult.orderId, reconciled: Boolean(entryResult.reconciled) };
      };
      const existing = await this.getExecutionIntent(intentKey);
      if (existing?.status === 'filled') return protectEntry({ ...existing, reconciled: true });
      const pending = await this.findExecutionIntent(intentPrefix, ['submitting', 'submitted', 'new', 'partially_filled', 'unknown']);
      if (pending && pending[0] !== intentKey) {
        const recovered = await this.reconcileExecution(client, symbol, pending[0], pending[1], 'ENTRY');
        return recovered.status === 'sent' ? protectEntry({ ...recovered, executedQty: pending[1].executedQty, clientOrderId: pending[1].clientOrderId, reconciled: true }) : recovered;
      }
      if (existing && ['submitting', 'submitted', 'new', 'partially_filled', 'unknown'].includes(existing.status)) {
        const recovered = await this.reconcileExecution(client, symbol, intentKey, existing, 'ENTRY');
        return recovered.status === 'sent' ? protectEntry({ ...recovered, executedQty: existing.executedQty, reconciled: true }) : recovered;
      }
      if (existing?.status === 'submit_error' && Date.parse(existing.retryAt || '') > Date.now()) {
        return { status: 'uncertain', reason: '上一次开仓请求失败，等待退避后重试。' };
      }
      if (!await this.claim(symbol, candles)) return reject('本根 K 线已提交过操作。');

      await client.setLeverage({ symbol, leverage: proposal.leverage });
      const intent = await this.beginExecutionIntent(intentKey, {
        action: 'ENTRY', symbol, positionSide: lockPositionSide,
        side: decision.action, quantity, clientOrderId, signalIdentity
      });
      let result;
      try {
        result = await client.marketOrder({ symbol, side: decision.action, quantity, positionSide, clientOrderId: intent.clientOrderId });
      } catch (error) {
        const recovered = await this.reconcileExecution(client, symbol, intentKey, intent, 'ENTRY');
        return recovered.status === 'sent' ? protectEntry({ ...recovered, executedQty: intent.quantity, clientOrderId: intent.clientOrderId, reconciled: true }) : recovered;
      }

      const entryStatus = String(result?.status || 'unknown').toLowerCase();
      await this.updateExecutionIntent(intentKey, current => ({
        ...current,
        status: entryStatus,
        orderId: result?.orderId ?? null,
        executedQty: Number(result?.executedQty || 0),
        avgPrice: Number(result?.avgPrice || 0) || null,
        lastCheckedAt: new Date().toISOString(),
        lastError: '',
        retryAt: null
      }));
      if (entryStatus !== 'filled') return { status: 'uncertain', reason: '开仓未确认全部成交，请检查 Binance。', orderId: result?.orderId };
      return protectEntry(result);
    });
  }
}

function fresh(market) { return Date.parse(market.dataAsOf) === candleOpenAt(Date.now(), '15m'); }
export function compatibleMarketPrice(candles, price) {
  if (!candles.marketProvider || candles.marketProvider === 'binance') return true;
  const reference = Number(candles.klines?.at(-1)?.close);
  return Number.isFinite(price) && price > 0 && Number.isFinite(reference) && reference > 0 && Math.abs(price / reference - 1) <= 0.02;
}
function validConfidence(value, threshold) { return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1 && Number.isFinite(Number(threshold)) && Number(value) >= Number(threshold); }
function step(value, size) { return Number((Math.floor((value + Number(size) * 1e-9) / Number(size)) * Number(size)).toFixed(12)); }
export function normalizeQuantity(value, instrument) {
  const f = instrument?.filters?.find(f => f.filterType === 'MARKET_LOT_SIZE');
  if (!f || !Number.isFinite(value) || value <= 0 || Number(f.stepSize) <= 0) return 0;
  const quantity = step(value, f.stepSize);
  return quantity >= Number(f.minQty) && quantity <= Number(f.maxQty) ? quantity : 0;
}
export function protectionLevels(value, price, long, instrument) {
  const f = instrument?.filters?.find(f => f.filterType === 'PRICE_FILTER');
  if (!f || Number(f.tickSize) <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const stopLoss = step(Number(value.stopLoss), f.tickSize), takeProfit = step(Number(value.takeProfit), f.tickSize);
  if (![stopLoss, takeProfit].every(v => Number.isFinite(v) && v > 0 && v >= Number(f.minPrice) && v <= Number(f.maxPrice))) return null;
  return (long ? stopLoss < price && price < takeProfit : takeProfit < price && price < stopLoss) ? { stopLoss, takeProfit } : null;
}
