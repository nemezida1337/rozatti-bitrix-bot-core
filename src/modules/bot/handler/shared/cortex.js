// src/modules/bot/handler/shared/cortex.js

import { logger } from "../../../../core/logger.js";
import { safeUpdateLeadAndContact } from "../../../crm/leads.js";
import { saveSession } from "../../sessionStore.js";

import { applyLlmToSession } from "./session.js";

const CTX = "modules/bot/handler/shared/cortex";

export function mapCortexResultToLlmResponse(cortex) {
  const ctx = `${CTX}.mapCortexResultToLlmResponse`;

  const payload = cortex?.result || {};
  const rootStage = cortex?.stage;
  const stage = payload.stage || rootStage || "NEW";

  const offers = Array.isArray(payload.offers) ? payload.offers : [];

  // chosen_offer_id может быть числом / строкой / массивом
  let chosenRaw = payload.chosen_offer_id;
  let chosenList = [];

  if (Array.isArray(chosenRaw)) {
    chosenList = chosenRaw;
  } else if (typeof chosenRaw === "number" || typeof chosenRaw === "string") {
    chosenList = [chosenRaw];
  }

  const normalizedChosen = chosenList
    .map((id) => {
      const n = Number(id);
      return Number.isFinite(n) ? n : null;
    })
    .filter((x) => x !== null);

  const offerIds = new Set(
    (offers || [])
      .map((o) => Number(o?.id))
      .filter((n) => Number.isFinite(n)),
  );

  const validChosen = normalizedChosen.filter((id) => offerIds.has(id));

  let chosenFinal = null;
  if (validChosen.length === 1) chosenFinal = validChosen[0];
  else if (validChosen.length > 1) chosenFinal = validChosen;

  const mapped = {
    action: payload.action ?? null,
    stage,
    reply: payload.reply || "",

    client_name: payload.client_name || null,
    oems: Array.isArray(payload.oems) ? payload.oems : [],

    update_lead_fields: payload.update_lead_fields || {},
    product_rows: Array.isArray(payload.product_rows) ? payload.product_rows : [],
    product_picks: Array.isArray(payload.product_picks) ? payload.product_picks : [],

    need_operator: !!payload.need_operator,

    offers,
    chosen_offer_id: chosenFinal,

    contact_update:
      payload.contact_update && typeof payload.contact_update === "object"
        ? payload.contact_update
        : null,
  };

  logger.debug({ ctx, mapped }, "Mapped CortexResult → LLM-формат");
  return mapped;
}

export async function processCortexResult(portalDomain, dialogId, session, cortexResult) {
  const ctx = `${CTX}.processCortexResult`;

  try {
    const llm = mapCortexResultToLlmResponse(cortexResult);

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

    return {
      reply: llm.reply,
      need_operator: !!llm.need_operator,
      action: llm.action,
    };
  } catch (err) {
    logger.error({ ctx, error: String(err) }, "Ошибка processCortexResult");
    return {
      reply: "Произошла ошибка, подключаю менеджера.",
      need_operator: true,
      action: "handover_operator",
    };
  }
}
