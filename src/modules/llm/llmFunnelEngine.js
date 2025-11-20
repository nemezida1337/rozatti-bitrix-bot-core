// src/modules/llm/llmFunnelEngine.js (v2)
// НОВЫЙ LLM PIPELINE
// — нормализованная история
// — структурированный контекст
// — strict JSON ответ
// — поддержка action (abcp_lookup, ask_name, ask_phone, smalltalk, …)
// — соответствует prompt v3

import { logger } from "../../core/logger.js";
import { generateStructuredFunnelReply } from "./openaiClient.js";

const CTX = "llmFunnel";

/**
 * ПОДГОТОВКА КОНТЕКСТА ДЛЯ LLM
 *
 * session = {
 *   state: { stage, client_name, last_reply },
 *   abcp: { OEM: { offers: [...] } },
 *   history: [{ role, text }],
 * }
 *
 * msg = входящее сообщение
 */
export async function prepareFunnelContext({ session, msg }) {
  const context = {
    session_state: {
      stage: session.state?.stage || "NEW",
      client_name: session.state?.client_name || null,
      last_reply: session.state?.last_reply || null,
    },
    abcp_data: session.abcp || {},
    message: {
      text: msg.text || "",
      is_forwarded: msg.isForwarded || false,
    },
    history: compressHistory(session.history),
  };

  logger.debug(CTX, "LLM context prepared:", context);
  return context;
}

/**
 * История: сокращаем, нормализуем.
 * Берём последние 6 сообщений (3 пары user/assistant).
 */
function compressHistory(history) {
  if (!history || !history.length) return [];
  const last = history.slice(-6);
  return last.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text || "",
  }));
}

/**
 * ЗАПУСК LLM-ФУННЕЛА
 *
 * Возвращает строго структурированный JSON от LLM.
 */
export async function runFunnelLLM(context) {
  try {
    const messages = [];

    // SYSTEM-PROMPT встроен в openaiClient.js
    // Здесь только user/system-контекст.
    messages.push({
      role: "system",
      content: `Ты — структурный LLM-двигатель для автозапчастей Rozatti. Используй строгий JSON.`,
    });

    // История диалога
    for (const h of context.history) {
      messages.push({
        role: h.role,
        content: h.content,
      });
    }

    // Последнее сообщение пользователя
    messages.push({
      role: "user",
      content: JSON.stringify({
        type: "user_message",
        text: context.message.text,
        is_forwarded: context.message.is_forwarded,
        session_state: context.session_state,
        abcp_data: context.abcp_data,
      }),
    });

    logger.debug(CTX, "LLM messages:", messages);

    const result = await generateStructuredFunnelReply({ history: messages });

    return normalizeLLMResult(result);
  } catch (err) {
    logger.error(CTX, "Ошибка LLM", err);
    return fallback();
  }
}

/**
 * Нормализация ответа LLM.
 */
function normalizeLLMResult(r) {
  return {
    action: r.action || "reply",
    reply: r.reply || "",
    stage: r.stage || "NEW",
    need_operator: !!r.need_operator,
    update_lead_fields: r.update_lead_fields || {},
    client_name: r.client_name || null,
    oems: r.oems || [],
  };
}

/**
 * Fallback на случай краша LLM.
 */
function fallback() {
  return {
    action: "reply",
    reply: "Сорри, сейчас временная ошибка. Уже восстанавливаюсь.",
    stage: "NEW",
    need_operator: false,
    update_lead_fields: {},
    client_name: null,
    oems: [],
  };
}
