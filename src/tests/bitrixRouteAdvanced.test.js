import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { logger } from "../core/logger.js";
import { getPortal, upsertPortal } from "../core/store.js";

process.env.TOKENS_FILE = "./data/portals.bitrixRouteAdvanced.test.json";

const TOKENS_PATH = path.resolve(process.cwd(), process.env.TOKENS_FILE);
const TOKENS_DIR = path.dirname(TOKENS_PATH);

function resetStoreFile() {
  if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, "{}", "utf8");
}

function eventsUrl() {
  const secret = process.env.BITRIX_EVENTS_SECRET;
  if (secret) return `/bitrix/events?secret=${encodeURIComponent(secret)}`;
  return "/bitrix/events";
}

async function startFakeBitrix() {
  const calls = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const methodMatch = String(req.url || "").match(/\/rest\/(.+)\.json/);
      const method = methodMatch ? methodMatch[1] : "unknown";
      calls.push(method);

      let payload = { result: true };
      if (method === "profile") {
        payload = {
          result: {
            ID: "1",
            NAME: "Bot",
            LAST_NAME: "User",
            EMAIL: "bot@example.test",
          },
        };
      } else if (method === "imbot.message.add") {
        payload = { result: 1 };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/rest`;
  return {
    baseUrl,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("bitrix route advanced scenarios", async (t) => {
  const { buildServer } = await import("../core/app.js");

  await t.test("install normalizes expires/user/member/token fields", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-install-normalize.bitrix24.ru";

    try {
      const res = await app.inject({
        method: "POST",
        url: "/bitrix/events",
        payload: {
          event: "onappinstalled",
          auth: {
            DOMAIN: domain,
            access_token: "access-install",
            refresh_token: "refresh-install",
            client_endpoint: "http://127.0.0.1:1/rest",
            member_id: "member-1",
            APPLICATION_TOKEN: "app-token-1",
            USER_ID: 777,
            expires_in: "600",
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"ok"/);

      const portal = getPortal(domain);
      assert.equal(portal.accessToken, "access-install");
      assert.equal(portal.refreshToken, "refresh-install");
      assert.equal(portal.memberId, "member-1");
      assert.equal(portal.applicationToken, "app-token-1");
      assert.equal(portal.userId, "777");
      assert.equal(portal.expires, 600);
      assert.ok(Number(portal.expiresAt) > Date.now());
    } finally {
      await app.close();
    }
  });

  await t.test("event updates only safe fields and warns on user mismatch", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-safe-update.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      baseUrl: "http://127.0.0.1:10000/rest",
      accessToken: "portal-access",
      refreshToken: "portal-refresh",
      userId: "100",
    });

    const warnCalls = [];
    const originalWarn = logger.warn;
    logger.warn = (ctxOrMsg, maybeMsg) => {
      warnCalls.push({ ctxOrMsg, maybeMsg });
      return originalWarn(ctxOrMsg, maybeMsg);
    };

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimbotmessageupdate",
          data: {
            AUTH: {
              domain,
              user_id: "200",
              client_endpoint: "http://127.0.0.1:10001/rest",
              member_id: "member-new",
              access_token: "evil-access",
              refresh_token: "evil-refresh",
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"noop"/);

      const portal = getPortal(domain);
      assert.equal(portal.baseUrl, "http://127.0.0.1:10001/rest");
      assert.equal(portal.memberId, "member-new");
      assert.equal(portal.accessToken, "portal-access");

      const mismatchWarn = warnCalls.find(
        (x) =>
          x.maybeMsg ===
          "Bitrix event auth user_id differs from portal install user_id. Using stored portal auth.",
      );
      assert.ok(mismatchWarn, "Expected user_id mismatch warning");
    } finally {
      logger.warn = originalWarn;
      await app.close();
    }
  });

  await t.test("fills missing portal.domain from incoming auth domain", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-safe-domain-fill.bitrix24.ru";

    // Ключ store = domain, но само поле domain внутри портала отсутствует.
    upsertPortal(domain, {
      baseUrl: "http://127.0.0.1:10002/rest",
      accessToken: "portal-access",
      refreshToken: "portal-refresh",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimbotmessageupdate",
          data: {
            AUTH: {
              domain,
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"noop"/);

      const portal = getPortal(domain);
      assert.equal(portal.domain, domain);
    } finally {
      await app.close();
    }
  });

  await t.test("onimcommandadd is routed to handler and returns ok", async () => {
    resetStoreFile();
    const fake = await startFakeBitrix();
    const app = await buildServer();
    const domain = "audit-command-route.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      baseUrl: fake.baseUrl,
      accessToken: "token-command",
      refreshToken: "refresh-command",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimcommandadd",
          data: {
            AUTH: { domain },
            COMMAND: "help",
            DIALOG_ID: "chat5001",
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"ok"/);
      assert.ok(fake.calls.includes("imbot.message.add"));
    } finally {
      await fake.close();
      await app.close();
    }
  });

  await t.test("onimbotmessageadd logs payload and returns ok", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-messageadd-log.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      baseUrl: "http://127.0.0.1:1/rest",
      accessToken: "token-messageadd",
      refreshToken: "refresh-messageadd",
    });

    const infoCalls = [];
    const originalInfo = logger.info;
    logger.info = (ctxOrMsg, maybeMsg) => {
      infoCalls.push({ ctxOrMsg, maybeMsg });
      return originalInfo(ctxOrMsg, maybeMsg);
    };

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimbotmessageadd",
          data: {
            AUTH: { domain },
            PARAMS: {
              DIALOG_ID: "chat5999",
              CHAT_ID: "5999",
              FROM_USER_ID: "42",
              MESSAGE_ID: "777",
              MESSAGE: "",
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"ok"/);

      const logCall = infoCalls.find((x) => x.maybeMsg === "[LLM] Incoming bot message");
      assert.ok(logCall, "Expected onimbotmessageadd diagnostic log");
      assert.equal(logCall.ctxOrMsg?.dialogId, "chat5999");
      assert.equal(logCall.ctxOrMsg?.chatId, "5999");
      assert.equal(logCall.ctxOrMsg?.fromUserId, "42");
      assert.equal(logCall.ctxOrMsg?.messageId, "777");
    } finally {
      logger.info = originalInfo;
      await app.close();
    }
  });

  await t.test("onimmessageadd is ignored by default and returns noop", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-onimmessageadd-disabled.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      baseUrl: "http://127.0.0.1:1/rest",
      accessToken: "token-onim-disabled",
      refreshToken: "refresh-onim-disabled",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimmessageadd",
          data: {
            AUTH: { domain },
            PARAMS: {
              DIALOG_ID: "chat6111",
              CHAT_ID: "6111",
              FROM_USER_ID: "51",
              MESSAGE_ID: "901",
              MESSAGE: "internal message",
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"noop"/);
    } finally {
      await app.close();
    }
  });

  await t.test("onimmessageadd is routed when BITRIX_ALLOW_ONIMMESSAGEADD=1", async () => {
    resetStoreFile();
    const prev = process.env.BITRIX_ALLOW_ONIMMESSAGEADD;
    process.env.BITRIX_ALLOW_ONIMMESSAGEADD = "1";
    const app = await buildServer();
    const domain = "audit-onimmessageadd-enabled.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      baseUrl: "http://127.0.0.1:1/rest",
      accessToken: "token-onim-enabled",
      refreshToken: "refresh-onim-enabled",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimmessageadd",
          data: {
            AUTH: { domain },
            PARAMS: {
              DIALOG_ID: "chat6112",
              CHAT_ID: "6112",
              FROM_USER_ID: "52",
              MESSAGE_ID: "902",
              MESSAGE: "",
              CHAT_ENTITY_TYPE: "LINES",
            },
            USER: {
              IS_CONNECTOR: "Y",
              IS_BOT: "N",
            },
          },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"ok"/);
    } finally {
      if (prev == null) delete process.env.BITRIX_ALLOW_ONIMMESSAGEADD;
      else process.env.BITRIX_ALLOW_ONIMMESSAGEADD = prev;
      await app.close();
    }
  });

  await t.test("unknown event returns noop", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-unknown-event.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      baseUrl: "http://127.0.0.1:1/rest",
      accessToken: "token-unknown",
      refreshToken: "refresh-unknown",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimrandomcustom",
          data: { AUTH: { domain } },
        },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.body, /"result":"noop"/);
    } finally {
      await app.close();
    }
  });

  await t.test("returns INTERNAL_ERROR when handler throws", async () => {
    resetStoreFile();
    const app = await buildServer();
    const domain = "audit-command-error.bitrix24.ru";

    upsertPortal(domain, {
      domain,
      accessToken: "token-error",
      refreshToken: "refresh-error",
    });

    try {
      const res = await app.inject({
        method: "POST",
        url: eventsUrl(),
        payload: {
          event: "onimcommandadd",
          data: {
            AUTH: { domain },
            COMMAND: "help",
            DIALOG_ID: "chat5002",
          },
        },
      });

      assert.equal(res.statusCode, 500);
      assert.match(res.body, /INTERNAL_ERROR/);
    } finally {
      await app.close();
    }
  });
});
