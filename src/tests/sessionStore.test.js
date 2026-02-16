import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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
