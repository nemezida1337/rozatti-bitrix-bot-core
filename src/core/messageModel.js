// src/core/messageModel.js (v2)
// Унифицированная нормализация входящих сообщений Bitrix24 → формат для LLM.

import { logger } from "./logger.js";

const CTX = "messageModel";

/**
 * normalizeIncomingMessage(body)
 *
 * Преобразует webhook Bitrix24 в единый формат:
 *
 * {
 *   portal: "rozatti.bitrix24.ru",
 *   dialogId: "12345|6789",
 *   text: "сообщение",
 *   attachments: [...],
 *   isForwarded: boolean
 * }
 */
export function normalizeIncomingMessage(body) {
  try {
    if (!body) return null;

    const portal = body._portal || body.auth?.domain || null;
    const dialogId = extractDialogId(body);
    const text = extractText(body);

    return {
      portal,
      dialogId,
      text: text || "",
      attachments: body?.data?.PARAMS?.FILES || [],
      isForwarded: Boolean(body?.data?.PARAMS?.FORWARD || false),
    };
  } catch (err) {
    logger.error(CTX, "Ошибка normalizeIncomingMessage", err);
    return null;
  }
}

/**
 * Извлекаем dialogId (chat_id)
 */
function extractDialogId(body) {
  try {
    // Открытые линии
    if (body?.data?.PARAMS?.CHAT_ID) {
      return String(body.data.PARAMS.CHAT_ID);
    }

    // IM чат
    if (body?.data?.CHAT?.ID) {
      return String(body.data.CHAT.ID);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Извлекаем текст сообщения
 */
function extractText(body) {
  try {
    if (body?.data?.PARAMS?.MESSAGE) {
      return String(body.data.PARAMS.MESSAGE).trim();
    }
    if (body?.data?.PARAMS?.TEXT) {
      return String(body.data.PARAMS.TEXT).trim();
    }
    if (body?.data?.TEXT) {
      return String(body.data.TEXT).trim();
    }
    return "";
  } catch {
    return "";
  }
}
