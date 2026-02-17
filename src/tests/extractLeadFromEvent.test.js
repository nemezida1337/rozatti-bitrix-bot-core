import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { hydrateSessionLeadFromEvent } from "../modules/bot/extractLeadFromEvent.js";
import { getSession, saveSession } from "../modules/bot/sessionStore.js";

const SESSIONS_DIR = path.resolve(process.cwd(), "data/sessions");

function sessionFile(portal, dialogId) {
  const safePortal = String(portal || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();
  const safeDialog = String(dialogId || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .toLowerCase();
  return path.join(SESSIONS_DIR, `${safePortal}__${safeDialog}.json`);
}

function cleanupSession(portal, dialogId) {
  const full = sessionFile(portal, dialogId);
  if (fs.existsSync(full)) fs.rmSync(full, { force: true });
}

test.beforeEach(() => {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  cleanupSession("extract.event.bitrix24.ru", "chat9101");
  cleanupSession("extract.event.bitrix24.ru", "chat9102");
});

test("extractLeadFromEvent: ignores body without portal or dialog", () => {
  hydrateSessionLeadFromEvent(null);
  hydrateSessionLeadFromEvent({ data: { PARAMS: { DIALOG_ID: "chat9101" } } });
  hydrateSessionLeadFromEvent({ _portal: "extract.event.bitrix24.ru", data: { PARAMS: {} } });

  assert.equal(getSession("extract.event.bitrix24.ru", "chat9101"), null);
});

test("extractLeadFromEvent: ignores non-LINES and invalid CHAT_ENTITY_DATA_1", () => {
  const portal = "extract.event.bitrix24.ru";
  const dialogId = "chat9101";

  hydrateSessionLeadFromEvent({
    _portal: portal,
    data: {
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ENTITY_TYPE: "CHAT",
        CHAT_ENTITY_DATA_1: "IMOL|x|x|LEAD|111|x",
      },
    },
  });

  hydrateSessionLeadFromEvent({
    _portal: portal,
    data: {
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ENTITY_TYPE: "LINES",
        CHAT_ENTITY_DATA_1: "IMOL|x|x|CONTACT|111|x",
      },
    },
  });

  assert.equal(getSession(portal, dialogId), null);
});

test("extractLeadFromEvent: creates session and writes leadId from CHAT_ENTITY_DATA_1", () => {
  const portal = "extract.event.bitrix24.ru";
  const dialogId = "chat9101";

  hydrateSessionLeadFromEvent({
    auth: { domain: portal },
    data: {
      params: {
        DIALOG_ID: dialogId,
        CHAT_ENTITY_TYPE: "LINES",
        CHAT_ENTITY_DATA_1: "IMOL|x|x|LEAD|18758|x",
      },
    },
  });

  const session = getSession(portal, dialogId);
  assert.ok(session);
  assert.equal(session.leadId, "18758");
});

test("extractLeadFromEvent: updates existing session when leadId changes", () => {
  const portal = "extract.event.bitrix24.ru";
  const dialogId = "chat9102";
  saveSession(portal, dialogId, {
    state: { stage: "CONTACT" },
    leadId: "100",
    history: [],
  });

  hydrateSessionLeadFromEvent({
    _portal: portal,
    data: {
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ENTITY_TYPE: "LINES",
        CHAT_ENTITY_DATA_1: "IMOL|x|x|LEAD|200|x",
      },
    },
  });

  const session = getSession(portal, dialogId);
  assert.equal(session.leadId, "200");
});

test("extractLeadFromEvent: does not rewrite session when same leadId already set", () => {
  const portal = "extract.event.bitrix24.ru";
  const dialogId = "chat9102";
  saveSession(portal, dialogId, {
    state: { stage: "CONTACT" },
    leadId: "333",
    history: [],
  });
  const before = fs.readFileSync(sessionFile(portal, dialogId), "utf8");

  hydrateSessionLeadFromEvent({
    _portal: portal,
    data: {
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ENTITY_TYPE: "LINES",
        CHAT_ENTITY_DATA_1: "IMOL|x|x|LEAD|333|x",
      },
    },
  });

  const after = fs.readFileSync(sessionFile(portal, dialogId), "utf8");
  assert.equal(after, before);
});
