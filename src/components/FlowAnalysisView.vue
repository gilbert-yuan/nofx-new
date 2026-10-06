<script setup>
import { computed, reactive, ref } from 'vue';
import { marketApi } from '../api/client.js';

const INTERVALS = ['1m', '5m', '1h', '1d'];
const DEFAULTS = {
  lookbackBars: 20, recentBars: 5, minBars: 30,
  consolidationRangeMaxPct: 8, accumulationVolumeRatioMin: 0.65, accumulationVolumeRatioMax: 1.4,
  accumulationGentleVolumeRatioMin: 1.05, accumulationGentleVolumeRatioMax: 1.8,
  positiveFlowRatioMin: 0.02, washoutDropMinPct: 3, washoutVolumeRatioMax: 1.05,
  washoutRecoveryRatioMin: 0.65, breakoutVolumeRatioMin: 1.5, breakoutRiseMinPct: 2,
  distributionVolumeRatioMin: 2, distributionStallMaxPct: 1, distributionUpperWickMin: 0.45,
  distributionTurnoverRateMinPct: 5,
  largeRiseMinPct: 8, forecastMediumScore: 40, forecastHighScore: 70,
  lookaheadBarsByInterval: { '1m': 60, '5m': 48, '1h': 72, '1d': 20 }
};

const mode = ref('live');
const symbol = ref('BTCUSDT');
const primaryInterval = ref('1h');
const assetClass = ref('stock');
const params = reactive(structuredClone(DEFAULTS));
const result = ref(null);
const busy = ref(false);
const error = ref('');
const selectedFile = ref(null);
const importedDatasets = ref(null);
const importedSymbol = ref('');
const importSummary = ref('');
const showAllEvidence = ref(false);

const mainPattern = computed(() => result.value?.primary?.patternKey);
const mainEvidence = computed(() => {
  const rows = result.value?.primary?.evidence || [];
  if (!rows.length) return null;
  if (showAllEvidence.value) return rows;
  const chosen = rows.find(row => row.key === mainPattern.value);
  return chosen ? [chosen] : [rows.reduce((best, row) => row.score > best.score ? row : best, rows[0])];
});
const forecastTone = computed(() => result.value?.forecast?.level === '高' ? 'high'
  : result.value?.forecast?.level === '中' ? 'medium' : 'low');
const formatNumber = (value, digits = 2) => Number.isFinite(Number(value))
  && value !== null && value !== undefined && value !== ''
  ? Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const formatPercent = (value, digits = 2) => Number.isFinite(Number(value)) && value !== null && value !== undefined && value !== ''
  ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(digits)}%` : '—';
const formatRatio = value => Number.isFinite(Number(value)) && value !== null && value !== undefined && value !== '' ? `${Number(value).toFixed(2)}×` : '—';
const formatFlowRatio = value => Number.isFinite(Number(value)) && value !== null && value !== undefined && value !== '' ? `${(Number(value) * 100).toFixed(2)}%` : '—';
const intervalName = value => ({ '1m': '1 分钟', '5m': '5 分钟', '1h': '1 小时', '1d': '日线' }[value] || value);
const scoreTone = score => Number(score) >= 60 ? 'strong' : Number(score) >= 40 ? 'watch' : 'quiet';
const fileName = computed(() => selectedFile.value?.name || '');

function cloneParams() {
  return { ...params, lookaheadBarsByInterval: { ...params.lookaheadBarsByInterval } };
}

async function runLive() {
  const normalizedSymbol = symbol.value.trim().toUpperCase();
  if (!normalizedSymbol) { error.value = '请输入加密资产代码，例如 BTCUSDT。'; return; }
  busy.value = true; error.value = '';
  try {
    result.value = await marketApi.flowAnalysis({ symbol: normalizedSymbol, interval: primaryInterval.value, limit: 200, params: JSON.stringify(cloneParams()) });
  } catch (cause) { error.value = cause.message || '行情分析失败。'; }
  finally { busy.value = false; }
}

function cleanHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_\-()%％]/g, '');
}
const HEADER_NAMES = {
  time: ['time', 'timestamp', 'opentime', 'datetime', 'date', '开盘时间', '时间', '日期', '时间戳'],
  open: ['open', '开盘', '开盘价'], high: ['high', '最高', '最高价'],
  low: ['low', '最低', '最低价'], close: ['close', '收盘', '收盘价'],
  volume: ['volume', 'vol', '成交量'], quoteVolume: ['quotevolume', '成交额', '交易额'],
  turnoverRate: ['turnoverrate', 'turnover', '换手率'], netFlow: ['netflow', '资金流向', '净流入', '净资金流'],
  takerBuyVolume: ['takerbuyvolume', '主动买入量'], takerBuyQuoteVolume: ['takerbuyquotevolume', '主动买入额'],
  interval: ['interval', 'timeframe', '周期', '周期单位']
};
function fieldName(header) {
  const key = cleanHeader(header);
  return Object.keys(HEADER_NAMES).find(name => HEADER_NAMES[name].some(alias => cleanHeader(alias) === key));
}
function numberValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const num = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(num) ? num : undefined;
}
function timestampValue(value) {
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const parsed = Number(value);
    return parsed > 0 && parsed < 1e12 ? parsed * 1000 : parsed;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function normalizeRecord(record, fallbackInterval) {
  const row = {};
  for (const [key, value] of Object.entries(record || {})) {
    const field = fieldName(key) || key;
    if (field === 'time') row.openTime = timestampValue(value);
    else if (field === 'interval') row.interval = INTERVALS.includes(String(value)) ? String(value) : fallbackInterval;
    else if (['open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'turnoverRate', 'netFlow', 'takerBuyVolume', 'takerBuyQuoteVolume'].includes(field)) row[field] = numberValue(value);
  }
  row.interval ||= fallbackInterval;
  if ([row.open, row.high, row.low, row.close, row.volume].some(value => !Number.isFinite(value))) return null;
  return row;
}
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('CSV 至少需要一行表头和一行 K 线数据。');
  const separator = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(separator).map(value => value.trim().replace(/^"|"$/g, ''));
  const datasets = {};
  for (const line of lines.slice(1)) {
    const values = line.split(separator).map(value => value.trim().replace(/^"|"$/g, ''));
    const raw = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const row = normalizeRecord(raw, primaryInterval.value);
    if (!row) continue;
    const interval = row.interval;
    (datasets[interval] ||= []).push(row);
  }
  return { datasets, symbol: '', assetClass: assetClass.value };
}
function parseJson(text) {
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  const payload = Array.isArray(parsed) ? { datasets: { [primaryInterval.value]: parsed } } : parsed;
  const rawDatasets = payload.datasets || (Array.isArray(payload.candles) ? { [payload.interval || primaryInterval.value]: payload.candles } : null);
  if (!rawDatasets || typeof rawDatasets !== 'object' || Array.isArray(rawDatasets)) throw new Error('JSON 格式需要包含 datasets 周期对象，或 candles 数组。');
  const datasets = {};
  for (const interval of INTERVALS) {
    if (!Array.isArray(rawDatasets[interval])) continue;
    datasets[interval] = rawDatasets[interval].map(row => normalizeRecord(row, interval)).filter(Boolean);
  }
  return { datasets, symbol: payload.symbol || '', assetClass: payload.assetClass || assetClass.value, primaryInterval: payload.primaryInterval || payload.interval };
}

async function onFileChange(event) {
  selectedFile.value = event.target.files?.[0] || null;
  importedDatasets.value = null; importedSymbol.value = ''; importSummary.value = ''; error.value = '';
  if (!selectedFile.value) return;
  try {
    const content = await selectedFile.value.text();
    const parsed = selectedFile.value.name.toLowerCase().endsWith('.json') ? parseJson(content) : parseCsv(content);
    const datasets = Object.fromEntries(Object.entries(parsed.datasets).filter(([, rows]) => rows.length));
    if (!Object.keys(datasets).length) throw new Error('文件中没有符合格式的 K 线行，请检查 OHLCV 列名与数值。');
    importedDatasets.value = datasets;
    importedSymbol.value = parsed.symbol || '';
    if (parsed.symbol) symbol.value = parsed.symbol;
    if (parsed.assetClass) assetClass.value = parsed.assetClass;
    if (INTERVALS.includes(parsed.primaryInterval)) primaryInterval.value = parsed.primaryInterval;
    const counts = Object.entries(datasets).map(([interval, rows]) => `${interval} ${rows.length} 根`).join(' · ');
    importSummary.value = `${counts}。${datasets[primaryInterval.value]?.some(row => Number.isFinite(row.turnoverRate)) ? '含换手率' : '缺少换手率'} · ${Object.values(datasets).some(rows => rows.some(row => Number.isFinite(row.netFlow) || Number.isFinite(row.takerBuyVolume) || Number.isFinite(row.takerBuyQuoteVolume))) ? '含资金流/主动买量' : '资金流字段缺失'}`;
  } catch (cause) { error.value = cause.message || '无法读取该文件。'; }
}

async function runImport() {
  if (!importedDatasets.value) { error.value = '请先选择有效的 CSV 或 JSON 行情文件。'; return; }
  busy.value = true; error.value = '';
  try {
    result.value = await marketApi.analyzeFlowData({
      symbol: symbol.value.trim() || importedSymbol.value || '导入数据',
      assetClass: assetClass.value,
      primaryInterval: primaryInterval.value,
      datasets: importedDatasets.value,
      params: cloneParams()
    });
  } catch (cause) { error.value = cause.message || '导入数据分析失败。'; }
  finally { busy.value = false; }
}

function analyze() { return mode.value === 'live' ? runLive() : runImport(); }
function changeMode(next) {
  mode.value = next;
  error.value = '';
  if (next === 'import' && symbol.value === 'BTCUSDT') symbol.value = '';
  if (next === 'live' && !symbol.value.trim()) symbol.value = 'BTCUSDT';
}
function resetParams() { Object.assign(params, structuredClone(DEFAULTS)); }
function downloadTemplate() {
  const csv = 'timestamp,interval,open,high,low,close,volume,quoteVolume,turnoverRate,netFlow\n';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = 'flow-analysis-template.csv'; link.click(); URL.revokeObjectURL(link.href);
}
</script>

<template>
  <div class="flow-page">
    <section class="flow-intro">
      <div class="flow-intro-copy">
        <span class="eyebrow">ORDER FLOW / VOLUME · PRICE</span>
        <h2>量价形态研判</h2>
        <p>基于已收盘 K 线的规则匹配，观察阶段、成交强弱和多周期一致性。</p>
      </div>
      <div class="flow-mark" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><b>FLOW</b></div>
    </section>

    <section class="flow-controls panel-card">
      <div class="flow-mode-row">
        <div class="flow-tabs" role="tablist" aria-label="行情数据来源">
          <button :class="{ active: mode === 'live' }" @click="changeMode('live')">实时加密行情</button>
          <button :class="{ active: mode === 'import' }" @click="changeMode('import')">导入行情文件</button>
        </div>
      </div>
      <div class="flow-input-grid">
        <label class="flow-field"><span>{{ mode === 'live' ? '永续合约代码' : '币种 / 股票代码' }}</span><input v-model="symbol" :placeholder="mode === 'live' ? 'BTCUSDT' : '例如 AAPL、600519 或 BTCUSDT'" @keydown.enter="analyze" /></label>
        <label v-if="mode === 'import'" class="flow-field"><span>资产类别</span><select v-model="assetClass"><option value="stock">股票</option><option value="crypto">加密资产</option><option value="other">其他</option></select></label>
        <label class="flow-field"><span>主研判周期</span><select v-model="primaryInterval"><option v-for="interval in INTERVALS" :key="interval" :value="interval">{{ intervalName(interval) }}</option></select></label>
        <label v-if="mode === 'import'" class="flow-field file-field"><span>CSV / JSON 历史数据</span><input type="file" accept=".csv,.json,text/csv,application/json" @change="onFileChange" /><small v-if="fileName">{{ fileName }}</small><small v-else>表头可使用英文或中文。<button type="button" class="text-button" @click="downloadTemplate">下载 CSV 示例</button></small></label>
        <button class="flow-run" :disabled="busy || (mode === 'import' && !importedDatasets)" @click="analyze">{{ busy ? '分析中…' : '生成研判报告' }} <span aria-hidden="true">↗</span></button>
      </div>
      <p v-if="mode === 'live'" class="flow-source-hint">实时数据源：币安 U 本位永续 · 自动获取 1m、5m、1h、1d · 使用主动买入量推导净流向</p>
      <p v-else-if="importSummary" class="flow-source-hint">{{ importSummary }}</p>
      <p v-else class="flow-source-hint">CSV 可附带换手率、成交额和净流入；JSON 可按周期传入多组 K 线。缺失字段不会被估造。</p>

      <details class="flow-param-details flow-params">
        <summary>调整判定参数 <span>所有阈值均可改，改动只作用于本次报告</span></summary>
        <div class="flow-param-grid">
          <label><span>背景观察根数</span><input v-model.number="params.lookbackBars" type="number" min="10" max="100" /></label>
          <label><span>近端比较根数</span><input v-model.number="params.recentBars" type="number" min="2" max="12" /></label>
          <label><span>最低有效 K 线</span><input v-model.number="params.minBars" type="number" min="20" max="500" /></label>
          <label><span>横盘区间上限 %</span><input v-model.number="params.consolidationRangeMaxPct" type="number" min="0.5" step="0.5" /></label>
          <label><span>吸筹量比下限</span><input v-model.number="params.accumulationVolumeRatioMin" type="number" min="0.1" step="0.05" /></label>
          <label><span>吸筹量比上限</span><input v-model.number="params.accumulationVolumeRatioMax" type="number" min="0.2" step="0.1" /></label>
          <label><span>温和放量倍数下限</span><input v-model.number="params.accumulationGentleVolumeRatioMin" type="number" min="0.5" step="0.05" /></label>
          <label><span>温和放量倍数上限</span><input v-model.number="params.accumulationGentleVolumeRatioMax" type="number" min="0.5" step="0.1" /></label>
          <label><span>正向资金流比值（0.02 = 2%）</span><input v-model.number="params.positiveFlowRatioMin" type="number" min="0" max="0.8" step="0.01" /></label>
          <label><span>洗盘急跌幅度 %</span><input v-model.number="params.washoutDropMinPct" type="number" min="0.5" step="0.5" /></label>
          <label><span>洗盘下跌量比上限</span><input v-model.number="params.washoutVolumeRatioMax" type="number" min="0.1" step="0.05" /></label>
          <label><span>洗盘收复比例</span><input v-model.number="params.washoutRecoveryRatioMin" type="number" min="0.1" max="1" step="0.05" /></label>
          <label><span>突破量比下限</span><input v-model.number="params.breakoutVolumeRatioMin" type="number" min="1" step="0.1" /></label>
          <label><span>突破阶段涨幅 %</span><input v-model.number="params.breakoutRiseMinPct" type="number" min="0.1" step="0.5" /></label>
          <label><span>派发量比下限</span><input v-model.number="params.distributionVolumeRatioMin" type="number" min="1" step="0.1" /></label>
          <label><span>滞涨幅度上限 %</span><input v-model.number="params.distributionStallMaxPct" type="number" min="0.1" step="0.1" /></label>
          <label><span>长上影占振幅</span><input v-model.number="params.distributionUpperWickMin" type="number" min="0.1" max="0.95" step="0.05" /></label>
          <label><span>派发辅助换手率 %</span><input v-model.number="params.distributionTurnoverRateMinPct" type="number" min="0.1" step="0.5" /></label>
          <label><span>大幅拉升幅度参考 %</span><input v-model.number="params.largeRiseMinPct" type="number" min="2" step="1" /></label>
          <label><span>中等级规则分</span><input v-model.number="params.forecastMediumScore" type="number" min="10" max="80" /></label>
          <label><span>高等级规则分</span><input v-model.number="params.forecastHighScore" type="number" min="20" max="100" /></label>
          <label v-for="interval in INTERVALS" :key="`horizon-${interval}`"><span>{{ intervalName(interval) }}观察窗口根数</span><input v-model.number="params.lookaheadBarsByInterval[interval]" type="number" min="1" max="500" /></label>
        </div>
        <div class="flow-param-footer"><span>规则改动尚未写入报告，点击“生成研判报告”后生效。</span><button class="ghost" @click="resetParams">恢复默认</button></div>
      </details>
    </section>

    <p v-if="error" class="flow-error" role="alert">{{ error }}</p>
    <div v-if="busy" class="flow-loading" role="status"><i></i>正在读取数据并计算规则匹配…</div>

    <template v-if="result">
      <section class="flow-report-head">
        <div class="flow-report-title"><span class="eyebrow">{{ result.symbol }} · {{ intervalName(result.primaryInterval) }} · {{ result.source?.label }}</span><h3>形态阶段与拉升观察</h3><p>报告生成于 {{ new Date(result.generatedAt).toLocaleString() }}</p></div>
        <span class="source-chip">{{ result.primary.usableBars }} 根有效 K 线</span>
      </section>
      <section class="flow-lead-grid">
        <article class="flow-stage-card panel-card">
          <div class="card-kicker">量价阶段匹配 <span class="signal-dot" :class="scoreTone(result.stage.confidence)"></span></div>
          <div class="stage-label">{{ result.stage.label }}</div>
          <div class="stage-score"><strong>{{ result.stage.confidence }}</strong><span>/ 100<br />形态符合度</span></div>
          <p>分数表示当前数据与所选规则的匹配程度，不代表识别到真实操盘主体。</p>
        </article>
        <article class="flow-forecast-card panel-card" :class="`tone-${forecastTone}`">
          <div class="card-kicker">近期大幅拉升评估 <span class="forecast-tag">{{ result.forecast.level }}概率</span></div>
          <div class="forecast-score"><strong>{{ result.forecast.ruleScore }}</strong><span>规则评分</span></div>
          <div class="forecast-window">参考窗口 <b>{{ result.forecast.referenceWindow }}</b></div>
          <p>{{ result.forecast.scoreMeaning }}</p>
        </article>
        <article class="flow-level-card panel-card">
          <div class="card-kicker">关键观察位</div>
          <dl>
            <div><dt>观察高点</dt><dd>{{ formatNumber(result.forecast.keyLevels.breakout, 8) }}</dd></div>
            <div><dt>区间支撑</dt><dd>{{ formatNumber(result.forecast.keyLevels.support, 8) }}</dd></div>
            <div><dt>当前收盘</dt><dd>{{ formatNumber(result.forecast.keyLevels.current, 8) }}</dd></div>
            <div><dt>大幅变动参考</dt><dd>+{{ formatNumber(result.forecast.keyLevels.largeRiseThresholdPct) }}%</dd></div>
          </dl>
        </article>
      </section>

      <section class="flow-metrics-grid" aria-label="核心量价指标">
        <article><span>近端量比</span><strong>{{ formatRatio(result.primary.metrics.volumeRatio) }}</strong><small>近 {{ result.rules.thresholds.recentBars }} 根 / 前 {{ result.rules.thresholds.lookbackBars }} 根</small></article>
        <article><span>近端温和放量比</span><strong>{{ formatRatio(result.primary.metrics.gentleVolumeRatio) }}</strong><small>近端后段均量 / 前段均量</small></article>
        <article><span>区间涨幅</span><strong :class="result.primary.metrics.recentReturnPct == null ? '' : Number(result.primary.metrics.recentReturnPct) >= 0 ? 'positive' : 'negative'">{{ formatPercent(result.primary.metrics.recentReturnPct) }}</strong><small>{{ intervalName(result.primaryInterval) }}主周期</small></article>
        <article><span>主动买入占比</span><strong>{{ result.primary.metrics.takerBuyRatio == null ? '—' : formatPercent(result.primary.metrics.takerBuyRatio * 100) }}</strong><small>交易所提供主动买量时显示</small></article>
        <article><span>近端净流入额</span><strong>{{ formatNumber(result.primary.metrics.netFlow, 2) }}</strong><small>占成交额 {{ formatFlowRatio(result.primary.metrics.netFlowRatio) }} · 缺字段时不参与评分</small></article>
        <article><span>平均换手率</span><strong>{{ result.primary.metrics.averageTurnoverRate == null ? '—' : `${formatNumber(result.primary.metrics.averageTurnoverRate)}%` }}</strong><small>仅支持导入来源提供的数据</small></article>
      </section>

      <section class="flow-section panel-card">
        <div class="flow-section-head"><div><span class="eyebrow">TIMEFRAME AGREEMENT</span><h3>多周期结构</h3></div><span>同一规则阈值 · 分周期独立计算</span></div>
        <div v-if="result.intervals.length" class="flow-interval-grid">
          <article v-for="item in result.intervals" :key="item.interval" class="interval-card">
            <div class="interval-top"><b>{{ item.interval }}</b><span :class="`score-${scoreTone(item.confidence)}`">{{ item.confidence }} 分</span></div>
            <strong>{{ item.label }}</strong>
            <small>{{ item.usableBars }} 根 · 最新 {{ formatNumber(item.latestPrice, 8) }}</small>
            <div class="mini-scores"><span v-for="pattern in item.patterns" :key="pattern.key" :class="{ chosen: pattern.key === item.patternKey }">{{ pattern.label.replace('型量价特征', '').replace('型特征', '').replace('型拉升特征', '') }} {{ pattern.score }}</span></div>
          </article>
        </div>
        <p v-else class="flow-empty">当前没有可显示的周期数据。</p>
      </section>

      <section class="flow-report-columns">
        <article class="flow-section panel-card">
          <div class="flow-section-head"><div><span class="eyebrow">RULE EVIDENCE</span><h3>规则依据</h3></div><button class="text-button" @click="showAllEvidence = !showAllEvidence">{{ showAllEvidence ? '只看主形态' : '展开全部四类规则' }}</button></div>
          <div v-for="pattern in mainEvidence" :key="pattern.key" class="evidence-pattern">
            <div class="evidence-title"><b>{{ pattern.label }}</b><span>{{ pattern.score }} / 100</span></div>
            <ul><li v-for="condition in pattern.conditions" :key="condition.label" :class="{ matched: condition.matched, unavailable: condition.available === false }">
              <i>{{ condition.available === false ? '·' : condition.matched ? '✓' : '—' }}</i><span>{{ condition.label }}</span><b>{{ condition.available === false ? '缺少数据' : `${formatNumber(condition.value, 4)}${condition.unit === '比值' ? '' : condition.unit}` }}</b><small>阈值 {{ condition.threshold ?? '—' }}{{ condition.unit === '比值' ? '' : condition.unit }}</small>
            </li></ul>
          </div>
          <div class="rule-descriptions"><p v-for="description in result.rules.descriptions" :key="description">{{ description }}</p></div>
        </article>
        <article class="flow-section panel-card">
          <div class="flow-section-head"><div><span class="eyebrow">CONFIRMATION / INVALIDATION</span><h3>触发与预警</h3></div></div>
          <h4>观察触发条件</h4>
          <ul class="trigger-list"><li v-for="condition in result.forecast.triggerConditions" :key="condition">{{ condition }}</li></ul>
          <h4>预警信号</h4>
          <ul v-if="result.warnings.length" class="warning-list"><li v-for="warning in result.warnings" :key="warning">{{ warning }}</li></ul>
          <p v-else class="no-warning">当前规则未发现明确预警；这不代表风险消失。</p>
          <div class="risk-notice"><b>风险提示</b><p>{{ result.riskNotice }}</p></div>
        </article>
      </section>
    </template>
    <section v-else-if="!busy" class="flow-empty-state panel-card"><span class="eyebrow">DETERMINISTIC MARKET READ</span><h3>选择数据，生成可追溯的规则报告</h3><p>报告会列出命中的量价条件、使用的数据字段、观察价位和未满足的数据要求。</p></section>
  </div>
</template>

<style scoped>
.flow-page { display: grid; gap: 16px; max-width: 1420px; margin: 0 auto; color: var(--text-primary); }
.panel-card { background: var(--bg-card); border: 1px solid var(--border-primary); border-radius: 6px; }
.flow-intro { min-height: 142px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 24px 28px; border: 1px solid var(--border-primary); background: linear-gradient(110deg, var(--bg-secondary), var(--bg-tertiary)); overflow: hidden; position: relative; }
.flow-intro-copy { position: relative; z-index: 1; display: grid; gap: 8px; }
.eyebrow { color: var(--brand-primary); font: 700 10px var(--font-mono); letter-spacing: .13em; }
.flow-intro h2 { font-size: clamp(25px, 3vw, 34px); letter-spacing: -.04em; }
.flow-intro p,.flow-report-title p { color: var(--text-tertiary); font-size: 13px; }
.flow-mark { width: 270px; height: 110px; position: relative; display: flex; align-items: end; gap: 10px; padding: 0 5px 17px 0; opacity: .7; }
.flow-mark span { flex: 1; min-width: 7px; background: var(--brand-primary); border-radius: 2px 2px 0 0; box-shadow: inset 0 3px 0 color-mix(in oklch, white 25%, transparent); }
.flow-mark span:nth-child(1) { height: 24%; }.flow-mark span:nth-child(2) { height: 35%; }.flow-mark span:nth-child(3) { height: 31%; }.flow-mark span:nth-child(4) { height: 52%; }.flow-mark span:nth-child(5) { height: 67%; }.flow-mark span:nth-child(6) { height: 93%; }
.flow-mark b { position: absolute; right: 0; top: 0; color: var(--text-tertiary); font: 700 10px var(--font-mono); letter-spacing: .18em; }
.flow-controls { padding: 16px; }
.flow-mode-row,.flow-section-head,.flow-report-head,.interval-top,.evidence-title,.flow-param-footer { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.flow-tabs { display: inline-flex; gap: 4px; padding: 3px; background: var(--bg-tertiary); border: 1px solid var(--border-secondary); border-radius: 4px; }
.flow-tabs button { border: 0; border-radius: 3px; background: transparent; color: var(--text-tertiary); padding: 8px 12px; font-size: 12px; cursor: pointer; }
.flow-tabs button.active { color: var(--text-primary); background: var(--bg-elevated); box-shadow: var(--shadow-sm); }
.flow-input-grid { display: grid; grid-template-columns: minmax(180px, 1.5fr) minmax(150px, 1fr) minmax(240px, 1.5fr) auto; align-items: end; gap: 12px; margin-top: 16px; }
.flow-field { display: grid; gap: 6px; min-width: 0; color: var(--text-secondary); font-size: 11px; font-weight: 600; }
.flow-field input,.flow-field select { min-width: 0; width: 100%; height: 38px; }
.file-field input { padding: 6px 8px; font-size: 11px; }
.file-field small { color: var(--text-tertiary); font-weight: 400; line-height: 1.45; }
.flow-run { min-height: 38px; padding: 0 16px; border: 0; border-radius: 3px; color: var(--btn-primary-text); background: var(--brand-primary); font-size: 12px; font-weight: 750; cursor: pointer; white-space: nowrap; }
.flow-run span { margin-left: 9px; font-size: 16px; }.flow-run:disabled { opacity: .5; cursor: not-allowed; }
.flow-source-hint { margin: 12px 0 0; color: var(--text-tertiary); font-size: 11px; }
.text-button { border: 0; background: none; color: var(--brand-primary); padding: 0; font: inherit; cursor: pointer; }
.flow-param-details { color: var(--text-secondary); font-size: 12px; }
.flow-param-details summary { cursor: pointer; list-style-position: inside; }
.flow-params { border-top: 1px solid var(--border-secondary); margin-top: 15px; padding-top: 13px; }
.flow-params summary span { margin-left: 7px; color: var(--text-tertiary); font-size: 10px; }
.flow-param-grid { display: grid; grid-template-columns: repeat(5, minmax(115px, 1fr)); gap: 10px; margin-top: 14px; }
.flow-param-grid label { display: grid; gap: 5px; color: var(--text-tertiary); font-size: 10px; }
.flow-param-grid input { width: 100%; min-width: 0; padding: 6px 8px; font-size: 12px; }
.flow-param-footer { margin-top: 12px; color: var(--text-muted); font-size: 10px; }
.flow-param-footer .ghost { padding: 6px 10px; font-size: 11px; }
.flow-error { padding: 11px 14px; border: 1px solid color-mix(in oklch, var(--danger) 45%, transparent); background: var(--danger-bg); color: var(--danger); font-size: 12px; }
.flow-loading { display: flex; align-items: center; gap: 9px; color: var(--text-secondary); padding: 8px 2px; font-size: 12px; }
.flow-loading i { width: 8px; height: 8px; border-radius: 50%; background: var(--brand-primary); animation: flow-pulse 1s ease-in-out infinite; }
.flow-report-head { padding: 5px 2px 0; }
.flow-report-title { display: grid; gap: 5px; }.flow-report-title .eyebrow { color: var(--text-tertiary); }.flow-report-title h3 { font-size: 20px; }
.source-chip { color: var(--text-secondary); background: var(--bg-tertiary); border: 1px solid var(--border-secondary); border-radius: 20px; padding: 6px 10px; font: 11px var(--font-mono); white-space: nowrap; }
.flow-lead-grid { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 12px; }
.flow-lead-grid article { min-height: 180px; padding: 16px 18px; }
.card-kicker { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-tertiary); font-size: 10px; letter-spacing: .05em; }
.signal-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }.signal-dot.strong { background: var(--brand-primary); }.signal-dot.watch { background: var(--warning); }
.stage-label { margin: 20px 0 3px; font-size: clamp(18px, 2vw, 24px); font-weight: 700; letter-spacing: -.025em; }
.stage-score { display: flex; align-items: center; gap: 8px; }.stage-score strong,.forecast-score strong { font: 500 32px var(--font-mono); }.stage-score span,.forecast-score span { color: var(--text-tertiary); font-size: 10px; line-height: 1.35; }
.flow-stage-card p,.flow-forecast-card p { color: var(--text-tertiary); font-size: 10px; line-height: 1.55; margin-top: 10px; }
.flow-forecast-card { position: relative; overflow: hidden; }.flow-forecast-card::after { content: ''; position: absolute; width: 118px; height: 118px; right: -38px; bottom: -57px; border: 1px solid color-mix(in oklch, var(--brand-primary) 35%, transparent); border-radius: 50%; box-shadow: 0 0 0 12px color-mix(in oklch, var(--brand-primary) 4%, transparent), 0 0 0 25px color-mix(in oklch, var(--brand-primary) 3%, transparent); pointer-events: none; }
.tone-high { border-top: 2px solid var(--danger); }.tone-medium { border-top: 2px solid var(--warning); }.tone-low { border-top: 2px solid var(--border-hover); }
.tone-high .forecast-score strong { color: var(--danger); }.tone-medium .forecast-score strong { color: var(--warning); }.tone-low .forecast-score strong { color: var(--text-secondary); }
.forecast-tag { padding: 4px 7px; background: var(--bg-tertiary); border-radius: 2px; color: var(--text-secondary); font-size: 10px; }
.forecast-score { display: flex; align-items: baseline; gap: 8px; margin-top: 13px; }.forecast-window { margin-top: 8px; color: var(--text-tertiary); font-size: 10px; }.forecast-window b { margin-left: 5px; color: var(--text-primary); font: 600 11px var(--font-mono); }
.flow-level-card dl { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0 0; }.flow-level-card dl div { display: grid; gap: 4px; }.flow-level-card dt { color: var(--text-tertiary); font-size: 10px; }.flow-level-card dd { margin: 0; font: 600 12px var(--font-mono); overflow-wrap: anywhere; }
.flow-metrics-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1px; background: var(--border-primary); border: 1px solid var(--border-primary); }
.flow-metrics-grid article { min-height: 91px; padding: 12px; background: var(--bg-secondary); display: grid; align-content: start; gap: 5px; }.flow-metrics-grid article > span { color: var(--text-tertiary); font-size: 10px; }.flow-metrics-grid strong { font: 600 16px var(--font-mono); }.flow-metrics-grid small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }.positive { color: var(--danger); }.negative { color: var(--success); }
.flow-section { padding: 16px; min-width: 0; }.flow-section-head { align-items: end; margin-bottom: 14px; }.flow-section-head h3 { margin-top: 4px; font-size: 15px; }.flow-section-head > span { color: var(--text-muted); font-size: 10px; }
.flow-interval-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
.interval-card { min-width: 0; padding: 11px; background: var(--bg-secondary); border: 1px solid var(--border-secondary); }.interval-top b { font: 700 11px var(--font-mono); }.interval-top > span { font: 10px var(--font-mono); }.score-strong { color: var(--brand-primary); }.score-watch { color: var(--warning); }.score-quiet { color: var(--text-muted); }
.interval-card > strong { display: block; margin-top: 12px; font-size: 12px; }.interval-card > small { display: block; margin-top: 4px; color: var(--text-muted); font-size: 9px; }
.mini-scores { display: grid; gap: 4px; margin-top: 11px; color: var(--text-muted); font-size: 9px; }.mini-scores span { display: flex; justify-content: space-between; gap: 4px; }.mini-scores span.chosen { color: var(--brand-primary); }
.flow-report-columns { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(290px, .75fr); gap: 12px; align-items: start; }
.evidence-pattern + .evidence-pattern { border-top: 1px solid var(--border-secondary); margin-top: 13px; padding-top: 13px; }.evidence-title b { font-size: 11px; }.evidence-title span { color: var(--text-tertiary); font: 10px var(--font-mono); }
.evidence-pattern ul,.trigger-list,.warning-list { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 1px; }.evidence-pattern li { display: grid; grid-template-columns: 18px minmax(120px, 1fr) auto auto; align-items: center; gap: 6px; min-height: 29px; padding: 5px 6px; background: var(--bg-secondary); font-size: 10px; }.evidence-pattern li > i { font-style: normal; color: var(--text-muted); }.evidence-pattern li.matched > i { color: var(--brand-primary); }.evidence-pattern li.unavailable > i { color: var(--warning); }.evidence-pattern li > b { font: 500 10px var(--font-mono); }.evidence-pattern li > small { color: var(--text-muted); font-size: 9px; }.rule-descriptions { margin-top: 12px; padding: 9px 10px; border-left: 2px solid var(--border-hover); background: var(--bg-secondary); }.rule-descriptions p { color: var(--text-tertiary); font-size: 9px; line-height: 1.6; }.rule-descriptions p + p { margin-top: 4px; }
.flow-section h4 { margin: 15px 0 7px; color: var(--text-secondary); font-size: 10px; }.trigger-list li,.warning-list li { position: relative; padding: 8px 9px 8px 24px; background: var(--bg-secondary); color: var(--text-secondary); font-size: 10px; line-height: 1.5; }.trigger-list li::before { content: '↗'; position: absolute; left: 9px; color: var(--brand-primary); }.warning-list li::before { content: '!'; position: absolute; left: 10px; color: var(--warning); font-weight: 800; }.no-warning { padding: 10px; background: var(--bg-secondary); color: var(--text-tertiary); font-size: 10px; }
.risk-notice { margin-top: 14px; border: 1px solid color-mix(in oklch, var(--warning) 28%, var(--border-primary)); background: color-mix(in oklch, var(--warning) 5%, var(--bg-secondary)); padding: 10px; }.risk-notice b { color: var(--warning); font-size: 10px; }.risk-notice p { margin-top: 5px; color: var(--text-tertiary); font-size: 9px; line-height: 1.6; }
.flow-empty,.flow-empty-state p { color: var(--text-tertiary); font-size: 11px; }.flow-empty-state { padding: 24px; }.flow-empty-state h3 { margin: 9px 0 7px; font-size: 16px; }
@keyframes flow-pulse { 50% { opacity: .3; transform: scale(.8); } }
@media (max-width: 1100px) { .flow-input-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.flow-param-grid { grid-template-columns: repeat(4, minmax(110px, 1fr)); } }
@media (max-width: 820px) { .flow-intro { padding: 18px; }.flow-mark { width: 150px; }.flow-lead-grid { grid-template-columns: 1fr 1fr; }.flow-level-card { grid-column: 1 / -1; }.flow-metrics-grid { grid-template-columns: repeat(3, minmax(0,1fr)); }.flow-interval-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }.flow-report-columns { grid-template-columns: 1fr; }.flow-param-grid { grid-template-columns: repeat(3, minmax(0,1fr)); } }
@media (max-width: 560px) { .flow-intro { min-height: auto; }.flow-mark { width: 95px; height: 80px; gap: 5px; }.flow-mark b { font-size: 8px; }.flow-mode-row { align-items: start; flex-direction: column; }.flow-input-grid { grid-template-columns: 1fr; }.flow-run { width: 100%; }.flow-lead-grid { grid-template-columns: 1fr; }.flow-lead-grid article { min-height: auto; }.flow-level-card { grid-column: auto; }.flow-metrics-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }.flow-interval-grid { grid-template-columns: 1fr 1fr; }.flow-param-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }.flow-param-footer { align-items: start; flex-direction: column; }.flow-report-head { align-items: start; flex-direction: column; }.evidence-pattern li { grid-template-columns: 18px minmax(100px,1fr) auto; }.evidence-pattern li > small { grid-column: 2 / -1; }.flow-section { padding: 12px; } }
@media (prefers-reduced-motion: reduce) { .flow-loading i { animation: none; } }
</style>
