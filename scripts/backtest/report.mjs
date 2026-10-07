import fs from 'node:fs';
import path from 'node:path';
import { writeJSON } from './config.mjs';
export const RISK_NOTE = '历史回测不能保证未来收益；最优仅指本次搜索范围与预算内的最优。交易费、滑点、资金费率为可配置情景假设；K线不能复原盘口深度、排队与盘中价格顺序。同根触发保护与止盈时使用项目撮合引擎的保守规则。报告不构成投资建议。';
const escapeHTML = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = x => Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—';
const num = x => Number.isFinite(x) ? x.toFixed(2) : '—';
const csv = x => `"${String(x ?? '').replaceAll('"', '""')}"`;
export function writeReport(directory, report) {
  fs.mkdirSync(directory, { recursive: true });
  writeJSON(path.join(directory, 'report.json'), report);
  const columns = ['strategy', 'symbol', 'segment', 'status', 'reason', 'returnRate', 'maxDrawdown', 'winRate', 'profitFactor',
    'trades', 'net', 'fees', 'funding', 'coverage', 'trialId', 'params', 'execution', 'costs'];
  const records = [];
  for (const coin of report.coins) for (const segment of ['training', 'validation', 'test', 'full', 'coinBestTest']) {
    const r = coin[segment]; if (!r) continue;
    records.push([report.strategyId, coin.symbol, segment, r.status, r.reason, r.metrics?.returnRate,
      r.metrics?.maxDrawdown, r.metrics?.winRate, r.metrics?.profitFactor, r.metrics?.trades, r.metrics?.net,
      r.metrics?.fees, r.metrics?.funding, r.coverage?.coverage, segment === 'coinBestTest' ? coin.bestTrialId : report.bestTrialId,
      JSON.stringify(r.params), JSON.stringify(r.execution), JSON.stringify(r.costs)]);
  }
  fs.writeFileSync(path.join(directory, 'coins.csv'), [columns, ...records].map(xs => xs.map(csv).join(',')).join('\n') + '\n');
  const rows = report.coins.map(c => {
    const r = c.test, best = c.coinBestTest;
    return `<tr><td>${escapeHTML(c.symbol)}</td><td>${escapeHTML(r?.status)}</td><td>${pct(r?.coverage?.coverage)}</td><td>${pct(r?.metrics?.returnRate)}</td><td>${pct(r?.metrics?.maxDrawdown)}</td><td>${pct(r?.metrics?.winRate)}</td><td>${num(r?.metrics?.profitFactor)}</td><td>${r?.metrics?.trades ?? '—'}</td><td>${pct(best?.metrics?.returnRate)}</td><td>${escapeHTML(r?.reason || '')}<details><summary>币种最优参数</summary><pre>${escapeHTML(JSON.stringify(c.bestParameters, null, 2))}</pre></details></td></tr>`;
  }).join('');
  const rounds = report.trials.map(t => `<tr><td>${t.round + 1}</td><td>${escapeHTML(t.id)}</td><td>${pct(t.training.meanReturn)}</td><td>${pct(t.validation.meanReturn)}</td><td>${pct(t.validation.worstDrawdown)}</td><td>${t.validation.trades}</td><td>${num(t.score)}</td></tr>`).join('');
  const profile = { version: 1, strategyId: report.strategyId, parameterSelection: 'validation_only',
    testUsedForSelection: false, enabled: report.filter.accepted || report.filter.manual,
    trainPeriod: report.periods.training, validationPeriod: report.periods.validation,
    params: report.bestParameters.params, execution: report.bestParameters.execution, costs: report.bestParameters.costs,
    featureConfig: report.featureConfig, rules: report.filter.appliedRules, missing: report.featureConfig.missing,
    productionReady: report.deployment?.eligible === true, deployment: report.deployment,
    reason: '历史评估门槛通过后可由授权批次采用；仍需前向观察，历史结果不保证未来收益',
    provenance: { runId: report.runId, engineFingerprint: report.engineFingerprint }, riskNote: RISK_NOTE };
  writeJSON(path.join(directory, 'strategy-profile.json'), profile);
  writeJSON(path.join(directory, 'best-per-coin.json'), Object.fromEntries(report.coins.map(c => [c.symbol,
    { trialId: c.bestTrialId, parameters: c.bestParameters, selectedUsing: 'validation_only',
      selectionStatus: c.parameterSelection, test: c.coinBestTest?.metrics }])));
  fs.writeFileSync(path.join(directory, 'report.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(report.strategyName)} 年度回测</title><style>body{font:15px system-ui;background:#0c1425;color:#d9e5f8;margin:28px}h1,h2{color:#8bcaff}article{max-width:1600px;margin:auto}section{background:#15223b;padding:20px;border-radius:12px;margin:18px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:10px;border-bottom:1px solid #30415c}th{position:sticky;top:0;background:#203453}pre{white-space:pre-wrap;max-height:420px;overflow:auto}small{color:#b1c0d9}a{color:#8bcaff}.scroll{overflow:auto}strong{color:#f9c36c}</style><article><h1>${escapeHTML(report.strategyName)} · 回测报告</h1><small>生成于 ${escapeHTML(report.generatedAt)} · 运行 ${escapeHTML(report.runId)}</small><section><p><strong>${escapeHTML(RISK_NOTE)}</strong></p><p>请求范围：${escapeHTML(report.periods.full.from)} 至 ${escapeHTML(report.periods.full.to)}（结束端点不含）。训练 ${escapeHTML(report.periods.training.to)} 前；验证结束于 ${escapeHTML(report.periods.validation.to)}；其后为最终样本外测试。</p><p>${escapeHTML(report.summary.test.accounting)}</p><p>测试平均收益 ${pct(report.summary.test.meanReturn)} · 最差币种回撤 ${pct(report.summary.test.worstDrawdown)} · ${report.summary.test.validCoins}/${report.coins.length} 币种有效 · ${report.summary.test.trades} 笔交易</p><p>优化停止原因：${escapeHTML(report.stopReason)}。参数选择：${escapeHTML(report.selectionStatus)}。</p></section><section><h2>固定筛选条件与盈利币种特征</h2><p>采用学习筛选：${report.filter.accepted ? '是' : '否'}；${escapeHTML(report.filter.reason)}</p><pre>${escapeHTML(JSON.stringify({ appliedRules: report.filter.appliedRules, evidence: report.filter.learned }, null, 2))}</pre></section><section><h2>逐币结果 · 最终测试期</h2><p>前六项指标使用策略统一最优参数；“币种最优测试收益”使用该币种验证期选出的参数。全年重放在 CSV/JSON 中标记为 full，其中包含训练数据。</p><div class="scroll"><table><thead><tr><th>币种</th><th>状态</th><th>全年覆盖率</th><th>收益率</th><th>最大回撤</th><th>胜率</th><th>盈亏比 PF</th><th>交易数</th><th>币种最优测试收益</th><th>原因 / 参数</th></tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>多轮参数优化</h2><table><thead><tr><th>轮次</th><th>试验</th><th>训练收益</th><th>验证收益</th><th>验证最差回撤</th><th>验证交易数</th><th>目标分</th></tr></thead><tbody>${rounds}</tbody></table><details><summary>统一最优参数及执行配置</summary><pre>${escapeHTML(JSON.stringify(report.bestParameters, null, 2))}</pre></details></section><section><h2>数据与模型限制</h2><pre>${escapeHTML(JSON.stringify(report.assumptions, null, 2))}</pre><p><a href="report.json">完整 JSON</a> · <a href="coins.csv">逐币 CSV</a> · <a href="strategy-profile.json">参数与筛选配置</a> · <a href="best-per-coin.json">逐币最优参数</a></p></section></article></html>`);
  if (report.deployment) {
    const comparisons = report.deployment.comparisons || {};
    const table = Object.entries(comparisons).map(([segment, c]) => `<tr><td>${escapeHTML(segment)}</td><td>${c.pairedCoins}</td><td>${pct(c.baseline.meanReturn)}</td><td>${pct(c.candidate.meanReturn)}</td><td>${pct(c.improvement)}</td><td>${c.candidate.trades}</td></tr>`).join('');
    const section = `<section><h2>当前线上参数对照与采用判定</h2><p>历史门槛：${report.deployment.eligible ? '通过，可由授权批次采用' : '未通过，保留当前参数'}。测试只否决冻结候选，不用来继续选参数。</p><p>以下对照仅使用双方有效且年度覆盖至少 95% 的同一批币种。</p><table><tr><th>分段</th><th>同币种数</th><th>当前参数收益</th><th>候选收益</th><th>改善幅度</th><th>候选交易数</th></tr>${table}</table><pre>${escapeHTML(JSON.stringify({ reasons: report.deployment.reasons, policy: report.deployment.policy }, null, 2))}</pre></section>`;
    const htmlFile = path.join(directory, 'report.html');
    fs.writeFileSync(htmlFile, fs.readFileSync(htmlFile, 'utf8').replace('</article>', `${section}</article>`));
  }
  return profile;
}
export function writeIndex(directory, reports, run) {
  writeJSON(path.join(directory, 'feature-filters.json'), { version: 1, runId: run.runId,
    strategies: Object.fromEntries(reports.map(r => [r.strategyId, { enabled: r.filter.accepted || r.filter.manual,
      featureConfig: r.featureConfig, rules: r.filter.appliedRules, missing: r.featureConfig.missing,
      trainPeriod: r.periods.training, validationPeriod: r.periods.validation, testUsedForSelection: false }])) });
  writeJSON(path.join(directory, 'summary.json'), { ...run, strategies: reports.map(r => ({ strategyId: r.strategyId,
    strategyName: r.strategyName, selectionStatus: r.selectionStatus, summary: r.summary, filterAccepted: r.filter.accepted,
    bestTrialId: r.bestTrialId, deployment: r.deployment, baseline: r.baseline?.summary })), riskNote: RISK_NOTE });
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>加密货币策略回测</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #ccc;text-align:left}</style><h1>加密货币年度策略回测</h1><p>${escapeHTML(RISK_NOTE)}</p><p>${escapeHTML(run.period.from)} 至 ${escapeHTML(run.period.to)} · 每币种独立账户，等权统计。测试收益为最终未参与调参的时间段。</p><table><tr><th>策略</th><th>有效币种</th><th>测试均值收益</th><th>最差币种回撤</th><th>交易数</th><th>参数状态</th></tr>${reports.map(r => `<tr><td><a href="${escapeHTML(r.strategyId)}/report.html">${escapeHTML(r.strategyName)}</a></td><td>${r.summary.test.validCoins}/${r.coins.length}</td><td>${pct(r.summary.test.meanReturn)}</td><td>${pct(r.summary.test.worstDrawdown)}</td><td>${r.summary.test.trades}</td><td>${escapeHTML(r.selectionStatus)}</td></tr>`).join('')}</table><p>各策略报告包含逐币最优参数、收益、回撤、胜率、手续费、资金费、特征条件及数据缺口。</p>`);
}
