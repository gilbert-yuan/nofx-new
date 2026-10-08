<script setup>
import { computed } from 'vue';

const props = defineProps({ data: Object, evidence: Array });
const valid = value => value != null && value !== '' && Number.isFinite(Number(value));
const percent = value => valid(value) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%` : '—';
const fraction = value => valid(value) ? `${(Number(value) * 100).toFixed(1)}%` : '—';
const rate = value => valid(value) ? `${(Number(value) * 100).toFixed(4)}%` : '—';
const decimal = value => valid(value) ? Number(value).toFixed(2) : '—';
const price = value => valid(value) ? Number(value).toPrecision(7) : '—';
const time = value => value ? new Date(value).toLocaleTimeString() : '—';
const statuses = { fresh: '有效', stale: '已过期', unavailable: '未获取' };
const evidenceLabels = { support: '同向', conflict: '反向', neutral: '中性', context: '参考', missing: '数据不足' };
const groups = computed(() => [
  ['持仓量', props.data?.openInterest], ['资金费', props.data?.funding],
  ['市场多空', props.data?.globalPositioning], ['大户持仓', props.data?.topPositioning],
  ['盘口', props.data?.orderBook], ['主动成交', props.data?.flow],
]);
</script>

<template>
  <section v-if="data" class="market-indicators" aria-label="免费行情辅助指标">
    <div class="indicator-heading"><strong>行情辅助证据</strong><span>有效 {{ data.coverage?.fresh || 0 }} / {{ data.coverage?.total || 6 }} 项 · 币安</span></div>
    <dl class="indicator-values">
      <div><dt>持仓数量 5m / 15m / 1h</dt><dd>{{ percent(data.openInterest?.changes?.['5m']?.quantityPct) }} / {{ percent(data.openInterest?.changes?.['15m']?.quantityPct) }} / {{ percent(data.openInterest?.changes?.['1h']?.quantityPct) }}</dd></div>
      <div><dt>同窗口价格 15m</dt><dd>{{ percent(data.openInterest?.changes?.['15m']?.pricePct) }}</dd></div>
      <div><dt>主动买入占比 · {{ data.flow?.windowBars || 5 }} 根 {{ data.flow?.interval || '1m' }}</dt><dd>{{ fraction(data.flow?.takerBuyFraction) }} · 成交活跃度 {{ decimal(data.flow?.tradeCountRatio) }} 倍</dd></div>
      <div><dt>主动成交差额 / 成交额</dt><dd>{{ fraction(data.flow?.deltaRatio) }} · VWAP {{ price(data.flow?.vwap) }}</dd></div>
      <div><dt>全市场账户 / 大户持仓多空比</dt><dd>{{ decimal(data.globalPositioning?.longShortRatio) }} / {{ decimal(data.topPositioning?.longShortRatio) }}</dd></div>
      <div><dt>资金费参考 · 下次结算</dt><dd>{{ rate(data.funding?.rate) }} · {{ time(data.funding?.nextFundingAt) }}<template v-if="valid(data.funding?.secondsToFunding)">（{{ Math.ceil(data.funding.secondsToFunding / 60) }} 分钟）</template></dd></div>
      <div><dt>标记价 / 指数价偏离</dt><dd>{{ decimal(data.funding?.markIndexDeviationBps) }} bps</dd></div>
      <div><dt>20 档买卖盘失衡 · 价差</dt><dd>{{ fraction(data.orderBook?.imbalance) }} · {{ decimal(data.orderBook?.spreadBps) }} bps</dd></div>
    </dl>
    <div v-if="evidence?.length" class="indicator-evidence">
      <span v-for="item in evidence" :key="item.key" :class="`evidence-${item.state}`" :title="item.note">{{ item.label }}：{{ evidenceLabels[item.state] || item.state }}</span>
    </div>
    <details class="indicator-times">
      <summary>各项数据时间与状态</summary>
      <div v-for="[name, metric] in groups" :key="name">{{ name }}：{{ statuses[metric?.status] || '未获取' }} · {{ time(metric?.asOf) }}</div>
    </details>
    <small>用于辅助判断；持仓量不指明多空方向，主动成交差额不代表实际入金。</small>
  </section>
</template>

<style scoped>
.market-indicators { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-primary); font-size: 12px; }
.indicator-heading { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.indicator-heading span, .indicator-values dt, .indicator-times, small { color: var(--text-tertiary); }
.indicator-values { margin: 0; }
.indicator-values > div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; padding: 3px 0; }
.indicator-values dd { margin: 0; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.indicator-evidence { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; }
.evidence-support { color: var(--positive, #1e8e5a); }
.evidence-conflict { color: var(--warning, #b26a00); }
.evidence-context, .evidence-neutral, .evidence-missing { color: var(--text-secondary); }
.indicator-times { margin: 8px 0; line-height: 1.6; }
.indicator-times summary { cursor: pointer; }
small { display: block; line-height: 1.5; }
</style>
