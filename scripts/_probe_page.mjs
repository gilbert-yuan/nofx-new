import { OkxClient } from '../server/okxClient.js';
const client = new OkxClient({ proxyUrl: 'http://127.0.0.1:7890' });

const base = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300 });
const first = base[0].openTime, last = base.at(-1).openTime;
console.log('base:', new Date(first).toISOString(), '~', new Date(last).toISOString());

for (const param of ['before', 'after']) {
  for (const val of [first, last]) {
    const r = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300, [param]: val });
    const f = r.length ? new Date(r[0].openTime).toISOString() : '-';
    const l = r.length ? new Date(r.at(-1).openTime).toISOString() : '-';
    console.log(`${param}=${val}(${new Date(val).toISOString().slice(5, 16)}) -> n=${r.length} ${f} ~ ${l}`);
  }
}
// 带 endTime 试试
const r2 = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300, before: first - 1 });
console.log('before=first-1 ->', r2.length, r2.length ? new Date(r2.at(-1).openTime).toISOString() : '');
