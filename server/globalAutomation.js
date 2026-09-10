/**
 * 全局自动化交易系统
 *
 * 仅两项自动任务：全市场逐币种拉取、分析、挂单；活跃订单行情、复核和盈亏。
 */

import { randomUUID } from 'node:crypto';
import { LOCAL_STRATEGY, localAnalysisMultiTimeframe, recommendedLeverage } from './localAnalysis.js';
import { getAdaptiveConfig } from './adaptiveConfig.js';
import { filterSymbolsByPerformance, getAdaptiveParametersForSymbol, shouldTradeAtCurrentHour } from './adaptiveFilters.js';
import { enhancedAnalysis, enhancedProtectionReview } from './enhancedAnalysis.js';
import { createSuperEnhancedAnalysis } from './superEnhancedAnalysis.js';
import { analyzeMarkets, reviewPosition } from './ai.js';
import { nextOpenTime, prepareMarket, createResearchRecord, MAIN_INTERVAL } from './research.js';
import { localProtectionReview, applyPaperProtectionReview } from './shared/protectionReview.js';
import { proxyHealth } from './core/proxyHealth.js';
import { applyPendingReview, HELD_INELIGIBLE } from './shared/pendingReview.js';

// ── 同币种冷却（2026-09-11 优化：由「仅止损后」扩展到「任意平仓后」）────────
// 依据：2711 笔真实成交 + 真实 1m K 线回放，统一出场（2ATR 止损/3R 止盈/1R 后移动 1.5ATR/120 根）。
// 策略期望为负（均单 -0.0108，t=-9.64），因此「少交易」是唯一确定的减亏手段。
// 冷却不改变单笔质量（均单几乎不变），靠降低交易频率线性减亏：
//   无冷却      保留100%  累计 -29.3  均单 -0.0108
//   15 分钟     保留 72%  累计 -21.8  均单 -0.0112
//   30 分钟     保留 62%  累计 -19.2  均单 -0.0114   ← 采用（减亏约 34%）
//   60 分钟     保留 53%  累计 -19.2  均单 -0.0134
//   120 分钟    保留 44%  累计 -16.9  均单 -0.0141
// 为什么不用「提高 ATR 门槛」：当前市况 1m 波动率中位数仅 0.079%，
//   绝对阈值 0.40% 只有 3.7% 的币能通过、0.60% 仅 0.5% → 系统停摆。冷却与市况无关，安全。
// 验证口径：训练/测试按入场时间前 50%/后 50% 切分，两段结论一致。
// 回滚：NOFX_SYMBOL_COOLDOWN_MIN=0
const SYMBOL_COOLDOWN_MIN = Math.max(0, Number(process.env.NOFX_SYMBOL_COOLDOWN_MIN ?? 30));
// 止损后的加长冷却（保持历史行为，默认 60 分钟）
const STOP_COOLDOWN_MIN = Math.max(0, Number(process.env.NOFX_STOP_COOLDOWN_MIN ?? 60));

export function selectAnalysisEngine(config = {}) {
  const analysis = config.analysis || {};
  const requested = analysis.engine
    || (analysis.useSuperEnhanced === true ? 'super' : analysis.useEnhanced === true ? 'enhanced' : 'local');
  const hasModel = config.model?.enabled === true && Boolean(config.model.apiKey);
  if (requested === 'ai') return hasModel ? 'ai' : 'local';
  return ['local', 'enhanced', 'super'].includes(requested) ? requested : 'local';
}

export class GlobalAutomation {
  constructor({ simulation, market, marketDb, archive, store }) {
    this.simulation = simulation;
    this.market = market;
    this.marketDb = marketDb;
    this.archive = archive;
    this.store = store;
    this.owner = randomUUID();
    this.superAnalysis = createSuperEnhancedAnalysis({ store });

    this.tasks = {
      klineSync: { enabled: true, interval: 60000, lastRun: null, running: false },
      positionReview: { enabled: true, interval: 10000, lastRun: null, running: false }
    };
    this.inFlight = new Map();

    this.timers = {};
    // 递归调度的代际标记：重新调度/停止时递增，使旧循环自然退出，避免重复循环
    this.taskTokens = {};
    this.schedulerActive = false;
    this.stats = {
      totalAnalyzed: 0,
      totalOrders: 0,
      totalReviews: 0,
      errors: []
    };
  }

  /**
   * 启动全局自动化系统
   */
  start() {
    if (this.schedulerActive) return;
    this.schedulerActive = true;
    for (const name of Object.keys(this.tasks)) this.scheduleTask(name);
  }

  /**
   * 停止全局自动化系统
   */
  stop() {
    console.log('[GlobalAutomation] 停止全局自动化系统...');
    // 先置代际标记并停用调度，让递归循环自然退出（clearTimeout 只清理已排队的那一跳）
    this.schedulerActive = false;
    for (const name of Object.keys(this.tasks)) this.taskTokens[name] = (this.taskTokens[name] || 0) + 1;
    Object.keys(this.timers).forEach(key => {
      if (this.timers[key]) {
        clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }
    });
    console.log('[GlobalAutomation] 全局自动化系统已停止');
  }

  /**
   * 调度任务
   */
  scheduleTask(name) {
    clearTimeout(this.timers[name]);
    const token = this.taskTokens[name] = (this.taskTokens[name] || 0) + 1;
    const current = () => this.schedulerActive && this.taskTokens[name] === token;
    const run = async () => {
      if (!current()) return;
      await this.executeTask(name, this.getTaskFunction(name), current);
      if (!current()) return;
      this.tasks[name].nextRunAt = new Date(Date.now() + this.tasks[name].interval).toISOString();
      this.timers[name] = setTimeout(run, this.tasks[name].interval);
      this.timers[name].unref();
    };
    void run();
  }

  /**
   * 执行任务
   */
  async executeTask(name, fn, current = () => true) {
    const task = this.tasks[name];
    if (!task) throw new Error(`Unknown automation task: ${name}`);
    if (this.inFlight.has(name)) return this.inFlight.get(name);
    if (!task.enabled || !current()) return;
    task.running = true;
    task.startedAt = new Date().toISOString();
    task.nextRunAt = null;
    task.error = '';
    const shouldContinue = () => current() && task.enabled;
    const work = (async () => {
      try {
        await proxyHealth.check();
        if (!proxyHealth.isAlive()) throw new Error('Market proxy unavailable');
        await fn(shouldContinue);
        task.lastRun = new Date().toISOString();
      } catch (error) {
        task.error = error.message;
        this.stats.errors.push({ task: name, error: error.message, time: new Date().toISOString() });
        this.stats.errors = this.stats.errors.slice(-50);
      } finally {
        task.running = false;
        this.inFlight.delete(name);
      }
    })();
    this.inFlight.set(name, work);
    return work;
  }

  // Task 1: finish fetch -> analysis -> optional submission for each symbol.
  async syncKlines(shouldContinue = () => true) {
    const symbols = (await this.market.perpetualUsdtContracts()).map(c => c.symbol);
    const context = {};
    const progress = this.tasks.klineSync.progress = { total: symbols.length, completed: 0, failed: 0, symbol: null };
    for (const symbol of symbols) {
      if (!shouldContinue()) break;
      progress.symbol = symbol;
      try {
        const market = await this.getFreshMarket(symbol, MAIN_INTERVAL, true);
        if (!shouldContinue()) break;
        await this.runAnalysis({ symbols: [symbol], preparedMarket: market, shouldContinue, context });
      } catch (error) {
        progress.failed++;
        this.tasks.klineSync.error = `${symbol}: ${error.message}`;
      }
      progress.completed++;
      await new Promise(resolve => setImmediate(resolve));
    }
    progress.symbol = null;
  }

  async runAnalysis({ symbols: requestedSymbols, preparedMarket, submit = true, interval = MAIN_INTERVAL, shouldContinue = () => true, context = {} } = {}) {
    // 代理宕机时跳过本轮分析，避免对全市场币种逐个刷 fetch failed。
    if (!proxyHealth.isAlive()) {
      console.warn('[GlobalAutomation] 代理不可用，跳过本轮行情分析（OKX 行情中断）。');
      return;
    }
    const config = context.config ??= await this.store.getConfig();
    const strategy = { ...(context.strategy ??= await this.store.getStrategy()), interval };
    const engine = selectAnalysisEngine(config);

    console.log(`[GlobalAutomation] 开始行情分析，使用 ${engine} 模式...`);

    let symbols = requestedSymbols || (await this.market.perpetualUsdtContracts()).map(s => s.symbol);
    const signals = [];
    const runId = randomUUID();
    const failures = [];

    // P3 修复：币种过滤原先整段写在 engine === 'local' 分支里，engine='enhanced'/'super' 时
    // 根本不会执行（而且样本还按 strategyModel === LOCAL_STRATEGY.modelId 过滤，
    // enhanced 下单的 modelId 是 `${engine}-rules-v1`，导致样本恒为 0、过滤器永远不生效）。
    // 现在改为：任何引擎都先读取状态并做一次基于"全部已平仓订单"的负期望值币种拉黑。
    const state = context.state ??= this.simulation.read ? await this.simulation.read() : { orders: [] };
    const adaptiveConfig = getAdaptiveConfig(state.adaptiveConfig);
    const adaptiveOverrides = state.adaptiveOverrides || {};
    // 自适应参数（止盈止损 ATR 等）只信任本地策略自身样本，避免用别的引擎结果调本地参数。
    const localHistory = (state.orders || []).filter(order =>
      order.status === 'closed' && order.analysisContext?.strategyModel === LOCAL_STRATEGY.modelId
    );
    // 币种黑名单则用全部引擎的已平仓样本：一个币长期亏钱，与它是哪个引擎下单无关。
    const filterHistory = (state.orders || []).filter(order => order.status === 'closed');

    const symbolFilter = filterSymbolsByPerformance(symbols, filterHistory, {
      ...adaptiveConfig.symbolFilter,
      enabled: adaptiveConfig.symbolFilter.enabled && filterHistory.length >= adaptiveConfig.symbolFilter.minOrdersToActivate
    });
    symbols = symbolFilter.filtered;
    if (symbolFilter.filteredOut.length) {
      console.log(`[GlobalAutomation] 过滤 ${symbolFilter.filteredOut.length} 个负期望值币种: ${symbolFilter.filteredOut
        .map(f => `${f.symbol}(${Number(f.avgNet || 0).toFixed(2)}U/单, 样本${f.count})`).join(', ')}`);
    }

    if (engine === 'local') {
      const hourCheck = shouldTradeAtCurrentHour(new Date().getUTCHours(), localHistory, {
        ...adaptiveConfig.hourFilter,
        enabled: adaptiveConfig.hourFilter.enabled && localHistory.length >= adaptiveConfig.hourFilter.minOrdersToActivate
      });
      if (!hourCheck.shouldTrade) {
        console.log(`[GlobalAutomation] 本地策略跳过本轮扫描：${hourCheck.reason}`);
        return;
      }
    }

    // 超级增强版：预筛选
    if (engine === 'super') {
      const preFilter = await this.superAnalysis.preFilter(symbols);
      symbols = preFilter.filtered;
      console.log(`[GlobalAutomation] 预筛选: ${preFilter.removed}个币种被过滤`);
      if (preFilter.reasons) {
        console.log(`[GlobalAutomation] 过滤原因: 市值${preFilter.reasons.lowMarketCap}, 流动性${preFilter.reasons.lowLiquidity}, 波动${preFilter.reasons.extremeVolatility}`);
      }
    }

    let analyzed = 0;
    let eligible = 0;
    let submitted = 0;
    let failed = 0;
    // P3 可观测性：记录本轮被各道闸门挡掉的数量，用于区分"正常降频"与"门槛过严导致 0 开单"。
    // 注意 reason 取的是各道 wait() 的首个拦截原因，因此每个币种最多计一次（最靠前的那道闸）。
    const blockedBy = { score: 0, volume: 0, riskReward: 0 };
    const tallyBlock = reason => {
      const text = String(reason || '');
      if (text.includes('综合信号强度不足')) blockedBy.score++;
      else if (text.includes('成交量不足')) blockedBy.volume++;
      else if (text.includes('风险收益比不足')) blockedBy.riskReward++;
    };

    // 并行处理，每次处理20个币种（提高并发数）
    const batchSize = 20;
    for (let i = 0; i < symbols.length; i += batchSize) {
      if (!shouldContinue()) break;
      const batch = symbols.slice(i, i + batchSize);

      const results = await Promise.all(batch.map(async symbol => {
        try {
          // 获取主周期K线
          const market = preparedMarket || await this.getFreshMarket(symbol, interval);

          // 使用多周期分析作为默认
          let analysis;
          if (engine === 'local') {
            // 并行获取辅助周期数据
            const auxMarketsPromises = [];
            const intervals = ['15m', '1h', '4h'];

            for (const interval of intervals) {
              if (interval === market.interval) continue;
              auxMarketsPromises.push(
                this.getFreshMarket(symbol, interval)
                  .then(m => ({ interval, market: m }))
                  .catch(err => {
                    console.warn(`[GlobalAutomation] 获取 ${symbol} ${interval} 失败:`, err.message);
                    return null;
                  })
              );
            }

            const auxMarketsArray = await Promise.all(auxMarketsPromises);
            if (!submit && auxMarketsArray.some(item => !item || item.market.partial)) {
              throw new Error('Auxiliary market data incomplete; retaining pending order');
            }
            const auxMarkets = {};
            for (const item of auxMarketsArray) {
              if (item) auxMarkets[item.interval] = item.market;
            }

            // 辅助数据缺失时，多周期分析返回 WAIT。
            const defaults = {
              defaultStopLossATR: LOCAL_STRATEGY.stopLossAtr,
              defaultTakeProfitATR: LOCAL_STRATEGY.takeProfitAtr,
              defaultMaxHoldBars: LOCAL_STRATEGY.maxHoldBars,
              minSampleSize: adaptiveConfig.symbolLevelParams.minSampleSize
            };
            const calculated = adaptiveConfig.symbolLevelParams.enabled
              ? getAdaptiveParametersForSymbol(symbol, localHistory, defaults)
              : { stopLossATR: defaults.defaultStopLossATR, takeProfitATR: defaults.defaultTakeProfitATR,
                maxHoldBars: defaults.defaultMaxHoldBars, confidence: 0, reason: '币种级自适应参数未启用。' };
            const adaptiveParams = {
              ...calculated,
              ...adaptiveOverrides,
              confidence: Object.keys(adaptiveOverrides).length ? 1 : calculated.confidence,
              reason: Object.keys(adaptiveOverrides).length ? '使用手工设定的自适应参数。' : calculated.reason
            };
            analysis = localAnalysisMultiTimeframe(market, auxMarkets, adaptiveParams);
          } else if (engine === 'enhanced') {
            analysis = enhancedAnalysis(market);
          } else if (engine === 'super') {
            analysis = await this.superAnalysis.analyze(market);
          } else {
            const result = await analyzeMarkets({ config, strategy, market: [market] });
            if (result.error) throw new Error(result.error);
            analysis = result.analyses?.[0];
          }

          // 让出事件循环（2026-09-10 性能优化）：enhancedAnalysis 是重 CPU 计算
          // （MA/RSI/MACD/Ichimoku/DMI/Supertrend/OBV + 评分），20 个币的批在 Promise.all
          // 里会把事件循环占满数秒，导致 /api/health 都要 2s+、静态文件 5s+。
          // 每个币算完 setImmediate 一次，让 Express 能插队处理 HTTP 请求。
          // 纯协作式调度，不改变任何结果，只影响时序。
          await new Promise(resolve => setImmediate(resolve));

          analyzed++;

          // All engines use the same timing, price and cost validation as manual analysis.
          const record = createResearchRecord({
            config: engine === 'ai' ? config : { ...config, model: { model: engine === 'local' ? LOCAL_STRATEGY.modelId : `${engine}-rules-v1`, baseUrl: 'local://rules' } },
            strategy, market: [market], result: { analyses: analysis ? [analysis] : [] },
            type: 'single', scope: { interval, limit: 80, engine }
          });
          Object.assign(record, { id: `auto-${runId}-${symbol}`, analysisEngine: engine, automationRunId: runId });
          for (const signal of record.analyses) {
            signal.analysisEngine = engine;
            if (engine !== 'ai') signal.confidenceType = 'rule_strength';
          }
          if (!shouldContinue()) return;
          await this.archive.save(record);
          analysis = record.analyses[0];
          signals.push(analysis);
          if (!submit) return { symbol, success: true };

          // P3：统计本轮被哪道闸门挡住（用于漏斗观测，不合格时才有拦截原因）
          if (!(analysis.eligible && analysis.plan)) tallyBlock(analysis.reason);

          // 如果有合格的开仓建议，自动下单
          if (analysis.eligible && analysis.plan && ['BUY', 'SELL'].includes(analysis.action)) {
            eligible++;

            try {
              // 保存分析记录
              const recordId = record.id;

              // 同币种风控：已有未平仓订单不重复开仓；
              // 止损后60分钟内冷却，避免同一趋势里反复止损（历史数据显示
              // 37%的止损单在60分钟内同币种再次开单，53%订单集中于29个反复亏损币种）。
              const simState = this.simulation.readLight ? await this.simulation.readLight()
                : this.simulation.read ? await this.simulation.read() : { orders: [] };
              const sameSymbol = (simState.orders || []).filter(o => o.symbol === symbol);
              if (sameSymbol.some(o => o.status === 'pending' || o.status === 'open')) {
                console.log(`[GlobalAutomation] ${symbol} 已有未平仓订单，跳过重复开仓`);
                return { symbol, success: true, action: 'SKIP_DUPLICATE' };
              }
              const lastStopAt = sameSymbol
                .filter(o => o.status === 'closed' && o.reason === 'stop_loss' && o.exitAt)
                .map(o => Date.parse(o.exitAt))
                .filter(t => Number.isFinite(t))
                .sort((a, b) => b - a)[0];
              // 任意平仓后的通用冷却（新增）：止盈/超时/手动平仓后同样不再立刻重进同一标的
              const lastClosedAt = sameSymbol
                .filter(o => o.status === 'closed' && o.exitAt)
                .map(o => Date.parse(o.exitAt))
                .filter(t => Number.isFinite(t))
                .sort((a, b) => b - a)[0];
              if (SYMBOL_COOLDOWN_MIN > 0 && lastClosedAt && Date.now() - lastClosedAt < SYMBOL_COOLDOWN_MIN * 60000) {
                const waitedMin = ((Date.now() - lastClosedAt) / 60000).toFixed(1);
                console.log(`[GlobalAutomation] ${symbol} 平仓后冷却期内（已等待 ${waitedMin}/${SYMBOL_COOLDOWN_MIN} 分钟），跳过开仓`);
                return { symbol, success: true, action: 'SKIP_COOLDOWN' };
              }
              if (STOP_COOLDOWN_MIN > 0 && lastStopAt && Date.now() - lastStopAt < STOP_COOLDOWN_MIN * 60000) {
                console.log(`[GlobalAutomation] ${symbol} 止损后${STOP_COOLDOWN_MIN}分钟冷却期内，跳过开仓`);
                return { symbol, success: true, action: 'SKIP_COOLDOWN' };
              }

              // 自动提交模拟订单
              const leverage = recommendedLeverage(analysis.plan, analysis.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT');
              if (!shouldContinue()) return;
              await this.simulation.submit({
                recordId,
                symbol,
                margin: 100,
                leverage,
                automatic: true
              });

              submitted++;
              console.log(`[GlobalAutomation] ${symbol} 已提交 ${analysis.action} 订单，杠杆 ${leverage}x`);

              // 显示评分和数据源
              if (analysis.plan?.trendStrengthScore) {
                console.log(`[GlobalAutomation] ${symbol} 趋势强度评分：${analysis.plan.trendStrengthScore}/100`);
              }
              if (engine === 'super' && analysis.plan?.dataSource) {
                const sources = [];
                if (analysis.plan.dataSource.coinGecko) sources.push('CoinGecko');
                if (analysis.plan.dataSource.fearGreed) sources.push('F&G');
                if (analysis.plan.dataSource.alphaVantage) sources.push('AlphaV');
                console.log(`[GlobalAutomation] ${symbol} 数据源: ${sources.join(', ')}`);
              }

              return { symbol, success: true, action: analysis.action };
            } catch (error) {
              failed++;
              console.error(`[GlobalAutomation] ${symbol} 下单失败:`, error.message);
              return { symbol, error: error.message };
            }
          }

          return { symbol, success: true, action: 'WAIT' };
        } catch (error) {
          failed++;
          return { symbol, error: error.message };
        }
      }));
      failures.push(...results.filter(result => result?.error));

      // 避免请求过快
      await new Promise(resolve => setImmediate(resolve));
    }

    this.stats.totalAnalyzed += analyzed;
    this.stats.totalOrders += submitted;

    console.log(`[GlobalAutomation] 分析完成: 已分析 ${analyzed}, 合格 ${eligible}, 已下单 ${submitted}, 失败 ${failed}`);
    // P3 漏斗日志：候选 → 各闸拦截 → 合格 → 下单。用于一眼判断是"降频生效"还是"被过滤光了"。
    console.log(`[GlobalAutomation][漏斗] 候选${symbols.length} 已分析${analyzed} | 评分不足${blockedBy.score} `
      + `量能不足${blockedBy.volume} 盈亏比不足${blockedBy.riskReward} | 合格${eligible} 下单${submitted}`);
    if (!requestedSymbols && symbols.length === 0) {
      console.warn('[GlobalAutomation][告警] 币种过滤后候选为 0 —— 过滤器可能把所有币种都拉黑了，请检查自适应过滤样本！');
    } else if (!requestedSymbols && analyzed > 0 && eligible === 0) {
      console.warn(`[GlobalAutomation][告警] 本轮 0 个合格信号 —— 门槛可能过严（候选${symbols.length}/已分析${analyzed}），`
        + `请核对上面漏斗计数；可临时下调 NOFX_MIN_TREND_SCORE / NOFX_MIN_RR 恢复出单。`);
    }
    if (requestedSymbols && failures.length) throw new Error(failures.map(item => `${item.symbol}: ${item.error}`).join('; '));
    return signals;
  }

  /**
   * 任务2: 更新挂单和持仓行情、复核订单并计算盈亏
   */
  async reviewPositions(shouldContinue = () => true) {

    const state = this.simulation.readLight ? await this.simulation.readLight() : await this.simulation.read();
    const openOrders = state.orders.filter(o => ['pending', 'open'].includes(o.status));
    this.tasks.positionReview.progress = { total: openOrders.length, completed: 0, failed: 0, symbol: null };

    if (openOrders.length === 0) {
      console.log('[GlobalAutomation] 无持仓需要复核');
      return;
    }

    console.log(`[GlobalAutomation] 开始复核 ${openOrders.length} 个持仓...`);

    const config = await this.store.getConfig();
    const engine = selectAnalysisEngine(config);

    let reviewed = 0;
    const context = { config };
    let updated = 0;
    let held = 0;
    let closed = 0;

    const refreshed = new Set();
    const markets = new Map();
    const progress = this.tasks.positionReview.progress = { total: openOrders.length, completed: 0, failed: 0, symbol: null };
    for (const snapshot of openOrders) {
      if (!shouldContinue()) break;
      progress.symbol = snapshot.symbol;
      try {
        if (!refreshed.has(snapshot.symbol)) {
          await this.simulation.refresh({ symbols: [snapshot.symbol], shouldContinue });
          refreshed.add(snapshot.symbol);
        }
        if (!shouldContinue()) break;
        const order = this.simulation.getOrder ? await this.simulation.getOrder(snapshot.id)
          : (await this.simulation.read()).orders.find(o => o.id === snapshot.id);
        if (!order || !['pending', 'open'].includes(order.status) || order.error) continue;
        // 获取最新行情
        const key = `${order.symbol}:${order.interval}`;
        if (!markets.has(key)) markets.set(key, await this.getFreshMarket(order.symbol, order.interval));
        const market = markets.get(key);
        if (!shouldContinue()) break;
        if (order.status === 'pending') {
          await this.reviewPendingOrder(order, market, shouldContinue, context);
          reviewed++;
          continue;
        }

        // 数据不足（如新上币种）时跳过复核，等K线积累够了再处理
        if (market.partial && market.klines.length < 15) {
          console.log(`[GlobalAutomation] ${order.symbol} ${order.interval} 已收盘K线不足 ${market.klines.length} 根，本次跳过复核`);
          continue;
        }

        // 生成复核建议
        let proposal;
        if (engine === 'local') {
          proposal = localProtectionReview(order, market);
        } else if (engine === 'enhanced') {
          proposal = enhancedProtectionReview(order, market);
        } else if (engine === 'super') {
          proposal = await this.superAnalysis.reviewPosition(order, market);
        } else {
          const strategy = await this.store.getStrategy();
          proposal = await reviewPosition({
            config,
            strategy: { ...strategy, interval: order.interval },
            market,
            position: {
              symbol: order.symbol,
              positionAmt: order.quantity * (order.direction === 'OPEN_LONG' ? 1 : -1),
              entryPrice: order.entry,
              markPrice: market.klines.at(-1).close,
              stopLoss: order.plan.stopLoss,
              takeProfit: order.plan.takeProfit,
              simulated: true
            }
          });
        }

        // ── 智能退出：真正执行平仓 ──────────────────────────────────────────
        // 此前 `proposal.action === 'CLOSE'` 只往 reviewHistory 记一条 close_suggested 就 return，
        // 从不平仓 —— 等于 enhanced/super 引擎里「趋势反转 / RSI 极值 / MACD 背离」三条退出规则
        // 全是死代码（其中「均线失守且未盈利5%」极易命中）。
        // ⚠️ 行为变更：CLOSE 建议一旦命中，立即按最新标记价市价平仓，不再等待人工确认。
        if (!shouldContinue()) break;
        if (proposal.action === 'CLOSE') {
          await this.simulation.mutateLight(state => {
            if (!shouldContinue()) return;
            const current = state.orders.find(o => o.id === order.id);
            if (!current || current.status !== 'open') return;
            current.reviewHistory = [...(current.reviewHistory || []), {
              at: new Date().toISOString(),
              engine,
              action: 'smart_exit',
              reason: proposal.reason,
              confidence: proposal.confidence,
              sentiment: proposal.sentiment
            }].slice(-50);
          });

          // 真正的平仓动作：刷新行情后按 markPrice 以 manual 原因结算（与 /api/paper/orders/:id/close 同一原语）
          if (!shouldContinue()) break;
          await this.simulation.close(order.id, { refresh: false });
          closed++;
          console.log(`[GlobalAutomation] ${order.symbol} 智能退出平仓：${proposal.reason}`);
          reviewed++;
          continue;
        }

        // 应用复核建议（只改当前这个活跃订单，走轻量写入）
        await this.simulation.mutateLight(state => {
          if (!shouldContinue()) return;
          const current = state.orders.find(o => o.id === order.id);
          if (!current || current.status !== 'open') return;

          const report = applyPaperProtectionReview(current, proposal, Date.now(), engine);
          if (report.action === 'updated') {
            updated++;
            console.log(`[GlobalAutomation] ${order.symbol} 止盈止损已更新`);

            // 如果是增强版或超级增强版，显示额外信息
            if ((engine === 'enhanced' || engine === 'super') && proposal.profitPercent !== undefined) {
              console.log(`[GlobalAutomation] ${order.symbol} 当前盈亏：${proposal.profitPercent.toFixed(2)}%`);
            }
            if (engine === 'super' && proposal.sentiment) {
              console.log(`[GlobalAutomation] ${order.symbol} 市场情绪：${proposal.sentiment.classification}`);
            }
          } else {
            held++;
          }
        });

        reviewed++;
      } catch (error) {
        progress.failed++;
        this.tasks.positionReview.error = `${snapshot.symbol}: ${error.message}`;
        console.error(`[GlobalAutomation] Review ${snapshot.symbol} failed:`, error.message);
      } finally {
        progress.completed++;
      }
    }
    progress.symbol = null;

    this.stats.totalReviews += reviewed;

    console.log(`[GlobalAutomation] 复核完成: 已复核 ${reviewed}, 已更新 ${updated}, 保持 ${held}, 智能退出 ${closed}`);
  }

  /**
   * 获取最新行情数据
   * 数据不足时：先查数据库，不够再直接从交易所获取；
   * 若交易所也提供不了足够多的已收盘K线（如新上币种），
   * 则降级返回已有的部分数据（partial: true），不再抛错。
   */
  async reviewPendingOrder(order, market, shouldContinue = () => true, context = {}) {
    if (market.partial) return;
    const signals = await this.runAnalysis({ symbols: [order.symbol], preparedMarket: market,
      interval: order.interval, submit: false, shouldContinue, context });
    if (!shouldContinue()) return;
    return this.simulation.mutateLight(state => {
      if (!shouldContinue()) return;
      const current = state.orders.find(o => o.id === order.id);
      if (!current || current.status !== 'pending' || current.nextTime !== order.nextTime) return;
      const report = applyPendingReview(current, signals?.[0]);
      const task = this.tasks.positionReview;
      if (report.action === 'cancelled') task.cancelled = (task.cancelled || 0) + 1;
      if (report.action === HELD_INELIGIBLE) task.graced = (task.graced || 0) + 1;
      if (report.action === 'repriced') task.repriced = (task.repriced || 0) + 1;
      return report;
    });
  }

  async getFreshMarket(symbol, interval = MAIN_INTERVAL, forceFetch = false) {
    const key = this.market.storageSymbol(symbol);
    const now = Date.now();

    // 用交易所返回的原始数据构造"尽力而为"的已收盘K线集合
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

    const fetchPrepared = async limit => {
      const raw = await this.market.klines({ symbol, interval, limit });
      await this.marketDb.saveKlines({ symbol: key, interval, rows: raw });
      const prepared = prepareMarket({ symbol, interval, rows: raw, limit: 80, marketProvider: this.market.provider, throwOnInsufficient: false });
      return prepared.insufficient ? buildPartial(raw) : prepared;
    };

    if (forceFetch) return fetchPrepared(100);

    try {
      // 先尝试从数据库获取
      const rows = await this.marketDb.listKlines({ symbol: key, interval, limit: 80 });

      // 尝试准备市场数据，检查是否足够
      let prepared = prepareMarket({ symbol, interval, rows, limit: 80, marketProvider: this.market.provider, throwOnInsufficient: false });

      // 如果数据不足，从交易所获取更多（交易所也不够时降级为部分数据，不报错）
      if (prepared.insufficient) {
        prepared = await fetchPrepared(Math.max(82, prepared.required + 2));
      }

      if (!prepared.partial) {
        await this.marketDb.saveKlines({ symbol: key, interval, rows: prepared.klines }).catch(() => {});
      }

      return prepared;
    } catch (error) {
      if (error.message && !error.message.includes('行情已过期')) {
        // 数据库读取等其他错误：直接从交易所获取
        console.warn(`[GlobalAutomation] 读取 ${symbol} ${interval} 本地数据失败，改用交易所数据:`, error.message);
      }

      // 从交易所获取（数据仍不足时降级为部分数据，不报错）
      const prepared = await fetchPrepared(82);

      if (!prepared.partial) {
        await this.marketDb.saveKlines({ symbol: key, interval, rows: prepared.klines }).catch(() => {});
      }

      return prepared;
    }
  }

  /**
   * 获取系统状态
   */
  async getStatus() {
    const accountStatus = await this.simulation.status();

    return {
      active: this.schedulerActive,
      tasks: this.tasks,
      stats: this.stats,
      account: accountStatus,
      uptime: process.uptime()
    };
  }

  /**
   * 配置任务
   */
  configure(taskName, options) {
    const task = this.tasks[taskName];
    if (!task) throw Object.assign(new Error(`Unknown automation task: ${taskName}`), { status: 400 });
    if (options.interval !== undefined && (!Number.isFinite(options.interval) || options.interval < 1000)) {
      throw Object.assign(new Error('Task interval must be at least 1000 ms'), { status: 422 });
    }
    if (typeof options.enabled === 'boolean') task.enabled = options.enabled;
    if (options.interval !== undefined) task.interval = options.interval;
    if (this.schedulerActive) this.scheduleTask(taskName);
    return task;
  }

  /**
   * 获取任务函数
   */
  getTaskFunction(taskName) {
    const taskFunctions = {
      klineSync: guard => this.syncKlines(guard),
      positionReview: guard => this.reviewPositions(guard)
    };

    return taskFunctions[taskName];
  }

  /**
   * 手动触发任务
   */
  async triggerTask(taskName) {
    if (!this.tasks[taskName]) {
      throw new Error(`未知任务: ${taskName}`);
    }

    const fn = this.getTaskFunction(taskName);
    const token = this.taskTokens[taskName];
    await this.executeTask(taskName, fn, () => this.taskTokens[taskName] === token);
  }
}

/**
 * 注册全局自动化路由
 */
export function registerGlobalAutomationRoutes(app, automation) {
  // 获取系统状态
  app.get('/api/automation/status', async (req, res, next) => {
    try {
      res.json(await automation.getStatus());
    } catch (error) {
      next(error);
    }
  });

  // 配置任务
  app.put('/api/automation/tasks/:taskName', async (req, res, next) => {
    try {
      const result = automation.configure(req.params.taskName, req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // 手动触发任务
  app.post('/api/automation/tasks/:taskName/trigger', async (req, res, next) => {
    try {
      if (!automation.tasks[req.params.taskName]) return res.status(400).json({ error: '未知自动任务。' });
      automation.triggerTask(req.params.taskName).catch(() => {});
      res.status(202).json({
        message: '任务已提交',
        task: req.params.taskName
      });
    } catch (error) {
      next(error);
    }
  });

  // 启动/停止自动化
  app.post('/api/automation/:action', async (req, res, next) => {
    try {
      if (req.params.action === 'start') {
        automation.start();
        res.json({ message: '全局自动化系统已启动' });
      } else if (req.params.action === 'stop') {
        automation.stop();
        res.json({ message: '全局自动化系统已停止' });
      } else {
        res.status(400).json({ error: '无效操作' });
      }
    } catch (error) {
      next(error);
    }
  });
}
