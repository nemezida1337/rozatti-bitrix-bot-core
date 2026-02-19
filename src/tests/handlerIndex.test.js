import assert from "node:assert/strict";
import test from "node:test";

import { upsertPortal } from "../core/store.js";
import { processIncomingBitrixMessage } from "../modules/bot/handler/index.js";
import { getSession, saveSession } from "../modules/bot/sessionStore.js";

process.env.TOKENS_FILE = "./data/portals.handlerIndex.test.json";

function makeBody({
  domain,
  dialogId,
  chatId,
  messageId,
  message,
  chatEntityType,
  isConnector,
  isBot,
}) {
  return {
    event: "onimbotmessageadd",
    data: {
      AUTH: domain ? { domain } : undefined,
      PARAMS: {
        DIALOG_ID: dialogId,
        CHAT_ID: chatId,
        MESSAGE_ID: messageId == null ? undefined : String(messageId),
        MESSAGE: message,
        CHAT_ENTITY_TYPE: chatEntityType,
      },
      USER: {
        IS_CONNECTOR: isConnector,
        IS_BOT: isBot,
      },
    },
  };
}

test("handler index: skips when portal token/baseUrl is missing", async () => {
  const dialogId = "chat-index-skip-1";

  await processIncomingBitrixMessage({
    body: makeBody({
      domain: null,
      dialogId,
      chatId: "901",
      messageId: 1,
      message: "hello",
    }),
  });

  const unknownSession = getSession("unknown", dialogId);
  assert.equal(unknownSession, null);
});

test("handler index: creates default session and saves tracking when decision blocks cortex", async () => {
  const domain = "audit-handler-index-default.bitrix24.ru";
  const dialogId = "chat-index-default-1";

  upsertPortal(domain, {
    domain,
    baseUrl: "http://127.0.0.1:9/rest",
    accessToken: "token-index-default",
    refreshToken: "refresh-index-default",
  });

  await processIncomingBitrixMessage({
    domain,
    body: makeBody({
      domain,
      dialogId,
      chatId: "902",
      messageId: 10,
      message: "",
    }),
  });

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.dialogId, dialogId);
  assert.equal(session.mode, "auto");
  assert.equal(session.manualAckSent, false);
  assert.deepEqual(session.oem_candidates, []);
  assert.equal(session.lastSeenLeadOem, null);
  assert.equal(Array.isArray(session.state?.oems), true);
  assert.equal(Array.isArray(session.state?.offers), true);
  assert.equal(session.lastProcessedMessageId, 10);
  assert.equal(typeof session.lastProcessedAt, "number");
});

test("handler index: manual mode lock path saves session and exits silently", async () => {
  const domain = "audit-handler-index-manual.bitrix24.ru";
  const dialogId = "chat-index-manual-1";

  upsertPortal(domain, {
    domain,
    baseUrl: "http://127.0.0.1:9/rest",
    accessToken: "token-index-manual",
    refreshToken: "refresh-index-manual",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: null,
    mode: "manual",
    manualAckSent: true,
    oem_candidates: ["AAA111"],
    state: { stage: "PRICING", offers: [] },
    lastProcessedMessageId: 3,
  });

  await processIncomingBitrixMessage({
    domain,
    body: makeBody({
      domain,
      dialogId,
      chatId: "903",
      messageId: 4,
      message: "manager mode",
    }),
  });

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.mode, "manual");
  assert.equal(session.manualAckSent, true);
  assert.equal(session.lastProcessedMessageId, 4);
  assert.equal(typeof session.lastProcessedAt, "number");
});

test("handler index: small talk is ignored for manager messages", async () => {
  const domain = "audit-handler-index-manager-smalltalk.bitrix24.ru";
  const dialogId = "chat-index-manager-smalltalk-1";

  upsertPortal(domain, {
    domain,
    baseUrl: "http://127.0.0.1:9/rest",
    accessToken: "token-index-manager-smalltalk",
    refreshToken: "refresh-index-manager-smalltalk",
  });

  await processIncomingBitrixMessage({
    domain,
    body: makeBody({
      domain,
      dialogId,
      chatId: "904",
      messageId: 11,
      message: "как оформить заказ?",
      chatEntityType: "LINES",
      isConnector: "N",
      isBot: "N",
    }),
  });

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.lastProcessedMessageId, 11);
  assert.equal(session.lastSmallTalkIntent, undefined);
  assert.equal(session.lastSmallTalkTopic, undefined);
});
