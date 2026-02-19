// src/modules/bot/handler/shared/session.js

import { crmSettings } from "../../../../config/settings.crm.js";

const ADDRESS_WORD_RE =
  /\b(ул|улица|дом|д\.|д |кв|квартира|корп|корпус|проспект|пр-т|шоссе|пер|переулок|проезд|г\.|город)\b/i;
const NON_ADDRESS_HINT_RE =
  /(нужна\s+запчаст|сможете\s+привезти|подбор|подберите|цена|вариант|oem|артикул)/i;
const SERVICE_FRAME_LINE_RE = /-{20,}/;
const SERVICE_LEXEMES_RE =
  /(заказ\s*№|отслеживат|команда\s+[a-zа-я0-9_.-]+|интернет-?магазин|свяжутся)/i;

function normalizeStageKey(rawStage) {
  const stage = String(rawStage || "").trim().toUpperCase();
  if (!stage) return rawStage;
  const aliases = crmSettings?.stageAliases || {};
  return aliases[stage] || stage;
}

function isStageAllowedForDeliverySave(rawStage) {
  const s = String(rawStage || "").trim().toUpperCase();
  return s === "ADDRESS" || s === "FINAL" || s === "ABCP_CREATE";
}

function isLikelyServiceText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const frameCount = (t.match(new RegExp(SERVICE_FRAME_LINE_RE.source, "g")) || []).length;
  return frameCount >= 2 || SERVICE_LEXEMES_RE.test(t);
}

function isValidDeliveryAddress(raw) {
  const t = String(raw || "").trim();
  if (!t) return false;

  const lower = t.toLowerCase();
  if (lower.includes("самовывоз")) return true;
  if (isLikelyServiceText(t)) return false;

  const hasAddressWords = ADDRESS_WORD_RE.test(lower);
  const hasDigits = /\d/.test(lower);
  const hasComma = lower.includes(",");

  if (NON_ADDRESS_HINT_RE.test(lower) && !hasAddressWords) return false;
  if (lower.includes("?") && !hasAddressWords) return false;
  if (!hasDigits) return false;

  if (hasAddressWords) return true;
  return hasComma && lower.split(/\s+/).filter(Boolean).length >= 3;
}

export function applyLlmToSession(session, llm) {
  if (!session || !llm) return;

  session.state = session.state || {};

  if (llm.stage) session.state.stage = normalizeStageKey(llm.stage);
  if (llm.client_name) session.state.client_name = llm.client_name;

  // Адрес доставки сохраняем в сессию, чтобы не спрашивать повторно на следующих шагах
  const da = llm?.update_lead_fields?.DELIVERY_ADDRESS;
  const rawStage = String(llm?.stage || session?.state?.stage || "").trim().toUpperCase();
  if (
    typeof da === "string" &&
    isStageAllowedForDeliverySave(rawStage) &&
    isValidDeliveryAddress(da)
  ) {
    session.state.delivery_address = da.trim();
    session.state.DELIVERY_ADDRESS = da.trim();
  }

  if (llm.contact_update && llm.contact_update.phone) {
    session.phone = llm.contact_update.phone;
  }

  // сохраняем oems (для requested_oem на следующих шагах)
  if (Array.isArray(llm.oems) && llm.oems.length > 0) {
    session.state.oems = llm.oems;
  }

  // сохраняем offers (для стабильного выбора "вариант 1")
  if (Array.isArray(llm.offers) && llm.offers.length > 0) {
    session.state.offers = llm.offers;
  }

  if (llm.chosen_offer_id) {
    session.state.chosen_offer_id = llm.chosen_offer_id;
  }

  session.state.last_reply = llm.reply;
  session.updatedAt = Date.now();
}

export function normalizeOemCandidates(arr) {
  if (!Array.isArray(arr)) return [];
  return Array.from(new Set(arr.map((x) => String(x || "").trim()).filter(Boolean)));
}
