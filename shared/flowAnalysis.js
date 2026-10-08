/**
 * 量价研判：前后端共用的周期、默认阈值与参数边界。
 * 规则引擎在 server/flowPatternAnalysis.js；本文件只放可序列化常量，避免 Vue 再抄一份默认值。
 */
export const FLOW_ANALYSIS_INTERVALS = Object.freeze(['1m', '5m', '1h', '1d']);

export const DEFAULT_FLOW_ANALYSIS_PARAMS = Object.freeze({
  lookbackBars: 20,
  recentBars: 5,
  minBars: 30,
  consolidationRangeMaxPct: 8,
  accumulationVolumeRatioMin: 0.65,
  accumulationVolumeRatioMax: 1.4,
  accumulationGentleVolumeRatioMin: 1.05,
  accumulationGentleVolumeRatioMax: 1.8,
  positiveFlowRatioMin: 0.02,
  washoutDropMinPct: 3,
  washoutVolumeRatioMax: 1.05,
  washoutRecoveryRatioMin: 0.65,
  breakoutVolumeRatioMin: 1.5,
  breakoutRiseMinPct: 2,
  distributionVolumeRatioMin: 2,
  distributionStallMaxPct: 1,
  distributionUpperWickMin: 0.45,
  distributionTurnoverRateMinPct: 5,
  largeRiseMinPct: 8,
  forecastMediumScore: 40,
  forecastHighScore: 70,
  lookaheadBarsByInterval: Object.freeze({ '1m': 60, '5m': 48, '1h': 72, '1d': 20 })
});

/** 与 normalizeParams 相同的夹取区间；前端输入框可对齐，避免「界面能填、服务端会夹」的漂移。 */
export const FLOW_ANALYSIS_PARAM_BOUNDS = Object.freeze({
  lookbackBars: [10, 100],
  recentBars: [2, 12],
  minBars: [20, 500],
  consolidationRangeMaxPct: [0.5, 40],
  accumulationVolumeRatioMin: [0.1, 5],
  accumulationVolumeRatioMax: [0.2, 10],
  positiveFlowRatioMin: [0, 0.8],
  accumulationGentleVolumeRatioMin: [0.5, 10],
  accumulationGentleVolumeRatioMax: [0.5, 15],
  washoutDropMinPct: [0.5, 30],
  washoutVolumeRatioMax: [0.1, 5],
  washoutRecoveryRatioMin: [0.1, 1],
  breakoutVolumeRatioMin: [1, 10],
  breakoutRiseMinPct: [0.1, 30],
  distributionVolumeRatioMin: [1, 10],
  distributionStallMaxPct: [0.1, 10],
  distributionUpperWickMin: [0.1, 0.95],
  distributionTurnoverRateMinPct: [0.1, 50],
  largeRiseMinPct: [2, 50],
  forecastMediumScore: [10, 80],
  forecastHighScore: [20, 100]
});
