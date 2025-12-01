// src/modules/llm/llmFunnelEngine.js
// LLM-воронка: собирает history и вызывает OpenAI-клиент по строгому контракту.

import { logger } from "../../core/logger.js";
import { generateStructuredFunnelReply } from "./openaiClient.js";

const CTX = "llm/llmFunnelEngine";

/**
 * Построение истории для LLM из сессии + текущего сообщения + (опционально) ABCP.
 *
 * session.history: [{ role: "user"|"assistant", text: string }, ...]
 * msg: { text: string }
 * abcpSummary: объект с результатами ABCP (как его вернул searchManyOEMs)
 */
export function buildHistory({ session, msg, abcpSummary }) {
  const history = [];

  if (Array.isArray(session?.history)) {
    for (const m of session.history) {
      if (!m || typeof m.text !== "string") continue;
      const role = m.role === "assistant" ? "assistant" : "user";
      history.push({ role, content: m.text });
    }
  }

  if (msg?.text) {
    history.push({ role: "user", content: msg.text });
  }

  // Если у нас есть нормализованные результаты ABCP — даём их LLM во втором проходе
  if (abcpSummary && Object.keys(abcpSummary).length > 0) {
    history.push({
      role: "system",
      content:
        "ABCP_RESULTS_JSON: " + JSON.stringify(abcpSummary),
    });
  }

  return history;
}

/**
 * Подготовка базового контекста для LLM.
 */
export async function prepareFunnelContext({ session, msg }) {
  return { session, msg };
}

/**
 * Запуск LLM по воронке.
 * На входе:
 *  - session, msg
 *  - (опц.) injectedABCP — нормализованный ответ ABCP для второго прохода
 */
export async function runFunnelLLM(context) {
  const { session, msg, injectedABCP } = context;

  const history = buildHistory({
    session: session || {},
    msg,
    abcpSummary: injectedABCP || null,
  });

  const llm = await generateStructuredFunnelReply({ history });

  logger.debug({ ctx: CTX, llm }, "runFunnelLLM result");
  return llm;
}
