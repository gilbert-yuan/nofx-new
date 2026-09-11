/**
 * 回测数据抓取 v2：随机 50 个 OKX USDT 永续，拉近 30 天 1m K 线
 *
 * 关键约束：
 *   1. /api/v5/market/candles 只能回溯约 1 天 → 必须用 history-candles（每页上限 100 根）
 *   2. 30 天 1m = 43200 根 → 文档称每页上限 100 根，实测 limit=300 可用（返回 300 根，>300 截断）
 *      → 每币 144 次请求；50 币共约 7200 次请求
 *   3. OKX 对历史 K 线有速率限制，裸并发 14 会被 429 打回 → 改成「分段并行 + 全局令牌桶限速」
 *
 * 分页语义（OKX v5，与直觉相反，实测确认）：
 *   after=X  → 返回**早于** X 的数据（往前翻）
 *   before=X → 返回**晚于** X 的数据（往后翻）
 *
 * 分段：每币切成 SEG 段，段内用 after 往前翻，段间并行 → 单币墙钟时间降到 1/SEG。
 *
 * 输出：data/backtest/klines/<SYMBOL>.ndjson（每行 t,o,h,l,c,v）+ meta.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { OkxClient } from '../server/okxClient.js';

const DAYS = Number(process.env.BT_DAYS ?? 30);
const COUNT = Number(process.env.BT_COUNT ?? 50);
const SEED = Number(process.env.BT_SEED ?? 20260911);
const SEG = Number(process.env.BT_SEG ?? 8);          // 每币分段数
const WORKERS = Number(process.env.BT_WORKERS ?? 16); // 段任务并发
const RPS = Number(process.env.BT_RPS ?? 15);         // 全局速率上限
const PAGE = Number(process.env.BT_PAGE ?? 300);      // 每页根数（实测 300 可用，文档只写 100）
const OUT = path.resolve('data/backtest');
const KDIR = path.join(OUT, 'klines');
fs.mkdirSync(KDIR, { recursive: true });

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 全局令牌桶 ──
let tokens = RPS, lastRefill = Date.now(), reqCount = 0, err429 = 0;
async function acquire() {
  const now = Date.now();
  tokens = Math.min(RPS, tokens + ((now - lastRefill) / 1000) * RPS);
  lastRefill = now;
  if (tokens < 1) {
    await sleep(Math.ceil(((1 - tokens) / RPS) * 1000));
    return acquire();
  }
  tokens -= 1;
}

const client = new OkxClient({ proxyUrl: 'http://127.0.0.1:7890' });

async function requestPage(instId, cursor) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await acquire();
    reqCount++;
    try {
      const raw = await client.publicRequest('/api/v5/market/history-candles', {
        instId, bar: '1m', limit: PAGE, ...(cursor ? { after: cursor } : {})
      });
      if (!Array.isArray(raw)) return [];
      return raw.map(r => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])])
        .filter(r => Number.isFinite(r[0]) && Number.isFinite(r[4]) && r[4] > 0)
        .sort((a, b) => a[0] - b[0]);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/429|Too Many|Rate limit/i.test(msg)) { err429++; await sleep(1200 * attempt); continue; }
      if (attempt >= 6) throw e;
      await sleep(400 * attempt);
    }
  }
  return [];
}

async function fetchSegment(instId, segStart, segEnd, globalEnd) {
  const byTime = new Map();
  let cursor = segEnd;
  let pages = 0;
  while (true) {
    const rows = await requestPage(instId, cursor);
    if (!rows.length) break;
    let minT = Infinity;
    for (const r of rows) {
      if (r[0] >= segStart && r[0] < globalEnd) byTime.set(r[0], r);
      if (r[0] < minT) minT = r[0];
    }
    pages++;
    if (minT <= segStart) break;
    if (minT >= cursor) break;
    cursor = minT;
    if (pages > 220) break;
  }
  return byTime;
}

async function fetchSymbol(c) {
  const file = path.join(KDIR, `${c.symbol}.ndjson`);
  if (fs.existsSync(file) && fs.statSync(file).size > barsTarget * 30) {
    return { symbol: c.symbol, bars: 'cached', skipped: true };
  }
  const segLen = Math.ceil((endTs - startTs) / SEG);
  const segs = [];
  for (let k = 0; k < SEG; k++) {
    const s = startTs + k * segLen;
    if (s >= endTs) break;
    segs.push([s, Math.min(s + segLen, endTs)]);
  }
  const merged = new Map();
  const results = await Promise.all(segs.map(([s, e]) => fetchSegment(c.instId, s, e, endTs)));
  for (const m of results) for (const [t, r] of m) merged.set(t, r);
  const all = [...merged.values()].filter(r => r[0] >= startTs && r[0] < endTs).sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(file, all.map(r => r.join(',')).join('\n') + '\n');
  return { symbol: c.symbol, bars: all.length };
}

// ── 1. 选币 ──
console.log('[1/3] 获取合约列表与成交额…');
const contracts = await client.perpetualUsdtContracts();
const tickers = await client.publicRequest('/api/v5/market/tickers', { instType: 'SWAP' });
const volMap = new Map(tickers.map(t => [t.instId, Number(t.volCcy24h || 0)]));
const universe = contracts.map(c => ({ symbol: c.symbol, instId: c.instId, vol24h: volMap.get(c.instId) || 0 }))
  .filter(c => c.vol24h > 0).sort((a, b) => a.symbol.localeCompare(b.symbol));
console.log(`  可交易 USDT 永续：${universe.length} 个（24h 成交额区间 ${Math.min(...universe.map(u => u.vol24h)).toExponential(2)} ~ ${Math.max(...universe.map(u => u.vol24h)).toExponential(2)}）`);

const pool = universe.slice();
for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[pool[i], pool[j]] = [pool[j], pool[i]]; }
const picked = pool.slice(0, COUNT);
console.log(`[2/3] 随机抽定 ${picked.length} 个：${picked.map(p => p.symbol).join(', ')}`);

const endTs = Date.now();
const startTs = endTs - DAYS * 86400000;
const barsTarget = Math.floor(DAYS * 1440);

// ── 2. 抓取（段任务并发 WORKERS）──
console.log(`[3/3] 拉取 ${DAYS} 天 1m（目标 ${barsTarget} 根/币，${SEG} 段并行，段并发 ${WORKERS}，限速 ${RPS} req/s）…`);
const results = [];
let done = 0, t0 = Date.now();
const queue = picked.slice();
async function worker() {
  while (queue.length) {
    const c = queue.shift();
    if (!c) return;
    try {
      const r = await fetchSymbol(c);
      results.push({ ...r, instId: c.instId, vol24h: c.vol24h });
    } catch (e) {
      results.push({ symbol: c.symbol, instId: c.instId, vol24h: c.vol24h, error: String(e?.message || e).slice(0, 80) });
    }
    done++;
    const el = (Date.now() - t0) / 1000;
    console.log(`  ${String(done).padStart(2)}/${picked.length} ${c.symbol.padEnd(11)} ${String(results.at(-1).bars ?? 'ERR').padStart(6)} 根  ${el.toFixed(0)}s  req=${reqCount} 429=${err429}`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));

// ── 3. 补齐数据不足的 ──
const short = results.filter(r => r.error || (r.bars !== 'cached' && Number(r.bars) < barsTarget * 0.95));
if (short.length) {
  console.log(`\n数据不足 ${short.length} 个，从候选池补齐…`);
  const backup = pool.slice(COUNT);
  for (const bad of short) {
    if (!backup.length) break;
    const c = backup.shift();
    try {
      const r = await fetchSymbol(c);
      if (!r.error && Number(r.bars) >= barsTarget * 0.95) {
        results.push({ ...r, instId: c.instId, vol24h: c.vol24h });
        console.log(`  补 ${c.symbol}: ${r.bars} 根`);
      }
    } catch { /* 忽略 */ }
  }
}

const okList = results.filter(r => !r.error && r.bars !== undefined);
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), days: DAYS, seed: SEED, interval: '1m',
  startTs, endTs, barsTarget, requests: reqCount, err429,
  symbols: results.map(r => ({ symbol: r.symbol, instId: r.instId, vol24h: r.vol24h, bars: r.bars, error: r.error }))
}, null, 2));

const failed = results.filter(r => r.error);
console.log(`\n完成：${okList.length} 个币种成功，失败 ${failed.length}，请求 ${reqCount} 次（429 命中 ${err429}），用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
if (failed.length) console.log('失败:', failed.map(f => `${f.symbol}(${f.error})`).join(', '));
