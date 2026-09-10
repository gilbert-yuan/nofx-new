/**
 * 自适应策略优化 API 路由
 */

import { getAdaptiveConfig, validateAdaptiveConfig } from './adaptiveConfig.js';
import {
  filterSymbolsByPerformance,
  identifyHighProbabilityHours,
  shouldTradeAtCurrentHour,
  getAdaptiveParametersForSymbol
} from './adaptiveFilters.js';
import { analyzeHoldingPeriodPerformance, generateOptimizedParameters } from './adaptiveStrategy.js';

/**
 * 注册自适应策略相关的 API 路由
 */
export function registerAdaptiveStrategyRoutes(app, simulation) {
  const route = fn => async (req, res, next) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      next(error);
    }
  };

  // 获取当前自适应配置
  app.get('/api/adaptive/config', route(async () => {
    // 从模拟账户状态中读取配置（如果有保存）
    const state = await simulation.read();
    return state.adaptiveConfig || getAdaptiveConfig();
  }));

  // 更新自适应配置
  app.put('/api/adaptive/config', route(async (req) => {
    const newConfig = req.body || {};
    const validation = validateAdaptiveConfig(newConfig);

    if (!validation.valid) {
      throw Object.assign(new Error(`配置验证失败: ${validation.errors.join(', ')}`), { status: 422 });
    }

    // 保存到模拟账户状态
    await simulation.mutate(state => {
      state.adaptiveConfig = getAdaptiveConfig(newConfig);
    });

    return { success: true, config: newConfig };
  }));

  // 获取币种过滤分析
  app.get('/api/adaptive/symbol-filter', route(async (req) => {
    const state = await simulation.read();
    const historicalOrders = state.orders.filter(o => o.status === 'closed');
    // P3：未显式传 symbols 时，默认用历史成交过的全部币种，
    // 否则 /api/adaptive/symbol-filter 永远返回空数组，无法用于排查过滤是否生效。
    const allSymbols = req.query.symbols
      ? req.query.symbols.split(',').map(s => s.trim()).filter(Boolean)
      : [...new Set(historicalOrders.map(o => o.symbol).filter(Boolean))].sort();

    const config = state.adaptiveConfig || getAdaptiveConfig();

    return filterSymbolsByPerformance(allSymbols, historicalOrders, {
      ...config.symbolFilter,
      enabled: true // 总是返回分析结果，即使配置中禁用
    });
  }));

  // 获取时段分析
  app.get('/api/adaptive/hour-analysis', route(async () => {
    const state = await simulation.read();
    const historicalOrders = state.orders.filter(o => o.status === 'closed');

    const config = state.adaptiveConfig || getAdaptiveConfig();

    return identifyHighProbabilityHours(historicalOrders, {
      ...config.hourFilter,
      enabled: true
    });
  }));

  // 检查当前时段是否适合交易
  app.get('/api/adaptive/current-hour-check', route(async () => {
    const state = await simulation.read();
    const historicalOrders = state.orders.filter(o => o.status === 'closed');
    const currentHour = new Date().getUTCHours();

    const config = state.adaptiveConfig || getAdaptiveConfig();

    return shouldTradeAtCurrentHour(currentHour, historicalOrders, config.hourFilter);
  }));

  // 获取币种级别的自适应参数
  app.get('/api/adaptive/symbol-params/:symbol', route(async (req) => {
    const state = await simulation.read();
    const historicalOrders = state.orders.filter(o => o.status === 'closed');
    const symbol = req.params.symbol;

    const config = state.adaptiveConfig || getAdaptiveConfig();

    return getAdaptiveParametersForSymbol(symbol, historicalOrders, {
      defaultStopLossATR: 2.5,
      defaultTakeProfitATR: 4.0,
      defaultMaxHoldBars: 30,
      minSampleSize: config.symbolLevelParams.minSampleSize
    });
  }));

  // 获取持仓时长优化建议
  app.get('/api/adaptive/holding-optimization', route(async () => {
    const state = await simulation.read();
    const historicalOrders = state.orders.filter(o => o.status === 'closed');

    const analysis = analyzeHoldingPeriodPerformance(historicalOrders);

    if (!analysis.sufficient) {
      return {
        sufficient: false,
        message: analysis.message,
        sampleSize: analysis.sampleSize
      };
    }

    const optimizedParams = generateOptimizedParameters(analysis, 30);

    return {
      sufficient: true,
      analysis,
      optimizedParams,
      timestamp: new Date().toISOString()
    };
  }));

  // 获取完整的自适应策略分析报告
  app.get('/api/adaptive/report', route(async () => {
    const state = await simulation.read();
    const historicalOrders = state.orders.filter(o => o.status === 'closed');
    const config = state.adaptiveConfig || getAdaptiveConfig();

    // 1. 持仓时长分析
    const holdingAnalysis = analyzeHoldingPeriodPerformance(historicalOrders);
    let holdingOptimization = null;
    if (holdingAnalysis.sufficient) {
      holdingOptimization = generateOptimizedParameters(holdingAnalysis, 30);
    }

    // 2. 时段分析
    const hourAnalysis = identifyHighProbabilityHours(historicalOrders, config.hourFilter);

    // 3. 币种表现统计
    const symbolStats = {};
    for (const order of historicalOrders) {
      if (!symbolStats[order.symbol]) {
        symbolStats[order.symbol] = { count: 0, wins: 0, totalNet: 0 };
      }
      symbolStats[order.symbol].count++;
      if (order.net > 0) symbolStats[order.symbol].wins++;
      symbolStats[order.symbol].totalNet += order.net;
    }

    const topSymbols = Object.entries(symbolStats)
      .map(([symbol, stats]) => ({
        symbol,
        ...stats,
        winRate: stats.wins / stats.count,
        avgNet: stats.totalNet / stats.count
      }))
      .filter(s => s.count >= 5)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 10);

    const worstSymbols = Object.entries(symbolStats)
      .map(([symbol, stats]) => ({
        symbol,
        ...stats,
        winRate: stats.wins / stats.count,
        avgNet: stats.totalNet / stats.count
      }))
      .filter(s => s.count >= 5)
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, 10);

    // 4. 整体统计
    const totalOrders = historicalOrders.length;
    const totalWins = historicalOrders.filter(o => o.net > 0).length;
    const overallWinRate = totalOrders > 0 ? totalWins / totalOrders : 0;
    const totalNet = historicalOrders.reduce((sum, o) => sum + o.net, 0);
    const avgNet = totalOrders > 0 ? totalNet / totalOrders : 0;

    return {
      summary: {
        totalOrders,
        totalWins,
        overallWinRate,
        totalNet,
        avgNet,
        timestamp: new Date().toISOString()
      },
      holdingOptimization,
      hourAnalysis: {
        highProbHours: hourAnalysis.highProbHours,
        summary: hourAnalysis.summary,
        topHours: hourAnalysis.hourStats
          .filter(h => h.count >= 5)
          .sort((a, b) => b.winRate - a.winRate)
          .slice(0, 5)
      },
      symbolPerformance: {
        topSymbols,
        worstSymbols
      },
      config
    };
  }));

  // 手动触发优化应用
  app.post('/api/adaptive/apply-optimization', route(async (req) => {
    const { maxHoldBars, stopLossATR, takeProfitATR } = req.body || {};

    const updates = {};
    if (maxHoldBars != null && Number.isFinite(maxHoldBars) && maxHoldBars >= 10 && maxHoldBars <= 200) {
      updates.maxHoldBars = maxHoldBars;
    }
    if (stopLossATR != null && Number.isFinite(stopLossATR) && stopLossATR >= 1 && stopLossATR <= 5) {
      updates.stopLossATR = stopLossATR;
    }
    if (takeProfitATR != null && Number.isFinite(takeProfitATR) && takeProfitATR >= 1.5 && takeProfitATR <= 10) {
      updates.takeProfitATR = takeProfitATR;
    }

    if (Object.keys(updates).length === 0) {
      throw Object.assign(new Error('无有效的优化参数'), { status: 422 });
    }

    // 保存到配置（实际应用在下次扫描时生效）
    await simulation.mutate(state => {
      if (!state.adaptiveOverrides) state.adaptiveOverrides = {};
      Object.assign(state.adaptiveOverrides, updates);
    });

    return {
      success: true,
      applied: updates,
      message: '优化参数已保存，将在下次自动扫描时生效',
      timestamp: new Date().toISOString()
    };
  }));

  // 重置自适应覆盖
  app.post('/api/adaptive/reset-overrides', route(async () => {
    await simulation.mutate(state => {
      delete state.adaptiveOverrides;
    });

    return {
      success: true,
      message: '已重置为默认参数',
      timestamp: new Date().toISOString()
    };
  }));
}
