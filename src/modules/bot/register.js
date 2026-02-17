// src/modules/bot/register.js
// Обёртка вокруг register.core.js с подменой обработчика сообщений на LLM

console.info("[LLM] register wrapper loaded");

// Реэкспортируем всё, что явно экспортируется из core
export * from "./register.core.js";
import { processIncomingBitrixMessage } from "./handler/index.js";
import * as core from "./register.core.js";

function makeEnsureFallback() {
  return async (...args) => {
    console.warn(
      "[LLM] ensureBotRegistered not found in register.core.js, noop called",
      args
    );
  };
}

function makeCommandFallback() {
  return async (...args) => {
    console.warn(
      "[LLM] handleOnImCommandAdd not found in register.core.js, noop called",
      args
    );
  };
}

export function resolveRegisterExports(coreModule, llmHandler) {
  const ensureBotRegisteredCore =
    coreModule.ensureBotRegistered || coreModule.default?.ensureBotRegistered;

  const handleOnImCommandAddCore =
    coreModule.handleOnImCommandAdd || coreModule.default?.handleOnImCommandAdd;

  const ensureBotRegistered =
    ensureBotRegisteredCore || makeEnsureFallback();

  const handleOnImCommandAdd =
    handleOnImCommandAddCore || makeCommandFallback();

  let defaultExport = coreModule.default;
  if (defaultExport && typeof defaultExport === "object") {
    defaultExport = {
      ...defaultExport,
      handleOnImBotMessageAdd: llmHandler,
      ensureBotRegistered:
        ensureBotRegisteredCore || defaultExport.ensureBotRegistered,
      handleOnImCommandAdd:
        handleOnImCommandAddCore || defaultExport.handleOnImCommandAdd,
    };
  }

  return {
    ensureBotRegistered,
    handleOnImCommandAdd,
    defaultExport,
  };
}

const resolved = resolveRegisterExports(core, processIncomingBitrixMessage);

// Подменяем только обработчик входящих сообщений
export const handleOnImBotMessageAdd = processIncomingBitrixMessage;

// Остальные функции пробрасываем из core
export const ensureBotRegistered = resolved.ensureBotRegistered;
export const handleOnImCommandAdd = resolved.handleOnImCommandAdd;
export default resolved.defaultExport;
