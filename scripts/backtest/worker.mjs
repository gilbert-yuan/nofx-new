import { parentPort } from 'node:worker_threads';
import { replay } from './replay.mjs';
import { dataset } from './replay.mjs';
import { coverage } from './data.mjs';
parentPort.on('message', async job => {
  try {
    let result;
    if (job.kind === 'audit') { const d = await dataset(job.file, job.config); result = { symbol: job.symbol, ...coverage(d.data, job.config, d.quality) }; }
    else if (job.kind === 'batch') {
      result = [];
      // Consecutive segments/trials of the same coin reuse its parsed candle columns.
      for (const item of job.jobs) {
        try { result.push(await replay(item)); }
        catch (e) { result.push({ symbol: item.symbol, strategyId: item.strategyId, status: 'error', reason: e.message,
          params: item.params, execution: item.execution, costs: item.costs, metrics: null, trades: [], featureSamples: [] }); }
      }
    } else result = await replay(job);
    parentPort.postMessage({ id: job.id, result });
  } catch (e) { parentPort.postMessage({ id: job.id, error: e.message }); }
});
