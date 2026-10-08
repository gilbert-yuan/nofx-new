/**
 * 平仓理由分类体系（单一事实源）
 *
 * 背景：改造前 `simulated_orders.reason` 是「想到什么写什么」的混装字段 ——
 *   1. 结算引擎写机器码（stop_loss / take_profit / timeout / liquidation）；
 *   2. 复核层（智能退出）写**中文长句**（"均线失守（偏离1.23ATR）且浮盈仅 0.11R…"）；
 *   3. 复核层真正执行平仓时又硬编码写 `manual`（26 笔智能退出全被记成手动平仓）；
 *   4. 止损不区分来源：初始止损 / 移动止损 / 保本止损 全是 `stop_loss`（2243 笔混成一坨）。
 *   后果是「平仓理由」这个字段**根本没法统计**。
 *
 * 设计
 *   1. **机器码 + 中文标签分离**：落库永远是稳定 code（便于 GROUP BY），
 *      中文只用于展示，由 `closeReasonLabel()` 统一翻译。
 *   2. **向后兼容**：`normalizeCloseReason()` 能识别旧 code 与历史中文长句，
 *      回填/展示都不丢信息；未知值归为 `manual` 并保留原文在 `reasonDetail`。
 *   3. **分组**：tp / sl / smart / risk / time / manual，便于看「哪一类在亏钱」。
 */

/** 平仓理由分组（顺序即展示顺序） */
export const CLOSE_REASON_GROUPS = Object.freeze([
  { id: 'tp', label: '止盈' },
  { id: 'sl', label: '止损' },
  { id: 'smart', label: '智能退出' },
  { id: 'risk', label: '风险' },
  { id: 'time', label: '时间' },
  { id: 'manual', label: '人工' }
]);

/** 平仓理由字典：code → { label, group, desc } */
export const CLOSE_REASONS = Object.freeze({
  // ── 止盈 ────────────────────────────────────────────────────────────────
  take_profit: { label: '止盈', group: 'tp', desc: '触达止盈目标，整仓了结' },
  partial_take_profit: { label: '分批止盈', group: 'tp', desc: '已分批减仓，剩余奔跑仓了结' },
  // ── 止损 ────────────────────────────────────────────────────────────────
  stop_loss: { label: '初始止损', group: 'sl', desc: '触及入场时的初始止损' },
  trailing_stop: { label: '移动止损', group: 'sl', desc: '浮盈达标后止损上移，被打掉（锁定部分利润）' },
  break_even_stop: { label: '保本止损', group: 'sl', desc: '分批后止损抬到保本线，被打掉（不亏不赚）' },
  // ── 智能退出（策略主动离场）──────────────────────────────────────────────
  smart_exit_ma: { label: '均线失守', group: 'smart', desc: '趋势被证伪（价格偏离均线超阈值且未走出保护空间），主动离场' },
  smart_exit_rsi: { label: 'RSI极值', group: 'smart', desc: 'RSI 严重超买/超卖，判定趋势力竭获利了结' },
  smart_exit_macd: { label: 'MACD背离', group: 'smart', desc: 'MACD 死叉/金叉，判定趋势力竭获利了结' },
  // ── 风险 / 时间 / 人工 ───────────────────────────────────────────────────
  liquidation: { label: '爆仓', group: 'risk', desc: '触及强平价被强制平仓' },
  timeout: { label: '持有到期', group: 'time', desc: '超过最大持仓根数，强制离场' },
  manual: { label: '手动平仓', group: 'manual', desc: '人工手动平仓' },
  strategy_cancelled: { label: '策略撤单', group: 'manual', desc: '挂单成交前撤销' }
});

/** 兜底理由 */
export const FALLBACK_CLOSE_REASON = 'manual';

/** 归入「止损」的 code 集合（统计 stoppedCount 用，与 SQL 侧共用同一份定义） */
export const STOP_REASON_CODES = Object.freeze(['stop_loss', 'trailing_stop', 'break_even_stop']);
/** 归入「止盈」的 code 集合（统计 takeProfitCount 用） */
export const TAKE_PROFIT_REASON_CODES = Object.freeze(['take_profit', 'partial_take_profit']);

/** 是否为止损类平仓（对历史值先归一化） */
export function isStopReason(code) {
  return STOP_REASON_CODES.includes(normalizeCloseReason(code));
}

/** 是否为止盈类平仓（对历史值先归一化） */
export function isTakeProfitReason(code) {
  return TAKE_PROFIT_REASON_CODES.includes(normalizeCloseReason(code));
}

const GROUP_LABELS = new Map(CLOSE_REASON_GROUPS.map(g => [g.id, g.label]));

/** 历史中文长句 → code（用于回填与展示兼容） */
const LEGACY_PATTERNS = Object.freeze([
  [/均线失守|趋势证伪|跌破.*均线|突破.*均线/, 'smart_exit_ma'],
  [/RSI严重超买|RSI严重超卖|RSI/, 'smart_exit_rsi'],
  [/MACD死叉|MACD金叉|MACD背离|MACD/, 'smart_exit_macd'],
  [/保本/, 'break_even_stop'],
  [/移动止损|跟踪止损/, 'trailing_stop'],
  [/止盈|获利了结/, 'take_profit'],
  [/止损/, 'stop_loss'],
  [/到期|超时/, 'timeout'],
  [/爆仓|强平/, 'liquidation']
]);

/** 是否为已知平仓理由 code */
export function isCloseReason(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CLOSE_REASONS, code);
}

/**
 * 归一化任意历史值为稳定 code。
 * 已知 code 原样返回；中文长句按关键词匹配；都无法识别返回 `manual`。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCloseReason(value) {
  if (isCloseReason(value)) return value;
  if (typeof value !== 'string') return FALLBACK_CLOSE_REASON;
  const text = value.trim();
  if (!text) return FALLBACK_CLOSE_REASON;
  for (const [pattern, code] of LEGACY_PATTERNS) if (pattern.test(text)) return code;
  return FALLBACK_CLOSE_REASON;
}

/** code → 中文标签（未知返回原值，避免展示空白） */
export function closeReasonLabel(code) {
  if (isCloseReason(code)) return CLOSE_REASONS[code].label;
  if (!code) return '';
  return String(code);
}

/** code → 分组 id（未知返回 'manual'） */
export function closeReasonGroup(code) {
  const key = isCloseReason(code) ? code : FALLBACK_CLOSE_REASON;
  return CLOSE_REASONS[key].group;
}

/** code → 分组中文标签 */
export function closeReasonGroupLabel(code) {
  return GROUP_LABELS.get(closeReasonGroup(code)) || '';
}

/**
 * 完整目录（供前端渲染下拉/图例）。
 * @returns {{code:string,label:string,group:string,groupLabel:string,desc:string}[]}
 */
export function closeReasonCatalog() {
  return Object.entries(CLOSE_REASONS).map(([code, meta]) => ({
    code,
    label: meta.label,
    group: meta.group,
    groupLabel: GROUP_LABELS.get(meta.group) || meta.group,
    desc: meta.desc
  }));
}
