import { randomUUID } from 'node:crypto';
import { analyzeMarkets, reviewPosition } from './ai.js';
import { LOCAL_STRATEGY, localAnalysisMultiTimeframe } from './localAnalysis.js';
import { candleOpenAt, nextOpenTime, prepareMarket, createResearchRecord, MAIN_INTERVAL } from './research.js';
import { advancePaperOrder, submitPaperOrder } from './simulatedAccount.js';
import { analyzeHoldingPeriodPerformance, generateOptimizedParameters } from './adaptiveStrategy.js';
import {
  filterSymbolsByPerformance,
  shouldTradeAtCurrentHour,
  getAdaptiveParametersForSymbol
} from './adaptiveFilters.js';
import { getAdaptiveConfig } from './adaptiveConfig.js';

const periods = { scan: 2 * 3600000, review: 5 * 60000 };
export function automationDefaults(now = Date.now()) {
  return { version: 1, enabled: true, engine: 'local', interval: MAIN_INTERVAL, margin: 100,
    scan: { nextAt: now, running: false }, review: { nextAt: now + periods.review, running: false } };
}

export function claimAutomationJob(state, kind, owner, now = Date.now(), force = false) {
  const automation = state.automation;
  if (!automation?.enabled) return null;
  const job = automation[kind];
  if (job.running && job.leaseUntil > now) return null;
  if (!job.running && !force && job.nextAt > now) return null;
  if (!job.running) Object.assign(job, { runId: randomUUID(), startedAt: now, nextAt: now + periods[kind],
    index: 0, total: 0, submitted: 0, eligible: 0, updated: 0, held: 0, failed: 0, symbols: null, errors: [] });
  Object.assign(job, { running: true, owner, leaseUntil: now + 180000 });
  return structuredClone(job);
}

export function localProtectionReview(order, market) {
  const rows = market.klines, price = rows.at(-1).close;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;
  if (!(atr > 0)) return { action: 'HOLD', reason: '波动率无效，保留当前保护价格。' };
  const long = order.direction === 'OPEN_LONG';
  // 未盈利超过2%时保持初始保护价格，避免把止损棘轮式推向现价被噪声扫出。
  const profit = long ? (price - order.entry) / order.entry : (order.entry - price) / order.entry;
  if (!(profit > 0.02)) return { action: 'HOLD', reason: '持仓未盈利超过2%，保持初始保护价格，避免噪声止损。' };
  // 移动止损距离放宽到 2.5×ATR（原 1.5×ATR 过紧，1m 噪音即可扫掉盈利单；P0-1）
  const TRAIL_ATR = 2.5;
  const stopLoss = long ? Math.max(order.plan.stopLoss, price - TRAIL_ATR * atr) : Math.min(order.plan.stopLoss, price + TRAIL_ATR * atr);
  // 止盈跟随对齐开仓目标 4×ATR，让盈利单能跑到完整目标而非被贴身止损提前扫掉
  const TP_ATR = 4;
  const takeProfit = long ? Math.max(order.plan.takeProfit, price + TP_ATR * atr) : Math.min(order.plan.takeProfit, price - TP_ATR * atr);
  return { action: 'UPDATE_PROTECTION', stopLoss, takeProfit, confidence: 0.75, reason: '盈利超过2%，按最新 14 根真实波幅复核；只收紧止损，顺势调整止盈。' };
}

export function applyPaperProtectionReview(order, proposal, now = Date.now(), engine = 'local') {
  if (order.status !== 'open') return { action: 'held', reason: '订单尚未入场或已经结束。' };
  const report = { at: new Date(now).toISOString(), engine, action: 'held', reason: proposal.reason || '保留当前保护价格。' };
  const record = () => { order.reviewHistory = [...(order.reviewHistory || []), report].slice(-50); return report; };
  if (order.error || Date.parse(order.markAt) !== candleOpenAt(now, order.interval)) { report.reason = '行情尚未连续结算到最新收盘时间，暂不修改。'; return record(); }
  if (proposal.action !== 'UPDATE_PROTECTION') return record();
  if (engine === 'ai' && (!Number.isFinite(Number(proposal.confidence)) || Number(proposal.confidence) < 0.65 || Number(proposal.confidence) > 1)) { report.reason = 'AI 自评分无效或低于复核阈值，保留原保护。'; return record(); }
  const stopLoss = Number(proposal.stopLoss), takeProfit = Number(proposal.takeProfit), price = Number(order.markPrice);
  const long = order.direction === 'OPEN_LONG';
  if (![stopLoss, takeProfit, price].every(v => Number.isFinite(v) && v > 0)
    || (long ? !(stopLoss < price && price < takeProfit) : !(takeProfit < price && price < stopLoss))
    || (long ? stopLoss < order.plan.stopLoss : stopLoss > order.plan.stopLoss)) {
    report.reason = '建议价格无效、已被穿越或扩大了止损风险，保留原保护。'; return record();
  }
  if (Math.abs(stopLoss - order.plan.stopLoss) / price < 0.0001 && Math.abs(takeProfit - order.plan.takeProfit) / price < 0.0001) return record();
  order.initialPlan ||= { ...order.plan };
  const effectiveFrom = nextOpenTime(candleOpenAt(now, order.interval), order.interval);
  const revision = { stopLoss, takeProfit, effectiveFrom, at: report.at };
  order.protectionRevisions = [...(order.protectionRevisions || []), revision];
  Object.assign(report, { action: 'updated', previous: { stopLoss: order.plan.stopLoss, takeProfit: order.plan.takeProfit }, stopLoss, takeProfit, effectiveFrom });
  order.plan = { ...order.plan, stopLoss, takeProfit };
  return record();
}

export class PaperAutomation {
  constructor({ simulation, store, market, marketDb, archive, analyze = analyzeMarkets, review = reviewPosition }) {
    Object.assign(this, { simulation, store, market, marketDb, archive, analyze, review, owner: randomUUID(), running: new Set() });
  }
  async init() {
    await this.simulation.mutate(state => {
      if (state.automation?.version !== 1) state.automation = automationDefaults();
      state.automation.interval = MAIN_INTERVAL;
      state.unlimitedCapital = true;
    });
  }
  start() { this.timer = setInterval(() => this.tick(), 5000); this.timer.unref(); this.tick(); }
  tick() { for (const kind of ['scan', 'review']) this.run(kind).catch(() => {}); }
  async configure(input) {
    return this.simulation.mutate(state => {
      if (typeof input.enabled === 'boolean') state.automation.enabled = input.enabled;
      if (input.engine !== undefined) {
        if (!['local', 'auto', 'ai'].includes(input.engine)) throw Object.assign(new Error('不支持的分析方式。'), { status: 422 });
        state.automation.engine = input.engine;
      }
      return state.automation;
    });
  }
  async editJob(kind, fn) {
    return this.simulation.mutate(state => {
      const job = state.automation[kind];
      if (job.owner !== this.owner || !job.running) throw new Error('任务租约已被其他进程接管。');
      job.leaseUntil = Date.now() + 180000;
      return fn(job, state);
    });
  }
  async fresh(symbol, interval = MAIN_INTERVAL) {
    const key = this.market.storageSymbol(symbol);
    const now = Date.now();

    // 交易所也没有足够已收盘K线（如新上币种）时，降级返回部分数据，不抛错
    const buildPartial = rows => {
      const closed = (Array.isArray(rows) ? rows : [])
        .filter(row => row.confirmed !== false && nextOpenTime(row.openTime, interval) <= now)
        .sort((a, b) => a.openTime - b.openTime).slice(-80)
        .map(row => ({ ...row, closeTime: nextOpenTime(row.openTime, interval) - 1 }));
      return {
        symbol,
        exchange: 'binance',
        marketProvider: this.market.provider,
        interval,
        dataAsOf: new Date(nextOpenTime(closed.at(-1)?.openTime ?? now, interval)).toISOString(),
        klines: closed,
        partial: true
      };
    };

    let rows = await this.marketDb.listKlines({ symbol: key, interval, limit: 80 });
    try { return prepareMarket({ symbol, interval, rows, limit: 80, marketProvider: this.market.provider }); }
    catch {
      const raw = await this.market.klines({ symbol, interval, limit: 82 });
      const prepared = prepareMarket({ symbol, interval, rows: raw, limit: 80, marketProvider: this.market.provider, throwOnInsufficient: false });
      if (prepared.insufficient) return buildPartial(raw);
      await this.marketDb.saveKlines({ symbol: key, interval, rows: prepared.klines });
      return prepared;
    }
  }
  async run(kind, force = false) {
    if (this.running.has(kind)) return;
    this.running.add(kind);
    let job;
    try {
      job = await this.simulation.mutate(state => claimAutomationJob(state, kind, this.owner, Date.now(), force));
      if (!job) return;
      const settings = (await this.simulation.read()).automation;
      const config = await this.store.getConfig(), hasModel = config.model.enabled && config.model.apiKey;
      if (settings.engine === 'ai' && !hasModel) throw new Error('AI 自动分析需要模型 Key，可在模拟交易页选择本地规则。');
      const engine = settings.engine === 'local' || !hasModel ? 'local' : 'ai';
      const strategy = { ...await this.store.getStrategy(), interval: MAIN_INTERVAL };
      strategy.rules = `${strategy.rules || ''}\n本轮为自动模拟任务：使用提供的 ${MAIN_INTERVAL} 已收盘行情；持仓时限与保护价格由本地策略版本和经验证的自适应参数决定。持仓复核只考虑保持或调整止盈止损，不扩大止损风险。`;
      await this.editJob(kind, j => { j.engine = engine; });
      if (kind === 'scan') await this.scan(job, config, strategy, engine);
      else await this.reviewOrders(job, config, strategy, engine);
      await this.editJob(kind, j => { j.running = false; j.finishedAt = Date.now(); j.leaseUntil = 0; });
    } catch (error) {
      if (job) await this.editJob(kind, j => { j.running = false; j.finishedAt = Date.now(); j.failed++; j.errors = [...(j.errors || []), error.message].slice(-30); }).catch(() => {});
    } finally { this.running.delete(kind); }
  }
  async scan(job, config, strategy, engine) {
    const allSymbols = job.symbols || (await this.market.perpetualUsdtContracts()).map(s => s.symbol);

    // 获取历史订单用于自适应过滤和优化
    const state = await this.simulation.read();
    const closedOrders = state.orders.filter(o => o.status === 'closed');
    // The old strategy is useful for diagnosis, but cannot tune a different
    // entry/exit rule. Only v2 outcomes can automatically alter v2 parameters.
    const historicalOrders = closedOrders.filter(o => o.analysisContext?.strategyModel === LOCAL_STRATEGY.modelId);
    // P3：币种黑名单不能用 strategyModel 过滤——engine 不是 'local' 时（如 enhanced）
    // strategyModel 不是 LOCAL_STRATEGY.modelId，样本会被过滤成空集，过滤器永远不生效。
    // 一个币长期亏钱跟它是哪个引擎下单无关，这里用全部已平仓样本。
    const filterHistory = closedOrders;
    const adaptiveConfig = getAdaptiveConfig(state.adaptiveConfig);
    const adaptiveOverrides = state.adaptiveOverrides || {};

    // 1. 应用币种过滤
    const symbolFilterResult = filterSymbolsByPerformance(allSymbols, filterHistory, {
      ...adaptiveConfig.symbolFilter,
      enabled: adaptiveConfig.symbolFilter.enabled && filterHistory.length >= adaptiveConfig.symbolFilter.minOrdersToActivate
    });

    const symbols = symbolFilterResult.filtered;

    if (symbolFilterResult.filteredOut.length > 0) {
      console.log(`[自适应过滤] 过滤了${symbolFilterResult.filteredOut.length}个负期望值币种:`,
        symbolFilterResult.filteredOut.map(f => `${f.symbol}(${Number(f.avgNet || 0).toFixed(2)}U/单, 样本${f.count})`).join(', '));
    }

    // 2. 检查当前时段是否适合交易
    const currentHour = new Date().getUTCHours();
    const hourCheck = shouldTradeAtCurrentHour(currentHour, historicalOrders, {
      ...adaptiveConfig.hourFilter,
      enabled: adaptiveConfig.hourFilter.enabled && historicalOrders.length >= adaptiveConfig.hourFilter.minOrdersToActivate
    });

    if (!hourCheck.shouldTrade) {
      console.log(`[自适应过滤] ${hourCheck.reason}`);
      await this.editJob('scan', j => {
        j.symbols = symbols;
        j.total = symbols.length;
        j.skippedDueToHour = true;
        j.nextAt = Date.now() + 1800000; // 30分钟后重试
      });
      return;
    }

    // 3. 分析持仓时长并生成优化参数
    const holdingAnalysis = analyzeHoldingPeriodPerformance(historicalOrders);
    let optimizedParams = null;

    if (adaptiveConfig.holdingPeriodOptimization.enabled && holdingAnalysis.sufficient) {
      optimizedParams = generateOptimizedParameters(holdingAnalysis, LOCAL_STRATEGY.maxHoldBars);

      if (optimizedParams.shouldApply && optimizedParams.confidence >= adaptiveConfig.holdingPeriodOptimization.autoApplyThreshold) {
        console.log(`[自适应优化] 基于${holdingAnalysis.sampleSize}笔历史订单，调整maxHoldBars: ${LOCAL_STRATEGY.maxHoldBars} → ${optimizedParams.suggestedMaxHoldBars}`);
        console.log(`[自适应优化] 整体胜率: ${(holdingAnalysis.overallWinRate * 100).toFixed(1)}%, 平均持仓: ${holdingAnalysis.avgHoldingBars.toFixed(1)}根`);

        // 添加优化建议到策略规则
        strategy.rules += `\n\n## 自适应策略优化（基于${holdingAnalysis.sampleSize}笔历史订单）\n`;
        strategy.rules += `- 最大持仓时长: ${optimizedParams.suggestedMaxHoldBars}根K线\n`;
        strategy.rules += `- 整体胜率: ${(holdingAnalysis.overallWinRate * 100).toFixed(1)}%\n`;

        if (optimizedParams.recommendations.length > 0) {
          strategy.rules += `\n### 优化建议:\n`;
          for (const rec of optimizedParams.recommendations.slice(0, 3)) {
            strategy.rules += `- [${rec.priority.toUpperCase()}] ${rec.message}\n`;
          }
        }
      }
    }

    await this.editJob('scan', j => {
      j.symbols = symbols;
      j.total = symbols.length;
      j.filteredSymbols = symbolFilterResult.filteredOut.length;
      j.hourCheck = hourCheck.reason;
      j.optimizationApplied = optimizedParams?.shouldApply || false;
      j.adaptiveSampleSize = historicalOrders.length;
    });

    for (let index = job.index; index < symbols.length; index += 5) {
      if (!(await this.simulation.read()).automation.enabled) break;
      const results = await Promise.all(symbols.slice(index, index + 5).map(async symbol => {
        try {
          const id = `auto-${job.runId}-${symbol}`;
          let record = await this.archive.get(id);
          if (!record) {
            const market = await this.fresh(symbol);

            // 使用多周期分析作为默认
            let result;
            if (engine === 'local') {
              // 获取辅助周期数据
              const auxMarkets = {};
              try {
                const intervals = ['15m', '1h', '4h'];
                for (const interval of intervals) {
                  if (interval === strategy.interval) continue;
                  const auxMarket = await this.fresh(symbol, interval);
                  auxMarkets[interval] = auxMarket;
                }

                // 获取该币种的自适应参数
                const defaults = {
                  defaultStopLossATR: LOCAL_STRATEGY.stopLossAtr,
                  defaultTakeProfitATR: LOCAL_STRATEGY.takeProfitAtr,
                  defaultMaxHoldBars: optimizedParams?.suggestedMaxHoldBars || LOCAL_STRATEGY.maxHoldBars,
                  minSampleSize: adaptiveConfig.symbolLevelParams.minSampleSize
                };
                const calculatedParams = adaptiveConfig.symbolLevelParams.enabled
                  ? getAdaptiveParametersForSymbol(symbol, historicalOrders, defaults)
                  : { stopLossATR: defaults.defaultStopLossATR, takeProfitATR: defaults.defaultTakeProfitATR,
                    maxHoldBars: defaults.defaultMaxHoldBars, confidence: 0, reason: '币种级自适应参数未启用。' };
                const adaptiveParams = {
                  ...calculatedParams,
                  ...adaptiveOverrides,
                  confidence: Object.keys(adaptiveOverrides).length ? 1 : calculatedParams.confidence,
                  reason: Object.keys(adaptiveOverrides).length ? '使用手工设定的自适应参数。' : calculatedParams.reason
                };

                if (adaptiveParams.confidence > 0) {
                  console.log(`[自适应参数] ${symbol}: ${adaptiveParams.reason}`);
                }

                // 使用多周期分析（传入自适应参数）
                result = { analyses: [localAnalysisMultiTimeframe(market, auxMarkets, adaptiveParams)] };
              } catch (error) {
                // 辅助数据失败时保持观望，禁止降级开仓。
                console.warn(`多周期数据获取失败 ${symbol}:`, error.message);
                result = { analyses: [localAnalysisMultiTimeframe(market, {})] };
              }

            } else {
              result = await this.analyze({ config, strategy, market: [market] });
            }

            const modelName = LOCAL_STRATEGY.modelId;

            record = createResearchRecord({
              config: engine === 'local' ? { ...config, model: { model: modelName, baseUrl: 'local://rules' } } : config,
              strategy, market: [market], result, type: 'single', scope: { interval: MAIN_INTERVAL, limit: 80, engine }
            });

            Object.assign(record, { id, analysisEngine: engine, automationRunId: job.runId });
            for (const signal of record.analyses) {
              signal.analysisEngine = engine;
              if (engine === 'local') signal.confidenceType = 'rule_strength';
            }
            await this.archive.save(record);
          }
          if (record.error) return { symbol, error: record.error };
          if (!record.analyses[0]?.eligible) return { symbol, held: true };
          await this.editJob('scan', (j, state) => {
            if (!state.automation.enabled) throw new Error('自动流程已暂停。');
            submitPaperOrder(state, record, { symbol, margin: 100, leverage: record.analyses[0].recommendedLeverage, automatic: true });
          });
          return { symbol, submitted: true, eligible: true };
        } catch (error) { return { symbol, error: error.message }; }
      }));
      await this.editJob('scan', j => {
        j.index = index + results.length;
        j.submitted += results.filter(r => r.submitted).length; j.eligible += results.filter(r => r.eligible).length;
        j.held += results.filter(r => r.held).length; j.failed += results.filter(r => r.error).length;
        j.errors = [...j.errors, ...results.filter(r => r.error).map(r => `${r.symbol}: ${r.error}`)].slice(-30);
      });
    }

    // P3 可观测性：区分"降频生效"与"门槛过严 / 币种被全量拉黑"导致的静默失效
    const finalScan = (await this.simulation.read()).automation?.scan;
    if (symbols.length === 0) {
      console.warn('[自适应过滤][告警] 币种过滤后候选为 0 —— 过滤器可能把所有币种都拉黑了，请检查自适应过滤样本！');
    } else if (finalScan && finalScan.eligible === 0) {
      console.warn(`[自适应过滤][告警] 本轮 0 个合格信号（候选${symbols.length}，已处理${finalScan.index}）—— 入场门槛可能过严。`);
    }
  }
  async reviewOrders(job, config, strategy, engine) {
    await this.simulation.refresh();
    const state = await this.simulation.read();
    const ids = job.symbols || state.orders.filter(o => o.status === 'open').map(o => o.id);
    await this.editJob('review', j => { j.symbols = ids; j.total = ids.length; });
    const markets = new Map();
    for (let index = job.index; index < ids.length; index++) {
      if (!(await this.simulation.read()).automation.enabled) break;
      const order = (await this.simulation.read()).orders.find(o => o.id === ids[index]);
      if (!order || order.status !== 'open') { await this.editJob('review', j => { j.index = index + 1; j.held++; }); continue; }
      try {
        const key = `${order.symbol}:${order.interval}`;
        if (!markets.has(key)) markets.set(key, await this.fresh(order.symbol, order.interval));
        const market = markets.get(key);
        // 已收盘K线过少（如新上币种）时跳过复核，避免指标计算出错
        if (market.partial && market.klines.length < 15) {
          await this.editJob('review', j => { j.index = index + 1; j.held++; });
          continue;
        }
        const proposal = engine === 'local' ? localProtectionReview(order, market) : await this.review({ config, strategy: { ...strategy, interval: order.interval },
          market, position: { symbol: order.symbol, positionAmt: order.quantity * (order.direction === 'OPEN_LONG' ? 1 : -1), entryPrice: order.entry,
            markPrice: market.klines.at(-1).close, stopLoss: order.plan.stopLoss, takeProfit: order.plan.takeProfit, simulated: true } });
        await this.editJob('review', (j, state) => {
          const current = state.orders.find(o => o.id === order.id);
          if (!state.automation.enabled) return;
          if (!current || current.lastReviewRunId === job.runId) { j.index = index + 1; return; }
          advancePaperOrder(current, market.klines);
          const report = applyPaperProtectionReview(current, proposal, Date.now(), engine);
          current.lastReviewRunId = job.runId;
          j.index = index + 1; if (report.action === 'updated') j.updated++; else j.held++;
        });
      } catch (error) {
        await this.editJob('review', j => { j.index = index + 1; j.failed++; j.errors = [...j.errors, `${order.symbol}: ${error.message}`].slice(-30); });
      }
    }
  }
}

export function registerAutomationRoutes(app, automation) {
  app.put('/api/paper/automation', async (req, res, next) => { try { res.json(await automation.configure(req.body || {})); } catch (error) { next(error); } });
  app.post('/api/paper/automation/:kind', async (req, res) => {
    if (!['scan', 'review'].includes(req.params.kind)) return res.status(400).json({ error: '未知模拟任务。' });
    automation.run(req.params.kind, true).catch(() => {});
    res.status(202).json({ accepted: true, message: '任务已提交，请查看任务进度。' });
  });
}
