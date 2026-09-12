/** 通用展示格式化工具（账户/表现/复盘等多个视图共用，避免重复定义） */

// 平仓理由字典与后端同一份定义（shared/closeReasons.js），避免前后端口径漂移
import { closeReasonLabel, closeReasonGroup } from '../../shared/closeReasons.js';

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

/**
 * 平仓理由 → 中文标签。
 * 走统一字典：新增/改名只在 shared/closeReasons.js 改一处，前后端同时生效。
 */
export function reasonLabel(s) {
  return closeReasonLabel(s);
}

/** 平仓理由 → 分组 id（tp / sl / smart / risk / time / manual），用于着色与归类筛选 */
export function reasonGroup(s) {
  return closeReasonGroup(s);
}
