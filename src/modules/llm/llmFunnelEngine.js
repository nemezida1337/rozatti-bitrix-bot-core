// src/modules/llm/llmFunnelEngine.js
//
// Оркестратор LLM-воронки:
//  - формирует контекст (историю, состояние сессии, ABCP)
//  - вызывает generateStructuredFunnelReply
//  - возвращает LLMFunnelResponse, уже нормализованный в openaiClient.js
//
// Экспорт:
//  - prepareFunnelContext({ session, msg, injectedABCP? })
//  - runFunnelLLM(context)

import { logger } from "../../core/logger.js";
import {
  generateStructuredFunnelReply,
  LLM_ACTIONS,
  LLM_STAGES,
} from "./openaiClient.js";

const CTX = "llm/funnelEngine";

/**
 * Подготовить контекст для LLM:
 *  - история диалога
 *  - состояние сессии
 *  - последняя реплика пользователя
 *  - (опционально) данные ABCP
 *
 * @param {Object} params
 * @param {Object} params.session
 * @param {Object} params.msg
 * @param {Object} [params.injectedABCP]
 */
export function prepareFunnelContext({ session, msg, injectedABCP }) {
  const history = [];

  // Восстанавливаем историю диалога из session.history, если есть
  if (Array.isArray(session?.history)) {
    for (const h of session.history) {
      if (!h || typeof h.text !== "string") continue;
      if (h.role !== "user" && h.role !== "assistant") continue;
      history.push({
        role: h.role,
        content: h.text,
      });
    }
  }

  // Текущий запрос пользователя
  if (msg?.text) {
    history.push({
      role: "user",
      content: msg.text,
    });
  }

  const funnelContext = {
    history,
    session: session || {},
    msg: msg || {},
    abcp: injectedABCP ?? session?.abcp ?? null,
  };

  return funnelContext;
}

/**
 * Основной вход в LLM-воронку.
 *
 * @param {Object} context
 * @param {Array<{role: string, content: string}>} context.history
 * @param {Object} context.session
 * @param {Object} context.msg
 * @param {Object|null} [context.abcp]
 * @returns {Promise<import("./openaiClient.js").LLMFunnelResponse>}
 */
export async function runFunnelLLM(context) {
  const ctx = `${CTX}.runFunnelLLM`;

  try {
    const { history, session, msg, abcp } = context;

    const technicalIntro = buildTechnicalIntro({ session, msg, abcp });

    const messages = [
      ...technicalIntro,
      ...(history || []),
    ];

    const result = await generateStructuredFunnelReply({
      history: messages,
    });

    // generateStructuredFunnelReply уже гарантирует контракт LLMFunnelResponse
    return result;
  } catch (err) {
    logger.error(
      { ctx, error: err?.message, stack: err?.stack },
      "Ошибка в runFunnelLLM, возвращаем fallback",
    );
    return fallback();
  }
}

/**
 * Техническая "подводка" для LLM:
 *  - состояние воронки
 *  - известные данные клиента
 *  - сводка по ABCP (если есть)
 */
function buildTechnicalIntro({ session, msg, abcp }) {
  const blocks = [];

  const state = session?.state || {};
  const stage = state.stage || LLM_STAGES.NEW;

  const clientName =
    session?.name ||
    state?.client_name ||
    null;

  const phone = session?.phone || null;
  const address = session?.address || null;

  const introLines = [];

  introLines.push(
    `Текущая стадия воронки: ${stage}.`,
  );

  if (clientName) {
    introLines.push(`Имя клиента (по версии системы): ${clientName}.`);
  } else {
    introLines.push("Имя клиента пока неизвестно.");
  }

  if (phone) {
    introLines.push(`Телефон клиента (по версии системы): ${phone}.`);
  } else {
    introLines.push("Телефон клиента пока неизвестен.");
  }

  if (address) {
    introLines.push(`Адрес/ПВЗ клиента: ${address}.`);
  } else {
    introLines.push("Адрес клиента пока неизвестен.");
  }

  if (Array.isArray(session?.oems) && session.oems.length > 0) {
    introLines.push(
      `Ранее распознаны OEM-коды клиента: ${session.oems.join(
        ", ",
      )}.`,
    );
  }

  const abcpSummary = buildAbcpSummary(abcp);
  if (abcpSummary) {
    introLines.push(
      "Краткое резюме по уже найденным предложениям ABCP:",
    );
    introLines.push(abcpSummary);
  }

  if (msg?.text) {
    introLines.push(
      `Текущее сообщение клиента: "${msg.text}".`,
    );
  }

  blocks.push({
    role: "system",
    content: introLines.join("\n"),
  });

  return blocks;
}

/**
 * Краткая сводка по ABCP для LLM.
 * Мы не даём всю структуру, только сжатую текстовую выжимку.
 */
function buildAbcpSummary(abcp) {
  if (!abcp || typeof abcp !== "object") return "";

  const lines = [];

  for (const [oem, entry] of Object.entries(abcp)) {
    if (!entry || typeof entry !== "object") continue;

    const offers = Array.isArray(entry.offers)
      ? entry.offers
      : [];

    if (!offers.length) {
      lines.push(`По OEM ${oem} пока нет актуальных предложений.`);
      continue;
    }

    const best = offers[0];

    const brand = best.brand || "";
    const name = best.name || "";
    const price = best.priceNum || best.price || null;
    const daysText = best.daysText || "";
    const minDays = best.minDays;
    const maxDays = best.maxDays;

    let line = `OEM ${oem}: лучший вариант`;

    if (brand) line += ` бренд ${brand}`;
    if (name) line += `, ${name}`;
    if (typeof price === "number") {
      line += `, цена около ${price} руб.`;
    }
    if (daysText) {
      line += `, срок: ${daysText}`;
    } else if (
      typeof minDays === "number" &&
      typeof maxDays === "number"
    ) {
      line += `, срок: от ${minDays} до ${maxDays} дней.`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Fallback-ответ, если что-то пошло совсем не так.
 *
 * @returns {import("./openaiClient.js").LLMFunnelResponse}
 */
function fallback() {
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
