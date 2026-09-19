<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const state = ref(null), error = ref(''), busy = ref(false);
let timer, disposed = false, loading = false;
const names = { klineSync: '全市场拉取 → 分析 → 挂单', positionReview: '挂单与持仓管理 → 盈亏更新' };
const time = value => value ? new Date(value).toLocaleString() : '—';
const price = value => Number.isFinite(Number(value)) ? Number(value).toPrecision(8).replace(/\.?(0+)(e|$)/, '$2') : '—';
const range = value => value ? `${price(value.min)}～${price(value.max)}` : '—';
const pct = value => Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : '—';
const funding = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(4)}%` : '—';
const decisionClass = code => code === 'BUY_NOW' || code === 'SELL_NOW' ? 'opportunity-go' : 'opportunity-wait';
const yaoDirectionClass = direction => direction === 'UP' ? 'yao-up' : direction === 'DOWN' ? 'yao-down' : 'yao-neutral';
const yaoEntryLabel = direction => direction === 'UP' ? '最佳买入' : direction === 'DOWN' ? '最佳做空' : '最佳入场';
const yaoReasons = reasons => Array.isArray(reasons) && reasons.length ? reasons.join('；') : '—';
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
        <p v-if="task.progress?.stage">当前阶段：{{ task.progress.stage }}</p>
        <p v-if="task.lastSummary" class="task-summary">{{ task.lastSummary }}</p>
        <small>最近完成：{{ time(task.lastRun) }}</small>
        <small v-if="task.lastSummaryAt">摘要时间：{{ time(task.lastSummaryAt) }}</small>
        <small>下一轮：{{ state.active && task.enabled ? time(task.nextRunAt) : '—' }}</small>
        <p v-if="key === 'positionReview'">本次启动以来：撤单 {{ task.cancelled || 0 }} · 宽限保留 {{ task.graced || 0 }} · 改价 {{ task.repriced || 0 }}</p>
        <p v-if="task.error" class="signal-warning">{{ task.error }}</p>
        <div class="task-actions">
          <button class="secondary" :disabled="busy" @click="action(`/automation/tasks/${key}`, 'PUT', { enabled: !task.enabled })">{{ task.enabled ? '暂停此任务' : '启用此任务' }}</button>
          <button class="ghost" :disabled="busy || task.running || !task.enabled" @click="action(`/automation/tasks/${key}/trigger`)">执行一轮</button>
        </div>
      </article>
    </div>
    <section class="opportunity-panel">
      <div class="section-head">
        <div><h3>策略机会 · 超级确认</h3><p class="muted">先由现有策略选币和定方向，再由独立确认层判断是否追入或等待更好价格。</p></div>
      </div>
      <p v-if="!state?.opportunities?.length" class="muted">暂未发现有效机会。策略观望、数据不足或风险计划不合格的币种不会显示在这里。</p>
      <div v-else class="opportunity-grid">
        <article v-for="item in state.opportunities" :key="item.symbol + '-' + item.generatedAt" class="opportunity-card">
          <div class="opportunity-head">
            <div><strong>{{ item.symbol }}</strong><small>{{ item.strategyName || item.strategyId || '策略' }} · {{ item.interval }}</small></div>
            <span :class="decisionClass(item.decision?.code)">{{ item.decision?.label || item.recommendation }}</span>
          </div>
          <div class="opportunity-stats">
            <div><span>当前价</span><strong>{{ price(item.current?.price) }}</strong></div>
            <div><span>24h</span><strong>{{ pct(item.current?.change24hPct) }}</strong></div>
            <div><span>OI</span><strong>{{ pct(item.current?.oiChangePct) }}</strong></div>
            <div><span>资金费率</span><strong>{{ funding(item.current?.fundingRate) }}</strong></div>
          </div>
          <dl class="opportunity-levels">
            <div><dt>理想入场</dt><dd>{{ range(item.levels?.entryRange) }} · 参考 {{ price(item.levels?.optimalEntry) }}</dd></div>
            <div><dt>止损</dt><dd>{{ price(item.levels?.stopLoss) }}</dd></div>
            <div><dt>止盈</dt><dd>{{ item.levels?.takeProfits?.length ? item.levels.takeProfits.map(price).join(' / ') : '—' }}</dd></div>
          </dl>
          <p class="opportunity-summary">{{ item.summary }}</p>
          <small>生成时间：{{ time(item.generatedAt) }} · {{ item.canProceed ? '当前可按计划继续' : '当前等待确认，不追价' }}</small>
        </article>
      </div>
    </section>
    <section class="yao-panel">
      <div class="section-head">
        <div>
          <h3>可能妖币 · 启动前预测</h3>
          <p class="muted">上涨和下跌都纳入预测。目标是 24h 涨跌幅绝对值或高低振幅达到 ±{{ state?.yaoCoinMeta?.targetAmplitudePct || 50 }}%；预测同时给出方向、幅度、目标价和最佳入场位置。</p>
        </div>
        <small v-if="state?.yaoCoinMeta?.asOf">行情时间：{{ time(state.yaoCoinMeta.asOf) }}</small>
      </div>
      <p v-if="state?.yaoCoinMeta?.error" class="signal-warning">妖币 24h 快照暂时失败：{{ state.yaoCoinMeta.error }}。当前候选仍按已缓存 K 线展示。</p>
      <p v-if="!state?.yaoCoins?.length" class="muted">本轮没有达到观察门槛的候选。候选会在全市场行情同步完成后更新，不代表没有普通策略机会。</p>
      <div v-else class="yao-grid">
        <article v-for="item in state.yaoCoins" :key="item.symbol + '-' + item.generatedAt" class="yao-card">
          <div class="yao-head">
            <div><strong>{{ item.symbol }}</strong><small>{{ item.stageLabel }} · 规则置信度 {{ item.probabilityPct }}%</small></div>
            <span :class="yaoDirectionClass(item.direction)">{{ item.directionLabel }}</span>
          </div>
          <div class="yao-stats">
            <div><span>当前价</span><strong>{{ price(item.current?.price) }}</strong></div>
            <div><span>当前24h</span><strong>{{ pct(item.current?.change24hPct) }}</strong></div>
            <div><span>当前振幅</span><strong>{{ pct(item.current?.amplitude24hPct) }}</strong></div>
            <div><span>预测涨跌幅</span><strong :class="yaoDirectionClass(item.direction)">{{ pct(item.predictedMovePct) }}</strong></div>
            <div><span>预测目标价</span><strong>{{ price(item.predictedTargetPrice) }}</strong></div>
          </div>
          <dl class="yao-levels">
            <div><dt>{{ yaoEntryLabel(item.direction) }}</dt><dd>{{ range(item.levels?.entryRange) }} · 参考 {{ price(item.levels?.optimalEntry) }}</dd></div>
            <div><dt>止损</dt><dd>{{ price(item.levels?.stopLoss) }}</dd></div>
            <div><dt>分档止盈</dt><dd>{{ item.levels?.takeProfits?.length ? item.levels.takeProfits.map(price).join(' / ') : '—' }}</dd></div>
          </dl>
          <div class="yao-features">
            <span>量能 {{ item.features?.volumeRatio == null ? '—' : `${Number(item.features.volumeRatio).toFixed(1)}x` }}</span>
            <span>波动 {{ item.features?.rangeRatio == null ? '—' : `${Number(item.features.rangeRatio).toFixed(1)}x` }}</span>
            <span>动量 {{ pct(item.features?.recentReturnPct) }}</span>
            <span>数据 {{ item.features?.dataSource === 'ticker24h+klines' ? '24h+K线' : 'K线降级' }}</span>
          </div>
          <p class="yao-reasons">{{ yaoReasons(item.reasons) }}</p>
          <small class="yao-warning">{{ item.warnings?.[0] }} · 仅观察，不自动下单</small>
        </article>
      </div>
    </section>
  </section>
</template>

<style scoped>
.automation-tasks { margin: 18px 0; }
.task-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.task-grid article { border: 1px solid var(--border-primary); border-radius: 8px; padding: 16px; }
.task-grid small { display: block; margin: 6px 0; }
.task-summary { font-size: 12px; line-height: 1.45; color: var(--text-secondary); word-break: break-word; }
.task-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.opportunity-panel { margin-top: 20px; border-top: 1px solid var(--border-primary); padding-top: 18px; }
.opportunity-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.opportunity-card { border: 1px solid var(--border-primary); border-radius: 8px; padding: 16px; background: var(--surface-secondary, transparent); }
.opportunity-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.opportunity-head strong { display: block; font-size: 18px; }
.opportunity-head small { display: block; margin-top: 4px; }
.opportunity-go, .opportunity-wait { display: inline-block; border-radius: 999px; padding: 5px 9px; font-size: 12px; line-height: 1.3; }
.opportunity-go { color: var(--positive, #1e8e5a); background: color-mix(in srgb, var(--positive, #1e8e5a) 12%, transparent); }
.opportunity-wait { color: var(--warning, #b26a00); background: color-mix(in srgb, var(--warning, #b26a00) 12%, transparent); }
.opportunity-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 16px 0; }
.opportunity-stats span, .opportunity-stats strong { display: block; }
.opportunity-stats span, .opportunity-levels dt { color: var(--text-tertiary); font-size: 12px; }
.opportunity-stats strong { margin-top: 4px; font-variant-numeric: tabular-nums; }
.opportunity-levels { margin: 0; border-top: 1px solid var(--border-primary); padding-top: 10px; }
.opportunity-levels > div { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.opportunity-levels dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.opportunity-summary { color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.yao-panel { margin-top: 20px; border-top: 1px solid var(--border-primary); padding-top: 18px; }
.yao-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.yao-card { border: 1px solid color-mix(in srgb, var(--warning, #b26a00) 38%, var(--border-primary)); border-radius: 8px; padding: 16px; background: color-mix(in srgb, var(--warning, #b26a00) 4%, transparent); }
.yao-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.yao-head strong { display: block; font-size: 18px; }
.yao-head small { display: block; margin-top: 4px; }
.yao-up, .yao-down, .yao-neutral { display: inline-block; border-radius: 999px; padding: 5px 9px; font-size: 12px; line-height: 1.3; }
.yao-up { color: var(--positive, #1e8e5a); background: color-mix(in srgb, var(--positive, #1e8e5a) 12%, transparent); }
.yao-down { color: var(--negative, #c0392b); background: color-mix(in srgb, var(--negative, #c0392b) 12%, transparent); }
.yao-neutral { color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent); }
.yao-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin: 16px 0; }
.yao-stats span, .yao-stats strong { display: block; }
.yao-stats span, .yao-levels dt { color: var(--text-tertiary); font-size: 12px; }
.yao-stats strong { margin-top: 4px; font-variant-numeric: tabular-nums; }
.yao-levels { margin: 0; border-top: 1px solid var(--border-primary); padding-top: 10px; }
.yao-levels > div { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.yao-levels dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.yao-features { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 12px; color: var(--text-secondary); font-size: 12px; }
.yao-reasons { color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.yao-warning { display: block; color: var(--text-tertiary); line-height: 1.45; }
@media (max-width: 700px) { .task-grid { grid-template-columns: 1fr; } }
@media (max-width: 900px) { .opportunity-grid { grid-template-columns: 1fr; } }
@media (max-width: 1100px) { .yao-grid { grid-template-columns: 1fr; } .yao-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 600px) { .yao-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
