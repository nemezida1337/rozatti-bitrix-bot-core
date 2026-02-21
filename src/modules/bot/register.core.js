// @ts-check

// src/modules/bot/register.core.js

import { makeBitrixClient } from "../../core/bitrixClient.js";
import { logger } from "../../core/logger.js";
import { getPortalAsync } from "../../core/store.js";
import { sendWelcome } from "../openlines/api.js";
// Раньше здесь был tryHandleOemMessage, теперь ABCP используется только как поиск в LLM-обработчике
// import { tryHandleSelectionMessage } from "../external/pricing/abcp.js";

/** @typedef {Record<string, any>} AnyRecord */

/**
 * @typedef {Object} BotConfig
 * @property {string} CODE
 * @property {string} NAME
 * @property {string} OPENLINES_WELCOME
 */

/**
 * @typedef {Object} PortalAuth
 * @property {string} [domain]
 * @property {string} [baseUrl]
 * @property {string} [accessToken]
 */

/**
 * @typedef {Object} HandlerInput
 * @property {AnyRecord} body
 * @property {PortalAuth} portal
 * @property {string} domain
 */

/** @returns {BotConfig} */
function getBotConfig() {
  return {
    CODE: process.env.BOT_CODE || "ram_parts_bot",
    NAME: process.env.BOT_NAME || "RAM Parts Bot",
    OPENLINES_WELCOME: process.env.BOT_OPENLINES_WELCOME || "Здравствуйте!",
  };
}

/** @returns {string} */
function botEventsUrl() {
  const base = process.env.BASE_URL || "";
  if (!base) throw new Error("BASE_URL is not set");
  const url = `${base.replace(/\/+$/, "")}/bitrix/events`;

  // P0: если включён секрет для вебхуков — автоматически прокидываем его в URL,
  // чтобы Bitrix присылал события на тот же endpoint.
  const secret = process.env.BITRIX_EVENTS_SECRET || "";
  if (secret) {
    return `${url}?secret=${encodeURIComponent(secret)}`;
  }
  return url;
}

/**
 * @param {unknown} botList
 * @param {string} botCode
 * @returns {AnyRecord|null}
 */
function findBotByCode(botList, botCode) {
  const code = String(botCode || "").toLowerCase();
  if (!code) return null;

  if (Array.isArray(botList)) {
    const hit = botList.find((b) => String(b?.CODE || "").toLowerCase() === code);
    return hit || null;
  }

  if (botList && typeof botList === "object") {
    for (const bot of Object.values(/** @type {AnyRecord} */ (botList))) {
      if (String(bot?.CODE || "").toLowerCase() === code) return /** @type {AnyRecord} */ (bot);
    }
  }

  return null;
}

/**
 * Поддерживаем привязку welcome-бота в Открытых линиях:
 * если там остался старый BOT_ID, события в нашего бота не приходят.
 * @param {{ call: (method: string, params?: Record<string, any>) => Promise<any> }} api
 * @param {string|number} botId
 * @param {string} domain
 */
async function syncWelcomeBotBindings(api, botId, domain) {
  try {
    const list = await api.call("imopenlines.config.list.get", {});
    const rows = Array.isArray(list) ? list : Object.values(list || {});
    const target = String(botId);
    const patched = [];

    for (const row of rows) {
      const enabled = String(row?.WELCOME_BOT_ENABLE || "N") === "Y";
      const currentId = String(row?.WELCOME_BOT_ID || "0");
      if (!enabled || currentId === target) continue;

      await api.call("imopenlines.config.update", {
        CONFIG_ID: Number(row?.ID),
        PARAMS: {
          WELCOME_BOT_ENABLE: "Y",
          WELCOME_BOT_ID: Number(botId),
          WELCOME_BOT_JOIN: row?.WELCOME_BOT_JOIN || "always",
        },
      });

      patched.push({
        configId: row?.ID,
        lineName: row?.LINE_NAME || null,
        oldBotId: currentId,
        newBotId: target,
      });
    }

    if (patched.length > 0) {
      logger.info(
        { domain, patchedCount: patched.length, patched },
        "Open Lines welcome bot bindings updated",
      );
    }
  } catch (e) {
    logger.warn({ domain, e: String(e) }, "Open Lines welcome bot sync skipped");
  }
}

/** @param {string} domain */
export async function ensureBotRegistered(domain) {
  const portal = await getPortalAsync(domain);
  if (!portal) throw new Error("Unknown portal: " + domain);
  const api = makeBitrixClient({
    domain,
    baseUrl: portal.baseUrl,
    accessToken: portal.accessToken,
  });

  // Проверяем наличие бота заранее: если уже есть, будем только обновлять callback-и.
  let existedBot = null;
  try {
    const bots = await api.call("imbot.bot.list", {});
    existedBot = findBotByCode(bots, getBotConfig().CODE);
  } catch {
    /* ignore */
  }

  const cfg = getBotConfig();
  const eventsUrl = botEventsUrl();
  const botType = process.env.BOT_TYPE || "O";

  // Регистрация бота в стиле оф. примеров: TYPE 'O' + OPENLINE 'Y' + полный набор событий
  const params = {
    CODE: cfg.CODE,
    TYPE: botType, // для диагностики можно переключить через BOT_TYPE (например, B)
    OPENLINE: "Y", // критично для ОЛ-режима
    EVENT_MESSAGE_ADD: eventsUrl,
    EVENT_WELCOME_MESSAGE: eventsUrl,
    EVENT_BOT_DELETE: eventsUrl,
    EVENT_MESSAGE_UPDATE: eventsUrl,
    EVENT_MESSAGE_DELETE: eventsUrl,
    PROPERTIES: {
      NAME: cfg.NAME,
      COLOR: "AZURE",
    },
  };

  try {
    const botId = await api.call("imbot.register", params);
    logger.info(
      { domain, code: cfg.CODE, botId, refreshed: !!existedBot },
      existedBot ? "Bot callbacks refreshed" : "Bot registered",
    );

    await syncWelcomeBotBindings(api, botId, domain);

    // Для существующего бота команды уже зарегистрированы.
    // Повторная регистрация команд может плодить дубли в некоторых инсталляциях.
    if (existedBot) return;

    // Регистрируем команды как в EchoBot
    const lang = [{ LANGUAGE_ID: "en", TITLE: "Show help", PARAMS: "" }];
    await api.call("imbot.command.register", {
      BOT_ID: botId,
      COMMAND: "help",
      COMMON: "Y",
      HIDDEN: "N",
      EXTRANET_SUPPORT: "N",
      LANG: lang,
      EVENT_COMMAND_ADD: eventsUrl,
    });
    await api.call("imbot.command.register", {
      BOT_ID: botId,
      COMMAND: "lead",
      COMMON: "Y",
      HIDDEN: "N",
      EXTRANET_SUPPORT: "N",
      LANG: [{ LANGUAGE_ID: "en", TITLE: "Create CRM lead", PARAMS: "text" }],
      EVENT_COMMAND_ADD: eventsUrl,
    });
    await api.call("imbot.command.register", {
      BOT_ID: botId,
      COMMAND: "vin",
      COMMON: "Y",
      HIDDEN: "N",
      EXTRANET_SUPPORT: "N",
      LANG: [{ LANGUAGE_ID: "en", TITLE: "VIN lookup", PARAMS: "VIN" }],
      EVENT_COMMAND_ADD: eventsUrl,
    });
  } catch (e) {
    logger.error({ e }, "imbot.register (or commands) failed");
    throw e;
  }
}

// Утилита: извлечь CHAT_ID из DIALOG_ID типа "chat12345" (нужно для некоторых методов ОЛ)
/** @param {string|undefined|null} dialogId */
function getChatIdFromDialogId(dialogId) {
  if (typeof dialogId !== "string") return null;
  if (dialogId.startsWith("chat")) {
    const n = Number(dialogId.slice(4));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Обработка нового сообщения (ONIMBOTMESSAGEADD) — "старый" простой контур
// (LLM-контур реализован в handler_llm_manager.js и вешается отдельно через обёртку register.js)
/** @param {HandlerInput} input */
export async function handleOnImBotMessageAdd({ body, portal, domain }) {
  const api = makeBitrixClient({
    domain,
    baseUrl: portal.baseUrl,
    accessToken: portal.accessToken,
  });
  const msg = body?.data?.PARAMS || {};
  const dialogId = msg?.DIALOG_ID;
  const text = String(msg?.MESSAGE || "").trim();
  const entityType = msg?.CHAT_ENTITY_TYPE; // "LINES" для ОЛ
  const chatId = entityType === "LINES" ? getChatIdFromDialogId(dialogId) : null;

  if (/^\/?help\b/i.test(text)) {
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: "Команды: /help, /lead <текст>, /vin <номер>",
    });
    return;
  }

  if (/^\/?vin\s+/i.test(text)) {
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: "VIN-поиск принят. (модуль подключается отдельно)",
    });
    if (chatId) await sendWelcome({ api, dialogId, text: "Приняли VIN. Ожидайте." });
    return;
  }

  if (/^\/?lead\s+/i.test(text)) {
    const title = text.replace(/^\/?lead\s+/i, "").trim() || "Лид из чата";
    const leadId = await api.call("crm.lead.add", {
      fields: { TITLE: title },
    });
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: `Создал лид #${leadId}`,
    });
    return;
  }

  // По умолчанию — простой ответ (этот контур можно почти не использовать,
  // основной интеллектуальный диалог ведёт LLM через handler_llm_manager)
  await api.call("imbot.message.add", {
    DIALOG_ID: dialogId,
    MESSAGE: "Принято. Напишите VIN или номер детали.",
  });
}

// Обработка команд (ONIMCOMMANDADD) — EchoBot-подобный ответ
/** @param {HandlerInput} input */
export async function handleOnImCommandAdd({ body, portal, domain }) {
  const api = makeBitrixClient({
    domain,
    baseUrl: portal.baseUrl,
    accessToken: portal.accessToken,
  });
  const cmd = body?.data || {};
  const dialogId = cmd?.DIALOG_ID || cmd?.PARAMS?.DIALOG_ID;

  const command = String(cmd?.COMMAND || "").toLowerCase();
  const params = String(cmd?.COMMAND_PARAMS || "").trim();

  if (command === "help") {
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: "Команды: /help, /lead <текст>, /vin <VIN>",
    });
    return;
  }
  if (command === "lead") {
    const title = params || "Лид из чата";
    const leadId = await api.call("crm.lead.add", {
      fields: { TITLE: title },
    });
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: `Создал лид #${leadId}`,
    });
    return;
  }
  if (command === "vin") {
    await api.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: `VIN '${params}' принят. (модуль подключается отдельно)`,
    });
    return;
  }

  await api.call("imbot.message.add", {
    DIALOG_ID: dialogId,
    MESSAGE: "Неизвестная команда. /help",
  });
}
