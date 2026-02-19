import assert from "node:assert/strict";
import test from "node:test";

import { crmSettings } from "../config/settings.crm.js";
import { convertLeadToDealAfterAbcpOrder } from "../modules/crm/leads/convertLeadToDealService.js";

function makeLeadMock() {
  return {
    ID: 321,
    TITLE: "Тестовый лид",
    ASSIGNED_BY_ID: 202,
    CONTACT_ID: 21796,
    SOURCE_ID: "6|I2CRM",
    SOURCE_DESCRIPTION: "https://example.test/source",
    STATUS_ID: "UC_T710VD",
  };
}

test("convertLeadToDealService: writes ABCP order number into deal on native convert path", async () => {
  const orderFieldCode = crmSettings?.dealFields?.ORDER_NUMBER;
  assert.ok(orderFieldCode);

  const calls = [];
  const api = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "crm.lead.get") return makeLeadMock();
      if (method === "crm.lead.convert") return { result: { DEAL_ID: 55501 } };
      if (method === "crm.deal.update") return { result: true };
      if (method === "crm.timeline.comment.add") return { result: true };
      return { result: true };
    },
  };

  const result = await convertLeadToDealAfterAbcpOrder({
    portal: "audit-convert.bitrix24.ru",
    leadId: 321,
    orderNumbers: ["4637"],
    dialogId: "chat-123",
    api,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dealId, 55501);

  const dealUpdate = calls.find((x) => x.method === "crm.deal.update");
  assert.ok(dealUpdate, "crm.deal.update should be called after successful conversion");
  assert.equal(dealUpdate.params?.id, 55501);
  assert.equal(dealUpdate.params?.fields?.ORIGIN_ID, "4637");
  assert.equal(String(dealUpdate.params?.fields?.[orderFieldCode]), "4637");
  assert.equal(String(dealUpdate.params?.fields?.TITLE || ""), "4637");
});

test("convertLeadToDealService: writes ABCP order number into deal on fallback path", async () => {
  const orderFieldCode = crmSettings?.dealFields?.ORDER_NUMBER;
  assert.ok(orderFieldCode);

  const calls = [];
  const api = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "crm.lead.get") return makeLeadMock();
      if (method === "crm.lead.convert") throw new Error("convert failed");
      if (method === "crm.deal.add") return { result: 55577 };
      if (method === "crm.lead.update") return { result: true };
      if (method === "crm.timeline.comment.add") return { result: true };
      return { result: true };
    },
  };

  const result = await convertLeadToDealAfterAbcpOrder({
    portal: "audit-convert-fallback.bitrix24.ru",
    leadId: 321,
    orderNumbers: ["4638"],
    dialogId: "chat-456",
    api,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dealId, 55577);

  const dealAdd = calls.find((x) => x.method === "crm.deal.add");
  assert.ok(dealAdd, "crm.deal.add should be called on fallback path");
  assert.equal(dealAdd.params?.fields?.ORIGIN_ID, "4638");
  assert.equal(String(dealAdd.params?.fields?.[orderFieldCode]), "4638");
  assert.equal(String(dealAdd.params?.fields?.TITLE || ""), "4638");
  assert.equal(dealAdd.params?.fields?.LEAD_ID, 321);

  const dealUpdate = calls.find((x) => x.method === "crm.deal.update");
  assert.ok(dealUpdate, "crm.deal.update should be called on fallback path too");
  assert.equal(dealUpdate.params?.id, 55577);
  assert.equal(dealUpdate.params?.fields?.LEAD_ID, 321);
});

test("convertLeadToDealService: prevents duplicate deal on fallback when deal already exists", async () => {
  const calls = [];
  const api = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "crm.lead.get") return makeLeadMock();
      if (method === "crm.lead.convert") throw new Error("convert failed");
      if (method === "crm.deal.list") return { result: [{ ID: 55666, LEAD_ID: 321 }] };
      if (method === "crm.deal.update") return { result: true };
      if (method === "crm.lead.update") return { result: true };
      if (method === "crm.timeline.comment.add") return { result: true };
      return { result: true };
    },
  };

  const result = await convertLeadToDealAfterAbcpOrder({
    portal: "audit-convert-dedup.bitrix24.ru",
    leadId: 321,
    orderNumbers: ["4638"],
    dialogId: "chat-999",
    api,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "DEAL_ALREADY_EXISTS");
  assert.equal(result.dealId, 55666);

  const dealAdd = calls.find((x) => x.method === "crm.deal.add");
  assert.equal(dealAdd, undefined, "crm.deal.add must not be called when duplicate exists");

  const dealUpdate = calls.find((x) => x.method === "crm.deal.update");
  assert.ok(dealUpdate, "existing deal should still be updated with binding fields");
  assert.equal(dealUpdate.params?.id, 55666);
});
