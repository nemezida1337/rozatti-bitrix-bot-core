// src/modules/openlines/api.js
// Утилиты для работы с Открытыми линиями и сообщениями бота

import { makeBitrixClient } from "../../core/bitrixClient.js";
import { logger } from "../../core/logger.js";

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
 * Отправка сообщения от бота в диалог (LLM-контур).
 *
 * Здесь используем imbot.message.add, как в рабочей версии,
 * которая уже светилась в логах как success.
 */
export async function sendOL(domain, dialogId, message) {
  try {
    if (!domain) throw new Error("sendOL: domain is required");
    if (!dialogId) throw new Error("sendOL: dialogId is required");
    if (!message) return;

    const api = makeBitrixClient({ domain });

    const rawId = String(dialogId);
    const payload = { MESSAGE: message };

    if (rawId.startsWith("chat")) {
      // классический DIALOG_ID вида "chat15684"
      payload.DIALOG_ID = rawId;
    } else if (/^\d+$/.test(rawId)) {
      // чистый числовой ID — используем как CHAT_ID
      payload.CHAT_ID = Number(rawId);
    } else {
      // fallback — отправляем как есть в DIALOG_ID
      payload.DIALOG_ID = rawId;
    }

    const res = await api.call("imbot.message.add", payload);

    logger.info(
      { domain, dialogId, payload, res },
      "openlines: sendOL imbot.message.add success",
    );
  } catch (e) {
    logger.error(
      { e: String(e), domain, dialogId },
      "openlines: sendOL failed",
    );
    // не пробрасываем, чтобы не ронять LLM-обработчик
  }
}

/**
 * "Печатает..." — пока no-op, чтобы не плодить REST-ошибки.
 */
export async function sendTyping(domain, dialogId) {
  try {
    logger.info({ domain, dialogId }, "openlines: typing noop");
    return;
  } catch {
    // ignore
  }
}
