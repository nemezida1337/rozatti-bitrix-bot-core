// @ts-check

// Legacy sync API for scripts/tests.
// Runtime path should use async APIs from `./store.js`.
import fs from "fs";
import path from "path";

import { logger } from "./logger.js";
import {
  __storeGetFilePath,
  __storeNormalizePortalRecord,
  __storeNormalizeStore,
  __storeResetAsyncStoreCache,
  __storeSetAsyncStoreCache,
} from "./store.js";

export function loadStore() {
  const filePath = __storeGetFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const normalized = __storeNormalizeStore(raw);
    __storeSetAsyncStoreCache(filePath, normalized);
    return normalized;
  } catch (e) {
    logger.error({ e }, "Failed to load token store");
    __storeResetAsyncStoreCache(filePath);
    return {};
  }
}

export function saveStore(obj) {
  const filePath = __storeGetFilePath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const normalized = __storeNormalizeStore(obj);
    const json = JSON.stringify(normalized, null, 2);

    fs.writeFileSync(tmpPath, json, "utf8");

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      const err = /** @type {{ code?: string }} */ (e);
      if (err && (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EBUSY")) {
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tmpPath, filePath);
      } else {
        throw e;
      }
    } finally {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          // ignore cleanup error
        }
      }
    }
    __storeSetAsyncStoreCache(filePath, normalized);
  } catch (e) {
    logger.error({ e }, "Failed to save token store");
    __storeResetAsyncStoreCache(filePath);
  }
}

export function upsertPortal(domain, data) {
  const store = loadStore();
  store[domain] = __storeNormalizePortalRecord(
    {
      ...(store[domain] || {}),
      ...data,
      domain,
      updatedAt: new Date().toISOString(),
    },
    domain,
  );
  saveStore(store);
  return store[domain];
}

export function getPortal(domain) {
  const store = loadStore();
  const portal = store[domain];
  if (!portal) return undefined;
  return __storeNormalizePortalRecord(portal, domain);
}
