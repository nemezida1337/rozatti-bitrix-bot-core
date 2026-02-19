// @ts-check

import fs from "fs";
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

/** @returns {PortalStore} */
export function loadStore() {
  const filePath = getFilePath();
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = /** @type {PortalStore} */ (JSON.parse(fs.readFileSync(filePath, "utf8")));
    return normalizeStore(raw);
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
    const json = JSON.stringify(normalizeStore(obj), null, 2);

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
  store[domain] = normalizePortalRecord(
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

/**
 * @param {string} domain
 * @returns {PortalRecord|undefined}
 */
export function getPortal(domain) {
  const store = loadStore();
  const portal = store[domain];
  if (!portal) return undefined;
  return normalizePortalRecord(portal, domain);
}
