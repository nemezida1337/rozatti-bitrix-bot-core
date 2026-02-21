// src/modules/bot/handler/shared/smallTalk.js

import { salesFaqSettings } from "../../../settings.salesFaq.js";

const OFFTOPIC_REGEX =
  /(погод|новост|политик|курс валют|анекдот|шутк|мем|кто ты|что ты умеешь|как дела|свободное время)/i;
const OPERATIONAL_NOISE_REGEX =
  /(приняли решение|что делаем в итоге|перезакажите|по блоку раздатки)/i;

const QUESTIONISH_REGEX =
  /(\?|подскажите|можно( ли)?|как|где|когда|сколько|скольки|есть ли|есть информация|есть новости|скиньте|пришлите|уточните|сообщите)/i;

const HOWTO_TOPIC_HINT_REGEX =
  /(заказ|оформ|оплат|достав|получ|подобр|возврат|гарант|статус|срок|сроки|цен|стоимост|сумм|денег|расч[её]т|перевод|карт|связ|созвон|телефон|адрес|самовывоз|реквизит|фото|видео|накладн|отправ|трек|идти|прид[её]т|график|время\s*работы|до\s*скольки|часы\s*работы|режим\s*работы|как\s+вы\s+работаете|работаете)/i;

const TOPIC_PATTERNS = [
  {
    topic: "CONTACTS",
    regex:
      /(созвон|связат|позвон|телефон|номер\s+телеф|ваш\s+номер|контакт|whatsapp|ватсап|вацап|wats?app|telegram|тг|tg|менеджер)/i,
  },
  { topic: "ADDRESS", regex: /(адрес|где вы|где находит|склад|щукино|ул\.?\s*рогова)/i },
  {
    topic: "HOURS",
    regex: /(время работы|график|до скольки|до скольки работаете|когда работает|как вы работаете|режим работы|выходн|работаете)/i,
  },
  { topic: "MEDIA", regex: /(фото|видео|сним)/i },
  {
    topic: "PAYMENT",
    regex:
      /(оплат|предоплат|счет|сч[её]т|расч[её]т|карт|перевод|налич|реквизит|задаток|доплат|стоим|стоимост|цена|сумм|денег|сколько\s+.*(стоит|стоить|стоимост|к\s+оплат|денег|сумма))/i,
  },
  {
    topic: "DELIVERY",
    regex:
      /(достав|получ|самовывоз|курьер|пвз|пункт выдач|сд[эе]к|делов(ые)?\s+линии|тк\b|обреш[её]тк|упаковк|страховк|накладн|трек|отправк|сколько\s+.*(идти|прид[её]т)|\bидти\b)/i,
  },
  { topic: "STATUS", regex: /(статус|где заказ|по заказу|номер заказа|есть информация|есть новости|когда будет|когда отправ|отправили|передали|накладн|трек|отслеж)/i },
  { topic: "RETURN", regex: /(возврат|вернут|гарант|брак|обмен)/i },
  { topic: "ORDER", regex: /(заказ|оформ|как купить|как заказат|подобр)/i },
];

function detectHowToTopic(text) {
  for (const item of TOPIC_PATTERNS) {
    if (item.regex.test(text)) return item.topic;
  }
  return null;
}

export function normalizeSmallTalkText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldSkipSmallTalkReply({
  session,
  rawText,
  intent,
  topic,
  now = Date.now(),
  dedupMs = Number(process.env.SMALL_TALK_DEDUP_MS || 180000),
}) {
  if (!session || !rawText || !intent || !Number.isFinite(dedupMs) || dedupMs <= 0) {
    return false;
  }

  const normalized = normalizeSmallTalkText(rawText);
  if (!normalized) return false;

  const lastAt = Number(session.lastSmallTalkAt || 0);
  const withinWindow = lastAt > 0 && now - lastAt <= dedupMs;
  if (!withinWindow) return false;

  return (
    session.lastSmallTalkIntent === intent &&
    String(session.lastSmallTalkTopic || "") === String(topic || "") &&
    session.lastSmallTalkTextNormalized === normalized
  );
}

/**
 * @param {string} text
 * @returns {{intent: "OFFTOPIC"|"HOWTO", topic?: string|null, reply: string}|null}
 */
export function resolveSmallTalk(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  if (OPERATIONAL_NOISE_REGEX.test(raw)) return null;

  if (OFFTOPIC_REGEX.test(raw)) {
    return {
      intent: "OFFTOPIC",
      topic: null,
      reply: salesFaqSettings.offTopicReply,
    };
  }

  if (QUESTIONISH_REGEX.test(raw) && HOWTO_TOPIC_HINT_REGEX.test(raw)) {
    const topic = detectHowToTopic(raw);
    const topicReply =
      topic && salesFaqSettings.topics && salesFaqSettings.topics[topic]
        ? salesFaqSettings.topics[topic]
        : salesFaqSettings.howToDefaultReply;

    return {
      intent: "HOWTO",
      topic,
      reply: topicReply,
    };
  }

  return null;
}

export default { resolveSmallTalk };
