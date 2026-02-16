// src/modules/bot/handler/flows/managerOemTriggerFlow.js
//
// ✅ ABSOLUTE TRIGGER: manager filled OEM in lead → AUTO start
// Вынесено из handler_llm_manager.js без изменения поведения.

import { callCortexLeadSales } from "../../../../core/hfCortexClient.js";
import { logger } from "../../../../core/logger.js";
import { safeUpdateLeadAndContact } from "../../../crm/leads.js";
import { abcpLookupFromText } from "../../../external/pricing/abcp.js";
import { crmSettings } from "../../../settings.crm.js";
import { saveSession } from "../../sessionStore.js";
import { sendChatReplyIfAllowed } from "../shared/chatReply.js";
import { mapCortexResultToLlmResponse } from "../shared/cortex.js";
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
  // если лида нет — триггер невозможен
  if (!session?.leadId) return false;
  const manualStatuses = crmSettings?.manualStatuses || [];
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

  // Триггер допустим только в ручных статусах (или если сессия уже в manual)
  const allowTrigger =
    (leadStatusId && manualStatuses.includes(leadStatusId)) || session?.mode === "manual";

  if (isManagerOemTrigger(session, currentLeadOem) && allowTrigger) {
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
      "Менеджер заполнил OEM в лиде → абсолютный триггер AUTO",
    );

    session.mode = "auto";
    session.lastSeenLeadOem = nowSeen;
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
        await sendChatReplyIfAllowed({
          api,
          portalDomain,
          portalCfg,
          dialogId,
          leadId: session.leadId,
          message: llm.reply,
        });
      }

      return true;
    }

    // Cortex null — просто сохраняем факт триггера
    saveSession(portalDomain, dialogId, session);
    return true;
  }

  // ✅ просто синхронизация (без триггера)
  if (nowSeen && nowSeen !== prevSeen) {
    session.lastSeenLeadOem = nowSeen;
  }

  return false;
}

export default { runManagerOemTriggerFlow };
