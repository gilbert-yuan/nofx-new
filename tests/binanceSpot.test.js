import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceSpotClient } from '../server/binanceSpotClient.js';

test('Binance Spot Demo uses /api/v3 and signs account history endpoints', async () => {
  const client = new BinanceSpotClient({ apiKey: 'A'.repeat(64), secretKey: 'B'.repeat(64), demo: true });
  const calls = [];
  client.request = async (method, endpoint, params, signed) => {
    calls.push({ method, endpoint, params, signed });
    return [];
  };

  await client.allOrders({ symbol: 'BTCUSDT', startTime: 1000, endTime: 2000 });
  await client.myTrades({ symbol: 'BTCUSDT', limit: 10 });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].endpoint, '/api/v3/allOrders');
  assert.equal(calls[1].endpoint, '/api/v3/myTrades');
  assert.equal(calls[0].signed, true);
  assert.equal(calls[0].params.symbol, 'BTCUSDT');
  assert.match(calls[0].params.signature, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].params.timestamp > 0, true);
});

test('Binance Spot Demo public market requests use the spot API path', async () => {
  const client = new BinanceSpotClient({ demo: true });
  const calls = [];
  client.request = async (method, endpoint, params, signed) => {
    calls.push({ method, endpoint, params, signed });
    return { symbols: [] };
  };
  await client.exchangeInfo();
  assert.deepEqual(calls[0], { method: 'GET', endpoint: '/api/v3/exchangeInfo', params: {}, signed: false });
});
test('Binance Spot Demo exposes account-wide symbol discovery reads', async () => {
  const client = new BinanceSpotClient({ apiKey: 'A'.repeat(64), secretKey: 'B'.repeat(64), demo: true });
  const calls = [];
  client.request = async (method, endpoint, params, signed) => {
    calls.push({ method, endpoint, params, signed });
    return [];
  };

  await client.account({ omitZeroBalances: true });
  await client.openOrders();
  await client.allOrderLists({ limit: 1000 });

  assert.equal(calls[0].endpoint, '/api/v3/account');
  assert.equal(calls[0].params.omitZeroBalances, true);
  assert.equal(calls[1].endpoint, '/api/v3/openOrders');
  assert.equal(calls[2].endpoint, '/api/v3/allOrderList');
  assert.equal(calls.every(call => call.signed), true);
});