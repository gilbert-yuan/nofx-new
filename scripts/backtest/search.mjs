import { hash, validateParams, validateExecution } from './config.mjs';

export function random(seed) {
  let n = seed >>> 0;
  return () => { n += 0x6D2B79F5; let t = n; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function valuesFor(spec, current) {
  if (spec.type === 'boolean') return [false, true];
  const step = spec.step || (spec.max - spec.min) / 100;
  const nearby = [current * 0.8, current, current * 1.2].map(v => Math.max(spec.min, Math.min(spec.max,
    Number((Math.round(v / step) * step).toFixed(10)))));
  return [...new Set(nearby)];
}
export function spaceFor(def, base, config) {
  const patch = config.strategies[def.id] || {}, space = {};
  if (config.optimization.autoSpace) for (const spec of def.paramSchema) {
    // Every parameter is exposed. Direction and missing-data policies require explicit experiments.
    if (!['longOnly', 'shortOnly', 'strictSkillData', 'marketUniverseEnabled', 'marketUniverseAllowUnknown', 'maxPositions'].includes(spec.key))
      space[`params.${spec.key}`] = valuesFor(spec, base.params[spec.key]);
  }
  for (const [key, value] of Object.entries(patch.searchSpace || {})) space[`params.${key}`] = expand(value);
  for (const [key, value] of Object.entries(config.optimization.runtimeSpace || {})) space[`execution.${key}`] = expand(value);
  for (const [key, value] of Object.entries(config.optimization.costSpace || {})) space[`costs.${key}`] = expand(value);
  for (const [key, values] of Object.entries(space)) {
    if (!values.length) throw new Error(`${key} 搜索空间为空`);
    for (const value of values) {
      const trial = structuredClone(base); set(trial, key, value); validateTrial(def, trial);
    }
  }
  return space;
}
function expand(value) {
  if (Array.isArray(value)) return value;
  if (value && Number.isFinite(value.min) && Number.isFinite(value.max) && value.step > 0 && value.min <= value.max) {
    const count = Math.floor((value.max - value.min) / value.step) + 1;
    if (count > 10000) throw new Error('单参数搜索网格不能超过 10000 个值');
    return Array.from({ length: count }, (_, i) => Number((value.min + i * value.step).toFixed(10)));
  }
  throw new Error('搜索空间必须为数组或 {min,max,step}');
}
function set(trial, key, value) {
  const [group, name] = key.split('.');
  if (!(name in trial[group])) throw new Error(`未知搜索参数 ${key}`);
  trial[group][name] = value;
}
export function validateTrial(def, trial) { validateParams(def, trial.params); validateExecution(trial.execution, trial.costs); }
export function trialId(trial) { return hash(trial).slice(0, 16); }
export function candidateRound(base, best, space, options, round, seen) {
  const keys = Object.keys(space), proposals = [], rng = random(options.seed + round * 104729);
  if (round === 0 && options.method !== 'grid') proposals.push(base);
  const budget = options.trialsPerRound - proposals.length;
  if (options.method === 'grid') {
    const count = keys.reduce((n, k) => n * space[k].length, 1);
    // Reserve the first slot for the current configuration even if it is outside the grid.
    if (round === 0) proposals.push(base);
    // Enumerate the first unseen combinations; baseline/grid duplicates cannot consume a later round.
    for (let index = 0; index < count && proposals.length < options.trialsPerRound; index++) {
      let n = index; const trial = structuredClone(base);
      for (const k of keys) { set(trial, k, space[k][n % space[k].length]); n = Math.floor(n / space[k].length); }
      if (!seen.has(trialId(trial)) && !proposals.some(t => trialId(t) === trialId(trial))) proposals.push(trial);
      if (proposals.length >= options.trialsPerRound) break;
    }
  } else for (let attempts = 0; proposals.length < options.trialsPerRound && attempts < Math.max(100, budget * 100); attempts++) {
    const trial = structuredClone(round === 0 ? base : best);
    const count = Math.min(keys.length, 1 + Math.floor(rng() * Math.max(1, Math.ceil(keys.length / (round + 2)))));
    const shuffled = [...keys];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    for (const k of shuffled.slice(0, count)) set(trial, k, space[k][Math.floor(rng() * space[k].length)]);
    const id = trialId(trial);
    if (!seen.has(id) && !proposals.some(t => trialId(t) === id)) proposals.push(trial);
  }
  return proposals.filter(t => !seen.has(trialId(t))).slice(0, options.trialsPerRound);
}
