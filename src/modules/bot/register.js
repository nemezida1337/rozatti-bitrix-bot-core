// src/modules/bot/register.js
// Обёртка вокруг register.core.js с подменой обработчика сообщений на LLM

console.info("[LLM] register wrapper loaded");

// Реэкспортируем всё, что явно экспортируется из core
export * from "./register.core.js";
import { processIncomingBitrixMessage } from "./handler/index.js";
import * as core from "./register.core.js";

// Новый LLM-хендлер (подменяет старый)

// --- Достаём функции из core ---
// Могут быть либо named-экспортами, либо лежать в default-объекте.

const ensureBotRegisteredCore =
  core.ensureBotRegistered || core.default?.ensureBotRegistered;

const handleOnImCommandAddCore =
  core.handleOnImCommandAdd || core.default?.handleOnImCommandAdd;

// Подменяем только обработчик входящих сообщений
export const handleOnImBotMessageAdd = processIncomingBitrixMessage;

// Остальные функции пробрасываем из core
export const ensureBotRegistered =
  ensureBotRegisteredCore ||
  (async (...args) => {
    console.warn(
      "[LLM] ensureBotRegistered not found in register.core.js, noop called",
      args
    );
  });

export const handleOnImCommandAdd =
  handleOnImCommandAddCore ||
  (async (...args) => {
    console.warn(
      "[LLM] handleOnImCommandAdd not found in register.core.js, noop called",
      args
    );
  });

// Default экспорт — на случай, если где-то импортят default
let _default = core.default;
if (_default && typeof _default === "object") {
  _default = {
    ..._default,
    handleOnImBotMessageAdd: processIncomingBitrixMessage,
    ensureBotRegistered: ensureBotRegisteredCore || _default.ensureBotRegistered,
    handleOnImCommandAdd:
      handleOnImCommandAddCore || _default.handleOnImCommandAdd,
  };
}
export default _default;
