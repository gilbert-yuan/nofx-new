<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { router } from '../router.js';

// 数据状态
const activeTab = ref('account'); // 'account' | 'performance' | 'statistics' | 'replay'
const accountData = ref(null);
const performanceData = ref(null);
const statisticsData = ref(null);
const replayData = ref(null);
const batchReplayData = ref(null);
const busy = ref(false);
const error = ref('');

// 模拟交易相关
const orderInput = ref({ recordId: '', symbol: '', margin: 100, leverage: 2 });
const showOrderForm = ref(false);
const selectedOrder = ref(null);
const orderPage = ref(1);
const orderPageSize = ref(20);

// 策略表现相关
const date = ref('');
const symbol = ref('');
const grouping = ref('byStrategy');
const page = ref(1);
const appliedFilter = ref('全部日期 / 全部币种');

// 筛选器
const statusFilter = ref('all'); // all, active, closed
const directionFilter = ref('all'); // all, long, short
const sortBy = ref('createdAt'); // createdAt, net, roi
const sortOrder = ref('desc'); // asc, desc

// 计算属性
const visible = computed(() => performanceData.value?.items.slice((page.value - 1) * 30, page.value * 30) || []);
const pages = computed(() => Math.max(1, Math.ceil((performanceData.value?.items.length || 0) / 30)));
const groups = computed(() => performanceData.value?.[grouping.value] || []);

// 筛选和排序后的订单
const filteredOrders = computed(() => {
  if (!accountData.value?.orders) return [];

  let orders = accountData.value.orders;

  // 状态筛选
  if (statusFilter.value === 'active') {
    orders = orders.filter(o => ['pending', 'open'].includes(o.status));
  } else if (statusFilter.value === 'closed') {
    orders = orders.filter(o => o.status === 'closed');
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

// 订单统计
const orderStats = computed(() => {
  if (!accountData.value?.orders) return null;

  const orders = accountData.value.orders;
  const closed = orders.filter(o => o.status === 'closed');
  const wins = closed.filter(o => o.net > 0);
  const losses = closed.filter(o => o.net < 0);

  const longOrders = closed.filter(o => o.direction === 'OPEN_LONG');
  const shortOrders = closed.filter(o => o.direction === 'OPEN_SHORT');

  const longWins = longOrders.filter(o => o.net > 0).length;
  const shortWins = shortOrders.filter(o => o.net > 0).length;

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
    profitFactor: losses.reduce((sum, o) => sum + Math.abs(o.net), 0) > 0
      ? wins.reduce((sum, o) => sum + o.net, 0) / losses.reduce((sum, o) => sum + Math.abs(o.net), 0)
      : null,
    longWinRate: longOrders.length > 0 ? longWins / longOrders.length : 0,
    shortWinRate: shortOrders.length > 0 ? shortWins / shortOrders.length : 0,
    avgHoldingBars: closed.length > 0 ? closed.reduce((sum, o) => sum + (o.heldBars || 0), 0) / closed.length : 0,
    maxWin: closed.length > 0 ? Math.max(...closed.map(o => o.net)) : 0,
    maxLoss: closed.length > 0 ? Math.min(...closed.map(o => o.net)) : 0
  };
});

// 按原因分组统计
const reasonStats = computed(() => {
  if (!accountData.value?.orders) return [];

  const closed = accountData.value.orders.filter(o => o.status === 'closed');
  const groups = {};

  for (const order of closed) {
    const r = order.reason || 'unknown';
    if (!groups[r]) {
      groups[r] = { reason: r, count: 0, wins: 0, totalNet: 0 };
    }
    groups[r].count++;
    if (order.net > 0) groups[r].wins++;
    groups[r].totalNet += order.net;
  }

  return Object.values(groups).map(g => ({
    ...g,
    winRate: g.count > 0 ? g.wins / g.count : 0,
    avgNet: g.count > 0 ? g.totalNet / g.count : 0
  })).sort((a, b) => b.count - a.count);
});

// 格式化函数
function fmt(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2); }
function pct(v) { return v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%'; }
function status(s) { return ({ closed: '已平仓', open: '模拟持仓', pending: '等待入场', expired: '到期未入场', cancelled: '已取消', data_gap: '行情缺失', excluded: '未参与' })[s] || s; }
function reason(s) { return ({ stop_loss: '止损', take_profit: '止盈', timeout: '持有到期', liquidation: '爆仓' })[s] || ''; }

// 加载模拟账户数据
async function loadAccount() {
  if (activeTab.value !== 'account') return;
  busy.value = true;
  error.value = '';
  try {
    accountData.value = await api('/paper/account');
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
function viewOrderDetail(order) {
  selectedOrder.value = order;
}

// 加载策略表现数据
async function loadPerformance(refresh = false) {
  if (activeTab.value !== 'performance') return;
  busy.value = true;
  error.value = '';
  const query = new URLSearchParams({ date: date.value, symbol: symbol.value.trim().toUpperCase() });
  try {
    performanceData.value = await api('/research/performance' + (refresh ? '/refresh' : '') + '?' + query, refresh ? { method: 'POST' } : {});
    page.value = 1;
    appliedFilter.value = (date.value || '全部日期') + ' / ' + (symbol.value.trim().toUpperCase() || '全部币种');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// 加载统计数据
async function loadStatistics() {
  if (activeTab.value !== 'statistics') return;
  busy.value = true;
  error.value = '';
  try {
    // 使用新的数据库视图
    statisticsData.value = await api('/paper/statistics');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// 加载单个订单复盘分析
async function loadOrderReplay(orderId) {
  busy.value = true;
  error.value = '';
  try {
    replayData.value = await api(`/paper/orders/${orderId}/replay`);
  } catch (err) {
    error.value = err.message;
    replayData.value = null;
  } finally {
    busy.value = false;
  }
}

// 加载批量订单复盘分析
async function loadBatchReplay(filters = {}) {
  busy.value = true;
  error.value = '';
  try {
    batchReplayData.value = await api('/paper/orders/replay-batch', {
      method: 'POST',
      body: { filters }
    });
  } catch (err) {
    error.value = err.message;
    batchReplayData.value = null;
  } finally {
    busy.value = false;
  }
}

// 查看订单复盘
async function viewOrderReplay(order) {
  if (order.status !== 'closed') {
    error.value = '仅支持已平仓订单复盘分析';
    return;
  }

  selectedOrder.value = order;
  await loadOrderReplay(order.id);
}

// 查看详细复盘结果
function viewDetailedReplay(result) {
  replayData.value = result;
  selectedOrder.value = result.order;
}

// 分页控制
function goToOrderPage(page) {
  if (page >= 1 && page <= totalOrderPages.value) {
    orderPage.value = page;
  }
}

// 重置筛选时重置页码
watch([statusFilter, directionFilter, sortBy, sortOrder], () => {
  orderPage.value = 1;
});

// 切换标签页
function switchTab(tab) {
  activeTab.value = tab;
  error.value = '';
  router.updateParams({ tab });

  if (tab === 'account') {
    loadAccount();
  } else if (tab === 'performance') {
    loadPerformance();
  } else if (tab === 'statistics') {
    loadStatistics();
  } else if (tab === 'replay') {
    // 复盘分析标签，默认加载最近的亏损订单
    loadBatchReplay({ result: 'loss', limit: 20 });
  }
}

// 从 URL 恢复状态
onMounted(() => {
  const routeState = router.getState();
  if (routeState.params.tab) {
    activeTab.value = routeState.params.tab;
  }

  if (activeTab.value === 'account') {
    loadAccount();
  } else if (activeTab.value === 'performance') {
    loadPerformance();
  } else if (activeTab.value === 'statistics') {
    loadStatistics();
  }
});
</script>

<template>
  <section class="history-panel trading-unified-view">
    <div class="view-heading">
      <div>
        <span class="eyebrow">UNIFIED TRADING SIMULATION</span>
        <h2>交易模拟</h2>
        <p>模拟账户管理与策略表现评估</p>
      </div>
    </div>

    <!-- 标签切换 -->
    <div class="tab-switcher">
      <button
        :class="{ active: activeTab === 'account' }"
        @click="switchTab('account')"
      >
        模拟账户
      </button>
      <button
        :class="{ active: activeTab === 'performance' }"
        @click="switchTab('performance')"
      >
        策略表现
      </button>
      <button
        :class="{ active: activeTab === 'statistics' }"
        @click="switchTab('statistics')"
      >
        统计分析
      </button>
      <button
        :class="{ active: activeTab === 'replay' }"
        @click="switchTab('replay')"
      >
        订单复盘
      </button>
    </div>

    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <p v-if="busy" class="inline-loading" role="status">正在处理，请稍候…</p>

    <!-- 模拟账户视图 -->
    <template v-if="activeTab === 'account' && accountData">
      <!-- 账户概览 -->
      <div class="summary-metrics performance-metrics">
        <article class="summary-metric">
          <span>账户权益</span>
          <strong>{{ fmt(accountData.equity) }}</strong>
          <small>余额 {{ fmt(accountData.balance) }} USDT</small>
        </article>
        <article class="summary-metric">
          <span>已实现收益</span>
          <strong :class="accountData.realized > 0 ? 'profit' : accountData.realized < 0 ? 'loss' : ''">
            {{ fmt(accountData.realized) }}
          </strong>
          <small>未实现 {{ fmt(accountData.unrealized) }}</small>
        </article>
        <article class="summary-metric">
          <span>持仓数量</span>
          <strong>{{ accountData.openCount }}</strong>
          <small>已用保证金 {{ fmt(accountData.usedMargin) }}</small>
        </article>
        <article class="summary-metric">
          <span>可用余额</span>
          <strong>{{ fmt(accountData.available) }}</strong>
          <small>净收益 {{ fmt(accountData.net) }}</small>
        </article>
      </div>

      <!-- 订单统计卡片 -->
      <div v-if="orderStats" class="stats-cards">
        <div class="stat-card">
          <div class="stat-label">胜率</div>
          <div class="stat-value" :class="orderStats.winRate >= 0.5 ? 'profit' : 'loss'">
            {{ pct(orderStats.winRate) }}
          </div>
          <div class="stat-detail">{{ orderStats.wins }}胜 / {{ orderStats.losses }}负</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">盈亏比</div>
          <div class="stat-value">{{ orderStats.profitFactor ? fmt(orderStats.profitFactor) : '—' }}</div>
          <div class="stat-detail">平均盈利 {{ fmt(orderStats.avgWin) }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">做多胜率</div>
          <div class="stat-value">{{ pct(orderStats.longWinRate) }}</div>
          <div class="stat-detail">做空 {{ pct(orderStats.shortWinRate) }}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">平均持仓</div>
          <div class="stat-value">{{ orderStats.avgHoldingBars.toFixed(1) }}</div>
          <div class="stat-detail">K线根数</div>
        </div>
      </div>

      <div class="action-row">
        <button class="primary" :disabled="busy" @click="refreshAccount">刷新行情与订单状态</button>
        <button class="ghost" :disabled="busy" @click="showOrderForm = !showOrderForm">
          {{ showOrderForm ? '取消下单' : '新建模拟订单' }}
        </button>
      </div>

      <!-- 筛选和排序 -->
      <div class="filter-row">
        <label>
          状态
          <select v-model="statusFilter">
            <option value="all">全部</option>
            <option value="active">活跃</option>
            <option value="closed">已平仓</option>
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
      <h2 class="performance-subtitle">订单列表（第 {{ orderPage }} / {{ totalOrderPages }} 页）</h2>
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
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
          </select>
          条
        </label>
      </div>

      <!-- 平仓原因统计 -->
      <h2 class="performance-subtitle">平仓原因分析</h2>
      <div v-if="reasonStats.length > 0" class="performance-table">
        <table>
          <thead>
            <tr>
              <th>原因</th>
              <th>数量</th>
              <th>胜率</th>
              <th>平均收益</th>
              <th>总收益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="stat in reasonStats" :key="stat.reason">
              <td>{{ reason(stat.reason) }}</td>
              <td>{{ stat.count }}</td>
              <td>{{ pct(stat.winRate) }}</td>
              <td :class="stat.avgNet > 0 ? 'profit' : stat.avgNet < 0 ? 'loss' : ''">
                {{ fmt(stat.avgNet) }}
              </td>
              <td :class="stat.totalNet > 0 ? 'profit' : stat.totalNet < 0 ? 'loss' : ''">
                {{ fmt(stat.totalNet) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty">暂无已平仓订单</p>
    </template>

    <!-- 策略表现视图 -->
    <template v-if="activeTab === 'performance'">
      <div class="history-filter">
        <label>
          生成日期（UTC，可留空）
          <input v-model="date" type="date" :disabled="busy" />
        </label>
        <label>
          币种
          <input v-model="symbol" placeholder="例如 BTCUSDT" :disabled="busy" />
        </label>
        <button class="ghost" :disabled="busy" @click="loadPerformance()">查询已有数据</button>
        <button class="primary" :disabled="busy" @click="loadPerformance(true)">
          {{ busy ? '处理中…' : '同步模拟行情并评估' }}
        </button>
      </div>

      <p class="muted performance-method">
        每条信号独立使用 1,000 USDT 名义本金，不复利、不加杠杆，不代表账户收益。下一根K线起，开盘价在区间内才入场；
        同根触及止盈和止损按止损。默认场景：每边手续费6基点、滑点5基点，资金费按每8小时3基点计提成本（非实际账单）。
        规则和成本随信号冻结。
      </p>

      <template v-if="performanceData">
        <p class="muted">
          {{ appliedFilter }} · {{ performanceData.records }} 条分析记录 ·
          {{ performanceData.excluded }} 条观望/无效/旧信号不计入 ·
          评估于 {{ new Date(performanceData.asOf).toLocaleString() }}
        </p>

        <p v-if="performanceData.truncated" class="signal-warning">
          匹配超过500条记录，本页仅评估最新500条；请按日期或币种缩小范围。
        </p>

        <div class="summary-metrics performance-metrics">
          <article class="summary-metric">
            <span>已平仓样本</span>
            <strong>{{ performanceData.summary.closed }}</strong>
            <small>等待/持仓 {{ performanceData.summary.pending }} · 到期未入场 {{ performanceData.summary.expired }}</small>
          </article>
          <article class="summary-metric">
            <span>估算净胜率</span>
            <strong>{{ pct(performanceData.summary.winRate) }}</strong>
            <small>盈利 {{ performanceData.summary.wins }} · 亏损 {{ performanceData.summary.losses }}</small>
          </article>
          <article class="summary-metric">
            <span>平均估算净收益</span>
            <strong>{{ fmt(performanceData.summary.averageNet) }}</strong>
            <small>USDT / 已平仓信号</small>
          </article>
          <article class="summary-metric">
            <span>盈亏总额比</span>
            <strong>{{ fmt(performanceData.summary.profitFactor) }}</strong>
            <small>无亏损样本时不计算</small>
          </article>
        </div>

        <p v-if="!performanceData.summary.closed" class="empty">
          还没有可评估的已平仓样本。生成有效交易计划后，等待后续K线收盘，再同步模拟行情。
        </p>

        <p v-if="performanceData.summary.dataGaps" class="signal-warning">
          {{ performanceData.summary.dataGaps }} 条信号存在行情缺口，已排除收益统计。
          请同步行情；缺失数据不会按零收益或盈利处理。
        </p>

        <details v-if="performanceData.errors?.length">
          <summary>行情同步问题（{{ performanceData.errors.length }}）</summary>
          <p v-for="(err, index) in performanceData.errors" :key="index" class="signal-warning">{{ err }}</p>
        </details>

        <div class="section-head">
          <h2>分组比较</h2>
          <label>
            分组
            <select v-model="grouping">
              <option value="byStrategy">策略版本</option>
              <option value="bySymbol">币种</option>
              <option value="byDirection">方向</option>
            </select>
          </label>
        </div>

        <div class="performance-table">
          <table>
            <thead>
              <tr>
                <th>分组</th>
                <th>已平仓</th>
                <th>净胜率</th>
                <th>平均净收益</th>
                <th>平均盈利</th>
                <th>平均亏损</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="group in groups" :key="group.key">
                <td>{{ group.key }}</td>
                <td>{{ group.closed }}</td>
                <td>{{ pct(group.winRate) }}</td>
                <td>{{ fmt(group.averageNet) }}</td>
                <td>{{ fmt(group.averageWin) }}</td>
                <td>{{ fmt(group.averageLoss) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="muted">样本仅用于前向观察，重叠信号并非独立实验；小样本不能证明策略盈利能力。</p>

        <h2 class="performance-subtitle">信号明细</h2>
        <div class="performance-table">
          <table>
            <thead>
              <tr>
                <th>币种 / 周期</th>
                <th>生成时间</th>
                <th>方向</th>
                <th>状态</th>
                <th>估算净收益</th>
                <th>退出原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in visible" :key="item.id">
                <td>{{ item.symbol }} / {{ item.interval }}</td>
                <td>{{ new Date(item.at).toLocaleString() }}</td>
                <td>{{ item.direction === 'OPEN_LONG' ? '多' : '空' }}</td>
                <td>{{ status(item.evaluation.status) }}</td>
                <td :class="item.evaluation.net > 0 ? 'profit' : item.evaluation.net < 0 ? 'loss' : ''">
                  {{ fmt(item.evaluation.net) }}
                </td>
                <td>
                  {{ reason(item.evaluation.reason) }}
                  {{ item.evaluation.ambiguousBar ? '（同根双触及）' : '' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="action-row">
          <button class="ghost" :disabled="page <= 1" @click="page--">上一页</button>
          <span>{{ page }} / {{ pages }}</span>
          <button class="ghost" :disabled="page >= pages" @click="page++">下一页</button>
        </div>
      </template>
    </template>

    <!-- 统计分析视图 -->
    <template v-if="activeTab === 'statistics'">
      <h2>统计分析</h2>
      <p class="muted">基于已平仓订单的多维度统计分析</p>

      <template v-if="statisticsData">
        <!-- 概览 -->
        <div class="summary-metrics performance-metrics">
          <article class="summary-metric">
            <span>总订单数</span>
            <strong>{{ statisticsData.summary.totalOrders }}</strong>
            <small>已平仓 {{ statisticsData.summary.closedOrders }}</small>
          </article>
          <article class="summary-metric">
            <span>活跃订单</span>
            <strong>{{ statisticsData.summary.activeOrders }}</strong>
            <small>挂单/持仓中</small>
          </article>
        </div>

        <!-- 按币种统计 -->
        <h2 class="performance-subtitle">按币种统计（Top 10）</h2>
        <div class="performance-table">
          <table>
            <thead>
              <tr>
                <th>币种</th>
                <th>数量</th>
                <th>胜率</th>
                <th>平均收益</th>
                <th>总收益</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="stat in statisticsData.bySymbol.slice(0, 10)" :key="stat.symbol">
                <td><strong>{{ stat.symbol }}</strong></td>
                <td>{{ stat.count }}</td>
                <td :class="stat.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(stat.winRate) }}</td>
                <td :class="stat.avgNet > 0 ? 'profit' : stat.avgNet < 0 ? 'loss' : ''">
                  {{ fmt(stat.avgNet) }}
                </td>
                <td :class="stat.totalNet > 0 ? 'profit' : stat.totalNet < 0 ? 'loss' : ''">
                  {{ fmt(stat.totalNet) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 按分析引擎统计 -->
        <h2 class="performance-subtitle">按分析引擎统计</h2>
        <div class="stats-grid">
          <div v-for="stat in statisticsData.byEngine" :key="stat.engine" class="stat-box">
            <div class="stat-label">{{ stat.engine === 'local' ? '本地规则' : stat.engine === 'local-mtf' ? '多周期规则' : stat.engine === 'ai' ? 'AI模型' : stat.engine }}</div>
            <div class="stat-value">{{ stat.count }} 单</div>
            <div class="stat-detail">
              胜率 {{ pct(stat.winRate) }} · 平均 {{ fmt(stat.avgNet) }}
            </div>
          </div>
        </div>

        <!-- 按策略版本统计 -->
        <template v-if="statisticsData.byStrategy.length > 0">
          <h2 class="performance-subtitle">按策略版本统计（Top 5）</h2>
          <div class="performance-table">
            <table>
              <thead>
                <tr>
                  <th>策略版本</th>
                  <th>数量</th>
                  <th>胜率</th>
                  <th>平均收益</th>
                  <th>总收益</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="stat in statisticsData.byStrategy.slice(0, 5)" :key="stat.version">
                  <td><code>{{ stat.version.substring(0, 8) }}</code></td>
                  <td>{{ stat.count }}</td>
                  <td :class="stat.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(stat.winRate) }}</td>
                  <td :class="stat.avgNet > 0 ? 'profit' : stat.avgNet < 0 ? 'loss' : ''">
                    {{ fmt(stat.avgNet) }}
                  </td>
                  <td :class="stat.totalNet > 0 ? 'profit' : stat.totalNet < 0 ? 'loss' : ''">
                    {{ fmt(stat.totalNet) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- 按UTC小时统计 -->
        <template v-if="statisticsData.byHour.length > 0">
          <h2 class="performance-subtitle">按UTC小时统计</h2>
          <div class="performance-table">
            <table>
              <thead>
                <tr>
                  <th>UTC时段</th>
                  <th>数量</th>
                  <th>胜率</th>
                  <th>平均收益</th>
                  <th>总收益</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="stat in statisticsData.byHour" :key="stat.hour">
                  <td>{{ stat.hour }}:00 - {{ stat.hour }}:59</td>
                  <td>{{ stat.count }}</td>
                  <td :class="stat.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(stat.winRate) }}</td>
                  <td :class="stat.avgNet > 0 ? 'profit' : stat.avgNet < 0 ? 'loss' : ''">
                    {{ fmt(stat.avgNet) }}
                  </td>
                  <td :class="stat.totalNet > 0 ? 'profit' : stat.totalNet < 0 ? 'loss' : ''">
                    {{ fmt(stat.totalNet) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- 按持仓时长统计 -->
        <template v-if="statisticsData.byHoldingBars.length > 0">
          <h2 class="performance-subtitle">按持仓时长统计（K线数）</h2>
          <div class="performance-table">
            <table>
              <thead>
                <tr>
                  <th>持仓区间</th>
                  <th>数量</th>
                  <th>胜率</th>
                  <th>平均收益</th>
                  <th>总收益</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="stat in statisticsData.byHoldingBars" :key="stat.bars">
                  <td>{{ stat.bars }} - {{ stat.bars + 4 }} 根</td>
                  <td>{{ stat.count }}</td>
                  <td :class="stat.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(stat.winRate) }}</td>
                  <td :class="stat.avgNet > 0 ? 'profit' : stat.avgNet < 0 ? 'loss' : ''">
                    {{ fmt(stat.avgNet) }}
                  </td>
                  <td :class="stat.totalNet > 0 ? 'profit' : stat.totalNet < 0 ? 'loss' : ''">
                    {{ fmt(stat.totalNet) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </template>

      <p v-else-if="busy" class="inline-loading">加载统计数据中...</p>
      <p v-else class="empty">暂无统计数据</p>
    </template>

    <!-- 订单复盘分析视图 -->
    <template v-if="activeTab === 'replay'">
      <h2>订单复盘分析</h2>
      <p class="muted">基于K线数据深度分析订单表现，诊断策略问题</p>

      <template v-if="batchReplayData && !batchReplayData.error">
        <!-- 批量分析摘要 -->
        <div class="summary-metrics performance-metrics" v-if="batchReplayData.summary">
          <article class="summary-metric">
            <span>分析订单数</span>
            <strong>{{ batchReplayData.summary.totalAnalyzed }}</strong>
            <small>已平仓订单</small>
          </article>
          <article class="summary-metric">
            <span>平均评分</span>
            <strong>{{ fmt(batchReplayData.summary.averageScore) }}</strong>
            <small>满分 100</small>
          </article>
        </div>

        <!-- 问题频率统计 -->
        <h3 class="performance-subtitle">问题诊断统计</h3>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-label">方向问题</div>
            <div class="stat-value">{{ batchReplayData.summary.issueFrequency.direction }} 单</div>
            <div class="stat-detail">趋势判断失误</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">止损问题</div>
            <div class="stat-value">{{ batchReplayData.summary.issueFrequency.stopLoss }} 单</div>
            <div class="stat-detail">止损设置不当</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">止盈问题</div>
            <div class="stat-value">{{ batchReplayData.summary.issueFrequency.takeProfit }} 单</div>
            <div class="stat-detail">止盈目标不合理</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">入场问题</div>
            <div class="stat-value">{{ batchReplayData.summary.issueFrequency.entry }} 单</div>
            <div class="stat-detail">入场时机欠佳</div>
          </div>
        </div>

        <!-- 首要优化建议 -->
        <div class="alert-info" v-if="batchReplayData.summary.topRecommendation">
          <strong>优化建议：</strong>{{ batchReplayData.summary.topRecommendation }}
        </div>

        <!-- 订单复盘列表 -->
        <h3 class="performance-subtitle">订单详细复盘</h3>
        <div class="performance-table">
          <table>
            <thead>
              <tr>
                <th>币种</th>
                <th>方向</th>
                <th>净收益</th>
                <th>评分</th>
                <th>主要问题</th>
                <th>诊断摘要</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="result in batchReplayData.results.filter(r => !r.error)" :key="result.order.id">
                <td><strong>{{ result.order.symbol }}</strong></td>
                <td>{{ result.order.direction === 'OPEN_LONG' ? '做多' : '做空' }}</td>
                <td :class="result.order.net > 0 ? 'profit' : 'loss'">
                  {{ fmt(result.order.net) }}
                </td>
                <td>
                  <span :class="result.diagnosis.score >= 70 ? 'profit' : result.diagnosis.score >= 50 ? '' : 'loss'">
                    {{ result.diagnosis.score }}
                  </span>
                </td>
                <td>
                  <span class="issue-badge" v-if="result.diagnosis.primaryIssue === 'direction'">方向</span>
                  <span class="issue-badge" v-else-if="result.diagnosis.primaryIssue === 'stopLoss_too_tight'">止损过紧</span>
                  <span class="issue-badge" v-else-if="result.diagnosis.primaryIssue === 'takeProfit_too_far'">止盈过远</span>
                  <span class="issue-badge" v-else-if="result.diagnosis.primaryIssue === 'timing'">入场时机</span>
                  <span v-else>{{ result.diagnosis.primaryIssue }}</span>
                </td>
                <td class="text-left">{{ result.diagnosis.summary }}</td>
                <td>
                  <button class="btn-small" @click="viewDetailedReplay(result)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <p v-else-if="batchReplayData?.error" class="signal-warning">{{ batchReplayData.error }}</p>
      <p v-else-if="busy" class="inline-loading">分析订单中...</p>
      <p v-else class="empty">暂无复盘数据</p>
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
              <dd>{{ fmt(selectedOrder.fees) }} USDT</dd>
              <dt>资金费用</dt>
              <dd>{{ fmt(selectedOrder.funding) }} USDT</dd>
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
              <dt>过期时间</dt>
              <dd>{{ new Date(selectedOrder.expiresAt).toLocaleString() }}</dd>
            </dl>
          </div>
        </div>

        <div v-if="selectedOrder.analysisContext" class="detail-section">
          <h3>分析上下文</h3>
          <dl>
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
        </div>

        <!-- 复盘分析数据 -->
        <template v-if="replayData && !replayData.error">
          <h3 style="margin-top: 24px;">复盘分析</h3>

          <!-- 综合诊断 -->
          <div class="replay-diagnosis">
            <div class="diagnosis-header">
              <div class="diagnosis-score" :class="replayData.diagnosis.score >= 70 ? 'score-good' : replayData.diagnosis.score >= 50 ? 'score-medium' : 'score-poor'">
                <span class="score-label">综合评分</span>
                <span class="score-value">{{ replayData.diagnosis.score }}</span>
              </div>
              <div class="diagnosis-summary">
                <p><strong>{{ replayData.diagnosis.summary }}</strong></p>
                <p v-if="replayData.diagnosis.strengths.length > 0" class="strengths">
                  ✓ {{ replayData.diagnosis.strengths.join(' · ') }}
                </p>
              </div>
            </div>

            <!-- 发现的问题 -->
            <div v-if="replayData.diagnosis.issues.length > 0" class="issues-list">
              <h4>发现的问题</h4>
              <div v-for="(issue, idx) in replayData.diagnosis.issues" :key="idx"
                   class="issue-item"
                   :class="'severity-' + issue.severity">
                <div class="issue-header">
                  <span class="issue-type">{{ issue.type }}</span>
                  <span class="issue-severity">{{ issue.severity === 'high' ? '严重' : issue.severity === 'medium' ? '中等' : '轻微' }}</span>
                </div>
                <p class="issue-description">{{ issue.description }}</p>
                <p class="issue-detail">{{ issue.detail }}</p>
              </div>
            </div>

            <!-- 优化建议 -->
            <div v-if="replayData.diagnosis.recommendations.length > 0" class="recommendations">
              <h4>优化建议</h4>
              <ul>
                <li v-for="(rec, idx) in replayData.diagnosis.recommendations" :key="idx">{{ rec }}</li>
              </ul>
            </div>
          </div>

          <!-- 详细分析维度 -->
          <div class="analysis-dimensions">
            <!-- 方向分析 -->
            <div class="dimension-card">
              <h4>方向分析</h4>
              <div class="dimension-content">
                <div class="dimension-row">
                  <span>方向判断</span>
                  <strong :class="replayData.analysis.direction.correct ? 'profit' : 'loss'">
                    {{ replayData.analysis.direction.correct ? '✓ 正确' : '✗ 有误' }}
                  </strong>
                </div>
                <div class="dimension-row">
                  <span>有利价差</span>
                  <strong class="profit">{{ fmt(replayData.analysis.direction.favorableMove) }}%</strong>
                </div>
                <div class="dimension-row">
                  <span>不利价差</span>
                  <strong class="loss">{{ fmt(replayData.analysis.direction.adverseMove) }}%</strong>
                </div>
                <div class="dimension-row">
                  <span>最终价差</span>
                  <strong :class="replayData.analysis.direction.finalMove > 0 ? 'profit' : 'loss'">
                    {{ fmt(replayData.analysis.direction.finalMove) }}%
                  </strong>
                </div>
                <p class="dimension-summary">{{ replayData.analysis.direction.summary }}</p>
              </div>
            </div>

            <!-- 止损分析 -->
            <div class="dimension-card">
              <h4>止损分析</h4>
              <div class="dimension-content">
                <div class="dimension-row">
                  <span>止损点位</span>
                  <strong>{{ fmt(replayData.analysis.stopLoss.stopLoss) }}</strong>
                </div>
                <div class="dimension-row">
                  <span>距离</span>
                  <strong>{{ fmt(replayData.analysis.stopLoss.distance) }}%</strong>
                </div>
                <div class="dimension-row">
                  <span>ATR比率</span>
                  <strong>{{ fmt(replayData.analysis.stopLoss.atrRatio) }}x</strong>
                </div>
                <div class="dimension-row">
                  <span>是否触及</span>
                  <strong :class="replayData.analysis.stopLoss.touched ? 'loss' : 'profit'">
                    {{ replayData.analysis.stopLoss.touched ? '已触及' : '未触及' }}
                  </strong>
                </div>
                <div class="dimension-row">
                  <span>评估</span>
                  <strong :class="replayData.analysis.stopLoss.optimal ? 'profit' : ''">
                    {{ replayData.analysis.stopLoss.optimal ? '✓ 合理' : '⚠ 需优化' }}
                  </strong>
                </div>
                <p class="dimension-summary">{{ replayData.analysis.stopLoss.assessment }}</p>
              </div>
            </div>

            <!-- 止盈分析 -->
            <div class="dimension-card">
              <h4>止盈分析</h4>
              <div class="dimension-content">
                <div class="dimension-row">
                  <span>止盈点位</span>
                  <strong>{{ fmt(replayData.analysis.takeProfit.takeProfit) }}</strong>
                </div>
                <div class="dimension-row">
                  <span>距离</span>
                  <strong>{{ fmt(replayData.analysis.takeProfit.distance) }}%</strong>
                </div>
                <div class="dimension-row">
                  <span>最大有利价差</span>
                  <strong class="profit">{{ fmt(replayData.analysis.takeProfit.maxFavorable) }}%</strong>
                </div>
                <div class="dimension-row">
                  <span>是否触及</span>
                  <strong :class="replayData.analysis.takeProfit.touched ? 'profit' : ''">
                    {{ replayData.analysis.takeProfit.touched ? '已触及' : '未触及' }}
                  </strong>
                </div>
                <div class="dimension-row">
                  <span>评估</span>
                  <strong :class="replayData.analysis.takeProfit.optimal ? 'profit' : ''">
                    {{ replayData.analysis.takeProfit.optimal ? '✓ 合理' : '⚠ 需优化' }}
                  </strong>
                </div>
                <p class="dimension-summary">{{ replayData.analysis.takeProfit.assessment }}</p>
              </div>
            </div>

            <!-- 入场分析 -->
            <div class="dimension-card">
              <h4>入场分析</h4>
              <div class="dimension-content">
                <div class="dimension-row">
                  <span>入场价格</span>
                  <strong>{{ fmt(replayData.analysis.entry.entryPrice) }}</strong>
                </div>
                <div class="dimension-row">
                  <span>K线位置</span>
                  <strong>{{ fmt(replayData.analysis.entry.entryPosition) }}%</strong>
                </div>
                <div class="dimension-row">
                  <span>在计划区间</span>
                  <strong :class="replayData.analysis.entry.inPlanRange ? 'profit' : 'loss'">
                    {{ replayData.analysis.entry.inPlanRange ? '✓ 是' : '✗ 否' }}
                  </strong>
                </div>
                <div class="dimension-row">
                  <span>评估</span>
                  <strong :class="replayData.analysis.entry.optimal ? 'profit' : ''">
                    {{ replayData.analysis.entry.optimal ? '✓ 良好' : '⚠ 可改进' }}
                  </strong>
                </div>
                <p class="dimension-summary">{{ replayData.analysis.entry.timing }}</p>
              </div>
            </div>
          </div>
        </template>

        <button v-if="selectedOrder.status === 'closed' && !replayData"
                class="btn-primary"
                @click="loadOrderReplay(selectedOrder.id)"
                style="margin-top: 16px;">
          加载复盘分析
        </button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.tab-switcher {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
  border-bottom: 1px solid #2a2a2a;
  padding-bottom: 0;
}

.tab-switcher button {
  padding: 12px 24px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: #888;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.tab-switcher button:hover {
  color: #fff;
}

.tab-switcher button.active {
  color: #fff;
  border-bottom-color: #15966a;
}

.stats-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin: 24px 0;
}

.stat-card {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
}

.stat-label {
  color: #888;
  font-size: 12px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.stat-value {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 4px;
}

.stat-detail {
  color: #888;
  font-size: 12px;
}

.filter-row {
  display: flex;
  gap: 16px;
  align-items: center;
  margin: 16px 0;
  padding: 16px;
  background: #1a1a1a;
  border-radius: 8px;
}

.filter-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #888;
}

.filter-row select {
  background: #0f0f0f;
  border: 1px solid #2a2a2a;
  color: #fff;
  padding: 6px 12px;
  border-radius: 4px;
}

.filter-result {
  margin-left: auto;
  color: #888;
  font-size: 14px;
}

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
  background: #1a1a1a;
  padding: 16px;
  border-radius: 8px;
}

.detail-section h3 {
  font-size: 14px;
  color: #888;
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
  color: #888;
}

.detail-section dd {
  color: #fff;
  margin: 0;
}

.detail-section code {
  background: #0f0f0f;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 12px;
}

.profit {
  color: var(--long);
  font-weight: 600;
}

.loss {
  color: var(--short);
  font-weight: 600;
}

/* 复盘分析样式 */
.issue-badge {
  background: var(--short-bg);
  color: var(--short);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.alert-info {
  background: var(--long-bg);
  border-left: 3px solid var(--long);
  padding: 12px 16px;
  margin: 16px 0;
  border-radius: 4px;
  color: var(--text-primary);
}

.replay-diagnosis {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: 20px;
  margin: 16px 0;
}

.diagnosis-header {
  display: flex;
  gap: 24px;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-primary);
}

.diagnosis-score {
  text-align: center;
  padding: 16px 24px;
  border-radius: 8px;
  min-width: 120px;
}

.diagnosis-score.score-good {
  background: var(--long-bg);
  border: 2px solid var(--long);
}

.diagnosis-score.score-medium {
  background: var(--warning)20;
  border: 2px solid var(--warning);
}

.diagnosis-score.score-poor {
  background: var(--short-bg);
  border: 2px solid var(--short);
}

.score-label {
  display: block;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 8px;
}

.score-value {
  display: block;
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
}

.diagnosis-summary {
  flex: 1;
}

.diagnosis-summary p {
  margin: 8px 0;
}

.diagnosis-summary .strengths {
  color: #15966a;
  font-size: 14px;
}

.issues-list {
  margin: 20px 0;
}

.issues-list h4 {
  font-size: 14px;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.issue-item {
  background: #0f0f0f;
  border-left: 3px solid #2a2a2a;
  padding: 12px 16px;
  margin-bottom: 12px;
  border-radius: 4px;
}

.issue-item.severity-high {
  border-left-color: #d15b4b;
}

.issue-item.severity-medium {
  border-left-color: #ffc107;
}

.issue-item.severity-low {
  border-left-color: #888;
}

.issue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.issue-type {
  font-weight: 600;
  color: #fff;
  text-transform: capitalize;
}

.issue-severity {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #2a2a2a;
}

.issue-description {
  color: #fff;
  margin: 4px 0;
  font-size: 14px;
}

.issue-detail {
  color: #888;
  margin: 4px 0;
  font-size: 13px;
}

.recommendations {
  margin: 20px 0;
}

.recommendations h4 {
  font-size: 14px;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 12px;
}

.recommendations ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.recommendations li {
  padding: 8px 12px;
  margin-bottom: 8px;
  background: var(--long-bg);
  border-left: 3px solid var(--long);
  border-radius: 4px;
  color: var(--text-primary);
}

.analysis-dimensions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 20px;
}

.dimension-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: 16px;
}

.dimension-card h4 {
  font-size: 14px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-primary);
}

.dimension-content {
  font-size: 13px;
}

.dimension-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid #1a1a1a;
}

.dimension-row span {
  color: #888;
}

.dimension-row strong {
  color: #fff;
}

.dimension-summary {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #2a2a2a;
  color: #888;
  font-size: 13px;
  line-height: 1.5;
}

.text-left {
  text-align: left;
}
</style>
