import { createHash, randomUUID } from 'node:crypto';

// The lock is deliberately persisted through the shared state store.  An
// in-memory mutex protects only one Node process and is not enough when a
// review request overlaps a background synchronizer or the service restarts.
export const BINANCE_EXECUTION_LOCK_TTL_MS = 120000;

export function createExecutionOwner(prefix = 'nofx') {
  return `${prefix}-${randomUUID()}`;
}

export function executionLockKey({ environment = 'live', symbol, positionSide = 'BOTH' } = {}) {
  return [environment, String(symbol || '').toUpperCase(), String(positionSide || 'BOTH').toUpperCase()].join(':');
}

/**
 * Binance client IDs are the durable idempotency key for an exchange action.
 * Keep them short, deterministic, and within Binance's allowed character set.
 */
export function deterministicBinanceClientOrderId(kind, ...parts) {
  const digest = createHash('sha256')
    .update([kind, ...parts].map(value => String(value ?? '')).join('|'))
    .digest('hex')
    .slice(0, 24);
  return `nofx_${String(kind).replace(/[^a-z0-9_]/gi, '_').slice(0, 9)}_${digest}`.slice(0, 36);
}

export async function acquireBinanceExecutionLock(store, key, owner, ttlMs = BINANCE_EXECUTION_LOCK_TTL_MS) {
  if (!store || typeof store.mutateState !== 'function') return { acquired: true, key, owner, token: randomUUID(), ephemeral: true };

  const now = Date.now();
  const expiresAt = now + Math.max(5000, Number(ttlMs) || BINANCE_EXECUTION_LOCK_TTL_MS);
  const token = randomUUID();
  let acquired = false;

  await store.mutateState(state => {
    const locks = state.binanceExecutionLocks || {};
    const current = locks[key];
    if (current && Number(current.expiresAt) > now && current.owner !== owner) return state;

    acquired = true;
    const active = Object.fromEntries(Object.entries(locks)
      .filter(([lockKey, lock]) => lockKey === key || Number(lock?.expiresAt) > now)
      .slice(-255));
    active[key] = {
      owner,
      token,
      acquiredAt: new Date(now).toISOString(),
      expiresAt
    };
    return { ...state, binanceExecutionLocks: active };
  });

  return { acquired, key, owner, token, expiresAt, ttlMs: Math.max(5000, Number(ttlMs) || BINANCE_EXECUTION_LOCK_TTL_MS) };
}

export async function renewBinanceExecutionLock(store, lock, ttlMs = lock?.ttlMs || BINANCE_EXECUTION_LOCK_TTL_MS) {
  if (!lock?.acquired || lock.ephemeral || !store || typeof store.mutateState !== 'function') return true;
  const now = Date.now();
  const expiresAt = now + Math.max(5000, Number(ttlMs) || BINANCE_EXECUTION_LOCK_TTL_MS);
  let renewed = false;
  await store.mutateState(state => {
    const current = state.binanceExecutionLocks?.[lock.key];
    if (!current || current.owner !== lock.owner || current.token !== lock.token || Number(current.expiresAt) <= now) return state;
    renewed = true;
    return {
      ...state,
      binanceExecutionLocks: {
        ...state.binanceExecutionLocks,
        [lock.key]: { ...current, expiresAt }
      }
    };
  });
  if (renewed) lock.expiresAt = expiresAt;
  return renewed;
}

export async function assertBinanceExecutionLock(store, lock) {
  if (!lock?.acquired || lock.ephemeral || !store || typeof store.getState !== 'function') return true;
  const current = (await store.getState()).binanceExecutionLocks?.[lock.key];
  return Boolean(current
    && current.owner === lock.owner
    && current.token === lock.token
    && Number(current.expiresAt) > Date.now());
}

export function startBinanceExecutionLease(store, lock, ttlMs = lock?.ttlMs || BINANCE_EXECUTION_LOCK_TTL_MS) {
  if (!lock?.acquired || lock.ephemeral || !store || typeof store.mutateState !== 'function') {
    return { stop: async () => {}, healthy: () => true };
  }
  const intervalMs = Math.max(1000, Math.floor((Number(ttlMs) || BINANCE_EXECUTION_LOCK_TTL_MS) / 3));
  let stopped = false;
  let healthy = true;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (!await renewBinanceExecutionLock(store, lock, ttlMs)) healthy = false;
    }).catch(() => { healthy = false; });
  }, intervalMs);
  timer.unref?.();
  return {
    healthy: () => healthy,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await pending;
    }
  };
}

export async function releaseBinanceExecutionLock(store, lock) {
  if (!lock?.acquired || lock.ephemeral || !store || typeof store.mutateState !== 'function') return;
  await store.mutateState(state => {
    const locks = state.binanceExecutionLocks || {};
    if (locks[lock.key]?.owner !== lock.owner || locks[lock.key]?.token !== lock.token) return state;
    const next = { ...locks };
    delete next[lock.key];
    return { ...state, binanceExecutionLocks: next };
  });
}
