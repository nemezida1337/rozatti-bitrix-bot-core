import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { upsertPortal } from "../core/store.js";
import {
  addLeadComment,
  setLeadProductRows,
  updateLead,
} from "../modules/crm/leads/updateLeadService.js";

const TOKENS_FILE = "./data/portals.updateLeadService.test.json";
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

test("updateLeadService: updateLead returns null for missing portal/leadId/fields", async () => {
  assert.equal(await updateLead("missing.bitrix24.ru", 1, { A: 1 }), null);

  const domain = "update-lead-empty.bitrix24.ru";
  seedPortal(domain);

  assert.equal(await updateLead(domain, null, { A: 1 }), null);
  assert.equal(await updateLead(domain, 1001, {}), null);
});

test("updateLeadService: updateLead calls crm.lead.update and returns result", async () => {
  const domain = "update-lead-ok.bitrix24.ru";
  seedPortal(domain);

  let called = false;
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.update") {
      called = true;
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const res = await updateLead(domain, 1002, { STATUS_ID: "PROCESSED" });
  assert.equal(res, true);
  assert.equal(called, true);
});

test("updateLeadService: addLeadComment no-op for empty args and works for valid input", async () => {
  const domain = "update-lead-comment.bitrix24.ru";
  seedPortal(domain);

  let callCount = 0;
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.timeline.comment.add") {
      callCount += 1;
      return { ok: true, status: 200, async json() { return { result: 1 }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  await addLeadComment(domain, null, "x");
  await addLeadComment(domain, 1001, "");
  await addLeadComment(domain, 1001, "Комментарий");
  assert.equal(callCount, 1);
});

test("updateLeadService: setLeadProductRows validates rows and calls API only for valid rows", async () => {
  const domain = "update-lead-rows.bitrix24.ru";
  seedPortal(domain);

  const payloads = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = methodFromUrl(url);
    const params = new URLSearchParams(String(opts.body || ""));
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.productrows.set") {
      payloads.push(Object.fromEntries(params.entries()));
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  assert.equal(await setLeadProductRows(domain, null, [{ PRODUCT_NAME: "A", PRICE: 1 }]), null);
  assert.equal(await setLeadProductRows(domain, 1001, []), null);
  assert.equal(await setLeadProductRows(domain, 1001, [{ PRODUCT_NAME: "", PRICE: "1" }]), null);

  const res = await setLeadProductRows(domain, 1001, [
    { PRODUCT_NAME: "Row A", PRICE: 1200, QUANTITY: 1 },
    { PRODUCT_NAME: "", PRICE: 333, QUANTITY: 1 },
  ]);
  assert.equal(res, true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].id, "1001");
  assert.equal(payloads[0]["rows[0][PRODUCT_NAME]"], "Row A");
});

test("updateLeadService: API errors are handled and return null/void", async () => {
  const domain = "update-lead-errors.bitrix24.ru";
  seedPortal(domain);

  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.update") {
      return { ok: true, status: 200, async json() { return { error: "FAIL", error_description: "lead fail" }; } };
    }
    if (method === "crm.lead.productrows.set") {
      return { ok: true, status: 200, async json() { return { error: "FAIL", error_description: "rows fail" }; } };
    }
    if (method === "crm.timeline.comment.add") {
      return { ok: true, status: 200, async json() { return { error: "FAIL", error_description: "comment fail" }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  assert.equal(await updateLead(domain, 1001, { A: 1 }), null);
  assert.equal(await setLeadProductRows(domain, 1001, [{ PRODUCT_NAME: "A", PRICE: 1 }]), null);
  await addLeadComment(domain, 1001, "x");
  assert.ok(true);
});
