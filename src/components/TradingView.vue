<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { fmt, pct, statusLabel as status, reasonLabel as reason, reasonGroup } from '../utils/format.js';

// 数据状态
const accountData = ref(null);
const busy = ref(false);
const error = ref('');

// 模拟交易相关
const orderInput = ref({ recordId: '', symbol: '', margin: 100, leverage: 2 });
const showOrderForm = ref(false);
const selectedOrder = ref(null);
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
  const scopeStatus = orderScope.value === 'closed' ? ['closed'] : ['pending', 'open'];
  let orders = accountData.value.orders.filter(o => scopeStatus.includes(o.status));

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
    active: orders.filter(o => ['pending', 'open'].includes(o.status)).length,
    closed: orders.filter(o => o.status === 'closed').length
  };
});

// 订单统计
const orderStats = computed(() => {
  if (!accountData.value?.orders) return null;

  const orders = accountData.value.orders;
  const closed = orders.filter(o => o.status === 'closed');
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

// 加载模拟账户数据
async function loadAccount() {
  busy.value = true;
  error.value = '';
  try {
    accountData.value = await api('/paper/account?view=summary');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// 刷新模拟账户
async function refreshAccount() {
  busy.value = true;
  error.value = '';
  try {
    accountData.value = await api('/paper/refresh', { method: 'POST' });
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

// 取消订单
async function cancelOrder(orderId) {
  if (!confirm('确定取消此订单？')) return;

  busy.value = true;
  error.value = '';
  try {
    await api(`/paper/orders/${orderId}`, { method: 'DELETE' });
    await loadAccount();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// 查看订单详情
async function viewOrderDetail(order) {
  selectedOrder.value = order;
  try {
    const detail = await api(`/paper/orders/${encodeURIComponent(order.id)}`);
    if (selectedOrder.value?.id === order.id) selectedOrder.value = detail;
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

// 初始化
onMounted(() => {
  loadAccount();
});
</script>

<template>
  <section class="history-panel trading-unified-view">
    <div class="view-heading">
      <div>
        <span class="eyebrow">UNIFIED TRADING SIMULATION</span>
        <h2>交易模拟</h2>
        <p>模拟账户与订单管理</p>
      </div>
    </div>

    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <p v-if="busy" class="inline-loading" role="status">正在处理，请稍候…</p>

    <!-- 模拟账户视图 -->
    <template v-if="accountData">
      <!-- 账户概览 -->
      <div class="summary-metrics performance-metrics">
        <article class="summary-metric">
          <span>已实现收益</span>
          <strong :class="accountData.realized > 0 ? 'profit' : accountData.realized < 0 ? 'loss' : ''">
            {{ fmt(accountData.realized) }}
          </strong>
          <small>未实现 <span :class="accountData.unrealized > 0 ? 'profit' : accountData.unrealized < 0 ? 'loss' : ''">{{ fmt(accountData.unrealized) }}</span></small>
        </article>
        <article class="summary-metric">
          <span>持仓数量</span>
          <strong>{{ accountData.openCount }}</strong>
          <small>已用保证金 {{ fmt(accountData.usedMargin) }}</small>
        </article>
        <article class="summary-metric">
          <span>可用余额</span>
          <strong>{{ fmt(accountData.available) }}</strong>
          <small>净收益 <span :class="accountData.net > 0 ? 'profit' : accountData.net < 0 ? 'loss' : ''">{{ fmt(accountData.net) }}</span></small>
        </article>
        <article v-if="orderStats" class="summary-metric">
          <span>胜率</span>
          <strong :class="orderStats.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(orderStats.winRate) }}</strong>
          <small>{{ orderStats.wins }}胜 / {{ orderStats.losses }}负</small>
        </article>
      </div>

      <div class="action-row">
        <button class="primary" :disabled="busy" @click="refreshAccount">刷新行情与订单状态</button>
        <button class="ghost" :disabled="busy" @click="showOrderForm = !showOrderForm">
          {{ showOrderForm ? '取消下单' : '新建模拟订单' }}
        </button>
      </div>

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
            <option value="open">模拟持仓</option>
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
              <th>方向</th>
              <th>状态</th>
              <th>杠杆</th>
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
              <td>
                <span :class="order.direction === 'OPEN_LONG' ? 'badge-long' : 'badge-short'">
                  {{ order.direction === 'OPEN_LONG' ? '多' : '空' }}
                </span>
              </td>
              <td>{{ status(order.status) }}</td>
              <td>{{ order.leverage }}x</td>
              <td>{{ order.entry ? fmt(order.entry) : '—' }}</td>
              <td>{{ order.markPrice ? fmt(order.markPrice) : '—' }}</td>
              <td :class="order.unrealized > 0 ? 'profit' : order.unrealized < 0 ? 'loss' : ''">
                {{ order.unrealized ? fmt(order.unrealized) : '—' }}
              </td>
              <td :class="order.net > 0 ? 'profit' : order.net < 0 ? 'loss' : ''">
                {{ order.net ? fmt(order.net) : '—' }}
              </td>
              <td :class="order.roi > 0 ? 'profit' : order.roi < 0 ? 'loss' : ''">
                {{ order.roi ? pct(order.roi) : '—' }}
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
                  @click="cancelOrder(order.id)"
                >
                  取消
                </button>
              </td>
            </tr>
            <tr v-if="!paginatedOrders.length">
              <td colspan="11" class="empty">
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
              <dd>{{ fmt(selectedOrder.entry) }}</dd>
              <dt>数量</dt>
              <dd>{{ fmt(selectedOrder.quantity) }}</dd>
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
              <dd>{{ fmt(selectedOrder.exit) }}</dd>
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

.profit {
  color: var(--profit);
  font-weight: 600;
}

.loss {
  color: var(--loss);
  font-weight: 600;
}

</style>
