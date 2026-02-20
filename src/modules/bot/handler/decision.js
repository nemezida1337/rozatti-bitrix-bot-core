// src/modules/bot/handler/decision.js
// Шаг 2: decision adapter (gate)
//
// Здесь мы:
// 1) нормализуем сигнал сообщения (OEM/VIN/COMPLEX/TEXT/EMPTY)
// 2) добавляем данные по стадии лида (leadStageKey) и наличию офферов (hasOffers)
// 3) вызываем leadDecisionGate и возвращаем результат

import { crmSettings } from "../../settings.crm.js";
import { leadDecisionGate } from "../leadDecisionGate.js";

const VIN_KEYWORD_REGEX = /(?:^|[^A-ZА-ЯЁ0-9_])(VIN|ВИН)(?=$|[^A-ZА-ЯЁ0-9_])/i;
const VIN_ALLOWED_17_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
const VIN_HAS_LETTER_REGEX = /[A-HJ-NPR-Z]/i;
const VIN_CONTIGUOUS_17_REGEX = /[A-HJ-NPR-Z0-9]{17}/gi;
const VIN_TOKEN_WITH_SEPARATORS_REGEX = /[A-HJ-NPR-Z0-9-]{17,30}/gi;
const VIN_AFTER_KEYWORD_REGEX =
  /(?:^|[^A-ZА-ЯЁ0-9_])(?:VIN|ВИН)\s*[:#]?\s*([A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9\s-]{14,60})/giu;

function compactAlnum(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function isValidVinCandidate(value) {
  const candidate = compactAlnum(value);
  return (
    candidate.length === 17 &&
    VIN_ALLOWED_17_REGEX.test(candidate) &&
    VIN_HAS_LETTER_REGEX.test(candidate)
  );
}

function hasValidContiguousVin(text) {
  const matches = String(text || "")
    .toUpperCase()
    .match(VIN_CONTIGUOUS_17_REGEX);
  if (!matches || matches.length === 0) return false;
  return matches.some((candidate) => isValidVinCandidate(candidate));
}

function hasValidVinTokenWithSeparators(text) {
  const tokens = String(text || "")
    .toUpperCase()
    .match(VIN_TOKEN_WITH_SEPARATORS_REGEX);
  if (!tokens || tokens.length === 0) return false;

  return tokens.some((token) => isValidVinCandidate(token));
}

function hasValidVinAfterKeyword(text) {
  const upper = String(text || "").toUpperCase();
  const matches = upper.matchAll(VIN_AFTER_KEYWORD_REGEX);
  for (const match of matches) {
    const candidate = compactAlnum(match?.[1] || "");
    if (candidate.length < 17) continue;
    if (isValidVinCandidate(candidate.slice(0, 17))) return true;
  }
  return false;
}

function buildStatusToStageKeyMap() {
  const map = {};
  const stageToStatus = crmSettings?.stageToStatusId || {};
  for (const [stageKey, statusId] of Object.entries(stageToStatus)) {
    if (!statusId) continue;
    map[String(statusId)] = stageKey;
  }
  return map;
}

const STATUS_TO_STAGE_KEY = buildStatusToStageKeyMap();

function resolveLeadStageKey(statusId) {
  if (!statusId) return null;
  return STATUS_TO_STAGE_KEY[String(statusId)] || null;
}

function isVinLike(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  const upper = t.toUpperCase();

  // Если в тексте есть валидный 17-символьный VIN подряд.
  if (hasValidContiguousVin(upper)) return true;

  if (VIN_KEYWORD_REGEX.test(upper)) {
    if (hasValidVinAfterKeyword(upper)) return true;
    // Поддержка VIN с дефисами только в контексте явного VIN/ВИН,
    // чтобы не ловить GUID/идентификаторы из реквизитов как VIN.
    if (hasValidVinTokenWithSeparators(upper)) return true;
  }

  return false;
}

function inferAuthorType(ctx) {
  const userFlags = ctx?.message?.userFlags || {};
  const isBot = String(userFlags?.isBot || "").toUpperCase() === "Y";
  const isConnector = String(userFlags?.isConnector || "").toUpperCase() === "Y";
  const chatEntityType = String(ctx?.message?.chatEntityType || "").toUpperCase();
  const isSystemLike = !!ctx?.message?.isSystemLike;

  if (isBot || isSystemLike) return "system";
  if (chatEntityType === "LINES" && isConnector) return "client";
  if (chatEntityType === "LINES") return "manager";
  return "client";
}

export function buildDecision(ctx) {
  const text = String(ctx?.message?.text || "").trim();
  const hasText = text.length > 0;

  const authorType = inferAuthorType(ctx);
  const hasImage = !!ctx?.hasImage;

  const detectedOems = Array.isArray(ctx?.detectedOems) ? ctx.detectedOems : [];
  const oemInLead = ctx?.lead?.oemInLead ? String(ctx.lead.oemInLead).trim() : null;

  const leadStatusId = ctx?.lead?.statusId || null;
  const leadStageKey = resolveLeadStageKey(leadStatusId);

  const hasOffers =
    (Array.isArray(ctx?.session?.state?.offers) && ctx.session.state.offers.length > 0) ||
    (Array.isArray(ctx?.session?.abcp?.offers) && ctx.session.abcp.offers.length > 0) ||
    (Array.isArray(ctx?.session?.abcp?.items) && ctx.session.abcp.items.length > 0);

  let requestType = "EMPTY";
  if (!hasText && hasImage) {
    requestType = "COMPLEX";
  } else if (!hasText) {
    requestType = "EMPTY";
  } else if (isVinLike(text)) {
    requestType = "VIN";
  } else if (detectedOems.length > 0) {
    requestType = "OEM";
  } else if (hasImage) {
    requestType = "COMPLEX";
  } else {
    requestType = "TEXT";
  }

  const gateInput = {
    authorType,
    requestType,
    rawText: text,
    hasImage,
    detectedOems,
    leadStatusId,
    leadStageKey,
    hasOffers,
    manualStatuses: ctx?.manualStatuses || [],
    oemInLead,
    sessionMode: ctx?.session?.mode,
    manualAckSent: !!ctx?.session?.manualAckSent,
  };

  const decision = leadDecisionGate(gateInput);

  return { gateInput, decision };
}
