// handler_llm_manager.js (v3)
// Полностью исправленная версия с правильной CRM-интеграцией.

import { logger } from "../../core/logger.js";
import { makeBitrixClient } from "../../core/bitrixClient.js";
import { createLeadsApi } from "../crm/leads.js";
import { searchManyOEMs } from "../external/pricing/abcp.js";
import { prepareFunnelContext, runFunnelLLM } from "../llm/llmFunnelEngine.js";
import { normalizeIncomingMessage } from "../../core/messageModel.js";
import { saveSession, getSession } from "./sessionStore.js";
import { sendOL } from "../openlines/api.js";

const CTX = "handler_llm";

export async function processIncomingBitrixMessage(req, res) {
  try {
    const msg = normalizeIncomingMessage(req.body);

    if (!msg || !msg.portal || !msg.dialogId) {
      logger.warn(CTX, "Некорректное входящее сообщение", req.body);
      return res.status(200).send("ok");
    }

    logger.info(
      CTX,
      `Входящее сообщение: "${msg.text}" | ${msg.portal} / ${msg.dialogId}`
    );

    const session =
      getSession(msg.portal, msg.dialogId) || createEmptySession();

    const llmInput = await prepareFunnelContext({ session, msg });

    //
    // 1) Первый проход LLM
    //
    const llm = await runFunnelLLM(llmInput);
    logger.debug(CTX, "LLM structured JSON:", llm);

    //
    // 2) ABCP-поиск если LLM запросил
    //
    let abcpResult = null;

    if (llm.action === "abcp_lookup" && llm.oems?.length) {
      logger.info(CTX, "LLM запросил ABCP lookup", llm.oems);

      abcpResult = await safeDoABCP(llm.oems);

      // второй проход LLM с ABCP
      llmInput.injectedABCP = abcpResult;
      const llm2 = await runFunnelLLM(llmInput);
      Object.assign(llm, llm2);
    }

    //
    // 3) CRM – создаём/обновляем лид
    //
    if (llm.update_lead_fields) {
      await safeUpdateLead({
        portal: msg.portal,
        dialogId: msg.dialogId,
        fields: llm.update_lead_fields,
        session,
      });
    }

    //
    // 4) Ответ клиенту
    //
    if (llm.reply) {
      await sendOL(msg.portal, msg.dialogId, llm.reply);
    }

    //
    // 5) Сохранение сессии
    //
    const newSession = {
      ...session,
      state: {
        stage: llm.stage || session.state.stage,
        client_name: llm.client_name ?? session.state.client_name,
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

    saveSession(msg.portal, msg.dialogId, newSession);

    return res.status(200).send("ok");
  } catch (err) {
    logger.error(CTX, "Ошибка обработки сообщения", err);
    return res.status(200).send("ok");
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

//
// Новый ABCP batch lookup
//
async function safeDoABCP(oems) {
  try {
    logger.info(CTX, "ABCP batch lookup", { oems });

    const result = await searchManyOEMs(oems);
    return result;
  } catch (err) {
    logger.error(CTX, "Ошибка ABCP", err);
    return {};
  }
}

//
// === ПРАВИЛЬНАЯ CRM-ИНТЕГРАЦИЯ ===
//
async function safeUpdateLead({ portal, dialogId, fields, session }) {
  try {
    if (!fields || Object.keys(fields).length === 0) return;

    logger.info(CTX, "CRM update request", fields);

    // создаём REST-клиент Bitrix
    const rest = makeBitrixClient({ domain: portal });

    // создаём CRM API
    const leads = createLeadsApi(rest);

    // гарантируем существование лида
    const leadId = await leads.ensureLeadForDialog(session, {
      dialogId,
      source: "OPENLINES",
    });

    // обновляем поля
    await leads.updateLead(leadId, fields);

    logger.info(CTX, `CRM lead updated: ${leadId}`);
  } catch (err) {
    logger.error(CTX, "Ошибка CRM safeUpdateLead", err);
  }
}
