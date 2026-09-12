<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { marketApi, historyApi } from './api/client.js';
import { useConfigStore } from './stores/config.js';
import { router } from './router.js';
import TopBar from './components/TopBar.vue';
import SymbolSidebar from './components/SymbolSidebar.vue';
import WorkbenchView from './components/WorkbenchView.vue';
import TradingView from './components/TradingView.vue';
import BinanceSettings from './components/BinanceSettings.vue';
import DailyTrendView from './components/DailyTrendView.vue';
import StrategiesView from './components/StrategiesView.vue';

// 配置/策略/状态集中到 store（前端唯一可信源）
const configStore = useConfigStore();
const { config, strategy } = configStore;
const { tradingStatus, symbolStatus, syncStatus, savedMode, statusError } = storeToRefs(configStore);
const loadStatus = () => configStore.loadStatus();

// 前端已下线的视图：「历史分析」「模型设置」「自动化任务」（导航入口已移除）。
// 老书签 / 历史 URL 落到这些视图时回落到工作台，避免白屏。
const AVAILABLE_VIEWS = ['workbench', 'trading', 'trading-simulation', 'strategies', 'daily-trend'];
const normalizeView = view => (AVAILABLE_VIEWS.includes(view) ? view : 'workbench');

const activeView = ref('workbench');
const activeSymbol = ref('BTCUSDT');
const chartDate = ref('');
const search = ref('');
const loading = ref(false);
const loadingAreas = reactive({ symbols: 0, market: 0, settings: 0, klineSync: 0 });
const message = ref('');
const error = ref('');
const state = reactive({ symbols: [], rows: [] });
let marketController;
let symbolsRequestId = 0;
let marketRequestId = 0;
let mounted = false;
let unsubscribeRoute;
let statusBusy = false;

const isBusy = computed(() => Object.values(loadingAreas).some((count) => count > 0));
const isMarketLoading = computed(() => loadingAreas.market > 0);
const isKlineSyncLoading = computed(() => loadingAreas.klineSync > 0);
const filteredSymbols = computed(() => state.symbols.filter(s => s.symbol.includes(search.value.trim().toUpperCase())));
const scope = reactive({ engine: 'auto', interval: '1m', limit: 80, maxSymbols: 20, batchSize: 10, symbolsText: '' });
const chart = computed(() => buildChart(state.rows));

onMounted(async () => {
  // 从 URL 恢复状态（已下线的视图回落工作台）
  const routeState = router.getState();
  const wanted = routeState.view || 'workbench';
  const restored = normalizeView(wanted);
  activeView.value = restored;
  if (restored !== wanted) router.replace(restored, {});

  if (routeState.params.symbol) {
    activeSymbol.value = routeState.params.symbol;
  }
  if (routeState.params.date) {
    chartDate.value = routeState.params.date;
  }
  if (routeState.params.interval) {
    scope.interval = routeState.params.interval;
  }

  // 监听路由变化
  unsubscribeRoute = router.onChange((newState) => {
    activeView.value = normalizeView(newState.view);
    if (newState.params.symbol && newState.params.symbol !== activeSymbol.value) {
      selectSymbol(newState.params.symbol);
    }
    if (newState.params.date && newState.params.date !== chartDate.value) {
      chartDate.value = newState.params.date;
    }
  });

  await loadConfig();
  mounted = true;
  await Promise.allSettled([loadSymbols(), selectSymbol(activeSymbol.value), loadStatus()]);

  if (mounted) statusTimer = setInterval(loadStatus, 10000);
});
onBeforeUnmount(() => { mounted = false; unsubscribeRoute?.(); clearInterval(statusTimer); marketController?.abort(); });

watch(() => [scope.interval, scope.limit, chartDate.value], () => {
  if (mounted) {
    selectSymbol(activeSymbol.value);
    // 更新 URL 中的 interval 参数
    if (activeView.value === 'workbench') {
      router.updateParams({ interval: scope.interval });
    }
  }
});
async function run(task, area = '') {
  if (area) loadingAreas[area] += 1;
  loading.value = true;
  if (!['market', 'symbols'].includes(area)) { error.value = ''; message.value = ''; }
  try { return await task(); } catch (err) { if (err.name !== 'AbortError') error.value = err.message; return null; } finally {
    if (area) loadingAreas[area] = Math.max(0, loadingAreas[area] - 1);
    loading.value = isBusy.value;
  }
}
async function loadSymbols(refresh = false) {
  const requestId = ++symbolsRequestId;
  await run(async () => {
    const result = refresh ? await marketApi.refresh() : await marketApi.symbols();
    if (requestId === symbolsRequestId) state.symbols = (refresh ? result.symbols : result) || [];
    symbolStatus.value = await marketApi.status();
  }, 'symbols');
}
async function selectSymbol(symbol) {
  if (!symbol) return;
  marketController?.abort();
  marketController = new AbortController();
  activeSymbol.value = symbol;

  // 更新 URL
  if (activeView.value === 'workbench') {
    router.updateParams({ symbol, interval: scope.interval });
  }

  state.rows = [];
  const interval = scope.interval, limit = scope.limit;
  const requestId = ++marketRequestId;
  await run(async () => {
    const result = await marketApi.klines({ symbol, interval, limit, endTime: chartDate.value ? new Date(chartDate.value).getTime() : undefined });
    if (requestId !== marketRequestId) return;
    state.rows = result.rows || [];
  }, 'market');
}
async function fetchLatestKlines(interval = scope.interval) {
  if (syncStatus.value?.busy) {
    message.value = `K 线正在同步：${syncStatus.value.progress?.completed || 0} / ${syncStatus.value.progress?.total || 0} 个合约。`;
    return;
  }
  const result = await run(async () => {
    const response = await historyApi.fetch({ symbols: 'ALL', interval, limit: scope.limit });
    await selectSymbol(activeSymbol.value);
    return response;
  }, 'klineSync');
  if (result) {
    const failed = result.datasets?.filter(d => d.error).length || 0;
    message.value = `已拉取 ${result.symbols?.length || 0} 个合约 ${result.interval} K 线，保存 ${result.saved || 0} 根${failed ? `，${failed} 个失败，请查看同步状态` : ''}`;
    await loadStatus();
  }
}
async function loadConfig() { await run(async () => { await configStore.load(); scope.interval = strategy.interval || scope.interval; scope.limit = strategy.klineLimit || scope.limit; }, 'settings'); }
async function saveBinanceSettings() { await run(async () => { await configStore.saveBinance(); message.value = '币安交易配置已保存'; }, 'settings'); }
async function testBinance() { const result = await run(() => configStore.test(), 'settings'); if (result) message.value = `${result.testnet ? '测试网' : '实盘'}只读连接成功 · ${result.activePositions} 个持仓 · ${result.positionMode === 'hedge' ? '双向持仓（自动交易需切换为单向）' : '单向持仓'}`; }
async function reviewBinance() { const result = await run(() => configStore.review(), 'settings'); if (result) { await loadStatus(); message.value = result.reason || `已复核 ${result.reviewed || 0} 个持仓，请查看执行记录`; } }
function buildChart(rows) { if (!rows.length) return { width: 960, height: 430, candles: [], volumes: [], min: 0, max: 0 }; const width=960, priceHeight=300, volumeTop=325, volumeHeight=82, pad=18; const highs=rows.map(r=>Number(r.high)), lows=rows.map(r=>Number(r.low)), max=Math.max(...highs), min=Math.min(...lows), span=(max-min || Math.max(Math.abs(max)*0.001, Number.EPSILON)), maxVolume=Math.max(...rows.map(r=>Number(r.volume)),1), step=(width-pad*2)/rows.length, bodyWidth=Math.max(2,step*.62), y=(price)=>pad+((max-price)/span)*(priceHeight-pad*2); return { width, height:430, min, max, candles:rows.map((row,index)=>{ const open=Number(row.open), close=Number(row.close), x=pad+index*step+step/2, openY=y(open), closeY=y(close); return { x, wickY1:y(Number(row.high)), wickY2:y(Number(row.low)), bodyX:x-bodyWidth/2, bodyY:Math.min(openY,closeY), bodyWidth, bodyHeight:Math.max(1,Math.abs(openY-closeY)), color:close>=open?'var(--chart-up)':'var(--chart-down)' }; }), volumes:rows.map((row,index)=>{ const height=Number(row.volume)/maxVolume*volumeHeight; return { x:pad+index*step+step/2-bodyWidth/2, y:volumeTop+volumeHeight-height, width:bodyWidth, height, color:Number(row.close)>=Number(row.open)?'var(--chart-volume-up)':'var(--chart-volume-down)' }; }) }; }
let statusTimer;
</script>
<template>
  <div class="app-shell"><TopBar :active-view="activeView" :mode="savedMode" @change-view="(view) => {
    if (view === activeView) return;
    activeView = view;

    // 更新 URL
    const params = {};
    if (view === 'workbench') {
      params.symbol = activeSymbol;
      params.interval = scope.interval;
    }
    router.push(view, params);
  }" /><div v-if="isBusy" class="global-progress" role="status"><span></span>正在加载，请稍候…</div><div v-if="message" class="notice">{{ message }}</div><div v-if="error" class="error">{{ error }}</div>
    <div class="workspace" :class="{ 'summary-page': activeView !== 'workbench' }"><SymbolSidebar v-if="activeView === 'workbench'" v-model:search="search" :symbols="filteredSymbols" :active-symbol="activeSymbol" :loading="Boolean(loadingAreas.symbols)" @refresh="loadSymbols(true)" @select="selectSymbol" />
      <main class="main-content">
        <WorkbenchView v-if="activeView === 'workbench'" :chart-date="chartDate" @update:chart-date="(date) => {
          chartDate = date;
          router.updateParams({ date: date || undefined });
        }" :active-symbol="activeSymbol" :interval="scope.interval" :rows="state.rows" :chart="chart" :market-loading="isMarketLoading" :kline-sync-loading="isKlineSyncLoading" :scope="scope" @refresh="selectSymbol(activeSymbol)" @fetch-latest="fetchLatestKlines" />
        <TradingView v-else-if="activeView === 'trading-simulation'" />
        <StrategiesView v-else-if="activeView === 'strategies'" />
        <DailyTrendView v-else-if="activeView === 'daily-trend'" />
        <BinanceSettings v-else-if="activeView === 'trading'" :binance="config.binance" :trader="config.trader" :status="tradingStatus" :saved-mode="savedMode" :loading="Boolean(loadingAreas.settings)" @save="saveBinanceSettings" @test="testBinance" @review="reviewBinance" />
      </main></div>
  </div>
</template>
