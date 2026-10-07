import fs from 'node:fs';
import path from 'node:path';
const source = path.resolve(process.argv[2] || '');
const report = JSON.parse(fs.readFileSync(source, 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
const number = n => Number.isFinite(n) ? n.toFixed(2) : '—';
const pct = n => Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—';
const metrics = report.full.metrics;
const all = [ ['优化组合', report.full], ['同妖币参数移除4H', report.comparisons.selectedWithoutH4],
  ['仅放开概率门槛的原参数', report.comparisons.thresholdFixedBaseline], ['最终20%独立测试', report.test] ];
const series = report.full.equityCurve;
const width = 1000, height = 300, pad = 36;
const min = Math.min(100, ...series.map(p => p.equity)), max = Math.max(100, ...series.map(p => p.equity));
const start = Date.parse(report.period.from), span = Date.parse(report.period.to) - start;
const point = p => `${(pad + (p.time - start) / span * (width - 2 * pad)).toFixed(2)},${(height - pad - (p.equity - min) / Math.max(1, max - min) * (height - 2 * pad)).toFixed(2)}`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>妖币埋伏 + 四小时趋势回测</title>
<style>body{font-family:Segoe UI,Microsoft YaHei,sans-serif;background:#0c1422;color:#e6edf7;margin:0;padding:40px}main{max-width:1100px;margin:auto}h1{font-size:30px;margin:0 0 12px}p{color:#a8b8cc;line-height:1.75}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:28px 0}.card,section{background:#142036;border:1px solid #253952;border-radius:12px;padding:22px;margin-bottom:20px}.label{color:#a8b8cc;font-size:14px}.value{font-size:27px;font-weight:650;margin-top:10px}.positive{color:#7de6bb}.negative{color:#ff9aab}svg{width:100%;height:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:right;padding:12px 8px;border-bottom:1px solid #253952}th:first-child,td:first-child{text-align:left}pre{background:#0c1422;padding:20px;overflow:auto;font-size:13px}summary{cursor:pointer;color:#7de6bb}li{line-height:1.7;color:#a8b8cc;margin-bottom:9px}a{color:#7de6bb}@media(max-width:760px){body{padding:18px}.cards{grid-template-columns:repeat(2,1fr)}section{overflow:auto}}</style><main>
<h1>妖币埋伏入场 · 四小时趋势过滤</h1><p>初始共享资金 100 USDT · 合约固定10倍 · ${escape(report.period.from.slice(0,10))} 至 ${escape(report.period.to.slice(0,10))}<br>历史合约文件 ${report.universe.files} 个，可评估 ${report.universe.valid} 个；完整年度 ${report.universe.fullHistory} 个，部分历史 ${report.universe.partialHistory} 个。</p>
<div class="cards">${[['期末资金',number(metrics.finalEquity)+' USDT'],['净盈亏',number(metrics.net)+' USDT'],['年度收益',pct(metrics.returnRate)],['最大回撤',pct(metrics.maxDrawdown)]].map(([l,v])=>`<div class="card"><div class="label">${l}</div><div class="value ${metrics.net >= 0 ? 'positive':'negative'}">${v}</div></div>`).join('')}</div>
<section><h2>共享账户权益曲线</h2><p>纵轴 ${number(min)} ～ ${number(max)} USDT；包含浮盈浮亏及已计费用。全年包含参数训练和验证。</p><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="年度资金曲线"><line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" stroke="#425a78"/><polyline points="${series.map(point).join(' ')}" fill="none" stroke="${metrics.net >= 0 ? '#7de6bb' : '#ff9aab'}" stroke-width="2.5"/></svg></section>
<section><h2>组合与对照</h2><table><thead><tr><th>情景</th><th>期末U</th><th>净赚U</th><th>收益</th><th>回撤</th><th>交易</th><th>胜率</th><th>PF</th><th>爆仓</th></tr></thead><tbody>${all.map(([name,r])=>`<tr><td>${name}</td><td>${number(r.metrics.finalEquity)}</td><td>${number(r.metrics.net)}</td><td>${pct(r.metrics.returnRate)}</td><td>${pct(r.metrics.maxDrawdown)}</td><td>${r.metrics.trades}</td><td>${pct(r.metrics.winRate)}</td><td>${number(r.metrics.profitFactor)}</td><td>${r.capital.liquidations}</td></tr>`).join('')}</tbody></table><p>留出测试独立从100U开始；年份重放与测试收益不能相加。当前生产默认参数因为50%门槛高于46.34%常数校准值，交易数为0。</p></section>
<section><h2>月度资金</h2><table><thead><tr><th>月份</th><th>期初U</th><th>期末U</th><th>当月收益</th></tr></thead><tbody>${Object.entries(report.full.monthly).map(([m,r])=>`<tr><td>${m}</td><td>${number(r.startEquity)}</td><td>${number(r.endEquity)}</td><td>${pct(r.returnRate)}</td></tr>`).join('')}</tbody></table></section>
<section><details><summary>查看冻结参数与执行设置</summary><pre>${escape(JSON.stringify({params:report.selection.trial.params,h4:report.selection.trial.filter,execution:report.execution,capital:report.capital,costs:report.costs},null,2))}</pre></details></section>
<section><h2>研究范围与限制</h2><p>${report.selection.trials}组候选，${report.selection.sample.length}个固定随机样本币；交易数/回撤搜索门槛通过=${report.selection.qualified}，选择锁定于 ${escape(report.selection.frozenAt)}。通过搜索门槛不代表已盈利；训练收益 ${pct(report.selection.training.returnRate)}，验证收益 ${pct(report.selection.validation.returnRate)}。</p><ul>${report.caveats.map(x=>`<li>${escape(x)}</li>`).join('')}</ul><p><a href="report.json">原始成交和完整统计</a> · <a href="report.md">文字报告</a> · <a href="selected-parameters.json">冻结参数</a></p></section></main></html>`;
const output = path.join(path.dirname(source), 'report.html'); fs.writeFileSync(output, html);
console.log(output);
