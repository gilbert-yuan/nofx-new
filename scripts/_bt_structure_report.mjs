/**
 * 结构策略回测报告生成器 —— 读 data/backtest/results/structure-<engine>-<tag>.json 现算全部数字。
 *
 * 用法：STRUCT_TAG=bf90 node scripts/_bt_structure_report.mjs
 * 产物：output/structure-bf90-report.html
 *
 * 判据（取证工作流）：毛/名义 vs 往返成本、持仓分桶、集中度（剔 Top3 币/最大 5 笔）、
 * 前后半段符号、同期市场基准、峰值并发资金效率。任一红灯 → 「不可上线」。
 */
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.env.STRUCT_TAG || 'bf90';
const D15 = path.resolve(process.env.BT_DIR_15M || 'data/backtest/bf90-15mrs');
const ENGINES = (process.env.STRUCT_ENGINES || 'structure-short,structure-long').split(',').map(s => s.trim()).filter(Boolean);
const FEE_RT_BPS = 12; // 往返成本口径（fee 6×2 + slip 5×2 = 22bps 名义；此处毛/名义对照 22bps）
const RT_COST_BPS = 22 + 3; // + funding（近似 8h×3bps，短持仓摊薄更小，保守计入）

const load = (engine) => {
  const f = `data/backtest/results/structure-${engine}-${TAG}.json`;
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

/** 同期市场基准：每币 15m 首末收盘价涨幅（决策可用窗口口径），取中位数/均值 + BTC/ETH
 *  BTC/ETH 无条件纳入读取范围：它们可能全程未成交，若只遍历成交币会让基准行退化成 0.00%。 */
function marketBenchmark(merged) {
  const traded = [...new Set(merged.trades.filter(t => !t.unfinished).map(t => t.symbol))];
  const syms = [...new Set([...traded, 'BTCUSDT', 'ETHUSDT'])];
  const moves = [];
  let btc = null, eth = null;
  for (const s of syms) {
    const f = path.join(D15, 'klines', `${s}.ndjson`);
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (lines.length < 100) continue;
    const first = Number(lines[0].split(',')[4]);
    const last = Number(lines[lines.length - 1].split(',')[4]);
    if (!(first > 0)) continue;
    const mv = (last - first) / first;
    moves.push(mv);
    if (s === 'BTCUSDT') btc = mv;
    if (s === 'ETHUSDT') eth = mv;
  }
  moves.sort((a, b) => a - b);
  return {
    n: moves.length,
    median: moves.length ? moves[Math.floor(moves.length / 2)] : NaN,
    mean: moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : NaN,
    btc, eth
  };
}

/** 持仓小时数：优先 held15m，回退 heldBars/60（TradingSimulator 只回传 heldBars 分钟）。
 *  ⚠️ 2026-09-14：结果里已无 held15m，直接用旧字段会让分桶全部塌进同一桶、中位持仓变 NaN。 */
const holdHours = (x) => Number.isFinite(x.held15m) ? x.held15m
  : (Number.isFinite(x.heldBars) ? x.heldBars / 60 : NaN);

/** 名义成交额（成本拆解分母）：优先 notional，回退 quantity×entry。 */
const notionalOf = (x) => (Number.isFinite(x.notional) && x.notional > 0) ? x.notional
  : ((Number.isFinite(x.quantity) && Number.isFinite(x.entry) && x.quantity > 0) ? x.quantity * x.entry : NaN);

function stats(merged) {
  const T = merged.trades.filter(x => !x.unfinished && Number.isFinite(x.net));
  const net = T.reduce((a, x) => a + x.net, 0);
  const wins = T.filter(x => x.net > 0);
  const gp = wins.reduce((a, x) => a + x.net, 0);
  const gl = Math.abs(T.filter(x => x.net <= 0).reduce((a, x) => a + x.net, 0));
  let acc = 0, pk = 0, mdd = 0;
  for (const x of T.slice().sort((a, b) => Date.parse(a.exitAt) - Date.parse(b.exitAt))) { acc += x.net; pk = Math.max(pk, acc); mdd = Math.max(mdd, pk - acc); }
  const byS = {};
  for (const x of T) byS[x.symbol] = (byS[x.symbol] || 0) + x.net;
  const coins = Object.entries(byS).sort((a, b) => b[1] - a[1]);
  const times = T.map(x => Date.parse(x.entryAt)).sort((a, b) => a - b);
  const mid = times.length ? times[Math.floor(times.length / 2)] : 0;
  const h1 = T.filter(x => Date.parse(x.entryAt) < mid).reduce((a, x) => a + x.net, 0);
  const h2 = T.filter(x => Date.parse(x.entryAt) >= mid).reduce((a, x) => a + x.net, 0);
  const gross = T.reduce((a, x) => a + x.gross, 0);
  const fee = T.reduce((a, x) => a + x.fee, 0);
  const funding = T.reduce((a, x) => a + x.funding, 0);
  const notionalSum = T.reduce((a, x) => a + notionalOf(x), 0);
  const top3 = coins.slice(0, 3).reduce((a, [, v]) => a + v, 0);
  const top10 = coins.slice(0, 10).reduce((a, [, v]) => a + v, 0);
  const top5t = [...T].sort((a, b) => b.net - a.net).slice(0, 5).reduce((a, x) => a + x.net, 0);
  const buckets = [
    ['<2h', x => holdHours(x) < 2], ['2-8h', x => holdHours(x) >= 2 && holdHours(x) < 8],
    ['8-16h', x => holdHours(x) >= 8 && holdHours(x) < 16], ['16-24h', x => holdHours(x) >= 16 && holdHours(x) < 24],
    ['≥24h', x => holdHours(x) >= 24], ['未知', x => !Number.isFinite(holdHours(x))]
  ].map(([k, fn]) => {
    const g = T.filter(fn);
    return { k, n: g.length, net: g.reduce((a, x) => a + x.net, 0), wr: g.length ? 100 * g.filter(x => x.net > 0).length / g.length : NaN };
  });
  const reasons = T.reduce((m, x) => (m[x.reason] = (m[x.reason] || 0) + 1, m), {});
  const waitMin = T.map(x => x.waitBars).filter(Number.isFinite).sort((a, b) => a - b);
  const med = a => a.length ? a[Math.floor(a.length / 2)] : NaN;
  const dirs = T.reduce((m, x) => (m[x.direction] = (m[x.direction] || 0) + 1, m), {});
  return {
    n: T.length, placed: merged.placed.length, cancels: merged.cancels.length,
    net, wr: T.length ? 100 * wins.length / T.length : NaN, pf: gl > 0 ? gp / gl : Infinity,
    mdd, avg: T.length ? net / T.length : NaN,
    medHeld15m: med(T.map(holdHours).sort((a, b) => a - b)),
    medRoi: 100 * med(T.map(x => x.roi).sort((a, b) => a - b)),
    gross, fee, funding, grossBps: notionalSum ? 10000 * gross / notionalSum : NaN,
    h1, h2, coins, top3, top10, top5t,
    coinsProfitable: coins.filter(c => c[1] > 0).length,
    top5coins: coins.slice(0, 5).map(([s, v]) => ({ s, v })),
    buckets, reasons, dirs,
    medWaitMin: med(waitMin),
    coinsTested: merged.symbols.length
  };
}

const fmt = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '–';
const signCls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const red = v => v >= 0 ? 'var(--up)' : 'var(--down)';

// 标题与币数一律从结果文件现算，避免写死「528 币」误导子集回测（如 STRUCT_SAMPLE=50）。
const MERGED = new Map(ENGINES.map(e => [e, load(e)]));
const LOADED = ENGINES.map(e => MERGED.get(e)).filter(Boolean);
const COINS_TESTED = LOADED.length ? Math.max(...LOADED.map(m => (m.symbols || []).length)) : 0;
const DATASET = (LOADED[0]?.config?.dataset) || TAG;
const TITLE = `结构策略 ${TAG} 回测报告`;

let html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${TITLE}</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--tx:#1a1f27;--tx2:#5a6472;--line:#e4e7ec;--up:#c8362b;--down:#1a9e5c;--accent:#2b5fd9;--warn:#b7791f;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--tx);padding:28px;font-size:14px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:21px;margin-bottom:4px}
.sub{color:var(--tx2);font-size:12.5px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:16px}
.card h2{font-size:15.5px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:10px}
.kpi{padding:10px 12px;background:#f8f9fb;border-radius:8px}
.kpi .l{font-size:11.5px;color:var(--tx2);margin-bottom:3px}
.kpi .v{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;text-align:right;border-bottom:1px solid var(--line);font-size:12.8px}
th:first-child,td:first-child{text-align:left}
th{color:var(--tx2);font-weight:500;font-size:11.5px}
.up{color:var(--up)} .down{color:var(--down)}
.verdict{border-left:4px solid var(--warn);padding-left:12px;line-height:1.75}
.verdict li{margin-left:18px}
.note{color:var(--tx2);font-size:12px;line-height:1.7;margin-top:10px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#eef2ff;color:var(--accent);margin-right:6px}
</style></head><body><div class="wrap">
<h1>${TITLE}（structure-short-v1 / structure-long-v1 · ${COINS_TESTED} 只达标币）</h1>
<div class="sub">语料 币安 USDT-M 合约 ${COINS_TESTED} 只 × 90 天 1m（${DATASET}，同源派生 15m/1h/4h 决策序列）· 决策 15m 收盘（80 根窗口）· 执行 1m 限价触达 · 成本 fee 6bps + slip 5bps + funding 3bps/8h · 保证金 100U/单 · 杠杆 = 生产同款 recommendedLeverage（≤12x，风险预算 18%）· 生成于 ${new Date().toISOString()}</div>
`;

for (const engine of ENGINES) {
  const merged = MERGED.get(engine);
  if (!merged) { html += `<div class="card"><h2>${engine}</h2><p>结果文件缺失，跳过。</p></div>`; continue; }
  const S = stats(merged);
  const bench = marketBenchmark(merged);
  const signals = merged.placed.length;

  // 自动判据
  const flags = [];
  if (!(S.grossBps > RT_COST_BPS)) flags.push(`毛收益/名义 ${fmt(S.grossBps, 1)}bps 未显著超过往返成本 ~${RT_COST_BPS}bps —— 成本即吞噬`);
  if (S.pf < 1.1) flags.push(`PF ${fmt(S.pf, 2)} 接近或低于 1`);
  if (S.h1 * S.h2 < 0) flags.push(`前后半段符号翻转（${fmt(S.h1, 0)}U / ${fmt(S.h2, 0)}U）—— 非稳定信号`);
  if (S.net - S.top3 < 0 && S.net > 0) flags.push(`剔除 Top3 贡献币后翻负（Top3 贡献 ${fmt(S.top3, 0)}U）—— 集中度依赖`);
  if (S.net - S.top5t < 0 && S.net > 0) flags.push(`剔除最大 5 笔后翻负（最大 5 笔 ${fmt(S.top5t, 0)}U）—— 尾部依赖`);
  if (S.mdd > Math.abs(S.net) * 3 && S.net > 0) flags.push(`最大回撤 ${fmt(S.mdd, 0)}U 数倍于净利 ${fmt(S.net, 0)}U`);
  const verdict = flags.length
    ? `<b style="color:var(--down)">⛔ 不可上线</b>（命中 ${flags.length} 条红线）`
    : `<b style="color:var(--up)">✅ 通过红线检查</b>（仍需 shadow ≥2 周验证）`;

  html += `<div class="card">
<h2><span class="badge">${engine === 'structure-short' ? '结构做空 v1' : '结构做多 v1'}</span>${verdict}</h2>
<ul class="verdict">${flags.map(f => `<li>${f}</li>`).join('') || '<li>六条红线全部通过（样本内）</li>'}</ul>
<div class="grid" style="margin-top:14px">
<div class="kpi"><div class="l">净盈亏</div><div class="v ${signCls(S.net)}" style="color:${red(S.net)}">${fmt(S.net, 1)} U</div></div>
<div class="kpi"><div class="l">成交 / 挂单</div><div class="v">${S.n} / ${S.placed}</div></div>
<div class="kpi"><div class="l">成交率</div><div class="v">${fmt(S.placed ? 100 * S.n / S.placed : NaN, 1)}%</div></div>
<div class="kpi"><div class="l">胜率</div><div class="v">${fmt(S.wr, 1)}%</div></div>
<div class="kpi"><div class="l">PF</div><div class="v">${S.pf === Infinity ? '∞' : fmt(S.pf, 2)}</div></div>
<div class="kpi"><div class="l">均单</div><div class="v ${signCls(S.avg)}" style="color:${red(S.avg)}">${fmt(S.avg, 3)} U</div></div>
<div class="kpi"><div class="l">最大回撤</div><div class="v">${fmt(S.mdd, 0)} U</div></div>
<div class="kpi"><div class="l">中位持仓</div><div class="v">${fmt(S.medHeld15m, 1)} h</div></div>
<div class="kpi"><div class="l">中位等成交</div><div class="v">${fmt(S.medWaitMin / 60, 1)} h</div></div>
<div class="kpi"><div class="l">中位 ROI</div><div class="v">${fmt(S.medRoi, 2)}%</div></div>
</div>

<h2 style="margin-top:18px">成本拆解</h2>
<table><tr><th>毛盈亏</th><th>手续费</th><th>资金费</th><th>毛/名义</th><th>对照往返成本</th></tr>
<tr><td class="${signCls(S.gross)}" style="color:${red(S.gross)}">${fmt(S.gross, 1)} U</td>
<td>−${fmt(S.fee, 1)} U</td><td>−${fmt(S.funding, 1)} U</td>
<td>${fmt(S.grossBps, 1)} bps</td><td>~${RT_COST_BPS} bps（fee12+slip10+funding）</td></tr></table>

<h2 style="margin-top:18px">持仓时长分桶</h2>
<table><tr><th>桶</th><th>笔数</th><th>净盈亏</th><th>胜率</th></tr>
${S.buckets.map(b => `<tr><td>${b.k}</td><td>${b.n}</td><td style="color:${red(b.net)}">${fmt(b.net, 1)} U</td><td>${fmt(b.wr, 1)}%</td></tr>`).join('')}</table>

<h2 style="margin-top:18px">集中度审计</h2>
<table><tr><th>口径</th><th>净盈亏</th></tr>
<tr><td>全样本（${S.coins.length} 币成交，盈利币 ${S.coinsProfitable} / ${S.coinsTested} 测试）</td><td style="color:${red(S.net)}">${fmt(S.net, 1)} U</td></tr>
<tr><td>剔除 Top3 贡献币（${S.top5coins.slice(0, 3).map(c => c.s).join(', ') || '–'}）</td><td style="color:${red(S.net - S.top3)}">${fmt(S.net - S.top3, 1)} U</td></tr>
<tr><td>剔除 Top10 贡献币</td><td style="color:${red(S.net - S.top10)}">${fmt(S.net - S.top10, 1)} U</td></tr>
<tr><td>剔除最大 5 笔</td><td style="color:${red(S.net - S.top5t)}">${fmt(S.net - S.top5t, 1)} U</td></tr>
<tr><td>前半段 / 后半段（按入场时间对分）</td><td><span style="color:${red(S.h1)}">${fmt(S.h1, 1)}</span> / <span style="color:${red(S.h2)}">${fmt(S.h2, 1)}</span> U</td></tr></table>

<h2 style="margin-top:18px">同期市场基准与出场构成</h2>
<table><tr><th>口径</th><th>区间涨跌幅</th></tr>
<tr><td>样本币区间收益中位数（${bench.n} 币，90 天首末）</td><td style="color:${red(bench.median)}">${fmt(bench.median * 100, 2)}%</td></tr>
<tr><td>BTCUSDT</td><td style="color:${red(bench.btc)}">${Number.isFinite(bench.btc) ? fmt(bench.btc * 100, 2) + '%' : '–'}</td></tr>
<tr><td>ETHUSDT</td><td style="color:${red(bench.eth)}">${Number.isFinite(bench.eth) ? fmt(bench.eth * 100, 2) + '%' : '–'}</td></tr></table>
<table style="margin-top:8px"><tr><th>出场</th><th>笔数</th></tr>
${Object.entries(S.reasons).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
<tr><td>方向构成</td><td>${Object.entries(S.dirs).map(([k, v]) => `${k}×${v}`).join(' / ')}</td></tr></table>

<div class="note">挂单失效 ${S.cancels} 笔（15m 收盘突破止损位或 24h 未成交）。口径说明：回测 worker 直接调用正式策略的 analyze / decoratePlan / review，分批止盈与 R 阶梯保护按订单 exitRules 结算；smartExit 是否开启由策略配置决定。信号总分门槛与入场质量门槛以产物中的 strategyParams 为准。</div>
</div>`;
}

html += `</div></body></html>`;
const out = `output/structure-${TAG}-report.html`; // TAG=bf90 时与原路径一致
fs.mkdirSync('output', { recursive: true });
fs.writeFileSync(out, html);
console.log(`报告已生成 ${out}（${(html.length / 1024).toFixed(0)} KB）`);
