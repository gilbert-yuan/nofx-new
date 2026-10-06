/**
 * 自动下单 / 账户回测的可调常量（单一事实源）。
 *
 * 未确认项使用下列默认值；改一项只改一项，再跑回测对比。
 * 环境变量同名覆盖（见 envNumber / envBool），方便单轮实验且不改文件。
 *
 * 待确认（当前默认）：
 *   1. 交易所 / 数据：Binance USDT-M 永续，公开 REST（www.binance.com / Demo）
 *   2. 回测区间 / 周期：近 90 天、15 分钟；语料 data/backtest/bf90-15mrs
 *   3. 成本：手续费 6bps、滑点 5bps、资金费 3bps/8h（与 PAPER_COSTS 一致）
 *   4. 策略：data/strategies.json 当前启用项（现为 h4-mean-reversion-v1）
 *      15m 回测默认 enhanced-trend-v1（该引擎主周期是 1m/15m，不是 4H）
 */
const envNumber = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
};
const envBool = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return /^(1|true|yes)$/i.test(String(raw).trim());
};

export const AUTO_TRADE = Object.freeze({
  exchange: 'binance',
  marketType: 'usdt-perp',
  venueNote: 'Binance USDⓈ-M 永续；下单仍走现有 Demo/实盘配置，本模块不改执行通道。',

  backtestDays: envNumber('NOFX_BT_DAYS', 90, 7, 730),
  interval: process.env.NOFX_BT_INTERVAL || '15m',
  corpusDir: process.env.NOFX_BT_DIR || 'data/backtest/bf90-15mrs',
  strategyId: process.env.NOFX_BT_STRATEGY || 'enhanced-trend-v1',
  analysisWindow: envNumber('NOFX_BT_WINDOW', 80, 30, 500),

  initialCapital: envNumber('NOFX_BT_CAPITAL', 100, 10, 1_000_000),
  feeBps: envNumber('NOFX_FEE_BPS', 6, 0, 100),
  slippageBps: envNumber('NOFX_SLIP_BPS', 5, 0, 100),
  fundingBpsPer8h: envNumber('NOFX_FUNDING_BPS', 3, 0, 100),

  // 初筛：24h 成交额、波动率、价差；触发时再核盘口深度与最低成交额
  screenEnabled: envBool('NOFX_LIQUIDITY_SCREEN', true),
  minQuoteVolume24h: envNumber('NOFX_MIN_QUOTE_VOL_24H', 5_000_000, 0, 1e12),
  minAtrPct: envNumber('NOFX_SCREEN_MIN_ATR_PCT', 0.002, 0, 1),
  maxAtrPct: envNumber('NOFX_SCREEN_MAX_ATR_PCT', 0.08, 0.001, 2),
  maxSpreadBps: envNumber('NOFX_MAX_SPREAD_BPS', 8, 0.1, 200),
  minBookNotional: envNumber('NOFX_MIN_BOOK_NOTIONAL', 200, 0, 1e9),
  bookLevels: envNumber('NOFX_BOOK_LEVELS', 5, 1, 50),
  minExchangeNotional: envNumber('NOFX_MIN_EXCHANGE_NOTIONAL', 5, 0, 1000),

  // 评分 → 杠杆 / 保证金。生产策略若已写 recommendedLeverage / autoMarginPct，
  // 仅在 scoreSizingEnabled 时覆盖；默认关，避免改写已回测过的 4H 档位。
  scoreSizingEnabled: envBool('NOFX_SCORE_SIZING', false),
  scoreFloor: envNumber('NOFX_SIZE_SCORE_FLOOR', 40, 0, 100),
  scoreCeil: envNumber('NOFX_SIZE_SCORE_CEIL', 90, 1, 100),
  minLeverage: envNumber('NOFX_SIZE_MIN_LEV', 1, 1, 50),
  maxLeverage: envNumber('NOFX_SIZE_MAX_LEV', 5, 1, 50),
  baseLeverage: envNumber('NOFX_SIZE_BASE_LEV', 2, 1, 50),
  minMarginPct: envNumber('NOFX_SIZE_MIN_MARGIN_PCT', 0.02, 0.001, 1),
  maxMarginPct: envNumber('NOFX_SIZE_MAX_MARGIN_PCT', 0.08, 0.001, 1),
  baseMarginPct: envNumber('NOFX_SIZE_BASE_MARGIN_PCT', 0.05, 0.001, 1),

  maxLossPct: envNumber('NOFX_MAX_LOSS_PCT', 0.02, 0.001, 0.2),
  maxPositions: envNumber('NOFX_MAX_POSITIONS', 10, 1, 100),
  maxTotalNotionalPct: envNumber('NOFX_MAX_TOTAL_NOTIONAL_PCT', 1.25, 0.1, 2),
  consecutiveLossHalt: envNumber('NOFX_CONSECUTIVE_LOSS_HALT', 4, 1, 50),
  consecutiveLossLookback: envNumber('NOFX_CONSECUTIVE_LOSS_LOOKBACK', 20, 1, 200)
});
