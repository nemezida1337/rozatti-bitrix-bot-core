// src/http/routes/bitrix.js (v4)
// Правильная версия, совместимая с app.js

import { handleOnImBotMessageAdd } from "../../modules/bot/register.js";

export function registerRoutes(router) {
  // Основные события OpenLines / IM
  router.post("/im.bot.message.add", async (req, res) => {
    await handleOnImBotMessageAdd(req, res);
  });

  router.post("/im.message.add", async (req, res) => {
    await handleOnImBotMessageAdd(req, res);
  });

  // fallback — любые нестандартные event-хуки Bitrix24
  router.post("/event", async (req, res) => {
    await handleOnImBotMessageAdd(req, res);
  });
}
