import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxClient } from '../server/okxClient.js';

class RecordingOkxClient extends OkxClient {
  constructor() { super({ apiKey: 'key', secretKey: 'secret', passphrase: 'pass' }); this.calls = []; }
  async signedRequest(method, path, params) { this.calls.push({ method, path, params }); return params; }
}

test('OKX order requests keep position protection attached to a new entry', async () => {
  const client = new RecordingOkxClient();
  const payload = await client.placeMarketOrder({
    symbol: 'BTCUSDT', side: 'buy', contracts: 2, tdMode: 'isolated', takeProfit: 110000, stopLoss: 90000, clOrdId: 'nofxentry123'
  });
  assert.equal(client.instId('BTCUSDT'), 'BTC-USDT-SWAP');
  assert.equal(payload.instId, 'BTC-USDT-SWAP');
  assert.equal(payload.ordType, 'market');
  assert.equal(payload.posSide, 'net');
  assert.equal(payload.attachAlgoOrds.length, 2);
  assert.equal(payload.attachAlgoOrds[0].tpOrdPx, '-1');
  assert.equal(payload.attachAlgoOrds[1].slOrdPx, '-1');
});

test('OKX protection changes use tagged conditional close orders only', async () => {
  const client = new RecordingOkxClient();
  await client.placeProtection({ instId: 'ETH-USDT-SWAP', pos: -3, takeProfit: 2800, stopLoss: 3200 });
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls.map(call => call.params.side), ['buy', 'buy']);
  assert.deepEqual(client.calls.map(call => call.params.closeFraction), ['1', '1']);
  assert.ok(client.calls.every(call => call.params.algoClOrdId.startsWith('nofx')));
});
