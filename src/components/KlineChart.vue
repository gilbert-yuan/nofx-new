<script setup>
import { computed, ref, watch } from 'vue';
const props = defineProps({ chart: { type: Object, required: true }, rows: { type: Array, default: () => [] }, loading: Boolean, date: String });
defineEmits(['update:date']);
const selected = ref(null);
watch(() => props.rows, () => { selected.value = null; });
const row = computed(() => props.rows[selected.value ?? props.rows.length - 1]);
const ticks = computed(() => Array.from({ length: 5 }, (_, i) => ({ y: 18 + i * 66, value: props.chart.max - (props.chart.max - props.chart.min) * i / 4 })));
const price = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 });
const time = value => new Date(Number(value)).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const selectedY = computed(() => row.value ? 18 + (props.chart.max - Number(row.value.close)) / (props.chart.max - props.chart.min || 1) * 264 : 18);
function point(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width * props.chart.width;
  selected.value = Math.max(0, Math.min(props.rows.length - 1, Math.floor((x - 18) / (924 / props.rows.length))));
}
function step(amount) { selected.value = Math.max(0, Math.min(props.rows.length - 1, (selected.value ?? props.rows.length - 1) + amount)); }
</script>
<template>
  <section class="chart-panel enhanced-chart">
    <div class="chart-toolbar"><strong>K 线走势</strong><slot name="actions" /></div>
    <div class="chart-date-controls"><label>查看截至时间（本地）<input type="datetime-local" :value="date" :disabled="loading" @change="$emit('update:date', $event.target.value)" /></label><button class="ghost" :disabled="!date || loading" @click="$emit('update:date', '')">返回最新</button></div>
    <p v-if="date" class="chart-history-note">正在查看历史行情。AI 分析仍使用最新已收盘 K 线。</p>
    <div class="candle-readout" v-if="row && !loading"><time>{{ time(row.openTime) }}</time><span v-for="[key, label] in [['open','开'],['high','高'],['low','低'],['close','收']]" :key="key">{{ label }} <b>{{ price(row[key]) }}</b></span></div>
    <div v-if="loading" class="chart-loading" role="status"><span class="spinner"></span>正在加载 K 线…</div>
    <div v-else-if="chart.candles.length" class="chart-plot">
      <svg :viewBox="'0 0 ' + chart.width + ' ' + chart.height" tabindex="0" role="img" aria-label="K 线与成交量图，左右方向键查看每根 K 线" @pointermove="point" @pointerdown="point" @keydown.left.prevent="step(-1)" @keydown.right.prevent="step(1)">
        <g v-for="tick in ticks" :key="tick.y"><line x1="18" :y1="tick.y" x2="942" :y2="tick.y" stroke="#e5eaf2" stroke-dasharray="3 5" /></g>
        <line x1="18" y1="312" x2="942" y2="312" stroke="#dce3ed" />
        <g v-for="(candle, index) in chart.candles" :key="index"><line :x1="candle.x" :x2="candle.x" :y1="candle.wickY1" :y2="candle.wickY2" :stroke="candle.color" stroke-width="1.3" /><rect :x="candle.bodyX" :y="candle.bodyY" :width="candle.bodyWidth" :height="candle.bodyHeight" :fill="candle.color" /></g>
        <g v-for="(bar, index) in chart.volumes" :key="index"><rect :x="bar.x" :y="bar.y" :width="bar.width" :height="bar.height" :fill="bar.color" opacity=".35" /></g>
        <line v-if="selected !== null && chart.candles[selected]" :x1="chart.candles[selected].x" :x2="chart.candles[selected].x" y1="18" y2="407" stroke="#68778d" stroke-dasharray="4 4" />
        <line v-if="selected !== null" x1="18" x2="942" :y1="selectedY" :y2="selectedY" stroke="#68778d" stroke-dasharray="4 4" />
      </svg>
      <div class="price-axis" aria-hidden="true"><span v-for="tick in ticks" :key="tick.y" :style="{ top: tick.y / chart.height * 100 + '%' }">{{ price(tick.value) }}</span><small>成交量</small></div>
      <div class="time-axis"><span>{{ time(rows[0].openTime) }}</span><span>{{ time(rows.at(-1).openTime) }}</span></div>
    </div>
    <div v-else class="research-empty"><h3>暂未获取 K 线</h3><p>点击“刷新当前 K 线”重新获取行情。</p></div>
    <div v-if="rows.length && !loading" class="candle-picker"><label>逐根查看 · {{ (selected ?? rows.length - 1) + 1 }} / {{ rows.length }}<input type="range" min="0" :max="rows.length - 1" :value="selected ?? rows.length - 1" @input="selected = Number($event.target.value)" /></label><p>{{ row ? time(row.openTime) : '' }} · 收盘价 {{ row ? price(row.close) : '—' }} USDT</p><small>时区：{{ zone }}</small></div>
    <div class="chart-footnote"><span><i class="legend-up"></i>上涨 <i class="legend-down"></i>下跌</span><span>悬停或使用 ← → 查看单根数据</span></div>
  </section>
</template>
