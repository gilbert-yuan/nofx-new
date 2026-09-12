/**
 * 每日趋势 SQL 版 vs 旧 JS 版 口径对拍（跑在真实生产数据上）。
 *
 * 目的：SQL 改写最怕「数字悄悄变了」。这里直接拉两个端点：
 *   · GET /api/paper/statistics  → byDay（旧 computeStatistics，纯 JS 归约）
 *   · GET /api/paper/daily-trend → byDay（新 dailyTrend.js，单条 SQL 聚合）
 * 逐日逐字段比对，任何一处不等都打印出来并以非 0 退出。
 *
 * 用法：node scripts/_smoke_daily_trend_parity.mjs
 */
const BASE = process.env.NOFX_BASE || 'http://127.0.0.1:3100';

const FIELDS = ['count', 'wins', 'winRate', 'totalNet', 'avgNet', 'avgWin',
  'totalGross', 'totalFees', 'totalFunding',
  'longCount', 'shortCount', 'stoppedCount', 'takeProfitCount'];

const get = async (path, timeoutMs = 120000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
};

const t0 = Date.now();
const legacy = await get('/api/paper/statistics');
const tLegacy = Date.now() - t0;

const t1 = Date.now();
const sql = await get('/api/paper/daily-trend');
const tSql = Date.now() - t1;

const legacyByDay = legacy.byDay || [];
const sqlByDay = sql.byDay || [];

console.log(`旧 JS 统计: ${tLegacy}ms · byDay ${legacyByDay.length} 天`);
console.log(`SQL 聚合  : ${tSql}ms · byDay ${sqlByDay.length} 天 (source=${sql.source})`);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures++;
};

check('日期桶数量一致', legacyByDay.length === sqlByDay.length, `js=${legacyByDay.length} sql=${sqlByDay.length}`);

const legacyByDate = new Map(legacyByDay.map(d => [d.date, d]));
const sqlByDate = new Map(sqlByDay.map(d => [d.date, d]));
const missing = [...legacyByDate.keys()].filter(k => !sqlByDate.has(k));
check('无缺失日期桶', missing.length === 0, missing.join(','));

const EPS = 1e-9;
for (const [date, a] of legacyByDate) {
  const b = sqlByDate.get(date);
  if (!b) continue;
  for (const key of FIELDS) {
    const av = Number(a[key] ?? 0), bv = Number(b[key] ?? 0);
    if (Math.abs(av - bv) > EPS) {
      failures++;
      console.log(`FAIL  ${date}.${key}: js=${av} sql=${bv} diff=${av - bv}`);
    }
  }
}
check('全部日级指标逐字段一致（容差 1e-9）', failures === 0, failures ? `${failures} 处不一致` : '');

// 汇总口径
const s = sql.summary || {};
const jsTotalNet = legacyByDay.reduce((acc, d) => acc + Number(d.totalNet || 0), 0);
const jsCount = legacyByDay.reduce((acc, d) => acc + Number(d.count || 0), 0);
check('汇总 totalNetDailySum 一致', Math.abs(Number(s.totalNetDailySum || 0) - jsTotalNet) < 1e-6,
  `js=${jsTotalNet} sql=${s.totalNetDailySum}`);
check('汇总单数一致', Number(s.closedOrders || 0) === jsCount, `js=${jsCount} sql=${s.closedOrders}`);
check('汇总 totalOrders 一致', Number(s.totalOrders || 0) === Number(legacy.summary?.totalOrders || 0),
  `js=${legacy.summary?.totalOrders} sql=${s.totalOrders}`);
check('汇总 activeOrders 一致', Number(s.activeOrders || 0) === Number(legacy.summary?.activeOrders || 0),
  `js=${legacy.summary?.activeOrders} sql=${s.activeOrders}`);

console.log(`\n提速：${tLegacy}ms → ${tSql}ms（${(tLegacy / Math.max(1, tSql)).toFixed(1)}×）`);
console.log(failures === 0 ? '\n✅ 口径完全一致' : `\n❌ 共 ${failures} 处不一致`);
process.exit(failures === 0 ? 0 : 1);
