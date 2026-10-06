<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { binanceApi } from '../api/client.js';
import { fmt, pct, statusLabel as status, reasonLabel as reason, reasonGroup } from '../utils/format.js';
import { isoDateTime } from '../utils/binance.js';

// 数据状态
const accountData = ref(null);
const busy = ref(false);
const error = ref('');
const overview = computed(() => accountData.value || {});
const actionMessage = ref('');
const closedOrders = computed(() => accountData.value?.closedOrders || (accountData.value?.orders || []).filter(o => o.status === 'closed'));
const selectedExchangeOrder = ref(null);
let pollTimer = null;
let disposed = false;
let loadSequence = 0;
const activeOrders = computed(() => accountData.value?.activeOrders || (accountData.value?.orders || []).filter(o => ['pending', 'open'].includes(o.status)));
const activityCounts = computed(() => ({ positions: activeOrders.value.filter(o => o.status === 'open').length, pending: activeOrders.value.filter(o => o.status === 'pending').length }));
const exchangeAccounts = computed(() => Object.values(accountData.value?.exchangeAccounts || {}).filter(account => account.enabled));

// 币安绑定订单（exchangeSync.demo / exchangeSync.live）
const remoteDetail = ref({});   // env -> 远端订单详情（点击「详情」时自动实时拉取）
const remoteLoading = ref({});  // env -> 是否正在向币安实时查询
const remoteError = ref('');
const BINANCE_ENVS = ['demo', 'live'];
const SYNC_STATUS_LABEL = {
  not_submitted: '未提交', submitting: '提交中', submitted: '已提交', new: '已挂单',
  partially_filled: '部分成交', filled: '已成交', canceled: '已撤销', cancelled: '已撤销',
  expired: '已过期', rejected: '已拒绝', submit_error: '提交失败', cancel_requested: '撤销中',
  cancel_error: '撤销失败', unknown: '状态未知', skipped_no_fill: '未成交跳过', not_configured: '未配置',
  unsupported_symbol: '环境不支持该合约'
};
const syncStatusLabel = value => SYNC_STATUS_LABEL[value] || value || '—';
/** 归一化绑定信息：新结构 exchangeSync.{demo,live}，旧订单回落单环境 exchange（Demo） */
function bindingOf(order, env) {
  const link = order?.exchangeSync?.[env] || (env === 'demo' ? order?.exchange : null) || null;
  const bound = Boolean(link && (link.orderId || link.clientOrderId) && !['not_submitted', 'not_configured', 'skipped_closed'].includes(link.status));
  return { link, bound };
}
/** 清空币安侧状态：切换订单 / 重新打开详情时调用，避免展示上一单的残留数据 */
function resetRemoteOrder() {
  remoteDetail.value = {};
  remoteLoading.value = {};
  remoteError.value = '';
}
/**
 * 向币安实时查询单个环境的订单详情。
 * 默认复用本次已加载的结果；force=true 强制重新查询（刷新 / 失败重试）。
 * 订单切换后回来的过期响应会被丢弃，不会污染当前弹窗。
 */
async function loadRemoteOrder(order, env, { force = false } = {}) {
  if (!order) return;
  const { link, bound } = bindingOf(order, env);
  if (!bound) return;
  if (!force && remoteDetail.value[env]) return;
  remoteLoading.value = { ...remoteLoading.value, [env]: true };
  remoteError.value = '';
  try {
    const result = await binanceApi.orderDetail({
      environment: env, symbol: order.symbol,
      orderId: link.orderId || undefined, clientOrderId: link.orderId ? undefined : link.clientOrderId
    });
    if (selectedOrder.value?.id !== order.id) return;
    remoteDetail.value = { ...remoteDetail.value, [env]: result.order };
  } catch (err) {
    if (selectedOrder.value?.id !== order.id) return;
    remoteError.value = env + '：' + err.message;
  } finally {
    remoteLoading.value = { ...remoteLoading.value, [env]: false };
  }
}
/** 该订单所有已绑定环境的币安详情并行拉取（点击「详情」时自动触发，无需二次点击） */
function loadBoundRemoteOrders(order) {
  return Promise.all(
    BINANCE_ENVS.filter(env => bindingOf(order, env).bound).map(env => loadRemoteOrder(order, env))
  );
}
/** 绑定区按钮文案：获取中 / 刷新 / 重试（按钮只做刷新与重试，展示不再依赖它） */
function remoteActionLabel(env) {
  if (remoteLoading.value[env]) return '获取中…';
  return remoteDetail.value[env] ? '刷新' : '重试';
}
// 模拟交易相关
const orderInput = ref({ recordId: '', symbol: '', margin: 100, leverage: 2 });
const showOrderForm = ref(false);
const selectedOrder = ref(null);
// Register after the ref exists: watch evaluates its getter during setup.
watch(() => selectedOrder.value?.id, () => resetRemoteOrder());
const orderPage = ref(1);
const orderPageSize = ref(8); // 每页 8 条
const orderScope = ref('active'); // active: 持仓 + 待入场 | closed: 已平仓

// 筛选器
const statusFilter = ref('all'); // all, pending, open（作用于「持仓与待入场」段）
const directionFilter = ref('all'); // all, long, short
const sortBy = ref('createdAt'); // createdAt, net, roi, exitAt
const sortOrder = ref('desc'); // asc, desc

// 排序后的订单
const filteredOrders = computed(() => {
  if (!accountData.value?.orders) return [];

  // 订单区分两段：① 持仓 + 待入场（在途）② 已平仓（历史成交）
  let orders = orderScope.value === 'closed'
    ? closedOrders.value : activeOrders.value;

  // 状态筛选（仅「持仓 / 待入场」段有意义；已平仓段只有一种状态）
  if (orderScope.value === 'active') {
    if (statusFilter.value === 'pending') orders = orders.filter(o => o.status === 'pending');
    else if (statusFilter.value === 'open') orders = orders.filter(o => o.status === 'open');
  }

  // 方向筛选
  if (directionFilter.value === 'long') {
    orders = orders.filter(o => o.direction === 'OPEN_LONG');
  } else if (directionFilter.value === 'short') {
    orders = orders.filter(o => o.direction === 'OPEN_SHORT');
  }

  // 排序
  orders = [...orders].sort((a, b) => {
    let aVal = a[sortBy.value];
    let bVal = b[sortBy.value];

    // 处理空值
    if (aVal === null || aVal === undefined) aVal = sortOrder.value === 'desc' ? -Infinity : Infinity;
    if (bVal === null || bVal === undefined) bVal = sortOrder.value === 'desc' ? -Infinity : Infinity;

    // 日期字段特殊处理
    if (sortBy.value === 'createdAt' || sortBy.value === 'exitAt') {
      aVal = new Date(aVal).getTime();
      bVal = new Date(bVal).getTime();
    }

    return sortOrder.value === 'desc' ? bVal - aVal : aVal - bVal;
  });

  return orders;
});

// 分页后的订单
const paginatedOrders = computed(() => {
  const start = (orderPage.value - 1) * orderPageSize.value;
  const end = start + orderPageSize.value;
  return filteredOrders.value.slice(start, end);
});

// 总页数
const totalOrderPages = computed(() => {
  return Math.max(1, Math.ceil(filteredOrders.value.length / orderPageSize.value));
});

// 两段订单的数量（用于分段按钮角标）
const scopeCounts = computed(() => {
  const orders = accountData.value?.orders || [];
  return {
    active: activeOrders.value.length,
    closed: closedOrders.value.length
  };
});

// 订单统计
const orderStats = computed(() => {
  if (!accountData.value?.orders) return null;

  const orders = accountData.value.orders;
  const closed = closedOrders.value;
  const wins = closed.filter(o => o.net > 0);
  const losses = closed.filter(o => o.net < 0);

  return {
    total: orders.length,
    active: orders.filter(o => ['pending', 'open'].includes(o.status)).length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? wins.length / closed.length : 0,
    totalNet: closed.reduce((sum, o) => sum + o.net, 0),
    avgNet: closed.length > 0 ? closed.reduce((sum, o) => sum + o.net, 0) / closed.length : 0,
    avgWin: wins.length > 0 ? wins.reduce((sum, o) => sum + o.net, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((sum, o) => sum + o.net, 0) / losses.length : 0,
    maxWin: closed.length > 0 ? Math.max(...closed.map(o => o.net)) : 0,
    maxLoss: closed.length > 0 ? Math.min(...closed.map(o => o.net)) : 0
  };
});



// 格式化函数
// fmt / pct / statusLabel / reasonLabel 由 ../utils/format.js 提供
const precise = value => value == null || !Number.isFinite(Number(value)) ? '—'
  : Number(value).toLocaleString('zh-CN', { useGrouping: false, maximumSignificantDigits: 10 });

// 加载模拟账户数据
async function loadAccount({ silent = false } = {}) {
  const sequence = ++loadSequence;
  if (!silent) { busy.value = true; error.value = ''; }
  try {
    const data = await api('/paper/account?view=summary');
    if (!disposed && sequence === loadSequence) accountData.value = data;
  } catch (err) {
    if (!disposed && sequence === loadSequence) error.value = err.message;
  } finally {
    if (!silent && !disposed) busy.value = false;
  }
}

// 刷新模拟账户
async function refreshAccount() {
  ++loadSequence;
  busy.value = true;
  error.value = '';
  try {
    accountData.value = await api('/paper/exchange-refresh', { method: 'POST' });
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// 提交模拟订单
async function submitOrder() {
  busy.value = true;
  error.value = '';
  try {
    await api('/paper/orders', {
      method: 'POST',
      body: orderInput.value
    });
    showOrderForm.value = false;
    await loadAccount();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// 设置初始金额（重定账户基期，自动仓位按权益比例随之缩放）
const capitalInput = ref('');
const showCapitalForm = ref(false);
async function setCapital() {
  const v = Number(capitalInput.value);
  if (!Number.isFinite(v) || v < 1) {
    error.value = '请输入有效的初始金额（≥1 USDT）';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api('/paper/capital', { method: 'PUT', body: { initialBalance: v } });
    showCapitalForm.value = false;
    capitalInput.value = '';
    await loadAccount();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

function describeAction(result) {
  const items = result.results || [];
  const issues = items.flatMap(item => item.results || [item]).filter(item => item.error || item.warning || item.complete === false);
  actionMessage.value = issues.length ? issues.map(item => `${item.symbol || ''} ${item.error || item.warning || '已提交，等待币安持仓确认'}`).join('；') : '操作已完成，资金池和订单列表已更新。';
  if (result.account) accountData.value = result.account;
}
async function closeOrder(order) {
  const targets = order.executionTargets?.map(target => target.environment === 'live' ? '币安实盘' : '币安模拟盘') || [];
  const operation = order.status === 'open' ? '平仓' : '撤单';
  const detail = targets.length ? `，涉及 ${[...new Set(targets)].join('、')}，将处理该行对应的全部交易目标` : '';
  if (!confirm(`确认${operation} ${order.symbol}${detail}？${order.status === 'open' ? '同方向合并持仓及其待入场余量将一起处理。' : '已成交部分继续保留。'}`)) return;
  busy.value = true;
  error.value = ''; actionMessage.value = ''; ++loadSequence;
  try {
    describeAction(await api(`/paper/activity/${encodeURIComponent(order.id)}/close`, { method: 'POST', timeoutMs: 180000 }));
  } catch (err) {
    error.value = err.message;
    await loadAccount({ silent: true });
  } finally {
    busy.value = false;
  }
}
async function closeAll() {
  const live = activeOrders.value.some(order => order.executionTargets?.some(target => target.environment === 'live'));
  if (!confirm(`确认平掉全部 ${activityCounts.value.positions} 个持仓，并撤销 ${activityCounts.value.pending} 个待入场订单？${live ? '包括币安实盘仓位。' : ''}完成后暂停新开仓，需手动恢复。`)) return;
  busy.value = true; error.value = ''; actionMessage.value = ''; ++loadSequence;
  try { describeAction(await api('/paper/close-all', { method: 'POST', timeoutMs: 600000 })); }
  catch (err) { error.value = err.message; await loadAccount({ silent: true }); }
  finally { busy.value = false; }
}
async function resumeEntries() {
  busy.value = true; error.value = '';
  try { await api('/paper/entries-paused', { method: 'PUT', body: { paused: false } }); await loadAccount(); }
  catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}

// 查看订单详情：点击即加载完整明细，并自动实时拉取该订单已绑定的币安订单详情
async function viewOrderDetail(order) {
  if (order.kind === 'external_closed' || order.id.startsWith('fused:') || order.id.startsWith('reconciling:')) {
    selectedExchangeOrder.value = order;
    return;
  }
  if (!order) return;
  const orderId = order.id;
  selectedOrder.value = order;   // 先渲染列表行已有字段，避免点击后空白等待
  resetRemoteOrder();
  try {
    const detail = await api(`/paper/orders/${encodeURIComponent(orderId)}`);
    if (selectedOrder.value?.id !== orderId) return;   // 已切到别的订单，丢弃本次结果
    selectedOrder.value = { ...detail, ...order, exchangeSync: detail.exchangeSync, exchange: detail.exchange, analysisContext: detail.analysisContext };
    // 绑定关系只在完整明细里（accountSummary 不含 exchangeSync），拿到明细后立即并行拉币安详情
    await loadBoundRemoteOrders(detail);
  } catch (err) { error.value = err.message; }
}

// 分页控制
function goToOrderPage(page) {
  if (page >= 1 && page <= totalOrderPages.value) {
    orderPage.value = page;
  }
}

// 切换订单分段（在途 / 已平仓）
function switchOrderScope(scope) {
  if (orderScope.value === scope) return;
  orderScope.value = scope;
  orderPage.value = 1;
  // 已平仓更关心「平仓时间」，在途更关心「创建时间」——只做语义默认值切换，不覆盖用户已选
  if (scope === 'closed' && sortBy.value === 'createdAt') sortBy.value = 'exitAt';
  else if (scope === 'active' && sortBy.value === 'exitAt') sortBy.value = 'createdAt';
}

// 重置筛选时重置页码
watch([statusFilter, directionFilter, sortBy, sortOrder], () => {
  orderPage.value = 1;
});
watch(totalOrderPages, pages => { orderPage.value = Math.min(orderPage.value, pages); });
watch(activeOrders, orders => {
  if (selectedExchangeOrder.value) selectedExchangeOrder.value = orders.find(o => o.id === selectedExchangeOrder.value.id) || null;
});

// 初始化
onMounted(() => {
  loadAccount();
  const poll = async () => {
    if (disposed) return;
    if (!busy.value && document.visibilityState !== 'hidden') await loadAccount({ silent: true });
    if (!disposed) pollTimer = setTimeout(poll, 10000);
  };
  pollTimer = setTimeout(poll, 10000);
});
onUnmounted(() => { disposed = true; ++loadSequence; clearTimeout(pollTimer); });
</script>

<template>
  <section class="history-panel trading-unified-view">
    <div class="view-heading">
      <div>
        <span class="eyebrow">UNIFIED TRADING SIMULATION</span>
        <h2>交易模拟</h2>
        <p>多策略共享资金池 · 成交与持仓融合管理</p>
      </div>
    </div>

    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <p v-if="actionMessage" class="signal-warning" role="status">{{ actionMessage }}</p>
    <p v-if="busy" class="inline-loading" role="status">正在处理，请稍候…</p>

    <!-- 模拟账户视图 -->
    <template v-if="accountData">
      <!-- 账户概览 -->
      <p class="muted pool-description">统一资金池（USDT） · 金额与收益依据：币安实盘 &gt; 币安模拟盘 &gt; 本地策略</p>
      <div class="summary-metrics performance-metrics">
        <article class="summary-metric">
          <span>已实现收益</span>
          <strong :class="overview.realized > 0 ? 'profit' : overview.realized < 0 ? 'loss' : ''">
            {{ fmt(overview.realized) }}
          </strong>
          <small>未实现 <span :class="overview.unrealized > 0 ? 'profit' : overview.unrealized < 0 ? 'loss' : ''">{{ fmt(overview.unrealized) }}</span></small>
          <small>成交净收益含手续费与资金费</small>
        </article>
        <article class="summary-metric">
          <span>持仓 / 待入场</span>
          <strong>{{ overview.positions }} / {{ overview.pending }}</strong>
          <small>已用保证金 {{ fmt(overview.usedMargin) }}</small>
          <small>手续费预留 {{ fmt(overview.feeReserve) }} · 提交中占用 {{ fmt(overview.reservationMargin) }}</small>
        </article>
        <article class="summary-metric">
          <span>可用余额</span>
          <strong>{{ fmt(overview.available) }}</strong>
          <small>总收益 <span :class="overview.net > 0 ? 'profit' : overview.net < 0 ? 'loss' : ''">{{ fmt(overview.net) }}</span></small>
        </article>
        <article class="summary-metric">
          <span>总权益</span>
          <strong>{{ fmt(overview.equity) }}</strong>
          <small>初始金额 {{ fmt(accountData.initialBalance) }} · 自动仓位 {{ fmt(accountData.equity * (accountData.autoMarginPct ?? 0.05)) }}/笔</small>
        </article>
        <article v-if="orderStats" class="summary-metric">
          <span>胜率</span>
          <strong :class="orderStats.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(orderStats.winRate) }}</strong>
          <small>{{ orderStats.wins }}胜 / {{ orderStats.losses }}负</small>
        </article>
      </div>

      <div class="action-row">
        <button class="primary" :disabled="busy" @click="refreshAccount">同步成交、持仓与挂单</button>
        <button class="ghost" :disabled="busy || !overview.canOpen" @click="showOrderForm = !showOrderForm">
          {{ showOrderForm ? '取消下单' : '新建模拟订单' }}
        </button>
        <button class="ghost" :disabled="busy" @click="showCapitalForm = !showCapitalForm; capitalInput = accountData.initialBalance">
          {{ showCapitalForm ? '取消设置' : '设置资金池初始金额' }}
        </button>
        <button class="btn-small btn-danger" :disabled="busy || !activeOrders.length" @click="closeAll">全部平仓并撤单</button>
        <button v-if="accountData.entriesPaused" class="ghost" :disabled="busy" @click="resumeEntries">恢复开仓</button>
      </div>
      <div class="exchange-sync-overview" aria-live="polite">
        <p v-for="account in exchangeAccounts" :key="account.environment" :class="{ 'failed-text': account.error }">
          <b>{{ account.environment === 'demo' ? '模拟盘数据' : '实盘数据' }}</b>
          · {{ account.syncedAt ? '最近同步 ' + isoDateTime(account.syncedAt) : '尚未完成同步' }}
          <template v-if="account.syncedAt"> · {{ account.positions?.length || 0 }} 个持仓 / {{ account.orders?.length || 0 }} 个入场挂单</template>
          <template v-if="account.error"> · {{ account.error }}{{ account.syncedAt ? '（展示上次成功同步的数据）' : '' }}</template>
        </p>
        <p v-for="warning in overview.warnings || []" :key="warning" class="failed-text">{{ warning }}</p>
        <small>总权益 = 本地设定初始金额 + 已实现收益 + 未实现收益；可用余额 = 总权益 − 持仓与挂单保证金 − 手续费预留 − 提交中占用。</small>
        <p><small>持仓与挂单每 10 秒同步，成交收益通常每 30 秒同步。存量未绑定持仓从接入资金池时起记录已实现收益，当前浮盈亏计入权益；已绑定策略订单按实际成交历史核算。杠杆后的买入金额不作为资金池上限。</small></p>
      </div>

      <!-- 初始金额设置 -->
      <form v-if="showCapitalForm" class="capital-form" @submit.prevent="setCapital">
        <label>
          初始金额（USDT）
          <input v-model="capitalInput" type="number" min="1" step="1" placeholder="例如 100" required>
        </label>
        <button class="primary" type="submit" :disabled="busy">保存</button>
        <small style="align-self:center;">保存后自动仓位 = 总权益 × 自动仓位比例，随盈亏复利缩放。</small>
      </form>

      <!-- 订单分段：持仓+待入场 / 已平仓 -->
      <div class="order-scope-switch">
        <button :class="{ active: orderScope === 'active' }" @click="switchOrderScope('active')">
          持仓与待入场 <span class="scope-count">{{ scopeCounts.active }}</span>
        </button>
        <button :class="{ active: orderScope === 'closed' }" @click="switchOrderScope('closed')">
          已平仓订单 <span class="scope-count">{{ scopeCounts.closed }}</span>
        </button>
      </div>

      <!-- 筛选和排序 -->
      <div class="filter-row">
        <label v-if="orderScope === 'active'">
          状态
          <select v-model="statusFilter">
            <option value="all">全部</option>
            <option value="pending">等待入场</option>
            <option value="open">持仓</option>
          </select>
        </label>

        <label>
          方向
          <select v-model="directionFilter">
            <option value="all">全部</option>
            <option value="long">做多</option>
            <option value="short">做空</option>
          </select>
        </label>

        <label>
          排序
          <select v-model="sortBy">
            <option value="createdAt">创建时间</option>
            <option value="exitAt">平仓时间</option>
            <option value="net">净收益</option>
            <option value="roi">ROI</option>
          </select>
        </label>

        <label>
          顺序
          <select v-model="sortOrder">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>

        <span class="filter-result">{{ filteredOrders.length }} 个订单</span>
      </div>

      <!-- 订单表格 -->
      <h2 class="performance-subtitle">
        {{ orderScope === 'closed' ? '已平仓订单' : '持仓与待入场单' }}（第 {{ orderPage }} / {{ totalOrderPages }} 页）
      </h2>
      <div class="performance-table">
        <table>
          <thead>
            <tr>
              <th>币种</th>
              <th>数据依据</th>
              <th>方向</th>
              <th>状态</th>
              <th>杠杆</th>
              <th>保证金（USDT）</th>
              <th>入场价</th>
              <th>标记价</th>
              <th>未实现</th>
              <th>净收益</th>
              <th>ROI</th>
              <th>平仓理由</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="order in paginatedOrders" :key="order.id">
              <td><strong>{{ order.symbol }}</strong></td>
              <td>{{ order.sourceLabel || '本地模拟' }}<small v-if="order.stale" class="failed-text"> · 同步异常</small></td>
              <td>
                <span :class="order.direction === 'OPEN_LONG' ? 'badge-long' : 'badge-short'">
                  {{ order.direction === 'OPEN_LONG' ? '多' : '空' }}
                </span>
              </td>
              <td>
                {{ order.status === 'closed' ? '已平仓' : order.source && order.source !== 'paper' ? (order.status === 'open' ? '实际持仓' : order.remoteStatus === 'partially_filled' ? '部分成交 · 余量待入场' : '等待入场') : status(order.status) }}
                <small v-for="local in order.localOrders || []" :key="local.id" class="local-order-note">本地模拟：{{ status(local.status) }}</small>
              </td>
              <td>{{ order.leverage }}x</td>
              <td :title="'买入金额 ' + fmt(order.buyAmount ?? order.notional) + ' USDT'">{{ order.margin != null ? fmt(order.margin) : '—' }}</td>
              <td>{{ order.entry ? precise(order.entry) : '—' }}</td>
              <td>{{ order.markPrice ? precise(order.markPrice) : '—' }}</td>
              <td :class="order.unrealized > 0 ? 'profit' : order.unrealized < 0 ? 'loss' : ''">
                {{ order.unrealized != null ? fmt(order.unrealized) : '—' }}
              </td>
              <td :class="order.net > 0 ? 'profit' : order.net < 0 ? 'loss' : ''">
                {{ order.net != null ? fmt(order.net) : '—' }}
                <small v-if="order.accountingIncomplete" class="failed-text">历史明细待补齐</small>
              </td>
              <td :class="order.roi > 0 ? 'profit' : order.roi < 0 ? 'loss' : ''">
                {{ order.roi != null ? pct(order.roi) : '—' }}
              </td>
              <td>
                <span v-if="order.reason" class="close-reason" :data-group="reasonGroup(order.reason)">
                  {{ reason(order.reason) }}
                </span>
                <span v-else>—</span>
              </td>
              <td>
                <button class="btn-small" @click="viewOrderDetail(order)">详情</button>
                <button
                  v-if="['pending', 'open'].includes(order.status)"
                  class="btn-small btn-danger"
                  :disabled="busy"
                  @click="closeOrder(order)"
                >
                  {{ order.status === 'open' ? '平仓' : '撤单' }}
                </button>
              </td>
            </tr>
            <tr v-if="!paginatedOrders.length">
              <td colspan="13" class="empty">
                {{ orderScope === 'closed' ? '暂无已平仓订单' : '当前没有持仓或待入场单' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页控件 -->
      <div class="pagination" v-if="totalOrderPages > 1">
        <button
          class="btn-small"
          :disabled="orderPage === 1"
          @click="goToOrderPage(1)"
        >
          首页
        </button>
        <button
          class="btn-small"
          :disabled="orderPage === 1"
          @click="goToOrderPage(orderPage - 1)"
        >
          上一页
        </button>

        <span class="page-info">
          第 {{ orderPage }} / {{ totalOrderPages }} 页，共 {{ filteredOrders.length }} 条
        </span>

        <button
          class="btn-small"
          :disabled="orderPage === totalOrderPages"
          @click="goToOrderPage(orderPage + 1)"
        >
          下一页
        </button>
        <button
          class="btn-small"
          :disabled="orderPage === totalOrderPages"
          @click="goToOrderPage(totalOrderPages)"
        >
          末页
        </button>

        <label style="margin-left: 16px;">
          每页
          <select v-model.number="orderPageSize" @change="orderPage = 1">
            <option :value="8">8</option>
            <option :value="16">16</option>
            <option :value="32">32</option>
            <option :value="64">64</option>
          </select>
          条
        </label>
      </div>

    </template>

    <div v-if="selectedExchangeOrder" class="modal-backdrop" @click.self="selectedExchangeOrder = null">
      <article class="modal modal-wide">
        <button class="modal-close" @click="selectedExchangeOrder = null">×</button>
        <h2>{{ selectedExchangeOrder.sourceLabel }} · {{ selectedExchangeOrder.symbol }}</h2>
        <div class="detail-section">
          <dl>
            <dt>状态</dt><dd>{{ selectedExchangeOrder.status === 'closed' ? '已平仓' : selectedExchangeOrder.status === 'open' ? '实际持仓' : syncStatusLabel(selectedExchangeOrder.remoteStatus) }}</dd>
            <dt>买入金额 / 保证金</dt><dd>{{ fmt(selectedExchangeOrder.buyAmount) }} / {{ fmt(selectedExchangeOrder.margin) }} USDT</dd>
            <dt>净收益</dt><dd>{{ fmt(selectedExchangeOrder.net) }} USDT</dd>
            <dt>执行目标</dt><dd>{{ selectedExchangeOrder.executionTargets?.map(target => target.environment === 'live' ? '币安实盘' : '币安模拟盘').join('、') || '已完成成交' }}</dd>
            <dt>方向 / 持仓模式</dt><dd>{{ selectedExchangeOrder.direction === 'OPEN_LONG' ? '做多' : '做空' }} / {{ selectedExchangeOrder.positionSide }}</dd>
            <dt>入场 / 委托价</dt><dd>{{ precise(selectedExchangeOrder.entry) }}</dd>
            <dt>{{ selectedExchangeOrder.status === 'open' ? '持仓数量' : '剩余委托数量' }}</dt><dd>{{ precise(selectedExchangeOrder.quantity) }}</dd>
            <template v-if="selectedExchangeOrder.orderId">
              <dt>币安订单 ID</dt><dd>{{ selectedExchangeOrder.orderId }}</dd>
              <dt>客户端订单 ID</dt><dd>{{ selectedExchangeOrder.clientOrderId || '—' }}</dd>
              <dt>委托 / 成交数量</dt><dd>{{ precise(selectedExchangeOrder.origQty) }} / {{ precise(selectedExchangeOrder.executedQty) }}</dd>
            </template>
            <template v-if="selectedExchangeOrder.status === 'open'">
              <dt>标记价</dt><dd>{{ precise(selectedExchangeOrder.markPrice) }}</dd>
              <dt>未实现收益</dt><dd>{{ fmt(selectedExchangeOrder.unrealized) }} USDT</dd>
            </template>
            <dt>最近同步</dt><dd>{{ isoDateTime(selectedExchangeOrder.syncedAt) }}</dd>
          </dl>
          <p v-if="selectedExchangeOrder.syncError" class="failed-text">{{ selectedExchangeOrder.syncError }}</p>
          <p v-if="!selectedExchangeOrder.localOrders?.length" class="muted">当前没有可确认的在途本地策略单绑定。币安实际持仓与挂单仍会正常展示。</p>
          <div v-for="local in selectedExchangeOrder.localOrders || []" :key="local.id" class="binding-row">
            本地策略单：{{ status(local.status) }}
            <button class="btn-small" @click="selectedExchangeOrder = null; viewOrderDetail({ id: local.id })">查看模拟单详情</button>
          </div>
        </div>
      </article>
    </div>

    <!-- 订单详情模态框 -->
    <div v-if="selectedOrder" class="modal-backdrop" @click.self="selectedOrder = null">
      <article class="modal modal-wide">
        <button class="modal-close" @click="selectedOrder = null">×</button>
        <span class="eyebrow">ORDER DETAIL</span>
        <h2>{{ selectedOrder.symbol }} - {{ selectedOrder.direction === 'OPEN_LONG' ? '做多' : '做空' }}</h2>

        <div class="order-detail-grid">
          <div class="detail-section">
            <h3>基本信息</h3>
            <dl>
              <dt>订单ID</dt>
              <dd>{{ selectedOrder.id }}</dd>
              <dt>状态</dt>
              <dd>{{ status(selectedOrder.status) }}</dd>
              <dt>保证金</dt>
              <dd>{{ fmt(selectedOrder.margin) }} USDT</dd>
              <dt>收益核算</dt>
              <dd>{{ selectedOrder.accountingIncomplete ? '部分历史平仓明细缺失，展示已取得成交的净额' : selectedOrder.allocationMethod === 'remaining_quantity' ? '交易所合并平仓及资金费按剩余数量分摊' : '订单成交记录' }}</dd>
              <dt>杠杆</dt>
              <dd>{{ selectedOrder.leverage }}x</dd>
              <dt>名义本金</dt>
              <dd>{{ fmt(selectedOrder.notional) }} USDT</dd>
            </dl>
          </div>

          <div class="detail-section" v-if="selectedOrder.entry">
            <h3>交易详情</h3>
            <dl>
              <dt>入场价</dt>
              <dd>{{ precise(selectedOrder.entry) }}</dd>
              <dt>数量</dt>
              <dd>{{ precise(selectedOrder.quantity) }}</dd>
              <dt>入场手续费</dt>
              <dd>{{ fmt(selectedOrder.entryFee) }} USDT</dd>
              <dt>持仓时间</dt>
              <dd>{{ selectedOrder.heldBars }} 根K线</dd>
            </dl>
          </div>

          <div class="detail-section" v-if="selectedOrder.status === 'closed'">
            <h3>平仓信息</h3>
            <dl>
              <dt>出场价</dt>
              <dd>{{ precise(selectedOrder.exit) }}</dd>
              <dt>平仓原因</dt>
              <dd>{{ reason(selectedOrder.reason) }}</dd>
              <dt>毛收益</dt>
              <dd :class="selectedOrder.gross > 0 ? 'profit' : 'loss'">{{ fmt(selectedOrder.gross) }} USDT</dd>
              <dt>总手续费</dt>
              <dd class="loss">{{ fmt(selectedOrder.fees) }} USDT</dd>
              <dt>资金费用</dt>
              <dd :class="selectedOrder.funding > 0 ? 'loss' : selectedOrder.funding < 0 ? 'profit' : ''">{{ fmt(selectedOrder.funding) }} USDT</dd>
              <dt>净收益</dt>
              <dd :class="selectedOrder.net > 0 ? 'profit' : 'loss'">{{ fmt(selectedOrder.net) }} USDT</dd>
              <dt>ROI</dt>
              <dd :class="selectedOrder.roi > 0 ? 'profit' : 'loss'">{{ pct(selectedOrder.roi) }}</dd>
            </dl>
          </div>

          <div class="detail-section">
            <h3>时间信息</h3>
            <dl>
              <dt>创建时间</dt>
              <dd>{{ new Date(selectedOrder.createdAt).toLocaleString() }}</dd>
              <dt v-if="selectedOrder.entryAt">入场时间</dt>
              <dd v-if="selectedOrder.entryAt">{{ new Date(selectedOrder.entryAt).toLocaleString() }}</dd>
              <dt v-if="selectedOrder.exitAt">平仓时间</dt>
              <dd v-if="selectedOrder.exitAt">{{ new Date(selectedOrder.exitAt).toLocaleString() }}</dd>
            </dl>
          </div>
        </div>

        <div class="detail-section exchange-binding">
          <h3>币安绑定订单</h3>
          <div v-for="env in ['demo', 'live']" :key="env" class="binding-row">
            <div class="binding-head">
              <b :class="env === 'demo' ? 'binding-demo' : 'binding-live'">{{ env === 'demo' ? 'Demo 测试盘' : '实盘' }}</b>
              <template v-if="bindingOf(selectedOrder, env).bound">
                <code>#{{ bindingOf(selectedOrder, env).link.orderId || bindingOf(selectedOrder, env).link.clientOrderId }}</code>
                <span class="binding-status" :data-status="bindingOf(selectedOrder, env).link.status">{{ syncStatusLabel(bindingOf(selectedOrder, env).link.status) }}</span>
                <button class="btn-small" :disabled="remoteLoading[env]" @click="loadRemoteOrder(selectedOrder, env, { force: true })">
                  {{ remoteActionLabel(env) }}
                </button>
              </template>
              <span v-else class="muted">{{ bindingOf(selectedOrder, env).link?.status ? '未绑定（' + syncStatusLabel(bindingOf(selectedOrder, env).link.status) + '）' : '未绑定' }}</span>
            </div>
            <small v-if="bindingOf(selectedOrder, env).bound && !remoteLoading[env]" class="binding-meta">
              {{ bindingOf(selectedOrder, env).link.lastSyncedAt ? '最近同步 ' + isoDateTime(bindingOf(selectedOrder, env).link.lastSyncedAt) : '尚未同步' }}<template v-if="bindingOf(selectedOrder, env).link.lastError"> · {{ bindingOf(selectedOrder, env).link.lastError }}</template>
            </small>
            <small v-else-if="remoteLoading[env]" class="binding-meta">正在向币安实时查询该订单详情…</small>
            <dl v-if="remoteDetail[env]" class="binding-detail">
              <dt>币安状态</dt><dd><span class="binding-status" :data-status="remoteDetail[env].status">{{ syncStatusLabel(String(remoteDetail[env].status).toLowerCase()) }}</span></dd>
              <dt>订单类型</dt><dd>{{ remoteDetail[env].type || '—' }} · {{ remoteDetail[env].side || '—' }}</dd>
              <dt>委托价</dt><dd>{{ remoteDetail[env].price ? precise(remoteDetail[env].price) : '—' }}</dd>
              <dt>成交均价</dt><dd>{{ remoteDetail[env].avgPrice ? precise(remoteDetail[env].avgPrice) : '—' }}</dd>
              <dt>委托 / 成交量</dt><dd>{{ precise(remoteDetail[env].origQty) }} / {{ precise(remoteDetail[env].executedQty) }}</dd>
              <dt>最近更新</dt><dd>{{ remoteDetail[env].updateTime ? new Date(remoteDetail[env].updateTime).toLocaleString() : '—' }}</dd>
            </dl>
          </div>
          <p v-if="remoteError" class="failed-text" role="alert">{{ remoteError }}</p>
          <p class="muted binding-note">绑定关系在下单时建立：系统提交挂单到对应环境后记录币安订单 ID；平仓、分批止盈与撤销按同步开关分别执行到 Demo / 实盘。</p>
        </div>

        <div v-if="selectedOrder.analysisContext" class="detail-section">
          <h3>分析上下文</h3>
          <dl>
            <dt>所属策略</dt>
            <dd>
              <template v-if="selectedOrder.analysisContext.strategyId">
                <code>{{ selectedOrder.analysisContext.strategyName || selectedOrder.analysisContext.strategyId }}</code>
                <span class="muted"> （{{ selectedOrder.analysisContext.strategyId }}）</span>
              </template>
              <span v-else class="muted">未标记（旧订单，按默认策略出场）</span>
            </dd>
            <dt>策略版本</dt>
            <dd><code>{{ selectedOrder.analysisContext.strategyVersion || '—' }}</code></dd>
            <dt>分析引擎</dt>
            <dd>{{ selectedOrder.analysisContext.analysisEngine || '—' }}</dd>
            <dt>置信度</dt>
            <dd>{{ selectedOrder.analysisContext.confidence || '—' }}</dd>
            <dt>开仓理由</dt>
            <dd>{{ selectedOrder.analysisContext.reason || '—' }}</dd>
            <dt>风险提示</dt>
            <dd>{{ selectedOrder.analysisContext.risk || '—' }}</dd>
          </dl>
          <details v-if="selectedOrder.analysisContext.strategyParams" class="strategy-params">
            <summary>该订单的策略参数快照</summary>
            <dl>
              <template v-for="(value, key) in selectedOrder.analysisContext.strategyParams" :key="key">
                <dt>{{ key }}</dt>
                <dd>{{ value }}</dd>
              </template>
            </dl>
          </details>
        </div>

      </article>
    </div>
  </section>
</template>

<style scoped>
.exchange-sync-overview { margin: 12px 0 20px; color: var(--text-secondary); font-size: 12px; }
.exchange-sync-overview p { margin: 6px 0; }
.exchange-sync-overview small { color: var(--text-tertiary); }
.local-order-note { display: block; color: var(--text-tertiary); font-size: 11px; }
.capital-form {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin: 12px 0;
  padding: 14px 16px;
  border: 1px solid var(--border-primary);
  border-radius: 10px;
  background: var(--bg-card);
}

.capital-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.capital-form input {
  width: 140px;
  padding: 7px 10px;
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  background: var(--bg-primary, transparent);
  color: var(--text-primary);
  font-size: 13px;
}

.capital-form small { color: var(--text-tertiary); }

.order-scope-switch {
  display: flex;
  gap: 8px;
  margin: 20px 0 -4px;
}

.order-scope-switch button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  border-radius: 999px;
  border: 1px solid var(--border-primary);
  background: var(--bg-card);
  color: var(--text-tertiary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.order-scope-switch button:hover {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
}

.order-scope-switch button.active {
  background: var(--bg-elevated);
  border-color: var(--long);
  color: var(--text-primary);
}

.order-scope-switch .scope-count {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-tertiary);
}

.order-scope-switch button.active .scope-count {
  color: var(--text-primary);
}

.filter-row {
  display: flex;
  gap: 16px;
  align-items: center;
  margin: 16px 0;
  padding: 16px;
  background: var(--bg-card);
  border-radius: 8px;
}

.filter-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.filter-row select {
  background: var(--bg-elevated);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  padding: 6px 12px;
  border-radius: 4px;
}

.filter-result {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 14px;
}

/* 平仓理由标签样式见 src/style.css（交易模拟 / 每日趋势共用） */
.badge-long {
  background: var(--long-bg);
  color: var(--long);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.badge-short {
  background: var(--short-bg);
  color: var(--short);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.btn-small {
  padding: 4px 8px;
  font-size: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  margin-right: 4px;
}

.btn-small:hover {
  background: var(--bg-elevated);
  border-color: var(--border-hover);
}

.btn-danger {
  background: var(--short-bg);
  border-color: var(--short);
  color: var(--short);
}

.btn-danger:hover {
  background: var(--short-bg);
  opacity: 0.8;
}

.modal-wide {
  max-width: 900px;
  max-height: 80vh;
  overflow-y: auto;
}

.order-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 24px;
  margin: 24px 0;
}

.detail-section {
  background: var(--bg-card);
  padding: 16px;
  border-radius: 8px;
}

.detail-section h3 {
  font-size: 14px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  margin-bottom: 12px;
}

.detail-section dl {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 8px;
  font-size: 14px;
}

.detail-section dt {
  color: var(--text-tertiary);
}

.detail-section dd {
  color: var(--text-primary);
  margin: 0;
}

.detail-section code {
  background: var(--bg-elevated);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 12px;
}

/* 币安绑定订单区块 */
.exchange-binding { grid-column: 1 / -1; }
.binding-row { padding: 10px 0; border-top: 1px solid var(--border-primary); }
.binding-row:first-of-type { border-top: 0; padding-top: 0; }
.binding-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.binding-head b { font-size: 13px; }
.binding-demo { color: var(--long); }
.binding-live { color: var(--short); }
.binding-status { padding: 2px 7px; border-radius: 999px; background: var(--bg-elevated); color: var(--text-secondary); font-size: 11px; }
.binding-status[data-status='filled'], .binding-status[data-status='new'] { color: var(--long); }
.binding-status[data-status='submit_error'], .binding-status[data-status='cancel_error'], .binding-status[data-status='rejected'] { color: var(--short); }
.binding-meta { display: block; margin-top: 6px; color: var(--text-tertiary); font-size: 11px; overflow-wrap: anywhere; }
.binding-detail { margin-top: 10px; display: grid; grid-template-columns: 110px 1fr; gap: 6px; font-size: 12px; }
.binding-detail dt { color: var(--text-tertiary); }
.binding-detail dd { margin: 0; color: var(--text-primary); }
.binding-note { margin: 12px 0 0; font-size: 11px; }
.failed-text { color: var(--short); font-size: 12px; }

.profit {
  color: var(--profit);
  font-weight: 600;
}

.loss {
  color: var(--loss);
  font-weight: 600;
}

</style>
