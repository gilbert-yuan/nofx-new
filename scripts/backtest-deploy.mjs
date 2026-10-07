import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { abs, hash, loadConfig, writeJSON } from './backtest/config.mjs';
import { engineFingerprint } from './backtest/system.mjs';
import { assessDeployment } from './backtest/deployment.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2), at = args.indexOf('--campaign');
if (at < 0 || !args[at + 1]) throw new Error('用法：node scripts/backtest-deploy.mjs --campaign DIR [--apply]');
const directory = abs(args[at + 1]), apply = args.includes('--apply');
const origin = 'http://127.0.0.1:3100';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
async function api(route, options = {}) {
  const response = await fetch(`${origin}${route}`, { ...options, signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) throw new Error(`本地策略 API ${route} HTTP ${response.status}`);
  return response.json();
}
async function restartService() {
  // Keep the existing PM2 environment (including proxy), never use --update-env.
  const node22 = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
  const node = fs.existsSync(node22) ? node22 : process.execPath;
  await exec(node, [abs('node_modules/pm2/bin/pm2'), 'restart', 'nofx-api'],
    { cwd: abs('.'), env: { ...process.env, PM2_HOME: abs('.pm2') }, windowsHide: true, timeout: 60000 });
  for (let attempt = 0; attempt < 20; attempt++) {
    try { return await api('/api/health'); } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error('服务重启后健康检查未通过');
}
async function main() {
  const campaign = read(path.join(directory, 'campaign-status.json')), engine = engineFingerprint();
  const config = loadConfig(campaign.configFile);
  if (engine !== campaign.engineFingerprint || hash(config) !== campaign.configFingerprint) throw new Error('代码或回测配置与批次快照不同，不能应用旧结果');
  const reports = [], plan = { generatedAt: new Date().toISOString(), engineFingerprint: engine, apply, strategies: [] };
  for (const id of campaign.requestedStrategies) {
    // Public run config masks the proxy; compare non-secret input fields separately below.
    const compatible = fs.readdirSync(directory, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(directory, d.name))
      .filter(dir => fs.existsSync(path.join(dir, id, 'report.json')) && fs.existsSync(path.join(dir, 'run.json')))
      .filter(dir => {
        const run = read(path.join(dir, 'run.json'));
        const publicConfig = { ...config, data: { ...config.data, proxy: config.data.proxy ? '[configured]' : null } };
        return run.engineFingerprint === engine && hash(run.config) === hash(publicConfig)
          && read(path.join(dir, 'status.json')).state === 'complete';
      });
    if (compatible.length !== 1) throw new Error(`${id} 缺少唯一的完整同版本报告`);
    const report = read(path.join(compatible[0], id, 'report.json'));
    const decision = assessDeployment(report); reports.push(report);
    plan.strategies.push({ strategyId: id, runId: report.runId, report: path.relative(abs('.'), path.join(compatible[0], id, 'report.html')),
      decision, state: decision.eligible ? 'candidate' : 'retained_baseline', changes: Object.fromEntries(Object.entries(report.bestParameters.params)
        .filter(([key, value]) => value !== report.baseline.parameters.params[key]).map(([key, value]) => [key, { from: report.baseline.parameters.params[key], to: value }])) });
  }
  writeJSON(path.join(directory, 'deployment-plan.json'), plan);
  if (!apply) return;
  const backupDirectory = path.join(directory, 'deployment-backup'); fs.mkdirSync(backupDirectory, { recursive: true });
  fs.copyFileSync(abs('data/strategies.json'), path.join(backupDirectory, 'strategies.json'));
  const profileFile = abs('data/backtest/production-profiles.json');
  const existingProfiles = fs.existsSync(profileFile) ? read(profileFile) : { version: 1, strategies: {} };
  if (fs.existsSync(profileFile)) fs.copyFileSync(profileFile, path.join(backupDirectory, 'production-profiles.json'));
  const safeConfig = JSON.parse(fs.readFileSync(abs('data/config.json'), 'utf8')).analysis?.backtestFeatureFilters;
  // Load new indicator settings and the conditional parameter update API before applying results.
  await restartService();
  for (const item of plan.strategies) {
    if (!item.decision.eligible) continue;
    const report = reports.find(r => r.strategyId === item.strategyId), current = await api(`/api/strategies/${item.strategyId}`);
    if (hash(current.params) !== hash(report.baseline.parameters.params)) { item.state = 'skipped_live_parameter_drift'; continue; }
    if (report.filter.appliedRules.length && safeConfig) { item.state = 'skipped_existing_filter_configuration'; continue; }
    const previousProfile = existingProfiles.strategies[item.strategyId];
    existingProfiles.strategies[item.strategyId] = { enabled: report.filter.appliedRules.length > 0,
      params: report.bestParameters.params, featureConfig: report.featureConfig, rules: report.filter.appliedRules,
      missing: report.featureConfig.missing, provenance: { runId: report.runId, engineFingerprint: engine } };
    writeJSON(profileFile, existingProfiles);
    let updateAttempted = false;
    try {
      updateAttempted = true;
      const result = await api(`/api/strategies/${item.strategyId}`, { method: 'PUT',
        body: JSON.stringify({ params: report.bestParameters.params, expectedParams: report.baseline.parameters.params }) });
      if (result.rejected?.length) throw new Error('线上 API 拒绝了部分参数');
      const verified = await api(`/api/strategies/${item.strategyId}`);
      if (hash(verified.params) !== hash(report.bestParameters.params) || verified.enabled !== current.enabled)
        throw new Error('策略参数回读或启用状态不一致');
      item.state = 'applied_and_verified'; item.appliedAt = new Date().toISOString();
    } catch (e) {
      if (updateAttempted) {
        try {
          const observed = await api(`/api/strategies/${item.strategyId}`);
          if (hash(observed.params) === hash(report.bestParameters.params)) {
            await api(`/api/strategies/${item.strategyId}`, { method: 'PUT', body: JSON.stringify({
              params: current.params, expectedParams: observed.params }) });
            item.rolledBack = hash((await api(`/api/strategies/${item.strategyId}`)).params) === hash(current.params);
          }
        } catch (rollbackError) { item.rollbackError = rollbackError.message; }
      }
      if (previousProfile) existingProfiles.strategies[item.strategyId] = previousProfile;
      else delete existingProfiles.strategies[item.strategyId];
      writeJSON(profileFile, existingProfiles);
      item.state = 'deployment_failed'; item.error = e.message; writeJSON(path.join(directory, 'deployment-result.json'), plan); throw e;
    }
    writeJSON(path.join(directory, 'deployment-result.json'), plan);
  }
  plan.codeApplied = true; plan.finishedAt = new Date().toISOString();
  writeJSON(path.join(directory, 'deployment-result.json'), plan);
  console.log(JSON.stringify({ codeApplied: true, strategies: plan.strategies.map(s => ({ id: s.strategyId, state: s.state, reasons: s.decision.reasons })) }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
