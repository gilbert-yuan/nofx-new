<script setup>
import { reactive, ref } from 'vue';
import { researchApi } from '../api/client.js';
const props = defineProps({ strategy: { type: Object, required: true }, params: { type: Object, required: true } });
const localTime = (value) => new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const end = Math.floor(Date.now() / 60000) * 60000;
const form = reactive({ symbol: 'BTCUSDT', start: localTime(end - 86400000), end: localTime(end), initialBalance: 10000, validationFraction: 0.3, grid: '{\n  "marketFlowEnabled": [false, true],\n  "marketFlowMinFraction": [0.5, 0.55, 0.6]\n}' });
const busy = ref('');
const error = ref('');
const history = ref(null);
const result = ref(null);
const selected = ref(null);
function input() {
  const startTime = new Date(form.start).getTime();
  const endTime = new Date(form.end).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new Error('请选择有效起止时间。');
  return { symbol: form.symbol.trim().toUpperCase(), strategyId: props.strategy.id, startTime, endTime, initialBalance: form.initialBalance, validationFraction: form.validationFraction, params: { ...props.params } };
}
async function run(action) {
  if (busy.value) return;
  error.value = '';
  busy.value = action;
  try {
    const body = input();
    if (action === 'fetch') history.value = await researchApi.fetchIndicators(body);
    else {
      body.grid = JSON.parse(form.grid || '{}');
      result.value = await researchApi.backtest(body);
      selected.value = null;
    }
  } catch (e) { error.value = e.message; }
  finally { busy.value = ''; }
}
const fmt = (value) => value == null ? '—' : Number(value).toFixed(2);
const missing = (row) => Object.values(row.missing || {}).reduce((a, b) => a + Number(b), 0);
</script>

<template>
  <section class="indicator-backtest">
    <h4>历史指标回测 · 参数组合</h4>
    <p class="muted">使用当前参数草稿作为基线。先补历史，再运行网格；按训练收益减回撤排序，后续验证区间单独展示。结果用于研究，参数保存仍由策略管理操作。</p>
    <div class="replay-fields">
      <label>币种<input v-model="form.symbol" :disabled="!!busy" /></label>
      <label>开始时间<input v-model="form.start" type="datetime-local" :disabled="!!busy" /></label>
      <label>结束时间（不含）<input v-model="form.end" type="datetime-local" :disabled="!!busy" /></label>
      <label>初始权益 USDT<input v-model.number="form.initialBalance" type="number" min="100" max="1000000" :disabled="!!busy" /></label>
      <label>后续验证比例<input v-model.number="form.validationFraction" type="number" min="0.1" max="0.5" step="0.05" :disabled="!!busy" /></label>
    </div>
    <label class="grid-input">参数网格 JSON（最多 64 个组合；参数名见上方）<textarea v-model="form.grid" rows="5" :disabled="!!busy" spellcheck="false" /></label>
    <p class="muted">OI 接口最近一个月，多空比最近 30 天；主动成交从历史 K 线计算。资金费过滤使用最新已结算值；盘口只支持本系统已采集的历史快照。缺失指标按“指标缺失时禁止入场”处理并统计。</p>
    <div class="replay-actions">
      <button class="secondary" :disabled="!!busy" @click="run('fetch')">{{ busy === 'fetch' ? '补齐历史中…' : '补历史数据' }}</button>
      <button class="primary" :disabled="!!busy" @click="run('backtest')">{{ busy === 'backtest' ? '回测中…' : '运行参数组合回测' }}</button>
    </div>
    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <div v-if="history" class="history-result">
      <p>本次历史返回：{{ Object.entries(history.saved || {}).map(([k,v]) => `${k} ${v} 条`).join(' · ') }}</p>
      <p v-for="(message,i) in history.errors" :key="i" class="signal-warning">{{ message }}</p>
      <small>{{ history.availabilityAssumption }}</small>
    </div>
    <div v-if="result" class="replay-results">
      <p>基线：训练收益 {{ fmt(result.baseline.training.returnPct) }}% / 回撤 {{ fmt(result.baseline.training.maxDrawdownPct) }}%；验证收益 {{ fmt(result.baseline.validation.returnPct) }}%。共 {{ result.combinations.length }} 个组合，历史指标 {{ result.historicalSamples }} 条。</p>
      <div class="replay-table"><table>
        <thead><tr><th>组合</th><th>训练收益</th><th>训练回撤</th><th>训练成交</th><th>验证收益</th><th>验证回撤</th><th>验证成交</th><th>缺失项次数</th><th>样本</th></tr></thead>
        <tbody><tr v-for="(row,i) in result.combinations" :key="i" @click="selected = selected === i ? null : i">
          <td><button class="ghost">{{ i + 1 }} · 查看参数</button></td><td>{{ fmt(row.training.returnPct) }}%</td><td>{{ fmt(row.training.maxDrawdownPct) }}%</td><td>{{ row.training.closedTrades }}</td><td>{{ fmt(row.validation.returnPct) }}%</td><td>{{ fmt(row.validation.maxDrawdownPct) }}%</td><td>{{ row.validation.closedTrades }}</td><td>{{ missing(row.training) + missing(row.validation) }}</td><td>{{ row.sufficient ? '≥5 笔' : '不足' }}</td>
        </tr></tbody>
      </table></div>
      <pre v-if="selected != null">{{ JSON.stringify(result.combinations[selected], null, 2) }}</pre>
      <p v-for="note in result.limitations" :key="note" class="muted">{{ note }}</p>
    </div>
  </section>
</template>

<style scoped>
.indicator-backtest { padding: 18px; margin-top: 18px; background: var(--bg-secondary); border: 1px solid var(--border-primary); border-radius: 8px; }
h4 { margin-bottom: 10px; }.muted { font-size: 12px; line-height: 1.7; margin: 10px 0; }
.replay-fields { display: grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr)); gap: 12px; margin: 14px 0; }
label { display: grid; gap: 6px; font-size: 12px; color: var(--text-secondary); }input, textarea { width: 100%; min-width: 0; padding: 8px; }textarea,pre { font-family: var(--font-mono); font-size: 12px; }
.replay-actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }.history-result { font-size: 12px; line-height: 1.8; }
.replay-table { overflow-x: auto; }table { width: 100%; border-collapse: collapse; white-space: nowrap; font-size: 12px; }th,td { padding: 9px; text-align: right; border-bottom: 1px solid var(--border-primary); }th:first-child,td:first-child { text-align: left; }tbody tr { cursor: pointer; }tbody tr:hover { background: var(--bg-elevated); }pre { max-height: 420px; overflow: auto; padding: 12px; background: var(--bg-tertiary); }
</style>
