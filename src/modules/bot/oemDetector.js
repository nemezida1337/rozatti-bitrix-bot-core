// src/modules/bot/oemDetector.js

// Простая эвристика для определения OEM в тексте.
// Мы ищем "слова" из букв/цифр подходящей длины
// и фильтруем по признакам, чтобы не ловить всякий мусор.
//
// ВАЖНО:
// - VIN-кейсы (VIN/ВИН + 17 символов) НЕ должны детектиться как OEM.
// - Часто VIN прилетает с пробелами/дефисами, поэтому проверяем "компакт" (без разделителей).

const OEM_REGEX = /[A-Z0-9]{6,20}/gi;
const VIN_KEYWORD_REGEX = /(?:\bVIN\b|\bВИН\b)/i;
const VIN_ALLOWED_17_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

// Русский телефон (детект для защиты от ложного OEM):
// - 11 цифр и начинается с 7/8
// - или 10 цифр (без кода страны) — только если есть явные маркеры телефона
const PHONE_HINT_RE = /(\bтел\b|\bтелефон\b|\bphone\b|whatsapp|ватсап|вотсап|viber|вайбер|\bзвон\w*)/i;

/**
 * Уплотняем строку: оставляем только A-Z0-9
 */
function compactAlnum(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function looksLikeRuPhoneCandidate(token, fullText = "") {
  const digits = String(token || "").replace(/\D/g, "");
  if (!digits) return false;

  // Самое безопасное: 11 цифр и начинается с 7/8 — это почти всегда телефон.
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return true;
  }

  // 10 цифр без кода — считаем телефоном только при наличии явных маркеров.
  if (digits.length === 10 && PHONE_HINT_RE.test(String(fullText || ""))) {
    return true;
  }

  return false;
}

/**
 * Пытаемся определить, что в тексте реально присутствует VIN:
 * - есть слово VIN/ВИН
 * - после него (или в целом по тексту) можно получить 17 валидных символов
 */
function looksLikeVin(text) {
  if (!text || typeof text !== "string") return false;

  const hasKeyword = VIN_KEYWORD_REGEX.test(text);
  const compact = compactAlnum(text);

  // 1) Если есть VIN/ВИН — достаточно найти 17-символьный валидный VIN в компакте
  if (hasKeyword) {
    // Берём окно после ключевого слова, чтобы уменьшить ложные срабатывания
    const upper = text.toUpperCase();
    const m = upper.match(VIN_KEYWORD_REGEX);
    if (m && typeof m.index === "number") {
      const tail = upper.slice(m.index + m[0].length);
      const tailCompact = compactAlnum(tail);
      // Если после VIN в тексте набирается 17 символов — это VIN
      if (tailCompact.length >= 17) {
        const vinCandidate = tailCompact.slice(0, 17);
        if (VIN_ALLOWED_17_REGEX.test(vinCandidate)) return true;
      }
    }

    // Фоллбек: проверяем весь компакт (иногда VIN без двоеточия/перевода строки)
    if (compact.length >= 17) {
      // скользящее окно на 17
      for (let i = 0; i <= compact.length - 17; i += 1) {
        const candidate = compact.slice(i, i + 17);
        if (VIN_ALLOWED_17_REGEX.test(candidate)) return true;
      }
    }
    // если есть VIN/ВИН, но не нашли 17 — всё равно считаем это "VIN-кейсом" (MANUAL),
    // чтобы не уходить в AUTO из-за кусков VIN вроде "WBAVL31020 VN97388".
    return true;
  }

  // 2) Без ключевого слова VIN — считаем VIN только если есть 17 подряд в исходном тексте
  // (это старое поведение, но оставим как безопасный минимум)
  const has17Contiguous = /[A-HJ-NPR-Z0-9]{17}/i.test(text);
  return has17Contiguous;
}

/**
 * Удаляем VIN-фрагмент (VIN: ...), чтобы не ловить куски VIN как OEM.
 * Делается только для детекта OEM, не для бизнес-логики.
 */
function stripVinSegmentForOemDetection(text) {
  if (!text || typeof text !== "string") return text;

  if (!VIN_KEYWORD_REGEX.test(text)) return text;

  // Убираем "VIN: ...." до конца строки / до 80 символов (хватает с запасом)
  // Примеры:
  //   "VIN:WBAVL31020 VN97388\nшланг..." -> "VIN\nшланг..."
  //   "ВИН WBAVL31020-VN97388 ..."       -> "ВИН ..."
  return text.replace(
    /(\bVIN\b|\bВИН\b)\s*[:#]?\s*[-A-Z0-9\s]{6,80}/gi,
    "$1 ",
  );
}

/**
 * Вытащить кандидатов OEM из текста.
 * Возвращает массив строк (без пробелов, в верхнем регистре).
 */
export function detectOemsFromText(text) {
  if (!text || typeof text !== "string") return [];

  // Если это VIN-кейс — сначала вырезаем VIN-сегмент, чтобы не ловить его куски как OEM
  const safeText = stripVinSegmentForOemDetection(text);

  const matches = safeText.match(OEM_REGEX) || [];
  const cleaned = matches
    .map((m) => m.replace(/[^A-Z0-9]/gi, "").toUpperCase())
    .filter((m) => m.length >= 6 && m.length <= 20)
    // P0: не считаем телефоны OEM-ом (особенно на стадиях CONTACT/ADDRESS).
    // ВАЖНО: числовые OEM (BMW 11 цифр) остаются, потому что начинаются не с 7/8.
    .filter((m) => !looksLikeRuPhoneCandidate(m, text));

  // Убираем дубликаты
  return Array.from(new Set(cleaned));
}

/**
 * Простой хелпер: является ли сообщение "простым OEM-запросом".
 *
 * Примеры "простых" запросов:
 *  - "63128363505"
 *  - "5QM411105R сможет привезти?"
 *  - "нужен 4N0907998"
 *
 * НЕ простые:
 *  - VIN/ВИН (даже если VIN с пробелами/дефисами)
 *  - длинные описания
 */
export function isSimpleOemQuery(text, detectedOems = null) {
  if (!text || typeof text !== "string") return false;

  // VIN/ВИН => всегда НЕ простой OEM
  if (looksLikeVin(text)) return false;

  const oems = Array.isArray(detectedOems) ? detectedOems : detectOemsFromText(text);
  if (oems.length === 0) return false;

  // Очень грубая эвристика по длине текста:
  const normalized = text.trim();
  if (normalized.length > 120) {
    // Слишком длинное описание — лучше отдать Cortexу/ручному сценарию
    return false;
  }

  return true;
}
