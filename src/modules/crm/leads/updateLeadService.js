// src/modules/crm/leads/updateLeadService.js
// Узел, который обновляет ЛИД и его товарные позиции по команде Cortex.

import { makeBitrixClient } from "../../../core/bitrixClient.js";
import { logger } from "../../../core/logger.js";
import { getPortalAsync } from "../../../core/store.js";

const CTX = "crm/updateLeadService";

// Получаем REST-клиент Bitrix
async function bx(portal) {
  const portalCfg = await getPortalAsync(portal);
  if (!portalCfg) {
    logger.error({ ctx: CTX, portal }, "Portal not found in store");
    return null;
  }

  return makeBitrixClient({
    domain: portal,
    baseUrl: portalCfg.baseUrl,
    accessToken: portalCfg.accessToken,
  });
}

// -----------------------------------------------------------
// 1) ОБНОВЛЕНИЕ ПОЛЕЙ ЛИДА
// -----------------------------------------------------------
export async function updateLead(portal, leadId, fields = {}) {
  try {
    const client = await bx(portal);
    if (!client) return null;

    if (!leadId) {
      logger.warn({ ctx: CTX, fields }, "updateLead: leadId отсутствует");
      return null;
    }

    if (!fields || Object.keys(fields).length === 0) {
      logger.debug({ ctx: CTX, leadId }, "updateLead: пустые поля");
      return null;
    }

    const res = await client.call("crm.lead.update", {
      id: leadId,
      fields,
    });

    logger.info({ ctx: CTX, leadId, fields }, "Лид обновлён");
    return res;
  } catch (err) {
    logger.error({ ctx: CTX, leadId, fields, error: String(err) }, "Ошибка crm.lead.update");
    return null;
  }
}

// -----------------------------------------------------------
// 2) ДОБАВЛЕНИЕ КОММЕНТАРИЯ К ЛИДУ
// -----------------------------------------------------------
export async function addLeadComment(portal, leadId, text) {
  try {
    if (!leadId || !text) return;

    const client = await bx(portal);
    if (!client) return;

    await client.call("crm.timeline.comment.add", {
      fields: {
        ENTITY_TYPE_ID: 1, // Lead
        ENTITY_ID: Number(leadId),
        COMMENT: text,
      },
    });

    logger.info({ ctx: CTX, leadId, text }, "Комментарий добавлен");
  } catch (err) {
    logger.error({ ctx: CTX, leadId, text, error: String(err) }, "Ошибка timeline.comment.add");
  }
}

// -----------------------------------------------------------
// 3) УСТАНОВКА ТОВАРНЫХ ПОЗИЦИЙ (product rows)
// -----------------------------------------------------------
export async function setLeadProductRows(portal, leadId, rows = []) {
  try {
    const client = await bx(portal);
    if (!client) return null;

    if (!leadId) {
      logger.warn({ ctx: CTX, rows }, "setLeadProductRows: leadId отсутствует");
      return null;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      logger.debug({ ctx: CTX, leadId }, "Нет product_rows для установки");
      return null;
    }

    // 🛡️ Минимальная валидация строк
    const validRows = rows.filter(
      (r) => r && typeof r === "object" && r.PRODUCT_NAME && typeof r.PRICE === "number",
    );

    if (!validRows.length) {
      logger.warn(
        { ctx: CTX, leadId, rows },
        "product_rows отфильтрованы полностью (некорректные данные)",
      );
      return null;
    }

    const payload = {
      id: Number(leadId),
      rows: validRows,
    };

    const res = await client.call("crm.lead.productrows.set", payload);

    logger.info({ ctx: CTX, leadId, rows: validRows }, "Товарные строки успешно записаны в лид");

    return res;
  } catch (err) {
    logger.error({ ctx: CTX, leadId, rows, error: String(err) }, "Ошибка crm.lead.productrows.set");
    return null;
  }
}
