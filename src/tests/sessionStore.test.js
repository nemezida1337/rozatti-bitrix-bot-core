import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { logger } from "../core/logger.js";
import {
  cleanupSessions,
  getSession,
  saveSession,
} from "../modules/bot/sessionStore.js";

const SESSIONS_DIR = path.resolve("./data/sessions");
const TTL_MS = 24 * 60 * 60 * 1000;

function safePart(v) {
  return String(v || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();
}

function sessionFile(portal, dialogId) {
  return path.join(SESSIONS_DIR, `${safePart(portal)}__${safePart(dialogId)}.json`);
}

function removeIfExists(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // no-op
  }
}

test("sessionStore: save/get normalizes structure", () => {
  const portal = "audit-session-normalize.bitrix24.ru";
  const dialogId = "chat-100";
  const file = sessionFile(portal, dialogId);
  removeIfExists(file);

  const input = {
    mode: "broken-mode",
    manualAckSent: "yes",
    oem_candidates: ["  OEM1 ", "", null, "OEM1"],
    lastSeenLeadOem: "   ",
    state: { stage: "NEW" },
  };

  saveSession(portal, dialogId, input);
  const s = getSession(portal, dialogId);

  assert.ok(s);
  assert.equal(s.mode, "auto");
  assert.equal(s.manualAckSent, true);
  assert.deepEqual(s.oem_candidates, ["OEM1", "OEM1"]);
  assert.equal(s.lastSeenLeadOem, null);
  assert.equal(typeof s.updatedAt, "number");
  assert.equal(typeof s.createdAt, "number");

  removeIfExists(file);
});

test("sessionStore: getSession drops stale session by TTL", () => {
  const portal = "audit-session-ttl.bitrix24.ru";
  const dialogId = "chat-101";
  const file = sessionFile(portal, dialogId);
  removeIfExists(file);

  const stale = {
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
    createdAt: Date.now() - TTL_MS - 1_000,
    updatedAt: Date.now() - TTL_MS - 1_000,
  };
  fs.writeFileSync(file, JSON.stringify(stale, null, 2), "utf8");

  const s = getSession(portal, dialogId);
  assert.equal(s, null);
  assert.equal(fs.existsSync(file), false);
});

test("sessionStore: cleanupSessions removes invalid json files", () => {
  const portal = "audit-session-bad-json.bitrix24.ru";
  const dialogId = "chat-102";
  const file = sessionFile(portal, dialogId);
  removeIfExists(file);

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(file, "{broken-json", "utf8");
  assert.equal(fs.existsSync(file), true);

  cleanupSessions();

  assert.equal(fs.existsSync(file), false);
});

test("sessionStore: getSession returns null and logs error on malformed JSON", () => {
  const portal = "audit-session-read-error.bitrix24.ru";
  const dialogId = "chat-103";
  const file = sessionFile(portal, dialogId);
  removeIfExists(file);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(file, "{bad-json", "utf8");

  const originalError = logger.error;
  const errorCalls = [];
  logger.error = (ctxOrMsg, maybeMsg) => {
    errorCalls.push({ ctxOrMsg, maybeMsg });
    return originalError(ctxOrMsg, maybeMsg);
  };

  try {
    const s = getSession(portal, dialogId);
    assert.equal(s, null);
    assert.equal(
      errorCalls.some((x) => x.maybeMsg === "Ошибка чтения сессии"),
      true,
    );
  } finally {
    logger.error = originalError;
    removeIfExists(file);
  }
});

test("sessionStore: getSession stale delete failure is handled with warning", () => {
  const portal = "audit-session-stale-unlink.bitrix24.ru";
  const dialogId = "chat-104";
  const file = sessionFile(portal, dialogId);
  removeIfExists(file);

  const stale = {
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
    createdAt: Date.now() - TTL_MS - 10_000,
    updatedAt: Date.now() - TTL_MS - 10_000,
  };
  fs.writeFileSync(file, JSON.stringify(stale), "utf8");

  const originalUnlink = fs.unlinkSync;
  const originalWarn = logger.warn;
  const warnCalls = [];
  fs.unlinkSync = () => {
    throw new Error("unlink denied");
  };
  logger.warn = (ctxOrMsg, maybeMsg) => {
    warnCalls.push({ ctxOrMsg, maybeMsg });
    return originalWarn(ctxOrMsg, maybeMsg);
  };

  try {
    const s = getSession(portal, dialogId);
    assert.equal(s, null);
    assert.equal(
      warnCalls.some((x) => x.maybeMsg === "Не удалось удалить просроченный файл сессии"),
      true,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
    logger.warn = originalWarn;
    removeIfExists(file);
  }
});

test("sessionStore: saveSession ignores empty required args", () => {
  const portal = "audit-session-empty-save.bitrix24.ru";
  const dialogId = "chat-105";
  const file = sessionFile(portal, dialogId);
  removeIfExists(file);

  saveSession("", dialogId, { mode: "auto" });
  saveSession(portal, "", { mode: "auto" });
  saveSession(portal, dialogId, null);

  assert.equal(fs.existsSync(file), false);
});

test("sessionStore: saveSession logs error when write fails", () => {
  const portal = "audit-session-save-error.bitrix24.ru";
  const dialogId = "chat-106";

  const originalWrite = fs.writeFileSync;
  const originalError = logger.error;
  const errorCalls = [];

  fs.writeFileSync = () => {
    throw new Error("write failed");
  };
  logger.error = (ctxOrMsg, maybeMsg) => {
    errorCalls.push({ ctxOrMsg, maybeMsg });
    return originalError(ctxOrMsg, maybeMsg);
  };

  try {
    saveSession(portal, dialogId, { mode: "auto" });
    assert.equal(
      errorCalls.some((x) => x.maybeMsg === "Ошибка сохранения сессии"),
      true,
    );
  } finally {
    fs.writeFileSync = originalWrite;
    logger.error = originalError;
  }
});

test("sessionStore: cleanupSessions warns when stale file cannot be removed", () => {
  const file = path.join(SESSIONS_DIR, "audit_cleanup_unlink_fail.json");
  removeIfExists(file);
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(file, "{bad-json", "utf8");

  const originalUnlink = fs.unlinkSync;
  const originalWarn = logger.warn;
  const warnCalls = [];

  fs.unlinkSync = (p) => {
    if (p === file) throw new Error("unlink blocked");
    return originalUnlink(p);
  };
  logger.warn = (ctxOrMsg, maybeMsg) => {
    warnCalls.push({ ctxOrMsg, maybeMsg });
    return originalWarn(ctxOrMsg, maybeMsg);
  };

  try {
    cleanupSessions();
    assert.equal(
      warnCalls.some((x) => x.maybeMsg === "Не удалось удалить устаревшую/битую сессию"),
      true,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
    logger.warn = originalWarn;
    removeIfExists(file);
  }
});

test("sessionStore: cleanupSessions logs error when listing sessions fails", () => {
  const originalReadDir = fs.readdirSync;
  const originalError = logger.error;
  const errorCalls = [];

  fs.readdirSync = () => {
    throw new Error("readdir failed");
  };
  logger.error = (ctxOrMsg, maybeMsg) => {
    errorCalls.push({ ctxOrMsg, maybeMsg });
    return originalError(ctxOrMsg, maybeMsg);
  };

  try {
    cleanupSessions();
    assert.equal(
      errorCalls.some((x) => x.maybeMsg === "Ошибка cleanupSessions"),
      true,
    );
  } finally {
    fs.readdirSync = originalReadDir;
    logger.error = originalError;
  }
});
