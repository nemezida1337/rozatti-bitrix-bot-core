import { logger } from "../../core/logger.js";
import { upsertPortal, getPortal } from "../../core/store.js";
import { handleOnImBotMessageAdd, ensureBotRegistered, handleOnImCommandAdd } from "../../modules/bot/register.js";

function isInstallEvent(event) {
  return event === "onappinstall" || event === "onappinstalled" || event === "onappinstalltest";
}

export async function registerRoutes(app) {
  app.post("/bitrix/events", async (req, reply) => {
    const body = req.body || {};
    const event = String(body?.event || "").toLowerCase();

    logger.info({ event, keys: Object.keys(body || {}) }, "Incoming event");

    const domain =
      body?.auth?.domain ||
      body?.auth?.client_endpoint?.replace(/^https?:\/\/(.*?)(\/.*)?$/, "$1") ||
      "unknown";

    // 1) Установка приложения: сохраняем токены + application_token
    if (isInstallEvent(event)) {
      const baseUrl = body?.auth?.client_endpoint || (`https://${domain}`);
      const tokenData = {
        domain,
        baseUrl,
        memberId: body?.auth?.member_id,
        accessToken: body?.auth?.access_token,
        refreshToken: body?.auth?.refresh_token,
        expires: body?.auth?.expires,
        applicationToken: body?.auth?.application_token
      };
      upsertPortal(domain, tokenData);
      logger.info({ domain }, "ONAPPINSTALL: tokens saved");

      try {
        await ensureBotRegistered(domain);
      } catch (e) {
        logger.error({ e, domain }, "Bot registration failed");
      }
      return reply.send({ result: "ok" });
    }

    // 2) Для всех остальных событий сверяем application_token (как в официальных примерах)
    const portal = getPortal(domain);
    const incomingAppToken = body?.auth?.application_token;

    if (portal?.applicationToken && incomingAppToken && portal.applicationToken !== incomingAppToken) {
      logger.warn({ domain }, "application_token mismatch");
      return reply.code(403).send({ error: "bad application_token" });
    }

    // 3) Маршруты событий бота
    if (event === "onimbotmessageadd") {
      if (!portal?.accessToken || !portal?.baseUrl) {
        logger.warn({ domain }, "No portal tokens found");
        return reply.code(401).send({ error: "no tokens" });
      }
      try {
        await handleOnImBotMessageAdd({ body, portal, domain });
        return reply.send({ result: "ok" });
      } catch (e) {
        logger.error({ err: e }, "Message handler failed");
        return reply.code(500).send({ error: "handler failed" });
      }
    }

    if (event === "onimcommandadd") {
      if (!portal?.accessToken || !portal?.baseUrl) {
        logger.warn({ domain }, "No portal tokens found");
        return reply.code(401).send({ error: "no tokens" });
      }
      try {
        await handleOnImCommandAdd({ body, portal, domain });
        return reply.send({ result: "ok" });
      } catch (e) {
        logger.error({ err: e }, "Command handler failed");
        return reply.code(500).send({ error: "handler failed" });
      }
    }

    // Дополнительно просто логируем (можно развить позже)
    if (event === "onimbotmessageupdate" || event === "onimbotmessagedelete" || event === "onimbotjoinchat" || event === "onimbotdelete") {
      logger.info({ event }, "Event received (no-op for now)");
      return reply.send({ result: "noop" });
    }

    logger.info({ event }, "Event not explicitly handled");
    return reply.send({ result: "noop" });
  });
}


