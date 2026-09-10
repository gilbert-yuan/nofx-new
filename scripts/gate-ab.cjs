/**
 * 闸门 A/B：在真实最新行情上，对比「旧参数」与「新参数」下 enhancedAnalysis 的出单率，
 * 确认新过滤器不会把系统打成 0 单，并观察各闸门拦截占比。
 * 只读数据库。
 */
const { Client } = require('pg');
const DB = 'postgres://postgres:admin@127.0.0.1:5432/nofx_lite';

const OLD = { NOFX_MIN_ATR_PCT: '0.0005', NOFX_MIN_RSI_LONG: '40', NOFX_MAX_RSI_SHORT: '60' };
const NEW = { NOFX_MIN_ATR_PCT: '0.003', NOFX_MIN_RSI_LONG: '50', NOFX_MAX_RSI_SHORT: '55' };

async function run(label, env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // 环境变量在模块加载时读取，必须每次重新 import（加时间戳绕过缓存）
  const mod = await import(`../server/enhancedAnalysis.js?t=${Date.now()}_${label}`);
  const { prepareMarket, nextOpenTime } = await import('../server/research.js');

  const c = new Client(DB);
  await c.connect();
  const syms = (await c.query(
    `SELECT symbol, count(*) n FROM market_klines WHERE interval='1m' GROUP BY symbol HAVING count(*)>=80`)).rows;

  let eligible = 0, total = 0;
  const reasons = new Map();
  const hits = [];
  for (const s of syms) {
    const rows = (await c.query(
      `SELECT open_time, open, high, low, close, volume FROM market_klines
       WHERE symbol=$1 AND interval='1m' ORDER BY open_time DESC LIMIT 120`, [s.symbol])).rows
      .reverse()
      .map(r => ({ openTime: Number(r.open_time), open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
    if (rows.length < 80) continue;
    let market;
    try {
      // 本地快照未必与"此刻"对齐（同步可能滞后），把 now 锚到最后一根已收盘K线的收盘时刻，
      // 以便通过 prepareMarket 的"行情已过期"校验；这不影响被评估的那根K线。
      const now = nextOpenTime(rows.at(-1).openTime, '1m');
      market = prepareMarket({ symbol: s.symbol, interval: '1m', rows, limit: 80, now, throwOnInsufficient: true });
    } catch { continue; }
    total++;
    let r;
    try { r = mod.enhancedAnalysis(market); } catch (e) { r = { action: 'ERROR', reason: 'EXC:' + e.message }; }
    // enhancedAnalysis 返回的信号对象本身没有 eligible 字段（由后续 normalizePlan 补上），
    // 因此这里以 action 判定是否出单。
    if (r && ['BUY', 'SELL'].includes(r.action) && r.plan) {
      eligible++;
      const a = r.plan?.indicators?.atr;
      const c2 = market.klines.at(-1).close;
      hits.push({ symbol: s.symbol, action: r.action, atrPct: a && c2 ? a / c2 : null });
      continue;
    }
    const key = String(r?.reason || 'unknown').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').slice(0, 34);
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  await c.end();
  console.log(`\n=== ${label} ===`);
  console.log(`可分析币种 ${total} | 合格出单 ${eligible} (${(100 * eligible / total).toFixed(1)}%)`);
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [k, v] of top) console.log(`   拦截 ${String(v).padStart(4)}  ${k}`);
  if (hits.length) {
    const arr = hits.map(h => h.atrPct).filter(v => v != null);
    console.log(`   出单标的 ATR%: ${arr.map(v => (100 * v).toFixed(3)).join(', ')}`);
    if (arr.length) console.log(`   出单标的平均 ATR% = ${(100 * arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)}%`);
  }
  return { total, eligible };
}

(async () => {
  const oldR = await run('旧参数(基线)', OLD);
  const newR = await run('新参数(P4)', NEW);
  console.log(`\n=== 结论 ===`);
  console.log(`出单率：${(100 * oldR.eligible / oldR.total).toFixed(1)}% → ${(100 * newR.eligible / newR.total).toFixed(1)}%`);
  console.log(`绝对出单数：${oldR.eligible} → ${newR.eligible}`);
})().catch(e => { console.error('ERR', e); process.exit(1); });
