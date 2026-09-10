/**
 * 跨分析引擎共享的策略护栏（Strategy Guards）
 *
 * 初衷（参见《策略优化分析报告》P2-1）：
 *   localAnalysis / localAnalysisMultiTimeframe / enhancedAnalysis 各自为政，
 *   方向限制、移动止损和止损距离应使用一致的规则。
 *
 * 本模块固化以下跨引擎一致 / 应保持一致的规则：
 *   1. `LONG_ONLY`      — 可选的本地规则引擎禁空开关，默认双向
 *   2. `TRAILING_RULE`  — 持仓保护：触发口径、渐进式跟踪阶梯（R 口径）、顺势扩盈距离
 *   3. `SMART_EXIT`     — 主动离场（均线失守 / RSI 极值 / MACD 背离）的统一阈值
 *   4. `RISK_RULE`      — 初始止损口径与杠杆风险预算
 *   5. `ENHANCED_RR_FLOOR` — enhanced 引擎专用 RR 门槛 + 最小止损距离
 *
 * **不抽出**：localAnalysis 的 `MIN_REWARD_TO_RISK` —— 它 (1.25) 与 enhanced 的
 * `MIN_RISK_REWARD_RATIO` (2.5) 看似都是「最低盈亏比」，但口径截然不同：
 *   - local 用「最不利入场价 → 止盈 ÷ 最不利入场价 → 止损」（含入场带宽）
 *   - enhanced 用「现价 → 主止盈 ÷ 现价 → 止损」（不含入场带宽）
 * 两者**不可机械对齐**——把 local 抬到 2.5 会出 0 单，把 enhanced 压到 1.25 会
 * 漏过大量低胜率信号。语义不同，门槛各自保留为引擎内部常量。
 *
 * 所有数值均可通过同名环境变量覆盖，便于逐项回滚与灰度（改一项 → 跑 ≥100 笔 → 再改下一项）。
 */

const num = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[strategyGuards] 环境变量 ${name}=${raw} 非法（需在 ${min}~${max}），回退默认值 ${fallback}`);
    return fallback;
  }
  return value;
};

const bool = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return /^(true|1|yes)$/i.test(String(raw).trim());
};

// ─────────────────────────── 禁空政策 ───────────────────────────
//
// 单一事实源：本字段被 localAnalysis / localAnalysisMultiTimeframe /
// enhancedAnalysis 三处 wait() 调用消费，避免出现「enhanced 文本漏写
// 『与本地策略保持一致』」之类的退化式漂移。
export const LONG_ONLY = Object.freeze({
  enabled: bool('NOFX_LONG_ONLY', false),
  reason: '当前配置 NOFX_LONG_ONLY 已启用，仅允许做多。'
});

// ───────────────────────── 移动止损（trailing）规则 ─────────────────────────
//
// ⚠️ 2026-09-10 修正（保本跳变）：旧实现是 `newStop = max(原止损, entry±0.2ATR,
// close∓2.5ATR)`。首次触发时浮盈仅 0.4R，`close−2.5ATR` 恒小于 `entry+0.2ATR`，
// 于是**保本项必然胜出** → 止损从距成交价 ~3.6 ATR 一步跳到 entry+0.2 ATR
// （距现价仅剩约 1.24 ATR），而 2.5 ATR 的跟踪要等浮盈 > 2.7 ATR 才接管。两个后果：
//   (1) 止损一步越过了当前盈利所能支撑的位置，极易被 1m 噪声扫出；
//   (2) entry+0.2ATR 远低于真实净保本线 —— 往返成本约 2×(6+5)=22bps ≈ 1.1 ATR @1m，
//       所谓「保本单」实际仍是净亏损单。
//
// 现改为**R 口径的渐进式跟踪阶梯**：实现多少浮盈，才允许把止损抬到对应档位，
// 且跟踪距离随浮盈收窄。三个保证：
//   (a) 止损单调只紧不松（取历史最紧值与当前计算值的紧侧）；
//   (b) 每一档的锁盈位都严格低于已实现浮盈（lockR < atR），绝不越过现价合理区间；
//   (c) 锁盈位同时不得低于**成本保本线**（netBreakEvenBps），避免「保本单仍亏钱」。
// 用 R 而非 ATR 作单位，是为了在初始止损口径（RISK_RULE）调整时不必重标阶梯。
export const TRAILING_RULE = Object.freeze({
  // 触发线：浮盈达到 N×R 即开始保护（R = 成交价到初始止损的距离）
  triggerR: num('NOFX_TRAIL_TRIGGER_R', 0.4, 0.05, 3.0),
  // 兼容保留：旧的「已明显盈利」百分比兜底通道（浮盈 > 2% 也触发）
  profitTriggerPct: num('NOFX_TRAIL_PROFIT_TRIGGER', 0.02, 0, 1),
  // 顺势扩展止盈（只放宽不收窄）
  extendTpAtr: num('NOFX_TRAIL_TP_ATR', 3.0, 0.5, 10),
  // 锁盈位要求的最小「留白」——锁盈位距离现价不得小于该 ATR 倍数，
  // 否则说明锁得太贴身（会把还没走完的趋势直接砍掉），该档锁盈自动失效、只做跟踪。
  lockMinRoomAtr: num('NOFX_LOCK_MIN_ROOM_ATR', 1.0, 0, 5),
  // 兼容保留：旧「保本落点」偏移（单位 ATR）。默认**不参与** max()，
  // 因为它正是「保本跳变」的成因。置 NOFX_TRAIL_USE_BREAKEVEN=true 可回退旧行为。
  breakEvenFloorAtr: num('NOFX_TRAIL_BREAKEVEN_ATR', 0.2, 0, 3),
  useBreakEven: bool('NOFX_TRAIL_USE_BREAKEVEN', false),
  // 成本保本线的额外缓冲（bps）
  breakEvenCostBufferBps: num('NOFX_TRAIL_BREAKEVEN_BUFFER_BPS', 4, 0, 200),
  // 渐进式跟踪阶梯（R 口径）：浮盈 ≥ atR 时，跟踪距离 = trailR×R，锁盈位 = lockR×R。
  // 必须按 atR 升序；且 lockR < atR（锁盈不得超过已实现浮盈）。
  ladder: Object.freeze([
    Object.freeze({ atR: 0, trailR: num('NOFX_TRAIL_R_L0', 0.70, 0.1, 3), lockR: num('NOFX_LOCK_L0_R', 0, 0, 10) }),
    Object.freeze({ atR: num('NOFX_LADDER_AT_L1', 1.0, 0.1, 10), trailR: num('NOFX_TRAIL_R_L1', 0.50, 0.1, 3), lockR: num('NOFX_LOCK_L1_R', 0.30, 0, 10) }),
    Object.freeze({ atR: num('NOFX_LADDER_AT_L2', 2.0, 0.1, 10), trailR: num('NOFX_TRAIL_R_L2', 0.40, 0.1, 3), lockR: num('NOFX_LOCK_L2_R', 0.80, 0, 10) })
  ])
});

// ───────────────────────── 主动离场（智能退出）规则 ─────────────────────────
//
// ⚠️ 2026-09-10 修正（规则单边）：旧实现三条规则的浮盈条件互不对称 ——
//   · 均线失守：profit < 5%  才生效
//   · RSI 极值 / MACD 背离：profit > 5% 才生效（5% 还是硬编码，与 R 口径混用）
// 结果是「微利单和浮亏单被优先砍掉，真正走出来的趋势单反而砍不掉」，与历史结论
// 「盈利需要持仓时间（30-59 根胜率 58-60%，<5 根仅 5%）」方向相反，会系统性缩短持仓。
//
// 修正后的职责划分：
//   · 均线失守 → 只负责「入场失败」的单：浮盈 < maExitMaxProfitR 时才算趋势被证伪；
//     一旦浮盈越过该线，保护权交给移动止损阶梯（见 TRAILING_RULE.ladder）。
//   · RSI 极值 / MACD 背离 → 只负责「趋势力竭」的获利了结，阈值统一改成 R 口径。
export const SMART_EXIT = Object.freeze({
  enabled: bool('NOFX_SMART_EXIT', true),
  // 均线失守判定：方向失效且偏离 MA20 超过该 ATR 倍数
  maBreakAtr: num('NOFX_SMART_MA_ATR', 1.0, 0.2, 5),
  // 均线失守只在浮盈低于该 R 倍数时生效（默认 = 跟踪触发线，即「还没走出保护空间」的单）
  maExitMaxProfitR: num('NOFX_SMART_MA_EXIT_MAX_R', TRAILING_RULE.triggerR, 0, 20),
  // RSI 极值 / MACD 背离止盈要求的最小浮盈（R 口径，取代硬编码 5%）
  tpMinR: num('NOFX_SMART_TP_MIN_R', 2.0, 0, 20),
  // 根级离场：把「均线失守」下沉到逐根K线判定，避免只在复核周期（120s+）才检查
  barLevelMaExit: bool('NOFX_SMART_EXIT_BAR_LEVEL', true)
});

// ─────────────────────── 风险几何（止损口径 / 杠杆） ───────────────────────
//
// 关于 riskStopAtr / minStopPct 的说明（2026-09-10 复核结论）：
//   旧实现 `riskUnit = max(atr × 2.0, close × 0.008)`，1m 上 ATR/close 中位数
//   仅约 0.20%，因此 0.8% 的绝对项主导，初始止损稳定落在距成交价约 3.6 ATR。
//   曾怀疑「止损过宽」，但重算后确认**这是成本结构逼出来的正确取舍**：
//   往返成本 22bps；若把 R 压到 1.6 ATR(0.32%)，成本占 R 的比例从 0.31R 恶化到 0.69R，
//   即每笔交易要先赚掉 2/3 个 R 才回本。**故本次不修改阈值**，只把它抽成可调参数，
//   并把真实保证金风险显式输出（plan.marginRiskPct），不再暗示 10% 预算已被用满。
export const RISK_RULE = Object.freeze({
  // 初始止损的 ATR 倍数
  stopAtr: num('NOFX_STOP_ATR', 2.0, 0.5, 6),
  // 初始止损的绝对下限（占价格比例）。默认保持 0.008 不变（见上方说明）。
  minStopPct: num('NOFX_MIN_STOP_PCT', 0.008, 0, 0.05),
  // 杠杆硬上限
  maxLeverage: num('NOFX_MAX_LEVERAGE', 5, 1, 50),
  // 目标保证金风险预算（占保证金比例）。该值受 maxLeverage 截断，通常用不满；
  // 实际值由 plan.marginRiskPct 输出（= 杠杆 × 止损距离）。
  riskBudgetPct: num('NOFX_RISK_BUDGET_PCT', 0.1, 0.001, 1)
});

// ───────────────── enhanced 引擎专用护栏（API 兼容期保留） ─────────────────
export const ENHANCED_RR_FLOOR = Object.freeze({
  minRiskReward: 2.5,
  // P2-2 报告衍生：止损距离不得低于 1.2 ATR，避免「maSupportStop 离现价 < 1 ATR」
  // 之类导致被正常波动扫掉。
  minStopDistanceAtr: 1.2
});

// ─────────────────────────── 工具函数 ───────────────────────────

/**
 * R 口径比较的容差。浮点误差会让「恰好等于阈值」判成未达标 ——
 * 例如 (100.32−100)/0.8 得到 0.3999999999999915，`>= 0.4` 为 false，
 * 于是「浮盈正好到触发线」的持仓被漏保护。所有「≥ 触发线」判定都走本容差。
 */
export const R_EPSILON = 1e-9;

/**
 * 「浮盈是否达到阈值」（含容差，方向为 ≥）。
 * @param {number} value     实际浮盈（R）
 * @param {number} threshold 阈值（R）
 */
export function reachedR(value, threshold) {
  return Number.isFinite(value) && Number.isFinite(threshold) && value + R_EPSILON >= threshold;
}

/**
 * 计划里的「入场基准价」——与 research.js / localAnalysis 的取价口径保持一致：
 * 优先限价挂单价 entryLimit（实际成交价锚点），否则回退到最不利入场边沿。
 * @param {object} plan
 * @param {string} direction 'long'|'short'|'OPEN_LONG'|'OPEN_SHORT'
 */
export function planRefEntry(plan, direction) {
  const long = direction === 'long' || direction === 'OPEN_LONG';
  if (Number.isFinite(plan?.entryLimit)) return plan.entryLimit;
  return long ? Number(plan?.entryMax) : Number(plan?.entryMin);
}

/**
 * 计划的风险单位 R（价格单位）= |入场基准价 − 初始止损|。
 * 这是「实际成交价到止损」的距离，与 R 口径的触发线 / 阶梯直接对应。
 * 若计划里已固化 `riskUnit`（下单时写入，最稳），优先使用它。
 * @returns {number} R，无法计算时 NaN
 */
export function planRiskUnit(plan, direction) {
  const fixed = Number(plan?.riskUnit);
  if (Number.isFinite(fixed) && fixed > 0) return fixed;
  const ref = planRefEntry(plan, direction);
  const stop = Number(plan?.stopLoss);
  if (!Number.isFinite(ref) || !Number.isFinite(stop)) return NaN;
  return Math.abs(ref - stop);
}

/**
 * 当前浮盈（以 R 为单位）。
 * @param {{long:boolean, entry:number, close:number, riskUnit:number}} p
 */
export function profitRFrom({ long, entry, close, riskUnit }) {
  const r = Number(riskUnit);
  if (!Number.isFinite(r) || r <= 0) return NaN;
  return (long ? close - entry : entry - close) / r;
}

/**
 * 真实净保本线（bps，占价格的万分比）。
 * 往返成本 = 开仓费 + 平仓费 + 双边滑点 ≈ 2 × (feeBps + slippageBps)。
 * @param {{feeBps?:number, slippageBps?:number}} [costs]
 */
export function netBreakEvenBps(costs) {
  const fee = Number(costs?.feeBps ?? 6);
  const slip = Number(costs?.slippageBps ?? 5);
  return 2 * (fee + slip) + TRAILING_RULE.breakEvenCostBufferBps;
}

/**
 * 按浮盈（R 倍数）取当前生效的跟踪档位。
 * @param {number} profitR 浮盈，单位 R
 */
export function trailStepFor(profitR) {
  let step = TRAILING_RULE.ladder[0];
  for (const item of TRAILING_RULE.ladder) if (Number.isFinite(profitR) && profitR >= item.atR) step = item;
  return step;
}

/**
 * 计算「本来应该生效」的保护止损（不含历史最紧值的单调约束，由调用方合并）。
 *
 * 组成：max/min（对多头取较大值 = 更紧）
 *   · baseStop      历史最紧止损（保证单调不放松）
 *   · trailStop     close ∓ trailR × R，跟踪距离随浮盈档位收窄
 *   · lockStop      entry ± lockR × R，且不得低于成本保本线；留白不足时该档自动失效
 *   · breakEvenStop entry ± breakEvenFloorAtr × ATR，仅当 useBreakEven=true（旧行为回退用）
 *
 * @param {object} p
 * @param {boolean} p.long
 * @param {number} p.entry    实际成交价
 * @param {number} p.close    当前价
 * @param {number} p.atr      当前 ATR
 * @param {number} p.riskUnit R（成交价到初始止损的距离，价格单位）
 * @param {number} p.profitR  当前浮盈（R 倍数）
 * @param {number} [p.baseStop] 历史最紧止损
 * @param {{feeBps?:number,slippageBps?:number}} [p.costs]
 * @returns {{stop:number, step:object, trailStop:number, lockStop:number|null, reversed:boolean}}
 *          reversed=true 表示算出的止损已越过现价（异常情形，调用方应判为无效并保持原值）
 */
export function computeTrailStop({ long, entry, close, atr, riskUnit, profitR, baseStop, costs }) {
  const step = trailStepFor(profitR);
  const sign = long ? 1 : -1;
  const candidates = [];
  if (Number.isFinite(baseStop) && baseStop > 0) candidates.push(baseStop);

  const trailStop = close - sign * step.trailR * riskUnit;
  candidates.push(trailStop);

  let lockStop = null;
  if (step.lockR > 0 && Number.isFinite(riskUnit) && riskUnit > 0) {
    // 锁盈位取「档位要求」与「成本保本线」的较优者（对多头取较大值 = 更紧）
    const costDist = entry * netBreakEvenBps(costs) / 10000;
    const byStep = entry + sign * step.lockR * riskUnit;
    const byCost = entry + sign * costDist;
    const wanted = long ? Math.max(byStep, byCost) : Math.min(byStep, byCost);
    // 留白检查：锁盈位距现价不得小于 lockMinRoomAtr×ATR，否则本档锁盈失效
    const room = long ? close - wanted : wanted - close;
    if (room >= TRAILING_RULE.lockMinRoomAtr * atr) {
      lockStop = wanted;
      candidates.push(wanted);
    }
  }

  if (TRAILING_RULE.useBreakEven) {
    candidates.push(entry + sign * TRAILING_RULE.breakEvenFloorAtr * atr);
  }

  const valid = candidates.filter(v => Number.isFinite(v) && v > 0);
  const stop = valid.length ? (long ? Math.max(...valid) : Math.min(...valid)) : NaN;
  // 多头：止损若 ≥ 现价说明把仓位锁死，视为异常；空头反之
  const reversed = Number.isFinite(stop) && (long ? stop >= close : stop <= close);
  return { stop, step, trailStop, lockStop, reversed };
}

/**
 * 把「禁空命中」翻译成 wait() 返回结构。
 * @param {(reason: string, suggestions?: string[], trend?: object) => object} wait
 *   wait 工厂函数，由调用方在各自作用域构造，以保持原代码风格一致。
 * @param {object} [trendStrength] 趋势强度对象（如有），透传给 wait
 */
export function longOnlyWait(wait, trendStrength) {
  return wait(LONG_ONLY.reason, [], trendStrength);
}

/**
 * 通用快捷检查：方向是否应被禁。
 * @param {string} direction  'long' | 'short'
 * @returns {boolean}
 */
export function isDirectionBlocked(direction) {
  return LONG_ONLY.enabled && direction === 'short';
}
