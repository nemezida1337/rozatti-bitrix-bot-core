import assert from "node:assert/strict";
import test from "node:test";

import axios from "axios";

const originalAxiosCreate = axios.create;
const originalFetch = global.fetch;
const originalEnv = {
  ABCP_DOMAIN: process.env.ABCP_DOMAIN,
  ABCP_KEY: process.env.ABCP_KEY,
  ABCP_USERPSW_MD5: process.env.ABCP_USERPSW_MD5,
  HF_CORTEX_ENABLED: process.env.HF_CORTEX_ENABLED,
  HF_CORTEX_URL: process.env.HF_CORTEX_URL,
  HF_CORTEX_API_KEY: process.env.HF_CORTEX_API_KEY,
  HF_CORTEX_TIMEOUT_MS: process.env.HF_CORTEX_TIMEOUT_MS,
};

let stubAbcpGet = async () => ({ data: [] });

function restoreEnv() {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
}

function mockFetchWithJsonBodies(bodies) {
  let i = 0;
  global.fetch = async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify(body);
      },
    };
  };
  return () => i;
}

function makeApiSpy() {
  const calls = [];
  return {
    calls,
    api: {
      async call(method, params) {
        calls.push({ method, params });
        return { result: true };
      },
    },
  };
}

process.env.ABCP_DOMAIN = "abcp.test";
process.env.ABCP_KEY = "login";
process.env.ABCP_USERPSW_MD5 = "pass";

axios.create = () => ({
  get: (url, cfg) => stubAbcpGet(url, cfg),
});

const { runFastOemFlow } = await import("../modules/bot/handler/flows/fastOemFlow.js");
const { runCortexTwoPassFlow } = await import("../modules/bot/handler/flows/cortexTwoPassFlow.js");

test.after(() => {
  axios.create = originalAxiosCreate;
  global.fetch = originalFetch;
  restoreEnv();
});

test("flows: fastOemFlow returns false when fast-path conditions are not met", async () => {
  process.env.HF_CORTEX_ENABLED = "false";
  stubAbcpGet = async () => ({ data: [] });

  const { api, calls } = makeApiSpy();
  const session = {
    state: { stage: "NEW", offers: [] },
    oem_candidates: [],
  };

  const handled = await runFastOemFlow({
    api,
    portalDomain: "audit-fast-skip.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-fast-001",
    chatId: "1",
    text: "привет",
    session,
  });

  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

test("flows: fastOemFlow handles Cortex=null with fallback reply", async () => {
  process.env.HF_CORTEX_ENABLED = "false";
  stubAbcpGet = async () => ({ data: [] });

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    state: { stage: "NEW", offers: [] },
    oem_candidates: [],
  };

  const handled = await runFastOemFlow({
    api,
    portalDomain: "audit-fast-null-cortex.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-fast-002",
    chatId: "2",
    text: "6Q0820803D",
    session,
  });

  assert.equal(handled, true);
  assert.deepEqual(session.oem_candidates, ["6Q0820803D"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "imbot.message.add");
  assert.match(String(calls[0].params?.MESSAGE || ""), /Получил номера/i);
  assert.match(String(calls[1].params?.MESSAGE || ""), /Сервис временно недоступен/i);
});

test("flows: fastOemFlow handles successful Cortex response and final reply", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params.number, price: 111, deadline: "5 дней" }],
      };
    }
    return { data: [] };
  };

  mockFetchWithJsonBodies([
    {
      result: {
        action: "abcp_lookup",
        stage: "PRICING",
        reply: "Подбор готов",
        oems: ["OEM-LLM-1", "OEM-LLM-2"],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    state: { stage: "NEW", offers: [] },
    oem_candidates: [],
  };

  const handled = await runFastOemFlow({
    api,
    portalDomain: "audit-fast-success.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-fast-003",
    chatId: "3",
    text: "06A906032N",
    session,
  });

  assert.equal(handled, true);
  assert.equal(session.state.stage, "PRICING");
  assert.deepEqual(session.oem_candidates, ["OEM-LLM-1", "OEM-LLM-2"]);
  assert.equal(session.lastSeenLeadOem, "06A906032N");
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].params?.MESSAGE || ""), /Подбор готов/);
});

test("flows: cortexTwoPassFlow handles first-pass Cortex=null", async () => {
  process.env.HF_CORTEX_ENABLED = "false";
  stubAbcpGet = async () => ({ data: [] });

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-null.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-001",
    chatId: "1",
    text: "любой текст",
    session,
  });

  assert.equal(handled, true);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Сервис временно недоступен/i);
});

test("flows: cortexTwoPassFlow runs single-pass when action is not abcp_lookup", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "reply",
        stage: "CONTACT",
        reply: "Уточните телефон",
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-single.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-002",
    chatId: "2",
    text: "нужна консультация",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 1);
  assert.equal(session.state.stage, "CONTACT");
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Уточните телефон/);
});

test("flows: cortexTwoPassFlow second pass no-progress skips duplicate chat reply", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params.number, price: 222, deadline: "4 дня" }],
      };
    }
    return { data: [] };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "abcp_lookup",
        stage: "PRICING",
        reply: "Ищу варианты",
        oems: ["REQ7788"],
      },
    },
    {
      result: {
        action: "abcp_lookup",
        stage: "PRICING",
        reply: "Повтор",
        oems: ["REQ7788"],
        offers: [],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-no-progress.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-003",
    chatId: "3",
    text: "REQ7788",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 2);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Ищу варианты/);
});

test("flows: cortexTwoPassFlow second pass success sends second reply", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params.number, price: 333, deadline: "6 дней" }],
      };
    }
    return { data: [] };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "abcp_lookup",
        stage: "PRICING",
        reply: "Собираю цены",
        oems: ["AAA111"],
      },
    },
    {
      result: {
        action: "reply",
        stage: "PRICING",
        reply: "Нашел 2 предложения",
        offers: [{ id: 1, price: 333 }],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-success.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-004",
    chatId: "4",
    text: "AAA111",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 2);
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Собираю цены/);
  assert.match(String(calls[1].params?.MESSAGE || ""), /Нашел 2 предложения/);
});

