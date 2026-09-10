<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const data = ref(null);
const busy = ref(false);
const error = ref('');
const date = ref('');
const symbol = ref('');
const grouping = ref('byStrategy');
const page = ref(1);
const appliedFilter = ref('全部日期 / 全部币种');

// 新增筛选选项
const statusFilter = ref('all'); // all, closed, pending
const directionFilter = ref('all'); // all, long, short
const resultFilter = ref('all'); // all, win, loss
const sortBy = ref('at'); // at, net, symbol
const sortOrder = ref('desc'); // asc, desc

// 计算属性
const filteredItems = computed(() => {
  if (!data.value?.items) return [];

  let items = [...data.value.items];

  // 状态筛选
  if (statusFilter.value === 'closed') {
    items = items.filter(i => i.evaluation.status === 'closed');
  } else if (statusFilter.value === 'pending') {
    items = items.filter(i => ['pending', 'open'].includes(i.evaluation.status));
  }

  // 方向筛选
  if (directionFilter.value === 'long') {
    items = items.filter(i => i.direction === 'OPEN_LONG');
  } else if (directionFilter.value === 'short') {
    items = items.filter(i => i.direction === 'OPEN_SHORT');
  }

  // 结果筛选
  if (resultFilter.value === 'win') {
    items = items.filter(i => i.evaluation.net > 0);
  } else if (resultFilter.value === 'loss') {
    items = items.filter(i => i.evaluation.net < 0);
  }

  // 排序
  items.sort((a, b) => {
    let aVal, bVal;

    if (sortBy.value === 'at') {
      aVal = new Date(a.at).getTime();
      bVal = new Date(b.at).getTime();
    } else if (sortBy.value === 'net') {
      aVal = a.evaluation.net || 0;
      bVal = b.evaluation.net || 0;
    } else if (sortBy.value === 'symbol') {
      aVal = a.symbol;
      bVal = b.symbol;
    }

    return sortOrder.value === 'desc' ? bVal - aVal || String(bVal).localeCompare(String(aVal)) : aVal - bVal || String(aVal).localeCompare(String(bVal));
  });

  return items;
});

const visible = computed(() => filteredItems.value.slice((page.value - 1) * 30, page.value * 30));
const pages = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / 30)));
const groups = computed(() => data.value?.[grouping.value] || []);

// 计算高级统计指标
const advancedStats = computed(() => {
  if (!data.value?.items) return null;

  const closedItems = data.value.items.filter(i => i.evaluation.status === 'closed');
  if (closedItems.length === 0) return null;

  const nets = closedItems.map(i => i.evaluation.net).sort((a, b) => a - b);
  const wins = closedItems.filter(i => i.evaluation.net > 0);
  const losses = closedItems.filter(i => i.evaluation.net < 0);

  // 连续统计
  let currentStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let currentStreakType = null;

  for (const item of closedItems) {
    const isWin = item.evaluation.net > 0;

    if (currentStreakType === null) {
      currentStreakType = isWin ? 'win' : 'loss';
      currentStreak = 1;
    } else if ((currentStreakType === 'win' && isWin) || (currentStreakType === 'loss' && !isWin)) {
      currentStreak++;
    } else {
      if (currentStreakType === 'win') {
        maxWinStreak = Math.max(maxWinStreak, currentStreak);
      } else {
        maxLossStreak = Math.max(maxLossStreak, currentStreak);
      }
      currentStreakType = isWin ? 'win' : 'loss';
      currentStreak = 1;
    }
  }

  if (currentStreakType === 'win') {
    maxWinStreak = Math.max(maxWinStreak, currentStreak);
  } else if (currentStreakType === 'loss') {
    maxLossStreak = Math.max(maxLossStreak, currentStreak);
  }

  return {
    median: nets[Math.floor(nets.length / 2)],
    percentile25: nets[Math.floor(nets.length * 0.25)],
    percentile75: nets[Math.floor(nets.length * 0.75)],
    maxWin: Math.max(...nets),
    maxLoss: Math.min(...nets),
    stdDev: Math.sqrt(nets.reduce((sum, n) => sum + Math.pow(n - data.value.summary.averageNet, 2), 0) / nets.length),
    sharpeRatio: data.value.summary.averageNet / Math.sqrt(nets.reduce((sum, n) => sum + Math.pow(n - data.value.summary.averageNet, 2), 0) / nets.length),
    maxWinStreak,
    maxLossStreak,
    avgWinSize: wins.length > 0 ? wins.reduce((sum, i) => sum + i.evaluation.net, 0) / wins.length : 0,
    avgLossSize: losses.length > 0 ? Math.abs(losses.reduce((sum, i) => sum + i.evaluation.net, 0) / losses.length) : 0,
    expectancy: data.value.summary.averageNet
  };
});

// 按时间段统计
const timeSeriesData = computed(() => {
  if (!data.value?.items) return [];

  const closedItems = data.value.items.filter(i => i.evaluation.status === 'closed');
  const grouped = {};

  for (const item of closedItems) {
    const date = new Date(item.at).toISOString().split('T')[0];
    if (!grouped[date]) {
      grouped[date] = { date, count: 0, wins: 0, totalNet: 0 };
    }
    grouped[date].count++;
    if (item.evaluation.net > 0) grouped[date].wins++;
    grouped[date].totalNet += item.evaluation.net;
  }

  return Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
});

// 按退出原因统计
const exitReasonStats = computed(() => {
  if (!data.value?.items) return [];

  const closedItems = data.value.items.filter(i => i.evaluation.status === 'closed');
  const grouped = {};

  for (const item of closedItems) {
    const reason = item.evaluation.reason || 'unknown';
    if (!grouped[reason]) {
      grouped[reason] = { reason, count: 0, wins: 0, totalNet: 0, avgNet: 0 };
    }
    grouped[reason].count++;
    if (item.evaluation.net > 0) grouped[reason].wins++;
    grouped[reason].totalNet += item.evaluation.net;
  }

  return Object.values(grouped).map(g => ({
    ...g,
    winRate: g.count > 0 ? g.wins / g.count : 0,
    avgNet: g.count > 0 ? g.totalNet / g.count : 0
  })).sort((a, b) => b.count - a.count);
});

function fmt(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2); }
function pct(v) { return v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%'; }
function status(s) { return ({ closed: '已平仓', open: '模拟持仓', pending: '等待入场', expired: '未成交（历史记录）', data_gap: '行情缺失', excluded: '未参与' })[s] || s; }
function reason(s) { return ({ stop_loss: '止损', take_profit: '止盈', timeout: '持有到期', liquidation: '爆仓' })[s] || s; }

async function load(refresh = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const query = new URLSearchParams({ date: date.value, symbol: symbol.value.trim().toUpperCase() });
  try {
    data.value = await api('/research/performance' + (refresh ? '/refresh' : '') + '?' + query, refresh ? { method: 'POST' } : {});
    page.value = 1;
    appliedFilter.value = (date.value || '全部日期') + ' / ' + (symbol.value.trim().toUpperCase() || '全部币种');
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

onMounted(() => load());
</script>

<template>
  <section class="history-panel performance-view">
    <div class="view-heading">
      <div>
        <span class="eyebrow">FORWARD PAPER TRADING</span>
        <h2>策略表现</h2>
        <p>追踪信号生成后的行情，比较规则是否有效。</p>
      </div>
    </div>

    <div class="history-filter">
      <label>
        生成日期（UTC，可留空）
        <input v-model="date" type="date" :disabled="busy" />
      </label>
      <label>
        币种
        <input v-model="symbol" placeholder="例如 BTCUSDT" :disabled="busy" />
      </label>
      <button class="ghost" :disabled="busy" @click="load()">查询已有数据</button>
      <button class="primary" :disabled="busy" @click="load(true)">
        {{ busy ? '处理中…' : '同步模拟行情并评估' }}
      </button>
    </div>

    <p class="muted performance-method">
      每条信号独立使用 1,000 USDT 名义本金，不复利、不加杠杆，不代表账户收益。下一根K线起，开盘价在区间内才入场；
      同根触及止盈和止损按止损。默认场景：每边手续费6基点、滑点5基点，资金费按每8小时3基点计提成本（非实际账单）。
      规则和成本随信号冻结。
    </p>

    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>
    <p v-if="busy" class="inline-loading" role="status">正在处理，请稍候…</p>

    <template v-if="data">
      <p class="muted">
        {{ appliedFilter }} · {{ data.records }} 条分析记录 ·
        {{ data.excluded }} 条观望/无效/旧信号不计入 ·
        评估于 {{ new Date(data.asOf).toLocaleString() }}
      </p>

      <p v-if="data.truncated" class="signal-warning">
        匹配超过500条记录，本页仅评估最新500条；请按日期或币种缩小范围。
      </p>

      <!-- 核心指标 -->
      <div class="summary-metrics performance-metrics">
        <article class="summary-metric">
          <span>已平仓样本</span>
          <strong>{{ data.summary.closed }}</strong>
          <small>等待/持仓 {{ data.summary.pending }}</small>
        </article>
        <article class="summary-metric">
          <span>估算净胜率</span>
          <strong :class="data.summary.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(data.summary.winRate) }}</strong>
          <small>盈利 {{ data.summary.wins }} · 亏损 {{ data.summary.losses }}</small>
        </article>
        <article class="summary-metric">
          <span>平均估算净收益</span>
          <strong :class="data.summary.averageNet > 0 ? 'profit' : data.summary.averageNet < 0 ? 'loss' : ''">
            {{ fmt(data.summary.averageNet) }}
          </strong>
          <small>USDT / 已平仓信号</small>
        </article>
        <article class="summary-metric">
          <span>盈亏总额比</span>
          <strong :class="data.summary.profitFactor > 1 ? 'profit' : data.summary.profitFactor < 1 ? 'loss' : ''">
            {{ fmt(data.summary.profitFactor) }}
          </strong>
          <small>无亏损样本时不计算</small>
        </article>
      </div>

      <!-- 高级统计指标 -->
      <template v-if="advancedStats">
        <h2 class="performance-subtitle">高级统计</h2>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-label">最大盈利</div>
            <div class="stat-value profit">{{ fmt(advancedStats.maxWin) }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">最大亏损</div>
            <div class="stat-value loss">{{ fmt(advancedStats.maxLoss) }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">中位数收益</div>
            <div class="stat-value">{{ fmt(advancedStats.median) }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">标准差</div>
            <div class="stat-value">{{ fmt(advancedStats.stdDev) }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">夏普比率</div>
            <div class="stat-value">{{ fmt(advancedStats.sharpeRatio) }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">期望值</div>
            <div class="stat-value" :class="advancedStats.expectancy > 0 ? 'profit' : 'loss'">
              {{ fmt(advancedStats.expectancy) }}
            </div>
          </div>
          <div class="stat-box">
            <div class="stat-label">最长连胜</div>
            <div class="stat-value">{{ advancedStats.maxWinStreak }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">最长连亏</div>
            <div class="stat-value">{{ advancedStats.maxLossStreak }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">平均盈利规模</div>
            <div class="stat-value profit">{{ fmt(advancedStats.avgWinSize) }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">平均亏损规模</div>
            <div class="stat-value loss">{{ fmt(advancedStats.avgLossSize) }}</div>
          </div>
        </div>
      </template>

      <p v-if="!data.summary.closed" class="empty">
        还没有可评估的已平仓样本。生成有效交易计划后，等待后续K线收盘，再同步模拟行情。
      </p>

      <p v-if="data.summary.dataGaps" class="signal-warning">
        {{ data.summary.dataGaps }} 条信号存在行情缺口，已排除收益统计。
        请同步行情；缺失数据不会按零收益或盈利处理。
      </p>

      <details v-if="data.errors?.length">
        <summary>行情同步问题（{{ data.errors.length }}）</summary>
        <p v-for="(err, index) in data.errors" :key="index" class="signal-warning">{{ err }}</p>
      </details>

      <!-- 按退出原因统计 -->
      <template v-if="exitReasonStats.length > 0">
        <h2 class="performance-subtitle">退出原因分析</h2>
        <div class="performance-table">
          <table>
            <thead>
              <tr>
                <th>退出原因</th>
                <th>数量</th>
                <th>胜率</th>
                <th>平均收益</th>
                <th>总收益</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="stat in exitReasonStats" :key="stat.reason">
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
      </template>

      <!-- 时间序列趋势 -->
      <template v-if="timeSeriesData.length > 0">
        <h2 class="performance-subtitle">每日表现趋势</h2>
        <div class="performance-table">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>信号数</th>
                <th>胜率</th>
                <th>日收益</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="day in timeSeriesData.slice(-10)" :key="day.date">
                <td>{{ day.date }}</td>
                <td>{{ day.count }}</td>
                <td>{{ pct(day.count > 0 ? day.wins / day.count : 0) }}</td>
                <td :class="day.totalNet > 0 ? 'profit' : day.totalNet < 0 ? 'loss' : ''">
                  {{ fmt(day.totalNet) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- 分组比较 -->
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
              <td :class="group.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(group.winRate) }}</td>
              <td :class="group.averageNet > 0 ? 'profit' : group.averageNet < 0 ? 'loss' : ''">
                {{ fmt(group.averageNet) }}
              </td>
              <td class="profit">{{ fmt(group.averageWin) }}</td>
              <td class="loss">{{ fmt(group.averageLoss) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="muted">样本仅用于前向观察，重叠信号并非独立实验；小样本不能证明策略盈利能力。</p>

      <!-- 信号明细筛选 -->
      <h2 class="performance-subtitle">信号明细</h2>
      <div class="filter-bar">
        <label>
          状态
          <select v-model="statusFilter">
            <option value="all">全部</option>
            <option value="closed">已平仓</option>
            <option value="pending">活跃</option>
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
          结果
          <select v-model="resultFilter">
            <option value="all">全部</option>
            <option value="win">盈利</option>
            <option value="loss">亏损</option>
          </select>
        </label>

        <label>
          排序
          <select v-model="sortBy">
            <option value="at">时间</option>
            <option value="net">收益</option>
            <option value="symbol">币种</option>
          </select>
        </label>

        <label>
          顺序
          <select v-model="sortOrder">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </label>

        <span class="filter-count">{{ filteredItems.length }} 条信号</span>
      </div>

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
              <td><strong>{{ item.symbol }}</strong> / {{ item.interval }}</td>
              <td>{{ new Date(item.at).toLocaleString() }}</td>
              <td>
                <span :class="item.direction === 'OPEN_LONG' ? 'badge-long' : 'badge-short'">
                  {{ item.direction === 'OPEN_LONG' ? '多' : '空' }}
                </span>
              </td>
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
  </section>
</template>

<style scoped>
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin: 16px 0 24px;
}

.stat-box {
  background: var(--bg-card);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  padding: 12px;
  text-align: center;
}

.stat-label {
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  margin-bottom: 6px;
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.filter-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  background: var(--bg-card);
  border-radius: 6px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.filter-bar label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
  text-transform: uppercase;
}

.filter-bar select {
  background: var(--bg-elevated);
  border: 1px solid var(--border-primary);
  color: var(--text-primary);
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
}

.filter-count {
  margin-left: auto;
  color: var(--text-tertiary);
  font-size: 13px;
}

.badge-long {
  background: var(--long-bg);
  color: var(--long);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.badge-short {
  background: var(--short-bg);
  color: var(--short);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.profit {
  color: var(--success);
}

.loss {
  color: var(--danger);
}

.performance-subtitle {
  margin: 32px 0 16px;
  font-size: 18px;
  font-weight: 600;
}
</style>
