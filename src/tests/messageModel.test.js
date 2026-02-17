import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeIncomingMessage } from "../core/messageModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function readFixture(name) {
  const p = path.join(__dirname, "fixtures", "bitrix", name);
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw);
}

test("normalizeIncomingMessage extracts dialogId/chatId/text/fromUserId/messageId", async () => {
  const fixture = await readFixture(
    "2026-01-05T15-21-52-842Z__onimbotmessageadd__rozzattti.bitrix24.ru.json",
  );

  const msg = normalizeIncomingMessage(fixture.body);

  assert.equal(msg.portal, "rozzattti.bitrix24.ru");
  assert.equal(msg.dialogId, "chat16194");
  assert.equal(msg.chatId, "16194");
  assert.equal(msg.fromUserId, "9526");
  assert.equal(msg.messageId, "529712");
  assert.match(msg.text, /5QM411105R/i);
});

test("normalizeIncomingMessage: returns null for empty body", () => {
  assert.equal(normalizeIncomingMessage(null), null);
});

test("normalizeIncomingMessage: resolves portal from _portal and fallback auth variants", () => {
  const fromPortal = normalizeIncomingMessage({
    _portal: "p1.bitrix24.ru",
    data: { params: {} },
  });
  assert.equal(fromPortal.portal, "p1.bitrix24.ru");

  const fromAuthDomainUpper = normalizeIncomingMessage({
    auth: { DOMAIN: "p2.bitrix24.ru" },
    data: { params: {} },
  });
  assert.equal(fromAuthDomainUpper.portal, "p2.bitrix24.ru");

  const fromDataAuth = normalizeIncomingMessage({
    data: { auth: { DOMAIN: "p3.bitrix24.ru" }, params: {} },
  });
  assert.equal(fromDataAuth.portal, "p3.bitrix24.ru");
});

test("normalizeIncomingMessage: falls back to CHAT_ID / CHAT.ID and trims text", () => {
  const fromChatId = normalizeIncomingMessage({
    data: {
      PARAMS: {
        CHAT_ID: "chat-5001",
        TEXT: "  hello world  ",
        AUTHOR_ID: 42,
      },
    },
  });

  assert.equal(fromChatId.dialogId, "chat-5001");
  assert.equal(fromChatId.chatId, "5001");
  assert.equal(fromChatId.fromUserId, "42");
  assert.equal(fromChatId.text, "hello world");
  assert.equal(fromChatId.messageId, null);

  const fromChatObj = normalizeIncomingMessage({
    data: {
      CHAT: { ID: "chat6002" },
      TEXT: "  from data text  ",
    },
  });

  assert.equal(fromChatObj.dialogId, "chat6002");
  assert.equal(fromChatObj.chatId, "6002");
  assert.equal(fromChatObj.text, "from data text");
  assert.deepEqual(fromChatObj.attachments, []);
  assert.equal(fromChatObj.isForwarded, false);
});

test("normalizeIncomingMessage: supports MESSAGE/FORWARD/FILES and MESSAGE_ID", () => {
  const msg = normalizeIncomingMessage({
    data: {
      PARAMS: {
        DIALOG_ID: "chat7001",
        MESSAGE: "  oem request  ",
        FROM_USER_ID: 9527,
        MESSAGE_ID: 100500,
        FILES: [{ id: 1 }],
        FORWARD: 1,
      },
    },
  });

  assert.equal(msg.dialogId, "chat7001");
  assert.equal(msg.chatId, "7001");
  assert.equal(msg.text, "oem request");
  assert.equal(msg.fromUserId, "9527");
  assert.equal(msg.messageId, "100500");
  assert.deepEqual(msg.attachments, [{ id: 1 }]);
  assert.equal(msg.isForwarded, true);
});

test("normalizeIncomingMessage: returns null on unexpected accessor error", () => {
  const body = {};
  Object.defineProperty(body, "data", {
    get() {
      throw new Error("boom");
    },
  });

  const msg = normalizeIncomingMessage(body);
  assert.equal(msg, null);
});
