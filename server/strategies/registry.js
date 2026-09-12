/**
 * 策略注册表（多策略体系的骨架）
 *
 * 设计目标（2026-09-11 老板需求）：
 *   1. 策略是**一等公民实体** —— 有 id、名称、说明、参数模式、分析函数、复核函数；
 *   2. 可勾选 —— 自动化只跑「已启用」的策略；
 *   3. 挂单后订单记住自己属于哪个策略，之后**用同一个策略**做持仓复核与出场判定；
 *   4. 新增策略只需 defineStrategy 一次注册，其余（API / 前端 / 自动化分派）自动生效。
 *
 * 约定：
 *   · analyze(market, ctx) → 信号（可 async）。ctx = { params, auxMarkets, config, strategyPrompt, interval, deps, adaptiveParams }
 *   · review(order, market, ctx) → 复核建议（可 async）。ctx 同上（review 只用到 order/market/deps）
 *   · prefilter(symbols, ctx) → string[]（可选）。策略级的候选池预筛选
 *   · needsAux → 主周期之外的辅助周期列表（可选）。自动化会按需拉取并放进 ctx.auxMarkets
 *   · paramSchema → 扁平参数模式数组，元素形如
 *       { key, label, group, type:'number'|'boolean', default, min?, max?, step?, description? }
 *
 * 本文件只做「注册 + 参数校验」这类纯逻辑，不依赖任何分析引擎，避免循环依赖。
 */

const registry = new Map();

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertParamSpec(spec, strategyId) {
  if (!isPlainObject(spec)) throw new Error(`策略 ${strategyId} 的参数模式项必须是对象`);
  if (typeof spec.key !== 'string' || !spec.key) throw new Error(`策略 ${strategyId} 的参数项缺少 key`);
  if (spec.type !== 'number' && spec.type !== 'boolean') throw new Error(`策略 ${strategyId} 的参数 ${spec.key} type 必须是 number|boolean`);
  if (!('default' in spec)) throw new Error(`策略 ${strategyId} 的参数 ${spec.key} 缺少 default`);
  if (spec.type === 'number' && (!Number.isFinite(spec.min) || !Number.isFinite(spec.max) || spec.min > spec.max)) {
    throw new Error(`策略 ${strategyId} 的参数 ${spec.key} 需要合法的 min/max`);
  }
}

/**
 * 注册一个策略。重复注册同一 id 会直接覆盖（便于开发期迭代同 id 的定义）。
 * @param {object} def
 */
export function defineStrategy(def) {
  if (!isPlainObject(def)) throw new Error('defineStrategy 需要对象');
  const { id, name, analyze, review } = def;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`策略 id 非法：${id}（只允许小写字母/数字/连字符）`);
  if (typeof name !== 'string' || !name) throw new Error(`策略 ${id} 缺少名称`);
  if (typeof analyze !== 'function') throw new Error(`策略 ${id} 缺少 analyze()`);
  if (typeof review !== 'function') throw new Error(`策略 ${id} 缺少 review()`);
  const paramSchema = Array.isArray(def.paramSchema) ? def.paramSchema : [];
  const seen = new Set();
  for (const spec of paramSchema) {
    assertParamSpec(spec, id);
    if (seen.has(spec.key)) throw new Error(`策略 ${id} 的参数 ${spec.key} 重复`);
    seen.add(spec.key);
  }
  const normalized = {
    id,
    name,
    description: String(def.description || ''),
    engine: String(def.engine || 'enhanced'),
    modelId: String(def.modelId || `${id}-rules-v1`),
    needsAux: Array.isArray(def.needsAux) ? [...def.needsAux] : [],
    paramSchema,
    priority: Number.isFinite(def.priority) ? def.priority : 100,
    builtin: def.builtin !== false,
    analyze: def.analyze,
    review: def.review,
    prefilter: typeof def.prefilter === 'function' ? def.prefilter : null,
    // ⚠️ decoratePlan 必须一起归一化保留。此前漏了它 → globalAutomation 里那句
    //   `if (typeof strategy.decoratePlan === 'function')` 对所有策略恒为 false，
    //   于是「给原生不带 exitRules 的引擎补该策略出场规则」这条路径**从未执行过**，
    //   相关策略的订单只能回退全局默认出场规则（与策略参数不一致）。
    decoratePlan: typeof def.decoratePlan === 'function' ? def.decoratePlan : null
  };
  registry.set(id, Object.freeze(normalized));
  return normalized;
}

export function hasStrategy(id) {
  return registry.has(String(id || ''));
}

export function getStrategy(id) {
  return registry.get(String(id || '')) || null;
}

/** 全部已注册策略（按 priority 升序，优先级数字小者先跑） */
export function listStrategies() {
  return [...registry.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/** 仅供测试：清空注册表 */
export function clearStrategies() {
  registry.clear();
}

/** 参数模式的默认值对象 */
export function defaultParams(schema = []) {
  return Object.fromEntries(schema.map(spec => [spec.key, spec.default]));
}

/**
 * 按参数模式解析/校验覆盖值：越界或类型不符即回退默认值并记入 rejected。
 * 与 enhancedAnalysis.resolveEnhancedParams 规则一致（后者额外做策略一致性告警）。
 * @returns {{ params: object, rejected: Array<{key:string, value:*, reason:string}> }}
 */
export function resolveParams(schema = [], overrides = {}) {
  const params = defaultParams(schema);
  const rejected = [];
  if (!isPlainObject(overrides)) return { params, rejected };
  for (const spec of schema) {
    const raw = overrides[spec.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (spec.type === 'boolean') {
      if (typeof raw === 'boolean') { params[spec.key] = raw; continue; }
      const text = String(raw).trim();
      if (/^(true|1|yes)$/i.test(text)) { params[spec.key] = true; continue; }
      if (/^(false|0|no)$/i.test(text)) { params[spec.key] = false; continue; }
      rejected.push({ key: spec.key, value: raw, reason: '需要布尔值' });
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value) && value >= spec.min && value <= spec.max) params[spec.key] = value;
    else rejected.push({ key: spec.key, value: raw, reason: `需要在 ${spec.min}~${spec.max}` });
  }
  return { params, rejected };
}

/**
 * 只保留 schema 里存在的键，并做合法性校验（用于 PUT 接口）。
 * @returns {{ patch: object, rejected: Array }}
 */
export function sanitizePatch(schema = [], patch = {}) {
  const { params, rejected } = resolveParams(schema, patch);
  const patchKeys = new Set(Object.keys(isPlainObject(patch) ? patch : {}).filter(key => schema.some(spec => spec.key === key)));
  return { patch: Object.fromEntries([...patchKeys].map(key => [key, params[key]])), rejected };
}
