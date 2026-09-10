<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api } from './api.js';
import { marketApi, historyApi } from './api/client.js';
import { useConfigStore } from './stores/config.js';
import { router } from './router.js';
import TopBar from './components/TopBar.vue';
import SymbolSidebar from './components/SymbolSidebar.vue';
import WorkbenchView from './components/WorkbenchView.vue';
import HistoryView from './components/HistoryView.vue';
import AiSettings from './components/AiSettings.vue';
import AnalysisResultCard from './components/AnalysisResultCard.vue';
import TradingView from './components/TradingView.vue';
import BinanceSettings from './components/BinanceSettings.vue';
import MarketStatus from './components/MarketStatus.vue';
import DailyTrendView from './components/DailyTrendView.vue';

// 配置/策略/状态集中到 store（前端唯一可信源）
const configStore = useConfigStore();
const { config, strategy, tradingStatus, symbolStatus, syncStatus, savedMode, statusError } = configStore;
const loadStatus = () => configStore.loadStatus();

const activeView = ref('workbench');
const activeSymbol = ref('BTCUSDT');
const chartDate = ref('');
const search = ref('');
const historyDate = ref(new Date().toISOString().slice(0, 10));
const historySymbol = ref('');
const selectedHistory = ref(null);
const selectedHistorySymbol = ref('');
const loading = ref(false);
const loadingAreas = reactive({ symbols: 0, market: 0, history: 0, analysis: 0, settings: 0, klineSync: 0 });
const message = ref('');
const error = ref('');
const state = reactive({ symbols: [], rows: [], analyses: [], currentAnalysis: null, symbolAnalyses: [] });
let marketController, historyController, symbolHistoryController;
let selectedInterval = '1m';
let symbolsRequestId = 0;
let marketRequestId = 0;
let analysisRequestId = 0;
let mounted = false;
let historyRequestId = 0;
let lastHistoryQuery = '';
let lastSymbolHistoryQuery = '';
let statusBusy = false;

const isBusy = computed(() => Object.values(loadingAreas).some((count) => count > 0));
const isHistoryLoading = computed(() => loadingAreas.history > 0);
const isMarketLoading = computed(() => loadingAreas.market > 0);
const isAnalysisLoading = computed(() => loadingAreas.analysis > 0);
const isKlineSyncLoading = computed(() => loadingAreas.klineSync > 0);
const filteredSymbols = computed(() => state.symbols.filter(s => s.symbol.includes(search.value.trim().toUpperCase())));
const scope = reactive({ engine: 'auto', interval: '1m', limit: 80, maxSymbols: 20, batchSize: 10, symbolsText: '' });
const chart = computed(() => buildChart(state.rows));

onMounted(async () => {
  // 从 URL 恢复状态
  const routeState = router.getState();
  activeView.value = routeState.view || 'workbench';

  if (routeState.params.symbol) {
    activeSymbol.value = routeState.params.symbol;
  }
  if (routeState.params.date) {
    historyDate.value = routeState.params.date;
  }
  if (routeState.params.interval) {
    scope.interval = routeState.params.interval;
  }

  // 监听路由变化
  router.onChange((newState) => {
    activeView.value = newState.view;
    if (newState.params.symbol && newState.params.symbol !== activeSymbol.value) {
      selectSymbol(newState.params.symbol);
    }
    if (newState.params.date && newState.params.date !== historyDate.value) {
      historyDate.value = newState.params.date;
      if (newState.view === 'history') {
        loadHistoryByDate(true);
      }
    }
  });

  await loadAiSettings();
  mounted = true;
  await Promise.allSettled([loadSymbols(), selectSymbol(activeSymbol.value), loadAnalyses(), loadStatus()]);

  // 根据当前视图加载必要数据
  if (activeView.value === 'history') {
    loadHistoryByDate();
  }

  statusTimer = setInterval(loadStatus, 10000);
});
onBeforeUnmount(() => { mounted = false; clearInterval(statusTimer); marketController?.abort(); historyController?.abort(); symbolHistoryController?.abort(); });

watch(() => [scope.interval, scope.limit, chartDate.value], () => {
  if (mounted) {
    selectSymbol(activeSymbol.value);
    // 更新 URL 中的 interval 参数
    if (activeView.value === 'workbench') {
      router.updateParams({ interval: scope.interval });
    }
  }
});
const visibleAnalysis = computed(() => {
  const record = state.currentAnalysis;
  if (record?.type !== 'single' || record.symbol !== activeSymbol.value || record.interval !== scope.interval) return null;
  return record;
});
const visibleHistory = computed(() => state.symbolAnalyses.filter(r => r.interval === scope.interval && r.analyses?.some(a => a.exchange === 'binance') && (r.symbol === activeSymbol.value || r.symbols?.includes(activeSymbol.value))));

async function run(task, area = '') {
  if (area) loadingAreas[area] += 1;
  loading.value = true;
  if (!['history', 'market', 'symbols'].includes(area)) { error.value = ''; message.value = ''; }
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
  const signal = marketController.signal;
  if (symbol !== activeSymbol.value || selectedInterval !== scope.interval) {
    state.currentAnalysis = null;
    analysisRequestId++;
  }
  activeSymbol.value = symbol;

  // 更新 URL
  if (activeView.value === 'workbench') {
    router.updateParams({ symbol, interval: scope.interval });
  }

  selectedInterval = scope.interval;
  state.rows = [];
  const interval = scope.interval, limit = scope.limit;
  const requestId = ++marketRequestId;
  await Promise.all([run(async () => {
    const result = await marketApi.klines({ symbol, interval, limit, endTime: chartDate.value ? new Date(chartDate.value).getTime() : undefined });
    if (requestId !== marketRequestId) return;
    state.rows = result.rows || [];
  }, 'market'), loadSymbolHistory()]);
}
async function loadSymbolHistory(force = false) {
  const symbol = activeSymbol.value, date = historyDate.value, key = `${date}|${symbol}`;
  symbolHistoryController?.abort();
  if (!force && key === lastSymbolHistoryQuery) return;
  lastSymbolHistoryQuery = '';
  symbolHistoryController = new AbortController();
  const signal = symbolHistoryController.signal;
  state.symbolAnalyses = [];
  await run(async () => {
    const rows = await api(`/analyses?symbol=${encodeURIComponent(symbol)}&date=${date}&limit=20`, { signal });
    if (!signal.aborted && symbol === activeSymbol.value && date === historyDate.value) {
      state.symbolAnalyses = rows || [];
      lastSymbolHistoryQuery = key;
    }
  }, 'history');
}
async function analyzeSymbol() {
  const symbol = activeSymbol.value, interval = scope.interval, requestId = ++analysisRequestId;
  state.currentAnalysis = null;
  await run(async () => {
    const record = await api('/market/analyze', { method: 'POST', body: { symbol, interval, limit: scope.limit, scope: { ...scope } } }).catch(err => {
      if (requestId === analysisRequestId && symbol === activeSymbol.value && interval === scope.interval) {
        state.currentAnalysis = { type: 'single', symbol, interval, analyses: [], error: err.message };
      }
      throw err;
    });
    if (requestId === analysisRequestId && symbol === activeSymbol.value && interval === scope.interval) state.currentAnalysis = record;
    await Promise.all([loadAnalyses(true), loadSymbolHistory(true)]);
    if (record.error) error.value = record.error;
    message.value = record.error ? '' : '已保存 ' + symbol + ' 的分析';
  }, 'analysis');
}
async function analyzeRange() { await analyzeBatch('range'); }
async function analyzeAll() { await analyzeBatch('all'); }
async function analyzeBatch(type) {
  await run(async () => {
    const record = await api('/market/analyze-' + type, { method: 'POST', body: { scope: { ...scope } } });
    await loadAnalyses(true);
    selectedHistory.value = record;
    selectedHistorySymbol.value = '';
    activeView.value = 'history';
    if (record.error) error.value = record.error;
    message.value = record.error ? '' : '已保存 ' + record.marketCount + ' 个币种的分析';
  }, 'analysis');
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
async function loadAnalyses(force = false) {
  const query = `${historyDate.value}|${historySymbol.value}`;
  historyController?.abort();
  if (!force && query === lastHistoryQuery) return;
  historyController = new AbortController();
  const signal = historyController.signal;
  const requestId = ++historyRequestId;
  await run(async () => {
    const records = await api(`/analyses?date=${historyDate.value}&symbol=${encodeURIComponent(historySymbol.value)}&limit=100`, { signal });
    if (requestId === historyRequestId) {
      lastHistoryQuery = query;
      state.analyses = records || [];
    }
  }, 'history');
}
async function loadHistoryByDate(force = false) {
  await Promise.all([loadAnalyses(force), loadSymbolHistory(force)]);
}
async function loadAiSettings() { await run(async () => { await configStore.load(); scope.interval = strategy.interval || scope.interval; scope.limit = strategy.klineLimit || scope.limit; }, 'settings'); }
async function saveAiSettings() { await run(async () => { await configStore.saveAi(); message.value = 'AI模型配置和提示词已保存'; }, 'settings'); }
async function saveBinanceSettings() { await run(async () => { await configStore.saveBinance(); message.value = '币安交易配置已保存'; }, 'settings'); }
async function testBinance() { const result = await run(() => configStore.test(), 'settings'); if (result) message.value = `${result.testnet ? '测试网' : '实盘'}只读连接成功 · ${result.activePositions} 个持仓 · ${result.positionMode === 'hedge' ? '双向持仓（自动交易需切换为单向）' : '单向持仓'}`; }
async function reviewBinance() { const result = await run(() => configStore.review(), 'settings'); if (result) { await loadStatus(); message.value = result.reason || `已复核 ${result.reviewed || 0} 个持仓，请查看执行记录`; } }
async function toggleSync() { await run(async () => { await (syncStatus.value?.running ? historyApi.syncStop() : historyApi.syncStart()); await loadStatus(); }, 'klineSync'); }
async function openHistory(item, symbol = '') { await run(async () => { selectedHistorySymbol.value = symbol; selectedHistory.value = await api(`/analyses/${encodeURIComponent(item.id)}`); }); }
function normalizedPosition(item) { return ['OPEN_LONG','OPEN_SHORT','CLOSE_LONG','CLOSE_SHORT','WAIT'].includes(item.positionRecommendation) ? item.positionRecommendation : ({ BUY: 'OPEN_LONG', SELL: 'OPEN_SHORT', HOLD: 'WAIT' }[item.action] || 'WAIT'); }
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
      params.symbol = activeSymbol.value;
      params.interval = scope.interval;
    } else if (view === 'history') {
      params.date = historyDate.value;
    }
    router.push(view, params);

    if (view === 'history') loadHistoryByDate();
  }" /><div v-if="isBusy" class="global-progress" role="status"><span></span>正在加载，请稍候…</div><div v-if="message" class="notice">{{ message }}</div><div v-if="error" class="error">{{ error }}</div>
    <div class="workspace" :class="{ 'summary-page': activeView !== 'workbench' }"><SymbolSidebar v-if="activeView === 'workbench'" v-model:search="search" :symbols="filteredSymbols" :active-symbol="activeSymbol" :loading="Boolean(loadingAreas.symbols)" @refresh="loadSymbols(true)" @select="selectSymbol" />
      <main class="main-content">
        <MarketStatus v-if="activeView === 'workbench'" :symbols="symbolStatus" :sync="syncStatus" :error="statusError" :loading="isKlineSyncLoading" @refresh-symbols="loadSymbols(true)" @sync="fetchLatestKlines(syncStatus?.interval || '1m')" @toggle-sync="toggleSync" />
        <WorkbenchView v-if="activeView === 'workbench'" :chart-date="chartDate" @update:chart-date="(date) => {
          chartDate = date;
          router.updateParams({ date: date || undefined });
        }" :active-symbol="activeSymbol" :interval="scope.interval" :rows="state.rows" :chart="chart" :current-analysis="visibleAnalysis" :symbol-analyses="visibleHistory" :loading="isAnalysisLoading" :market-loading="isMarketLoading" :kline-sync-loading="isKlineSyncLoading" :history-loading="isHistoryLoading" :history-date="historyDate" :scope="scope" :symbol-count="state.symbols.length" @analyze="analyzeSymbol" @analyze-range="analyzeRange" @analyze-all="analyzeAll" @refresh="selectSymbol(activeSymbol)" @fetch-latest="fetchLatestKlines" @update:history-date="(date) => {
          if (date !== historyDate) {
            historyDate = date;
            loadHistoryByDate(true);
          }
        }" @history="openHistory" />
        <TradingView v-else-if="activeView === 'trading-simulation'" />
        <HistoryView v-else-if="activeView === 'history'" :date="historyDate" :records="state.analyses" :loading="isHistoryLoading" @update:date="(date) => {
          if (date !== historyDate) {
            historyDate = date;
            router.updateParams({ date });
            loadHistoryByDate(true);
          }
        }" @refresh="() => loadHistoryByDate(true)" @open="openHistory" />
        <DailyTrendView v-else-if="activeView === 'daily-trend'" />
        <AiSettings v-else-if="activeView === 'settings'" :model="config.model" :strategy="strategy" :loading="Boolean(loadingAreas.settings)" @save="saveAiSettings" />
        <BinanceSettings v-else-if="activeView === 'trading'" :binance="config.binance" :trader="config.trader" :status="tradingStatus" :saved-mode="savedMode" :loading="Boolean(loadingAreas.settings)" @save="saveBinanceSettings" @test="testBinance" @review="reviewBinance" />
      </main></div>
    <div v-if="selectedHistory" class="modal-backdrop" @click.self="selectedHistory = null"><article class="modal"><button class="modal-close" @click="selectedHistory = null">×</button><span class="eyebrow">ANALYSIS DETAIL</span><h2>{{ selectedHistory.type !== 'single' ? '范围分析详情' : selectedHistory.symbol }}</h2><p class="muted">{{ new Date(selectedHistory.at).toLocaleString() }} · {{ selectedHistory.interval }} · 版本 {{ selectedHistory.strategyVersion || '旧记录' }}</p><div v-for="item in selectedHistory.analyses.filter((entry) => !selectedHistorySymbol || entry.symbol === selectedHistorySymbol)" :key="`${selectedHistory.id}-${item.symbol}`" class="detail-item"><AnalysisResultCard :item="item" /></div></article></div>
  </div>
</template>
