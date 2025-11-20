// src/modules/llm/openaiClient.js (v3)
// Строгий JSON, PROMPT v3, защита от ошибок, минимизация токенов,
// согласовано с handler_llm_manager.js (v2) и llmFunnelEngine.js (v2)

import OpenAI from "openai";
import { logger } from "../../core/logger.js";
import "../../core/env.js"; // подхватываем .env

const CTX = "openai";

// Инициализация клиента
const apiKey = process.env.OPENAI_API_KEY || null;
let client = null;

if (!apiKey) {
  logger.warn(CTX, "OPENAI_API_KEY отсутствует — LLM будет отключена.");
} else {
  client = new OpenAI({ apiKey });
}

export const llmAvailable = !!client;

/**
 * ⛔ ВАЖНО:
 * PROMPT v3 уже встроен здесь как системный промт.
 * Он создаёт жесткую схему поведения LLM и строгое JSON-формирование.
 */
const SYSTEM_PROMPT_V3 = `
Ты — умный структурный LLM-двигатель Rozatti, который работает как менеджер автозапчастей.

ТВОЯ ГЛАВНАЯ ЗАДАЧА:
Всегда возвращать СТРОГИЙ JSON в одном объекте, без текста вне JSON.

ФОРМАТ JSON:

{
  "action": "reply | abcp_lookup | ask_name | ask_phone | confirm_order | smalltalk",
  "reply": "текст ответа клиенту",
  "stage": "NEW | QUALIFY | PRICING | WAITING_CUSTOMER | WON | LOST",
  "oems": [],
  "need_operator": false,
  "update_lead_fields": { "NAME": null, "PHONE": null },
  "client_name": null
}

ПРАВИЛА:
- Не используй информацию вне контекста.
- Не придумывай модели авто, годы, двигатели, VIN.
- По OEM используй ТОЛЬКО то, что передано в abcp_data.
- На "подробнее" и "в чем разница" — делай краткое сравнение.
- На "как заказать" — сначала уточняй номер детали, количество, вариант.
- Перед вопросом имени — делай резюме заказа.
- Если данных недостаточно — уточняй.
- SMALLTALK/анекдоты — только по явному запросу.
- НЕ повторяй длинные ответы.
- ВСЕГДА строго соблюдай JSON-формат и поля.

ЕСЛИ действие = "abcp_lookup":
— верни массив "oems": ["A2810182500", ...].

ЕСЛИ действие = "reply":
— просто ответ пользователю.

ЕСЛИ действие = "ask_name":
— задай вопрос имени.

ЕСЛИ действие = "ask_phone":
— попроси телефон.

ЕСЛИ действие = "confirm_order":
— оформи результат, но не спрашивай контакты пока не подтверждено.

ЕСЛИ действие = "smalltalk":
— короткий анекдот и возвращение к теме диалога.

НЕ ПИШИ никакого текста вне JSON.
Только один JSON-объект в ответ.
`;

/**
 * Главная функция, которую вызывает LLM-пайплайн.
 *
 * @param { history: [{role, content}], model? }
 */
export async function generateStructuredFunnelReply({ history, model }) {
  if (!client) {
    return {
      action: "reply",
      reply: "Сейчас техническая пауза. Передам информацию менеджеру.",
      stage: "NEW",
      need_operator: true,
      update_lead_fields: {},
      client_name: null,
      oems: [],
    };
  }

  const usedModel =
    model ||
    process.env.LLM_MODEL_STRUCTURED ||
    process.env.LLM_MODEL ||
    "gpt-4o-mini";

  // Сообщения LLM
  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT_V3,
    },
    ...history, // уже отформатировано в llmFunnelEngine.js
  ];

  logger.debug(CTX, "LLM request", {
    model: usedModel,
    messagesCount: messages.length,
  });

  let raw = "{}";

  try {
    const completion = await client.chat.completions.create({
      model: usedModel,
      messages,
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    raw = completion?.choices?.[0]?.message?.content || "{}";
  } catch (err) {
    logger.error(CTX, "Ошибка исполнения LLM", err);
    return fallbackResponse();
  }

  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(CTX, "Ошибка JSON.parse", { raw });
    return fallbackResponse();
  }

  return normalize(parsed);
}

/**
 * Нормализация ответа LLM
 */
function normalize(r) {
  return {
    action: r.action || "reply",
    reply: r.reply || "",
    stage: r.stage || "NEW",
    need_operator: !!r.need_operator,
    update_lead_fields: r.update_lead_fields || {},
    client_name: r.client_name || null,
    oems: Array.isArray(r.oems) ? r.oems : [],
  };
}

/**
 * Fallback на случай полного краша LLM
 */
function fallbackResponse() {
  return {
    action: "reply",
    reply: "Что-то пошло не так. Я уже восстанавливаюсь.",
    stage: "NEW",
    need_operator: false,
    update_lead_fields: {},
    client_name: null,
    oems: [],
  };
}
