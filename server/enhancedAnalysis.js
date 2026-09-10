/**
 * 增强版本地分析引擎
 *
 * 集成指标：
 * 基础: 20/50均线, ATR
 * 动量: MACD, RSI
 * 波动: 布林带
 * 成交量: Volume分析
 * 支撑阻力: 动态识别
 *
 * 高级指标:
 * - Ichimoku Cloud (一目均衡表)
 * - DMI/ADX (方向指标)
 * - Supertrend (超级趋势)
 * - OBV (能量潮)
 * - CMF (资金流量)
 * - Williams %R
 */

import { request } from 'undici';
import {
  calculateIchimoku,
  calculateDMI,
  calculateSupertrend,
  calculateOBV,
  calculateCMF,
  calculateWilliamsR,
  calculateTrendScore
} from './advancedIndicators.js';
import { LONG_ONLY, TRAILING_RULE } from './shared/strategyGuards.js';

// ==================== P3 盈利改造：可调参数集中区（单点回滚） ====================
// 诊断依据（2231 笔已平仓实测，/api/paper/statistics）：胜率 22.5%，净盈亏比 1.24 →
// 期望值 = 0.225×1.24 − 0.775×1 = −0.49（每承担 1 单位风险净亏 0.49）。
// 盈亏平衡需要胜率 44.6%（不现实）或净盈亏比 ≥ 3.4，因此方向是"拉高盈亏比 + 砍掉低质量高频单"。
// 成本实测（非估算）：总毛收益 −869.1U，总净收益 −2168.9U，
// 即摩擦成本 1299.8U（手续费+滑点双边 22bps + 资金费 3bps/8h），均摊 0.583U/单。
// 结论：摩擦占净亏损的 60%，但毛收益本身也是负的（−869U）——
// 降频只能拿回约 60%，剩下 40% 必须靠拉高盈亏比（T1）解决，两者不可互相替代。

// 调参入口：下面几个关键常量支持环境变量覆盖（代码默认值不变，PM2 重启即生效，无需改代码）。
// 例：NOFX_MAIN_TP_R=4.0 NOFX_MIN_RR=2.2 NOFX_ENTRY_BAND_ATR=0.3 NOFX_MIN_TREND_SCORE=70
const numFromEnv = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[enhancedAnalysis] 环境变量 ${name}=${raw} 非法（需在 ${min}~${max}），回退默认值 ${fallback}`);
    return fallback;
  }
  return value;
};

// 主止盈风险倍数（R = riskUnit = 止损距离）。原主止盈取 2R（净盈亏比仅 1.24），
// 现提升到 3.5R。注意：止盈拉远会压低胜率，必须与 MIN_TREND_SCORE 一起观察；
// 若胜率跌破 ~18%，应先把此值回调到 3.0 再评估。
const MAIN_TP_R_MULTIPLE = numFromEnv('NOFX_MAIN_TP_R', 3.5, 1, 10);
// 分级止盈前两档（仅随 plan 透出做展示，实际下单只用 plan.takeProfit）
const TP1_R_MULTIPLE = 1.0;
const TP2_R_MULTIPLE = 2.0;
// 支撑/阻力位收窄止盈时的盈亏比下限：收窄后低于此值就放弃收窄。
// 原逻辑无条件把主止盈压到阻力位（实测压到 1.2R 也放行），是净盈亏比被压低的主因之一。
const SR_NARROW_MIN_RR = 2.5;
// 入场最低风险收益比（按"现价→主止盈 ÷ 现价→主止损"计算）。原门槛 1.2 过低，放行大量劣质单。
const MIN_RISK_REWARD_RATIO = numFromEnv('NOFX_MIN_RR', 2.5, 0, 10);
// 入场区间半宽（单位 ATR）。区间越宽，最不利入场价离止损越远 → 净盈亏比越低。
// 保持 0.5 不动（改小可继续抬高净盈亏比，但会明显降低成交率），留作单点调优旋钮。
const ENTRY_BAND_ATR = numFromEnv('NOFX_ENTRY_BAND_ATR', 0.5, 0, 2);
// 综合评分门槛（原 60 分）。提高是最直接的降频 + 提质量手段。
const MIN_TREND_SCORE = numFromEnv('NOFX_MIN_TREND_SCORE', 66, 0, 100);
// 成交量确认下限（量比）。原代码算出了 volumeConfirm 却从未使用，等于没有量能门槛。
const MIN_VOLUME_RATIO = 0.8;
// 是否强制要求成交量确认（关闭即回到无成交量门槛的旧行为）
const REQUIRE_VOLUME_CONFIRM = true;

// ── P4 胜率复盘新增：波动率下限 + 方向性 RSI 门槛（2026-09-10）──────────────────
// 诊断样本：2462 笔已平仓模拟订单（真实入场点，仅重算入场时特征）。
// 1) 波动率（ATR/价格）与均单净盈亏呈**单调**关系，是本轮最强的单因子：
//      <0.15% → -1.16U/单 | 0.15~0.25% → -1.32U/单 | 0.25~0.40% → -1.45U/单
//      ≥0.40% → -0.81U/单 | ≥0.50% → -0.48U/单 | ≥0.60% → +0.14U/单
//    机理：低波动=震荡市，趋势信号缺乏跟随性，进场即被均值回归打掉止损。
//    原下限 0.0005（0.05%）形同虚设（仅拦掉 113/460 个币），现抬到 0.30%。
//    通过率核对（1m 历史入场点）：≥0.20% 通过 82.7%，≥0.30% 通过 53.6%，
//    ≥0.35% 通过 43.8%，≥0.40% 通过 37.8% —— 取 0.30% 保留过半交易流量的同时
//    拿到大部分胜率收益。该闸门自带时段自适应：活跃时段通过 41%~69%，
//    死水时段（如 12:00 UTC 实测）只通过 7%，即"安静时不做单"。
// 2) RSI 同样单调：RSI≥45 → -1.15U/单，≥55 → -1.12U/单，≥60 → -0.95U/单。
//    因此多单门槛由 40 抬到 50，空单门槛由 60 收到 55（对称收紧"动能方向"）。
// 组合效果（1m & ATR≥0.35% & RSI≥50）：n=572，胜率 22.8%→29.5%，均单 -0.91→-0.20U。
// 调参：想更激进 → NOFX_MIN_ATR_PCT=0.004；交易过少 → 调回 0.0015。
// 回滚全部三项：NOFX_MIN_ATR_PCT=0.0005 NOFX_MIN_RSI_LONG=40 NOFX_MAX_RSI_SHORT=60
const MIN_ATR_PCT = numFromEnv('NOFX_MIN_ATR_PCT', 0.003, 0, 0.05);
// 波动率上限（原值 0.08 保持不变，极端行情直接回避）
const MAX_ATR_PCT = 0.08;
// 多单要求的最低 RSI（原 40）
const MIN_RSI_LONG = numFromEnv('NOFX_MIN_RSI_LONG', 50, 0, 100);
// 空单允许的最高 RSI（原 60）
const MAX_RSI_SHORT = numFromEnv('NOFX_MAX_RSI_SHORT', 55, 0, 100);
// ── P4 新增结束 ──────────────────────────────────────────────────────────────

// 持仓复核：盈利触发阈值（保持不变）
const TRAIL_PROFIT_TRIGGER = 0.02;
// 移动止损 / 顺势扩展止盈 / 盈亏平衡位参数 — 跨引擎共享常量（见 server/shared/strategyGuards.js）。
// 局部分解便于阅读：TRAIL_STOP_ATR=TRAILING_RULE.stopAtr, TRAIL_TP_ATR=TRAILING_RULE.extendTpAtr。
const TRAIL_STOP_ATR = TRAILING_RULE.stopAtr;
const TRAIL_TP_ATR = TRAILING_RULE.extendTpAtr;
// ==================== P3 可调参数集中区结束 ====================

// 计算EMA（指数移动平均）
function ema(data, period) {
  if (data.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

// 计算MACD（标准实现）
// 标准算法：MACD = EMA12 - EMA26，Signal = EMA9(MACD序列)，Histogram = MACD - Signal。
// 修复 P2-3：原代码用 closes.slice(-9) 只取最近 9 根 K 线算 MACD 子序列再 EMA(9)，与标准全序列 EMA 偏差大，
// signal 偏低、histogram 偏高，金叉/死叉判错。改为增量维护 EMA12/EMA26、构造完整 MACD 序列、再对 MACD 做 EMA(9)。
// 数据需求：closes.length >= 26 才能算第一根 MACD，< 35 时 EMA9 信号线样本不足返回 null（避免半截信号污染趋势评分）。
function calculateMACD(closes) {
  if (closes.length < 26) return null;

  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  const k9  = 2 / (9  + 1);

  // 用 SMA 初始化 EMA12 / EMA26（与既有 ema() 助手口径一致）
  let e12 = 0, e26 = 0;
  for (let i = 0; i < 26; i++) {
    if (i < 12) e12 += closes[i];
    e26 += closes[i];
  }
  e12 /= 12;
  e26 /= 26;

  // 推进 EMA12/EMA26，记录每个 i>=25 时刻的 MACD(i) = EMA12(i) - EMA26(i)
  const macdSeries = [];
  for (let i = 25; i < closes.length; i++) {
    // EMA12 从 i=12 开始增量更新；到达 i=25 时已包含 closes[0..25]
    if (i >= 12) e12 = closes[i] * k12 + e12 * (1 - k12);
    // EMA26 从 i=26 开始增量更新；i=25 时为 SMA 种子
    if (i >= 26) e26 = closes[i] * k26 + e26 * (1 - k26);
    macdSeries.push(e12 - e26);
  }

  if (macdSeries.length === 0) return null;

  const macdLine = macdSeries[macdSeries.length - 1];

  // 信号线至少需要 9 个 MACD 样本才能给出稳定的 EMA(9) 值
  if (macdSeries.length < 9) {
    return { macdLine, signalLine: null, histogram: null };
  }

  let signal = 0;
  for (let i = 0; i < 9; i++) signal += macdSeries[i];
  signal /= 9;
  for (let i = 9; i < macdSeries.length; i++) {
    signal = macdSeries[i] * k9 + signal * (1 - k9);
  }

  return { macdLine, signalLine: signal, histogram: macdLine - signal };
}

// 计算RSI
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

// 计算布林带
function calculateBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const mean = slice.reduce((sum, val) => sum + val, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: mean + stdDev * std,
    middle: mean,
    lower: mean - stdDev * std,
    bandwidth: (2 * stdDev * std) / mean
  };
}

// 成交量分析
function analyzeVolume(volumes) {
  if (volumes.length < 20) return null;

  const recent = volumes.slice(-5);
  const baseline = volumes.slice(-20, -5);

  const recentAvg = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  const baselineAvg = baseline.reduce((sum, v) => sum + v, 0) / baseline.length;

  const volumeRatio = recentAvg / baselineAvg;
  const trend = volumeRatio > 1.5 ? 'increasing' : volumeRatio < 0.7 ? 'decreasing' : 'stable';

  return { volumeRatio, trend, strong: volumeRatio > 1.8 };
}

// 寻找支撑阻力位
function findSupportResistance(klines) {
  if (klines.length < 50) return null;

  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);

  // 最近的高点和低点
  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow = Math.min(...lows.slice(-20));

  // 历史关键位（出现频率高的价格区域）
  const priceRanges = {};
  const binSize = (recentHigh - recentLow) / 20;

  klines.slice(-50).forEach(k => {
    const bin = Math.floor((k.high - recentLow) / binSize);
    priceRanges[bin] = (priceRanges[bin] || 0) + 1;
  });

  const keyLevels = Object.entries(priceRanges)
    .filter(([_, count]) => count >= 3)
    .map(([bin, count]) => ({
      price: recentLow + (Number(bin) + 0.5) * binSize,
      strength: count
    }))
    .sort((a, b) => b.strength - a.strength);

  return {
    resistance: keyLevels.filter(l => l.price > klines.at(-1).close)[0]?.price || recentHigh,
    support: keyLevels.filter(l => l.price < klines.at(-1).close).reverse()[0]?.price || recentLow,
    keyLevels
  };
}

// 趋势强度评分
function calculateTrendStrength(market) {
  let score = 0;
  const reasons = [];

  const rows = market.klines;
  const closes = rows.map(r => r.close);
  const highs = rows.map(r => r.high);
  const lows = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);

  // 基础指标权重总计：70分
  // 高级指标权重总计：30分
  // 总分：100分

  // 1. 均线排列 (20分)
  const ma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
  const ma50 = closes.slice(-50).reduce((sum, c) => sum + c, 0) / 50;
  const close = rows.at(-1).close;

  if (ma20 > ma50 && close > ma20) {
    score += 20;
    reasons.push('多头均线排列完美');
  } else if (ma20 < ma50 && close < ma20) {
    score += 20;
    reasons.push('空头均线排列完美');
  } else if (Math.abs(ma20 - ma50) < ma50 * 0.005) {
    reasons.push('均线纠缠，趋势不明');
  } else {
    score += 8;
    reasons.push('均线排列一般');
  }

  // 2. MACD (15分)
  const macd = calculateMACD(closes);
  if (macd) {
    if (Math.abs(macd.histogram) > Math.abs(closes[closes.length - 10] - closes[closes.length - 1]) * 0.002) {
      if (macd.histogram > 0 && macd.macdLine > macd.signalLine) {
        score += 15;
        reasons.push('MACD金叉且柱状图扩大');
      } else if (macd.histogram < 0 && macd.macdLine < macd.signalLine) {
        score += 15;
        reasons.push('MACD死叉且柱状图扩大');
      } else {
        score += 8;
        reasons.push('MACD信号中等');
      }
    } else {
      score += 5;
      reasons.push('MACD信号较弱');
    }
  }

  // 3. RSI (12分)
  const rsi = calculateRSI(closes);
  if (rsi !== null) {
    if (rsi > 50 && rsi < 70) {
      score += 12;
      reasons.push(`RSI健康多头区(${rsi.toFixed(1)})`);
    } else if (rsi < 50 && rsi > 30) {
      score += 12;
      reasons.push(`RSI健康空头区(${rsi.toFixed(1)})`);
    } else if (rsi >= 70) {
      score += 5;
      reasons.push(`RSI超买(${rsi.toFixed(1)})`);
    } else if (rsi <= 30) {
      score += 5;
      reasons.push(`RSI超卖(${rsi.toFixed(1)})`);
    } else {
      score += 8;
      reasons.push(`RSI中性(${rsi.toFixed(1)})`);
    }
  }

  // 4. 布林带 (10分)
  const bb = calculateBollinger(closes);
  if (bb) {
    const position = (close - bb.lower) / (bb.upper - bb.lower);
    if (position > 0.3 && position < 0.7) {
      score += 10;
      reasons.push('价格在布林带中轨');
    } else if (position > 0.8) {
      score += 6;
      reasons.push('价格接近布林带上轨');
    } else if (position < 0.2) {
      score += 6;
      reasons.push('价格接近布林带下轨');
    } else {
      score += 8;
      reasons.push('价格在布林带正常区域');
    }
  }

  // 5. 成交量 (13分)
  const volumeAnalysis = analyzeVolume(volumes);
  if (volumeAnalysis) {
    if (volumeAnalysis.strong) {
      score += 13;
      reasons.push(`成交量大幅放大(${volumeAnalysis.volumeRatio.toFixed(2)}倍)`);
    } else if (volumeAnalysis.trend === 'increasing') {
      score += 9;
      reasons.push(`成交量温和放大(${volumeAnalysis.volumeRatio.toFixed(2)}倍)`);
    } else if (volumeAnalysis.trend === 'stable') {
      score += 7;
      reasons.push('成交量平稳');
    } else {
      score += 3;
      reasons.push('成交量萎缩');
    }
  }

  // ========== 高级指标 (30分) ==========

  // 6. Ichimoku一目均衡表 (10分)
  try {
    const ichimoku = calculateIchimoku(highs, lows, closes);
    if (ichimoku) {
      const ichimokuScore = ichimoku.strength / 7; // 转换为10分制
      score += ichimokuScore;
      reasons.push(`Ichimoku${ichimoku.signal}(${ichimoku.strength}/70)`);
    }
  } catch (e) {
    // 数据不足，跳过
  }

  // 7. DMI/ADX趋势强度 (8分)
  try {
    const dmi = calculateDMI(highs, lows, closes);
    if (dmi) {
      if (dmi.trendStrength === 'STRONG') {
        score += 8;
        reasons.push(`ADX强趋势(${dmi.adx.toFixed(1)})`);
      } else if (dmi.trendStrength === 'MODERATE') {
        score += 5;
        reasons.push(`ADX中等趋势(${dmi.adx.toFixed(1)})`);
      } else {
        score += 2;
        reasons.push(`ADX弱趋势(${dmi.adx.toFixed(1)})`);
      }
    }
  } catch (e) {
    // 数据不足，跳过
  }

  // 8. Supertrend超级趋势 (7分)
  try {
    const supertrend = calculateSupertrend(highs, lows, closes);
    if (supertrend) {
      if (supertrend.trend === 'BULLISH' || supertrend.trend === 'BEARISH') {
        score += 7;
        reasons.push(`Supertrend${supertrend.trend}`);
      } else {
        score += 3;
        reasons.push('Supertrend中性');
      }
    }
  } catch (e) {
    // 数据不足，跳过
  }

  // 9. OBV能量潮 (5分)
  try {
    const obv = calculateOBV(closes, volumes);
    if (obv) {
      if (obv.signal === 'BULLISH' || obv.signal === 'BEARISH') {
        score += 5;
        reasons.push(`OBV${obv.trend}`);
      } else {
        score += 2;
        reasons.push('OBV中性');
      }
    }
  } catch (e) {
    // 数据不足，跳过
  }

  return { score, reasons, maxScore: 100 };
}

/**
 * 增强版本地分析
 */
export function enhancedAnalysis(market) {
  const rows = market.klines;
  const symbol = market.symbol;

  const wait = (reason, risks = [], trendScore = null) => ({
    symbol,
    action: 'WAIT',
    confidence: 0,
    reason,
    risk: risks.length ? risks.join(' ') : '市场条件不满足开仓要求。',
    plan: null,
    trendScore  // 添加趋势评分
  });

  // 最低数据要求
  if (rows.length < 50) {
    return wait('需要至少50根K线数据，当前数据不足。', ['数据不足，无法可靠分析。']);
  }

  // 基础数据提取
  const closes = rows.map(r => r.close);
  const highs = rows.map(r => r.high);
  const lows = rows.map(r => r.low);
  const volumes = rows.map(r => r.volume);
  const close = rows.at(-1).close;

  // 计算所有指标
  const ma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
  const ma50 = closes.slice(-50).reduce((sum, c) => sum + c, 0) / 50;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;

  const macd = calculateMACD(closes);
  const rsi = calculateRSI(closes);
  const bb = calculateBollinger(closes);
  const volumeAnalysis = analyzeVolume(volumes);
  const srLevels = findSupportResistance(rows);
  const trendStrength = calculateTrendStrength(market);

  // 波动率过滤（P0-2 加上限；P4 抬高下限）
  // 上限：极端行情直接回避；下限：死水/震荡行情不做趋势单（详见文件顶部 P4 参数区）。
  const volatility = atr / close;
  if (volatility > MAX_ATR_PCT) {
    return wait(
      `波动率过高（>${(MAX_ATR_PCT * 100).toFixed(0)}%），等待市场稳定。`,
      [`当前波动率${(volatility * 100).toFixed(2)}%，风险极大。`],
      trendStrength
    );
  }
  if (volatility < MIN_ATR_PCT) {
    return wait(
      `波动率过低（${(volatility * 100).toFixed(3)}% < ${(MIN_ATR_PCT * 100).toFixed(2)}%），震荡市不做趋势单。`,
      [`当前波动率${(volatility * 100).toFixed(3)}%，趋势信号缺乏跟随性，容易被均值回归反复打掉止损。`],
      trendStrength
    );
  }

  // 趋势判断
  const isBullish = ma20 > ma50 && close > ma20;
  const isBearish = ma20 < ma50 && close < ma20;

  // 趋势不明
  if (Math.abs(ma20 - ma50) < atr * 0.3) {
    return wait(
      '均线纠缠，趋势不明确，等待突破方向。',
      ['均线距离小于0.3倍ATR，缺乏明确趋势。'],
      trendStrength
    );
  }

  // MACD确认
  let macdConfirm = false;
  if (macd) {
    if (isBullish && macd.histogram > 0) macdConfirm = true;
    if (isBearish && macd.histogram < 0) macdConfirm = true;
  }

  // RSI过滤（P4：多单门槛 40→MIN_RSI_LONG(50)，空单门槛 60→MAX_RSI_SHORT(55)，
  // 只在「动能方向与信号一致」时入场；实测 RSI 与胜率单调正相关）
  let rsiWarning = '';
  if (rsi !== null) {
    if (rsi > 70) rsiWarning = 'RSI超买，注意回调风险';
    if (rsi < 30) rsiWarning = 'RSI超卖，注意反弹风险';
    if (isBullish && rsi < MIN_RSI_LONG) return wait(`多头信号但RSI偏弱（${rsi.toFixed(1)} < ${MIN_RSI_LONG}），等待动能确认。`, [rsiWarning]);
    if (isBearish && rsi > MAX_RSI_SHORT) return wait(`空头信号但RSI偏强（${rsi.toFixed(1)} > ${MAX_RSI_SHORT}），等待动能确认。`, [rsiWarning]);
    // 空头且RSI超卖=在下跌末端追空（历史回放胜率仅25.6%，平均亏损最大），放弃。
    if (isBearish && rsi < 30) return wait('空头信号但RSI超卖，避免在下跌末端追空。', [rsiWarning]);
  }

  // 成交量确认（原代码算出了 volumeConfirm 却从未使用，等于没有量能门槛；
  // 无成交量数据时视为通过，避免因数据缺失把全部信号误杀）
  const volumeConfirm = volumeAnalysis ? volumeAnalysis.volumeRatio > MIN_VOLUME_RATIO : true;
  if (REQUIRE_VOLUME_CONFIRM && !volumeConfirm) {
    return wait(
      `成交量不足（量比${volumeAnalysis ? volumeAnalysis.volumeRatio.toFixed(2) : 'n/a'} < ${MIN_VOLUME_RATIO}），等待量能确认。`,
      ['量能低于基线，突破缺乏承接，容易假突破。'],
      trendStrength
    );
  }

  // 放量追势过滤：近期量能放大到基线1.2倍以上时，1分钟级别追入
  // 极易被均值回归打掉止损（历史回放：量比>=1.2的订单胜率27%~33%，明显低于低量订单的36%）。
  if (volumeAnalysis && volumeAnalysis.volumeRatio >= 1.2) {
    return wait(
      `近期成交量放大至基线${volumeAnalysis.volumeRatio.toFixed(2)}倍，避免放量追势。`,
      ['等待量能回落后再评估入场。'],
      trendStrength
    );
  }

  // 综合评分过滤（门槛由 MIN_TREND_SCORE 控制，原值 60；提高到 66 用于降频 + 提质量）
  if (trendStrength.score < MIN_TREND_SCORE) {
    return wait(
      `综合信号强度不足（${trendStrength.score}/100 < ${MIN_TREND_SCORE}），等待更强信号。`,
      [`当前评分：${trendStrength.reasons.join('; ')}`],
      trendStrength
    );
  }

  // 确定方向
  let direction = null;
  if (isBullish && (macdConfirm || trendStrength.score >= 70)) {
    direction = 'long';
  } else if (isBearish && (macdConfirm || trendStrength.score >= 70)) {
    direction = 'short';
  } else {
    return wait(
      '缺少关键确认信号，等待。',
      ['建议等待更多确认信号后再入场。'],
      trendStrength
    );
  }

  // 本地规则引擎默认双向；显式配置只做多时统一拦截空头。
  if (LONG_ONLY.enabled && direction === 'short') {
    return wait(LONG_ONLY.reason, [], trendStrength);
  }

  // 追高/追空过滤：价格偏离20均线超过1.5倍ATR时放弃入场，等待回调。
  // 历史复盘显示顺势追入的订单多在数分钟内被均值回归打掉止损。
  const extension = (close - ma20) / atr;
  if (direction === 'long' && extension > 1.5) {
    return wait(
      `价格偏离20均线上方超过1.5 ATR（${extension.toFixed(2)}），避免追高。`,
      ['建议等待价格回调至均线附近再入场。'],
      trendStrength
    );
  }
  if (direction === 'short' && extension < -1.5) {
    return wait(
      `价格偏离20均线下方超过1.5 ATR（${extension.toFixed(2)}），避免追空。`,
      ['建议等待价格反弹至均线附近再入场。'],
      trendStrength
    );
  }

  // 计算入场区间（半宽由 ENTRY_BAND_ATR 控制）
  const entryMin = close - atr * ENTRY_BAND_ATR;
  const entryMax = close + atr * ENTRY_BAND_ATR;

  // 动态止损止盈（基于ATR和支撑阻力）
  let stopLoss, takeProfit1, takeProfit2, takeProfit3;

  // 噪声保护：止损距离取 2倍ATR 与 0.8% 价格距离的较大值。
  // 历史复盘（2143笔已平仓）显示旧方案平均止损距离仅0.57%（1m ATR级别），
  // 88.7%订单被止损、其中55%在入场几分钟内0次修改即被噪声扫出，胜率仅22.6%。
  const riskUnit = Math.max(atr * 2.0, close * 0.008);

  // 以现价为基准的盈亏比：|现价→目标| ÷ |现价→止损|
  //
  // 【口径变更 · 重要】本字段语义自 P3 起改为「现价→主止盈 ÷ 现价→止损」，
  // 与 2025 年之前历史订单里 riskRewardRatio≈1.33 的旧口径**不可直接比较**：
  // 旧公式以 entryMax（最不利入场价）为基准，把入场区间宽度（1 个 ATR）也计入风险，
  // 分母 = 入场带宽 + riskUnit，分子只算到 2R 止盈，因此 2R 只能算出 1.33、3.5R 也只到 2.33；
  // 新公式分母 = 现价到止损的距离，3.5R 对应约 3.0。
  // 变更原因：保留旧口径时，MIN_RISK_REWARD_RATIO=2.5 会把所有信号挡死（0 开单）。
  // 若需与历史订单的 RR 做同口径对比，请改用 plan 里的净盈亏比（research.js 的 netRewardRisk）。
  const rrFromClose = target => {
    const risk = Math.abs(close - stopLoss);
    return risk > 0 ? Math.abs(target - close) / risk : 0;
  };

  if (direction === 'long') {
    stopLoss = entryMin - riskUnit;

    // 多级止盈：按风险单位等比设置，主止盈（takeProfit3）提到 MAIN_TP_R_MULTIPLE 倍 R
    takeProfit1 = entryMax + riskUnit * TP1_R_MULTIPLE;
    takeProfit2 = entryMax + riskUnit * TP2_R_MULTIPLE;
    takeProfit3 = entryMax + riskUnit * MAIN_TP_R_MULTIPLE;

    // 使用阻力位收窄止盈：只允许收窄到更近的阻力位，且收窄后盈亏比不得低于 SR_NARROW_MIN_RR，
    // 否则放弃收窄、保留原主止盈（旧的无条件收窄会把 3.5R 压到 1.x R）。
    if (srLevels && Number.isFinite(srLevels.resistance)
      && srLevels.resistance < takeProfit3 && srLevels.resistance > takeProfit1) {
      const narrowedTakeProfit = srLevels.resistance + riskUnit;
      if (rrFromClose(narrowedTakeProfit) >= SR_NARROW_MIN_RR) {
        takeProfit2 = srLevels.resistance;
        takeProfit3 = narrowedTakeProfit;
      }
    }
  } else {
    stopLoss = entryMax + riskUnit;

    takeProfit1 = entryMin - riskUnit * TP1_R_MULTIPLE;
    takeProfit2 = entryMin - riskUnit * TP2_R_MULTIPLE;
    takeProfit3 = entryMin - riskUnit * MAIN_TP_R_MULTIPLE;

    // 使用支撑位收窄止盈：同样要求收窄后盈亏比不低于 SR_NARROW_MIN_RR
    if (srLevels && Number.isFinite(srLevels.support)
      && srLevels.support > takeProfit3 && srLevels.support < takeProfit1) {
      const narrowedTakeProfit = srLevels.support - riskUnit;
      if (rrFromClose(narrowedTakeProfit) >= SR_NARROW_MIN_RR) {
        takeProfit2 = srLevels.support;
        takeProfit3 = narrowedTakeProfit;
      }
    }
  }

  // 计算风险收益比（主止盈口径；riskDistance 仍按最不利入场价用于推荐杠杆）
  const worstEntry = direction === 'long' ? entryMax : entryMin;
  const riskDistance = Math.abs(worstEntry - stopLoss) / worstEntry;
  const riskRewardRatio = rrFromClose(takeProfit3);

  // 风险收益比过滤（门槛由 MIN_RISK_REWARD_RATIO 控制，旧值 1.2 过低）
  if (riskRewardRatio < MIN_RISK_REWARD_RATIO) {
    return wait(
      `风险收益比不足（${riskRewardRatio.toFixed(2)}:1 < ${MIN_RISK_REWARD_RATIO}:1），等待更好位置。`,
      ['建议等待回调或突破至更优风险收益位置。']
    );
  }

  // 推荐杠杆（保守）
  const recommendedLeverage = Math.max(1, Math.min(5, Math.floor(0.08 / riskDistance)));

  // 置信度（基于综合评分）
  const confidence = Math.min(0.90, 0.60 + trendStrength.score / 250);

  // 组装信号
  return {
    symbol,
    action: direction === 'long' ? 'BUY' : 'SELL',
    confidence,
    reason: `增强分析(${trendStrength.score}/100分)：${trendStrength.reasons.slice(0, 3).join('；')}`,
    risk: [
      rsiWarning,
      `波动率${(volatility * 100).toFixed(2)}%`,
      `风险收益比${riskRewardRatio.toFixed(2)}:1`,
      `推荐杠杆${recommendedLeverage}x`
    ].filter(Boolean).join('；'),
    plan: {
      entryMin,
      entryMax,
      stopLoss,
      // 主止盈改用 3.5R 档（原为 2R 档）。2R 时净盈亏比仅 1.24，在 22.7% 胜率下
      // 期望值为负；3.5R 是"胜率不至于崩塌"与"盈亏比足够"之间的折中。
      takeProfit: takeProfit3,
      takeProfit1,
      takeProfit2,
      takeProfit3,
      // P4 周期回退：主周期已由 5m 回退到 1m（见 research.js MAIN_INTERVAL），
      // 根数须同步还原，否则 6 分钟入场窗口会缩成 2 分钟、2 小时持仓上限会缩成 24 分钟。
      // 6根@1m=6min 入场窗口；120根@1m=2h 持仓上限（与 5m 时代的 2根/24根 等时）。
      validForBars: 6,
      maxHoldBars: 120,
      riskRewardRatio,
      recommendedLeverage,
      trendStrengthScore: trendStrength.score,
      indicators: {
        ma20,
        ma50,
        atr,
        rsi,
        macd: macd ? { histogram: macd.histogram } : null,
        bollinger: bb,
        volumeRatio: volumeAnalysis?.volumeRatio,
        support: srLevels?.support,
        resistance: srLevels?.resistance
      }
    }
  };
}

/**
 * 增强版持仓复核
 */
export function enhancedProtectionReview(order, market) {
  const rows = market.klines;
  if (rows.length < 30) {
    return { action: 'HOLD', reason: '数据不足，保留当前保护价格。' };
  }

  const close = rows.at(-1).close;
  const long = order.direction === 'OPEN_LONG';

  // 重新计算技术指标
  const closes = rows.map(r => r.close);
  const ma20 = closes.slice(-20).reduce((sum, c) => sum + c, 0) / 20;
  const atr = rows.slice(-14).reduce((sum, r, i) => {
    const previous = rows[rows.length - 15 + i].close;
    return sum + Math.max(r.high - r.low, Math.abs(r.high - previous), Math.abs(r.low - previous));
  }, 0) / 14;

  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const trendStrength = calculateTrendStrength(market);

  // 评估当前趋势
  const trendValid = long ? (close > ma20) : (close < ma20);
  const profit = long ? (close - order.entry) / order.entry : (order.entry - close) / order.entry;

  // 检查是否应该提前退出
  let shouldExit = false;
  let exitReason = '';

  // 1. 趋势反转（更严格的条件）
  if (!trendValid && Math.abs(close - ma20) > atr * 1.0 && profit < 0.05) {
    shouldExit = true;
    exitReason = '均线失守且未盈利超过5%，趋势可能反转';
  }

  // 2. RSI极值（更严格）
  if (rsi !== null) {
    if (long && rsi > 80 && profit > 0.05) {
      shouldExit = true;
      exitReason = `RSI严重超买(${rsi.toFixed(1)})且已盈利5%+，建议获利了结`;
    }
    if (!long && rsi < 20 && profit > 0.05) {
      shouldExit = true;
      exitReason = `RSI严重超卖(${rsi.toFixed(1)})且已盈利5%+，建议获利了结`;
    }
  }

  // 3. MACD背离（需要更多盈利）
  if (macd && profit > 0.05) {
    if (long && macd.histogram < 0 && close > order.entry * 1.05) {
      shouldExit = true;
      exitReason = 'MACD死叉，盈利5%+，建议止盈';
    }
    if (!long && macd.histogram > 0 && close < order.entry * 0.95) {
      shouldExit = true;
      exitReason = 'MACD金叉，盈利5%+，建议止盈';
    }
  }

  // 如果应该退出，返回市价平仓建议
  if (shouldExit) {
    return {
      action: 'CLOSE',
      reason: exitReason,
      closePrice: close,
      confidence: 0.80
    };
  }

  // 动态止损（移动止损）
  let newStopLoss = order.plan.stopLoss;
  let newTakeProfit = order.plan.takeProfit;

  if (profit > TRAIL_PROFIT_TRIGGER) {
    // 盈利超过阈值，启用移动止损（距离参数化，见文件顶部 P3 参数区）
    if (long) {
      // 多头：止损移至成本或盈利保护位
      const breakEvenStop = order.entry + atr * 0.2;
      const trailingStop = close - atr * TRAIL_STOP_ATR;  // P0-1 一致性：移动止损距离放宽到 2.5 ATR
      newStopLoss = Math.max(order.plan.stopLoss, breakEvenStop, trailingStop);

      // 动态扩展止盈（只放宽不收紧：主止盈已是 3.5R，close+3ATR 通常低于它，取 max 后保持不变）
      newTakeProfit = Math.max(order.plan.takeProfit, close + atr * TRAIL_TP_ATR);
    } else {
      // 空头：止损移至成本或盈利保护位
      const breakEvenStop = order.entry - atr * 0.2;
      const trailingStop = close + atr * TRAIL_STOP_ATR;  // P0-1 一致性：移动止损距离放宽到 2.5 ATR
      newStopLoss = Math.min(order.plan.stopLoss, breakEvenStop, trailingStop);

      // 动态扩展止盈
      newTakeProfit = Math.min(order.plan.takeProfit, close - atr * TRAIL_TP_ATR);
    }
  } else {
    // 未盈利超过2%：保持初始保护价格，不再收紧止损。
    // 历史复盘显示旧逻辑在未盈利时按 close±1.8ATR 持续收紧止损，
    // 会把初始止损棘轮式推向现价，入场几分钟内即被1m噪声扫出。
    return {
      action: 'HOLD',
      reason: '持仓未盈利超过2%，保持初始保护价格，避免噪声止损。',
      trendScore: trendStrength.score
    };
  }

  // 验证止损是否收紧
  const stopTightened = long ? newStopLoss > order.plan.stopLoss : newStopLoss < order.plan.stopLoss;

  if (!stopTightened) {
    return {
      action: 'HOLD',
      reason: '当前位置无需调整，保持原保护价格。',
      trendScore: trendStrength.score
    };
  }

  return {
    action: 'UPDATE_PROTECTION',
    stopLoss: newStopLoss,
    takeProfit: newTakeProfit,
    confidence: 0.75,
    reason: profit > 0.02
      ? `已盈利${(profit * 100).toFixed(2)}%，启用移动止损保护盈利`
      : `按最新ATR(${atr.toFixed(2)})调整，趋势评分${trendStrength.score}/100`,
    trendScore: trendStrength.score,
    profitPercent: profit * 100
  };
}
