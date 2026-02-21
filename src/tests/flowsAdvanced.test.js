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
let stubAbcpPost = async () => ({ data: { status: 1 } });

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
  post: (url, body, cfg) => stubAbcpPost(url, body, cfg),
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
    phone: "+79991234567",
    lastCortexDecision: {
      pass: "second",
      intent: "OLD_INTENT",
      action: "reply",
      stage: "PRICING",
      at: Date.now() - 1000,
    },
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
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
  assert.equal(session.lastCortexDecision, null);
  assert.equal(session.lastCortexRoute, "cortex_fallback_first_pass");
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
    phone: "+79991234567",
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
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
    phone: "+79991234567",
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
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
    phone: "+79991234567",
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
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

test("flows: cortexTwoPassFlow second pass ABCP_CREATE appends order number to client reply", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params.number, price: 444, deadline: "7 дней" }],
      };
    }
    if (url === "/basket/shipmentMethods") return { data: [{ id: 21 }] };
    if (url === "/basket/shipmentAddresses") return { data: [{ id: 31 }] };
    return { data: [] };
  };
  stubAbcpPost = async (url) => {
    if (url === "/basket/order") {
      return { data: { status: 1, orders: [{ number: "A-2002" }] } };
    }
    return { data: { status: 1 } };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "abcp_lookup",
        stage: "PRICING",
        reply: "Собираю цены",
        oems: ["BBB111"],
      },
    },
    {
      result: {
        action: "reply",
        stage: "ABCP_CREATE",
        reply: "Оформляю заказ",
        chosen_offer_id: 7,
        offers: [{ id: 7, code: "CODE-7", price: 444 }],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    phone: "+79991234567",
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-abcp-create.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-005",
    chatId: "5",
    text: "BBB111",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 2);
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Собираю цены/);
  assert.match(String(calls[1].params?.MESSAGE || ""), /Оформляю заказ/);
  assert.match(String(calls[1].params?.MESSAGE || ""), /A-2002/);
});

test("flows: cortexTwoPassFlow creates order on FINAL stage", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  stubAbcpGet = async (url) => {
    if (url === "/basket/shipmentMethods") return { data: [{ id: 21 }] };
    if (url === "/basket/shipmentAddresses") return { data: [{ id: 31 }] };
    return { data: [] };
  };
  stubAbcpPost = async (url) => {
    if (url === "/basket/order") {
      return { data: { status: 1, orders: [{ number: "A-3003" }] } };
    }
    return { data: { status: 1 } };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "reply",
        stage: "FINAL",
        reply: "Оформляю заказ",
        chosen_offer_id: 5,
        offers: [{ id: 5, code: "CODE-5", price: 777 }],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    phone: "+79991234567",
    state: {
      stage: "CONTACT",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-final-create.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-005b",
    chatId: "5",
    text: "подтверждаю заказ",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 1);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Оформляю заказ/);
  assert.match(String(calls[0].params?.MESSAGE || ""), /A-3003/);
});

test("flows: cortexTwoPassFlow uses current llm contact/address for TS fallback order", async () => {
  const prevOrderClearBasket = process.env.ABCP_ORDER_CLEAR_BASKET;
  const prevTsClientId = process.env.ABCP_TS_CLIENT_ID;

  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";
  process.env.ABCP_ORDER_CLEAR_BASKET = "0";
  delete process.env.ABCP_TS_CLIENT_ID;

  const cpUsersPhoneQueries = [];
  let tsOrderPayload = {};

  stubAbcpGet = async (url, { params }) => {
    if (url === "/cp/users") {
      cpUsersPhoneQueries.push(String(params?.phone || ""));
      return { data: { items: [{ id: 4321, clientId: 4321 }] } };
    }
    if (url === "/ts/agreements/list") return { data: [{ id: 77 }] };
    if (url === "/ts/deliveryMethod/forCo") return { data: [{ id: 55, type: "courier" }] };
    return { data: [] };
  };

  stubAbcpPost = async (url, body) => {
    if (url === "/basket/add") {
      return {
        data: {
          status: 0,
          errorCode: 403,
          errorMessage: "Orders v1 disabled",
        },
      };
    }
    if (url === "/ts/cart/create") {
      return { data: { id: 9001 } };
    }
    if (url === "/ts/orders/createByCart") {
      const qs = new URLSearchParams(String(body || ""));
      tsOrderPayload = Object.fromEntries(qs.entries());
      return { data: { orders: [{ number: "TS-1001" }] } };
    }
    return { data: { status: 1 } };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "reply",
        stage: "FINAL",
        reply: "Оформляю заказ",
        chosen_offer_id: 11,
        offers: [
          {
            id: 11,
            brand: "VAG",
            oem: "06A906032N",
            price: 1234,
            quantity: 1,
            supplierCode: 91,
            itemKey: "IK-11",
          },
        ],
        contact_update: {
          phone: "+7 999 000-11-22",
        },
        update_lead_fields: {
          DELIVERY_ADDRESS: "г. Владивосток, ул. Светланская, д. 10",
        },
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    phone: null,
    state: {
      stage: "CONTACT",
      offers: [],
    },
  };

  try {
    const handled = await runCortexTwoPassFlow({
      api,
      portalDomain: "audit-two-pass-ts-fallback.bitrix24.ru",
      portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
      dialogId: "chat-two-005e",
      chatId: "5",
      text: "подтверждаю, оформляйте",
      session,
    });

    assert.equal(handled, true);
    assert.equal(getFetchCalls(), 1);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].params?.MESSAGE || ""), /TS-1001/);
    assert.ok(cpUsersPhoneQueries.length > 0);
    assert.ok(cpUsersPhoneQueries.some((x) => x.replace(/\D/g, "").endsWith("9990001122")));
    assert.equal(
      tsOrderPayload["delivery[meetData][address]"],
      "г. Владивосток, ул. Светланская, д. 10",
    );
    assert.equal(tsOrderPayload["delivery[meetData][contact]"], "+7 999 000-11-22");
  } finally {
    if (prevOrderClearBasket == null) delete process.env.ABCP_ORDER_CLEAR_BASKET;
    else process.env.ABCP_ORDER_CLEAR_BASKET = prevOrderClearBasket;
    if (prevTsClientId == null) delete process.env.ABCP_TS_CLIENT_ID;
    else process.env.ABCP_TS_CLIENT_ID = prevTsClientId;
  }
});

test("flows: cortexTwoPassFlow does not create order for handover_operator even on FINAL", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  let touchedAbcpOrderApi = false;
  stubAbcpGet = async (url) => {
    if (String(url || "").startsWith("/basket/")) touchedAbcpOrderApi = true;
    return { data: [] };
  };
  stubAbcpPost = async () => {
    touchedAbcpOrderApi = true;
    return { data: { status: 1 } };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "handover_operator",
        stage: "FINAL",
        need_operator: true,
        reply: "Передаю менеджеру",
        chosen_offer_id: 5,
        offers: [{ id: 5, code: "CODE-5", price: 777 }],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    phone: "+79991234567",
    state: {
      stage: "CONTACT",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-no-order-handover.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-005c",
    chatId: "5",
    text: "не актуально, передайте менеджеру",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 1);
  assert.equal(touchedAbcpOrderApi, false);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].params?.MESSAGE || ""), /Передаю менеджеру/);
  assert.doesNotMatch(String(calls[0].params?.MESSAGE || ""), /Заказ в ABCP оформлен/i);
});

test("flows: cortexTwoPassFlow does not create order on LOST stage", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  let touchedAbcpOrderApi = false;
  stubAbcpGet = async (url) => {
    if (String(url || "").startsWith("/basket/")) touchedAbcpOrderApi = true;
    return { data: [] };
  };
  stubAbcpPost = async () => {
    touchedAbcpOrderApi = true;
    return { data: { status: 1 } };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "reply",
        stage: "LOST",
        need_operator: false,
        reply: "Понял, обращайтесь если потребуется подбор",
        chosen_offer_id: 5,
        offers: [{ id: 5, code: "CODE-5", price: 777 }],
      },
    },
  ]);

  const { api, calls } = makeApiSpy();
  const session = {
    leadId: null,
    phone: "+79991234567",
    state: {
      stage: "CONTACT",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-no-order-lost.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-005d",
    chatId: "5",
    text: "не нужно",
    session,
  });

  assert.equal(handled, true);
  assert.equal(getFetchCalls(), 1);
  assert.equal(touchedAbcpOrderApi, false);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].params?.MESSAGE || ""), /обращайтесь/i);
  assert.doesNotMatch(String(calls[0].params?.MESSAGE || ""), /Заказ в ABCP оформлен/i);
});

test("flows: cortexTwoPassFlow converts lead to deal after successful ABCP order", async () => {
  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params.number, price: 555, deadline: "3 дня" }],
      };
    }
    if (url === "/basket/shipmentMethods") return { data: [{ id: 21 }] };
    if (url === "/basket/shipmentAddresses") return { data: [{ id: 31 }] };
    return { data: [] };
  };
  stubAbcpPost = async (url) => {
    if (url === "/basket/order") {
      return { data: { status: 1, orders: [{ number: "A-7777" }] } };
    }
    return { data: { status: 1 } };
  };

  const getFetchCalls = mockFetchWithJsonBodies([
    {
      result: {
        action: "abcp_lookup",
        stage: "PRICING",
        reply: "Ищу варианты",
        oems: ["CCC111"],
      },
    },
    {
      result: {
        action: "reply",
        stage: "ABCP_CREATE",
        reply: "Оформляю заказ",
        chosen_offer_id: 9,
        offers: [{ id: 9, code: "CODE-9", price: 555 }],
      },
    },
  ]);

  const calls = [];
  const api = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "crm.lead.get") {
        return {
          ID: 321,
          TITLE: "Тестовый лид",
          STATUS_ID: "UC_T710VD",
          ASSIGNED_BY_ID: 12,
          SOURCE_ID: "OPENLINES",
        };
      }
      if (method === "crm.lead.convert") {
        return { result: { DEAL_ID: 55501 } };
      }
      return { result: true };
    },
  };

  const session = {
    leadId: 321,
    phone: "+79991234567",
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "audit-two-pass-convert.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "chat-two-006",
    chatId: "6",
    text: "CCC111",
    session,
  });

  assert.equal(handled, true);
  assert.ok(getFetchCalls() >= 2);
  assert.ok(calls.some((x) => x.method === "crm.lead.get"));
  assert.ok(calls.some((x) => x.method === "crm.lead.convert"));
  assert.equal(session.lastLeadConversion?.ok, true);
  assert.equal(session.lastLeadConversion?.dealId, 55501);
});
