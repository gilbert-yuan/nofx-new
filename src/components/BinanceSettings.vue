<script setup>
import { computed, reactive, ref, toRefs } from 'vue';
import { fmt, orderStatusLabel, dateTime, environmentName } from '../utils/binance.js';

const props = defineProps({
  binance: Object,
  trader: Object,
  loading: Boolean,
  status: Object,
  savedMode: String,
  smokeResult: Object,
  control: { type: Object, default: () => ({ account: null, openOrders: [], positions: [], positionMode: 'one-way' }) }
});
const { binance, trader, loading, status, savedMode, smokeResult, control } = toRefs(props);
const emit = defineEmits(['save', 'test', 'review', 'smoke', 'refresh-account', 'refresh-orders', 'refresh-positions', 'place-order', 'cancel-order', 'close-position']);
const stateName = value => ({ ok: '已完成', disabled: '未启用', blocked: '待配置', error: '失败', attention: '需要检查', skipped: '已跳过', dry_run: '模拟指令', sent: '已提交', held: '保持', rejected: '已拦截', proposed: '建议', uncertain: '需核对成交' }[value] || value || '尚未运行');
const smoke = reactive({ symbol: 'BTCUSDT', quantity: 0.002 });
const querySymbol = ref('');
const formError = ref('');
const orderForm = reactive({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 0.001, price: 0, reduceOnly: false });
const orderStatus = orderStatusLabel;
const confirmAction = message => typeof window === 'undefined' || window.confirm(message);
const environment = computed(() => environmentName(binance.value.demo));

// 凭证是否已配置：服务端返回的是打码值（yJ97…xxxx），非空即代表已保存过
const credentialsReady = computed(() => ({
  demo: Boolean(binance.value.demoApiKey),
  live: Boolean(binance.value.liveApiKey)
}));
// 冒烟步骤详情压缩为一行，避免把整个订单 JSON 铺满页面
const brief = value => {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return text.length > 140 ? text.slice(0, 140) + '…' : text;
};
const filterSymbol = () => querySymbol.value.trim().toUpperCase() || undefined;

function syncEnvironmentAlias() {
  binance.value.testnet = binance.value.demo === true;
}

function submitOrder() {
  formError.value = '';
  const symbol = String(orderForm.symbol || '').trim().toUpperCase();
  const quantity = Number(orderForm.quantity);
  const price = Number(orderForm.price);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) { formError.value = '请输入有效的 USDT 永续交易对，例如 BTCUSDT。'; return; }
  if (!(quantity > 0)) { formError.value = '下单数量必须大于 0。'; return; }
  if (orderForm.type === 'LIMIT' && !(price > 0)) { formError.value = '限价单必须填写大于 0 的价格。'; return; }
  const detail = environment.value + ' · ' + symbol + ' · ' + orderForm.side + ' ' + orderForm.type
    + ' · 数量 ' + quantity
    + (orderForm.type === 'LIMIT' ? ' · 价格 ' + price : '')
    + (orderForm.reduceOnly ? ' · 只减仓' : '');
  if (!confirmAction('确认提交 Binance ' + detail + '？')) return;
  emit('place-order', {
    symbol,
    side: orderForm.side,
    type: orderForm.type,
    quantity,
    ...(orderForm.type === 'LIMIT' ? { price } : {}),
    reduceOnly: orderForm.reduceOnly === true
  });
}

function cancelOrder(order) {
  if (!confirmAction('确认撤销 ' + order.symbol + ' #' + order.orderId + '？')) return;
  emit('cancel-order', { symbol: order.symbol, orderId: order.orderId });
}

function closePosition(position) {
  formError.value = '';
  if (control.value.positionMode === 'hedge') {
    formError.value = '当前账户是双向持仓；项目自动交易和快捷平仓只支持单向持仓。';
    return;
  }
  const amount = Number(position.positionAmt);
  if (!Number.isFinite(amount) || amount === 0) return;
  const side = amount > 0 ? 'SELL' : 'BUY';
  const detail = environment.value + ' · ' + position.symbol
    + ' · ' + side + ' MARKET · 数量 ' + Math.abs(amount) + ' · 只减仓';
  if (!confirmAction('确认平仓 ' + detail + '？')) return;
  emit('close-position', { symbol: position.symbol, side, type: 'MARKET', quantity: Math.abs(amount), reduceOnly: true });
}
</script>
<template>
  <div class="trading-layout">
    <section class="ai-settings">
      <div class="view-heading"><div><span class="eyebrow">BINANCE · USDⓈ-M</span><h2>币安交易配置</h2><p>环境凭证、自动执行范围与账户操作的统一入口。</p></div><span class="mode-pill">{{ savedMode }}</span></div>

      <fieldset class="settings-group"><legend>账户连接</legend>
        <div class="environment-credentials">
          <article class="environment-card demo-card">
            <div class="environment-card-head"><div><b>Demo Trading<small class="env-chip">{{ credentialsReady.demo ? '已配置' : '未配置' }}</small></b><small>demo-fapi.binance.com · 模拟资金</small></div><label class="sync-toggle"><input v-model="trader.syncPaperOrdersToDemo" type="checkbox" /><span>同步模拟单</span></label></div>
            <label>Demo API Key<input v-model="binance.demoApiKey" type="password" autocomplete="off" placeholder="Demo API Key" /></label>
            <label>Demo Secret Key<input v-model="binance.demoSecretKey" type="password" autocomplete="off" placeholder="Demo Secret Key" /></label>
          </article>
          <article class="environment-card live-card">
            <div class="environment-card-head"><div><b>USDⓈ-M 实盘<small class="env-chip live" :class="{ ready: credentialsReady.live }">{{ credentialsReady.live ? '已配置' : '未配置' }}</small></b><small>fapi.binance.com · 真实资金</small></div><label class="sync-toggle"><input v-model="trader.syncPaperOrdersToLive" type="checkbox" /><span>同步模拟单</span></label></div>
            <label>Live API Key<input v-model="binance.liveApiKey" type="password" autocomplete="off" placeholder="Live API Key" /></label>
            <label>Live Secret Key<input v-model="binance.liveSecretKey" type="password" autocomplete="off" placeholder="Live Secret Key" /></label>
          </article>
        </div>
        <div class="model-grid selected-environment">
          <label>手动操作环境<select v-model="binance.demo" @change="syncEnvironmentAlias"><option :value="true">Binance Demo Trading（测试盘）</option><option :value="false">Binance USDⓈ-M 实盘</option></select></label>
        </div>
        <p class="muted">两套凭证和同步开关相互独立。实盘只有在明确勾选“同步模拟单”并保存实盘 Key 后才会提交；API Key 请按最小权限创建并限制 IP。</p>
        <p v-if="trader.syncPaperOrdersToDemo && trader.syncPaperOrdersToLive" class="sync-warning">当前同时同步 Demo 和实盘：同一模拟开仓、分批止盈、平仓会分别提交到两个账户，请确认这是你的意图。</p>
      </fieldset>

      <fieldset class="settings-group"><legend>自动执行与风控</legend>
        <div class="permission-grid">
          <label><input v-model="trader.enabled" type="checkbox" /><span><b>启用定时复核</b><small>15 分钟行情同步后检查持仓</small></span></label>
          <label><input v-model="trader.dryRun" type="checkbox" /><span><b>仅生成模拟指令</b><small>记录建议，不提交订单</small></span></label>
          <label><input v-model="trader.allowEntryOrders" type="checkbox" /><span><b>自动开仓</b><small>只分析下方指定的候选币种</small></span></label>
          <label><input v-model="trader.allowProtectionUpdates" type="checkbox" /><span><b>止盈止损管理</b><small>复核并更新本系统的保护单</small></span></label>
          <label><input v-model="trader.allowCloseOrders" type="checkbox" /><span><b>自动平仓</b><small>策略退出时提交只减仓订单</small></span></label>
        </div>
        <label class="wide-label">开仓候选币种<input v-model="trader.entrySymbolsText" placeholder="BTCUSDT,ETHUSDT" /></label>
        <div class="model-grid">
          <label>每轮最多开仓<input v-model.number="trader.maxNewEntriesPerCycle" type="number" min="1" max="5" /></label>
          <label>最大杠杆<input v-model.number="trader.maxLeverage" type="number" min="1" max="20" /></label>
          <label>最低模型置信度<input v-model.number="trader.minConfidence" type="number" min="0" max="1" step="0.05" /></label>
          <label>单仓名义价值 / 权益<input v-model.number="trader.maxPositionNotionalPct" type="number" min="0.01" max="1" step="0.01" /></label>
          <label>总仓名义价值 / 权益<input v-model.number="trader.maxTotalNotionalPct" type="number" min="0.01" max="1" step="0.01" /></label>
          <label>保护价最小调整幅度（基点）<input v-model.number="trader.minProtectionMoveBps" type="number" min="0" step="5" /></label>
        </div>
        <p class="muted">比例 0.2 表示账户权益的 20%；置信度是模型自评，不代表实际胜率。Demo 同步只接受限价计划，不会补发历史模拟挂单。</p>
        <div class="button-row save-row"><button class="primary" @click="$emit('save')" :disabled="loading">保存币安配置</button><button class="ghost" @click="$emit('test')" :disabled="loading">测试已保存的连接</button></div>
      </fieldset>

      <fieldset class="settings-group"><legend>连接验证</legend>
        <div class="model-grid">
          <label>验证币种<input v-model="smoke.symbol" placeholder="BTCUSDT" /></label>
          <label>下单数量<input v-model.number="smoke.quantity" type="number" min="0.001" step="0.001" /></label>
        </div>
        <p class="muted">Demo 专用冒烟：以现价 50% 的远价挂 BUY 限价单（不可能成交）→ 查挂单 → 撤单 → 复核，验证签名鉴权/下单/查询/撤单全链路。需先保存 Demo Key。</p>
        <div class="button-row"><button class="secondary" @click="$emit('smoke', { symbol: smoke.symbol.trim().toUpperCase(), quantity: smoke.quantity })" :disabled="loading || binance.demo !== true">运行 Demo 冒烟测试</button></div>
        <p v-if="binance.demo !== true" class="muted">当前手动环境为实盘，冒烟按钮已禁用，避免在实盘创建测试挂单。</p>
        <ol v-if="smokeResult?.steps" class="smoke-steps">
          <li v-for="(step, index) in smokeResult.steps" :key="step.name" :class="{ failed: !step.ok }">
            <b><i class="step-no" :class="{ failed: !step.ok }">{{ index + 1 }}</i>{{ step.name }}</b>
            <span v-if="step.ok">{{ brief(step.detail) }}</span>
            <span v-else class="failed-text">{{ step.error }}</span>
          </li>
        </ol>
        <p v-if="smokeResult && !smokeResult.ok" class="failed-text">冒烟未通过：{{ smokeResult.error }}</p>
      </fieldset>

      <fieldset class="settings-group control-group"><legend>账户操作 · {{ environment }}</legend>
        <div class="control-banner">
          <div><b>USDⓈ-M Futures</b><span>{{ binance.demo ? 'Demo Trading · 只使用模拟资金' : '实盘 · 每次下单都需要浏览器确认' }}</span></div>
          <small v-if="control.updatedAt">数据更新于 {{ dateTime(control.updatedAt) }}</small>
        </div>
        <div v-if="control.account" class="account-metrics">
          <article><span>钱包余额</span><strong>{{ fmt(control.account.totalEquity) }} <small>USDT</small></strong></article>
          <article><span>活动持仓</span><strong>{{ control.account.activePositions }}</strong><small>{{ control.account.positionMode === 'hedge' ? '双向持仓' : '单向持仓' }}</small></article>
          <article><span>连接环境</span><strong>{{ control.account.demo ? 'Demo' : 'Live' }}</strong><small>{{ control.account.positionMode === 'hedge' ? '需检查账户模式' : '可快捷平仓' }}</small></article>
        </div>
        <p v-else class="control-empty">尚未读取账户快照。点击“测试已保存的连接”或下方“刷新账户快照”。</p>
        <div class="button-row control-actions">
          <button class="ghost" @click="$emit('refresh-account')" :disabled="loading">刷新账户快照</button>
        </div>

        <div class="control-section-head">
          <h3>手动下单</h3>
          <small>{{ binance.demo ? '写入 Demo 账户' : '写入实盘账户，请核对后再提交' }}</small>
        </div>
        <div class="manual-order-grid">
          <label>交易对<input v-model="orderForm.symbol" placeholder="BTCUSDT" /></label>
          <label>方向<select v-model="orderForm.side"><option value="BUY">BUY · 买入</option><option value="SELL">SELL · 卖出</option></select></label>
          <label>类型<select v-model="orderForm.type"><option value="LIMIT">LIMIT · 限价</option><option value="MARKET">MARKET · 市价</option></select></label>
          <label>数量<input v-model.number="orderForm.quantity" type="number" min="0" step="any" /></label>
          <label>价格<input v-model.number="orderForm.price" type="number" min="0" step="any" :disabled="orderForm.type === 'MARKET'" :placeholder="orderForm.type === 'MARKET' ? '市价单无需填写' : '例如 65000'" /></label>
          <label class="control-check"><input v-model="orderForm.reduceOnly" type="checkbox" /><span><b>只减仓</b><small>只减少现有仓位，不增加风险敞口</small></span></label>
        </div>
        <p class="muted control-warning" :class="{ live: !binance.demo }">{{ binance.demo ? 'Demo 下单仍会真实写入 Demo 账户；先刷新过滤器后再提交。' : '当前为实盘。提交前请再次核对交易对、方向、数量和价格。' }}</p>
        <p v-if="formError" class="failed-text" role="alert">{{ formError }}</p>
        <div class="button-row"><button class="primary" @click="submitOrder" :disabled="loading">提交 {{ orderForm.type === 'MARKET' ? '市价' : '限价' }}订单</button></div>

        <div class="control-section-head">
          <h3>当前持仓 <span>{{ control.positions?.length || 0 }}</span></h3>
          <button class="ghost mini-refresh" @click="$emit('refresh-positions', filterSymbol())" :disabled="loading">刷新</button>
        </div>
        <p class="muted section-note">模式：{{ control.positionMode === 'hedge' ? '双向' : '单向' }}<template v-if="!control.positions?.length"> · 点击“刷新”读取 Binance 当前账户状态</template></p>
        <div v-if="control.positions?.length" class="control-table-wrap"><table class="control-table"><thead><tr><th>交易对</th><th>数量</th><th>入场价</th><th>标记价</th><th>未实现盈亏</th><th>操作</th></tr></thead><tbody>
          <tr v-for="position in control.positions" :key="position.symbol + '-' + position.positionSide"><td><b>{{ position.symbol }}</b><small>{{ position.positionSide || 'BOTH' }}</small></td><td class="num">{{ position.positionAmt }}</td><td class="num">{{ fmt(position.entryPrice) }}</td><td class="num">{{ fmt(position.markPrice) }}</td><td class="num" :class="Number(position.unRealizedProfit) >= 0 ? 'positive' : 'negative'">{{ fmt(position.unRealizedProfit) }}</td><td><button class="mini-danger" @click="closePosition(position)" :disabled="loading || control.positionMode === 'hedge'">市价平仓</button></td></tr>
        </tbody></table></div>

        <div class="control-section-head">
          <h3>当前挂单 <span>{{ control.openOrders?.length || 0 }}</span></h3>
          <button class="ghost mini-refresh" @click="$emit('refresh-orders', filterSymbol())" :disabled="loading">刷新</button>
        </div>
        <p class="muted section-note">普通 LIMIT / MARKET 订单<template v-if="!control.openOrders?.length"> · 点击“刷新”读取当前未成交订单</template></p>
        <div v-if="control.openOrders?.length" class="control-table-wrap"><table class="control-table"><thead><tr><th>订单</th><th>方向</th><th>类型</th><th>价格</th><th>数量</th><th>状态</th><th>操作</th></tr></thead><tbody>
          <tr v-for="order in control.openOrders" :key="order.symbol + '-' + order.orderId"><td><b>{{ order.symbol }}</b><small>#{{ order.orderId }}</small></td><td :class="order.side === 'BUY' ? 'positive' : 'negative'">{{ order.side }}</td><td>{{ order.type }}</td><td class="num">{{ fmt(order.price) }}</td><td class="num">{{ order.origQty || order.origQuantity || '—' }}</td><td><span class="status-chip">{{ orderStatus(order.status) }}</span></td><td><button class="mini-danger" @click="cancelOrder(order)" :disabled="loading">撤单</button></td></tr>
        </tbody></table></div>
        <label class="wide-label query-symbol">查询交易对（可选）<input v-model="querySymbol" placeholder="留空查询全部；例如 BTCUSDT" /></label>
      </fieldset>
    </section>
    <aside class="execution-panel">
      <span class="eyebrow">POSITION REVIEW</span><h2>持仓复核</h2>
      <div class="execution-status"><span class="mode-pill">{{ status?.running ? '复核中' : stateName(status?.lastResult?.status) }}</span><p>{{ status?.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : '启用后随 15 分钟同步运行' }}</p></div>
      <p class="muted" v-if="status?.lastResult?.reason || status?.lastError">{{ status.lastResult?.reason || status.lastError }}</p>
      <button class="secondary" @click="$emit('review')" :disabled="loading || status?.running">按已保存配置立即复核</button>
      <div class="execution-history"><h3>最近执行记录</h3><p v-if="!status?.decisions?.length" class="empty">暂无记录。复核结果、拦截原因和执行状态会显示在这里。</p>
        <article v-for="record in status?.decisions || []" :key="record.id"><time>{{ new Date(record.at).toLocaleString() }}</time><b>{{ stateName(record.execution.status) }}</b><div v-for="item in [...(record.execution.reviews || []), ...(record.execution.entries || [])]" :key="item.symbol"><strong>{{ item.symbol }}</strong> · {{ stateName(item.action.status) }}<p>{{ item.action.reason || item.review?.reason || item.decision?.reason }}</p></div></article>
      </div>
    </aside>
  </div>
</template>
<style scoped>
.environment-credentials { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.environment-card { padding: 14px; border: 1px solid var(--border-primary); background: var(--bg-tertiary); }
.environment-card.demo-card { border-top: 2px solid var(--brand-primary); }
.environment-card.live-card { border-top: 2px solid var(--danger, #e5484d); }
.environment-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.environment-card-head b { display: flex; align-items: center; gap: 8px; color: var(--text-primary); font: 700 13px var(--font-mono); }
.environment-card-head small { display: block; margin-top: 4px; color: var(--text-tertiary); font-size: 11px; }
.env-chip { padding: 2px 6px; border: 1px solid var(--border-primary); color: var(--text-tertiary); font: 500 10px var(--font-body); letter-spacing: .04em; }
.env-chip.live { border-color: color-mix(in oklch, var(--danger, #e5484d) 40%, var(--border-primary)); }
.env-chip.live.ready { color: var(--danger, #e5484d); border-color: color-mix(in oklch, var(--danger, #e5484d) 40%, var(--border-primary)); }
.environment-card > label { display: block; margin-top: 10px; color: var(--text-tertiary); font-size: 11px; }
.environment-card > label input { width: 100%; margin-top: 6px; }
.sync-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); white-space: nowrap; font-size: 11px; }
.sync-toggle input { accent-color: var(--brand-primary); }
.selected-environment { max-width: 360px; margin-top: 12px; }
.sync-warning { margin: 10px 0 0; padding: 10px 12px; border-left: 3px solid var(--danger, #e5484d); color: var(--danger, #e5484d); background: color-mix(in oklch, var(--danger, #e5484d) 8%, transparent); font-size: 12px; line-height: 1.55; }
.save-row { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-secondary); }
.smoke-steps { margin: 10px 0 0; padding-left: 4px; list-style: none; font-size: 12px; display: grid; gap: 6px; }
.smoke-steps li { display: flex; flex-direction: column; gap: 2px; color: var(--text-secondary); }
.smoke-steps li b { display: inline-flex; align-items: center; gap: 8px; color: var(--text-primary); }
.smoke-steps li.failed b { color: var(--danger, #e5484d); }
.step-no { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1px solid var(--border-primary); color: var(--brand-primary); background: var(--bg-tertiary); font: 600 10px var(--font-mono); font-style: normal; }
.step-no.failed { color: var(--danger, #e5484d); border-color: color-mix(in oklch, var(--danger, #e5484d) 40%, var(--border-primary)); }
.smoke-steps span { overflow-wrap: anywhere; color: var(--text-tertiary); }
.failed-text { color: var(--danger, #e5484d); font-size: 12px; }
.control-group { margin-top: 24px; }
.control-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-left: 3px solid var(--brand-primary);
  background: var(--brand-bg);
  color: var(--text-secondary);
  font-size: 11px;
}
.control-banner b { display: block; color: var(--text-primary); font: 700 12px var(--font-mono); letter-spacing: .04em; }
.control-banner span, .control-banner small { display: block; margin-top: 4px; color: var(--text-tertiary); }
.control-actions { margin-top: 12px; }
.account-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0;
}
.account-metrics article {
  padding: 12px;
  border: 1px solid var(--border-primary);
  background: var(--bg-tertiary);
}
.account-metrics span, .account-metrics small { display: block; color: var(--text-tertiary); font-size: 11px; }
.account-metrics strong { display: block; margin: 7px 0 3px; color: var(--text-primary); font: 700 16px var(--font-mono); }
.account-metrics strong small { display: inline; font: 11px var(--font-body); }
.manual-order-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}
.manual-order-grid label { min-width: 0; color: var(--text-tertiary); font-size: 11px; }
.manual-order-grid input, .manual-order-grid select { width: 100%; min-width: 0; margin-top: 6px; }
.control-check { display: flex; align-items: start; gap: 8px; padding: 9px 10px; border: 1px solid var(--border-primary); background: var(--bg-tertiary); }
.control-check input { width: auto; margin-top: 2px; accent-color: var(--brand-primary); }
.control-check b { display: block; color: var(--text-primary); font-size: 12px; }
.control-check small { display: block; margin-top: 4px; line-height: 1.5; }
.control-warning.live { color: var(--danger, #e5484d); }
.control-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 24px 0 8px; padding-top: 16px; border-top: 1px solid var(--border-secondary); }
.control-section-head h3 { margin: 0; color: var(--text-primary); font-size: 13px; }
.control-section-head h3 span { color: var(--brand-primary); font: 700 12px var(--font-mono); }
.control-section-head small { color: var(--text-tertiary); font-size: 11px; }
.mini-refresh { padding: 4px 10px; font-size: 11px; }
.section-note { margin: 0 0 8px; }
.control-table-wrap { overflow-x: auto; border: 1px solid var(--border-primary); background: var(--bg-tertiary); }
.control-table { width: 100%; min-width: 660px; border-collapse: collapse; }
.control-table th, .control-table td { padding: 9px 10px; border-bottom: 1px solid var(--border-primary); text-align: left; white-space: nowrap; font-size: 11px; }
.control-table th { color: var(--text-tertiary); font-weight: 500; }
.control-table tr:last-child td { border-bottom: 0; }
.control-table td small { display: block; margin-top: 3px; color: var(--text-tertiary); }
.control-table .num { text-align: right; font-family: var(--font-mono); }
.positive { color: var(--long, var(--brand-primary)); }
.negative { color: var(--short, var(--danger, #e5484d)); }
.status-chip { display: inline-block; padding: 3px 6px; color: var(--text-secondary); background: var(--bg-elevated); }
.mini-danger { padding: 5px 8px; border: 1px solid color-mix(in oklch, var(--danger, #e5484d) 45%, var(--border-primary)); color: var(--danger, #e5484d); background: var(--danger-bg, transparent); font-size: 11px; }
.mini-danger:hover { background: color-mix(in oklch, var(--danger, #e5484d) 16%, transparent); }
.control-empty { margin: 0; padding: 14px; border: 1px dashed var(--border-primary); color: var(--text-tertiary); font-size: 11px; }
.query-symbol { margin-top: 14px; max-width: 360px; }
@media (max-width: 720px) {
  .environment-credentials, .account-metrics, .manual-order-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .control-banner { align-items: start; flex-direction: column; }
}
@media (max-width: 460px) {
  .environment-credentials, .account-metrics, .manual-order-grid { grid-template-columns: 1fr; }
}
</style>
