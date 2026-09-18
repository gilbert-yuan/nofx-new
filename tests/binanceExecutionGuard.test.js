import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireBinanceExecutionLock,
  assertBinanceExecutionLock,
  releaseBinanceExecutionLock,
  renewBinanceExecutionLock
} from '../server/binanceExecutionGuard.js';

function memoryStore() {
  let state = {};
  return {
    getState: async () => state,
    mutateState: async fn => { state = await fn(state); return state; }
  };
}

test('execution lock uses fencing tokens: stale owners cannot release a replacement lock', async () => {
  const store = memoryStore();
  const first = await acquireBinanceExecutionLock(store, 'live:BTCUSDT:BOTH', 'worker-a', 5000);
  assert.equal(first.acquired, true);
  assert.equal((await acquireBinanceExecutionLock(store, 'live:BTCUSDT:BOTH', 'worker-b', 5000)).acquired, false);

  await store.mutateState(state => ({
    ...state,
    binanceExecutionLocks: {
      ...state.binanceExecutionLocks,
      [first.key]: { owner: 'worker-a', token: 'replacement-token', expiresAt: Date.now() + 5000 }
    }
  }));
  const replacement = await acquireBinanceExecutionLock(store, first.key, 'worker-b', 5000);
  assert.equal(replacement.acquired, false, '未过期的替换锁仍应阻止其他 owner');

  await store.mutateState(state => ({
    ...state,
    binanceExecutionLocks: {
      ...state.binanceExecutionLocks,
      [first.key]: { owner: 'worker-b', token: 'replacement-token', expiresAt: Date.now() + 5000 }
    }
  }));
  await releaseBinanceExecutionLock(store, first);
  assert.equal((await store.getState()).binanceExecutionLocks[first.key].owner, 'worker-b');
});

test('execution lock renewal extends the lease and preserves the token', async () => {
  const store = memoryStore();
  const lock = await acquireBinanceExecutionLock(store, 'demo:ETHUSDT:LONG', 'worker-a', 5000);
  const before = lock.expiresAt;
  assert.equal(await assertBinanceExecutionLock(store, lock), true);
  assert.equal(await renewBinanceExecutionLock(store, lock, 10000), true);
  assert.equal(lock.expiresAt > before, true);
  assert.equal(await assertBinanceExecutionLock(store, lock), true);
  await releaseBinanceExecutionLock(store, lock);
  assert.equal(await assertBinanceExecutionLock(store, lock), false);
});
