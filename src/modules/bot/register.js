/**
 * AUTO WRAP: всё из register.core.js, но handleOnImBotMessageAdd — наш LLM-менеджер.
 */
console.info("[LLM] register wrapper loaded");
export * from "./register.core.js";
import * as core from "./register.core.js";
import { handleOnImBotMessageAdd as handleLLM } from "./handler_llm_manager.js";

// Перекрываем именно то, что зовёт роутер:
export { handleLLM as handleOnImBotMessageAdd };

// На всякий случай дадим default с подменой (если где-то импортят default)
let _default = core.default;
if (_default && typeof _default === "object") {
  _default = { ..._default, handleOnImBotMessageAdd: handleLLM };
}
export default _default;
