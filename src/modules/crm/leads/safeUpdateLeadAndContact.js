// src/modules/crm/leads/safeUpdateLeadAndContact.js

import { crmSettings } from "../../../config/settings.crm.js";
import { makeBitrixClient } from "../../../core/bitrixClient.js";
import { resolveCortexStage } from "../../../core/cortexContract.js";
import { logger } from "../../../core/logger.js";
import { getPortalAsync } from "../../../core/store.js";
import { detectOemsFromText } from "../../bot/oemDetector.js";
import { ensureContact } from "../contact/contactService.js";
import { getLead } from "../leadStateService.js";

import { updateLead, addLeadComment, setLeadProductRows } from "./updateLeadService.js";

const CTX = "modules/crm/leads/safeUpdateLeadAndContact";
const SERVICE_FRAME_LINE_RE = /-{20,}/;
const SERVICE_HEADER_RE = /^[^\n]{1,120}\[[^\]]{3,40}\]/m;
const SERVICE_LEXEMES_RE =
  /(заказ\s*№|отслеживат|команда\s+[a-zа-я0-9_.-]+|интернет-?магазин|свяжутся)/i;

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Нормализация телефона в формат 7XXXXXXXXXX
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return "7" + digits.slice(1);
  }

  if (digits.length === 10) {
    return "7" + digits;
  }

  return digits;
}

function buildProductRowsFromOffers(llm) {
  const offers = Array.isArray(llm.offers) ? llm.offers : [];
  if (!offers.length) return [];

  let chosenIdsRaw = [];
  if (Array.isArray(llm.chosen_offer_id)) {
    chosenIdsRaw = llm.chosen_offer_id;
  } else if (typeof llm.chosen_offer_id === "number" || typeof llm.chosen_offer_id === "string") {
    chosenIdsRaw = [llm.chosen_offer_id];
  }

  const chosenIds = chosenIdsRaw
    .map((id) => {
      const n = Number(id);
      return Number.isFinite(n) ? n : null;
    })
    .filter((n) => n !== null);

  let chosenOffers = [];

  if (chosenIds.length > 0) {
    chosenOffers = offers.filter((o) => chosenIds.includes(Number(o.id)));

    if (!chosenOffers.length) {
      logger.warn({ ctx: CTX, chosenIds }, "chosen_offer_id не найден — product_rows не создаём");
      return [];
    }
  } else {
    chosenOffers = offers;
  }

  return chosenOffers.map((offer) => ({
    PRODUCT_NAME: `${offer.brand || ""} ${offer.oem || ""}`.trim(),
    PRICE: offer.price,
    QUANTITY: offer.quantity && Number(offer.quantity) > 0 ? Number(offer.quantity) : 1,
  }));
}

function mapStageToStatus(stage) {
  if (!stage) return null;
  const stageProbe = resolveCortexStage(stage, { fallback: "NEW" });
  if (!stageProbe.isKnown && !stageProbe.isEmpty) {
    logger.warn(
      { ctx: CTX, stage: stageProbe.input },
      "Unknown stage in safeUpdateLeadAndContact: STATUS_ID update skipped",
    );
    return null;
  }

  const aliases = crmSettings.stageAliases || {};
  const normalizedStage = aliases[String(stageProbe.value).toUpperCase()] || stageProbe.value;
  const map = crmSettings.stageToStatusId || {};
  const mapped = map[normalizedStage] || null;
  if (mapped) return mapped;

  if (normalizedStage === "LOST") {
    const loss = crmSettings.lossStatusId || {};
    return loss.LOST || loss.BAD_LEAD || null;
  }

  return null;
}

function deriveContactUpdate(update_lead_fields, session) {
  const fields = update_lead_fields || {};

  let phoneRaw = fields.PHONE || session?.phone || null;
  const phone = normalizePhone(phoneRaw);

  if (!phone) return null;

  return {
    name: fields.NAME || null,
    last_name: fields.LAST_NAME || null,
    second_name: fields.SECOND_NAME || null,
    phone,
  };
}

function isLikelySystemLikeText(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  const frameCount = (t.match(new RegExp(SERVICE_FRAME_LINE_RE.source, "g")) || []).length;
  const hasFramedEnvelope = frameCount >= 2;
  const hasHeader = SERVICE_HEADER_RE.test(t);
  const hasServiceLexemes = SERVICE_LEXEMES_RE.test(t);

  return hasFramedEnvelope && (hasHeader || hasServiceLexemes);
}

function canonicalPhoneDigits(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return digits.slice(1);
  }
  if (digits.length === 10) return digits;
  return digits;
}

function phoneLooksDerivedFromOem({ phoneRaw, lastUserMessage }) {
  const msg = String(lastUserMessage || "").trim();
  if (!msg || !phoneRaw) return false;

  const phoneDigits = canonicalPhoneDigits(phoneRaw);
  if (!phoneDigits) return false;

  const oems = detectOemsFromText(msg);
  if (!Array.isArray(oems) || oems.length === 0) return false;

  return oems.some((oem) => {
    const oemDigits = canonicalPhoneDigits(oem);
    return !!oemDigits && oemDigits === phoneDigits;
  });
}

/**
 * Адрес доставки пишем ТОЛЬКО в лид (не в контакт) и только на стадиях ADDRESS/FINAL.
 * Это защищает от преждевременной записи адреса в CRM.
 */
function isStageForDeliveryWrite(stage) {
  const s = String(stage || "").toUpperCase();
  const fromCfg = crmSettings.deliveryWriteStages;
  const allowed =
    Array.isArray(fromCfg) && fromCfg.length > 0
      ? fromCfg.map((x) => String(x).toUpperCase())
      : ["ADDRESS", "FINAL", "ABCP_CREATE"];
  return allowed.includes(s);
}

/**
 * Какие стадии считаем "финальными" для автозаполнения контакта и товаров.
 * По умолчанию — только FINAL.
 * Можно расширить конфигом: crmSettings.enrichmentFinalStages = ["FINAL","ADDRESS"]
 */
function isFinalStageForEnrichment(stage) {
  const fromCfg = crmSettings.enrichmentFinalStages;
  const finalStages = Array.isArray(fromCfg) && fromCfg.length > 0 ? fromCfg : ["FINAL"];
  const s = String(stage || "").toUpperCase();
  return finalStages.map((x) => String(x).toUpperCase()).includes(s);
}

/**
 * Правило OEM (10/10):
 * - Если OEM > 1 (multi) — UF_OEM НЕ пишем до выбора (chosen_offer_id).
 * - UF_OEM пишем только:
 *   a) по выбранному offer (валидный chosen_offer_id → offer найден → offer.oem)
 *   b) либо когда есть ровно 1 уникальный OEM в oems (безопасно)
 */
function deriveOemToSet({ chosen_offer_id, offers, oems }) {
  const offersArr = Array.isArray(offers) ? offers : [];
  const oemsArr = Array.isArray(oems) ? oems : [];

  // chosen_offer_id может быть числом/строкой/массивом — тут нам нужен один выбранный (для UF_OEM)
  let chosenId = null;
  if (Array.isArray(chosen_offer_id) && chosen_offer_id.length > 0) {
    // если выбрали несколько — в UF_OEM всё равно писать нельзя (пусть остаётся менеджерский/прошлый)
    // но если там один — можно
    if (chosen_offer_id.length === 1) chosenId = chosen_offer_id[0];
    else return { oemToSet: null, reason: "multi_choice" };
  } else if (typeof chosen_offer_id === "number" || typeof chosen_offer_id === "string") {
    chosenId = chosen_offer_id;
  }

  if (chosenId !== null) {
    const chosen = offersArr.find((o) => Number(o.id) === Number(chosenId));
    if (chosen?.oem) {
      return { oemToSet: String(chosen.oem).trim(), reason: "chosen_offer" };
    }
    return { oemToSet: null, reason: "chosen_not_found" };
  }

  // fallback: если oems содержит ровно 1 уникальный элемент — можно безопасно
  const uniq = Array.from(new Set(oemsArr.map((x) => String(x || "").trim()).filter(Boolean)));
  if (uniq.length === 1) {
    return { oemToSet: uniq[0], reason: "single_oem" };
  }

  // multi OEM без выбора → запрещено писать UF_OEM
  if (uniq.length > 1) {
    return { oemToSet: null, reason: "multi_oem_no_choice" };
  }

  return { oemToSet: null, reason: "no_oem" };
}

function isLeadConvertedInSession(session) {
  const conversion = session?.lastLeadConversion;
  if (!conversion || !conversion.ok) return false;

  const dealId = toPositiveInt(conversion.dealId);
  if (dealId) return true;

  const reason = String(conversion.reason || "")
    .trim()
    .toUpperCase();
  return reason.includes("CONVERTED") || reason.includes("DEAL_CREATED_BY_FALLBACK");
}

function computeRowsOpportunity(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let total = 0;
  for (const row of list) {
    const price = Number(row?.PRICE ?? row?.price ?? 0);
    const qty = Number(row?.QUANTITY ?? row?.quantity ?? 1);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
    total += price * qty;
  }
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function syncConvertedDeal({
  portal,
  portalCfg,
  leadId,
  dealId,
  ensuredContactId = null,
  rows = [],
  ctx,
}) {
  const dealIdNum = toPositiveInt(dealId);
  const leadIdNum = toPositiveInt(leadId);
  if (!dealIdNum || !leadIdNum || !portalCfg?.baseUrl || !portalCfg?.accessToken) return;

  const api = makeBitrixClient({
    domain: portal,
    baseUrl: portalCfg.baseUrl,
    accessToken: portalCfg.accessToken,
  });

  let contactId = toPositiveInt(ensuredContactId);
  if (!contactId) {
    try {
      const lead = await api.call("crm.lead.get", { id: leadIdNum });
      contactId = toPositiveInt(lead?.CONTACT_ID);
    } catch (err) {
      logger.warn(
        { ctx, portal, leadId: leadIdNum, dealId: dealIdNum, err: String(err) },
        "Не удалось получить CONTACT_ID лида для синхронизации сделки",
      );
    }
  }

  const rowsToSet = Array.isArray(rows) ? rows : [];
  if (rowsToSet.length > 0) {
    try {
      await api.call("crm.deal.productrows.set", {
        id: dealIdNum,
        rows: rowsToSet,
      });
    } catch (err) {
      logger.warn(
        { ctx, portal, leadId: leadIdNum, dealId: dealIdNum, err: String(err) },
        "Не удалось записать product rows в сделку после конверсии",
      );
    }
  }

  const fields = {
    LEAD_ID: leadIdNum,
  };

  if (contactId) {
    fields.CONTACT_ID = contactId;
    fields.CONTACT_IDS = [contactId];
  }

  const total = computeRowsOpportunity(rowsToSet);
  if (total !== null) {
    fields.OPPORTUNITY = total;
  }

  try {
    await api.call("crm.deal.update", {
      id: dealIdNum,
      fields,
    });
  } catch (err) {
    logger.warn(
      { ctx, portal, leadId: leadIdNum, dealId: dealIdNum, fields, err: String(err) },
      "Не удалось синхронизировать сделку после конверсии",
    );
  }
}

export async function safeUpdateLeadAndContact(params) {
  const { portal, dialogId, chatId, session, llm, lastUserMessage, usedBackend } = params || {};

  const ctx = `${CTX}.safeUpdateLeadAndContact`;

  try {
    if (!portal || !dialogId || !session || !llm) return;

    const portalCfg = await getPortalAsync(portal);
    if (!portalCfg) return;

    const leadId = session.leadId;
    if (!leadId) return;

    const {
      stage: llmStage,
      action,
      oems = [],
      update_lead_fields = {},
      product_rows = [],
      offers = [],
      chosen_offer_id,
      contact_update,
    } = llm;

    const stage = llmStage || session?.state?.stage || "NEW";
    // ---------- lastUserMessage (не затираем пустым/NULL) ----------
    let effectiveLastUserMessage =
      typeof lastUserMessage === "string" ? lastUserMessage.trim() : lastUserMessage;

    if (!effectiveLastUserMessage) {
      const fromSession =
        typeof session?.lastUserMessage === "string" && session.lastUserMessage.trim()
          ? session.lastUserMessage.trim()
          : typeof session?.state?.lastUserMessage === "string" &&
              session.state.lastUserMessage.trim()
            ? session.state.lastUserMessage.trim()
            : null;
      if (fromSession) effectiveLastUserMessage = fromSession;
    }

    if (!effectiveLastUserMessage && crmSettings.leadFields?.HF_CORTEX_LOG) {
      try {
        const lead = await getLead({
          domain: portal,
          baseUrl: portalCfg.baseUrl,
          accessToken: portalCfg.accessToken,
          leadId,
        });

        const rawLog = lead?.[crmSettings.leadFields.HF_CORTEX_LOG];
        if (rawLog) {
          const parsed = typeof rawLog === "string" ? JSON.parse(rawLog) : rawLog;
          const prev = parsed?.lastUserMessage;
          if (typeof prev === "string" && prev.trim()) {
            effectiveLastUserMessage = prev.trim();
          }
        }
      } catch (err) {
        logger.warn(
          { ctx, leadId, err: err?.message || String(err) },
          "Не смогли восстановить lastUserMessage из HF_CORTEX_LOG",
        );
      }
    }

    // =========================
    // 1) ОБНОВЛЕНИЕ ЛИДА
    // =========================

    const leadFieldsToUpdate = {};

    const statusId = mapStageToStatus(stage);
    const successStatusId = crmSettings?.stageToStatusId?.SUCCESS || null;
    if (isLeadConvertedInSession(session) && successStatusId) {
      leadFieldsToUpdate.STATUS_ID = successStatusId;
    } else if (statusId) {
      leadFieldsToUpdate.STATUS_ID = statusId;
    }

    // ---------- OEM (КЛЮЧЕВОЕ ПРАВИЛО 10/10) ----------
    const { oemToSet, reason: oemReason } = deriveOemToSet({
      chosen_offer_id,
      offers,
      oems,
    });

    // комментарий — только на abcp_lookup (как было)
    // Комментируем OEM даже если multi (а UF не пишем) — для аудита
    if (action === "abcp_lookup") {
      const uniq = Array.from(
        new Set(
          (Array.isArray(oems) ? oems : []).map((x) => String(x || "").trim()).filter(Boolean),
        ),
      );
      const oemForComment = oemToSet || (uniq.length > 0 ? uniq.join(", ") : null);

      if (oemForComment) {
        try {
          await addLeadComment(portal, leadId, `OEM: ${oemForComment}`);
        } catch (err) {
          logger.error(
            { ctx, leadId, oemForComment, err: err?.message || String(err) },
            "Ошибка addLeadComment",
          );
        }
      }
    }

    // UF-поле OEM — ТОЛЬКО если разрешено правилом
    if (oemToSet && crmSettings.leadFields?.OEM) {
      leadFieldsToUpdate[crmSettings.leadFields.OEM] = oemToSet;
      // синхронизируем lastSeenLeadOem, чтобы не срабатывал ложный MANAGER_OEM_TRIGGER
      session.lastSeenLeadOem = String(oemToSet).trim();
    } else if (oemReason === "multi_oem_no_choice" || oemReason === "multi_choice") {
      logger.info(
        { ctx, leadId, oemReason, oems, chosen_offer_id },
        "UF_OEM не обновляем: multi OEM / multi choice без однозначного выбора",
      );
    }

    // ---------- update_lead_fields ----------
    if (update_lead_fields && typeof update_lead_fields === "object") {
      const cloned = { ...update_lead_fields };

      // --- Доставка: используем только ключ DELIVERY_ADDRESS (CLIENT_ADDRESS больше не поддерживаем) ---
      let deliveryAddressRaw = null;
      if (typeof cloned.DELIVERY_ADDRESS === "string" && cloned.DELIVERY_ADDRESS.trim()) {
        deliveryAddressRaw = cloned.DELIVERY_ADDRESS.trim();
      }

      // Логические поля доставки не должны напрямую уходить в crm.lead.update
      delete cloned.CLIENT_ADDRESS;
      delete cloned.DELIVERY_ADDRESS;

      if (typeof cloned.PHONE === "string") {
        if (
          phoneLooksDerivedFromOem({
            phoneRaw: cloned.PHONE,
            lastUserMessage: effectiveLastUserMessage,
          })
        ) {
          logger.warn(
            { ctx, leadId, phone: cloned.PHONE, lastUserMessage: effectiveLastUserMessage },
            "Пропускаем PHONE: похоже на OEM из последнего сообщения",
          );
          delete cloned.PHONE;
        }
      }

      if (typeof cloned.PHONE === "string") {
        const norm = normalizePhone(cloned.PHONE);
        if (norm) {
          cloned.PHONE = [{ VALUE: norm, VALUE_TYPE: "WORK" }];
        } else {
          delete cloned.PHONE;
        }
      }

      Object.assign(leadFieldsToUpdate, cloned);

      // Запись адреса доставки строго в UF лида
      if (
        deliveryAddressRaw &&
        crmSettings.leadFields?.DELIVERY_ADDRESS &&
        isStageForDeliveryWrite(stage) &&
        !isLikelySystemLikeText(deliveryAddressRaw)
      ) {
        leadFieldsToUpdate[crmSettings.leadFields.DELIVERY_ADDRESS] = deliveryAddressRaw;
      } else if (deliveryAddressRaw && isLikelySystemLikeText(deliveryAddressRaw)) {
        logger.warn(
          { ctx, leadId, deliveryAddressRaw },
          "Пропускаем DELIVERY_ADDRESS: похоже на служебный/пересланный текст",
        );
      }
    }

    // ---------- HF_CORTEX_LOG ----------
    if (crmSettings.leadFields?.HF_CORTEX_LOG) {
      leadFieldsToUpdate[crmSettings.leadFields.HF_CORTEX_LOG] = JSON.stringify({
        ts: new Date().toISOString(),
        backend: usedBackend || "HF_CORTEX",
        stage,
        action,
        oems,
        chosen_offer_id,
        lastUserMessage: effectiveLastUserMessage || null,
      });
    }

    if (Object.keys(leadFieldsToUpdate).length > 0) {
      await updateLead(portal, leadId, leadFieldsToUpdate);
    }

    // =========================
    // 2) КОНТАКТ
    // =========================

    const isFinalStage = isFinalStageForEnrichment(stage);
    let effectiveContactUpdate = contact_update || deriveContactUpdate(update_lead_fields, session);
    let ensuredContactId = null;

    if (isFinalStage && effectiveContactUpdate) {
      const phone = normalizePhone(effectiveContactUpdate.phone || session?.phone);
      if (phone) {
        ensuredContactId = await ensureContact(portal, leadId, {
          NAME: effectiveContactUpdate.name,
          LAST_NAME: effectiveContactUpdate.last_name,
          SECOND_NAME: effectiveContactUpdate.second_name,
          PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }],
        });
      }
    }

    // =========================
    // 3) PRODUCT ROWS
    // =========================

    let rowsForLead = [];
    if (isFinalStage) {
      rowsForLead = product_rows.length > 0 ? product_rows : buildProductRowsFromOffers(llm);

      if (rowsForLead.length > 0) {
        await setLeadProductRows(portal, leadId, rowsForLead);
      }
    }

    const convertedDealId = toPositiveInt(session?.lastLeadConversion?.dealId);
    if (isFinalStage && convertedDealId) {
      await syncConvertedDeal({
        portal,
        portalCfg,
        leadId,
        dealId: convertedDealId,
        ensuredContactId,
        rows: rowsForLead,
        ctx,
      });
    }

    logger.info({ ctx, portal, dialogId, chatId, leadId, stage }, "safeUpdateLeadAndContact done");
  } catch (err) {
    logger.error({ ctx, error: String(err) }, "safeUpdateLeadAndContact failed");
  }
}
