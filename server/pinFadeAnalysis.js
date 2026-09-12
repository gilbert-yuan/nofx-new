/**
 * 插针回补引擎（Pin-bar Fade）
 * —— server/strategies/builtins.js 注册的第 5 个内置策略引擎（engine = 'pin'）
 *
 * 需求（2026-09-12 老板）：分析主流币种的插针特征，提前挂单，吃猛插大针的回调。
 *
 * 机制（**只做「下插针做多」**，因此天然满足 NOFX_LONG_ONLY 禁空政策；上插针做空未实现）：
 *   1. 识别插针 —— 已收盘的 1m K 线满足：
 *        · 下影线 ≥ wickAtrMin × ATR14（针够长）
 *        · 下影线 > wickBodyRatio × 实体（是针不是实体长阴）
 *        · 收盘位于当根区间上沿 ≥ closePosMin（针被打回，不是持续下跌）
 *        · 收盘价 > MA(trendMaPeriod)（趋势未坏，逆势接针胜率更低）
 *          ⚠️ 实时自动化窗口固定 80 根，趋势均线按可用根数截断（默认 60，落在窗口内）；
 *             截断会写进信号 reason 与 signal.trend，不做静默降级。
 *   2. 提前挂单 —— 在**下影线内部**挂限价买单：
 *        entryLimit = low + pullbackDepth × 影线长度
 *      价格回踩触及该价才成交（判定见 tradingSimulator._tryEntry），不追价、不改价；
 *      挂单有效期由「针后 validBars 根内持续给出同向建议」+ 全局挂单宽限 NOFX_PENDING_GRACE_MIN 共同决定。
 *   3. 出场 —— 止损 = low − stopBufferAtr × ATR（跌穿针脚即逻辑失效）；
 *      R = entryLimit − stopLoss，且不得低于 minStopPct × entryLimit（成本/R 约束）；
 *      止盈 = entryLimit + takeProfitR × R。
 *      出场规则快照进 plan.exitRules（由策略的 decoratePlan 写入），订单按自己的规则出场。
 *
 * ⚠️ 期望值实测（**必须先读**）：
 *   90 天 × 1m × 24 个主流币、560 组参数网格（data/backtest/pin-study.json，脚本 scripts/_pin_study.mjs）：
 *     · 扣费前毛收益为正的仅 4/560 组，最好也只有 +0.028%/笔；
 *     · 扣费后（22bps 往返）**全部为负**，中位数与时间样本外同样为负。
 *   结论：1m 插针后**没有可提取的方向性 alpha**（插针后 60 根的向上极值虽大于向下极值，
 *   但先向下后向上的路径会先打掉止损），**不是手续费吃掉的薄 edge，是本来就没有 edge**。
 *   因此该策略**默认不启用**，保留为可参数化、可对照实验的引擎。
 *   完整网格、逐币种分解与样本外切分见 data/backtest/pin-study.json。
 *
 * 参数化约定与 enhancedAnalysis 一致：默认值只作为**未传参时**的兜底（可被环境变量改），
 * 策略级覆盖走 data/strategies.json 的 overrides（前端「策略管理」页），分析函数内不读全局常量。
 */
import { averageTrueRange } from './shared/protectionReview.js';
import { PAPER_COSTS } from './research.js';

/**
 * 「主流币种」白名单 —— 只在这批标的上出手（majorsOnly=true 时生效）。
 * 为什么不按市值/成交量动态取：prefilter 的签名不接收策略参数，且动态取需要额外拉全市场
 * ticker（每轮数百次请求）。这里是**代码常量**，增删请直接改本数组。
 */
export const PIN_MAJOR_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'TRXUSDT',
  'LINKUSDT', 'LTCUSDT', 'DOTUSDT', 'BCHUSDT', 'SUIUSDT', 'AVAXUSDT', 'HBARUSDT', 'NEARUSDT',
  'ATOMUSDT', 'FILUSDT', 'ETCUSDT', 'OPUSDT', 'ARBUSDT', 'PEPEUSDT', 'SHIBUSDT', 'ICPUSDT',
  'APTUSDT', 'TONUSDT', 'UNIUSDT', 'AAVEUSDT', 'INJUSDT', 'TIAUSDT'
]);

const MAJOR_SET = new Set(PIN_MAJOR_SYMBOLS);

/** 规则强度说明（写进信号的 risk 字段，规则分数不是胜率） */
const RISK_NOTE = '插针回补是逆势均值回归：针脚被有效跌破即逻辑失效。规则分数是信号强度，不是胜率；'
  + '90 天 1m 回测（24 主流币、560 组参数网格）扣费后为负期望，详见 data/backtest/pin-study.json。';

/** 参数默认值（字段与 PIN_PARAM_SCHEMA 一一对应） */
export const PIN_DEFAULTS = Object.freeze({
  // 信号过滤
  majorsOnly: true,
  wickAtrMin: 3.0,
  wickBodyRatio: 1.5,
  closePosMin: 0.55,
  // ⚠️ 默认 60（不是 200）：实时自动化的行情窗口**固定 80 根** ——
  //   globalAutomation.getFreshMarket → prepareMarket({ limit: 80 })，
  // 配置超过窗口长度的均线周期既拿不到更多历史，还会让整条策略永不触发。
  // 回测脚本自己加载数千根 K 线，可以按需调大（引擎会把超出窗口的部分显式截断并披露）。
  trendMaPeriod: 60,
  minAtrPct: 0.0005,
  maxAtrPct: 0.08,
  skipGlitchRangeAtr: 8,
  // 入场与挂单
  pullbackDepth: 0.25,
  entryBandAtr: 0.3,
  validBars: 15,
  // 止盈止损
  takeProfitR: 2.5,
  // 风险
  stopBufferAtr: 0.2,
  minStopPct: 0.008,
  // 持仓约束
  maxHoldBars: 60
});

const numSpec = (key, label, group, min, max, step, description) =>
  ({ key, label, group, type: 'number', default: PIN_DEFAULTS[key], min, max, step, description });
const boolSpec = (key, label, group, description) =>
  ({ key, label, group, type: 'boolean', default: PIN_DEFAULTS[key], description });

/**
 * 插针回补策略的参数模式（不含出场规则 —— 出场规则在 builtins.js 里展开 EXIT_PARAM_SCHEMA，
 * 因为移动止损 / 智能退出 / 分批止盈是全策略共用的同一套 schema）。
 */
export const PIN_PARAM_SCHEMA = Object.freeze([
  boolSpec('majorsOnly', '仅主流币种', 'filter', `只交易内置白名单（${PIN_MAJOR_SYMBOLS.length} 个主流标的）；关闭则全市场扫描。`),
  numSpec('wickAtrMin', '插针长度门槛（ATR）', 'filter', 1, 12, 0.1, '下影线长度 ÷ ATR14 的下限。3 = 针长至少 3 倍 ATR。抬高=更极端的针、频率骤降。'),
  numSpec('wickBodyRatio', '影线/实体 下限', 'filter', 0.5, 8, 0.1, '下影线必须大于实体的该倍数，避免把「实体长阴」当成插针。'),
  numSpec('closePosMin', '收盘位置下限', 'filter', 0, 1, 0.05, '收盘价在当根 (high−low) 区间中的位置下限。0.55 = 必须收回区间上半部。'),
  numSpec('trendMaPeriod', '趋势均线周期', 'filter', 20, 400, 10, '只在收盘价高于该均线时做多（趋势未坏）。⚠️ 实时自动化的行情窗口固定 80 根，配置超过窗口长度的周期会被截断到实际可用根数并在信号原因里披露（默认 60，落在窗口内）。'),
  numSpec('minAtrPct', '波动率下限', 'filter', 0, 0.05, 0.0002, 'ATR/价格 下限；死水行情不做。0.0005 = 0.05%。'),
  numSpec('maxAtrPct', '波动率上限', 'filter', 0.001, 0.5, 0.001, 'ATR/价格 上限；极端波动（针可能是真实崩盘）回避。'),
  numSpec('skipGlitchRangeAtr', '坏打印门槛（ATR）', 'filter', 2, 50, 1, '单根振幅超过该倍数 ATR 视为交易所坏打印，当根不出手。'),
  numSpec('pullbackDepth', '挂单深度（影线比例）', 'entry', 0, 1.5, 0.05, '限价 = 针脚 + N×影线长度。0.25 = 挂在影线下四分之一处，越深越难成交但价格越好。'),
  numSpec('entryBandAtr', '入场区间半宽（ATR）', 'entry', 0, 2, 0.05, '计划里的 entryMin/entryMax = 限价 ± N×ATR，仅用于计划校验与展示，限价单以 entryLimit 成交。'),
  numSpec('validBars', '挂单有效（根）', 'entry', 0, 120, 1, '针出现后维持同向建议的根数。0 = 只在针当根出手（挂单寿命等于全局挂单宽限 NOFX_PENDING_GRACE_MIN）。'),
  numSpec('takeProfitR', '止盈（R）', 'protection', 1, 10, 0.1, '止盈 = 限价 ± N×R。低于「1 + 2×成本/R」会被计划校验的成本后盈亏比闸门挡掉（当前默认参数下需 ≥ 1.56R）。'),
  numSpec('stopBufferAtr', '止损缓冲（ATR）', 'risk', 0, 3, 0.05, '止损 = 针脚 − N×ATR；跌穿针脚即插针逻辑失效。'),
  numSpec('minStopPct', '最小止损（价格比例）', 'risk', 0, 0.05, 0.001, 'R 的绝对下限。1m 的 ATR≈0.08%，若不用 0.8% 兜底，22bps 往返成本会占掉 R 的 1/4 以上。'),
  numSpec('maxHoldBars', '最长持仓（根）', 'position', 10, 120, 1, '超时未触发的订单按收盘价结算（计划校验上限 120 根）。')
]);

/**
 * 解析策略参数：默认值为底，overrides 逐字段覆盖（越界回退默认并告警）。
 * 每次返回新对象，多币种并发分析互不影响。
 */
export function resolvePinParams(overrides) {
  const params = { ...PIN_DEFAULTS };
  if (!overrides || typeof overrides !== 'object') return params;
  for (const spec of PIN_PARAM_SCHEMA) {
    const raw = overrides[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (spec.type === 'boolean') {
      if (typeof raw === 'boolean') params[spec.key] = raw;
      else if (/^(true|1|yes)$/i.test(String(raw).trim())) params[spec.key] = true;
      else if (/^(false|0|no)$/i.test(String(raw).trim())) params[spec.key] = false;
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[spec.key] = value;
    else console.warn(`[pinFadeAnalysis] 策略参数 ${spec.key}=${raw} 非法（需在 ${spec.min}~${spec.max}），回退默认值 ${spec.default}`);
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

/**
 * 判定某一根 K 线是否为「合格的插针」，返回几何数据；不合格返回 null。
 * @param {object} row 该根 K 线
 * @param {number} atr 该根的 ATR14
 * @param {number} ma   该根的趋势均线
 * @param {object} p    已解析参数
 */
function classifyPin(row, atr, ma, p) {
  if (!isFiniteCandle(row) || !(atr > 0)) return null;
  const range = row.high - row.low;
  if (!(range > 0)) return null;
  // 交易所坏打印（细价标的偶发）：单根振幅异常大，不能当针
  if (range / atr > p.skipGlitchRangeAtr) return null;
  const wick = Math.min(row.open, row.close) - row.low;
  const body = Math.abs(row.close - row.open);
  const closePos = (row.close - row.low) / range;
  if (wick / atr < p.wickAtrMin) return null;
  if (!(wick > body * p.wickBodyRatio)) return null;
  if (closePos < p.closePosMin) return null;
  if (!(Number.isFinite(ma) && row.close > ma)) return null;
  return { wick, body, range, closePos, wickAtr: wick / atr };
}

/**
 * 插针回补分析：返回与其它引擎同构的信号对象。
 * @param {{symbol:string, interval:string, klines:Array}} market
 * @param {object} [overrides] 策略级参数覆盖
 * @param {{feeBps?:number, slippageBps?:number, fundingBpsPer8h?:number}} [costs]
 */
export function pinFadeAnalysis(market, overrides, costs = PAPER_COSTS) {
  const p = resolvePinParams(overrides);
  const rows = Array.isArray(market?.klines) ? market.klines : [];
  // 实际生效的均线周期：不超过「可用根数 − 2」（要给趋势判定留出历史）。
  // ⚠️ 这里**必须**是按可用根数截断的值：实时自动化窗口固定 80 根，若按配置值硬性要求
  //    202 根（trendMaPeriod=200），整条策略在线上会永远返回「K 线不够」而从不触发。
  const maPeriod = Math.min(Math.round(p.trendMaPeriod), Math.max(20, rows.length - 2));
  const maClamped = maPeriod < Math.round(p.trendMaPeriod);
  // 趋势均线信息挂到**每一个**返回（含 WAIT）：截断要始终可见，不能只在 BUY 分支披露。
  const trendInfo = { maPeriod, configuredMaPeriod: p.trendMaPeriod, clamped: maClamped, barsUsed: rows.length };
  const wait = (reason, extra = {}) => ({
    symbol: market?.symbol, action: 'WAIT', confidence: 0, reason, risk: RISK_NOTE, plan: null,
    trend: trendInfo, ...extra
  });

  if (p.majorsOnly && !MAJOR_SET.has(String(market?.symbol || '').toUpperCase())) {
    return wait(`插针回补仅交易主流币白名单，${market?.symbol} 不在名单内（可在策略参数里关闭 majorsOnly）。`);
  }
  // 只要求「ATR14 可用 + 回看窗口装得下」；趋势均线按可用根数**截断**而不是硬性要求，
  // 否则默认 60 根均线在 80 根窗口里只剩 18 根余量，一旦上游缩减窗口就会静默失效。
  const needBars = Math.max(30, 16 + p.validBars);
  if (rows.length < needBars) {
    return wait(`插针回补需要至少 ${needBars} 根已收盘 K 线，实际 ${rows.length} 根。`
      + `${maClamped ? `（趋势均线配置 ${p.trendMaPeriod} 根，受限截断为 ${maPeriod} 根）` : ''}`);
  }

  const atrList = atrSeries(rows, 14);
  const maAt = index => rows.slice(Math.max(0, index - maPeriod + 1), index + 1)
    .reduce((sum, r) => sum + r.close, 0) / Math.min(maPeriod, index + 1);

  // 从当根往前找最近一根合格插针（validBars=0 时只看当根）
  let pin = null;
  let pinIndex = -1;
  for (let back = 0; back <= p.validBars; back++) {
    const index = rows.length - 1 - back;
    if (index < 15) break;
    const atr = atrList[index];
    if (!(atr > 0)) continue;
    // 波动率区间：用「针那根」的 ATR 判断，避免死水/极端行情出手
    const atrPct = atr / rows[index].close;
    if (atrPct < p.minAtrPct || atrPct > p.maxAtrPct) continue;
    const found = classifyPin(rows[index], atr, maAt(index), p);
    if (found) { pin = { ...found, atr, atrPct, index, bar: rows[index], freshBars: back }; pinIndex = index; break; }
  }
  if (!pin) {
    return wait(`最近 ${p.validBars + 1} 根内没有合格插针（下影线 ≥ ${p.wickAtrMin}×ATR、`
      + `收盘位于区间 ${(p.closePosMin * 100).toFixed(0)}% 以上、且收盘价在 MA${maPeriod} 上方）。`);
  }

  const { bar, atr, wick } = pin;
  const low = bar.low;
  // 提前挂单：挂在影线内部，等回踩成交
  const entryLimit = low + p.pullbackDepth * wick;
  // 止损：针脚下方缓冲；R 再受 minStopPct 绝对下限约束
  let stopDistance = p.stopBufferAtr * atr + p.pullbackDepth * wick;
  stopDistance = Math.max(stopDistance, p.minStopPct * entryLimit);
  const stopLoss = entryLimit - stopDistance;
  const takeProfit = entryLimit + p.takeProfitR * stopDistance;

  // 成本后盈亏比闸门（与 research.normalizePlan 的判定同源）：
  // 成本 = 2×(手续费+滑点) + 资金费×(持仓小时/8)。低于 1 的计划会被计划校验直接作废，故提前拦下。
  const hours = p.maxHoldBars / 60;
  const costPct = (2 * (costs.feeBps + costs.slippageBps) + costs.fundingBpsPer8h * hours / 8) / 10000;
  const costAbs = entryLimit * costPct;
  const netReward = Math.abs(takeProfit - entryLimit) - costAbs;
  const netRisk = Math.abs(entryLimit - stopLoss) + costAbs;
  const netRewardRisk = netRisk > 0 ? netReward / netRisk : 0;
  const minTpR = stopDistance > 0 ? 1 + 2 * costAbs / stopDistance : Infinity;
  if (!(netRewardRisk >= 1)) {
    return wait(`成本后盈亏比 ${netRewardRisk.toFixed(2)} 低于 1（止盈 ${p.takeProfitR}R 太近，`
      + `当前止损距离 ${(stopDistance / entryLimit * 100).toFixed(3)}% 下需 ≥ ${minTpR.toFixed(2)}R），不出手。`);
  }

  const band = p.entryBandAtr * atr;
  const confidence = Math.min(0.95, 0.45
    + 0.06 * (pin.wickAtr - p.wickAtrMin)
    + 0.25 * Math.max(0, pin.closePos - p.closePosMin));
  const reason = `插针回补：${pin.freshBars === 0 ? '当根' : `${pin.freshBars} 根前`}收出下影线 `
    + `${pin.wickAtr.toFixed(2)}×ATR（影线/实体 ${(pin.wick / Math.max(pin.body, 1e-12)).toFixed(1)}），`
    + `收盘位于区间 ${(pin.closePos * 100).toFixed(0)}%，价在 MA${maPeriod} 上方`
    + `${maClamped ? `（配置 ${p.trendMaPeriod} 根，受 ${rows.length} 根行情窗口限制截断）` : ''}；`
    + `在影线内 ${(p.pullbackDepth * 100).toFixed(0)}% 处挂限价 ${entryLimit.toPrecision(6)} 等回踩，`
    + `止损 ${stopLoss.toPrecision(6)}（针脚下方 ${p.stopBufferAtr}ATR / R=${(stopDistance / entryLimit * 100).toFixed(3)}%），`
    + `止盈 ${takeProfit.toPrecision(6)}（${p.takeProfitR}R），成本后盈亏比 ${netRewardRisk.toFixed(2)}。`;

  return {
    symbol: market.symbol,
    action: 'BUY',
    confidence,
    reason,
    risk: RISK_NOTE,
    pinBar: { index: pinIndex, freshBars: pin.freshBars, wickAtr: pin.wickAtr, closePos: pin.closePos, atrPct: pin.atrPct },
    // 实际生效的趋势均线周期（配置值超出可用行情窗口时会被截断，此处如实披露）
    trend: trendInfo,
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
