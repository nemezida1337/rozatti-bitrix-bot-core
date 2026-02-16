// src/modules/bot/handler/shared/chatReply.js

import { logger } from "../../../../core/logger.js";
import { getLeadStatusId } from "../../../crm/leadStateService.js";
import { crmSettings } from "../../../settings.crm.js";

const CTX = "modules/bot/handler/shared/chatReply";

/**
 * Решаем, можно ли писать в чат, или включается silent enrichment.
 */
export async function shouldSendChatReply({
  portalDomain,
  portalCfg,
  leadId,
  manualStatuses,
}) {
  const ctx = `${CTX}.shouldSendChatReply`;

  if (!leadId) return { canSend: true, reason: "no_leadId" };

  if (!Array.isArray(manualStatuses) || manualStatuses.length === 0) {
    return { canSend: true, reason: "no_manualStatuses" };
  }

  try {
    const statusId = await getLeadStatusId({
      domain: portalDomain,
      baseUrl: portalCfg.baseUrl,
      accessToken: portalCfg.accessToken,
      leadId,
    });

    if (!statusId) return { canSend: true, reason: "no_statusId" };

    if (manualStatuses.includes(statusId)) {
      return { canSend: false, reason: `manual_status:${statusId}`, statusId };
    }

    return { canSend: true, reason: `status:${statusId}`, statusId };
  } catch (err) {
    logger.warn(
      { ctx, portalDomain, leadId, err: err?.message || String(err) },
      "Не смогли прочитать STATUS_ID — отвечаем клиенту (не молчим)",
    );
    return { canSend: true, reason: "lead_get_failed" };
  }
}

export async function sendChatReplyIfAllowed({
  api,
  portalDomain,
  portalCfg,
  dialogId,
  leadId,
  message,
}) {
  const decision = await shouldSendChatReply({
    portalDomain,
    portalCfg,
    leadId,
    manualStatuses: crmSettings?.manualStatuses || [],
  });

  if (!decision.canSend) {
    logger.info(
      {
        ctx: `${CTX}.SILENT_ENRICHMENT`,
        portalDomain,
        dialogId,
        leadId,
        reason: decision.reason,
        statusId: decision.statusId,
        messagePreview: String(message || "").slice(0, 120),
      },
      "Silent enrichment: лид в ручной стадии — НЕ отправляем сообщение в чат",
    );
    return false;
  }

  await api.call("imbot.message.add", {
    DIALOG_ID: dialogId,
    MESSAGE: message || "…",
  });

  return true;
}
