// @ts-check

import fsp from "node:fs/promises";
import path from "path";

import { logger } from "./logger.js";

/**
 * @typedef {Object} PortalRecord
 * @property {string} [domain]
 * @property {string} [baseUrl]
 * @property {string} [accessToken]
 * @property {string} [access_token]
 * @property {string} [refreshToken]
 * @property {string} [refresh_token]
 * @property {string|number} [expires]
 * @property {number} [expiresAt]
 * @property {string} [memberId]
 * @property {string} [member_id]
 * @property {string} [applicationToken]
 * @property {string} [application_token]
 * @property {string} [userId]
 * @property {string|number} [user_id]
 * @property {string} [updatedAt]
 */

/** @typedef {Record<string, PortalRecord>} PortalStore */

/**
 * @param {PortalRecord|undefined} record
 * @param {string} [domainHint]
 * @returns {PortalRecord}
 */
function normalizePortalRecord(record, domainHint) {
  const src = record || {};
  /** @type {PortalRecord} */
  const out = { ...src };

  const accessToken = src.accessToken || src.access_token;
  const refreshToken = src.refreshToken || src.refresh_token;
  const memberId = src.memberId || src.member_id;
  const applicationToken = src.applicationToken || src.application_token;
  const userIdRaw = src.userId ?? src.user_id;
  const domain = src.domain || domainHint;

  if (accessToken) out.accessToken = String(accessToken);
  if (refreshToken) out.refreshToken = String(refreshToken);
  if (memberId) out.memberId = String(memberId);
  if (applicationToken) out.applicationToken = String(applicationToken);
  if (userIdRaw != null) out.userId = String(userIdRaw);
  if (domain) out.domain = String(domain);

  delete out.access_token;
  delete out.refresh_token;
  delete out.member_id;
  delete out.application_token;
  delete out.user_id;

  return out;
}

/**
 * @param {PortalStore} store
 * @returns {PortalStore}
 */
function normalizeStore(store) {
  /** @type {PortalStore} */
  const out = {};
  for (const [domain, rec] of Object.entries(store || {})) {
    out[domain] = normalizePortalRecord(rec, domain);
  }
  return out;
}

function getFilePath() {
  const tokensFile = process.env.TOKENS_FILE || "./data/portals.json";
  return path.resolve(process.cwd(), tokensFile);
}

function getAsyncStoreCacheTtlMs() {
  const n = Number(process.env.STORE_CACHE_TTL_MS || 1500);
  if (!Number.isFinite(n) || n < 0) return 1500;
  return Math.trunc(n);
}

function cloneStore(store) {
  const src = store && typeof store === "object" ? store : {};
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(src);
  }
  return JSON.parse(JSON.stringify(src));
}

/** @type {{ filePath: string|null, loadedAt: number, store: PortalStore|null, pending: Promise<PortalStore>|null }} */
const asyncStoreCache = {
  filePath: null,
  loadedAt: 0,
  store: null,
  pending: null,
};

function setAsyncStoreCache(filePath, store) {
  asyncStoreCache.filePath = filePath;
  asyncStoreCache.loadedAt = Date.now();
  asyncStoreCache.store = cloneStore(store);
  asyncStoreCache.pending = null;
}

function resetAsyncStoreCache(filePath = null) {
  if (filePath && asyncStoreCache.filePath && asyncStoreCache.filePath !== filePath) return;
  asyncStoreCache.filePath = filePath;
  asyncStoreCache.loadedAt = 0;
  asyncStoreCache.store = null;
  asyncStoreCache.pending = null;
}

async function ensureDirAsync(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function safeRenameAsync(tmpPath, filePath) {
  try {
    await fsp.rename(tmpPath, filePath);
  } catch (e) {
    const err = /** @type {{ code?: string }} */ (e);
    if (err && (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EBUSY")) {
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tmpPath, filePath);
      return;
    }
    throw e;
  }
}

/** @returns {Promise<PortalStore>} */
export async function loadStoreAsync() {
  const filePath = getFilePath();

  const ttlMs = getAsyncStoreCacheTtlMs();
  const cachedIsFresh =
    asyncStoreCache.filePath === filePath &&
    !!asyncStoreCache.store &&
    Date.now() - asyncStoreCache.loadedAt <= ttlMs;
  if (cachedIsFresh) return cloneStore(asyncStoreCache.store);

  if (asyncStoreCache.filePath === filePath && asyncStoreCache.pending) {
    const shared = await asyncStoreCache.pending;
    return cloneStore(shared);
  }

  const pendingLoad = (async () => {
    try {
      const rawText = await fsp.readFile(filePath, "utf8");
      const raw = /** @type {PortalStore} */ (JSON.parse(rawText));
      const normalized = normalizeStore(raw);
      setAsyncStoreCache(filePath, normalized);
      return normalized;
    } catch (e) {
      const err = /** @type {{ code?: string }} */ (e);
      if (err?.code === "ENOENT") {
        setAsyncStoreCache(filePath, {});
        return {};
      }
      logger.error({ e }, "Failed to load token store");
      setAsyncStoreCache(filePath, {});
      return {};
    }
  })();

  asyncStoreCache.filePath = filePath;
  asyncStoreCache.pending = pendingLoad;

  try {
    const loaded = await pendingLoad;
    return cloneStore(loaded);
  } finally {
    if (asyncStoreCache.pending === pendingLoad) {
      asyncStoreCache.pending = null;
    }
  }
}

/** @param {PortalStore} obj */
export async function saveStoreAsync(obj) {
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const normalized = normalizeStore(obj);
  try {
    await ensureDirAsync(dir);
    const json = JSON.stringify(normalized, null, 2);
    await fsp.writeFile(tmpPath, json, "utf8");
    await safeRenameAsync(tmpPath, filePath);
    setAsyncStoreCache(filePath, normalized);
  } catch (e) {
    logger.error({ e }, "Failed to save token store");
    resetAsyncStoreCache(filePath);
  } finally {
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * @param {string} domain
 * @param {PortalRecord} data
 * @returns {Promise<PortalRecord>}
 */
export async function upsertPortalAsync(domain, data) {
  const store = await loadStoreAsync();
  store[domain] = normalizePortalRecord(
    {
      ...(store[domain] || {}),
      ...data,
      domain,
      updatedAt: new Date().toISOString(),
    },
    domain,
  );
  await saveStoreAsync(store);
  return store[domain];
}

/**
 * @param {string} domain
 * @returns {Promise<PortalRecord|undefined>}
 */
export async function getPortalAsync(domain) {
  const store = await loadStoreAsync();
  const portal = store[domain];
  if (!portal) return undefined;
  return normalizePortalRecord(portal, domain);
}

export {
  getFilePath as __storeGetFilePath,
  normalizePortalRecord as __storeNormalizePortalRecord,
  normalizeStore as __storeNormalizeStore,
  resetAsyncStoreCache as __storeResetAsyncStoreCache,
  setAsyncStoreCache as __storeSetAsyncStoreCache,
};
