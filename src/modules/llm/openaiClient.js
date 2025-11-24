//
// Единая обёртка для работы с LLM в Rozatti Bot Core.
// Задачи:
//  - задать строгий контракт ответа (LLMFunnelResponse)
//  - вызывать модель с историей диалога
//  - безопасно парсить JSON
//  - нормализовать/валидировать action, stage, oems, update_lead_fields
//
// Экспорт:
//  - LLM_ACTIONS
//  - LLM_STAGES
//  - normalizeLLMResponse
//  - validateLLMFunnelResponse
//  - generateStructuredFunnelReply({ history })

import OpenAI from "openai";
import { logger } from "../../core/logger.js";

const CTX = "llm/openaiClient";

const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openai =
  openaiApiKey && new OpenAI({ apiKey: openaiApiKey });

/**
 * Возможные действия LLM.
 * Важно: они используются во всём проекте.
 */
export const LLM_ACTIONS = {
  REPLY: "reply",
  ABCP_LOOKUP: "abcp_lookup",
  ASK_NAME: "ask_name",
  ASK_PHONE: "ask_phone",
  HANDOVER_OPERATOR: "handover_operator",
};

/**
 * Стадии воронки.
 * Мапятся на STATUS_ID в settings.crm.js.
 */
export const LLM_STAGES = {
  NEW: "NEW",
  PRICING: "PRICING",
  CONTACT: "CONTACT",
  FINAL: "FINAL",
};

/**
 * Строгий контракт ответа LLM.
 *
 * @typedef {Object} LLMFunnelResponse
 * @property {string} action            - одно из LLM_ACTIONS
 * @property {string} reply             - текст ответа клиенту
 * @property {string} stage             - одно из LLM_STAGES
 * @property {boolean} need_operator    - нужно ли подключить оператора
 * @property {Object<string, any>} update_lead_fields - словарь полей лида для Bitrix24
 * @property {string|null} client_name  - полное имя клиента (ФИО)
 * @property {string[]} oems            - массив OEM-кодов (в верхнем регистре)
 * @property {Array<Object>} [product_rows]  - готовые product rows Bitrix24
 * @property {Array<Object>} [product_picks] - picks по ABCP (сырой выбор для маппинга в product rows)
 */

/**
 * SYSTEM prompt для модели: описывает формат и поведение.
 * ВАЖНО: ответ ВСЕГДА должен быть в виде одного JSON-объекта без лишнего текста.
 */
const SYSTEM_PROMPT = `
Ты — структурный LLM-двигатель для бота Rozatti (автозапчасти, Bitrix24, ABCP).

ОБЩИЕ ПРАВИЛА:
- Отвечай строго ОДНИМ JSON-объектом без всякого текста вокруг.
- Никаких комментариев, пояснений, Markdown и текста вне JSON.
- Все строки в JSON — в кавычках.
- Не используй undefined, функции, даты, только обычные JSON-типы.

ФОРМАТ ОТВЕТА (JSON-ОБЪЕКТ):

{
  "action": "reply" | "abcp_lookup" | "ask_name" | "ask_phone" | "handover_operator",
  "stage": "NEW" | "PRICING" | "CONTACT" | "FINAL",
  "reply": "строка для клиента",
  "need_operator": false,
  "update_lead_fields": {
    // любые поля лида Bitrix24:
    // "NAME": "ФИО клиента (как в одном поле)",
    // "PHONE": "+7...",
    // "ADDRESS": "адрес или ПВЗ",
    // "COMMENTS": "комментарий для менеджера"
    // плюс UF_CRM_* при необходимости
  },
  "client_name": "полное ФИО клиента или null",
  "oems": ["OEM1", "OEM2"],

  // опционально (на будущее, использовать только когда уверена):
  "product_rows": [
    {
      "PRODUCT_NAME": "Название позиции",
      "PRICE": 12345.67,
      "QUANTITY": 1,
      "CURRENCY_ID": "RUB"
    }
  ],
  "product_picks": [
    {
      "idx": 0,
      "qty": 1,
      "item": {
        "oem": "A0000000000",
        "brand": "MB",
        "name": "Название детали",
        "priceNum": 12345.67,
        "daysText": "до 7 раб.дн."
      }
    }
  ]
}

ОСОБЕННОСТИ:
- action="abcp_lookup" — когда нужно обратиться к ABCP по массиву OEM:
  - В этом случае нужно вернуть поле "oems": ["11121717432", "4N0907998"].
  - reply можно заполнить небольшой фразой или оставить пустым.
- action="ask_name" — бот просит клиента указать ФИО и способ получения (самовывоз/доставка).
- action="ask_phone" — бот просит только телефон.
- action="reply" — обычный ответ (по умолчанию).
- action="handover_operator" — только если запрос принципиально не может обработать бот.

СТАДИИ:
- stage="NEW"      — приветствие, первичный сбор данных.
- stage="PRICING"  — подбираем цены/сроки (ABCP).
- stage="CONTACT"  — собираем ФИО/телефон/адрес.
- stage="FINAL"    — все данные собраны, заказ готов к передаче менеджеру.
`;

/**
 * Сервисная функция: попытаться вынуть JSON-объект из текста.
 * LLM иногда может обернуть его в ```json ... ``` или лишний текст.
 */
function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();

  // Если строка и так начинается с { — пробуем парсить сразу.
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      // падаем ниже к более грубому поиску
    }
  }

  // Попробуем найти первый блок {...}
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = trimmed.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch (e) {
    return null;
  }
}

/**
 * Нормализация action.
 */
function sanitizeAction(raw) {
  const allowed = new Set(Object.values(LLM_ACTIONS));
  if (typeof raw === "string" && allowed.has(raw)) {
    return raw;
  }
  return LLM_ACTIONS.REPLY;
}

/**
 * Нормализация stage.
 */
function sanitizeStage(raw) {
  const allowed = new Set(Object.values(LLM_STAGES));
  if (typeof raw === "string" && allowed.has(raw)) {
    return raw;
  }
  return LLM_STAGES.NEW;
}

/**
 * Нормализация массива OEM.
 *  - только строки
 *  - trim + toUpperCase
 *  - фильтр по длине
 *  - уникальность
 */
function normalizeOems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];

  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim().toUpperCase();
    if (!t) continue;
    if (t.length < 3 || t.length > 40) continue;
    out.push(t);
  }

  return Array.from(new Set(out));
}

/**
 * Нормализация update_lead_fields: только "обычный" объект, без массивов/null.
 */
function normalizeUpdateLeadFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Нормализация product_rows / product_picks:
 *  - только массив объектов (без массивов внутри)
 */
function normalizeObjectArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v) => v && typeof v === "object" && !Array.isArray(v),
  );
}

/**
 * Нормализация строки ответа.
 */
function normalizeReply(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * Нормализация булевого флага (need_operator и подобное).
 * Принимаем true/false, 1/0, "true"/"false", "yes"/"no".
 * Всё остальное приводим к false для безопасности.
 */
function normalizeBool(raw) {
  if (raw === true || raw === "true" || raw === "yes" || raw === 1 || raw === "1") {
    return true;
  }
  if (raw === false || raw === "false" || raw === "no" || raw === 0 || raw === "0") {
    return false;
  }
  return false;
}

/**
 * Приведение произвольного объекта r к LLMFunnelResponse.
 *
 * @param {any} r
 * @returns {LLMFunnelResponse}
 */
export function normalizeLLMResponse(r) {
  if (!r || typeof r !== "object") {
    return {
      action: LLM_ACTIONS.REPLY,
      reply: "Сорри, сейчас временная ошибка. Уже восстанавливаюсь.",
      stage: LLM_STAGES.NEW,
      need_operator: false,
      update_lead_fields: {},
      client_name: null,
      oems: [],
      product_rows: [],
      product_picks: [],
    };
  }

  // Поддержка старого формата (если когда-то использовали r.response)
  if (!r.action && !r.reply && r.response && typeof r.response === "object") {
    const lines = [];

    for (const [oem, val] of Object.entries(r.response)) {
      if (typeof val === "string") {
        lines.push(`${oem} — ${val}`);
      } else if (val && typeof val === "object") {
        const pr = val.price_range || {};
        const min = pr.min;
        const max = pr.max;
        const currency = pr.currency || "руб.";

        if (typeof min === "number" && typeof max === "number") {
          lines.push(
            `${oem} — цены от ${min.toLocaleString(
              "ru-RU",
            )} до ${max.toLocaleString("ru-RU")} ${currency}`,
          );
        } else {
          lines.push(`${oem} — есть предложения.`);
        }
      } else {
        lines.push(`${oem} — данные не распознаны.`);
      }
    }

    r.reply = lines.join("\n");
    r.action = LLM_ACTIONS.REPLY;
    r.stage = r.stage || LLM_STAGES.PRICING;
    r.need_operator = normalizeBool(r.need_operator);
    r.update_lead_fields = r.update_lead_fields || {};
    r.client_name = r.client_name || null;
    r.oems = Array.isArray(r.oems) ? r.oems : Object.keys(r.response);
  }

  const action = sanitizeAction(r.action);
  const stage = sanitizeStage(r.stage);
  const reply = normalizeReply(r.reply);
  const update_lead_fields = normalizeUpdateLeadFields(r.update_lead_fields);
  const oems = normalizeOems(r.oems);

  const client_name =
    typeof r.client_name === "string" && r.client_name.trim()
      ? r.client_name.trim()
      : null;

  const product_rows = normalizeObjectArray(r.product_rows);
  const product_picks = normalizeObjectArray(r.product_picks);

  return {
    action,
    reply,
    stage,
    need_operator: normalizeBool(r.need_operator),
    update_lead_fields,
    client_name,
    oems,
    product_rows,
    product_picks,
  };
}

/**
 * Лёгкий валидатор контракта LLM.
 * Используется для тестов и при необходимости дополнительной проверки.
 *
 * @param {any} raw
 * @returns {{ ok: boolean, value: LLMFunnelResponse, errors: string[] }}
 */
export function validateLLMFunnelResponse(raw) {
  const errors = [];

  if (!raw || typeof raw !== "object") {
    errors.push("Response is not an object");
  } else {
    if (!raw.action) {
      errors.push("Missing field: action");
    }
    if (!raw.stage) {
      errors.push("Missing field: stage");
    }
    if (!raw.reply) {
      errors.push("Missing field: reply");
    }
  }

  const value = normalizeLLMResponse(raw || {});

  return {
    ok: errors.length === 0,
    value,
    errors,
  };
}

/**
 * Вызов модели с историей сообщений.
 *
 * @param {{ history: Array<{role: "system"|"user"|"assistant", content: string}> }} param0
 * @returns {Promise<LLMFunnelResponse>}
 */
export async function generateStructuredFunnelReply({ history }) {
  const ctx = `${CTX}.generateStructuredFunnelReply`;

  if (!openai) {
    logger.warn({ ctx }, "OPENAI_API_KEY не задан, используем fallback-ответ");
    return {
      action: LLM_ACTIONS.REPLY,
      reply:
        "Извините, сейчас модуль LLM временно недоступен. Менеджер скоро подключится.",
      stage: LLM_STAGES.NEW,
      need_operator: true,
      update_lead_fields: {},
      client_name: null,
      oems: [],
      product_rows: [],
      product_picks: [],
    };
  }

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...(history || []),
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages,
      temperature: 0.2,
      max_tokens: 512,
    });

    const content =
      completion.choices?.[0]?.message?.content || "";

    const parsed = extractJsonObject(content);

    if (!parsed) {
      logger.warn(
        { ctx, content },
        "Не удалось распарсить JSON от LLM, используем fallback",
      );
      return {
        action: LLM_ACTIONS.REPLY,
        reply:
          "Сорри, сейчас временная ошибка. Уже восстанавливаюсь.",
        stage: LLM_STAGES.NEW,
        need_operator: false,
        update_lead_fields: {},
        client_name: null,
        oems: [],
        product_rows: [],
        product_picks: [],
      };
    }

    const normalized = normalizeLLMResponse(parsed);

    logger.debug(
      { ctx, normalized },
      "LLM ответ успешно нормализован",
    );

    return normalized;
  } catch (err) {
    logger.error(
      { ctx, error: err?.message, stack: err?.stack },
      "Ошибка при вызове LLM",
    );
    return {
      action: LLM_ACTIONS.REPLY,
      reply:
        "Сорри, сейчас временная ошибка. Уже восстанавливаюсь.",
      stage: LLM_STAGES.NEW,
      need_operator: false,
      update_lead_fields: {},
      client_name: null,
      oems: [],
      product_rows: [],
      product_picks: [],
    };
  }
}
