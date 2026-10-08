/**
 * Binance Demo / 实盘环境判定与凭证解析 —— 前后端共享的唯一实现。
 *
 * 背景：这套逻辑此前在 4 处各自实现（binancePaperSync 的 selectedDemo、
 * routes/binance 的 isBinanceDemo、store.mergeConfig 的内联四层判定、
 * 前端 stores/config 的 isBinanceDemo），口径一旦调整就会漂移。
 * demo 是新字段；testnet 是旧配置的兼容别名，语义与 demo 对齐。
 */

/** 任意 binance 配置对象（或 patch）→ 是否 Demo 环境 */
export const isBinanceDemo = source => source?.demo !== undefined
  ? source.demo === true
  : source?.testnet !== false;

/**
 * 按环境解析凭证：优先环境专属 key（demoApiKey / liveApiKey）；
 * 未配置环境专属 key 时回落到「当前选中环境」的主 apiKey / secretKey（旧配置兼容）。
 * 返回对象可直接传给 BinanceClient 构造器。
 */
export function binanceEnvironmentConfig(config = {}, environment = 'demo') {
  const binance = config.binance || {};
  const demo = environment === 'demo';
  const prefix = demo ? 'demo' : 'live';
  const selected = isBinanceDemo(binance) === demo;
  const apiKey = String(binance[prefix + 'ApiKey'] || (selected ? binance.apiKey : '') || '').trim();
  const secretKey = String(binance[prefix + 'SecretKey'] || (selected ? binance.secretKey : '') || '').trim();
  return { ...binance, apiKey, secretKey, demo, testnet: demo, environment };
}

/**
 * mergeConfig 专用：patch 里显式带了 demo/testnet 时以 patch 为准，
 * 否则沿用当前配置的环境。等价于旧版内联的四层判定。
 */
export function mergeBinanceDemo(patchBinance = {}, currentBinance = {}) {
  return patchBinance.demo !== undefined || patchBinance.testnet !== undefined
    ? isBinanceDemo(patchBinance)
    : isBinanceDemo(currentBinance);
}
