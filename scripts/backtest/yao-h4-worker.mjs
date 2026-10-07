import fs from 'node:fs';
import zlib from 'node:zlib';
import { parentPort } from 'node:worker_threads';
import { scanCoin } from './yao-h4.mjs';
parentPort.on('message', async job => {
  try {
    const result = await scanCoin(job);
    fs.writeFileSync(job.output, zlib.gzipSync(JSON.stringify(result), { level: 1 }));
    parentPort.postMessage({ symbol: job.symbol, audit: result.audit, funnel: result.funnel,
      counts: result.opportunities.map(xs => xs.length) });
  } catch (e) { parentPort.postMessage({ error: e.stack }); }
});
