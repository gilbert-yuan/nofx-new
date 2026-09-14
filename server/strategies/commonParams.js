/**
 * 所有可下单策略共用的仓位风险参数。
 *
 * 这些参数仍受全局风控硬上限约束，但策略可以在自己的配置文件条目里
 * 选择更保守的 maxLeverage / riskBudgetPct。策略分析、自动下单和回测
 * 都通过同一组 schema 解析，避免某个策略悄悄退回环境变量默认值。
 */
import { RISK_RULE } from '../shared/strategyGuards.js';

export const STRATEGY_RISK_DEFAULTS = Object.freeze({
  maxLeverage: RISK_RULE.maxLeverage,
  riskBudgetPct: RISK_RULE.riskBudgetPct
});

const numSpec = (key, label, group, min, max, step, description) => ({
  key, label, group, type: 'number', default: STRATEGY_RISK_DEFAULTS[key], min, max, step, description
});

export const STRATEGY_RISK_PARAM_SCHEMA = Object.freeze([
  numSpec('maxLeverage', '策略杠杆上限', 'risk', 1, 50, 1,
    '策略推荐杠杆的上限；仍受系统级全局风控上限约束。'),
  numSpec('riskBudgetPct', '策略保证金风险预算', 'risk', 0.001, 1, 0.01,
    '按止损距离反推推荐杠杆的目标保证金风险占比。')
]);
