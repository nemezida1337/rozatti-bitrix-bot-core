import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { crmSettings } from "../config/settings.crm.js";
import { upsertPortal } from "../core/store.js";
import { safeUpdateLeadAndContact } from "../modules/crm/leads.js";

function parseFormBody(raw) {
  const params = new URLSearchParams(raw || "");
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function startFakeBitrix() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const methodMatch = String(req.url || "").match(/\/rest\/(.+)\.json/);
      const method = methodMatch ? methodMatch[1] : "unknown";
      const form = parseFormBody(body);

      calls.push({ method, form });

      let payload = { result: true };
      if (method === "crm.lead.get") payload = { result: {} };
      if (method === "crm.contact.list") payload = { result: [] };
      if (method === "crm.contact.add") payload = { result: 9001 };

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

test("safeUpdateLeadAndContact: multi OEM without choice does not write UF_OEM", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-multi-oem.bitrix24.ru";
  const oemField = crmSettings.leadFields.OEM;

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-1",
    refreshToken: "refresh-1",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2001",
      chatId: "2001",
      session: { leadId: 1001, state: { stage: "NEW" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: ["OEM_A_123", "OEM_B_456"],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      lastUserMessage: "нужен OEM",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      Object.prototype.hasOwnProperty.call(leadUpdate.form, `fields[${oemField}]`),
      false,
      "UF_OEM must not be written for multi OEM without choice",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: DELIVERY_ADDRESS is not written on CONTACT stage", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-delivery-contact.bitrix24.ru";
  const deliveryField = crmSettings.leadFields.DELIVERY_ADDRESS;

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-2",
    refreshToken: "refresh-2",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2002",
      chatId: "2002",
      session: { leadId: 1002, state: { stage: "NEW" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {
          DELIVERY_ADDRESS: "Москва, Тверская 1",
        },
      },
      lastUserMessage: "адрес",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        leadUpdate.form,
        `fields[${deliveryField}]`,
      ),
      false,
      "Delivery address must not be written on CONTACT stage",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: DELIVERY_ADDRESS is written on ADDRESS stage", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-delivery-address.bitrix24.ru";
  const deliveryField = crmSettings.leadFields.DELIVERY_ADDRESS;
  const deliveryValue = "СПб, Невский 10";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-3",
    refreshToken: "refresh-3",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2003",
      chatId: "2003",
      session: { leadId: 1003, state: { stage: "NEW" } },
      llm: {
        stage: "ADDRESS",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {
          DELIVERY_ADDRESS: deliveryValue,
        },
      },
      lastUserMessage: "мой адрес",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      leadUpdate.form[`fields[${deliveryField}]`],
      deliveryValue,
      "Delivery address must be written on ADDRESS stage",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: writes UF_OEM when chosen_offer_id points to offer OEM", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-chosen-oem.bitrix24.ru";
  const oemField = crmSettings.leadFields.OEM;
  const chosenOem = "OEM-CHOSEN-777";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-4",
    refreshToken: "refresh-4",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2004",
      chatId: "2004",
      session: { leadId: 1004, state: { stage: "PRICING" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: ["AAA111", "BBB222"],
        offers: [
          { id: 1, oem: "AAA111", price: 1000, brand: "B1" },
          { id: 2, oem: chosenOem, price: 1200, brand: "B2" },
        ],
        chosen_offer_id: 2,
        update_lead_fields: {},
      },
      lastUserMessage: "беру второй",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      leadUpdate.form[`fields[${oemField}]`],
      chosenOem,
      "UF_OEM must be taken from chosen offer OEM",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: FINAL stage sets product rows from offers", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-final-rows.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-5",
    refreshToken: "refresh-5",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2005",
      chatId: "2005",
      session: { leadId: 1005, state: { stage: "PRICING" } },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: ["OEMX1"],
        offers: [
          { id: 1, oem: "OEMX1", price: 4567, brand: "BMW", quantity: 2 },
        ],
        chosen_offer_id: 1,
        update_lead_fields: {},
      },
      lastUserMessage: "оформляем",
      usedBackend: "HF_CORTEX",
    });

    const rowsSet = fake.calls.find((c) => c.method === "crm.lead.productrows.set");
    assert.ok(rowsSet, "crm.lead.productrows.set must be called on FINAL stage");
    assert.equal(rowsSet.form["rows[0][PRODUCT_NAME]"], "BMW OEMX1");
    assert.equal(rowsSet.form["rows[0][PRICE]"], "4567");
    assert.equal(rowsSet.form["rows[0][QUANTITY]"], "2");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: FINAL + contact_update triggers contact creation/bind", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-final-contact.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-6",
    refreshToken: "refresh-6",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2006",
      chatId: "2006",
      session: { leadId: 1006, state: { stage: "CONTACT" } },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        contact_update: {
          name: "Ivan",
          last_name: "Petrov",
          second_name: "S",
          phone: "+7 (999) 111-22-33",
        },
        update_lead_fields: {},
      },
      lastUserMessage: "мои данные",
      usedBackend: "HF_CORTEX",
    });

    const addContact = fake.calls.find((c) => c.method === "crm.contact.add");
    assert.ok(addContact, "crm.contact.add must be called on FINAL with contact_update");
    assert.equal(addContact.form["fields[NAME]"], "Ivan");
    assert.equal(addContact.form["fields[LAST_NAME]"], "Petrov");
    assert.equal(addContact.form["fields[PHONE][0][VALUE]"], "79991112233");

    const bindLeadCalls = fake.calls.filter((c) => c.method === "crm.lead.update");
    const hasContactBind = bindLeadCalls.some((c) => c.form["fields[CONTACT_ID]"] === "9001");
    assert.equal(hasContactBind, true);
  } finally {
    await fake.close();
  }
});
