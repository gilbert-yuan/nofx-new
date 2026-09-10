/** 通用展示格式化工具（账户/表现/复盘等多个视图共用，避免重复定义） */

export function fmt(v) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(2);
}

export function pct(v) {
  return v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%';
}

export function statusLabel(s) {
  return (
    {
      closed: '已平仓',
      open: '模拟持仓',
      pending: '等待入场',
      expired: '未成交（历史记录）',
      cancelled: '已取消',
      data_gap: '行情缺失',
      excluded: '未参与'
    }[s] || s
  );
}

export function reasonLabel(s) {
  return (
    {
      stop_loss: '止损',
      strategy_cancelled: '策略撤单',
      take_profit: '止盈',
      timeout: '持有到期',
      liquidation: '爆仓'
    }[s] || ''
  );
}
