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
