// src/modules/bot/handler/flows/cortexTwoPassFlow.js
//
// 4) Стандартный путь: ДВА вызова HF-CORTEX
// Вынесено из handler_llm_manager.js без изменения поведения.

import { callCortexLeadSales } from "../../../../core/hfCortexClient.js";
import { logger } from "../../../../core/logger.js";
import { safeUpdateLeadAndContact } from "../../../crm/leads.js";
import { abcpLookupFromText } from "../../../external/pricing/abcp.js";
import { createAbcpOrderFromSession } from "../../../external/pricing/abcpOrder.js";
import { saveSession } from "../../sessionStore.js";
import { sendChatReplyIfAllowed } from "../shared/chatReply.js";
import { mapCortexResultToLlmResponse } from "../shared/cortex.js";
import { normalizeOemCandidates, applyLlmToSession } from "../shared/session.js";

function shouldCreateAbcpOrder(llm, session) {
  const llmStage = String(llm?.stage || "").toUpperCase();
  const sessionStage = String(session?.state?.stage || "").toUpperCase();
  const stage = llmStage || sessionStage;
  if (stage !== "ABCP_CREATE") return false;

  if (session?.lastAbcpOrder && Array.isArray(session.lastAbcpOrder.orderNumbers)) {
    return session.lastAbcpOrder.orderNumbers.length === 0;
  }

  return true;
}

async function tryCreateAbcpOrderIfNeeded({ llm, session, dialogId }) {
  if (!shouldCreateAbcpOrder(llm, session)) return llm;

  const created = await createAbcpOrderFromSession({ session, llm, dialogId });

  session.lastAbcpOrder = {
    ok: !!created.ok,
    reason: created.reason || null,
    orderNumbers: Array.isArray(created.orderNumbers) ? created.orderNumbers : [],
    at: Date.now(),
  };

  if (created.ok && created.orderNumbers.length > 0) {
    const suffix = ` Заказ в ABCP оформлен: №${created.orderNumbers.join(", ")}.`;
    llm.reply = `${String(llm.reply || "").trim()}${suffix}`.trim();
  } else if (!created.ok && !String(llm.reply || "").trim()) {
    llm.reply = "Не удалось автоматически оформить заказ в ABCP, передаю менеджеру.";
  }

  return llm;
}

export async function runCortexTwoPassFlow({
  api,
  portalDomain,
  portalCfg,
  dialogId,
  chatId,
  text,
  session,
  baseCtx = "modules/bot/handler_llm_manager",
}) {
  const ctx = `${baseCtx}.processIncomingBitrixMessage`;

  // ✅ если есть offers в сессии — прокидываем их в Cortex, чтобы выбор по id был стабильным
  const sessionOffers =
    session?.state?.offers &&
    Array.isArray(session.state.offers) &&
    session.state.offers.length > 0
      ? session.state.offers
      : null;

  // 4.1. ПЕРВЫЙ ВЫЗОВ HF-CORTEX
  const cortexRaw1 = await callCortexLeadSales(
    {
      msg: { text },
      sessionSnapshot: session,
      ...(session.abcp ? { injected_abcp: session.abcp } : {}),
      ...(sessionOffers ? { offers: sessionOffers } : {}),
    },
    logger,
  );

  logger.info(
    { ctx: `${ctx}.CORTEX_FIRST_PASS`, cortexRaw: cortexRaw1 },
    "[HF-CORTEX] response (first pass)",
  );

  if (!cortexRaw1) {
    logger.warn({ ctx }, "HF-CORTEX вернул null, шлём fallback");
    await sendChatReplyIfAllowed({
      api,
      portalDomain,
      portalCfg,
      dialogId,
      leadId: session.leadId,
      message: "Сервис временно недоступен, менеджер скоро подключится.",
    });
    saveSession(portalDomain, dialogId, session);
    return true;
  }

  let llm1 = mapCortexResultToLlmResponse(cortexRaw1);
  llm1 = await tryCreateAbcpOrderIfNeeded({ llm: llm1, session, dialogId });

  // ✅ NEW: фиксируем кандидатов OEM при запросе ABCP
  if (llm1.action === "abcp_lookup" && Array.isArray(llm1.oems) && llm1.oems.length > 0) {
    session.oem_candidates = normalizeOemCandidates(llm1.oems);
  }

  await safeUpdateLeadAndContact({
    portal: portalDomain,
    dialogId,
    chatId,
    session,
    llm: llm1,
    lastUserMessage: text,
    usedBackend: "HF_CORTEX",
  });

  applyLlmToSession(session, llm1);
  saveSession(portalDomain, dialogId, session);

  await sendChatReplyIfAllowed({
    api,
    portalDomain,
    portalCfg,
    dialogId,
    leadId: session.leadId,
    message: llm1.reply || "…",
  });

  // 5) ВТОРОЙ ПРОХОД: ABCP → HF-CORTEX (офферы)
  if (llm1.action === "abcp_lookup" && Array.isArray(llm1.oems) && llm1.oems.length > 0) {
    const ctxAbcp = `${baseCtx}.ABCP_SECOND_PASS`;

    logger.info({ ctx: ctxAbcp, oems: llm1.oems, text }, "Запускаем второй проход ABCP");

    try {
      const abcpData = await abcpLookupFromText(text, llm1.oems);

      logger.info(
        { ctx: ctxAbcp, abcpKeys: Object.keys(abcpData || {}) },
        "ABCP данные получены",
      );

      if (abcpData && Object.keys(abcpData).length > 0) {
        // Кешируем ABCP-ответ в сессии для последующих сообщений
        session.abcp = abcpData;

        // ✅ на втором проходе offers из сессии обычно ещё пусты — но на ретраях могут быть
        const sessionOffers2 =
          session?.state?.offers &&
          Array.isArray(session.state.offers) &&
          session.state.offers.length > 0
            ? session.state.offers
            : null;

        const cortexRaw2 = await callCortexLeadSales(
          {
            msg: { text },
            sessionSnapshot: session,
            injected_abcp: abcpData,
            ...(sessionOffers2 ? { offers: sessionOffers2 } : {}),
          },
          logger,
        );

        logger.info(
          { ctx: `${ctxAbcp}.CORTEX_SECOND_PASS`, cortexRaw: cortexRaw2 },
          "[HF-CORTEX] response (second pass)",
        );

        if (!cortexRaw2) {
          logger.warn({ ctx: ctxAbcp }, "Второй вызов Cortex вернул null");
          saveSession(portalDomain, dialogId, session);
          return true;
        }

        const llm2 = mapCortexResultToLlmResponse(cortexRaw2);
        await tryCreateAbcpOrderIfNeeded({ llm: llm2, session, dialogId });

        const noProgress =
          llm2.action === "abcp_lookup" && (!llm2.offers || llm2.offers.length === 0);

        if (noProgress) {
          logger.warn(
            { ctx: ctxAbcp, llm2 },
            "Второй проход Cortex не дал прогресса — не отправляем повторный ответ клиенту",
          );
          saveSession(portalDomain, dialogId, session);
          return true;
        }

        await safeUpdateLeadAndContact({
          portal: portalDomain,
          dialogId,
          chatId,
          session,
          llm: llm2,
          lastUserMessage: text,
          usedBackend: "HF_CORTEX",
        });

        applyLlmToSession(session, llm2);
        saveSession(portalDomain, dialogId, session);

        await sendChatReplyIfAllowed({
          api,
          portalDomain,
          portalCfg,
          dialogId,
          leadId: session.leadId,
          message: llm2.reply || "…",
        });
      } else {
        logger.info({ ctx: ctxAbcp }, "ABCP не вернул данных, второй проход Cortex пропущен");
        saveSession(portalDomain, dialogId, session);
      }
    } catch (err) {
      logger.error(
        { ctx: ctxAbcp, error: String(err) },
        "Ошибка ABCP/Cortex на втором проходе, передаём на менеджера",
      );
      await sendChatReplyIfAllowed({
        api,
        portalDomain,
        portalCfg,
        dialogId,
        leadId: session.leadId,
        message: "Не получилось автоматически подобрать варианты, передаю ваш запрос менеджеру.",
      });
      saveSession(portalDomain, dialogId, session);
    }
  }

  return true;
}

export default { runCortexTwoPassFlow };
