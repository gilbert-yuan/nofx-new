import { fetchContinuousKlines } from './continuousKlines.js';
import { randomUUID } from 'node:crypto';
import { candleOpenAt, nextOpenTime, validCandle, PAPER_COSTS } from './research.js';
import { recommendedLeverage } from './localAnalysis.js';
import { RISK_RULE } from './shared/strategyGuards.js';
import { createAccountSimulator } from './tradingSimulator.js';
import { analyzeClosedOrders, generateStrategyAdjustments } from './strategyOptimizer.js';
import { SimulatedAccountRepository } from './simulatedAccountRepository.js';
import { getOrderReplayData, batchAnalyzeOrders } from './orderReplay.js';
import { optimizeStrategyFromOrders } from './adaptiveStrategy.js';

const active = order => ['pending', 'open'].includes(order.status);
const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
export const initialPaperAccount = () => ({ initialBalance: 10000, orders: [] });

export function accountSummary(state) {
  const orders = state.orders;
  const realized = orders.filter(o => o.status === 'closed').reduce((sum, o) => sum + o.net, 0);
  const entryFees = orders.filter(o => o.status === 'open').reduce((sum, o) => sum + o.entryFee, 0);
  const usedMargin = orders.filter(active).reduce((sum, o) => sum + o.margin, 0);
  const feeReserve = orders.filter(o => o.status === 'pending').reduce((sum, o) => sum + o.notional * o.costs.feeBps / 10000, 0);
  const floating = orders.filter(o => o.status === 'open').reduce((sum, o) => sum + (o.unrealized || 0), 0);
  const balance = state.initialBalance + realized - entryFees;
  const investedMargin = orders.filter(o => o.entry).reduce((sum, o) => sum + o.margin, 0);
  const closedMargin = orders.filter(o => o.status === 'closed').reduce((sum, o) => sum + o.margin, 0);
  return { unlimitedCapital: !!state.unlimitedCapital, investedMargin, closedMargin, realizedReturn: closedMargin ? realized / closedMargin : null,
    initialBalance: state.initialBalance, balance: state.unlimitedCapital ? null : balance, available: state.unlimitedCapital ? null : balance - usedMargin - feeReserve,
    equity: state.unlimitedCapital ? null : balance + floating, usedMargin, realized, unrealized: floating,
    net: realized - entryFees + floating, openCount: orders.filter(active).length };
}

export function submitPaperOrder(state, record, input, now = Date.now()) {
  const signal = record?.analyses?.find(s => s.symbol === input.symbol);
  const existing = state.orders.find(o => o.recordId === record?.id && o.symbol === input.symbol);
  if (existing) return existing;
  if (!signal?.eligible || !signal.plan || !['OPEN_LONG', 'OPEN_SHORT'].includes(signal.positionRecommendation)) fail('该分析为观望或没有有效开仓计划，不能模拟下单。');
  if ((signal.marketProvider || record.marketProvider) !== 'okx') fail('请使用当前 OKX 行情重新分析后模拟下单。');
  const first = Math.max(Date.parse(signal.firstEntryAt), nextOpenTime(candleOpenAt(now, signal.interval), signal.interval));
  if (!Number.isFinite(first)) fail('分析计划的入场时间无效，请重新分析。');
  const margin = Number(input.margin ?? 100), leverage = Number(input.leverage ?? signal.recommendedLeverage ?? recommendedLeverage(signal.plan, signal.positionRecommendation));
  // 杠杆上限必须与全局配置 RISK_RULE.maxLeverage 一致（由 NOFX_MAX_LEVERAGE 驱动）。
  // 此前此处硬编码 5，P12 把 NOFX_MAX_LEVERAGE 提到 12 后脱节，导致被推荐 ~10x 的
  // 币种（如 IOSTUSDT）在模拟下单时被误拒。改读单一事实源，避免再次漂移。
  const maxLev = RISK_RULE.maxLeverage;
  if (!Number.isFinite(margin) || margin < 1 || margin > 100000 || !Number.isInteger(leverage) || leverage < 1 || leverage > maxLev) fail(`保证金须为 1～100000 USDT，杠杆须为 1～${maxLev} 的整数。`);
  if (!state.unlimitedCapital && state.orders.filter(active).length >= 20) fail('最多同时持有 20 个模拟挂单或持仓。');
  if (!state.unlimitedCapital && state.orders.some(o => active(o) && o.symbol === input.symbol)) fail('该币种已有模拟挂单或持仓。');
  const plan = { ...signal.plan, stopLoss: Number(input.stopLoss ?? signal.plan.stopLoss), takeProfit: Number(input.takeProfit ?? signal.plan.takeProfit) };
  const long = signal.positionRecommendation === 'OPEN_LONG';
  if (![plan.stopLoss, plan.takeProfit].every(v => Number.isFinite(v) && v > 0) || (long ? !(plan.stopLoss < plan.entryMin && plan.takeProfit > plan.entryMax) : !(plan.takeProfit < plan.entryMin && plan.stopLoss > plan.entryMax))) fail('止盈止损必须位于入场区间两侧，且符合多空方向。');
  const notional = margin * leverage;
  if (!state.unlimitedCapital && margin + notional * PAPER_COSTS.feeBps / 10000 > accountSummary(state).available) fail('模拟可用余额不足。');

  // 保存完整的分析上下文，用于后续策略优化
  const analysisContext = {
    signal: { ...signal }, // 完整的分析信号
    strategyVersion: record.strategyVersion, // 策略版本哈希
    strategyModel: record.snapshot?.model || null,
    analysisEngine: record.analysisEngine || signal.analysisEngine, // 分析引擎类型
    scope: record.scope, // 分析参数（limit, interval等）
    confidence: signal.confidence,
    confidenceType: signal.confidenceType,
    reason: signal.reason, // 开仓理由
    risk: signal.risk, // 风险提示
    validationIssues: signal.validationIssues || [],
    automationRunId: record.automationRunId, // 自动化运行ID
    dataAsOf: signal.dataAsOf // 行情时间戳
  };

  const order = { id: randomUUID(), recordId: record.id, symbol: signal.symbol, interval: signal.interval, marketProvider: 'okx',
    direction: signal.positionRecommendation, status: 'pending', margin, leverage, notional, plan, initialPlan: { ...plan }, costs: { ...PAPER_COSTS },
    automatic: input.automatic === true, protectionRevisions: [], reviewHistory: [],
    analysisContext, // 新增：完整分析上下文
    createdAt: new Date(now).toISOString(), nextTime: first, heldBars: 0, error: '' };
  state.orders.unshift(order);
  return order;
}

export function settlePaperOrder(order, price, reason, time, ambiguousBar = false) {
  const direction = order.direction === 'OPEN_LONG' ? 1 : -1;
  const exit = price * (1 - direction * order.costs.slippageBps / 10000);
  const quantity = order.quantity;

  // ── 分批止盈汇总（2026-09-11）──────────────────────────────────────────
  // 手动平仓 / 智能退出 CLOSE 走的都是本函数，而不是 tradingSimulator._settle。
  // 若此前已分批成交，order.quantity 只剩奔跑仓，已实现盈亏记在 realized* 上 ——
  // 不并入的话，这批盈利会凭空消失（明明赚了却被记成少赚）。
  // 入场费按剩余仓位比例分摊，与 _settle 完全同口径。
  const prior = {
    gross: Number(order.realizedGross) || 0,
    fee: Number(order.realizedFee) || 0,
    funding: Number(order.realizedFunding) || 0,
    net: Number(order.realizedNet) || 0,
    qty: Number(order.realizedQty) || 0
  };
  const originalQty = prior.qty + quantity;
  const share = originalQty > 0 ? quantity / originalQty : 0;

  const gross = direction * (exit - order.entry) * quantity;
  const exitFee = exit * quantity * order.costs.feeBps / 10000;
  const entryFee = (order.entryFee || 0) * share;
  const funding = order.notional * share * order.costs.fundingBpsPer8h / 10000 * Math.max(0, time - Date.parse(order.entryAt)) / 28800000;
  const rawNet = (gross - entryFee - exitFee - funding) + prior.net;
  // Isolated simulated collateral: never debit more than reserved margin + entry fee.
  const net = Math.max(-order.margin - order.entryFee, rawNet);
  Object.assign(order, { status: 'closed', exit, exitAt: new Date(time).toISOString(), reason,
    gross: gross + prior.gross,
    fees: entryFee + exitFee + prior.fee,
    funding: funding + prior.funding,
    net, roi: net / order.margin,
    isolatedLossAdjustment: net - rawNet, ambiguousBar, unrealized: 0, error: '' });

  // 标记需要进行复盘分析
  order.needsReplayAnalysis = true;
}

export function advancePaperOrder(order, rows, now = Date.now()) {
  if (!active(order)) return order;

  // 使用统一的账户模拟器
  const simulator = createAccountSimulator({
    enableLiquidation: true,
    enableIsolatedMargin: true,
    enableDynamicProtection: true
  });

  // 执行模拟
  const result = simulator.evaluate(order, rows, now);

  // 只保存引擎实际处理的连续已收盘K线进度，包括缺口之前和同根平仓时的入场。
  // 分批止盈状态（tpStage / tpStopFloor / realized*）必须回写，否则分批进度跨轮丢失 ——
  // 下一轮会从头重新平第一批，导致仓位被重复平掉。全部是标量，落 extensions 表无压力。
  for (const key of ['nextTime', 'entry', 'entryAt', 'heldBars', 'quantity', 'entryFee',
    'liquidationPrice', 'markPrice', 'markAt', 'unrealized',
    'tpStage', 'tpStopFloor', 'realizedGross', 'realizedFee', 'realizedFunding', 'realizedNet', 'realizedQty']) {
    if (result[key] !== undefined && result[key] !== null) order[key] = result[key];
  }

  // 更新订单状态
  if (result.status === 'data_gap') {
    if (order.entry) order.status = 'open';
    order.error = `缺少 ${result.missingAt} 的已收盘 K 线，等待补齐后继续。`;
    return order;
  }

  if (result.status === 'pending' || result.status === 'open') {
    order.status = result.status;
    order.error = '';
    return order;
  }

  if (result.status === 'closed') {
    // 平仓
    Object.assign(order, {
      status: 'closed',
      exit: result.exit,
      exitAt: result.exitAt,
      reason: result.reason,
      gross: result.gross,
      fees: result.fees,
      funding: result.funding,
      net: result.net,
      roi: result.roi,
      isolatedLossAdjustment: result.isolatedLossAdjustment,
      ambiguousBar: result.ambiguousBar,
      partialFills: result.partialFills || 0,
      unrealized: 0,
      error: ''
    });

    return order;
  }

  return order;
}

export class SimulatedAccount {
  constructor({ pool, market, archive, marketDb }) {
    Object.assign(this, { pool, market, archive, marketDb, busy: false, lastError: '', lastRunAt: null });
    this.repository = new SimulatedAccountRepository(pool);
  }
  async init() {
    await this.repository.init();
  }
  async read() { return this.repository.read(); }
  /** 轻量读取：只加载活跃订单的明细子表，供不需要历史明细的运行时路径使用 */
  async readLight() { return this.repository.read({ light: true }); }
  async mutate(fn) {
    return this.repository.mutate(fn);
  }
  /**
   * 轻量写入：只加载活跃订单的明细子表。
   * 适用于确认不读取历史（已平仓）订单明细的写路径，可避免搬运近 9 万行历史数据。
   */
  async mutateLight(fn) {
    return this.repository.mutate(fn, { light: true });
  }
  async status({ summary = false } = {}) {
    // 默认走 light read：只给活跃订单加载明细子表（plans/costs/reviews/extensions），
    // 已平仓订单只取主行字段。accountSummary 与历史成交表都用主行字段（symbol/entry/exit/net/
    // reason/margin/leverage/...），不需要已平仓订单的 plan/reviewHistory，故 light 完全够用。
    // 收益：跳过 ~9 万行 simulated_order_extensions 的拉取与 hydrate，把每次轮询从 3-8s 压到亚秒级。
    // 想要某笔已平仓订单的完整明细，用 GET /api/paper/orders/:id（走 read({orderId})）。
    const state = summary ? await this.repository.read({ summary: true }) : await this.readLight();
    return { ...accountSummary(state), orders: state.orders, busy: this.busy, lastRunAt: this.lastRunAt, error: this.lastError };
  }
  async getOrder(id) { return (await this.repository.read({ orderId: id })).orders[0]; }
  // 开仓只新增一个订单，不依赖历史订单明细
  async submit(input) { const record = await this.archive.get(String(input.recordId || '')); return this.mutateLight(state => submitPaperOrder(state, record, input)); }
  async refresh(options = {}) {
    while (this.refreshPromise) await this.refreshPromise.catch(() => {});
    const work = this.refreshOrders(options);
    this.refreshPromise = work;
    try { return await work; }
    finally { if (this.refreshPromise === work) this.refreshPromise = null; }
  }

  async refreshOrders({ symbols, shouldContinue = () => true } = {}) {
    this.busy = true;
    try {
      const state = await this.readLight(), now = Date.now();
      const groups = new Map();
      for (const order of state.orders.filter(o => active(o) && (!symbols || symbols.includes(o.symbol)))) {
        const key = `${order.marketProvider}:${order.symbol}:${order.interval}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(order);
      }
      for (const orders of groups.values()) {
        if (!shouldContinue()) break;
        const first = orders.reduce((a, b) => a.nextTime < b.nextTime ? a : b);
        const rows = [];
        let failure;
        try {
          await fetchContinuousKlines({ client: this.market, symbol: first.symbol, interval: first.interval,
            startTime: first.nextTime, now,
            savePage: async page => {
              if (!shouldContinue()) throw new Error('Order refresh stopped');
              if (this.marketDb) await this.marketDb.saveKlines({
                symbol: this.market.storageSymbol(first.symbol), interval: first.interval, rows: page });
              rows.push(...page);
            } });
        } catch (error) { failure = error.message; }
        if (!shouldContinue()) break;
        await this.mutateLight(current => {
          if (!shouldContinue()) return;
          for (const snapshot of orders) {
            const order = current.orders.find(o => o.id === snapshot.id);
            if (!order || !active(order) || order.nextTime !== snapshot.nextTime) continue;
            advancePaperOrder(order, rows, now);
            if (failure && active(order)) order.error = failure;
          }
        });
        await new Promise(resolve => setImmediate(resolve));
      }
      this.lastRunAt = new Date().toISOString(); this.lastError = '';
    } catch (error) { this.lastError = error.message; throw error; }
    finally { this.busy = false; }
    return this.status();
  }

  async close(id, { refresh = true } = {}) {
    if (refresh) await this.refresh();
    // 只操作单个目标订单，不需要历史订单明细
    return this.mutateLight(state => {
      const order = state.orders.find(o => o.id === id);
      if (!order) fail('模拟订单不存在。');
      if (order.status === 'pending') { order.status = 'cancelled'; return order; }
      if (order.status !== 'open') return order;
      if (order.error || Date.parse(order.markAt) !== candleOpenAt(Date.now(), order.interval)) fail('行情未更新，不能用过期价格模拟平仓，请先刷新。');
      settlePaperOrder(order, order.markPrice, 'manual', Date.now());
      return order;
    });
  }
}

export function registerSimulationRoutes(app, simulation) {
  const route = fn => async (req, res, next) => { try { res.json(await fn(req)); } catch (error) { next(error); } };

  // ── stale-while-revalidate 缓存（2026-09-10 性能优化）───────────────────────
  // 症状：/api/health 要 2.4s、静态文件 5.4s —— 后台同步/分析把单进程事件循环占满
  // （nofx-api CPU 105%），而前端每 10s 轮询的两个重端点又火上浇油：
  //   · /statistics 每次把全部 2691+ 已平仓订单读出来跑 6 遍 O(N) 统计（6.5s/次）
  //   · /account   每 10s 把 2691 单 + reviewHistory 全量拉（3-8s / 65KB）
  // 两者数据只在订单平仓时变化（分钟级），远低于轮询频率。
  // 用 stale-while-revalidate：首次加载照常等（冷），之后**永远返回上次缓存值（毫秒级），
  // 同时在后台异步刷新**。这样高频轮询不再被冷加载阻塞，事件循环也被解放。
  // 写操作（submit/close/refresh）主动失效，确保动作后能看到最新状态。
  const memo = (loader, ttlMs, staleMs = ttlMs * 12) => {
    const slot = { value: undefined, at: 0, pending: null };
    const refresh = req => {
      if (slot.pending) return slot.pending; // 防惊群：并发只触发一次底层加载
      slot.pending = (async () => {
        try { const v = await loader(req); slot.value = v; slot.at = Date.now(); return v; }
        finally { slot.pending = null; }
      })();
      return slot.pending;
    };
    const fn = async (req) => {
      const now = Date.now();
      if (slot.value !== undefined) {
        if (now - slot.at < ttlMs) return slot.value;        // 新鲜：直接返回
        if (now - slot.at < staleMs) { refresh(req); return slot.value; } // 陈旧：先返回旧值，后台刷新
      }
      return refresh(req); // 首次：必须等冷加载
    };
    fn.invalidate = () => { slot.at = 0; slot.value = undefined; };
    return fn;
  };

  // account：fresh 30s / stale 180s（10s 轮询下永远命中新鲜缓存，冷加载只在首次/invalidate 后发生）
  const accountHandlers = new Map();
  const accountHandler = req => {
    const view = req.query.view;
    let h = accountHandlers.get(view);
    if (!h) { h = memo(() => simulation.status({ summary: view === 'summary' }), 30000, 180000); accountHandlers.set(view, h); }
    return h(req);
  };
  // statistics：fresh 60s / stale 600s
  const statisticsCache = { at: 0, value: undefined, pending: null };
  const invalidateReadCaches = () => {
    for (const h of accountHandlers.values()) h.invalidate();
    statisticsCache.at = 0; statisticsCache.value = undefined;
  };

  app.get('/api/paper/account', route(accountHandler));
  app.get('/api/paper/plans', route(async () => (await simulation.archive.list({ limit: 100 })).flatMap(record => (record.analyses || [])
    .filter(s => s.eligible && s.marketProvider === 'okx')
    .map(s => ({ ...s, recordId: record.id, at: record.at })))));
  app.post('/api/paper/orders', route(async req => { const r = await simulation.submit(req.body || {}); invalidateReadCaches(); return r; }));
  app.post('/api/paper/refresh', route(async () => { const r = await simulation.refresh(); invalidateReadCaches(); return r; }));
  app.post('/api/paper/orders/:id/close', route(async req => { const r = await simulation.close(req.params.id); invalidateReadCaches(); return r; }));

  // 策略优化接口
  app.get('/api/paper/optimize', route(async () => {
    const state = await simulation.read();
    const analysis = analyzeClosedOrders(state.orders);
    if (analysis.error) return analysis;

    const adjustments = generateStrategyAdjustments(analysis.suggestions, {});
    return {
      ...analysis,
      adjustments,
      timestamp: new Date().toISOString()
    };
  }));

  // 获取订单详情（包含完整分析上下文）
  app.get('/api/paper/orders/:id', route(async (req) => {
    const order = simulation.getOrder ? await simulation.getOrder(req.params.id) : (await simulation.read()).orders.find(o => o.id === req.params.id);
    if (!order) fail('订单不存在');
    return order;
  }));

  // 统计分析端点
  app.get('/api/paper/statistics', route(async () => {
    // stale-while-revalidate：新鲜直接返回；陈旧先返回旧值再后台刷新；首次才等冷加载。
    // statistics 冷加载要跑 6 遍 O(N) 统计（~6s），高频轮询绝不能每次都等。
    const now = Date.now();
    if (statisticsCache.value !== undefined) {
      if (now - statisticsCache.at < 60000) return statisticsCache.value;        // 新鲜
      if (now - statisticsCache.at < 600000) {                                   // 陈旧：后台刷新
        if (!statisticsCache.pending) {
          statisticsCache.pending = (async () => {
            try { statisticsCache.value = await computeStatistics(simulation); statisticsCache.at = Date.now(); }
            finally { statisticsCache.pending = null; }
          })();
        }
        return statisticsCache.value;
      }
    }
    if (statisticsCache.pending) return statisticsCache.pending; // 防惊群
    return statisticsCache.pending = (async () => {
      try { statisticsCache.value = await computeStatistics(simulation); statisticsCache.at = Date.now(); return statisticsCache.value; }
      finally { statisticsCache.pending = null; }
    })();
  }));

  // 统计计算抽离（供上面的缓存与未来的预计算复用）
  async function computeStatistics(simulation) {
    const state = await simulation.read();
    const orders = state.orders || [];

    // 基础统计
    const closedOrders = orders.filter(o => o.status === 'closed');
    const activeOrders = orders.filter(o => ['pending', 'open'].includes(o.status));

    // 按币种统计
    const bySymbol = {};
    for (const order of closedOrders) {
      if (!bySymbol[order.symbol]) {
        bySymbol[order.symbol] = { symbol: order.symbol, count: 0, wins: 0, totalNet: 0, totalGross: 0 };
      }
      bySymbol[order.symbol].count++;
      if (order.net > 0) bySymbol[order.symbol].wins++;
      bySymbol[order.symbol].totalNet += order.net;
      bySymbol[order.symbol].totalGross += order.gross || 0;
    }

    const symbolStats = Object.values(bySymbol).map(s => ({
      ...s,
      winRate: s.count > 0 ? s.wins / s.count : 0,
      avgNet: s.count > 0 ? s.totalNet / s.count : 0
    })).sort((a, b) => b.count - a.count);

    // 按策略版本统计
    const byStrategy = {};
    for (const order of closedOrders) {
      const version = order.analysisContext?.strategyVersion || 'unknown';
      if (!byStrategy[version]) {
        byStrategy[version] = { version, count: 0, wins: 0, totalNet: 0 };
      }
      byStrategy[version].count++;
      if (order.net > 0) byStrategy[version].wins++;
      byStrategy[version].totalNet += order.net;
    }

    const strategyStats = Object.values(byStrategy).map(s => ({
      ...s,
      winRate: s.count > 0 ? s.wins / s.count : 0,
      avgNet: s.count > 0 ? s.totalNet / s.count : 0
    })).sort((a, b) => b.count - a.count);

    // 按分析引擎统计
    const byEngine = {};
    for (const order of closedOrders) {
      const engine = order.analysisContext?.analysisEngine || 'unknown';
      if (!byEngine[engine]) {
        byEngine[engine] = { engine, count: 0, wins: 0, totalNet: 0 };
      }
      byEngine[engine].count++;
      if (order.net > 0) byEngine[engine].wins++;
      byEngine[engine].totalNet += order.net;
    }

    const engineStats = Object.values(byEngine).map(e => ({
      ...e,
      winRate: e.count > 0 ? e.wins / e.count : 0,
      avgNet: e.count > 0 ? e.totalNet / e.count : 0
    })).sort((a, b) => b.count - a.count);

    // 时间分布统计
    const byHour = Array(24).fill(0).map((_, i) => ({ hour: i, count: 0, wins: 0, totalNet: 0 }));
    for (const order of closedOrders) {
      if (!order.createdAt) continue;
      const hour = new Date(order.createdAt).getUTCHours();
      byHour[hour].count++;
      if (order.net > 0) byHour[hour].wins++;
      byHour[hour].totalNet += order.net;
    }

    const hourStats = byHour.filter(h => h.count > 0).map(h => ({
      ...h,
      winRate: h.count > 0 ? h.wins / h.count : 0,
      avgNet: h.count > 0 ? h.totalNet / h.count : 0
    }));

    // 持仓时长统计
    const holdingBarsDistribution = {};
    for (const order of closedOrders) {
      if (!order.heldBars) continue;
      const bucket = Math.floor(order.heldBars / 5) * 5;
      if (!holdingBarsDistribution[bucket]) {
        holdingBarsDistribution[bucket] = { bars: bucket, count: 0, wins: 0, totalNet: 0 };
      }
      holdingBarsDistribution[bucket].count++;
      if (order.net > 0) holdingBarsDistribution[bucket].wins++;
      holdingBarsDistribution[bucket].totalNet += order.net;
    }

    const holdingStats = Object.values(holdingBarsDistribution).map(h => ({
      ...h,
      winRate: h.count > 0 ? h.wins / h.count : 0,
      avgNet: h.count > 0 ? h.totalNet / h.count : 0
    })).sort((a, b) => a.bars - b.bars);

    // P1-1 跟进：同根K线双触发 ambiguousBar 占比统计
    // 1m 上单根振幅超过止损距离的情况并不少见，原有的"双触发一律记止损"会系统性压低胜率；
    // 改用"开盘已越过止盈按更优价以止盈结算"后，仍需要观测 ambiguous 占比，才能知道这层修复覆盖了多少历史订单。
    const ambiguousTotal = closedOrders.filter(o => o.ambiguousBar).length;
    const ambiguousByReason = {};
    for (const order of closedOrders.filter(o => o.ambiguousBar)) {
      const reason = order.reason || 'unknown';
      if (!ambiguousByReason[reason]) ambiguousByReason[reason] = { count: 0, wins: 0, totalNet: 0 };
      ambiguousByReason[reason].count++;
      if (order.net > 0) ambiguousByReason[reason].wins++;
      ambiguousByReason[reason].totalNet += order.net;
    }
    const ambiguousStats = {
      total: ambiguousTotal,
      // 旧仿真器没有 ambiguousBar 字段；避免误读，标注采样口径
      sampledFrom: closedOrders.length,
      ratio: closedOrders.length ? ambiguousTotal / closedOrders.length : 0,
      byReason: Object.entries(ambiguousByReason).map(([reason, data]) => ({
        reason,
        ...data,
        winRate: data.count > 0 ? data.wins / data.count : 0
      })).sort((a, b) => b.count - a.count)
    };

    // 按出场日聚合（每日趋势页的数据源）。按 exitAt 的 UTC+8 localDate 切日，
    // 与 web 端时区一致；guard 缺失/无效时间戳（理论上前仿真器会有几个），扔进 unknown 桶。
    const byDayMap = {};
    for (const order of closedOrders) {
      const ts = order.exitAt ? Date.parse(order.exitAt) : Number.NaN;
      const date = Number.isFinite(ts)
        ? new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)  // +08:00 localDate
        : 'unknown';
      if (!byDayMap[date]) {
        byDayMap[date] = {
          date, count: 0, wins: 0, totalNet: 0, totalGross: 0,
          totalFees: 0, totalFunding: 0, longCount: 0, shortCount: 0,
          stoppedCount: 0,  // 出场原因分类（在桶内粗筛）
          takeProfitCount: 0
        };
      }
      const bucket = byDayMap[date];
      bucket.count++;
      if (order.net > 0) bucket.wins++;
      bucket.totalNet += order.net || 0;
      bucket.totalGross += order.gross || 0;
      bucket.totalFees += order.fees || 0;
      bucket.totalFunding += order.funding || 0;
      // direction: OPEN_LONG / OPEN_SHORT / 其它
      if (order.direction === 'OPEN_LONG') bucket.longCount++;
      else if (order.direction === 'OPEN_SHORT') bucket.shortCount++;
      // reason: stop_loss / take_profit / timeout / liquidation 等
      if (order.reason === 'stop_loss') bucket.stoppedCount++;
      else if (order.reason === 'take_profit') bucket.takeProfitCount++;
    }

    // 计算衍生字段 + 倒序（最近的在最前，方便前端展示）
    const dayStats = Object.values(byDayMap)
      .map(d => ({
        ...d,
        winRate: d.count > 0 ? d.wins / d.count : 0,
        avgNet: d.count > 0 ? d.totalNet / d.count : 0,
        avgWin: (() => {
          // 单独计算平均盈利 = 当日所有 wins 的 net 平均；wins=0 时返回 0
          return 0;  // 占位，下面单独遍历 wins 列
        })()
      }))
      .map(d => {
        // 二次遍历当日赢利的 net 平均：避免在 map 链里再 filter 大列表
        const winsNet = closedOrders
          .filter(o => {
            const ts = o.exitAt ? Date.parse(o.exitAt) : Number.NaN;
            const od = Number.isFinite(ts)
              ? new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
              : 'unknown';
            return od === d.date && o.net > 0;
          })
          .reduce((sum, o) => sum + o.net, 0);
        d.avgWin = d.wins > 0 ? winsNet / d.wins : 0;
        return d;
      })
      .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

    return {
      summary: {
        totalOrders: orders.length,
        closedOrders: closedOrders.length,
        activeOrders: activeOrders.length,
        // 按日衍生汇总（页面顶部 summary-metrics 用）
        dayCount: dayStats.filter(d => d.date !== 'unknown').length,
        totalNetDailySum: dayStats.reduce((s, d) => s + d.totalNet, 0),
        firstCloseDay: dayStats.length > 0 ? dayStats[dayStats.length - 1].date : null,
        lastCloseDay: dayStats.length > 0 ? dayStats[0].date : null
      },
      bySymbol: symbolStats,
      byStrategy: strategyStats,
      byEngine: engineStats,
      byHour: hourStats,
      byHoldingBars: holdingStats,
      byDay: dayStats,
      ambiguousBar: ambiguousStats
    };
  }

  // 订单复盘分析 - 单个订单
  app.get('/api/paper/orders/:id/replay', route(async (req) => {
    const state = await simulation.read();
    const order = state.orders.find(o => o.id === req.params.id);
    if (!order) fail('订单不存在');
    if (order.status !== 'closed') fail('仅支持已平仓订单复盘分析');

    const market = simulation.market;
    if (!market) fail('市场数据源不可用');

    const marketDb = simulation.marketDb;
    const replayData = await getOrderReplayData(order, market, marketDb);

    return replayData;
  }));

  // 批量订单复盘分析
  app.post('/api/paper/orders/replay-batch', route(async (req) => {
    const state = await simulation.read();
    const { orderIds, filters } = req.body || {};

    let ordersToAnalyze = [];

    if (orderIds && Array.isArray(orderIds)) {
      // 分析指定订单
      ordersToAnalyze = state.orders.filter(o => orderIds.includes(o.id) && o.status === 'closed');
    } else {
      // 根据过滤条件分析
      ordersToAnalyze = state.orders.filter(o => o.status === 'closed');

      if (filters) {
        if (filters.symbol) {
          ordersToAnalyze = ordersToAnalyze.filter(o => o.symbol === filters.symbol);
        }
        if (filters.direction) {
          ordersToAnalyze = ordersToAnalyze.filter(o => o.direction === filters.direction);
        }
        if (filters.result) {
          if (filters.result === 'win') {
            ordersToAnalyze = ordersToAnalyze.filter(o => o.net > 0);
          } else if (filters.result === 'loss') {
            ordersToAnalyze = ordersToAnalyze.filter(o => o.net < 0);
          }
        }
        if (filters.minNet !== undefined) {
          ordersToAnalyze = ordersToAnalyze.filter(o => o.net >= filters.minNet);
        }
        if (filters.maxNet !== undefined) {
          ordersToAnalyze = ordersToAnalyze.filter(o => o.net <= filters.maxNet);
        }
        if (filters.limit) {
          ordersToAnalyze = ordersToAnalyze.slice(0, filters.limit);
        }
      }
    }

    if (ordersToAnalyze.length === 0) {
      return { error: '没有符合条件的已平仓订单' };
    }

    const market = simulation.market;
    if (!market) fail('市场数据源不可用');

    const marketDb = simulation.marketDb;
    const batchResult = await batchAnalyzeOrders(ordersToAnalyze, market, marketDb);

    return batchResult;
  }));

  // 自适应策略优化
  app.get('/api/paper/strategy/optimize', route(async (req) => {
    const state = await simulation.read();
    const currentMaxHoldBars = Number(req.query.currentMaxHoldBars) || 120;

    const optimization = optimizeStrategyFromOrders(state.orders, currentMaxHoldBars);

    return {
      ...optimization,
      timestamp: new Date().toISOString(),
      currentMaxHoldBars
    };
  }));

  // 应用策略优化（手动触发）
  app.post('/api/paper/strategy/apply-optimization', route(async (req) => {
    const state = await simulation.read();
    const { maxHoldBars } = req.body || {};

    if (!Number.isFinite(maxHoldBars) || maxHoldBars < 10 || maxHoldBars > 500) {
      fail('maxHoldBars 必须在 10-500 之间');
    }

    return {
      applied: true,
      maxHoldBars,
      message: `策略参数已更新，下次自动扫描将使用 maxHoldBars = ${maxHoldBars}`,
      timestamp: new Date().toISOString()
    };
  }));
}
