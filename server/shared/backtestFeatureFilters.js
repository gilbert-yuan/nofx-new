import fs from 'node:fs';
import path from 'node:path';
import { validateFeatureRules } from '../../shared/strategyFeatureFilter.js';

let cache = null;
/** Explicit config or an authorized production profile enables filters; offline runs never write either. */
export function backtestEntryFilter(config, strategyId, params = null) {
  const setting = config?.analysis?.backtestFeatureFilters;
  if (setting?.enabled === false) return null;
  const deployedFile = path.resolve('data/backtest/production-profiles.json');
  if (setting?.enabled !== true && !fs.existsSync(deployedFile)) return null;
  let profiles = setting?.profiles;
  const sourceFile = setting?.enabled === true ? setting.file : deployedFile;
  if (sourceFile) {
    const file = path.resolve(sourceFile), stat = fs.statSync(file);
    const key = `${file}:${stat.size}:${stat.mtimeMs}`;
    if (cache?.key !== key) cache = { key, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
    profiles = cache.value.strategies;
  }
  const profile = profiles?.[strategyId];
  if (!profile || profile.enabled !== true) return null;
  // An authorized deployment binds filters to the exact strategy parameter snapshot.
  if (profile.params && (!params || Object.keys(profile.params).some(k => profile.params[k] !== params[k]))) return null;
  validateFeatureRules(profile.rules);
  const p = profile.featureConfig;
  if (!p || !/^\d+(m|h|d)$/.test(p.interval) || !Number.isInteger(p.lookbackBars) || p.lookbackBars < 2 || p.lookbackBars > 1000)
    throw new Error('回测筛选配置的周期或窗口无效');
  return { ...profile, missing: profile.missing || 'reject' };
}
