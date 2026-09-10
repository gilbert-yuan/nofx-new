import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxClient } from '../server/okxClient.js';

const networkFailure = () => new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });

test('OKX public candles recover after transient connection failures', async () => {
  let calls = 0;
  const client = new OkxClient({ proxyUrl: '', retryDelayMs: 0, fetchImpl: async () => {
    if (++calls < 3) throw networkFailure();
    return { ok: true, json: async () => ({ code: '0', data: [['0', '1', '2', '1', '2', '10', '10', '20', '1']] }) };
  } });
  const rows = await client.klines({ symbol: 'BTCUSDT' });
  assert.equal(calls, 3);
  assert.equal(rows[0].close, 2);
});

test('OKX public retries are bounded and preserve nested network diagnostics', async () => {
  let calls = 0;
  const cause = new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error(), { code: 'ECONNREFUSED' }),
    Object.assign(new Error(), { code: 'ETIMEDOUT' })
  ]) });
  const client = new OkxClient({ proxyUrl: '', retryDelayMs: 0, fetchImpl: async () => { calls++; throw cause; } });
  await assert.rejects(client.publicRequest('/api/v5/market/candles'), error => {
    assert.equal(error.cause, cause);
    assert.equal(error.status, 502);
    assert.match(error.message, /direct; ECONNREFUSED, ETIMEDOUT/);
    return true;
  });
  assert.equal(calls, 3);
});

test('OKX never retries signed order submissions after network failure', async () => {
  let calls = 0;
  const client = new OkxClient({ apiKey: 'key', secretKey: 'secret', passphrase: 'pass', proxyUrl: '', retryDelayMs: 0,
    fetchImpl: async () => { calls++; throw networkFailure(); } });
  await assert.rejects(client.placeMarketOrder({ symbol: 'BTCUSDT', side: 'buy', contracts: 1 }), /ECONNRESET/);
  assert.equal(calls, 1);
});

test('OKX business errors and certificate failures are not retried', async () => {
  for (const fetchResult of [
    async () => ({ ok: true, status: 200, json: async () => ({ code: '51001', msg: 'Instrument does not exist' }) }),
    async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(), { code: 'CERT_HAS_EXPIRED' }) }); }
  ]) {
    let calls = 0;
    const client = new OkxClient({ proxyUrl: '', retryDelayMs: 0, fetchImpl: async () => { calls++; return fetchResult(); } });
    await assert.rejects(client.publicRequest('/api/v5/market/candles'));
    assert.equal(calls, 1);
  }
});

test('OKX proxy configuration is read when constructing the client and supports explicit direct access', async t => {
  const previous = process.env.OKX_PROXY_URL;
  t.after(() => { if (previous === undefined) delete process.env.OKX_PROXY_URL; else process.env.OKX_PROXY_URL = previous; });
  process.env.OKX_PROXY_URL = '';
  assert.equal(new OkxClient().dispatcher, undefined);
  process.env.OKX_PROXY_URL = 'http://127.0.0.1:7890';
  const client = new OkxClient();
  assert.equal(client.connectionMode, 'proxy');
  await client.dispatcher.close();
  assert.equal(new OkxClient({ proxyUrl: '' }).dispatcher, undefined);
});

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
