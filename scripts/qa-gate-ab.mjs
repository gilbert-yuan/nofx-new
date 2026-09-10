// QA V1 A/B：在完全相同的真实历史 K 线上，逐项放宽新门槛，定位"哪道门槛卡死"。
// 通过 env 覆盖（NOFX_*）+ 源码字符串替换生成变体，动态导入，不修改原文件、不重启服务。
import { Client } from 'pg';
import { readFile } from 'node:fs/promises';

const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';
const WINDOW = 80;
const STEP = Number(process.env.QA_STEP || 4);
const IV = process.env.QA_INTERVAL || '5m';
const MAXSYM = Number(process.env.QA_SYMBOLS || 460);

const SRC = await readFile(new URL('../server/enhancedAnalysis.js', import.meta.url), 'utf8');
const IND_URL = new URL('../server/advancedIndicators.js', import.meta.url).href;
const UNDICI_URL = import.meta.resolve('undici');

let src = SRC
  .replace("'./advancedIndicators.js'", JSON.stringify(IND_URL))
  .replace("'undici'", JSON.stringify(UNDICI_URL));
if (src.includes("from 'undici'")) throw new Error('undici import 替换失败');
if (!src.includes(IND_URL)) throw new Error('advancedIndicators import 替换失败');

// 变体：env 覆盖 + 源码替换
const VARIANTS = {
  'NEW(当前改动)': { env: {}, patch: s => s },
  'RR门槛回落1.2': { env: { NOFX_MIN_RR: '1.2' }, patch: s => s },
  '评分门槛回落60': { env: { NOFX_MIN_TREND_SCORE: '60' }, patch: s => s },
  '关闭量能确认': { env: {}, patch: s => s.replace('const REQUIRE_VOLUME_CONFIRM = true;', 'const REQUIRE_VOLUME_CONFIRM = false;') },
  '去掉量比>=1.2拦截': { env: {}, patch: s => s.replace('volumeAnalysis.volumeRatio >= 1.2', 'false') },
  '主止盈回落2R': { env: { NOFX_MAIN_TP_R: '2.0' }, patch: s => s },
  'RR改用旧entryMax口径': {
    env: {},
    patch: s => s.replace('const risk = Math.abs(close - stopLoss);',
      "const risk = Math.abs((direction === 'long' ? entryMax : entryMin) - stopLoss);")
  },
  '全旧基线(改前)': {
    env: { NOFX_MIN_RR: '1.2', NOFX_MIN_TREND_SCORE: '60', NOFX_MAIN_TP_R: '2.0' },
    patch: s => s
      .replace('const REQUIRE_VOLUME_CONFIRM = true;', 'const REQUIRE_VOLUME_CONFIRM = false;')
      .replace('const risk = Math.abs(close - stopLoss);',
        "const risk = Math.abs((direction === 'long' ? entryMax : entryMin) - stopLoss);")
  }
};

async function loadVariant(name) {
  for (const k of Object.keys(process.env)) if (k.startsWith('NOFX_')) delete process.env[k];
  Object.assign(process.env, VARIANTS[name].env);
  const code = VARIANTS[name].patch(src);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  return mod.enhancedAnalysis;
}

function classify(reason) {
  const r = String(reason || '');
  if (r.includes('需要至少50根')) return 'data_insufficient';
  if (r.includes('波动率过高')) return 'volatility_high';
  if (r.includes('波动率过低')) return 'volatility_low';
  if (r.includes('均线纠缠')) return 'ma_tangled';
  if (r.includes('RSI')) return 'rsi_filter';
  if (r.includes('成交量不足')) return 'volume_confirm_lt_0p8';
  if (r.includes('成交量放大')) return 'volume_spike_ge_1p2';
  if (r.includes('综合信号强度不足')) return 'trend_score_gate';
  if (r.includes('缺少关键确认信号')) return 'no_direction_confirm';
  if (r.includes('做空信号暂时禁用')) return 'short_disabled';
  if (r.includes('避免追高') || r.includes('避免追空')) return 'extension_1p5atr';
  if (r.includes('风险收益比不足')) return 'rr_gate';
  return 'other:' + r.slice(0, 24);
}

const client = new Client({ connectionString: DB });
await client.connect();
const kRes = await client.query(
  `select symbol, open_time, open, high, low, close, volume from market_klines
   where interval = $1 order by symbol, open_time asc`, [IV]);
await client.end();

const bySymbol = new Map();
for (const row of kRes.rows) {
  if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
  bySymbol.get(row.symbol).push({
    openTime: Number(row.open_time), open: +row.open, high: +row.high,
    low: +row.low, close: +row.close, volume: +row.volume
  });
}
let usable = [...bySymbol.entries()].filter(([, b]) => b.length >= WINDOW);
usable = usable.slice(0, MAXSYM);
const windows = usable.reduce((s, [, b]) => s + Math.floor((b.length - WINDOW) / STEP) + 1, 0);
console.log(`周期=${IV}  币种=${bySymbol.size}  取样=${usable.length}  步进=${STEP}  窗口总数=${windows}`);

const results = {};
for (const name of Object.keys(VARIANTS)) {
  const fn = await loadVariant(name);
  const gates = {};
  let total = 0, sig = 0;
  const rrList = [];
  for (const [symbol, bars] of usable) {
    for (let end = WINDOW; end <= bars.length; end += STEP) {
      const w = bars.slice(end - WINDOW, end);
      total++;
      const res = fn({ symbol, interval: IV, klines: w });
      if (res.action === 'WAIT') {
        const g = classify(res.reason);
        gates[g] = (gates[g] || 0) + 1;
      } else {
        sig++;
        if (Number.isFinite(res.plan?.riskRewardRatio)) rrList.push(res.plan.riskRewardRatio);
      }
    }
  }
  results[name] = { total, sig, gates, rrList };
  console.log(`  ...${name} 完成: ${sig}/${total}`);
}

console.log(`\n${'变体'.padEnd(22)} ${'信号数'.padStart(7)} ${'通过率'.padStart(8)}   相对NEW`);
const base = results['NEW(当前改动)'].sig || 1;
for (const [name, r] of Object.entries(results)) {
  console.log(`${name.padEnd(22)} ${String(r.sig).padStart(7)} ${(r.sig / r.total * 100).toFixed(2).padStart(7)}%   ${(r.sig / base).toFixed(2)}x`);
}

console.log('\n--- NEW 变体各门槛拦截明细 ---');
const g = results['NEW(当前改动)'].gates;
for (const [k, v] of Object.entries(g).sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(24)} ${String(v).padStart(7)}  ${(v / results['NEW(当前改动)'].total * 100).toFixed(2)}%`);
}
const rr = results['NEW(当前改动)'].rrList;
if (rr.length) {
  const avg = rr.reduce((a, b) => a + b, 0) / rr.length;
  const s = [...rr].sort((a, b) => a - b);
  console.log(`\nNEW 信号 plan.riskRewardRatio: n=${rr.length} 均值=${avg.toFixed(3)} 中位=${s[Math.floor(rr.length / 2)].toFixed(3)} min=${s[0].toFixed(3)} max=${s.at(-1).toFixed(3)}`);
}
