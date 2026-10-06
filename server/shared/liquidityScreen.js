/**
 * 币种初筛 + 触发时盘口校验。
 * 缺字段时 fail-closed：不编造成交额/价差/深度，直接跳过并给出原因。
 */
import { AUTO_TRADE } from '../../shared/autoTradeDefaults.js';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function atrPctFromBars(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length < period + 1) return null;
  const slice = rows.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const high = finite(slice[i].high);
    const low = finite(slice[i].low);
    const prev = finite(slice[i - 1].close);
    if (high == null || low == null || prev == null) return null;
    sum += Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  }
  const close = finite(slice.at(-1).close);
  if (!(close > 0)) return null;
  return (sum / period) / close;
}

function spreadBps(bid, ask) {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return (ask - bid) / ((ask + bid) / 2) * 10000;
}

function bookNotional(levels, count) {
  if (!Array.isArray(levels) || !levels.length) return null;
  let total = 0;
  for (const level of levels.slice(0, count)) {
    const price = finite(level?.[0] ?? level?.price);
    const qty = finite(level?.[1] ?? level?.qty ?? level?.quantity);
    if (!(price > 0) || !(qty > 0)) return null;
    total += price * qty;
  }
  return total;
}

export function screenSymbol(snapshot = {}, params = AUTO_TRADE) {
  const reasons = [];
  const quoteVolume = finite(snapshot.quoteVolume ?? snapshot.quoteVolume24h ?? snapshot.volume24h);
  const atrPct = finite(snapshot.atrPct) ?? atrPctFromBars(snapshot.klines || snapshot.bars);
  const bid = finite(snapshot.bidPrice ?? snapshot.bid);
  const ask = finite(snapshot.askPrice ?? snapshot.ask);
  const spread = finite(snapshot.spreadBps) ?? spreadBps(bid, ask);

  if (quoteVolume == null) reasons.push('缺少24h成交额');
  else if (quoteVolume < params.minQuoteVolume24h) reasons.push(`24h成交额 ${quoteVolume.toFixed(0)} < ${params.minQuoteVolume24h}`);

  const hasBars = Array.isArray(snapshot.klines) && snapshot.klines.length >= 15;
  if (atrPct == null) {
    if (hasBars) reasons.push('缺少波动率');
  } else if (atrPct < params.minAtrPct) reasons.push(`波动率 ${(atrPct * 100).toFixed(3)}% 过低`);
  else if (atrPct > params.maxAtrPct) reasons.push(`波动率 ${(atrPct * 100).toFixed(2)}% 过高`);

  if (spread != null && spread > params.maxSpreadBps) reasons.push(`价差 ${spread.toFixed(2)}bps 超过 ${params.maxSpreadBps}`);

  return {
    symbol: String(snapshot.symbol || ''),
    ok: reasons.length === 0,
    reasons,
    metrics: { quoteVolume, atrPct, spreadBps: spread }
  };
}

export function screenUniverse(rows = [], params = AUTO_TRADE) {
  const kept = [];
  const rejected = [];
  for (const row of rows) {
    const result = screenSymbol(row, params);
    if (result.ok) kept.push(row.symbol || result.symbol);
    else rejected.push(result);
  }
  const reasons = {};
  for (const item of rejected) {
    const key = item.reasons[0] || 'unknown';
    reasons[key] = (reasons[key] || 0) + 1;
  }
  return { filtered: kept, rejected, reasons };
}

export function checkBookLiquidity({ bid, ask, bids, asks, notional }, params = AUTO_TRADE) {
  const reasons = [];
  const spread = spreadBps(finite(bid), finite(ask));
  if (spread == null) reasons.push('缺少买卖价');
  else if (spread > params.maxSpreadBps) reasons.push(`盘口价差 ${spread.toFixed(2)}bps 超过 ${params.maxSpreadBps}`);

  const bidDepth = bookNotional(bids, params.bookLevels);
  const askDepth = bookNotional(asks, params.bookLevels);
  if (bidDepth == null || askDepth == null) reasons.push('缺少盘口深度');
  else {
    if (bidDepth < params.minBookNotional) reasons.push(`买盘前${params.bookLevels}档名义 ${bidDepth.toFixed(1)} < ${params.minBookNotional}`);
    if (askDepth < params.minBookNotional) reasons.push(`卖盘前${params.bookLevels}档名义 ${askDepth.toFixed(1)} < ${params.minBookNotional}`);
  }

  const orderNotional = finite(notional);
  if (orderNotional != null && orderNotional < params.minExchangeNotional) {
    reasons.push(`下单名义 ${orderNotional.toFixed(2)} 低于交易所最低 ${params.minExchangeNotional}`);
  }
  if (orderNotional != null && bidDepth != null && askDepth != null) {
    const depth = Math.min(bidDepth, askDepth);
    if (orderNotional > depth) reasons.push(`下单名义 ${orderNotional.toFixed(1)} 超过盘口可成交深度 ${depth.toFixed(1)}`);
  }

  return { ok: reasons.length === 0, reasons, spreadBps: spread, bidDepth, askDepth };
}

export function tickerToSnapshot(symbol, ticker = {}, extra = {}) {
  return {
    symbol,
    quoteVolume: finite(ticker.quoteVolume),
    bidPrice: finite(ticker.bidPrice),
    askPrice: finite(ticker.askPrice),
    ...extra
  };
}
