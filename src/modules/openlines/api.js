// src/modules/openlines/api.js (v2.3)
// Сохраняем старые функции (OL-сессии) + добавляем sendOL/sendTyping,
// корректно используя makeBitrixClient из core/bitrixClient.js.

import { logger } from "../../core/logger.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";

/**
 * === СТАРЫЕ ФУНКЦИИ ОТКРЫТЫХ ЛИНИЙ (НЕ ТРОГАЕМ) ===
 * Они работают через переданный извне api (у которого есть .call).
 */

export async function sendWelcome({ api, dialogId, text = "Здравствуйте!" }) {
  try {
    return await api.call("imopenlines.bot.session.message.send", {
      DIALOG_ID: dialogId,
      MESSAGE: text,
    });
  } catch (e) {
    logger.error({ e }, "openlines: welcome failed");
    throw e;
  }
}

export async function finishDialog({ api, sessionId }) {
  try {
    return await api.call("imopenlines.bot.session.finish", {
      SESSION_ID: sessionId,
    });
  } catch (e) {
    logger.error({ e }, "openlines: finish failed");
    throw e;
  }
}

export async function transferToOperator({ api, operatorId, sessionId }) {
  try {
    return await api.call("imopenlines.bot.session.transfer", {
      SESSION_ID: sessionId,
      OPERATOR_ID: operatorId,
    });
  } catch (e) {
    logger.error({ e }, "openlines: transfer failed");
    throw e;
  }
}

/**
 * Внутренний helper: получаем Bitrix-клиент по домену портала.
 */
function getClient(portal) {
  if (!portal) {
    throw new Error("portal domain is required for Bitrix client");
  }
  return makeBitrixClient({ domain: portal });
}

/**
 * === НОВАЯ ФУНКЦИЯ: sendOL ===
 * Унифицированная отправка сообщений в чат Открытых линий.
 * Используется handler_llm_manager.js (v2).
 */
export async function sendOL(portal, dialogId, text) {
  try {
    if (!portal || !dialogId || !text) return;

    logger.info("openlines", `→ OL [${portal} | ${dialogId}]: ${text}`);

    const client = getClient(portal);

    return await client.call("im.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: text,
    });
  } catch (err) {
    logger.error("openlines", "Ошибка sendOL", err);
    return null;
  }
}

/**
 * Эффект «печатает...»
 */
export async function sendTyping(portal, dialogId) {
  try {
    if (!portal || !dialogId) return;

    const client = getClient(portal);

    return await client.call("im.dialog.state.set", {
      DIALOG_ID: dialogId,
      STATE: "typing",
    });
  } catch (err) {
    logger.error("openlines", "Ошибка sendTyping", err);
    return null;
  }
}
