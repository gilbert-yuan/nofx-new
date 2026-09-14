/**
 * 多策略体系入口。
 *
 * 用法：
 *   import { createStrategyRuntime, listStrategies, getStrategy } from './strategies/index.js';
 *   const runtime = createStrategyRuntime({ store, resolveEngine: selectAnalysisEngine });
 *   const strategies = await runtime.enabled(config);   // 已启用策略（含参数）
 *
 * 导入本模块会**副作用注册** builtins 里的内置策略。
 */
export { defineStrategy, listStrategies, getStrategy, hasStrategy, resolveParams, defaultParams, sanitizePatch } from './registry.js';
export { createStrategyRuntime, StrategyRuntime } from './runtime.js';
export { loadConfiguredStrategy } from './loader.js';
export { ENGINE_DEFAULT_STRATEGY } from './builtins.js';

// 副作用：注册内置策略（enhanced-trend-v1 / structure-short-v1 / structure-long-v1；
// super/ai/pin/pump-short 的注册已于 2026-09-14 移除，引擎文件保留）
import './builtins.js';
