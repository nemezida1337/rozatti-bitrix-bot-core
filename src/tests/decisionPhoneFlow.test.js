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

test("Attachment-only message is treated as COMPLEX (not EMPTY)", () => {
  const ctx = {
    message: { text: "" },
    hasImage: true,
    detectedOems: [],
    lead: { statusId: crmSettings.stageToStatusId.NEW, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.requestType, "COMPLEX");
  assert.equal(decision.shouldCallCortex, false);
  assert.equal(decision.replyType, "MANUAL_ACK");
  assert.equal(decision.shouldReply, true);
});

test("VIN + OEM in one message is treated as OEM (cortex-first mixed handling)", () => {
  const text = "вин WDD2211761A308475, номер A221421201207";
  const detectedOems = detectOemsFromText(text);
  assert.deepEqual(detectedOems, ["A221421201207"]);

  const ctx = {
    message: { text },
    hasImage: false,
    detectedOems,
    lead: { statusId: crmSettings.stageToStatusId.NEW, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.requestType, "OEM");
  assert.equal(decision.mode, "auto");
  assert.equal(decision.shouldCallCortex, true);
  assert.equal(decision.replyType, "AUTO_START");
});

test("VIN keyword without valid VIN code keeps OEM flow in auto mode", () => {
  const text = "Пришлю вин позже, номер 5N0071680B041";
  const detectedOems = detectOemsFromText(text);
  assert.deepEqual(detectedOems, ["5N0071680B041"]);

  const ctx = {
    message: { text },
    hasImage: false,
    detectedOems,
    lead: { statusId: crmSettings.stageToStatusId.NEW, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.requestType, "OEM");
  assert.equal(decision.mode, "auto");
  assert.equal(decision.shouldCallCortex, true);
});

test("VIN keyword without code and without OEM is treated as regular text", () => {
  const text = "Пришлю вин и фото как ответите";
  const detectedOems = detectOemsFromText(text);
  assert.deepEqual(detectedOems, []);

  const ctx = {
    message: { text },
    hasImage: false,
    detectedOems,
    lead: { statusId: crmSettings.stageToStatusId.NEW, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.equal(gateInput.requestType, "TEXT");
  assert.equal(decision.mode, "auto");
  assert.equal(decision.shouldCallCortex, true);
});

test("GUID-like token without VIN keyword is not treated as VIN", () => {
  const text = "Идентификатор 2AE93039AD3-E318-4FC0-8B8F-D2C4F7D56DB2, номер 06L105243AP";
  const detectedOems = detectOemsFromText(text);
  assert.ok(detectedOems.length > 0);

  const ctx = {
    message: { text },
    hasImage: false,
    detectedOems,
    lead: { statusId: crmSettings.stageToStatusId.NEW, oemInLead: null },
    session: { state: { offers: [] }, mode: "auto" },
    manualStatuses: crmSettings.manualStatuses,
  };

  const { gateInput, decision } = buildDecision(ctx);
  assert.notEqual(gateInput.requestType, "VIN");
  assert.equal(decision.shouldCallCortex, true);
});
