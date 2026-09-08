import { randomUUID } from 'node:crypto';
import { BinanceClient } from './binanceClient.js';
import { BinanceMarket } from './binanceMarket.js';
import { marketData } from './marketData.js';
import { makeDecision, reviewPosition } from './ai.js';
import { candleOpenAt, prepareMarket } from './research.js';
import { validateOrder } from './risk.js';

const owned = order => String(order.clientAlgoId || '').startsWith('nofx');
const id = () => `nofx${randomUUID().replaceAll('-', '').slice(0, 28)}`;
const reject = reason => ({ status: 'rejected', reason });

export class BinancePositionMonitor {
  constructor({ store, marketDb, clientFactory = config => new BinanceClient(config), publicMarket = marketData, decide = makeDecision, review = reviewPosition }) {
    Object.assign(this, { store, marketDb, clientFactory, publicMarket, decide, review, busy: false, lastRunAt: null, lastResult: null, lastError: '' });
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
      const mode = await client.positionMode();
      if (mode.dualSidePosition !== false) return this.finish({ status: 'blocked', reason: '当前自动交易仅支持币安单向持仓模式，请在币安检查持仓模式。' });
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
            if (['sent', 'dry_run'].includes(action.status)) reserved.push({ symbol, positionAmt: action.quantity, markPrice: action.price, positionSide: 'BOTH' });
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
  async applyReview({ client, config, market, candles, position, review }) {
    if (!['CLOSE', 'UPDATE_PROTECTION'].includes(review?.action)) return { status: 'held', reason: review?.reason || '保持持仓。' };
    if (!validConfidence(review.confidence, config.trader.minConfidence)) return reject('置信度无效或低于阈值。');
    if (!fresh(candles)) return reject('分析期间已跨越 K 线周期，请等待下次复核。');
    const current = (await client.positions(position.symbol)).filter(p => Number(p.positionAmt) !== 0);
    if (current.length !== 1 || !Number.isFinite(Number(current[0].positionAmt)) || current[0].positionSide !== 'BOTH' || Math.sign(Number(current[0].positionAmt)) !== Math.sign(Number(position.positionAmt))) return reject('持仓已变化或不是单向持仓。');
    position = current[0];
    const symbol = position.symbol;
    if (!compatibleMarketPrice(candles, Number(position.markPrice))) return reject('币安价格与参考行情偏差超过 2% 或无效，暂停本次操作。');
    if (review.action === 'CLOSE') {
      if (config.trader.allowCloseOrders !== true) return { status: 'proposed', reason: '自动平仓未开启。' };
      if (config.trader.dryRun !== false) return { status: 'dry_run', action: 'CLOSE' };
      if (!await this.claim(symbol, candles)) return reject('本根 K 线已提交过操作。');
      const result = await client.marketOrder({ symbol, side: Number(position.positionAmt) > 0 ? 'SELL' : 'BUY', quantity: Math.abs(Number(position.positionAmt)), reduceOnly: true, clientOrderId: id() });
      if (result.status !== 'FILLED') return { status: 'uncertain', reason: '平仓未确认全部成交，请检查币安订单。' };
      for (const order of (await client.openAlgoOrders(symbol)).filter(owned)) await client.cancelAlgo(order.algoId);
      return { status: 'sent', action: 'CLOSE', orderId: result.orderId };
    }
    if (config.trader.allowProtectionUpdates !== true) return { status: 'proposed', reason: '保护单调整未开启。' };
    const instrument = (await market.perpetualUsdtContracts()).find(s => s.symbol === symbol);
    const levels = protectionLevels(review, Number(position.markPrice), Number(position.positionAmt) > 0, instrument);
    if (!levels) return reject('止盈止损价格无效或不符合价格步长。');
    if (config.trader.dryRun !== false) return { status: 'dry_run', action: 'UPDATE_PROTECTION', ...levels };
    if (!await this.claim(symbol, candles)) return reject('本根 K 线已提交过操作。');
    return this.replaceProtection({ client, symbol, side: Number(position.positionAmt) > 0 ? 'SELL' : 'BUY', levels, minBps: config.trader.minProtectionMoveBps });
  }
  async replaceProtection({ client, symbol, side, levels, minBps = 25 }) {
    const pending = await client.openAlgoOrders(symbol);
    if (!Array.isArray(pending)) throw new Error('币安保护单快照无效。');
    if (pending.some(o => !owned(o))) throw new Error('存在手动保护单，请先在币安检查，系统不会覆盖。');
    for (const type of ['STOP_MARKET', 'TAKE_PROFIT_MARKET']) {
      if (pending.filter(o => (o.orderType || o.type) === type).length > 1) throw new Error('发现多个同类保护单，请先检查币安订单。');
    }
    for (const [type, triggerPrice] of [['STOP_MARKET', levels.stopLoss], ['TAKE_PROFIT_MARKET', levels.takeProfit]]) {
      const sameType = pending.filter(o => (o.orderType || o.type) === type);
      if (sameType.some(o => !owned(o))) throw new Error('存在手动保护单，请先在币安检查，系统不会覆盖。');
      if (sameType.length > 1) throw new Error('发现多个同类保护单，请先检查币安订单。');
      const previous = sameType[0];
      if (previous && Math.abs(Number(previous.triggerPrice) - triggerPrice) / triggerPrice * 10000 < Math.max(0, Number(minBps) || 0)) continue;
      // Establish replacement first: a rejected new stop must never delete the existing stop.
      await client.protectionOrder({ symbol, side, type, triggerPrice, clientAlgoId: id() });
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
    if (!await this.claim(symbol, candles)) return reject('本根 K 线已提交过操作。');
    await client.setLeverage({ symbol, leverage: proposal.leverage });
    const result = await client.marketOrder({ symbol, side: decision.action, quantity, clientOrderId: id() });
    if (result.status !== 'FILLED') return { status: 'uncertain', reason: '开仓未确认全部成交，请检查币安订单。' };
    try {
      await this.replaceProtection({ client, symbol, side: decision.action === 'BUY' ? 'SELL' : 'BUY', levels });
    } catch (error) {
      // A filled entry without confirmed protection is immediately reduced; never open another entry on this path.
      try {
        const close = await client.marketOrder({ symbol, side: decision.action === 'BUY' ? 'SELL' : 'BUY', quantity: Number(result.executedQty), reduceOnly: true, clientOrderId: id() });
        if (close.status !== 'FILLED') throw new Error('Emergency close is not filled.');
      } catch { throw new Error(`保护单设置失败，紧急平仓也未确认，请立即检查 ${symbol}：${error.message}`); }
      throw new Error(`保护单设置失败，已发送紧急减仓指令，请检查 ${symbol}：${error.message}`);
    }
    return { status: 'sent', ...proposal, orderId: result.orderId };
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
