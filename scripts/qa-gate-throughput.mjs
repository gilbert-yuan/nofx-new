// QA V1 验证：用真实历史 5m K 线跑 enhancedAnalysis，统计各道门槛的通过率。
// 只读数据库，不写任何表，不重启服务。
import { Client } from 'pg';
import { enhancedAnalysis } from '../server/enhancedAnalysis.js';
import { PAPER_COSTS } from '../server/research.js';

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const WINDOW = 80;      // 与扫描器 prepareMarket limit=80 一致
const STEP = 12;        // 每小时采一个窗口（5m × 12）
const MAX_SYMBOLS = Number(process.env.QA_SYMBOLS || 80);

function classify(reason) {
  const r = String(reason || '');
  if (r.includes('需要至少50根')) return 'data_insufficient';
  if (r.includes('波动率过高')) return 'volatility_high';
  if (r.includes('波动率过低')) return 'volatility_low';
  if (r.includes('均线纠缠')) return 'ma_tangled';
  if (r.includes('RSI')) return 'rsi_filter';
  if (r.includes('成交量不足')) return 'volume_confirm';
  if (r.includes('成交量放大')) return 'volume_spike_1p2';
  if (r.includes('综合信号强度不足')) return 'trend_score_lt_66';
  if (r.includes('缺少关键确认信号')) return 'no_direction_confirm';
  if (r.includes('做空信号暂时禁用')) return 'short_disabled';
  if (r.includes('避免追高') || r.includes('避免追空')) return 'extension_1p5atr';
  if (r.includes('风险收益比不足')) return 'rr_below_2p5';
  return 'other:' + r.slice(0, 30);
}

// 复算 research.js normalizePlan 的 netRewardRisk
function netRR(plan, action) {
  if (!plan) return null;
  const long = action === 'BUY';
  const entry = long ? plan.entryMax : plan.entryMin;
  const hours = plan.maxHoldBars * 5 / 60; // 5m 周期
  const cost = entry * (2 * (PAPER_COSTS.feeBps + PAPER_COSTS.slippageBps)
    + PAPER_COSTS.fundingBpsPer8h * hours / 8) / 10000;
  const reward = Math.abs(plan.takeProfit - entry) - cost;
  const risk = Math.abs(entry - plan.stopLoss) + cost;
  return risk > 0 ? reward / risk : null;
}

const client = new Client({ connectionString: DB });
await client.connect();

const symRes = await client.query(`
  select symbol, count(*)::int as n from market_klines
  where interval = '5m' group by symbol having count(*) >= 200
  order by n desc limit $1`, [MAX_SYMBOLS]);
const symbols = symRes.rows.map(r => r.symbol);
console.log(`样本币种数: ${symbols.length}`);

const kRes = await client.query(`
  select symbol, open_time, open, high, low, close, volume
  from market_klines where interval = '5m' and symbol = any($1::text[])
  order by symbol, open_time asc`, [symbols]);
await client.end();

const bySymbol = new Map();
for (const row of kRes.rows) {
  if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
  bySymbol.get(row.symbol).push({
    openTime: Number(row.open_time), open: +row.open, high: +row.high,
    low: +row.low, close: +row.close, volume: +row.volume
  });
}

const gates = {};
let total = 0, signals = 0;
const signalRows = [];
const rrSamples = [];
const netSamples = [];

for (const [symbol, bars] of bySymbol) {
  for (let end = WINDOW; end <= bars.length; end += STEP) {
    const window = bars.slice(end - WINDOW, end);
    if (window.length < 50) continue;
    total++;
    let res;
    try {
      res = enhancedAnalysis({ symbol, interval: '5m', klines: window });
    } catch (e) {
      gates['EXCEPTION:' + e.message.slice(0, 40)] = (gates['EXCEPTION:' + e.message.slice(0, 40)] || 0) + 1;
      continue;
    }
    if (res.action === 'WAIT') {
      const g = classify(res.reason);
      gates[g] = (gates[g] || 0) + 1;
    } else {
      signals++;
      gates['__SIGNAL__'] = (gates['__SIGNAL__'] || 0) + 1;
      const nrr = netRR(res.plan, res.action);
      if (nrr !== null) netSamples.push(nrr);
      if (res.plan?.riskRewardRatio) rrSamples.push(res.plan.riskRewardRatio);
      signalRows.push({
        symbol, action: res.action, score: res.trendScore?.score,
        rr: res.plan?.riskRewardRatio, net: nrr,
        tp: res.plan?.takeProfit, sl: res.plan?.stopLoss,
        entryMin: res.plan?.entryMin, entryMax: res.plan?.entryMax,
        lev: res.plan?.recommendedLeverage
      });
    }
  }
}

console.log(`\n扫描窗口总数: ${total}`);
console.log(`生成信号数: ${signals}  (通过率 ${(signals / total * 100).toFixed(2)}%)`);
console.log('\n--- 各门槛拦截次数 ---');
const sorted = Object.entries(gates).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) console.log(`${k.padEnd(28)} ${String(v).padStart(7)}  ${(v / total * 100).toFixed(2)}%`);

if (signalRows.length) {
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`\n--- 信号质量 ---`);
  console.log(`plan.riskRewardRatio  均值 ${avg(rrSamples).toFixed(3)}  中位 ${med(rrSamples).toFixed(3)}  min ${Math.min(...rrSamples).toFixed(3)}`);
  console.log(`netRewardRisk(复算)   均值 ${avg(netSamples).toFixed(3)}  中位 ${med(netSamples).toFixed(3)}  min ${Math.min(...netSamples).toFixed(3)}  max ${Math.max(...netSamples).toFixed(3)}`);
  console.log(`触发信号币种数: ${new Set(signalRows.map(r => r.symbol)).size} / ${bySymbol.size}`);
  console.log('\n前 25 条信号样本:');
  for (const r of signalRows.slice(0, 25)) {
    console.log(`${r.symbol.padEnd(12)} ${r.action} score=${String(r.score).padStart(3)} rr=${r.rr?.toFixed(2)} net=${r.net?.toFixed(2)} lev=${r.lev}x`);
  }
}
