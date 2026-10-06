import { createHash, randomUUID } from 'node:crypto';
import { binanceEnvironmentConfig } from '../shared/binanceEnvironment.js';
import { fusedPaperOrders } from '../shared/fusedPaperAccount.js';
import { ensureExchangeSync, mirrorLegacyDemo } from './binancePaperSync.js';
import { acquireBinanceExecutionLock, assertBinanceExecutionLock, createExecutionOwner,
  deterministicBinanceClientOrderId, executionLockKey, releaseBinanceExecutionLock, startBinanceExecutionLease } from './binanceExecutionGuard.js';

const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };
const uncertain = error => /timeout|timed out|ECONN|fetch failed|network|socket|execution status unknown/i.test(String(error.message || error))
  || [-1006, -1007].includes(Number(error.code)) || Number(error.status) >= 500;
const qtyOf = row => Math.abs(Number(row?.positionAmt) || 0);

/** Manual actions use fresh exchange quantities and durable client IDs under the same
 * position locks used by automation. An ambiguous POST is queried, never resubmitted. */
export class FusedOrderExecution {
  constructor(simulation) { this.simulation = simulation; this.requests = new Map(); }
  close(id) {
    if (this.requests.has(id)) return this.requests.get(id);
    const request = this.closeRow(id).finally(() => this.requests.delete(id));
    this.requests.set(id, request);
    return request;
  }
  async closeRow(id, { synchronize = true } = {}) {
    const simulation = this.simulation;
    if (synchronize) await simulation.accountSync.refresh({ forceIncome: true });
    const row = fusedPaperOrders(await simulation.readLight()).activeOrders.find(item => item.id === id);
    if (!row) reject('订单已结束或列表已更新，请同步后重试。');
    const refs = new Set(row.localOrders?.map(ref => ref.id) || []);
    await simulation.mutateLight(state => {
      for (const order of state.orders.filter(order => refs.has(order.id))) {
        if (row.status === 'open') order.manualCloseRequested = true;
        else order.manualEntryCancelled = true;
      }
    });
    if (!row.executionTargets?.length) {
      const order = await simulation.close(row.id);
      return { ok: true, results: [{ ok: true, complete: true, source: 'paper', symbol: row.symbol, status: order.status }], account: await simulation.status({ summary: true }) };
    }
    const results = [];
    for (const target of row.executionTargets) {
      try { results.push(await this.execute(target)); }
      catch (error) { results.push({ environment: target.environment, symbol: target.symbol, ok: false, error: error.message }); }
    }
    await this.finalizeLocal(row, results);
    if (synchronize) await simulation.accountSync.refresh({ forceIncome: true });
    return { ok: results.every(result => result.ok !== false), results, account: await simulation.status({ summary: true }) };
  }
  async finalizeLocal(row, results) {
    if (!results.length || results.some(result => !result.ok || !result.complete)) return;
    await this.simulation.mutateLight(state => {
      for (const ref of row.localOrders || []) {
        const order = state.orders.find(item => item.id === ref.id);
        if (!order) continue;
        const links = ensureExchangeSync(order);
        const filled = Object.values(links).filter(link => Number(link.executedQty) > 0);
        if (row.status === 'pending' && filled.length) {
          // Cancelling the unfilled remainder must preserve protection for its fills.
          const preferred = Number(links.live?.executedQty) > 0 ? links.live : links.demo;
          order.status = 'open'; order.entry = Number(preferred.avgPrice) || order.entry;
          order.quantity = Number(preferred.executedQty); order.entryAt ||= new Date().toISOString();
          order.nextTime ||= Date.now();
        } else {
          order.status = row.status === 'pending' ? 'cancelled' : 'closed';
          order.reason = row.status === 'pending' ? 'strategy_cancelled' : 'manual';
          order.exitAt = new Date().toISOString(); order.exit = results.find(result => result.avgPrice > 0)?.avgPrice || row.markPrice;
        }
      }
    }, { exchangeSync: true });
  }
  async writeIntent(key, intent) {
    await this.simulation.mutateLight(state => { state.manualExecutions ||= {}; state.manualExecutions[key] = intent; });
  }
  async recordResult(target, intent, result) {
    const time = new Date().toISOString();
    const status = String(result.status || 'NEW').toLowerCase();
    await this.simulation.mutateLight(state => {
      state.manualExecutions ||= {};
      state.manualExecutions[intent.key] = { ...intent, status, orderId: result.orderId, executedQty: Number(result.executedQty || 0), updatedAt: time };
      for (const ref of target.localOrders || []) {
        const order = state.orders.find(item => item.id === ref.id);
        if (!order) continue;
        const link = ensureExchangeSync(order)[target.environment];
        if (target.kind === 'entry_order') Object.assign(link, { status, executedQty: Number(result.executedQty || link.executedQty || 0),
          avgPrice: Number(result.avgPrice || link.avgPrice || 0), lastSyncedAt: time });
        else {
          link.closeOrders ||= [];
          const existing = link.closeOrders.find(action => action.id === intent.id);
          const action = { id: intent.id, manual: true, status, orderId: result.orderId, clientOrderId: intent.clientOrderId,
            executedQty: Number(result.executedQty || 0), avgPrice: Number(result.avgPrice || 0), lastSyncedAt: time, reason: 'manual' };
          if (existing) Object.assign(existing, action); else link.closeOrders.push(action);
        }
        mirrorLegacyDemo(order);
      }
    }, { exchangeSync: true });
  }
  async execute(target) {
    const simulation = this.simulation, config = await simulation.store.getConfig();
    const resolved = binanceEnvironmentConfig(config, target.environment);
    const snapshot = (await simulation.readLight()).exchangeAccounts?.[target.environment];
    const accountKey = createHash('sha256').update(resolved.apiKey || '').digest('hex');
    if (!resolved.apiKey || !resolved.secretKey || !snapshot?.enabled || snapshot.accountKey !== accountKey) reject('执行环境或凭证已变更，请重新同步。');
    const client = simulation.clientFactory(resolved);
    const mode = await client.positionMode();
    if (typeof mode?.dualSidePosition !== 'boolean') reject('未能确认持仓模式，暂缓平仓。');
    const dual = mode.dualSidePosition;
    client.dualSideCache = dual;
    const ps = dual ? target.direction === 'OPEN_LONG' ? 'LONG' : 'SHORT' : 'BOTH';
    const key = executionLockKey({ environment: target.environment, symbol: target.symbol, positionSide: ps });
    const lock = await acquireBinanceExecutionLock(simulation.store, key, createExecutionOwner('manual-close'));
    if (!lock.acquired) reject('该币种正在执行其他交易操作，请稍后重试。');
    const lease = startBinanceExecutionLease(simulation.store, lock);
    const assertLock = async () => { if (!lease.healthy() || !await assertBinanceExecutionLock(simulation.store, lock)) reject('执行锁已失效，请同步后重试。'); };
    try {
      await assertLock();
      if (target.kind === 'entry_order') {
        let remote = await client.order({ symbol: target.symbol, orderId: target.orderId });
        if (['NEW', 'PARTIALLY_FILLED'].includes(remote.status)) remote = await client.cancelOrder({ symbol: target.symbol, orderId: target.orderId });
        const intent = { id: `cancel:${target.orderId}`, key: `${key}:cancel:${target.orderId}` };
        await this.recordResult(target, intent, remote);
        return { ok: true, complete: !['NEW', 'PARTIALLY_FILLED'].includes(remote.status), environment: target.environment,
          symbol: target.symbol, status: remote.status, executedQty: Number(remote.executedQty || 0) };
      }
      // Cancel entries that could refill this merged position while it is closing.
      const orders = await client.openOrders(target.symbol);
      if (!Array.isArray(orders)) reject('未能确认待入场订单，暂缓平仓。');
      const entrySide = target.direction === 'OPEN_LONG' ? 'BUY' : 'SELL';
      for (const order of orders.filter(order => order.side === entrySide && ![true, 'true'].includes(order.reduceOnly)
        && ![true, 'true'].includes(order.closePosition) && (order.positionSide || 'BOTH') === ps)) {
        await assertLock(); await client.cancelOrder({ symbol: target.symbol, orderId: order.orderId });
      }
      // Reuse protection ownership checks; external positions have no local ID.
      const protectionOrder = { id: target.localOrders?.[0]?.id || 'external', symbol: target.symbol, direction: target.direction };
      let finalOrder = null;
      for (let round = 0; round < 32; round++) {
        await assertLock();
        const positions = await client.positions(target.symbol);
        if (!Array.isArray(positions)) reject('未能读取实际持仓数量。');
        const position = positions.find(row => row.symbol === target.symbol && (row.positionSide || 'BOTH') === ps
          && (target.direction === 'OPEN_LONG' ? Number(row.positionAmt) > 0 : Number(row.positionAmt) < 0));
        const amount = qtyOf(position);
        if (!amount) {
          const cleaned = await simulation.exchangeSync.cancelNativeProtection(protectionOrder, target.environment, client);
          for (const ref of target.localOrders || []) await simulation.exchangeSync.updateLink(ref.id, target.environment, link => {
            link.manualProtectionCleanup = cleaned ? 'clean' : 'pending';
          });
          return { ok: true, complete: true, environment: target.environment, symbol: target.symbol,
            status: 'closed', avgPrice: Number(finalOrder?.avgPrice || 0),
            ...(cleaned ? {} : { warning: '持仓已平仓，残留保护单尚未确认清理。' }) };
        }
        const previous = (await simulation.readLight()).manualExecutions?.[key];
        if (previous?.accountKey === accountKey && ['submitting', 'unknown', 'new', 'partially_filled'].includes(previous.status)) {
          // A missing GET after an ambiguous POST is not permission to send again.
          let existing;
          try { existing = await client.order({ symbol: target.symbol, clientOrderId: previous.clientOrderId }); }
          catch { reject('上次平仓结果尚未确认，请稍后同步重试；未重复发送订单。'); }
          await this.recordResult(target, previous, existing);
          if (!['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(existing.status)) reject('平仓订单尚未完成，请稍后同步。');
          // The position read preceded this reconciliation. Always fetch it again.
          continue;
        }
        if (previous?.accountKey === accountKey && previous.status === 'filled' && previous.remainingBefore != null
          && amount > Math.max(0, previous.remainingBefore - Number(previous.executedQty || 0)) + 1e-10) {
          return { ok: true, complete: false, environment: target.environment, symbol: target.symbol, status: 'awaiting_position' };
        }
        const info = await client.exchangeInfo();
        const symbolInfo = info.symbols?.find(row => row.symbol === target.symbol);
        const filter = symbolInfo?.filters?.find(row => row.filterType === 'MARKET_LOT_SIZE' && Number(row.stepSize) > 0)
          || symbolInfo?.filters?.find(row => row.filterType === 'LOT_SIZE');
        const step = Number(filter?.stepSize), max = Number(filter?.maxQty) || amount;
        if (!(step > 0)) reject('币种数量过滤器未就绪，暂缓平仓。');
        const quantity = Number((Math.floor((Math.min(amount, max) + step * 1e-8) / step) * step).toFixed(12));
        if (!(quantity > 0) || quantity < Number(filter.minQty || 0)) reject('剩余持仓低于最小平仓数量，请在币安处理。');
        const id = randomUUID(), intent = { key, id, accountKey, status: 'submitting', quantity, remainingBefore: amount,
          clientOrderId: deterministicBinanceClientOrderId('close', target.environment, target.symbol, ps, id), createdAt: new Date().toISOString() };
        await this.writeIntent(key, intent);
        await assertLock();
        try {
          finalOrder = await client.marketOrder({ symbol: target.symbol, side: entrySide === 'BUY' ? 'SELL' : 'BUY',
            quantity, reduceOnly: true, ...(dual ? { positionSide: ps } : {}), clientOrderId: intent.clientOrderId });
        } catch (error) {
          if (uncertain(error)) {
            await this.writeIntent(key, { ...intent, status: 'unknown', error: String(error.message).slice(0, 300) });
            try { finalOrder = await client.order({ symbol: target.symbol, clientOrderId: intent.clientOrderId }); }
            catch { reject('币安平仓响应未确认，请稍后同步重试；未重复发送订单。'); }
          } else { await this.writeIntent(key, { ...intent, status: 'rejected', error: String(error.message).slice(0, 300) }); throw error; }
        }
        await this.recordResult(target, intent, finalOrder);
        if (finalOrder.status !== 'FILLED') return { ok: true, complete: false, environment: target.environment,
          symbol: target.symbol, status: finalOrder.status, orderId: finalOrder.orderId };
      }
      reject('分批平仓达到单次上限，请同步查看剩余持仓。');
    } finally { await lease.stop(); await releaseBinanceExecutionLock(simulation.store, lock); }
  }
  async closeAll() {
    if (this.bulkRequest) return this.bulkRequest;
    const work = this.closeAllRows().finally(() => { this.bulkRequest = null; });
    this.bulkRequest = work; return work;
  }
  async closeAllRows() {
    const simulation = this.simulation;
    await simulation.mutateLight(state => { state.entriesPaused = true; });
    await simulation.accountSync.refresh({ forceIncome: true });
    const results = [];
    // Entries are cancelled before closing positions. Pause remains in force after
    // success or partial failure, so automated strategies cannot immediately reenter.
    for (const status of ['pending', 'open']) {
      const rows = fusedPaperOrders(await simulation.readLight()).activeOrders;
      const targets = rows.filter(row => row.status === status); let index = 0;
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, async () => {
        while (index < targets.length) {
          const row = targets[index++];
          try { const result = await this.closeRow(row.id, { synchronize: false }); results.push({ id: row.id, symbol: row.symbol, ...result, account: undefined }); }
          catch (error) { results.push({ id: row.id, symbol: row.symbol, ok: false, error: error.message }); }
        }
      }));
      await simulation.accountSync.refresh({ forceIncome: true });
    }
    await simulation.accountSync.refresh({ forceIncome: true });
    return { ok: results.every(row => row.ok), entriesPaused: true, results, account: await simulation.status({ summary: true }) };
  }
}
