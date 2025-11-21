// src/modules/llm/llmFunnelEngine.js (v5, фикс логгера)
// НОВЫЙ LLM PIPELINE
// — нормализованная история
// — структурированный контекст
// — strict JSON ответ
// — поддержка action (abcp_lookup, ask_name, ask_phone, smalltalk, …)
// — работает вместе с openaiClient.js (SYSTEM_PROMPT_V4)

import { logger } from "../../core/logger.js";
import { generateStructuredFunnelReply } from "./openaiClient.js";

const CTX = "llmFunnel";

/**
 * ПОДГОТОВКА КОНТЕКСТА ДЛЯ LLM
 *
 * session = {
 *   state: { stage, client_name, last_reply },
 *   abcp: { OEM: { offers: [.] } },   // сейчас храним только для истории / отладки
 *   history: [{ role, text }],
 * }
 *
 * msg = входящее сообщение
 */
export async function prepareFunnelContext({ session, msg }) {
  const context = {
    session_state: {
      stage: session?.state?.stage || "NEW",
      client_name: session?.state?.client_name || null,
      last_reply: session?.state?.last_reply || null,
    },
    // ABCP-данные из сессии сюда больше НЕ подсовываем в LLM
    // (обнулим ниже через abcpPayload)
    abcp_data: session?.abcp || {},
    message: {
      text: msg.text || "",
      is_forwarded: msg.isForwarded || false,
    },
    history: compressHistory(session?.history || []),
  };

  logger.debug({ ctx: CTX, context }, "LLM context prepared");
  return context;
}

/**
 * История: сокращаем, нормализуем.
 * Берём последние 6 сообщений (3 пары user/assistant).
 */
function compressHistory(history) {
  if (!Array.isArray(history) || !history.length) return [];
  const last = history.slice(-6);

  return last.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text || "",
  }));
}

/**
 * ЗАПУСК LLM-ФУННЕЛА
 *
 * context:
 *  - session_state
 *  - abcp_data      — данные из сессии (теперь только для логов, НЕ идёт в LLM)
 *  - injectedABCP   — свежий результат ABCP (handler_llm_manager подкидывает на 2-м проходе)
 *  - message
 *  - history
 */
export async function runFunnelLLM(context) {
  try {
    const messages = [];

    // SYSTEM-PROMPT основной лежит в openaiClient.js
    // Здесь даём только техническую подсказку.
    messages.push({
      role: "system",
      content:
        "Ты — структурный LLM-двигатель для автозапчастей Rozatti. Ответ всегда в формате одного JSON-объекта.",
    });

    // История диалога
    for (const h of context.history || []) {
      messages.push({
        role: h.role,
        content: h.content,
      });
    }

    // СВЕЖИЕ данные ABCP, если их подкинули из handler'а.
    // ВАЖНО: мы больше НЕ используем context.abcp_data,
    // чтобы LLM не могла опираться на старые цены.
    const abcpPayload = context.injectedABCP || {};

    // Последнее сообщение пользователя (как единый JSON)
    messages.push({
      role: "user",
      content: JSON.stringify({
        type: "user_message",
        text: context.message?.text || "",
        is_forwarded: context.message?.is_forwarded || false,
        session_state: context.session_state || {},
        abcp_data: abcpPayload,
      }),
    });

    logger.debug(
      { ctx: CTX, messagesCount: messages.length },
      "LLM messages",
    );

    const result = await generateStructuredFunnelReply({ history: messages });

    return normalizeLLMResult(result);
  } catch (err) {
    logger.error({ ctx: CTX, err }, "Ошибка LLM");
    return fallback();
  }
}

/**
 * Нормализация ответа LLM.
 */
function normalizeLLMResult(r) {
  return {
    action: r?.action || "reply",
    reply: r?.reply || "",
    stage: r?.stage || "NEW",
    need_operator: !!r?.need_operator,
    update_lead_fields: r?.update_lead_fields || {},
    client_name: r?.client_name || null,
    oems: Array.isArray(r?.oems) ? r.oems : [],
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
