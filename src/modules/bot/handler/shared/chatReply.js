// src/modules/bot/handler/shared/chatReply.js

import { logger } from "../../../../core/logger.js";
import { eventBus } from "../../../../core/eventBus.js";
import { getLeadStatusId } from "../../../crm/leadStateService.js";
import { crmSettings } from "../../../settings.crm.js";

const CTX = "modules/bot/handler/shared/chatReply";

function buildOpenlinesPayload(dialogId, message) {
  const raw = String(dialogId || "");
  const payload = { MESSAGE: message };

  if (/^chat\d+$/i.test(raw)) {
    payload.CHAT_ID = Number(raw.replace(/\D/g, ""));
    return payload;
  }

  if (/^\d+$/.test(raw)) {
    payload.CHAT_ID = Number(raw);
    return payload;
  }

  payload.DIALOG_ID = raw;
  return payload;
}

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

  const replyText = message || "…";

  try {
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: replyText,
    });
    return true;
  } catch (err) {
    const code = err?.code || err?.res?.error || null;

    // Частый кейс в Open Lines: imbot.message.add может вернуть CANCELED.
    // Пробуем нативный OL-метод и не роняем webhook.
    if (code === "CANCELED") {
      logger.warn(
        { ctx: `${CTX}.FALLBACK`, portalDomain, dialogId, leadId, code },
        "imbot.message.add denied, trying imopenlines.bot.session.message.send",
      );
      try {
        await api.call(
          "imopenlines.bot.session.message.send",
          buildOpenlinesPayload(dialogId, replyText),
        );
        return true;
      } catch (fallbackErr) {
        const errorCode = fallbackErr?.code || fallbackErr?.res?.error || "UNKNOWN";
        logger.error(
          {
            ctx: `${CTX}.FALLBACK`,
            portalDomain,
            dialogId,
            leadId,
            errorCode,
            error: fallbackErr?.message || String(fallbackErr),
          },
          "Open Lines fallback send failed",
        );
        await eventBus.emit("BOT_REPLY_FAILED", {
          portal: portalDomain,
          dialogId,
          leadId,
          errorCode,
          channel: "openlines_fallback",
          messagePreview: String(replyText || "").slice(0, 120),
        });
        return false;
      }
    }

    throw err;
  }
}
