// src/scripts/runScenarioDumps.js
//
// Прогоняет 19 сценариев бота (11 small-talk + 3 flow + 5 e2e) и пишет дампы
// в data/tmp/scenario-dumps/<timestamp>.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
function resolveOutDir() {
  const explicit = String(process.env.SCENARIO_DUMPS_OUT_DIR || "").trim();
  if (explicit) return path.resolve(process.cwd(), explicit);
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(ROOT, "data", "tmp", "scenario-dumps", now);
}
const OUT_DIR = resolveOutDir();
const OUT_CORTEX_DIR = path.join(OUT_DIR, "cortex");

const originalFetch = global.fetch;
const originalAxiosCreate = axios.create;

const ENV_KEYS = [
  "ABCP_DOMAIN",
  "ABCP_KEY",
  "ABCP_USERPSW_MD5",
  "HF_CORTEX_ENABLED",
  "HF_CORTEX_URL",
  "HF_CORTEX_TIMEOUT_MS",
  "HF_CORTEX_DUMP",
  "HF_CORTEX_DUMP_DIR",
];

const envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let stubAbcpGet = async () => ({ data: [] });
let stubAbcpPost = async () => ({ data: { status: 1 } });

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

async function writeJson(filepath, obj) {
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(obj, null, 2), "utf8");
}

function setBaseEnv() {
  process.env.ABCP_DOMAIN = "abcp.test";
  process.env.ABCP_KEY = "login";
  process.env.ABCP_USERPSW_MD5 = "pass";
  process.env.HF_CORTEX_DUMP = "1";
  process.env.HF_CORTEX_DUMP_DIR = OUT_CORTEX_DIR;
}

function setCortexEnv({ enabled = "true" } = {}) {
  process.env.HF_CORTEX_ENABLED = enabled;
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function installAxiosStub() {
  axios.create = () => ({
    get: (url, cfg) => stubAbcpGet(url, cfg || {}),
    post: (url, body, cfg) => stubAbcpPost(url, body, cfg || {}),
  });
}

function restoreAxios() {
  axios.create = originalAxiosCreate;
}

function installFetchJsonStub(bodies = []) {
  const calls = [];
  let idx = 0;

  global.fetch = async (url, init = {}) => {
    const payload = bodies[Math.min(idx, Math.max(0, bodies.length - 1))] || {};
    idx += 1;

    let requestBody = null;
    try {
      requestBody = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      requestBody = String(init?.body || "");
    }

    calls.push({
      url: String(url),
      method: String(init?.method || "GET"),
      requestBody,
    });

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify(payload);
      },
    };
  };

  return {
    getCalls: () => cloneJson(calls),
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function makeApiSpy(handlers = {}) {
  const calls = [];
  return {
    calls,
    api: {
      async call(method, params) {
        calls.push({
          method: String(method),
          params: cloneJson(params),
        });
        if (typeof handlers[method] === "function") {
          return handlers[method](params);
        }
        return { result: true };
      },
    },
  };
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      out.push(full);
    }
  }
  await walk(rootDir);
  return out;
}

function mapRelativeToOut(filePaths = []) {
  return filePaths.map((x) => path.relative(OUT_DIR, x).replaceAll("\\", "/"));
}

async function runSmallTalkScenarios(resolveSmallTalk, salesFaqSettings) {
  const scenarios = [
    {
      id: "smalltalk_offtopic_weather",
      title: "OFFTOPIC: погода",
      input: "какая сегодня погода?",
      expected: { intent: "OFFTOPIC", topic: null, reply: salesFaqSettings.offTopicReply },
    },
    {
      id: "smalltalk_howto_default",
      title: "HOWTO default: общий вопрос по срокам",
      input: "Подскажите сроки поставки?",
      expected: { intent: "HOWTO", topic: null, reply: salesFaqSettings.howToDefaultReply },
    },
    {
      id: "smalltalk_topic_contacts",
      title: "HOWTO: CONTACTS",
      input: "Подскажите пожалуйста, как можно с вами созвониться?",
      expected: { intent: "HOWTO", topic: "CONTACTS", reply: salesFaqSettings.topics.CONTACTS },
    },
    {
      id: "smalltalk_topic_address",
      title: "HOWTO: ADDRESS",
      input: "Где вы находитесь? Нужен самовывоз.",
      expected: { intent: "HOWTO", topic: "ADDRESS", reply: salesFaqSettings.topics.ADDRESS },
    },
    {
      id: "smalltalk_topic_hours",
      title: "HOWTO: HOURS",
      input: "Какой у вас график работы?",
      expected: { intent: "HOWTO", topic: "HOURS", reply: salesFaqSettings.topics.HOURS },
    },
    {
      id: "smalltalk_topic_media",
      title: "HOWTO: MEDIA",
      input: "Можете прислать фото запчасти?",
      expected: { intent: "HOWTO", topic: "MEDIA", reply: salesFaqSettings.topics.MEDIA },
    },
    {
      id: "smalltalk_topic_order",
      title: "HOWTO: ORDER",
      input: "Как оформить заказ?",
      expected: { intent: "HOWTO", topic: "ORDER", reply: salesFaqSettings.topics.ORDER },
    },
    {
      id: "smalltalk_topic_delivery",
      title: "HOWTO: DELIVERY",
      input: "Какие сроки доставки?",
      expected: { intent: "HOWTO", topic: "DELIVERY", reply: salesFaqSettings.topics.DELIVERY },
    },
    {
      id: "smalltalk_topic_payment",
      title: "HOWTO: PAYMENT",
      input: "Как оплатить заказ?",
      expected: { intent: "HOWTO", topic: "PAYMENT", reply: salesFaqSettings.topics.PAYMENT },
    },
    {
      id: "smalltalk_topic_return",
      title: "HOWTO: RETURN",
      input: "Как оформить возврат по браку?",
      expected: { intent: "HOWTO", topic: "RETURN", reply: salesFaqSettings.topics.RETURN },
    },
    {
      id: "smalltalk_topic_status",
      title: "HOWTO: STATUS",
      input: "Добрый день! Подскажите заказ №3592 в каком статусе?",
      expected: { intent: "HOWTO", topic: "STATUS", reply: salesFaqSettings.topics.STATUS },
    },
  ];

  const results = [];

  for (const scenario of scenarios) {
    const actual = resolveSmallTalk(scenario.input);
    const ok =
      actual?.intent === scenario.expected.intent &&
      (actual?.topic || null) === scenario.expected.topic &&
      actual?.reply === scenario.expected.reply;

    results.push({
      id: scenario.id,
      group: "small_talk",
      title: scenario.title,
      input: scenario.input,
      expected: scenario.expected,
      actual: actual || null,
      ok,
    });
  }

  return results;
}

async function runFlowFastOemSuccess(runFastOemFlow) {
  setCortexEnv({ enabled: "true" });

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params?.number, price: 111, deadline: "5 дней" }],
      };
    }
    return { data: [] };
  };
  stubAbcpPost = async () => ({ data: { status: 1 } });

  const fetchStub = installFetchJsonStub([
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
    portalDomain: "dump-fast-success.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "dump-fast-001",
    chatId: "1",
    text: "06A906032N",
    session,
  });

  restoreFetch();

  return {
    id: "flow_fast_oem_success",
    group: "flow",
    title: "Fast OEM: NEW -> PRICING",
    input: {
      text: "06A906032N",
      session_before: {
        leadId: null,
        state: { stage: "NEW", offers: [] },
      },
    },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      cortex_calls: fetchStub.getCalls(),
    },
    ok:
      handled === true &&
      session?.state?.stage === "PRICING" &&
      Array.isArray(calls) &&
      calls.length >= 2,
  };
}

async function runFlowManagerTriggerSuccess(runManagerOemTriggerFlow, crmSettings) {
  setCortexEnv({ enabled: "true" });

  stubAbcpGet = async (url) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [
          {
            isOriginal: true,
            number: "OEM-TRIGGER-999",
            price: 100,
            deadline: "5 дней",
          },
        ],
      };
    }
    return { data: [] };
  };
  stubAbcpPost = async () => ({ data: { status: 1 } });

  const fetchStub = installFetchRouterStub({
    cortexBodies: [
      {
        result: {
          action: "reply",
          stage: "CONTACT",
          reply: "Готово, продолжаем",
          oems: ["OEM-TRIGGER-999"],
        },
      },
    ],
  });

  const oemField = crmSettings.leadFields.OEM;
  const { api, calls } = makeApiSpy({
    "crm.lead.get": () => ({
      ID: 704,
      STATUS_ID: crmSettings.stageToStatusId.VIN_PICK,
      [oemField]: " OEM-TRIGGER-999 ",
    }),
    "imbot.message.add": () => ({ result: true }),
  });

  const session = {
    leadId: 704,
    mode: "manual",
    lastSeenLeadOem: null,
    // pending manual-flow candidates allow first-pass trigger after restart.
    oem_candidates: ["OEM-TRIGGER-999"],
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runManagerOemTriggerFlow({
    api,
    portalDomain: "dump-manager-trigger.bitrix24.ru",
    portalCfg: { baseUrl: "http://bitrix.local/rest", accessToken: "token" },
    dialogId: "dump-manager-001",
    session,
  });

  restoreFetch();

  return {
    id: "flow_manager_oem_trigger_success",
    group: "flow",
    title: "Manager OEM trigger: manual -> auto",
    input: {
      session_before: {
        leadId: 704,
        mode: "manual",
        state: { stage: "NEW", offers: [] },
      },
    },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      cortex_calls: fetchStub.getCalls(),
    },
    ok:
      handled === true &&
      session?.mode === "auto" &&
      session?.state?.stage === "CONTACT" &&
      calls.some((x) => x.method === "imbot.message.add"),
  };
}

async function runFlowTwoPassAbcpCreate(runCortexTwoPassFlow) {
  setCortexEnv({ enabled: "true" });

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params?.number, price: 444, deadline: "7 дней" }],
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

  const fetchStub = installFetchJsonStub([
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
    portalDomain: "dump-two-pass-abcp-create.bitrix24.ru",
    portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
    dialogId: "dump-two-pass-001",
    chatId: "5",
    text: "BBB111",
    session,
  });

  restoreFetch();

  const lastMessage = String(calls[calls.length - 1]?.params?.MESSAGE || "");

  return {
    id: "flow_cortex_two_pass_abcp_create",
    group: "flow",
    title: "Two-pass Cortex: PRICING -> ABCP_CREATE (order append)",
    input: {
      text: "BBB111",
      session_before: {
        leadId: null,
        state: { stage: "NEW", offers: [], delivery_address: "г. Москва, ул. Тверская, д. 1" },
        phone: "+79991234567",
      },
    },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      cortex_calls: fetchStub.getCalls(),
      last_chat_message: lastMessage,
    },
    ok:
      handled === true &&
      calls.length >= 2 &&
      /A-2002/i.test(lastMessage),
  };
}

function makeJsonResponse(payload, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return JSON.stringify(payload);
    },
    async json() {
      return payload;
    },
  };
}

function installFetchRouterStub({ cortexBodies = [] } = {}) {
  const calls = [];
  let cortexIndex = 0;

  global.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = String(init?.method || "GET").toUpperCase();
    const bodyRaw = String(init?.body || "");
    const bodyStr = bodyRaw.startsWith("URLSearchParams") ? "" : bodyRaw;

    let requestBody = null;
    try {
      requestBody = bodyStr ? JSON.parse(bodyStr) : null;
    } catch {
      requestBody = bodyRaw || null;
    }

    calls.push({
      url: href,
      method,
      requestBody,
    });

    // Cortex endpoint
    if (href.includes("cortex.test/flow")) {
      const payload = cortexBodies[Math.min(cortexIndex, Math.max(0, cortexBodies.length - 1))] || {};
      cortexIndex += 1;
      return makeJsonResponse(payload);
    }

    // Bitrix profile/get-status probes (sendChatReplyIfAllowed)
    if (href.includes("/profile.json")) {
      return makeJsonResponse({
        result: {
          ID: "1",
          NAME: "Bot",
          LAST_NAME: "User",
          EMAIL: "bot@example.test",
        },
      });
    }

    if (href.includes("/crm.lead.get.json")) {
      return makeJsonResponse({
        result: {
          ID: 501,
          STATUS_ID: "NEW",
        },
      });
    }

    return makeJsonResponse({ result: true });
  };

  return {
    getCalls: () => cloneJson(calls),
  };
}

function countFetchCallsByUrl(fetchCalls = [], marker = "") {
  const mark = String(marker || "");
  if (!mark) return 0;
  return fetchCalls.filter((x) => String(x?.url || "").includes(mark)).length;
}

function getLastImbotMessage(apiCalls = []) {
  for (let i = apiCalls.length - 1; i >= 0; i -= 1) {
    const call = apiCalls[i];
    if (call?.method === "imbot.message.add") {
      return String(call?.params?.MESSAGE || "");
    }
  }
  return "";
}

async function runE2eLeadToDealWithAbcp({
  runFastOemFlow,
  runCortexTwoPassFlow,
}) {
  setCortexEnv({ enabled: "true" });

  stubAbcpGet = async (url, { params }) => {
    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params?.number, price: 5300, deadline: "6 дней" }],
      };
    }
    if (url === "/basket/shipmentMethods") return { data: [{ id: 21 }] };
    if (url === "/basket/shipmentAddresses") return { data: [{ id: 31 }] };
    return { data: [] };
  };
  stubAbcpPost = async (url) => {
    if (url === "/basket/order") {
      return {
        data: {
          status: 1,
          orders: [{ number: "E2E-9001" }],
        },
      };
    }
    return { data: { status: 1 } };
  };

  const fetchStub = installFetchRouterStub({
    cortexBodies: [
      {
        result: {
          action: "abcp_lookup",
          stage: "PRICING",
          reply: "Нашел 2 варианта",
          oems: ["61217726563"],
          offers: [
            { id: 1, code: "CODE-1", price: 5500 },
            { id: 2, code: "CODE-2", price: 5300 },
          ],
        },
      },
      {
        result: {
          action: "reply",
          stage: "FINAL",
          reply: "Подтверждаю оформление",
          chosen_offer_id: 2,
          offers: [{ id: 2, code: "CODE-2", price: 5300 }],
          contact_update: {
            name: "Тест",
            last_name: "Клиент",
            phone: "+79991234567",
          },
          update_lead_fields: {
            DELIVERY_ADDRESS: "г. Москва, ул. Тверская, д. 1",
          },
        },
      },
    ],
  });

  const { api, calls } = makeApiSpy({
    "crm.lead.get": () => ({
      ID: 501,
      TITLE: "E2E лид",
      STATUS_ID: "UC_T710VD",
      ASSIGNED_BY_ID: 12,
      SOURCE_ID: "OPENLINES",
      CONTACT_ID: 777,
    }),
    "crm.lead.convert": () => ({ result: { DEAL_ID: 7001 } }),
    "crm.deal.update": () => ({ result: true }),
    "crm.timeline.comment.add": () => ({ result: true }),
    "imbot.message.add": () => ({ result: true }),
  });

  const portalDomain = "dump-e2e.bitrix24.ru";
  const portalCfg = {
    baseUrl: "http://bitrix.local/rest",
    accessToken: "token",
  };
  const dialogId = "dump-e2e-001";

  const session = {
    leadId: null,
    phone: "+79991234567",
    mode: "auto",
    oem_candidates: [],
    state: {
      stage: "NEW",
      offers: [],
      delivery_address: "г. Москва, ул. Тверская, д. 1",
    },
  };

  const step1 = await runFastOemFlow({
    api,
    portalDomain,
    portalCfg,
    dialogId,
    chatId: "1",
    text: "61217726563",
    session,
  });

  session.leadId = 501;

  const step2 = await runCortexTwoPassFlow({
    api,
    portalDomain,
    portalCfg,
    dialogId,
    chatId: "1",
    text: "Беру второй вариант, оформляйте",
    session,
  });

  restoreFetch();

  const lastMessage = String(calls[calls.length - 1]?.params?.MESSAGE || "");

  return {
    id: "e2e_client_to_abcp_and_deal",
    group: "e2e",
    title: "E2E: клиент -> подбор -> заказ ABCP -> конверсия в сделку",
    input: {
      messages: [
        "61217726563",
        "Беру второй вариант, оформляйте",
      ],
      lead_id_before_final_step: 501,
    },
    output: {
      steps: {
        fast_oem_handled: step1,
        final_order_handled: step2,
      },
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      fetch_calls: fetchStub.getCalls(),
      last_chat_message: lastMessage,
      conversion: cloneJson(session?.lastLeadConversion || null),
      abcp_order: cloneJson(session?.lastAbcpOrder || null),
    },
    ok:
      step1 === true &&
      step2 === true &&
      session?.lastAbcpOrder?.ok === true &&
      Array.isArray(session?.lastAbcpOrder?.orderNumbers) &&
      session.lastAbcpOrder.orderNumbers.includes("E2E-9001") &&
      session?.lastLeadConversion?.ok === true &&
      Number(session?.lastLeadConversion?.dealId) === 7001 &&
      calls.some((x) => x.method === "crm.lead.convert") &&
      /E2E-9001/i.test(lastMessage),
  };
}

async function runE2eServiceNoticeInWork({ runCortexTwoPassFlow }) {
  setCortexEnv({ enabled: "true" });

  const abcpGetCalls = [];
  const abcpPostCalls = [];
  stubAbcpGet = async (url, cfg = {}) => {
    abcpGetCalls.push({ url: String(url || ""), cfg: cloneJson(cfg) });
    return { data: [] };
  };
  stubAbcpPost = async (url, body, cfg = {}) => {
    abcpPostCalls.push({ url: String(url || ""), body: cloneJson(body), cfg: cloneJson(cfg) });
    return { data: { status: 1 } };
  };

  const fetchStub = installFetchRouterStub({
    cortexBodies: [
      {
        result: {
          action: "reply",
          stage: "IN_WORK",
          reply: "Спасибо за уведомление, проверим обновление прайса.",
          intent: "SERVICE_NOTICE",
          confidence: 1,
        },
      },
    ],
  });

  const { api, calls } = makeApiSpy({
    "imbot.message.add": () => ({ result: true }),
  });

  const session = {
    leadId: null,
    mode: "auto",
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "dump-e2e-service-notice.bitrix24.ru",
    portalCfg: { baseUrl: "http://bitrix.local/rest", accessToken: "token" },
    dialogId: "dump-e2e-service-notice-001",
    chatId: "1",
    text: "Ваш прайс давно не обновлялся на farpost, проверьте packetdated.",
    session,
  });

  restoreFetch();

  const fetchCalls = fetchStub.getCalls();
  const lastMessage = getLastImbotMessage(calls);

  return {
    id: "e2e_service_notice_in_work",
    group: "e2e",
    title: "E2E: service notice -> IN_WORK без ABCP",
    input: {
      message: "Ваш прайс давно не обновлялся на farpost, проверьте packetdated.",
    },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      fetch_calls: fetchCalls,
      abcp_calls: {
        get: cloneJson(abcpGetCalls),
        post: cloneJson(abcpPostCalls),
      },
      last_chat_message: lastMessage,
      cortex_calls_count: countFetchCallsByUrl(fetchCalls, "cortex.test/flow"),
    },
    ok:
      handled === true &&
      session?.state?.stage === "IN_WORK" &&
      countFetchCallsByUrl(fetchCalls, "cortex.test/flow") === 1 &&
      abcpGetCalls.length === 0 &&
      abcpPostCalls.length === 0 &&
      /проверим обновление прайса/i.test(lastMessage),
  };
}

async function runE2eOrderStatusInWork({ runCortexTwoPassFlow }) {
  setCortexEnv({ enabled: "true" });

  const abcpGetCalls = [];
  const abcpPostCalls = [];
  stubAbcpGet = async (url, cfg = {}) => {
    abcpGetCalls.push({ url: String(url || ""), cfg: cloneJson(cfg) });
    return { data: [] };
  };
  stubAbcpPost = async (url, body, cfg = {}) => {
    abcpPostCalls.push({ url: String(url || ""), body: cloneJson(body), cfg: cloneJson(cfg) });
    return { data: { status: 1 } };
  };

  const fetchStub = installFetchRouterStub({
    cortexBodies: [
      {
        result: {
          action: "reply",
          stage: "IN_WORK",
          reply: "Принял номер заказа 102123458, проверим статус и вернемся с обновлением.",
          intent: "ORDER_STATUS",
          confidence: 1,
        },
      },
    ],
  });

  const { api, calls } = makeApiSpy({
    "imbot.message.add": () => ({ result: true }),
  });

  const session = {
    leadId: null,
    mode: "auto",
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "dump-e2e-order-status.bitrix24.ru",
    portalCfg: { baseUrl: "http://bitrix.local/rest", accessToken: "token" },
    dialogId: "dump-e2e-order-status-001",
    chatId: "1",
    text: "Добрый день, номер заказа 102123458, подскажите статус",
    session,
  });

  restoreFetch();

  const fetchCalls = fetchStub.getCalls();
  const lastMessage = getLastImbotMessage(calls);

  return {
    id: "e2e_order_status_in_work",
    group: "e2e",
    title: "E2E: order status -> IN_WORK без ABCP",
    input: {
      message: "Добрый день, номер заказа 102123458, подскажите статус",
    },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      fetch_calls: fetchCalls,
      abcp_calls: {
        get: cloneJson(abcpGetCalls),
        post: cloneJson(abcpPostCalls),
      },
      last_chat_message: lastMessage,
      cortex_calls_count: countFetchCallsByUrl(fetchCalls, "cortex.test/flow"),
    },
    ok:
      handled === true &&
      session?.state?.stage === "IN_WORK" &&
      countFetchCallsByUrl(fetchCalls, "cortex.test/flow") === 1 &&
      abcpGetCalls.length === 0 &&
      abcpPostCalls.length === 0 &&
      /проверим статус/i.test(lastMessage),
  };
}

async function runE2eAmbiguousNumberClarify({ runCortexTwoPassFlow }) {
  setCortexEnv({ enabled: "true" });

  const abcpGetCalls = [];
  const abcpPostCalls = [];
  stubAbcpGet = async (url, cfg = {}) => {
    abcpGetCalls.push({ url: String(url || ""), cfg: cloneJson(cfg) });
    return { data: [] };
  };
  stubAbcpPost = async (url, body, cfg = {}) => {
    abcpPostCalls.push({ url: String(url || ""), body: cloneJson(body), cfg: cloneJson(cfg) });
    return { data: { status: 1 } };
  };

  const fetchStub = installFetchRouterStub({
    cortexBodies: [
      {
        result: {
          action: "reply",
          stage: "NEW",
          reply:
            "Уточните, пожалуйста: это номер заказа или OEM? Если номер заказа - проверю статус.",
          intent: "CLARIFY_NUMBER_TYPE",
          requires_clarification: true,
          ambiguity_reason: "NUMBER_TYPE_AMBIGUOUS",
          confidence: 1,
        },
      },
    ],
  });

  const { api, calls } = makeApiSpy({
    "imbot.message.add": () => ({ result: true }),
  });

  const session = {
    leadId: null,
    mode: "auto",
    state: { stage: "NEW", offers: [] },
  };

  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "dump-e2e-clarify-number.bitrix24.ru",
    portalCfg: { baseUrl: "http://bitrix.local/rest", accessToken: "token" },
    dialogId: "dump-e2e-clarify-number-001",
    chatId: "1",
    text: "4655",
    session,
  });

  restoreFetch();

  const fetchCalls = fetchStub.getCalls();
  const lastMessage = getLastImbotMessage(calls);

  return {
    id: "e2e_ambiguous_number_clarify",
    group: "e2e",
    title: "E2E: ambiguous number -> clarify",
    input: {
      message: "4655",
    },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      fetch_calls: fetchCalls,
      abcp_calls: {
        get: cloneJson(abcpGetCalls),
        post: cloneJson(abcpPostCalls),
      },
      last_chat_message: lastMessage,
      cortex_calls_count: countFetchCallsByUrl(fetchCalls, "cortex.test/flow"),
      last_cortex_decision: cloneJson(session?.lastCortexDecision || null),
    },
    ok:
      handled === true &&
      session?.state?.stage === "NEW" &&
      session?.lastCortexDecision?.intent === "CLARIFY_NUMBER_TYPE" &&
      session?.lastCortexDecision?.requires_clarification === true &&
      countFetchCallsByUrl(fetchCalls, "cortex.test/flow") === 1 &&
      abcpGetCalls.length === 0 &&
      abcpPostCalls.length === 0 &&
      /номер заказа или oem/i.test(lastMessage),
  };
}

async function runE2eMixedVinOemRoute({ runCortexTwoPassFlow }) {
  setCortexEnv({ enabled: "true" });

  const abcpGetCalls = [];
  const abcpPostCalls = [];
  stubAbcpGet = async (url, cfg = {}) => {
    const params = cfg?.params || {};
    abcpGetCalls.push({ url: String(url || ""), params: cloneJson(params) });

    if (url === "/search/brands") return { data: [{ brand: "BMW" }] };
    if (url === "/search/articles") {
      return {
        data: [{ isOriginal: true, number: params?.number, price: 7700, deadline: "8 дней" }],
      };
    }
    return { data: [] };
  };
  stubAbcpPost = async (url, body, cfg = {}) => {
    abcpPostCalls.push({ url: String(url || ""), body: cloneJson(body), cfg: cloneJson(cfg) });
    return { data: { status: 1 } };
  };

  const fetchStub = installFetchRouterStub({
    cortexBodies: [
      {
        result: {
          action: "abcp_lookup",
          stage: "PRICING",
          reply: "Проверяю OEM и VIN, собираю варианты.",
          intent: "OEM_QUERY",
          oems: ["52105A67977"],
        },
      },
      {
        result: {
          action: "reply",
          stage: "PRICING",
          reply: "Нашел вариант по OEM 52105A67977.",
          intent: "OEM_QUERY",
          oems: ["52105A67977"],
          offers: [{ id: 1, code: "CODE-52105", oem: "52105A67977", price: 7700 }],
        },
      },
    ],
  });

  const { api, calls } = makeApiSpy({
    "imbot.message.add": () => ({ result: true }),
  });

  const session = {
    leadId: null,
    mode: "auto",
    state: { stage: "NEW", offers: [] },
    oem_candidates: [],
  };

  const text =
    "Моторчик продольной регулировки водительского сидения, VIN LBV5U5401MMZ97474, артикул 52105A67977";
  const handled = await runCortexTwoPassFlow({
    api,
    portalDomain: "dump-e2e-mixed-vin-oem.bitrix24.ru",
    portalCfg: { baseUrl: "http://bitrix.local/rest", accessToken: "token" },
    dialogId: "dump-e2e-mixed-vin-oem-001",
    chatId: "1",
    text,
    session,
  });

  restoreFetch();

  const fetchCalls = fetchStub.getCalls();
  const lastMessage = getLastImbotMessage(calls);

  return {
    id: "e2e_mixed_vin_oem_route",
    group: "e2e",
    title: "E2E: mixed VIN+OEM -> OEM/PRICING path",
    input: { message: text },
    output: {
      handled,
      session_after: cloneJson(session),
      api_calls: cloneJson(calls),
      fetch_calls: fetchCalls,
      abcp_calls: {
        get: cloneJson(abcpGetCalls),
        post: cloneJson(abcpPostCalls),
      },
      last_chat_message: lastMessage,
      cortex_calls_count: countFetchCallsByUrl(fetchCalls, "cortex.test/flow"),
      last_cortex_decision: cloneJson(session?.lastCortexDecision || null),
    },
    ok:
      handled === true &&
      session?.state?.stage === "PRICING" &&
      Array.isArray(session?.oem_candidates) &&
      session.oem_candidates.includes("52105A67977") &&
      session?.lastCortexDecision?.intent === "OEM_QUERY" &&
      countFetchCallsByUrl(fetchCalls, "cortex.test/flow") === 2 &&
      abcpGetCalls.length > 0 &&
      abcpPostCalls.length === 0 &&
      /вариант по oem/i.test(lastMessage),
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(OUT_CORTEX_DIR, { recursive: true });

  setBaseEnv();
  installAxiosStub();

  const { resolveSmallTalk } = await import("../modules/bot/handler/shared/smallTalk.js");
  const { salesFaqSettings } = await import("../modules/settings.salesFaq.js");
  const { crmSettings } = await import("../modules/settings.crm.js");
  const { runFastOemFlow } = await import("../modules/bot/handler/flows/fastOemFlow.js");
  const { runManagerOemTriggerFlow } = await import(
    "../modules/bot/handler/flows/managerOemTriggerFlow.js"
  );
  const { runCortexTwoPassFlow } = await import("../modules/bot/handler/flows/cortexTwoPassFlow.js");

  const beforeFiles = await listFilesRecursive(OUT_CORTEX_DIR);

  const smallTalkResults = await runSmallTalkScenarios(resolveSmallTalk, salesFaqSettings);
  const flowResults = [];
  flowResults.push(await runFlowFastOemSuccess(runFastOemFlow));
  flowResults.push(await runFlowManagerTriggerSuccess(runManagerOemTriggerFlow, crmSettings));
  flowResults.push(await runFlowTwoPassAbcpCreate(runCortexTwoPassFlow));
  const e2eResults = [];
  e2eResults.push(
    await runE2eLeadToDealWithAbcp({
      runFastOemFlow,
      runCortexTwoPassFlow,
    }),
  );
  e2eResults.push(
    await runE2eServiceNoticeInWork({
      runCortexTwoPassFlow,
    }),
  );
  e2eResults.push(
    await runE2eOrderStatusInWork({
      runCortexTwoPassFlow,
    }),
  );
  e2eResults.push(
    await runE2eAmbiguousNumberClarify({
      runCortexTwoPassFlow,
    }),
  );
  e2eResults.push(
    await runE2eMixedVinOemRoute({
      runCortexTwoPassFlow,
    }),
  );

  const all = [...smallTalkResults, ...flowResults, ...e2eResults];

  for (const row of all) {
    const filePath = path.join(OUT_DIR, `${row.id}.json`);
    await writeJson(filePath, row);
  }

  const afterFiles = await listFilesRecursive(OUT_CORTEX_DIR);
  const newCortexFiles = afterFiles.filter((f) => !beforeFiles.includes(f));

  const summary = {
    generated_at: new Date().toISOString(),
    scenarios_total: all.length,
    scenarios_ok: all.filter((x) => x.ok).length,
    scenarios_failed: all.filter((x) => !x.ok).length,
    failed_scenario_ids: all.filter((x) => !x.ok).map((x) => x.id),
    groups: {
      small_talk: smallTalkResults.length,
      flow: flowResults.length,
      e2e: e2eResults.length,
    },
    output_dir: path.relative(ROOT, OUT_DIR).replaceAll("\\", "/"),
    cortex_dump_files: mapRelativeToOut(newCortexFiles),
    scenario_files: all.map((x) => `${x.id}.json`),
  };

  await writeJson(path.join(OUT_DIR, "index.json"), summary);

  const compact = {
    summary,
    scenarios: all.map((x) => ({ id: x.id, group: x.group, title: x.title, ok: x.ok })),
  };
  await writeJson(path.join(OUT_DIR, "summary_compact.json"), compact);

  const enforceStrict = String(process.env.SCENARIO_DUMPS_ENFORCE || "").trim() === "1";
  if (enforceStrict && summary.scenarios_failed > 0) {
    throw new Error(
      `Scenario dump failures: ${summary.failed_scenario_ids.join(", ") || "unknown"}`,
    );
  }

  restoreFetch();
  restoreAxios();
  restoreEnv();

  process.stdout.write(
    `SCENARIO_DUMPS_READY ${summary.output_dir} total=${summary.scenarios_total} ok=${summary.scenarios_ok}\n`,
  );
}

main().catch((err) => {
  restoreFetch();
  restoreAxios();
  restoreEnv();
  process.stderr.write(`SCENARIO_DUMPS_FAILED ${String(err?.stack || err)}\n`);
  process.exitCode = 1;
});
