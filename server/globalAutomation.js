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
import { nextOpenTime, prepareMarket, createResearchRecord, MAIN_INTERVAL, candleOpenAt } from './research.js';
import { applyPaperProtectionReview } from './shared/protectionReview.js';
import { proxyHealth } from './core/proxyHealth.js';
import { applyPendingReview, HELD_INELIGIBLE } from './shared/pendingReview.js';
import { createStrategyRuntime } from './strategies/index.js';
import { RISK_RULE } from './shared/strategyGuards.js';
import { normalizeCloseReason, isStopReason } from '../shared/closeReasons.js';
import { accountSummary, isTransientOrderError } from './simulatedAccount.js';
import { buildOpportunityReport as createOpportunityReport, buildExecutionPlanFromOpportunity } from './opportunityReport.js';

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

const STOP_COOLDOWN_MIN = Math.max(0, Number(process.env.NOFX_STOP_COOLDOWN_MIN ?? 60));

// 自动下单保证金 = 当前账户权益 × AUTO_MARGIN_PCT（复利 sizing，随盈亏自动缩放）。
// 依据 bf90 资金回放（scripts/_bt_capital.mjs）：5% 权益/笔在 p17/p19/p20 三条参数流上
// 均 1.5~2.5×/90d、MDD<6%、无爆仓；固定 100U/笔在 100U 账户下因手续费储备一单都开不出。
const AUTO_MARGIN_PCT = Math.min(1, Math.max(0.01, Number(process.env.NOFX_AUTO_MARGIN_PCT ?? 0.05)));
// 止损后的加长冷却（保持历史行为，默认 60 分钟）

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
    // 多策略运行时：启用状态、完整参数与备注来自 data/strategies.json；
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
    // 保存配置后递增修订号，令当前扫描 context 在下一个币种/订单前刷新。
    this.runtimeConfigRevision = 0;

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
    // 最近发现的有效策略机会，既供自动化页面展示，也保留给重启后的首次状态读取回填。
    this.opportunities = [];
    this.opportunitiesHydrated = false;
    // 4h 结构策略不使用衍生品/BTC 环境上下文。
    // 相关拉取链路保留在下方注释中，避免旧配置或默认值重新启用。
    // this.skillContextCache = new Map();
  }

  /** 标记配置或旧版策略提示词已变更，避免重启进程才能刷新运行时快照。 */
  invalidateRuntimeConfig() {
    this.runtimeConfigRevision += 1;
    return this.runtimeConfigRevision;
  }

  /** 按修订号加载自动化共用的配置上下文。 */
  async loadRuntimeConfig(context = {}) {
    const revision = this.runtimeConfigRevision;
    if (context.configRevision !== revision || !context.config) {
      context.config = await this.store.getConfig();
      context.strategyPrompt = await this.store.getStrategy();
      context.configRevision = revision;
    }
    return context;
  }

  /** 策略分析/复核共用的依赖注入（策略定义里通过 ctx.deps 取用） */
  strategyDeps() {
    return { superAnalysis: this.superAnalysis, store: this.store, market: this.market, marketDb: this.marketDb };
  }

  /*
   * [已停用] 4h 结构策略不再拉取或消费衍生品/BTC 环境数据。
   * 旧实现保留在注释中，便于审计历史变更，但不能被运行时调用。
   *
  async getSkillDerivatives(symbol) {
    const bucket = Math.floor(Date.now() / 900000);
    const key = `derivatives:${symbol}:${bucket}`;
    if (this.skillContextCache.has(key)) return this.skillContextCache.get(key);
    const promise = typeof this.market.skillContext === 'function'
      ? this.market.skillContext(symbol)
      : { symbol, errors: { market: '行情客户端未提供 skillContext()' } };
    this.skillContextCache.set(key, promise);
    return promise;
  }

  async getSkillBtcMarket(interval = '4h', limit = 500) {
    const bucket = Math.floor(Date.now() / 900000);
    const key = `btc:${interval}:${limit}:${bucket}`;
    if (this.skillContextCache.has(key)) return this.skillContextCache.get(key);
    const promise = this.getFreshMarket('BTCUSDT', interval, false, limit);
    this.skillContextCache.set(key, promise);
    return promise;
  }
  */

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
        // 探测交给 proxyHealth 的 30s 周期定时器（index.js 启动时 start()），
        // 这里只读缓存状态 —— 此前每次 executeTask 都强制 TCP 拨号一次（positionReview 每秒一轮）。
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
    const roundStart = Date.now();
    let roundSignals = 0;
    for (const symbol of symbols) {
      if (!shouldContinue()) break;
      progress.symbol = symbol;
      try {
        const market = await this.getFreshMarket(symbol, MAIN_INTERVAL, true);
        if (!shouldContinue()) break;
        const signals = await this.runAnalysis({ symbols: [symbol], preparedMarket: market, shouldContinue, context });
        roundSignals += Array.isArray(signals) ? signals.length : 0;
      } catch (error) {
        progress.failed++;
        this.tasks.klineSync.error = `${symbol}: ${error.message}`;
      }
      progress.completed++;
      await new Promise(resolve => setImmediate(resolve));
    }
    progress.symbol = null;
    console.log(`[GlobalAutomation][klineSync 轮] 全市场 ${progress.completed} 币（失败 ${progress.failed}）· 新信号 ${roundSignals} · 耗时 ${((Date.now() - roundStart) / 1000).toFixed(0)}s`);
  }

  /**
   * 行情分析（多策略）：遍历「已启用策略」，每个策略用自己的参数独立扫描候选币种。
   *
   * 改造要点（2026-09-11 老板需求）：
   *   · 启用哪些策略及其参数由 data/strategies.json 决定（前端「策略管理」页配置）；
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
    await this.loadRuntimeConfig(context);
    const { config, strategyPrompt } = context;
    // 启用集和参数来自 data/strategies.json；配置保存后由修订号令共用 context 失效，
    // 因此当前轮下一个币种即可使用新配置，不必重启服务或等待整轮结束。
    const enabledStrategies = explicitStrategies || await this.strategies.enabled(config);
    if (!enabledStrategies.length) {
      console.warn('[GlobalAutomation] ⚠️ 未启用任何策略，本轮不做分析。请到「策略管理」勾选至少一个策略。');
      return [];
    }

    // 全市场轮次才打日志；单币种调用（全市场轮每币一次 / 挂单复核）会把它放大成每轮 500+ 行
    if (!requestedSymbols || requestedSymbols.length > 1) {
      console.log(`[GlobalAutomation] 开始行情分析，启用策略：${enabledStrategies.map(s => s.id).join(', ')}`);
    }

    let symbols = requestedSymbols || (await this.market.perpetualUsdtContracts()).map(s => s.symbol);
    const signals = [];
    const runId = randomUUID();
    const failures = [];

    // P3 修复：币种黑名单不再依赖引擎分支，任何策略都先做一次「负期望值币种拉黑」。
    // 自动化只需要订单主字段、账户自适应配置、活跃订单明细及历史订单的 strategyModel。
    // 使用专用快照可避免每轮扫描搬运大量已平仓订单扩展数据；旧模拟器仍回退到 read()。
    const state = context.state ??= this.simulation.readAutomation
      ? await this.simulation.readAutomation()
      : this.simulation.read ? await this.simulation.read() : { orders: [] };
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

    if (!requestedSymbols || requestedSymbols.length > 1) {
      console.log(`[GlobalAutomation] 分析完成: 已分析 ${totals.analyzed}, 合格 ${totals.eligible}, 已下单 ${totals.submitted}, 失败 ${totals.failed}`);
      // P3 漏斗日志：候选 → 各闸拦截 → 合格 → 下单。用于一眼判断是"降频生效"还是"被过滤光了"。
      console.log(`[GlobalAutomation][漏斗] 候选${symbols.length}×策略${enabledStrategies.length} 已分析${totals.analyzed} | 评分不足${blockedBy.score} `
        + `量能不足${blockedBy.volume} 盈亏比不足${blockedBy.riskReward} | 合格${totals.eligible} 下单${totals.submitted}`);
    }
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
          const strategyOutcome = await this.runStrategyAnalysis({
            strategy, symbol, market, submit, interval, config, strategyPrompt,
            state, adaptiveConfig, adaptiveOverrides, localHistory
          });
          const analysis = strategyOutcome?.analysis || null;
          const auxMarkets = strategyOutcome?.auxMarkets || {};

          // 让出事件循环（2026-09-10 性能优化）：分析是重 CPU 计算，
          // 20 个币的批在 Promise.all 里会把事件循环占满数秒，导致 /api/health 都要 2s+。
          await new Promise(resolve => setImmediate(resolve));
          if (!analysis) return { symbol, success: true, action: 'WAIT' };
          outcome.analyzed++;

          // 策略可给计划补上自己的出场规则（如本地引擎原生不带 exitRules）。
          if (typeof strategy.decoratePlan === 'function' && analysis.plan) {
            analysis.plan = await strategy.decoratePlan(analysis.plan, {
              params: strategy.params,
              config,
              interval,
              planInterval: strategy.planInterval || interval,
              deps: this.strategyDeps()
            });
          }

          // 原生计划周期策略（planInterval，如冲高回落空的 15m）：用该周期的辅助行情建
          // 研究记录与订单 —— 订单 interval 跟随 planInterval，maxHoldBars / 止损止盈结算
          // 都按该周期根数口径。辅助行情缺失时回退主周期行情（引擎侧会因无 15m 数据而出 WAIT）。
          const planMarket = strategy.planInterval && strategy.planInterval !== interval
            ? (auxMarkets[strategy.planInterval] || market)
            : market;
          const planInterval = planMarket.interval;

          // 所有策略共用同一套「时点 / 价格 / 成本」校验（createResearchRecord → normalizePlan）。
          const record = createResearchRecord({
            config: strategy.engine === 'ai'
              ? config
              : { ...config, model: { model: strategy.modelId, baseUrl: 'local://rules' } },
            strategy: { ...strategyPrompt, interval: planInterval },
            market: [planMarket],
            result: { analyses: [analysis] },
            type: 'single',
            scope: { interval: planInterval, limit: 80, engine: strategy.engine },
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
          const signal = record.analyses[0];
          outcome.signals.push(signal);

          // 现有策略先给出初步方向；只有有效 BUY/SELL 计划才进入独立二次确认，
          // 避免把 WAIT 或数据不足的币种伪装成机会。
          if (signal.eligible && signal.plan && ['BUY', 'SELL'].includes(signal.action)) {
            const opportunity = await this.createOpportunityReport({ symbol, signal, market: planMarket, strategy });
            if (opportunity) {
              signal.opportunityReport = opportunity;
              this.rememberOpportunity(opportunity);
              console.log(`[GlobalAutomation][机会] ${opportunity.summary}`);
            }
          }

          // 机会报告是在归一化后追加的，必须保存更新后的完整 record，
          // 否则 archive 中会只有策略计划而没有二次确认结论。
          await this.archive.save(record);
          if (!submit) return { symbol, success: true };

          // P3：统计本轮被哪道闸门挡住（不合格时才有拦截原因）
          if (!(signal.eligible && signal.plan)) tallyBlock(signal.reason);

          if (signal.eligible && signal.plan && ['BUY', 'SELL'].includes(signal.action)) {
            outcome.eligible++;
            const submission = await this.submitSignal({
              symbol,
              signal,
              recordId: record.id,
              executionPlan: buildExecutionPlanFromOpportunity(signal),
              shouldContinue
            });
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
      deps: this.strategyDeps(),
      account: state ? accountSummary(state) : null
    };

    if (strategy.needsAux?.length) {
      const auxMarkets = {};
      let incomplete = false;
      const requiredWindow = strategy.marketWindow || 80;
      for (const auxInterval of strategy.needsAux) {
        try {
          const intervalWindow = strategy.marketWindows?.[auxInterval] || requiredWindow;
          const canReuseConfiguredMain = auxInterval === market.interval && market.klines?.length >= intervalWindow;
          const aux = canReuseConfiguredMain ? market : await this.getFreshMarket(symbol, auxInterval, false, intervalWindow);
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

    // 衍生品/BTC 环境判断已关闭。即使旧策略配置残留 derivatives/btc，也不拉取、不传递，
    // 4h 策略只使用多周期 K 线和本地风险几何。
    // if (strategy.marketContext?.derivatives) ctx.derivatives = await this.getSkillDerivatives(symbol);
    // if (strategy.marketContext?.btc) {
    //   ctx.btcMarket = await this.getSkillBtcMarket(strategy.marketContext.btc, strategy.marketWindow || 500);
    // }
    ctx.skillContext = {
      // derivatives: null, // 已关闭，不再向分析器注入
      // btcMarket: null,   // 已关闭，不再向分析器注入
      requireFiveMinute: Boolean(strategy.marketContext?.requireFiveMinute)
    };

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

    // 把策略声明的计划周期（planInterval，如冲高回落空的 '4h'）注入 ctx，
    // 供原生不带周期识别的引擎（如 pump-short）按 planInterval 取对应辅助行情。
    ctx.planInterval = strategy.planInterval || null;
    const analysis = await strategy.analyze(market, ctx);
    // auxMarkets 一并返回：planInterval 策略（如 pump-fade-short-v1 的 15m）建研究记录时要用
    // 该周期的行情做 normalizePlan / 订单落库，否则订单会落在主周期（1m）上、
    // maxHoldBars 被 120 根上限压缩成 2 小时。
    return { analysis: analysis || null, auxMarkets: ctx.auxMarkets || {} };
  }

  async createOpportunityReport({ symbol, signal, market, strategy }) {
    let marketContext = {};
    if (typeof this.market.opportunityContext === 'function') {
      try {
        marketContext = await this.market.opportunityContext(symbol);
      } catch (error) {
        marketContext = { errors: { opportunityContext: error.message } };
      }
    } else {
      marketContext = { errors: { opportunityContext: '行情源未提供衍生品机会上下文。' } };
    }
    return createOpportunityReport({ signal, market, marketContext, strategy });
  }

  rememberOpportunity(report) {
    if (!report?.symbol) return;
    this.opportunitiesHydrated = true;
    const key = `${report.symbol}:${report.strategyId || ''}:${report.dataAsOf || report.generatedAt}`;
    this.opportunities = [report, ...this.opportunities.filter(item =>
      `${item.symbol}:${item.strategyId || ''}:${item.dataAsOf || item.generatedAt}` !== key
    )].slice(0, 50);
  }

  async getOpportunities(limit = 20) {
    const count = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)));
    if (!this.opportunitiesHydrated) {
      this.opportunitiesHydrated = true;
      try {
        const records = await this.archive?.list?.({ limit: 200 }) || [];
        this.opportunities = records.flatMap(record => (record.analyses || [])
          .map(signal => signal.opportunityReport)
          .filter(Boolean)).slice(0, 50);
      } catch {
        // 机会展示不能阻塞自动化状态接口；下一次新机会仍会进入内存队列。
      }
    }
    return this.opportunities.slice(0, count);
  }

  /**
   * 风控闸门 + 按策略落单。
   * 同币种未平仓不重复开仓；止损后 / 任意平仓后的冷却期同样拦截。
   */
  async submitSignal({ symbol, signal, recordId, executionPlan, shouldContinue }) {
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

      // 自动提交模拟订单（带 strategyId，订单从此知道自己属于哪个策略）。
      // 模拟订单是否镜像到 Binance Demo 由 trader.syncPaperOrdersToDemo 控制，
      // 避免把本地回测/纸面订单误发到远端。
      // 正式策略已经按自己的 params 计算并固化了推荐杠杆。
      // 只有旧策略没有输出该字段时，才回退到全局风控默认值。
      const strategyLeverage = Number(signal.recommendedLeverage ?? signal.plan?.recommendedLeverage);
      const leverage = Number.isFinite(strategyLeverage) && strategyLeverage > 0
        ? Math.max(1, Math.min(RISK_RULE.maxLeverage, Math.floor(strategyLeverage)))
        : recommendedLeverage(signal.plan, signal.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT');
      // 策略级并发上限（09-17 平衡档上线）：多策略共用一个资金池，但按策略 id 各自限仓。
      // plan.maxPositions 缺省（旧策略/未配置）时不限制 —— 与既有行为完全一致。
      const strategyMaxPositions = Math.floor(Number(signal.plan?.maxPositions));
      if (Number.isFinite(strategyMaxPositions) && strategyMaxPositions >= 1) {
        const openForStrategy = (simState.orders || [])
          .filter(o => o.analysisContext?.strategyId === signal.strategyId
            && (o.status === 'pending' || o.status === 'open')).length;
        if (openForStrategy >= strategyMaxPositions) {
          console.log(`[GlobalAutomation][${signal.strategyId}] ${symbol} 并发持仓 ${openForStrategy}/${strategyMaxPositions} 已满，跳过开仓`);
          return { symbol, success: true, action: 'SKIP_MAX_POSITIONS' };
        }
      }
      let explicitMargin = null;
      const skillRisk = Number(signal.plan?.riskPerTrade);
      const skillDailyLoss = Number(signal.plan?.maxDailyLoss);
      if (signal.strategyId?.startsWith('structure-') && Number.isFinite(skillRisk) && skillRisk > 0) {
        const summary = accountSummary(simState);
        const equity = Number(summary.equity ?? summary.initialBalance);
        const dayStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
        const dailyNet = (simState.orders || [])
          .filter(order => order.status === 'closed' && Date.parse(order.exitAt || '') >= dayStart)
          .reduce((sum, order) => sum + Number(order.net || 0), 0);
        if (Number.isFinite(skillDailyLoss) && skillDailyLoss > 0 && Number.isFinite(equity)
          && dailyNet <= -equity * skillDailyLoss) {
          console.log(`[GlobalAutomation][${signal.strategyId}] ${symbol} 已达到每日亏损上限 ${skillDailyLoss * 100}% ，跳过开仓`);
          return { symbol, success: true, action: 'SKIP_DAILY_LOSS' };
        }
        const entry = Number(signal.plan.entryLimit ?? ((signal.plan.entryMin + signal.plan.entryMax) / 2));
        const stop = Number(signal.plan.stopLoss);
        const stopPct = entry > 0 ? Math.abs(entry - stop) / entry : 0;
        if (Number.isFinite(equity) && equity > 0 && stopPct > 0) {
          const notional = equity * skillRisk / stopPct;
          explicitMargin = Math.floor((notional / leverage) * 100) / 100;
          if (explicitMargin < 1) {
            console.log(`[GlobalAutomation][${signal.strategyId}] ${symbol} 按 ${skillRisk * 100}% 止损风险计算的保证金不足 1 USDT，跳过开仓`);
            return { symbol, success: true, action: 'SKIP_RISK_SIZE' };
          }
        }
      }
      if (!shouldContinue()) return { symbol, success: true, action: 'ABORTED' };
      const submitInput = {
        recordId,
        symbol,
        leverage,
        automatic: true,
        strategyId: signal.strategyId,
        ...(executionPlan ? { executionPlan } : {})
      };
      // 买入金额：策略级 plan.autoMarginPct（如 4H 均值回归平衡档 0.015）优先 ——
      // 多策略共用一个资金池，各策略用各自回测验证过的仓位口径（按当前共享权益计）；
      // 缺省回落全局 NOFX_AUTO_MARGIN_PCT（enhanced-trend 等旧策略行为不变）。
      const strategyMarginPct = Number(signal.plan?.autoMarginPct);
      if (explicitMargin != null) submitInput.margin = explicitMargin;
      else if (Number.isFinite(strategyMarginPct) && strategyMarginPct > 0 && strategyMarginPct <= 1) {
        submitInput.autoMarginPct = strategyMarginPct;
      } else submitInput.autoMarginPct = AUTO_MARGIN_PCT;
      await this.simulation.submit(submitInput);

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
    const task = this.tasks.positionReview;
    const startedAt = Date.now();
    const state = this.simulation.readLight ? await this.simulation.readLight() : await this.simulation.read();
    const openOrders = state.orders.filter(o => ['pending', 'open'].includes(o.status));
    const progress = task.progress = { total: openOrders.length, completed: 0, failed: 0, symbol: null, stage: null };
    const summary = {
      reviewed: 0,
      updated: 0,
      held: 0,
      closed: 0,
      refreshed: 0,
      skippedSameCandle: 0,
      skippedInactive: 0,
      skippedError: 0,
      skippedNoStrategy: 0,
      skippedPartial: 0
    };

    const finishLog = force => {
      progress.symbol = null;
      progress.stage = null;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const line = `[GlobalAutomation][positionReview 轮] 活跃 ${openOrders.length} · 进度 ${progress.completed}/${progress.total}`
        + ` · 实复核 ${summary.reviewed} · 刷新 ${summary.refreshed}`
        + ` · 跳过 同K线${summary.skippedSameCandle}/已结束${summary.skippedInactive}/错误订单${summary.skippedError}`
        + `/无策略${summary.skippedNoStrategy}/数据不足${summary.skippedPartial}`
        + ` · 更新 ${summary.updated} · 保持 ${summary.held} · 智能退出 ${summary.closed}`
        + ` · 失败 ${progress.failed} · 耗时 ${elapsed}s`;
      task.lastSummary = line;
      task.lastSummaryAt = new Date().toISOString();

      const due = Date.now() - (this._positionReviewLastSummaryAt || 0) >= 60000;
      if (force || due) {
        this._positionReviewLastSummaryAt = Date.now();
        console.log(line);
      }
    };

    // 复核日志不能每秒刷屏，但需要有心跳摘要，避免任务正常跳过时看起来“没输出”。
    // 已复核到哪根 K 线的记忆（订单 id → 已复核的开盘时间），同一根内不重复复核。
    this._reviewedCandle ??= new Map();
    const reviewKey = openOrders.map(o => `${o.id}:${o.status}:${o.error ? 'E' : ''}`).join('|') || '0';
    const changed = this._reviewLogKey !== reviewKey;
    if (changed) {
      this._reviewLogKey = reviewKey;
      console.log(openOrders.length
        ? `[GlobalAutomation] 开始复核 ${openOrders.length} 个持仓/挂单...`
        : '[GlobalAutomation] 无持仓/挂单需要复核');
    }
    if (openOrders.length === 0) {
      finishLog(changed);
      return;
    }

    let config = await this.store.getConfig();
    // 多策略：启用集只用于无 strategyId 的旧订单回退；有 strategyId 的存量订单
    // 由 strategyForOrder 从订单快照/配置文件恢复，即使原策略已被停用也继续复核。
    let strategies = await this.strategies.enabled(config);
    if (!strategies.length) {
      console.warn('[GlobalAutomation] ⚠️ 当前未启用新策略，但仍继续复核已有订单的策略快照。');
    }

    // 轻量快照直接传给复核链路：此前 reviewPendingOrder → runAnalysis 拿不到 state 时
    // 会退化为每秒一次全量 simulation.read()（含 9 万行 extensions hydrate，单次 8~19s）。
    const context = { config, state, configRevision: this.runtimeConfigRevision };
    // 清理已不活跃订单的复核记忆，防 Map 无界增长
    const activeIds = new Set(openOrders.map(o => o.id));
    for (const id of this._reviewedCandle.keys()) if (!activeIds.has(id)) this._reviewedCandle.delete(id);

    const refreshed = new Set();
    const markets = new Map();
    for (const snapshot of openOrders) {
      if (!shouldContinue()) break;
      if (context.configRevision !== this.runtimeConfigRevision) {
        await this.loadRuntimeConfig(context);
        config = context.config;
        strategies = await this.strategies.enabled(config);
      }
      progress.symbol = snapshot.symbol;
      const curCandle = candleOpenAt(Date.now(), snapshot.interval);
      if (this._reviewedCandle.get(snapshot.id) === curCandle) {
        summary.skippedSameCandle++;
        progress.completed++;
        continue;
      }
      try {
        const symbolKey = `${snapshot.symbol}:${snapshot.interval}`;
        const retryError = isTransientOrderError(snapshot.error);
        if (!refreshed.has(symbolKey)
          && (!snapshot.error || retryError)
          && (retryError || Date.parse(snapshot.markAt) !== curCandle)) {
          progress.stage = 'refresh';
          await this.simulation.refresh({ symbols: [snapshot.symbol], shouldContinue });
          summary.refreshed++;
        }
        refreshed.add(symbolKey);
        if (!shouldContinue()) break;
        progress.stage = 'read-order';
        const order = this.simulation.getOrder ? await this.simulation.getOrder(snapshot.id)
          : (await this.simulation.read()).orders.find(o => o.id === snapshot.id);
        if (!order || !['pending', 'open'].includes(order.status)) {
          summary.skippedInactive++;
          continue;
        }
        if (order.error) {
          summary.skippedError++;
          continue;
        }

        const key = `${order.symbol}:${order.interval}`;
        progress.stage = 'market';
        if (!markets.has(key)) markets.set(key, await this.getFreshMarket(order.symbol, order.interval));
        const market = markets.get(key);
        if (!shouldContinue()) break;
        const orderStrategy = await this.strategies.strategyForOrder(order, config, strategies);
        if (order.status === 'pending') {
          progress.stage = 'pending-review';
          await this.reviewPendingOrder(order, market, shouldContinue, context, orderStrategy);
          this._reviewedCandle.set(snapshot.id, curCandle);
          summary.reviewed++;
          continue;
        }

        if (market.partial && market.klines.length < 15) {
          summary.skippedPartial++;
          console.log(`[GlobalAutomation] ${order.symbol} ${order.interval} 已收盘K线不足 ${market.klines.length} 根，本次跳过复核`);
          continue;
        }

        if (!orderStrategy) {
          summary.skippedNoStrategy++;
          console.warn(`[GlobalAutomation] ${order.symbol} 找不到所属策略，跳过复核。`);
          continue;
        }
        if (orderStrategy.engine === 'ai' && !context.strategyPrompt) {
          context.strategyPrompt = await this.store.getStrategy();
        }
        progress.stage = 'strategy-review';
        const proposal = await orderStrategy.review(order, market, {
          config,
          params: orderStrategy.params,
          strategyPrompt: context.strategyPrompt,
          interval: order.interval,
          deps: this.strategyDeps()
        });

        if (!shouldContinue()) break;
        if (proposal.action === 'CLOSE') {
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

          if (!shouldContinue()) break;
          progress.stage = 'close';
          await this.simulation.close(order.id, { refresh: false, reason: closeReason });
          summary.closed++;
          this._reviewedCandle.set(snapshot.id, curCandle);
          console.log(`[GlobalAutomation][${orderStrategy.id}] ${order.symbol} 智能退出平仓：${closeReason} — ${proposal.reason}`);
          summary.reviewed++;
          continue;
        }

        progress.stage = 'write-review';
        await this.simulation.mutateLight(state => {
          if (!shouldContinue()) return;
          const current = state.orders.find(o => o.id === order.id);
          if (!current || current.status !== 'open') return;

          const report = applyPaperProtectionReview(current, proposal, Date.now(), orderStrategy.engine);
          if (report.action === 'updated') {
            summary.updated++;
            console.log(`[GlobalAutomation][${orderStrategy.id}] ${order.symbol} 止盈止损已更新`);

            if ((orderStrategy.engine === 'enhanced' || orderStrategy.engine === 'super') && proposal.profitPercent !== undefined) {
              console.log(`[GlobalAutomation] ${order.symbol} 当前盈亏：${proposal.profitPercent.toFixed(2)}%`);
            }
            if (orderStrategy.engine === 'super' && proposal.sentiment) {
              console.log(`[GlobalAutomation] ${order.symbol} 市场情绪：${proposal.sentiment.classification}`);
            }
          } else {
            summary.held++;
          }
        });

        summary.reviewed++;
        this._reviewedCandle.set(snapshot.id, curCandle);
      } catch (error) {
        progress.failed++;
        this.tasks.positionReview.error = `${snapshot.symbol}: ${error.message}`;
        console.error(`[GlobalAutomation] Review ${snapshot.symbol} failed:`, error.message);
      } finally {
        progress.stage = null;
        progress.completed++;
      }
    }

    this.stats.totalReviews += summary.reviewed;
    finishLog(changed || summary.reviewed > 0 || progress.failed > 0);
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
    const orderStrategy = strategy
      || await this.strategies.strategyForOrder(order, context.config || {}, []);
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

  async getFreshMarket(symbol, interval = MAIN_INTERVAL, forceFetch = false, limit = 80) {
    const key = this.market.storageSymbol(symbol);
    const now = Date.now();
    const windowLimit = Math.min(1000, Math.max(20, Number(limit) || 80));

    // 用交易所返回的原始数据构造"尽力而为"的已收盘K线集合
    const buildPartial = rows => {
      const closed = (Array.isArray(rows) ? rows : [])
        .filter(row => row.confirmed !== false && nextOpenTime(row.openTime, interval) <= now)
        .sort((a, b) => a.openTime - b.openTime).slice(-windowLimit)
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
      const fetchLimit = Math.min(1000, Math.max(windowLimit + 2, Number(limit) || windowLimit + 2));
      const raw = await this.market.klines({ symbol, interval, limit: fetchLimit });
      await this.marketDb.saveKlines({ symbol: key, interval, rows: raw });
      const prepared = prepareMarket({ symbol, interval, rows: raw, limit: windowLimit, marketProvider: this.market.provider, throwOnInsufficient: false });
      return prepared.insufficient ? buildPartial(raw) : prepared;
    };

    if (forceFetch) return fetchPrepared(windowLimit + 2);

    try {
      // 先尝试从数据库获取
      const rows = await this.marketDb.listKlines({ symbol: key, interval, limit: windowLimit });

      // 尝试准备市场数据，检查是否足够
      let prepared = prepareMarket({ symbol, interval, rows, limit: windowLimit, marketProvider: this.market.provider, throwOnInsufficient: false });

      // 如果数据不足，从交易所获取更多（交易所也不够时降级为部分数据，不报错）
      if (prepared.insufficient) {
        prepared = await fetchPrepared(Math.max(windowLimit + 2, prepared.required + 2));
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
      const prepared = await fetchPrepared(windowLimit + 2);

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
      opportunities: await this.getOpportunities(20),
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

  // 最近有效策略机会：包含币种、价格区间、止损止盈和超级确认结论。
  app.get('/api/automation/opportunities', async (req, res, next) => {
    try {
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(req.query.limit) || 20)));
      res.json({ asOf: new Date().toISOString(), opportunities: await automation.getOpportunities(limit) });
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
