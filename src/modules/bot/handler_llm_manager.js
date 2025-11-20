// src/modules/bot/handler_llm_manager.js
// v4 — правильная интеграция с Bitrix (handleOnImBotMessageAdd({ body, portal, domain }))

import { logger } from "../../core/logger.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";
import { createLeadsApi } from "../crm/leads.js";
import { searchManyOEMs } from "../external/pricing/abcp.js";
import { prepareFunnelContext, runFunnelLLM } from "../llm/llmFunnelEngine.js";
import { getSession, saveSession } from "./sessionStore.js";
import { sendOL, sendTyping } from "../openlines/api.js";

const CTX = "handler_llm";

/**
 * Главный вход: подменяет собой handleOnImBotMessageAdd из register.core.js
 *
 * ВАЖНО: вызывается ТАК:
 *   handleOnImBotMessageAdd({ body, portal, domain })
 * а не (req, res)
 */
export async function processIncomingBitrixMessage({ body, portal, domain }) {
  try {
    // 1) Нормализуем входящее сообщение Bitrix
    const { msg, portalDomain } = normalizeBitrixMessage(body, portal, domain);
    if (!msg) {
      logger.warn(CTX, "Пустое или некорректное сообщение", body);
      return;
    }

    logger.info(
      CTX,
      `Входящее сообщение: "${msg.text}" | ${portalDomain} / ${msg.dialogId}`
    );

    // 2) Подгружаем / создаём сессию
    const session =
      getSession(portalDomain, msg.dialogId) || createEmptySession();

    // 3) Подготовка контекста для LLM
    const llmInput = await prepareFunnelContext({
      session,
      msg: {
        ...msg,
        portal: portalDomain,
        raw: body,
      },
    });

    // 4) Первый проход LLM
    const llm1 = await runFunnelLLM(llmInput);
    logger.debug(CTX, "LLM structured JSON (pass1):", llm1);

    let llm = { ...llm1 };
    let abcpResult = null;

    // 5) ABCP-поиск, если LLM запросил
    if (llm.action === "abcp_lookup" && Array.isArray(llm.oems) && llm.oems.length) {
      logger.info(CTX, "LLM запросил ABCP lookup", llm.oems);

      // эффект "печатает..."
      await sendTyping(portalDomain, msg.dialogId);

      abcpResult = await safeDoABCP(llm.oems);

      // второй проход LLM с результатами ABCP
      llmInput.injectedABCP = abcpResult;
      const llm2 = await runFunnelLLM(llmInput);
      logger.debug(CTX, "LLM structured JSON (pass2):", llm2);

      llm = { ...llm, ...llm2 };
    }

    // 6) Обновление лида в CRM (через createLeadsApi)
    if (llm.update_lead_fields && Object.keys(llm.update_lead_fields).length) {
      await safeUpdateLead({
        portal: portalDomain,
        dialogId: msg.dialogId,
        fields: llm.update_lead_fields,
        session,
      });
    }

    // 7) Ответ клиенту
    if (llm.reply) {
      await sendOL(portalDomain, msg.dialogId, llm.reply);
    }

    // 8) Обновляем и сохраняем сессию
    const newSession = {
      ...session,
      state: {
        stage: llm.stage || session.state.stage,
        client_name:
          llm.client_name !== undefined
            ? llm.client_name
            : session.state.client_name,
        last_reply: llm.reply,
      },
      abcp: abcpResult ?? session.abcp,
      history: [
        ...session.history,
        { role: "user", text: msg.text },
        { role: "assistant", text: llm.reply },
      ],
      updatedAt: Date.now(),
    };

    saveSession(portalDomain, msg.dialogId, newSession);
  } catch (err) {
    logger.error(CTX, "Message handler failed", err);
    // Ничего не бросаем наружу — Bitrix должен получить 200 от Fastify-роута
  }
}

/**
 * Приводим Bitrix-событие к нормальному виду:
 * { portal, dialogId, text }
 */
function normalizeBitrixMessage(body, portal, domain) {
  try {
    const event = body?.event?.toLowerCase?.() || "";
    const data = body?.data || {};
    const params = data.PARAMS || data.FIELDS || {};

    const dialogId =
      params.DIALOG_ID ||
      params.MESSAGE?.DIALOG_ID ||
      params.CHAT_ID && `chat${params.CHAT_ID}`;

    const textRaw =
      params.MESSAGE ||
      params.COMMAND_PARAMS ||
      params.TEXT ||
      "";

    const text = String(textRaw || "").trim();
    const portalDomain = domain || portal || body?.auth?.domain || null;

    if (!portalDomain || !dialogId) {
      return { msg: null, portalDomain };
    }

    return {
      portalDomain,
      msg: {
        dialogId,
        text,
        event,
      },
    };
  } catch (e) {
    logger.error(CTX, "Ошибка normalizeBitrixMessage", e);
    return { msg: null, portalDomain: domain || portal || null };
  }
}

function createEmptySession() {
  return {
    state: {
      stage: "NEW",
      client_name: null,
      last_reply: null,
    },
    abcp: null,
    history: [],
    updatedAt: Date.now(),
  };
}

/**
 * ABCP batch lookup с логами и защитой от ошибок
 */
async function safeDoABCP(oems) {
  try {
    const cleanOems = [...new Set(oems.map((x) => String(x).trim()))].filter(
      Boolean
    );

    if (!cleanOems.length) return {};

    logger.info(CTX, "ABCP batch lookup", { oems: cleanOems });
    const result = await searchManyOEMs(cleanOems);
    return result || {};
  } catch (err) {
    logger.error(CTX, "Ошибка ABCP", err);
    return {};
  }
}

/**
 * CRM: создаём/обновляем лид через createLeadsApi + ensureLeadForDialog
 */
async function safeUpdateLead({ portal, dialogId, fields, session }) {
  try {
    if (!portal || !dialogId) return;
    if (!fields || Object.keys(fields).length === 0) return;

    logger.info(CTX, "CRM update request", { portal, dialogId, fields });

    const rest = makeBitrixClient({ domain: portal });
    const leads = createLeadsApi(rest);

    // гарантируем наличие лида
    const leadId = await leads.ensureLeadForDialog(session, {
      dialogId,
      source: "OPENLINES",
    });

    await leads.updateLead(leadId, fields);

    logger.info(CTX, `CRM lead updated: ${leadId}`);
  } catch (err) {
    logger.error(CTX, "Ошибка CRM safeUpdateLead", err);
  }
}
