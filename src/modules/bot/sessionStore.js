// src/modules/bot/sessionStore.js (v2)
// Лёгкое и безопасное хранилище сессий.
// TTL = 24 часа, автo-очистка, структура совместима с handler_llm_manager.js (v2)

import fs from "fs";
import path from "path";
import { logger } from "../../core/logger.js";

const CTX = "sessionStore";

const SESSIONS_PATH = path.resolve("./data/sessions");
const TTL_MS = 24 * 60 * 60 * 1000; // 24 часа

ensureDir(SESSIONS_PATH);

export function getSession(portal, dialogId) {
  try {
    const file = path.join(SESSIONS_PATH, `${portal}__${dialogId}.json`);
    if (!fs.existsSync(file)) return null;

    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);

    // TTL
    if (Date.now() - (obj.updatedAt || 0) > TTL_MS) {
      fs.unlinkSync(file);
      return null;
    }

    return obj;
  } catch (err) {
    logger.error(CTX, "Ошибка getSession", err);
    return null;
  }
}

export function saveSession(portal, dialogId, session) {
  try {
    const file = path.join(SESSIONS_PATH, `${portal}__${dialogId}.json`);
    session.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(session, null, 2), "utf8");
  } catch (err) {
    logger.error(CTX, "Ошибка saveSession", err);
  }
}

// Очистка слишком старых сессий
export function cleanupSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_PATH);

    for (const f of files) {
      const full = path.join(SESSIONS_PATH, f);
      const s = JSON.parse(fs.readFileSync(full, "utf8"));

      if (Date.now() - (s.updatedAt || 0) > TTL_MS) {
        fs.unlinkSync(full);
      }
    }
  } catch (err) {
    logger.error(CTX, "Ошибка cleanupSessions", err);
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
}
