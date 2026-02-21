// src/modules/bot/handler/flows/cortexTwoPassFlow.js
//
// 4) Стандартный путь: ДВА вызова HF-CORTEX
// Вынесено из handler_llm_manager.js без изменения поведения.

import { callCortexLeadSales } from "../../../../core/hfCortexClient.js";
import { logger } from "../../../../core/logger.js";
import { convertLeadToDealAfterAbcpOrder } from "../../../crm/leads/convertLeadToDealService.js";
import { safeUpdateLeadAndContact } from "../../../crm/leads.js";
import { abcpLookupFromText } from "../../../external/pricing/abcp.js";
import { createAbcpOrderFromSession } from "../../../external/pricing/abcpOrder.js";
import { saveSession } from "../../sessionStore.js";
import { sendChatReplyIfAllowed } from "../shared/chatReply.js";
import { mapCortexResultToLlmResponse } from "../shared/cortex.js";
import { appendSessionHistoryTurn } from "../shared/historyContext.js";
import { normalizeOemCandidates, applyLlmToSession } from "../shared/session.js";

const ADDRESS_WORD_RE =
  /\b(ул|улица|дом|д\.|д |кв|квартира|корп|корпус|проспект|пр-т|шоссе|пер|переулок|проезд|г\.|город)\b/i;
const NON_ADDRESS_HINT_RE =
  /(нужна\s+запчаст|сможете\s+привезти|подбор|подберите|цена|вариант|oem|артикул)/i;
const SERVICE_FRAME_LINE_RE = /-{20,}/;
const SERVICE_LEXEMES_RE =
  /(заказ\s*№|отслеживат|команда\s+[a-zа-я0-9_.-]+|интернет-?магазин|свяжутся)/i;

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

function normalizeOrderNumbers(orderNumbers) {
  if (!Array.isArray(orderNumbers)) return [];
  return Array.from(
    new Set(orderNumbers.map((x) => String(x || "").trim()).filter(Boolean)),
  );
}

function makeLeadConversionKey({ leadId, orderNumbers }) {
  return `${leadId}|${orderNumbers.join(",")}`;
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return "7" + digits.slice(1);
  }
  if (digits.length === 10) return "7" + digits;
  return digits.length >= 10 ? digits : null;
}

function parseChosenIds(chosen_offer_id) {
  const list = Array.isArray(chosen_offer_id)
    ? chosen_offer_id
    : chosen_offer_id != null
      ? [chosen_offer_id]
      : [];

  return list
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .map((x) => Number(x));
}

function hasSelectedOffer(llm, session) {
  const chosenIds = parseChosenIds(llm?.chosen_offer_id ?? session?.state?.chosen_offer_id);
  if (!chosenIds.length) return false;

  const offers = Array.isArray(llm?.offers) && llm.offers.length > 0
    ? llm.offers
    : Array.isArray(session?.state?.offers)
      ? session.state.offers
      : [];

  if (!offers.length) return false;
  return offers.some((offer) => chosenIds.includes(Number(offer?.id)));
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
  if (isLikelyServiceText(lower)) return false;

  const hasAddressWords = ADDRESS_WORD_RE.test(lower);
  const hasDigits = /\d/.test(lower);
  const hasComma = lower.includes(",");

  if (NON_ADDRESS_HINT_RE.test(lower) && !hasAddressWords) return false;
  if (lower.includes("?") && !hasAddressWords) return false;
  if (!hasDigits) return false;
  if (hasAddressWords) return true;

  return hasComma && lower.split(/\s+/).filter(Boolean).length >= 3;
}

function hasDeliveryAddress(llm, session) {
  const candidates = [
    llm?.update_lead_fields?.DELIVERY_ADDRESS,
    session?.state?.delivery_address,
    session?.state?.DELIVERY_ADDRESS,
  ];
  return candidates.some((x) => isValidDeliveryAddress(x));
}

function hasPhone(llm, session) {
  const candidates = [
    llm?.contact_update?.phone,
    llm?.update_lead_fields?.PHONE,
    session?.phone,
  ];
  return candidates.some((x) => !!normalizePhone(x));
}

function shouldCreateAbcpOrder(llm, session) {
  const llmStage = String(llm?.stage || "").toUpperCase();
  const sessionStage = String(session?.state?.stage || "").toUpperCase();
  const stage = llmStage || sessionStage;
  const action = String(llm?.action || "").toLowerCase();

  // Заказы не создаём на эскалации/потере, даже если технически есть выбранный оффер.
  if (llm?.need_operator === true) return false;
  if (action === "handover_operator") return false;
  if (stage === "LOST") return false;

  if (stage !== "ABCP_CREATE" && stage !== "FINAL") return false;

  if (session?.lastAbcpOrder && Array.isArray(session.lastAbcpOrder.orderNumbers)) {
    if (session.lastAbcpOrder.orderNumbers.length > 0) return false;
  }

  if (!hasSelectedOffer(llm, session)) return false;
  if (!hasPhone(llm, session)) return false;
  if (!hasDeliveryAddress(llm, session)) return false;

  return true;
}

function setLastCortexDecision(session, llm, pass) {
  if (!session || !llm) return;
  session.lastCortexDecision = {
    pass: pass || null,
    intent: llm.intent || null,
    action: llm.action || null,
    stage: llm.stage || null,
    confidence: Number.isFinite(Number(llm.confidence)) ? Number(llm.confidence) : null,
    requires_clarification: !!llm.requires_clarification,
    need_operator: !!llm.need_operator,
    at: Date.now(),
  };
}

async function tryConvertLeadAfterAbcpOrder({
  api,
  portalDomain,
  session,
  dialogId,
  orderNumbers,
  baseCtx,
}) {
  const leadId = toPositiveInt(session?.leadId);
  const normalizedOrderNumbers = normalizeOrderNumbers(orderNumbers);

  if (!leadId || normalizedOrderNumbers.length === 0) return;

  const conversionKey = makeLeadConversionKey({
    leadId,
    orderNumbers: normalizedOrderNumbers,
  });

  if (
    session?.lastLeadConversion &&
    session.lastLeadConversion.ok &&
    session.lastLeadConversion.key === conversionKey
  ) {
    logger.info(
      { ctx: `${baseCtx}.LEAD_CONVERT`, dialogId, leadId, conversionKey },
      "Конверсия лида уже выполнена, повтор пропускаем",
    );
    return;
  }

  try {
    const converted = await convertLeadToDealAfterAbcpOrder({
      api,
      portal: portalDomain,
      leadId,
      orderNumbers: normalizedOrderNumbers,
      dialogId,
    });

    session.lastLeadConversion = {
      key: conversionKey,
      ok: !!converted?.ok,
      reason: converted?.reason || null,
      dealId: converted?.dealId || null,
      orderNumbers: normalizedOrderNumbers,
      at: Date.now(),
    };

    if (converted?.ok) {
      logger.info(
        {
          ctx: `${baseCtx}.LEAD_CONVERT`,
          dialogId,
          leadId,
          dealId: converted?.dealId || null,
          reason: converted?.reason || "OK",
        },
        "Лид автоматически переведен в сделку после заказа ABCP",
      );
    } else {
      logger.warn(
        {
          ctx: `${baseCtx}.LEAD_CONVERT`,
          dialogId,
          leadId,
          reason: converted?.reason || "UNKNOWN",
        },
        "Не удалось перевести лид в сделку после заказа ABCP",
      );
    }
  } catch (err) {
    session.lastLeadConversion = {
      key: conversionKey,
      ok: false,
      reason: "CONVERT_EXCEPTION",
      dealId: null,
      orderNumbers: normalizedOrderNumbers,
      at: Date.now(),
    };

    logger.error(
      {
        ctx: `${baseCtx}.LEAD_CONVERT`,
        dialogId,
        leadId,
        error: String(err),
      },
      "Ошибка конверсии лида в сделку после заказа ABCP",
    );
  }
}

async function tryCreateAbcpOrderIfNeeded({
  llm,
  api,
  portalDomain,
  session,
  dialogId,
  baseCtx,
}) {
  if (!shouldCreateAbcpOrder(llm, session)) return llm;

  const created = await createAbcpOrderFromSession({ session, llm, dialogId });

  session.lastAbcpOrder = {
    ok: !!created.ok,
    reason: created.reason || null,
    orderNumbers: Array.isArray(created.orderNumbers) ? created.orderNumbers : [],
    at: Date.now(),
  };

  if (created.ok && created.orderNumbers.length > 0) {
    const suffix = ` Заказ в ABCP оформлен: №${created.orderNumbers.join(", ")}.`;
    llm.reply = `${String(llm.reply || "").trim()}${suffix}`.trim();
    await tryConvertLeadAfterAbcpOrder({
      api,
      portalDomain,
      session,
      dialogId,
      orderNumbers: created.orderNumbers,
      baseCtx,
    });
  } else if (!created.ok && !String(llm.reply || "").trim()) {
    llm.reply = "Не удалось автоматически оформить заказ в ABCP, передаю менеджеру.";
  }

  return llm;
}

export async function runCortexTwoPassFlow({
  api,
  portalDomain,
  portalCfg,
  dialogId,
  chatId,
  text,
  session,
  baseCtx = "modules/bot/handler_llm_manager",
}) {
  const ctx = `${baseCtx}.processIncomingBitrixMessage`;
  const sendBotReply = async (message, kind = null) => {
    const safeMessage = String(message || "").trim();
    if (!safeMessage) return;

    const sent = await sendChatReplyIfAllowed({
      api,
      portalDomain,
      portalCfg,
      dialogId,
      leadId: session.leadId,
      dealId: session?.dealId || null,
      message: safeMessage,
    });
    if (!sent) return;

    appendSessionHistoryTurn(session, {
      role: "bot",
      text: safeMessage,
      kind: kind || "bot_reply",
      ts: Date.now(),
    });
  };

  // ✅ если есть offers в сессии — прокидываем их в Cortex, чтобы выбор по id был стабильным
  const sessionOffers =
    session?.state?.offers &&
    Array.isArray(session.state.offers) &&
    session.state.offers.length > 0
      ? session.state.offers
      : null;

  // 4.1. ПЕРВЫЙ ВЫЗОВ HF-CORTEX
  const cortexRaw1 = await callCortexLeadSales(
    {
      msg: { text },
      sessionSnapshot: session,
      ...(session.abcp ? { injected_abcp: session.abcp } : {}),
      ...(sessionOffers ? { offers: sessionOffers } : {}),
    },
    logger,
  );

  logger.info(
    { ctx: `${ctx}.CORTEX_FIRST_PASS`, cortexRaw: cortexRaw1 },
    "[HF-CORTEX] response (first pass)",
  );

  if (!cortexRaw1) {
    logger.warn({ ctx }, "HF-CORTEX вернул null, шлём fallback");
    session.lastCortexDecision = null;
    await sendBotReply(
      "Сервис временно недоступен, менеджер скоро подключится.",
      "cortex_fallback_first_pass",
    );
    session.lastCortexRoute = "cortex_fallback_first_pass";
    saveSession(portalDomain, dialogId, session);
    return true;
  }

  let llm1 = mapCortexResultToLlmResponse(cortexRaw1);
  setLastCortexDecision(session, llm1, "first");
  // Синхронизируем актуальные контакт/адрес/выбор в session до попытки авто-заказа.
  // Иначе TS fallback может не увидеть телефон/адрес из текущего сообщения.
  applyLlmToSession(session, llm1);
  llm1 = await tryCreateAbcpOrderIfNeeded({
    llm: llm1,
    api,
    portalDomain,
    session,
    dialogId,
    baseCtx,
  });

  // ✅ NEW: фиксируем кандидатов OEM при запросе ABCP
  if (llm1.action === "abcp_lookup" && Array.isArray(llm1.oems) && llm1.oems.length > 0) {
    session.oem_candidates = normalizeOemCandidates(llm1.oems);
  }

  await safeUpdateLeadAndContact({
    portal: portalDomain,
    dialogId,
    chatId,
    session,
    llm: llm1,
    lastUserMessage: text,
    usedBackend: "HF_CORTEX",
  });

  applyLlmToSession(session, llm1);
  session.lastCortexRoute = "cortex_first_pass_reply";
  await sendBotReply(llm1.reply || "…", "cortex_first_pass_reply");
  saveSession(portalDomain, dialogId, session);

  // 5) ВТОРОЙ ПРОХОД: ABCP → HF-CORTEX (офферы)
  if (llm1.action === "abcp_lookup" && Array.isArray(llm1.oems) && llm1.oems.length > 0) {
    const ctxAbcp = `${baseCtx}.ABCP_SECOND_PASS`;

    logger.info({ ctx: ctxAbcp, oems: llm1.oems, text }, "Запускаем второй проход ABCP");

    try {
      const abcpData = await abcpLookupFromText(text, llm1.oems);

      logger.info(
        { ctx: ctxAbcp, abcpKeys: Object.keys(abcpData || {}) },
        "ABCP данные получены",
      );

      if (abcpData && Object.keys(abcpData).length > 0) {
        // Кешируем ABCP-ответ в сессии для последующих сообщений
        session.abcp = abcpData;

        // ✅ на втором проходе offers из сессии обычно ещё пусты — но на ретраях могут быть
        const sessionOffers2 =
          session?.state?.offers &&
          Array.isArray(session.state.offers) &&
          session.state.offers.length > 0
            ? session.state.offers
            : null;

        const cortexRaw2 = await callCortexLeadSales(
          {
            msg: { text },
            sessionSnapshot: session,
            injected_abcp: abcpData,
            ...(sessionOffers2 ? { offers: sessionOffers2 } : {}),
          },
          logger,
        );

        logger.info(
          { ctx: `${ctxAbcp}.CORTEX_SECOND_PASS`, cortexRaw: cortexRaw2 },
          "[HF-CORTEX] response (second pass)",
        );

        if (!cortexRaw2) {
          logger.warn({ ctx: ctxAbcp }, "Второй вызов Cortex вернул null");
          session.lastCortexRoute = "cortex_second_pass_null";
          saveSession(portalDomain, dialogId, session);
          return true;
        }

        let llm2 = mapCortexResultToLlmResponse(cortexRaw2);
        setLastCortexDecision(session, llm2, "second");
        // Синхронизация перед авто-заказом на втором проходе (ABCP_CREATE/FINAL).
        applyLlmToSession(session, llm2);
        llm2 = await tryCreateAbcpOrderIfNeeded({
          llm: llm2,
          api,
          portalDomain,
          session,
          dialogId,
          baseCtx,
        });

        const noProgress =
          llm2.action === "abcp_lookup" && (!llm2.offers || llm2.offers.length === 0);

        if (noProgress) {
          logger.warn(
            { ctx: ctxAbcp, llm2 },
            "Второй проход Cortex не дал прогресса — не отправляем повторный ответ клиенту",
          );
          session.lastCortexRoute = "cortex_second_pass_no_progress";
          saveSession(portalDomain, dialogId, session);
          return true;
        }

        await safeUpdateLeadAndContact({
          portal: portalDomain,
          dialogId,
          chatId,
          session,
          llm: llm2,
          lastUserMessage: text,
          usedBackend: "HF_CORTEX",
        });

        applyLlmToSession(session, llm2);
        session.lastCortexRoute = "cortex_second_pass_reply";
        await sendBotReply(llm2.reply || "…", "cortex_second_pass_reply");
        saveSession(portalDomain, dialogId, session);
      } else {
        logger.info({ ctx: ctxAbcp }, "ABCP не вернул данных, второй проход Cortex пропущен");
        session.lastCortexRoute = "cortex_second_pass_skipped_no_abcp";
        saveSession(portalDomain, dialogId, session);
      }
    } catch (err) {
      logger.error(
        { ctx: ctxAbcp, error: String(err) },
        "Ошибка ABCP/Cortex на втором проходе, передаём на менеджера",
      );
      await sendBotReply(
        "Не получилось автоматически подобрать варианты, передаю ваш запрос менеджеру.",
        "cortex_second_pass_error",
      );
      session.lastCortexRoute = "cortex_second_pass_error";
      saveSession(portalDomain, dialogId, session);
    }
  }

  return true;
}

export default { runCortexTwoPassFlow };
