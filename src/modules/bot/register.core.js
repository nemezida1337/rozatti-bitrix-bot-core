// src/modules/bot/register.core.js

import { logger } from "../../core/logger.js";
import { getPortal } from "../../core/store.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";
import { sendWelcome, finishDialog, transferToOperator } from "../openlines/api.js";
// Раньше здесь был tryHandleOemMessage, теперь ABCP используется только как поиск в LLM-обработчике
// import { tryHandleSelectionMessage } from "../external/pricing/abcp.js";

function getBotConfig() {
  return {
    CODE: process.env.BOT_CODE || "ram_parts_bot",
    NAME: process.env.BOT_NAME || "RAM Parts Bot",
    OPENLINES_WELCOME: process.env.BOT_OPENLINES_WELCOME || "Здравствуйте!",
  };
}

function botEventsUrl() {
  const base = process.env.BASE_URL || "";
  if (!base) throw new Error("BASE_URL is not set");
  return `${base.replace(/\/+$/, "")}/bitrix/events`;
}

export async function ensureBotRegistered(domain) {
  const portal = getPortal(domain);
  if (!portal) throw new Error("Unknown portal: " + domain);
  const api = makeBitrixClient({
    domain,
    baseUrl: portal.baseUrl,
    accessToken: portal.accessToken,
  });

  // Если бот уже есть — выходим
  try {
    const bots = await api.call("imbot.bot.list", {});
    if (Array.isArray(bots) && bots.find((b) => b.CODE === getBotConfig().CODE)) {
      logger.info({ domain }, "Bot already registered");
      return;
    }
  } catch {
    /* ignore */
  }

  const cfg = getBotConfig();
  const eventsUrl = botEventsUrl();

  // Регистрация бота в стиле оф. примеров: TYPE 'O' + OPENLINE 'Y' + полный набор событий
  const params = {
    CODE: cfg.CODE,
    TYPE: "O", // бот для Open Lines
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
    logger.info({ domain, code: cfg.CODE, botId }, "Bot registered");

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
    if (chatId)
      await sendWelcome({ api, dialogId, text: "Приняли VIN. Ожидайте." });
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
