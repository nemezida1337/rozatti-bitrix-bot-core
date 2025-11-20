// src/modules/openlines/api.js
// Утилиты для работы с Открытыми линиями и сообщениями бота

import { logger } from "../../core/logger.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";

/**
 * Приветственное сообщение через стандартный метод
 * imopenlines.bot.session.message.send
 *
 * Используется старым контуром (register.core.js),
 * туда передаётся уже готовый api = makeBitrixClient(...)
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

/**
 * Завершение диалога в ОЛ
 */
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

/**
 * Перевод диалога на оператора
 */
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
 * Отправка сообщения от бота в диалог Открытой линии
 * Используем ИМЕННО imbot.message.add, а не im.message.add
 * (по докам Bitrix24 для чат-ботов).
 *
 * См. Bitrix24 REST:
 * - imbot.message.add — отправка сообщения от чат-бота
 */
export async function sendOL(domain, dialogId, message) {
  try {
    if (!domain) throw new Error("sendOL: domain is required");
    if (!dialogId) throw new Error("sendOL: dialogId is required");
    if (!message) return;

    const api = makeBitrixClient({ domain });

    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: message,
    });

    logger.info(
      { domain, dialogId },
      "openlines: sendOL imbot.message.add success"
    );
  } catch (e) {
    logger.error(
      { e: String(e), domain, dialogId },
      "openlines: sendOL failed"
    );
    // не пробрасываем наверх, чтобы не ронять обработчик целиком
  }
}

/**
 * "Печатает..." — временно делаем no-op,
 * чтобы не плодить лишние REST-вызовы и ошибки.
 * Если захочешь — потом подключим реальный метод им.XXX
 * для индикации набора текста.
 */
export async function sendTyping(domain, dialogId) {
  try {
    logger.info({ domain, dialogId }, "openlines: typing noop");
    return;
  } catch {
    // игнор
  }
}
