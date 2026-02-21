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
import path from "path";

import { logger } from "../../core/logger.js";

const CTX = "sessionStore";

const SESSIONS_PATH = path.resolve("./data/sessions");
const TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

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
      const role = String(item.role || "").trim().toLowerCase();
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

/**
 * Прочитать сессию с диска.
 * Если файла нет или TTL истёк — вернуть null и удалить старый файл.
 */
export function getSession(portal, dialogId) {
  const full = buildSessionPath(portal, dialogId);

  try {
    if (!fs.existsSync(full)) {
      return null;
    }

    const raw = fs.readFileSync(full, "utf8");
    const session = normalizeSession(JSON.parse(raw));

    const updatedAt = session.updatedAt || 0;
    const age = Date.now() - updatedAt;

    if (age > TTL_MS) {
      try {
        fs.unlinkSync(full);
      } catch (e) {
        logger.warn(
          { ctx: CTX, file: full, error: String(e) },
          "Не удалось удалить просроченный файл сессии",
        );
      }
      return null;
    }

    return session;
  } catch (err) {
    logger.error(
      { ctx: CTX, file: full, error: String(err) },
      "Ошибка чтения сессии",
    );
    return null;
  }
}

/**
 * Сохранить сессию на диск.
 * ВАЖНО: updatedAt обновляется всегда (TTL "скользящий").
 * Пишем атомарно: .tmp -> rename, чтобы не ловить битые JSON при падениях.
 */
export function saveSession(portal, dialogId, session) {
  if (!portal || !dialogId || !session) {
    return;
  }

  try {
    ensureDir(SESSIONS_PATH);

    const full = buildSessionPath(portal, dialogId);
    const normalized = normalizeSession(session);

    const toSave = {
      ...normalized,
      updatedAt: Date.now(),
    };

    const json = JSON.stringify(toSave, null, 2);

    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, full);
  } catch (err) {
    logger.error(
      { ctx: CTX, portal, dialogId, error: String(err) },
      "Ошибка сохранения сессии",
    );
  }
}

/**
 * Периодическая очистка старых файлов.
 * Использует TTL_MS и поле updatedAt внутри JSON, если оно есть;
 * иначе ориентируется на mtime файла.
 */
export function cleanupSessions() {
  try {
    ensureDir(SESSIONS_PATH);
    const files = fs.readdirSync(SESSIONS_PATH);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const full = path.join(SESSIONS_PATH, file);

      let stale = false;

      try {
        const raw = fs.readFileSync(full, "utf8");
        const s = normalizeSession(JSON.parse(raw));
        const updatedAt = s.updatedAt || 0;

        if (updatedAt && Date.now() - updatedAt > TTL_MS) {
          stale = true;
        } else if (!updatedAt) {
          const stat = fs.statSync(full);
          const mtime = stat.mtimeMs || stat.mtime?.getTime() || 0;
          if (mtime && Date.now() - mtime > TTL_MS) {
            stale = true;
          }
        }
      } catch {
        stale = true;
      }

      if (stale) {
        try {
          fs.unlinkSync(full);
        } catch (e) {
          logger.warn(
            { ctx: CTX, file: full, error: String(e) },
            "Не удалось удалить устаревшую/битую сессию",
          );
        }
      }
    }
  } catch (err) {
    logger.error({ ctx: CTX, error: String(err) }, "Ошибка cleanupSessions");
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}

// Запускаем периодическую очистку раз в TTL (можно уменьшить, если нужно)
setInterval(() => {
  try {
    cleanupSessions();
  } catch (e) {
    logger.error(
      { ctx: CTX, error: String(e) },
      "Ошибка в interval cleanupSessions",
    );
  }
}, TTL_MS).unref?.();
