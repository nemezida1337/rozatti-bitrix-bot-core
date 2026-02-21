// src/modules/bot/handler/flows/managerOemTriggerFlow.js
//
// ✅ TRIGGER: manager filled OEM in lead on VIN_PICK stage → AUTO start
// Вынесено из handler_llm_manager.js без изменения поведения.

import { callCortexLeadSales } from "../../../../core/hfCortexClient.js";
import { logger } from "../../../../core/logger.js";
import { safeUpdateLeadAndContact } from "../../../crm/leads.js";
import { abcpLookupFromText } from "../../../external/pricing/abcp.js";
import { crmSettings } from "../../../settings.crm.js";
import { saveSession } from "../../sessionStore.js";
import { sendChatReplyIfAllowed } from "../shared/chatReply.js";
import { mapCortexResultToLlmResponse } from "../shared/cortex.js";
import { appendSessionHistoryTurn } from "../shared/historyContext.js";
import { isManagerOemTrigger } from "../shared/leadOem.js";
import { normalizeOemCandidates, applyLlmToSession } from "../shared/session.js";

export async function runManagerOemTriggerFlow({
  api,
  portalDomain,
  portalCfg,
  dialogId,
  session,
  baseCtx = "modules/bot/handler_llm_manager",
}) {
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

  // если лида нет — триггер невозможен
  if (!session?.leadId) return false;
  const manualStatuses = crmSettings?.manualStatuses || [];
  const vinPickStatusId = crmSettings?.stageToStatusId?.VIN_PICK || null;
  const oemField = crmSettings?.leadFields?.OEM;

  let lead = null;
  try {
    lead = await api.call("crm.lead.get", { id: session.leadId });
  } catch (err) {
    logger.warn(
      { ctx: `${baseCtx}.MANAGER_OEM_TRIGGER`, leadId: session.leadId, err: err?.message || String(err) },
      "Не смогли прочитать лид для проверки OEM/STATUS",
    );
    return false;
  }

  const leadStatusId = lead?.STATUS_ID || null;

  const currentLeadOem = (() => {
    if (!oemField) return null;
    const raw = lead?.[oemField];
    if (!raw) return null;
    const val = String(raw).trim();
    return val ? val : null;
  })();

  // ✅ ВАЖНО: всегда синхронизируем lastSeenLeadOem с лидом (но триггерим только empty→filled)
  const prevSeen = session.lastSeenLeadOem ? String(session.lastSeenLeadOem).trim() : "";
  const nowSeen = currentLeadOem ? String(currentLeadOem).trim() : "";
  const baselineInitialized = session.leadOemBaselineInitialized === true;

  const isManualStatus = !!leadStatusId && manualStatuses.includes(leadStatusId);
  const isVinPickStatus = vinPickStatusId
    ? String(leadStatusId || "") === String(vinPickStatusId)
    : isManualStatus;

  // Триггер допустим только на VIN_PICK (фоллбек: любой manual-статус, если VIN_PICK не настроен)
  const allowTrigger = isVinPickStatus;

  // Защита от ложного auto-start после рестарта:
  // первый проход только синхронизирует baseline с фактическим OEM в лиде.
  // Исключение: если есть ожидаемые OEM-кандидаты из pending manual-flow и OEM совпал.
  let allowFirstPassTrigger = false;
  if (!baselineInitialized) {
    session.lastSeenLeadOem = nowSeen || null;
    session.leadOemBaselineInitialized = true;

    if (nowSeen && Array.isArray(session.oem_candidates) && session.oem_candidates.length > 0) {
      const nowUpper = nowSeen.toUpperCase();
      const hasPendingMatch = session.oem_candidates.some(
        (x) => String(x || "").trim().toUpperCase() === nowUpper,
      );
      allowFirstPassTrigger = hasPendingMatch;
    }
  }

  const triggerByTransition = baselineInitialized
    ? isManagerOemTrigger({ lastSeenLeadOem: prevSeen }, currentLeadOem)
    : false;
  const shouldTrigger = allowTrigger && (triggerByTransition || allowFirstPassTrigger);

  if (shouldTrigger) {
    const ctxTrig = `${baseCtx}.MANAGER_OEM_TRIGGER`;

    logger.info(
      {
        ctx: ctxTrig,
        portalDomain,
        dialogId,
        leadId: session.leadId,
        currentLeadOem,
        leadStatusId,
      },
      "Менеджер заполнил OEM в лиде на VIN_PICK → триггер AUTO",
    );

    session.mode = "auto";
    session.lastSeenLeadOem = nowSeen;
    session.leadOemBaselineInitialized = true;
    session.oem_candidates = normalizeOemCandidates([nowSeen]); // фиксируем как текущий контекст

    // 1) ABCP по OEM из лида
    let abcpData = null;
    try {
      abcpData = await abcpLookupFromText("", [nowSeen]);
      session.abcp = abcpData;
    } catch (err) {
      logger.error(
        { ctx: ctxTrig, error: String(err), currentLeadOem: nowSeen },
        "Ошибка ABCP при manager OEM trigger",
      );
    }

    // 2) один вызов Cortex с injected_abcp
    const cortexRaw = await callCortexLeadSales(
      {
        msg: { text: "" },
        sessionSnapshot: session,
        injected_abcp: abcpData,
      },
      logger,
    );

    logger.info(
      { ctx: `${ctxTrig}.CORTEX`, cortexRaw },
      "[HF-CORTEX] response (manager OEM trigger)",
    );

    if (cortexRaw) {
      const llm = mapCortexResultToLlmResponse(cortexRaw);

      await safeUpdateLeadAndContact({
        portal: portalDomain,
        dialogId,
        chatId: null,
        session,
        llm,
        lastUserMessage: null,
        usedBackend: "HF_CORTEX",
      });

      applyLlmToSession(session, llm);
      saveSession(portalDomain, dialogId, session);

      // Ответ клиенту — только если не manual статус
      if (llm.reply) {
        await sendBotReply(llm.reply, "manager_oem_trigger_reply");
      }

      return true;
    }

    // Cortex null — просто сохраняем факт триггера
    saveSession(portalDomain, dialogId, session);
    return true;
  }

  // ✅ просто синхронизация (без триггера)
  if (nowSeen !== prevSeen) {
    session.lastSeenLeadOem = nowSeen || null;
    session.leadOemBaselineInitialized = true;
  }

  return false;
}

export default { runManagerOemTriggerFlow };
