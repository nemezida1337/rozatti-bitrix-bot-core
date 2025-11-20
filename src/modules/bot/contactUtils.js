// src/modules/bot/contactUtils.js
// Утилиты контактов: телефон, подтверждения, карточка.

import { makeContactCardText } from "../../core/messageModel.js";

/**
 * Нормализация телефона.
 * Берём только российский мобильный:
 *   (+7|7|8)?9XXXXXXXXX → +79XXXXXXXXX
 */
export function extractPhone(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^+\d]/g, " ");

  const m = cleaned.match(/(\+7|7|8)?9\d{9}/);
  if (!m) return null;

  let digits = m[0].replace(/\D/g, "");

  if (digits.length === 11 && (digits.startsWith("79") || digits.startsWith("89"))) {
    digits = "7" + digits.slice(-10);
  } else if (digits.length === 10 && digits.startsWith("9")) {
    digits = "7" + digits;
  } else if (digits.length === 12 && digits.startsWith("7") && digits[1] === "9") {
    digits = "7" + digits.slice(-10);
  } else if (!(digits.length === 11 && digits.startsWith("79"))) {
    return null;
  }

  return "+7" + digits.slice(-10);
}

/**
 * Пересланное сообщение (обёртка из Telegram).
 * На таких сообщениях контакты не трогаем.
 */
export function isForwardWrapper(text) {
  if (!text) return false;
  const t = String(text);
  return /\[b\]\s*Пересланное сообщение/i.test(t) || /Пересланное сообщение/i.test(t);
}

/**
 * Подтверждение типа "всё верно / ок / да".
 * Используем ТОЛЬКО на шаге подтверждения карточки контакта.
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
  ];
  for (const pat of negativePatterns) {
    if (norm.includes(pat)) {
      return false;
    }
  }

  return (
    norm.includes("все верно") ||
    norm.includes("всё верно") ||
    norm === "да" ||
    norm.startsWith("да,") ||
    norm.includes("верно") ||
    norm.includes("актуально") ||
    norm.includes("правильно") ||
    norm.includes("окей") ||
    norm === "ок" ||
    norm === "ок." ||
    norm === "окей" ||
    norm === "окей." ||
    norm.includes("все ок") ||
    norm.includes("всё ок") ||
    norm.includes("все хорошо") ||
    norm.includes("всё хорошо") ||
    norm === "норм" ||
    norm === "нормально" ||
    norm.includes("норм.") ||
    norm.includes("нормально.") ||
    norm.includes("ага") ||
    norm.includes("угу") ||
    norm === "yes" ||
    norm === "yep" ||
    norm === "yeah" ||
    norm === "ok"
  );
}

/**
 * Обновить телефон в session по тексту сообщения.
 * Имя здесь НЕ трогаем — его даёт LLM через JSON.
 */
export function updateSessionContactFromText(
  session,
  text,
  { forwardWrapper = false, isConfirm = false } = {}
) {
  if (!session || !text) return;

  if (forwardWrapper || isConfirm) {
    return;
  }

  const phoneFromText = extractPhone(text);
  if (phoneFromText) {
    session.phone = phoneFromText;
  }
}

/**
 * Отправить карточку контакта.
 * Имя берём из session.name (если LLM уже его дала).
 */
export async function sendContactCard({ session, rest, dialogId }) {
  const rawName = session.name || "";
  const rawPhone = session.phone && session.phone !== "—" ? session.phone : null;

  if (!rawPhone) {
    const msg = rawName
      ? `Спасибо, ${rawName}. Оставьте, пожалуйста, номер телефона для связи и оформления заказа.`
      : "Оставьте, пожалуйста, номер телефона для связи и оформления заказа.";

    await rest.call("imbot.message.add", {
      DIALOG_ID: dialogId,
      MESSAGE: msg,
    });
    return;
  }

  let phone = rawPhone.replace(/[^+\d]/g, "").replace(/^\+{2,}/, "+");
  const displayName = rawName || "—";

  const text = makeContactCardText({ name: displayName, phone });
  await rest.call("imbot.message.add", {
    DIALOG_ID: dialogId,
    MESSAGE: text,
  });
}
