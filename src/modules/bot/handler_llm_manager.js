// src/modules/bot/handler_llm_manager.js
// LLM-бот + ABCP + лиды. Диалог полностью ведёт LLM,
// этот модуль только оркестрирует внешние действия (ABCP, CRM, сессия).

import { makeBitrixClient } from "../../core/bitrixClient.js";
import { getSession } from "./sessionStore.js";
import {
  searchOemForText,
  tryHandleSelectionMessage,
} from "../external/pricing/abcp.js";
import { createLeadsApi } from "../crm/leads.js";
import {
  extractPhone,
  isForwardWrapper,
  isConfirmAnswer,
  updateSessionContactFromText,
} from "./contactUtils.js";
import { runFunnelLLM } from "../llm/llmFunnelEngine.js";

async function sendMessage(rest, dialogId, text) {
  if (!text) return;
  await rest.call("imbot.message.add", {
    DIALOG_ID: dialogId,
    MESSAGE: text,
  });
}

export async function handleOnImBotMessageAdd({ body, portal, domain }) {
  const msg = body?.data?.PARAMS || {};
  const dialogId = msg.DIALOG_ID;
  const textRaw = msg.MESSAGE;
  const text = String(textRaw || "").trim();

  if (!dialogId) {
    console.warn("[llm-bot] Missing DIALOG_ID in onImBotMessageAdd");
    return;
  }

  const api = makeBitrixClient({
    domain,
    baseUrl: portal.baseUrl,
    accessToken: portal.accessToken,
  });

  const rest = api;
  const leadsApi = createLeadsApi(rest);

  const sessionKey = dialogId;
  const session = getSession(sessionKey);

  console.log("[llm-bot] incoming:", { dialogId, text });

  const confirm = isConfirmAnswer(text);
  const forwardWrapper = isForwardWrapper(text);

  // 0) Обработка выбора по цифрам (1 3 / 2x2)
  // Здесь ABCP сам отправляет сообщение клиенту «Принято. Вы выбрали: ...»
  // После успешной обработки выбора просто выходим, чтобы не дублировать ответ через LLM.
  try {
    const selectionResult = await tryHandleSelectionMessage({
      api,
      dialogId,
      text,
    });
    if (selectionResult && selectionResult.handled) {
      session.selectedItems = selectionResult.picks || [];
      console.log(
        "[llm-bot] ABCP selection handled, picks:",
        session.selectedItems.length
      );

      if (session.leadId && session.selectedItems.length) {
        try {
          await leadsApi.setProductRowsFromSelection(
            session.leadId,
            session.selectedItems
          );
          console.log(
            "[llm-bot] Product rows set from selection:",
            session.selectedItems.length
          );
        } catch (err) {
          console.error(
            "[llm-bot] Failed to set product rows from selection:",
            err
          );
        }
      }

      return;
    }
  } catch (e) {
    console.error("[llm-bot] ABCP selection error:", e);
  }

  // 1) Обновление телефона из текста (LLM тоже может дать PHONE в JSON — обработаем ниже)
  updateSessionContactFromText(session, text, {
    forwardWrapper,
    isConfirm: confirm,
  });

  // 2) ABCP-поиск по OEM — только как источник данных для LLM
  let abcpSearch = null;
  try {
    abcpSearch = await searchOemForText({
      dialogId,
      text,
      maxOems: 5,
      maxOffersPerOem: 5,
    });
    if (abcpSearch?.found) {
      console.log(
        "[llm-bot] ABCP OEM search found",
        abcpSearch.oems.length,
        "numbers"
      );
    } else {
      console.log("[llm-bot] ABCP OEM search: no numbers or no offers");
    }
  } catch (e) {
    console.error("[llm-bot] ABCP OEM search error:", e);
  }

  if (!text) return;

  // 3) Вызов LLM-внутреннего движка (с историей + ABCP-данными).
  // LLM полностью формирует текст ответа и даёт структурные данные в JSON,
  // а этот хендлер только выполняет её решения (CRM, ABCP и т.п.)
  const {
    replyText,
    stage,
    needOperator,
    updateLeadFields,
    comment,
    clientName,
  } = await runFunnelLLM({ session, text, abcpSearch });

  const leadFields = { ...(updateLeadFields || {}) };

  // Имя клиента из LLM (clientName или NAME в updateLeadFields)
  if (typeof clientName === "string" && clientName.trim()) {
    const cleanName = clientName.trim();
    if (!session.name || session.name === "—") {
      session.name = cleanName;
    }
    if (!leadFields.NAME) {
      leadFields.NAME = cleanName;
    }
  }

  // Телефон из LLM (если она положила в updateLeadFields.PHONE)
  if (leadFields.PHONE) {
    const phone = extractPhone(leadFields.PHONE);
    if (phone) {
      session.phone = phone;
      leadFields.PHONE = phone;
    } else {
      delete leadFields.PHONE;
    }
  }

  // 4) Обновление лида, если он уже есть
  if (session.leadId) {
    try {
      const fieldsToUpdate = { ...leadFields };
      if (Object.keys(fieldsToUpdate).length > 0) {
        await leadsApi.updateLead(session.leadId, fieldsToUpdate);
      }
      if (stage) {
        await leadsApi.setLeadStage(session.leadId, stage);
      }
      if (comment && comment.trim()) {
        await leadsApi.appendComment(session.leadId, comment.trim());
      }
    } catch (e) {
      console.error("[llm-bot] Failed to update lead", session.leadId, e);
    }
  } else {
    console.log(
      "[llm-bot] No leadId yet, skip CRM update. Stage:",
      stage,
      "updateLeadFields:",
      Object.keys(leadFields || {}).length,
      "comment:",
      !!comment
    );
  }

  if (needOperator) {
    console.log(
      "[llm-bot] needOperator = true (перевод на оператора пока не реализован)"
    );
  }

  await sendMessage(rest, dialogId, replyText);
}
