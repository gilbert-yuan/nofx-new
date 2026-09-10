import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';
import { useConfigStore } from '../src/stores/config.js';

test('status loads coalesce and update reactive bindings including recovery after failure', async t => {
  setActivePinia(createPinia());
  const store = useConfigStore();
  const { symbolStatus, syncStatus, statusError } = storeToRefs(store);
  let calls = 0;
  let fail = true;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify(fail ? { error: 'temporarily unavailable' } : { count: 463, interval: '15m' }),
      { status: fail ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  symbolStatus.value = { count: 1 };
  assert.equal(store.symbolStatus.count, 1);
  const first = store.loadStatus();
  const second = store.loadStatus();
  await Promise.all([first, second]);
  assert.equal(calls, 3, 'concurrent callers share the three status requests');
  assert.equal(statusError.value, 'temporarily unavailable');
  fail = false;
  await store.loadStatus();
  assert.equal(calls, 6);
  assert.equal(symbolStatus.value.count, 463);
  assert.equal(syncStatus.value.interval, '15m');
  assert.equal(statusError.value, '');
});
