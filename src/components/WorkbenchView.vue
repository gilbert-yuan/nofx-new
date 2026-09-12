<script setup>
import { computed } from 'vue';
import KlineChart from './KlineChart.vue';
const props = defineProps({ chartDate: String, activeSymbol: String, interval: String, rows: Array, chart: Object, marketLoading: Boolean, klineSyncLoading: Boolean, scope: Object });
defineEmits(['update:chartDate', 'refresh', 'fetch-latest']);
const last = computed(() => props.rows.at(-1));
const change = computed(() => props.rows.length && Number(props.rows[0].open) > 0 ? (Number(last.value.close) / Number(props.rows[0].open) - 1) * 100 : null);
const position = computed(() => props.chart.max > props.chart.min ? Math.max(0, Math.min(100, (Number(last.value?.close) - props.chart.min) / (props.chart.max - props.chart.min) * 100)) : 50);
const price = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
</script>
<template>
  <div class="view-stack workbench-view">
    <section class="workbench-hero">
      <div><span class="eyebrow">行情 OKX · 交易 BINANCE / USDT 永续</span><h2>{{ activeSymbol.replace(/USDT$/, '') }} <em>/ USDT</em></h2><p>{{ interval }} 周期 · 当前窗口 {{ rows.length }} 根 K 线 · 参考价格可能与币安不同</p></div>
      <div class="quote-actions"><div class="quote-value"><span class="eyebrow">{{ chartDate ? '历史窗口末价' : '最新 K 线价格' }}</span><strong class="last-price">{{ last ? price(last.close) : '—' }} <small>USDT</small></strong></div><label>图表周期<select v-model="scope.interval"><option>1m</option><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>1d</option></select></label></div>
    </section>
    <div class="window-strip" aria-label="当前 K 线窗口统计">
      <div><span>窗口涨跌</span><strong :class="change === null ? '' : change >= 0 ? 'price-up' : 'price-down'">{{ change === null ? '—' : (change >= 0 ? '+' : '') + change.toFixed(2) + '%' }}</strong></div>
      <div><span>窗口最低</span><strong>{{ rows.length ? price(chart.min) : '—' }}</strong></div>
      <div class="window-location"><span>收盘价在窗口区间的位置</span><div class="range-track"><i v-if="last" :style="{ left: position + '%' }"></i></div></div>
      <div><span>窗口最高</span><strong>{{ rows.length ? price(chart.max) : '—' }}</strong></div>
    </div>
    <div class="market-column">
      <KlineChart :date="chartDate" @update:date="$emit('update:chartDate', $event)" :chart="chart" :rows="rows" :loading="marketLoading"><template #actions><button class="ghost" @click="$emit('refresh')" :disabled="marketLoading || klineSyncLoading">{{ marketLoading ? '加载中…' : '刷新当前 K 线' }}</button></template></KlineChart>
    </div>
  </div>
</template>
