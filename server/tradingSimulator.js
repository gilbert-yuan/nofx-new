/**
 * 统一的交易模拟引擎
 *
 * 整合了策略表现（paperTrading.js）和模拟交易（simulatedAccount.js）的核心逻辑
 * 通过配置参数支持不同的使用场景
 */

import { nextOpenTime, validCandle, PAPER_COSTS } from './research.js';

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
    const checkpoint = () => ({
      nextTime: time, entry, entryAt: entryTime !== null ? new Date(entryTime).toISOString() : null,
      heldBars: held, quantity: order.quantity, entryFee: order.entryFee,
      liquidationPrice: order.liquidationPrice, markPrice: order.markPrice,
      markAt: order.markAt, unrealized: order.unrealized
    });

    // 逐根K线推进
    while (nextOpenTime(time, order.interval) <= now) {
      // 检查过期（未入场）
      if (!entry && time >= order.expiresAt) {
        return { status: 'expired' };
      }

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

        // 检查出场条件
        const exitResult = this._checkExit(
          row,
          protection,
          entry,
          held,
          direction,
          order.liquidationPrice
        );

        if (exitResult) {
          const settled = this._settle(
            order,
            exitResult,
            entry,
            entryTime,
            nextOpenTime(time, order.interval),
            held,
            direction,
            adverse
          );
          time = nextOpenTime(time, order.interval);
          return { ...checkpoint(), ...settled };
        }
      }

      time = nextOpenTime(time, order.interval);
    }

    // 未完成
    if (!entry && time >= order.expiresAt) {
      return { status: 'expired' };
    }

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
        expiresAt: Date.parse(input.expiresAt),
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
      expiresAt: Date.parse(input.expiresAt),
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
      markPrice: input.markPrice, markAt: input.markAt, unrealized: input.unrealized
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
    const { entryMin, entryMax } = protection;

    // 开盘价必须在入场区间内
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
  _settle(order, exitResult, entry, entryTime, exitTime, held, direction, adverse) {
    const costs = order.costs;

    // 计算出场滑点
    const exit = exitResult.price * (1 - direction * costs.slippageBps / 10000);
    const quantity = order.quantity;

    // 计算盈亏
    const gross = direction * (exit - entry) * quantity;
    const entryFee = order.entryFee || order.notional * costs.feeBps / 10000;
    const exitFee = exit * quantity * costs.feeBps / 10000;
    const funding = this._calcFunding(order.notional, costs, entryTime, exitTime);
    const rawNet = gross - entryFee - exitFee - funding;

    // 隔离保证金保护（如果启用）
    let net = rawNet;
    let isolatedAdjustment = 0;

    if (this.config.enableIsolatedMargin && rawNet < 0) {
      const maxLoss = -order.margin - entryFee;
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
      gross,
      fee: entryFee + exitFee,
      fees: entryFee + exitFee,  // 兼容两种命名
      fundingReserve: funding,
      funding,  // 兼容两种命名
      net,
      netReturn: net / order.notional,
      roi: net / order.margin,
      heldBars: held,
      adverseReturnUpperBound: adverse,
      isolatedLossAdjustment: isolatedAdjustment,
      ambiguousBar: exitResult.ambiguous
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
      expired: items.filter(i => i.evaluation?.status === 'expired').length,
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
