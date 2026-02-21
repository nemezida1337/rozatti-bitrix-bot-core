import assert from "node:assert/strict";
import test from "node:test";

import {
  claimRedisIdempotency,
  clearRedisIdempotency,
  isRedisConfigured,
  setRedisIdempotency,
  withRedisLock,
} from "../core/distributedState.js";

const originalEnv = {
  REDIS_URL: process.env.REDIS_URL,
  REDIS_ENABLED: process.env.REDIS_ENABLED,
};

function restoreEnv() {
  if (originalEnv.REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalEnv.REDIS_URL;

  if (originalEnv.REDIS_ENABLED === undefined) delete process.env.REDIS_ENABLED;
  else process.env.REDIS_ENABLED = originalEnv.REDIS_ENABLED;
}

test.beforeEach(() => {
  delete process.env.REDIS_URL;
  process.env.REDIS_ENABLED = "1";
});

test.after(() => {
  restoreEnv();
});

test("distributedState: reports redis disabled when REDIS_URL is empty", () => {
  delete process.env.REDIS_URL;
  assert.equal(isRedisConfigured(), false);
});

test("distributedState: withRedisLock falls back to local execution without REDIS_URL", async () => {
  delete process.env.REDIS_URL;
  const result = await withRedisLock(
    {
      scope: "test_lock",
      key: "k1",
      ttlMs: 1000,
      waitTimeoutMs: 1000,
      pollMs: 10,
    },
    async (meta) => ({
      ok: true,
      backend: meta?.backend || null,
      lock: meta?.lock || null,
    }),
  );

  assert.deepEqual(result, { ok: true, backend: "local", lock: "disabled" });
});

test("distributedState: idempotency helpers return fallback values without REDIS_URL", async () => {
  delete process.env.REDIS_URL;

  const claim = await claimRedisIdempotency({
    scope: "test_idem",
    key: "k2",
    ttlMs: 1000,
    value: "1",
  });
  const setOk = await setRedisIdempotency({
    scope: "test_idem",
    key: "k2",
    ttlMs: 1000,
    value: "1",
  });
  const clearOk = await clearRedisIdempotency({
    scope: "test_idem",
    key: "k2",
  });

  assert.equal(claim, null);
  assert.equal(setOk, false);
  assert.equal(clearOk, false);
});
