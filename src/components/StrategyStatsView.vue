<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { statsApi } from '../api/client.js';

const selectedStrategy = ref('all');
const granularity = ref('day');
const data = ref(null);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await statsApi.get(granularity.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(granularity, load);

const strategyOptions = computed(() => {
  if (!data.value) return [{ id: 'all', name: '全部策略' }];
  return [{ id: 'all', name: '全部策略' }, ...data.value.byStrategy.map(s => ({ id: s.id, name: s.name }))];
});

// 当前展示的汇总（全部 or 单策略）
const display = computed(() => {
  if (!data.value) return null;
  if (selectedStrategy.value === 'all') return { id: 'all', name: '全部策略', ...data.value.overview };
  return data.value.byStrategy.find(s => s.id === selectedStrategy.value) || null;
});

// 时间轴行（按选中策略过滤）
const rows = computed(() => {
  if (!data.value) return [];
  return data.value.timeline.buckets.map(b => {
    const cell = selectedStrategy.value === 'all'
      ? b
      : (b.byStrategy[selectedStrategy.value] || { orders: 0, closed: 0, profit: 0, net: 0 });
    return { bucket: b.bucket, orders: cell.orders, closed: cell.closed, profit: cell.profit, net: cell.net };
  });
});

const maxOrders = computed(() => Math.max(1, ...rows.value.map(r => r.orders)));

const isHour = computed(() => granularity.value === 'hour');
const bucketLabel = (b) => (isHour.value ? String(b).padStart(2, '0') + ':00' : String(b));

const fmtPct = (p) => (p > 0 ? (p * 100).toFixed(1) + '%' : '—');
const fmtNet = (n) => (n >= 0 ? '+' : '') + Number(n).toFixed(2);
const barHeight = (v) => Math.max(4, (v / maxOrders.value) * 100);
</script>

<template>
  <div class="stats-view">
    <div class="stats-head">
      <div>
        <h2>策略订单统计</h2>
        <p class="sub">数据源 <code>simulated_orders</code>（真实） · 关联 <code>research_records.strategyId</code> · 盈利 = net&gt;0 · 胜率 = 盈利/平仓 · 时间按 +08</p>
      </div>
      <div class="controls">
        <label>策略
          <select v-model="selectedStrategy" :disabled="!data">
            <option v-for="o in strategyOptions" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
        </label>
        <div class="seg">
          <button :class="{ active: granularity === 'day' }" @click="granularity = 'day'">按天</button>
          <button :class="{ active: granularity === 'hour' }" @click="granularity = 'hour'">按小时</button>
        </div>
        <button class="refresh" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
      </div>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div v-if="data" class="body">
      <!-- 总览卡 -->
      <div class="cards">
        <div class="card"><div class="k">订单数</div><div class="v">{{ display.orders }}</div></div>
        <div class="card"><div class="k">平仓数</div><div class="v">{{ display.closed }}</div></div>
        <div class="card"><div class="k">盈利数</div><div class="v up">{{ display.profit }}</div></div>
        <div class="card"><div class="k">胜率</div><div class="v">{{ fmtPct(display.winRate) }}</div></div>
        <div class="card">
          <div class="k">累计净盈亏</div>
          <div class="v" :class="display.net > 0 ? 'up' : display.net < 0 ? 'down' : ''">{{ fmtNet(display.net) }}U</div>
        </div>
      </div>

      <!-- 策略汇总表 -->
      <section class="panel">
        <h3>策略汇总{{ selectedStrategy !== 'all' ? '（已筛选：' + display.name + '）' : '' }}</h3>
        <div class="tbl-scroll">
          <table>
            <thead>
              <tr><th>策略</th><th class="num">订单数</th><th class="num">平仓数</th><th class="num">盈利数</th><th class="num">胜率</th><th class="num">净盈亏</th></tr>
            </thead>
            <tbody>
              <tr v-for="s in data.byStrategy" :key="s.id" :class="{ hl: selectedStrategy === s.id }">
                <td><b>{{ s.id }}</b><br><span class="sub">{{ s.name }}</span></td>
                <td class="num">{{ s.orders }}</td>
                <td class="num">{{ s.closed }}</td>
                <td class="num up">{{ s.profit }}</td>
                <td class="num">{{ fmtPct(s.winRate) }}</td>
                <td class="num" :class="s.net > 0 ? 'up' : s.net < 0 ? 'down' : ''">{{ fmtNet(s.net) }}U</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="legend"><b class="up">红 = 盈利 / 正收益</b>　<i class="down">绿 = 亏损 / 负收益</i>（红涨绿跌约定）。cancelled / open / pending 无已实现盈亏，不计入胜率分母。</p>
      </section>

      <!-- 时间轴 -->
      <section class="panel">
        <h3>时间轴 · {{ isHour ? '按小时（+08）' : '按天（+08）' }}　<span class="dim">（{{ selectedStrategy === 'all' ? '全部策略合计' : display.name }}）</span></h3>
        <div v-if="rows.length" class="chart" :class="{ hour: isHour }">
          <div v-for="r in rows" :key="r.bucket" class="col" :title="`${bucketLabel(r.bucket)}｜订单 ${r.orders} / 盈利 ${r.profit} / 净 ${fmtNet(r.net)}U`">
            <div class="bar-wrap">
              <div class="bar" :style="{ height: barHeight(r.orders) + '%', background: r.orders ? 'var(--chart-up)' : 'transparent', opacity: r.orders ? 0.85 : 0 }"></div>
              <span class="bar-orders">{{ r.orders || '' }}</span>
            </div>
            <div class="profit-up" :class="{ up: r.profit > 0 }">{{ r.profit ? '✓' + r.profit : '' }}</div>
            <div class="axis">{{ bucketLabel(r.bucket) }}</div>
          </div>
        </div>
        <p v-else class="dim">该范围内暂无订单数据。</p>
      </section>

      <p class="gen">更新于 {{ new Date(data.generatedAt).toLocaleString('zh-CN') }}</p>
    </div>
  </div>
</template>

<style scoped>
.stats-view { padding: 4px 8px 32px; color: var(--text, #e6e6e6); }
.stats-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.stats-head h2 { margin: 0 0 4px; font-size: 18px; }
.sub { color: #8b949e; font-size: 12px; margin: 0; }
.sub code { background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 4px; }
.controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.controls label { font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 6px; }
.controls select { background: #161b22; color: var(--text, #e6e6e6); border: 1px solid #30363d; border-radius: 8px; padding: 6px 10px; font-size: 13px; }
.seg { display: inline-flex; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
.seg button { background: #0f141a; color: #c9d1d9; border: 0; padding: 7px 14px; font-size: 13px; cursor: pointer; }
.seg button.active { background: var(--accent, #388bfd); color: #fff; }
.refresh { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
.refresh:hover { border-color: #388bfd; }
.error-box { background: rgba(229,72,77,.12); border: 1px solid rgba(229,72,77,.4); color: #ff7b72; padding: 10px 14px; border-radius: 8px; }

.cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 12px 16px; min-width: 132px; }
.card .k { color: #8b949e; font-size: 12px; }
.card .v { font-size: 22px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }

.panel { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.panel h3 { margin: 0 0 14px; font-size: 14px; color: #c9d1d9; font-weight: 600; }
.tbl-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; }
th { color: #8b949e; font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.hl { background: rgba(56,139,253,.12); }
.sub { color: #8b949e; font-size: 11px; }
.up { color: var(--chart-up); }
.down { color: var(--chart-down); }
.legend { font-size: 12px; color: #8b949e; margin: 12px 0 0; }
.legend b, .legend i { font-style: normal; font-weight: 600; }

.chart { display: flex; align-items: flex-end; gap: 6px; min-height: 200px; padding: 8px 0 0; overflow-x: auto; }
.chart.hour .col { min-width: 30px; }
.col { display: flex; flex-direction: column; align-items: center; min-width: 64px; flex: 1; }
.bar-wrap { height: 150px; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; position: relative; width: 100%; }
.bar { width: 60%; max-width: 34px; border-radius: 4px 4px 0 0; transition: height .3s; }
.bar-orders { font-size: 12px; font-weight: 700; color: #e6e6e6; margin-top: 4px; font-variant-numeric: tabular-nums; }
.profit-up { font-size: 11px; color: var(--chart-up); height: 14px; margin-top: 2px; }
.axis { font-size: 11px; color: #6e7681; margin-top: 4px; text-align: center; }
.dim { color: #6e7681; }
.gen { color: #6e7681; font-size: 11px; text-align: right; margin-top: 4px; }
</style>
