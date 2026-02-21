import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSmallTalkText,
  resolveSmallTalk,
  shouldSkipSmallTalkReply,
} from "../modules/bot/handler/shared/smallTalk.js";
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

test("smallTalk: does not route generic part numbers into CONTACTS", () => {
  const result = resolveSmallTalk(
    "Здравствуйте, хотел бы заказать две детали. Скажите, сколько будут стоить?",
  );
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "PAYMENT");
  assert.equal(result.reply, salesFaqSettings.topics.PAYMENT);
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

test("smallTalk: resolves HOURS for working-hours questions", () => {
  const result = resolveSmallTalk("Подскажите, какой у вас график работы?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "HOURS");
  assert.equal(result.reply, salesFaqSettings.topics.HOURS);
});

test("smallTalk: resolves HOURS for phrase 'как вы работаете'", () => {
  const result = resolveSmallTalk("добрый день, как вы работаете?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "HOURS");
  assert.equal(result.reply, salesFaqSettings.topics.HOURS);
});

test("smallTalk: resolves HOURS for phrase 'до скольки работаете'", () => {
  const result = resolveSmallTalk("до скольки работаете");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "HOURS");
  assert.equal(result.reply, salesFaqSettings.topics.HOURS);
});

test("smallTalk: resolves PAYMENT for settlement question", () => {
  const result = resolveSmallTalk("Здравствуйте, завтра будет проводиться расчет?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "PAYMENT");
});

test("smallTalk: resolves PAYMENT for transfer to card question", () => {
  const result = resolveSmallTalk("Здравствуйте, можно узнать что там с переводом на карту?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "PAYMENT");
});

test("smallTalk: resolves DELIVERY for tracking and shipping timing", () => {
  const result = resolveSmallTalk("Доброе утро! По трек номеру и отправке примерные сроки?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "DELIVERY");
});

test("smallTalk: resolves DELIVERY for how long shipping takes", () => {
  const result = resolveSmallTalk("До Невинномысска сколько будет идти?");
  assert.ok(result);
  assert.equal(result.intent, "HOWTO");
  assert.equal(result.topic, "DELIVERY");
});

test("smallTalk: keeps noisy operational text as NONE", () => {
  const result = resolveSmallTalk(
    "Добрый день, по блоку раздатки заказ 3456, приняли решение? что делаем в итоге?",
  );
  assert.equal(result, null);
});

test("smallTalk: returns null for regular sales text", () => {
  const result = resolveSmallTalk("нужен 06H905110G");
  assert.equal(result, null);
});

test("smallTalk: normalizeSmallTalkText removes punctuation and collapses spaces", () => {
  const value = normalizeSmallTalkText("  Подскажите,   как  созвониться?!  ");
  assert.equal(value, "подскажите как созвониться");
});

test("smallTalk: shouldSkipSmallTalkReply suppresses duplicate in time window", () => {
  const now = Date.now();
  const session = {
    lastSmallTalkIntent: "HOWTO",
    lastSmallTalkTopic: "CONTACTS",
    lastSmallTalkAt: now - 30_000,
    lastSmallTalkTextNormalized: "подскажите как созвониться",
  };

  const skip = shouldSkipSmallTalkReply({
    session,
    rawText: "Подскажите, как созвониться?",
    intent: "HOWTO",
    topic: "CONTACTS",
    now,
    dedupMs: 180_000,
  });

  assert.equal(skip, true);
});

test("smallTalk: shouldSkipSmallTalkReply allows response outside window", () => {
  const now = Date.now();
  const session = {
    lastSmallTalkIntent: "HOWTO",
    lastSmallTalkTopic: "CONTACTS",
    lastSmallTalkAt: now - 181_000,
    lastSmallTalkTextNormalized: "подскажите как созвониться",
  };

  const skip = shouldSkipSmallTalkReply({
    session,
    rawText: "Подскажите, как созвониться?",
    intent: "HOWTO",
    topic: "CONTACTS",
    now,
    dedupMs: 180_000,
  });

  assert.equal(skip, false);
});
