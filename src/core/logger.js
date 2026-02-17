// @ts-check

// src/core/logger.js
// Простой человеко-читаемый логгер без кракозябр в консоли.
// Совместим по API с pino-стилем: logger.info({ ctx }, "message")

import fs from "fs";
import path from "path";

// Папка и уровень логирования
const LOG_DIR = process.env.LOG_DIR || "./logs";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

// Порядок важности уровней
/** @type {Array<"debug"|"info"|"warn"|"error">} */
const LEVELS = ["debug", "info", "warn", "error"];
/** @type {Record<"debug"|"info"|"warn"|"error", number>} */
const LEVEL_PRIORITY = LEVELS.reduce((acc, level, idx) => {
  acc[level] = idx;
  return acc;
}, /** @type {Record<"debug"|"info"|"warn"|"error", number>} */ ({}));

// Гарантируем, что папка логов существует
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Один файл в день: logs/app_YYYY-MM-DD.log
const date = new Date().toISOString().slice(0, 10);
const filePath = path.resolve(LOG_DIR, `app_${date}.log`);
const fileStream = fs.createWriteStream(filePath, {
  flags: "a",
  encoding: "utf8",
});

/**
 * Нормализуем аргументы:
 *  logger.info("msg")
 *  logger.info({ ctx }, "msg")
 */
function normalizeArgs(ctxOrMsg, maybeMsg) {
  if (typeof ctxOrMsg === "string" || ctxOrMsg instanceof Error) {
    return { ctx: {}, msg: String(ctxOrMsg) };
  }
  return {
    ctx: ctxOrMsg || {},
    msg: maybeMsg ? String(maybeMsg) : "",
  };
}

function shouldLog(level) {
  const currentLevel = /** @type {"debug"|"info"|"warn"|"error"} */ (
    LEVELS.includes(/** @type {any} */ (LOG_LEVEL))
      ? /** @type {any} */ (LOG_LEVEL)
      : "info"
  );
  const current = LEVEL_PRIORITY[currentLevel] ?? LEVEL_PRIORITY.info;
  const target = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.info;
  return target >= current;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {any} [ctxOrMsg]
 * @param {string} [maybeMsg]
 */
function write(level, ctxOrMsg, maybeMsg) {
  if (!shouldLog(level)) return;

  const { ctx, msg } = normalizeArgs(ctxOrMsg, maybeMsg);
  const time = nowIso();

  // Консоль — человеко-читаемый формат
  const prefix = `[${time}] [${level.toUpperCase()}]`;
  if (level === "error") {
    // Для ошибок используем console.error
    if (ctx && Object.keys(ctx).length) {
      console.error(prefix, msg, "|", ctx);
    } else {
      console.error(prefix, msg);
    }
  } else if (level === "warn") {
    if (ctx && Object.keys(ctx).length) {
      console.warn(prefix, msg, "|", ctx);
    } else {
      console.warn(prefix, msg);
    }
  } else {
    if (ctx && Object.keys(ctx).length) {
      console.log(prefix, msg, "|", ctx);
    } else {
      console.log(prefix, msg);
    }
  }

  // Файл — компактный JSON одной строкой
  const lineObj = { time, level, msg };
  if (ctx && Object.keys(ctx).length) {
    lineObj.ctx = ctx;
  }

  try {
    fileStream.write(JSON.stringify(lineObj) + "\n");
  } catch {
    // не роняем процесс из-за проблем с лог-файлом
  }
}

export const logger = {
  debug(ctxOrMsg, maybeMsg) {
    write("debug", ctxOrMsg, maybeMsg);
  },
  info(ctxOrMsg, maybeMsg) {
    write("info", ctxOrMsg, maybeMsg);
  },
  warn(ctxOrMsg, maybeMsg) {
    write("warn", ctxOrMsg, maybeMsg);
  },
  error(ctxOrMsg, maybeMsg) {
    write("error", ctxOrMsg, maybeMsg);
  },
};
