import assert from "node:assert/strict";
import test from "node:test";

import { buildDecision } from "../modules/bot/handler/decision.js";
import { crmSettings } from "../modules/settings.crm.js";

function makeCtx({ chatEntityType, isConnector, isBot }) {
  return {
    message: {
      text: "нужен артикул",
      chatEntityType,
      isSystemLike: false,
      userFlags: {
        isConnector,
        isBot,
      },
    },
    hasImage: false,
    detectedOems: [],
    lead: { statusId: crmSettings.stageToStatusId.CONTACT, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };
}

test("decision author type: Open Lines connector is treated as client", () => {
  const { gateInput, decision } = buildDecision(
    makeCtx({ chatEntityType: "LINES", isConnector: "Y", isBot: "N" }),
  );
  assert.equal(gateInput.authorType, "client");
  assert.equal(decision.shouldCallCortex, true);
});

test("decision author type: Open Lines non-connector is treated as manager", () => {
  const { gateInput, decision } = buildDecision(
    makeCtx({ chatEntityType: "LINES", isConnector: "N", isBot: "N" }),
  );
  assert.equal(gateInput.authorType, "manager");
  assert.equal(decision.shouldCallCortex, false);
  assert.equal(decision.mode, "manual");
});

test("decision author type: bot/system message is treated as system", () => {
  const { gateInput, decision } = buildDecision(
    makeCtx({ chatEntityType: "LINES", isConnector: "Y", isBot: "Y" }),
  );
  assert.equal(gateInput.authorType, "system");
  assert.equal(decision.shouldCallCortex, false);
});

test("decision author type: system-like framed text is treated as system", () => {
  const ctx = makeCtx({ chatEntityType: "LINES", isConnector: "Y", isBot: "N" });
  ctx.message.isSystemLike = true;

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.authorType, "system");
  assert.equal(decision.shouldCallCortex, false);
});
