import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { crmSettings } from "../config/settings.crm.js";
import { logger } from "../core/logger.js";
import { upsertPortal } from "../core/store.legacy.js";
import { safeUpdateLeadAndContact } from "../modules/crm/leads.js";

process.env.TOKENS_FILE = "./data/portals.safeUpdateLeadAndContact.test.json";

function parseFormBody(raw) {
  const params = new URLSearchParams(raw || "");
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function startFakeBitrix({ resolvePayload } = {}) {
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

      if (typeof resolvePayload === "function") {
        const custom = resolvePayload({ method, form, payload });
        if (custom !== undefined) payload = custom;
      }

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

function parseCortexLogFromLeadUpdate(form) {
  const field = crmSettings.leadFields.HF_CORTEX_LOG;
  const raw = form[`fields[${field}]`];
  return raw ? JSON.parse(raw) : null;
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
      Object.prototype.hasOwnProperty.call(leadUpdate.form, `fields[${deliveryField}]`),
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

test("safeUpdateLeadAndContact: HARD_PICK stage maps to IN_WORK status", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-hard-pick-maps-in-work.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-hard-pick-1",
    refreshToken: "refresh-hard-pick-1",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat-hard-pick-1",
      chatId: "hard-pick-1",
      session: { leadId: 1401, state: { stage: "NEW" } },
      llm: {
        stage: "HARD_PICK",
        action: "handover_operator",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      lastUserMessage: "нужен сложный подбор",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      leadUpdate.form["fields[STATUS_ID]"],
      crmSettings.stageToStatusId.IN_WORK,
      "HARD_PICK must map to IN_WORK status",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: LOST stage maps to JUNK status", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-lost-maps-junk.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-lost-1",
    refreshToken: "refresh-lost-1",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat-lost-1",
      chatId: "lost-1",
      session: { leadId: 1402, state: { stage: "PRICING" } },
      llm: {
        stage: "LOST",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      lastUserMessage: "не актуально",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      leadUpdate.form["fields[STATUS_ID]"],
      crmSettings.stageToStatusId.LOST,
      "LOST must map to JUNK status",
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
        offers: [{ id: 1, oem: "OEMX1", price: 4567, brand: "BMW", quantity: 2 }],
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

test("safeUpdateLeadAndContact: restores lastUserMessage from previous HF_CORTEX_LOG", async () => {
  const previousMessage = "предыдущее сообщение";
  const fake = await startFakeBitrix({
    resolvePayload: ({ method }) => {
      if (method === "crm.lead.get") {
        return {
          result: {
            [crmSettings.leadFields.HF_CORTEX_LOG]: JSON.stringify({
              lastUserMessage: previousMessage,
            }),
          },
        };
      }
      return undefined;
    },
  });
  const domain = "audit-safe-restore-last-msg.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-7",
    refreshToken: "refresh-7",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2007",
      chatId: "2007",
      session: { leadId: 1007, state: { stage: "CONTACT" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    const cortexLog = parseCortexLogFromLeadUpdate(leadUpdate.form);
    assert.equal(cortexLog.lastUserMessage, previousMessage);
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: abcp_lookup writes OEM comment even for multi OEM", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-oem-comment.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-8",
    refreshToken: "refresh-8",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2008",
      chatId: "2008",
      session: { leadId: 1008, state: { stage: "PRICING" } },
      llm: {
        stage: "PRICING",
        action: "abcp_lookup",
        oems: ["AAA111", "BBB222"],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      lastUserMessage: "подобрать",
      usedBackend: "HF_CORTEX",
    });

    const comment = fake.calls.find((c) => c.method === "crm.timeline.comment.add");
    assert.ok(comment, "crm.timeline.comment.add must be called on abcp_lookup");
    assert.equal(comment.form["fields[COMMENT]"], "OEM: AAA111, BBB222");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: invalid PHONE is removed and non-matching chosen_offer_id does not set rows", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-invalid-phone-chosen.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-9",
    refreshToken: "refresh-9",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2009",
      chatId: "2009",
      session: { leadId: 1009, state: { stage: "PRICING" } },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: ["OEM1"],
        offers: [{ id: 1, oem: "OEM1", price: 1234, brand: "BMW", quantity: 1 }],
        chosen_offer_id: 999,
        update_lead_fields: { PHONE: "abc" },
      },
      lastUserMessage: "выбираю",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      Object.keys(leadUpdate.form).some((k) => k.includes("[PHONE]")),
      false,
      "Invalid PHONE must not be sent to crm.lead.update",
    );

    const rowsSet = fake.calls.find((c) => c.method === "crm.lead.productrows.set");
    assert.equal(rowsSet, undefined, "Rows must not be set when chosen_offer_id is not found");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: single OEM fallback writes UF_OEM without chosen offer", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-single-oem-fallback.bitrix24.ru";
  const oemField = crmSettings.leadFields.OEM;

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-10",
    refreshToken: "refresh-10",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2010",
      chatId: "2010",
      session: { leadId: 1010, state: { stage: "NEW" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: ["OEM-SINGLE-1"],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      lastUserMessage: "один OEM",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(leadUpdate.form[`fields[${oemField}]`], "OEM-SINGLE-1");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: multi chosen_offer_id array does not write UF_OEM", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-multi-choice-oem.bitrix24.ru";
  const oemField = crmSettings.leadFields.OEM;

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-11",
    refreshToken: "refresh-11",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2011",
      chatId: "2011",
      session: { leadId: 1011, state: { stage: "PRICING" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: ["OEM-A", "OEM-B"],
        offers: [
          { id: 1, oem: "OEM-A", price: 111, brand: "B1" },
          { id: 2, oem: "OEM-B", price: 222, brand: "B2" },
        ],
        chosen_offer_id: [1, 2],
        update_lead_fields: {},
      },
      lastUserMessage: "два выбора",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      Object.prototype.hasOwnProperty.call(leadUpdate.form, `fields[${oemField}]`),
      false,
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: FINAL uses all offers when chosen_offer_id is absent", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-final-all-offers.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-12",
    refreshToken: "refresh-12",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2012",
      chatId: "2012",
      session: { leadId: 1012, state: { stage: "PRICING" } },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: ["OEM-A1", "OEM-B2"],
        offers: [
          { id: 1, oem: "OEM-A1", price: 1000, brand: "BMW", quantity: 0 },
          { id: 2, oem: "OEM-B2", price: 2000, brand: "Audi", quantity: 3 },
        ],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      lastUserMessage: "все варианты",
      usedBackend: "HF_CORTEX",
    });

    const rowsSet = fake.calls.find((c) => c.method === "crm.lead.productrows.set");
    assert.ok(rowsSet, "crm.lead.productrows.set must be called");
    assert.equal(rowsSet.form["rows[0][PRODUCT_NAME]"], "BMW OEM-A1");
    assert.equal(rowsSet.form["rows[0][QUANTITY]"], "1");
    assert.equal(rowsSet.form["rows[1][PRODUCT_NAME]"], "Audi OEM-B2");
    assert.equal(rowsSet.form["rows[1][QUANTITY]"], "3");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: derives contact from update_lead_fields PHONE and normalizes 10-digit number", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-derive-contact-from-fields.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-13",
    refreshToken: "refresh-13",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2013",
      chatId: "2013",
      session: { leadId: 1013, state: { stage: "CONTACT" } },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {
          NAME: "Petr",
          LAST_NAME: "Ivanov",
          PHONE: "9991112233",
        },
      },
      lastUserMessage: "контакт из полей",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(leadUpdate.form["fields[PHONE][0][VALUE]"], "79991112233");

    const addContact = fake.calls.find((c) => c.method === "crm.contact.add");
    assert.ok(addContact, "crm.contact.add must be called");
    assert.equal(addContact.form["fields[PHONE][0][VALUE]"], "79991112233");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: non-11-digit phone in update_lead_fields is passed as-is digits", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-phone-as-is-digits.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-14",
    refreshToken: "refresh-14",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2014",
      chatId: "2014",
      session: { leadId: 1014, state: { stage: "NEW" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {
          PHONE: "123-45-67",
        },
      },
      lastUserMessage: "короткий телефон",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(leadUpdate.form["fields[PHONE][0][VALUE]"], "1234567");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: skips PHONE when it is derived from OEM-like user message", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-skip-phone-from-oem.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-19",
    refreshToken: "refresh-19",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2019",
      chatId: "2019",
      session: { leadId: 1019, state: { stage: "NEW" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: ["A9602820106"],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {
          PHONE: "9602820106",
        },
      },
      lastUserMessage: "A9602820106",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      Object.keys(leadUpdate.form).some((k) => k.includes("[PHONE]")),
      false,
      "PHONE must be skipped when it matches OEM digits from user message",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: skips DELIVERY_ADDRESS when value is framed service text", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-skip-service-address.bitrix24.ru";
  const deliveryField = crmSettings.leadFields.DELIVERY_ADDRESS;

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-20",
    refreshToken: "refresh-20",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2020",
      chatId: "2020",
      session: { leadId: 1020, state: { stage: "ADDRESS" } },
      llm: {
        stage: "ADDRESS",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {
          DELIVERY_ADDRESS:
            "------------------------------------------------------\n" +
            "Rozatti[18:17:05]\n" +
            "Заказ №4045 ожидает забора\n" +
            "------------------------------------------------------",
        },
      },
      lastUserMessage: "служебное",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must be called");
    assert.equal(
      Object.prototype.hasOwnProperty.call(leadUpdate.form, `fields[${deliveryField}]`),
      false,
      "Service framed text must not be written into DELIVERY_ADDRESS",
    );
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: continues when HF_CORTEX_LOG is invalid JSON", async () => {
  const fake = await startFakeBitrix({
    resolvePayload: ({ method }) => {
      if (method === "crm.lead.get") {
        return {
          result: {
            [crmSettings.leadFields.HF_CORTEX_LOG]: "{bad-json",
          },
        };
      }
      return undefined;
    },
  });
  const domain = "audit-safe-invalid-hf-log.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-15",
    refreshToken: "refresh-15",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2015",
      chatId: "2015",
      session: { leadId: 1015, state: { stage: "CONTACT" } },
      llm: {
        stage: "CONTACT",
        action: "reply",
        oems: [],
        offers: [],
        chosen_offer_id: null,
        update_lead_fields: {},
      },
      usedBackend: "HF_CORTEX",
    });

    const leadUpdate = fake.calls.find((c) => c.method === "crm.lead.update");
    assert.ok(leadUpdate, "crm.lead.update must still be called");
    const cortexLog = parseCortexLogFromLeadUpdate(leadUpdate.form);
    assert.equal(cortexLog.lastUserMessage, null);
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: top-level catch handles malformed llm object", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-top-level-catch.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-16",
    refreshToken: "refresh-16",
  });

  try {
    const sessionWithThrowingState = {
      leadId: 1016,
      get state() {
        throw new Error("state getter boom");
      },
    };

    await assert.doesNotReject(async () => {
      await safeUpdateLeadAndContact({
        portal: domain,
        dialogId: "chat2016",
        chatId: "2016",
        session: sessionWithThrowingState,
        llm: {
          stage: "",
          action: "reply",
          oems: [],
          update_lead_fields: {},
        },
        lastUserMessage: "x",
        usedBackend: "HF_CORTEX",
      });
    });
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: FINAL with chosen_offer_id array uses selected offer for rows", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-final-chosen-array.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-17",
    refreshToken: "refresh-17",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2017",
      chatId: "2017",
      session: { leadId: 1017, state: { stage: "PRICING" } },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: ["OEM-1", "OEM-2"],
        offers: [
          { id: 1, oem: "OEM-1", price: 100, brand: "B1" },
          { id: 2, oem: "OEM-2", price: 200, brand: "B2" },
        ],
        chosen_offer_id: [2],
        update_lead_fields: {},
      },
      lastUserMessage: "выбран второй",
      usedBackend: "HF_CORTEX",
    });

    const rowsSet = fake.calls.find((c) => c.method === "crm.lead.productrows.set");
    assert.ok(rowsSet, "crm.lead.productrows.set must be called");
    assert.equal(rowsSet.form["rows[0][PRODUCT_NAME]"], "B2 OEM-2");
    assert.equal(rowsSet.form["rows[0][PRICE]"], "200");
    assert.equal(rowsSet.form["rows[1][PRODUCT_NAME]"], undefined);
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: keeps SUCCESS status when lead is already converted in session", async () => {
  const fake = await startFakeBitrix();
  const domain = "audit-safe-converted-status-lock.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-21",
    refreshToken: "refresh-21",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2021",
      chatId: "2021",
      session: {
        leadId: 1021,
        state: { stage: "FINAL" },
        lastLeadConversion: {
          ok: true,
          reason: "DEAL_CREATED_BY_FALLBACK",
          dealId: 7001,
        },
      },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: ["OEM-LOCK"],
        offers: [{ id: 1, oem: "OEM-LOCK", price: 1200, brand: "B" }],
        chosen_offer_id: 1,
        update_lead_fields: {
          PHONE: "+79995554433",
          DELIVERY_ADDRESS: "Москва, ул. Тверская, д. 1",
        },
      },
      lastUserMessage: "подтверждаю",
      usedBackend: "HF_CORTEX",
    });

    const leadUpdateCalls = fake.calls.filter((c) => c.method === "crm.lead.update");
    const statusWrite = leadUpdateCalls.find((c) =>
      Object.prototype.hasOwnProperty.call(c.form, "fields[STATUS_ID]"),
    );
    assert.ok(statusWrite, "STATUS_ID must be written");
    assert.equal(statusWrite.form["fields[STATUS_ID]"], crmSettings.stageToStatusId.SUCCESS);
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: syncs converted deal bindings and rows on FINAL", async () => {
  const fake = await startFakeBitrix({
    resolvePayload: ({ method }) => {
      if (method === "crm.lead.get") {
        return { result: { CONTACT_ID: 777 } };
      }
      return undefined;
    },
  });
  const domain = "audit-safe-converted-deal-sync.bitrix24.ru";

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-22",
    refreshToken: "refresh-22",
  });

  try {
    await safeUpdateLeadAndContact({
      portal: domain,
      dialogId: "chat2022",
      chatId: "2022",
      session: {
        leadId: 1022,
        phone: "+79990001122",
        state: { stage: "FINAL" },
        lastLeadConversion: {
          ok: true,
          reason: "DEAL_CREATED_BY_FALLBACK",
          dealId: 7022,
        },
      },
      llm: {
        stage: "FINAL",
        action: "reply",
        oems: ["OEM-7022"],
        offers: [],
        chosen_offer_id: null,
        product_rows: [
          {
            PRODUCT_NAME: "B OEM-7022",
            PRICE: 3210,
            QUANTITY: 1,
          },
        ],
        update_lead_fields: {
          PHONE: "+79990001122",
          DELIVERY_ADDRESS: "Москва, ул. Ленина, д. 10",
        },
      },
      lastUserMessage: "готово",
      usedBackend: "HF_CORTEX",
    });

    const dealRowsSet = fake.calls.find((c) => c.method === "crm.deal.productrows.set");
    assert.ok(dealRowsSet, "crm.deal.productrows.set must be called for converted deal");
    assert.equal(dealRowsSet.form["id"], "7022");
    assert.equal(dealRowsSet.form["rows[0][PRODUCT_NAME]"], "B OEM-7022");

    const dealUpdate = fake.calls.find((c) => c.method === "crm.deal.update");
    assert.ok(dealUpdate, "crm.deal.update must be called for converted deal sync");
    assert.equal(dealUpdate.form["id"], "7022");
    assert.equal(dealUpdate.form["fields[LEAD_ID]"], "1022");
    assert.equal(dealUpdate.form["fields[CONTACT_ID]"], "777");
    assert.equal(dealUpdate.form["fields[OPPORTUNITY]"], "3210");
  } finally {
    await fake.close();
  }
});

test("safeUpdateLeadAndContact: addLeadComment error is caught and logged in local catch", async () => {
  const fake = await startFakeBitrix({
    resolvePayload: ({ method }) => {
      if (method === "crm.timeline.comment.add") {
        return { error: "FAIL", error_description: "timeline fail" };
      }
      return undefined;
    },
  });
  const domain = "audit-safe-comment-catch.bitrix24.ru";
  const originalLoggerError = logger.error;
  let sawSafeLocalCatchLog = false;

  logger.error = (...args) => {
    const msg = args[1];
    if (msg === "Ошибка timeline.comment.add") {
      throw new Error("forced logger error in addLeadComment");
    }
    if (msg === "Ошибка addLeadComment") {
      sawSafeLocalCatchLog = true;
    }
    return originalLoggerError(...args);
  };

  upsertPortal(domain, {
    domain,
    baseUrl: fake.baseUrl,
    accessToken: "token-18",
    refreshToken: "refresh-18",
  });

  try {
    await assert.doesNotReject(async () => {
      await safeUpdateLeadAndContact({
        portal: domain,
        dialogId: "chat2018",
        chatId: "2018",
        session: { leadId: 1018, state: { stage: "PRICING" } },
        llm: {
          stage: "PRICING",
          action: "abcp_lookup",
          oems: ["ERR-OEM"],
          offers: [],
          chosen_offer_id: null,
          update_lead_fields: {},
        },
        lastUserMessage: "проверка комментария",
        usedBackend: "HF_CORTEX",
      });
    });

    assert.equal(
      sawSafeLocalCatchLog,
      true,
      "safeUpdateLeadAndContact local catch for addLeadComment must be hit",
    );
  } finally {
    logger.error = originalLoggerError;
    await fake.close();
  }
});
