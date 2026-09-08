import { marketData, marketStorageSymbol } from './marketData.js';
import { analyzeMarkets } from './ai.js';
import { createResearchRecord, prepareMarket, toBybitInterval, nextOpenTime } from './research.js';
import { ResearchStore } from './researchStore.js';
import { evaluateSignal, evaluationEnd, summarizeResults } from './paperTrading.js';
import { localAnalysis, localAnalysisMultiTimeframe } from './localAnalysis.js';
import { SimulatedAccount, registerSimulationRoutes } from './simulatedAccount.js';
import { PaperAutomation, registerAutomationRoutes } from './paperAutomation.js';

const bounded = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;

export async function freshMarkets({ symbols, interval, limit, client, marketDb }) {
  const market = [], failures = [];
  for (let i = 0; i < symbols.length; i += 5) {
    await Promise.all(symbols.slice(i, i + 5).map(async symbol => {
      try {
        // The exchange may include the currently forming candle. Keep two spare
        // rows so the requested analysis window always contains closed candles.
        const rows = await client.klines({ symbol, interval, limit: Math.min(1000, limit + 2) });
        const prepared = prepareMarket({ symbol, interval, rows, limit, marketProvider: client.provider || 'binance' });
        await marketDb.saveKlines({ symbol: marketStorageSymbol(symbol, prepared.marketProvider), interval, rows: prepared.klines });
        market.push(prepared);
      } catch (error) { failures.push(`${symbol}: ${error.message}`); }
    }));
  }
  market.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
  return { market, failures };
}

export async function registerResearchRoutes({ app, store, marketDb, loadContracts }) {
  const archive = new ResearchStore(marketDb.pool);
  await archive.init((await store.getState()).decisions);
  const simulation = new SimulatedAccount({ pool: marketDb.pool, market: marketData, archive, marketDb });
  await simulation.init();
  registerSimulationRoutes(app, simulation);
  simulation.start();
  const automation = new PaperAutomation({ simulation, store, market: marketData, marketDb, archive });
  await automation.init();
  registerAutomationRoutes(app, automation);
  automation.start();
  let analysisBusy = false, refreshBusy = false;

  for (const type of ['single', 'range', 'all']) {
    const endpoint = type === 'single' ? 'analyze' : `analyze-${type}`;
    app.post(`/api/market/${endpoint}`, async (req, res, next) => {
      if (analysisBusy) return res.status(409).json({ error: '已有分析任务运行，请完成后再试。' });
      analysisBusy = true;
      try {
        const config = await store.getConfig();
        const requestedEngine = req.body?.scope?.engine || req.body?.engine || 'auto';
        if (!['auto', 'local', 'local-mtf', 'ai'].includes(requestedEngine)) return res.status(400).json({ error: '不支持的分析方式。' });
        const hasModel = config.model.enabled && config.model.apiKey;
        if (requestedEngine === 'ai' && !hasModel) return res.status(422).json({ error: 'AI 分析需要模型 Key；可切换本地规则分析，无需 Key。' });
        const engine = requestedEngine === 'local-mtf' ? 'local-mtf' : (requestedEngine === 'local' || !hasModel ? 'local' : 'ai');
        const strategy = await store.getStrategy();
        const input = req.body?.scope || {};
        const scope = {
          interval: String((type === 'single' && req.body?.interval) || input.interval || strategy.interval || '15m'),
          limit: bounded((type === 'single' && req.body?.limit) || input.limit || strategy.klineLimit, 80, 20, 200),
          maxSymbols: bounded(input.maxSymbols, 20, 1, 300), batchSize: bounded(input.batchSize, 10, 1, 20),
          symbols: (Array.isArray(input.symbols) ? input.symbols : String(input.symbolsText || '').split(','))
            .map(s => String(s).trim().toUpperCase().replace(/^(BYBIT|OKX)_/, '')).filter(Boolean)
        };
        toBybitInterval(scope.interval);
        let symbols;
        if (type === 'single') {
          const symbol = String(req.body?.symbol || '').toUpperCase().replace(/^(BYBIT|OKX)_/, '');
          if (!/^[\p{L}\p{N}]+USDT$/u.test(symbol)) return res.status(400).json({ error: '请选择有效USDT合约。' });
          symbols = [symbol];
        } else {
          symbols = (await loadContracts()).map(item => item.symbol);
          if (type === 'range') symbols = symbols.filter(s => !scope.symbols.length || scope.symbols.includes(s)).slice(0, scope.maxSymbols);
        }
        if (!symbols.length) return res.status(422).json({ error: '没有符合范围的合约。' });

        // 获取主周期行情
        const { market, failures } = await freshMarkets({ symbols, interval: scope.interval, limit: scope.limit, client: marketData, marketDb });
        if (!market.length) return res.status(422).json({ error: failures.join(' | ') || '没有有效行情。' });

        // 如果使用多周期分析，获取辅助周期数据
        let auxMarketsMap = {};
        if (engine === 'local-mtf') {
          const auxIntervals = ['15m', '1h', '4h'];
          for (const auxInterval of auxIntervals) {
            if (auxInterval === scope.interval) continue; // 跳过与主周期相同的
            try {
              const auxResult = await freshMarkets({ symbols, interval: auxInterval, limit: 80, client: marketData, marketDb });
              auxMarketsMap[auxInterval] = auxResult.market.reduce((map, m) => {
                map[m.symbol] = m;
                return map;
              }, {});
            } catch (error) {
              failures.push(`获取${auxInterval}周期数据失败: ${error.message}`);
            }
          }
        }

        const effectiveStrategy = { ...strategy, interval: scope.interval };
        const analyses = [];
        // Limit queued batches as well as provider concurrency.
        for (let i = 0; i < market.length; i += scope.batchSize * 5) {
          const batches = [];
          for (let j = i; j < Math.min(market.length, i + scope.batchSize * 5); j += scope.batchSize) {
            const batch = market.slice(j, j + scope.batchSize);
            if (engine === 'local') {
              batches.push(Promise.resolve({ analyses: batch.map(localAnalysis) }));
            } else if (engine === 'local-mtf') {
              batches.push(Promise.resolve({
                analyses: batch.map(m => {
                  const auxMarkets = {};
                  for (const interval of ['15m', '1h', '4h']) {
                    if (auxMarketsMap[interval] && auxMarketsMap[interval][m.symbol]) {
                      auxMarkets[interval] = auxMarketsMap[interval][m.symbol];
                    }
                  }
                  return localAnalysisMultiTimeframe(m, auxMarkets);
                })
              }));
            } else {
              batches.push(analyzeMarkets({ config, strategy: effectiveStrategy, market: batch }).catch(error => ({ analyses: [], error: error.message })));
            }
          }
          for (const result of await Promise.all(batches)) {
            analyses.push(...(result.analyses || []));
            if (result.error) failures.push(result.error);
          }
        }

        const modelName = engine === 'local-mtf' ? 'local-mtf-trend-atr-v1' : 'local-trend-atr-v1';
        const record = createResearchRecord({
          config: engine.startsWith('local') ? { ...config, model: { model: modelName, baseUrl: 'local://rules' } } : config,
          strategy: effectiveStrategy, market, result: { analyses, error: failures.join(' | ') }, type, scope
        });
        record.analysisEngine = engine;
        for (const signal of record.analyses) {
          signal.analysisEngine = engine;
          if (engine.startsWith('local')) signal.confidenceType = 'rule_strength';
        }
        await archive.save(record);
        const { snapshot, market: snapshotMarket, ...response } = record;
        res.json(response);
      } catch (error) { next(error); }
      finally { analysisBusy = false; }
    });
  }

  app.get('/api/analyses', async (req, res, next) => {
    try { res.json(await archive.list({ ...filters(req), limit: bounded(req.query.limit, 100, 1, 100), offset: bounded(req.query.offset, 0, 0, 10000000) })); }
    catch (error) { next(error); }
  });
  app.get('/api/analyses/:id', async (req, res, next) => {
    try {
      const record = await archive.get(req.params.id);
      if (!record) return res.status(404).json({ error: '未找到该分析记录。' });
      res.json(record);
    } catch (error) { next(error); }
  });

  async function performance(req, refresh = false) {
    const records = await archive.list({ ...filters(req), limit: 501, snapshots: true });
    const truncated = records.length > 500;
    const selected = records.slice(0, 500);
    const items = [], errors = [], client = refresh ? marketData : null;
    let excluded = 0;
    const now = Date.now(), fetched = new Set();
    for (const record of selected) {
      for (const signal of record.analyses || []) {
        if (filters(req).symbol && signal.symbol !== filters(req).symbol) continue;
        if (!record.snapshot?.costs || !signal.eligible || record.snapshot.exchange !== 'binance') { excluded++; continue; }
        const start = Date.parse(signal.firstEntryAt), end = Math.min(now, evaluationEnd(signal));
        const provider = record.snapshot.marketProvider || 'binance';
        if (refresh && provider !== client.provider) errors.push(`${signal.symbol}：保留原 ${provider} 行情评估，当前行情源不同，未混用新数据。`);
        if (refresh && provider === client.provider && start < end) {
          const key = `${provider}|${signal.symbol}|${signal.interval}|${start}|${end}`;
          if (!fetched.has(key)) {
            fetched.add(key);
            try {
              // Every plan is bounded to <=126 bars, so a 200-row bounded window is complete.
              const rows = await client.klines({ symbol: signal.symbol, interval: signal.interval, endTime: end - 1, startTime: start, limit: 200 });
              await marketDb.saveKlines({ symbol: marketStorageSymbol(signal.symbol, provider), interval: signal.interval,
                rows: rows.filter(r => r.openTime >= start && r.openTime < end && nextOpenTime(r.openTime, signal.interval) <= now) });
            } catch (error) { errors.push(`${signal.symbol}: ${error.message}`); }
          }
        }
        const rows = start < end ? await archive.candles(signal.symbol, signal.interval, start, end, provider) : [];
        items.push({ id: `${record.id}:${signal.symbol}`, recordId: record.id, symbol: signal.symbol, interval: signal.interval,
          direction: signal.positionRecommendation, strategyVersion: record.strategyVersion, at: record.at,
          confidence: signal.confidence, costs: record.snapshot.costs,
          evaluation: evaluateSignal(signal, rows, record.snapshot.costs, now) });
      }
    }
    const group = field => [...new Set(items.map(i => i[field]))].map(key => ({ key, ...summarizeResults(items.filter(i => i[field] === key)) }));
    return { asOf: new Date(now).toISOString(), records: selected.length, truncated, excluded, summary: summarizeResults(items),
      byStrategy: group('strategyVersion'), bySymbol: group('symbol'), byDirection: group('direction'), items, errors };
  }
  app.get('/api/research/performance', async (req, res, next) => {
    try { res.json(await performance(req)); } catch (error) { next(error); }
  });
  app.post('/api/research/performance/refresh', async (req, res, next) => {
    if (refreshBusy) return res.status(409).json({ error: '模拟行情正在同步，请稍后重试。' });
    refreshBusy = true;
    try { res.json(await performance(req, true)); } catch (error) { next(error); }
    finally { refreshBusy = false; }
  });

  // 返回实例供全局自动化使用
  return { simulation, archive, automation };
}

function filters(req) {
  return { date: String(req.query.date || '').trim(), symbol: String(req.query.symbol || '').trim().toUpperCase() };
}
