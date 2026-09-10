/**
 * 自适应策略配置管理
 * 控制各种自适应优化功能的开关和参数
 */

export const DEFAULT_ADAPTIVE_CONFIG = {
  // 币种过滤
  symbolFilter: {
    enabled: true,
    minSampleSize: 5,          // 最小样本量（保留一个币所需）
    minSampleSizeToExclude: 10, // P3：拉黑一个负期望值币种所需样本量（比保留门槛更严）
    minWinRate: 0.35,          // 最低胜率阈值（期望值过滤下仅作统计展示）
    minOrdersToActivate: 20    // 至少需要多少笔历史订单才启用
  },

  // 时段过滤
  hourFilter: {
    enabled: true,
    minSampleSize: 5,
    minWinRate: 0.55,
    minOrdersToActivate: 50
  },

  // 持仓时长优化
  holdingPeriodOptimization: {
    enabled: true,
    minSampleSize: 20,
    autoApplyThreshold: 0.3,    // 置信度阈值，超过此值自动应用
    triggerInterval: 50         // 每N笔订单触发一次优化
  },

  // 币种级别参数优化
  symbolLevelParams: {
    enabled: true,
    minSampleSize: 10
  },

  // 波动率自适应
  volatilityAdaptive: {
    enabled: false,  // 暂时禁用，需要更多测试
    lookbackPeriod: 100
  },

  // 日志级别
  logging: {
    verbose: true,
    logFilters: true,
    logOptimizations: true
  }
};

/**
 * 获取自适应配置
 * @param {Object} overrides - 覆盖默认配置的选项
 * @returns {Object} - 合并后的配置
 */
export function getAdaptiveConfig(overrides = {}) {
  return {
    symbolFilter: { ...DEFAULT_ADAPTIVE_CONFIG.symbolFilter, ...overrides.symbolFilter },
    hourFilter: { ...DEFAULT_ADAPTIVE_CONFIG.hourFilter, ...overrides.hourFilter },
    holdingPeriodOptimization: { ...DEFAULT_ADAPTIVE_CONFIG.holdingPeriodOptimization, ...overrides.holdingPeriodOptimization },
    symbolLevelParams: { ...DEFAULT_ADAPTIVE_CONFIG.symbolLevelParams, ...overrides.symbolLevelParams },
    volatilityAdaptive: { ...DEFAULT_ADAPTIVE_CONFIG.volatilityAdaptive, ...overrides.volatilityAdaptive },
    logging: { ...DEFAULT_ADAPTIVE_CONFIG.logging, ...overrides.logging }
  };
}

/**
 * 验证配置有效性
 * @param {Object} config - 配置对象
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
export function validateAdaptiveConfig(config) {
  const errors = [];

  if (config.symbolFilter?.minWinRate != null) {
    if (config.symbolFilter.minWinRate < 0 || config.symbolFilter.minWinRate > 1) {
      errors.push('symbolFilter.minWinRate 必须在 0-1 之间');
    }
  }

  if (config.hourFilter?.minWinRate != null) {
    if (config.hourFilter.minWinRate < 0 || config.hourFilter.minWinRate > 1) {
      errors.push('hourFilter.minWinRate 必须在 0-1 之间');
    }
  }

  if (config.holdingPeriodOptimization?.autoApplyThreshold != null) {
    if (config.holdingPeriodOptimization.autoApplyThreshold < 0 || config.holdingPeriodOptimization.autoApplyThreshold > 1) {
      errors.push('holdingPeriodOptimization.autoApplyThreshold 必须在 0-1 之间');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
