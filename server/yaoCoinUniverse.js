/**
 * 妖币埋伏动态币种画像。
 *
 * 这里不保存固定白名单。每轮扫描使用当前市场画像重新评分：市值、流通率、
 * 24h 成交额/市值、成交额绝对值、市场排名和当前波动共同决定本轮是否进入
 * 妖币策略候选池。数据缺失时保留「未知」状态，交由调用方决定是否降级放行。
 */

export const YAO_MARKET_PROFILE_DEFAULTS = Object.freeze({
  enabled: true,
  minScore: 55,
  minMarketCapUsd: 20_000_000,
  maxMarketCapUsd: 20_000_000_000,
  minCirculatingRatio: 0.2,
  maxCirculatingRatio: 1.05,
  minVolume24hUsd: 5_000_000,
  minVolumeMarketCapRatio: 0.005,
  maxVolumeMarketCapRatio: 2,
  maxMarketCapRank: 1_000,
  minCoverage: 0.6,
  minKnownFraction: 0.2,
  allowUnknown: false
});

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function normalizedSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;
}

function normalizedBaseSymbol(value) {
  return normalizedSymbol(value).replace(/^(1000|1000000)(?=[A-Z])/, '');
}

function inRange(value, min, max) {
  return value != null && value >= min && value <= max;
}

function component(name, value, available, weight, reason = '') {
  return { name, value, available, weight, reason };
}

/**
 * 计算一个币种的当前市场画像。评分是候选池排序/过滤分，不是收益概率。
 */
export function scoreYaoMarketProfile(row = {}, options = {}) {
  const p = { ...YAO_MARKET_PROFILE_DEFAULTS, ...options };
  const symbol = normalizedSymbol(row.symbol);
  const marketCap = finite(row.marketCap);
  const marketCapRank = finite(row.marketCapRank);
  const volume24h = finite(row.volume24h ?? row.quoteVolume);
  const circulatingSupply = finite(row.circulatingSupply);
  const totalSupply = finite(row.totalSupply);
  const circulatingRatio = circulatingSupply != null && totalSupply > 0
    ? circulatingSupply / totalSupply : null;
  const volumeMarketCapRatio = finite(row.volumeMarketCapRatio)
    ?? (volume24h != null && marketCap > 0 ? volume24h / marketCap : null);
  const priceChange24h = finite(row.priceChangePercentage24h ?? row.priceChangePct);

  const components = [
    component('marketCap', marketCap == null ? null : Number(inRange(marketCap, p.minMarketCapUsd, p.maxMarketCapUsd)), marketCap != null, 25,
      marketCap == null ? '缺少市值' : inRange(marketCap, p.minMarketCapUsd, p.maxMarketCapUsd) ? '市值处于中低盘波动区间' : '市值过小或过大'),
    component('circulatingRatio', circulatingRatio == null ? null : Number(inRange(circulatingRatio, p.minCirculatingRatio, p.maxCirculatingRatio)), circulatingRatio != null, 25,
      circulatingRatio == null ? '缺少流通率' : inRange(circulatingRatio, p.minCirculatingRatio, p.maxCirculatingRatio) ? '流通率可接受' : '流通率过低或供应数据异常'),
    component('liquidityRatio', volumeMarketCapRatio == null ? null : Number(inRange(volumeMarketCapRatio, p.minVolumeMarketCapRatio, p.maxVolumeMarketCapRatio)), volumeMarketCapRatio != null, 20,
      volumeMarketCapRatio == null ? '缺少成交额/市值' : inRange(volumeMarketCapRatio, p.minVolumeMarketCapRatio, p.maxVolumeMarketCapRatio) ? '流动性足够且未明显异常' : '流动性不足或成交额异常'),
    component('volume24h', volume24h == null ? null : Number(volume24h >= p.minVolume24hUsd), volume24h != null, 15,
      volume24h == null ? '缺少24h成交额' : volume24h >= p.minVolume24hUsd ? '24h成交额足够' : '24h成交额偏低'),
    component('marketCapRank', marketCapRank == null ? null : Number(marketCapRank <= p.maxMarketCapRank), marketCapRank != null, 10,
      marketCapRank == null ? '缺少市值排名' : marketCapRank <= p.maxMarketCapRank ? '市值排名在覆盖范围内' : '市值排名过后'),
    component('currentVolatility', priceChange24h == null ? null : Number(Math.abs(priceChange24h) <= 45), priceChange24h != null, 5,
      priceChange24h == null ? '缺少当前涨跌幅' : Math.abs(priceChange24h) <= 45 ? '尚未明显脱离埋伏区间' : '当前涨跌幅过大')
  ];
  const availableWeight = components.filter(item => item.available).reduce((sum, item) => sum + item.weight, 0);
  const weightedScore = components.reduce((sum, item) => sum + (item.available ? item.value * item.weight : 0), 0);
  const coverage = availableWeight / components.reduce((sum, item) => sum + item.weight, 0);
  const score = availableWeight > 0 ? weightedScore / availableWeight * 100 : null;
  const hardReject = [
    marketCap != null && marketCap < p.minMarketCapUsd,
    marketCap != null && marketCap > p.maxMarketCapUsd,
    circulatingRatio != null && !inRange(circulatingRatio, p.minCirculatingRatio, p.maxCirculatingRatio),
    volume24h != null && volume24h < p.minVolume24hUsd,
    volumeMarketCapRatio != null && volumeMarketCapRatio < p.minVolumeMarketCapRatio,
    volumeMarketCapRatio != null && volumeMarketCapRatio > p.maxVolumeMarketCapRatio,
    marketCapRank != null && marketCapRank > p.maxMarketCapRank,
    priceChange24h != null && Math.abs(priceChange24h) > 45
  ].some(Boolean);
  const known = availableWeight > 0;
  const eligible = p.enabled !== false && known && coverage >= p.minCoverage
    && !hardReject && score >= p.minScore;

  return {
    symbol,
    known,
    eligible,
    score: score == null ? null : Math.round(score * 100) / 100,
    coverage: Math.round(coverage * 1000) / 1000,
    marketCap,
    marketCapRank,
    volume24h,
    circulatingSupply,
    totalSupply,
    circulatingRatio: circulatingRatio == null ? null : Math.round(circulatingRatio * 10000) / 10000,
    volumeMarketCapRatio: volumeMarketCapRatio == null ? null : Math.round(volumeMarketCapRatio * 10000) / 10000,
    priceChange24h,
    hardReject,
    components,
    reason: !known ? '市场画像字段不足' : hardReject ? components.filter(item => item.available && item.value === 0).map(item => item.reason).join('；') : `市场画像评分 ${score.toFixed(1)}，覆盖率 ${(coverage * 100).toFixed(0)}%`
  };
}

/**
 * 批量筛选本轮妖币策略候选。市场数据完全不可用时 fail-open，避免外部数据源
 * 故障导致自动化误以为全市场都不合格；只要有部分画像，已知且不合格的会被移除。
 */
export function filterYaoCoinUniverse(symbols = [], marketRows = [], options = {}) {
  const p = { ...YAO_MARKET_PROFILE_DEFAULTS, ...options };
  if (p.enabled === false) return { filtered: [...symbols], filteredOut: [], profiles: [], unavailable: false, reasons: {} };
  const rowMap = new Map();
  for (const row of (Array.isArray(marketRows) ? marketRows : [])) {
    rowMap.set(normalizedSymbol(row?.symbol), row);
    rowMap.set(normalizedBaseSymbol(row?.symbol), row);
  }
  const profiles = [];
  const filtered = [];
  const filteredOut = [];
  const reasons = {};
  for (const input of symbols) {
    const symbol = normalizedSymbol(input);
    const row = rowMap.get(symbol) || rowMap.get(normalizedBaseSymbol(symbol));
    const profile = scoreYaoMarketProfile(row ? { ...row, symbol } : { symbol }, p);
    profiles.push(profile);
    if (!profile.known && p.allowUnknown !== false) {
      filtered.push(input);
      reasons.unknown = (reasons.unknown || 0) + 1;
    } else if (profile.eligible) {
      filtered.push(input);
      reasons.eligible += 1;
    } else {
      filteredOut.push({ symbol: input, score: profile.score, reason: profile.reason });
      const reason = profile.reason || '市场画像不合格';
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  const knownCount = profiles.filter(profile => profile.known).length;
  const knownFraction = knownCount / Math.max(1, symbols.length);
  const unavailable = knownCount === 0 || knownFraction < p.minKnownFraction;
  return {
    filtered: unavailable ? [...symbols] : filtered,
    filteredOut: unavailable ? [] : filteredOut,
    profiles,
    unavailable,
    reasons,
    summary: { total: symbols.length, known: knownCount, knownFraction, filtered: unavailable ? symbols.length : filtered.length, removed: unavailable ? 0 : filteredOut.length }
  };
}
