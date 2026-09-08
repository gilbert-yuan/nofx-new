<script setup>
import { computed } from 'vue';
import KlineChart from './KlineChart.vue';
import AnalysisResultCard from './AnalysisResultCard.vue';
import AnalysisScope from './AnalysisScope.vue';
const props = defineProps({ chartDate: String, activeSymbol: String, interval: String, rows: Array, chart: Object, currentAnalysis: Object, symbolAnalyses: Array, loading: Boolean, marketLoading: Boolean, klineSyncLoading: Boolean, historyLoading: Boolean, historyDate: String, scope: Object, symbolCount: Number });
defineEmits(['update:chartDate', 'analyze', 'refresh', 'fetch-latest', 'update:historyDate', 'history', 'analyze-range', 'analyze-all']);
const last = computed(() => props.rows.at(-1));
const change = computed(() => props.rows.length && Number(props.rows[0].open) > 0 ? (Number(last.value.close) / Number(props.rows[0].open) - 1) * 100 : null);
const position = computed(() => props.chart.max > props.chart.min ? Math.max(0, Math.min(100, (Number(last.value?.close) - props.chart.min) / (props.chart.max - props.chart.min) * 100)) : 50);
const price = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
</script>
<template>
  <div class="view-stack workbench-view">
    <section class="workbench-hero">
      <div><span class="eyebrow">行情 OKX · 交易 BINANCE / USDT 永续</span><h2>{{ activeSymbol.replace(/USDT$/, '') }} <em>/ USDT</em></h2><p>{{ interval }} 周期 · 当前窗口 {{ rows.length }} 根 K 线 · 参考价格可能与币安不同</p></div>
      <div class="quote-actions"><div class="quote-value"><span class="eyebrow">{{ chartDate ? '历史窗口末价' : '最新 K 线价格' }}</span><strong class="last-price">{{ last ? price(last.close) : '—' }} <small>USDT</small></strong></div><label>图表周期<select v-model="scope.interval"><option>1m</option><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>1d</option></select></label><button class="primary" @click="$emit('analyze')" :disabled="loading || marketLoading || !rows.length"><span v-if="loading" class="spinner"></span>{{ marketLoading ? '行情加载中…' : loading ? '正在分析…' : '分析当前币种' }}</button></div>
    </section>
    <label class="history-filter">分析方式<select v-model="scope.engine" :disabled="loading"><option value="auto">自动（无模型 Key 时使用本地规则）</option><option value="local">本地规则（免 Key）</option><option value="local-mtf">多周期规则（15分钟+1小时+4小时，免 Key）</option><option value="ai">AI 模型（需要模型 Key）</option></select></label>
    <div class="window-strip" aria-label="当前 K 线窗口统计">
      <div><span>窗口涨跌</span><strong :class="change === null ? '' : change >= 0 ? 'price-up' : 'price-down'">{{ change === null ? '—' : (change >= 0 ? '+' : '') + change.toFixed(2) + '%' }}</strong></div>
      <div><span>窗口最低</span><strong>{{ rows.length ? price(chart.min) : '—' }}</strong></div>
      <div class="window-location"><span>收盘价在窗口区间的位置</span><div class="range-track"><i v-if="last" :style="{ left: position + '%' }"></i></div></div>
      <div><span>窗口最高</span><strong>{{ rows.length ? price(chart.max) : '—' }}</strong></div>
    </div>
    <div class="research-layout">
      <div class="market-column">
        <KlineChart :date="chartDate" @update:date="$emit('update:chartDate', $event)" :chart="chart" :rows="rows" :loading="marketLoading"><template #actions><button class="ghost" @click="$emit('refresh')" :disabled="marketLoading || klineSyncLoading">{{ marketLoading ? '加载中…' : '刷新当前 K 线' }}</button></template></KlineChart>
        <details class="batch-analysis"><summary>批量分析 <span>{{ symbolCount }} 个可用合约 · 展开设置范围</span></summary><AnalysisScope :scope="scope" :symbol-count="symbolCount" :loading="loading" @analyze-range="$emit('analyze-range')" @analyze-all="$emit('analyze-all')" /></details>
      </div>
      <section class="analysis-panel research-panel" :aria-busy="loading">
        <div class="section-head"><div><span class="eyebrow">MARKET RESEARCH</span><h2>分析结论</h2></div><span class="research-badge">已收盘行情</span></div>
        <div v-if="loading" class="research-empty" role="status"><span class="spinner"></span><h3>正在分析行情</h3><p>正在获取已收盘 K 线并生成分析，请稍候。结果返回后会自动显示。</p></div>
        <template v-else>
          <p v-if="currentAnalysis?.error" class="signal-warning" role="alert">本次分析未完整完成：{{ currentAnalysis.error }}</p>
          <div v-if="currentAnalysis?.analyses?.length" class="result-grid"><AnalysisResultCard v-for="item in currentAnalysis.analyses" :key="item.symbol" :item="item" /></div>
          <div v-else class="research-empty"><span class="empty-symbol" aria-hidden="true">⌁</span><h3>{{ currentAnalysis?.error ? '暂未取得有效结论' : '等待本次分析' }}</h3><p>分析 {{ activeSymbol }} 的已收盘 {{ interval }} K 线，查看方向、判断依据与止盈止损计划。</p><button class="primary" @click="$emit('analyze')" :disabled="marketLoading || !rows.length">{{ currentAnalysis?.error ? '重新分析' : '开始分析' }}</button></div>
        </template>
        <div class="research-history"><div class="section-head"><h3>历史记录</h3><label class="history-date">筛选日期<input :value="historyDate" type="date" :disabled="historyLoading" @change="$emit('update:historyDate', $event.target.value)" /></label></div><p v-if="historyLoading" class="inline-loading" role="status"><span class="spinner"></span>加载记录…</p><div v-else-if="symbolAnalyses.length" class="history-list"><button v-for="item in symbolAnalyses" :key="item.id" class="history-row" @click="$emit('history', item)"><span><b>{{ item.error ? '分析有异常' : '查看分析' }} · {{ item.interval }}</b><small>{{ new Date(item.at).toLocaleString() }}</small></span><i aria-hidden="true">↗</i></button></div><p v-else class="muted">所选日期暂无该币种的分析记录。</p></div>
      </section>
    </div>
  </div>
</template>
