/** Rust API 返回的平仓理由代码对应的界面标签和样式分组。 */
const REASONS = Object.freeze({
  take_profit: { label: '止盈', group: 'tp' },
  partial_take_profit: { label: '分批止盈', group: 'tp' },
  stop_loss: { label: '初始止损', group: 'sl' },
  trailing_stop: { label: '移动止损', group: 'sl' },
  break_even_stop: { label: '保本止损', group: 'sl' },
  smart_exit_ma: { label: '均线失守', group: 'smart' },
  smart_exit_rsi: { label: 'RSI极值', group: 'smart' },
  smart_exit_macd: { label: 'MACD背离', group: 'smart' },
  liquidation: { label: '爆仓', group: 'risk' },
  timeout: { label: '持有到期', group: 'time' },
  manual: { label: '手动平仓', group: 'manual' },
  strategy_cancelled: { label: '策略撤单', group: 'manual' }
});

export function closeReasonLabel(code) {
  return Object.hasOwn(REASONS, code) ? REASONS[code].label : code ? String(code) : '';
}

export function closeReasonGroup(code) {
  return Object.hasOwn(REASONS, code) ? REASONS[code].group : 'manual';
}
