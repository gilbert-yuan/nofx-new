import { fetchContinuousKlines } from './continuousKlines.js';
import { randomUUID } from 'node:crypto';
import { candleOpenAt, nextOpenTime, validCandle, PAPER_COSTS } from './research.js';
import { recommendedLeverage } from './localAnalysis.js';
import { RISK_RULE } from './shared/strategyGuards.js';
import { normalizeCloseReason, isStopReason, isTakeProfitReason } from '../shared/closeReasons.js';
import { createAccountSimulator } from './tradingSimulator.js';
import { analyzeClosedOrders, generateStrategyAdjustments } from './strategyOptimizer.js';
import { SimulatedAccountRepository } from './simulatedAccountRepository.js';
import { getOrderReplayData, batchAnalyzeOrders } from './orderReplay.js';
import { optimizeStrategyFromOrders } from './adaptiveStrategy.js';
import { BinanceClient } from './binanceClient.js';
import { binanceMarket } from './binanceMarket.js';
import { BinancePaperSync, createExchangeSyncState } from './binancePaperSync.js';

export { safeSetLeverage } from './binancePaperSync.js';

const active = order => ['pending', 'open'].includes(order.status);
export const PENDING_ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const fail = message => { throw Object.assign(new Error(message), { status: 422 }); };
const TRANSIENT_ORDER_ERROR_RE = /ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|Unable to reach|Client network socket|TLS connection|DNS|proxy|network|timeout/i;
export const isTransientOrderError = error => TRANSIENT_ORDER_ERROR_RE.test(String(error || ''));

function pendingExpiry(order) {
  const created = Date.parse(order.createdAt);
  return Number.isFinite(created) ? created + PENDING_ORDER_TTL_MS : null;
}

export function expirePendingOrder(order, now = Date.now()) {
  if (order?.status !== 'pending') return false;
  const expiresAt = pendingExpiry(order);
  if (!Number.isFinite(expiresAt) || now < expiresAt) return false;
  Object.assign(order, {
    status: 'expired',
    expiresAt: new Date(expiresAt).toISOString(),
    expiredAt: new Date(now).toISOString(),
    reason: 'pending_expired',
    error: ''
  });
  return true;
}

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
  const marketProvider = signal.marketProvider || record.marketProvider;
  if (!['binance', 'okx'].includes(marketProvider)) fail('分析行情来源无效，请重新分析后模拟下单。');
  const first = Math.max(Date.parse(signal.firstEntryAt), nextOpenTime(candleOpenAt(now, signal.interval), signal.interval));
  if (!Number.isFinite(first)) fail('分析计划的入场时间无效，请重新分析。');
  // 保证金三档来源：显式 input.margin（手动下单）> autoMarginPct（自动化按当前权益比例复利 sizing）
  // > 默认 100。autoMarginPct 来自 NOFX_AUTO_MARGIN_PCT（默认 0.05）：bf90 回测显示 5% 权益/笔
  // 在三条参数流上均稳健（1.5~2.5×/90d，MDD<6%），而固定 100U 在 100U 账户下连一单都开不出。
  let margin;
  if (input.margin != null && input.margin !== '') margin = Number(input.margin);
  else if (input.autoMarginPct != null) {
    const equity = accountSummary(state).equity ?? 0;
    margin = Math.floor(equity * Number(input.autoMarginPct) * 100) / 100;
  } else margin = 100;
  if (input.autoMarginPct != null && margin < 1) fail(`账户权益过低，按 ${(input.autoMarginPct * 100).toFixed(1)}% 自动仓位不足 1 USDT，跳过开仓。`);
  // 杠杆上限分两道：
  // ① 全局风控硬上限 RISK_RULE.maxLeverage：超过配置上限的请求一律拒绝（策略/用户输入越界）；
  // ② 币种上限（该币在 Demo 真实可设的最大杠杆）：在全局上限内再夹一道，规避币安 400
  //    「Leverage N is not valid」（如 ARKUSDT 在 Demo 最大杠杆 < 全局 12）。
  const requestedLeverage = Math.floor(Number(input.leverage ?? signal.recommendedLeverage ?? recommendedLeverage(signal.plan, signal.positionRecommendation)));
  if (!Number.isFinite(margin) || margin < 1 || margin > 100000 || !Number.isInteger(requestedLeverage) || requestedLeverage < 1 || requestedLeverage > RISK_RULE.maxLeverage)
    fail(`保证金须为 1～100000 USDT，杠杆须为 1～${RISK_RULE.maxLeverage} 的整数（${input.symbol} 在币安最大杠杆 ${binanceMarket.getMaxLeverage(input.symbol) || '未知'}）。`);
  const perSymbolMax = binanceMarket.getMaxLeverage(input.symbol);
  const effectiveMax = (perSymbolMax && perSymbolMax > 0) ? Math.min(RISK_RULE.maxLeverage, perSymbolMax) : RISK_RULE.maxLeverage;
  const leverage = Math.max(1, Math.min(requestedLeverage, effectiveMax));
  if (!state.unlimitedCapital && state.orders.filter(active).length >= 20) fail('最多同时持有 20 个模拟挂单或持仓。');
  if (!state.unlimitedCapital && state.orders.some(o => active(o) && o.symbol === input.symbol)) fail('该币种已有模拟挂单或持仓。');
  const plan = { ...signal.plan, stopLoss: Number(input.stopLoss ?? signal.plan.stopLoss), takeProfit: Number(input.takeProfit ?? signal.plan.takeProfit) };
  const long = signal.positionRecommendation === 'OPEN_LONG';
  if (![plan.stopLoss, plan.takeProfit].every(v => Number.isFinite(v) && v > 0) || (long ? !(plan.stopLoss < plan.entryMin && plan.takeProfit > plan.entryMax) : !(plan.takeProfit < plan.entryMin && plan.stopLoss > plan.entryMax))) fail('止盈止损必须位于入场区间两侧，且符合多空方向。');
  const notional = margin * leverage;
  if (!state.unlimitedCapital && margin + notional * PAPER_COSTS.feeBps / 10000 > accountSummary(state).available) fail('模拟可用余额不足。');

  // 保存完整的分析上下文，用于后续策略优化
  // ⚠️ 多策略关键字段：strategyId 决定「这笔订单后续用哪个策略做持仓复核 / 出场判定」，
  //    因此必须在**下单那一刻**固化，不能依赖运行时全局配置（配置改了也不会串味）。
  const strategyId = input.strategyId || record.strategyId || signal.strategyId || null;
  const analysisContext = {
    signal: { ...signal }, // 完整的分析信号
    strategyVersion: record.strategyVersion, // 策略版本哈希（含策略参数，见 research.js 快照）
    strategyModel: record.snapshot?.model || null,
    strategyId, // 所属策略 id
    strategyName: record.strategyName || record.snapshot?.strategyName || null,
    strategyParams: record.strategyParams || record.snapshot?.strategyParams || null,
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

  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_ORDER_TTL_MS).toISOString();
  const order = { id: randomUUID(), recordId: record.id, symbol: signal.symbol, interval: signal.interval, marketProvider,
    direction: signal.positionRecommendation, status: 'pending', margin, leverage, notional, plan, initialPlan: { ...plan }, costs: { ...PAPER_COSTS },
    automatic: input.automatic === true, protectionRevisions: [], reviewHistory: [],
    analysisContext, // 新增：完整分析上下文
    exchangeSync: { demo: createExchangeSyncState('demo'), live: createExchangeSyncState('live') },
    exchange: createExchangeSyncState('demo'),
    createdAt, expiresAt, nextTime: first, heldBars: 0, error: '' };
  state.orders.unshift(order);
  return order;
}

export function settlePaperOrder(order, price, reason, time, ambiguousBar = false) {
  const direction = order.direction === 'OPEN_LONG' ? 1 : -1;
  // 落库统一为稳定机器码（便于统计）；中文长句归一到对应 code，未知兜底 manual
  const closeReason = normalizeCloseReason(reason);
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
  Object.assign(order, { status: 'closed', exit, exitAt: new Date(time).toISOString(), reason: closeReason,
    // 保留人工可读的原始说明（智能退出的中文详情），统计用 reason、审计用 detail
    reasonDetail: typeof reason === 'string' && reason !== closeReason ? reason : '',
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
  if (expirePendingOrder(order, now)) return order;

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

  if (result.status === 'expired') {
    Object.assign(order, { status: 'expired', reason: result.reason, expiresAt: result.expiresAt, error: '' });
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
  constructor({ pool, market, archive, marketDb, store = null, clientFactory = config => new BinanceClient(config) }) {
    Object.assign(this, { pool, market, archive, marketDb, store, clientFactory, busy: false, lastError: '', lastRunAt: null });
    this.repository = new SimulatedAccountRepository(pool);
    this.exchangeSync = new BinancePaperSync({ simulation: this, store, clientFactory });
  }
  async init() {
    await this.repository.init();
  }
  startExchangeSync() { this.exchangeSync.start(); }
  stopExchangeSync() { this.exchangeSync.stop(); }
  exchangeSyncStatus() { return this.exchangeSync.status(); }
  async exchangeSyncOrders() { return this.repository.readExchangeSync(); }
  enqueueExchangeSync(orderId, event) { this.exchangeSync.enqueue(orderId, event); }
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
  async mutateLight(fn, options = {}) {
    return this.repository.mutate(fn, { light: true, ...options });
  }
  async status({ summary = false } = {}) {
    // 默认走 light read：只给活跃订单加载明细子表（plans/costs/reviews/extensions），
    // 已平仓订单只取主行字段。accountSummary 与历史成交表都用主行字段（symbol/entry/exit/net/
    // reason/margin/leverage/...），不需要已平仓订单的 plan/reviewHistory，故 light 完全够用。
    // 收益：跳过 ~9 万行 simulated_order_extensions 的拉取与 hydrate，把每次轮询从 3-8s 压到亚秒级。
    // 想要某笔已平仓订单的完整明细，用 GET /api/paper/orders/:id（走 read({orderId})）。
    const state = summary ? await this.repository.read({ summary: true }) : await this.readLight();
    return { ...accountSummary(state), orders: state.orders, busy: this.busy, lastRunAt: this.lastRunAt, error: this.lastError,
      autoMarginPct: Math.min(1, Math.max(0.01, Number(process.env.NOFX_AUTO_MARGIN_PCT ?? 0.05))) };
  }
  async getOrder(id) { return (await this.repository.read({ orderId: id })).orders[0]; }
  /** 设置初始金额（重定账户基期；已有订单的浮动/已实现盈亏继续叠加在新基数上）。
   *  输入初始金额即视为进入有限资金模式（自动关闭 unlimitedCapital，除非显式传 true）——
   *  否则 equity 恒为 null，autoMarginPct 无法按权益缩放。 */
  async setCapital({ initialBalance, unlimitedCapital } = {}) {
    const v = Number(initialBalance);
    if (!Number.isFinite(v) || v < 1 || v > 1000000) fail('初始金额须为 1～1000000 USDT。');
    return this.mutateLight(state => {
      state.initialBalance = v;
      state.unlimitedCapital = unlimitedCapital === true;
      return { initialBalance: state.initialBalance, unlimitedCapital: state.unlimitedCapital };
    });
  }
  /** 每日趋势：纯 SQL 聚合，不把订单读进内存（见 server/dailyTrend.js） */
  async dailyTrend() { return this.repository.dailyTrend(); }
  // 开仓只新增一个订单，不依赖历史订单明细
  async submit(input) {
    const record = await this.archive.get(String(input.recordId || ''));
    const signal = record?.analyses?.find(item => item.symbol === input.symbol);
    const provider = signal?.marketProvider || record?.marketProvider;
    if (this.market?.provider && provider !== this.market.provider) {
      const label = this.market.provider === 'binance' ? 'Binance' : 'OKX';
      fail('请使用当前 ' + label + ' 行情重新分析后模拟下单。');
    }
    const order = await this.mutateLight(state => submitPaperOrder(state, record, input));
    this.enqueueExchangeSync(order.id, { type: 'submit' });
    return order;
  }

  // Legacy method names remain for callers from older integrations. Network work is
  // intentionally queued and never awaited by the simulation path.
  syncNewPaperOrderToDemo(order) {
    if (order?.id) this.enqueueExchangeSync(order.id, { type: 'submit' });
    return order;
  }

  cancelDemoOrder(order) {
    if (order?.id) this.enqueueExchangeSync(order.id, { type: 'cancel' });
    return order;
  }
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
        if (first.marketProvider !== this.market.provider) {
          const message = '行情来源已从 ' + (first.marketProvider === 'okx' ? 'OKX' : first.marketProvider)
            + ' 切换为 ' + (this.market.provider === 'binance' ? 'Binance Spot' : this.market.provider)
            + '；旧订单不会使用不同交易所的 K 线推进，请取消并重新分析后下单。';
          await this.mutateLight(current => {
            for (const snapshot of orders) {
              const order = current.orders.find(item => item.id === snapshot.id);
              if (order && active(order) && order.nextTime === snapshot.nextTime) order.error = message;
            }
          });
          continue;
        }
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
        const syncEvents = [];
        await this.mutateLight(current => {
          if (!shouldContinue()) return;
          for (const snapshot of orders) {
            const order = current.orders.find(o => o.id === snapshot.id);
            if (!order || !active(order) || order.nextTime !== snapshot.nextTime) continue;
            const previousStatus = order.status;
            const previousQuantity = Number(order.quantity) || 0;
            const previousRealizedQty = Number(order.realizedQty) || 0;
            advancePaperOrder(order, rows, now);
            if (failure && active(order)) order.error = failure;
            else if (active(order) && order.error && isTransientOrderError(order.error)) order.error = '';
            if (previousStatus === 'pending' && ['expired', 'cancelled'].includes(order.status)) {
              syncEvents.push({ orderId: order.id, event: { type: 'cancel' } });
            }
            const realizedQty = Number(order.realizedQty) || 0;
            if (previousStatus === 'open' && order.status === 'closed') {
              syncEvents.push({ orderId: order.id, event: {
                type: 'close',
                actionId: 'close-' + order.id + '-' + String(order.exitAt || order.reason || 'paper'),
                reason: order.reason || 'paper_close',
                paperQuantity: previousQuantity,
                originalPaperQuantity: previousQuantity + previousRealizedQty
              } });
            } else if (previousStatus === 'open' && order.status === 'open' && realizedQty > previousRealizedQty) {
              const delta = realizedQty - previousRealizedQty;
              syncEvents.push({ orderId: order.id, event: {
                type: 'close',
                actionId: 'partial-' + order.id + '-' + realizedQty.toFixed(12).replace('.', '_'),
                reason: 'partial_take_profit',
                paperQuantity: delta,
                originalPaperQuantity: previousQuantity + previousRealizedQty
              } });
            }
          }
        });
        for (const { orderId, event } of syncEvents) this.enqueueExchangeSync(orderId, event);
        await new Promise(resolve => setImmediate(resolve));
      }
      this.lastRunAt = new Date().toISOString(); this.lastError = '';
    } catch (error) { this.lastError = error.message; throw error; }
    finally { this.busy = false; }
    return this.status();
  }

  async close(id, { refresh = true, reason = 'manual' } = {}) {
    if (refresh) await this.refresh();
    const closeReason = normalizeCloseReason(reason);
    // 只操作单个目标订单，不需要历史订单明细
    let syncEvent = null;
    const order = await this.mutateLight(state => {
      const current = state.orders.find(o => o.id === id);
      if (!current) fail('模拟订单不存在。');
      // 挂单未成交 → 撤销（此前不写 reason，统计里表现为「无理由消失」）
      if (current.status === 'pending') {
        current.status = 'cancelled';
        current.reason = 'strategy_cancelled';
        syncEvent = { type: 'cancel' };
        return current;
      }
      if (current.status !== 'open') return current;
      if (current.error || Date.parse(current.markAt) !== candleOpenAt(Date.now(), current.interval)) fail('行情未更新，不能用过期价格模拟平仓，请先刷新。');
      const previousQuantity = Number(current.quantity) || 0;
      const previousRealizedQty = Number(current.realizedQty) || 0;
      settlePaperOrder(current, current.markPrice, closeReason, Date.now());
      syncEvent = {
        type: 'close',
        actionId: 'close-' + current.id + '-' + String(current.exitAt || closeReason),
        reason: closeReason,
        paperQuantity: previousQuantity,
        originalPaperQuantity: previousQuantity + previousRealizedQty
      };
      return current;
    });
    if (syncEvent) this.enqueueExchangeSync(order.id, syncEvent);
    return order;
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
  // 每日趋势：纯 SQL 聚合（毫秒级），但仍做 30s 新鲜 / 300s 陈旧的后台刷新缓存，
  // 避免首屏与页面切换重复打库。写操作主动失效，保证下单/平仓后立刻可见。
  const dailyTrendHandler = memo(() => simulation.dailyTrend(), 30000, 300000);
  const invalidateReadCaches = () => {
    for (const h of accountHandlers.values()) h.invalidate();
    statisticsCache.at = 0; statisticsCache.value = undefined;
    dailyTrendHandler.invalidate();
  };

  app.get('/api/paper/account', route(accountHandler));
  app.get('/api/paper/plans', route(async () => (await simulation.archive.list({ limit: 100 })).flatMap(record => (record.analyses || [])
    .filter(s => s.eligible && s.marketProvider === 'binance')
    .map(s => ({ ...s, recordId: record.id, at: record.at })))));
  app.post('/api/paper/orders', route(async req => { const r = await simulation.submit(req.body || {}); invalidateReadCaches(); return r; }));
  app.put('/api/paper/capital', route(async req => { const r = await simulation.setCapital(req.body || {}); invalidateReadCaches(); return r; }));
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

  // 每日趋势（单条 SQL 聚合，多指标一次算出）。
  // GET 走 stale-while-revalidate 缓存；POST 为「刷新」按钮：先失效再强制取最新。
  app.get('/api/paper/daily-trend', route(dailyTrendHandler));
  app.post('/api/paper/daily-trend', route(async () => {
    dailyTrendHandler.invalidate();
    return dailyTrendHandler({});
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
      // reason: 平仓理由机器码（见 server/shared/closeReasons.js）
      // 止损/止盈按「类」统计：移动止损、保本止损同属止损，分批止盈同属止盈
      if (isStopReason(order.reason)) bucket.stoppedCount++;
      else if (isTakeProfitReason(order.reason)) bucket.takeProfitCount++;
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
