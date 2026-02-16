import assert from "node:assert/strict";
import test from "node:test";

import { buildDecision } from "../modules/bot/handler/decision.js";
import { detectOemsFromText } from "../modules/bot/oemDetector.js";
import { crmSettings } from "../modules/settings.crm.js";

test("Phone message on CONTACT stage is treated as TEXT (not OEM) and allowed to go to Cortex", () => {
  const text = "+79889945791";
  const detectedOems = detectOemsFromText(text);
  assert.deepEqual(detectedOems, []);

  const ctx = {
    message: { text },
    hasImage: false,
    detectedOems,
    lead: { statusId: crmSettings.stageToStatusId.CONTACT, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.requestType, "TEXT");
  assert.equal(gateInput.leadStageKey, "CONTACT");
  assert.equal(decision.shouldCallCortex, true);
});
