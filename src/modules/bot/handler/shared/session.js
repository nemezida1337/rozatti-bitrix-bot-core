// src/modules/bot/handler/shared/session.js

export function applyLlmToSession(session, llm) {
  if (!session || !llm) return;

  session.state = session.state || {};

  if (llm.stage) session.state.stage = llm.stage;
  if (llm.client_name) session.state.client_name = llm.client_name;

  // Адрес доставки сохраняем в сессию, чтобы не спрашивать повторно на следующих шагах
  const da = llm?.update_lead_fields?.DELIVERY_ADDRESS;
  if (typeof da === "string" && da.trim()) {
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
