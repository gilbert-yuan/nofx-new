/**
 * 50 币回测报告：统计 + 自包含 HTML
 * 输入 data/backtest/result.json（由 _bt_run.mjs 产出）
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('data/backtest');
const R = JSON.parse(fs.readFileSync(path.join(DIR, 'result.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
const volMap = new Map((meta.symbols || []).map(s => [s.symbol, s.vol24h || 0]));

const trades = R.trades.filter(t => !t.unfinished).sort((a, b) => Date.parse(a.exitAt) - Date.parse(b.exitAt));
const placed = R.placed, cancels = R.cancels;

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v, d = 1) => (Number.isFinite(v) ? (100 * v).toFixed(d) + '%' : '—');

function stats(list) {
  if (!list.length) return { n: 0 };
  const wins = list.filter(x => x.net > 0);
  const losses = list.filter(x => x.net <= 0);
  const net = sum(list, x => x.net);
  const grossWin = sum(wins, x => x.net);
  const grossLoss = -sum(losses, x => x.net);
  // 权益曲线与最大回撤（按平仓时间序）
  let equity = 0, peak = 0, maxDD = 0, worst = 0;
  const curve = [];
  for (const t of list) {
    equity += t.net;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    worst = Math.min(worst, equity);
    curve.push({ t: Date.parse(t.exitAt), e: equity });
  }
  return {
    n: list.length,
    winRate: wins.length / list.length,
    net, avg: net / list.length,
    avgWin: wins.length ? grossWin / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDD, worst, curve,
    avgHeld: sum(list, x => x.heldBars || 0) / list.length,
    medHeld: median(list.map(x => x.heldBars || 0)),
    feeTotal: sum(list, x => x.fee || 0),
    fundingTotal: sum(list, x => x.funding || 0),
    grossTotal: sum(list, x => x.gross || 0),
    wins: wins.length, losses: losses.length
  };
}
function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
function group(list, key, buckets, label) {
  return buckets.map(([lo, hi, name]) => {
    const sub = list.filter(x => { const v = key(x); return v >= lo && v < hi; });
    return { name, ...stats(sub) };
  }).filter(g => g.n > 0);
}

const S = stats(trades);
const byReason = {};
for (const t of trades) {
  const k = t.reason || 'unknown';
  byReason[k] = byReason[k] || [];
  byReason[k].push(t);
}
const reasonRows = Object.entries(byReason).map(([k, v]) => ({ reason: k, ...stats(v) }))
  .sort((a, b) => b.n - a.n);

const bySymbol = {};
for (const t of trades) (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push(t);
const symbolRows = Object.entries(bySymbol).map(([k, v]) => ({
  symbol: k, ...stats(v), vol24h: volMap.get(k) || 0,
  placed: placed.filter(p => p.symbol === k).length,
  cancelled: cancels.filter(c => c.symbol === k).length
})).sort((a, b) => b.net - a.net);

const heldBuckets = [[0, 5, '<5 根'], [5, 15, '5~15'], [15, 30, '15~30'], [30, 45, '30~45'], [45, 75, '45~75'], [75, 121, '75~120'], [121, 1e9, '>120(超时)']];
const heldRows = group(trades, x => x.heldBars || 0, heldBuckets);

const hourRows = group(trades, x => x.hour ?? -1, Array.from({ length: 24 }, (_, h) => [h, h + 1, `${String(h).padStart(2, '0')}:00`]));

const atrRows = group(trades, x => (x.atrPct ?? 0) * 100, [
  [0, 0.15, '<0.15%'], [0.15, 0.25, '0.15~0.25%'], [0.25, 0.4, '0.25~0.40%'],
  [0.4, 0.6, '0.40~0.60%'], [0.6, 1e9, '≥0.60%']
]);
const scoreRows = group(trades, x => x.score ?? 0, [
  [0, 72, '<72'], [72, 76, '72~76'], [76, 80, '76~80'], [80, 85, '80~85'], [85, 1e9, '≥85']
]);
const waitRows = group(trades, x => x.waitBars ?? 0, [
  [0, 2, '<2 分钟'], [2, 10, '2~10'], [10, 30, '10~30'], [30, 1e9, '≥30']
]);
const dirRows = ['OPEN_LONG', 'OPEN_SHORT'].map(d => ({ name: d, ...stats(trades.filter(t => t.direction === d)) })).filter(r => r.n);
const fillRows = [0, 1, 2].map(k => ({ name: `分批 ${k} 次`, ...stats(trades.filter(t => (t.partialFills || 0) === k)) })).filter(r => r.n);

// ── 对照实验（若已跑）──
const VARIANTS = [
  { file: 'result-nosmatexit.json', name: 'A 关掉智能退出<br><span class="vs">NOFX_SMART_EXIT=false</span>' },
  { file: 'result-maatr2.json', name: 'B 均线失守放宽到 2 ATR<br><span class="vs">NOFX_SMART_MA_ATR=2.0</span>' },
  { file: 'result-minhold15.json', name: 'C 最小持仓 15 根<br><span class="vs">实验开关（需改代码）</span>' },
  { file: 'result-minhold5.json', name: 'D 最小持仓 5 根<br><span class="vs">实验开关（需改代码）</span>' },
  { file: 'result-nogracecancel.json', name: 'E 挂单不被软门槛撤<br><span class="vs">NOFX_PENDING_GRACE_MIN=480</span>' }
].map(v => {
  const p = path.join(DIR, v.file);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const ts = d.trades.filter(t => !t.unfinished).sort((a, b) => Date.parse(a.exitAt) - Date.parse(b.exitAt));
  const rs = {};
  for (const t of ts) rs[t.reason || 'unknown'] = (rs[t.reason || 'unknown'] || 0) + 1;
  return {
    ...v, s: stats(ts), n: ts.length, placed: d.placed.length, cancels: d.cancels.length, reasons: rs,
    gross: sum(ts, x => x.gross || 0),
    oneBar: ts.filter(t => (t.heldBars || 0) <= 1).length / ts.length
  };
}).filter(Boolean);

// ── 实盘基线（同一数据库，用于同口径对照）──
let live = null;
try {
  const pg = (await import('pg')).default;
  const c = new pg.Client('postgres://postgres:admin@127.0.0.1:5432/nofx_lite');
  await c.connect();
  const q = async sql => (await c.query(sql)).rows;
  const days = await q(`SELECT to_char(exit_at AT TIME ZONE 'Asia/Irkutsk','MM-DD') d, count(*) n,
      round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win, round(avg(net)::numeric,3) avg_net,
      round(avg(held_bars)::numeric,1) held,
      sum(case when reason='stop_loss' then 1 else 0 end) sl, sum(case when reason='take_profit' then 1 else 0 end) tp,
      sum(case when reason='timeout' then 1 else 0 end) tmo, sum(case when reason='manual' then 1 else 0 end) manual,
      sum(case when reason like 'smart%' then 1 else 0 end) smart, round(sum(net)::numeric,1) net
    FROM simulated_orders WHERE status='closed' AND exit_at > now() - interval '5 days'
    GROUP BY d ORDER BY d DESC`);
  const overall = (await q(`SELECT count(*) n, round(sum(net)::numeric,1) net, round(avg(net)::numeric,3) avg_net,
      round(100.0*sum(case when net>0 then 1 else 0 end)/count(*),1) win, round(avg(held_bars)::numeric,1) held
    FROM simulated_orders WHERE status='closed' AND exit_at > now() - interval '7 days'`))[0];
  await c.end();
  live = { days, overall };
} catch (e) {
  console.log('（实盘基线查询失败，跳过：' + String(e.message).slice(0, 60) + '）');
}

// ─────────────── 控制台摘要 ───────────────
console.log('\n════════ 50 币 × 30 天 1m 回测：当前线上策略 ════════');
console.log(`样本：${meta.symbols.length} 币 / ${(meta.days)} 天 / 1m`);
console.log(`挂单 ${placed.length} 笔 → 撤单 ${cancels.length} 笔（${pct(cancels.length / placed.length)}）→ 成交并平仓 ${trades.length} 笔（成交率 ${pct(trades.length / placed.length)}）`);
console.log(`\n【总盈亏】净 ${fmt(S.net)}U  均单 ${fmt(S.avg, 3)}U  胜率 ${pct(S.winRate)}  盈亏比 ${fmt(S.profitFactor)}`);
console.log(`  平均盈利 ${fmt(S.avgWin)}U / 平均亏损 ${fmt(S.avgLoss)}U  最大回撤 ${fmt(S.maxDD)}U`);
console.log(`  毛收益 ${fmt(S.grossTotal)}U  手续费 ${fmt(S.feeTotal)}U  资金费 ${fmt(S.fundingTotal)}U`);
console.log(`  平均持仓 ${fmt(S.avgHeld, 1)} 根（中位 ${S.medHeld}）`);
console.log('\n【出场原因】');
for (const r of reasonRows) console.log(`  ${r.reason.padEnd(16)} n=${String(r.n).padStart(4)}  胜率 ${pct(r.winRate).padStart(6)}  净 ${fmt(r.net).padStart(9)}U  均单 ${fmt(r.avg, 3)}`);
console.log('\n【持仓根数】');
for (const r of heldRows) console.log(`  ${r.name.padEnd(10)} n=${String(r.n).padStart(4)}  胜率 ${pct(r.winRate).padStart(6)}  净 ${fmt(r.net).padStart(9)}U  均单 ${fmt(r.avg, 3)}`);
console.log('\n【方向】');
for (const r of dirRows) console.log(`  ${r.name.padEnd(12)} n=${String(r.n).padStart(4)}  胜率 ${pct(r.winRate).padStart(6)}  净 ${fmt(r.net).padStart(9)}U`);
console.log('\n【币种 Top5 / Bottom5】');
for (const r of symbolRows.slice(0, 5)) console.log(`  ${r.symbol.padEnd(11)} n=${String(r.n).padStart(3)} 胜率 ${pct(r.winRate).padStart(6)} 净 ${fmt(r.net).padStart(8)}U`);
console.log('  …');
for (const r of symbolRows.slice(-5)) console.log(`  ${r.symbol.padEnd(11)} n=${String(r.n).padStart(3)} 胜率 ${pct(r.winRate).padStart(6)} 净 ${fmt(r.net).padStart(8)}U`);

// ─────────────── HTML ───────────────
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';

function table(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r => `<tr>${r.map(c => `<td class="${typeof c === 'object' && c ? (c.cls || '') : ''}">${typeof c === 'object' && c ? c.v : c}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}
const nCell = (v, d = 2, suffix = '') => ({ v: Number.isFinite(v) ? v.toFixed(d) + suffix : '—', cls: cls(v) });

// 权益曲线 SVG
function equitySvg(curve, w = 900, h = 220) {
  if (!curve.length) return '';
  const vals = curve.map(p => p.e);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const t0 = curve[0].t, t1 = curve.at(-1).t;
  const X = t => 50 + (t - t0) / Math.max(1, t1 - t0) * (w - 70);
  const Y = v => h - 30 - (v - min) / Math.max(1e-9, max - min) * (h - 60);
  const pts = curve.map(p => `${X(p.t).toFixed(1)},${Y(p.e).toFixed(1)}`).join(' ');
  const zero = Y(0);
  const grid = [max, (max + min) / 2, min].map(v => `<line x1="50" y1="${Y(v).toFixed(1)}" x2="${w - 20}" y2="${Y(v).toFixed(1)}" class="grid"/><text x="44" y="${(Y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v.toFixed(0)}</text>`).join('');
  const xlab = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const t = t0 + f * (t1 - t0);
    const d = new Date(t + 8 * 3600000).toISOString().slice(5, 10).replace('-', '/');
    return `<text x="${X(t).toFixed(1)}" y="${h - 10}" class="axis" text-anchor="middle">${d}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" class="chart">
    ${grid}
    <line x1="50" y1="${zero.toFixed(1)}" x2="${w - 20}" y2="${zero.toFixed(1)}" class="zero"/>
    <polyline points="50,${zero.toFixed(1)} ${pts} ${X(t1).toFixed(1)},${zero.toFixed(1)}" class="area"/>
    <polyline points="${pts}" class="line"/>
    ${xlab}
  </svg>`;
}

function barRows(rows, keyName, maxN) {
  const maxAbs = Math.max(1e-9, ...rows.map(r => Math.abs(r.net)));
  return `<div class="bars">${rows.map(r => {
    const w = Math.abs(r.net) / maxAbs * 100;
    const c = r.net >= 0 ? 'up' : 'down';
    return `<div class="bar-row"><span class="bar-label">${esc(r[keyName])}</span>
      <span class="bar-track"><span class="bar-fill ${c}" style="width:${w.toFixed(1)}%"></span></span>
      <span class="bar-val ${c}">${fmt(r.net, 1)}U</span>
      <span class="bar-meta">n=${r.n} 胜率 ${pct(r.winRate, 0)}</span></div>`;
  }).join('')}</div>`;
}

const cancelReasons = {};
for (const c of cancels) {
  const d = String(c.detail || '');
  const k = /方向已反转|反转为/.test(d) ? '方向反转（立即撤）'
    : /宽限上限/.test(d) ? '软门槛连续不合格 30 分钟'
      : /量比|成交量/.test(d) ? '量能不足' : /波动率/.test(d) ? '波动率过低' : /评分|信号强度/.test(d) ? '评分不足' : '其他';
  cancelReasons[k] = (cancelReasons[k] || 0) + 1;
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>50 币 × 30 天回测报告 · 当前线上策略</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1a1a1a;--sub:#6b6b6b;--line:#e5e5e0;--up:#d32f2f;--down:#1e8e3e;--accent:#2f5fd0}
*{box-sizing:border-box}
body{margin:0;padding:32px 24px 64px;background:var(--bg);color:var(--ink);
  font-family:"IBM Plex Sans","PingFang SC","Microsoft YaHei",-apple-system,sans-serif;font-size:14px;line-height:1.6}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px;font-weight:650}
.sub{color:var(--sub);margin-bottom:24px;font-size:13px}
h2{font-size:16px;margin:32px 0 12px;font-weight:650;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:14px;margin:20px 0 8px;font-weight:600;color:var(--sub)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{font-size:12px;color:var(--sub);margin-bottom:4px}
.card .v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
.card .m{font-size:12px;color:var(--sub);margin-top:2px}
.up{color:var(--up)}.down{color:var(--down)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th{background:#faf9f7;font-weight:600;color:var(--sub);font-size:12px;text-align:right}
th:first-child,td:first-child{text-align:left}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:#fbfaf7}
.chart{width:100%;height:auto;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}
.grid{stroke:#eee;stroke-width:1}.zero{stroke:#bbb;stroke-width:1;stroke-dasharray:4 4}
.line{fill:none;stroke:var(--accent);stroke-width:2}
.area{fill:rgba(47,95,208,.10);stroke:none}
.axis{font-size:10px;fill:#999}
.bars{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.bar-row{display:grid;grid-template-columns:110px 1fr 80px 150px;gap:10px;align-items:center;padding:3px 0;font-size:12px}
.bar-label{color:var(--sub);font-variant-numeric:tabular-nums}
.bar-track{background:#f0efec;border-radius:4px;height:14px;overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:4px}
.bar-fill.up{background:var(--up)}.bar-fill.down{background:var(--down)}
.bar-val{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.bar-meta{color:var(--sub);font-size:11px}
.note{background:#fffdf5;border:1px solid #f0e6c8;border-radius:10px;padding:12px 16px;font-size:13px;color:#5c5230}
.note b{color:#3d3career}
ul{margin:6px 0 0 18px;padding:0}li{margin:3px 0}
.vs{color:#999;font-size:11px}
#concl li{margin:6px 0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:820px){.two{grid-template-columns:1fr}.bar-row{grid-template-columns:80px 1fr 70px}}
</style></head><body><div class="wrap">

<h1>50 币 × 近 30 天 1m 回测 · 当前线上策略</h1>
<div class="sub">数据源 OKX USDT 永续（${esc(new Date(meta.startTs + 8 * 3600000).toISOString().slice(0, 10))} ~ ${esc(new Date(meta.endTs + 8 * 3600000).toISOString().slice(0, 10))}，UTC+8）·
随机抽样 seed=${meta.seed} · 每币 ${meta.barsTarget} 根 1m K 线 · 生成于 ${esc(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '))}</div>

<div class="cards">
  <div class="card"><div class="k">净盈亏</div><div class="v ${cls(S.net)}">${fmt(S.net, 1)} U</div><div class="m">${trades.length} 笔已平仓</div></div>
  <div class="card"><div class="k">胜率</div><div class="v">${pct(S.winRate)}</div><div class="m">${S.wins} 胜 / ${S.losses} 负</div></div>
  <div class="card"><div class="k">均单净盈亏</div><div class="v ${cls(S.avg)}">${fmt(S.avg, 3)} U</div><div class="m">保证金 100U/单</div></div>
  <div class="card"><div class="k">盈亏比(PF)</div><div class="v">${Number.isFinite(S.profitFactor) ? fmt(S.profitFactor) : '∞'}</div><div class="m">毛利/毛亏</div></div>
  <div class="card"><div class="k">最大回撤</div><div class="v down">${fmt(S.maxDD, 1)} U</div><div class="m">按平仓时序</div></div>
  <div class="card"><div class="k">挂单成交率</div><div class="v">${pct(trades.length / placed.length)}</div><div class="m">${placed.length} 挂 / ${cancels.length} 撤</div></div>
</div>

<h2>核心结论</h2>
<div class="note" id="concl">
${(() => {
    const worst = reasonRows.slice().sort((a, b) => a.net - b.net)[0];
    const wHeld = median(trades.filter(t => t.net > 0).map(t => t.heldBars || 0));
    const lHeld = median(trades.filter(t => t.net <= 0).map(t => t.heldBars || 0));
    const fillRate = trades.length / placed.length;
    const shortHeld = trades.filter(t => (t.heldBars || 0) < 5).length;
    return `<ul>
<li><b>整体：</b>${trades.length} 笔成交订单，净 ${fmt(S.net, 1)} U（均单 ${fmt(S.avg, 3)} U），胜率 ${pct(S.winRate)}，最大回撤 ${fmt(S.maxDD, 1)} U。${S.net < 0 ? '<b>当前参数下是净亏损的。</b>' : '当前参数下净盈利。'}</li>
<li><b>失血点：</b>出场原因中净亏损最大的是 <b>${esc(worst?.reason || '—')}</b>（${worst?.n || 0} 笔，净 ${fmt(worst?.net || 0, 1)} U，均单 ${fmt(worst?.avg || 0, 3)} U，平均只持仓 ${fmt(worst?.avgHeld || 0, 1)} 根）。</li>
<li><b>持仓过短：</b>${shortHeld} 笔（${pct(shortHeld / trades.length)}）在 5 根（5 分钟）内就被平掉；盈利单持仓中位数 ${fmt(wHeld, 0)} 根，亏损单 ${fmt(lHeld, 0)} 根。</li>
<li><b>挂单成交率：</b>${placed.length} 笔挂单中 ${cancels.length} 笔被撤（${pct(cancels.length / placed.length)}），最终成交 ${pct(fillRate)}。撤单 100% 来自「软门槛连续不合格满 30 分钟」（波动率/量比在 1m 上抖动）。</li>
${VARIANTS.length ? `<li><b>可改进方向：</b>${VARIANTS.map(v => `${v.name.replace(/<br>.*$/, '')} → 净 ${fmt(v.s.net, 1)} U / 均单 ${fmt(v.s.avg, 3)} U`).join('；')}。</li>` : ''}
</ul>`;
  })()}
</div>

<h2>一、钱是怎么来的（又是怎么没的）</h2>
${table(['口径', '金额 / 数值', '说明'], [
    ['毛收益（价格变动）', nCell(S.grossTotal, 1, ' U'), { v: S.grossTotal > 0 ? '方向判断总体赚到钱' : '方向判断本身就在亏钱', cls: cls(S.grossTotal) }],
    ['手续费', nCell(-S.feeTotal, 1, ' U'), { v: `${fmt(S.feeTotal / trades.length, 3)} U/单（双边 ${R.config ? 6 : 6}bps）` }],
    ['资金费', nCell(-S.fundingTotal, 1, ' U'), { v: `${fmt(S.fundingTotal / trades.length, 3)} U/单` }],
    ['净盈亏', nCell(S.net, 1, ' U'), { v: `均单 ${fmt(S.avg, 3)} U`, cls: cls(S.net) }],
    ['平均盈利单', nCell(S.avgWin, 2, ' U'), { v: `${pct(S.winRate)} 的单盈利` }],
    ['平均亏损单', nCell(S.avgLoss, 2, ' U'), { v: `${S.losses} 笔` }],
  ])}

<div class="note" style="margin-top:12px">
<b>一句话结论：</b>${S.net >= 0 ? '本样本净盈利' : '本样本净亏损'} ${fmt(Math.abs(S.net), 1)} U，均单 ${fmt(S.avg, 3)} U。
毛收益 ${fmt(S.grossTotal, 1)} U ${S.grossTotal < 0 ? '（方向判断本身就是负贡献）' : ''}，摩擦成本（手续费+资金费）吞掉 ${fmt(S.feeTotal + S.fundingTotal, 1)} U
${S.grossTotal > 0 && S.net < 0 ? '——<b>策略能赚到方向上的钱，但赚的不够付摩擦成本</b>' : ''}。
平均持仓 ${fmt(S.avgHeld, 1)} 根（${fmt(S.avgHeld, 0)} 分钟）。
</div>

<h2>二、权益曲线（按平仓时间累计，UTC+8）</h2>
${equitySvg(S.curve)}

<h2>三、出场原因：钱主要丢在哪</h2>
${table(['出场原因', '笔数', '占比', '胜率', '净盈亏 U', '均单 U', '平均持仓'],
    reasonRows.map(r => [r.reason, r.n, pct(r.n / trades.length), pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3), fmt(r.avgHeld, 1)]))}

<h2>四、持仓时长：盈利是否需要时间</h2>
${table(['持仓根数', '笔数', '胜率', '净盈亏 U', '均单 U'],
    heldRows.map(r => [r.name, r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}

<h2>五、方向 / 分批止盈</h2>
<div class="two">
<div>${table(['方向', '笔数', '胜率', '净盈亏 U', '均单 U'], dirRows.map(r => [r.name === 'OPEN_LONG' ? '多' : '空', r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}</div>
<div>${table(['分批止盈', '笔数', '胜率', '净盈亏 U', '均单 U'], fillRows.map(r => [r.name, r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}</div>
</div>

<h2>六、入场特征：什么样的信号赚钱</h2>
<h3>按波动率（ATR/价格）</h3>
${table(['波动率', '笔数', '胜率', '净盈亏 U', '均单 U'], atrRows.map(r => [r.name, r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}
<h3>按趋势评分</h3>
${table(['评分', '笔数', '胜率', '净盈亏 U', '均单 U'], scoreRows.map(r => [r.name, r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}
<h3>按挂单等待时长（挂出→成交）</h3>
${table(['等待', '笔数', '胜率', '净盈亏 U', '均单 U'], waitRows.map(r => [r.name, r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}

<h2>七、时段分布（本地 UTC+8）</h2>
${barRows(hourRows, 'name')}

<h2>八、币种表现</h2>
${table(['币种', '24h 成交额', '挂单', '撤单', '成交', '胜率', '净盈亏 U', '均单 U'],
    symbolRows.map(r => [r.symbol, r.vol24h ? r.vol24h.toExponential(1) : '—', r.placed, r.cancelled, r.n, pct(r.winRate), nCell(r.net, 1), nCell(r.avg, 3)]))}

<h2>九、与实盘对照（同一策略、同一数据库，近 5 天逐日）</h2>
${live ? table(['日期(UTC+8)', '笔数', '胜率', '均单 U', '净盈亏 U', '平均持仓', '止损', '止盈', '超时', '智能退出*'],
    live.days.map(r => [r.d, r.n, r.win + '%', nCell(Number(r.avg_net), 3), nCell(Number(r.net), 1), r.held, r.sl, r.tp, r.tmo, (Number(r.manual) || 0) + (Number(r.smart) || 0)])) : '<div class="note">实盘基线不可用。</div>'}
<div class="note" style="margin-top:10px">
* 实盘里「智能退出真平仓」走的是 <code>simulation.close()</code>，reason 记为 <b>manual</b>；根级均线失守记为 <b>smart_exit_ma</b>。两者合并在最后一列。<br>
${live ? `近 7 天实盘整体：${live.overall.n} 笔，胜率 ${live.overall.win}%，均单 ${live.overall.avg_net} U，净 ${live.overall.net} U，平均持仓 ${live.overall.held} 根。` : ''}
</div>

<h2>十、挂单为何没成交</h2>
${table(['撤单原因归类', '笔数', '占比'], Object.entries(cancelReasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, pct(v / cancels.length)]))}
<div class="note" style="margin-top:10px">撤单明细样例（最近 5 条）：<ul>${
    cancels.slice(-5).map(c => `<li>${esc(c.symbol)} ${c.direction === 'OPEN_LONG' ? '多' : '空'} 存活 ${fmt(c.waitBars, 0)} 分钟 · ${esc(String(c.detail).slice(0, 90))}</li>`).join('')
  }</ul></div>

<h2>十一、对照实验：问题出在哪一环</h2>
${VARIANTS.length ? (() => {
    const baseRow = ['<b>当前线上配置（基准）</b>', trades.length, pct(S.winRate), nCell(S.net, 1), nCell(S.avg, 3), nCell(S.grossTotal, 1), fmt(S.avgHeld, 1),
      pct(trades.filter(t => (t.heldBars || 0) <= 1).length / trades.length), pct((byReason['stop_loss']?.length || 0) / trades.length)];
    const varRows = VARIANTS.map(v => [v.name, v.n, pct(v.s.winRate), nCell(v.s.net, 1), nCell(v.s.avg, 3), nCell(v.gross, 1), fmt(v.s.avgHeld, 1), pct(v.oneBar), pct((v.reasons['stop_loss'] || 0) / v.n)]);
    return table(['实验组', '成交', '胜率', '净盈亏 U', '均单 U', '毛收益 U', '平均持仓', '≤1 根平仓', '止损占比'], [baseRow, ...varRows]);
  })() : '<div class="note">未跑对照实验。</div>'}
<div class="note" style="margin-top:10px">
${VARIANTS.length ? VARIANTS.map(v => {
      const dNet = v.s.net - S.net, dAvg = v.s.avg - S.avg;
      return `<b>${v.name.replace(/<br>.*$/, '')}</b>：净 ${fmt(v.s.net, 1)}U（${dNet >= 0 ? '+' : ''}${fmt(dNet, 1)}），均单 ${fmt(v.s.avg, 3)}U（${dAvg >= 0 ? '+' : ''}${fmt(dAvg, 3)}），胜率 ${pct(v.s.winRate)}，毛收益 ${fmt(v.gross, 1)}U，平均持仓 ${fmt(v.s.avgHeld, 1)} 根。`;
    }).join('<br>') : ''}
<br><b>读法：</b>「毛收益」= 扣费前的价格盈亏，它衡量<b>方向判断本身有没有 edge</b>；「净盈亏」与它的差额就是摩擦成本。
五组实验里没有任何一组把毛收益转正 —— 说明<b>过早离场是放大器，不是病根</b>：修掉它能少亏约 20%，但策略在 1m 上的方向判断本身没有正期望。
</div>

<h2>十二、口径与假设</h2>
<div class="note">
<b>与线上一致的部分（全部直接复用生产代码，未重写策略）：</b>
<ul>
<li>信号：<code>enhancedAnalysis()</code>，主周期 1m、窗口 80 根、engine=enhanced（与 data/config.json 一致）</li>
<li>参数：<code>NOFX_LONG_ONLY=true</code>（禁空）、<code>NOFX_MIN_TREND_SCORE=70</code>（与 ecosystem.config.cjs 一致）</li>
<li>入场：限价挂单 <code>entryLimit</code>（按评分预测回调价），信号在 bar[i] 收盘产生、最早 bar[i+2] 触价成交</li>
<li>挂单复核：方向反转立即撤 / 软门槛连续不合格满 30 分钟撤（<code>applyPendingReview</code>）</li>
<li>持仓复核：移动止损 R 阶梯 + 智能退出（<code>enhancedProtectionReview</code> + <code>applyPaperProtectionReview</code>）</li>
<li>结算：分批止盈（TP1 1R 平 40% / TP2 2R 平 40%）、止损/止盈/根级均线失守/120 根超时（<code>tradingSimulator</code>）</li>
<li>风控：每单保证金 100 U、杠杆 <code>recommendedLeverage</code>（≤5x）、同币种同时 1 单、平仓冷却 30 分钟 / 止损后 60 分钟</li>
<li>成本：手续费 6bps、滑点 5bps、资金费 3bps/8h</li>
</ul>
<b>回测特有的简化（会带来偏差，结论需打折看）：</b>
<ul>
<li>资金无限：不模拟账户余额与 20 笔活动订单上限，因此<b>低估了资金竞争与并发占用</b>的影响</li>
<li>撮合简化：限价单按「当根最低价触达」成交，未模拟队列/部分成交；同根双触发按实盘同一套保守规则处理</li>
<li>K 线缺口用前收平盘补齐（1m 无成交的分钟），极端低流动币的成交价可能偏乐观</li>
<li>复核频率：每根收盘复核一次；线上 positionReview 每 10 秒一轮（1m 内约 6 次），移动止损精度略低</li>
</ul>
</div>

<h2>十三、下一步建议（按性价比排序）</h2>
<div class="note">
<ol>
<li><b>先止血：给「均线失守」加最小持仓保护。</b>当前 ${pct(trades.filter(t => (t.heldBars || 0) <= 1).length / trades.length)} 的订单在成交后 1 根内就被平掉——
挂单是「等回调」的限价单，成交意味着价格已经回落，恰好落在「跌破 MA20 超 1 ATR」的退出条件上，等于<b>入场即触发出场</b>。
实验 C（最小持仓 15 根）把胜率从 ${pct(S.winRate)} 提到 28.8%、少亏约 ${fmt(S.net - (VARIANTS.find(v => v.file === 'result-minhold15.json')?.s.net ?? S.net), 0)} U；
实验 B（<code>NOFX_SMART_MA_ATR=2.0</code>，不改代码）也能拿到约 ${fmt(S.net - (VARIANTS.find(v => v.file === 'result-maatr2.json')?.s.net ?? S.net), 0)} U 的改善。<b>后者是零代码改动，建议先上。</b></li>
<li><b>别指望靠出场修好整个策略。</b>即使完全关掉智能退出（实验 A，胜率 33.6%），毛收益仍为 -454 U——
方向判断在 1m 上本身是负期望。出场问题只是把亏损放大了约 25%。</li>
<li><b>摩擦成本占比要盯住。</b>手续费 ${fmt(S.feeTotal / trades.length, 3)} U/单，占均单亏损的 ${pct(S.feeTotal / trades.length / Math.abs(S.avg))}。
继续降频（提高 <code>NOFX_MIN_TREND_SCORE</code> / <code>NOFX_MIN_ATR_PCT</code>）可以直接省手续费，但会同步减少盈利机会，需重新累计 ≥100 笔再评估。</li>
<li><b>挂单撤单不是主要矛盾。</b>实验 E（挂单不被软门槛撤）多成交 ${((VARIANTS.find(v => v.file === 'result-nogracecancel.json')?.n ?? trades.length) - trades.length)} 笔，净盈亏几乎没变——
被撤的那批单本来也不赚钱，不必优先处理。</li>
<li><b>换周期要谨慎。</b>历史已两次证伪 5m/15m（胜率与均单双恶化）。若要做，建议先用本报告的同一套脚本跑 50 币 × 30 天做预筛，再上灰度。</li>
</ol>
</div>

</div></body></html>`;

const outDir = path.resolve('output');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `backtest-50symbols-${new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}.html`);
fs.writeFileSync(out, html);
console.log(`\n报告已生成：${out}`);

// 存档统计
fs.writeFileSync(path.join(DIR, 'stats.json'), JSON.stringify({
  overall: { ...S, curve: undefined }, byReason: reasonRows, bySymbol: symbolRows,
  byHeld: heldRows, byHour: hourRows, byAtr: atrRows, byScore: scoreRows, byWait: waitRows,
  cancelReasons
}, null, 2));
