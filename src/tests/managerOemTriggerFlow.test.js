import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";

import { crmSettings } from "../modules/settings.crm.js";

const VIN_PICK_STATUS_ID = crmSettings.stageToStatusId.VIN_PICK;
const IN_WORK_STATUS_ID = crmSettings.stageToStatusId.IN_WORK;

const originalAxiosCreate = axios.create;
const originalFetch = global.fetch;
const originalEnv = {
  ABCP_DOMAIN: process.env.ABCP_DOMAIN,
  ABCP_KEY: process.env.ABCP_KEY,
  ABCP_USERPSW_MD5: process.env.ABCP_USERPSW_MD5,
};

let stubAbcpGet = async () => ({ data: [] });

process.env.ABCP_DOMAIN = "abcp.test";
process.env.ABCP_KEY = "login";
process.env.ABCP_USERPSW_MD5 = "pass";

axios.create = () => ({
  get: (url, cfg) => stubAbcpGet(url, cfg),
});

const { runManagerOemTriggerFlow } = await import(
  "../modules/bot/handler/flows/managerOemTriggerFlow.js"
);

function restoreAbcpEnv() {
  if (originalEnv.ABCP_DOMAIN == null) delete process.env.ABCP_DOMAIN;
  else process.env.ABCP_DOMAIN = originalEnv.ABCP_DOMAIN;

  if (originalEnv.ABCP_KEY == null) delete process.env.ABCP_KEY;
  else process.env.ABCP_KEY = originalEnv.ABCP_KEY;

  if (originalEnv.ABCP_USERPSW_MD5 == null) delete process.env.ABCP_USERPSW_MD5;
  else process.env.ABCP_USERPSW_MD5 = originalEnv.ABCP_USERPSW_MD5;
}

function makeApi(impl) {
  return {
    call(method, payload) {
      return impl(method, payload);
    },
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test.after(() => {
  axios.create = originalAxiosCreate;
  restoreAbcpEnv();
  global.fetch = originalFetch;
});

test("managerOemTriggerFlow: returns false when session has no leadId", async () => {
  stubAbcpGet = async () => ({ data: [] });

  const api = makeApi(() => {
    throw new Error("api.call should not be used");
  });

  const handled = await runManagerOemTriggerFlow({
    api,
    portalDomain: "audit-flow-no-lead.bitrix24.ru",
    portalCfg: {},
    dialogId: "chat-flow-001",
    session: { mode: "auto" },
  });

  assert.equal(handled, false);
});

test("managerOemTriggerFlow: returns false when crm.lead.get throws", async () => {
  stubAbcpGet = async () => ({ data: [] });

  const api = makeApi((method) => {
    assert.equal(method, "crm.lead.get");
    throw new Error("boom");
  });

  const session = {
    leadId: 701,
    mode: "auto",
    lastSeenLeadOem: null,
  };

  const handled = await runManagerOemTriggerFlow({
    api,
    portalDomain: "audit-flow-lead-get-error.bitrix24.ru",
    portalCfg: {},
    dialogId: "chat-flow-002",
    session,
  });

  assert.equal(handled, false);
  assert.equal(session.lastSeenLeadOem, null);
});

test("managerOemTriggerFlow: syncs lastSeenLeadOem when OEM changed but no trigger", async () => {
  stubAbcpGet = async () => ({ data: [] });

  const oemField = crmSettings.leadFields.OEM;
  const api = makeApi((method, payload) => {
    assert.equal(method, "crm.lead.get");
    assert.deepEqual(payload, { id: 702 });
    return {
      ID: 702,
      STATUS_ID: "NEW",
      [oemField]: "  OEM-NEW-123  ",
    };
  });

  const session = {
    leadId: 702,
    mode: "auto",
    lastSeenLeadOem: "OEM-OLD-001",
    oem_candidates: [],
  };

  const handled = await runManagerOemTriggerFlow({
    api,
    portalDomain: "audit-flow-sync-only.bitrix24.ru",
    portalCfg: {},
    dialogId: "chat-flow-003",
    session,
  });

  assert.equal(handled, false);
  assert.equal(session.lastSeenLeadOem, "OEM-NEW-123");
  assert.deepEqual(session.oem_candidates, []);
});

test("managerOemTriggerFlow: does not trigger outside VIN_PICK stage", async () => {
  stubAbcpGet = async () => ({ data: [] });

  const oemField = crmSettings.leadFields.OEM;
  const api = makeApi((method, payload) => {
    assert.equal(method, "crm.lead.get");
    assert.deepEqual(payload, { id: 7021 });
    return {
      ID: 7021,
      STATUS_ID: IN_WORK_STATUS_ID,
      [oemField]: "OEM-TRIGGER-BLOCKED",
    };
  });

  const session = {
    leadId: 7021,
    mode: "manual",
    lastSeenLeadOem: null,
    leadOemBaselineInitialized: true,
    oem_candidates: [],
  };

  const handled = await runManagerOemTriggerFlow({
    api,
    portalDomain: "audit-flow-not-vin-pick.bitrix24.ru",
    portalCfg: {},
    dialogId: "chat-flow-003a",
    session,
  });

  assert.equal(handled, false);
  assert.equal(session.mode, "manual");
});

test("managerOemTriggerFlow: handles manager OEM trigger and returns true when Cortex is disabled", async () => {
  stubAbcpGet = async () => ({ data: [] });

  const oemField = crmSettings.leadFields.OEM;
  const api = makeApi((method, payload) => {
    assert.equal(method, "crm.lead.get");
    assert.deepEqual(payload, { id: 703 });
    return {
      ID: 703,
      STATUS_ID: VIN_PICK_STATUS_ID,
      [oemField]: "  OEM-TRIGGER-777  ",
    };
  });

  const session = {
    leadId: 703,
    mode: "manual",
    lastSeenLeadOem: null,
    leadOemBaselineInitialized: true,
    oem_candidates: [],
  };

  const prevEnabled = process.env.HF_CORTEX_ENABLED;
  process.env.HF_CORTEX_ENABLED = "false";

  try {
    const handled = await runManagerOemTriggerFlow({
      api,
      portalDomain: "audit-flow-trigger-cortex-off.bitrix24.ru",
      portalCfg: {},
      dialogId: "chat-flow-004",
      session,
    });

    assert.equal(handled, true);
    assert.equal(session.mode, "auto");
    assert.equal(session.lastSeenLeadOem, "OEM-TRIGGER-777");
    assert.deepEqual(session.oem_candidates, ["OEM-TRIGGER-777"]);
  } finally {
    if (prevEnabled == null) delete process.env.HF_CORTEX_ENABLED;
    else process.env.HF_CORTEX_ENABLED = prevEnabled;
  }
});

test("managerOemTriggerFlow: processes Cortex response and sends chat message", async () => {
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

  const oemField = crmSettings.leadFields.OEM;
  const apiCalls = [];
  const api = makeApi((method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "crm.lead.get") {
      return {
        ID: 704,
        STATUS_ID: VIN_PICK_STATUS_ID,
        [oemField]: " OEM-TRIGGER-999 ",
      };
    }
    if (method === "imbot.message.add") return { result: true };
    throw new Error(`Unexpected method: ${method}`);
  });

  const session = {
    leadId: 704,
    mode: "manual",
    lastSeenLeadOem: null,
    leadOemBaselineInitialized: true,
    oem_candidates: [],
    state: { stage: "NEW", offers: [] },
  };

  const prevEnv = {
    HF_CORTEX_ENABLED: process.env.HF_CORTEX_ENABLED,
    HF_CORTEX_URL: process.env.HF_CORTEX_URL,
    HF_CORTEX_TIMEOUT_MS: process.env.HF_CORTEX_TIMEOUT_MS,
  };

  process.env.HF_CORTEX_ENABLED = "true";
  process.env.HF_CORTEX_URL = "http://cortex.test/flow";
  process.env.HF_CORTEX_TIMEOUT_MS = "1000";

  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    async text() {
      return JSON.stringify({
        result: {
          action: "reply",
          stage: "CONTACT",
          reply: "Готово, продолжаем",
          oems: ["OEM-TRIGGER-999"],
        },
      });
    },
  });

  try {
    const handled = await runManagerOemTriggerFlow({
      api,
      portalDomain: "audit-flow-trigger-cortex-ok.bitrix24.ru",
      portalCfg: { baseUrl: "http://127.0.0.1:9/rest", accessToken: "token" },
      dialogId: "chat-flow-005",
      session,
    });

    assert.equal(handled, true);
    assert.equal(session.mode, "auto");
    assert.equal(session.lastSeenLeadOem, "OEM-TRIGGER-999");
    assert.equal(session.state.stage, "CONTACT");
    assert.equal(apiCalls.some((x) => x.method === "imbot.message.add"), true);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("managerOemTriggerFlow: first pass initializes OEM baseline and does not auto-trigger", async () => {
  stubAbcpGet = async () => ({ data: [] });

  const oemField = crmSettings.leadFields.OEM;
  const api = makeApi((method, payload) => {
    assert.equal(method, "crm.lead.get");
    assert.deepEqual(payload, { id: 705 });
    return {
      ID: 705,
      STATUS_ID: VIN_PICK_STATUS_ID,
      [oemField]: "OEM-BASELINE-1",
    };
  });

  const session = {
    leadId: 705,
    mode: "manual",
    lastSeenLeadOem: null,
    leadOemBaselineInitialized: false,
    oem_candidates: [],
  };

  const handled = await runManagerOemTriggerFlow({
    api,
    portalDomain: "audit-flow-baseline-sync.bitrix24.ru",
    portalCfg: {},
    dialogId: "chat-flow-006",
    session,
  });

  assert.equal(handled, false);
  assert.equal(session.lastSeenLeadOem, "OEM-BASELINE-1");
  assert.equal(session.leadOemBaselineInitialized, true);
});
