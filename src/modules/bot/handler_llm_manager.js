// src/modules/bot/handler_llm_manager.js (v6, +CRM, ФИО, телефон, адрес)
// ЧИСТЫЙ ОРКЕСТРАТОР ДИАЛОГА
// Вся бизнес-логика — в LLM + модулях (ABCP, CRM, OL)

import { logger } from "../../core/logger.js";
import { searchManyOEMs } from "../external/pricing/abcp.js";
import { createLeadsApi } from "../crm/leads.js";
import { prepareFunnelContext, runFunnelLLM } from "../llm/llmFunnelEngine.js";
import { normalizeIncomingMessage } from "../../core/messageModel.js";
import { saveSession, getSession } from "./sessionStore.js";
import { sendOL } from "../openlines/api.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";
import { crmSettings } from "../../../config/settings.crm.js";

const CTX = "handler_llm";

//
// Безопасный ответ Bitrix (работает и с Fastify reply, и с Express res)
//
function safeReply(res, payload = "ok") {
  if (!res) return;
  try {
    if (typeof res.code === "function" && typeof res.send === "function") {
      return res.code(200).send(payload); // Fastify
    }
    if (typeof res.status === "function" && typeof res.send === "function") {
      return res.status(200).send(payload); // Express-подобный
    }
    if (typeof res.send === "function") {
      return res.send(payload); // запасной вариант
    }
  } catch (e) {
    logger.error(
      { ctx: CTX, error: e },
      "Ошибка при отправке ответа Bitrix",
    );
  }
}

//
// Нормализация телефона под формат +7... (для РФ)
//
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, "");
  if (!digits) return null;

  // 8XXXXXXXXXX → +7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("8")) {
    return "+7" + digits.slice(1);
  }

  // 7XXXXXXXXXX → +7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith("7")) {
    return "+7" + digits.slice(1);
  }

  // 9XXXXXXXXX → +7XXXXXXXXXX
  if (digits.length === 10 && digits.startsWith("9")) {
    return "+7" + digits;
  }

  // 00XXXXXXXX... → +XXXXXXXX...
  if (digits.length >= 11 && digits.startsWith("00")) {
    return "+" + digits.slice(2);
  }

  // Всё остальное — просто плюс перед цифрами
  if (digits.length >= 10) {
    return "+" + digits;
  }

  return "+" + digits;
}

//
// Грубый парсер ФИО: "Фамилия Имя Отчество?" → { firstName, lastName, middleName }
//
function parseFullName(full) {
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

//
// MAIN ENTRY POINT
//
export async function processIncomingBitrixMessage(req, res) {
  try {
    const msg = normalizeIncomingMessage(req.body);

    if (!msg || !msg.portal || !msg.dialogId) {
      logger.warn(
        { ctx: CTX, body: req.body },
        "Некорректное входящее сообщение",
      );
      safeReply(res);
      return;
    }

    logger.info(
      {
        ctx: CTX,
        portal: msg.portal,
        dialogId: msg.dialogId,
        fromUserId: msg.fromUserId,
      },
      `Входящее сообщение: "${msg.text}"`,
    );

    // 0) Сессия
    const session = getSession(msg.portal, msg.dialogId) || createEmptySession();

    // 1) Подготовка контекста для LLM
    const llmInput = await prepareFunnelContext({ session, msg });

    //
    // 2) LLM → strict JSON
    //
    const llm = await runFunnelLLM(llmInput);
    logger.debug({ ctx: CTX, llm }, "LLM structured JSON");

    //
    // 3) ABCP (ТОЛЬКО если LLM запросил)
    //
    let abcpResult = null;
    if (llm.action === "abcp_lookup" && llm.oems?.length) {
      abcpResult = await safeDoABCP(llm.oems);
      llmInput.injectedABCP = abcpResult;

      // повторный прогон LLM с ABCP-данными
      const llm2 = await runFunnelLLM(llmInput);
      Object.assign(llm, llm2);
      logger.debug({ ctx: CTX, llm }, "LLM after ABCP re-run");
    }

    //
    // 4) Обновление лида в CRM
    //
    if (
      llm &&
      ( (llm.update_lead_fields && Object.keys(llm.update_lead_fields).length > 0) ||
        (Array.isArray(llm.oems) && llm.oems.length > 0))
    ) {
      await safeUpdateLead({
        portal: msg.portal,
        dialogId: msg.dialogId,
        session,
        llm,
        lastUserMessage: msg.text,
      });
    }

    //
    // 5) Ответ клиенту в Открытые линии
    //
    if (llm.reply) {
      await sendOL(msg.portal, msg.dialogId, llm.reply);
    }

    //
    // 6) Сохранение сессии
    //
    const newSession = {
      ...session,
      state: {
        stage: llm.stage || session.state.stage,
        client_name: llm.client_name ?? session.state.client_name,
        last_reply: llm.reply,
      },
      abcp: abcpResult ?? session.abcp,
      history: [
        ...session.history,
        { role: "user", text: msg.text },
        { role: "assistant", text: llm.reply },
      ],
      updatedAt: Date.now(),
    };

    saveSession(msg.portal, msg.dialogId, newSession);

    safeReply(res);
  } catch (err) {
    logger.error({ ctx: CTX, err }, "Ошибка обработки сообщения");
    safeReply(res);
  }
}

//
// CREATE EMPTY SESSION
//
function createEmptySession() {
  return {
    state: {
      stage: "NEW",
      client_name: null,
      last_reply: null,
    },
    // CRM
    name: null,        // полное ФИО (строка)
    phone: null,
    address: null,     // адрес доставки / ПВЗ СДЭК
    lastQuery: null,
    leadId: null,
    leadCreated: false,
    // ABCP + история
    abcp: null,
    history: [],
    updatedAt: Date.now(),
  };
}

//
// ABCP WRAPPER
//
async function safeDoABCP(oems) {
  try {
    if (!oems || !oems.length) return {};
    logger.info({ ctx: CTX, oems }, "ABCP lookup");

    // Новый API ABCP: один вызов по массиву OEM, возвращает
    // { OEM: { offers: [...] }, ... }
    const result = await searchManyOEMs(oems);
    logger.debug({ ctx: CTX, result }, "ABCP result");
    return result;
  } catch (err) {
    logger.error({ ctx: CTX, err }, "Ошибка ABCP");
    return {};
  }
}

//
// LEAD UPDATE WRAPPER + CONTACT SYNC
//
async function safeUpdateLead({ portal, dialogId, session, llm, lastUserMessage }) {
  const ctx = `${CTX}.crm`;

  try {
    if (!portal || !dialogId || !session || !llm) {
      logger.warn({ ctx, portal, dialogId }, "safeUpdateLead: missing args");
      return;
    }

    // 1) Готовим Bitrix REST клиент и CRM-API
    const rest = makeBitrixClient({ domain: portal });
    const leads = createLeadsApi(rest);

    // 2) Обновляем внутреннюю сессию под ожидания crm/leads.js
    const ufFields = llm.update_lead_fields || {};

    const nameFromLLM =
      ufFields.NAME ||
      ufFields.Name ||
      ufFields.name ||
      llm.client_name ||
      session.state?.client_name ||
      null;

    const phoneFromLLM =
      ufFields.PHONE ||
      ufFields.phone ||
      session.phone ||
      null;

    const addressFromLLM =
      ufFields.ADDRESS ||
      ufFields.address ||
      session.address ||
      null;

    if (nameFromLLM) {
      session.name = String(nameFromLLM).trim();
    }
    if (phoneFromLLM) {
      const normalized = normalizePhone(phoneFromLLM);
      if (normalized) {
        session.phone = normalized;
      }
    }
    if (addressFromLLM) {
      session.address = String(addressFromLLM).trim();
    }
    if (lastUserMessage) {
      session.lastQuery = lastUserMessage;
    }

    const dialogMeta = {
      dialogId,
      source: crmSettings?.sourceId || "OPENLINES",
    };

    // 3) Гарантируем наличие лида (создаст, если его ещё нет)
    const leadId = await leads.ensureLeadForDialog(session, dialogMeta);
    logger.info({ ctx, leadId }, "ensureLeadForDialog ok");

    // 4) Собираем поля для обновления
    const fields = {};

    // NAME / LAST_NAME / SECOND_NAME из полного ФИО
    if (session.name) {
      const { firstName, lastName, middleName } = parseFullName(session.name);
      if (firstName) fields.NAME = firstName;
      if (lastName) fields.LAST_NAME = lastName;
      if (middleName) fields.SECOND_NAME = middleName;
    }

    // PHONE — Bitrix ждёт массив мультиполей PHONE
    if (session.phone) {
      fields.PHONE = [
        {
          VALUE: session.phone,
          VALUE_TYPE: "WORK",
        },
      ];
    }

    // ADDRESS — строка адреса / ПВЗ СДЭК
    if (session.address) {
      fields.ADDRESS = session.address;
    }

    // COMMENTS: либо из LLM, либо краткий лог запроса
    if (ufFields.COMMENTS) {
      fields.COMMENTS = ufFields.COMMENTS;
    } else if (lastUserMessage) {
      const baseComment = `Запрос клиента из чата: ${lastUserMessage}`;
      fields.COMMENTS = baseComment;
    }

    // OEM → кастомное поле UF_CRM_1762873310878
    const oems = Array.isArray(llm.oems) ? llm.oems : [];
    const oemFieldCode = crmSettings?.leadFields?.OEM;

    if (oemFieldCode && oems.length > 0) {
      fields[oemFieldCode] = oems.join(", ");
    }

    // Если полей нет — смысла дергать update нет
    if (!Object.keys(fields).length) {
      logger.debug({ ctx, leadId }, "Нет полей для обновления лида");
      return;
    }

    const ok = await leads.updateLead(leadId, fields);
    logger.info({ ctx, leadId, ok, fields }, "Лид обновлён");

    // 5) Синхронизация телефона/ФИО/адреса в Контакт
    if (ok) {
      await syncContactFromLead({
        ctx,
        rest,
        leadId,
        session,
        fields,
      });
    }
  } catch (err) {
    logger.error(
      { ctx, error: err?.message, stack: err?.stack },
      "Ошибка safeUpdateLead",
    );
  }
}

//
// Синхронизация контакта по данным лида:
//  - ФИО (NAME / LAST_NAME / SECOND_NAME)
//  - телефон
//  - адрес
//
async function syncContactFromLead({ ctx, rest, leadId, session, fields }) {
  try {
    const phone =
      session.phone ||
      (Array.isArray(fields.PHONE) && fields.PHONE[0]?.VALUE) ||
      null;

    const fullName = session.name || fields.NAME || "";
    const { firstName, lastName, middleName } = parseFullName(fullName);
    const address = session.address || fields.ADDRESS || "";

    if (!phone && !fullName && !address) {
      logger.debug({ ctx, leadId }, "syncContactFromLead: нет данных, пропуск");
      return;
    }

    // Получаем лид, чтобы узнать CONTACT_ID и текущие поля
    const lead = await rest.call("crm.lead.get", { id: leadId }).catch((e) => {
      logger.warn({ ctx, leadId, error: String(e) }, "crm.lead.get failed");
      return null;
    });

    const contactIdRaw =
      lead && (lead.CONTACT_ID || lead.CONTACT_ID === 0)
        ? lead.CONTACT_ID
        : null;
    const contactId = contactIdRaw ? Number(contactIdRaw) : null;

    const contactFields = {};

    if (firstName) contactFields.NAME = firstName;
    if (lastName) contactFields.LAST_NAME = lastName;
    if (middleName) contactFields.SECOND_NAME = middleName;

    if (phone) {
      contactFields.PHONE = [
        {
          VALUE: phone,
          VALUE_TYPE: "WORK",
        },
      ];
    }

    if (address) {
      contactFields.ADDRESS = address;
    }

    // Если вообще нечего писать — выходим
    if (!Object.keys(contactFields).length) {
      logger.debug({ ctx, leadId }, "syncContactFromLead: нет полей для контакта");
      return;
    }

    if (contactId) {
      // Обновляем существующий контакт
      const res = await rest
        .call("crm.contact.update", {
          id: contactId,
          fields: contactFields,
        })
        .catch((e) => {
          logger.warn(
            { ctx, leadId, contactId, error: String(e) },
            "crm.contact.update failed",
          );
          return null;
        });

      logger.info(
        { ctx, leadId, contactId, res, phone, address },
        "Контакт обновлён (ФИО/телефон/адрес синхронизированы)",
      );
      return;
    }

    // Если контакта нет — создаём новый и привязываем к лиду
    const newContactRes = await rest
      .call("crm.contact.add", {
        fields: contactFields,
      })
      .catch((e) => {
        logger.warn(
          { ctx, leadId, error: String(e) },
          "crm.contact.add failed",
        );
        return null;
      });

    const newContactId = newContactRes ? Number(newContactRes) : null;

    if (!newContactId) {
      logger.warn(
        { ctx, leadId, raw: newContactRes },
        "crm.contact.add вернул некорректный id",
      );
      return;
    }

    // Привязываем контакт к лиду
    const linkRes = await rest
      .call("crm.lead.update", {
        id: leadId,
        fields: { CONTACT_ID: newContactId },
      })
      .catch((e) => {
        logger.warn(
          { ctx, leadId, newContactId, error: String(e) },
          "crm.lead.update CONTACT_ID failed",
        );
        return null;
      });

    logger.info(
      { ctx, leadId, newContactId, linkRes, phone, address },
      "Создан и привязан новый контакт к лиду",
    );
  } catch (e) {
    logger.error(
      { ctx, leadId, error: String(e) },
      "syncContactFromLead: непредвиденная ошибка",
    );
  }
}
