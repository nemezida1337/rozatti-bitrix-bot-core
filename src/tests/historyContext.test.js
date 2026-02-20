import assert from "node:assert/strict";
import test from "node:test";

import {
  appendSessionHistoryTurn,
  buildRepeatFollowupReply,
  detectRepeatFollowup,
  inferMessageAuthorRole,
  normalizeHistoryText,
} from "../modules/bot/handler/shared/historyContext.js";

test("historyContext: inferMessageAuthorRole detects connector client", () => {
  const role = inferMessageAuthorRole({
    chatEntityType: "LINES",
    userFlags: { isConnector: "Y", isBot: "N" },
    isSystemLike: false,
  });
  assert.equal(role, "client");
});

test("historyContext: normalizeHistoryText normalizes punctuation/spaces", () => {
  const value = normalizeHistoryText("  Ну  что,  по   заказу?! ");
  assert.equal(value, "ну что по заказу");
});

test("historyContext: appendSessionHistoryTurn deduplicates same turn", () => {
  const session = { history: [] };

  const first = appendSessionHistoryTurn(session, {
    role: "client",
    text: "Ну что по заказу?",
    messageId: "1",
    ts: 1000,
  });
  const duplicate = appendSessionHistoryTurn(session, {
    role: "client",
    text: "Ну что по заказу?",
    messageId: "1",
    ts: 1001,
  });

  assert.equal(first, true);
  assert.equal(duplicate, false);
  assert.equal(session.history.length, 1);
});

test("historyContext: appendSessionHistoryTurn respects SESSION_HISTORY_MAX_TURNS", () => {
  const prev = process.env.SESSION_HISTORY_MAX_TURNS;
  process.env.SESSION_HISTORY_MAX_TURNS = "3";

  const session = { history: [] };
  try {
    appendSessionHistoryTurn(session, { role: "client", text: "1", messageId: "1", ts: 1 });
    appendSessionHistoryTurn(session, { role: "bot", text: "2", messageId: "2", ts: 2 });
    appendSessionHistoryTurn(session, { role: "client", text: "3", messageId: "3", ts: 3 });
    appendSessionHistoryTurn(session, { role: "bot", text: "4", messageId: "4", ts: 4 });
    assert.equal(session.history.length, 3);
    assert.equal(session.history[0].text, "2");
  } finally {
    if (prev == null) delete process.env.SESSION_HISTORY_MAX_TURNS;
    else process.env.SESSION_HISTORY_MAX_TURNS = prev;
  }
});

test("historyContext: detectRepeatFollowup finds repeat by previous context", () => {
  const now = Date.now();
  const session = { history: [] };
  appendSessionHistoryTurn(session, {
    role: "client",
    text: "нужен 06H905110G",
    messageId: "10",
    ts: now - 120_000,
  });
  appendSessionHistoryTurn(session, {
    role: "bot",
    text: "Принял запрос, уже в работе.",
    messageId: null,
    ts: now - 110_000,
  });

  const repeat = detectRepeatFollowup({
    session,
    text: "ну что там, есть новости?",
    authorRole: "client",
    hasImage: false,
    detectedOems: [],
    now,
  });

  assert.ok(repeat);
  assert.equal(repeat.promptType, "FOLLOWUP_PING");
  assert.equal(repeat.previous_bot_service_ack, true);
});

test("historyContext: buildRepeatFollowupReply returns in-progress wording", () => {
  const text = buildRepeatFollowupReply({
    session: { state: { stage: "IN_WORK" } },
    followup: { promptType: "STATUS_CHECK", previous_bot_service_ack: true },
  });
  assert.match(text, /в работе/i);
  assert.match(text, /статус/i);
});

test("historyContext: VIN keyword without code does not suppress followup detection", () => {
  const now = Date.now();
  const session = { history: [] };
  appendSessionHistoryTurn(session, {
    role: "client",
    text: "Нужен номер 06H905110G",
    messageId: "20",
    ts: now - 120_000,
  });
  appendSessionHistoryTurn(session, {
    role: "bot",
    text: "Принял запрос, уже в работе.",
    messageId: null,
    ts: now - 110_000,
  });

  const repeat = detectRepeatFollowup({
    session,
    text: "Подскажите, вин позже скину",
    authorRole: "client",
    hasImage: false,
    detectedOems: [],
    now,
  });

  assert.ok(repeat);
  assert.equal(repeat.promptType, "FOLLOWUP_PING");
});
