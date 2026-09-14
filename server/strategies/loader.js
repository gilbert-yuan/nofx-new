/**
 * 独立进程（回测 / 诊断）加载正式策略的最小入口。
 *
 * 这里不复制策略参数，也不复制策略分派逻辑：注册表定义、data/strategies.json
 * 配置迁移、参数校验和默认值合并全部走 StrategyRuntime。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { StrategyRuntime } from './runtime.js';

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && (error?.code === 'ENOENT' || error instanceof SyntaxError)) return fallback;
    throw error;
  }
}

/**
 * @param {string} id 注册表中的策略 id
 * @param {{strategyPath?: string, configPath?: string}} options
 * @returns {Promise<{strategy: object, config: object, strategyPath: string, configPath: string}>}
 */
export async function loadConfiguredStrategy(id, {
  strategyPath = 'data/strategies.json',
  configPath = 'data/config.json'
} = {}) {
  const resolvedStrategyPath = path.resolve(strategyPath);
  const resolvedConfigPath = path.resolve(configPath);
  const rawState = await readJson(resolvedStrategyPath, {});
  const config = await readJson(resolvedConfigPath, {});
  const runtime = new StrategyRuntime({
    // 回测只读正式配置，不把 v1→v2 迁移写回工作区。
    store: { getStrategies: async () => rawState },
    resolveEngine: current => current?.analysis?.engine || 'enhanced'
  });
  const strategy = await runtime.configured(id, config);
  if (!strategy) throw new Error('未注册正式策略：' + id);
  return { strategy, config, strategyPath: resolvedStrategyPath, configPath: resolvedConfigPath };
}
