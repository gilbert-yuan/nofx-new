import { randomUUID } from 'node:crypto';
import { analyzeMarkets, reviewPosition } from './ai.js';
import { localAnalysis, localAnalysisMultiTimeframe } from './localAnalysis.js';
import { candleOpenAt, nextOpenTime, prepareMarket, createResearchRecord } from './research.js';
import { advancePaperOrder, submitPaperOrder } from './simulatedAccount.js';

const periods = { scan: 2 * 3600000, review: 5 * 60000 };
export function automationDefaults(now = Date.now()) {
  return { version: 1, enabled: true, engine: 'local', interval: '1m', margin: 100,
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
  const stopLoss = long ? Math.max(order.plan.stopLoss, price - 1.5 * atr) : Math.min(order.plan.stopLoss, price + 1.5 * atr);
  const takeProfit = long ? Math.max(order.plan.takeProfit, price + 3 * atr) : Math.min(order.plan.takeProfit, price - 3 * atr);
  return { action: 'UPDATE_PROTECTION', stopLoss, takeProfit, confidence: 0.75, reason: '按最新 14 根真实波幅复核；只收紧止损，顺势调整止盈。' };
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
  async fresh(symbol, interval = '1m') {
    const key = this.market.storageSymbol(symbol);
    let rows = await this.marketDb.listKlines({ symbol: key, interval, limit: 80 });
    try { return prepareMarket({ symbol, interval, rows, limit: 80, marketProvider: this.market.provider }); }
    catch {
      rows = await this.market.klines({ symbol, interval, limit: 82 });
      const prepared = prepareMarket({ symbol, interval, rows, limit: 80, marketProvider: this.market.provider });
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
      const strategy = { ...await this.store.getStrategy(), interval: '1m' };
      strategy.rules += '\n本轮为自动模拟任务：使用提供的 1m 已收盘行情，覆盖旧规则中的其他周期要求；开仓等待最多 6 根，持有最多 120 根。持仓复核只考虑保持或调整止盈止损，不扩大止损风险。';
      await this.editJob(kind, j => { j.engine = engine; });
      if (kind === 'scan') await this.scan(job, config, strategy, engine);
      else await this.reviewOrders(job, config, strategy, engine);
      await this.editJob(kind, j => { j.running = false; j.finishedAt = Date.now(); j.leaseUntil = 0; });
    } catch (error) {
      if (job) await this.editJob(kind, j => { j.running = false; j.finishedAt = Date.now(); j.failed++; j.errors = [...(j.errors || []), error.message].slice(-30); }).catch(() => {});
    } finally { this.running.delete(kind); }
  }
  async scan(job, config, strategy, engine) {
    const symbols = job.symbols || (await this.market.perpetualUsdtContracts()).map(s => s.symbol);
    await this.editJob('scan', j => { j.symbols = symbols; j.total = symbols.length; });
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
                // 使用多周期分析
                result = { analyses: [localAnalysisMultiTimeframe(market, auxMarkets)] };
              } catch (error) {
                // 如果获取辅助周期失败，降级到单周期分析
                console.warn(`多周期数据获取失败 ${symbol}:`, error.message);
                result = { analyses: [localAnalysis(market)] };
              }

              if (result.analyses[0].plan) {
                Object.assign(result.analyses[0].plan, { validForBars: 6, maxHoldBars: 120 });
              }
            } else {
              result = await this.analyze({ config, strategy, market: [market] });
            }

            const modelName = engine === 'local' && result.analyses[0].multiTimeframeAnalysis
              ? 'local-mtf-trend-atr-v1'
              : 'local-trend-atr-v1';

            record = createResearchRecord({
              config: engine === 'local' ? { ...config, model: { model: modelName, baseUrl: 'local://rules' } } : config,
              strategy, market: [market], result, type: 'single', scope: { interval: '1m', limit: 80, engine }
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
