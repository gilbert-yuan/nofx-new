<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api.js';
import AutomationTasks from './AutomationTasks.vue';
const account = ref(null), plans = ref([]), selected = ref(''), margin = ref(100), leverage = ref(1), stopLoss = ref(0), takeProfit = ref(0);
const busy = ref(false), error = ref(''), notice = ref('');
let timer, polling = false, disposed = false;
const plan = computed(() => plans.value.find(p => `${p.recordId}:${p.symbol}` === selected.value));
const orders = computed(() => account.value?.orders || []);
const open = computed(() => orders.value.filter(o => ['pending', 'open'].includes(o.status)));
const history = computed(() => orders.value.filter(o => !['pending', 'open'].includes(o.status)));
const recentReviews = computed(() => orders.value.flatMap(o => (o.reviewHistory || []).map(r => ({ ...r, symbol: o.symbol, orderId: o.id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30));
const openPage = ref(1), historyPage = ref(1);
const openRows = computed(() => open.value.slice((openPage.value - 1) * 30, openPage.value * 30));
const historyRows = computed(() => history.value.slice((historyPage.value - 1) * 30, historyPage.value * 30));
watch(() => open.value.length, n => { openPage.value = Math.min(openPage.value, Math.max(1, Math.ceil(n / 30))); });
watch(() => history.value.length, n => { historyPage.value = Math.min(historyPage.value, Math.max(1, Math.ceil(n / 30))); });
const fmt = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
const money = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
const time = value => value ? new Date(value).toLocaleString() : '—';
const label = value => ({ pending: '等待入场', open: '持仓中', closed: '已平仓', cancelled: '已取消', expired: '未成交（历史记录）', stop_loss: '止损', take_profit: '止盈', manual: '手动平仓', timeout: '到期平仓', liquidation: '模拟强平' })[value] || value;
watch(selected, () => { const value = plan.value; if (value) { leverage.value = value.recommendedLeverage || 1; stopLoss.value = value.plan.stopLoss; takeProfit.value = value.plan.takeProfit; } });
async function load() {
  if (polling) return;
  polling = true;
  try {
    const [a, p] = await Promise.all([api('/paper/account'), api('/paper/plans')]);
    if (!disposed) {
      account.value = a; plans.value = p;
      if (!p.some(row => `${row.recordId}:${row.symbol}` === selected.value)) selected.value = p.length ? `${p[0].recordId}:${p[0].symbol}` : '';
    }
  } catch (e) { if (!disposed) error.value = e.message; }
  finally { polling = false; }
}
async function action(fn, message) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await fn(); notice.value = message; await load(); } catch (e) { error.value = e.message; } finally { busy.value = false; }
}
function submit() { if (plan.value) return action(() => api('/paper/orders', { method: 'POST', body: { recordId: plan.value.recordId, symbol: plan.value.symbol, margin: margin.value, leverage: leverage.value, stopLoss: stopLoss.value, takeProfit: takeProfit.value } }), '模拟计划已提交，从未来 K 线开始等待入场。'); }
function close(order) { return action(() => api(`/paper/orders/${order.id}/close`, { method: 'POST' }), order.status === 'pending' ? '模拟挂单已取消。' : '已处理模拟平仓。'); }
onMounted(() => { load(); timer = setInterval(() => { if (!document.hidden && !busy.value) load(); }, 10000); });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <section class="paper-account view-stack">
    <div class="view-heading"><div><span class="eyebrow">AUTOMATED PAPER TRADING / OKX</span><h2>自动模拟交易</h2><p>无限模拟资金 · 每笔 100 USDT 保证金 × 推荐杠杆 · 累计投入与收益独立统计</p></div><button class="secondary" :disabled="busy" @click="action(() => api('/paper/refresh', { method: 'POST', timeoutMs: 180000 }), '模拟行情和账本已刷新。')">{{ busy ? '处理中…' : '刷新撮合与盈亏' }}</button></div>
    <p v-if="error || account?.error" class="signal-warning" role="alert">{{ error || account.error }}</p><p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div v-if="account" class="summary-metrics paper-metrics">
      <article class="summary-metric"><span>累计成交投入</span><strong>{{ money(account.investedMargin) }}</strong><small>各笔已成交保证金之和 · USDT</small></article>
      <article class="summary-metric"><span>已平仓投入收益率</span><strong>{{ account.realizedReturn == null ? '—' : (account.realizedReturn * 100).toFixed(2) + '%' }}</strong><small>已平仓净收益 ÷ 已平仓保证金</small></article>
      <article class="summary-metric"><span>已实现净盈亏</span><strong :class="account.realized >= 0 ? 'price-up' : 'price-down'">{{ money(account.realized) }}</strong><small>已扣双边手续费与资金费估算</small></article>
      <article class="summary-metric"><span>浮动盈亏</span><strong :class="account.unrealized >= 0 ? 'price-up' : 'price-down'">{{ money(account.unrealized) }}</strong><small>按最新已处理收盘价 · 开仓费已扣余额</small></article>
    </div>
    <AutomationTasks />
    <section class="history-panel paper-order-form">
      <div class="section-head"><h3>采用分析计划</h3><span class="research-badge">仅模拟，不发送交易所订单</span></div>
      <p v-if="!plans.length" class="muted">暂无有效开仓计划。请到行情工作台选择“本地规则（免 Key）”或 AI 分析；观望、无效及过期计划不能下单。</p>
      <form v-else @submit.prevent="submit">
        <label>分析计划<select v-model="selected" :disabled="busy"><option v-for="p in plans" :key="`${p.recordId}:${p.symbol}`" :value="`${p.recordId}:${p.symbol}`">{{ p.symbol }} · {{ p.positionRecommendation === 'OPEN_LONG' ? '做多' : '做空' }} · {{ p.analysisEngine === 'local' ? '本地规则' : 'AI' }} · {{ time(p.at) }}</option></select></label>
        <div class="model-grid"><label>保证金（USDT）<input v-model.number="margin" type="number" min="1" max="100000" step="0.01" required :disabled="busy" /></label><label>杠杆（推荐 {{ plan?.recommendedLeverage || 1 }}×）<input v-model.number="leverage" type="number" min="1" max="5" step="1" required :disabled="busy" /></label><label>止损价格<input v-model.number="stopLoss" type="number" min="0" step="any" required :disabled="busy" /></label><label>止盈价格<input v-model.number="takeProfit" type="number" min="0" step="any" required :disabled="busy" /></label></div>
        <p v-if="plan" class="muted">名义仓位 {{ money(margin * leverage) }} USDT · 入场区间 {{ fmt(plan.plan.entryMin) }}～{{ fmt(plan.plan.entryMax) }}</p>
        <button class="primary" type="submit" :disabled="busy || !plan">提交模拟开仓计划</button>
      </form>
    </section>
    <section class="history-panel"><div class="section-head"><h3>模拟挂单与持仓</h3><span>{{ open.length }} 笔 · 不限制总资金</span></div><p v-if="!open.length" class="muted">暂无挂单或持仓。</p>
      <div v-else class="paper-table"><table><thead><tr><th>币种 / 方向</th><th>状态 / 杠杆</th><th>保证金 / 名义仓位</th><th>入场价 / 参考价</th><th>止损 / 止盈</th><th>浮动盈亏</th><th>操作</th></tr></thead><tbody><tr v-for="o in openRows" :key="o.id"><td><b>{{ o.symbol }}</b><small>{{ o.direction === 'OPEN_LONG' ? '做多' : '做空' }} · {{ o.interval }}</small></td><td>{{ label(o.status) }}<small>{{ o.leverage }}×</small></td><td>{{ money(o.margin) }}<small>{{ money(o.notional) }} USDT</small></td><td>{{ o.entry ? fmt(o.entry) : '等待区间入场' }}<small>{{ o.markPrice ? fmt(o.markPrice) : '—' }} · {{ time(o.markAt) }}</small></td><td>{{ fmt(o.plan.stopLoss) }}<small>{{ fmt(o.plan.takeProfit) }}</small></td><td :class="o.unrealized >= 0 ? 'price-up' : 'price-down'">{{ money(o.unrealized || 0) }}<small v-if="o.error" class="signal-warning">{{ o.error }}</small></td><td><button class="ghost" :disabled="busy" @click="close(o)">{{ o.status === 'pending' ? '取消挂单' : '模拟平仓' }}</button></td></tr></tbody></table></div>
    </section>
    <section class="history-panel"><h3>模拟成交记录</h3><p v-if="!history.length" class="muted">止盈、止损、到期或手动平仓后，净收益会记录在这里。</p><div v-else class="paper-table"><table><thead><tr><th>币种 / 杠杆</th><th>结果</th><th>入场 / 平仓</th><th>毛盈亏</th><th>手续费 / 资金费</th><th>净盈亏 / 保证金收益率</th></tr></thead><tbody><tr v-for="o in historyRows" :key="o.id"><td>{{ o.symbol }}<small>{{ o.leverage }}× · {{ time(o.exitAt || o.createdAt) }}</small></td><td>{{ label(o.reason || o.status) }}<small v-if="o.ambiguousBar">同根多触发，保守结算</small></td><td>{{ o.entry ? fmt(o.entry) : '—' }}<small>{{ o.exit ? fmt(o.exit) : '—' }}</small></td><td>{{ money(o.gross || 0) }}</td><td>{{ money(o.fees || 0) }}<small>{{ money(o.funding || 0) }}</small></td><td :class="o.net >= 0 ? 'price-up' : 'price-down'">{{ money(o.net || 0) }}<small>{{ ((o.roi || 0) * 100).toFixed(2) }}%</small></td></tr></tbody></table></div></section>
    <div class="history-filter"><button class="ghost" :disabled="openPage <= 1" @click="openPage--">持仓上一页</button><span>持仓 {{ openPage }} / {{ Math.max(1, Math.ceil(open.length / 30)) }}</span><button class="ghost" :disabled="openPage * 30 >= open.length" @click="openPage++">持仓下一页</button><button class="ghost" :disabled="historyPage <= 1" @click="historyPage--">历史上一页</button><span>历史 {{ historyPage }} / {{ Math.max(1, Math.ceil(history.length / 30)) }}</span><button class="ghost" :disabled="historyPage * 30 >= history.length" @click="historyPage++">历史下一页</button></div>
    <section class="history-panel"><h3>最近保护复核记录</h3><p v-if="!recentReviews.length" class="muted">产生持仓后，每 5 分钟检查一次；调整理由和生效时间会显示在这里。</p><div v-for="(r, i) in recentReviews" :key="`${r.orderId}-${r.at}-${i}`" class="review-entry"><b>{{ r.symbol }} · {{ r.action === 'updated' ? '已调整保护' : '保持原保护' }}</b><small>{{ time(r.at) }} · {{ r.engine === 'local' ? '本地规则' : 'AI' }}</small><p>{{ r.reason }}</p><p v-if="r.action === 'updated'">止损 {{ fmt(r.previous.stopLoss) }} → {{ fmt(r.stopLoss) }} · 止盈 {{ fmt(r.previous.takeProfit) }} → {{ fmt(r.takeProfit) }} · 生效 {{ time(r.effectiveFrom) }}</p></div></section>
    <p class="muted paper-method">每 30 秒使用已同步的收盘 K 线撮合；每 5 分钟复核持仓，保护修改从下一根尚未开始的 K 线生效，只收紧止损。从提交后的未来 K 线开盘价进入区间时成交，收盘后检查该根高低价是否触及保护价。同根双触发按止损优先，跳空止损按更差开盘价；缺线暂停结算，补齐后接续。每边手续费 0.06%、滑点 0.05%，资金费每 8 小时按 0.03% 估算。简化逐仓强平维持保证金率为 0.5%，单笔亏损上限为保证金及开仓费。每轮自动计划最多等待 6 根、持有 120 根 1m K 线（AI 计划可更短）。手动平仓使用最新已收盘参考价。推荐杠杆取 1～5×。后台服务运行时，关闭页面仍会自动处理。</p>
  </section>
</template>

<style scoped>
.paper-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.paper-order-form form { display: grid; gap: 16px; }
.paper-order-form label { display: grid; gap: 7px; }
.paper-order-form .model-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.paper-order-form .primary { justify-self: start; }
.paper-table { overflow-x: auto; }
.paper-table table { width: 100%; min-width: 850px; }
.paper-table small { display: block; margin-top: 6px; max-width: 220px; }
.paper-method { line-height: 1.8; }
.automation-jobs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.automation-jobs article { border: 1px solid var(--border-primary); padding: 18px; border-radius: 8px; }
.automation-jobs small, .review-entry small { display: block; margin: 7px 0; }
.review-entry { border-bottom: 1px solid var(--border-primary); padding: 14px 0; }
@media(max-width: 700px) { .automation-jobs { grid-template-columns: 1fr; } }
@media(max-width: 1000px) { .paper-metrics, .paper-order-form .model-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media(max-width: 600px) { .paper-order-form .model-grid { grid-template-columns: 1fr; } }
</style>
