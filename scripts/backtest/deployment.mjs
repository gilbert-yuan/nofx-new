import { hash } from './config.mjs';
import { summarize } from './stats.mjs';

export const DEPLOYMENT_POLICY = Object.freeze({ minTestTrades: 100, minTradedCoins: 10,
  minTestObservedDays: 30, minAnnualCoverage: 0.95, minImprovement: 0.001,
  maxDrawdown: 0.3, maxDrawdownIncrease: 0.02, minProfitFactor: 1.05 });

/** Test results may veto a frozen candidate; they never select a different candidate. */
export function assessDeployment(report, policy = DEPLOYMENT_POLICY) {
  const reasons = [], comparisons = {};
  if (!report.baseline) return { eligible: false, reasons: ['baseline_comparison_missing'], policy };
  if (report.selectionStatus !== 'best_within_search_budget') reasons.push('optimization_evidence_insufficient');
  if (hash(report.bestParameters.execution) !== hash(report.baseline.parameters.execution)
    || hash(report.bestParameters.costs) !== hash(report.baseline.parameters.costs)) reasons.push('execution_or_cost_scenario_changed');
  const changed = hash(report.bestParameters.params) !== hash(report.baseline.parameters.params)
    || report.filter.appliedRules.length > 0;
  if (!changed) reasons.push('no_parameter_or_filter_change');
  if (report.summary.test.errorCoins || report.summary.full.errorCoins) reasons.push('replay_errors');
  const testDays = (Date.parse(report.periods.test.to) - Date.parse(report.periods.test.from)) / 86400000;
  if (testDays < policy.minTestObservedDays) reasons.push('test_window_too_short');
  for (const segment of ['validation', 'test']) {
    // The live universe includes recent listings too. A profitable mature-coin subset
    // cannot authorize a candidate whose complete evaluated universe loses money.
    const overall = summarize(report.coins.map(c => c[segment]));
    if (!(overall.meanReturn > 0)) reasons.push(`${segment}_overall_not_profitable`);
    if (!(overall.profitFactor >= policy.minProfitFactor)) reasons.push(`${segment}_overall_profit_factor_below_threshold`);
    if (overall.worstDrawdown == null || overall.worstDrawdown > policy.maxDrawdown) reasons.push(`${segment}_overall_drawdown_limit`);
    const baseline = new Map(report.baseline.coins.map(c => [c.symbol, c[segment]]));
    const paired = report.coins.filter(c => c[segment]?.status === 'ok' && baseline.get(c.symbol)?.status === 'ok'
      && c[segment].coverage?.coverage >= policy.minAnnualCoverage);
    const candidate = summarize(paired.map(c => c[segment])), previous = summarize(paired.map(c => baseline.get(c.symbol)));
    const tradedCoins = paired.filter(c => c[segment].metrics.trades > 0).length;
    const delta = candidate.meanReturn == null || previous.meanReturn == null ? null : candidate.meanReturn - previous.meanReturn;
    comparisons[segment] = { overall, candidate, baseline: previous, pairedCoins: paired.length, tradedCoins, improvement: delta };
    if (!(candidate.meanReturn > 0)) reasons.push(`${segment}_not_profitable`);
    if (delta == null || delta < policy.minImprovement) reasons.push(`${segment}_improvement_below_threshold`);
    if (tradedCoins < policy.minTradedCoins) reasons.push(`${segment}_too_few_traded_coins`);
    if (candidate.trades < policy.minTestTrades) reasons.push(`${segment}_too_few_trades`);
    if (!(candidate.profitFactor >= policy.minProfitFactor)) reasons.push(`${segment}_profit_factor_below_threshold`);
    if (candidate.worstDrawdown == null || candidate.worstDrawdown > policy.maxDrawdown
      || candidate.worstDrawdown > previous.worstDrawdown + policy.maxDrawdownIncrease)
      reasons.push(`${segment}_drawdown_limit`);
  }
  return { eligible: reasons.length === 0, reasons, policy, comparisons,
    parameterSelection: 'training_and_validation_only', testRole: 'one_time_veto; no_reoptimization_from_test',
    interpretation: '通过历史门槛仅支持采用该次冻结候选，不保证未来盈利或全局最优' };
}
