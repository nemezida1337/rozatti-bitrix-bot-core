// src/core/messageModel.js
// Унифицированная нормализация входящих сообщений Bitrix24 → формат для LLM.

import { logger } from "./logger.js";

const CTX = "messageModel";
const SERVICE_FRAME_LINE_RE = /-{20,}/;
const SERVICE_HEADER_RE = /^[^\n]{1,120}\[[^\]]{3,40}\]/m;
const SERVICE_LEXEMES_RE =
  /(заказ\s*№|отслеживат|команда\s+[a-zа-я0-9_.-]+|интернет-?магазин|свяжутся)/i;

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
    const { leadId, dealId } = extractCrmBindings(params, body);

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
    const isForwarded = isForwardedMessage(params);
    const isSystemLike = detectSystemLikeMessage({ params, text });

    return {
      portal,
      dialogId,
      chatId,
      fromUserId,
      messageId,
      text: text || "",
      attachments: params?.FILES || [],
      isForwarded,
      isSystemLike,
      leadId,
      dealId,
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

function isTruthyFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v || "").trim().toUpperCase();
  return s === "Y" || s === "YES" || s === "TRUE" || s === "1";
}

function isForwardedMessage(params) {
  if (!params || typeof params !== "object") return false;
  return isTruthyFlag(params.FORWARD);
}

function detectSystemLikeMessage({ params, text }) {
  if (isTruthyFlag(params?.SYSTEM)) return true;

  const t = String(text || "").trim();
  if (!t) return false;

  const frameCount = (t.match(new RegExp(SERVICE_FRAME_LINE_RE.source, "g")) || []).length;
  const hasFramedEnvelope = frameCount >= 2;
  const hasHeader = SERVICE_HEADER_RE.test(t);
  const hasServiceLexemes = SERVICE_LEXEMES_RE.test(t);

  return hasFramedEnvelope && (hasHeader || hasServiceLexemes);
}

function normalizeEntityId(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
}

function extractEntityIdFromRaw(raw, token) {
  const text = String(raw || "");
  if (!text) return null;
  const re = new RegExp(`(?:^|\\|)${token}\\|(\\d+)`, "i");
  const m = text.match(re);
  return normalizeEntityId(m?.[1]);
}

function extractCrmBindings(params, body = null) {
  const data1 = params?.CHAT_ENTITY_DATA_1 || params?.chat_entity_data_1 || "";
  const data2 = params?.CHAT_ENTITY_DATA_2 || params?.chat_entity_data_2 || "";
  const chatData1 =
    body?.data?.CHAT?.ENTITY_DATA_1 ||
    body?.data?.CHAT?.entity_data_1 ||
    body?.data?.CHAT?.entityData1 ||
    "";
  const chatData2 =
    body?.data?.CHAT?.ENTITY_DATA_2 ||
    body?.data?.CHAT?.entity_data_2 ||
    body?.data?.CHAT?.entityData2 ||
    "";

  const leadId =
    extractEntityIdFromRaw(data1, "LEAD") ||
    extractEntityIdFromRaw(data2, "LEAD") ||
    extractEntityIdFromRaw(chatData1, "LEAD") ||
    extractEntityIdFromRaw(chatData2, "LEAD") ||
    null;

  const dealId =
    extractEntityIdFromRaw(data1, "DEAL") ||
    extractEntityIdFromRaw(data2, "DEAL") ||
    extractEntityIdFromRaw(chatData1, "DEAL") ||
    extractEntityIdFromRaw(chatData2, "DEAL") ||
    null;

  return { leadId, dealId };
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
