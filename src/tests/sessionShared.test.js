import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLlmToSession,
  normalizeOemCandidates,
} from "../modules/bot/handler/shared/session.js";

test("session shared: applyLlmToSession no-op on empty input", () => {
  const session = { state: { stage: "NEW" } };
  applyLlmToSession(null, { stage: "CONTACT" });
  applyLlmToSession(session, null);
  assert.equal(session.state.stage, "NEW");
});

test("session shared: applyLlmToSession maps llm fields into session", () => {
  const session = { state: {} };
  const llm = {
    stage: "ADDRESS",
    client_name: "Ivan",
    update_lead_fields: { DELIVERY_ADDRESS: "  SPB, Nevsky 10  " },
    contact_update: { phone: "+79991234567" },
    oems: ["AAA111", "BBB222"],
    offers: [{ id: 1, price: 1000 }],
    chosen_offer_id: 1,
    reply: "ok",
  };

  applyLlmToSession(session, llm);

  assert.equal(session.state.stage, "ADDRESS");
  assert.equal(session.state.client_name, "Ivan");
  assert.equal(session.state.delivery_address, "SPB, Nevsky 10");
  assert.equal(session.state.DELIVERY_ADDRESS, "SPB, Nevsky 10");
  assert.equal(session.phone, "+79991234567");
  assert.deepEqual(session.state.oems, ["AAA111", "BBB222"]);
  assert.deepEqual(session.state.offers, [{ id: 1, price: 1000 }]);
  assert.equal(session.state.chosen_offer_id, 1);
  assert.equal(session.state.last_reply, "ok");
  assert.equal(typeof session.updatedAt, "number");
});

test("session shared: applyLlmToSession keeps existing oems/offers when llm arrays are empty", () => {
  const session = {
    state: {
      oems: ["KEEP-OEM"],
      offers: [{ id: 9 }],
      chosen_offer_id: 2,
    },
  };
  const llm = {
    oems: [],
    offers: [],
    chosen_offer_id: 0,
    reply: null,
    update_lead_fields: { DELIVERY_ADDRESS: "   " },
  };

  applyLlmToSession(session, llm);

  assert.deepEqual(session.state.oems, ["KEEP-OEM"]);
  assert.deepEqual(session.state.offers, [{ id: 9 }]);
  assert.equal(session.state.chosen_offer_id, 2);
  assert.equal(session.state.last_reply, null);
  assert.equal(session.state.delivery_address, undefined);
});

test("session shared: normalizeOemCandidates trims/deduplicates and drops empty", () => {
  const out = normalizeOemCandidates([
    " AAA111 ",
    "BBB222",
    "",
    null,
    "AAA111",
    "  ",
    12345,
  ]);

  assert.deepEqual(out, ["AAA111", "BBB222", "12345"]);
  assert.deepEqual(normalizeOemCandidates(null), []);
});

