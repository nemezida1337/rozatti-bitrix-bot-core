// src/modules/bot/handler/shared/smallTalk.js

import { salesFaqSettings } from "../../../settings.salesFaq.js";

const OFFTOPIC_REGEX =
  /(погод|новост|политик|курс валют|анекдот|шутк|мем|кто ты|что ты умеешь|как дела)/i;

const HOWTO_HINT_REGEX =
  /(как|где|когда).*(заказ|оформ|оплат|достав|получ|подобр|возврат|гарант)/i;

const TOPIC_PATTERNS = [
  { topic: "PAYMENT", regex: /(оплат|предоплат|счет|сч[её]т|карт|перевод|налич)/i },
  { topic: "DELIVERY", regex: /(достав|получ|самовывоз|курьер|пвз|пункт выдач)/i },
  { topic: "RETURN", regex: /(возврат|вернут|гарант|брак|обмен)/i },
  { topic: "STATUS", regex: /(статус|где заказ|когда отправ|трек|отслеж)/i },
  { topic: "ORDER", regex: /(заказ|оформ|как купить|как заказат|подобр)/i },
];

function detectHowToTopic(text) {
  for (const item of TOPIC_PATTERNS) {
    if (item.regex.test(text)) return item.topic;
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{intent: "OFFTOPIC"|"HOWTO", topic?: string|null, reply: string}|null}
 */
export function resolveSmallTalk(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  if (OFFTOPIC_REGEX.test(raw)) {
    return {
      intent: "OFFTOPIC",
      topic: null,
      reply: salesFaqSettings.offTopicReply,
    };
  }

  if (HOWTO_HINT_REGEX.test(raw)) {
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
