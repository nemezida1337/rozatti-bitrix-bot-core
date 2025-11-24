// src/modules/crm/contactService.js
// ContactService — работа с Контактами Bitrix24:
//  - нормализация телефона
//  - поиск контакта по телефону
//  - разбор полного ФИО на NAME / LAST_NAME / SECOND_NAME
//  - создание/обновление контакта
//  - привязка контакта к лиду
//  - синхронизация контакта по данным лида

import { logger } from "../../core/logger.js";
import { normalizePhone as normalizePhoneUtil } from "../bot/contactUtils.js";

const CTX = "crm/contactService";

/**
 * Грубый парсер ФИО: "Фамилия Имя Отчество?"
 * → { firstName, lastName, middleName }
 */
export function parseFullName(full) {
  if (!full) {
    return { firstName: "", lastName: "", middleName: "" };
  }

  const parts = String(full)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length >= 3) {
    const lastName = parts[0];
    const firstName = parts[1];
    const middleName = parts.slice(2).join(" ");
    return { firstName, lastName, middleName };
  }

  if (parts.length === 2) {
    const firstName = parts[0];
    const lastName = parts[1];
    return { firstName, lastName, middleName: "" };
  }

  const firstName = parts[0] || "";
  return { firstName, lastName: "", middleName: "" };
}

/**
 * Фабрика ContactService.
 *
 * @param {object} rest - Bitrix REST клиент (makeBitrixClient)
 * @returns {{
 *   normalizePhone: (phoneRaw: string) => string | null,
 *   parseFullName: (full: string) => { firstName: string, lastName: string, middleName: string },
 *   findContactByPhone: (phoneRaw: string) => Promise<{ phone: string | null, contact: any }>,
 *   createContact: (args: { fullName?: string, phone?: string | null, address?: string | null }) => Promise<number | null>,
 *   updateContact: (args: { contactId: number, fullName?: string, phone?: string | null, address?: string | null }) => Promise<boolean>,
 *   linkContactToLead: (args: { leadId: number, contactId: number }) => Promise<boolean>,
 *   syncContactFromLead: (args: { ctx?: string, leadId: number, session: any, fields: any }) => Promise<void>
 * }}
 */
export function createContactService(rest) {
  if (!rest || typeof rest.call !== "function") {
    throw new Error("[crm/contactService] rest.call is required");
  }

  /**
   * Обёртка над normalizePhone из contactUtils.
   */
  function normalizePhone(phoneRaw) {
    return normalizePhoneUtil(phoneRaw);
  }

  /**
   * Поиск контакта по телефону.
   * Возвращает { phone, contact }.
   */
  async function findContactByPhone(phoneRaw) {
    const ctx = `${CTX}.findContactByPhone`;
    const phone = normalizePhone(phoneRaw);

    if (!phone) {
      logger.debug({ ctx, phoneRaw }, "Телефон невалиден, поиск контакта пропущен");
      return { phone: null, contact: null };
    }

    try {
      const res = await rest.call("crm.contact.list", {
        filter: { PHONE: phone },
        select: ["ID", "NAME", "LAST_NAME", "SECOND_NAME", "PHONE", "ADDRESS"],
      });

      const list = Array.isArray(res) ? res : [];
      const contact = list[0] || null;

      logger.debug(
        { ctx, phone, found: !!contact, id: contact?.ID },
        "Поиск контакта по телефону завершён",
      );

      return { phone, contact };
    } catch (e) {
      logger.warn(
        { ctx, phone, error: String(e) },
        "crm.contact.list по телефону упал",
      );
      return { phone, contact: null };
    }
  }

  /**
   * Создать контакт.
   * fullName — полное ФИО (можно пустое).
   */
  async function createContact({ fullName, phone, address }) {
    const ctx = `${CTX}.createContact`;

    const { firstName, lastName, middleName } = parseFullName(fullName || "");

    const fields = {};

    if (firstName) fields.NAME = firstName;
    if (lastName) fields.LAST_NAME = lastName;
    if (middleName) fields.SECOND_NAME = middleName;

    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone) {
      fields.PHONE = [
        {
          VALUE: normalizedPhone,
          VALUE_TYPE: "WORK",
        },
      ];
    }

    if (address) {
      fields.ADDRESS = address;
    }

    if (!Object.keys(fields).length) {
      logger.debug({ ctx, fullName, phone, address }, "Нет полей для создания контакта");
      return null;
    }

    try {
      const res = await rest.call("crm.contact.add", { fields });
      const contactId = res ? Number(res) : null;

      if (!contactId || Number.isNaN(contactId)) {
        logger.warn({ ctx, raw: res }, "crm.contact.add вернул некорректный id");
        return null;
      }

      logger.info(
        { ctx, contactId, phone: normalizedPhone, address },
        "Создан новый контакт",
      );

      return contactId;
    } catch (e) {
      logger.warn(
        { ctx, error: String(e), fullName, phone, address },
        "crm.contact.add упал",
      );
      return null;
    }
  }

  /**
   * Обновить контакт (частичное обновление).
   */
  async function updateContact({ contactId, fullName, phone, address }) {
    const ctx = `${CTX}.updateContact`;

    if (!contactId) {
      logger.warn({ ctx }, "updateContact: contactId is required");
      return false;
    }

    const fields = {};

    if (fullName) {
      const { firstName, lastName, middleName } = parseFullName(fullName);
      if (firstName) fields.NAME = firstName;
      if (lastName) fields.LAST_NAME = lastName;
      if (middleName) fields.SECOND_NAME = middleName;
    }

    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone) {
      fields.PHONE = [
        {
          VALUE: normalizedPhone,
          VALUE_TYPE: "WORK",
        },
      ];
    }

    if (address) {
      fields.ADDRESS = address;
    }

    if (!Object.keys(fields).length) {
      logger.debug({ ctx, contactId }, "Нет полей для обновления контакта");
      return true;
    }

    try {
      const res = await rest.call("crm.contact.update", {
        id: contactId,
        fields,
      });

      logger.info(
        { ctx, contactId, res, phone: normalizedPhone, address },
        "Контакт обновлён",
      );

      return true;
    } catch (e) {
      logger.warn(
        { ctx, contactId, error: String(e) },
        "crm.contact.update упал",
      );
      return false;
    }
  }

  /**
   * Привязать контакт к лиду.
   */
  async function linkContactToLead({ leadId, contactId }) {
    const ctx = `${CTX}.linkContactToLead`;

    if (!leadId || !contactId) {
      logger.warn({ ctx, leadId, contactId }, "linkContactToLead: missing args");
      return false;
    }

    try {
      const res = await rest.call("crm.lead.update", {
        id: leadId,
        fields: { CONTACT_ID: contactId },
      });

      logger.info(
        { ctx, leadId, contactId, res },
        "Контакт привязан к лиду",
      );

      return true;
    } catch (e) {
      logger.warn(
        { ctx, leadId, contactId, error: String(e) },
        "crm.lead.update (CONTACT_ID) упал",
      );
      return false;
    }
  }

  /**
   * Синхронизация контакта по данным лида:
   *  - ФИО
   *  - телефон
   *  - адрес
   *
   * Используется из safeUpdateLeadAndContact.
   */
  async function syncContactFromLead({ ctx, leadId, session, fields }) {
    const syncCtx = `${ctx || CTX}.syncContactFromLead`;

    try {
      const phoneFromFields =
        Array.isArray(fields?.PHONE) && fields.PHONE[0]?.VALUE
          ? fields.PHONE[0].VALUE
          : null;

      const phoneSrc = session?.phone || phoneFromFields || null;
      const normalizedPhone = normalizePhone(phoneSrc);

      const fullName = session?.name || fields?.NAME || "";
      const { firstName, lastName, middleName } = parseFullName(fullName);

      const address = session?.address || fields?.ADDRESS || "";

      if (!normalizedPhone && !firstName && !lastName && !middleName && !address) {
        logger.debug(
          { ctx: syncCtx, leadId },
          "syncContactFromLead: нет данных для контакта",
        );
        return;
      }

      // 1) Читаем лид, чтобы узнать текущий CONTACT_ID
      const lead = await rest
        .call("crm.lead.get", { id: leadId })
        .catch((e) => {
          logger.warn(
            { ctx: syncCtx, leadId, error: String(e) },
            "crm.lead.get упал (для syncContactFromLead)",
          );
          return null;
        });

      if (!lead) {
        logger.warn({ ctx: syncCtx, leadId }, "Лид не найден");
        return;
      }

      let contactId = lead.CONTACT_ID ? Number(lead.CONTACT_ID) : null;

      // 2) Если в лиде нет CONTACT_ID, но есть телефон — пробуем найти контакт по телефону
      if (!contactId && normalizedPhone) {
        const { contact } = await findContactByPhone(normalizedPhone);
        if (contact && contact.ID) {
          contactId = Number(contact.ID);
          logger.info(
            { ctx: syncCtx, leadId, contactId },
            "Нашли существующий контакт по телефону, будем обновлять и привязывать",
          );
        }
      }

      const contactFields = {};

      if (firstName) contactFields.NAME = firstName;
      if (lastName) contactFields.LAST_NAME = lastName;
      if (middleName) contactFields.SECOND_NAME = middleName;

      if (normalizedPhone) {
        contactFields.PHONE = [
          {
            VALUE: normalizedPhone,
            VALUE_TYPE: "WORK",
          },
        ];
      }

      if (address) {
        contactFields.ADDRESS = address;
      }

      if (!Object.keys(contactFields).length) {
        logger.debug(
          { ctx: syncCtx, leadId },
          "syncContactFromLead: нет полей для контакта",
        );
        return;
      }

      // 3) Если CONTACT_ID уже есть — обновляем контакт
      if (contactId) {
        try {
          const res = await rest.call("crm.contact.update", {
            id: contactId,
            fields: contactFields,
          });

          logger.info(
            { ctx: syncCtx, leadId, contactId, res, phone: normalizedPhone, address },
            "Контакт обновлён (ФИО/телефон/адрес синхронизированы)",
          );
        } catch (e) {
          logger.warn(
            { ctx: syncCtx, leadId, contactId, error: String(e) },
            "crm.contact.update (syncContactFromLead) упал",
          );
        }

        return;
      }

      // 4) Если контакта нет — создаём новый и привязываем к лиду
      const newContactId = await createContact({
        fullName,
        phone: normalizedPhone,
        address,
      });

      if (!newContactId) {
        logger.warn(
          { ctx: syncCtx, leadId },
          "Не удалось создать новый контакт",
        );
        return;
      }

      const linkRes = await linkContactToLead({
        leadId,
        contactId: newContactId,
      });

      logger.info(
        {
          ctx: syncCtx,
          leadId,
          newContactId,
          linkRes,
          phone: normalizedPhone,
          address,
        },
        "Создан и привязан новый контакт к лиду",
      );
    } catch (e) {
      logger.error(
        { ctx: syncCtx, leadId, error: String(e) },
        "syncContactFromLead: непредвиденная ошибка",
      );
    }
  }

  return {
    normalizePhone,
    parseFullName,
    findContactByPhone,
    createContact,
    updateContact,
    linkContactToLead,
    syncContactFromLead,
  };
}
