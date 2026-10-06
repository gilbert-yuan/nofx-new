import express from 'express';
import { asyncHandler, ApiError } from '../core/errors.js';
import { clamp } from '../core/http.js';
import { analyzeFlowPatterns, FLOW_ANALYSIS_INTERVALS } from '../flowPatternAnalysis.js';

const parseParams = value => {
  if (!value) return {};
  try {
    const params = typeof value === 'string' ? JSON.parse(value) : value;
    return params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  } catch {
    throw new ApiError('分析参数格式无效。', 400);
  }
};

function sanitizeDatasets(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError('请提供按周期分组的 K 线数据。', 400);
  }
  const datasets = {};
  for (const interval of FLOW_ANALYSIS_INTERVALS) {
    if (input[interval] === undefined) continue;
    if (!Array.isArray(input[interval]) || input[interval].length > 500) {
      throw new ApiError(`${interval} 数据必须是最多 500 根的 K 线数组。`, 400);
    }
    datasets[interval] = input[interval];
  }
  if (!Object.keys(datasets).length) throw new ApiError('导入数据需要包含 1m、5m、1h 或 1d 周期。', 400);
  return datasets;
}

function symbolName(value) {
  const symbol = String(value || '').trim().slice(0, 40);
  if (!symbol) throw new ApiError('请填写币种或股票代码。', 400);
  return symbol;
}

/** Multi-timeframe live and user-supplied rule-based flow analysis. */
export function createFlowAnalysisRouter(container) {
  const router = express.Router();
  const { marketData, marketDb } = container;

  router.get('/api/market/flow-analysis', asyncHandler(async (req, res) => {
    const symbol = symbolName(req.query.symbol || 'BTCUSDT').toUpperCase();
    const primaryInterval = FLOW_ANALYSIS_INTERVALS.includes(req.query.interval) ? req.query.interval : '1h';
    const limit = clamp(Number(req.query.limit || 200), 30, 500);
    const params = parseParams(req.query.params);
    const datasets = {};
    const dataWarnings = [];

    const results = await Promise.all(FLOW_ANALYSIS_INTERVALS.map(async interval => {
      try {
        const rows = await marketData.klines({ symbol, interval, limit });
        try {
          const confirmed = rows.filter(row => row.confirmed !== false);
          await marketDb.saveKlines({ symbol: marketData.storageSymbol(symbol), interval, rows: confirmed });
        } catch (error) {
          dataWarnings.push(`${interval} K 线已获取，但写入历史库失败：${error.message}`);
        }
        datasets[interval] = rows;
        return { interval, ok: true, count: rows.length };
      } catch (error) {
        dataWarnings.push(`${interval} 数据不可用：${error.message}`);
        return { interval, ok: false, error: error.message };
      }
    }));

    if (!Object.values(datasets).some(rows => rows.length)) {
      throw new ApiError('当前无法取得行情数据，请检查代码并稍后重试。', 502);
    }
    res.json(analyzeFlowPatterns({
      symbol, primaryInterval, datasets, params,
      source: { kind: 'live', provider: marketData.provider, marketType: marketData.marketType, label: '币安 U 本位永续' },
      dataWarnings
    }));
  }));

  router.post('/api/market/flow-analysis', asyncHandler(async (req, res) => {
    const symbol = symbolName(req.body?.symbol || '导入数据');
    const primaryInterval = FLOW_ANALYSIS_INTERVALS.includes(req.body?.primaryInterval)
      ? req.body.primaryInterval : '1h';
    const datasets = sanitizeDatasets(req.body?.datasets);
    const assetClass = ['crypto', 'stock', 'other'].includes(req.body?.assetClass) ? req.body.assetClass : 'other';
    res.json(analyzeFlowPatterns({
      symbol,
      primaryInterval,
      datasets,
      params: parseParams(req.body?.params),
      source: { kind: 'import', assetClass, label: assetClass === 'stock' ? '导入股票行情' : assetClass === 'crypto' ? '导入加密资产行情' : '导入历史行情' }
    }));
  }));

  return router;
}
