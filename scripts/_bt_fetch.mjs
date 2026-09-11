/**
 * 回测数据抓取：随机 50 个 OKX USDT 永续，拉近 30 天 1m K 线
 *
 * 接口说明：
 *   /api/v5/market/candles          —— 只能回溯约 1 天（1440 根 1m），不够用
 *   /api/v5/market/history-candles  —— 可回溯数月，但每页上限 100 根
 * 因此 30 天 = 43200 根 → 每币约 432 页。
 *
 * 分页语义（OKX v5，与直觉相反）：after = 返回**早于**该时间戳的数据。
 *
 * 输出：data/backtest/klines/<SYMBOL>.ndjson（每行 {t,o,h,l,c,v}）
 *      data/backtest/meta.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { OkxClient } from '../server/okxClient.js';

const DAYS = Number(process.env.BT_DAYS ?? 30);
const COUNT = Number(process.env.BT_COUNT ?? 50);
const SEED = Number(process.env.BT_SEED ?? 20260911);
const CONCURRENCY = Number(process.env.BT_CONCURRENCY ?? 8);
const OUT = path.resolve('data/backtest');
const KDIR = path.join(OUT, 'klines');
fs.mkdirSync(KDIR, { recursive: true });

// 可复现随机（mulberry32）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

const client = new OkxClient({ proxyUrl: 'http://127.0.0.1:7890' });

console.log('[1/3] 获取合约列表与成交额…');
const contracts = await client.perpetualUsdtContracts();
const tickers = await client.publicRequest('/api/v5/market/tickers', { instType: 'SWAP' });
const volMap = new Map(tickers.map(t => [t.instId, Number(t.volCcy24h || 0)]));
const universe = contracts
  .map(c => ({ symbol: c.symbol, instId: c.instId, vol24h: volMap.get(c.instId) || 0 }))
  .filter(c => c.vol24h > 0)
  .sort((a, b) => a.symbol.localeCompare(b.symbol));
console.log(`  可交易 USDT 永续：${universe.length} 个`);

// 随机抽 COUNT 个（Fisher-Yates，用可复现随机）
const pool = universe.slice();
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
let picked = pool.slice(0, COUNT);
console.log(`[2/3] 随机抽定 ${picked.length} 个：${picked.map(p => p.symbol).join(', ')}`);

const endTs = Date.now();
const startTs = endTs - DAYS * 86400000;
const barsTarget = Math.floor(DAYS * 1440);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHistory(c, cursorEnd) {
  // cursorEnd: 从该时间戳往回翻（exclusive）
  const raw = await client.publicRequest('/api/v5/market/history-candles', {
    instId: c.instId, bar: '1m', limit: 100, ...(cursorEnd ? { after: cursorEnd } : {})
  });
  if (!Array.isArray(raw)) return [];
  return raw.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])])
    .filter(r => Number.isFinite(r[0]) && Number.isFinite(r[4]) && r[4] > 0)
    .sort((a, b) => a[0] - b[0]);
}

async function fetchSymbol(c) {
  const file = path.join(KDIR, `${c.symbol}.ndjson`);
  // 断点续传：已有文件且覆盖到起点则跳过
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (st.size > barsTarget * 30) return { symbol: c.symbol, bars: 'cached', skipped: true };
  }
  const byTime = new Map();
  let cursor = null;
  let pages = 0;
  let retries = 0;
  while (true) {
    let rows;
    try {
      rows = await fetchHistory(c, cursor);
      retries = 0;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/429|Too Many|Rate/i.test(msg) || e?.status === 429) {
        await sleep(1500 * (++retries));
        if (retries > 6) throw e;
        continue;
      }
      if (retries++ > 4) throw e;
      await sleep(500 * retries);
      continue;
    }
    if (!rows.length) break;
    let minT = Infinity;
    for (const r of rows) { byTime.set(r[0], r); if (r[0] < minT) minT = r[0]; }
    pages++;
    if (minT <= startTs) break;
    if (minT >= (cursor ?? Infinity)) break; // 没再前进，防死循环
    cursor = minT;
    if (pages > barsTarget / 100 + 60) break;
  }
  const all = [...byTime.values()].filter(r => r[0] >= startTs && r[0] < endTs).sort((a, b) => a[0] - b[0]);
  const lines = all.map(r => `${r[0]},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { symbol: c.symbol, bars: all.length, pages };
}

console.log(`[3/3] 拉取 ${DAYS} 天 1m 数据（目标 ${barsTarget} 根/币，并发 ${CONCURRENCY}）…`);
const results = [];
let done = 0;
const queue = picked.slice();
const t0 = Date.now();
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    if (!c) return;
    try {
      const r = await fetchSymbol(c);
      results.push({ ...r, instId: c.instId, vol24h: c.vol24h });
    } catch (e) {
      results.push({ symbol: c.symbol, instId: c.instId, vol24h: c.vol24h, error: String(e?.message || e) });
    }
    done++;
    const pct = ((done / picked.length) * 100).toFixed(0);
    process.stdout.write(`\r  进度 ${done}/${picked.length} (${pct}%)  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s      `);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log('');

// 数据不足的用候选池补齐（最多补 10 个）
const short = results.filter(r => r.error || (r.bars !== 'cached' && r.bars < barsTarget * 0.95));
if (short.length) {
  console.log(`数据不足 ${short.length} 个，尝试从候选池补齐…`);
  const backup = pool.slice(COUNT);
  for (const bad of short) {
    if (!backup.length) break;
    const c = backup.shift();
    try {
      const r = await fetchSymbol(c);
      results.push({ ...r, instId: c.instId, vol24h: c.vol24h });
      console.log(`  补 ${c.symbol}: ${r.bars} 根`);
    } catch (e) { /* 忽略 */ }
  }
}

const ok = results.filter(r => !r.error && r.bars !== undefined);
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), days: DAYS, seed: SEED, interval: '1m',
  startTs, endTs, barsTarget,
  symbols: results.map(r => ({ symbol: r.symbol, instId: r.instId, vol24h: r.vol24h, bars: r.bars, error: r.error }))
}, null, 2));

const cached = results.filter(r => r.skipped).length;
const failed = results.filter(r => r.error);
console.log(`完成：成功 ${ok.length - cached} 拉取 + ${cached} 缓存，失败 ${failed.length}，用时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`);
if (failed.length) console.log('失败:', failed.map(f => `${f.symbol}(${f.error.slice(0, 40)})`).join(', '));
const barCounts = results.filter(r => typeof r.bars === 'number').map(r => r.bars);
if (barCounts.length) console.log(`根数分布 min=${Math.min(...barCounts)} max=${Math.max(...barCounts)} 中位=${barCounts.sort((a, b) => a - b)[barCounts.length >> 1]}`);
