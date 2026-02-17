// @ts-check

import fs from "fs";
import path from "path";

import { logger } from "./logger.js";

/**
 * @typedef {Object} PortalRecord
 * @property {string} [domain]
 * @property {string} [baseUrl]
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {string|number} [expires]
 * @property {number} [expiresAt]
 * @property {string} [updatedAt]
 */

/** @typedef {Record<string, PortalRecord>} PortalStore */

function getFilePath() {
  const tokensFile = process.env.TOKENS_FILE || "./data/portals.json";
  return path.resolve(process.cwd(), tokensFile);
}

/** @returns {PortalStore} */
export function loadStore() {
  const filePath = getFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    return /** @type {PortalStore} */ (JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (e) {
    logger.error({ e }, "Failed to load token store");
    return {};
  }
}

/** @param {PortalStore} obj */
export function saveStore(obj) {
  const filePath = getFilePath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Атомарная запись: пишем во временный файл и затем делаем rename.
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const json = JSON.stringify(obj, null, 2);

    fs.writeFileSync(tmpPath, json, "utf8");

    try {
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      const err = /** @type {{ code?: string }} */ (e);
      // На некоторых системах rename поверх существующего файла может падать.
      // Фоллбек: удаляем старый файл и повторяем rename.
      if (
        err &&
        (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EBUSY")
      ) {
        try {
          fs.rmSync(filePath, { force: true });
          fs.renameSync(tmpPath, filePath);
        } catch (e2) {
          throw e2;
        }
      } else {
        throw e;
      }
    } finally {
      // Если что-то пошло не так — подчистим временный файл.
      if (fs.existsSync(tmpPath)) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {
          // ignore cleanup error
        }
      }
    }
  } catch (e) {
    logger.error({ e }, "Failed to save token store");
  }
}

/**
 * @param {string} domain
 * @param {PortalRecord} data
 * @returns {PortalRecord}
 */
export function upsertPortal(domain, data) {
  const store = loadStore();
  store[domain] = { ...(store[domain] || {}), ...data, updatedAt: new Date().toISOString() };
  saveStore(store);
  return store[domain];
}

/**
 * @param {string} domain
 * @returns {PortalRecord|undefined}
 */
export function getPortal(domain) {
  const store = loadStore();
  return store[domain];
}
