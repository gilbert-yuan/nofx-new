<script setup>
/**
 * StrategiesView · 策略管理
 *
 * 多策略体系的前端入口（对应数据源 /api/strategies）：
 *   - 勾选参与自动化的策略（可多选，按优先级依次扫描）
 *   - 按分组编辑每个策略的量化参数（越界会被后端拒绝并回退默认值）
 *   - 单个策略参数一键恢复默认
 *
 * 关键语义：订单在下单时会**快照所属策略与参数**（analysisContext.strategyId /
 * strategyParams），之后持仓复核与逐根出场结算都只读订单上的这份快照 ——
 * 因此改参数只影响**新订单**，不会回写已在途订单的出场规则。
 */
import { ref, onMounted, computed } from 'vue';
import { strategiesApi } from '../api/client.js';

const data = ref(null);
const drafts = ref({});
const notesDrafts = ref({});
const expanded = ref({});
const busy = ref({});
const error = ref('');
const notice = ref('');

const strategies = computed(() => data.value?.strategies || []);
const groupLabels = computed(() => data.value?.groupLabels || {});
const enabledCount = computed(() => strategies.value.filter((s) => s.enabled).length);

/** 按 paramSchema 的 group 分组（保持 schema 内首次出现顺序） */
function groupOf(item) {
  const order = [];
  const byGroup = new Map();
  for (const spec of item.paramSchema || []) {
    const key = spec.group || 'other';
    if (!byGroup.has(key)) { byGroup.set(key, []); order.push(key); }
    byGroup.get(key).push(spec);
  }
  return order.map((key) => ({ key, label: groupLabels.value[key] || key, specs: byGroup.get(key) }));
}

function draft(item) {
  return drafts.value[item.id] || item.params;
}

function isDirty(item) {
  const d = drafts.value[item.id];
  if (!d) return false;
  return Object.keys(d).some((k) => d[k] !== item.params[k]);
}

function changed(item, spec) {
  const d = drafts.value[item.id];
  if (!d) return false;
  return d[spec.key] !== item.params[spec.key];
}

async function guard(key, fn) {
  if (busy.value[key]) return;
  busy.value = { ...busy.value, [key]: true };
  try { await fn(); }
  catch (e) { error.value = e.message; }
  finally { busy.value = { ...busy.value, [key]: false }; }
}

function applyStrategy(next) {
  const list = data.value.strategies;
  const index = list.findIndex((s) => s.id === next.id);
  if (index >= 0) list.splice(index, 1, next);
  else list.push(next);
  drafts.value = { ...drafts.value, [next.id]: { ...next.params } };
  notesDrafts.value = { ...notesDrafts.value, [next.id]: next.notes || '' };
}

async function load() {
  error.value = '';
  const res = await strategiesApi.list();
  data.value = res;
  const next = {};
  const notes = {};
  for (const item of res.strategies) {
    next[item.id] = { ...item.params };
    notes[item.id] = item.notes || '';
  }
  drafts.value = next;
  notesDrafts.value = notes;
}

const toggle = (item) => guard(item.id, async () => {
  notice.value = '';
  const res = await strategiesApi.update(item.id, { enabled: !item.enabled });
  applyStrategy(res.strategy);
  notice.value = `${res.strategy.name} 已${res.strategy.enabled ? '加入' : '移出'}自动化扫描（当前启用 ${enabledCount.value} 个）。`;
});

/** 只提交改过的参数：没动的项不进落盘文件，避免 data/strategies.json 被默认值塞满 */
function dirtyParams(item) {
  const d = drafts.value[item.id];
  if (!d) return {};
  const out = {};
  for (const key of Object.keys(d)) if (d[key] !== item.params[key]) out[key] = d[key];
  return out;
}

const save = (item) => guard(item.id, async () => {
  notice.value = '';
  const res = await strategiesApi.update(item.id, { params: dirtyParams(item) });
  applyStrategy(res.strategy);
  if (res.rejected?.length) {
    error.value = `${item.name} 有 ${res.rejected.length} 项参数越界已被回退默认值：`
      + res.rejected.map((r) => `${r.key}（${r.reason}）`).join('；');
  } else {
    notice.value = `${item.name} 参数已保存，下一轮自动化生效（不影响已在途订单）。`;
  }
});

const reset = (item) => guard(item.id, async () => {
  notice.value = '';
  const res = await strategiesApi.reset(item.id);
  applyStrategy(res.strategy);
  notice.value = `${item.name} 参数已恢复默认值。`;
});

const notesDirty = (item) => (notesDrafts.value[item.id] ?? '') !== (item.notes || '');

const saveNotes = (item) => guard(item.id, async () => {
  if (!notesDirty(item)) return;
  notice.value = '';
  const res = await strategiesApi.update(item.id, { notes: notesDrafts.value[item.id] ?? '' });
  applyStrategy(res.strategy);
  notice.value = res.strategy.notes
    ? `${res.strategy.name} 备注已保存：${res.strategy.notes}`
    : `${res.strategy.name} 备注已清除。`;
});

const discard = (item) => { drafts.value = { ...drafts.value, [item.id]: { ...item.params } }; };

onMounted(() => { load().catch((e) => { error.value = e.message; }); });
</script>

<template>
  <section class="history-panel strategies-view">
    <div class="view-heading">
      <div>
        <span class="eyebrow">STRATEGIES</span>
        <h2>策略管理</h2>
        <p>
          勾选参与自动化的策略（可多选）。勾选后自动化会按优先级依次用这些策略扫描全市场；
          <strong>每个订单在下单时记录自己所属的策略与参数</strong>，之后持仓复核与出场结算
          （移动止损 / 智能退出 / 分批止盈）均按该订单自己的策略规则执行。
        </p>
      </div>
    </div>

    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>

    <section v-if="data" class="history-panel strategies-panel">
      <div class="section-head">
        <h3>策略清单</h3>
        <span class="muted">启用 {{ enabledCount }} / {{ strategies.length }}</span>
      </div>

      <article v-for="item in strategies" :key="item.id" class="strategy-card" :class="{ off: !item.enabled }">
        <header class="strategy-head">
          <label class="strategy-toggle">
            <input type="checkbox" :checked="item.enabled" :disabled="busy[item.id]" @change="toggle(item)" />
            <span class="strategy-name">{{ item.name }}</span>
          </label>
          <div class="strategy-tags">
            <span class="tag">引擎 {{ item.engine }}</span>
            <span class="tag">优先级 {{ item.engine === 'ai' ? '—' : item.priority }}</span>
            <span v-if="item.builtin" class="tag tag-soft">内置</span>
            <span v-if="item.needsAux?.length" class="tag tag-soft">需辅助周期 {{ item.needsAux.join('/') }}</span>
          </div>
          <span class="strategy-state" :class="{ on: item.enabled }">{{ item.enabled ? '已启用' : '未启用' }}</span>
        </header>

        <p class="strategy-desc">{{ item.description }}</p>

        <div class="strategy-notes">
          <label class="notes-label" :for="`notes-${item.id}`">备注</label>
          <input
            :id="`notes-${item.id}`"
            v-model="notesDrafts[item.id]"
            class="notes-input"
            type="text"
            maxlength="200"
            placeholder="例如：只做多（当前禁空）"
            :disabled="busy[item.id]"
            @change="saveNotes(item)"
            @keyup.enter="saveNotes(item)"
          />
          <span class="notes-hint">{{ notesDirty(item) ? '回车或失焦保存' : '仅作说明，不影响任何计算' }}</span>
        </div>

        <p class="muted strategy-id">ID <code>{{ item.id }}</code> · 模型 <code>{{ item.modelId }}</code> · 参数 {{ item.paramSchema.length }} 项</p>

        <div class="strategy-actions">
          <button class="ghost" @click="expanded = { ...expanded, [item.id]: !expanded[item.id] }">
            {{ expanded[item.id] ? '收起参数' : `展开参数（${item.paramSchema.length}）` }}
          </button>
          <template v-if="expanded[item.id]">
            <button class="primary" :disabled="busy[item.id] || !isDirty(item)" @click="save(item)">保存参数</button>
            <button class="secondary" :disabled="busy[item.id] || !isDirty(item)" @click="discard(item)">放弃修改</button>
            <button class="secondary" :disabled="busy[item.id]" @click="reset(item)">恢复默认</button>
          </template>
        </div>

        <div v-if="expanded[item.id]" class="param-groups">
          <fieldset v-for="group in groupOf(item)" :key="group.key" class="param-group">
            <legend>{{ group.label }}</legend>
            <div class="param-grid">
              <label v-for="spec in group.specs" :key="spec.key" class="param-row" :class="{ changed: changed(item, spec) }">
                <span class="param-label">{{ spec.label }}</span>
                <template v-if="spec.type === 'boolean'">
                  <input type="checkbox" v-model="drafts[item.id][spec.key]" :disabled="busy[item.id]" />
                </template>
                <template v-else>
                  <input
                    type="number"
                    v-model.number="drafts[item.id][spec.key]"
                    :min="spec.min" :max="spec.max" :step="spec.step || 1"
                    :disabled="busy[item.id]"
                  />
                </template>
                <small class="param-meta">
                  默认 {{ item.defaults[spec.key] }}
                  <template v-if="spec.min !== undefined"> · 范围 {{ spec.min }}~{{ spec.max }}</template>
                </small>
                <small v-if="spec.description" class="param-desc">{{ spec.description }}</small>
              </label>
            </div>
          </fieldset>
        </div>
      </article>

      <p class="muted strategies-foot">
        改动落盘在 <code>data/strategies.json</code>；运行时不做缓存，保存后下一轮自动化任务即生效。
        参数越界会被自动拒绝并回退默认值（不会写入非法值）。
      </p>
    </section>

    <p v-else-if="!error" class="muted">正在读取策略配置…</p>
  </section>
</template>

<style scoped>
.strategies-view { display: block; }
.strategies-panel { margin-top: 18px; }
.strategy-card {
  border: 1px solid var(--border-primary);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 14px;
  background: var(--bg-card);
}
.strategy-card.off { opacity: 0.72; }
.strategy-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.strategy-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.strategy-name { font-family: var(--font-display); font-size: 15px; font-weight: 600; color: var(--text-primary); }
.strategy-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag {
  border: 1px solid var(--border-primary);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 11px;
  color: var(--text-tertiary);
}
.tag-soft { background: var(--state-hover); }
.strategy-state {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
  border: 1px solid var(--border-secondary);
  border-radius: 999px;
  padding: 2px 10px;
}
.strategy-state.on { color: var(--brand-primary); border-color: var(--brand-primary); background: var(--brand-bg); }
.strategy-desc { margin: 10px 0 4px; font-size: 13px; color: var(--text-secondary); line-height: 1.6; }
.strategy-notes { display: flex; align-items: center; gap: 8px; margin: 8px 0 2px; flex-wrap: wrap; }
.notes-label { font-size: 12px; color: var(--text-tertiary); }
.notes-input {
  flex: 1 1 200px;
  max-width: 420px;
  background: var(--bg-input);
  border: 1px solid var(--border-secondary);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 13px;
  color: var(--text-primary);
}
.notes-hint { font-size: 12px; color: var(--text-muted); }
.strategy-id { font-size: 12px; margin: 0; }
.strategy-id code, .strategies-foot code {
  font-family: var(--font-mono);
  background: var(--bg-input);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
}
.strategy-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.param-groups { margin-top: 14px; }
.param-group {
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  padding: 10px 14px 14px;
  margin-bottom: 10px;
}
.param-group legend { font-size: 12px; color: var(--text-tertiary); padding: 0 6px; }
.param-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px 18px; }
.param-row { display: grid; grid-template-columns: 1fr 96px; gap: 4px 10px; align-items: center; padding: 4px 6px; border-radius: 6px; }
.param-row.changed { background: var(--brand-bg); }
.param-label { font-size: 12px; color: var(--text-secondary); }
.param-meta { grid-column: 1 / -1; font-size: 11px; color: var(--text-muted); }
.param-desc { grid-column: 1 / -1; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.strategies-foot { margin-top: 14px; font-size: 12px; line-height: 1.7; }
@media (max-width: 700px) { .param-grid { grid-template-columns: 1fr; } }
</style>
