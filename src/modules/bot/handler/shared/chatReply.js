// src/modules/bot/handler/shared/chatReply.js

import { logger } from "../../../../core/logger.js";
import { eventBus } from "../../../../core/eventBus.js";
import { getLeadStatusId } from "../../../crm/leadStateService.js";
import { crmSettings } from "../../../settings.crm.js";

const CTX = "modules/bot/handler/shared/chatReply";
const DEFAULT_REPLY_DEDUP_MS = 120000;
const MAX_DEDUP_CACHE_SIZE = 5000;
const _recentReplies = new Map();

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function resolveReplyDedupMs() {
  const fromEnv = Number(process.env.BOT_REPLY_DEDUP_MS || DEFAULT_REPLY_DEDUP_MS);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) return DEFAULT_REPLY_DEDUP_MS;
  return Math.trunc(fromEnv);
}

function normalizeReplyText(message) {
  return String(message || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pruneDedupCache(now, dedupMs) {
  if (_recentReplies.size <= MAX_DEDUP_CACHE_SIZE) return;
  const maxAge = Math.max(dedupMs * 10, 300000);
  for (const [key, ts] of _recentReplies.entries()) {
    if (!Number.isFinite(ts) || now - ts > maxAge) {
      _recentReplies.delete(key);
    }
  }
}

function shouldSkipDuplicateReply({ portalDomain, dialogId, message, dedupMs }) {
  const normalized = normalizeReplyText(message);
  if (!normalized) return false;

  const key = `${String(portalDomain || "")}::${String(dialogId || "")}::${normalized}`;
  const now = Date.now();
  pruneDedupCache(now, dedupMs);

  const lastTs = Number(_recentReplies.get(key) || 0);
  if (lastTs > 0 && now - lastTs <= dedupMs) {
    return true;
  }
  _recentReplies.set(key, now);
  return false;
}

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
  dealId = null,
  manualStatuses,
}) {
  const ctx = `${CTX}.shouldSendChatReply`;
  const normalizedDealId = toPositiveInt(dealId);

  if (normalizedDealId) {
    return {
      canSend: false,
      reason: `deal_bound:${normalizedDealId}`,
      dealId: normalizedDealId,
    };
  }

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
  dealId = null,
  message,
}) {
  const decision = await shouldSendChatReply({
    portalDomain,
    portalCfg,
    leadId,
    dealId,
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
      "Silent enrichment: отправка в чат отключена для текущего CRM-контекста",
    );
    return false;
  }

  const replyText = message || "…";
  const dedupMs = resolveReplyDedupMs();
  const isDuplicate = shouldSkipDuplicateReply({
    portalDomain,
    dialogId,
    message: replyText,
    dedupMs,
  });
  if (isDuplicate) {
    logger.info(
      {
        ctx: `${CTX}.DEDUP`,
        portalDomain,
        dialogId,
        leadId,
        dedupMs,
        messagePreview: String(replyText).slice(0, 120),
      },
      "Skip duplicate bot reply in dedup window",
    );
    return false;
  }

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

export function __resetReplyDedupForTests() {
  _recentReplies.clear();
}
