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

test("smallTalk: resolves STATUS for order status question from real chats", () => {
  const result = resolveSmallTalk("Добрый день! Подскажите заказ №3592 в каком статусе?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "STATUS");
  assert.equal(result.reply, salesFaqSettings.topics.STATUS);
});

test("smallTalk: resolves CONTACTS for call/contact questions", () => {
  const result = resolveSmallTalk("подскажите пожалуйста, как можно с вами созвониться?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "CONTACTS");
  assert.equal(result.reply, salesFaqSettings.topics.CONTACTS);
});

test("smallTalk: resolves MEDIA for photo/video requests", () => {
  const result = resolveSmallTalk("Можете прислать фото запчасти?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "MEDIA");
  assert.equal(result.reply, salesFaqSettings.topics.MEDIA);
});

test("smallTalk: resolves ADDRESS for pickup/address questions", () => {
  const result = resolveSmallTalk("где вы находитесь? нужен самовывоз");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "ADDRESS");
  assert.equal(result.reply, salesFaqSettings.topics.ADDRESS);
});

test("smallTalk: returns null for regular sales text", () => {
  const result = resolveSmallTalk("нужен 06H905110G");
  assert.equal(result, null);
});
