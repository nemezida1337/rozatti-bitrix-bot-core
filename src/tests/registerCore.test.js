import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { upsertPortal } from "../core/store.js";
import {
  ensureBotRegistered,
  handleOnImBotMessageAdd,
  handleOnImCommandAdd,
} from "../modules/bot/register.core.js";

const TOKENS_FILE = "./data/portals.registerCore.test.json";
const TOKENS_PATH = path.resolve(process.cwd(), TOKENS_FILE);

const originalFetch = globalThis.fetch;
const originalEnv = {
  BASE_URL: process.env.BASE_URL,
  BOT_CODE: process.env.BOT_CODE,
  BITRIX_EVENTS_SECRET: process.env.BITRIX_EVENTS_SECRET,
};

function resetStore() {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, "{}", "utf8");
}

function restoreEnv() {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeFetchStub({ botList = [], openlinesConfigList = [], onCall } = {}) {
  return async (url, opts = {}) => {
    const method = String(url).match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    const params = new URLSearchParams(String(opts.body || ""));
    if (onCall) onCall({ method, params });

    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            result: { ID: "1", NAME: "Bot", LAST_NAME: "User", EMAIL: "bot@example.test" },
          };
        },
      };
    }
    if (method === "imbot.bot.list") {
      return { ok: true, status: 200, async json() { return { result: botList }; } };
    }
    if (method === "imbot.register") {
      return { ok: true, status: 200, async json() { return { result: 9001 }; } };
    }
    if (method === "imbot.command.register") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    if (method === "imopenlines.config.list.get") {
      return { ok: true, status: 200, async json() { return { result: openlinesConfigList }; } };
    }
    if (method === "imopenlines.config.update") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    if (method === "imbot.message.add") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    if (method === "imopenlines.bot.session.message.send") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    if (method === "crm.lead.add") {
      return { ok: true, status: 200, async json() { return { result: 777 }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };
}

function seedPortal(domain) {
  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-1",
    refreshToken: "refresh-1",
  });
}

test.beforeEach(() => {
  process.env.TOKENS_FILE = TOKENS_FILE;
  resetStore();
  restoreEnv();
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

test("register.core: ensureBotRegistered refreshes existing bot callbacks without command re-register", async () => {
  const domain = "register-core-existing.bitrix24.ru";
  process.env.BOT_CODE = "ram_parts_bot";
  process.env.BASE_URL = "https://my-bot.example";
  seedPortal(domain);

  const called = [];
  globalThis.fetch = makeFetchStub({
    botList: [{ CODE: "ram_parts_bot" }],
    onCall: ({ method }) => called.push(method),
  });

  await ensureBotRegistered(domain);

  assert.ok(called.includes("imbot.bot.list"));
  assert.equal(called.includes("imbot.register"), true);
  assert.equal(called.includes("imbot.command.register"), false);
});

test("register.core: ensureBotRegistered detects existing bot in object-shaped imbot.bot.list", async () => {
  const domain = "register-core-existing-object.bitrix24.ru";
  process.env.BOT_CODE = "ram_parts_bot";
  process.env.BASE_URL = "https://my-bot.example";
  seedPortal(domain);

  const called = [];
  globalThis.fetch = makeFetchStub({
    botList: {
      "42": { CODE: "ram_parts_bot" },
    },
    onCall: ({ method }) => called.push(method),
  });

  await ensureBotRegistered(domain);

  assert.equal(called.includes("imbot.register"), true);
  assert.equal(called.includes("imbot.command.register"), false);
});

test("register.core: ensureBotRegistered updates open lines welcome bot bindings when stale bot id is configured", async () => {
  const domain = "register-core-openlines-sync.bitrix24.ru";
  process.env.BOT_CODE = "ram_parts_bot";
  process.env.BASE_URL = "https://my-bot.example";
  seedPortal(domain);

  const called = [];
  globalThis.fetch = makeFetchStub({
    botList: [{ CODE: "ram_parts_bot", ID: 9001 }],
    openlinesConfigList: [
      {
        ID: "6",
        LINE_NAME: "Telegram",
        WELCOME_BOT_ENABLE: "Y",
        WELCOME_BOT_ID: "123",
        WELCOME_BOT_JOIN: "always",
      },
      {
        ID: "7",
        LINE_NAME: "WhatsApp",
        WELCOME_BOT_ENABLE: "N",
        WELCOME_BOT_ID: "0",
      },
    ],
    onCall: ({ method }) => called.push(method),
  });

  await ensureBotRegistered(domain);

  assert.equal(called.includes("imopenlines.config.list.get"), true);
  assert.equal(called.includes("imopenlines.config.update"), true);
});

test("register.core: ensureBotRegistered registers bot and commands with secret in callback URL", async () => {
  const domain = "register-core-new.bitrix24.ru";
  process.env.BOT_CODE = "ram_parts_bot";
  process.env.BASE_URL = "https://my-bot.example";
  process.env.BITRIX_EVENTS_SECRET = "evt-secret";
  seedPortal(domain);

  const registerPayloads = [];
  const commandPayloads = [];
  globalThis.fetch = makeFetchStub({
    botList: [],
    onCall: ({ method, params }) => {
      if (method === "imbot.register") registerPayloads.push(Object.fromEntries(params.entries()));
      if (method === "imbot.command.register") commandPayloads.push(Object.fromEntries(params.entries()));
    },
  });

  await ensureBotRegistered(domain);

  assert.equal(registerPayloads.length, 1);
  assert.match(
    registerPayloads[0].EVENT_MESSAGE_ADD || "",
    /\/bitrix\/events\?secret=evt-secret$/,
  );
  assert.equal(commandPayloads.length, 3);
});

test("register.core: ensureBotRegistered uses callback URL without secret when BITRIX_EVENTS_SECRET is empty", async () => {
  const domain = "register-core-no-secret.bitrix24.ru";
  process.env.BOT_CODE = "ram_parts_bot";
  process.env.BASE_URL = "https://my-bot.example";
  delete process.env.BITRIX_EVENTS_SECRET;
  seedPortal(domain);

  const registerPayloads = [];
  globalThis.fetch = makeFetchStub({
    botList: [],
    onCall: ({ method, params }) => {
      if (method === "imbot.register") registerPayloads.push(Object.fromEntries(params.entries()));
    },
  });

  await ensureBotRegistered(domain);

  assert.equal(registerPayloads.length, 1);
  assert.equal(registerPayloads[0].EVENT_MESSAGE_ADD, "https://my-bot.example/bitrix/events");
});

test("register.core: ensureBotRegistered fails when BASE_URL is missing", async () => {
  const domain = "register-core-no-base.bitrix24.ru";
  delete process.env.BASE_URL;
  seedPortal(domain);

  globalThis.fetch = makeFetchStub({ botList: [] });

  await assert.rejects(() => ensureBotRegistered(domain), /BASE_URL is not set/);
});

test("register.core: ensureBotRegistered rethrows when imbot.register fails", async () => {
  const domain = "register-core-register-fail.bitrix24.ru";
  process.env.BOT_CODE = "ram_parts_bot";
  process.env.BASE_URL = "https://my-bot.example";
  seedPortal(domain);

  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
    if (method === "profile") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: "1", NAME: "Bot", LAST_NAME: "User", EMAIL: "bot@example.test" } };
        },
      };
    }
    if (method === "imbot.bot.list") {
      return { ok: true, status: 200, async json() { return { result: [] }; } };
    }
    if (method === "imbot.register") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { error: "REGISTER_FAILED", error_description: "register fail" };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  await assert.rejects(() => ensureBotRegistered(domain), /register fail|REGISTER_FAILED/);
});

test("register.core: handleOnImCommandAdd covers help/lead/vin/unknown", async () => {
  const domain = "register-core-command.bitrix24.ru";
  const portal = { domain, baseUrl: "https://example.bitrix.test/rest", accessToken: "token-1" };

  const sentMessages = [];
  const leadTitles = [];
  globalThis.fetch = makeFetchStub({
    onCall: ({ method, params }) => {
      if (method === "imbot.message.add") sentMessages.push(params.get("MESSAGE"));
      if (method === "crm.lead.add") leadTitles.push(params.get("fields[TITLE]"));
    },
  });

  await handleOnImCommandAdd({
    domain,
    portal,
    body: { data: { COMMAND: "help", DIALOG_ID: "chat101" } },
  });
  await handleOnImCommandAdd({
    domain,
    portal,
    body: { data: { COMMAND: "lead", COMMAND_PARAMS: "Новый лид", DIALOG_ID: "chat101" } },
  });
  await handleOnImCommandAdd({
    domain,
    portal,
    body: { data: { COMMAND: "vin", COMMAND_PARAMS: "WBA123", DIALOG_ID: "chat101" } },
  });
  await handleOnImCommandAdd({
    domain,
    portal,
    body: { data: { COMMAND: "something", DIALOG_ID: "chat101" } },
  });

  assert.equal(leadTitles.includes("Новый лид"), true);
  assert.equal(sentMessages.some((m) => /Команды:/.test(String(m))), true);
  assert.equal(sentMessages.some((m) => /VIN 'WBA123' принят/.test(String(m))), true);
  assert.equal(sentMessages.some((m) => /Неизвестная команда/.test(String(m))), true);
});

test("register.core: handleOnImBotMessageAdd covers help/vin/lead/default branches", async () => {
  const domain = "register-core-message.bitrix24.ru";
  const portal = { domain, baseUrl: "https://example.bitrix.test/rest", accessToken: "token-1" };

  const sentMessages = [];
  const leadTitles = [];
  const welcomeCalls = [];
  globalThis.fetch = makeFetchStub({
    onCall: ({ method, params }) => {
      if (method === "imbot.message.add") sentMessages.push(params.get("MESSAGE"));
      if (method === "crm.lead.add") leadTitles.push(params.get("fields[TITLE]"));
      if (method === "imopenlines.bot.session.message.send") welcomeCalls.push(params.get("MESSAGE"));
    },
  });

  await handleOnImBotMessageAdd({
    domain,
    portal,
    body: { data: { PARAMS: { DIALOG_ID: "chat202", MESSAGE: "/help" } } },
  });
  await handleOnImBotMessageAdd({
    domain,
    portal,
    body: {
      data: { PARAMS: { DIALOG_ID: "chat303", MESSAGE: "/vin WBA123", CHAT_ENTITY_TYPE: "LINES" } },
    },
  });
  await handleOnImBotMessageAdd({
    domain,
    portal,
    body: { data: { PARAMS: { DIALOG_ID: "chat404", MESSAGE: "/lead Тест лид" } } },
  });
  await handleOnImBotMessageAdd({
    domain,
    portal,
    body: { data: { PARAMS: { DIALOG_ID: "chat505", MESSAGE: "обычный текст" } } },
  });

  assert.equal(sentMessages.some((m) => /Команды:/.test(String(m))), true);
  assert.equal(sentMessages.some((m) => /VIN-поиск принят/.test(String(m))), true);
  assert.equal(leadTitles.includes("Тест лид"), true);
  assert.equal(sentMessages.some((m) => /Принято. Напишите VIN/.test(String(m))), true);
  assert.equal(welcomeCalls.includes("Приняли VIN. Ожидайте."), true);
});

test("register.core: handleOnImBotMessageAdd VIN with invalid chat dialog does not call openlines welcome", async () => {
  const domain = "register-core-vin-invalid-chat.bitrix24.ru";
  const portal = { domain, baseUrl: "https://example.bitrix.test/rest", accessToken: "token-1" };

  const welcomeCalls = [];
  globalThis.fetch = makeFetchStub({
    onCall: ({ method }) => {
      if (method === "imopenlines.bot.session.message.send") welcomeCalls.push(method);
    },
  });

  await handleOnImBotMessageAdd({
    domain,
    portal,
    body: {
      data: { PARAMS: { DIALOG_ID: "chatBAD", MESSAGE: "/vin X1", CHAT_ENTITY_TYPE: "LINES" } },
    },
  });

  assert.equal(welcomeCalls.length, 0);
});

test("register.core: handleOnImBotMessageAdd VIN with non-chat dialog id skips openlines welcome", async () => {
  const domain = "register-core-vin-non-chat-dialog.bitrix24.ru";
  const portal = { domain, baseUrl: "https://example.bitrix.test/rest", accessToken: "token-1" };

  const welcomeCalls = [];
  globalThis.fetch = makeFetchStub({
    onCall: ({ method }) => {
      if (method === "imopenlines.bot.session.message.send") welcomeCalls.push(method);
    },
  });

  await handleOnImBotMessageAdd({
    domain,
    portal,
    body: {
      data: { PARAMS: { DIALOG_ID: "12345", MESSAGE: "/vin X2", CHAT_ENTITY_TYPE: "LINES" } },
    },
  });

  assert.equal(welcomeCalls.length, 0);
});
