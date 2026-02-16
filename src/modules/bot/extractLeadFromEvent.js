// src/modules/bot/extractLeadFromEvent.js
// Привязка авто-лида Bitrix (созданного Открытой линией) к нашей сессии
// по полю CHAT_ENTITY_DATA_1 из события ONIMBOTMESSAGEADD.

import { logger } from "../../core/logger.js";

import { getSession, saveSession } from "./sessionStore.js";

const CTX = "modules/bot/extractLeadFromEvent";

/**
 * Читает тело события Bitrix и, если там есть CHAT_ENTITY_DATA_1 с LEAD|ID,
 * записывает этот leadId в session.leadId (ключ: portal + dialogId).
 *
 * @param {object} body - сырое тело события Bitrix (req.body)
 */
export function hydrateSessionLeadFromEvent(body) {
  try {
    if (!body) return;

    // Так же, как в messageModel.normalizeIncomingMessage
    const portal =
      body._portal ||
      body.auth?.domain ||
      body.auth?.DOMAIN ||
      body.data?.AUTH?.domain ||
      body.data?.AUTH?.DOMAIN ||
      null;

    if (!portal) return;

    const params = body?.data?.PARAMS || body?.data?.params || {};
    const dialogId =
      (params.DIALOG_ID && String(params.DIALOG_ID)) ||
      (params.DIALOG && String(params.DIALOG)) ||
      (params.CHAT_ID && String(params.CHAT_ID)) ||
      null;

    if (!dialogId) return;

    // Нас интересуют только открытые линии
    const chatEntityType =
      params.CHAT_ENTITY_TYPE || params.chat_entity_type || null;
    if (chatEntityType !== "LINES") {
      return;
    }

    const raw =
      params.CHAT_ENTITY_DATA_1 || params.chat_entity_data_1 || null;
    if (!raw) {
      logger.debug(
        { ctx: CTX, portal, dialogId },
        "Нет CHAT_ENTITY_DATA_1, пропускаем",
      );
      return;
    }

    // Пример строки: IMOL|...|...|LEAD|18758|...
    const m = String(raw).match(/LEAD\|(\d+)/);
    if (!m) {
      logger.debug(
        { ctx: CTX, portal, dialogId, raw },
        "CHAT_ENTITY_DATA_1 без LEAD|ID",
      );
      return;
    }

    const leadId = m[1];

    let session = getSession(portal, dialogId) || {
      state: { stage: "NEW", client_name: null, last_reply: null },
      name: null,
      phone: null,
      address: null,
      lastQuery: null,
      leadId: null,
      leadCreated: false,
      abcp: null,
      history: [],
      updatedAt: Date.now(),
    };

    if (session.leadId === leadId) {
      return;
    }

    session.leadId = leadId;
    saveSession(portal, dialogId, session);

    logger.info(
      { ctx: CTX, portal, dialogId, leadId, raw },
      "Привязали авто-лид к сессии из CHAT_ENTITY_DATA_1",
    );
  } catch (err) {
    logger.error(
      { ctx: CTX, error: String(err) },
      "Ошибка hydrateSessionLeadFromEvent",
    );
  }
}
