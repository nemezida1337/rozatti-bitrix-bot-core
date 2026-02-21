// src/modules/bot/sessionStore.js (v4)
// Лёгкое и безопасное хранилище сессий.
// TTL = 24 часа, авто-очистка, структура совместима с handler_llm_manager.js
//
// Добавлено (v4):
// - session.mode: "auto" | "manual"
// - session.manualAckSent: boolean
// - session.oem_candidates: string[]
// - session.lastSeenLeadOem: string | null (для 100% OEM-trigger менеджера)
// - нормализация структуры для старых сессий
// - updatedAt всегда обновляется при сохранении (TTL "скользящий")
// - атомарная запись: write tmp -> rename

import fs from "fs";
import fsp from "node:fs/promises";
import path from "path";

import { logger } from "../../core/logger.js";

const CTX = "sessionStore";

const SESSIONS_PATH = path.resolve("./data/sessions");
const TTL_MS = 24 * 60 * 60 * 1000; // 24 часа
const CACHE_TTL_MS = (() => {
  const n = Number(process.env.SESSION_CACHE_TTL_MS || 3000);
  if (!Number.isFinite(n) || n <= 0) return 3000;
  return Math.trunc(n);
})();

/** @type {Map<string, { session: any, loadedAt: number }>} */
const SESSION_CACHE = new Map();

ensureDir(SESSIONS_PATH);

const DEFAULT_MODE = "auto"; // "auto" | "manual"

function buildDefaultSession() {
  return {
    // gate/session behavior flags
    mode: DEFAULT_MODE,
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
    // Признак, что lastSeenLeadOem уже синхронизирован с фактическим OEM в лиде.
    // Нужен, чтобы после рестарта не срабатывать ложно на "старый" OEM.
    leadOemBaselineInitialized: false,
    // Короткая история последних turn'ов диалога для контекстных ответов.
    history: [],

    // timestamps
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Нормализует структуру сессии:
 * - добавляет недостающие поля
 * - приводит типы к ожидаемым
 * - ничего не удаляет (чтобы не ломать обратную совместимость)
 */
function normalizeSession(session) {
  const base = buildDefaultSession();
  const s = session && typeof session === "object" ? session : {};
  const merged = { ...base, ...s };

  // mode
  if (merged.mode !== "auto" && merged.mode !== "manual") {
    merged.mode = DEFAULT_MODE;
  }

  // manualAckSent
  merged.manualAckSent = Boolean(merged.manualAckSent);

  // oem_candidates
  if (!Array.isArray(merged.oem_candidates)) {
    merged.oem_candidates = [];
  } else {
    merged.oem_candidates = merged.oem_candidates
      .map((x) => String(x || "").trim())
      .filter(Boolean);
  }

  // lastSeenLeadOem
  if (merged.lastSeenLeadOem === undefined) {
    merged.lastSeenLeadOem = null;
  }
  if (merged.lastSeenLeadOem !== null) {
    const v = String(merged.lastSeenLeadOem || "").trim();
    merged.lastSeenLeadOem = v ? v : null;
  }

  // baseline flag
  merged.leadOemBaselineInitialized = Boolean(merged.leadOemBaselineInitialized);

  // history
  if (!Array.isArray(merged.history)) {
    merged.history = [];
  } else {
    const maxHistory = Number(process.env.SESSION_HISTORY_MAX_TURNS || 40);
    const normalizedHistory = [];
    for (const item of merged.history) {
      if (!item || typeof item !== "object") continue;
      const role = String(item.role || "")
        .trim()
        .toLowerCase();
      if (!role) continue;
      const text = String(item.text || "").trim();
      const textNormalized = String(item.text_normalized || "").trim();
      if (!text && !textNormalized) continue;
      normalizedHistory.push({
        role,
        text,
        text_normalized: textNormalized || text.toLowerCase(),
        message_id:
          item.message_id === undefined || item.message_id === null
            ? null
            : String(item.message_id),
        kind: item.kind ? String(item.kind) : null,
        ts: Number(item.ts) || Date.now(),
      });
    }
    if (Number.isFinite(maxHistory) && maxHistory > 0 && normalizedHistory.length > maxHistory) {
      merged.history = normalizedHistory.slice(-Math.trunc(maxHistory));
    } else {
      merged.history = normalizedHistory;
    }
  }

  // timestamps
  merged.createdAt = Number(merged.createdAt) || base.createdAt;
  merged.updatedAt = Number(merged.updatedAt) || base.updatedAt;

  return merged;
}

/**
 * Безопасное построение имени файла по portal + dialogId.
 * Пример: rozzatti.bitrix24.ru__chat12345.json
 */
function buildSessionFilename(portal, dialogId) {
  const safePortal = String(portal || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();
  const safeDialog = String(dialogId || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();

  return `${safePortal}__${safeDialog}.json`;
}

function buildSessionPath(portal, dialogId) {
  return path.join(SESSIONS_PATH, buildSessionFilename(portal, dialogId));
}

function buildSessionCacheKey(portal, dialogId) {
  const safePortal = String(portal || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();
  const safeDialog = String(dialogId || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();
  return `${safePortal}__${safeDialog}`;
}

function cloneSession(session) {
  if (!session || typeof session !== "object") return session;
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(session);
  }
  return JSON.parse(JSON.stringify(session));
}

function putSessionToCache(portal, dialogId, session) {
  const key = buildSessionCacheKey(portal, dialogId);
  SESSION_CACHE.set(key, { session: cloneSession(session), loadedAt: Date.now() });
}

function takeSessionFromCache(portal, dialogId) {
  const key = buildSessionCacheKey(portal, dialogId);
  const cached = SESSION_CACHE.get(key);
  if (!cached) return null;

  if (Date.now() - cached.loadedAt > CACHE_TTL_MS) {
    SESSION_CACHE.delete(key);
    return null;
  }

  const updatedAt = Number(cached.session?.updatedAt || 0);
  if (updatedAt > 0 && Date.now() - updatedAt > TTL_MS) {
    SESSION_CACHE.delete(key);
    return null;
  }

  return cloneSession(cached.session);
}

function dropSessionFromCache(portal, dialogId) {
  SESSION_CACHE.delete(buildSessionCacheKey(portal, dialogId));
}

async function ensureDirAsync(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function safeRenameAsync(tmp, full) {
  try {
    await fsp.rename(tmp, full);
  } catch (e) {
    const err = /** @type {{ code?: string }} */ (e);
    if (err && (err.code === "EEXIST" || err.code === "EPERM" || err.code === "EBUSY")) {
      await fsp.rm(full, { force: true });
      await fsp.rename(tmp, full);
      return;
    }
    throw e;
  }
}

/**
 * Асинхронное чтение сессии без блокировки event loop.
 * Использует короткий in-memory cache для горячего пути.
 */
export async function getSessionAsync(portal, dialogId) {
  if (!portal || !dialogId) return null;

  const cached = takeSessionFromCache(portal, dialogId);
  if (cached) return cached;

  const full = buildSessionPath(portal, dialogId);
  let raw = null;
  try {
    raw = await fsp.readFile(full, "utf8");
  } catch (err) {
    const e = /** @type {{ code?: string }} */ (err);
    if (e?.code === "ENOENT") return null;
    logger.error({ ctx: CTX, file: full, error: String(err) }, "Ошибка чтения сессии");
    return null;
  }

  try {
    const session = normalizeSession(JSON.parse(raw));
    const updatedAt = session.updatedAt || 0;
    const age = Date.now() - updatedAt;

    if (age > TTL_MS) {
      try {
        await fsp.unlink(full);
      } catch (e) {
        logger.warn(
          { ctx: CTX, file: full, error: String(e) },
          "Не удалось удалить просроченный файл сессии",
        );
      }
      dropSessionFromCache(portal, dialogId);
      return null;
    }

    putSessionToCache(portal, dialogId, session);
    return session;
  } catch (err) {
    logger.error({ ctx: CTX, file: full, error: String(err) }, "Ошибка чтения сессии");
    return null;
  }
}

/**
 * Асинхронное сохранение сессии на диск (atomic tmp -> rename).
 * Обновляет in-memory cache.
 */
export async function saveSessionAsync(portal, dialogId, session) {
  if (!portal || !dialogId || !session) return;

  try {
    await ensureDirAsync(SESSIONS_PATH);

    const full = buildSessionPath(portal, dialogId);
    const normalized = normalizeSession(session);
    const toSave = {
      ...normalized,
      updatedAt: Date.now(),
    };
    const json = JSON.stringify(toSave, null, 2);
    const tmp = `${full}.tmp.${process.pid}.${Date.now()}`;

    await fsp.writeFile(tmp, json, "utf8");
    try {
      await safeRenameAsync(tmp, full);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }

    putSessionToCache(portal, dialogId, toSave);
  } catch (err) {
    logger.error({ ctx: CTX, portal, dialogId, error: String(err) }, "Ошибка сохранения сессии");
  }
}

/**
 * Асинхронная очистка устаревших/битых сессий.
 */
export async function cleanupSessionsAsync() {
  try {
    await ensureDirAsync(SESSIONS_PATH);
    const files = await fsp.readdir(SESSIONS_PATH);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const full = path.join(SESSIONS_PATH, file);
      let stale = false;

      try {
        const raw = await fsp.readFile(full, "utf8");
        const s = normalizeSession(JSON.parse(raw));
        const updatedAt = s.updatedAt || 0;
        if (updatedAt && Date.now() - updatedAt > TTL_MS) {
          stale = true;
        } else if (!updatedAt) {
          const stat = await fsp.stat(full);
          const mtime = stat.mtimeMs || stat.mtime?.getTime() || 0;
          if (mtime && Date.now() - mtime > TTL_MS) stale = true;
        }
      } catch {
        stale = true;
      }

      if (!stale) continue;

      try {
        await fsp.unlink(full);
      } catch (e) {
        logger.warn(
          { ctx: CTX, file: full, error: String(e) },
          "Не удалось удалить устаревшую/битую сессию",
        );
      }
    }

    SESSION_CACHE.clear();
  } catch (err) {
    logger.error({ ctx: CTX, error: String(err) }, "Ошибка cleanupSessions");
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

function clearSessionCache() {
  SESSION_CACHE.clear();
}

export {
  CTX as __sessionStoreCtx,
  SESSIONS_PATH as __sessionStorePath,
  TTL_MS as __sessionStoreTtlMs,
  buildSessionPath as __sessionStoreBuildSessionPath,
  clearSessionCache as __sessionStoreClearSessionCache,
  dropSessionFromCache as __sessionStoreDropSessionFromCache,
  ensureDir as __sessionStoreEnsureDir,
  normalizeSession as __sessionStoreNormalizeSession,
  putSessionToCache as __sessionStorePutSessionToCache,
  takeSessionFromCache as __sessionStoreTakeSessionFromCache,
};

// Запускаем периодическую очистку раз в TTL (можно уменьшить, если нужно)
setInterval(() => {
  cleanupSessionsAsync().catch((e) => {
    logger.error({ ctx: CTX, error: String(e) }, "Ошибка в interval cleanupSessions");
  });
}, TTL_MS).unref?.();
