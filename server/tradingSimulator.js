/**
 * 统一的交易模拟引擎
 *
 * 整合了策略表现（paperTrading.js）和模拟交易（simulatedAccount.js）的核心逻辑
 * 通过配置参数支持不同的使用场景
 */

import { nextOpenTime, validCandle, PAPER_COSTS } from './research.js';
import { PARTIAL_TP, partialTpLevels, netBreakEvenBps } from './shared/strategyGuards.js';

/**
 * 交易模拟器配置
 */
export class SimulatorConfig {
  constructor(options = {}) {
    // 模式：'backtest' (策略表现) | 'account' (模拟交易)
    this.mode = options.mode || 'backtest';

    // 资金管理
    this.unlimitedCapital = options.unlimitedCapital ?? (this.mode === 'backtest');
    this.initialBalance = options.initialBalance || 10000;

    // 持仓限制
    this.maxPositions = options.maxPositions ?? (this.mode === 'account' ? 20 : Infinity);
    this.allowDuplicateSymbol = options.allowDuplicateSymbol ?? (this.mode === 'backtest');

    // 风险控制
    this.enableLiquidation = options.enableLiquidation ?? (this.mode === 'account');
    this.enableIsolatedMargin = options.enableIsolatedMargin ?? (this.mode === 'account');

    // 动态保护
    this.enableDynamicProtection = options.enableDynamicProtection ?? (this.mode === 'account');

    // 成本参数
    this.costs = options.costs || { ...PAPER_COSTS };
  }
}

/**
 * 统一的交易模拟引擎
 */
export class TradingSimulator {
  constructor(config = {}) {
    this.config = config instanceof SimulatorConfig ? config : new SimulatorConfig(config);
  }

  /**
   * 评估单个信号/订单
   *
   * @param {Object} input - 信号或订单对象
   * @param {Array} rows - K线数据
   * @param {number} now - 当前时间戳
   * @returns {Object} 评估结果
   */
  evaluate(input, rows, now = Date.now()) {
    // 统一输入格式
    const order = this._normalizeInput(input);

    // 检查是否可评估
    if (!this._isEligible(order)) {
      return { status: 'excluded' };
    }

    // 执行模拟
    return this._simulate(order, rows, now);
  }

  /**
   * 批量回测（策略表现模式）
   *
   * @param {Array} signals - 信号数组
   * @param {Function} getKlines - 获取K线的函数 (signal) => rows
   * @returns {Object} 汇总统计
   */
  async batchBacktest(signals, getKlines) {
    const results = [];

    for (const signal of signals) {
      try {
        const rows = await getKlines(signal);
        const result = this.evaluate(signal, rows);
        results.push({ signal, evaluation: result });
      } catch (error) {
        results.push({
          signal,
          evaluation: { status: 'error', error: error.message }
        });
      }
    }

    return this._summarize(results);
  }

  /**
   * 核心模拟逻辑
   */
  _simulate(order, rows, now) {
    const byTime = new Map(rows.map(r => [Number(r.openTime), r]));
    const long = order.direction === 'OPEN_LONG' || order.positionRecommendation === 'OPEN_LONG';
    const direction = long ? 1 : -1;
    const plan = order.plan;

    // 状态变量
    let time = order.startTime;
    let entry = order.entry ?? null;
    let entryTime = order.entryTime ?? null;
    let held = order.heldBars || 0;
    let adverse = 0;

    // ── 分批止盈状态（跨轮续跑：从 order 恢复）────────────────────────────
    // 全部用**标量**而不是 fills[] 数组：simulated_order_extensions 按 path 逐字段
    // 展开存行（当前已 9 万行、是已知性能瓶颈），数组会让行数成倍膨胀。
    let tpStage = Number(order.tpStage) || 0;
    const realized = {
      gross: Number(order.realizedGross) || 0,
      fee: Number(order.realizedFee) || 0,
      funding: Number(order.realizedFunding) || 0,
      net: Number(order.realizedNet) || 0,
      qty: Number(order.realizedQty) || 0,
      fills: tpStage
    };
    // 分批档位：入场后才能算（需要 entry 与 R），惰性计算一次
    let tpLevels = null;

    const checkpoint = () => ({
      nextTime: time, entry, entryAt: entryTime !== null ? new Date(entryTime).toISOString() : null,
      heldBars: held, quantity: order.quantity, entryFee: order.entryFee,
      liquidationPrice: order.liquidationPrice, markPrice: order.markPrice,
      markAt: order.markAt, unrealized: order.unrealized,
      tpStage, tpStopFloor: order.tpStopFloor,
      realizedGross: realized.gross, realizedFee: realized.fee,
      realizedFunding: realized.funding, realizedNet: realized.net, realizedQty: realized.qty
    });

    // ── 根级智能退出（Task #8）：把「均线失守」下沉到逐根判定 ──────────────────
    // 此前均线失守只在复核周期（GlobalAutomation 配置 120s、实测约 160s）才检查，
    // 1m 周期下平均要晚 2~3 根才动作，趋势已反转的浮亏单被多扛了几分钟。
    // 现按计划里固化的 smartExit 配置，在每根已收盘 K 线上判定；复核周期仅作兜底。
    // 只看**已收盘** K 线，不使用未来数据，回测/实盘口径一致。
    const smartExit = plan?.smartExit;
    const barLevelMaExit = !!smartExit && smartExit.barLevel !== false && Number.isFinite(smartExit.maBreakAtr);
    let maSeries = null;
    let atrSeries = null;
    if (barLevelMaExit) {
      maSeries = new Map();
      atrSeries = new Map();
      const ordered = rows.slice().sort((a, b) => Number(a.openTime) - Number(b.openTime));
      const seq = ordered.map(r => r.close);
      const maPeriod = Number.isInteger(smartExit.maPeriod) && smartExit.maPeriod > 1 ? smartExit.maPeriod : 20;
      const atrPeriod = 14;
      for (let i = 0; i < ordered.length; i++) {
        const t = Number(ordered[i].openTime);
        if (i + 1 >= maPeriod) {
          let sum = 0;
          for (let k = i + 1 - maPeriod; k <= i; k++) sum += seq[k];
          maSeries.set(t, sum / maPeriod);
        }
        if (i >= atrPeriod) {
          let sum = 0;
          for (let k = i + 1 - atrPeriod; k <= i; k++) {
            const previous = seq[k - 1];
            sum += Math.max(ordered[k].high - ordered[k].low, Math.abs(ordered[k].high - previous), Math.abs(ordered[k].low - previous));
          }
          atrSeries.set(t, sum / atrPeriod);
        }
      }
    }

    // 逐根K线推进
    while (nextOpenTime(time, order.interval) <= now) {
      // 获取当前K线
      const row = byTime.get(time);
      if (!this._validateKline(row, time, order.interval)) {
        return {
          ...checkpoint(),
          status: 'data_gap',
          missingAt: new Date(time).toISOString()
        };
      }

      // 获取当前保护价格（支持动态调整）
      const protection = this._getProtection(order, time);

      // 尝试入场
      if (!entry) {
        const entryResult = this._tryEntry(row, protection, direction, order.costs);
        if (entryResult) {
          entry = entryResult.price;
          entryTime = time;
          order.quantity = order.notional / entry;
          order.entryFee = order.notional * order.costs.feeBps / 10000;

          // 计算爆仓价格
          if (this.config.enableLiquidation && order.leverage > 1) {
            order.liquidationPrice = entry * (1 - direction * (1 / order.leverage - 0.005));
          }
        }
      }

      // 持仓管理
      if (entry) {
        held++;

        // 更新标记价格和未实现盈亏
        order.markPrice = row.close;
        order.markAt = new Date(nextOpenTime(time, order.interval)).toISOString();
        const funding = this._calcFunding(order.notional, order.costs, entryTime, nextOpenTime(time, order.interval));
        order.unrealized = direction * (row.close - entry) * order.quantity - funding;

        // 计算最大不利偏移
        adverse = Math.max(
          adverse,
          long ? (entry - row.low) / entry : (row.high - entry) / entry,
          0
        );

        // 止损的「工作副本」：分批止盈会把止损抬到保本线，这个抬升必须跨根保留
        // （否则下一根又退回初始止损），故持久化在 order.tpStopFloor 上。
        let workingStop = protection.stopLoss;
        const floor = Number(order.tpStopFloor);
        if (Number.isFinite(floor) && floor > 0) {
          workingStop = long ? Math.max(workingStop, floor) : Math.min(workingStop, floor);
        }

        // ── 分批止盈（2026-09-11）：先于「主止盈」、后于「止损」 ──────────────
        // 单根 K 线没有 tick，无法判定命中先后，按最坏情况处理：
        //   · 止损/爆仓 → 交给下面的 _checkExit 立即出场（保护优先），不巧立分批；
        //   · TP1/TP2   → 在价格路径上必然先于主止盈被触及，故先按各档价位分批，
        //                 剩余「奔跑仓」再交给 _checkExit 的主止盈判定。
        if (tpLevels === null) {
          const riskUnit = Number(order.plan?.riskUnit) > 0
            ? Number(order.plan.riskUnit)
            : Math.abs(entry - Number(order.initialPlan?.stopLoss ?? protection.stopLoss));
          tpLevels = partialTpLevels({ long, entry, riskUnit, mainTakeProfit: protection.takeProfit });
        }
        while (tpStage < tpLevels.length) {
          const level = tpLevels[tpStage];
          const hit = long ? row.high >= level.price : row.low <= level.price;
          if (!hit) break;
          const originalQty = realized.qty + order.quantity;
          const batchQty = Math.min(originalQty * level.closePct, order.quantity);
          if (!(batchQty > 0)) break;

          const costs = order.costs;
          const exitPrice = level.price * (1 - direction * costs.slippageBps / 10000);
          const gross = direction * (exitPrice - entry) * batchQty;
          const exitFee = exitPrice * batchQty * costs.feeBps / 10000;
          // 入场费与名义按「该批占原始仓位」的比例分摊；最后一批由 _settle 用剩余
          // 比例结清，各批份额之和恰为 1，合计恰好等于全额入场费（不会重复计或漏计）。
          const share = originalQty > 0 ? batchQty / originalQty : 0;
          const entryFeeShare = (order.entryFee || 0) * share;
          const funding = this._calcFunding(order.notional * share, costs, entryTime, nextOpenTime(time, order.interval));
          const net = gross - entryFeeShare - exitFee - funding;

          realized.gross += gross;
          realized.fee += entryFeeShare + exitFee;
          realized.funding += funding;
          realized.net += net;
          realized.qty += batchQty;
          // 剩余 = 当前剩余 − 本批。
          // 不能写成 originalQty − batchQty：originalQty 是「原始总量」，
          // 第二档那样算会把剩余仓位错误地还原成 60%（应为 20%）。
          order.quantity = Math.max(0, order.quantity - batchQty);
          tpStage++;
          realized.fills = tpStage;

          // 分批成交后，把剩余仓位止损抬到净保本线（含往返成本 + 缓冲），锁成无风险
          if (PARTIAL_TP.moveStopToBreakEven) {
            const costDist = entry * netBreakEvenBps(costs) / 10000;
            const beStop = long ? entry + costDist : entry - costDist;
            const nextFloor = Number.isFinite(order.tpStopFloor) && order.tpStopFloor > 0
              ? (long ? Math.max(order.tpStopFloor, beStop) : Math.min(order.tpStopFloor, beStop))
              : beStop;
            order.tpStopFloor = nextFloor;
            workingStop = long ? Math.max(workingStop, nextFloor) : Math.min(workingStop, nextFloor);
          }
        }

        // 检查出场条件
        const exitResult = this._checkExit(
          row,
          { ...protection, stopLoss: workingStop },
          entry,
          held,
          direction,
          order.liquidationPrice
        );

        if (exitResult) {
          realized.fills = tpStage;
          const settled = this._settle(
            order,
            exitResult,
            entry,
            entryTime,
            nextOpenTime(time, order.interval),
            held,
            direction,
            adverse,
            realized
          );
          time = nextOpenTime(time, order.interval);
          return { ...checkpoint(), ...settled };
        }

        // 根级智能退出（Task #8）：止损/止盈未触发时，逐根检查「均线失守」。
        // 仅对「尚未走出保护空间」的持仓生效（浮盈 < maExitMaxProfitR），
        // 与 enhancedProtectionReview 的口径完全一致；越过保护线后交给移动止损阶梯。
        if (barLevelMaExit) {
          const ma = maSeries.get(time);
          const atrNow = atrSeries.get(time);
          if (Number.isFinite(ma) && Number.isFinite(atrNow) && atrNow > 0) {
            const invalidated = long ? row.close < ma : row.close > ma;
            const deviated = Math.abs(row.close - ma) > atrNow * smartExit.maBreakAtr;
            const riskUnit = Number(order.plan?.riskUnit);
            const profitR = Number.isFinite(riskUnit) && riskUnit > 0
              ? (long ? row.close - entry : entry - row.close) / riskUnit
              : NaN;
            const maxR = Number.isFinite(smartExit.maExitMaxProfitR) ? smartExit.maExitMaxProfitR : 0.4;
            const belowLine = !Number.isFinite(profitR) || profitR < maxR;
            if (invalidated && deviated && belowLine) {
              realized.fills = tpStage;
              const settled = this._settle(
                order,
                { reason: 'smart_exit_ma', price: row.close, ambiguous: false },
                entry,
                entryTime,
                nextOpenTime(time, order.interval),
                held,
                direction,
                adverse,
                realized
              );
              time = nextOpenTime(time, order.interval);
              return { ...checkpoint(), ...settled };
            }
          }
        }
      }

      time = nextOpenTime(time, order.interval);
    }

    // 未完成
    return {
      ...checkpoint(),
      status: entry ? 'open' : 'pending',
    };
  }

  /**
   * 标准化输入格式
   */
  _normalizeInput(input) {
    // 如果是信号（来自策略表现）
    if (input.eligible !== undefined && input.plan) {
      return {
        eligible: input.eligible,
        plan: input.plan,
        direction: input.positionRecommendation,
        positionRecommendation: input.positionRecommendation,
        symbol: input.symbol,
        interval: input.interval,
        startTime: Date.parse(input.firstEntryAt),
        notional: this.config.costs.notional ?? PAPER_COSTS.notional,
        leverage: 1,
        margin: this.config.costs.notional ?? PAPER_COSTS.notional,
        costs: { ...this.config.costs },
        protectionRevisions: []
      };
    }

    // 如果是订单（来自模拟交易）
    return {
      eligible: true,
      plan: input.plan,
      initialPlan: input.initialPlan,
      direction: input.direction,
      symbol: input.symbol,
      interval: input.interval,
      startTime: input.nextTime ?? Date.parse(input.createdAt),
      notional: input.notional,
      leverage: input.leverage,
      margin: input.margin,
      costs: input.costs || { ...PAPER_COSTS },
      protectionRevisions: input.protectionRevisions || [],
      entry: input.entry,
      entryTime: input.entryAt ? Date.parse(input.entryAt) : null,
      heldBars: input.heldBars || 0,
      quantity: input.quantity,
      entryFee: input.entryFee,
      liquidationPrice: input.liquidationPrice ?? (this.config.enableLiquidation && input.entry && input.leverage > 1
        ? input.entry * (1 - (input.direction === 'OPEN_LONG' ? 1 : -1) * (1 / input.leverage - 0.005)) : undefined),
    markPrice: input.markPrice, markAt: input.markAt, unrealized: input.unrealized,
    // ── 分批止盈状态（2026-09-11）：必须透传 ──────────────────────────────
    // 订单每轮复核都会重新走 _normalizeInput，若这里丢掉 tpStage / realized*，
    // _simulate 会以为「还没平过任何一批」，从第一档开始重平，
    // 剩余仓位（已只剩 60%）被当成原始总量再切一次 40% —— 仓位被重复平掉、盈亏少算一半。
    tpStage: input.tpStage, tpStopFloor: input.tpStopFloor,
    realizedGross: input.realizedGross, realizedFee: input.realizedFee,
    realizedFunding: input.realizedFunding, realizedNet: input.realizedNet, realizedQty: input.realizedQty
  };
}

  /**
   * 检查是否可评估
   */
  _isEligible(order) {
    if (order.eligible === false) return false;
    if (!order.plan) return false;
    return true;
  }

  /**
   * 验证K线数据
   */
  _validateKline(row, time, interval) {
    if (!row) return false;
    if (!validCandle(row)) return false;

    // 检查数据刷新时间
    if (row.refreshedAt && Date.parse(row.refreshedAt) < nextOpenTime(time, interval)) {
      return false;
    }

    // 检查是否已收盘
    if (row.confirmed === false) return false;

    return true;
  }

  /**
   * 获取当前保护价格（支持动态调整）
   */
  _getProtection(order, time) {
    if (!this.config.enableDynamicProtection || !order.protectionRevisions?.length) {
      return order.plan;
    }

    // 找到生效的最新复核
    const revision = [...order.protectionRevisions]
      .reverse()
      .find(r => r.effectiveFrom <= time);

    if (!revision) return order.initialPlan || order.plan;

    return {
      ...order.plan,
      stopLoss: revision.stopLoss,
      takeProfit: revision.takeProfit
    };
  }

  /**
   * 尝试入场
   */
  _tryEntry(row, protection, direction, costs) {
    const { entryMin, entryMax, entryLimit } = protection;

    // 限价挂单（entryLimit 存在）：等价格回调触达 entryLimit 才成交。
    // 多头：当根最低价触及 entryLimit；空头：当根最高价触及 entryLimit。
    if (Number.isFinite(entryLimit)) {
      const long = direction === 1;
      const reached = long ? row.low <= entryLimit : row.high >= entryLimit;
      if (!reached) return null;
      // 限价单成交价不劣于挂单价；这里加保守滑点（与全系统成本模型一致）。
      const slipped = entryLimit * (1 + direction * costs.slippageBps / 10000);
      const valid = long
        ? slipped > protection.stopLoss && slipped < protection.takeProfit
        : slipped < protection.stopLoss && slipped > protection.takeProfit;
      if (!valid) return null;
      return { price: slipped };
    }

    // 兼容旧计划：下一根开盘价必须在入场区间内（近似市价）
    if (row.open < entryMin || row.open > entryMax) {
      return null;
    }

    // 计算滑点后的实际入场价
    const slipped = row.open * (1 + direction * costs.slippageBps / 10000);
    const long = direction === 1;

    // 验证滑点后价格仍在止损止盈之间
    const valid = long
      ? slipped > protection.stopLoss && slipped < protection.takeProfit
      : slipped < protection.stopLoss && slipped > protection.takeProfit;

    if (!valid) return null;

    return { price: slipped };
  }

  /**
   * 检查出场条件
   */
  _checkExit(row, protection, entry, held, direction, liquidationPrice) {
    const long = direction === 1;
    const { stopLoss, takeProfit, maxHoldBars } = protection;

    // 1. 爆仓检查（如果启用）
    if (this.config.enableLiquidation && liquidationPrice) {
      const liquidated = long
        ? row.low <= liquidationPrice
        : row.high >= liquidationPrice;

      if (liquidated) {
        const opensBeyond = long
          ? row.open <= liquidationPrice
          : row.open >= liquidationPrice;
        const stopBeforeLiq = long
          ? stopLoss > liquidationPrice
          : stopLoss < liquidationPrice;

        if (opensBeyond || !stopBeforeLiq) {
          const hitTarget = long ? row.high >= takeProfit : row.low <= takeProfit;
          return {
            reason: 'liquidation',
            price: opensBeyond ? row.open : liquidationPrice,
            ambiguous: hitTarget
          };
        }
      }
    }

    // 2. 止损 / 止盈检查（同根K线可能双触发）
    const hitStop = long ? row.low <= stopLoss : row.high >= stopLoss;
    const hitTarget = long ? row.high >= takeProfit : row.low <= takeProfit;

    if (hitStop && hitTarget) {
      // P1-1：同根K线双触发时，若当根开盘已越过止盈，按更优价以止盈结算
      // （"先止盈后回踩"的单不应被记成止损，避免系统性压低胜率）
      const openedBeyondTarget = long ? row.open >= takeProfit : row.open <= takeProfit;
      if (openedBeyondTarget) {
        return {
          reason: 'take_profit',
          price: long ? Math.max(row.open, takeProfit) : Math.min(row.open, takeProfit),
          ambiguous: true
        };
      }
      const stopPrice = long ? Math.min(row.open, stopLoss) : Math.max(row.open, stopLoss);
      return { reason: 'stop_loss', price: stopPrice, ambiguous: true };
    }

    if (hitStop) {
      // 止损价格：开盘价和止损价的较优值
      const stopPrice = long
        ? Math.min(row.open, stopLoss)
        : Math.max(row.open, stopLoss);

      return {
        reason: 'stop_loss',
        price: stopPrice,
        ambiguous: false
      };
    }

    // 3. 止盈检查
    if (hitTarget) {
      return {
        reason: 'take_profit',
        price: takeProfit,
        ambiguous: false
      };
    }

    // 4. 超时检查
    if (held >= maxHoldBars) {
      return {
        reason: 'timeout',
        price: row.close,
        ambiguous: false
      };
    }

    return null;
  }

  /**
   * 结算平仓
   */
  _settle(order, exitResult, entry, entryTime, exitTime, held, direction, adverse, realized = null) {
    const costs = order.costs;

    // 计算出场滑点
    const exit = exitResult.price * (1 - direction * costs.slippageBps / 10000);
    const quantity = order.quantity;

    // ── 分批止盈汇总 ──────────────────────────────────────────────────────
    // 有分批时 order.quantity 只剩「奔跑仓」，此前各批盈亏已累计在 realized 里。
    // 入场费与名义按剩余仓位比例分摊（各批份额 + 剩余份额 = 1），合计恰为全额。
    const prior = realized || { gross: 0, fee: 0, funding: 0, net: 0, qty: 0, fills: 0 };
    const originalQty = prior.qty + quantity;
    const share = originalQty > 0 ? quantity / originalQty : 0;

    // 计算盈亏（本批 = 剩余全部）
    const gross = direction * (exit - entry) * quantity;
    const entryFee = (order.entryFee || order.notional * costs.feeBps / 10000) * share;
    const exitFee = exit * quantity * costs.feeBps / 10000;
    const funding = this._calcFunding(order.notional * share, costs, entryTime, exitTime);
    const rawNet = (gross - entryFee - exitFee - funding) + prior.net;

    // 隔离保证金保护（如果启用）
    // 已实现盈亏（prior.net）必须并入后判定：前面分批赚到的钱要能抵补奔跑仓的亏损，
    // 否则「先赚后亏」的单会被误判成穿仓。
    let net = rawNet;
    let isolatedAdjustment = 0;

    if (this.config.enableIsolatedMargin && rawNet < 0) {
      const maxLoss = -order.margin - (order.entryFee || 0);
      if (rawNet < maxLoss) {
        isolatedAdjustment = maxLoss - rawNet;
        net = maxLoss;
      }
    }

    return {
      status: 'closed',
      reason: exitResult.reason,
      entry,
      exit,
      entryAt: new Date(entryTime).toISOString(),
      exitAt: new Date(exitTime).toISOString(),
      gross: gross + prior.gross,
      fee: entryFee + exitFee + prior.fee,
      fees: entryFee + exitFee + prior.fee,  // 兼容两种命名
      fundingReserve: funding + prior.funding,
      funding: funding + prior.funding,  // 兼容两种命名
      net,
      netReturn: net / order.notional,
      roi: net / order.margin,
      heldBars: held,
      adverseReturnUpperBound: adverse,
      isolatedLossAdjustment: isolatedAdjustment,
      ambiguousBar: exitResult.ambiguous,
      // 分批成交次数（0 = 未分批），供复盘区分「全仓主止盈」与「分批止盈」
      partialFills: prior.fills || 0
    };
  }

  /**
   * 计算资金费
   */
  _calcFunding(notional, costs, entryTime, exitTime) {
    const duration = exitTime - entryTime;
    return notional * costs.fundingBpsPer8h / 10000 * duration / 28800000;
  }

  /**
   * 汇总统计
   */
  _summarize(items) {
    const closed = items.filter(i => i.evaluation?.status === 'closed');
    const wins = closed.filter(i => i.evaluation.net > 0);
    const losses = closed.filter(i => i.evaluation.net < 0);

    const sum = (rows, key) => rows.reduce((total, row) => total + row.evaluation[key], 0);

    return {
      total: items.length,
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : null,
      net: sum(closed, 'net'),
      averageNet: closed.length ? sum(closed, 'net') / closed.length : null,
      averageWin: wins.length ? sum(wins, 'net') / wins.length : null,
      averageLoss: losses.length ? sum(losses, 'net') / losses.length : null,
      profitFactor: losses.length ? sum(wins, 'net') / -sum(losses, 'net') : null,
      dataGaps: items.filter(i => i.evaluation?.status === 'data_gap').length,
      pending: items.filter(i => ['open', 'pending'].includes(i.evaluation?.status)).length,
      items
    };
  }
}

/**
 * 便捷工厂函数
 */
export function createBacktestSimulator(options = {}) {
  return new TradingSimulator({ mode: 'backtest', ...options });
}

export function createAccountSimulator(options = {}) {
  return new TradingSimulator({ mode: 'account', ...options });
}
