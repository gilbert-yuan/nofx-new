import { OkxClient } from '../server/okxClient.js';
const client = new OkxClient({ proxyUrl: 'http://127.0.0.1:7890' });

let rows = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300 });
let cursor = rows[0].openTime;
console.log('page0', new Date(cursor).toISOString());
for (let p = 1; p <= 30; p++) {
  const r = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300, after: cursor });
  if (!r.length) { console.log(`page${p} empty -> 深度到此为止`); break; }
  cursor = r[0].openTime;
  if (p % 5 === 0 || p === 30) console.log(`page${p} 最早=${new Date(cursor).toISOString()} n=${r.length}`);
}
console.log('最终可达最早:', new Date(cursor).toISOString(), '距今(天)=', ((Date.now() - cursor) / 86400000).toFixed(2));
