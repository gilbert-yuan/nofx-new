/**
 * 妖币预测概率校准模型。
 *
 * 模型由 scripts/calibrate_yao_ambush.mjs 只使用训练时间段拟合，线上只做
 * 分数查表/线性插值，不读取未来行情。rawProbabilityPct 保留在预测结果中，
 * 便于区分“规则分数”和“历史校准后的经验概率”。
 */

export const YAO_CALIBRATION_MODEL = Object.freeze({
  version: 1,
  method: 'isotonic-binned',
  trainedAt: '2026-09-19T00:34:36.938Z',
  source: 'bf90-1m / 100 symbols / 70% chronological train split',
  minRawScore: 60,
  direction: Object.freeze({
    raw: Object.freeze([60, 65, 70, 75, 80, 85, 90, 92, 94, 96, 98, 99]),
    // 训练段经单调回归后，各原始分数段均约为 46.3%。
    calibrated: Object.freeze([46.34, 46.34, 46.34, 46.34, 46.34, 46.34, 46.34, 46.34, 46.34, 46.34, 46.34, 46.34]),
    globalRate: 0.463378142497676
  }),
  target: Object.freeze({
    raw: Object.freeze([60, 65, 70, 75, 80, 85, 90, 92, 94, 96, 98, 99]),
    // 目标标签：信号后 24h 内，预测方向有利极值达到 50%。单位为百分比。
    calibrated: Object.freeze([0.43, 0.71, 0.87, 1.16, 1.48, 1.91, 2.67, 2.67, 2.67, 4.76, 4.76, 6.84]),
    globalRate: 0.0105184412758144
  })
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function interpolate(raw, mapping, fallback) {
  const value = finite(raw);
  if (value == null || !Array.isArray(mapping?.raw) || !Array.isArray(mapping?.calibrated)
    || !mapping.raw.length || mapping.raw.length !== mapping.calibrated.length) return fallback;
  if (value <= mapping.raw[0]) return mapping.calibrated[0];
  for (let index = 1; index < mapping.raw.length; index++) {
    if (value <= mapping.raw[index]) {
      const x0 = mapping.raw[index - 1];
      const x1 = mapping.raw[index];
      const y0 = mapping.calibrated[index - 1];
      const y1 = mapping.calibrated[index];
      const ratio = x1 > x0 ? (value - x0) / (x1 - x0) : 0;
      return y0 + (y1 - y0) * ratio;
    }
  }
  return mapping.calibrated.at(-1);
}

/**
 * @param {number} rawProbabilityPct 规则模型原始分数（0~99）
 * @param {'direction'|'target'} kind
 * @param {object} [model]
 */
export function calibrateYaoProbability(rawProbabilityPct, kind = 'direction', model = YAO_CALIBRATION_MODEL) {
  const mapping = model?.[kind] || YAO_CALIBRATION_MODEL[kind];
  const fallback = kind === 'target'
    ? Number(model?.target?.globalRate || YAO_CALIBRATION_MODEL.target.globalRate) * 100
    : Number(model?.direction?.globalRate || YAO_CALIBRATION_MODEL.direction.globalRate) * 100;
  const result = interpolate(rawProbabilityPct, mapping, fallback);
  return Number.isFinite(result) ? Math.max(0, Math.min(100, result)) : fallback;
}
