import assert from "node:assert/strict";
import test from "node:test";

import { logger } from "../core/logger.js";
import { upsertPortal } from "../core/store.legacy.js";
import { processIncomingBitrixMessage } from "../modules/bot/handler/index.js";
import { getSession, saveSession } from "../modules/bot/sessionStore.legacy.js";
import { crmSettings } from "../modules/settings.crm.js";

process.env.TOKENS_FILE = "./data/portals.handlerIndex.test.json";
const originalFetch = globalThis.fetch;

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

test("handler index: skips bot replies for deal-bound chats", async () => {
  const domain = "audit-handler-index-deal-bound.bitrix24.ru";
  const dialogId = "chat-index-deal-bound-1";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-deal-bound",
    refreshToken: "refresh-index-deal-bound",
  });

  const apiCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    apiCalls.push({ url: String(url), body: String(opts.body || "") });
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: {
        event: "onimbotmessageadd",
        data: {
          AUTH: { domain },
          PARAMS: {
            DIALOG_ID: dialogId,
            CHAT_ID: "907",
            MESSAGE_ID: "31",
            MESSAGE: "Когда ждать заказ?",
            CHAT_ENTITY_TYPE: "LINES",
            CHAT_ENTITY_DATA_1: "Y|DEAL|3860|N|N|42708|1771572461|0|0|0",
            CHAT_ENTITY_DATA_2: "LEAD|0|COMPANY|0|CONTACT|25278|DEAL|3860",
          },
          USER: {
            IS_CONNECTOR: "Y",
            IS_BOT: "N",
          },
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.lastProcessedMessageId, 31);
  assert.equal(typeof session.lastProcessedAt, "number");
  assert.equal(apiCalls.length, 0, "No Bitrix/LLM calls expected for deal chat");
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

test("handler index: attachment-only client message sends MANUAL_ACK once", async () => {
  const domain = "audit-handler-index-attachment-ack.bitrix24.ru";
  const dialogId = "chat-index-attachment-ack-1";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-attachment-ack",
    refreshToken: "refresh-index-attachment-ack",
  });
  saveSession(domain, dialogId, {
    dialogId,
    leadId: null,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    state: { stage: "NEW", offers: [] },
    lastProcessedMessageId: 0,
  });

  const apiCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    const params = new URLSearchParams(String(opts.body || ""));
    apiCalls.push({ method, params: Object.fromEntries(params.entries()) });

    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User" } };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: {
        event: "onimbotmessageadd",
        data: {
          AUTH: { domain },
          PARAMS: {
            DIALOG_ID: dialogId,
            CHAT_ID: "905",
            MESSAGE_ID: "12",
            MESSAGE: "",
            FILES: [{ id: "f1", name: "voice.oga" }],
            CHAT_ENTITY_TYPE: "LINES",
          },
          USER: {
            IS_CONNECTOR: "Y",
            IS_BOT: "N",
          },
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.mode, "manual");
  assert.equal(session.manualAckSent, true);
  assert.equal(session.lastProcessedMessageId, 12);
  assert.equal(
    apiCalls.some((x) => x.method === "imbot.message.add"),
    true,
  );
});

test("handler index: marketplace service notice replies and moves lead to IN_WORK", async () => {
  const domain = "audit-handler-index-service-notice.bitrix24.ru";
  const dialogId = "chat-index-service-notice-1";
  const leadId = "25946";
  const prevEnv = {
    HF_CORTEX_ENABLED: process.env.HF_CORTEX_ENABLED,
    HF_CORTEX_URL: process.env.HF_CORTEX_URL,
    HF_CORTEX_TIMEOUT_MS: process.env.HF_CORTEX_TIMEOUT_MS,
    HF_CORTEX_API_KEY: process.env.HF_CORTEX_API_KEY,
    HF_CORTEX_CLASSIFIER_SOURCE: process.env.HF_CORTEX_CLASSIFIER_SOURCE,
    NODE_LEGACY_CLASSIFICATION: process.env.NODE_LEGACY_CLASSIFICATION,
  };

  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/lead-sales";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";
  process.env.HF_CORTEX_API_KEY = "test-key";
  process.env.HF_CORTEX_CLASSIFIER_SOURCE = "cortex";
  process.env.NODE_LEGACY_CLASSIFICATION = "0";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-service-notice",
    refreshToken: "refresh-index-service-notice",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    state: { stage: "NEW", oems: [], offers: [] },
    lastProcessedMessageId: 0,
  });

  const apiCalls = [];
  let cortexCalled = false;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr === "http://cortex.test/lead-sales") {
      cortexCalled = true;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            flow: "lead_sales",
            stage: "IN_WORK",
            result: {
              action: "reply",
              stage: "IN_WORK",
              reply: "Спасибо за уведомление, проверим обновление прайса.",
              intent: "SERVICE_NOTICE",
              confidence: 1,
              ambiguity_reason: null,
              requires_clarification: false,
              client_name: null,
              oems: [],
              update_lead_fields: {},
              product_rows: [],
              product_picks: [],
              need_operator: false,
              offers: [],
              chosen_offer_id: null,
              contact_update: null,
            },
          });
        },
      };
    }

    const method = urlStr.match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    const params = new URLSearchParams(String(opts.body || ""));
    const call = {
      url: urlStr,
      method,
      params: Object.fromEntries(params.entries()),
    };
    apiCalls.push(call);

    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User" } };
        },
      };
    }

    if (method === "crm.lead.get") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: leadId, STATUS_ID: "NEW" } };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: makeBody({
        domain,
        dialogId,
        chatId: "906",
        messageId: 21,
        message:
          "Ваш прайс [URL=https://www.farpost.ru/personal/goods/packet/128350/view?from=tg.good.packetDated]«1 BMW»[/URL] не обновлялся уже 2 недели.",
        chatEntityType: "LINES",
        isConnector: "Y",
        isBot: "N",
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  assert.equal(
    cortexCalled,
    true,
    "cortex must be called for service notice in cortex classifier mode",
  );

  const sendCall = apiCalls.find((x) => x.method === "imbot.message.add");
  assert.ok(sendCall, "imbot.message.add must be called");
  assert.equal(sendCall.params.MESSAGE, "Спасибо за уведомление, проверим обновление прайса.");

  const leadUpdateCall = apiCalls.find(
    (x) => x.method === "crm.lead.update" && x.params.id === leadId,
  );
  assert.ok(leadUpdateCall, "crm.lead.update must be called for stage move");
  assert.equal(leadUpdateCall.params["fields[STATUS_ID]"], "UC_ZA04R1");

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.mode, "auto");
  assert.equal(session.state?.stage, "IN_WORK");
  assert.equal(session.lastProcessedMessageId, 21);
});

test("handler index: repeat followup uses history-aware reply", async () => {
  const domain = "audit-handler-index-repeat-followup.bitrix24.ru";
  const dialogId = "chat-index-repeat-followup-1";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-repeat-followup",
    refreshToken: "refresh-index-repeat-followup",
  });

  const now = Date.now();
  saveSession(domain, dialogId, {
    dialogId,
    leadId: null,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    state: { stage: "IN_WORK", offers: [] },
    history: [
      {
        role: "client",
        text: "нужен 06H905110G",
        text_normalized: "нужен 06h905110g",
        message_id: "100",
        ts: now - 120_000,
      },
      {
        role: "bot",
        text: "Принял запрос, уже в работе.",
        text_normalized: "принял запрос уже в работе",
        message_id: null,
        ts: now - 100_000,
      },
    ],
    lastProcessedMessageId: 100,
  });

  const apiCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    const params = new URLSearchParams(String(opts.body || ""));
    apiCalls.push({ method, params: Object.fromEntries(params.entries()) });

    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User" } };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: makeBody({
        domain,
        dialogId,
        chatId: "910",
        messageId: 101,
        message: "ну что там, есть новости?",
        chatEntityType: "LINES",
        isConnector: "Y",
        isBot: "N",
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const sendCall = apiCalls.find((x) => x.method === "imbot.message.add");
  assert.ok(sendCall, "repeat followup should send contextual reply");
  assert.match(String(sendCall.params.MESSAGE || ""), /повторное сообщение/i);
  assert.match(String(sendCall.params.MESSAGE || ""), /в работе/i);

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.lastProcessedMessageId, 101);
  assert.equal(Array.isArray(session.history), true);
  assert.equal(
    session.history.some((x) => x.kind === "repeat_followup"),
    true,
  );
});

test("handler index: pricing objection is routed through Cortex in cortex classifier mode", async () => {
  const domain = "audit-handler-index-pricing-objection.bitrix24.ru";
  const dialogId = "chat-index-pricing-objection-1";
  const leadId = "70201";
  const prevEnv = {
    HF_CORTEX_ENABLED: process.env.HF_CORTEX_ENABLED,
    HF_CORTEX_URL: process.env.HF_CORTEX_URL,
    HF_CORTEX_TIMEOUT_MS: process.env.HF_CORTEX_TIMEOUT_MS,
    HF_CORTEX_API_KEY: process.env.HF_CORTEX_API_KEY,
    HF_CORTEX_CLASSIFIER_SOURCE: process.env.HF_CORTEX_CLASSIFIER_SOURCE,
    NODE_LEGACY_CLASSIFICATION: process.env.NODE_LEGACY_CLASSIFICATION,
  };

  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/lead-sales-pricing";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";
  process.env.HF_CORTEX_API_KEY = "test-key";
  process.env.HF_CORTEX_CLASSIFIER_SOURCE = "cortex";
  process.env.NODE_LEGACY_CLASSIFICATION = "0";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-pricing-objection",
    refreshToken: "refresh-index-pricing-objection",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: ["95834933740", "95834933750"],
    state: {
      stage: "PRICING",
      offers: [
        { id: 1, oem: "95834933740", price: 11700 },
        { id: 2, oem: "95834933750", price: 11500 },
      ],
    },
    history: [],
    lastProcessedMessageId: 200,
  });

  const apiCalls = [];
  let cortexCalled = false;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr === "http://cortex.test/lead-sales-pricing") {
      cortexCalled = true;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            flow: "lead_sales",
            stage: "PRICING",
            result: {
              action: "reply",
              stage: "PRICING",
              reply:
                "Понял по цене. Могу подобрать дешевле: напишите бюджет или номера вариантов, которые рассмотреть.",
              intent: "OEM_QUERY",
              confidence: 0.95,
              ambiguity_reason: null,
              requires_clarification: false,
              client_name: null,
              oems: ["95834933740", "95834933750"],
              update_lead_fields: {},
              product_rows: [],
              product_picks: [],
              need_operator: false,
              offers: [
                { id: 1, oem: "95834933740", price: 11700 },
                { id: 2, oem: "95834933750", price: 11500 },
              ],
              chosen_offer_id: null,
              contact_update: null,
            },
          });
        },
      };
    }

    const method = urlStr.match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    const params = new URLSearchParams(String(opts.body || ""));
    apiCalls.push({ url: urlStr, method, params: Object.fromEntries(params.entries()) });

    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User" } };
        },
      };
    }

    if (method === "crm.lead.get") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            result: {
              ID: leadId,
              STATUS_ID: crmSettings?.stageToStatusId?.PRICING || "UC_5SCNOB",
            },
          };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: makeBody({
        domain,
        dialogId,
        chatId: "911",
        messageId: 201,
        message: "дороговато))",
        chatEntityType: "LINES",
        isConnector: "Y",
        isBot: "N",
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  assert.equal(
    cortexCalled,
    true,
    "cortex must be called for pricing objections in cortex classifier mode",
  );

  const sendCall = apiCalls.find((x) => x.method === "imbot.message.add");
  assert.ok(sendCall, "imbot.message.add must be called");
  assert.match(String(sendCall.params.MESSAGE || ""), /Понял по цене/i);

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(session.lastProcessedMessageId, 201);
});

test("handler index: simple OEM request goes Cortex-first when fast OEM path is disabled", async () => {
  const domain = "audit-handler-index-cortex-first-oem.bitrix24.ru";
  const dialogId = "chat-index-cortex-first-oem-1";
  const prevEnv = {
    HF_CORTEX_ENABLED: process.env.HF_CORTEX_ENABLED,
    HF_CORTEX_URL: process.env.HF_CORTEX_URL,
    HF_CORTEX_TIMEOUT_MS: process.env.HF_CORTEX_TIMEOUT_MS,
    HF_CORTEX_API_KEY: process.env.HF_CORTEX_API_KEY,
    HF_CORTEX_CLASSIFIER_SOURCE: process.env.HF_CORTEX_CLASSIFIER_SOURCE,
    NODE_LEGACY_CLASSIFICATION: process.env.NODE_LEGACY_CLASSIFICATION,
    NODE_FAST_OEM_PATH: process.env.NODE_FAST_OEM_PATH,
  };

  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/lead-sales-oem";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";
  process.env.HF_CORTEX_API_KEY = "test-key";
  process.env.HF_CORTEX_CLASSIFIER_SOURCE = "cortex";
  process.env.NODE_LEGACY_CLASSIFICATION = "0";
  process.env.NODE_FAST_OEM_PATH = "0";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-cortex-first-oem",
    refreshToken: "refresh-index-cortex-first-oem",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: "99001",
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    state: { stage: "NEW", oems: [], offers: [] },
    lastProcessedMessageId: 0,
  });

  const apiCalls = [];
  let cortexCalled = false;
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr === "http://cortex.test/lead-sales-oem") {
      cortexCalled = true;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            flow: "lead_sales",
            stage: "PRICING",
            result: {
              action: "reply",
              stage: "PRICING",
              reply: "Нашел варианты, отправляю подбор.",
              intent: "OEM_QUERY",
              confidence: 0.98,
              ambiguity_reason: null,
              requires_clarification: false,
              client_name: null,
              oems: ["06A906032N"],
              update_lead_fields: {},
              product_rows: [],
              product_picks: [],
              need_operator: false,
              offers: [{ id: 1, oem: "06A906032N", price: 1111 }],
              chosen_offer_id: null,
              contact_update: null,
            },
          });
        },
      };
    }

    const method = urlStr.match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    const params = new URLSearchParams(String(opts.body || ""));
    apiCalls.push({ method, params: Object.fromEntries(params.entries()) });

    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User" } };
        },
      };
    }
    if (method === "crm.lead.get") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "99001", STATUS_ID: "NEW" } };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: makeBody({
        domain,
        dialogId,
        chatId: "912",
        messageId: 301,
        message: "06A906032N",
        chatEntityType: "LINES",
        isConnector: "Y",
        isBot: "N",
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  assert.equal(cortexCalled, true);
  const sendCalls = apiCalls.filter((x) => x.method === "imbot.message.add");
  assert.equal(sendCalls.length, 1);
  assert.match(String(sendCalls[0].params.MESSAGE || ""), /Нашел варианты/i);
  assert.doesNotMatch(String(sendCalls[0].params.MESSAGE || ""), /Получил номера/i);
});

test("handler index: failed chat send does not persist new lastProcessedMessageId", async () => {
  const domain = "audit-handler-index-send-fail.bitrix24.ru";
  const dialogId = "chat-index-send-fail-1";
  const prevEnv = {
    HF_CORTEX_ENABLED: process.env.HF_CORTEX_ENABLED,
    HF_CORTEX_URL: process.env.HF_CORTEX_URL,
    HF_CORTEX_TIMEOUT_MS: process.env.HF_CORTEX_TIMEOUT_MS,
    HF_CORTEX_API_KEY: process.env.HF_CORTEX_API_KEY,
    HF_CORTEX_CLASSIFIER_SOURCE: process.env.HF_CORTEX_CLASSIFIER_SOURCE,
    NODE_LEGACY_CLASSIFICATION: process.env.NODE_LEGACY_CLASSIFICATION,
    NODE_FAST_OEM_PATH: process.env.NODE_FAST_OEM_PATH,
  };

  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/lead-sales-send-fail";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";
  process.env.HF_CORTEX_API_KEY = "test-key";
  process.env.HF_CORTEX_CLASSIFIER_SOURCE = "cortex";
  process.env.NODE_LEGACY_CLASSIFICATION = "0";
  process.env.NODE_FAST_OEM_PATH = "0";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-send-fail",
    refreshToken: "refresh-index-send-fail",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: null,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: [],
    state: { stage: "NEW", oems: [], offers: [] },
    lastProcessedMessageId: 410,
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr === "http://cortex.test/lead-sales-send-fail") {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            flow: "lead_sales",
            stage: "CONTACT",
            result: {
              action: "reply",
              stage: "CONTACT",
              reply: "Уточните телефон",
              intent: "SMALL_TALK",
              confidence: 0.9,
              ambiguity_reason: null,
              requires_clarification: false,
              client_name: null,
              oems: [],
              update_lead_fields: {},
              product_rows: [],
              product_picks: [],
              need_operator: false,
              offers: [],
              chosen_offer_id: null,
              contact_update: null,
            },
          });
        },
      };
    }

    const method = urlStr.match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    if (method === "imbot.message.add") {
      throw new Error("forced send fail");
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await assert.rejects(
      () =>
        processIncomingBitrixMessage({
          domain,
          body: makeBody({
            domain,
            dialogId,
            chatId: "913",
            messageId: 411,
            message: "добрый день",
            chatEntityType: "LINES",
            isConnector: "Y",
            isBot: "N",
          }),
        }),
      /forced send fail/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const session = getSession(domain, dialogId);
  assert.ok(session);
  assert.equal(
    session.lastProcessedMessageId,
    410,
    "failed send must not lock message id and block retry by stale-guard",
  );
});

test("handler index: shadow comparison runs in legacy serving mode", async () => {
  const domain = "audit-handler-index-shadow-legacy.bitrix24.ru";
  const dialogId = "chat-index-shadow-legacy-1";
  const leadId = "73001";
  const prevEnv = {
    HF_CORTEX_CLASSIFIER_SOURCE: process.env.HF_CORTEX_CLASSIFIER_SOURCE,
    NODE_LEGACY_CLASSIFICATION: process.env.NODE_LEGACY_CLASSIFICATION,
    HF_CORTEX_SHADOW_COMPARE: process.env.HF_CORTEX_SHADOW_COMPARE,
    HF_CORTEX_SHADOW_SAMPLE_PERCENT: process.env.HF_CORTEX_SHADOW_SAMPLE_PERCENT,
    HF_CORTEX_SHADOW_LOG_MATCH: process.env.HF_CORTEX_SHADOW_LOG_MATCH,
  };

  process.env.HF_CORTEX_CLASSIFIER_SOURCE = "node";
  process.env.NODE_LEGACY_CLASSIFICATION = "1";
  process.env.HF_CORTEX_SHADOW_COMPARE = "1";
  process.env.HF_CORTEX_SHADOW_SAMPLE_PERCENT = "100";
  process.env.HF_CORTEX_SHADOW_LOG_MATCH = "0";

  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-index-shadow-legacy",
    refreshToken: "refresh-index-shadow-legacy",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId,
    mode: "auto",
    manualAckSent: false,
    oem_candidates: ["95834933740", "95834933750"],
    state: {
      stage: "PRICING",
      offers: [
        { id: 1, oem: "95834933740", price: 11700 },
        { id: 2, oem: "95834933750", price: 11500 },
      ],
    },
    history: [],
    lastProcessedMessageId: 900,
  });

  const shadowLogs = [];
  const originalWarn = logger.warn;
  logger.warn = (ctxOrMsg, maybeMsg) => {
    const msg = typeof ctxOrMsg === "string" ? ctxOrMsg : maybeMsg;
    if (String(msg || "").includes("[V2][SHADOW]")) {
      shadowLogs.push({
        ctx: typeof ctxOrMsg === "object" ? ctxOrMsg : null,
        msg: String(msg || ""),
      });
    }
    return originalWarn(ctxOrMsg, maybeMsg);
  };

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    const method = urlStr.match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User" } };
        },
      };
    }
    if (method === "crm.lead.get") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            result: {
              ID: leadId,
              STATUS_ID: crmSettings?.stageToStatusId?.PRICING || "UC_5SCNOB",
            },
          };
        },
      };
    }

    return {
      ok: true,
      status: 200,
      async json() {
        return { result: true };
      },
    };
  };

  try {
    await processIncomingBitrixMessage({
      domain,
      body: makeBody({
        domain,
        dialogId,
        chatId: "914",
        messageId: 901,
        message: "дороговато",
        chatEntityType: "LINES",
        isConnector: "Y",
        isBot: "N",
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
    logger.warn = originalWarn;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }

  assert.equal(shadowLogs.length > 0, true, "shadow divergence log must be emitted");
  assert.equal(
    shadowLogs.some((x) => x.ctx?.shadowTargetMode === "cortex"),
    true,
    "in legacy-serving mode shadow target must be cortex",
  );
});
