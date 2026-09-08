/**
 * 高级技术指标库
 *
 * 新增指标：
 * 1. Ichimoku Cloud (一目均衡表) - 综合趋势判断
 * 2. DMI/ADX (方向指标/平均趋向指数) - 趋势强度
 * 3. Parabolic SAR - 趋势跟踪止损
 * 4. Supertrend - 超级趋势指标
 * 5. VWAP (成交量加权平均价) - 日内重要支撑阻力
 * 6. OBV (能量潮) - 成交量趋势
 * 7. CMF (蔡金资金流量) - 资金流向
 * 8. Fisher Transform - 价格转换指标
 * 9. Hull MA (赫尔移动平均) - 低延迟均线
 * 10. Keltner Channel - 凯特纳通道
 * 11. Donchian Channel - 唐奇安通道
 * 12. Williams %R - 威廉指标
 */

// ==================== 趋势判断指标 ====================

/**
 * Ichimoku Cloud (一目均衡表)
 * 最强大的趋势判断系统之一
 */
export function calculateIchimoku(highs, lows, closes) {
  if (highs.length < 52) return null;

  const tenkanPeriod = 9;   // 转换线
  const kijunPeriod = 26;   // 基准线
  const senkouBPeriod = 52; // 先行带B

  // 转换线 = (9日最高 + 9日最低) / 2
  const tenkanSen = (
    Math.max(...highs.slice(-tenkanPeriod)) +
    Math.min(...lows.slice(-tenkanPeriod))
  ) / 2;

  // 基准线 = (26日最高 + 26日最低) / 2
  const kijunSen = (
    Math.max(...highs.slice(-kijunPeriod)) +
    Math.min(...lows.slice(-kijunPeriod))
  ) / 2;

  // 先行带A = (转换线 + 基准线) / 2，向前移26期
  const senkouSpanA = (tenkanSen + kijunSen) / 2;

  // 先行带B = (52日最高 + 52日最低) / 2，向前移26期
  const senkouSpanB = (
    Math.max(...highs.slice(-senkouBPeriod)) +
    Math.min(...lows.slice(-senkouBPeriod))
  ) / 2;

  // 滞后线 = 收盘价，向后移26期
  const chikouSpan = closes[closes.length - 26];

  const currentPrice = closes[closes.length - 1];

  // 判断趋势
  let signal = 'NEUTRAL';
  let strength = 0;

  // 价格在云上方 = 看涨
  if (currentPrice > Math.max(senkouSpanA, senkouSpanB)) {
    signal = 'BULLISH';
    strength += 30;

    // 转换线 > 基准线 = 强看涨
    if (tenkanSen > kijunSen) strength += 20;

    // 滞后线 > 价格 = 更强
    if (chikouSpan && chikouSpan > closes[closes.length - 26]) strength += 20;
  }
  // 价格在云下方 = 看跌
  else if (currentPrice < Math.min(senkouSpanA, senkouSpanB)) {
    signal = 'BEARISH';
    strength += 30;

    if (tenkanSen < kijunSen) strength += 20;
    if (chikouSpan && chikouSpan < closes[closes.length - 26]) strength += 20;
  }

  return {
    tenkanSen,      // 转换线
    kijunSen,       // 基准线
    senkouSpanA,    // 先行带A
    senkouSpanB,    // 先行带B
    chikouSpan,     // 滞后线
    signal,         // BULLISH/BEARISH/NEUTRAL
    strength,       // 0-70
    cloudThickness: Math.abs(senkouSpanA - senkouSpanB),
    description: `一目均衡表: ${signal}, 强度${strength}/70`
  };
}

/**
 * DMI + ADX (方向运动指标 + 平均趋向指数)
 * 判断趋势方向和强度
 */
export function calculateDMI(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;

  const plusDM = [];
  const minusDM = [];
  const tr = [];

  // 计算+DM, -DM和TR
  for (let i = 1; i < highs.length; i++) {
    const highDiff = highs[i] - highs[i - 1];
    const lowDiff = lows[i - 1] - lows[i];

    plusDM.push(highDiff > 0 && highDiff > lowDiff ? highDiff : 0);
    minusDM.push(lowDiff > 0 && lowDiff > highDiff ? lowDiff : 0);

    const trueRange = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr.push(trueRange);
  }

  // 计算平滑后的值
  const smoothPlusDM = plusDM.slice(-period).reduce((sum, v) => sum + v, 0);
  const smoothMinusDM = minusDM.slice(-period).reduce((sum, v) => sum + v, 0);
  const smoothTR = tr.slice(-period).reduce((sum, v) => sum + v, 0);

  // 计算+DI和-DI
  const plusDI = (smoothPlusDM / smoothTR) * 100;
  const minusDI = (smoothMinusDM / smoothTR) * 100;

  // 计算ADX
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

  // 简化ADX计算（实际应该用移动平均）
  const adx = dx; // 这里简化了，完整版应该用DX的EMA

  // 判断趋势
  let signal = 'NEUTRAL';
  let trendStrength = 'WEAK';

  if (adx > 25) {
    trendStrength = 'STRONG';
    if (plusDI > minusDI) signal = 'BULLISH';
    else signal = 'BEARISH';
  } else if (adx > 20) {
    trendStrength = 'MODERATE';
    if (plusDI > minusDI) signal = 'BULLISH';
    else signal = 'BEARISH';
  }

  return {
    plusDI,
    minusDI,
    adx,
    signal,
    trendStrength,
    description: `ADX: ${adx.toFixed(1)} (${trendStrength}), 方向: ${signal}`
  };
}

/**
 * Parabolic SAR (抛物线转向指标)
 * 趋势跟踪止损点
 */
export function calculateParabolicSAR(highs, lows, closes, acceleration = 0.02, maximum = 0.2) {
  if (highs.length < 5) return null;

  let sar = lows[0];
  let ep = highs[0]; // 极点价
  let af = acceleration; // 加速因子
  let trend = 1; // 1=上升趋势, -1=下降趋势

  const close = closes[closes.length - 1];

  // 简化计算，只返回当前SAR
  if (trend === 1) {
    sar = sar + af * (ep - sar);
    if (close < sar) {
      trend = -1;
      sar = ep;
      ep = lows[lows.length - 1];
      af = acceleration;
    }
  } else {
    sar = sar - af * (sar - ep);
    if (close > sar) {
      trend = 1;
      sar = ep;
      ep = highs[highs.length - 1];
      af = acceleration;
    }
  }

  return {
    sar,
    trend: trend === 1 ? 'BULLISH' : 'BEARISH',
    signal: trend === 1 && close > sar ? 'BUY' : trend === -1 && close < sar ? 'SELL' : 'HOLD',
    description: `SAR: ${sar.toFixed(2)} (${trend === 1 ? '多头' : '空头'})`
  };
}

/**
 * Supertrend (超级趋势)
 * 简单有效的趋势指标
 */
export function calculateSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
  if (highs.length < period) return null;

  // 计算ATR
  const atr = closes.slice(-period).reduce((sum, close, i) => {
    if (i === 0) return sum;
    const tr = Math.max(
      highs[highs.length - period + i] - lows[lows.length - period + i],
      Math.abs(highs[highs.length - period + i] - closes[closes.length - period + i - 1]),
      Math.abs(lows[lows.length - period + i] - closes[closes.length - period + i - 1])
    );
    return sum + tr;
  }, 0) / period;

  const hl2 = (highs[highs.length - 1] + lows[lows.length - 1]) / 2;
  const close = closes[closes.length - 1];

  const upperBand = hl2 + multiplier * atr;
  const lowerBand = hl2 - multiplier * atr;

  // 简化判断
  const trend = close > lowerBand ? 'BULLISH' : close < upperBand ? 'BEARISH' : 'NEUTRAL';
  const support = lowerBand;
  const resistance = upperBand;

  return {
    upperBand,
    lowerBand,
    trend,
    support,
    resistance,
    atr,
    signal: trend === 'BULLISH' ? 'BUY' : trend === 'BEARISH' ? 'SELL' : 'HOLD',
    description: `Supertrend: ${trend}, 支撑${lowerBand.toFixed(2)}, 阻力${upperBand.toFixed(2)}`
  };
}

// ==================== 成交量指标 ====================

/**
 * OBV (能量潮指标)
 * 通过成交量变化判断趋势
 */
export function calculateOBV(closes, volumes) {
  if (closes.length < 2) return null;

  let obv = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv += volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      obv -= volumes[i];
    }
  }

  // 计算OBV的趋势
  const obvs = [];
  let tempObv = 0;
  for (let i = 1; i < Math.min(closes.length, 20); i++) {
    const idx = closes.length - 20 + i;
    if (idx < 1) continue;

    if (closes[idx] > closes[idx - 1]) {
      tempObv += volumes[idx];
    } else if (closes[idx] < closes[idx - 1]) {
      tempObv -= volumes[idx];
    }
    obvs.push(tempObv);
  }

  const obvTrend = obvs.length > 10 ?
    (obvs[obvs.length - 1] > obvs[0] ? 'RISING' : 'FALLING') : 'NEUTRAL';

  return {
    obv,
    trend: obvTrend,
    signal: obvTrend === 'RISING' ? 'BULLISH' : obvTrend === 'FALLING' ? 'BEARISH' : 'NEUTRAL',
    description: `OBV: ${obv.toFixed(0)} (${obvTrend === 'RISING' ? '上升' : obvTrend === 'FALLING' ? '下降' : '中性'})`
  };
}

/**
 * CMF (蔡金资金流量指标)
 * 衡量买卖压力
 */
export function calculateCMF(highs, lows, closes, volumes, period = 20) {
  if (closes.length < period) return null;

  let mfvSum = 0;
  let volumeSum = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const mfm = ((closes[i] - lows[i]) - (highs[i] - closes[i])) / (highs[i] - lows[i]);
    const mfv = mfm * volumes[i];
    mfvSum += mfv;
    volumeSum += volumes[i];
  }

  const cmf = volumeSum === 0 ? 0 : mfvSum / volumeSum;

  let signal = 'NEUTRAL';
  if (cmf > 0.1) signal = 'BULLISH';
  else if (cmf < -0.1) signal = 'BEARISH';

  return {
    cmf,
    signal,
    strength: Math.abs(cmf) * 100,
    description: `CMF: ${cmf.toFixed(3)} (${signal === 'BULLISH' ? '资金流入' : signal === 'BEARISH' ? '资金流出' : '中性'})`
  };
}

/**
 * VWAP (成交量加权平均价)
 * 日内重要支撑阻力
 */
export function calculateVWAP(highs, lows, closes, volumes) {
  if (closes.length < 1) return null;

  let cumVolume = 0;
  let cumVolumePrice = 0;

  for (let i = 0; i < closes.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    cumVolumePrice += typical * volumes[i];
    cumVolume += volumes[i];
  }

  const vwap = cumVolume === 0 ? closes[closes.length - 1] : cumVolumePrice / cumVolume;
  const currentPrice = closes[closes.length - 1];
  const deviation = (currentPrice - vwap) / vwap;

  return {
    vwap,
    currentPrice,
    deviation,
    signal: currentPrice > vwap ? 'ABOVE' : 'BELOW',
    description: `VWAP: ${vwap.toFixed(2)}, 偏离${(deviation * 100).toFixed(2)}%`
  };
}

// ==================== 通道指标 ====================

/**
 * Keltner Channel (凯特纳通道)
 * 基于ATR的波动通道
 */
export function calculateKeltner(highs, lows, closes, period = 20, multiplier = 2) {
  if (closes.length < period) return null;

  // 中线 = EMA
  const ema = closes.slice(-period).reduce((sum, v) => sum + v, 0) / period;

  // 计算ATR
  const atr = closes.slice(-period).reduce((sum, close, i) => {
    if (i === 0) return sum;
    const tr = Math.max(
      highs[highs.length - period + i] - lows[lows.length - period + i],
      Math.abs(highs[highs.length - period + i] - closes[closes.length - period + i - 1]),
      Math.abs(lows[lows.length - period + i] - closes[closes.length - period + i - 1])
    );
    return sum + tr;
  }, 0) / period;

  const upper = ema + multiplier * atr;
  const lower = ema - multiplier * atr;
  const current = closes[closes.length - 1];

  return {
    upper,
    middle: ema,
    lower,
    atr,
    position: (current - lower) / (upper - lower),
    signal: current > upper ? 'OVERBOUGHT' : current < lower ? 'OVERSOLD' : 'NORMAL',
    description: `Keltner: ${ema.toFixed(2)} ±${(multiplier * atr).toFixed(2)}`
  };
}

/**
 * Donchian Channel (唐奇安通道)
 * 突破交易经典指标
 */
export function calculateDonchian(highs, lows, period = 20) {
  if (highs.length < period) return null;

  const upper = Math.max(...highs.slice(-period));
  const lower = Math.min(...lows.slice(-period));
  const middle = (upper + lower) / 2;

  return {
    upper,
    middle,
    lower,
    width: upper - lower,
    description: `Donchian: ${upper.toFixed(2)} - ${lower.toFixed(2)}`
  };
}

// ==================== 其他指标 ====================

/**
 * Williams %R (威廉指标)
 * 超买超卖指标
 */
export function calculateWilliamsR(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;

  const highestHigh = Math.max(...highs.slice(-period));
  const lowestLow = Math.min(...lows.slice(-period));
  const close = closes[closes.length - 1];

  const williamsR = ((highestHigh - close) / (highestHigh - lowestLow)) * -100;

  let signal = 'NEUTRAL';
  if (williamsR < -80) signal = 'OVERSOLD';
  else if (williamsR > -20) signal = 'OVERBOUGHT';

  return {
    value: williamsR,
    signal,
    description: `Williams %R: ${williamsR.toFixed(1)} (${signal === 'OVERSOLD' ? '超卖' : signal === 'OVERBOUGHT' ? '超买' : '中性'})`
  };
}

/**
 * Hull MA (赫尔移动平均)
 * 低延迟的移动平均线
 */
export function calculateHullMA(closes, period = 9) {
  if (closes.length < period) return null;

  const wma = (data, len) => {
    const weights = Array.from({ length: len }, (_, i) => i + 1);
    const sum = weights.reduce((s, w) => s + w, 0);
    const weightedSum = data.slice(-len).reduce((s, v, i) => s + v * weights[i], 0);
    return weightedSum / sum;
  };

  const halfPeriod = Math.floor(period / 2);
  const sqrtPeriod = Math.floor(Math.sqrt(period));

  const wma1 = wma(closes, halfPeriod);
  const wma2 = wma(closes, period);

  const raw = 2 * wma1 - wma2;

  // 简化HMA计算
  const hullMA = raw;

  return {
    value: hullMA,
    description: `Hull MA(${period}): ${hullMA.toFixed(2)}`
  };
}

/**
 * 综合趋势评分
 * 汇总所有指标给出综合评分
 */
export function calculateTrendScore(klines) {
  if (klines.length < 52) return null;

  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const closes = klines.map(k => k.close);
  const volumes = klines.map(k => k.volume);

  const indicators = {
    ichimoku: calculateIchimoku(highs, lows, closes),
    dmi: calculateDMI(highs, lows, closes),
    sar: calculateParabolicSAR(highs, lows, closes),
    supertrend: calculateSupertrend(highs, lows, closes),
    obv: calculateOBV(closes, volumes),
    cmf: calculateCMF(highs, lows, closes, volumes),
    williamsR: calculateWilliamsR(highs, lows, closes)
  };

  // 计算综合评分
  let bullishScore = 0;
  let bearishScore = 0;
  let totalWeight = 0;

  // Ichimoku (权重30)
  if (indicators.ichimoku) {
    totalWeight += 30;
    if (indicators.ichimoku.signal === 'BULLISH') {
      bullishScore += indicators.ichimoku.strength * 30 / 70;
    } else if (indicators.ichimoku.signal === 'BEARISH') {
      bearishScore += indicators.ichimoku.strength * 30 / 70;
    }
  }

  // DMI/ADX (权重25)
  if (indicators.dmi) {
    totalWeight += 25;
    if (indicators.dmi.adx > 20) {
      if (indicators.dmi.signal === 'BULLISH') {
        bullishScore += 25 * (indicators.dmi.adx / 100);
      } else if (indicators.dmi.signal === 'BEARISH') {
        bearishScore += 25 * (indicators.dmi.adx / 100);
      }
    }
  }

  // Supertrend (权重20)
  if (indicators.supertrend) {
    totalWeight += 20;
    if (indicators.supertrend.trend === 'BULLISH') bullishScore += 20;
    else if (indicators.supertrend.trend === 'BEARISH') bearishScore += 20;
  }

  // OBV (权重15)
  if (indicators.obv) {
    totalWeight += 15;
    if (indicators.obv.signal === 'BULLISH') bullishScore += 15;
    else if (indicators.obv.signal === 'BEARISH') bearishScore += 15;
  }

  // CMF (权重10)
  if (indicators.cmf) {
    totalWeight += 10;
    if (indicators.cmf.signal === 'BULLISH') bullishScore += 10;
    else if (indicators.cmf.signal === 'BEARISH') bearishScore += 10;
  }

  const netScore = bullishScore - bearishScore;
  const normalizedScore = totalWeight > 0 ? (netScore / totalWeight) * 100 : 0;

  let trendSignal = 'NEUTRAL';
  if (normalizedScore > 30) trendSignal = 'STRONG_BULLISH';
  else if (normalizedScore > 10) trendSignal = 'BULLISH';
  else if (normalizedScore < -30) trendSignal = 'STRONG_BEARISH';
  else if (normalizedScore < -10) trendSignal = 'BEARISH';

  return {
    indicators,
    bullishScore,
    bearishScore,
    netScore,
    normalizedScore,
    signal: trendSignal,
    description: `综合趋势评分: ${normalizedScore.toFixed(1)}/100 (${trendSignal})`
  };
}
