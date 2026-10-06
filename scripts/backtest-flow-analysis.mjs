/**
 * Out-of-sample event audit for the production flow-pattern analyzer.
 *
 * The target is a forward +8% move within the configured 1h horizon (72 bars).
 * Signals are generated only from closed 1h bars and the engine is called
 * directly; no pattern or forecast rules are reimplemented here.
 *
 * Usage:
 *   node scripts/backtest-flow-analysis.mjs
 *   node scripts/backtest-flow-analysis.mjs --symbol BTCUSDT
 *   node scripts/backtest-flow-analysis.mjs --max-symbols 40
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFlowPatterns, DEFAULT_FLOW_ANALYSIS_PARAMS } from '../server/flowPatternAnalysis.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_BARS = 200;
const HORIZON_BARS = DEFAULT_FLOW_ANALYSIS_PARAMS.lookaheadBarsByInterval['1h'];
const TARGET_PCT = DEFAULT_FLOW_ANALYSIS_PARAMS.largeRiseMinPct;
const HOLDOUT_FRACTION = 0.3;
const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const corpusDir = path.resolve(ROOT, option('corpus', 'data/backtest/bf365-1hrs'));
const klineDir = path.join(corpusDir, 'klines');
const requestedSymbol = option('symbol', '').trim().toUpperCase();
const maxSymbols = positiveInt(option('max-symbols', 0), 0);
const strideBars = positiveInt(option('stride', HORIZON_BARS), HORIZON_BARS);
const outDir = path.resolve(ROOT, option('out', 'data/backtest/flow-analysis'));

if (!fs.existsSync(klineDir)) throw new Error(`Missing historical corpus: ${klineDir}`);

function readBars(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [time, open, high, low, close, volume] = line.split(',').map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) || open <= 0 || close <= 0 || volume < 0) continue;
    rows.push({ openTime: time, open, high, low, close, volume });
  }
  rows.sort((a, b) => a.openTime - b.openTime);
  return rows;
}

function resampleDays(hourly) {
  const byDay = new Map();
  for (const bar of hourly) {
    const day = Math.floor(bar.openTime / DAY_MS) * DAY_MS;
    let group = byDay.get(day);
    if (!group) {
      group = { openTime: day, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, count: 0 };
      byDay.set(day, group);
    } else {
      group.high = Math.max(group.high, bar.high);
      group.low = Math.min(group.low, bar.low);
      group.close = bar.close;
      group.volume += bar.volume;
    }
    group.count++;
  }
  // Do not make an incomplete hourly day look like a completed daily candle.
  return [...byDay.values()].filter(day => day.count === 24).sort((a, b) => a.openTime - b.openTime);
}

function isContiguous(bars, start, end) {
  for (let index = start + 1; index <= end; index++) {
    if (bars[index].openTime - bars[index - 1].openTime !== HOUR_MS) return false;
  }
  return true;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function auc(rows) {
  const positives = rows.filter(row => row.hit).length;
  const negatives = rows.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...rows].sort((a, b) => a.ruleScore - b.ruleScore);
  let positiveRankSum = 0;
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].ruleScore === sorted[index].ruleScore) end++;
    const averageRank = ((index + 1) + end) / 2;
    for (let cursor = index; cursor < end; cursor++) if (sorted[cursor].hit) positiveRankSum += averageRank;
    index = end;
  }
  return (positiveRankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function summarize(rows, baseline = null) {
  if (!rows.length) return { samples: 0, hitRate: null, closeConfirmRate: null, liftVsBase: null };
  const hits = rows.filter(row => row.hit);
  const closes = rows.filter(row => row.closeHit);
  const downHits = rows.filter(row => row.downHit);
  const downCloses = rows.filter(row => row.downCloseHit);
  const upsides = rows.map(row => row.maxUpsidePct);
  const drawdowns = rows.map(row => row.maxAdversePct);
  const hitRate = hits.length / rows.length;
  const downsideHitRate = downHits.length / rows.length;
  const baseRate = baseline?.hitRate ?? hitRate;
  const baseDownRate = baseline?.downsideHitRate ?? downsideHitRate;
  return {
    samples: rows.length,
    timeBlocks: new Set(rows.map(row => row.timeBlock)).size,
    baseRate,
    baseDownRate,
    targetHits: hits.length,
    closeConfirmedHits: closes.length,
    hitRate,
    closeConfirmRate: closes.length / rows.length,
    liftVsBase: baseRate > 0 ? hitRate / baseRate : null,
    downsideHits: downHits.length,
    downsideHitRate,
    downsideCloseConfirmRate: downCloses.length / rows.length,
    downsideLiftVsBase: baseDownRate > 0 ? downsideHitRate / baseDownRate : null,
    meanMaxUpsidePct: upsides.reduce((sum, value) => sum + value, 0) / rows.length,
    medianMaxUpsidePct: percentile(upsides, 0.5),
    meanMaxAdversePct: drawdowns.reduce((sum, value) => sum + value, 0) / rows.length,
    medianMaxAdversePct: percentile(drawdowns, 0.5),
    medianBarsToTarget: percentile(hits.map(row => row.barsToHit), 0.5),
    meanRuleScore: rows.reduce((sum, row) => sum + row.ruleScore, 0) / rows.length,
    scoreAuc: auc(rows)
  };
}

function formatPct(value, digits = 1) { return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`; }
function formatNum(value, digits = 2) { return value === null || value === undefined ? '—' : Number(value).toFixed(digits); }
function table(rows, columns) {
  const header = `| ${columns.map(column => column[0]).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${columns.map(([, key, render]) => render ? render(row[key], row) : String(row[key] ?? '—')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

const files = fs.readdirSync(klineDir)
  .filter(file => file.toLowerCase().endsWith('.ndjson'))
  .filter(file => !requestedSymbol || path.basename(file, path.extname(file)).toUpperCase() === requestedSymbol)
  .sort((a, b) => a.localeCompare(b));
if (!files.length) throw new Error(requestedSymbol ? `No corpus for symbol ${requestedSymbol}` : `No .ndjson files in ${klineDir}`);
const selectedFiles = maxSymbols ? files.slice(0, maxSymbols) : files;

// Determine a common calendar boundary for the untouched chronological holdout.
let corpusStart = Number.POSITIVE_INFINITY;
let corpusEnd = 0;
for (const file of selectedFiles) {
  const stat = fs.statSync(path.join(klineDir, file));
  if (!stat.size) continue;
  const lines = fs.readFileSync(path.join(klineDir, file), 'utf8').split(/\r?\n/).filter(Boolean);
  const first = Number(lines[0]?.split(',')[0]);
  const last = Number(lines.at(-1)?.split(',')[0]);
  if (Number.isFinite(first)) corpusStart = Math.min(corpusStart, first);
  if (Number.isFinite(last)) corpusEnd = Math.max(corpusEnd, last + HOUR_MS);
}
if (!Number.isFinite(corpusStart) || corpusEnd <= corpusStart) throw new Error('The selected corpus has no valid timestamps.');
const holdoutStart = corpusStart + (corpusEnd - corpusStart) * (1 - HOLDOUT_FRACTION);
const strideMs = strideBars * HOUR_MS;
const samples = [];
const symbolSummaries = [];
let skippedShort = 0;
let skippedGaps = 0;
let processedSymbols = 0;

console.log(`数据集：${path.relative(ROOT, corpusDir)} · 文件 ${selectedFiles.length} · 目标 +${TARGET_PCT}% / ${HORIZON_BARS} 根 1h · 步长 ${strideBars} 根`);
console.log(`时间边界：${new Date(corpusStart).toISOString()} ～ ${new Date(corpusEnd).toISOString()} · 留出集起点 ${new Date(holdoutStart).toISOString()}`);

for (const file of selectedFiles) {
  const symbol = path.basename(file, path.extname(file));
  const bars = readBars(path.join(klineDir, file));
  if (bars.length < HISTORY_BARS + HORIZON_BARS + 1) { skippedShort++; continue; }
  const dailyBars = resampleDays(bars);
  const symbolRows = [];
  const earliestDecision = bars[HISTORY_BARS - 1].openTime + HOUR_MS;
  const sinceAnchor = Math.max(0, earliestDecision - corpusStart);
  let nextSampleAt = corpusStart + Math.ceil(sinceAnchor / strideMs) * strideMs;

  for (let index = HISTORY_BARS - 1; index + HORIZON_BARS < bars.length; index++) {
    const decisionAt = bars[index].openTime + HOUR_MS;
    if (decisionAt < nextSampleAt) continue;
    while (nextSampleAt <= decisionAt) nextSampleAt += strideMs;

    const historyStart = index - HISTORY_BARS + 1;
    const forwardEnd = index + HORIZON_BARS;
    if (!isContiguous(bars, historyStart, forwardEnd)) { skippedGaps++; continue; }

    const history = bars.slice(historyStart, index + 1);
    const closedDaily = dailyBars
      .filter(day => day.openTime + DAY_MS <= decisionAt)
      .slice(-HISTORY_BARS);
    const report = analyzeFlowPatterns({
      symbol,
      primaryInterval: '1h',
      datasets: { '1h': history, '1d': closedDaily },
      params: DEFAULT_FLOW_ANALYSIS_PARAMS,
      source: { kind: 'historical', provider: 'Binance USDⓈ-M Futures', label: '365 日 1h OHLCV 语料' }
    });
    const forward = bars.slice(index + 1, forwardEnd + 1);
    const target = bars[index].close * (1 + TARGET_PCT / 100);
    let barsToHit = null;
    let maxHigh = 0, maxClose = 0, minLow = Number.POSITIVE_INFINITY, minClose = Number.POSITIVE_INFINITY;
    const downsideTarget = bars[index].close * 0.92;
    for (let step = 0; step < forward.length; step++) {
      const bar = forward[step];
      maxHigh = Math.max(maxHigh, bar.high);
      maxClose = Math.max(maxClose, bar.close);
      minLow = Math.min(minLow, bar.low);
      minClose = Math.min(minClose, bar.close);
      if (barsToHit === null && bar.high >= target) barsToHit = step + 1;
    }
    const hit = barsToHit !== null;
    const row = {
      symbol,
      decisionAt,
      timeBlock: Math.floor((decisionAt - corpusStart) / strideMs),
      tier: report.forecast.level,
      stageKey: report.stage.patternKey || 'none',
      stageLabel: report.stage.label,
      stageConfidence: report.stage.confidence,
      ruleScore: report.forecast.ruleScore,
      hit,
      closeHit: maxClose >= target,
      downHit: minLow <= downsideTarget,
      downCloseHit: minClose <= downsideTarget,
      barsToHit,
      maxUpsidePct: (maxHigh / bars[index].close - 1) * 100,
      maxAdversePct: Math.min(0, (minLow / bars[index].close - 1) * 100),
      terminalClosePct: (forward.at(-1).close / bars[index].close - 1) * 100
    };
    samples.push(row);
    symbolRows.push(row);
  }

  if (symbolRows.length) {
    symbolSummaries.push({
      symbol,
      samples: symbolRows.length,
      hitRate: symbolRows.filter(row => row.hit).length / symbolRows.length,
      meanMaxUpsidePct: symbolRows.reduce((sum, row) => sum + row.maxUpsidePct, 0) / symbolRows.length
    });
  }
  processedSymbols++;
  if (processedSymbols % 50 === 0 || processedSymbols === selectedFiles.length) {
    console.log(`处理 ${processedSymbols}/${selectedFiles.length} · 已生成样本 ${samples.length}`);
  }
}

if (!samples.length) throw new Error('No eligible samples. Try a longer historical corpus or fewer requested constraints.');
const holdoutRows = samples.filter(row => row.decisionAt >= holdoutStart);
const earlyRows = samples.filter(row => row.decisionAt < holdoutStart);
const allPeriodSummary = summarize(samples);
const earlyPeriodSummary = summarize(earlyRows);
const holdoutSummary = summarize(holdoutRows);
const tierRows = ['高', '中', '低'].map(tier => ({ tier, ...summarize(holdoutRows.filter(row => row.tier === tier), holdoutSummary) }));
const fullTierRows = ['高', '中', '低'].map(tier => ({ tier, ...summarize(samples.filter(row => row.tier === tier), allPeriodSummary) }));
const stageRows = [...new Set(holdoutRows.map(row => row.stageKey))]
  .map(stageKey => ({
    stageKey,
    stage: holdoutRows.find(row => row.stageKey === stageKey)?.stageLabel || stageKey,
    ...summarize(holdoutRows.filter(row => row.stageKey === stageKey), holdoutSummary)
  }))
  .sort((a, b) => b.samples - a.samples);
const holdoutMonthMap = new Map();
for (const row of holdoutRows) {
  const month = new Date(row.decisionAt).toISOString().slice(0, 7);
  const bucket = holdoutMonthMap.get(month) || [];
  bucket.push(row);
  holdoutMonthMap.set(month, bucket);
}
const monthlyRows = [...holdoutMonthMap.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([month, rows]) => ({ month, ...summarize(rows, holdoutSummary) }));
const coverage = {
  corpusSymbols: selectedFiles.length,
  evaluatedSymbols: symbolSummaries.length,
  shortSymbolsSkipped: skippedShort,
  gapWindowsSkipped: skippedGaps,
  samples: samples.length,
  earlyPeriodSamples: earlyRows.length,
  holdoutSamples: holdoutRows.length,
  distinctHoldoutDays: new Set(holdoutRows.map(row => new Date(row.decisionAt).toISOString().slice(0, 10))).size,
  distinctHoldoutTimeBlocks: new Set(holdoutRows.map(row => row.timeBlock)).size,
  holdoutStart: new Date(holdoutStart).toISOString(),
  horizonBars: HORIZON_BARS,
  samplingStrideBars: strideBars,
  historyBars: HISTORY_BARS
};

const report = {
  createdAt: new Date().toISOString(),
  protocol: {
    corpus: path.relative(ROOT, corpusDir),
    source: '本地当前币种池的 Binance U 本位永续 1h OHLCV 语料；日线由完整 24 根 UTC 小时线聚合。',
    timeRange: { start: new Date(corpusStart).toISOString(), end: new Date(corpusEnd).toISOString() },
    targetDefinition: `主要做多事件：信号收盘价之后 ${HORIZON_BARS} 根 1h K 线内，最高价触及 +${TARGET_PCT}%；派发风险另观察最低价是否触及 -8%。`,
    signalTiming: '每个样本在 1h K 线收盘时生成信号，从下一根 K 线开始统计；输入窗口不含未来 K 线。',
    sampling: `每币每 ${strideBars} 小时取一个样本，预测窗口不重叠；最后 ${Math.round(HOLDOUT_FRACTION * 100)}% 日历时间作为时间留出集。`,
    parameters: DEFAULT_FLOW_ANALYSIS_PARAMS,
    availableFields: ['开盘价', '最高价', '最低价', '收盘价', '成交量'],
    missingFields: ['1m', '5m', '换手率', '资金净流入', '主动买入量', '主动买入额'],
    limitations: [
      '本轮验证 1h 量价预测及部分 1d 确认。语料只有 OHLCV，未覆盖实时分析中的 1m/5m 共振、主动买卖量和换手率。',
      '+8% 触及率是事件预测指标，不是交易收益；没有模拟成交、手续费、滑点、止损或仓位。',
      '规则分不是校准概率；AUC 与等级命中率用于评估排序区分能力，不能解释为概率准确度。',
      '语料来自本地当前币种池，未包含已下架合约、其他交易所或股票，存在币种存续偏差。',
      `同一 72 小时窗口内的不同币种可能同时受市场行情影响；${coverage.holdoutSamples} 个留出样本只覆盖 ${coverage.distinctHoldoutTimeBlocks} 个时间窗口，横截面样本并非完全独立。`,
      '“吸筹、洗盘、拉升、派发”没有客观人工标注真值；阶段部分只能比较其后续行情表现，不能证明阶段标签语义正确。'
    ]
  },
  coverage,
  allPeriod: {
    ...allPeriodSummary,
    tiers: fullTierRows
  },
  earlyPeriod: earlyPeriodSummary,
  holdout: {
    ...holdoutSummary,
    tiers: tierRows,
    stages: stageRows,
    monthly: monthlyRows
  },
  symbols: symbolSummaries.sort((a, b) => b.samples - a.samples || a.symbol.localeCompare(b.symbol))
};

function markdown() {
  const metrics = (summary, name) => `### ${name}\n\n`
    + `样本 **${summary.samples}** · +${TARGET_PCT}% 最高价触及率 **${formatPct(summary.hitRate)}** · 收盘确认率 **${formatPct(summary.closeConfirmRate)}** · -8% 最低价触及率 **${formatPct(summary.downsideHitRate)}** · 规则分 AUC **${formatNum(summary.scoreAuc, 3)}** · 平均最大不利波动 **${formatNum(summary.meanMaxAdversePct)}%**\n\n`;
  const tierTable = rows => table(rows, [
    ['等级', 'tier'], ['样本', 'samples'], ['时间窗口', 'timeBlocks'], ['触及数', 'targetHits'],
    ['最高价触及率', 'hitRate', formatPct], ['收盘确认率', 'closeConfirmRate', formatPct],
    ['最低价 -8% 触及率', 'downsideHitRate', formatPct],
    ['相对基准', 'liftVsBase', value => value === null ? '—' : `${value.toFixed(2)}×`],
    ['平均最大涨幅', 'meanMaxUpsidePct', value => `${formatNum(value)}%`],
    ['平均最大不利波动', 'meanMaxAdversePct', value => `${formatNum(value)}%`]
  ]);
  const stageTable = table(stageRows, [
    ['形态标签', 'stage'], ['样本', 'samples'], ['72h 时间窗口', 'timeBlocks'], ['未来 +8% 触及', 'hitRate', formatPct],
    ['未来 -8% 触及', 'downsideHitRate', formatPct],
    ['收盘确认率', 'closeConfirmRate', formatPct], ['平均最大涨幅', 'meanMaxUpsidePct', value => `${formatNum(value)}%`],
    ['平均最大不利波动', 'meanMaxAdversePct', value => `${formatNum(value)}%`]
  ]);
  const monthTable = table(monthlyRows, [
    ['月份', 'month'], ['样本', 'samples'], ['+8% 触及率', 'hitRate', formatPct],
    ['平均规则分', 'meanRuleScore', value => formatNum(value, 1)], ['规则分 AUC', 'scoreAuc', value => formatNum(value, 3)]
  ]);
  const high = tierRows.find(row => row.tier === '高');
  const medium = tierRows.find(row => row.tier === '中');
  const low = tierRows.find(row => row.tier === '低');
  const distribution = stageRows.find(row => row.stageKey === 'distribution');
  const accumulation = stageRows.find(row => row.stageKey === 'accumulation');
  const markup = stageRows.find(row => row.stageKey === 'markup');
  const washout = stageRows.find(row => row.stageKey === 'washout');
  const mediumDelta = medium?.hitRate == null || report.holdout.hitRate == null ? null : (medium.hitRate - report.holdout.hitRate) * 100;
  const findings = [
    `留出集 AUC 为 ${formatNum(report.holdout.scoreAuc, 3)}。0.5 约为随机排序水平，当前规则分对 +8% 事件的整体区分度很弱。`,
    `高等级只有 ${high?.samples || 0} 个样本，命中率 ${formatPct(high?.hitRate)}；样本不足以验证“高”级判断。`,
    `中等级 ${medium?.samples || 0} 个样本，命中率 ${formatPct(medium?.hitRate)}，较留出集基准 ${formatPct(report.holdout.hitRate)} ${mediumDelta === null ? '' : `高 ${mediumDelta.toFixed(1)} 个百分点`}。该提升幅度有限，仍需更多独立时间窗口确认。`,
    `低等级命中率 ${formatPct(low?.hitRate)}，与留出集基准接近；当前低等级不能有效排除 +8% 拉升事件。`,
    `吸筹标签 +8% 触及率 ${formatPct(accumulation?.hitRate)}，低于基准；当前条件没有显示出拉升前兆。`,
    `拉升标签 +8% 触及率 ${formatPct(markup?.hitRate)}、洗盘标签 ${formatPct(washout?.hitRate)}；同时它们的 -8% 触及率分别为 ${formatPct(markup?.downsideHitRate)}、${formatPct(washout?.downsideHitRate)}，呈现高波动而非单向上涨。`,
    `派发风险标签 ${distribution?.samples || 0} 个样本，之后 -8% 触及率 ${formatPct(distribution?.downsideHitRate)}，高于全留出集下行基准 ${formatPct(report.holdout.downsideHitRate)}；但该组 +8% 触及率也有 ${formatPct(distribution?.hitRate)}，方向性仍不纯。`
  ];
  return [
    '# 量价研判规则正确性回测',
    '',
    `生成时间：${report.createdAt}`,
    '',
    `- 语料：${report.protocol.corpus}，${new Date(corpusStart).toISOString()} 至 ${new Date(corpusEnd).toISOString()}`,
    `- 目标：${report.protocol.targetDefinition}`,
    `- 信号时点：${report.protocol.signalTiming}`,
    `- 采样：每币每 ${strideBars} 小时一个不重叠窗口；前 70% 时间作较早参考区间，后 30% 作留出集。阈值固定为当前默认值，未用留出集调参。`,
    `- 覆盖：${coverage.evaluatedSymbols}/${coverage.corpusSymbols} 个币，${coverage.samples} 个样本；留出集 ${coverage.holdoutSamples} 个样本、${coverage.distinctHoldoutTimeBlocks} 个 72h 时间窗口。跳过 ${coverage.shortSymbolsSkipped} 个历史不足币种和 ${coverage.gapWindowsSkipped} 个有缺口窗口。`,
    '',
    '> +8% 命中指未来 72 小时最高价触及目标；派发风险另看最低价是否触及 -8%。规则分不是概率，阶段标签没有人工真值。',
    '',
    '## 结果解读',
    '',
    ...findings.map(item => `- ${item}`),
    '',
    metrics(report.allPeriod, '全区间'),
    metrics(report.earlyPeriod, '较早区间（前 70%）'),
    metrics(report.holdout, '时间留出集（后 30%）'),
    '## 留出集：预测等级',
    '',
    tierTable(tierRows),
    '',
    '## 留出集：阶段标签',
    '',
    stageTable,
    '',
    '## 留出集：按月稳定性',
    '',
    monthTable,
    '',
    '## 数据与解释限制',
    '',
    ...report.protocol.limitations.map(item => `- ${item}`),
    '',
    '回测信号直接调用 `analyzeFlowPatterns` 生成；未重写规则逻辑，也未用历史结果拟合或优化阈值。'
  ].join('\n');
}

fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, 'flow-analysis-correctness-1h.json');
const mdPath = path.join(outDir, 'flow-analysis-correctness-1h.md');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
fs.writeFileSync(mdPath, markdown());

console.log(`\n全区间样本 ${report.allPeriod.samples} · +${TARGET_PCT}% 触及率 ${formatPct(report.allPeriod.hitRate)} · AUC ${formatNum(report.allPeriod.scoreAuc, 3)}`);
console.log(`留出集样本 ${report.holdout.samples} · 基准 ${formatPct(report.holdout.hitRate)} · AUC ${formatNum(report.holdout.scoreAuc, 3)}`);
for (const row of tierRows) console.log(`${row.tier}等级：${row.samples} 样本 · 触及率 ${formatPct(row.hitRate)} · 相对基准 ${row.liftVsBase === null ? '—' : `${row.liftVsBase.toFixed(2)}x`}`);
console.log(`报告：${path.relative(ROOT, mdPath)} · ${path.relative(ROOT, jsonPath)}`);
