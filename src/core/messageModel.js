// src/core/messageModel.js (fixed)
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
 *   dialogId: "chat15684",
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
 * Извлекаем dialogId (DIALOG_ID, а не CHAT_ID)
 */
function extractDialogId(body) {
  try {
    // 1) Открытые линии/бот: Bitrix шлёт DIALOG_ID вида "chat15684"
    if (body?.data?.PARAMS?.DIALOG_ID) {
      return String(body.data.PARAMS.DIALOG_ID);
    }

    // 2) Если вдруг DIALOG_ID нет — fallback к CHAT_ID
    if (body?.data?.PARAMS?.CHAT_ID) {
      return String(body.data.PARAMS.CHAT_ID);
    }

    // 3) Общий IM чат
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
