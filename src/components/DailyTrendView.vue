<script setup>
/**
 * DailyTrendView · 每日趋势
 *
 * 数据源：GET/POST /api/paper/daily-trend → byDay（按 exitAt UTC+8 日期分桶）
 *   —— 服务端用**单条 SQL** 一次聚合出日级 14 项 + 汇总 8 项指标（server/dailyTrend.js），
 *      不再把全部已平仓订单拉进 Node 内存跑多遍 O(N) 统计。
 * 闭环：老板在「交易模拟」+ 历史分析里看出"今天某币种大亏"时，可以跳到本页
 *      倒查到当日是哪些信号源（symbol / engine / strategy）拖低了全天净收益。
 *
 * 设计：
 *  - 顶部 summary-metrics 4 张：覆盖天数 / 总单数 / 累计净收益 / 平均胜率
 *  - 手画 SVG 趋势图：
 *      · 柱：当日净收益（红/绿按符号调色）
 *      · 线：累计净值（按日期顺序累加）
 *      · hover 圆点放大 + tooltip
 *      · 空数据时显示「尚未出现已平仓单」
 *  - 单数柱状图（副图，用同 SVG 不同 group）
 *  - 详细表格：按日期 desc，列：日期 / 单数 / 胜率 / 日净收益 / 累计 /
 *      毛利 / 手续费 / 资金费 / 多 / 空 / 止损 / 止盈
 *
 * 零依赖：纯 Vue 3 + SVG，不引入 chart 库（保持和项目风格一致）。
 */
import { ref, computed, onMounted, watch } from 'vue';
import { paperApi } from '../api/client.js';
import { closeReasonLabel, closeReasonGroup } from '../../shared/closeReasons.js';

const busy = ref(false);
const error = ref('');
const summary = ref(null);
const byDay = ref([]);
const byReason = ref([]);
const generatedAt = ref('');
const dataSource = ref('');

// 展示行：倒序 + 累计衍生
const rows = computed(() => {
  const src = byDay.value || [];
  // byDay 已按日期 desc 倒序返回；asc 用于图表连续展示
  const asc = [...src].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let cum = 0;
  for (const d of asc) {
    cum += Number(d.totalNet || 0);
    d._cumulative = cum;
  }
  // 倒序保留给表格（最新在顶）
  // 返回 asc 版本用于画图，desc 版本用于表格
  return { asc, desc: [...asc].reverse() };
});

const totalDays = computed(() => byDay.value.filter(d => d.date !== 'unknown').length);
const totalCount = computed(() => byDay.value.reduce((s, d) => s + (d.count || 0), 0));
const totalNetCum = computed(() => summary.value?.totalNetDailySum ?? 0);
const avgWinRate = computed(() => {
  const list = byDay.value.filter(d => d.count > 0);
  if (!list.length) return 0;
  return list.reduce((s, d) => s + (d.winRate || 0), 0) / list.length;
});

async function load(refresh = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const data = await paperApi.dailyTrend(refresh);
    summary.value = data.summary || null;
    byDay.value = data.byDay || [];
    byReason.value = data.byReason || [];
    dataSource.value = data.source || '';
    generatedAt.value = data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString('zh-CN') : '';
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}

// ────────────────────── SVG 趋势图 ──────────────────────

const CHART_WIDTH = 720;
const CHART_HEIGHT = 220;
const PADDING = { top: 16, right: 56, bottom: 28, left: 48 };

// 图表的边界（横轴 = asc 的日期）
const chartData = computed(() => {
  const asc = rows.value.asc || [];
  if (!asc.length) return null;
  const innerW = CHART_WIDTH - PADDING.left - PADDING.right;
  const innerH = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const nets = asc.map(d => Number(d.totalNet) || 0);
  const cumNets = asc.map(d => Number(d._cumulative) || 0);
  const counts = asc.map(d => Number(d.count) || 0);
  const maxAbsNet = Math.max(1, ...nets.map(Math.abs));
  const minCum = Math.min(0, ...cumNets);
  const maxCum = Math.max(0, ...cumNets);
  const maxCumAbs = Math.max(Math.abs(minCum), Math.abs(maxCum), 1);
  const maxCount = Math.max(1, ...counts);

  const xFor = (i) => asc.length === 1
    ? PADDING.left + innerW / 2
    : PADDING.left + (i * innerW) / (asc.length - 1);
  const yForNet = (v) => PADDING.top + innerH / 2 - (v / maxAbsNet) * (innerH / 2 - 4);
  const yForCum = (v) => PADDING.top + innerH / 2 + (v / maxCumAbs) * (innerH / 2 - 4);

  // 柱宽：自适应；数据少时用 16px 宽
  const barWidth = Math.max(4, Math.min(28, innerW / Math.max(1, asc.length) - 4));

  return {
    innerW, innerH, maxAbsNet, maxCumAbs, maxCount,
    points: asc.map((d, i) => ({
      d, i,
      x: xFor(i),
      yNet: yForNet(d.totalNet || 0),
      yCum: yForCum(d._cumulative || 0),
      yCount: PADDING.top + innerH * (1 - (d.count || 0) / maxCount),
      barWidth
    }))
  };
});

// hover 状态
const hoverIdx = ref(-1);

function onChartEnter(idx) { hoverIdx.value = idx; }
function onChartLeave() { hoverIdx.value = -1; }

// 轴刻度数值（简单的 zero-line + 顶部/底部）
const axisTicks = computed(() => {
  if (!chartData.value) return null;
  const cd = chartData.value;
  return {
    yMid: PADDING.top + cd.innerH / 2,
    yTop: PADDING.top,
    yBot: PADDING.top + cd.innerH,
    cumTop: PADDING.top,
    cumBot: PADDING.top + cd.innerH,
    maxNet: cd.maxAbsNet,
    maxCum: cd.maxCumAbs,
    maxCount: cd.maxCount
  };
});

// ─────────────────────────── helper ───────────────────────────

function fmt(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(2); }
function pct(v) { return v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%'; }
// 平仓理由标签与后端同一份字典（shared/closeReasons.js）
function reason(s) { return closeReasonLabel(s) || s || '—'; }

// 某理由占总平仓单数的比例
const reasonTotal = computed(() => byReason.value.reduce((s, r) => s + (r.count || 0), 0));
function reasonShare(r) { return reasonTotal.value ? (r.count || 0) / reasonTotal.value : 0; }

onMounted(() => load());
</script>

<template>
  <section class="history-panel daily-trend">
    <div class="view-heading">
      <div>
        <span class="eyebrow">DAILY TREND</span>
        <h2>每日趋势</h2>
        <p>按出场日期统计每天的单数、净收益、胜率、毛收益和手续费——点开某天即可看到当日全部订单。</p>
      </div>
      <div class="history-filter">
        <span v-if="dataSource === 'sql'" class="daily-trend-source" title="服务端单条 SQL 一次聚合出全部日级指标">
          SQL 聚合 · 单条查询{{ generatedAt ? ` · ${generatedAt}` : '' }}
        </span>
        <button class="ghost" :disabled="busy" @click="load(true)">{{ busy ? '加载中…' : '刷新' }}</button>
      </div>
    </div>

    <p v-if="error" class="signal-warning" role="alert">{{ error }}</p>

    <!-- summary metrics -->
    <div class="summary-metrics daily-trend-metrics">
      <article class="summary-metric">
        <span>覆盖交易日</span>
        <strong>{{ totalDays }}</strong>
        <small>从 {{ summary?.firstCloseDay || '—' }} 到 {{ summary?.lastCloseDay || '—' }}</small>
      </article>
      <article class="summary-metric">
        <span>总单数</span>
        <strong>{{ totalCount }}</strong>
        <small>closed={{ summary?.closedOrders ?? '—' }} · active={{ summary?.activeOrders ?? '—' }}</small>
      </article>
      <article class="summary-metric" :class="totalNetCum >= 0 ? 'long' : 'short'">
        <span>累计净收益</span>
        <strong :class="totalNetCum > 0 ? 'profit' : totalNetCum < 0 ? 'loss' : ''">{{ fmt(totalNetCum) }}</strong>
        <small>USDT 累计，按出场日累加</small>
      </article>
      <article class="summary-metric">
        <span>平均日胜率</span>
        <strong :class="avgWinRate >= 0.5 ? 'profit' : 'loss'">{{ pct(avgWinRate) }}</strong>
        <small>{{ totalDays }} 个交易日的算术平均</small>
      </article>
    </div>

    <!-- net & cumulative -->
    <h2 class="performance-subtitle">净收益趋势</h2>
    <div class="daily-trend-charts">
      <svg v-if="chartData" :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`" class="daily-trend-svg" preserveAspectRatio="none">
        <!-- zero baseline -->
        <line :x1="PADDING.left" :x2="CHART_WIDTH - PADDING.right" :y1="axisTicks.yMid" :y2="axisTicks.yMid"
          stroke="var(--chart-grid)" stroke-width="1" />

        <!-- 日净收益柱 -->
        <g class="daily-trend-bars">
          <rect v-for="pt in chartData.points" :key="`bar-${pt.i}`"
            :x="pt.x - pt.barWidth / 2"
            :y="pt.totalNet >= 0 ? pt.yNet : axisTicks.yMid"
            :width="pt.barWidth"
            :height="Math.abs(pt.yNet - axisTicks.yMid)"
            :fill="pt.totalNet >= 0 ? 'var(--profit)' : 'var(--loss)'"
            :opacity="hoverIdx === -1 || hoverIdx === pt.i ? 0.85 : 0.35"
            @mouseenter="onChartEnter(pt.i)" @mouseleave="onChartLeave" />
        </g>

        <!-- 累计净值折线 -->
        <g class="daily-trend-line">
          <polyline
            :points="chartData.points.map(pt => `${pt.x},${pt.yCum}`).join(' ')"
            fill="none" stroke="var(--brand-primary)" stroke-width="2"
            stroke-linejoin="round" />
          <circle v-for="pt in chartData.points" :key="`c-${pt.i}`"
            :cx="pt.x" :cy="pt.yCum" r="3"
            :fill="hoverIdx === pt.i ? 'var(--text-primary)' : 'var(--brand-primary)'"
            @mouseenter="onChartEnter(pt.i)" @mouseleave="onChartLeave" />
        </g>

        <!-- Y 轴左：日净收益 -->
        <text :x="PADDING.left - 6" :y="PADDING.top + 4" class="daily-trend-axis-text" text-anchor="end">
          +{{ fmt(axisTicks.maxNet) }}
        </text>
        <text :x="PADDING.left - 6" :y="axisTicks.yMid + 4" class="daily-trend-axis-text" text-anchor="end">
          0
        </text>
        <text :x="PADDING.left - 6" :y="CHART_HEIGHT - PADDING.bottom + 4" class="daily-trend-axis-text" text-anchor="end">
          −{{ fmt(axisTicks.maxNet) }}
        </text>

        <!-- Y 轴右：累计净值 -->
        <text :x="CHART_WIDTH - PADDING.right + 6" :y="PADDING.top + 4" class="daily-trend-axis-text" text-anchor="start">
          +{{ fmt(axisTicks.maxCum) }}
        </text>
        <text :x="CHART_WIDTH - PADDING.right + 6" :y="axisTicks.yMid + 4" class="daily-trend-axis-text" text-anchor="start">
          0
        </text>
        <text :x="CHART_WIDTH - PADDING.right + 6" :y="CHART_HEIGHT - PADDING.bottom + 4" class="daily-trend-axis-text" text-anchor="start">
          −{{ fmt(axisTicks.maxCum) }}
        </text>

        <!-- X 轴日期（最多显示 8 个，均布） -->
        <text v-for="(pt, i) in chartData.points" :key="`x-${pt.i}`"
          v-show="chartData.points.length <= 8 || i % Math.ceil(chartData.points.length / 8) === 0 || i === chartData.points.length - 1"
          :x="pt.x" :y="CHART_HEIGHT - PADDING.bottom + 16"
          class="daily-trend-axis-text" text-anchor="middle">
          {{ pt.d.date.slice(5) }}
        </text>
      </svg>
      <div v-else class="daily-trend-empty">暂无已平仓订单数据。</div>

      <!-- tooltip -->
      <div v-if="hoverIdx >= 0 && chartData" class="daily-trend-tooltip">
        <strong>{{ chartData.points[hoverIdx].d.date }}</strong>
        <p>单数：<b>{{ chartData.points[hoverIdx].d.count }}</b></p>
        <p>日净：<b :class="chartData.points[hoverIdx].d.totalNet > 0 ? 'profit' : chartData.points[hoverIdx].d.totalNet < 0 ? 'loss' : ''">{{ fmt(chartData.points[hoverIdx].d.totalNet) }}</b></p>
        <p>累计：<b>{{ fmt(chartData.points[hoverIdx].d._cumulative) }}</b></p>
        <p>胜率：<b>{{ pct(chartData.points[hoverIdx].d.winRate) }}</b></p>
      </div>
    </div>

    <!-- 单数子图 -->
    <h2 class="performance-subtitle">每日单数</h2>
    <div class="daily-trend-charts">
      <svg v-if="chartData" :viewBox="`0 0 ${CHART_WIDTH} 120`" class="daily-trend-svg" preserveAspectRatio="none">
        <g>
          <rect v-for="pt in chartData.points" :key="`cnt-${pt.i}`"
            :x="pt.x - pt.barWidth / 2"
            :y="pt.yCount - 24"
            :width="pt.barWidth"
            :height="axisTicks.yBot - pt.yCount + 24"
            fill="var(--info)"
            :opacity="hoverIdx === -1 || hoverIdx === pt.i ? 0.85 : 0.35"
            @mouseenter="onChartEnter(pt.i)" @mouseleave="onChartLeave" />
        </g>
        <text :x="PADDING.left - 6" :y="axisTicks.yBot + 4 - 24" class="daily-trend-axis-text" text-anchor="end">
          {{ Math.max(1, Math.ceil(axisTicks.maxCount / 5)) }}
        </text>
        <text :x="PADDING.left - 6" :y="axisTicks.yBot + 4" class="daily-trend-axis-text" text-anchor="end">0</text>
        <text v-for="(pt, i) in chartData.points" :key="`cnt-label-${pt.i}`"
          v-show="chartData.points.length <= 8 || i % Math.ceil(chartData.points.length / 8) === 0 || i === chartData.points.length - 1"
          :x="pt.x" :y="114" class="daily-trend-axis-text" text-anchor="middle">
          {{ pt.d.date.slice(5) }}
        </text>
      </svg>
    </div>

    <!-- 详细表格 -->
    <h2 class="performance-subtitle">明细</h2>
    <div class="performance-table">
      <table>
        <thead>
          <tr>
            <th>日期</th>
            <th>单数</th>
            <th>胜率</th>
            <th>日净收益</th>
            <th>累计</th>
            <th>毛收益</th>
            <th>手续费</th>
            <th>资金费</th>
            <th>多 / 空</th>
            <th>止损 / 止盈</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in rows.desc" :key="d.date">
            <td>{{ d.date }}</td>
            <td>{{ d.count }}</td>
            <td :class="d.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(d.winRate) }}</td>
            <td :class="d.totalNet > 0 ? 'profit' : d.totalNet < 0 ? 'loss' : ''">{{ fmt(d.totalNet) }}</td>
            <td :class="d._cumulative > 0 ? 'profit' : d._cumulative < 0 ? 'loss' : ''">{{ fmt(d._cumulative) }}</td>
            <td>{{ fmt(d.totalGross) }}</td>
            <td>−{{ fmt(d.totalFees) }}</td>
            <td>{{ fmt(d.totalFunding) }}</td>
            <td>{{ d.longCount }} / {{ d.shortCount }}</td>
            <td>{{ d.stoppedCount }} / {{ d.takeProfitCount }}</td>
          </tr>
          <tr v-if="rows.desc.length === 0">
            <td colspan="10" class="muted">暂无数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 平仓理由统计（同一条 SQL 顺带聚合，不额外请求） -->
    <h2 class="performance-subtitle">平仓理由统计</h2>
    <p class="muted" style="margin: -6px 0 10px;">
      每种平仓理由各占多少单、胜率和净盈亏——判断「策略是被止损磨死的，还是根本走不到止盈」。
    </p>
    <div class="performance-table">
      <table>
        <thead>
          <tr>
            <th>平仓理由</th>
            <th>单数</th>
            <th>占比</th>
            <th>胜率</th>
            <th>平均收益</th>
            <th>平均盈利</th>
            <th>净盈亏</th>
            <th>手续费</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in byReason" :key="r.reason">
            <td>
              <span class="close-reason" :data-group="closeReasonGroup(r.reason)">{{ reason(r.reason) }}</span>
            </td>
            <td>{{ r.count }}</td>
            <td>{{ pct(reasonShare(r)) }}</td>
            <td :class="r.winRate >= 0.5 ? 'profit' : 'loss'">{{ pct(r.winRate) }}</td>
            <td :class="r.avgNet > 0 ? 'profit' : r.avgNet < 0 ? 'loss' : ''">{{ fmt(r.avgNet) }}</td>
            <td>{{ fmt(r.avgWin) }}</td>
            <td :class="r.totalNet > 0 ? 'profit' : r.totalNet < 0 ? 'loss' : ''">{{ fmt(r.totalNet) }}</td>
            <td>−{{ fmt(r.totalFees) }}</td>
          </tr>
          <tr v-if="byReason.length === 0">
            <td colspan="8" class="muted">暂无数据</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
