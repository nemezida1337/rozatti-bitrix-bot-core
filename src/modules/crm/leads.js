// src/modules/crm/leads.js
// Единая обёртка над CRM Bitrix24 для работы с лидами + высокоуровневая
// функция safeUpdateLeadAndContact, которая:
//  - гарантирует наличие лида для диалога
//  - обновляет поля лида по LLM-контракту
//  - двигает лид по стадиям
//  - синхронизирует Контакт (ФИО, телефон, адрес)
//  - при необходимости записывает товары (product rows)

import { crmSettings } from "../../../config/settings.crm.js";
import { logger } from "../../core/logger.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";
import { createContactService, parseFullName as parseFullNameStandalone } from "./contactService.js";

const CTX = "crm/leads";

// Маппинг наших внутренних стадий (LLM_STAGES) в STATUS_ID Bitrix.
// Можно переопределить через crmSettings.stageToStatusId.
const DEFAULT_STAGE_TO_STATUS_ID = {
  NEW: "NEW",          // новый лид
  PRICING: "IN_PROCESS",
  CONTACT: "IN_PROCESS",
  FINAL: "IN_PROCESS",
};

function getStageToStatusMap() {
  const cfg = crmSettings?.stageToStatusId || {};
  return { ...DEFAULT_STAGE_TO_STATUS_ID, ...cfg };
}

const STAGE_TO_STATUS_ID = getStageToStatusMap();

/**
 * Построить поля лида при первом создании из сессии.
 *
 * session:
 *   - state.stage         — стадия воронки LLM
 *   - state.client_name   — имя / ФИО клиента (по версии LLM)
 *   - name                — полное ФИО (если уже есть)
 *   - phone               — телефон
 *   - address             — адрес доставки / ПВЗ
 *   - lastQuery           — последний текст запроса
 */
export function buildLeadFieldsFromSession(session = {}, dialogMeta = {}) {
  const name =
    session.name ||
    session.state?.client_name ||
    "";

  const phone = session.phone || null;
  const address = session.address || null;
  const COMMENTS = session.lastQuery || "";

  const SOURCE_ID =
    dialogMeta.source ||
    crmSettings?.sourceId ||
    "OPENLINES";

  const fields = {
    TITLE: name
      ? `Запрос запчастей: ${name}`
      : "Запрос запчастей (бот)",
    NAME: name || "",
    SOURCE_ID,
  };

  if (COMMENTS) {
    fields.COMMENTS = COMMENTS;
  }

  if (phone) {
    fields.PHONE = [
      {
        VALUE: phone,
        VALUE_TYPE: "WORK",
      },
    ];
  }

  if (address) {
    fields.ADDRESS = address;
  }

  return fields;
}

/**
 * Построить product rows для crm.lead.productrows.set из picks ABCP.
 *
 * picks — массив объектов формата:
 *   { idx, qty, item: { oem, offer, days, daysText, brand, name, priceNum } }
 *
 * (эту структуру можно формировать из второго ответа LLM по ABCP)
 */
function buildProductRowsFromSelection(picks = []) {
  const rows = [];

  for (const p of picks) {
    if (!p || !p.item) continue;

    const { oem, offer, brand, name, priceNum } = p.item;

    let price =
      typeof priceNum === "number" && Number.isFinite(priceNum)
        ? priceNum
        : Number(
            String((offer && offer.price) ?? "").replace(",", "."),
          );

    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }

    const quantity = p.qty && Number(p.qty) > 0 ? Number(p.qty) : 1;

    const productName =
      name ||
      (brand && oem ? `${brand} ${oem}` : oem) ||
      "Запчасть";

    rows.push({
      PRODUCT_NAME: productName,
      PRICE: price,
      QUANTITY: quantity,
      CURRENCY_ID: "RUB",
    });
  }

  return rows;
}

/**
 * Фабрика API для работы с лидами.
 *
 * @param {object} rest - клиент, у которого есть метод call(method, params)
 */
export function createLeadsApi(rest) {
  if (!rest || typeof rest.call !== "function") {
    throw new Error("[crm/leads] createLeadsApi: rest.call is required");
  }

  /**
   * Создать лид по данным сессии.
   */
  async function createLeadFromSession(session, dialogMeta = {}) {
    const fields = buildLeadFieldsFromSession(session, dialogMeta);

    const result = await rest.call("crm.lead.add", { fields });
    const leadId = Number(result);

    if (!leadId || Number.isNaN(leadId)) {
      throw new Error(
        `[crm/leads] crm.lead.add вернул некорректный id: ${result}`,
      );
    }

    logger.info(
      { ctx: CTX, leadId, dialogId: dialogMeta.dialogId },
      "Лид создан",
    );

    return leadId;
  }

  /**
   * Частичное обновление лида.
   */
  async function updateLead(leadId, fields = {}) {
    if (!leadId) {
      throw new Error("[crm/leads] updateLead: leadId is required");
    }
    if (!fields || !Object.keys(fields).length) {
      return true;
    }

    await rest.call("crm.lead.update", {
      id: leadId,
      fields,
    });

    logger.info({ ctx: CTX, leadId, fields }, "Лид обновлён");
    return true;
  }

  /**
   * Установить статус лида по стадии LLM.
   */
  async function setLeadStage(leadId, stage) {
    if (!leadId || !stage) {
      return false;
    }

    const statusId = STAGE_TO_STATUS_ID[stage];
    if (!statusId) {
      logger.warn(
        { ctx: CTX, leadId, stage },
        "[crm/leads] Unknown stage, skip setLeadStage",
      );
      return false;
    }

    return updateLead(leadId, { STATUS_ID: statusId });
  }

  /**
   * Добавить комментарий к лиду (через поле COMMENTS — простой вариант).
   */
  async function appendComment(leadId, comment) {
    if (!leadId || !comment) return false;

    let lead;
    try {
      lead = await rest.call("crm.lead.get", { id: leadId });
    } catch (e) {
      logger.warn(
        { ctx: CTX, leadId, error: String(e) },
        "[crm/leads] crm.lead.get failed в appendComment",
      );
      return false;
    }

    const prev = (lead && lead.COMMENTS) || "";
    const next = prev ? `${prev}\n\n${comment}` : comment;

    return updateLead(leadId, { COMMENTS: next });
  }

  /**
   * Установить product rows для лида (crm.lead.productrows.set).
   * rows — массив объектов Bitrix24:
   *   [{ PRODUCT_NAME, PRICE, QUANTITY, CURRENCY_ID }, ...]
   */
  async function setProductRows(leadId, rows = []) {
    if (!leadId) {
      throw new Error("[crm/leads] setProductRows: leadId is required");
    }

    const safeRows = Array.isArray(rows) ? rows : [];
    await rest.call("crm.lead.productrows.set", {
      id: leadId,
      rows: safeRows,
    });

    logger.info(
      { ctx: CTX, leadId, rowsCount: safeRows.length },
      "Установлены product rows для лида",
    );
  }

  /**
   * Установить product rows по выбранным офферам ABCP (попозже LLM будет
   * отдавать picks, готовые к конвертации).
   */
  async function setProductRowsFromSelection(leadId, picks = []) {
    const rows = buildProductRowsFromSelection(picks);
    if (!rows.length) {
      logger.debug(
        { ctx: CTX, leadId },
        "setProductRowsFromSelection: нет валидных строк",
      );
      return;
    }

    await setProductRows(leadId, rows);
  }

  /**
   * Гарантировать наличие лида для диалога.
   * Если в session.leadId уже есть id — просто вернуть его.
   * Иначе создать новый лид и записать id в session.leadId/leadCreated.
   */
  async function ensureLeadForDialog(session = {}, dialogMeta = {}) {
    if (session.leadId) {
      return session.leadId;
    }

    const leadId = await createLeadFromSession(session, dialogMeta);
    session.leadId = leadId;
    session.leadCreated = true;

    return leadId;
  }

  return {
    // вспомогательная (если захочешь использовать вне)
    buildLeadFieldsFromSession,
    // products
    setProductRows,
    setProductRowsFromSelection,
    // базовые операции
    createLeadFromSession,
    updateLead,
    setLeadStage,
    appendComment,
    ensureLeadForDialog,
  };
}

/**
 * Высокоуровневый CRM-слой:
 * безопасное обновление лида и контакта по JSON-контракту LLM.
 *
 * Параметры:
 *  - portal          — домен портала Bitrix
 *  - dialogId        — ID диалога в ОЛ (для связи лида с чатом)
 *  - session         — объект сессии (будет обновлён и потом сохранён handler'ом)
 *  - llm             — strict JSON-ответ LLM (action, stage, oems, update_lead_fields, client_name, ...)
 *  - lastUserMessage — текст последнего сообщения клиента (для COMMENTS)
 */
export async function safeUpdateLeadAndContact({
  portal,
  dialogId,
  session,
  llm,
  lastUserMessage,
}) {
  const ctx = `${CTX}.safeUpdateLeadAndContact`;

  try {
    if (!portal || !dialogId || !session || !llm) {
      logger.warn(
        { ctx, portal, dialogId },
        "safeUpdateLeadAndContact: missing args",
      );
      return;
    }

    // 1) Bitrix REST клиент + CRM-API + ContactService
    const rest = makeBitrixClient({ domain: portal });
    const leads = createLeadsApi(rest);
    const contacts = createContactService(rest);

    // 2) Обновляем сессию по данным LLM (для следующего шага и для buildLeadFieldsFromSession)
    const ufFields = llm.update_lead_fields || {};

    if (!session.state) {
      session.state = {
        stage: "NEW",
        client_name: null,
        last_reply: null,
      };
    }

    if (ufFields.NAME) {
      session.name = ufFields.NAME;
      session.state.client_name = ufFields.NAME;
    } else if (llm.client_name) {
      session.name = llm.client_name;
      session.state.client_name = llm.client_name;
    }

    if (ufFields.PHONE && !session.phone) {
      session.phone = ufFields.PHONE;
    }

    if (ufFields.ADDRESS && !session.address) {
      session.address = ufFields.ADDRESS;
    }

    if (lastUserMessage) {
      session.lastQuery = lastUserMessage;
    }

    // 3) Гарантируем наличие лида
    const dialogMeta = {
      dialogId,
      source: crmSettings?.sourceId || "OPENLINES",
    };

    const leadId = await leads.ensureLeadForDialog(session, dialogMeta);
    logger.info({ ctx, leadId }, "ensureLeadForDialog ok");

    // 4) Собираем поля для обновления лида
    const fields = {};

    // NAME / LAST_NAME / SECOND_NAME из полного ФИО
    const fullName =
      session.name ||
      ufFields.NAME ||
      llm.client_name ||
      session.state?.client_name ||
      "";

    if (fullName) {
      const { firstName, lastName, middleName } = parseFullNameStandalone(fullName);

      if (firstName) fields.NAME = firstName;
      if (lastName) fields.LAST_NAME = lastName;
      if (middleName) fields.SECOND_NAME = middleName;
    }

    // PHONE — нормализуем через ContactService
    const phoneFromLLM =
      ufFields.PHONE ||
      ufFields.phone ||
      session.phone ||
      null;

    const normalizedPhone = contacts.normalizePhone(phoneFromLLM);
    if (normalizedPhone) {
      fields.PHONE = [
        {
          VALUE: normalizedPhone,
          VALUE_TYPE: "WORK",
        },
      ];
    }

    // ADDRESS — строка адреса / ПВЗ СДЭК
    const addressFromLLM =
      ufFields.ADDRESS ||
      ufFields.address ||
      session.address ||
      null;

    if (addressFromLLM) {
      fields.ADDRESS = addressFromLLM;
    }

    // COMMENTS: либо из LLM, либо краткий лог запроса
    if (ufFields.COMMENTS) {
      fields.COMMENTS = ufFields.COMMENTS;
    } else if (lastUserMessage) {
      fields.COMMENTS = `Запрос клиента из чата: ${lastUserMessage}`;
    }

    // OEM → кастомное поле UF_CRM_xxx (если настроено)
    const oems = Array.isArray(llm.oems) ? llm.oems : [];
    const oemFieldCode = crmSettings?.leadFields?.OEM;

    if (oemFieldCode && oems.length > 0) {
      fields[oemFieldCode] = oems.join(", ");
    }

    // 5) Обновляем лид, если есть что обновлять
    if (Object.keys(fields).length > 0) {
      await leads.updateLead(leadId, fields);
    } else {
      logger.debug({ ctx, leadId }, "Нет полей для обновления лида");
    }

    // 6) Двигаем лид по стадиям (если LLM вернул stage)
    if (llm.stage) {
      await leads.setLeadStage(leadId, llm.stage);
    }

    // 7) Product rows (опционально, если LLM уже умеет отдавать product_rows)
    if (Array.isArray(llm.product_rows) && llm.product_rows.length > 0) {
      await leads.setProductRows(leadId, llm.product_rows);
    } else if (Array.isArray(llm.product_picks) && llm.product_picks.length > 0) {
      // На будущее: если LLM будет отдавать picks по ABCP — используем их
      await leads.setProductRowsFromSelection(leadId, llm.product_picks);
    }

    // 8) Синхронизируем Контакт по данным лида/сессии
    await contacts.syncContactFromLead({
      ctx,
      leadId,
      session,
      fields,
    });
  } catch (err) {
    logger.error(
      { ctx, error: err?.message, stack: err?.stack },
      "Ошибка safeUpdateLeadAndContact",
    );
  }
}
