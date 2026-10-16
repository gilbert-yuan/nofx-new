<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { mlApi } from '../api/client.js';

const props = defineProps({ symbol: { type: String, required: true }, historical: Boolean });
const result = ref(null);
const health = ref(null);
const busy = ref(false);
const error = ref('');
const now = ref(Date.now());
let sequence = 0;
let controller;
let clock;
let disposed = false;
let healthSequence = 0;
const demo = computed(() => (health.value || result.value)?.operating_mode === 'demo_auto');
const modeBadge = computed(() => {
  if (!health.value && !result.value) return '正在读取运行模式';
  if (!demo.value) return '研究模式 · 下单关闭';
  const context = (health.value || result.value)?.execution_context;
  if (!context?.worker_active) return 'Binance Demo · 自动任务未启动';
  return context.blocked_reasons?.length ? 'Binance Demo · 风控等待' : 'Binance Demo · 自动交易运行中';
});
const risk = computed(() => result.value?.risk_management);
const forecast = computed(() => result.value?.forecast);
const stale = computed(() => result.value && (result.value.stale || result.value.origin_ms < Math.floor(now.value / 3600000) * 3600000 || result.value.forecast_target_end_ms <= now.value));
const price = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const time = value => value ? new Date(value).toLocaleString() : '—';
const last = values => Array.isArray(values) ? values.at(-1) : null;
const action = value => ({ BUY: '偏多', SELL: '偏空', HOLD: '观望' }[value] || '等待分析');
const riskStatus = computed(() => stale.value ? '数据已过期' : ({ ready_research: '保护计划已校验', ready_demo: 'Demo 保护计划就绪', blocked_demo: 'Demo 风控拦截', hold: '无新仓信号', rejected: '风控未通过', stale: '数据已过期' }[risk.value?.status] || '等待信号'));
async function refreshHealth() {
  const token = ++healthSequence;
  try { const output = await mlApi.health(); if (!disposed && token === healthSequence) health.value = output; }
  catch { /* Keep the last observed state; signal errors remain visible. */ }
}
function reset() {
  sequence++;
  controller?.abort();
  result.value = null;
  error.value = '';
  busy.value = false;
}
watch(() => [props.symbol, props.historical], reset);
async function analyze() {
  if (busy.value || props.historical) return;
  const token = ++sequence;
  controller?.abort();
  controller = new AbortController();
  busy.value = true;
  error.value = '';
  result.value = null;
  try {
    const output = await mlApi.pipeline(props.symbol, controller.signal);
    if (disposed || token !== sequence) return;
    if (output.symbol !== props.symbol || output.pipeline?.id !== 'chronos-lightgbm-risk-v1' || !output.risk_management) throw new Error('服务尚未加载完整的预测、信号和风控链路。');
    result.value = output;
    healthSequence++;
    health.value = output;
    now.value = Date.now();
  } catch (err) {
    if (!disposed && token === sequence) error.value = err.message;
  } finally {
    if (!disposed && token === sequence) busy.value = false;
  }
}
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now(); refreshHealth(); }, 30000);
  refreshHealth();
});
onUnmounted(() => { disposed = true; sequence++; controller?.abort(); clearInterval(clock); });
</script>

<template>
  <section class="ml-pipeline" aria-label="Chronos LightGBM 风险管理">
    <div class="ml-heading">
      <div><span class="eyebrow">Binance {{ symbol }} · 最新闭合 1h · 预测未来 12h</span><h2>AI 信号与风控</h2><p>Chronos-Bolt-Tiny → LightGBM → 风险管理</p></div>
      <div class="ml-actions"><span class="ml-badge">{{ modeBadge }}</span><button class="ghost" :disabled="busy || historical" @click="analyze">{{ busy ? '分析中…' : '分析当前币种' }}</button></div>
    </div>
    <p v-if="historical" class="ml-notice">当前图表为历史窗口。请清除图表日期后分析最新小时，避免混用不同时点。</p>
    <p v-if="health?.data_mode === 'frozen_snapshot'" class="ml-notice">模型服务正在使用冻结历史数据，结果仅供历史复核。</p>
    <p v-if="error" class="ml-error" role="alert">{{ error }}</p>
    <p v-if="stale" class="ml-notice" role="status">这份结果已跨小时或预测期限，需重新分析。</p>
    <div class="ml-stages" :aria-busy="busy">
      <article><span class="ml-step">01 · 价格预测</span><h3>Chronos-Bolt-Tiny</h3><dl><div><dt>参考收盘价</dt><dd>{{ price(forecast?.current_price) }}</dd></div><div><dt>12h 中位预测</dt><dd>{{ price(last(forecast?.q50)) }}</dd></div><div><dt>12h 预测区间</dt><dd>{{ price(last(forecast?.q10)) }} ～ {{ price(last(forecast?.q90)) }}</dd></div></dl><small>预测分位数区间，实际覆盖可能低于标称值。</small></article>
      <article><span class="ml-step">02 · 信号判断</span><h3>LightGBM <em>{{ action(result?.action) }}</em></h3><dl><div v-for="key in ['BUY', 'HOLD', 'SELL']" :key="key"><dt>{{ action(key) }}概率</dt><dd>{{ percent(result?.probabilities?.[key]) }}</dd></div></dl><small>分类概率不等同于交易胜率；HOLD 不会平掉已有仓位。</small></article>
      <article><span class="ml-step">03 · 风险管理</span><h3>{{ riskStatus }}</h3><dl><div><dt>止损价格</dt><dd>{{ price(risk?.plan?.stopLoss) }}</dd></div><div><dt>止盈价格</dt><dd>{{ price(risk?.plan?.takeProfit) }}</dd></div><div><dt>{{ demo ? 'Demo 仓位' : '研究仓位' }}</dt><dd>{{ price(risk?.position_size?.notional_usdt) }} USDT · 1×</dd></div></dl><small>复用 Rust 生产保护规则；2 ATR 止损、5 ATR 止盈。</small></article>
    </div>
    <div v-if="result" class="ml-details">
      <p>数据截止 {{ time(result.origin_ms) }} · 预测终点 {{ time(result.forecast_target_end_ms) }} · {{ result.data_mode === 'live_public' ? '实时公共行情' : '历史复核' }} · {{ stale ? '已过期' : '该小时有效' }}</p>
      <details><summary>查看仓位、出场与执行限制</summary>
        <dl><div><dt>{{ demo ? 'Demo 共享账户权益' : '研究参考资金' }}</dt><dd>{{ price(risk.reference_equity_usdt) }} USDT</dd></div><div><dt>单笔风险预算</dt><dd>{{ percent(risk.risk_fraction) }} · {{ price(risk.position_size?.risk_budget_usdt) }} USDT</dd></div><div><dt>止损损失估算（含成本）</dt><dd>{{ price(risk.position_size?.estimated_stop_loss_usdt) }} USDT</dd></div><div><dt>入场区间</dt><dd>{{ price(risk.plan?.entryMin) }} ～ {{ price(risk.plan?.entryMax) }}</dd></div><div><dt>最长持有</dt><dd>{{ risk.plan?.maxHoldBars ?? '—' }} 根 1h（另有 1 根入场延迟）</dd></div></dl>
        <p>单日亏损限制 {{ percent(risk.daily_loss_fraction) }} · 最大回撤限制 {{ percent(risk.max_drawdown_fraction) }}。{{ risk.account_risk_notice }}</p>
        <p v-if="risk.accounting_notice">{{ risk.accounting_notice }}</p>
        <p v-for="reason in risk.blocked_reasons" :key="reason">{{ reason }}</p>
        <p>{{ demo ? 'Demo 自动任务负责订单创建、保护更新和出场，执行记录可在自动化任务中查看。' : '保护计划包含共享的移动止损、智能退出和分批止盈规则快照；当前没有创建订单或监控持仓。' }}</p>
      </details>
    </div>
    <p v-else-if="!error && !busy" class="ml-idle">{{ demo ? 'Demo 自动扫描独立运行。点击分析可查看当前币种的信号与账户风控结果。' : '点击分析，依次生成该币种的价格预测、分类信号和研究保护计划。' }}</p>
  </section>
</template>

<style scoped>
.ml-pipeline { padding: 22px; border: 1px solid var(--border-primary); border-radius: 14px; background: var(--bg-secondary); }
.ml-heading, .ml-actions { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.ml-heading h2 { font-size: 20px; margin: 6px 0; }
.ml-heading p { margin: 0; color: var(--text-secondary); font-size: 12px; }
.ml-badge { padding: 5px 9px; border-radius: 6px; background: var(--bg-tertiary); color: var(--text-secondary); font-size: 12px; }
.ml-stages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 22px; }
.ml-stages article { padding: 16px; border: 1px solid var(--border-primary); border-radius: 9px; }
.ml-step, small, dt, .ml-details, .ml-idle { color: var(--text-tertiary); font-size: 12px; }
.ml-stages h3 { font-size: 15px; margin: 10px 0 16px; color: var(--text-primary); }
.ml-stages em { font-style: normal; font-size: 12px; margin-left: 8px; color: var(--text-secondary); }
dl { margin: 0 0 14px; } dl > div { display: flex; justify-content: space-between; gap: 12px; margin: 9px 0; }
dd { margin: 0; color: var(--text-primary); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
small { display: block; line-height: 1.6; } .ml-details { margin-top: 16px; line-height: 1.7; }
.ml-details summary { cursor: pointer; color: var(--text-secondary); } .ml-details dl { max-width: 560px; margin-top: 14px; }
.ml-error, .ml-notice { margin: 14px 0 0; padding: 10px; background: var(--bg-tertiary); border-radius: 6px; font-size: 12px; line-height: 1.6; }
.ml-error { color: var(--negative, #d54b56); } .ml-notice { color: var(--text-secondary); } .ml-idle { margin-bottom: 0; }
@media (max-width: 1000px) { .ml-stages { grid-template-columns: 1fr; } .ml-pipeline { padding: 16px; } }
</style>
