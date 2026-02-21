import assert from "node:assert/strict";
import test from "node:test";

import { upsertPortal } from "../core/store.legacy.js";
import { buildContext } from "../modules/bot/handler/context.js";
import { saveSession } from "../modules/bot/sessionStore.legacy.js";
import { crmSettings } from "../modules/settings.crm.js";

const originalFetch = global.fetch;
process.env.TOKENS_FILE = "./data/portals.contextBuilder.test.json";

function makeBody(domain, dialogId, message = "") {
  return {
    event: "onimbotmessageadd",
    data: {
      auth: { domain },
      params: {
        DIALOG_ID: dialogId,
        CHAT_ID: String(dialogId).replace(/\D/g, "") || "1",
        MESSAGE: message,
      },
    },
  };
}

test.after(() => {
  global.fetch = originalFetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("context builder: resolves domain from lowercase auth and works without session", async () => {
  const ctx = await buildContext({
    portal: null,
    body: makeBody("audit-context-basic.bitrix24.ru", "chat-ctx-001", "hello"),
  });

  assert.equal(ctx.domain, "audit-context-basic.bitrix24.ru");
  assert.equal(ctx.portal.hasToken, false);
  assert.equal(ctx.lead.leadId, null);
  assert.equal(ctx.message.text, "hello");
  assert.equal(ctx.message.isSystemLike, false);
});

test("context builder: reads lead status and OEM from CRM when session has leadId", async () => {
  const domain = "audit-context-lead.bitrix24.ru";
  const dialogId = "chat-ctx-002";
  const oemField = crmSettings.leadFields.OEM;

  upsertPortal(domain, {
    domain,
    baseUrl: "http://bitrix.test/rest",
    accessToken: "token-context",
    refreshToken: "refresh-context",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: 9901,
    state: { stage: "NEW", offers: [] },
  });

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/profile.json")) {
      return {
        ok: true,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User", EMAIL: "bot@example.test" } };
        },
      };
    }
    if (u.includes("/crm.lead.get.json")) {
      return {
        ok: true,
        async json() {
          return {
            result: {
              ID: 9901,
              STATUS_ID: "PROCESSED",
              [oemField]: "  OEM-CTX-777  ",
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { result: {} };
      },
    };
  };

  const ctx = await buildContext({
    portal: null,
    body: makeBody(domain, dialogId, "OEM-CTX-777"),
  });

  assert.equal(ctx.portal.hasToken, true);
  assert.equal(ctx.lead.leadId, 9901);
  assert.equal(ctx.lead.statusId, "PROCESSED");
  assert.equal(ctx.lead.oemValue, "  OEM-CTX-777  ");
  assert.equal(ctx.lead.oemInLead, true);
});

test("context builder: handles getLead failures gracefully", async () => {
  const domain = "audit-context-fail.bitrix24.ru";
  const dialogId = "chat-ctx-003";

  upsertPortal(domain, {
    domain,
    baseUrl: "http://bitrix-fail.test/rest",
    accessToken: "token-context-fail",
    refreshToken: "refresh-context-fail",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: 9902,
    state: { stage: "NEW", offers: [] },
  });

  global.fetch = async () => {
    throw new Error("network fail");
  };

  const ctx = await buildContext({
    portal: null,
    body: makeBody(domain, dialogId, "OEMFAIL1"),
  });

  assert.equal(ctx.lead.leadId, 9902);
  assert.equal(ctx.lead.statusId, null);
  assert.equal(ctx.lead.oemValue, null);
  assert.equal(ctx.lead.oemInLead, false);
});

test("context builder: OEM field with only spaces is treated as empty", async () => {
  const domain = "audit-context-empty-oem.bitrix24.ru";
  const dialogId = "chat-ctx-004";
  const oemField = crmSettings.leadFields.OEM;

  upsertPortal(domain, {
    domain,
    baseUrl: "http://bitrix-empty-oem.test/rest",
    accessToken: "token-context-empty",
    refreshToken: "refresh-context-empty",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: 9903,
    state: { stage: "NEW", offers: [] },
  });

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/profile.json")) {
      return {
        ok: true,
        async json() {
          return { result: {} };
        },
      };
    }
    if (u.includes("/crm.lead.get.json")) {
      return {
        ok: true,
        async json() {
          return {
            result: {
              ID: 9903,
              STATUS_ID: "NEW",
              [oemField]: "   ",
            },
          };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { result: {} };
      },
    };
  };

  const ctx = await buildContext({
    portal: null,
    body: makeBody(domain, dialogId, "text"),
  });

  assert.equal(ctx.lead.oemValue, "   ");
  assert.equal(ctx.lead.oemInLead, false);
});

test("context builder: uses portal argument when store has no portal record", async () => {
  const portal = {
    domain: "audit-context-portal-fallback.bitrix24.ru",
    baseUrl: "http://bitrix-portal-fallback.test/rest",
    accessToken: "portal-fallback-token",
  };

  const ctx = await buildContext({
    portal,
    body: {
      event: "onimbotmessageadd",
      data: {
        params: {
          DIALOG_ID: "chat-ctx-005",
          CHAT_ID: "5",
          MESSAGE: "hello from portal fallback",
        },
      },
    },
  });

  assert.equal(ctx.domain, portal.domain);
  assert.equal(ctx.portal.baseUrl, portal.baseUrl);
  assert.equal(ctx.portal.accessToken, portal.accessToken);
  assert.equal(ctx.portal.hasToken, true);
});

test("context builder: handles null body and keeps safe defaults", async () => {
  const ctx = await buildContext({
    portal: null,
    body: null,
    domain: "audit-context-domain-hint.bitrix24.ru",
  });

  assert.equal(ctx.domain, "audit-context-domain-hint.bitrix24.ru");
  assert.equal(ctx.event.event, null);
  assert.equal(ctx.message.dialogId, null);
  assert.equal(ctx.message.text, "");
  assert.equal(ctx.portal.hasToken, false);
  assert.equal(ctx.lead.leadId, null);
});

test("context builder: does not call CRM lead API when accessToken is missing", async () => {
  const domain = "audit-context-no-token.bitrix24.ru";
  const dialogId = "chat-ctx-006";
  let fetchCalls = 0;

  upsertPortal(domain, {
    domain,
    baseUrl: "http://bitrix-no-token.test/rest",
    refreshToken: "refresh-only",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: 9904,
    state: { stage: "NEW", offers: [] },
  });

  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      async json() {
        return { result: {} };
      },
    };
  };

  const ctx = await buildContext({
    portal: null,
    body: makeBody(domain, dialogId, "no token"),
  });

  assert.equal(ctx.portal.hasToken, false);
  assert.equal(ctx.lead.leadId, 9904);
  assert.equal(ctx.lead.statusId, null);
  assert.equal(fetchCalls, 0);
});

test("context builder: keeps OEM defaults when lead does not contain OEM field", async () => {
  const domain = "audit-context-no-oem-field.bitrix24.ru";
  const dialogId = "chat-ctx-007";

  upsertPortal(domain, {
    domain,
    baseUrl: "http://bitrix-no-oem-field.test/rest",
    accessToken: "token-no-oem",
    refreshToken: "refresh-no-oem",
  });

  saveSession(domain, dialogId, {
    dialogId,
    leadId: 9905,
    state: { stage: "NEW", offers: [] },
  });

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/profile.json")) {
      return {
        ok: true,
        async json() {
          return { result: {} };
        },
      };
    }
    if (u.includes("/crm.lead.get.json")) {
      return {
        ok: true,
        async json() {
          return { result: { ID: 9905, STATUS_ID: "CONTACT" } };
        },
      };
    }
    return {
      ok: true,
      async json() {
        return { result: {} };
      },
    };
  };

  const ctx = await buildContext({
    portal: null,
    body: makeBody(domain, dialogId, "OEM maybe"),
  });

  assert.equal(ctx.lead.statusId, "CONTACT");
  assert.equal(ctx.lead.oemValue, null);
  assert.equal(ctx.lead.oemInLead, false);
});

test("context builder: marks image flags when FILES are present in lowercase params", async () => {
  const domain = "audit-context-files.bitrix24.ru";
  const body = {
    event: "onimbotmessageadd",
    data: {
      auth: { domain },
      params: {
        DIALOG_ID: "chat-ctx-008",
        CHAT_ID: "8",
        MESSAGE: "photo",
        FILES: [{ id: 1 }],
      },
    },
  };

  const ctx = await buildContext({ portal: null, body });

  assert.equal(ctx.domain, domain);
  assert.equal(ctx.message.hasAttachments, true);
  assert.equal(ctx.hasImage, true);
});

test("context builder: suppresses OEM detection for system-like framed messages", async () => {
  const domain = "audit-context-system-like.bitrix24.ru";
  const body = {
    event: "onimbotmessageadd",
    data: {
      auth: { domain },
      params: {
        DIALOG_ID: "chat-ctx-009",
        CHAT_ID: "9",
        MESSAGE:
          "------------------------------------------------------\n" +
          "Rozatti[19:15:06]\n" +
          "добрый вечер, завтра с вами свяжутся\n" +
          "------------------------------------------------------",
      },
    },
  };

  const ctx = await buildContext({ portal: null, body });

  assert.equal(ctx.message.isSystemLike, true);
  assert.deepEqual(ctx.detectedOems, []);
  assert.equal(ctx.isSimpleOem, false);
});
