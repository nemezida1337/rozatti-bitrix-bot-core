// src/modules/crm/contact/contactService.js

import { makeBitrixClient } from "../../../core/bitrixClient.js";
import { logger } from "../../../core/logger.js";
import { getPortal } from "../../../core/store.js";

const CTX = "crm/contact";

function bx(portal) {
  const portalCfg = getPortal(portal);
  if (!portalCfg) return null;

  return makeBitrixClient({
    domain: portal,
    baseUrl: portalCfg.baseUrl,
    accessToken: portalCfg.accessToken,
  });
}

/**
 * Универсальный хелпер: Bitrix может вернуть либо полный объект { result: {...} },
 * либо уже "распакованный" result. Приводим к одному виду.
 */
function unwrapResult(res) {
  if (!res) return null;
  if (res.result && typeof res.result === "object") {
    return res.result;
  }
  return res;
}

/**
 * Находим контакт по телефону (возвращаем контакт-объект или null)
 */
async function findContactByPhone(portal, phone) {
  const client = bx(portal);
  if (!client || !phone) return null;

  try {
    const raw = await client.call("crm.contact.list", {
      filter: { PHONE: phone },
      select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "PHONE", "ADDRESS"],
    });

    const res = unwrapResult(raw);

    if (res && Array.isArray(res) && res.length > 0) {
      // случай, когда client.call уже вернул массив result
      return res[0];
    }

    // случай классического REST-ответа с полями total/result
    if (res && Array.isArray(res.result) && res.result.length > 0) {
      return res.result[0];
    }

    return null;
  } catch (err) {
    logger.error({ ctx: CTX, phone, err }, "Ошибка поиска контакта по телефону");
    return null;
  }
}

/**
 * Создаёт новый контакт и привязывает его к лиду.
 */
async function createAndBindContact(portal, leadId, fields) {
  const client = bx(portal);
  if (!client) return null;

  let contactId = null;
  try {
    const raw = await client.call("crm.contact.add", { fields });
    const res = unwrapResult(raw);

    // Bitrix обычно возвращает ID напрямую (число/строка)
    contactId = typeof res === "object" ? res.result || res.ID || null : res;
  } catch (err) {
    logger.error({ ctx: CTX, leadId, fields, err }, "Не удалось создать контакт");
    return null;
  }

  if (!contactId) {
    logger.error({ ctx: CTX, leadId, fields }, "Bitrix не вернул ID контакта");
    return null;
  }

  try {
    await client.call("crm.lead.update", {
      id: leadId,
      fields: { CONTACT_ID: contactId },
    });
    logger.info(
      { ctx: CTX, leadId, contactId },
      "Создан и привязан новый контакт",
    );
  } catch (err) {
    logger.error(
      { ctx: CTX, leadId, contactId, err },
      "Ошибка привязки нового контакта к лиду",
    );
  }

  return contactId;
}

/**
 * Обновляет существующий контакт
 */
async function updateContact(portal, contactId, fields) {
  const client = bx(portal);
  if (!client) return;

  await client.call("crm.contact.update", {
    id: contactId,
    fields,
  });

  logger.info({ ctx: CTX, contactId, fields }, "Контакт обновлён");
}

/**
 * ensureContact — главный метод
 *
 * Алгоритм:
 * 1) crm.lead.get → проверяем CONTACT_ID (учитываем "0").
 * 2) Если CONTACT_ID есть → crm.contact.update.
 * 3) Если нет:
 *    3.1) Пытаемся найти контакт по телефону → crm.contact.list.
 *         - нашли → crm.contact.update + crm.lead.update(CONTACT_ID)
 *         - не нашли → crm.contact.add + crm.lead.update(CONTACT_ID)
 */
export async function ensureContact(portal, leadId, fields) {
  const client = bx(portal);
  if (!client) return null;

  try {
    const phone = fields.PHONE?.[0]?.VALUE || null;

    // 1. Получаем лид и проверяем, есть ли уже CONTACT_ID
    let leadRaw;
    try {
      leadRaw = await client.call("crm.lead.get", { id: leadId });
    } catch (err) {
      logger.error({ ctx: CTX, leadId, err }, "Не удалось получить лид");
    }

    const lead = unwrapResult(leadRaw) || {};
    const rawContactId = lead.CONTACT_ID;

    // В Bitrix "0" или 0 = нет контакта
    const contactIdFromLead =
      rawContactId && String(rawContactId) !== "0" ? String(rawContactId) : null;

    logger.info(
      { ctx: CTX, leadId, rawContactId, contactIdFromLead },
      "Результат crm.lead.get (CONTACT_ID)",
    );

    if (contactIdFromLead) {
      // Есть привязанный контакт — просто обновляем его
      try {
        await updateContact(portal, contactIdFromLead, fields);
        logger.info(
          { ctx: CTX, leadId, contactId: contactIdFromLead },
          "Обновили уже привязанный к лиду контакт",
        );
      } catch (err) {
        logger.error(
          { ctx: CTX, leadId, contactId: contactIdFromLead, err },
          "Ошибка обновления контакта, привязанного к лиду",
        );
      }
      return contactIdFromLead;
    }

    // 2. Если к лиду контакт не привязан — пробуем найти по телефону
    let existingContact = null;
    if (phone) {
      existingContact = await findContactByPhone(portal, phone);
    }

    if (existingContact && existingContact.ID) {
      const existingId = String(existingContact.ID);

      // Обновляем найденный по телефону контакт и привязываем к лиду
      try {
        await updateContact(portal, existingId, fields);

        await client.call("crm.lead.update", {
          id: leadId,
          fields: { CONTACT_ID: existingId },
        });

        logger.info(
          { ctx: CTX, leadId, contactId: existingId },
          "Контакт найден по телефону и привязан к лиду",
        );
      } catch (err) {
        logger.error(
          { ctx: CTX, leadId, contactId: existingId, err },
          "Ошибка привязки контакта к лиду",
        );
      }
      return existingId;
    }

    // 3. Контакта нет — создаём нового и привязываем
    return await createAndBindContact(portal, leadId, fields);
  } catch (err) {
    logger.error({ ctx: CTX, leadId, fields, err }, "Ошибка ensureContact");
    return null;
  }
}
