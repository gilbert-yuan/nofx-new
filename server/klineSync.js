import { marketData } from './marketData.js';
import { normalizeSymbols } from './tradeSync.js';
import { fetchContinuousKlines } from './continuousKlines.js';

export class KlineSync {
  constructor({ store, marketDb, positionMonitor = null, client = marketData }) {
    this.store = store;
    this.marketDb = marketDb;
    this.positionMonitor = positionMonitor;
    this.client = client;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastError = '';
    this.progress = { total: 0, completed: 0, failed: 0 };
    this.nextRunAt = null;
    this.interval = '1m';
    this.intervalSeconds = 60;
    this.lastDurationMs = null;
    this.skippedCycles = 0;
    this.scheduleKey = '';
  }

  async configureFromStore() {
    const config = await this.store.getConfig();
    const key = JSON.stringify(config.marketSync);
    if (this.timer && key === this.scheduleKey) return;
    this.scheduleKey = key;
    if (config.marketSync?.enabled) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      await this.start();
    } else {
      await this.stop();
    }
  }

  async start() {
    const config = await this.store.getConfig();
    if (this.timer) return this.status();

    const intervalMs = Math.max(30, Number(config.marketSync?.intervalSeconds || 300)) * 1000;
    this.intervalSeconds = intervalMs / 1000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
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
    this.nextRunAt = null;
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
      nextRunAt: this.nextRunAt,
      progress: this.progress,
      interval: this.interval,
      intervalSeconds: this.intervalSeconds,
      lastDurationMs: this.lastDurationMs,
      skippedCycles: this.skippedCycles,
      provider: this.client.provider || 'binance',
      states: (await this.marketDb.klineSyncStates()).filter(s => s.symbol.startsWith(this.client.storageSymbol?.('') || 'BINANCE_'))
    };
  }

  async fetchConfigured() {
    const config = await this.store.getConfig();
    const client = this.client;
    const symbols = resolveConfiguredSymbols(
      config.marketSync?.symbolsText,
      await client.perpetualUsdtSymbols()
    );
    return this.fetchSymbols({
      symbols,
      interval: config.marketSync?.interval || '15m',
      limit: config.marketSync?.limit || 80,
      review: true
    });
  }

  async fetchSymbols({ symbols, interval = '15m', limit = 80, review = false }) {
    if (this.running) { this.skippedCycles++; return { skipped: true, reason: 'Kline sync is already running.' }; }
    this.running = true;
    const startedAt = Date.now();
    this.interval = interval;

    try {
      const client = this.client;
      const now = Date.now();
      const datasets = [];
      let fetched = 0;
      let saved = 0;
      this.progress = { total: symbols.length, completed: 0, failed: 0 };

      let nextIndex = 0;
      const worker = async () => { while (nextIndex < symbols.length) {
        const index = nextIndex++, symbol = symbols[index];
        const storageSymbol = client.storageSymbol?.(symbol) || `BINANCE_${symbol}`;
        const state = await this.marketDb.getKlineSyncState({ symbol: storageSymbol, interval });
        let checkpoint = state?.lastOpenTime == null ? undefined : Number(state.lastOpenTime);
        let symbolFetched = 0, symbolSaved = 0;

        try {
          const resume = await this.marketDb.getKlineResumeTime({ symbol: storageSymbol, interval });
          const startTime = resume == null ? checkpoint : checkpoint == null ? resume : Math.min(resume, checkpoint);
          await fetchContinuousKlines({
            client, symbol, interval, startTime, limit: clamp(Number(limit || 80), 1, 1000), now,
            savePage: async rows => {
              const savedRows = await this.marketDb.saveKlines({ symbol: storageSymbol, interval, rows });
              checkpoint = rows.at(-1).openTime;
              symbolFetched += rows.length;
              symbolSaved += savedRows;
              fetched += rows.length;
              saved += savedRows;
              await this.marketDb.updateKlineSyncState({ symbol: storageSymbol, interval, lastOpenTime: checkpoint, status: 'syncing', error: '' });
            }
          });
          await this.marketDb.updateKlineSyncState({ symbol: storageSymbol, interval, lastOpenTime: checkpoint, status: 'ok', error: '' });
          datasets[index] = { symbol, interval, fetched: symbolFetched, saved: symbolSaved };
        } catch (error) {
          await this.marketDb.updateKlineSyncState({
            symbol: storageSymbol,
            interval,
            lastOpenTime: checkpoint,
            status: 'error',
            error: error.message
          });
          datasets[index] = { symbol, interval, fetched: symbolFetched, saved: symbolSaved, error: error.message };
          this.progress.failed++;
        }
        this.progress.completed++;
      } };
      const workers = await Promise.allSettled(Array.from({ length: Math.min(5, symbols.length) }, worker));
      const failedWorker = workers.find(result => result.status === 'rejected');
      if (failedWorker) throw failedWorker.reason;

      const positionReview = review && this.positionMonitor ? await this.positionMonitor.reviewAfterKlines({ interval, symbols }) : null;
      this.lastRunAt = new Date().toISOString();
      this.lastError = datasets.find((d) => d.error)?.error || '';
      return { symbols, interval, fetched, saved, datasets, positionReview };
    } finally {
      this.lastDurationMs = Date.now() - startedAt;
      this.running = false;
    }
  }
}

function resolveConfiguredSymbols(value, allSymbols) {
  const configured = normalizeSymbols(value || 'ALL');
  return configured.includes('ALL') ? allSymbols : configured;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
