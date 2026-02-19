import assert from "node:assert/strict";
import test from "node:test";

import { resolveSmallTalk } from "../modules/bot/handler/shared/smallTalk.js";
import { salesFaqSettings } from "../modules/settings.salesFaq.js";

test("smallTalk: resolves OFFTOPIC and redirects to VIN/OEM flow", () => {
  const result = resolveSmallTalk("какая сегодня погода?");
  assert.ok(result);
  assert.equal(result.intent, "OFFTOPIC");
  assert.equal(result.reply, salesFaqSettings.offTopicReply);
});

test("smallTalk: resolves HOWTO for process questions", () => {
  const result = resolveSmallTalk("как оформить заказ и доставку?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "DELIVERY");
  assert.equal(result.reply, salesFaqSettings.topics.DELIVERY);
});

test("smallTalk: resolves HOWTO payment topic via config", () => {
  const result = resolveSmallTalk("как оплатить заказ?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "PAYMENT");
  assert.equal(result.reply, salesFaqSettings.topics.PAYMENT);
});

test("smallTalk: returns null for regular sales text", () => {
  const result = resolveSmallTalk("нужен 06H905110G");
  assert.equal(result, null);
});
