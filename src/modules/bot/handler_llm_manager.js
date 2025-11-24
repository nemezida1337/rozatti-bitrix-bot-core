// src/modules/bot/handler_llm_manager.js
// ЧИСТЫЙ ОРКЕСТРАТОР ДИАЛОГА
// Вся бизнес-логика — в LLM + модулях (ABCP, CRM, OL)

import { logger } from "../../core/logger.js";
import { eventBus } from "../../core/eventBus.js";
import { normalizeIncomingMessage } from "../../core/messageModel.js";
import { safeUpdateLeadAndContact } from "../crm/leads.js";
import { searchManyOEMs } from "../external/pricing/abcp.js";
import { prepareFunnelContext, runFunnelLLM } from "../llm/llmFunnelEngine.js";
import { sendOL } from "../openlines/api.js";

import { saveSession, getSession } from "./sessionStore.js";

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
// CREATE EMPTY SESSION
//
function createEmptySession() {
  return {
    state: {
      stage: "NEW",
      client_name: null,
      last_reply: null,
    },
    // CRM
    name: null,        // полное ФИО (строка)
    phone: null,
    address: null,     // адрес доставки / ПВЗ СДЭК
    lastQuery: null,
    leadId: null,
    leadCreated: false,
    // ABCP + история
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

    // 0) Сессия
    const session =
      getSession(msg.portal, msg.dialogId) || createEmptySession();

    // EventBus: входящее сообщение пользователя
    eventBus.emit("USER_MESSAGE", {
      portal: msg.portal,
      dialogId: msg.dialogId,
      text: msg.text,
      session,
    });

    // 1) Подготовка контекста для LLM
    const baseContext = await prepareFunnelContext({ session, msg });

    //
    // 2) LLM → strict JSON (первый проход)
    //
    /** @type {import("../llm/openaiClient.js").LLMFunnelResponse} */
    let llm = await runFunnelLLM(baseContext);
    logger.debug({ ctx: CTX, llm }, "LLM structured JSON (pass 1)");

    eventBus.emit("LLM_RESPONSE", {
      portal: msg.portal,
      dialogId: msg.dialogId,
      pass: 1,
      llm,
    });

    //
    // 3) ABCP (ТОЛЬКО если LLM запросил abcp_lookup по OEM)
    //
    let abcpResult = null;

    const needABCP =
      llm &&
      llm.action === "abcp_lookup" &&
      Array.isArray(llm.oems) &&
      llm.oems.length > 0;

    if (needABCP) {
      abcpResult = await safeDoABCP(llm.oems);

      eventBus.emit("ABCP_RESULT", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        oems: llm.oems,
        result: abcpResult,
      });

      // 3.1) Второй проход LLM с инъекцией ABCP
      const contextWithABCP = {
        ...baseContext,
        injectedABCP: abcpResult,
      };

      llm = await runFunnelLLM(contextWithABCP);
      logger.debug({ ctx: CTX, llm }, "LLM structured JSON (pass 2)");

      eventBus.emit("LLM_RESPONSE", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        pass: 2,
        llm,
      });
    }

    //
    // 4) Безопасное обновление лида + контакта в CRM
    //
    if (
      llm &&
      ((llm.update_lead_fields &&
        Object.keys(llm.update_lead_fields).length > 0) ||
        (Array.isArray(llm.oems) && llm.oems.length > 0) ||
        (Array.isArray(llm.product_rows) && llm.product_rows.length > 0) ||
        (Array.isArray(llm.product_picks) && llm.product_picks.length > 0))
    ) {
      await safeUpdateLeadAndContact({
        portal: msg.portal,
        dialogId: msg.dialogId,
        session,
        llm,
        lastUserMessage: msg.text,
      });
    }

    //
    // 5) Ответ клиенту в Открытые линии
    //
    if (llm.reply) {
      await sendOL(msg.portal, msg.dialogId, llm.reply);

      eventBus.emit("OL_SEND", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        text: llm.reply,
      });
    }

    //
    // 6) Сохранение сессии
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

    eventBus.emit("SESSION_UPDATED", {
      portal: msg.portal,
      dialogId: msg.dialogId,
      session: newSession,
    });

    safeReply(res);
  } catch (err) {
    logger.error({ ctx: CTX, err }, "Ошибка обработки сообщения");
    safeReply(res);
  }
}
