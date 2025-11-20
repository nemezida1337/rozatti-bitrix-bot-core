// src/modules/bot/register.core.js
// Минимальный модуль регистрации команд/обработчиков.
// Здесь НЕ должно быть ABCP-логики.

import { logger } from "../../core/logger.js";
import { sendOL } from "../openlines/api.js";
import { processIncomingBitrixMessage } from "./handler_llm_manager.js";

const CTX = "register.core";

// Обёртка: Bitrix вызывает этот метод при каждом входящем сообщении.
export async function handleBotMessage(req, res) {
  try {
    await processIncomingBitrixMessage(req, res);
  } catch (err) {
    logger.error(CTX, "Ошибка handleBotMessage", err);

    // Ответить Bitrix, чтобы он не ретраил
    res.status(200).send("ok");
  }
}

// Дополнительные команды, если нужны
export function registerBotCommands() {
  logger.info(CTX, "Команды бота зарегистрированы (если требуются)");
}
