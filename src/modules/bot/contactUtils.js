// src/modules/bot/contactUtils.js (v2)
// Чистые утилиты: нормализация телефона, проверка формата.
// Имя и телефон парсит ТОЛЬКО LLM.

import { logger } from "../../core/logger.js";

const CTX = "contactUtils";

export function normalizePhone(phone) {
  if (!phone) return null;

  try {
    let p = phone.toString().trim();

    // Убираем все символы, кроме + и цифр
    p = p.replace(/[^\d+]/g, "");

    // Если начинается с 8 → конвертируем в +7
    if (p.startsWith("8") && p.length >= 11) {
      p = "+7" + p.slice(1);
    }

    // Если начинается с 7 → конвертируем в +7
    if (p.startsWith("7") && !p.startsWith("+7")) {
      p = "+7" + p.slice(1);
    }

    // Если нет + → добавляем (для России)
    if (!p.startsWith("+")) {
      p = "+7" + p;
    }

    // Минимальная длина телефона 11–12 символов
    if (p.length < 11) return null;

    return p;
  } catch (err) {
    logger.error(CTX, "Ошибка normalizePhone", err);
    return null;
  }
}
