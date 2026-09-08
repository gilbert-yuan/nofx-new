import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.js';
test('API merges headers and rejects malformed JSON instead of returning an empty success', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['X-Test'], 'yes');
    return new Response('{broken', { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(api('/config', { headers: { 'X-Test': 'yes' } }), /格式无效/);
});
test('API timeout releases waiting UI and caller cancellation remains silent AbortError', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  await assert.rejects(api('/market/klines', { timeoutMs: 10 }), /超时/);
  const controller = new AbortController();
  const pending = api('/market/klines', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
test('API preserves structured server errors and successful payloads', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 409, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(api('/market/analyze', { method: 'POST' }), { message: 'busy', status: 409 });
  fetch.mock.mockImplementation(async () => new Response('{"rows":[]}', { headers: { 'content-type': 'application/json' } }));
  assert.deepEqual(await api('/market/klines'), { rows: [] });
});
