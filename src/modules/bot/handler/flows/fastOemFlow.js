// src/modules/bot/handler/flows/fastOemFlow.js
//
// 3.1. Быстрый путь для простого OEM-запроса
// Вынесено из handler_llm_manager.js без изменения поведения.

import { callCortexLeadSales } from "../../../../core/hfCortexClient.js";
import { logger } from "../../../../core/logger.js";
import { safeUpdateLeadAndContact } from "../../../crm/leads.js";
import { abcpLookupFromText } from "../../../external/pricing/abcp.js";
import { detectOemsFromText, isSimpleOemQuery } from "../../oemDetector.js";
import { saveSession } from "../../sessionStore.js";
import { sendChatReplyIfAllowed } from "../shared/chatReply.js";
import { mapCortexResultToLlmResponse } from "../shared/cortex.js";
import { appendSessionHistoryTurn } from "../shared/historyContext.js";
import { normalizeOemCandidates, applyLlmToSession } from "../shared/session.js";

export async function runFastOemFlow({
  api,
  portalDomain,
  portalCfg,
  dialogId,
  chatId,
  text,
  session,
  baseCtx = "modules/bot/handler_llm_manager",
}) {
  const simpleOem = isSimpleOemQuery(text);
  const detectedOems = detectOemsFromText(text);

  if (!(simpleOem && detectedOems.length > 0 && session?.state?.stage === "NEW")) {
    return false;
  }

  const ctxFast = `${baseCtx}.FAST_OEM_PATH`;

  const sendBotReply = async (message, kind = null) => {
    const safeMessage = String(message || "").trim();
    if (!safeMessage) return;

    const sent = await sendChatReplyIfAllowed({
      api,
      portalDomain,
      portalCfg,
      dialogId,
      leadId: session.leadId,
      dealId: session?.dealId || null,
      message: safeMessage,
    });
    if (!sent) return;

    appendSessionHistoryTurn(session, {
      role: "bot",
      text: safeMessage,
      kind: kind || "bot_reply",
      ts: Date.now(),
    });
  };

  // ✅ NEW: сохраняем кандидатов OEM (важно для multi-OEM правил в CRM)
  session.oem_candidates = normalizeOemCandidates(detectedOems);

  logger.info(
    { ctx: ctxFast, text, detectedOems, oem_candidates: session.oem_candidates },
    "Простой OEM-запрос, используем быстрый путь (ABCP → Cortex одним проходом)",
  );

  // 1) Сразу отправляем клиенту "Получил номер, подбираю варианты."
  await sendBotReply(
    `Получил номера ${session.oem_candidates.join(" и ")}, подбираю варианты.`,
    "fast_oem_ack",
  );

  // 2) Делаем ABCP по найденным OEM
  let abcpData = null;
  try {
    abcpData = await abcpLookupFromText(text, session.oem_candidates);
    // Кешируем ABCP-данные в сессии, чтобы использовать на следующих шагах
    session.abcp = abcpData;
  } catch (err) {
    logger.error(
      { ctx: ctxFast, error: String(err) },
      "Ошибка ABCP на быстром пути, передаём на менеджера",
    );
    await sendBotReply(
      "Не получилось автоматически подобрать варианты, передаю ваш запрос менеджеру.",
      "fast_oem_error",
    );
    saveSession(portalDomain, dialogId, session);
    return true;
  }

  // ✅ берём offers из сессии, если они уже были (обычно нет на первом сообщении, но полезно на ретраях)
  const sessionOffers =
    session?.state?.offers &&
    Array.isArray(session.state.offers) &&
    session.state.offers.length > 0
      ? session.state.offers
      : null;

  // 3) Один вызов Cortex с injected_abcp (+ offers если есть)
  const cortexRaw = await callCortexLeadSales(
    {
      msg: { text },
      sessionSnapshot: session,
      injected_abcp: abcpData,
      ...(sessionOffers ? { offers: sessionOffers } : {}),
    },
    logger,
  );

  // Лог быстрого прохода Cortex
  logger.info(
    { ctx: `${ctxFast}.CORTEX_FAST_PASS`, cortexRaw },
    "[HF-CORTEX] response (fast OEM pass)",
  );

  if (!cortexRaw) {
    logger.warn({ ctx: ctxFast }, "HF-CORTEX вернул null на быстром пути");
    await sendBotReply(
      "Сервис временно недоступен, подключаю менеджера для помощи.",
      "fast_oem_cortex_fallback",
    );
    saveSession(portalDomain, dialogId, session);
    return true;
  }

  const llm = mapCortexResultToLlmResponse(cortexRaw);

  // ✅ NEW: если Cortex попросил abcp_lookup и выдал oems — зафиксируем кандидатов
  if (llm.action === "abcp_lookup" && Array.isArray(llm.oems) && llm.oems.length > 0) {
    session.oem_candidates = normalizeOemCandidates(llm.oems);
  }

  await safeUpdateLeadAndContact({
    portal: portalDomain,
    dialogId,
    chatId,
    session,
    llm,
    lastUserMessage: text,
    usedBackend: "HF_CORTEX",
  });

  applyLlmToSession(session, llm);
  // ✅ важно: бот сам записал OEM в лид — синхронизируем, чтобы не было ложного manager-trigger
  if (detectedOems[0]) session.lastSeenLeadOem = String(detectedOems[0]).trim();
  saveSession(portalDomain, dialogId, session);

  await sendBotReply(llm.reply || "…", "fast_oem_reply");

  return true;
}

export default { runFastOemFlow };
