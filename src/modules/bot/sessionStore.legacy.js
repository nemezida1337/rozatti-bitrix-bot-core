// @ts-check

// Legacy sync API for scripts/tests.
// Runtime path should use async APIs from `./sessionStore.js`.
import fs from "fs";
import path from "path";

import { logger } from "../../core/logger.js";

import {
  __sessionStoreBuildSessionPath,
  __sessionStoreClearSessionCache,
  __sessionStoreCtx,
  __sessionStoreDropSessionFromCache,
  __sessionStoreEnsureDir,
  __sessionStoreNormalizeSession,
  __sessionStorePath,
  __sessionStorePutSessionToCache,
  __sessionStoreTakeSessionFromCache,
  __sessionStoreTtlMs,
} from "./sessionStore.js";

export function getSession(portal, dialogId) {
  if (!portal || !dialogId) return null;

  const cached = __sessionStoreTakeSessionFromCache(portal, dialogId);
  if (cached) return cached;

  const full = __sessionStoreBuildSessionPath(portal, dialogId);

  try {
    if (!fs.existsSync(full)) {
      __sessionStoreDropSessionFromCache(portal, dialogId);
      return null;
    }

    const raw = fs.readFileSync(full, "utf8");
    const session = __sessionStoreNormalizeSession(JSON.parse(raw));
    const updatedAt = session.updatedAt || 0;
    const age = Date.now() - updatedAt;

    if (age > __sessionStoreTtlMs) {
      try {
        fs.unlinkSync(full);
      } catch (e) {
        logger.warn(
          { ctx: __sessionStoreCtx, file: full, error: String(e) },
          "Не удалось удалить просроченный файл сессии",
        );
      }
      __sessionStoreDropSessionFromCache(portal, dialogId);
      return null;
    }

    __sessionStorePutSessionToCache(portal, dialogId, session);
    return session;
  } catch (err) {
    logger.error(
      { ctx: __sessionStoreCtx, file: full, error: String(err) },
      "Ошибка чтения сессии",
    );
    __sessionStoreDropSessionFromCache(portal, dialogId);
    return null;
  }
}

export function saveSession(portal, dialogId, session) {
  if (!portal || !dialogId || !session) return;

  try {
    __sessionStoreEnsureDir(__sessionStorePath);

    const full = __sessionStoreBuildSessionPath(portal, dialogId);
    const normalized = __sessionStoreNormalizeSession(session);
    const toSave = {
      ...normalized,
      updatedAt: Date.now(),
    };
    const json = JSON.stringify(toSave, null, 2);
    const tmp = `${full}.tmp`;

    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, full);
    __sessionStorePutSessionToCache(portal, dialogId, toSave);
  } catch (err) {
    logger.error(
      { ctx: __sessionStoreCtx, portal, dialogId, error: String(err) },
      "Ошибка сохранения сессии",
    );
  }
}

export function cleanupSessions() {
  try {
    __sessionStoreEnsureDir(__sessionStorePath);
    const files = fs.readdirSync(__sessionStorePath);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const full = path.join(__sessionStorePath, file);
      let stale = false;

      try {
        const raw = fs.readFileSync(full, "utf8");
        const s = __sessionStoreNormalizeSession(JSON.parse(raw));
        const updatedAt = s.updatedAt || 0;

        if (updatedAt && Date.now() - updatedAt > __sessionStoreTtlMs) {
          stale = true;
        } else if (!updatedAt) {
          const stat = fs.statSync(full);
          const mtime = stat.mtimeMs || stat.mtime?.getTime() || 0;
          if (mtime && Date.now() - mtime > __sessionStoreTtlMs) stale = true;
        }
      } catch {
        stale = true;
      }

      if (!stale) continue;

      try {
        fs.unlinkSync(full);
      } catch (e) {
        logger.warn(
          { ctx: __sessionStoreCtx, file: full, error: String(e) },
          "Не удалось удалить устаревшую/битую сессию",
        );
      }
    }

    __sessionStoreClearSessionCache();
  } catch (err) {
    logger.error({ ctx: __sessionStoreCtx, error: String(err) }, "Ошибка cleanupSessions");
  }
}
