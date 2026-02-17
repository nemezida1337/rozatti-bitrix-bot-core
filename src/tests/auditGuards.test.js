import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { normalizeIncomingMessage } from "../core/messageModel.js";
import { getPortal, upsertPortal } from "../core/store.js";
import { buildDecision } from "../modules/bot/handler/decision.js";
import { crmSettings } from "../modules/settings.crm.js";

process.env.TOKENS_FILE = "./data/portals.auditGuards.test.json";
process.env.BITRIX_EVENTS_SECRET = "audit-secret";
process.env.BITRIX_VALIDATE_APP_TOKEN = "1";
process.env.EVENT_DUMP = "1";
process.env.EVENT_DUMP_DIR = "./data/events.auditGuards.test";

const DUMP_DIR = path.resolve(process.cwd(), process.env.EVENT_DUMP_DIR);

function resetDumpDir() {
  fs.rmSync(DUMP_DIR, { recursive: true, force: true });
}

async function startFakeInstallBitrix() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const methodMatch = String(req.url || "").match(/\/rest\/(.+)\.json/);
      const method = methodMatch ? methodMatch[1] : "unknown";

      let payload = { result: true };
      if (method === "profile") {
        payload = { result: { ID: "1", NAME: "Bot", LAST_NAME: "User", EMAIL: "bot@example.test" } };
      } else if (method === "imbot.bot.list") {
        payload = { result: [{ CODE: process.env.BOT_CODE || "ram_parts_bot" }] };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/rest/`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("bitrix/events: rejects non-install events without valid secret", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      payload: { event: "onimcommandadd", data: {} },
    });

    assert.equal(res.statusCode, 401);
    assert.match(res.body, /INVALID_EVENTS_SECRET/);
  } finally {
    await app.close();
  }
});

test("bitrix/events: install events bypass secret check", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      payload: { event: "onappinstall" },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.body, /DOMAIN_REQUIRED/);
  } finally {
    await app.close();
  }
});

test("bitrix/events: accepts events secret from x-hf-events-token header", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      headers: { "x-hf-events-token": "audit-secret" },
      payload: { event: "onimcommandadd", data: {} },
    });

    // Секрет принят, дальше упираемся в domain-required
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /DOMAIN_REQUIRED/);
  } finally {
    await app.close();
  }
});

test("bitrix/events: returns PORTAL_AUTH_REQUIRED when portal has no tokens", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const domain = "audit-no-auth.bitrix24.ru";

  upsertPortal(domain, { domain, baseUrl: `https://${domain}/rest/` });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      payload: {
        event: "onimbotmessageupdate",
        data: { AUTH: { domain, application_token: "any" } },
      },
    });

    assert.equal(res.statusCode, 412);
    assert.match(res.body, /PORTAL_AUTH_REQUIRED/);
  } finally {
    await app.close();
  }
});

test("bitrix/events: migrates stored snake_case tokens to camelCase on regular event", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const domain = "audit-migrate-snake.bitrix24.ru";
  const appToken = "app-token-snake";

  upsertPortal(domain, {
    domain,
    baseUrl: `https://${domain}/rest/`,
    access_token: "snake-access",
    refresh_token: "snake-refresh",
    application_token: appToken,
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      payload: {
        event: "onimbotmessageupdate",
        data: { AUTH: { domain, application_token: appToken } },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"result":"noop"/);

    const portal = getPortal(domain);
    assert.equal(portal.accessToken, "snake-access");
    assert.equal(portal.refreshToken, "snake-refresh");
    assert.equal(portal.applicationToken, appToken);
  } finally {
    await app.close();
  }
});

test("bitrix/events: rejects event when application_token mismatches stored one", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const fake = await startFakeInstallBitrix();

  const domain = "audit-app-token-mismatch.bitrix24.ru";
  const storedToken = "app-token-stored";

  try {
    const installRes = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      payload: {
        event: "onappinstall",
        auth: {
          domain,
          access_token: "access-1",
          refresh_token: "refresh-1",
          client_endpoint: fake.baseUrl,
          application_token: storedToken,
        },
      },
    });
    assert.equal(installRes.statusCode, 200);

    const eventRes = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      payload: {
        event: "onimbotmessageupdate",
        data: {
          AUTH: {
            domain,
            application_token: "app-token-wrong",
          },
        },
      },
    });

    assert.equal(eventRes.statusCode, 401);
    assert.match(eventRes.body, /INVALID_APPLICATION_TOKEN/);
  } finally {
    await fake.close();
    await app.close();
  }
});

test("bitrix/events: allows event when application_token matches stored one", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const fake = await startFakeInstallBitrix();

  const domain = "audit-app-token-match.bitrix24.ru";
  const storedToken = "app-token-ok";

  try {
    const installRes = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      payload: {
        event: "onappinstall",
        auth: {
          domain,
          access_token: "access-2",
          refresh_token: "refresh-2",
          client_endpoint: fake.baseUrl,
          application_token: storedToken,
        },
      },
    });
    assert.equal(installRes.statusCode, 200);

    const eventRes = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      payload: {
        event: "onimbotmessageupdate",
        data: {
          AUTH: {
            domain,
            application_token: storedToken,
          },
        },
      },
    });

    assert.equal(eventRes.statusCode, 200);
    assert.match(eventRes.body, /"result":"noop"/);
  } finally {
    await fake.close();
    await app.close();
  }
});

test("bitrix/events: accepts onappinstall as x-www-form-urlencoded payload", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const fake = await startFakeInstallBitrix();

  const domain = "audit-form-install.bitrix24.ru";
  const appToken = "app-token-form-install";
  const body =
    `event=onappinstall` +
    `&auth[domain]=${encodeURIComponent(domain)}` +
    `&auth[access_token]=access-form-1` +
    `&auth[refresh_token]=refresh-form-1` +
    `&auth[client_endpoint]=${encodeURIComponent(fake.baseUrl)}` +
    `&auth[application_token]=${appToken}`;

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"result":"ok"/);
  } finally {
    await fake.close();
    await app.close();
  }
});

test("bitrix/events: parses nested data[AUTH] from x-www-form-urlencoded", async () => {
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const fake = await startFakeInstallBitrix();

  const domain = "audit-form-event.bitrix24.ru";
  const appToken = "app-token-form-event";
  const installBody =
    `event=onappinstall` +
    `&auth[domain]=${encodeURIComponent(domain)}` +
    `&auth[access_token]=access-form-2` +
    `&auth[refresh_token]=refresh-form-2` +
    `&auth[client_endpoint]=${encodeURIComponent(fake.baseUrl)}` +
    `&auth[application_token]=${appToken}`;

  const eventBody =
    `event=onimbotmessageupdate` +
    `&data[AUTH][domain]=${encodeURIComponent(domain)}` +
    `&data[AUTH][application_token]=${appToken}`;

  try {
    const installRes = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: installBody,
    });
    assert.equal(installRes.statusCode, 200);

    const eventRes = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: eventBody,
    });

    assert.equal(eventRes.statusCode, 200);
    assert.match(eventRes.body, /"result":"noop"/);
  } finally {
    await fake.close();
    await app.close();
  }
});

test("bitrix/events: dumps supported events with sanitized payload", async () => {
  resetDumpDir();
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();

  const domain = "audit-dump-install.bitrix24.ru";
  const note = `user@example.com +7 (999) 111-22-33 ${"A".repeat(6000)}`;

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events",
      payload: {
        event: "onappinstall",
        meta: [{ email: "meta@example.com", phone: "+7 999 888-77-66" }],
        auth: {
          domain,
          access_token: "access-secret-value",
          refresh_token: "refresh-secret-value",
          application_token: "app-secret-token",
          client_endpoint: "http://127.0.0.1:1/rest",
          note,
        },
      },
    });

    assert.equal(res.statusCode, 200);

    const files = fs.readdirSync(DUMP_DIR).filter((f) => f.includes(domain));
    assert.ok(files.length >= 1);

    const payload = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, files[0]), "utf8"));
    const dumpedAuth = payload.body?.auth || {};
    const dumpedMeta = payload.body?.meta || [];

    assert.equal(dumpedAuth.access_token, "***");
    assert.equal(dumpedAuth.refresh_token, "***");
    assert.equal(dumpedAuth.application_token, "***");
    assert.match(String(dumpedAuth.note), /\*\*\*@example\.com/i);
    assert.doesNotMatch(String(dumpedAuth.note), /111-22-33/);
    assert.match(String(dumpedAuth.note), /\(truncated\)/);
    assert.equal(Array.isArray(dumpedMeta), true);
    assert.match(String(dumpedMeta[0]?.email || ""), /\*\*\*@example\.com/i);
    assert.doesNotMatch(String(dumpedMeta[0]?.phone || ""), /888-77-66/);
  } finally {
    await app.close();
    resetDumpDir();
  }
});

test("bitrix/events: does not dump unsupported events", async () => {
  resetDumpDir();
  const { buildServer } = await import("../core/app.js");
  const app = await buildServer();
  const domain = "audit-dump-noop.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: `https://${domain}/rest/`,
    accessToken: "token",
    refreshToken: "refresh",
    applicationToken: "app-token",
  });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/bitrix/events?secret=audit-secret",
      payload: {
        event: "onimbotmessageupdate",
        data: {
          AUTH: {
            domain,
            application_token: "app-token",
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"result":"noop"/);
    assert.equal(fs.existsSync(DUMP_DIR), false);
  } finally {
    await app.close();
    resetDumpDir();
  }
});

test("gate: on PRICING stage without offers should not call Cortex", () => {
  const ctx = {
    message: { text: "какой лучше вариант?" },
    hasImage: false,
    detectedOems: [],
    lead: { statusId: crmSettings.stageToStatusId.PRICING, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.leadStageKey, "PRICING");
  assert.equal(gateInput.hasOffers, false);
  assert.equal(decision.shouldCallCortex, false);
});

test("gate: on PRICING stage with offers should call Cortex", () => {
  const ctx = {
    message: { text: "беру первый вариант" },
    hasImage: false,
    detectedOems: [],
    lead: { statusId: crmSettings.stageToStatusId.PRICING, oemInLead: null },
    session: {
      state: { offers: [{ id: 1, price: 1000 }] },
      abcp: null,
      mode: "auto",
    },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.leadStageKey, "PRICING");
  assert.equal(gateInput.hasOffers, true);
  assert.equal(decision.shouldCallCortex, true);
});

test("messageModel: parses lowercase data.params like data.PARAMS", () => {
  const body = {
    event: "onimbotmessageadd",
    data: {
      AUTH: { domain: "example.bitrix24.ru" },
      params: {
        DIALOG_ID: "chat123",
        CHAT_ID: "123",
        FROM_USER_ID: "77",
        MESSAGE_ID: "555",
        MESSAGE: "hello from params",
      },
    },
  };

  const msg = normalizeIncomingMessage(body);
  assert.equal(msg.portal, "example.bitrix24.ru");
  assert.equal(msg.dialogId, "chat123");
  assert.equal(msg.chatId, "123");
  assert.equal(msg.fromUserId, "77");
  assert.equal(msg.messageId, "555");
  assert.equal(msg.text, "hello from params");
});

test("messageModel: reads FILES/FORWARD from lowercase data.params", () => {
  const body = {
    event: "onimbotmessageadd",
    data: {
      AUTH: { domain: "example.bitrix24.ru" },
      params: {
        DIALOG_ID: "chat777",
        CHAT_ID: "777",
        MESSAGE: "photo attached",
        FILES: [{ id: "f1", name: "image.jpg" }],
        FORWARD: "Y",
      },
    },
  };

  const msg = normalizeIncomingMessage(body);
  assert.equal(msg.dialogId, "chat777");
  assert.equal(msg.chatId, "777");
  assert.equal(msg.text, "photo attached");
  assert.equal(Array.isArray(msg.attachments), true);
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].id, "f1");
  assert.equal(msg.isForwarded, true);
});

test("messageModel: resolves portal from lowercase auth/domain", () => {
  const body = {
    data: {
      auth: {
        domain: "lower-auth.bitrix24.ru",
      },
      params: {
        DIALOG_ID: "chat900",
        CHAT_ID: "900",
        MESSAGE: "hello",
      },
    },
  };

  const msg = normalizeIncomingMessage(body);
  assert.equal(msg.portal, "lower-auth.bitrix24.ru");
  assert.equal(msg.dialogId, "chat900");
  assert.equal(msg.chatId, "900");
  assert.equal(msg.text, "hello");
});

test("decision adapter: PHONE-like text does not become OEM", () => {
  const ctx = {
    message: { text: "+7 (988) 994-57-91" },
    hasImage: false,
    detectedOems: [],
    lead: { statusId: "PROCESSED", oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: [],
  };

  const { gateInput, decision } = buildDecision(ctx);

  assert.equal(gateInput.requestType, "TEXT");
  assert.equal(decision.shouldCallCortex, true);
});
