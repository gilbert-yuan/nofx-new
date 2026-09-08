import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxPositionMonitor } from '../server/okxPositionMonitor.js';

test('OKX position review is fail-closed until automation is explicitly enabled', async () => {
  let decisions = 0;
  const monitor = new OkxPositionMonitor({
    store: {
      async getConfig() { return { trader: { enabled: false }, okx: {} }; },
      async addDecision() { decisions += 1; }
    },
    marketDb: {}
  });
  const result = await monitor.reviewAfterKlines({ interval: '15m' });
  assert.equal(result.status, 'disabled');
  assert.equal(decisions, 0);
  assert.equal((await monitor.status()).running, false);
});
