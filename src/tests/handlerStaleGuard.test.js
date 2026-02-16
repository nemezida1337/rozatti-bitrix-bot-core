import assert from "node:assert/strict";
import test from "node:test";

import { processIncomingBitrixMessage } from "../modules/bot/handler/index.js";
import { getSession, saveSession } from "../modules/bot/sessionStore.js";

function makeBody({ domain, dialogId, chatId, messageId, message }) {
  return {
    event: "onimbotmessageadd",
    data: {
      AUTH: { domain },
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ID: chatId,
        MESSAGE_ID: String(messageId),
        MESSAGE: message,
      },
    },
  };
}

test("handler stale-guard: ignores older messageId", async () => {
  const domain = "audit-stale-guard-old.bitrix24.ru";
  const dialogId = "chat3001";
  const chatId = "3001";

  saveSession(domain, dialogId, {
    dialogId,
    state: { stage: "NEW", offers: [] },
    lastProcessedMessageId: 200,
    lastProcessedAt: 111,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
  });

  await processIncomingBitrixMessage({
    domain,
    portal: {
      domain,
      baseUrl: "http://127.0.0.1:9/rest",
      accessToken: "token-stale",
    },
    body: makeBody({
      domain,
      dialogId,
      chatId,
      messageId: 199,
      message: "older message",
    }),
  });

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.lastProcessedMessageId, 200);
  assert.equal(session.lastProcessedAt, 111);
});

test("handler stale-guard: updates tracking for newer messageId", async () => {
  const domain = "audit-stale-guard-new.bitrix24.ru";
  const dialogId = "chat3002";
  const chatId = "3002";

  saveSession(domain, dialogId, {
    dialogId,
    state: { stage: "NEW", offers: [] },
    lastProcessedMessageId: 200,
    lastProcessedAt: 111,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    lastSeenLeadOem: null,
  });

  await processIncomingBitrixMessage({
    domain,
    portal: {
      domain,
      baseUrl: "http://127.0.0.1:9/rest",
      accessToken: "token-stale",
    },
    body: makeBody({
      domain,
      dialogId,
      chatId,
      messageId: 201,
      message: "",
    }),
  });

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.lastProcessedMessageId, 201);
  assert.equal(typeof session.lastProcessedAt, "number");
  assert.equal(session.lastProcessedAt > 111, true);
});

