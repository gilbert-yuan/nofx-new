/**
 * 冲高回落做空引擎（Pump-Fade Short）
 * —— server/strategies/builtins.js 注册的第 6 个内置策略引擎（engine = 'pump-short'）
 *
 * 需求（2026-09-12 老板）：探索适合做空的策略 —— 100 币 × 90 天大样本回测的唯一正期望方向。
 *
 * ⚠️ 信号周期可配：默认 15m（needsAux=['15m']），4h 做空策略通过 builtins 的
 *   planInterval='4h' + needsAux=['4h'] 复用同一套冲高回落空逻辑。引擎按
 *   `ctx.planInterval || '15m'` 解析信号周期（pump-short 永远是基于 planInterval 的策略，
 *   主周期行情恒为 1m，绝不可回退到 market.interval）——现有 15m 策略行为完全不变。
 *   90 天 1m 研究版用 150 根 15m（≈37.5h）决策上下文，实时自动化行情窗口固定 80 根
 *   → 回看窗口按可用根数截断（≈80 根 = 20h），并写入信号披露。
 *
 * 机制（**只做空**，是 NOFX_LONG_ONLY 禁空政策的显式白名单例外 —— 该策略本身就是空头策略，
 *   由老板拍板启用，与 enhanced/local 的禁空护栏互不相干）：
 *   1. 识别冲高 —— 已收盘的 15m K 线满足：
 *        · 收盘价 > 前 lookbackBars 根最高价 + pumpAtrMin × ATR14（垂直拉升脱离区间）
 *        · 当根振幅 ≤ skipGlitchRangeAtr × ATR（排除坏打印）
 *        · ATR/价格 ∈ [minAtrPct, maxAtrPct]（死水与极端波动回避）
 *   2. 挂空单 —— entryLimit = 冲高收盘价 − pullbackAtr × ATR（吃第一段回落，研究口径 pull=0.3~0.8）；
 *      交易所价格上摸到该价才成交（tradingSimulator._tryEntry 空头分支：当根最高价 ≥ entryLimit）。
 *   3. 出场 —— 止损 = 冲高最高价 + stopBufferAtr × ATR（冲高未被证伪即逻辑失效）；
 *      R = stop − entry，且不得低于 minStopPct × entry；
 *      止盈 = entry − takeProfitR × R（研究最优 3R；右偏形态：胜率 33~43%、靠大单撑均值）。
 *      出场规则快照进 plan.exitRules（decoratePlan 写入，智能退出默认关闭），
 *      持仓复核用 localProtectionReview（R 口径移动止损阶梯，方向对称）。
 *
 * 期望值依据（**必须先读**）：
 *   100 币 × 90 天 × 1m→15m、48 组参数（data/backtest/short-study-diag.json，脚本
 *   scripts/_short_study.mjs / _short_study_diag.mjs）：
 *     · 47/48 组净均值为正；市场同期 +12.75%（随机做空基准 −0.34%/笔）—— alpha 独立于 beta；
 *     · 剂量效应单调：W=1.5→4.5 单笔均值 +0.7%→+3.7%、PF 1.5→4.0；
 *     · 四个月切片全正、时间对半均正、去尾 5% 后 W≥2.5 仍正；
 *     · 默认参数取 W=2.5 / pull=0.5（稳健中间档），⚠️ 胜率仅 ~35%、中位数为负，
 *       连亏 8~10 笔是常态，仓位与回撤按此设计；90 天窗口只有一轮波动周期，先 shadow 验证。
 *
 * 参数化约定与 pinFadeAnalysis 一致：默认值只作为未传参时的兜底，
 * 策略级覆盖走 data/strategies.json 的 overrides（前端「策略管理」页）。
 */
import { averageTrueRange } from './shared/protectionReview.js';
import { PAPER_COSTS } from './research.js';

/** 规则强度说明（写进信号的 risk 字段，规则分数不是胜率） */
const RISK_NOTE = '冲高回落空是右偏形态：胜率约 33~43%、中位数为负、靠 3R/4.5R 大单撑均值，连亏 8~10 笔是常态。'
  + '100 币 × 90 天 15m 回测 47/48 组净均值为正（市场同期 +12.75% 逆风），详见 data/backtest/short-study-diag.json。'
  + '规则分数是信号强度，不是胜率。';

/** 参数默认值（字段与 PUMP_SHORT_PARAM_SCHEMA 一一对应） */
export const PUMP_SHORT_DEFAULTS = Object.freeze({
  // 信号过滤
  pumpAtrMin: 2.5,
  // ⚠️ 默认 76（不是研究版的 150）：实时自动化的行情窗口**固定 80 根** ——
  //   globalAutomation.getFreshMarket → prepareMarket({ limit: 80 })。
  //   引擎按可用根数截断并披露（回看 150 根在线上永远拿不到，等于策略永不触发）。
  lookbackBars: 76,
  minAtrPct: 0.0008,
  maxAtrPct: 0.08,
  skipGlitchRangeAtr: 8,
  // 入场与挂单
  pullbackAtr: 0.5,
  entryBandAtr: 0.3,
  validBars: 12,
  // 止盈止损（研究最优：buf=2ATR / tp=3R；激进档 buf=2 / tp=4.5R）
  takeProfitR: 3.0,
  stopBufferAtr: 2.0,
  minStopPct: 0.008,
  // 持仓约束（15m 根：96 根 = 24h，与研究 maxHold 一致；计划校验上限 120 根 = 30h）
  maxHoldBars: 96
});

const numSpec = (key, label, group, min, max, step, description) =>
  ({ key, label, group, type: 'number', default: PUMP_SHORT_DEFAULTS[key], min, max, step, description });

/**
 * 冲高回落空的参数模式（不含出场规则 —— 出场规则在 builtins.js 展开 EXIT_PARAM_SCHEMA）。
 */
export const PUMP_SHORT_PARAM_SCHEMA = Object.freeze([
  numSpec('pumpAtrMin', '冲高门槛（ATR）', 'filter', 0.5, 12, 0.1,
    '收盘价超出前 lookbackBars 根最高价的 ATR 倍数下限。2.5 = 稳健档；4.5 = 只做特大冲高（单笔均值更高但频率骤降）。'),
  numSpec('lookbackBars', '回看窗口（根）', 'filter', 20, 78, 1,
    '区间高点回看的 15m 根数。⚠️ 实时窗口固定 80 根，>78 会被截断到实际可用根数并写入信号披露。'),
  numSpec('minAtrPct', '波动率下限', 'filter', 0, 0.05, 0.0002, 'ATR/价格 下限；死水行情不做。15m 建议 ≥ 0.0008。'),
  numSpec('maxAtrPct', '波动率上限', 'filter', 0.001, 0.5, 0.001, 'ATR/价格 上限；极端波动（可能是真实崩盘启动）回避。'),
  numSpec('skipGlitchRangeAtr', '坏打印门槛（ATR）', 'filter', 2, 50, 1, '冲高当根振幅超过该倍数 ATR 视为坏打印，不出手。'),
  numSpec('pullbackAtr', '挂单回落深度（ATR）', 'entry', 0, 3, 0.05,
    '限价 = 冲高收盘价 − N×ATR。0.3 = 深度小、成交快；0.8 = 等更深回落、价格更好。'),
  numSpec('entryBandAtr', '入场区间半宽（ATR）', 'entry', 0, 2, 0.05, '计划的 entryMin/entryMax = 限价 ± N×ATR，仅用于计划校验与展示，限价单以 entryLimit 成交。'),
  numSpec('validBars', '挂单有效（根）', 'entry', 0, 48, 1, '冲高出现后维持同向建议的 15m 根数（12 根 = 3h）。0 = 只在冲高当根出手。'),
  numSpec('takeProfitR', '止盈（R）', 'protection', 1, 10, 0.1, '止盈 = 限价 − N×R。右偏形态：R 越大均值越高但胜率越低（研究 3R/4.5R 均可）。'),
  numSpec('stopBufferAtr', '止损缓冲（ATR）', 'risk', 0, 5, 0.1, '止损 = 冲高最高价 + N×ATR。研究最优 2.0。'),
  numSpec('minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001, 'R 的绝对下限，兜底成本约束。'),
  numSpec('maxHoldBars', '最长持仓（15m 根）', 'position', 10, 120, 1, '超时未触发的订单按收盘价结算。96 根 = 24h（计划校验上限 120 根 = 30h）。')
]);

/**
 * 解析策略参数：默认值为底，overrides 逐字段覆盖（越界回退默认并告警）。
 */
export function resolvePumpShortParams(overrides) {
  const params = { ...PUMP_SHORT_DEFAULTS };
  if (!overrides || typeof overrides !== 'object') return params;
  for (const spec of PUMP_SHORT_PARAM_SCHEMA) {
    const raw = overrides[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[spec.key] = value;
    else console.warn(`[pumpFadeShortAnalysis] 策略参数 ${spec.key}=${raw} 非法（需在 ${spec.min}~${spec.max}），回退默认值 ${spec.default}`);
  }
  return params;
}

const isFiniteCandle = r => r && ['open', 'high', 'low', 'close'].every(k => Number.isFinite(r[k]) && r[k] > 0)
  && r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close);

/** 滚动 ATR 序列（口径 = shared/protectionReview.averageTrueRange 的窗口版） */
function atrSeries(rows, period = 14) {
  const out = new Array(rows.length).fill(NaN);
  for (let i = period; i < rows.length; i++) out[i] = averageTrueRange(rows.slice(i - period, i + 1), period);
  return out;
}

/** 滚动区间高点（不含当根）：前 len 根的最高价 */
function rollingHigh(rows, idx, len) {
  let m = -Infinity;
  for (let k = Math.max(0, idx - len); k < idx; k++) if (rows[k].high > m) m = rows[k].high;
  return m;
}

/**
 * 冲高回落做空分析：返回与其它引擎同构的信号对象。
 * @param {{symbol:string, interval:string, klines:Array}} market  自动化主周期行情（1m）
 * @param {object} [ctx]  策略上下文：信号周期行情取 ctx.auxMarkets[信号周期]（信号周期 = ctx.planInterval || '15m'）；
 *   挂单复核路径（reviewPendingOrder）直接传入该周期行情（market.interval === 信号周期）。
 * @param {{feeBps?:number, slippageBps?:number, fundingBpsPer8h?:number}} [costs]
 */
export function pumpFadeShortAnalysis(market, ctx = {}, costs = PAPER_COSTS) {
  // 信号周期：优先策略声明的 planInterval（4h 做空由 builtins 传 ctx.planInterval），
  // 否则回退引擎原生默认 '15m'。⚠️ 绝不回退 ctx.interval / market.interval ——
  // 主周期行情恒为 1m，回退它等于把信号周期当成 1m，会让 15m 策略永不触发。
  const interval = ctx?.planInterval || '15m';
  const tfMin = interval === '4h' ? 240 : interval === '1h' ? 60 : interval === '30m' ? 30 : 15;
  // 行情来源：主周期就是该周期（订单复核）时直接用；否则取对应辅助周期行情。
  const source = market?.interval === interval
    ? market
    : (ctx?.auxMarkets && ctx.auxMarkets[interval]);
  const p = resolvePumpShortParams(ctx?.params);
  const rows = Array.isArray(source?.klines) ? source.klines : [];

  // 实际生效的回看窗口：不超过「可用根数 − 2」（给区间高点留历史）。
  // ⚠️ 必须按可用根数截断：实时窗口固定 80 根，硬性要求 150 根会让策略永不触发。
  const look = Math.min(Math.round(p.lookbackBars), Math.max(20, rows.length - 2));
  const clamped = look < Math.round(p.lookbackBars);
  const windowInfo = { interval, lookbackBars: look, configuredLookbackBars: p.lookbackBars,
    clamped, barsUsed: rows.length, dataAsOf: source?.dataAsOf || null };
  const wait = (reason, extra = {}) => ({
    symbol: market?.symbol, action: 'WAIT', confidence: 0, reason, risk: RISK_NOTE, plan: null,
    trend: windowInfo, ...extra
  });

  if (!source) {
    return wait(`未获取到 ${interval} 行情（needsAux=['${interval}'] 未就绪），本轮观望。`);
  }
  const needBars = Math.max(30, 16 + p.validBars);
  if (rows.length < needBars) {
    return wait(`冲高回落空需要至少 ${needBars} 根已收盘 ${interval} K 线，实际 ${rows.length} 根。`
      + `${clamped ? `（回看窗口配置 ${p.lookbackBars} 根，受 ${rows.length} 根行情窗口限制截断为 ${look} 根）` : ''}`);
  }

  const atrList = atrSeries(rows, 14);

  // 从当根往前找最近一次合格冲高（validBars=0 时只看当根）
  let pump = null;
  for (let back = 0; back <= p.validBars; back++) {
    const index = rows.length - 1 - back;
    if (index < 15) break;
    const row = rows[index];
    if (!isFiniteCandle(row)) continue;
    const atr = atrList[index];
    if (!(atr > 0)) continue;
    const atrPct = atr / row.close;
    if (atrPct < p.minAtrPct || atrPct > p.maxAtrPct) continue;
    const range = row.high - row.low;
    if (!(range > 0) || range / atr > p.skipGlitchRangeAtr) continue;
    const priorHigh = rollingHigh(rows, index, look);
    if (!Number.isFinite(priorHigh)) continue;
    const excess = row.close - priorHigh;
    const pumpAtr = excess / atr;
    if (pumpAtr < p.pumpAtrMin) continue;
    pump = { index, back, bar: row, atr, atrPct, priorHigh, pumpAtr, freshBars: back };
    break;
  }
  if (!pump) {
    return wait(`最近 ${p.validBars + 1} 根 ${interval} 内没有合格冲高（收盘价超出前 ${look} 根高点 `
      + `≥ ${p.pumpAtrMin}×ATR、振幅 ≤ ${p.skipGlitchRangeAtr}×ATR、ATR/价格 ∈ `
      + `[${(p.minAtrPct * 100).toFixed(2)}% ~ ${(p.maxAtrPct * 100).toFixed(1)}%]）。`);
  }

  const { bar, atr } = pump;
  // 挂空：吃冲高后的第一段回落（研究口径 entry = 冲高收盘 − pull×ATR）
  const entryLimit = bar.close - p.pullbackAtr * atr;
  // 止损：冲高最高价上方缓冲；R 受 minStopPct 绝对下限约束
  let stopDistance = (bar.high - entryLimit) + p.stopBufferAtr * atr;
  stopDistance = Math.max(stopDistance, p.minStopPct * entryLimit);
  const stopLoss = entryLimit + stopDistance;
  const takeProfit = entryLimit - p.takeProfitR * stopDistance;
  if (!(takeProfit > 0) || !(stopLoss > entryLimit)) {
    return wait('计划价格关系无效（止损未高于入场或止盈非正），不出手。');
  }

  // 成本后盈亏比闸门（与 research.normalizePlan 判定同源，成本 = 2×(费+滑) + 资金费）
  const hours = p.maxHoldBars * tfMin / 60;
  const costPct = (2 * (costs.feeBps + costs.slippageBps) + costs.fundingBpsPer8h * hours / 8) / 10000;
  const costAbs = entryLimit * costPct;
  const netReward = (entryLimit - takeProfit) - costAbs;
  const netRisk = (stopLoss - entryLimit) + costAbs;
  const netRewardRisk = netRisk > 0 ? netReward / netRisk : 0;
  const minTpR = stopDistance > 0 ? 1 + 2 * costAbs / stopDistance : Infinity;
  if (!(netRewardRisk >= 1)) {
    return wait(`成本后盈亏比 ${netRewardRisk.toFixed(2)} 低于 1（止盈 ${p.takeProfitR}R 太近，`
      + `当前止损距离 ${(stopDistance / entryLimit * 100).toFixed(3)}% 下需 ≥ ${minTpR.toFixed(2)}R），不出手。`);
  }

  const band = p.entryBandAtr * atr;
  const confidence = Math.min(0.95, 0.45 + 0.06 * (pump.pumpAtr - p.pumpAtrMin));
  const reason = `冲高回落空（${interval}）：${pump.freshBars === 0 ? '当根' : `${pump.freshBars} 根前`}收盘价超出前 ${look} 根高点 `
    + `${pump.pumpAtr.toFixed(2)}×ATR（冲高至 ${bar.high.toPrecision(6)}）`
    + `${clamped ? `（回看配置 ${p.lookbackBars} 根，受 ${rows.length} 根窗口限制截断为 ${look} 根）` : ''}；`
    + `在冲高收盘下方 ${p.pullbackAtr}ATR 挂限价空 ${entryLimit.toPrecision(6)} 等回落，`
    + `止损 ${stopLoss.toPrecision(6)}（冲高上方 ${p.stopBufferAtr}ATR / R=${(stopDistance / entryLimit * 100).toFixed(3)}%），`
    + `止盈 ${takeProfit.toPrecision(6)}（${p.takeProfitR}R，${interval} 持仓上限 ${p.maxHoldBars} 根 = ${(p.maxHoldBars * tfMin / 60).toFixed(0)}h），`
    + `成本后盈亏比 ${netRewardRisk.toFixed(2)}。`;

  return {
    symbol: market.symbol,
    action: 'SELL',
    confidence,
    reason,
    risk: RISK_NOTE,
    pumpBar: { index: pump.index, freshBars: pump.freshBars, pumpAtr: pump.pumpAtr, atrPct: pump.atrPct },
    trend: windowInfo,
    plan: {
      entryMin: entryLimit - band,
      entryMax: entryLimit + band,
      entryLimit,
      stopLoss,
      takeProfit,
      riskUnit: stopDistance,
      maxHoldBars: Math.round(p.maxHoldBars)
    }
  };
}
