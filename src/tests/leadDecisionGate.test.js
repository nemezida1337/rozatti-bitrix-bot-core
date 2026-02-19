import assert from "node:assert/strict";
import test from "node:test";

import { leadDecisionGate } from "../modules/bot/leadDecisionGate.js";

test("leadDecisionGate: system author returns passive decision", () => {
  const d = leadDecisionGate({
    authorType: "system",
    requestType: "TEXT",
    sessionMode: "auto",
  });

  assert.equal(d.waitReason, "SYSTEM");
  assert.equal(d.shouldReply, false);
  assert.equal(d.shouldCallCortex, false);
});

test("leadDecisionGate: manual lock without OEM in lead waits silently", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "OEM",
    detectedOems: ["AAA111"],
    leadStatusId: "UC_ZA04R1",
    manualStatuses: ["UC_ZA04R1", "UC_UAO7E9"],
    oemInLead: null,
    sessionMode: "auto",
  });

  assert.equal(d.mode, "manual");
  assert.equal(d.waitReason, "WAIT_OEM_MANUAL");
  assert.equal(d.shouldReply, false);
  assert.equal(d.shouldCallCortex, false);
  assert.deepEqual(d.oemCandidates, ["AAA111"]);
});

test("leadDecisionGate: manual lock with OEM in lead switches to auto", () => {
  const d = leadDecisionGate({
    authorType: "manager",
    requestType: "TEXT",
    oemInLead: "OEM-SET",
    sessionMode: "manual",
  });

  assert.equal(d.mode, "auto");
  assert.equal(d.replyType, "AUTO_START");
  assert.equal(d.shouldCallCortex, true);
  assert.equal(d.shouldMoveStage, true);
});

test("leadDecisionGate: empty request in auto mode does nothing", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "EMPTY",
    sessionMode: "auto",
  });

  assert.equal(d.waitReason, "EMPTY");
  assert.equal(d.shouldReply, false);
  assert.equal(d.shouldCallCortex, false);
});

test("leadDecisionGate: VIN/complex without OEM returns one-time manual ack", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "VIN",
    hasImage: false,
    detectedOems: [],
    sessionMode: "auto",
    manualAckSent: false,
  });

  assert.equal(d.mode, "manual");
  assert.equal(d.waitReason, "VIN_WAIT_OEM");
  assert.equal(d.shouldReply, true);
  assert.equal(d.replyType, "MANUAL_ACK");
  assert.equal(d.shouldCallCortex, false);
});

test("leadDecisionGate: repeated manual ack is not sent", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "COMPLEX",
    hasImage: true,
    detectedOems: [],
    sessionMode: "auto",
    manualAckSent: true,
  });

  assert.equal(d.mode, "manual");
  assert.equal(d.shouldReply, false);
  assert.equal(d.replyType, null);
});

test("leadDecisionGate: single OEM in message enables write to lead", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "OEM",
    detectedOems: ["AAA111"],
    oemInLead: null,
    sessionMode: "auto",
  });

  assert.equal(d.mode, "auto");
  assert.equal(d.shouldCallCortex, true);
  assert.equal(d.shouldWriteOemToLead, true);
});

test("leadDecisionGate: multi OEM in message does not write OEM field", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "OEM",
    detectedOems: ["AAA111", "BBB222"],
    oemInLead: null,
    sessionMode: "auto",
  });

  assert.equal(d.shouldCallCortex, true);
  assert.equal(d.shouldWriteOemToLead, false);
});

test("leadDecisionGate: text on pricing without offers is ignored", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "TEXT",
    leadStageKey: "PRICING",
    hasOffers: false,
    sessionMode: "auto",
  });

  assert.equal(d.waitReason, "NO_OEM_TEXT");
  assert.equal(d.shouldCallCortex, false);
});

test("leadDecisionGate: text on pricing with offers calls Cortex", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "TEXT",
    leadStageKey: "PRICING",
    hasOffers: true,
    sessionMode: "auto",
  });

  assert.equal(d.shouldReply, true);
  assert.equal(d.shouldCallCortex, true);
  assert.equal(d.shouldMoveStage, true);
});

test("leadDecisionGate: text on NEW stage calls Cortex", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "TEXT",
    leadStageKey: "NEW",
    hasOffers: false,
    sessionMode: "auto",
  });

  assert.equal(d.shouldReply, true);
  assert.equal(d.shouldCallCortex, true);
  assert.equal(d.shouldMoveStage, true);
});

test("leadDecisionGate: text without stage (null) calls Cortex", () => {
  const d = leadDecisionGate({
    authorType: "client",
    requestType: "TEXT",
    leadStageKey: null,
    hasOffers: false,
    sessionMode: "auto",
  });

  assert.equal(d.shouldReply, true);
  assert.equal(d.shouldCallCortex, true);
  assert.equal(d.shouldMoveStage, true);
});
