import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { upsertPortal } from "../core/store.js";
import { ensureContact } from "../modules/crm/contact/contactService.js";

const TOKENS_FILE = "./data/portals.contactService.test.json";
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

test("contactService: returns null when portal is not configured", async () => {
  const contactId = await ensureContact("missing-portal.bitrix24.ru", 1001, {
    NAME: "Ivan",
  });
  assert.equal(contactId, null);
});

test("contactService: updates already bound contact from lead CONTACT_ID", async () => {
  const domain = "contact-service-bound.bitrix24.ru";
  seedPortal(domain);

  const seenMethods = [];
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    seenMethods.push(method);

    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get") {
      return { ok: true, status: 200, async json() { return { result: { CONTACT_ID: "55" } }; } };
    }
    if (method === "crm.contact.update") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const contactId = await ensureContact(domain, 1002, {
    NAME: "Petya",
    PHONE: [{ VALUE: "+79990001122" }],
  });

  assert.equal(contactId, "55");
  assert.equal(seenMethods.includes("crm.contact.list"), false);
  assert.equal(seenMethods.includes("crm.contact.add"), false);
  assert.equal(seenMethods.includes("crm.contact.update"), true);
});

test("contactService: finds contact by phone, updates and binds to lead", async () => {
  const domain = "contact-service-find.bitrix24.ru";
  seedPortal(domain);

  const seenMethods = [];
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    seenMethods.push(method);

    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get") {
      return { ok: true, status: 200, async json() { return { result: { CONTACT_ID: "0" } }; } };
    }
    if (method === "crm.contact.list") {
      return { ok: true, status: 200, async json() { return { result: [{ ID: "88" }] }; } };
    }
    if (method === "crm.contact.update") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    if (method === "crm.lead.update") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const contactId = await ensureContact(domain, 1003, {
    NAME: "Sidor",
    PHONE: [{ VALUE: "+79990001123" }],
  });

  assert.equal(contactId, "88");
  assert.equal(seenMethods.includes("crm.contact.list"), true);
  assert.equal(seenMethods.includes("crm.contact.add"), false);
  assert.equal(seenMethods.includes("crm.lead.update"), true);
});

test("contactService: creates and binds new contact when none exists", async () => {
  const domain = "contact-service-create.bitrix24.ru";
  seedPortal(domain);

  const seenMethods = [];
  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    seenMethods.push(method);

    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get") {
      return { ok: true, status: 200, async json() { return { result: { CONTACT_ID: 0 } }; } };
    }
    if (method === "crm.contact.list") {
      return { ok: true, status: 200, async json() { return { result: [] }; } };
    }
    if (method === "crm.contact.add") {
      return { ok: true, status: 200, async json() { return { result: 101 }; } };
    }
    if (method === "crm.lead.update") {
      return { ok: true, status: 200, async json() { return { result: true }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const contactId = await ensureContact(domain, 1004, {
    NAME: "New",
    PHONE: [{ VALUE: "+79990001124" }],
  });

  assert.equal(contactId, 101);
  assert.equal(seenMethods.includes("crm.contact.add"), true);
  assert.equal(seenMethods.includes("crm.lead.update"), true);
});

test("contactService: returns null when contact is created without id", async () => {
  const domain = "contact-service-create-empty-id.bitrix24.ru";
  seedPortal(domain);

  globalThis.fetch = async (url) => {
    const method = methodFromUrl(url);
    if (method === "profile") {
      return { ok: true, status: 200, async json() { return { result: {} }; } };
    }
    if (method === "crm.lead.get") {
      return { ok: true, status: 200, async json() { return { result: { CONTACT_ID: "0" } }; } };
    }
    if (method === "crm.contact.list") {
      return { ok: true, status: 200, async json() { return { result: [] }; } };
    }
    if (method === "crm.contact.add") {
      return { ok: true, status: 200, async json() { return { result: null }; } };
    }
    return { ok: true, status: 200, async json() { return { result: true }; } };
  };

  const contactId = await ensureContact(domain, 1005, {
    NAME: "No id",
    PHONE: [{ VALUE: "+79990001125" }],
  });

  assert.equal(contactId, null);
});
