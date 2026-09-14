/**
 * 多周期结构分析共享工具（结构做空 / 结构做多引擎共用）
 *
 * 来源：crypto-short-skill-node / crypto-long-skill-node（老板 2026-09-14 提供）的
 * indicators/core.js + analysis/structure.js 移植，指标行为与原版保持一致。
 * 两个 skill 的 structure() 本是同构镜像 —— 这里合并为一个实现，同时输出
 * 空头字段（bosBearish/chochBearish/failedBreakout）与多头字段
 * （bosBullish/chochBullish/failedBreakdown），引擎按方向各取所需。
 */
import { averageTrueRange } from './protectionReview.js';


/** EMA（SMA 种子，与 skill indicators/core.ema 一致） */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Wilder RSI（与 skill indicators/core.rsi 一致） */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; gain += Math.max(d, 0); loss += Math.max(-d, 0); }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** 滚动 ATR 序列（口径 = shared/protectionReview.averageTrueRange，与 pump-short 一致） */
export function atrSeries(rows, period = 14) {
  const out = new Array(rows.length).fill(NaN);
  for (let i = period; i < rows.length; i++) out[i] = averageTrueRange(rows.slice(i - period, i + 1), period);
  return out;
}

/** 当前 ATR 在近 200 个 ATR 值中的分位（skill 的 atrPercentile 口径） */
export function atrPercentile(series) {
  const valid = series.filter(x => Number.isFinite(x));
  if (!valid.length) return 0.5;
  const cur = valid.at(-1);
  const window = valid.slice(-200);
  let below = 0;
  for (const v of window) if (v <= cur) below++;
  return below / window.length;
}

/** 摆动高低点（skill structure.pivots：左右各 3 根严格隔离） */
export function pivots(rows, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < rows.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (rows[j].high >= rows[i].high) isH = false;
      if (rows[j].low <= rows[i].low) isL = false;
    }
    if (isH) highs.push({ index: i, price: rows[i].high, time: rows[i].openTime ?? null });
    if (isL) lows.push({ index: i, price: rows[i].low, time: rows[i].openTime ?? null });
  }
  return { highs, lows };
}

/**
 * 市场结构（skill structure.structure 的合并版）：LH/HH + LL/HL 判趋势、
 * BOS（跌破前一摆动低点 / 突破前一摆动高点）、CHOCH（BOS + 对应高低点形态）、
 * 假突破/假跌破、最近阻力/支撑。
 */
function trendFromPivots(highs, lows) {
  const h = highs.slice(-2), l = lows.slice(-2);
  const highPattern = h.length < 2 ? 'NA' : h[1].price < h[0].price ? 'LH' : 'HH';
  const lowPattern = l.length < 2 ? 'NA' : l[1].price < l[0].price ? 'LL' : 'HL';
  const trend = highPattern === 'LH' && lowPattern === 'LL' ? 'BEARISH'
    : highPattern === 'HH' && lowPattern === 'HL' ? 'BULLISH' : 'NEUTRAL';
  return { trend, highPattern, lowPattern };
}

/**
 * 市场结构：CHOCH 必须是「先形成完整反向结构，再由 BOS 确认」。
 * 例如多转空要求：此前存在 BULLISH 结构，随后形成 LH+LL，最后收盘跌破
 * 最新摆动低点；仅仅在上涨趋势里跌破一个低点不再被标记为 bearish CHOCH。
 */
export function marketStructure(rows, left = 3, right = 3) {
  const p = pivots(rows, left, right);
  const current = trendFromPivots(p.highs, p.lows);
  const h = p.highs.slice(-2), l = p.lows.slice(-2);
  // 当前结构由各方向最新两枚 pivot 构成；旧结构必须剔除各方向最新 pivot，
  // 防止“新高已出现、旧低仍在”的混合窗口把趋势状态污染成 NEUTRAL。
  const prior = trendFromPivots(p.highs.slice(0, -1), p.lows.slice(0, -1));
  const lastClose = rows.at(-1)?.close;
  const bosBearish = l.at(-1) != null && lastClose < l.at(-1).price;
  const bosBullish = h.at(-1) != null && lastClose > h.at(-1).price;
  const structureShiftBearish = prior.trend === 'BULLISH' && current.trend === 'BEARISH';
  const structureShiftBullish = prior.trend === 'BEARISH' && current.trend === 'BULLISH';
  const failedBreakout = h.length >= 2 && rows.slice(-8).some(x => x.high > h[0].price && x.close < h[0].price);
  const failedBreakdown = l.length >= 2 && rows.slice(-8).some(x => x.low < l[0].price && x.close > l[0].price);
  return {
    ...current,
    priorTrend: prior.trend,
    structureShiftBearish,
    structureShiftBullish,
    bosBearish,
    chochBearish: structureShiftBearish && bosBearish,
    failedBreakout,
    bosBullish,
    chochBullish: structureShiftBullish && bosBullish,
    failedBreakdown,
    highs: p.highs,
    lows: p.lows,
    resistance: h.at(-1)?.price ?? null,
    support: l.at(-1)?.price ?? null,
    pivotHighs: p.highs.map(x => x.price),
    pivotLows: p.lows.map(x => x.price)
  };
}

/** 单周期指标摘要（skill summarizeIndicators 的本地化子集） */
export function summarize(rows) {
  const close = rows.map(x => x.close), volume = rows.map(x => x.volume);
  const e20 = ema(close, 20), e50 = ema(close, 50), a = atrSeries(rows, 14), rs = rsi(close, 14);
  const volWindow = volume.slice(-20);
  const volMean = volWindow.reduce((s, v) => s + v, 0) / (volWindow.length || 1);
  return {
    price: close.at(-1),
    ema20: e20.at(-1),
    ema50: e50.at(-1),
    atr: a.at(-1),
    atrPct: atrPercentile(a.filter(Number.isFinite)),
    rsi: rs.at(-1),
    volumeRatio: volume.at(-1) / (volMean || 1)
  };
}

export const isFiniteCandle = r => r && ['open', 'high', 'low', 'close'].every(k => Number.isFinite(r[k]) && r[k] > 0)
  && r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close);

/** 结构摘要（写进信号，便于前端/研究记录追溯三周期判定） */
export function summarizeStructure(s4, s1, s15) {
  return {
      '4h': { trend: s4.trend, priorTrend: s4.priorTrend, highPattern: s4.highPattern, lowPattern: s4.lowPattern },
      '1h': { trend: s1.trend, priorTrend: s1.priorTrend, resistance: s1.resistance, support: s1.support },
    '15m': {
      trend: s15.trend,
      priorTrend: s15.priorTrend,
      structureShiftBearish: s15.structureShiftBearish,
      chochBearish: s15.chochBearish, bosBearish: s15.bosBearish, failedBreakout: s15.failedBreakout,
      structureShiftBullish: s15.structureShiftBullish,
      chochBullish: s15.chochBullish, bosBullish: s15.bosBullish, failedBreakdown: s15.failedBreakdown
    }
  };
}

/**
 * 从 1H/4H 已确认 pivot 中选真实止盈位。只接受方向正确且达到最低真实 RR
 * 的目标；找不到就返回 null，由策略直接 HOLD。
 */
export function selectPivotTarget({ long, entry, stopDistance, minRealRR, structures = [] }) {
  const candidates = [];
  for (const item of structures) {
    for (const pivot of (long ? item.structure?.highs : item.structure?.lows) || []) {
      const price = Number(pivot.price);
      if (!Number.isFinite(price) || !(price > 0)) continue;
      const favorable = long ? price > entry : price < entry;
      if (!favorable) continue;
      const rr = Math.abs(price - entry) / stopDistance;
      candidates.push({ price, rr, source: item.interval, pivotIndex: pivot.index,
      ...(pivot.time != null ? { pivotTime: pivot.time } : {}) });
    }
  }
  candidates.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  return candidates.find(target => target.rr >= minRealRR) || null;
}
