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

// ⚠️ Новый импорт: HF-CORTEX клиент
import { callCortexLeadSales } from "../../core/hfCortexClient.js";

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
    name: null, // полное ФИО (строка)
    phone: null,
    address: null, // адрес доставки / ПВЗ СДЭК
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
// Маппер ответа HF-CORTEX → внутренний формат LLMFunnelResponse
//
function mapCortexResultToLLM(cortexResponse) {
  if (!cortexResponse) return null;

  // предполагаем структуру:
  // {
  //   ok: true,
  //   flow: "lead_sales",
  //   context: {...},
  //   result: {
  //     action, stage, reply, reply_text, oems, update_lead_fields,
  //     product_rows, product_picks, client_name, ...
  //   }
  // }
  const res = cortexResponse.result || cortexResponse;

  if (!res || typeof res !== "object") return null;

  const llm = {
    action: res.action || null,
    stage: res.stage || null,
    reply: res.reply ?? res.reply_text ?? null,
    oems: Array.isArray(res.oems) ? res.oems : [],
    update_lead_fields:
      (res.update_lead_fields &&
        typeof res.update_lead_fields === "object" &&
        !Array.isArray(res.update_lead_fields)
        ? res.update_lead_fields
        : {}),
    product_rows: Array.isArray(res.product_rows) ? res.product_rows : [],
    product_picks: Array.isArray(res.product_picks) ? res.product_picks : [],
    client_name:
      res.client_name ??
      cortexResponse.context?.client_name ??
      null,
  };

  return llm;
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
    // 2) Попытка вызвать HF-CORTEX (если включен)
    //
    /** @type {import("../llm/openaiClient.js").LLMFunnelResponse | null} */
    let llm = null;
    let usedBackend = "llm_funnel";

    try {
      const cortexPayload = {
        msg,
        sessionSnapshot: {
          state: session.state,
          leadId: session.leadId,
          leadCreated: session.leadCreated,
          lastQuery: session.lastQuery,
        },
        baseContext,
      };

      const cortexResponse = await callCortexLeadSales(
        cortexPayload,
        logger,
      );

      if (cortexResponse && cortexResponse.ok !== false) {
        const mapped = mapCortexResultToLLM(cortexResponse);

        if (mapped) {
          llm = mapped;
          usedBackend = "hf_cortex";

          eventBus.emit("HF_CORTEX_RESPONSE", {
            portal: msg.portal,
            dialogId: msg.dialogId,
            response: cortexResponse,
            mapped,
          });

          logger.debug(
            { ctx: CTX, mapped },
            "HF-CORTEX mapped LLM response",
          );
        }
      }
    } catch (err) {
      logger.error(
        { ctx: CTX, err },
        "Ошибка вызова HF-CORTEX, fallback на локальный LLM",
      );
      eventBus.emit("HF_CORTEX_ERROR", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        error: {
          message: err.message,
          name: err.name,
        },
      });
      // llm останется null → пойдём по старому пути
    }

    //
    // 2.b Fallback: если HF-CORTEX не дал валидный ответ — используем локальный LLM-поток
    //
    if (!llm) {
      /** @type {import("../llm/openaiClient.js").LLMFunnelResponse} */
      const firstPass = await runFunnelLLM(baseContext);
      llm = firstPass;
      usedBackend = "llm_funnel";

      logger.debug(
        { ctx: CTX, llm },
        "LLM structured JSON (pass 1, local funnel)",
      );

      eventBus.emit("LLM_RESPONSE", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        pass: 1,
        backend: "llm_funnel",
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
        logger.debug(
          { ctx: CTX, llm },
          "LLM structured JSON (pass 2, local funnel)",
        );

        eventBus.emit("LLM_RESPONSE", {
          portal: msg.portal,
          dialogId: msg.dialogId,
          pass: 2,
          backend: "llm_funnel",
          llm,
        });
      }

      // Обновим session.abcp внизу через newSession (см. ниже)
      // Для HF-CORTEX путь с ABCP пока не трогаем — туда будем прокидывать позже.
    } else {
      //
      // HF-CORTEX дал валидный ответ (первый проход)
      //
      eventBus.emit("LLM_RESPONSE", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        pass: "cortex_init",
        backend: usedBackend,
        llm,
      });

      //
      // 3) ABCP для HF-CORTEX (второй проход)
      //
      let abcpResult = null;

      const needABCPForCortex =
        llm &&
        llm.action === "abcp_lookup" &&
        Array.isArray(llm.oems) &&
        llm.oems.length > 0;

      if (needABCPForCortex) {
        // 3.0) ABCP по OEM, которые вернул Cortex
        abcpResult = await safeDoABCP(llm.oems);

        eventBus.emit("ABCP_RESULT", {
          portal: msg.portal,
          dialogId: msg.dialogId,
          oems: llm.oems,
          result: abcpResult,
        });

        // 3.1) Второй проход HF-CORTEX с инъекцией ABCP в baseContext
        try {
          const cortexPayload2 = {
            msg,
            sessionSnapshot: {
              state: {
                ...session.state,
                stage: llm.stage || session.state.stage,
                client_name:
                  llm.client_name ?? session.state.client_name,
                last_reply: llm.reply ?? session.state.last_reply,
              },
              leadId: session.leadId,
              leadCreated: session.leadCreated,
              lastQuery: msg.text,
            },
            baseContext: {
              ...baseContext,
              injectedABCP: abcpResult,
            },
          };

          const cortexResponse2 = await callCortexLeadSales(
            cortexPayload2,
            logger,
          );

          if (cortexResponse2 && cortexResponse2.ok !== false) {
            const mapped2 = mapCortexResultToLLM(cortexResponse2);

            if (mapped2) {
              llm = mapped2;
              usedBackend = "hf_cortex";

              eventBus.emit("HF_CORTEX_RESPONSE", {
                portal: msg.portal,
                dialogId: msg.dialogId,
                response: cortexResponse2,
                mapped: mapped2,
                pass: 2,
              });

              eventBus.emit("LLM_RESPONSE", {
                portal: msg.portal,
                dialogId: msg.dialogId,
                pass: "cortex_abcp",
                backend: usedBackend,
                llm,
              });

              logger.debug(
                { ctx: CTX, llm },
                "HF-CORTEX mapped LLM response (pass 2, with ABCP)",
              );
            }
          }
        } catch (err) {
          logger.error(
            { ctx: CTX, err },
            "Ошибка второго прохода HF-CORTEX с ABCP, продолжаем с первым ответом",
          );
          // В случае ошибки просто остаёмся на первом llm-ответе Cortex
        }
      }
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
    if (llm && llm.reply) {
      await sendOL(msg.portal, msg.dialogId, llm.reply);

      eventBus.emit("OL_SEND", {
        portal: msg.portal,
        dialogId: msg.dialogId,
        text: llm.reply,
        backend: usedBackend,
      });
    }

    //
    // 6) Сохранение сессии
    //
    const newSession = {
      ...session,
      state: {
        stage: (llm && llm.stage) || session.state.stage,
        client_name:
          (llm && llm.client_name) ?? session.state.client_name,
        last_reply: llm ? llm.reply : session.state.last_reply,
      },
      // Для HF-CORTEX мы пока abcp не трогаем (будем прокидывать позже)
      // здесь оставляем старое значение, если ABCP не дергался в local-funnel
      updatedAt: Date.now(),
      history: [
        ...session.history,
        { role: "user", text: msg.text },
        ...(llm && llm.reply
          ? [{ role: "assistant", text: llm.reply }]
          : []),
      ],
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
