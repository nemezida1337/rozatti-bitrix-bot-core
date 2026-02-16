// src/core/messageModel.js
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
 *   chatId: "15684",
 *   fromUserId: "123",
 *   messageId: "456",
 *   text: "сообщение",
 *   attachments: [...],
 *   isForwarded: boolean,
 *   raw: body
 * }
 */
export function normalizeIncomingMessage(body) {
  try {
    if (!body) return null;
    const params = getParams(body);

    const portal =
      body._portal ||
      body?.auth?.domain ||
      body?.auth?.DOMAIN ||
      body?.data?.AUTH?.domain ||
      body?.data?.AUTH?.DOMAIN ||
      body?.data?.auth?.domain ||
      body?.data?.auth?.DOMAIN ||
      null;
    const dialogId = extractDialogId(body);
    const chatId = extractChatId(body, dialogId);
    const fromUserId = extractFromUserId(body);
    const messageId = extractMessageId(body);
    const text = extractText(body);

    return {
      portal,
      dialogId,
      chatId,
      fromUserId,
      messageId,
      text: text || "",
      attachments: params?.FILES || [],
      isForwarded: Boolean(params?.FORWARD || false),
      raw: body,
    };
  } catch (err) {
    logger.error(
      { ctx: CTX, err, body },
      "Ошибка normalizeIncomingMessage",
    );
    return null;
  }
}

/**
 * Извлекаем dialogId (DIALOG_ID, а не CHAT_ID)
 */
function extractDialogId(body) {
  try {
    const params = getParams(body);
    // 1) Открытые линии/бот: Bitrix шлёт DIALOG_ID вида "chat15684"
    if (params?.DIALOG_ID) {
      return String(params.DIALOG_ID);
    }

    // 2) Если вдруг DIALOG_ID нет — fallback к CHAT_ID
    if (params?.CHAT_ID) {
      return String(params.CHAT_ID);
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
 * Извлекаем числовой CHAT_ID
 */
function extractChatId(body, dialogId) {
  try {
    const params = getParams(body);
    if (params?.CHAT_ID) {
      return String(params.CHAT_ID).replace(/\D/g, "");
    }

    if (dialogId) {
      return String(dialogId).replace(/\D/g, "");
    }

    if (body?.data?.CHAT?.ID) {
      return String(body.data.CHAT.ID).replace(/\D/g, "");
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
    const params = getParams(body);
    if (params?.MESSAGE) {
      return String(params.MESSAGE).trim();
    }
    if (params?.TEXT) {
      return String(params.TEXT).trim();
    }
    if (body?.data?.TEXT) {
      return String(body.data.TEXT).trim();
    }
    return "";
  } catch {
    return "";
  }
}

function extractFromUserId(body) {
  try {
    const params = getParams(body);
    if (params?.FROM_USER_ID) {
      return String(params.FROM_USER_ID);
    }
    if (params?.AUTHOR_ID) {
      return String(params.AUTHOR_ID);
    }
    return null;
  } catch {
    return null;
  }
}

function extractMessageId(body) {
  try {
    const params = getParams(body);
    if (params?.MESSAGE_ID) {
      return String(params.MESSAGE_ID);
    }
    return null;
  } catch {
    return null;
  }
}

function getParams(body) {
  return body?.data?.PARAMS || body?.data?.params || null;
}
