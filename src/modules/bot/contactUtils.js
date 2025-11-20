// src/modules/bot/contactUtils.js
// Минимальный модуль контактов: только телефон + служебная логика.
// ВЕСЬ ТЕКСТ клиенту формирует LLM, не этот модуль.

import { makeContactCardText } from "../../core/messageModel.js";

/**
 * Нормализация телефона.
 * Берём российский мобильный:
 *   (+7|7|8)?9XXXXXXXXX → +79XXXXXXXXX
 */
export function extractPhone(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^+\d]/g, " ");

  const m = cleaned.match(/(\+7|7|8)?9\d{9}/);
  if (!m) return null;

  let digits = m[0].replace(/\D+/g, "");
  if (!digits) return null;

  // 9XXXXXXXXX / 89XXXXXXXXX / 79XXXXXXXXX → +79XXXXXXXXX
  if (digits.length === 10 && digits.startsWith("9")) {
    // ок
  } else if (digits.length === 11 && /^[78]/.test(digits)) {
    digits = digits.slice(1);
  } else if (!(digits.length === 11 && digits.startsWith("79"))) {
    return null;
  }

  return "+7" + digits.slice(-10);
}

/**
 * Пересланное сообщение (обёртка из Telegram).
 */
export function isForwardWrapper(text) {
  if (!text) return false;
  const t = String(text);
  return (
    /\[b\]\s*Пересланное сообщение/i.test(t) ||
    /Пересланное сообщение/i.test(t)
  );
}

/**
 * Подтверждение типа "всё верно / ок / да".
 * ЭТО оставим на всякий случай, но в идеале
 * подтверждение тоже будет делать LLM.
 */
export function isConfirmAnswer(text) {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  const norm = t.replace(/\s+/g, " ").trim();

  const negativePatterns = [
    "не верно",
    "неверно",
    "не всё верно",
    "не все верно",
    "неправильно",
    "не правильно",
    "не так",
  ];
  for (const pat of negativePatterns) {
    if (norm.includes(pat)) {
      return false;
    }
  }

  const positiveExact = new Set([
    "да",
    "да.",
    "да!",
    "ок",
    "ок.",
    "окей",
    "окей.",
    "ага",
    "угу",
  ]);
  if (positiveExact.has(norm)) return true;

  const positiveSub = [
    "все верно",
    "всё верно",
    "верно",
    "правильно",
    "актуально",
    "все ок",
    "всё ок",
    "все хорошо",
    "всё хорошо",
    "подходит",
    "устраивает",
    "так и есть",
  ];
  for (const pat of positiveSub) {
    if (norm.includes(pat)) return true;
  }

  return false;
}

/**
 * Обновление телефона из свободного текста.
 * Имя НЕ трогаем — его даёт LLM через JSON.
 */
export function updateSessionContactFromText(
  session,
  text,
  { forwardWrapper = false, isConfirm = false } = {}
) {
  if (!session || !text) return;

  if (forwardWrapper || isConfirm) return;

  const phoneFromText = extractPhone(text);
  if (phoneFromText) {
    session.phone = phoneFromText;
  }
}

/**
 * Эта функция больше не шлёт карточку в чат.
 * Можно вообще не использовать её из handler_llm_manager.
 * Оставляю заглушкой на будущее, если понадобится
 * отдельно показать контакт менеджеру.
 */
export async function sendContactCard({ session, rest, dialogId }) {
  const rawName = session.name || "—";
  const rawPhone =
    session.phone && session.phone !== "—" ? session.phone : null;

  if (!rawPhone) {
    // Сейчас НИЧЕГО не шлём: LLM сама спрашивает телефон в reply.
    return;
  }

  let phone = rawPhone.replace(/[^+\d]/g, "").replace(/^\+{2,}/, "+");
  const text = makeContactCardText({ name: rawName, phone });

  // Если когда-нибудь захочешь вручную слать карточку — раскомментируешь.
  // await rest.call("imbot.message.add", {
  //   DIALOG_ID: dialogId,
  //   MESSAGE: text,
  // });
}
