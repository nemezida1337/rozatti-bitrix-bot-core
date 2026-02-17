import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { upsertPortal } from "../core/store.js";
import {
  finishDialog,
  sendOL,
  sendTyping,
  sendWelcome,
  transferToOperator,
} from "../modules/openlines/api.js";

const TOKENS_FILE = "./data/portals.openlinesApi.test.json";
const TOKENS_PATH = path.resolve(process.cwd(), TOKENS_FILE);

const originalFetch = globalThis.fetch;

function resetStore() {
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, "{}", "utf8");
}

function seedPortal(domain) {
  upsertPortal(domain, {
    domain,
    baseUrl: "https://example.bitrix.test/rest",
    accessToken: "token-1",
    refreshToken: "refresh-1",
  });
}

function methodFromUrl(url) {
  return String(url).match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
}

test.beforeEach(() => {
  process.env.TOKENS_FILE = TOKENS_FILE;
  resetStore();
  globalThis.fetch = originalFetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("openlines/api: sendWelcome sends session message and rethrows api error", async () => {
  const calls = [];
  const okApi = {
    async call(method, payload) {
      calls.push({ method, payload });
      return { result: true };
    },
  };

  await sendWelcome({ api: okApi, dialogId: "chat7001", text: "hi" });
  assert.equal(calls[0].method, "imopenlines.bot.session.message.send");
  assert.equal(calls[0].payload.DIALOG_ID, "chat7001");
  assert.equal(calls[0].payload.MESSAGE, "hi");

  const errApi = {
    async call() {
      throw new Error("welcome fail");
    },
  };
  await assert.rejects(() => sendWelcome({ api: errApi, dialogId: "chat7002" }), /welcome fail/);
});

test("openlines/api: finishDialog and transferToOperator call expected methods", async () => {
  const methods = [];
  const api = {
    async call(method, payload) {
      methods.push({ method, payload });
      return { result: true };
    },
  };

  await finishDialog({ api, sessionId: 77 });
  await transferToOperator({ api, operatorId: 12, sessionId: 78 });

  assert.equal(methods[0].method, "imopenlines.bot.session.finish");
  assert.equal(methods[0].payload.SESSION_ID, 77);
  assert.equal(methods[1].method, "imopenlines.bot.session.transfer");
  assert.equal(methods[1].payload.SESSION_ID, 78);
  assert.equal(methods[1].payload.OPERATOR_ID, 12);
});

test("openlines/api: sendOL builds payload for chat/number/custom dialog ids", async () => {
  const domain = "openlines-payload.bitrix24.ru";
  seedPortal(domain);

  const payloads = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = methodFromUrl(url);
    const params = new URLSearchParams(String(opts.body || ""));
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "imbot.message.add") {
      payloads.push(Object.fromEntries(params.entries()));
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  await sendOL(domain, "chat123", "msg-1");
  await sendOL(domain, "123", "msg-2");
  await sendOL(domain, "line-A", "msg-3");

  assert.equal(payloads.length, 3);
  assert.equal(payloads[0].DIALOG_ID, "chat123");
  assert.equal(payloads[0].CHAT_ID, undefined);
  assert.equal(payloads[1].CHAT_ID, "123");
  assert.equal(payloads[1].DIALOG_ID, undefined);
  assert.equal(payloads[2].DIALOG_ID, "line-A");
});

test("openlines/api: sendOL no-op for empty message and suppresses input errors", async () => {
  const domain = "openlines-noop.bitrix24.ru";
  seedPortal(domain);

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  await sendOL(domain, "chat999", "");
  await sendOL("", "chat999", "hello");
  await sendOL(domain, "", "hello");

  assert.equal(calls, 0);
});

test("openlines/api: sendTyping is safe no-op", async () => {
  await sendTyping("typing-domain.bitrix24.ru", "chat222");
  assert.ok(true);
});
