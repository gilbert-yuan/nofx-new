<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
const props = defineProps({ item: { type: Object, required: true } });
const now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => clearInterval(timer));
const expired = computed(() => props.item.expiresAt && Date.parse(props.item.expiresAt) <= now.value);
const hasMultiTimeframe = computed(() => props.item.multiTimeframeAnalysis && Object.keys(props.item.multiTimeframeAnalysis).length > 0);
function time(value) { return value ? new Date(value).toLocaleString() : '未记录'; }
function number(value) { return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 }); }
function label(value) { return { OPEN_LONG: '做多', OPEN_SHORT: '做空', CLOSE_LONG: '平多', CLOSE_SHORT: '平空', WAIT: '观望' }[value] || '观望'; }
function normalized(item) { return ['OPEN_LONG','OPEN_SHORT','CLOSE_LONG','CLOSE_SHORT','WAIT'].includes(item.positionRecommendation) ? item.positionRecommendation : ({ BUY: 'OPEN_LONG', SELL: 'OPEN_SHORT', HOLD: 'WAIT' }[item.action] || 'WAIT'); }
function trendLabel(trend) { return trend === 'long' ? '上升' : trend === 'short' ? '下降' : '不明确'; }
function trendIcon(trend) { return trend === 'long' ? '↑' : trend === 'short' ? '↓' : '—'; }
</script>
<template>
  <article class="result-card">
    <div class="result-top"><strong>{{ item.symbol }}</strong><span class="position-action" :class="normalized(item)">{{ label(normalized(item)) }}</span></div>
    <small>行情 {{ (item.marketProvider || item.exchange || '来源未记录').toUpperCase() }} · 交易 {{ (item.exchange || '未记录').toUpperCase() }} · {{ item.interval || '周期未记录' }}</small>
    <div class="confidence">{{ item.analysisEngine === 'local' || item.analysisEngine === 'local-mtf' ? '本地规则强度' : '模型自评' }} <b>{{ typeof item.confidence === 'number' ? item.confidence.toFixed(2) : '无有效评分' }}</b> · 非实测胜率</div>

    <!-- 多周期分析详情 -->
    <details v-if="hasMultiTimeframe" class="mtf-analysis">
      <summary>多周期共振分析</summary>
      <div class="mtf-grid">
        <div v-for="(analysis, interval) in item.multiTimeframeAnalysis" :key="interval" class="mtf-item">
          <div class="mtf-header">
            <span class="mtf-interval">{{ interval }}</span>
            <span class="mtf-trend" :class="analysis.trend">
              {{ trendIcon(analysis.trend) }} {{ trendLabel(analysis.trend) }}
            </span>
          </div>
          <div class="mtf-detail">
            <small>{{ analysis.reason }}</small>
            <small v-if="analysis.strength !== undefined">
              强度: {{ analysis.strength.toFixed(2) }} ·
              价格{{ analysis.aligned ? '已确认' : '待确认' }}
            </small>
          </div>
        </div>
      </div>
    </details>

    <p v-if="item.eligible">推荐模拟杠杆：<b>{{ item.recommendedLeverage || 1 }}×</b> · 按止损距离计算，上限 5×；可到"模拟交易"采用此计划。</p>
    <p>{{ item.reason }}</p>
    <small v-if="item.risk">风险：{{ item.risk }}</small><small v-if="item.suggestion">建议：{{ item.suggestion }}</small>
    <p v-if="expired" class="signal-warning">已过入场有效期，请重新分析。</p>
    <p v-if="!item.generatedAt" class="signal-warning">旧记录未经交易计划校验，不计入模拟统计。</p>
    <ul v-if="item.validationIssues?.length" class="signal-warning"><li v-for="issue in item.validationIssues" :key="issue">{{ issue }}</li></ul>
    <dl v-if="item.plan" class="signal-plan">
      <div><dt>入场区间</dt><dd>{{ number(item.plan.entryMin) }} ～ {{ number(item.plan.entryMax) }}</dd></div>
      <div><dt>止损 / 止盈</dt><dd>{{ number(item.plan.stopLoss) }} / {{ number(item.plan.takeProfit) }}</dd></div>
      <div><dt>估算成本后盈亏比</dt><dd>{{ typeof item.plan.netRewardRisk === 'number' ? item.plan.netRewardRisk.toFixed(2) : '未提供' }}</dd></div>
      <div><dt>最长持有</dt><dd>{{ item.plan.maxHoldBars }} 根K线</dd></div>
    </dl>
    <div class="signal-times">
      <small>已收盘行情截至：{{ time(item.dataAsOf) }}</small>
      <small>分析生成：{{ time(item.generatedAt) }}</small>
      <small v-if="item.plan">模拟入场：{{ time(item.firstEntryAt) }} 起，仅在K线开盘价落入区间时入场</small>
      <small v-if="item.expiresAt">入场截止：{{ time(item.expiresAt) }}</small>
    </div>
  </article>
</template>

<style scoped>
.mtf-analysis {
  margin: 12px 0;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  padding: 12px;
}

.mtf-analysis summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: #15966a;
  user-select: none;
}

.mtf-analysis summary:hover {
  color: #1bbd84;
}

.mtf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.mtf-item {
  background: #0f0f0f;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px;
}

.mtf-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.mtf-interval {
  font-weight: 600;
  font-size: 12px;
  color: #888;
  text-transform: uppercase;
}

.mtf-trend {
  font-size: 13px;
  font-weight: 600;
}

.mtf-trend.long {
  color: #15966a;
}

.mtf-trend.short {
  color: #d15b4b;
}

.mtf-trend.unknown {
  color: #888;
}

.mtf-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mtf-detail small {
  font-size: 11px;
  color: #888;
  line-height: 1.4;
}
</style>
