/**
 * 账户级自动下单回测（复用生产策略 + TradingSimulator）。
 *
 * 可调常量见 shared/autoTradeDefaults.js 顶部；本文件只读那些默认值，
 * 不再另写一套手续费 / 周期 / 资金口径。
 *
 *   node scripts/backtest-auto-trade.mjs
 *   NOFX_BT_STRATEGY=enhanced-trend-v1 NOFX_BT_DAYS=90 node scripts/backtest-auto-trade.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_TRADE } from '../shared/autoTradeDefaults.js';
import { PAPER_COSTS } from '../server/research.js';
import { loadConfiguredStrategy } from '../server/strategies/loader.js';
import { createAccountSimulator } from '../server/tradingSimulator.js';
import { applyPaperProtectionReview } from '../server/shared/protectionReview.js';
import { recommendedLeverage } from '../server/localAnalysis.js';
import { RISK_RULE } from '../server/shared/strategyGuards.js';
import { screenSymbol } from '../server/shared/liquidityScreen.js';
import { sizeSignal } from '../server/shared/scoreSizing.js';
import { shouldHaltNewEntries } from '../server/shared/lossCircuit.js';
import { buildOpportunityReport, buildExecutionPlanFromOpportunity } from '../server/opportunityReport.js';

const TF_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
const INTERVAL = AUTO_TRADE.interval;
const TF = TF_MS[INTERVAL];
if (!TF) throw new Error(`不支持的回测周期 ${INTERVAL}`);
const WINDOW = AUTO_TRADE.analysisWindow;
const CAPITAL = AUTO_TRADE.initialCapital;
const DAYS = AUTO_TRADE.backtestDays;
const COSTS = Object.freeze({
  ...PAPER_COSTS,
  feeBps: AUTO_TRADE.feeBps,
  slippageBps: AUTO_TRADE.slippageBps,
  fundingBpsPer8h: AUTO_TRADE.fundingBpsPer8h
});
const MAX_SYMBOLS = Number(process.env.NOFX_BT_MAX_SYMBOLS || 20);
const OUT_DIR = path.resolve(process.env.NOFX_BT_OUT || 'data/backtest/auto-trade');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.resolve(ROOT, AUTO_TRADE.corpusDir);
const KDIR = path.join(CORPUS, 'klines');

const loaded = await loadConfiguredStrategy(AUTO_TRADE.strategyId, {
  strategyPath: process.env.BT_STRATEGY_CONFIG || 'data/strategies.json',
  configPath: process.env.BT_CONFIG || 'data/config.json'
});
const STRATEGY = loaded.strategy;
const PARAMS = loaded.strategy.params;
const CONFIG = loaded.config;

function readBars(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [time, open, high, low, close, volume] = line.split(',').map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite) || open <= 0 || close <= 0) continue;
    rows.push({ openTime: time, open, high, low, close, volume, closeTime: time + TF - 1 });
  }
  return rows.sort((a, b) => a.openTime - b.openTime);
}

function quoteVolume24h(bars, index) {
  const from = bars[index].openTime - 24 * 3600_000;
  let quote = 0;
  for (let i = index; i >= 0; i--) {
    if (bars[i].openTime < from) break;
    quote += bars[i].volume * bars[i].close;
  }
  return quote;
}

function atrPct(bars, index, period = 14) {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const prev = bars[i - 1].close;
    sum += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev));
  }
  return bars[index].close > 0 ? (sum / period) / bars[index].close : null;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * fraction;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function sharpe(returns, periodsPerYear) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const var_ = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(var_);
  if (!(sd > 0)) return null;
  return mean / sd * Math.sqrt(periodsPerYear);
}

function summarize(trades, equityCurve) {
  const closed = trades.filter(t => Number.isFinite(t.net));
  const wins = closed.filter(t => t.net > 0);
  const losses = closed.filter(t => t.net <= 0);
  const net = closed.reduce((s, t) => s + t.net, 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const lossAbs = Math.abs(losses.reduce((s, t) => s + t.net, 0));
  let peak = CAPITAL, mdd = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    mdd = Math.max(mdd, peak - point.equity);
  }
  const daily = new Map();
  for (const t of closed) {
    const day = String(t.exitAt || '').slice(0, 10);
    daily.set(day, (daily.get(day) || 0) + t.net);
  }
  const dailyRets = [...daily.values()].map(v => v / CAPITAL);
  return {
    trades: closed.length,
    net: Number(net.toFixed(4)),
    roiPct: Number((net / CAPITAL * 100).toFixed(4)),
    winRate: closed.length ? Number((wins.length / closed.length).toFixed(4)) : null,
    profitFactor: lossAbs ? Number((grossWin / lossAbs).toFixed(3)) : null,
    avgWin: wins.length ? Number((grossWin / wins.length).toFixed(4)) : 0,
    avgLoss: losses.length ? Number((losses.reduce((s, t) => s + t.net, 0) / losses.length).toFixed(4)) : 0,
    payoff: wins.length && losses.length
      ? Number(Math.abs((grossWin / wins.length) / (losses.reduce((s, t) => s + t.net, 0) / losses.length)).toFixed(3))
      : null,
    maxDrawdown: Number(mdd.toFixed(4)),
    maxDrawdownPct: Number((mdd / CAPITAL * 100).toFixed(4)),
    sharpeDaily: sharpe(dailyRets, 365),
    medianNet: percentile(closed.map(t => t.net), 0.5)
  };
}

if (!fs.existsSync(KDIR)) throw new Error(`缺少语料 ${KDIR}`);
const meta = fs.existsSync(path.join(CORPUS, 'meta.json'))
  ? JSON.parse(fs.readFileSync(path.join(CORPUS, 'meta.json'), 'utf8')) : {};
const files = fs.readdirSync(KDIR).filter(f => f.endsWith('.ndjson')).sort();
const selected = files.slice(0, MAX_SYMBOLS);
const series = [];
for (const file of selected) {
  const symbol = file.replace(/\.ndjson$/, '');
  const bars = readBars(path.join(KDIR, file));
  if (bars.length < WINDOW + 10) continue;
  series.push({ symbol, bars });
}
if (!series.length) throw new Error('没有足够长的 K 线序列');

const endTs = Math.max(...series.map(s => s.bars.at(-1).openTime + TF));
const startTs = Math.max(
  Math.min(...series.map(s => s.bars[WINDOW]?.openTime || s.bars[0].openTime)),
  endTs - DAYS * 86400_000
);
const sim = createAccountSimulator({
  initialBalance: CAPITAL,
  maxPositions: AUTO_TRADE.maxPositions,
  allowDuplicateSymbol: false,
  unlimitedCapital: false
});
const states = series.map(s => ({
  ...s,
  i: s.bars.findIndex(bar => bar.openTime >= startTs),
  order: null,
  cooldown: -Infinity
}));
for (const s of states) if (s.i < WINDOW) s.i = WINDOW;

const trades = [];
const skipReasons = {};
const noteSkip = reason => { skipReasons[reason] = (skipReasons[reason] || 0) + 1; };
const equityCurve = [{ t: startTs, equity: CAPITAL }];
let realized = 0;
const usedMargin = () => states.reduce((n, s) => n + (s.order ? Number(s.order.margin) || 0 : 0), 0);
const floating = () => states.reduce((n, s) => n + (s.order?.entry ? Number(s.order.unrealized) || 0 : 0), 0);

const times = new Set();
for (const s of states) {
  for (const bar of s.bars) {
    const t = bar.openTime + TF;
    if (t >= startTs && t <= endTs) times.add(t);
  }
}
const timeline = [...times].sort((a, b) => a - b);

console.log(`策略 ${AUTO_TRADE.strategyId} · ${INTERVAL} · ${DAYS}d · 本金 ${CAPITAL}U · 币 ${states.length} · 成本 ${COSTS.feeBps}/${COSTS.slippageBps}/${COSTS.fundingBpsPer8h} bps`);

for (const now of timeline) {
  for (const s of states) {
    while (s.i < s.bars.length && s.bars[s.i].openTime + TF <= now) {
      if (s.order) {
        const from = Math.max(0, s.i - 200);
        const ev = sim.evaluate(s.order, s.bars.slice(from, s.i + 1), s.bars[s.i].openTime + TF);
        for (const key of ['nextTime', 'status', 'entry', 'entryAt', 'heldBars', 'quantity', 'entryFee',
          'markPrice', 'markAt', 'unrealized', 'tpStage', 'tpStopFloor', 'realizedGross', 'realizedFee',
          'realizedFunding', 'realizedNet', 'realizedQty']) {
          if (ev[key] !== undefined && ev[key] !== null) s.order[key] = ev[key];
        }
        if (ev.status === 'closed') {
          const net = Number(ev.net);
          if (Number.isFinite(net)) {
            realized += net;
            trades.push({
              symbol: s.symbol, direction: s.order.direction, entry: ev.entry, exit: ev.exit,
              entryAt: ev.entryAt, exitAt: ev.exitAt, heldBars: ev.heldBars, reason: ev.reason,
              net, gross: ev.gross, fee: ev.fees ?? ev.fee, funding: ev.funding,
              leverage: s.order.leverage, margin: s.order.margin, notional: s.order.notional
            });
            equityCurve.push({ t: Date.parse(ev.exitAt), equity: CAPITAL + realized });
          }
          s.cooldown = Date.parse(ev.exitAt) + 30 * 60_000;
          s.order = null;
        } else if (ev.status === 'data_gap' || ev.status === 'expired') {
          noteSkip(ev.status);
          s.order = null;
        }
      }
      s.i++;
    }
  }

  if (states.filter(s => s.order).length >= AUTO_TRADE.maxPositions) continue;
  const halt = shouldHaltNewEntries(trades.map(t => ({ status: 'closed', net: t.net, exitAt: t.exitAt })), AUTO_TRADE);
  if (halt.halt) continue;

  const equity = CAPITAL + realized + floating();
  const available = equity - usedMargin();
  const candidates = [];
  for (const s of states) {
    if (s.order || now < s.cooldown) continue;
    const idx = s.i - 1;
    if (idx < WINDOW || idx + 2 >= s.bars.length) continue;
    if (s.bars[idx].openTime + TF !== now) continue;
    const window = s.bars.slice(idx - WINDOW + 1, idx + 1);
    const screen = screenSymbol({
      symbol: s.symbol,
      quoteVolume: quoteVolume24h(s.bars, idx),
      atrPct: atrPct(s.bars, idx),
      klines: window
    }, AUTO_TRADE);
    if (!screen.ok) {
      noteSkip(screen.reasons[0] || '筛币未通过');
      continue;
    }
    const market = { symbol: s.symbol, interval: INTERVAL, klines: window, dataAsOf: new Date(now).toISOString() };
    const auxMarkets = INTERVAL === '15m'
      ? { '15m': market }
      : undefined;
    const raw = await STRATEGY.analyze(market, {
      params: PARAMS, config: CONFIG, interval: INTERVAL, ...(auxMarkets ? { auxMarkets } : {})
    });
    if (!raw || raw.action === 'WAIT' || !raw.plan) continue;
    const signal = { ...raw, symbol: s.symbol, interval: INTERVAL, strategyId: AUTO_TRADE.strategyId };
    const report = buildOpportunityReport({
      signal, market,
      marketContext: { errors: { opportunityContext: 'backtest_context_unavailable' } },
      strategy: STRATEGY
    });
    const plan = buildExecutionPlanFromOpportunity(report ? { ...signal, opportunityReport: report } : signal) || { ...raw.plan };
    candidates.push({ s, signal: { ...signal, plan, opportunityReport: report }, idx, close: s.bars[idx].close });
  }
  candidates.sort((a, b) => (Number(b.signal.plan?.trendStrengthScore) || 0) - (Number(a.signal.plan?.trendStrengthScore) || 0));

  for (const c of candidates) {
    if (c.s.order || states.filter(x => x.order).length >= AUTO_TRADE.maxPositions) continue;
    const strategyLev = Number(c.signal.plan.recommendedLeverage ?? c.signal.recommendedLeverage);
    let leverage = Number.isFinite(strategyLev) && strategyLev > 0
      ? Math.max(1, Math.min(RISK_RULE.maxLeverage, Math.floor(strategyLev)))
      : recommendedLeverage(c.signal.plan, c.signal.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT');
    let marginPct = Number(c.signal.plan.autoMarginPct) || AUTO_TRADE.baseMarginPct;
    if (AUTO_TRADE.scoreSizingEnabled) {
      const sized = sizeSignal(c.signal, {
        price: c.close, params: AUTO_TRADE, equity,
        openCount: states.filter(x => x.order).length
      });
      if (!sized.ok) {
        noteSkip(sized.reason);
        continue;
      }
      leverage = sized.leverage;
      marginPct = sized.marginPct;
    }
    const margin = Math.floor(Math.max(1, Math.min(available, equity * marginPct)) * 100) / 100;
    if (!(margin >= 1) || margin * leverage < AUTO_TRADE.minExchangeNotional) {
      noteSkip('保证金或名义不足');
      continue;
    }
    const dir = c.signal.action === 'BUY' ? 'OPEN_LONG' : 'OPEN_SHORT';
    c.s.order = {
      id: `${c.s.symbol}-${now}`, symbol: c.s.symbol, direction: dir, interval: INTERVAL,
      plan: c.signal.plan, initialPlan: { ...c.signal.plan }, status: 'pending',
      margin, leverage, notional: margin * leverage, costs: { ...COSTS },
      createdAt: new Date(now).toISOString(),
      nextTime: c.s.bars[c.idx + 1].openTime,
      analysisContext: { strategyId: AUTO_TRADE.strategyId, strategyParams: PARAMS },
      protectionRevisions: []
    };
  }

  for (const s of states) {
    if (!s.order?.entry) continue;
    const idx = s.i - 1;
    if (idx < WINDOW) continue;
    const market = {
      symbol: s.symbol, interval: INTERVAL,
      klines: s.bars.slice(idx - WINDOW + 1, idx + 1),
      dataAsOf: new Date(now).toISOString()
    };
    try {
      const proposal = await STRATEGY.review(s.order, market, { params: PARAMS, config: CONFIG, interval: INTERVAL });
      applyPaperProtectionReview(s.order, proposal, now, STRATEGY.engine);
    } catch { /* 复核失败保持原保护 */ }
  }
}

const stats = summarize(trades, equityCurve);
fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
  createdAt: new Date().toISOString(),
  round: 'R1-code-robustness',
  change: '新增筛币/盘口/评分仓位/连亏熔断模块，并接上 100U 账户回测；策略参数未改。',
  defaults: AUTO_TRADE,
  costs: COSTS,
  coverage: {
    corpus: path.relative(ROOT, CORPUS),
    symbols: states.length,
    start: new Date(startTs).toISOString(),
    end: new Date(endTs).toISOString(),
    skipped: skipReasons
  },
  stats,
  equityCurve: equityCurve.filter((_, i) => i % Math.max(1, Math.floor(equityCurve.length / 400)) === 0 || i === equityCurve.length - 1),
  trades
};
const jsonPath = path.join(OUT_DIR, 'auto-trade-r1.json');
const mdPath = path.join(OUT_DIR, 'auto-trade-r1.md');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
fs.writeFileSync(mdPath, [
  '# 自动下单回测 R1',
  '',
  `- 改动：${report.change}`,
  `- 策略 ${AUTO_TRADE.strategyId} · ${INTERVAL} · ${DAYS} 天 · 本金 ${CAPITAL} USDT`,
  `- 成本 fee ${COSTS.feeBps}bps / slip ${COSTS.slippageBps}bps / funding ${COSTS.fundingBpsPer8h}bps/8h`,
  `- 成交 ${stats.trades} · 净 ${stats.net}U · ROI ${stats.roiPct}% · 胜率 ${stats.winRate ?? '—'} · PF ${stats.profitFactor ?? '—'} · 盈亏比 ${stats.payoff ?? '—'}`,
  `- 最大回撤 ${stats.maxDrawdown}U (${stats.maxDrawdownPct}%) · 日频夏普 ${stats.sharpeDaily == null ? '—' : stats.sharpeDaily.toFixed(3)}`,
  '',
  '下一轮只改一个变量。建议先开 `NOFX_LIQUIDITY_SCREEN` 对照（本轮已默认开），或保持策略参数不动、只开 `NOFX_SCORE_SIZING=1` 看仓位映射。'
].join('\n'));
console.log(`成交 ${stats.trades} · 净 ${stats.net}U · ROI ${stats.roiPct}% · 胜率 ${stats.winRate} · MDD ${stats.maxDrawdownPct}%`);
console.log(`报告 ${path.relative(ROOT, mdPath)}`);
