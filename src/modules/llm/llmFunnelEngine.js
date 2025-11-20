// src/modules/llm/llmFunnelEngine.js
// Воронка на LLM: прокидываем историю + ABCP-результаты.

import { generateStructuredFunnelReply, llmAvailable } from "./openaiClient.js";
import { makeLLMDownReply } from "../../core/messageModel.js";

/* Вспомогательные: дни/цены */

function declDays(n) {
  n = Math.round(Math.abs(Number(n)));
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "день";
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return "дня";
  return "дней";
}

function parsePriceNumber(str) {
  const n = Number(String(str).replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Основной запуск воронки.
 * @param {object} opts
 * @param {object} opts.session
 * @param {string} opts.text
 * @param {object|null} [opts.abcpSearch]
 */
export async function runFunnelLLM({ session, text, abcpSearch }) {
  const safeText = String(text || "").trim();
  if (!safeText) {
    return {
      replyText: "",
      stage: session.stage || "NEW",
      needOperator: false,
      updateLeadFields: {},
      comment: "",
      clientName: "",
    };
  }

  if (!session.history) session.history = [];

  session.history.push({ role: "user", content: safeText, ts: Date.now() });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  let replyText;
  let stage = session.stage || "NEW";
  let needOperator = false;
  let updateLeadFields = {};
  let comment = "";
  let clientName = "";

  // Если LLM недоступна — простой fallback
  if (!llmAvailable) {
    replyText = makeLLMDownReply({
      name: session.name,
      hasPhone: !!session.phone,
    });

    session.history.push({ role: "assistant", content: replyText, ts: Date.now() });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    return { replyText, stage, needOperator, updateLeadFields, comment, clientName };
  }

  // История для LLM
  const historyForLLM = session.history.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // Если есть ABCP-результаты — добавим системный блок с цифрами
  if (abcpSearch && Array.isArray(abcpSearch.oems) && abcpSearch.oems.length) {
    const lines = [];

    lines.push("У тебя есть результаты поиска запчастей (ABCP) по OEM.");
    lines.push("Отвечай как продавец оригинальных запчастей.");
    lines.push("Не выдумывай цены, используй только эти данные.");
    lines.push("");

    lines.push("ДАННЫЕ ABCP:");
    for (const o of abcpSearch.oems) {
      const offers = Array.isArray(o.offers) ? o.offers : [];
      if (!offers.length) {
        lines.push(`Номер ${o.oem}: предложений нет.`);
        continue;
      }

      const priceVals = [];
      const dayVals = [];

      for (const off of offers) {
        const p = parsePriceNumber(off.price);
        if (p != null) priceVals.push(p);
        if (Number.isFinite(off.days) && off.days > 0) dayVals.push(off.days);
      }

      if (priceVals.length) {
        const minP = Math.min(...priceVals);
        const maxP = Math.max(...priceVals);
        if (Math.abs(minP - maxP) < 1) {
          lines.push(
            `Номер ${o.oem}: цена около ${Math.round(minP).toLocaleString("ru-RU")} ₽.`
          );
        } else {
          lines.push(
            `Номер ${o.oem}: цена от ${Math.round(minP).toLocaleString(
              "ru-RU"
            )} до ${Math.round(maxP).toLocaleString("ru-RU")} ₽.`
          );
        }
      }

      if (dayVals.length) {
        const minD = Math.min(...dayVals);
        const maxD = Math.max(...dayVals);
        if (Math.abs(minD - maxD) <= 1) {
          lines.push(`Срок: примерно ${minD} ${declDays(minD)}.`);
        } else {
          lines.push(`Срок: от ${minD} до ${maxD} ${declDays(maxD)}.`);
        }
      }

      for (const off of offers) {
        const brand = (off.brand || "").trim();
        const name = (off.name || "").trim();
        const title =
          brand && name ? `${brand} ${name}` : brand || name || "вариант";

        let daysStr = "";
        if (Number.isFinite(off.days) && off.days > 0) {
          daysStr = `${off.days} ${declDays(off.days)}`;
        } else if (off.daysText) {
          daysStr = off.daysText;
        } else {
          daysStr = "срок уточняется";
        }

        lines.push(`• #${off.idx}: ${title} — ${off.price} ₽, ${daysStr}`);
      }
    }

    historyForLLM.unshift({
      role: "system",
      content: lines.join("\n"),
    });
  }

  // Состояние клиента (имя/телефон/стадия) как отдельный system-блок
  {
    const stateLines = [];

    stateLines.push("Краткое состояние диалога:");

    if (session.name) {
      stateLines.push(
        `- Имя клиента уже известно: ${session.name}. Не спрашивай имя повторно без причины.`
      );
    } else {
      stateLines.push(
        "- Имя клиента пока неизвестно. Можно один раз вежливо спросить, как к нему обращаться, когда он уже проявил интерес к покупке."
      );
    }

    if (session.phone) {
      stateLines.push(
        `- Телефон клиента уже известен: ${session.phone}. Не проси его повторно без явной причины.`
      );
    } else {
      stateLines.push(
        "- Телефон клиента пока неизвестен. Проси его тогда, когда клиент готов оформить заказ или просит перезвонить."
      );
    }

    if (session.stage) {
      stateLines.push(`- Текущая стадия воронки: ${session.stage}.`);
    } else {
      stateLines.push("- Стадия воронки пока не задана (по умолчанию NEW).");
    }

    historyForLLM.unshift({
      role: "system",
      content: stateLines.join("\n"),
    });
  }

  // Вызов LLM
  try {
    const control = await generateStructuredFunnelReply({
      history: historyForLLM,
    });

    replyText = control.reply;
    stage = control.stage || stage;
    needOperator = !!control.need_operator;
    updateLeadFields = control.update_lead_fields || {};
    comment = control.comment || "";
    if (typeof control.client_name === "string" && control.client_name.trim()) {
      clientName = control.client_name.trim();
    }
  } catch (e) {
    console.error("[llm-bot] Structured LLM failed:", e);
    replyText = "Извини, сейчас у меня техническая ошибка.";
    stage = "NEW";
    needOperator = true;
    comment = "LLM error";
  }

  session.stage = stage;
  session.history.push({ role: "assistant", content: replyText, ts: Date.now() });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  return {
    replyText,
    stage,
    needOperator,
    updateLeadFields,
    comment,
    clientName,
  };
}
