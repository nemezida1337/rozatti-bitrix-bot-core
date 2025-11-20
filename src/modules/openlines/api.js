import { logger } from "../../core/logger.js";

export async function sendWelcome({ api, dialogId, text = "Здравствуйте!" }) {
  try {
    return await api.call("imopenlines.bot.session.message.send", { DIALOG_ID: dialogId, MESSAGE: text });
  } catch (e) {
    logger.error({ e }, "openlines: welcome failed");
    throw e;
  }
}

export async function finishDialog({ api, sessionId }) {
  try {
    return await api.call("imopenlines.bot.session.finish", { SESSION_ID: sessionId });
  } catch (e) {
    logger.error({ e }, "openlines: finish failed");
    throw e;
  }
}

export async function transferToOperator({ api, operatorId, sessionId }) {
  try {
    return await api.call("imopenlines.bot.session.transfer", { SESSION_ID: sessionId, OPERATOR_ID: operatorId });
  } catch (e) {
    logger.error({ e }, "openlines: transfer failed");
    throw e;
  }
}
