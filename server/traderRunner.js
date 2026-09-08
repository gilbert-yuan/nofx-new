import { randomUUID } from 'node:crypto';
import { BinanceClient } from './binanceClient.js';
import { analyzeMarkets, makeDecision } from './ai.js';
import { normalizeDecision, validateOrder } from './risk.js';

export class TraderRunner {
  constructor(store) {
    this.store = store;
    this.timer = null;
    this.busy = false;
  }

  async start() {
    const config = await this.store.getConfig();
    if (this.timer) return this.status();

    await this.store.patchState({ running: true, lastError: '' });
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {});
    }, Math.max(30, Number(config.trader.scanIntervalSeconds || 300)) * 1000);

    this.runOnce().catch(() => {});
    return this.status();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.store.patchState({ running: false });
    return this.status();
  }

  async status() {
    const state = await this.store.getState();
    return {
      ...state,
      running: Boolean(this.timer)
    };
  }

  async runOnce() {
    if (this.busy) return { skipped: true, reason: 'Previous run is still active.' };
    this.busy = true;

    try {
      const config = await this.store.getConfig();
      const strategy = await this.store.getStrategy();
      if (strategy.symbols?.includes('ALL')) {
        throw new Error(
          'Automatic order execution does not support ALL symbols. Use the all-contract research analysis endpoint instead.'
        );
      }
      const client = new BinanceClient(config.binance);
      const account = client.hasCredentials() ? await client.account() : null;
      const positions = client.hasCredentials() ? await client.positions() : [];
      const market = await loadMarket(client, strategy);
      const rawDecision = await makeDecision({
        config,
        strategy,
        market,
        account,
        positions
      });
      const decision = normalizeDecision(rawDecision);
      const execution = await this.executeDecision({ client, config, account, decision, market, positions });

      const record = {
        id: randomUUID(),
        at: new Date().toISOString(),
        market,
        decision,
        execution
      };
      await this.store.addDecision(record);
      await this.store.patchState({ lastRunAt: record.at, lastError: '' });
      return record;
    } catch (error) {
      await this.store.patchState({ lastError: error.message });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async executeDecision({ client, config, account, decision, market, positions }) {
    if (decision.action === 'HOLD') {
      return { status: 'skipped', reason: decision.reason || 'Decision is HOLD.' };
    }

    const symbolMarket = market.find((item) => item.symbol === decision.symbol);
    const price = Number(symbolMarket?.price || 0);
    const matching = (positions || []).filter(p => p.symbol === decision.symbol && Number(p.positionAmt) !== 0);
    const side = decision.action === 'CLOSE' ? (matching.length === 1 ? (Number(matching[0].positionAmt) > 0 ? 'SELL' : 'BUY') : '') : decision.action;
    const order = { ...decision, side, reduceOnly: decision.action === 'CLOSE' };
    const risk = validateOrder({ order, config, account, price, positions });

    if (!risk.ok) return { status: 'rejected', reason: risk.reason };
    if (config.trader.dryRun) {
      return { status: 'dry_run', reason: risk.reason, order, notional: risk.notional };
    }

    if (!order.reduceOnly) return { status: 'rejected', reason: 'Live entries require exchange-side protective stops, pending-order reconciliation and daily-loss controls; this research release does not enable them.' };
    const result = await client.marketOrder({
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      reduceOnly: decision.action === 'CLOSE'
    });

    return { status: 'sent', orderId: result.orderId, result };
  }
}

async function loadMarket(client, strategy) {
  const rows = [];
  for (const symbol of strategy.symbols || []) {
    const [ticker, klines] = await Promise.all([
      client.price(symbol),
      client.klines({
        symbol,
        interval: strategy.interval || '4h',
        limit: strategy.klineLimit || 80
      })
    ]);

    rows.push({
      symbol,
      price: Number(ticker.price),
      interval: strategy.interval || '4h',
      klines: klines.map((k) => ({
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5])
      }))
    });
  }
  return rows;
}

function inferCloseSide(decision) {
  return decision.side || 'SELL';
}
