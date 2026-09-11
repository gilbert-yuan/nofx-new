// 探测：代理连通性 + OKX 1m K 线拉取速度
import { OkxClient } from '../server/okxClient.js';

const client = new OkxClient({ proxyUrl: 'http://127.0.0.1:7890' });

const t0 = Date.now();
const insts = await client.perpetualUsdtContracts();
console.log(`合约数=${insts.length}  耗时=${Date.now() - t0}ms`);
console.log('样例:', insts.slice(0, 3).map(x => x.symbol).join(', '));

const t1 = Date.now();
const rows = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300 });
console.log(`BTCUSDT 1m 一页 ${rows.length} 根 耗时=${Date.now() - t1}ms`);
console.log('首根:', new Date(rows[0].openTime).toISOString(), '末根:', new Date(rows.at(-1).openTime).toISOString(), 'close=', rows.at(-1).close);

// 分页能力测试：用 after/before 翻页
const t2 = Date.now();
let cursor = rows[0].openTime;
const older = await client.klines({ symbol: 'BTCUSDT', interval: '1m', limit: 300, before: cursor });
console.log(`向前翻页 ${older.length} 根 耗时=${Date.now() - t2}ms`);
if (older.length) console.log('旧数据范围:', new Date(older[0].openTime).toISOString(), '~', new Date(older.at(-1).openTime).toISOString());

// tickers 一次拿全市场成交额
const t3 = Date.now();
const tk = await client.publicRequest('/api/v5/market/tickers', { instType: 'SWAP' });
console.log(`tickers=${tk.length} 耗时=${Date.now() - t3}ms`);
