/**
 * 策略运行时：把「注册表里的策略定义」与「持久化的启用集 / 参数覆盖」合到一起。
 *
 * 持久化文件：data/strategies.json
 *   {
 *     version: 2,
 *     initialized: true,
 *     strategies: {
 *       "enhanced-trend-v1": {
 *         enabled: true,
 *         params: { minTrendScore: 66, ... },
 *         notes: "做多"
 *       }
 *     },
 *     updatedAt: "..."
 *   }
 *
 * 改造要点：首次运行时把既有的 `config.analysis.engine` 平移成启用集，
 * 保证升级前后「自动化跑的策略」完全一致（enhanced → enhanced-trend-v1）。
 * v1（enabled/overrides/notes）文件会在首次读取时自动迁移到 v2；v2 把一个策略
 * 的启用状态、完整有效参数和备注放在同一条记录里，回测与线上运行共用这一份配置。
 */
import { listStrategies, getStrategy, resolveParams, defaultParams } from './registry.js';
import { ENGINE_DEFAULT_STRATEGY } from './builtins.js';

const VERSION = 2;

/** 备注最大长度（超长截断，避免把说明文字当存储用） */
export const MAX_NOTES_LENGTH = 200;

/** 备注归一化：折叠空白、去首尾、限长。空串表示「无备注」。 */
export function normalizeNotes(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTES_LENGTH);
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const emptyState = () => ({ version: VERSION, initialized: false, strategies: {}, updatedAt: null });

/** 备注只保留字符串值，脏数据（旧文件/手改）直接丢弃而不是抛错 */
function sanitizeNotes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, text] of Object.entries(raw)) {
    const note = normalizeNotes(text);
    if (note) out[id] = note;
  }
  return out;
}

function normalizeEntry(raw) {
  return {
    enabled: raw?.enabled === true,
    params: isPlainObject(raw?.params) ? { ...raw.params } : {},
    notes: normalizeNotes(raw?.notes)
  };
}

/** 将旧的 enabled/overrides/notes 结构转换成 v2 的按策略记录结构。 */
function normalizeState(raw) {
  if (isPlainObject(raw) && isPlainObject(raw.strategies)) {
    const strategies = Object.fromEntries(
      Object.entries(raw.strategies).map(([id, entry]) => [id, normalizeEntry(entry)])
    );
    return {
      state: {
        ...emptyState(),
        version: VERSION,
        initialized: typeof raw.initialized === 'boolean' ? raw.initialized : Object.keys(strategies).length > 0,
        strategies,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
      },
      migrated: raw.version !== VERSION
    };
  }

  const enabled = Array.isArray(raw?.enabled) ? new Set(raw.enabled) : null;
  const overrides = isPlainObject(raw?.overrides) ? raw.overrides : {};
  const notes = sanitizeNotes(raw?.notes);
  const ids = new Set([
    ...listStrategies().map(def => def.id),
    ...Object.keys(overrides),
    ...Object.keys(notes)
  ]);
  const strategies = {};
  for (const id of ids) {
    strategies[id] = normalizeEntry({
      enabled: enabled ? enabled.has(id) : false,
      params: overrides[id],
      notes: notes[id]
    });
  }
  return {
    state: { ...emptyState(), initialized: enabled !== null, strategies },
    migrated: true
  };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class StrategyRuntime {
  /**
   * @param {object} options
   * @param {object} options.store            需提供 getStrategies()/saveStrategies()（缺失时退化为内存态）
   * @param {(config:object)=>string} [options.resolveEngine] 由全局 config 推导默认引擎
   */
  constructor({ store, resolveEngine } = {}) {
    this.store = store;
    // 缺省引擎用 enhanced：`local`（本地多周期 v1）策略已下线，
    // 若还兜到 local 会取不到任何策略定义（见 defaultEnabled 的回退逻辑）。
    this.resolveEngine = typeof resolveEngine === 'function' ? resolveEngine : () => 'enhanced';
  }

  async readStateMeta() {
    if (typeof this.store?.getStrategies !== 'function') return { state: emptyState(), migrated: false };
    try {
      return normalizeState(await this.store.getStrategies());
    } catch {
      return { state: emptyState(), migrated: false };
    }
  }

  async readState() {
    return (await this.readStateMeta()).state;
  }

  async writeState(state) {
    const next = { ...state, version: VERSION, updatedAt: new Date().toISOString() };
    if (typeof this.store?.saveStrategies === 'function') await this.store.saveStrategies(next);
    return next;
  }

  /**
   * 未初始化时：按 config.analysis.engine 推导默认启用集。
   * 引擎没有对应策略时回落到 enhanced（而不是曾经写死的 local —— 该策略已下线）。
   */
  defaultEnabled(config) {
    const engine = this.resolveEngine(config || {});
    const id = ENGINE_DEFAULT_STRATEGY[engine] || ENGINE_DEFAULT_STRATEGY.enhanced;
    return getStrategy(id) ? [id] : listStrategies().slice(0, 1).map(s => s.id);
  }

  /**
   * 读取状态，必要时初始化、补齐新策略参数并落盘。
   * 新版本策略增加参数时，只给已有配置补上缺失的默认键，不覆盖用户已经保存的值。
   */
  async ensureState(config) {
    const { state: rawState, migrated } = await this.readStateMeta();
    const state = { ...rawState, strategies: { ...(rawState.strategies || {}) } };
    let changed = migrated;
    const defs = listStrategies();

    if (!state.initialized) {
      const defaults = new Set(this.defaultEnabled(config));
      for (const def of defs) {
        const current = normalizeEntry(state.strategies[def.id]);
        state.strategies[def.id] = { ...current, enabled: defaults.has(def.id) };
      }
      state.initialized = true;
      changed = true;
    }

    for (const def of defs) {
      const current = normalizeEntry(state.strategies[def.id]);
      const params = resolveParams(def.paramSchema, current.params).params;
      const next = { ...current, params };
      if (!sameJson(next, state.strategies[def.id])) changed = true;
      state.strategies[def.id] = next;
    }

    return changed ? this.writeState(state) : state;
  }

  /** 某个策略的有效参数（默认值 + 配置文件中的完整参数） */
  effectiveParams(def, state) {
    return resolveParams(def.paramSchema, state.strategies?.[def.id]?.params || {}).params;
  }

  /** 将注册表定义和一份参数快照合成可执行策略对象。 */
  materialize(def, params = {}) {
    return { ...def, params: resolveParams(def.paramSchema, params).params };
  }

  /** 运行时就绪的策略列表（含 params）—— 自动化用它来跑分析 */
  async enabled(config) {
    const state = await this.ensureState(config);
    return listStrategies()
      .filter(def => state.strategies?.[def.id]?.enabled === true)
      .map(def => this.materialize(def, this.effectiveParams(def, state)));
  }

  /** 全量已注册策略（包括停用策略），供存量订单恢复原策略配置。 */
  async all(config) {
    const state = await this.ensureState(config);
    return listStrategies().map(def => this.materialize(def, this.effectiveParams(def, state)));
  }

  /** 按策略 id 读取当前配置；snapshotParams 存在时优先恢复订单快照。 */
  async configured(id, config = {}, snapshotParams = null) {
    const def = getStrategy(id);
    if (!def) return null;
    if (isPlainObject(snapshotParams)) return this.materialize(def, snapshotParams);
    const state = await this.ensureState(config);
    return this.materialize(def, this.effectiveParams(def, state));
  }

  /** 给 API / 前端：全量策略 + 启用状态 + 有效参数 + 默认值 */
  async list(config) {
    const state = await this.ensureState(config);
    const enabled = listStrategies()
      .filter(def => state.strategies?.[def.id]?.enabled === true)
      .map(def => def.id);
    const enabledSet = new Set(enabled);
    return {
      enabled,
      updatedAt: state.updatedAt || null,
      strategies: listStrategies().map(def => ({
        id: def.id,
        name: def.name,
        description: def.description,
        engine: def.engine,
        modelId: def.modelId,
        // 优先级要暴露给前端：StrategiesView 的策略卡上有「优先级 N」标签，
        // 此前漏传导致所有卡片的标签都是空的（引擎标签正常，容易看不出来）。
        priority: def.priority,
        needsAux: def.needsAux,
        marketWindow: def.marketWindow,
        marketWindows: def.marketWindows,
        marketContext: def.marketContext,
        // 原生计划周期（15m/4h 策略的订单周期口径）也要暴露给前端，漏传会显示为空
        planInterval: def.planInterval,
        builtin: def.builtin,
        enabled: enabledSet.has(def.id),
        notes: state.strategies?.[def.id]?.notes || '',
        paramSchema: def.paramSchema,
        params: this.effectiveParams(def, state),
        defaults: defaultParams(def.paramSchema)
      }))
    };
  }

  /** 单策略快照（找不到返回 null） */
  async describe(id, config) {
    const all = await this.list(config);
    return all.strategies.find(item => item.id === String(id || '')) || null;
  }

  /**
   * 更新启用状态 / 参数覆盖。
   * @param {string} id
   * @param {{enabled?:boolean, params?:object, notes?:string}} patch
   */
  async update(id, patch = {}, config) {
    const def = getStrategy(id);
    if (!def) throw Object.assign(new Error(`未知策略：${id}`), { status: 404 });
    const state = await this.ensureState(config);
    const rejected = [];
    const entry = normalizeEntry(state.strategies[def.id]);

    if (typeof patch.enabled === 'boolean') entry.enabled = patch.enabled;

    if (isPlainObject(patch.params)) {
      const { rejected: bad } = resolveParams(def.paramSchema, patch.params);
      rejected.push(...bad);
      const badKeys = new Set(bad.map((item) => item.key));
      const current = this.effectiveParams(def, state);
      const merged = { ...current };
      for (const spec of def.paramSchema) {
        if (!Object.prototype.hasOwnProperty.call(patch.params, spec.key)) continue;
        if (badKeys.has(spec.key)) continue;
        merged[spec.key] = resolveParams(def.paramSchema, {
          ...current,
          [spec.key]: patch.params[spec.key]
        }).params[spec.key];
      }
      entry.params = merged;
    }

    // 备注：纯展示用途，不参与任何分析计算；传空串即清除
    if (typeof patch.notes === 'string') {
      entry.notes = normalizeNotes(patch.notes);
    }

    state.strategies = { ...state.strategies, [def.id]: entry };
    await this.writeState(state);
    return { strategy: await this.describe(def.id, config), rejected };
  }

  /** 恢复某策略的参数为默认值（不影响启用状态） */
  async reset(id, config) {
    const def = getStrategy(id);
    if (!def) throw Object.assign(new Error(`未知策略：${id}`), { status: 404 });
    const state = await this.ensureState(config);
    state.strategies = {
      ...state.strategies,
      [def.id]: {
        ...normalizeEntry(state.strategies[def.id]),
        params: defaultParams(def.paramSchema)
      }
    };
    await this.writeState(state);
    return { strategy: await this.describe(def.id, config) };
  }

  /**
   * 订单 → 该订单所属的策略（含参数）。订单快照优先于当前配置，保证改配置/停策略
   * 不会改变已在途订单；没有快照的旧订单才回退当前策略配置或默认值。
   */
  resolveForOrder(order, strategies, config) {
    const available = Array.isArray(strategies) ? strategies : [];
    const id = order?.analysisContext?.strategyId;
    if (id) {
      const def = getStrategy(id);
      if (def) {
        const snapshot = order?.analysisContext?.strategyParams;
        if (isPlainObject(snapshot)) return this.materialize(def, snapshot);
        const found = available.find(item => item.id === id);
        if (found) return found;
        return this.materialize(def);
      }
    }
    const fallbackId = this.defaultEnabled(config)[0];
    return available.find(item => item.id === fallbackId) || available[0] || null;
  }

  /** 异步订单解析：没有快照时也能从配置文件恢复已停用策略的当前参数。 */
  async strategyForOrder(order, config = {}, strategies = []) {
    const id = order?.analysisContext?.strategyId;
    if (id) {
      const snapshot = order?.analysisContext?.strategyParams;
      const configured = await this.configured(id, config, snapshot);
      if (configured) return configured;
    }
    return strategies.find(item => item.id === this.defaultEnabled(config)[0])
      || strategies[0]
      || (await this.enabled(config))[0]
      || null;
  }
}

export function createStrategyRuntime(options) {
  return new StrategyRuntime(options);
}
