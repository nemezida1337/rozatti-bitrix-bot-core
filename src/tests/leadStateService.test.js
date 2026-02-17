import assert from "node:assert/strict";
import test from "node:test";

import {
  clearLeadCache,
  getLead,
  getLeadStatusId,
} from "../modules/crm/leadStateService.js";

const originalFetch = globalThis.fetch;

function methodFromUrl(url) {
  return String(url).match(/\/rest\/(.+)\.json/)?.[1] || "unknown";
}

test.beforeEach(() => {
  globalThis.fetch = originalFetch;
  clearLeadCache();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  clearLeadCache();
});

test("leadStateService: validates required args", async () => {
  await assert.rejects(
    () => getLead({ baseUrl: "https://example.test/rest", accessToken: "t", leadId: 1 }),
    /domain is required/,
  );
  await assert.rejects(
    () => getLead({ domain: "a.bitrix24.ru", baseUrl: "https://example.test/rest", accessToken: "t" }),
    /leadId is required/,
  );
});

test("leadStateService: supports both payload shapes and getLeadStatusId", async () => {
  let step = 0;
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get") {
      step += 1;
      if (step === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { result: { result: { ID: 1, STATUS_ID: "NEW" } } };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: 2, STATUS_ID: "IN_WORK" } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const a = await getLead({
    domain: "lead-state-shape.bitrix24.ru",
    baseUrl: "https://example.test/rest",
    accessToken: "token",
    leadId: 1,
    cacheTtlMs: 0,
  });
  assert.equal(a.STATUS_ID, "NEW");

  const b = await getLeadStatusId({
    domain: "lead-state-shape.bitrix24.ru",
    baseUrl: "https://example.test/rest",
    accessToken: "token",
    leadId: 2,
    cacheTtlMs: 0,
  });
  assert.equal(b, "IN_WORK");
});

test("leadStateService: returns cached lead and clearLeadCache works by domain and lead", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get") {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { result: { ID: 10, STATUS_ID: `S${calls}` } };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const domain = "lead-state-cache.bitrix24.ru";
  const base = { domain, baseUrl: "https://example.test/rest", accessToken: "token", cacheTtlMs: 8000 };

  const first = await getLead({ ...base, leadId: 10 });
  const second = await getLead({ ...base, leadId: 10 });
  assert.equal(first.STATUS_ID, "S1");
  assert.equal(second.STATUS_ID, "S1");
  assert.equal(calls, 1);

  clearLeadCache(domain, 10);
  const third = await getLead({ ...base, leadId: 10 });
  assert.equal(third.STATUS_ID, "S2");
  assert.equal(calls, 2);

  clearLeadCache(domain);
  const fourth = await getLead({ ...base, leadId: 10 });
  assert.equal(fourth.STATUS_ID, "S3");
  assert.equal(calls, 3);
});

test("leadStateService: returns empty object for invalid payload and rethrows fetch errors", async () => {
  let mode = "invalid";
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get" && mode === "invalid") {
      return { ok: true, status: 200, async json() { return { result: null }; } };
    }
    if (method === "crm.lead.get" && mode === "error") {
      return {
        ok: true,
        status: 200,
        async json() {
          return { error: "FAIL", error_description: "broken" };
        },
      };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const empty = await getLead({
    domain: "lead-state-invalid.bitrix24.ru",
    baseUrl: "https://example.test/rest",
    accessToken: "token",
    leadId: 11,
    cacheTtlMs: 0,
  });
  assert.deepEqual(empty, {});

  mode = "error";
  await assert.rejects(
    () =>
      getLead({
        domain: "lead-state-invalid.bitrix24.ru",
        baseUrl: "https://example.test/rest",
        accessToken: "token",
        leadId: 11,
        cacheTtlMs: 0,
      }),
    /broken|FAIL/,
  );
});
