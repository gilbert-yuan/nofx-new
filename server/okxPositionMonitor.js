import { randomUUID } from 'node:crypto';
import { OkxClient } from './okxClient.js';
import { makeDecision, reviewPosition } from './ai.js';
import { prepareMarket } from './research.js';

export class OkxPositionMonitor {
  constructor({ store, marketDb }) {
    this.store = store;
    this.marketDb = marketDb;
    this.busy = false;
    this.lastRunAt = null;
    this.lastError = '';
    this.lastResult = null;
  }

  async status() { return { running: this.busy, lastRunAt: this.lastRunAt, lastError: this.lastError, lastResult: this.lastResult }; }

  async reviewAfterKlines({ interval }) {
    if (this.busy) return { skipped: true, reason: 'Position review is already running.' };
    this.busy = true;
    try {
      const config = await this.store.getConfig();
      const trader = config.trader || {};
      if (!trader.enabled) return this.finish({ status: 'disabled', reason: 'OKX automation is disabled.' });
      if (interval !== '15m') return this.finish({ status: 'skipped', reason: 'Position review runs only after 15-minute candles.' });
      const client = new OkxClient(config.okx);
      if (!client.hasCredentials()) return this.finish({ status: 'blocked', reason: 'OKX API key, secret key and passphrase are required.' });

      const strategy = await this.store.getStrategy();
      const allPositions = (await client.positions()).filter(position => Math.abs(Number(position.pos)) > 0 && position.instId.endsWith('-USDT-SWAP'));
      const positions = allPositions.slice(0, clamp(trader.maxPositionsToReview, 10, 1, 20));
      const reviews = [];
      for (const position of positions) reviews.push(await this.reviewOne({ client, config, strategy, position }));
      const entries = await this.reviewEntries({ client, config, strategy, positions: allPositions });
      const result = this.finish({ status: 'ok', dryRun: Boolean(trader.dryRun), reviewed: reviews.length, reviews, entries });
      await this.store.addDecision({ id: randomUUID(), at: this.lastRunAt, type: 'okx-position-review', execution: result, researchOnly: false });
      return result;
    } catch (error) {
      this.lastError = error.message;
      this.lastRunAt = new Date().toISOString();
      throw error;
    } finally { this.busy = false; }
  }

  async reviewOne({ client, config, strategy, position }) {
    const symbol = client.symbol(position.instId);
    const raw = await client.klines({ symbol, interval: '15m', limit: 81 });
    const market = prepareMarket({ symbol, interval: '15m', rows: raw.filter(row => row.confirmed), limit: 80 });
    await this.marketDb.saveKlines({ symbol: `OKX_${symbol}`, interval: '15m', rows: market.klines });
    const review = normalizeReview(await reviewPosition({ config, strategy: { ...strategy, interval: '15m' }, position: summarizePosition(position), market }));
    const action = await this.applyReview({ client, config, position, market, review });
    return { symbol, instId: position.instId, position: summarizePosition(position), review, action };
  }

  async applyReview({ client, config, position, market, review }) {
    const trader = config.trader || {};
    if (review.action === 'HOLD') return { status: 'held', reason: review.reason };
    if (review.confidence < Number(trader.minConfidence || 0.65)) return { status: 'rejected', reason: 'Model self-assessment is below the configured threshold.' };
    if (review.action === 'CLOSE') {
      if (!trader.allowCloseOrders) return { status: 'proposed', reason: 'Closing positions is disabled by configuration.' };
      if (trader.dryRun) return { status: 'dry_run', action: 'CLOSE', reason: review.reason };
      const result = await client.closePosition({ instId: position.instId, contracts: Math.abs(Number(position.pos)), tdMode: position.mgnMode || config.okx.tdMode, pos: position.pos });
      return { status: 'sent', action: 'CLOSE', result };
    }
    if (review.action !== 'UPDATE_PROTECTION') return { status: 'rejected', reason: 'Unsupported review action.' };
    if (!validProtection(position, market, review)) return { status: 'rejected', reason: 'Proposed TP/SL is invalid for the active position.' };
    if (!trader.allowProtectionUpdates) return { status: 'proposed', action: 'UPDATE_PROTECTION', reason: 'Protection updates are disabled by configuration.' };
    if (trader.dryRun) return { status: 'dry_run', action: 'UPDATE_PROTECTION', takeProfit: review.takeProfit, stopLoss: review.stopLoss };
    return this.updateManagedProtection({ client, config, position, review });
  }

  async reviewEntries({ client, config, strategy, positions }) {
    const trader = config.trader || {};
    if (!trader.allowEntryOrders) return { status: 'disabled', reason: 'New entries are disabled by configuration.', items: [] };
    const symbols = parseSymbols(trader.entrySymbolsText);
    if (!symbols.length) return { status: 'blocked', reason: 'Add one or more entry symbols before enabling automatic entries.', items: [] };

    const balance = await client.balance();
    const limit = clamp(trader.maxNewEntriesPerCycle, 1, 1, 5);
    const held = new Set(positions.map(position => client.symbol(position.instId)));
    const items = [];
    for (const symbol of symbols.filter(symbol => !held.has(symbol)).slice(0, limit)) {
      items.push(await this.reviewEntry({ client, config, strategy, positions, balance, symbol }));
    }
    return { status: 'ok', evaluated: items.length, items };
  }

  async reviewEntry({ client, config, strategy, positions, balance, symbol }) {
    const raw = await client.klines({ symbol, interval: '15m', limit: 81 });
    const market = prepareMarket({ symbol, interval: '15m', rows: raw.filter(row => row.confirmed), limit: 80 });
    await this.marketDb.saveKlines({ symbol: `OKX_${symbol}`, interval: '15m', rows: market.klines });
    const decision = normalizeEntryDecision(await makeDecision({ config, strategy: { ...strategy, interval: '15m' }, market, account: balance, positions }));
    const action = await this.applyEntry({ client, config, positions, balance, market, symbol, decision });
    return { symbol, decision, action };
  }

  async applyEntry({ client, config, positions, balance, market, symbol, decision }) {
    const trader = config.trader || {};
    if (!['BUY', 'SELL'].includes(decision.action)) return { status: 'held', reason: decision.reason || 'No new entry was recommended.' };
    if (decision.confidence < Number(trader.minConfidence || 0.65)) return { status: 'rejected', reason: 'Model self-assessment is below the configured threshold.' };
    if (!validEntryProtection(market, decision)) return { status: 'rejected', reason: 'Proposed entry TP/SL is invalid for the latest price.' };
    if (!Number.isInteger(decision.contracts) || decision.contracts <= 0) return { status: 'rejected', reason: 'Proposed contract count must be a positive whole number.' };
    if (decision.leverage < 1 || decision.leverage > Number(trader.maxLeverage || 1)) return { status: 'rejected', reason: 'Proposed leverage exceeds the configured limit.' };

    const instrument = await client.instrument(symbol);
    if (!instrument) return { status: 'rejected', reason: 'OKX instrument is unavailable.' };
    const size = normalizeContracts(decision.contracts, instrument);
    if (!size) return { status: 'rejected', reason: 'Proposed contract count is below the OKX minimum or lot size.' };
    const equity = usdtEquity(balance);
    const price = Number(market.klines.at(-1)?.close);
    const newNotional = size * Number(instrument.contractValue) * price;
    const existingNotional = positions.reduce((sum, position) => sum + Math.abs(Number(position.notionalUsd || 0)), 0);
    if (!Number.isFinite(equity) || equity <= 0) return { status: 'rejected', reason: 'USDT account equity is unavailable.' };
    if (!Number.isFinite(newNotional) || newNotional > equity * Number(trader.maxPositionNotionalPct || 0)) return { status: 'rejected', reason: 'Entry exceeds the configured per-position notional limit.' };
    if (existingNotional + newNotional > equity * Number(trader.maxTotalNotionalPct || 0)) return { status: 'rejected', reason: 'Entry exceeds the configured total notional limit.' };

    const proposal = { action: decision.action, contracts: size, leverage: decision.leverage, takeProfit: decision.takeProfit, stopLoss: decision.stopLoss, estimatedNotional: newNotional };
    if (trader.dryRun) return { status: 'dry_run', ...proposal };
    const instId = client.instId(symbol);
    await client.setLeverage({ instId, leverage: decision.leverage, tdMode: config.okx.tdMode || 'isolated' });
    const result = await client.placeMarketOrder({
      symbol, side: decision.action === 'BUY' ? 'buy' : 'sell', contracts: size, tdMode: config.okx.tdMode || 'isolated',
      takeProfit: decision.takeProfit, stopLoss: decision.stopLoss, clOrdId: orderId('entry')
    });
    return { status: 'sent', ...proposal, result };
  }

  async updateManagedProtection({ client, config, position, review }) {
    const pending = (await client.pendingAlgoOrders(position.instId)).filter(order => String(order.algoClOrdId || '').startsWith('nofx'));
    const takeProfit = pending.filter(order => Number(order.tpTriggerPx) > 0);
    const stopLoss = pending.filter(order => Number(order.slTriggerPx) > 0);
    if (takeProfit.length > 1 || stopLoss.length > 1) return { status: 'rejected', reason: 'Multiple NOFX protection orders found; resolve them in OKX before automatic adjustment.' };
    const minMoveBps = Math.max(0, Number(config.trader?.minProtectionMoveBps || 0));
    const moveTakeProfit = !takeProfit[0] || requiresMove(takeProfit[0].tpTriggerPx, review.takeProfit, minMoveBps);
    const moveStopLoss = !stopLoss[0] || requiresMove(stopLoss[0].slTriggerPx, review.stopLoss, minMoveBps);
    if (!moveTakeProfit && !moveStopLoss) return { status: 'held', reason: `Protection levels changed by less than ${minMoveBps} bps.` };
    const result = [];
    if (takeProfit[0] && moveTakeProfit) result.push(await client.amendProtection({ instId: position.instId, algoId: takeProfit[0].algoId, takeProfit: review.takeProfit }));
    if (stopLoss[0] && moveStopLoss) result.push(await client.amendProtection({ instId: position.instId, algoId: stopLoss[0].algoId, stopLoss: review.stopLoss }));
    if (!takeProfit[0] || !stopLoss[0]) result.push(await client.placeProtection({
      instId: position.instId, pos: position.pos, tdMode: position.mgnMode || config.okx.tdMode,
      takeProfit: takeProfit[0] ? null : review.takeProfit, stopLoss: stopLoss[0] ? null : review.stopLoss
    }));
    return { status: 'sent', action: 'UPDATE_PROTECTION', takeProfit: review.takeProfit, stopLoss: review.stopLoss, result };
  }

  finish(result) { this.lastRunAt = new Date().toISOString(); this.lastError = ''; this.lastResult = result; return result; }
}

function normalizeReview(value) {
  const action = String(value?.action || 'HOLD').toUpperCase();
  return {
    action: ['HOLD', 'CLOSE', 'UPDATE_PROTECTION'].includes(action) ? action : 'HOLD',
    confidence: Number(value?.confidence || 0), reason: String(value?.reason || ''),
    takeProfit: Number(value?.takeProfit || 0), stopLoss: Number(value?.stopLoss || 0)
  };
}
function summarizePosition(position) { return { instId: position.instId, pos: Number(position.pos), posSide: position.posSide, avgPx: Number(position.avgPx), markPx: Number(position.markPx), upl: Number(position.upl), lever: Number(position.lever), mgnMode: position.mgnMode, closeOrderAlgo: position.closeOrderAlgo || [] }; }
function validProtection(position, market, review) {
  if (![review.takeProfit, review.stopLoss, Number(position.pos), Number(market.klines.at(-1)?.close)].every(Number.isFinite)) return false;
  const current = Number(market.klines.at(-1).close);
  return Number(position.pos) > 0 ? review.stopLoss < current && current < review.takeProfit : review.takeProfit < current && current < review.stopLoss;
}
function validEntryProtection(market, decision) {
  const current = Number(market.klines.at(-1)?.close);
  if (![current, decision.takeProfit, decision.stopLoss].every(Number.isFinite)) return false;
  return decision.action === 'BUY'
    ? decision.stopLoss < current && current < decision.takeProfit
    : decision.takeProfit < current && current < decision.stopLoss;
}
function normalizeEntryDecision(value) {
  const action = String(value?.action || 'HOLD').toUpperCase();
  return {
    action: ['BUY', 'SELL', 'HOLD'].includes(action) ? action : 'HOLD',
    contracts: Math.trunc(Number(value?.contracts ?? value?.quantity ?? 0)), leverage: Number(value?.leverage || 1),
    confidence: Number(value?.confidence || 0), reason: String(value?.reason || ''),
    takeProfit: Number(value?.takeProfit || 0), stopLoss: Number(value?.stopLoss || 0)
  };
}
function parseSymbols(value) { return String(value || '').split(',').map(item => item.trim().toUpperCase().replace(/^(OKX|BYBIT)_/, '')).filter(symbol => symbol && symbol !== 'ALL'); }
function normalizeContracts(contracts, instrument) {
  const lotSize = Number(instrument.lotSize || 1), minimum = Number(instrument.minSize || lotSize);
  if (![lotSize, minimum].every(Number.isFinite) || lotSize <= 0 || minimum <= 0) return 0;
  const normalized = Math.floor(contracts / lotSize) * lotSize;
  return normalized >= minimum ? normalized : 0;
}
function usdtEquity(balance) { return Number(balance?.details?.find(item => item.ccy === 'USDT')?.eq || balance?.totalEq || 0); }
function orderId(kind) { return `nofx${kind}${Date.now()}${Math.floor(Math.random() * 1e6)}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 32); }
function requiresMove(current, proposed, minMoveBps) { const now = Number(current), next = Number(proposed); return !Number.isFinite(now) || Math.abs(next - now) / now * 10_000 >= minMoveBps; }
function clamp(value, fallback, min, max) { const number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback; }
