import assert from "node:assert/strict";
import test from "node:test";

import {
  mapCortexResultToLlmResponse,
  processCortexResult,
} from "../modules/bot/handler/shared/cortex.js";

test("cortex shared: mapCortexResultToLlmResponse normalizes chosen_offer_id against offers", () => {
  const cortex = {
    stage: "PRICING",
    result: {
      action: "reply",
      reply: "Выберите вариант",
      offers: [{ id: 1 }, { id: "2" }, { id: "x" }],
      chosen_offer_id: ["2", "999", "bad"],
      need_operator: 0,
      contact_update: "wrong-type",
    },
  };

  const mapped = mapCortexResultToLlmResponse(cortex);

  assert.equal(mapped.stage, "PRICING");
  assert.equal(mapped.reply, "Выберите вариант");
  assert.deepEqual(mapped.offers, [{ id: 1 }, { id: "2" }, { id: "x" }]);
  assert.equal(mapped.chosen_offer_id, 2);
  assert.equal(mapped.need_operator, false);
  assert.equal(mapped.contact_update, null);
});

test("cortex shared: mapCortexResultToLlmResponse supports multiple valid choices", () => {
  const cortex = {
    result: {
      stage: "FINAL",
      offers: [{ id: 1 }, { id: 2 }, { id: 3 }],
      chosen_offer_id: [1, "2", "404"],
      oems: ["AAA111"],
      update_lead_fields: { PHONE: "+79990001122" },
      product_rows: [{ PRODUCT_NAME: "A", PRICE: 1 }],
      product_picks: [{ id: 2 }],
      contact_update: { phone: "+79990001122" },
      need_operator: true,
    },
  };

  const mapped = mapCortexResultToLlmResponse(cortex);

  assert.equal(mapped.stage, "FINAL");
  assert.deepEqual(mapped.chosen_offer_id, [1, 2]);
  assert.deepEqual(mapped.oems, ["AAA111"]);
  assert.deepEqual(mapped.update_lead_fields, { PHONE: "+79990001122" });
  assert.deepEqual(mapped.product_rows, [{ PRODUCT_NAME: "A", PRICE: 1 }]);
  assert.deepEqual(mapped.product_picks, [{ id: 2 }]);
  assert.deepEqual(mapped.contact_update, { phone: "+79990001122" });
  assert.equal(mapped.need_operator, true);
});

test("cortex shared: mapCortexResultToLlmResponse falls back to defaults", () => {
  const mapped = mapCortexResultToLlmResponse({});

  assert.equal(mapped.stage, "NEW");
  assert.equal(mapped.reply, "");
  assert.equal(mapped.action, null);
  assert.deepEqual(mapped.oems, []);
  assert.deepEqual(mapped.offers, []);
  assert.equal(mapped.chosen_offer_id, null);
  assert.deepEqual(mapped.update_lead_fields, {});
  assert.deepEqual(mapped.product_rows, []);
  assert.deepEqual(mapped.product_picks, []);
  assert.equal(mapped.contact_update, null);
});

test("cortex shared: processCortexResult returns mapped response on success", async () => {
  const session = {
    state: { stage: "NEW", offers: [] },
    oem_candidates: [],
  };

  const result = await processCortexResult(
    "audit-cortex-process-ok.bitrix24.ru",
    "chat-cortex-001",
    session,
    {
      result: {
        action: "reply",
        stage: "PRICING",
        reply: "Есть варианты",
        need_operator: false,
      },
    },
  );

  assert.deepEqual(result, {
    reply: "Есть варианты",
    need_operator: false,
    action: "reply",
  });
  assert.equal(session.state.stage, "PRICING");
  assert.equal(session.state.last_reply, "Есть варианты");
});

test("cortex shared: processCortexResult falls back to operator on error", async () => {
  const badCortex = {};
  Object.defineProperty(badCortex, "result", {
    get() {
      throw new Error("broken payload");
    },
  });

  const result = await processCortexResult(
    "audit-cortex-process-fail.bitrix24.ru",
    "chat-cortex-002",
    { state: {} },
    badCortex,
  );

  assert.deepEqual(result, {
    reply: "Произошла ошибка, подключаю менеджера.",
    need_operator: true,
    action: "handover_operator",
  });
});
