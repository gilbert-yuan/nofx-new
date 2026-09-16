<script setup>
import { computed, onMounted, ref } from 'vue';
import { binanceApi } from '../api/client.js';
import { fmt, orderStatusLabel, moneyClass } from '../utils/binance.js';

const mode = ref('simulation');
const data = ref(null);
const busy = ref(false);
const error = ref('');
const orderView = ref('fills');
const symbols = ref('');
const from = ref('');
const to = ref('');
const orderStatus = orderStatusLabel;
const displaySymbols = computed(() => data.value?.symbols?.join(', ') || '未发现可同步交易对');
const scopeText = computed(() => {
  const discovery = data.value?.discovery;
  if (!discovery) return '';
  if (discovery.mode === 'manual') return `手工指定 ${data.value.symbols.length} 个交易对`;
  return `自动发现 ${data.value.symbols.length} / ${discovery.candidateCount} 个账户相关交易对`;
});

async function syncOrders() {
  busy.value = true; error.value = '';
  try {
    data.value = await binanceApi.spotDemoOrders({ symbols: symbols.value.trim() || undefined, from: from.value || undefined, to: to.value || undefined });
  } catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}
onMounted(syncOrders);
</script>

<template>
  <section class="binance-orders-view">
    <div class="view-heading orders-heading">
      <div><span class="eyebrow">BINANCE · SPOT DEMO</span><h2>币安订单</h2><p>自动同步账户相关的 Spot Demo 历史订单和成交，按实际成交价、手续费和现货已实现盈亏统计。</p></div>
      <div class="order-mode-tabs"><button :class="{ active: mode === 'simulation' }" @click="mode = 'simulation'">模拟</button><button :class="{ active: mode === 'live' }" @click="mode = 'live'">正式</button></div>
    </div>
    <template v-if="mode === 'live'"><div class="orders-empty"><span class="empty-mark">LIVE</span><h3>正式订单暂未开放</h3><p>当前不会读取或提交正式账户订单。先使用模拟盘核对数据口径。</p></div></template>
    <template v-else>
      <div class="orders-toolbar">
        <label>补充交易对（可选）<input v-model="symbols" placeholder="留空自动扫描账户；可填 BTCUSDT,SOLUSDT" /></label>
        <label>开始日期<input v-model="from" type="date" /></label>
        <label>结束日期<input v-model="to" type="date" /></label>
        <button class="primary" :disabled="busy" @click="syncOrders">{{ busy ? '同步中…' : '同步全部账户订单' }}</button>
      </div>
      <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
      <div v-if="data" class="orders-content">
        <p class="spot-demo-badge">Spot Demo · demo-api.binance.com/api/v3 · {{ data.historyOrders.length }} 条历史订单</p>
        <div class="orders-scope"><b>{{ scopeText }}</b><span v-if="data.discovery?.windows > 1">已按 {{ data.discovery.windows }} 个 24 小时窗口拉取</span><span v-if="data.discovery?.truncated">自动发现候选过多，仅同步前 {{ data.symbols.length }} 个；请在输入框补充其余交易对。</span><span v-if="data.discovery?.reachedPerWindowLimit">部分交易对在单个时间窗口达到 1,000 条上限，结果可能不完整。</span></div>
        <div class="orders-meta"><span>环境：Demo 模拟盘</span><span>交易对：{{ displaySymbols }}</span><span>同步于 {{ new Date(data.syncedAt).toLocaleString() }}</span></div>
        <div class="orders-metrics">
          <article><span>总净盈亏</span><strong :class="moneyClass(data.summary.netPnl)">{{ fmt(data.summary.netPnl) }} <small>USDT</small></strong><em>已实现盈亏 − 实际手续费</em></article>
          <article><span>总实际费用</span><strong>{{ fmt(data.summary.fees) }} <small>USDT</small></strong><em>币安 commission 汇总</em></article>
          <article><span>总成交金额</span><strong>{{ fmt(data.summary.totalQuote) }} <small>USDT</small></strong><em>买入 {{ fmt(data.summary.buyQuote) }} · 卖出 {{ fmt(data.summary.sellQuote) }}</em></article>
          <article><span>订单统计</span><strong>{{ data.summary.orders }}</strong><em>已实现盈利 {{ fmt(data.summary.realizedPnl) }} USDT · {{ data.summary.closed }} 个买卖订单</em></article>
        </div>
        <div class="order-list-tabs"><button :class="{ active: orderView === 'fills' }" @click="orderView = 'fills'">成交汇总 ({{ data.orders.length }})</button><button :class="{ active: orderView === 'history' }" @click="orderView = 'history'">历史订单 ({{ data.historyOrders.length }})</button></div>
        <div v-if="orderView === 'fills'" class="orders-table-wrap"><table><thead><tr><th>订单</th><th>方向</th><th>买入价</th><th>卖出价</th><th>成交金额</th><th>实际费用</th><th>已实现盈亏</th><th>净盈亏</th><th>时间</th></tr></thead><tbody>
          <tr v-for="order in data.orders" :key="order.id"><td><b>{{ order.symbol }}</b><small>#{{ order.orderId }}</small></td><td><span :class="order.buyQty && order.sellQty ? 'round-trip' : order.buyQty ? 'buy' : 'sell'">{{ order.buyQty && order.sellQty ? '买卖' : order.buyQty ? '买入' : '卖出' }}</span></td><td class="num">{{ order.buyPrice == null ? '—' : fmt(order.buyPrice) }}</td><td class="num">{{ order.sellPrice == null ? '—' : fmt(order.sellPrice) }}</td><td class="num">{{ fmt(order.buyQuote + order.sellQuote) }}</td><td class="num">{{ fmt(order.fees) }}</td><td class="num" :class="moneyClass(order.realizedPnl)">{{ fmt(order.realizedPnl) }}</td><td class="num" :class="moneyClass(order.netPnl)">{{ fmt(order.netPnl) }}</td><td>{{ new Date(order.lastTime).toLocaleString() }}</td></tr>
          <tr v-if="!data.orders.length"><td colspan="9" class="empty">没有同步到成交记录。</td></tr>
        </tbody></table></div>
        <div v-else class="orders-table-wrap"><table><thead><tr><th>历史订单</th><th>方向</th><th>类型</th><th>状态</th><th>委托价</th><th>平均成交价</th><th>委托量</th><th>成交量</th><th>更新时间</th></tr></thead><tbody>
          <tr v-for="order in data.historyOrders" :key="order.symbol + '-' + order.orderId"><td><b>{{ order.symbol }}</b><small>#{{ order.orderId }}</small></td><td><span :class="order.side === 'BUY' ? 'buy' : 'sell'">{{ order.side === 'BUY' ? '买入' : '卖出' }}</span></td><td>{{ order.type || '—' }}</td><td><span class="status-tag">{{ orderStatus(order.status) }}</span></td><td class="num">{{ fmt(order.price) }}</td><td class="num">{{ order.executedQty ? fmt(order.avgPrice) : '—' }}</td><td class="num">{{ fmt(order.origQty) }}</td><td class="num">{{ fmt(order.executedQty) }}</td><td>{{ new Date(order.time).toLocaleString() }}</td></tr>
          <tr v-if="!data.historyOrders.length"><td colspan="9" class="empty">没有同步到历史订单。</td></tr>
        </tbody></table></div>
        <p class="orders-note">留空会从当前挂单、订单列表和非零资产发现账户相关交易对。币安 Spot API 不提供跨交易对的历史订单接口；已完全平仓、资产归零的旧交易对可在“补充交易对”中输入。买卖均价为同一订单内的成交加权均价。</p>
      </div>
    </template>
  </section>
</template>
<style scoped>
.orders-heading{align-items:flex-start}.spot-demo-badge{display:inline-block;margin:14px 0 0;padding:6px 9px;border-left:3px solid var(--brand-primary);background:var(--brand-bg);color:var(--text-secondary);font:11px var(--font-mono)}.order-mode-tabs,.order-list-tabs{display:flex;gap:4px;padding:4px;border:1px solid var(--border-primary);background:var(--bg-tertiary);border-radius:8px}.order-mode-tabs button,.order-list-tabs button{border:0;background:transparent;color:var(--text-tertiary);padding:8px 18px;border-radius:5px}.order-mode-tabs button.active,.order-list-tabs button.active{background:var(--bg-elevated);color:var(--text-primary);box-shadow:var(--shadow-sm)}.order-list-tabs{display:inline-flex;margin-top:18px}.orders-toolbar{display:flex;align-items:end;gap:12px;padding:16px;border:1px solid var(--border-primary);background:var(--bg-elevated);border-radius:8px}.orders-toolbar label{flex:1;display:grid;gap:6px;color:var(--text-tertiary);font-size:11px}.orders-toolbar input{padding:9px 10px}.orders-scope{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:14px;padding:10px 12px;border-left:3px solid var(--brand-primary);background:var(--brand-bg);color:var(--text-secondary);font-size:11px}.orders-scope b{color:var(--text-primary)}.orders-meta{display:flex;flex-wrap:wrap;gap:16px;color:var(--text-tertiary);font-size:11px;margin:18px 0 10px}.orders-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.orders-metrics article{padding:16px;background:var(--bg-elevated);border:1px solid var(--border-primary);border-radius:8px}.orders-metrics span,.orders-metrics em{display:block;color:var(--text-tertiary);font-size:11px;font-style:normal}.orders-metrics strong{display:block;margin:8px 0 4px;font:700 20px var(--font-mono);color:var(--text-primary)}.orders-metrics small{font:11px var(--font-body);color:var(--text-tertiary)}.orders-table-wrap{overflow-x:auto;margin-top:10px;border:1px solid var(--border-primary);border-radius:8px;background:var(--bg-elevated)}table{width:100%;border-collapse:collapse;min-width:980px}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--border-primary);white-space:nowrap;font-size:12px}th{color:var(--text-tertiary);font-weight:500;background:var(--bg-tertiary)}td small{display:block;color:var(--text-tertiary);margin-top:3px}td.num{font-family:var(--font-mono);text-align:right}th:nth-child(n+3){text-align:right}tr:last-child td{border-bottom:0}.buy,.sell,.round-trip,.status-tag{display:inline-block;padding:3px 7px;border-radius:4px;font-size:11px}.buy{color:var(--long);background:var(--brand-bg)}.sell{color:var(--short);background:var(--brand-bg)}.round-trip{color:var(--brand-primary);background:var(--brand-bg)}.status-tag{color:var(--text-secondary);background:var(--bg-tertiary)}.profit{color:var(--long)!important}.loss{color:var(--short)!important}.orders-note{color:var(--text-tertiary);font-size:11px;margin-top:10px}.orders-empty{padding:80px 24px;text-align:center;border:1px dashed var(--border-primary);border-radius:8px;background:var(--bg-elevated)}.empty-mark{color:var(--brand-primary);font:700 12px var(--font-mono);letter-spacing:2px}.orders-empty h3{margin:14px 0 8px}.orders-empty p,.empty{color:var(--text-tertiary)}.empty{text-align:center}@media(max-width:900px){.orders-metrics{grid-template-columns:repeat(2,1fr)}.orders-toolbar{align-items:stretch;flex-direction:column}}
</style>