/**
 * 策略表现评估
 *
 * 使用统一的 TradingSimulator 引擎
 * 保持原有 API 接口不变，内部切换到新引擎
 */

import { nextOpenTime } from './research.js';
import { createBacktestSimulator } from './tradingSimulator.js';

/**
 * 计算评估结束时间
 */
export function evaluationEnd(signal) {
  let end = Date.parse(signal.expiresAt);
  for (let i = 0; i < signal.plan.maxHoldBars; i++) {
    end = nextOpenTime(end, signal.interval);
  }
  return end;
}

/**
 * 评估单个信号
 *
 * @param {Object} signal - 交易信号
 * @param {Array} rows - K线数据
 * @param {Object} costs - 成本参数
 * @param {number} now - 当前时间
 * @returns {Object} 评估结果
 */
export function evaluateSignal(signal, rows, costs, now = Date.now()) {
  // 使用统一的回测模拟器
  const simulator = createBacktestSimulator({ costs });

  // 执行评估
  return simulator.evaluate(signal, rows, now);
}

/**
 * 汇总评估结果
 *
 * @param {Array} items - 评估项目数组
 * @returns {Object} 汇总统计
 */
export function summarizeResults(items) {
  const closed = items.filter(i => i.evaluation.status === 'closed');
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
    dataGaps: items.filter(i => i.evaluation.status === 'data_gap').length,
    pending: items.filter(i => ['open', 'pending'].includes(i.evaluation.status)).length,
    expired: items.filter(i => i.evaluation.status === 'expired').length
  };
}
