// src/http/routes/bitrix.js

import { logger } from "../../core/logger.js";
import { upsertPortal, getPortal } from "../../core/store.js";
import {
  handleOnImBotMessageAdd,
  ensureBotRegistered,
  handleOnImCommandAdd,
} from "../../modules/bot/register.js";

function isInstallEvent(event) {
  if (!event) return false;
  const e = String(event).toLowerCase();
  return (
    e === "onappinstall" ||
    e === "onappinstalled" ||
    e === "onappinstalltest"
  );
}

function extractDomain(body = {}) {
  // onappinstall — auth снаружи
  if (body?.auth?.domain) return body.auth.domain;
  if (body?.auth?.DOMAIN) return body.auth.DOMAIN;

  // обычные события — AUTH внутри data
  if (body?.data?.AUTH?.domain) return body.data.AUTH.domain;
  if (body?.data?.AUTH?.DOMAIN) return body.data.AUTH.DOMAIN;

  return null;
}

export async function registerRoutes(app) {
  app.post("/bitrix/events", async (req, reply) => {
    const body = req.body || {};
    const rawEvent = body?.event || "";
    const event = String(rawEvent || "").toLowerCase();

    // базовый лог входящего события
    logger.info(
      { event, keys: Object.keys(body || {}) },
      "Incoming event"
    );

    const domain = extractDomain(body);

    try {
      // === УСТАНОВКА / ПЕРЕУСТАНОВКА ПРИЛОЖЕНИЯ ===
      if (isInstallEvent(event)) {
        if (!domain) {
          logger.error({ body }, "ONAPPINSTALL without domain");
          return reply.code(400).send({ error: "DOMAIN_REQUIRED" });
        }

        await upsertPortal(domain, body.auth || body.data?.AUTH || {});
        logger.info({ domain }, "ONAPPINSTALL: tokens saved");

        try {
          await ensureBotRegistered(domain);
        } catch (e) {
          logger.error({ e, domain }, "Bot registration failed");
        }

        return reply.send({ result: "ok" });
      }

      // дальше — любые обычные события, без домена не работаем
      if (!domain) {
        logger.warn({ event, body }, "Event without domain");
        return reply.code(400).send({ error: "DOMAIN_REQUIRED" });
      }

      const portal = await getPortal(domain);

      // === ДОП. ЛОГ ДЛЯ onImBotMessageAdd — ВИДИМ ТЕКСТ И DIALOG_ID ===
      if (event === "onimbotmessageadd") {
        const params = body?.data?.PARAMS || body?.data?.params || {};
        const logPayload = {
          domain,
          dialogId: params.DIALOG_ID || params.DIALOG || params.CHAT_ID,
          chatId: params.CHAT_ID,
          fromUserId: params.FROM_USER_ID,
          messageId: params.MESSAGE_ID,
          text: params.MESSAGE || body?.data?.TEXT || null,
        };

        logger.info(logPayload, "[LLM] Incoming bot message");
      }

      // === МАРШРУТИЗАЦИЯ СОБЫТИЙ ===

      if (event === "onimbotmessageadd") {
        await handleOnImBotMessageAdd({ portal, body });
        return reply.send({ result: "ok" });
      }

      if (event === "onimcommandadd") {
        await handleOnImCommandAdd({ portal, body });
        return reply.send({ result: "ok" });
      }

      // Прочие бот-события пока просто логируем
      if (
        event === "onimbotmessageupdate" ||
        event === "onimbotjoinchat" ||
        event === "onimbotdelete"
      ) {
        logger.info({ event, domain }, "Bot event (no-op for now)");
        return reply.send({ result: "noop" });
      }

      // Всё остальное — в no-op, но с логом
      logger.info({ event, domain }, "Event not explicitly handled");
      return reply.send({ result: "noop" });
    } catch (e) {
      logger.error(
        { e, event, domain, body },
        "Error while handling Bitrix event"
      );
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });
}
