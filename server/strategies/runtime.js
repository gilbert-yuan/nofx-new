/**
 * 策略运行时：把「注册表里的策略定义」与「持久化的启用集 / 参数覆盖」合到一起。
 *
 * 持久化文件：data/strategies.json
 *   {
 *     version: 1,
 *     enabled: ["enhanced-trend-v1"],      // null = 尚未初始化，按 config.analysis.engine 推导
 *     overrides: { "<id>": { "<paramKey>": value } },
 *     notes: { "<id>": "做多" },            // 人工备注（说明该策略当前用途/方向，不参与任何计算）
 *     updatedAt: "..."
 *   }
 *
 * 改造要点：首次运行时把既有的 `config.analysis.engine` 平移成启用集，
 * 保证升级前后「自动化跑的策略」完全一致（enhanced → enhanced-trend-v1）。
 */
import { listStrategies, getStrategy, resolveParams, defaultParams } from './registry.js';
import { ENGINE_DEFAULT_STRATEGY } from './builtins.js';

const VERSION = 1;

/** 备注最大长度（超长截断，避免把说明文字当存储用） */
export const MAX_NOTES_LENGTH = 200;

/** 备注归一化：折叠空白、去首尾、限长。空串表示「无备注」。 */
export function normalizeNotes(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTES_LENGTH);
}

const emptyState = () => ({ version: VERSION, enabled: null, overrides: {}, notes: {}, updatedAt: null });

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

  async readState() {
    if (typeof this.store?.getStrategies !== 'function') return emptyState();
    try {
      const raw = await this.store.getStrategies();
      if (!raw || typeof raw !== 'object') return emptyState();
      return {
        ...emptyState(),
        ...raw,
        overrides: (raw.overrides && typeof raw.overrides === 'object') ? raw.overrides : {},
        notes: sanitizeNotes(raw.notes)
      };
    } catch {
      return emptyState();
    }
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
   * 读取状态，必要时初始化并落盘。
   *
   * 顺带清理「已下线策略」残留在启用集里的 id：这类 id 取不到定义，
   * 既不会出现在策略列表里、也不会被 enabled() 跑，只会让前端的
   * 「启用 N / M」计数虚高（策略删除后最容易踩到的隐形残留）。
   */
  async ensureState(config) {
    const state = await this.readState();
    if (!Array.isArray(state.enabled)) {
      state.enabled = this.defaultEnabled(config);
      return this.writeState(state);
    }
    const known = new Set(listStrategies().map(s => s.id));
    const alive = state.enabled.filter(id => known.has(id));
    if (alive.length !== state.enabled.length) {
      // 重排为注册表顺序，与 update() 的写入顺序保持一致
      state.enabled = listStrategies().map(s => s.id).filter(id => alive.includes(id));
      return this.writeState(state);
    }
    return state;
  }

  /** 某个策略的有效参数（默认值 + 已保存的覆盖） */
  effectiveParams(def, state) {
    const overrides = state.overrides?.[def.id];
    return resolveParams(def.paramSchema, overrides || {}).params;
  }

  /** 运行时就绪的策略列表（含 params）—— 自动化用它来跑分析 */
  async enabled(config) {
    const state = await this.ensureState(config);
    return state.enabled
      .map(id => getStrategy(id))
      .filter(Boolean)
      .map(def => ({ ...def, params: this.effectiveParams(def, state) }));
  }

  /** 给 API / 前端：全量策略 + 启用状态 + 有效参数 + 默认值 */
  async list(config) {
    const state = await this.ensureState(config);
    const enabledSet = new Set(state.enabled);
    return {
      enabled: [...state.enabled],
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
        builtin: def.builtin,
        enabled: enabledSet.has(def.id),
        notes: state.notes?.[def.id] || '',
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

    if (typeof patch.enabled === 'boolean') {
      const set = new Set(state.enabled);
      if (patch.enabled) set.add(def.id); else set.delete(def.id);
      state.enabled = listStrategies().map(s => s.id).filter(key => set.has(key));
    }

    if (patch.params && typeof patch.params === 'object') {
      const { params, rejected: bad } = resolveParams(def.paramSchema, patch.params);
      rejected.push(...bad);
      // 只落盘「本次显式提交且合法」的键：
      //   · 与默认值相同也照样写入 —— 那是用户明确设过的意图，应当可见、可追溯；
      //   · 未提交的键保持原样（调用方可以只提交改动项，文件不会被默认值塞满）；
      //   · 校验失败的键既不改值也不落盘。
      // 清空请用 reset()（恢复默认）。
      const badKeys = new Set(bad.map((item) => item.key));
      const merged = { ...(state.overrides[def.id] || {}) };
      for (const spec of def.paramSchema) {
        if (!Object.prototype.hasOwnProperty.call(patch.params, spec.key)) continue;
        if (badKeys.has(spec.key)) continue;
        merged[spec.key] = params[spec.key];
      }
      state.overrides = { ...state.overrides, [def.id]: merged };
    }

    // 备注：纯展示用途，不参与任何分析计算；传空串即清除
    if (typeof patch.notes === 'string') {
      const note = normalizeNotes(patch.notes);
      const notes = { ...(state.notes || {}) };
      if (note) notes[def.id] = note; else delete notes[def.id];
      state.notes = notes;
    }

    await this.writeState(state);
    return { strategy: await this.describe(def.id, config), rejected };
  }

  /** 恢复某策略的参数为默认值（不影响启用状态） */
  async reset(id, config) {
    const def = getStrategy(id);
    if (!def) throw Object.assign(new Error(`未知策略：${id}`), { status: 404 });
    const state = await this.ensureState(config);
    const overrides = { ...state.overrides };
    delete overrides[def.id];
    state.overrides = overrides;
    await this.writeState(state);
    return { strategy: await this.describe(def.id, config) };
  }

  /** 订单 → 该订单所属的策略（含参数）。订单未标记策略时回退到默认策略。 */
  resolveForOrder(order, strategies, config) {
    const id = order?.analysisContext?.strategyId;
    if (id) {
      const found = strategies.find(item => item.id === id);
      if (found) return found;
    }
    const fallbackId = this.defaultEnabled(config)[0];
    return strategies.find(item => item.id === fallbackId) || strategies[0] || null;
  }
}

export function createStrategyRuntime(options) {
  return new StrategyRuntime(options);
}
