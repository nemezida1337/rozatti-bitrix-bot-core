// src/modules/bot/handler_llm_manager.js (v4, фикс логгера)
// ЧИСТЫЙ ОРКЕСТРАТОР ДИАЛОГА
// Вся бизнес-логика — в LLM + модулях (ABCP, CRM, OL)

import { logger } from "../../core/logger.js";
import { searchManyOEMs } from "../external/pricing/abcp.js";
// CRM-обновление пока отключено
// import { createLeadsApi } from "../crm/leads.js";
import { prepareFunnelContext, runFunnelLLM } from "../llm/llmFunnelEngine.js";
import { normalizeIncomingMessage } from "../../core/messageModel.js";
import { saveSession, getSession } from "./sessionStore.js";
import { sendOL } from "../openlines/api.js";

const CTX = "handler_llm";

//
// Безопасный ответ Bitrix (работает и с Fastify reply, и с Express res)
//
function safeReply(res, payload = "ok") {
  if (!res) return;
  try {
    if (typeof res.code === "function" && typeof res.send === "function") {
      return res.code(200).send(payload); // Fastify
    }
    if (typeof res.status === "function" && typeof res.send === "function") {
      return res.status(200).send(payload); // Express-подобный
    }
    if (typeof res.send === "function") {
      return res.send(payload); // запасной вариант
    }
  } catch (e) {
    logger.error(
      { ctx: CTX, error: e },
      "Ошибка при отправке ответа Bitrix",
    );
  }
}

//
// MAIN ENTRY POINT
//
export async function processIncomingBitrixMessage(req, res) {
  try {
    const msg = normalizeIncomingMessage(req.body);

    if (!msg || !msg.portal || !msg.dialogId) {
      logger.warn(
        { ctx: CTX, body: req.body },
        "Некорректное входящее сообщение",
      );
      safeReply(res);
      return;
    }

    logger.info(
      {
        ctx: CTX,
        portal: msg.portal,
        dialogId: msg.dialogId,
        fromUserId: msg.fromUserId,
      },
      `Входящее сообщение: "${msg.text}"`,
    );

    const session = getSession(msg.portal, msg.dialogId) || createEmptySession();
    const llmInput = await prepareFunnelContext({ session, msg });

    //
    // 1) LLM → strict JSON
    //
    const llm = await runFunnelLLM(llmInput);
    logger.debug({ ctx: CTX, llm }, "LLM structured JSON");

    //
    // 2) ABCP (ТОЛЬКО если LLM запросил)
    //
    let abcpResult = null;
    if (llm.action === "abcp_lookup" && llm.oems?.length) {
      abcpResult = await safeDoABCP(llm.oems);
      llmInput.injectedABCP = abcpResult;

      // повторный прогон LLM с ABCP-данными
      const llm2 = await runFunnelLLM(llmInput);
      Object.assign(llm, llm2);
    }

    //
    // 3) Обновление лида в CRM (ПОКА ЗАГЛУШКА — см. safeUpdateLead)
    //
    if (llm.update_lead_fields) {
      await safeUpdateLead({
        portal: msg.portal,
        dialogId: msg.dialogId,
        fields: llm.update_lead_fields,
      });
    }

    //
    // 4) Ответ клиенту в Открытые линии
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

    safeReply(res);
  } catch (err) {
    logger.error({ ctx: CTX, err }, "Ошибка обработки сообщения");
    safeReply(res);
  }
}

//
// CREATE EMPTY SESSION
//
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
// ABCP WRAPPER
//
async function safeDoABCP(oems) {
  try {
    if (!oems || !oems.length) return {};
    logger.info({ ctx: CTX, oems }, "ABCP lookup");

    // Новый API ABCP: один вызов по массиву OEM, возвращает
    // { OEM: { offers: [...] }, ... }
    const result = await searchManyOEMs(oems);
    logger.debug({ ctx: CTX, result }, "ABCP result");
    return result;
  } catch (err) {
    logger.error({ ctx: CTX, err }, "Ошибка ABCP");
    return {};
  }
}

//
// LEAD UPDATE WRAPPER (ПОКА ЗАГЛУШКА)
//
async function safeUpdateLead(_opts) {
  // TODO: аккуратно завязать на createLeadsApi(rest) из crm/leads.js,
  // чтобы обновлять NAME/PHONE/STATUS_ID и product rows по выбору ABCP.
  return;
}
