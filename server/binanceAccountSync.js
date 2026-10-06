import { BinanceClient } from './binanceClient.js';
import { binanceEnvironmentConfig, isBinanceDemo } from '../shared/binanceEnvironment.js';
import { binanceSyncEnabled, binanceEnvironmentHasCredentials } from './binancePaperSync.js';
import { normalizeBinanceAccount } from '../shared/paperOrderActivity.js';
import { createHash } from 'node:crypto';
import { reconcileFusedLocalOrders } from '../shared/fusedPaperAccount.js';

/** Exchange observations feed the shared local capital pool. Wallet balances are not imported. */
export class BinanceAccountSync {
  constructor({ simulation, store, clientFactory = config => new BinanceClient(config), intervalMs = 10000 }) {
    Object.assign(this, { simulation, store, clientFactory, intervalMs, started: false, timer: null, pending: null });
  }
  start() { if (!this.started) { this.started = true; this.schedule(0); } }
  stop() { this.started = false; clearTimeout(this.timer); this.timer = null; }
  schedule(delay = this.intervalMs) {
    if (!this.started) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(error => console.error('[account-sync]', error.message)).finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }
  requestRefresh() { if (this.started) this.schedule(0); }
  refresh({ forceIncome = false } = {}) {
    if (this.pending) {
      // A manual refresh/close must include fills that arrived during the pending
      // background read. Coalesce one forced follow-up instead of returning it early.
      if (!forceIncome) return this.pending;
      if (!this.forcedFollowup) this.forcedFollowup = this.pending.then(() => this.refresh({ forceIncome: true }))
        .finally(() => { this.forcedFollowup = null; });
      return this.forcedFollowup;
    }
    this.pending = this.reconcile({ forceIncome }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async reconcile({ forceIncome = false } = {}) {
    const config = await this.store?.getConfig?.() || {};
    const [state, linked] = await Promise.all([this.simulation.readLight(), this.simulation.exchangeSyncOrders()]);
    const links = new Map(linked.orders.map(order => [order.id, order]));
    state.orders = state.orders.map(order => ({ ...order, exchangeSync: links.get(order.id)?.exchangeSync || order.exchangeSync, exchange: links.get(order.id)?.exchange || order.exchange }));
    const results = await Promise.all(['demo', 'live'].map(async environment => {
      const configured = binanceEnvironmentHasCredentials(config, environment);
      const enabled = binanceSyncEnabled(config, environment) || (environment === 'demo' && configured && isBinanceDemo(config.binance));
      const lastAttemptAt = new Date().toISOString();
      if (!enabled || !configured) return { environment, enabled, configured, lastAttemptAt, error: enabled ? '未配置币安账户凭证。' : '' };
      const resolved = binanceEnvironmentConfig(config, environment);
      const accountKey = createHash('sha256').update(resolved.apiKey).digest('hex');
      try {
        const client = this.clientFactory(resolved);
        const reservations = Object.values(state.capitalReservations || {}).filter(row => row.environment === environment
          && ['submitting', 'submitted', 'unknown'].includes(row.status) && row.clientOrderId && !row.orderId);
        const resolvedReservations = [];
        for (const reservation of reservations) {
          try {
            const order = await client.order({ symbol: reservation.symbol, clientOrderId: reservation.clientOrderId });
            resolvedReservations.push({ id: reservation.id, orderId: order.orderId,
              status: ['REJECTED', 'EXPIRED', 'CANCELED'].includes(order.status) && !(Number(order.executedQty) > 0) ? 'rejected' : 'submitted' });
          } catch { /* An unconfirmed POST keeps its reservation, including across restarts. */ }
        }
        const [positions, orders] = await Promise.all([client.positions(), client.openOrders()]);
        const activity = normalizeBinanceAccount(positions, orders);
        const metrics = await this.simulation.orderLedger.refresh({ client, environment, accountKey, activity, state, force: forceIncome });
        return { environment, accountKey, enabled, configured, lastAttemptAt, syncedAt: new Date().toISOString(), error: '',
          ...activity, ...metrics, resolvedReservations };
      } catch (error) {
        // A failed fetch is not an empty account. Keep the last complete snapshot.
        return { environment, accountKey, enabled, configured, lastAttemptAt, error: String(error.message || error).slice(0, 300) };
      }
    }));
    await this.simulation.mutateLight(state => {
      state.exchangeAccounts ||= {};
      for (const result of results) {
        const previous = state.exchangeAccounts[result.environment];
        const sameAccount = result.configured && previous?.accountKey === result.accountKey;
        const snapshot = { ...(sameAccount ? previous : {}), ...result };
        for (const resolved of result.resolvedReservations || []) {
          if (state.capitalReservations?.[resolved.id]) Object.assign(state.capitalReservations[resolved.id], resolved);
        }
        delete snapshot.resolvedReservations;
        delete snapshot.funds; delete snapshot.income; delete snapshot.incomeError;
        state.exchangeAccounts[result.environment] = snapshot;
        if (!snapshot.error && !snapshot.metricsError) {
          for (const reservation of Object.values(state.capitalReservations || {})) {
            if (reservation.environment !== result.environment || !['submitting', 'submitted', 'unknown'].includes(reservation.status)) continue;
            const remote = snapshot.orders?.find(order => String(order.orderId) === String(reservation.orderId)
              || order.clientOrderId === reservation.clientOrderId);
            if (remote || (reservation.orderId && snapshot.observedOrderIds?.includes(String(reservation.orderId)))) reservation.status = 'reconciled';
          }
        }
      }
      reconcileFusedLocalOrders(state);
    });
    return results;
  }
}
