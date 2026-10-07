import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listStrategies, getStrategy, resolveParams } from '../../server/strategies/index.js';
import { PAPER_COSTS } from '../../server/research.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MINUTE = 60_000, DAY = 86_400_000;
export const DEFAULTS = {
  version: 1,
  period: { days: 365, from: null, to: null, warmupDays: 90 },
  data: { directory: 'data/backtest/crypto-year', legacyDirectories: ['data/backtest/bf365-1m'],
    symbols: 'all', quoteAsset: 'USDT', market: 'binance-usdm-perpetual', downloadWorkers: 2,
    proxy: null, verifyChecksums: true, restFallback: true, minCoverage: 0.95,
    minObservedDays: 1, allowPartialHistory: true, historicalProfiles: null, profileMaxAgeDays: 2,
    restLookbackDays: 7 },
  execution: { initialBalance: 1000, marginPct: 0.05, fixedMargin: null, maxLeverage: 5,
    leverage: null, respectStrategySizing: true, riskPct: 0.01, pendingMinutes: 1440,
    cooldownMinutes: 0, stopCooldownMinutes: 60, dailyLossPct: 0.03,
    consecutiveLossLimit: 5, decisionEveryBars: 1, reviewEveryBars: 1,
    enableLiquidation: true, enableIsolatedMargin: true, enableDynamicProtection: true },
  costs: { feeBps: PAPER_COSTS.feeBps, slippageBps: PAPER_COSTS.slippageBps,
    fundingBpsPer8h: PAPER_COSTS.fundingBpsPer8h },
  features: { enabled: true, interval: '1h', lookbackBars: 72, trendBars: 24, atrPeriod: 14,
    volumePeriod: 20, minCoinsPerGroup: 5, minTradesPerCoin: 5, minEffect: 0.25,
    lowerQuantile: 0.1, upperQuantile: 0.9, maxRules: 2, minValidationTrades: 10,
    minValidationImprovement: 0, maxValidationDrawdown: 0.5, manualRules: [], missing: 'reject' },
  optimization: { seed: 20261007, trainFraction: 0.6, validationFraction: 0.2,
    maxRounds: 5, trialsPerRound: 8, patience: 2, minImprovement: 0.0001,
    method: 'adaptive-random', objective: 'return', autoSpace: true, minTrades: 10, minTradesPerCoin: 3, maxDrawdown: 0.6,
    drawdownPenalty: 0.5, instabilityPenalty: 0.1, runtimeSpace: {}, costSpace: {} },
  parameterSource: 'schema', strategies: {},
  output: { directory: 'output/crypto-backtest', workers: 2, resume: true, saveTrades: true }
};

export function merge(base, patch) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(patch || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v)
    && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], v) : structuredClone(v);
  return out;
}
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
export const abs = p => path.resolve(ROOT, p);
export function duration(interval) {
  const m = /^(\d+)(m|h|d)$/.exec(interval);
  if (!m) throw new Error(`不支持的固定周期 ${interval}`);
  return Number(m[1]) * ({ m: MINUTE, h: 60 * MINUTE, d: DAY })[m[2]];
}
function between(value, min, max, label, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`${label} 必须为 ${min}～${max}${integer ? ' 的整数' : ''}`);
}
function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须为对象`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} 未知配置项 ${key}`);
}
function boolean(value, label) { if (typeof value !== 'boolean') throw new Error(`${label} 必须为布尔值`); }
export function validateExecution(e, costs) {
  knownKeys(e, Object.keys(DEFAULTS.execution), 'execution');
  knownKeys(costs, Object.keys(DEFAULTS.costs), 'costs');
  for (const k of ['respectStrategySizing', 'enableLiquidation', 'enableIsolatedMargin', 'enableDynamicProtection']) boolean(e[k], `execution.${k}`);
  between(e.initialBalance, 0.01, 1e12, 'initialBalance');
  between(e.marginPct, 0.00001, 1, 'marginPct');
  if (e.fixedMargin != null) between(e.fixedMargin, 0.001, 1e12, 'fixedMargin');
  between(e.riskPct, 0.00001, 1, 'riskPct');
  between(e.maxLeverage, 1, 125, 'maxLeverage', true);
  if (e.leverage != null) between(e.leverage, 1, e.maxLeverage, 'leverage', true);
  between(e.pendingMinutes, 1, 525600, 'pendingMinutes');
  for (const k of ['cooldownMinutes', 'stopCooldownMinutes']) between(e[k], 0, 525600, k);
  between(e.dailyLossPct, 0, 1, 'dailyLossPct');
  between(e.consecutiveLossLimit, 0, 10000, 'consecutiveLossLimit', true);
  for (const k of ['decisionEveryBars', 'reviewEveryBars']) between(e[k], 1, 10000, k, true);
  for (const k of ['feeBps', 'slippageBps', 'fundingBpsPer8h']) between(costs[k], 0, 1000, k);
}
export function validateParams(strategy, overrides) {
  const keys = new Set(strategy.paramSchema.map(s => s.key));
  for (const k of Object.keys(overrides || {})) if (!keys.has(k)) throw new Error(`${strategy.id} 未知参数 ${k}`);
  for (const spec of strategy.paramSchema) if (spec.type === 'boolean' && Object.hasOwn(overrides || {}, spec.key)) boolean(overrides[spec.key], `${strategy.id}.${spec.key}`);
  const result = resolveParams(strategy.paramSchema, overrides);
  if (result.rejected.length) throw new Error(`${strategy.id} 参数无效：${JSON.stringify(result.rejected)}`);
  for (const s of strategy.paramSchema) if (s.type === 'number' && s.step === 1 && !Number.isInteger(result.params[s.key]))
    throw new Error(`${strategy.id}.${s.key} 必须为整数`);
  for (const [a, b] of [['maFastPeriod', 'maSlowPeriod'], ['macdFastPeriod', 'macdSlowPeriod'],
    ['volumeRecentPeriod', 'volumeLookbackPeriod']])
    if (result.params[a] != null && result.params[a] >= result.params[b]) throw new Error(`${strategy.id} 要求 ${a} < ${b}`);
  return result.params;
}
export function loadConfig(file, patch = {}) {
  const input = file ? JSON.parse(fs.readFileSync(abs(file), 'utf8')) : {};
  knownKeys(input, Object.keys(DEFAULTS), 'backtest');
  const c = merge(merge(DEFAULTS, input), patch);
  for (const key of ['period', 'data', 'features', 'optimization', 'output']) knownKeys(c[key], Object.keys(DEFAULTS[key]), key);
  for (const k of ['verifyChecksums', 'restFallback', 'allowPartialHistory']) boolean(c.data[k], `data.${k}`);
  for (const k of ['resume', 'saveTrades']) boolean(c.output[k], `output.${k}`);
  boolean(c.features.enabled, 'features.enabled'); boolean(c.optimization.autoSpace, 'optimization.autoSpace');
  if (c.data.symbols !== 'all' && (!Array.isArray(c.data.symbols) || !c.data.symbols.length || c.data.symbols.some(s => typeof s !== 'string' || !/^[\p{L}\p{N}_]+USDT$/iu.test(s)))) throw new Error('data.symbols 必须为 all 或 USDT 合约列表');
  if (!Array.isArray(c.data.legacyDirectories) || c.data.legacyDirectories.some(s => typeof s !== 'string')) throw new Error('legacyDirectories 必须为目录列表');
  const to = c.period.to == null ? Math.floor(Date.now() / MINUTE) * MINUTE : Date.parse(c.period.to);
  const from = c.period.from == null ? to - c.period.days * DAY : Date.parse(c.period.from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from % MINUTE || to % MINUTE)
    throw new Error('period.from/to 必须为递增的、对齐分钟的 ISO 时间，to 为不含端点');
  if (to > Math.floor(Date.now() / MINUTE) * MINUTE) throw new Error('结束时间不能超过最新已收盘分钟');
  c.period = { ...c.period, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  between(c.period.warmupDays, 0, 3650, 'warmupDays');
  between(c.output.workers, 1, 8, 'workers', true);
  between(c.data.downloadWorkers, 1, 16, 'downloadWorkers', true);
  between(c.data.minCoverage, 0, 1, 'minCoverage');
  between(c.data.minObservedDays, 0, 3650, 'minObservedDays');
  if (c.data.market !== 'binance-usdm-perpetual' || c.data.quoteAsset !== 'USDT')
    throw new Error('当前下载器的市场范围为 Binance USDT 本位永续；其他数据可先导入同格式 K 线');
  if (!['schema', 'configured'].includes(c.parameterSource)) throw new Error('parameterSource 为 schema/configured');
  const o = c.optimization;
  between(o.trainFraction, 0.1, 0.85, 'trainFraction');
  between(o.validationFraction, 0.05, 0.8, 'validationFraction');
  if (o.trainFraction + o.validationFraction >= 0.95) throw new Error('训练与验证比例之和必须小于 0.95');
  for (const k of ['maxRounds', 'trialsPerRound', 'patience']) between(o[k], 1, 100000, k, true);
  if (!['adaptive-random', 'grid'].includes(o.method)) throw new Error('优化 method 为 adaptive-random/grid');
  if (!['return', 'risk-adjusted-return'].includes(o.objective)) throw new Error('优化 objective 为 return/risk-adjusted-return');
  between(o.maxDrawdown, 0, 1, 'optimization.maxDrawdown');
  for (const k of ['minTrades', 'drawdownPenalty', 'instabilityPenalty', 'minImprovement']) between(o[k], 0, 1e9, k);
  const f = c.features;
  duration(f.interval);
  if (!['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'].includes(f.interval)) throw new Error('特征周期不在项目支持范围内');
  for (const k of ['lookbackBars', 'trendBars', 'atrPeriod', 'volumePeriod', 'minCoinsPerGroup', 'minTradesPerCoin', 'maxRules'])
    between(f[k], 1, 10000, `features.${k}`, true);
  if (f.lookbackBars < Math.max(f.trendBars, f.atrPeriod, f.volumePeriod) + 1) throw new Error('特征 lookbackBars 必须覆盖指标周期并多一根');
  if (f.lookbackBars > 1000) throw new Error('features.lookbackBars 不得超过运行时支持的 1000 根');
  between(f.lowerQuantile, 0, 0.49, 'lowerQuantile'); between(f.upperQuantile, 0.51, 1, 'upperQuantile');
  if (!['reject', 'pass'].includes(f.missing)) throw new Error('features.missing 为 reject/pass');
  between(c.data.profileMaxAgeDays, 0, 3650, 'profileMaxAgeDays');
  between(c.data.restLookbackDays, 0, 3650, 'restLookbackDays');
  between(o.minTradesPerCoin, 1, 1e9, 'minTradesPerCoin', true);
  between(f.minEffect, 0, 1e9, 'minEffect');
  between(f.minValidationTrades, 1, 1e9, 'minValidationTrades', true);
  between(f.minValidationImprovement, 0, 1e9, 'minValidationImprovement');
  between(f.maxValidationDrawdown, 0, 1, 'maxValidationDrawdown');
  for (const id of Object.keys(c.strategies)) if (!getStrategy(id)) throw new Error(`未知策略 ${id}`);
  for (const [id, settings] of Object.entries(c.strategies)) knownKeys(settings, ['params', 'searchSpace', 'execution', 'costs'], id);
  validateExecution(c.execution, c.costs);
  return c;
}
export function schemaDocument() {
  return { version: 1, strategies: listStrategies().map(s => ({ id: s.id, name: s.name,
    planInterval: s.planInterval || '1m', needsAux: s.needsAux, marketWindow: s.marketWindow,
    marketWindows: s.marketWindows, parameters: s.paramSchema })), runtime: DEFAULTS.execution,
    costs: DEFAULTS.costs, features: DEFAULTS.features };
}
export function initialConfig() {
  return merge(DEFAULTS, { strategies: Object.fromEntries(listStrategies().map(s => [s.id,
    { params: Object.fromEntries(s.paramSchema.map(p => [p.key, p.default])), searchSpace: {} }])) });
}
