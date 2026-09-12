/**
 * 全局自动化交易系统
 *
 * 仅两项自动任务：全市场逐币种拉取、分析、挂单；活跃订单行情、复核和盈亏。
 */

import { randomUUID } from 'node:crypto';
import { LOCAL_STRATEGY, recommendedLeverage } from './localAnalysis.js';
import { getAdaptiveConfig } from './adaptiveConfig.js';
import { filterSymbolsByPerformance, getAdaptiveParametersForSymbol, shouldTradeAtCurrentHour } from './adaptiveFilters.js';
import { createSuperEnhancedAnalysis } from './superEnhancedAnalysis.js';
import { nextOpenTime, prepareMarket, createResearchRecord, MAIN_INTERVAL } from './research.js';
import { applyPaperProtectionReview } from './shared/protectionReview.js';
import { proxyHealth } from './core/proxyHealth.js';
import { applyPendingReview, HELD_INELIGIBLE } from './shared/pendingReview.js';
import { createStrategyRuntime } from './strategies/index.js';
import { normalizeCloseReason, isStopReason } from '../shared/closeReasons.js';

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
    // 多策略运行时：启用集与参数覆盖来自 data/strategies.json；
    // 首次运行按 config.analysis.engine 推导默认启用集（enhanced → enhanced-trend-v1），保证升级平滑。
    this.strategies = createStrategyRuntime({ store, resolveEngine: selectAnalysisEngine });

    // 每轮结束到下一轮开始的等待时间（2026-09-12 老板要求整体提速 10 倍：60s→6s、10s→1s）。
    // ⚠️ 调度器有 inFlight 去重（executeTask）：上一轮没跑完时新一跳会复用同一个 promise，
    //    所以间隔小于单轮耗时不会造成并发堆积，只是变成「跑完就接下一轮」。
    // ⚠️ 调度下限是 1000ms（见 updateTask 校验），勿再往下调。
    this.tasks = {
      klineSync: { enabled: true, interval: 6000, lastRun: null, running: false },
      positionReview: { enabled: true, interval: 1000, lastRun: null, running: false }
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

  /** 策略分析/复核共用的依赖注入（策略定义里通过 ctx.deps 取用） */
  strategyDeps() {
    return { superAnalysis: this.superAnalysis, store: this.store };
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

  /**
   * 行情分析（多策略）：遍历「已启用策略」，每个策略用自己的参数独立扫描候选币种。
   *
   * 改造要点（2026-09-11 老板需求）：
   *   · 启用哪些策略由 data/strategies.json 决定（前端「策略管理」页勾选）；
   *   · 每个策略用**自己的参数**跑分析，产出的信号带 strategyId，订单落库时一并固化；
   *   · 同一币种若被多个策略看中，只有优先级最高的那个能成交（沿用「同币种不重复开仓」风控）。
   *
   * @param {object} [options]
   * @param {Array}  [options.strategies] 显式指定策略（挂单复核时只跑该订单所属策略）
   */
  async runAnalysis({ symbols: requestedSymbols, preparedMarket, submit = true, interval = MAIN_INTERVAL,
    shouldContinue = () => true, context = {}, strategies: explicitStrategies } = {}) {
    // 代理宕机时跳过本轮分析，避免对全市场币种逐个刷 fetch failed。
    if (!proxyHealth.isAlive()) {
      console.warn('[GlobalAutomation] 代理不可用，跳过本轮行情分析（OKX 行情中断）。');
      return [];
    }
    const config = context.config ??= await this.store.getConfig();
    const strategyPrompt = context.strategyPrompt ??= await this.store.getStrategy();
    // ⚠️ 启用集**不缓存**：syncKlines 整轮（全市场数百币种、数分钟）共用同一个 context，
    // 若在这里按轮缓存，前端「策略管理」勾选/改参后要等下一整轮才生效（体验上像"没反应"）。
    // 每币种重读一次 data/strategies.json（小文件、毫秒级）换来「勾选后下一币种即生效」。
    const enabledStrategies = explicitStrategies || await this.strategies.enabled(config);
    if (!enabledStrategies.length) {
      console.warn('[GlobalAutomation] ⚠️ 未启用任何策略，本轮不做分析。请到「策略管理」勾选至少一个策略。');
      return [];
    }

    console.log(`[GlobalAutomation] 开始行情分析，启用策略：${enabledStrategies.map(s => s.id).join(', ')}`);

    let symbols = requestedSymbols || (await this.market.perpetualUsdtContracts()).map(s => s.symbol);
    const signals = [];
    const runId = randomUUID();
    const failures = [];

    // P3 修复：币种黑名单不再依赖引擎分支，任何策略都先做一次「负期望值币种拉黑」。
    const state = context.state ??= this.simulation.read ? await this.simulation.read() : { orders: [] };
    const adaptiveConfig = getAdaptiveConfig(state.adaptiveConfig);
    const adaptiveOverrides = state.adaptiveOverrides || {};
    // 自适应参数只信任「同一模型 id 的本地策略样本」，避免用别的引擎结果调本地参数。
    const localModelIds = new Set(enabledStrategies.filter(s => s.engine === 'local').map(s => s.modelId));
    const localHistory = (state.orders || []).filter(order =>
      order.status === 'closed' && localModelIds.has(order.analysisContext?.strategyModel)
    );
    // 币种黑名单则用全部策略的已平仓样本：一个币长期亏钱，与它是哪个策略下单无关。
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

    const totals = { analyzed: 0, eligible: 0, submitted: 0, failed: 0 };
    // P3 可观测性：区分"正常降频"与"门槛过严导致 0 开单"。每币种最多计一次（最靠前的那道闸）。
    const blockedBy = { score: 0, volume: 0, riskReward: 0 };

    for (const strategy of enabledStrategies) {
      if (!shouldContinue()) break;
      let candidates = symbols;

      // 策略级候选预筛选（如超级增强的市值 / 流动性过滤）
      if (strategy.prefilter) {
        try {
          const result = await strategy.prefilter(symbols, { deps: this.strategyDeps(), config, state });
          if (Array.isArray(result?.filtered)) {
            console.log(`[GlobalAutomation][${strategy.id}] 预筛选: ${symbols.length - result.filtered.length} 个币种被过滤`);
            if (result.reasons) {
              console.log(`[GlobalAutomation][${strategy.id}] 过滤原因: 市值${result.reasons.lowMarketCap}, 流动性${result.reasons.lowLiquidity}, 波动${result.reasons.extremeVolatility}`);
            }
            candidates = result.filtered;
          }
        } catch (error) {
          console.warn(`[GlobalAutomation][${strategy.id}] 预筛选失败，跳过本轮该策略: ${error.message}`);
          continue;
        }
      }

      // 时段过滤：只对本地规则引擎有意义，且只信任本地策略自己的样本。
      if (strategy.engine === 'local') {
        const hourCheck = shouldTradeAtCurrentHour(new Date().getUTCHours(), localHistory, {
          ...adaptiveConfig.hourFilter,
          enabled: adaptiveConfig.hourFilter.enabled && localHistory.length >= adaptiveConfig.hourFilter.minOrdersToActivate
        });
        if (!hourCheck.shouldTrade) {
          console.log(`[GlobalAutomation][${strategy.id}] 跳过本轮扫描：${hourCheck.reason}`);
          continue;
        }
      }

      const outcome = await this.scanWithStrategy({
        strategy, symbols: candidates, preparedMarket, submit, interval, shouldContinue,
        config, strategyPrompt, runId, state, adaptiveConfig, adaptiveOverrides, localHistory
      });
      totals.analyzed += outcome.analyzed;
      totals.eligible += outcome.eligible;
      totals.submitted += outcome.submitted;
      totals.failed += outcome.failed;
      failures.push(...outcome.failures);
      signals.push(...outcome.signals);
      for (const key of Object.keys(blockedBy)) blockedBy[key] += outcome.blockedBy[key];
    }

    this.stats.totalAnalyzed += totals.analyzed;
    this.stats.totalOrders += totals.submitted;

    console.log(`[GlobalAutomation] 分析完成: 已分析 ${totals.analyzed}, 合格 ${totals.eligible}, 已下单 ${totals.submitted}, 失败 ${totals.failed}`);
    // P3 漏斗日志：候选 → 各闸拦截 → 合格 → 下单。用于一眼判断是"降频生效"还是"被过滤光了"。
    console.log(`[GlobalAutomation][漏斗] 候选${symbols.length}×策略${enabledStrategies.length} 已分析${totals.analyzed} | 评分不足${blockedBy.score} `
      + `量能不足${blockedBy.volume} 盈亏比不足${blockedBy.riskReward} | 合格${totals.eligible} 下单${totals.submitted}`);
    if (!requestedSymbols && symbols.length === 0) {
      console.warn('[GlobalAutomation][告警] 币种过滤后候选为 0 —— 过滤器可能把所有币种都拉黑了，请检查自适应过滤样本！');
    } else if (!requestedSymbols && totals.analyzed > 0 && totals.eligible === 0) {
      console.warn(`[GlobalAutomation][告警] 本轮 0 个合格信号 —— 门槛可能过严（候选${symbols.length}/已分析${totals.analyzed}），`
        + `请核对上面漏斗计数；可在「策略管理」下调对应策略的评分门槛 / 盈亏比门槛。`);
    }
    if (requestedSymbols && failures.length) throw new Error(failures.map(item => `${item.symbol}: ${item.error}`).join('; '));
    return signals;
  }

  /** 单个策略的扫描循环：逐批（20 币）分析 → 合格即按该策略挂单。 */
  async scanWithStrategy({ strategy, symbols, preparedMarket, submit, interval, shouldContinue,
    config, strategyPrompt, runId, state, adaptiveConfig, adaptiveOverrides, localHistory }) {
    const outcome = { analyzed: 0, eligible: 0, submitted: 0, failed: 0, failures: [], signals: [],
      blockedBy: { score: 0, volume: 0, riskReward: 0 } };
    const tallyBlock = reason => {
      const text = String(reason || '');
      if (text.includes('综合信号强度不足')) outcome.blockedBy.score++;
      else if (text.includes('成交量不足')) outcome.blockedBy.volume++;
      else if (text.includes('风险收益比不足')) outcome.blockedBy.riskReward++;
    };

    const batchSize = 20;
    for (let i = 0; i < symbols.length; i += batchSize) {
      if (!shouldContinue()) break;
      const batch = symbols.slice(i, i + batchSize);

      const results = await Promise.all(batch.map(async symbol => {
        try {
          const market = preparedMarket || await this.getFreshMarket(symbol, interval);
          const analysis = await this.runStrategyAnalysis({
            strategy, symbol, market, submit, interval, config, strategyPrompt,
            state, adaptiveConfig, adaptiveOverrides, localHistory
          });

          // 让出事件循环（2026-09-10 性能优化）：分析是重 CPU 计算，
          // 20 个币的批在 Promise.all 里会把事件循环占满数秒，导致 /api/health 都要 2s+。
          await new Promise(resolve => setImmediate(resolve));
          if (!analysis) return { symbol, success: true, action: 'WAIT' };
          outcome.analyzed++;

          // 策略可给计划补上自己的出场规则（如本地引擎原生不带 exitRules）。
          if (typeof strategy.decoratePlan === 'function' && analysis.plan) {
            analysis.plan = strategy.decoratePlan(analysis.plan, { params: strategy.params });
          }

          // 所有策略共用同一套「时点 / 价格 / 成本」校验（createResearchRecord → normalizePlan）。
          const record = createResearchRecord({
            config: strategy.engine === 'ai'
              ? config
              : { ...config, model: { model: strategy.modelId, baseUrl: 'local://rules' } },
            strategy: { ...strategyPrompt, interval },
            market: [market],
            result: { analyses: [analysis] },
            type: 'single',
            scope: { interval, limit: 80, engine: strategy.engine },
            strategyId: strategy.id,
            strategyName: strategy.name,
            strategyParams: strategy.params
          });
          Object.assign(record, {
            id: `auto-${runId}-${symbol}-${strategy.id}`,
            analysisEngine: strategy.engine,
            strategyId: strategy.id,
            automationRunId: runId
          });
          for (const signal of record.analyses) {
            signal.analysisEngine = strategy.engine;
            signal.strategyId = strategy.id;
            if (strategy.engine !== 'ai') signal.confidenceType = 'rule_strength';
          }
          if (!shouldContinue()) return;
          await this.archive.save(record);
          const signal = record.analyses[0];
          outcome.signals.push(signal);
          if (!submit) return { symbol, success: true };

          // P3：统计本轮被哪道闸门挡住（不合格时才有拦截原因）
          if (!(signal.eligible && signal.plan)) tallyBlock(signal.reason);

          if (signal.eligible && signal.plan && ['BUY', 'SELL'].includes(signal.action)) {
            outcome.eligible++;
            const submission = await this.submitSignal({ symbol, signal, recordId: record.id, shouldContinue });
            if (submission.action === 'SUBMITTED') outcome.submitted++;
            if (submission.error) {
              outcome.failed++;
              outcome.failures.push({ symbol, error: submission.error });
            }
            return submission;
          }
          return { symbol, success: true, action: 'WAIT' };
        } catch (error) {
          outcome.failed++;
          return { symbol, error: error.message };
        }
      }));
      outcome.failures.push(...results.filter(result => result?.error && !result.failures));

      // 避免请求过快
      await new Promise(resolve => setImmediate(resolve));
    }
    return outcome;
  }

  /**
   * 用某个策略分析单个币种。
   * 辅助周期（auxMarkets）与币种级自适应参数按需准备，只有该策略真正需要时才拉取。
   */
  async runStrategyAnalysis({ strategy, symbol, market, submit, interval, config, strategyPrompt,
    state, adaptiveConfig, adaptiveOverrides, localHistory }) {
    const ctx = {
      params: strategy.params,
      config,
      strategyPrompt,
      interval,
      state,
      deps: this.strategyDeps()
    };

    if (strategy.needsAux?.length) {
      const auxMarkets = {};
      let incomplete = false;
      for (const auxInterval of strategy.needsAux) {
        if (auxInterval === market.interval) continue;
        try {
          const aux = await this.getFreshMarket(symbol, auxInterval);
          if (!aux || aux.partial) incomplete = true;
          if (aux) auxMarkets[auxInterval] = aux;
        } catch (error) {
          incomplete = true;
          console.warn(`[GlobalAutomation] 获取 ${symbol} ${auxInterval} 失败:`, error.message);
        }
      }
      // 复核挂单时（submit=false）辅助数据不完整就保持原挂单，不用残缺数据改判方向。
      if (!submit && incomplete) throw new Error('Auxiliary market data incomplete; retaining pending order');
      ctx.auxMarkets = auxMarkets;
    }

    if (strategy.engine === 'local') {
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
      ctx.adaptiveParams = {
        ...calculated,
        ...adaptiveOverrides,
        confidence: Object.keys(adaptiveOverrides).length ? 1 : calculated.confidence,
        reason: Object.keys(adaptiveOverrides).length ? '使用手工设定的自适应参数。' : calculated.reason
      };
    }

    const analysis = await strategy.analyze(market, ctx);
    return analysis || null;
  }

  /**
   * 风控闸门 + 按策略落单。
   * 同币种未平仓不重复开仓；止损后 / 任意平仓后的冷却期同样拦截。
   */
  async submitSignal({ symbol, signal, recordId, shouldContinue }) {
    try {
      const simState = this.simulation.readLight ? await this.simulation.readLight()
        : this.simulation.read ? await this.simulation.read() : { orders: [] };
      const sameSymbol = (simState.orders || []).filter(o => o.symbol === symbol);
      if (sameSymbol.some(o => o.status === 'pending' || o.status === 'open')) {
        console.log(`[GlobalAutomation] ${symbol} 已有未平仓订单，跳过重复开仓`);
        return { symbol, success: true, action: 'SKIP_DUPLICATE' };
      }
      // 止损类（含移动止损 / 保本止损）单独记一个更长的冷却。
      // 此前只认 `stop_loss` 字面量，细分后移动止损会被漏掉，导致冷却失效。
      const lastStopAt = sameSymbol
        .filter(o => o.status === 'closed' && isStopReason(o.reason) && o.exitAt)
        .map(o => Date.parse(o.exitAt))
        .filter(t => Number.isFinite(t))
        .sort((a, b) => b - a)[0];
      // 任意平仓后的通用冷却：止盈/超时/手动平仓后同样不再立刻重进同一标的
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

      // 自动提交模拟订单（带 strategyId，订单从此知道自己属于哪个策略）
      const leverage = recommendedLeverage(signal.plan, signal.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT');
      if (!shouldContinue()) return { symbol, success: true, action: 'ABORTED' };
      await this.simulation.submit({
        recordId,
        symbol,
        margin: 100,
        leverage,
        automatic: true,
        strategyId: signal.strategyId
      });

      console.log(`[GlobalAutomation][${signal.strategyId || 'strategy'}] ${symbol} 已提交 ${signal.action} 订单，杠杆 ${leverage}x`);
      if (signal.plan?.trendStrengthScore) {
        console.log(`[GlobalAutomation] ${symbol} 趋势强度评分：${signal.plan.trendStrengthScore}/100`);
      }
      return { symbol, success: true, action: 'SUBMITTED', strategyId: signal.strategyId };
    } catch (error) {
      console.error(`[GlobalAutomation] ${symbol} 下单失败:`, error.message);
      return { symbol, error: error.message };
    }
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
    // 多策略：本轮把所有启用策略读一次，之后按「每个订单自己所属的策略」分派复核。
    const strategies = await this.strategies.enabled(config);
    if (!strategies.length) {
      console.warn('[GlobalAutomation] ⚠️ 未启用任何策略，跳过本轮持仓复核。');
      return;
    }

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
        // 该订单所属策略（订单落库时固化的 strategyId；老订单回退默认策略）。
        const orderStrategy = this.strategies.resolveForOrder(order, strategies, config);
        if (order.status === 'pending') {
          await this.reviewPendingOrder(order, market, shouldContinue, context, orderStrategy);
          reviewed++;
          continue;
        }

        // 数据不足（如新上币种）时跳过复核，等K线积累够了再处理
        if (market.partial && market.klines.length < 15) {
          console.log(`[GlobalAutomation] ${order.symbol} ${order.interval} 已收盘K线不足 ${market.klines.length} 根，本次跳过复核`);
          continue;
        }

        // 生成复核建议 —— 调用**该订单所属策略**的复核实现，保证出场语义与下单时一致。
        // 智能退出 / 移动止损 / 分批止盈的阈值都从 order.plan.exitRules 读（策略级快照）。
        if (!orderStrategy) {
          console.warn(`[GlobalAutomation] ${order.symbol} 找不到所属策略，跳过复核。`);
          continue;
        }
        if (orderStrategy.engine === 'ai') context.strategyPrompt ??= await this.store.getStrategy();
        const proposal = await orderStrategy.review(order, market, {
          config,
          strategyPrompt: context.strategyPrompt,
          interval: order.interval,
          deps: this.strategyDeps()
        });

        // ── 智能退出：真正执行平仓 ──────────────────────────────────────────
        // 此前 `proposal.action === 'CLOSE'` 只往 reviewHistory 记一条 close_suggested 就 return，
        // 从不平仓 —— 等于 enhanced/super 引擎里「趋势反转 / RSI 极值 / MACD 背离」三条退出规则
        // 全是死代码（其中「均线失守且未盈利5%」极易命中）。
        // ⚠️ 行为变更：CLOSE 建议一旦命中，立即按最新标记价市价平仓，不再等待人工确认。
        if (!shouldContinue()) break;
        if (proposal.action === 'CLOSE') {
          // 平仓理由：优先用复核层给的机器码（smart_exit_ma / rsi / macd）。
          // 此前这里一律记 `manual`，26 笔智能退出在统计里全成了「手动平仓」，
          // 完全看不出「趋势证伪 / 力竭了结」各占多少。
          const closeReason = proposal.closeReason || normalizeCloseReason(proposal.reason);
          await this.simulation.mutateLight(state => {
            if (!shouldContinue()) return;
            const current = state.orders.find(o => o.id === order.id);
            if (!current || current.status !== 'open') return;
            current.reviewHistory = [...(current.reviewHistory || []), {
              at: new Date().toISOString(),
              engine: orderStrategy.engine,
              strategyId: orderStrategy.id,
              action: 'smart_exit',
              reason: proposal.reason,
              closeReason,
              confidence: proposal.confidence,
              sentiment: proposal.sentiment
            }].slice(-50);
          });

          // 真正的平仓动作：刷新行情后按 markPrice 以该理由结算（与 /api/paper/orders/:id/close 同一原语）
          if (!shouldContinue()) break;
          await this.simulation.close(order.id, { refresh: false, reason: closeReason });
          closed++;
          console.log(`[GlobalAutomation][${orderStrategy.id}] ${order.symbol} 智能退出平仓：${closeReason} — ${proposal.reason}`);
          reviewed++;
          continue;
        }

        // 应用复核建议（只改当前这个活跃订单，走轻量写入）
        await this.simulation.mutateLight(state => {
          if (!shouldContinue()) return;
          const current = state.orders.find(o => o.id === order.id);
          if (!current || current.status !== 'open') return;

          const report = applyPaperProtectionReview(current, proposal, Date.now(), orderStrategy.engine);
          if (report.action === 'updated') {
            updated++;
            console.log(`[GlobalAutomation][${orderStrategy.id}] ${order.symbol} 止盈止损已更新`);

            // 如果是增强版或超级增强版，显示额外信息
            if ((orderStrategy.engine === 'enhanced' || orderStrategy.engine === 'super') && proposal.profitPercent !== undefined) {
              console.log(`[GlobalAutomation] ${order.symbol} 当前盈亏：${proposal.profitPercent.toFixed(2)}%`);
            }
            if (orderStrategy.engine === 'super' && proposal.sentiment) {
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
  /**
   * 复核挂单：用**该挂单所属策略**重新分析，再走 pendingReview 规则决定保留 / 取消。
   * 只跑该订单的策略，避免被其它策略的信号误判方向。
   */
  async reviewPendingOrder(order, market, shouldContinue = () => true, context = {}, strategy = null) {
    if (market.partial) return;
    const orderStrategy = strategy || this.strategies.resolveForOrder(order, [], context.config || {});
    if (!orderStrategy) return;
    const signals = await this.runAnalysis({
      symbols: [order.symbol],
      preparedMarket: market,
      interval: order.interval,
      submit: false,
      shouldContinue,
      // 用独立的 context 承载缓存，避免显式传入的 strategies 被上一轮的缓存覆盖
      context: { config: context.config, state: context.state, strategyPrompt: context.strategyPrompt },
      strategies: [orderStrategy]
    });
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
