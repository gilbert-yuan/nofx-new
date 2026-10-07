import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfiguredStrategy } from '../server/strategies/loader.js';
import { listStrategies } from '../server/strategies/index.js';
import { abs, hash, initialConfig, loadConfig, writeJSON } from './backtest/config.mjs';
import { auditData, engineFingerprint } from './backtest/system.mjs';

const configFile = abs(process.argv[3] || 'configs/crypto-backtest.campaign.json');
const command = process.argv[2] || 'run';
const order = ['h4-mean-reversion-v1', 'h4-trend-breakout-v1', 'h4-chandelier-breakout-v1',
  'structure-long-v1', 'structure-short-v1', 'yao-coin-ambush-v1', 'enhanced-trend-v1'];
const log = text => console.log(`[${new Date().toISOString()}] ${text}`);
let activeChild = null, stopping = false;
const stop = () => { stopping = true; activeChild?.kill(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const spaces = {
  'h4-mean-reversion-v1': { entryExtAtr: [1.5, 2, 2.5], rsiOversold: [25, 30, 35], stopAtr: [1.2, 1.5, 2], maxHoldBars: [12, 17, 24] },
  'h4-trend-breakout-v1': { stopAtr: [1.5, 2, 2.5], tpR: [2, 3, 4], maxHoldBars: [24, 30, 36], volumeMult: [0, 1, 1.2] },
  'h4-chandelier-breakout-v1': { channelPeriod: [40, 55, 70], stopAtr: [2, 2.5, 3], chandelierMult: [2.5, 3, 3.5], adxMin: [15, 20, 25] },
  'structure-long-v1': { bullishScoreMin: [65, 70, 75], entryQualityMin: [65, 70, 75], minRealRR: [1.5, 2, 2.5], stopBufferAtr: [0.25, 0.35, 0.5] },
  'structure-short-v1': { bearishScoreMin: [65, 70, 75], entryQualityMin: [65, 70, 75], minRealRR: [1.5, 2, 2.5], stopBufferAtr: [0.25, 0.35, 0.5] },
  'yao-coin-ambush-v1': { minRawProbabilityPct: [85, 90, 95], minVolumeRatio: [2, 2.5, 3], stopAtr: [0.5, 0.8, 1] },
  'enhanced-trend-v1': { minTrendScore: [70, 73, 76], stopAtr: [1.5, 2, 2.5], mainTpR: [2.5, 3, 4], maxHoldBars: [90, 120, 180] }
};
async function initialize() {
  if (fs.existsSync(configFile)) throw new Error(`配置已存在：${configFile}`);
  const config = initialConfig();
  config.period = { days: 365, from: '2025-10-06T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', warmupDays: 90 };
  config.data.proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  config.data.downloadWorkers = 4;
  config.output.workers = 6;
  config.output.directory = 'output/crypto-backtest-campaign';
  config.execution.initialBalance = 360;
  config.execution.maxLeverage = 12;
  config.optimization = { ...config.optimization, autoSpace: false, maxRounds: 3, trialsPerRound: 3,
    patience: 2, minTrades: 30, maxDrawdown: 0.3 };
  for (const def of listStrategies()) {
    const loaded = await loadConfiguredStrategy(def.id);
    config.strategies[def.id] = { params: loaded.strategy.params, searchSpace: spaces[def.id] };
  }
  writeJSON(configFile, config);
  log(`已冻结当前线上参数与完整年度范围：${configFile}`);
}
function execute(script, args, logfile) {
  if (stopping) return Promise.reject(new Error('批次收到停止信号'));
  fs.mkdirSync(path.dirname(logfile), { recursive: true });
  const stream = fs.createWriteStream(logfile, { flags: 'a' });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', script, ...args],
      { cwd: abs('.'), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    child.stdout.on('data', chunk => { stream.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stream.write(chunk); process.stderr.write(chunk); });
    child.on('error', error => { stream.end(); reject(error); });
    child.on('exit', code => { activeChild = null; stream.end(); code === 0 ? resolve() : reject(new Error(`${script} 退出码 ${code}`)); });
  });
}
async function main() {
  if (command === 'init') return initialize();
  if (command !== 'run') throw new Error('用法：node scripts/backtest-campaign.mjs init|run [配置文件]');
  const config = loadConfig(configFile), directory = abs(config.output.directory);
  const statusFile = path.join(directory, 'campaign-status.json'), lockFile = path.join(directory, 'campaign.lock');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    try { process.kill(lock.pid, 0); throw new Error(`已有执行中的批次，PID ${lock.pid}`); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'w' });
  const campaign = { state: 'running', configFile: path.relative(abs('.'), configFile), configFingerprint: hash(config),
    engineFingerprint: engineFingerprint(), startedAt: new Date().toISOString(), requestedStrategies: order, completedStrategies: [] };
  const status = stage => writeJSON(statusFile, { ...campaign, stage, updatedAt: new Date().toISOString() });
  try {
    status('official_data_download');
    await execute('scripts/backtest-system.mjs', ['data', '--config', configFile], path.join(directory, 'logs', 'data.log'));
    status('coverage_audit'); await auditData(config);
    for (const id of order) {
      if (engineFingerprint() !== campaign.engineFingerprint) throw new Error('批次期间领域代码发生变化；保留检查点，重新执行以获得统一版本结果');
      status(`optimize:${id}`);
      await execute(`scripts/backtest-${id}.mjs`, ['optimize', '--config', configFile], path.join(directory, 'logs', `${id}.log`));
      campaign.completedStrategies.push(id); status(`completed:${id}`);
    }
    status('deployment_evaluation');
    await execute('scripts/backtest-deploy.mjs', ['--campaign', directory, '--apply'], path.join(directory, 'logs', 'deployment.log'));
    campaign.state = 'complete'; campaign.finishedAt = new Date().toISOString(); status('complete');
  } catch (e) { campaign.state = stopping ? 'paused' : 'failed'; campaign.error = e.message; status(campaign.state); throw e; }
  finally { fs.unlinkSync(lockFile); }
}
main().catch(e => { console.error(e.message); process.exitCode = stopping ? 130 : 1; });
