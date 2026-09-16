/**
 * 币安相关展示工具 —— BinanceSettings / BinanceOrdersView 等共用，
 * 消除两个视图各自维护一份 fmt / orderStatus / 盈亏配色的重复。
 */
import { isBinanceDemo } from '../../shared/binanceEnvironment.js';

export { isBinanceDemo };

/** 金额/数量格式化：至少 2 位、最多 6 位小数，非法值显示占位符 */
export const fmt = value => Number.isFinite(Number(value))
  ? Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  : '—';

/** 币安订单状态 → 中文标签（合约 openOrders 与 Spot 历史订单共用同一套状态枚举） */
export const orderStatusLabel = value => ({
  NEW: '未成交',
  PARTIALLY_FILLED: '部分成交',
  FILLED: '已成交',
  CANCELED: '已撤单',
  EXPIRED: '已过期',
  REJECTED: '已拒绝'
}[value] || value || '—');

/** 盈亏数字 → 涨跌配色类名（红涨绿跌） */
export const moneyClass = value => Number(value) > 0 ? 'profit' : Number(value) < 0 ? 'loss' : '';

/** 毫秒时间戳 → 本地时间；空值显示占位符 */
export const dateTime = value => Number(value) > 0 ? new Date(Number(value)).toLocaleString() : '—';

/** ISO 时间 → 本地时间；空值显示占位符 */
export const isoDateTime = value => value ? new Date(value).toLocaleString() : '—';

/** 环境中文名（用于确认弹窗、提示文案），保证「Demo 模拟盘 / 实盘」叫法全站一致 */
export const environmentName = demo => demo ? 'Demo 模拟盘' : '实盘';
