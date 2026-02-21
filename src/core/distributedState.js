import { randomUUID } from "node:crypto";

import { createClient } from "redis";

import { logger } from "./logger.js";

const CTX = "core/distributedState";
const LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

let _redisClientPromise = null;
let _redisCooldownUntil = 0;

function isTruthy(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRedisFeatureEnabled(env = process.env) {
  const enabledRaw = env?.REDIS_ENABLED;
  if (enabledRaw != null && String(enabledRaw).trim() !== "") {
    return isTruthy(enabledRaw);
  }
  return true;
}

function getRedisUrl(env = process.env) {
  return String(env?.REDIS_URL || "").trim();
}

export function isRedisConfigured(env = process.env) {
  if (!isRedisFeatureEnabled(env)) return false;
  return !!getRedisUrl(env);
}

function getRedisPrefix(env = process.env) {
  const raw = String(env?.REDIS_KEY_PREFIX || "").trim();
  return raw || "bitrixbot";
}

function buildScopedKey(scope, key, env = process.env) {
  const prefix = getRedisPrefix(env);
  return `${prefix}:${String(scope || "default")}::${String(key || "unknown")}`;
}

function markRedisCooldown() {
  const cooldownMs = toPositiveInt(process.env.REDIS_RECONNECT_COOLDOWN_MS, 10000);
  _redisCooldownUntil = Date.now() + cooldownMs;
}

async function getRedisClient() {
  if (!isRedisConfigured()) return null;
  if (Date.now() < _redisCooldownUntil) return null;

  if (_redisClientPromise) {
    const existing = await _redisClientPromise;
    if (existing && existing.isOpen) return existing;
    _redisClientPromise = null;
  }

  _redisClientPromise = (async () => {
    const redisUrl = getRedisUrl();
    const connectTimeout = toPositiveInt(process.env.REDIS_CONNECT_TIMEOUT_MS, 1500);
    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout,
      },
    });

    client.on("error", (err) => {
      logger.warn({ ctx: CTX, err: String(err) }, "Redis client error");
    });

    try {
      await client.connect();
      logger.info({ ctx: CTX }, "Redis connected");
      return client;
    } catch (err) {
      logger.warn({ ctx: CTX, err: String(err) }, "Redis connect failed, fallback to local state");
      markRedisCooldown();
      try {
        client.destroy();
      } catch {
        // ignore
      }
      return null;
    }
  })();

  return _redisClientPromise;
}

async function runRedis(op, fn, { quiet = false } = {}) {
  const client = await getRedisClient();
  if (!client) return { available: false, ok: false, value: null };

  try {
    const value = await fn(client);
    return { available: true, ok: true, value };
  } catch (err) {
    if (!quiet) {
      logger.warn(
        { ctx: CTX, op, err: String(err) },
        "Redis command failed, fallback to local state",
      );
    }
    markRedisCooldown();
    return { available: true, ok: false, value: null };
  }
}

function resolveLockConfig(options = {}) {
  return {
    ttlMs: toPositiveInt(options.ttlMs, toPositiveInt(process.env.REDIS_LOCK_TTL_MS, 45000)),
    waitTimeoutMs: toPositiveInt(
      options.waitTimeoutMs,
      toPositiveInt(process.env.REDIS_LOCK_WAIT_MS, 45000),
    ),
    pollMs: toPositiveInt(options.pollMs, toPositiveInt(process.env.REDIS_LOCK_POLL_MS, 120)),
  };
}

/**
 * Выполняет `task` под cross-process lock (Redis), если Redis доступен.
 * При недоступном Redis просто выполняет task без distributed lock.
 */
export async function withRedisLock(options, task) {
  const scope = options?.scope || "lock";
  const key = options?.key || "unknown";
  const { ttlMs, waitTimeoutMs, pollMs } = resolveLockConfig(options);

  if (!isRedisConfigured()) {
    return task({ backend: "local", lock: "disabled" });
  }

  const lockKey = buildScopedKey(scope, key);
  const token = randomUUID();
  const startedAt = Date.now();
  let acquired = false;

  while (Date.now() - startedAt <= waitTimeoutMs) {
    const acquire = await runRedis("lock.acquire", (client) =>
      client.set(lockKey, token, { NX: true, PX: ttlMs }),
    );

    if (!acquire.available || !acquire.ok) {
      return task({ backend: "local", lock: "redis_unavailable" });
    }

    if (acquire.value === "OK") {
      acquired = true;
      break;
    }

    await sleep(pollMs);
  }

  if (!acquired) {
    logger.warn(
      { ctx: CTX, scope, key, waitTimeoutMs },
      "Redis lock wait timeout, executing without distributed lock",
    );
    return task({ backend: "local", lock: "wait_timeout" });
  }

  const renewEveryMs = Math.max(1000, Math.floor(ttlMs / 3));
  const renewTimer = setInterval(async () => {
    await runRedis("lock.renew", (client) => client.set(lockKey, token, { XX: true, PX: ttlMs }), {
      quiet: true,
    });
  }, renewEveryMs);
  renewTimer.unref?.();

  try {
    return await task({ backend: "redis", lockKey });
  } finally {
    clearInterval(renewTimer);
    await runRedis(
      "lock.release",
      (client) =>
        client.eval(LOCK_RELEASE_SCRIPT, {
          keys: [lockKey],
          arguments: [token],
        }),
      { quiet: true },
    );
  }
}

/**
 * Пытается атомарно "захватить" idempotency key в Redis (SET NX PX).
 * Если Redis недоступен, вернет null — caller должен использовать local fallback.
 */
export async function claimRedisIdempotency(options = {}) {
  const scope = options?.scope || "idempotency";
  const key = options?.key || "unknown";
  const ttlMs = toPositiveInt(options?.ttlMs, 600000);
  const value = String(options?.value ?? "1");

  if (!isRedisConfigured()) return null;

  const redisKey = buildScopedKey(scope, key);
  const claim = await runRedis("idempotency.claim", (client) =>
    client.set(redisKey, value, { NX: true, PX: ttlMs }),
  );

  if (!claim.available || !claim.ok) return null;
  if (claim.value === "OK") {
    return { claimed: true, existingValue: null };
  }

  const existing = await runRedis("idempotency.get_existing", (client) => client.get(redisKey));
  if (!existing.available || !existing.ok) return null;

  return {
    claimed: false,
    existingValue:
      typeof existing.value === "string"
        ? existing.value
        : existing.value == null
          ? null
          : String(existing.value),
  };
}

export async function setRedisIdempotency(options = {}) {
  const scope = options?.scope || "idempotency";
  const key = options?.key || "unknown";
  const ttlMs = toPositiveInt(options?.ttlMs, 600000);
  const value = String(options?.value ?? "1");

  if (!isRedisConfigured()) return false;

  const redisKey = buildScopedKey(scope, key);
  const res = await runRedis("idempotency.set", (client) =>
    client.set(redisKey, value, { PX: ttlMs }),
  );
  return !!res.available && !!res.ok;
}

export async function clearRedisIdempotency(options = {}) {
  const scope = options?.scope || "idempotency";
  const key = options?.key || "unknown";

  if (!isRedisConfigured()) return false;

  const redisKey = buildScopedKey(scope, key);
  const res = await runRedis("idempotency.clear", (client) => client.del(redisKey));
  return !!res.available && !!res.ok;
}
