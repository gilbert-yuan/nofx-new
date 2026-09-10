/**
 * 全局自动化交易系统
 *
 * 核心功能：
 * 1. 定时获取K线（使用OKX公共接口，无需API Key）
 * 2. 定时分析行情（本地规则或AI）
 * 3. 自动模拟下单
 * 4. 动态止盈止损管理
 * 5. 持仓实时复核
 */

import { randomUUID } from 'node:crypto';
import { LOCAL_STRATEGY, localAnalysisMultiTimeframe, recommendedLeverage } from './localAnalysis.js';
import { getAdaptiveConfig } from './adaptiveConfig.js';
import { filterSymbolsByPerformance, getAdaptiveParametersForSymbol, shouldTradeAtCurrentHour } from './adaptiveFilters.js';
import { enhancedAnalysis, enhancedProtectionReview } from './enhancedAnalysis.js';
import { createSuperEnhancedAnalysis } from './superEnhancedAnalysis.js';
import { analyzeMarkets, reviewPosition } from './ai.js';
import { candleOpenAt, nextOpenTime, prepareMarket, createResearchRecord, MAIN_INTERVAL } from './research.js';
import { TRAILING_RULE } from './shared/strategyGuards.js';

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

    // 任务状态
    this.tasks = {
      klineSync: { enabled: true, interval: 60000, lastRun: null, running: false },
      analysis: { enabled: true, interval: 5 * 60000, lastRun: null, running: false },  // 5分钟执行一次
      positionReview: { enabled: true, interval: 60000, lastRun: null, running: false }  // 1分钟执行一次
    };

    this.timers = {};
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
    console.log('[GlobalAutomation] 启动全局自动化系统...');

    // 启动K线同步任务（每60秒）
    this.scheduleTask('klineSync', () => this.syncKlines(), this.tasks.klineSync.interval);

    // 启动行情分析任务（每15分钟）
    this.scheduleTask('analysis', () => this.runAnalysis(), this.tasks.analysis.interval);

    // 启动持仓复核任务（每1分钟）
    this.scheduleTask('positionReview', () => this.reviewPositions(), this.tasks.positionReview.interval);

    console.log('[GlobalAutomation] 全局自动化系统已启动');
  }

  /**
   * 停止全局自动化系统
   */
  stop() {
    console.log('[GlobalAutomation] 停止全局自动化系统...');
    Object.keys(this.timers).forEach(key => {
      if (this.timers[key]) {
        clearInterval(this.timers[key]);
        this.timers[key] = null;
      }
    });
    console.log('[GlobalAutomation] 全局自动化系统已停止');
  }

  /**
   * 调度任务
   */
  scheduleTask(name, fn, interval) {
    // 立即执行一次
    this.executeTask(name, fn);

    // 设置定时任务
    this.timers[name] = setInterval(() => {
      this.executeTask(name, fn);
    }, interval);

    this.timers[name].unref();
  }

  /**
   * 执行任务
   */
  async executeTask(name, fn) {
    const task = this.tasks[name];
    if (!task.enabled || task.running) return;

    task.running = true;
    const startTime = Date.now();

    try {
      await fn();
      task.lastRun = new Date().toISOString();
      console.log(`[GlobalAutomation] ${name} 完成，耗时 ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error(`[GlobalAutomation] ${name} 失败:`, error.message);
      this.stats.errors.push({
        task: name,
        error: error.message,
        time: new Date().toISOString()
      });
      this.stats.errors = this.stats.errors.slice(-50);
    } finally {
      task.running = false;
    }
  }

  /**
   * 任务1: 同步K线数据（使用OKX公共接口，无需API Key）
   */
  async syncKlines() {
    const symbols = await this.market.perpetualUsdtContracts();
    console.log(`[GlobalAutomation] 开始同步 ${symbols.length} 个币种的K线...`);

    let synced = 0;
    let failed = 0;

    for (const contract of symbols) {
      try {
        const symbol = contract.symbol;
        const key = this.market.storageSymbol(symbol);
        const interval = MAIN_INTERVAL;

        // 获取最新K线
        const rows = await this.market.klines({
          symbol,
          interval,
          limit: 100
        });

        if (rows.length > 0) {
          // 保存到数据库
          await this.marketDb.saveKlines({
            symbol: key,
            interval,
            rows
          });
          synced++;
        }
      } catch (error) {
        failed++;
        console.error(`[GlobalAutomation] 同步 ${contract.symbol} 失败:`, error.message);
      }

      // 避免请求过快
      if (synced % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`[GlobalAutomation] K线同步完成: 成功 ${synced}, 失败 ${failed}`);
  }

  /**
   * 任务2: 定时分析行情并自动下单
   */
  async runAnalysis() {
    const config = await this.store.getConfig();
    const strategy = { ...await this.store.getStrategy(), interval: MAIN_INTERVAL };
    const engine = selectAnalysisEngine(config);

    console.log(`[GlobalAutomation] 开始行情分析，使用 ${engine} 模式...`);

    let symbols = (await this.market.perpetualUsdtContracts()).map(s => s.symbol);
    const runId = randomUUID();

    // P3 修复：币种过滤原先整段写在 engine === 'local' 分支里，engine='enhanced'/'super' 时
    // 根本不会执行（而且样本还按 strategyModel === LOCAL_STRATEGY.modelId 过滤，
    // enhanced 下单的 modelId 是 `${engine}-rules-v1`，导致样本恒为 0、过滤器永远不生效）。
    // 现在改为：任何引擎都先读取状态并做一次基于"全部已平仓订单"的负期望值币种拉黑。
    const state = this.simulation.read ? await this.simulation.read() : { orders: [] };
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
      const batch = symbols.slice(i, i + batchSize);

      const results = await Promise.all(batch.map(async symbol => {
        try {
          // 获取主周期K线
          const market = await this.getFreshMarket(symbol, MAIN_INTERVAL);

          // 使用多周期分析作为默认
          let analysis;
          if (engine === 'local') {
            // 并行获取辅助周期数据
            const auxMarketsPromises = [];
            const intervals = ['15m', '1h', '4h'];

            for (const interval of intervals) {
              if (interval === MAIN_INTERVAL) continue;
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

          analyzed++;

          // All engines use the same timing, price and cost validation as manual analysis.
          const record = createResearchRecord({
            config: engine === 'ai' ? config : { ...config, model: { model: engine === 'local' ? LOCAL_STRATEGY.modelId : `${engine}-rules-v1`, baseUrl: 'local://rules' } },
            strategy, market: [market], result: { analyses: analysis ? [analysis] : [] },
            type: 'single', scope: { interval: MAIN_INTERVAL, limit: 80, engine }
          });
          Object.assign(record, { id: `auto-${runId}-${symbol}`, analysisEngine: engine, automationRunId: runId });
          for (const signal of record.analyses) {
            signal.analysisEngine = engine;
            if (engine !== 'ai') signal.confidenceType = 'rule_strength';
          }
          await this.archive.save(record);
          analysis = record.analyses[0];

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
              const simState = this.simulation.read ? await this.simulation.read() : { orders: [] };
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
              if (lastStopAt && Date.now() - lastStopAt < 60 * 60000) {
                console.log(`[GlobalAutomation] ${symbol} 止损后60分钟冷却期内，跳过开仓`);
                return { symbol, success: true, action: 'SKIP_COOLDOWN' };
              }

              // 自动提交模拟订单
              const leverage = recommendedLeverage(analysis.plan, analysis.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT');
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

      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    this.stats.totalAnalyzed += analyzed;
    this.stats.totalOrders += submitted;

    console.log(`[GlobalAutomation] 分析完成: 已分析 ${analyzed}, 合格 ${eligible}, 已下单 ${submitted}, 失败 ${failed}`);
    // P3 漏斗日志：候选 → 各闸拦截 → 合格 → 下单。用于一眼判断是"降频生效"还是"被过滤光了"。
    console.log(`[GlobalAutomation][漏斗] 候选${symbols.length} 已分析${analyzed} | 评分不足${blockedBy.score} `
      + `量能不足${blockedBy.volume} 盈亏比不足${blockedBy.riskReward} | 合格${eligible} 下单${submitted}`);
    if (symbols.length === 0) {
      console.warn('[GlobalAutomation][告警] 币种过滤后候选为 0 —— 过滤器可能把所有币种都拉黑了，请检查自适应过滤样本！');
    } else if (analyzed > 0 && eligible === 0) {
      console.warn(`[GlobalAutomation][告警] 本轮 0 个合格信号 —— 门槛可能过严（候选${symbols.length}/已分析${analyzed}），`
        + `请核对上面漏斗计数；可临时下调 NOFX_MIN_TREND_SCORE / NOFX_MIN_RR 恢复出单。`);
    }
  }

  /**
   * 任务3: 复核持仓，动态调整止盈止损
   */
  async reviewPositions() {
    // 先刷新所有持仓状态
    await this.simulation.refresh();

    const state = await this.simulation.read();
    const openOrders = state.orders.filter(o => o.status === 'open');

    if (openOrders.length === 0) {
      console.log('[GlobalAutomation] 无持仓需要复核');
      return;
    }

    console.log(`[GlobalAutomation] 开始复核 ${openOrders.length} 个持仓...`);

    const config = await this.store.getConfig();
    const engine = selectAnalysisEngine(config);

    let reviewed = 0;
    let updated = 0;
    let held = 0;
    let closed = 0;

    for (const order of openOrders) {
      try {
        // 获取最新行情
        const market = await this.getFreshMarket(order.symbol, order.interval);

        // 数据不足（如新上币种）时跳过复核，等K线积累够了再处理
        if (market.partial && market.klines.length < 15) {
          console.log(`[GlobalAutomation] ${order.symbol} ${order.interval} 已收盘K线不足 ${market.klines.length} 根，本次跳过复核`);
          continue;
        }

        // 生成复核建议
        let proposal;
        if (engine === 'local') {
          proposal = this.localProtectionReview(order, market);
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

        // 应用复核建议
        await this.simulation.mutate(state => {
          const current = state.orders.find(o => o.id === order.id);
          if (!current || current.status !== 'open') return;

          // 如果建议平仓
          if (proposal.action === 'CLOSE') {
            // 记录建议
            current.reviewHistory = current.reviewHistory || [];
            current.reviewHistory.push({
              at: new Date().toISOString(),
              engine,
              action: 'close_suggested',
              reason: proposal.reason,
              confidence: proposal.confidence,
              sentiment: proposal.sentiment
            });

            console.log(`[GlobalAutomation] ${order.symbol} ${proposal.reason}`);
            closed++;
            // 注意：实际平仓需要用户确认或在Web界面操作
            return;
          }

          const report = this.applyPaperProtectionReview(current, proposal, Date.now(), engine);
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
        console.error(`[GlobalAutomation] 复核 ${order.symbol} 失败:`, error.message);
      }
    }

    this.stats.totalReviews += reviewed;

    console.log(`[GlobalAutomation] 复核完成: 已复核 ${reviewed}, 已更新 ${updated}, 保持 ${held}, 建议平仓 ${closed}`);
  }

  /**
   * 获取最新行情数据
   * 数据不足时：先查数据库，不够再直接从交易所获取；
   * 若交易所也提供不了足够多的已收盘K线（如新上币种），
   * 则降级返回已有的部分数据（partial: true），不再抛错。
   */
  async getFreshMarket(symbol, interval = MAIN_INTERVAL) {
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
      const prepared = prepareMarket({ symbol, interval, rows: raw, limit: 80, marketProvider: this.market.provider, throwOnInsufficient: false });
      return prepared.insufficient ? buildPartial(raw) : prepared;
    };

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
   * 本地规则复核持仓
   */
  localProtectionReview(order, market) {
    const rows = market.klines;
    const price = rows.at(-1).close;

    // 计算14根平均真实波幅
    const atr = rows.slice(-14).reduce((sum, r, i) => {
      const previous = rows[rows.length - 15 + i].close;
      return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
    }, 0) / 14;

    if (!(atr > 0)) {
      return { action: 'HOLD', reason: '波动率无效，保留当前保护价格。' };
    }

    const long = order.direction === 'OPEN_LONG';

    // 未盈利超过2%时保持初始保护价格，避免把止损棘轮式推向现价被噪声扫出。
    const profit = long
      ? (price - order.entry) / order.entry
      : (order.entry - price) / order.entry;
    if (!(profit > 0.02)) {
      return {
        action: 'HOLD',
        reason: '持仓未盈利超过2%，保持初始保护价格，避免噪声止损。'
      };
    }

    // 移动止损距离放宽到 2.5×ATR（P0-1；跨引擎共享常量见 server/shared/strategyGuards.js → TRAILING_RULE）
    const stopLoss = long
      ? Math.max(order.plan.stopLoss, price - TRAILING_RULE.stopAtr * atr)
      : Math.min(order.plan.stopLoss, price + TRAILING_RULE.stopAtr * atr);

    // 止盈跟随对齐开仓目标 4×ATR，让盈利单能跑到完整目标而非被贴身止损提前扫掉
    const TP_ATR = 4;
    const takeProfit = long
      ? Math.max(order.plan.takeProfit, price + TP_ATR * atr)
      : Math.min(order.plan.takeProfit, price - TP_ATR * atr);

    return {
      action: 'UPDATE_PROTECTION',
      stopLoss,
      takeProfit,
      confidence: 0.75,
      reason: '按最新 14 根真实波幅复核；只收紧止损，顺势调整止盈。'
    };
  }

  /**
   * 应用持仓保护复核建议
   */
  applyPaperProtectionReview(order, proposal, now = Date.now(), engine = 'local') {
    if (order.status !== 'open') {
      return { action: 'held', reason: '订单尚未入场或已经结束。' };
    }

    const report = {
      at: new Date(now).toISOString(),
      engine,
      action: 'held',
      reason: proposal.reason || '保留当前保护价格。'
    };

    const record = () => {
      order.reviewHistory = [...(order.reviewHistory || []), report].slice(-50);
      return report;
    };

    // 检查行情是否最新
    if (order.error || Date.parse(order.markAt) !== candleOpenAt(now, order.interval)) {
      report.reason = '行情尚未连续结算到最新收盘时间，暂不修改。';
      return record();
    }

    if (proposal.action !== 'UPDATE_PROTECTION') {
      return record();
    }

    // AI模式需要验证置信度
    if (engine === 'ai') {
      const confidence = Number(proposal.confidence);
      if (!Number.isFinite(confidence) || confidence < 0.65 || confidence > 1) {
        report.reason = 'AI 自评分无效或低于复核阈值，保留原保护。';
        return record();
      }
    }

    const stopLoss = Number(proposal.stopLoss);
    const takeProfit = Number(proposal.takeProfit);
    const price = Number(order.markPrice);
    const long = order.direction === 'OPEN_LONG';

    // 验证价格有效性
    if (
      ![stopLoss, takeProfit, price].every(v => Number.isFinite(v) && v > 0) ||
      (long ? !(stopLoss < price && price < takeProfit) : !(takeProfit < price && price < stopLoss)) ||
      (long ? stopLoss < order.plan.stopLoss : stopLoss > order.plan.stopLoss)
    ) {
      report.reason = '建议价格无效、已被穿越或扩大了止损风险，保留原保护。';
      return record();
    }

    // 检查变化是否足够大（避免微小调整）
    if (
      Math.abs(stopLoss - order.plan.stopLoss) / price < 0.0001 &&
      Math.abs(takeProfit - order.plan.takeProfit) / price < 0.0001
    ) {
      return record();
    }

    // 保存初始计划
    order.initialPlan ||= { ...order.plan };

    // 记录修订
    const effectiveFrom = nextOpenTime(candleOpenAt(now, order.interval), order.interval);
    const revision = { stopLoss, takeProfit, effectiveFrom, at: report.at };
    order.protectionRevisions = [...(order.protectionRevisions || []), revision];

    // 更新报告
    Object.assign(report, {
      action: 'updated',
      previous: { stopLoss: order.plan.stopLoss, takeProfit: order.plan.takeProfit },
      stopLoss,
      takeProfit,
      effectiveFrom
    });

    // 应用新的保护价格
    order.plan = { ...order.plan, stopLoss, takeProfit };

    return record();
  }

  /**
   * 获取系统状态
   */
  async getStatus() {
    const accountStatus = await this.simulation.status();

    return {
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
    if (!this.tasks[taskName]) {
      throw new Error(`未知任务: ${taskName}`);
    }

    const task = this.tasks[taskName];

    if (typeof options.enabled === 'boolean') {
      task.enabled = options.enabled;
      console.log(`[GlobalAutomation] ${taskName} ${options.enabled ? '已启用' : '已禁用'}`);
    }

    if (typeof options.interval === 'number' && options.interval > 0) {
      task.interval = options.interval;

      // 重新调度任务
      if (this.timers[taskName]) {
        clearInterval(this.timers[taskName]);
        this.scheduleTask(taskName, this.getTaskFunction(taskName), task.interval);
      }

      console.log(`[GlobalAutomation] ${taskName} 间隔已更新为 ${options.interval}ms`);
    }

    return task;
  }

  /**
   * 获取任务函数
   */
  getTaskFunction(taskName) {
    const taskFunctions = {
      klineSync: () => this.syncKlines(),
      analysis: () => this.runAnalysis(),
      positionReview: () => this.reviewPositions()
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
    await this.executeTask(taskName, fn);
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
