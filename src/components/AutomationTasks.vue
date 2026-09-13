<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const state = ref(null), error = ref(''), busy = ref(false);
let timer, disposed = false, loading = false;
const names = { klineSync: '全市场拉取 → 分析 → 挂单', positionReview: '挂单与持仓管理 → 盈亏更新' };
const time = value => value ? new Date(value).toLocaleString() : '—';
async function load() {
  if (loading || disposed) return;
  loading = true;
  try { const next = await api('/automation/status'); if (!disposed) { state.value = next; error.value = ''; } }
  catch (e) { if (!disposed) error.value = e.message; }
  finally { loading = false; }
}
async function action(path, method = 'POST', body) {
  if (busy.value) return;
  busy.value = true;
  try { await api(path, { method, body }); await load(); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
onMounted(() => { load(); timer = setInterval(() => { if (!document.hidden) load(); }, 10000); });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <section class="history-panel automation-tasks">
    <div class="section-head">
      <h3>自动任务 · 仅两项</h3>
      <button v-if="state" class="secondary" :disabled="busy" @click="action(`/automation/${state.active ? 'stop' : 'start'}`)">
        {{ state.active ? '停止自动任务' : '启动自动任务' }}
      </button>
    </div>
    <p class="muted">沿用当前策略配置。全市场按币种逐个拉取并立即分析；订单管理独立更新活跃订单行情。停止后，本轮在安全检查点退出，自动撮合与盈亏刷新也会停止。</p>
    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <div v-if="state" class="task-grid">
      <article v-for="(task, key) in state.tasks" :key="key">
        <h4>{{ names[key] || key }}</h4>
        <p>{{ task.running ? '执行中' : !task.enabled ? '已暂停' : state.active ? '等待下一轮' : '已停止' }}</p>
        <p>每轮完成后等待 {{ task.interval / 1000 }} 秒</p>
        <p>进度 {{ task.progress?.completed || 0 }} / {{ task.progress?.total || 0 }} · 失败 {{ task.progress?.failed || 0 }}</p>
        <p v-if="task.progress?.symbol">当前币种：{{ task.progress.symbol }}</p>
        <small>最近完成：{{ time(task.lastRun) }}</small>
        <small>下一轮：{{ state.active && task.enabled ? time(task.nextRunAt) : '—' }}</small>
        <p v-if="key === 'positionReview'">本次启动以来：撤单 {{ task.cancelled || 0 }} · 宽限保留 {{ task.graced || 0 }} · 改价 {{ task.repriced || 0 }}</p>
        <p v-if="task.error" class="signal-warning">{{ task.error }}</p>
        <div class="task-actions">
          <button class="secondary" :disabled="busy" @click="action(`/automation/tasks/${key}`, 'PUT', { enabled: !task.enabled })">{{ task.enabled ? '暂停此任务' : '启用此任务' }}</button>
          <button class="ghost" :disabled="busy || task.running || !task.enabled" @click="action(`/automation/tasks/${key}/trigger`)">执行一轮</button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.automation-tasks { margin: 18px 0; }
.task-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.task-grid article { border: 1px solid var(--border-primary); border-radius: 8px; padding: 16px; }
.task-grid small { display: block; margin: 6px 0; }
.task-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
@media (max-width: 700px) { .task-grid { grid-template-columns: 1fr; } }
</style>
