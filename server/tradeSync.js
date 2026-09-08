import { BinanceClient } from './binanceClient.js';
import { normalizeBinanceUserTrade } from './marketDb.js';

export class TradeSync {
  constructor({ store, marketDb }) {
    this.store = store;
    this.marketDb = marketDb;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = '';
  }

  async configureFromStore() {
    const config = await this.store.getConfig();
    if (config.tradeSync?.enabled) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  async start() {
    const config = await this.store.getConfig();
    if (this.timer) return this.status();

    const intervalMs = Math.max(30, Number(config.tradeSync.intervalSeconds || 300)) * 1000;
    this.timer = setInterval(() => {
      this.fetchConfigured().catch((error) => {
        this.lastError = error.message;
      });
    }, intervalMs);

    this.fetchConfigured().catch((error) => {
      this.lastError = error.message;
    });
    return this.status();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.status();
  }

  async status() {
    return {
      running: Boolean(this.timer),
      busy: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      states: await this.marketDb.tradeSyncStates()
    };
  }

  async fetchConfigured() {
    const config = await this.store.getConfig();
    const symbols = normalizeSymbols(config.tradeSync?.symbolsText || '');
    return this.fetchSymbols({
      symbols,
      limit: config.tradeSync?.limit,
      initialLookbackDays: config.tradeSync?.initialLookbackDays
    });
  }

  async fetchSymbols({ symbols, limit = 500, initialLookbackDays = 30 }) {
    if (this.running) return { skipped: true, reason: 'Trade sync is already running.' };
    this.running = true;

    try {
      const config = await this.store.getConfig();
      const client = new BinanceClient(config.binance);
      const datasets = [];
      let fetched = 0;
      let saved = 0;

      for (const symbol of symbols) {
        const state = await this.marketDb.getTradeSyncState(symbol);
        const params = {
          symbol,
          limit: clamp(Number(limit || 500), 1, 1000)
        };

        if (state?.lastTradeId) {
          params.fromId = Number(state.lastTradeId) + 1;
        } else if (initialLookbackDays > 0) {
          params.startTime = Date.now() - Number(initialLookbackDays) * 24 * 60 * 60 * 1000;
        }

        try {
          const rawRows = await client.userTrades(params);
          const rows = rawRows.map(normalizeBinanceUserTrade);
          const savedRows = await this.marketDb.saveTrades({ symbol, rows });
          const last = rows.at(-1);
          await this.marketDb.updateTradeSyncState({
            symbol,
            lastTradeId: last?.tradeId || state?.lastTradeId,
            lastTradeTime: last?.time || state?.lastTradeTime,
            status: 'ok',
            error: ''
          });
          fetched += rows.length;
          saved += savedRows;
          datasets.push({ symbol, fetched: rows.length, saved: savedRows });
        } catch (error) {
          await this.marketDb.updateTradeSyncState({
            symbol,
            lastTradeId: state?.lastTradeId,
            lastTradeTime: state?.lastTradeTime,
            status: 'error',
            error: error.message
          });
          datasets.push({ symbol, fetched: 0, saved: 0, error: error.message });
        }
      }

      this.lastRunAt = new Date().toISOString();
      this.lastError = datasets.find((d) => d.error)?.error || '';
      return { symbols, fetched, saved, datasets };
    } finally {
      this.running = false;
    }
  }
}

export function normalizeSymbols(input) {
  const symbols = Array.isArray(input) ? input : String(input).split(',');
  const normalized = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  return [...new Set(normalized)].slice(0, 20);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
