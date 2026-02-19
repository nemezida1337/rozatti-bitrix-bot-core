// src/modules/bot/handler/decision.js
// Шаг 2: decision adapter (gate)
//
// Здесь мы:
// 1) нормализуем сигнал сообщения (OEM/VIN/COMPLEX/TEXT/EMPTY)
// 2) добавляем данные по стадии лида (leadStageKey) и наличию офферов (hasOffers)
// 3) вызываем leadDecisionGate и возвращаем результат

import { crmSettings } from "../../settings.crm.js";
import { leadDecisionGate } from "../leadDecisionGate.js";

const VIN_KEYWORD_REGEX = /(?:\bVIN\b|\bВИН\b)/i;
const VIN_ALLOWED_17_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

function compactAlnum(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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

  // Если пользователь явно пишет VIN/ВИН — считаем VIN-запросом
  if (VIN_KEYWORD_REGEX.test(t)) return true;

  // Если в тексте есть 17-символьный VIN (после очистки)
  const c = compactAlnum(t);
  return c.length === 17 && VIN_ALLOWED_17_REGEX.test(c);
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
  if (!hasText) {
    requestType = "EMPTY";
  } else if (detectedOems.length > 0) {
    requestType = "OEM";
  } else if (isVinLike(text)) {
    requestType = "VIN";
  } else if (hasImage) {
    requestType = "COMPLEX";
  } else {
    requestType = "TEXT";
  }

  const gateInput = {
    authorType,
    requestType,
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
