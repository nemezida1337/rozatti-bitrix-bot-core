// src/modules/bot/handler/context.js
// Шаг 1: сбор контекста (без решений, без экшенов)

import { logger } from "../../../core/logger.js";
import { normalizeIncomingMessage } from "../../../core/messageModel.js";
import { getPortal } from "../../../core/store.js";
import { getLead } from "../../crm/leadStateService.js";
import { crmSettings } from "../../settings.crm.js";
import { hydrateSessionLeadFromEvent } from "../extractLeadFromEvent.js";
import { detectOemsFromText, isSimpleOemQuery } from "../oemDetector.js";
import { getSession } from "../sessionStore.js";

// OEM-детектор (быстрый путь)

// LEAD snapshot (STATUS_ID + UF_OEM и т.п.)

// CRM settings (manualStatuses + поля)

const CTX = "modules/bot/handler/context";

function isNonEmpty(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  return s.length > 0;
}

export async function buildContext({ portal, body, domain: domainHint = null }) {
  const msg = normalizeIncomingMessage(body);

  const domain =
    msg?.portal ||
    domainHint ||
    portal?.domain ||
    body?.auth?.domain ||
    body?.auth?.DOMAIN ||
    body?.data?.AUTH?.domain ||
    body?.data?.AUTH?.DOMAIN ||
    body?.data?.auth?.domain ||
    body?.data?.auth?.DOMAIN ||
    null;
  const dialogId = msg?.dialogId || null;

  // привязка auto-lead -> session.leadId
  try {
    hydrateSessionLeadFromEvent(body);
  } catch (e) {
    logger.warn(
      { ctx: CTX, e: String(e) },
      "hydrateSessionLeadFromEvent failed (ignored)",
    );
  }

  const portalCfg = (domain ? getPortal(domain) : null) || portal || null;
  const baseUrl = portalCfg?.baseUrl || null;
  const accessToken = portalCfg?.accessToken || null;
  const hasToken = !!accessToken;

  const session =
    domain && dialogId ? getSession(domain, dialogId) || null : null;
  const leadId = session?.leadId || null;

  const isSystemLike = !!msg?.isSystemLike;
  const detectedOems = isSystemLike ? [] : detectOemsFromText(msg?.text || "");
  const isSimpleOem = isSystemLike
    ? false
    : isSimpleOemQuery(msg?.text || "", detectedOems);

  let leadRaw = null;
  let statusId = null;
  let oemValue = null;
  let oemInLead = false;

  const oemFieldCode = crmSettings?.leadFields?.OEM;

  if (domain && leadId && baseUrl && accessToken) {
    try {
      leadRaw = await getLead({ domain, baseUrl, accessToken, leadId });
      statusId = leadRaw?.STATUS_ID || null;

      if (
        oemFieldCode &&
        leadRaw &&
        Object.prototype.hasOwnProperty.call(leadRaw, oemFieldCode)
      ) {
        oemValue = leadRaw[oemFieldCode];
        oemInLead = isNonEmpty(oemValue);
      }
    } catch (e) {
      logger.warn(
        { ctx: CTX, domain, leadId, e: String(e) },
        "getLead failed (status/oem unknown)",
      );
    }
  }

  return {
    domain,
    portal: { baseUrl, accessToken, hasToken },
    event: { event: body?.event || null },
    message: {
      dialogId: msg?.dialogId || null,
      chatId: msg?.chatId || null,
      fromUserId: msg?.fromUserId || null,
      messageId: msg?.messageId || null,
      text: msg?.text || "",
      hasAttachments: !!(msg?.attachments && msg.attachments.length),
      isForwarded: !!msg?.isForwarded,
      isSystemLike,
      chatEntityType:
        body?.data?.PARAMS?.CHAT_ENTITY_TYPE ||
        body?.data?.params?.CHAT_ENTITY_TYPE ||
        null,
      userFlags: {
        isBot: body?.data?.USER?.IS_BOT || null,
        isConnector: body?.data?.USER?.IS_CONNECTOR || null,
        isNetwork: body?.data?.USER?.IS_NETWORK || null,
      },
    },
    lead: {
      leadId,
      statusId,
      oemValue,
      oemInLead,
      raw: leadRaw,
    },
    session,
    detectedOems,
    isSimpleOem,
    hasImage: !!(msg?.attachments && msg.attachments.length),
    manualStatuses: crmSettings?.manualStatuses || [],
    botDisabledStatuses: crmSettings?.botDisabledStatuses || [],
    pricingStatusId: crmSettings?.stageToStatusId?.PRICING || null,
    leadFields: crmSettings?.leadFields || {},
  };
}

export default { buildContext };
