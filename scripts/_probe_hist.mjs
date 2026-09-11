import { OkxClient } from '../server/okxClient.js';
const client = new OkxClient({ proxyUrl: 'http://127.0.0.1:7890' });

const raw = await client.publicRequest('/api/v5/market/history-candles', { instId: 'BTC-USDT-SWAP', bar: '1m', limit: 100 });
const rows = raw.map(r => ({ openTime: Number(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
  .sort((a, b) => a.openTime - b.openTime);
console.log('history n=', rows.length, new Date(rows[0].openTime).toISOString(), '~', new Date(rows.at(-1).openTime).toISOString());

let cursor = rows[0].openTime;
const t0 = Date.now();
for (let p = 1; p <= 20; p++) {
  const r = await client.publicRequest('/api/v5/market/history-candles', { instId: 'BTC-USDT-SWAP', bar: '1m', limit: 100, after: cursor });
  if (!r.length) { console.log(`page${p} empty`); break; }
  const m = r.map(x => ({ openTime: Number(x[0]) })).sort((a, b) => a.openTime - b.openTime);
  cursor = m[0].openTime;
  if (p % 5 === 0) console.log(`page${p} 最早=${new Date(cursor).toISOString()} n=${r.length}`);
}
console.log('20页耗时', Date.now() - t0, 'ms; 最早', new Date(cursor).toISOString(), '距今天=', ((Date.now() - cursor) / 86400000).toFixed(2));
