/** 从原 index.js 抽出的请求处理工具，路由层与服务层共用 */

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isMasked(value) {
  return typeof value === 'string' && (value.includes('...') || value === '********');
}

/** 合并配置时保留被掩码（未改动）的密钥 */
export function stripMaskedSecrets(current, patch) {
  const next = structuredClone(patch);
  if (isMasked(next.binance?.apiKey)) next.binance.apiKey = current.binance.apiKey;
  if (isMasked(next.binance?.secretKey)) next.binance.secretKey = current.binance.secretKey;
  if (isMasked(next.model?.apiKey)) next.model.apiKey = current.model.apiKey;
  if (isMasked(next.okx?.apiKey)) next.okx.apiKey = current.okx?.apiKey || '';
  if (isMasked(next.okx?.secretKey)) next.okx.secretKey = current.okx?.secretKey || '';
  if (isMasked(next.okx?.passphrase)) next.okx.passphrase = current.okx?.passphrase || '';
  return next;
}

export function normalizeStrategy(input = {}) {
  return {
    name: String(input.name || 'Binance strategy'),
    symbols: String(input.symbolsText || input.symbols || 'BTCUSDT,ETHUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    interval: String(input.interval || '15m'),
    klineLimit: Number(input.klineLimit || 80),
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : String(input.systemPrompt?.content || ''),
    rules: typeof input.rules === 'string' ? input.rules : String(input.rules?.content || input.rules?.rules || '')
  };
}

export function normalizeAnalysisScope(input = {}) {
  const symbols = Array.isArray(input.symbols)
    ? input.symbols
    : String(input.symbolsText || '').split(',');
  return {
    symbols: symbols.map((symbol) => String(symbol).trim().toUpperCase().replace(/^(BYBIT|OKX)_/, '')).filter(Boolean),
    interval: String(input.interval || '15m'),
    limit: clamp(Number(input.limit || 80), 20, 200),
    maxSymbols: clamp(Number(input.maxSymbols || 20), 1, 300),
    batchSize: clamp(Number(input.batchSize || 10), 1, 20)
  };
}
