// src/modules/bot/oemDetector.js

// Простая эвристика для определения OEM в тексте.
// Мы ищем "слова" из букв/цифр подходящей длины
// и фильтруем по признакам, чтобы не ловить всякий мусор.
//
// ВАЖНО:
// - VIN-кейсы (VIN/ВИН + 17 символов) НЕ должны детектиться как OEM.
// - Часто VIN прилетает с пробелами/дефисами, поэтому проверяем "компакт" (без разделителей).

const OEM_REGEX = /[A-Z0-9]{6,20}/gi;
const VIN_KEYWORD_REGEX = /(?:^|[^A-ZА-ЯЁ0-9_])(VIN|ВИН)(?=$|[^A-ZА-ЯЁ0-9_])/i;
const VIN_ALLOWED_17_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
const VIN_HAS_LETTER_REGEX = /[A-HJ-NPR-Z]/i;
const VIN_CONTIGUOUS_17_REGEX = /[A-HJ-NPR-Z0-9]{17}/gi;
const VIN_TOKEN_WITH_SEPARATORS_REGEX = /[A-HJ-NPR-Z0-9-]{17,30}/gi;
const VIN_AFTER_KEYWORD_REGEX =
  /(?:^|[^A-ZА-ЯЁ0-9_])(?:VIN|ВИН)\s*[:#]?\s*([A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9\s-]{14,60})/giu;
const URL_RE = /https?:\/\/\S+/gi;
const ORDER_NUMBER_CONTEXT_RE = /(номер\s+заказа|заказ\s*№|order\s*#|order\s+number)/i;
const SERVICE_TOKEN_RE =
  /^(?:UTM|SOURCE|MEDIUM|CAMPAIGN|CONTENT|TERM|REF|CHAT\d{3,}|DIALOG\d{3,})$/i;

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

function isValidVinCandidate(value) {
  const candidate = compactAlnum(value);
  return (
    candidate.length === 17 &&
    VIN_ALLOWED_17_REGEX.test(candidate) &&
    VIN_HAS_LETTER_REGEX.test(candidate)
  );
}

function hasValidContiguousVin(text) {
  const matches = String(text || "")
    .toUpperCase()
    .match(VIN_CONTIGUOUS_17_REGEX);
  if (!matches || matches.length === 0) return false;
  return matches.some((candidate) => isValidVinCandidate(candidate));
}

function hasValidVinTokenWithSeparators(text) {
  const tokens = String(text || "")
    .toUpperCase()
    .match(VIN_TOKEN_WITH_SEPARATORS_REGEX);
  if (!tokens || tokens.length === 0) return false;

  return tokens.some((token) => isValidVinCandidate(token));
}

function hasValidVinAfterKeyword(text) {
  const upper = String(text || "").toUpperCase();
  const matches = upper.matchAll(VIN_AFTER_KEYWORD_REGEX);
  for (const match of matches) {
    const candidate = compactAlnum(match?.[1] || "");
    if (candidate.length < 17) continue;
    if (isValidVinCandidate(candidate.slice(0, 17))) return true;
  }
  return false;
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
 * - есть валидный 17-символьный VIN (подряд или с дефисами)
 * - либо после VIN/ВИН идёт валидный VIN-код
 */
function looksLikeVin(text) {
  if (!text || typeof text !== "string") return false;

  const upper = String(text || "").toUpperCase();
  if (hasValidContiguousVin(upper)) return true;

  if (VIN_KEYWORD_REGEX.test(upper)) {
    if (hasValidVinAfterKeyword(upper)) return true;
    // Проверяем VIN с дефисами только при явном VIN/ВИН в тексте,
    // чтобы GUID/UUID не считались VIN.
    if (hasValidVinTokenWithSeparators(upper)) return true;
  }

  return false;
}

/**
 * Удаляем VIN-фрагмент (VIN: ...), чтобы не ловить куски VIN как OEM.
 * Делается только для детекта OEM, не для бизнес-логики.
 */
function stripVinSegmentForOemDetection(text) {
  if (!text || typeof text !== "string") return text;

  if (!VIN_KEYWORD_REGEX.test(text)) return text;

  // Убираем "VIN: ...." до конца строки / до ~80 символов.
  // Сохраняем префикс (включая возможный разделитель), чтобы не склеивать слова.
  return text.replace(
    /((?:^|[^A-ZА-ЯЁ0-9_])(?:VIN|ВИН)\s*[:#]?\s*)[-A-Z0-9\s]{6,80}/giu,
    "$1",
  );
}

function looksLikeOrderNumberToken(token, fullText = "") {
  const t = String(token || "").trim();
  if (!/^\d{7,12}$/.test(t)) return false;
  return ORDER_NUMBER_CONTEXT_RE.test(String(fullText || ""));
}

function looksLikeServiceToken(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  return SERVICE_TOKEN_RE.test(t);
}

/**
 * Вытащить кандидатов OEM из текста.
 * Возвращает массив строк (без пробелов, в верхнем регистре).
 */
export function detectOemsFromText(text) {
  if (!text || typeof text !== "string") return [];

  // Если это VIN-кейс — сначала вырезаем VIN-сегмент, чтобы не ловить его куски как OEM
  const safeText = stripVinSegmentForOemDetection(text).replace(URL_RE, " ");

  const matches = safeText.match(OEM_REGEX) || [];
  const cleaned = matches
    .map((m) => m.replace(/[^A-Z0-9]/gi, "").toUpperCase())
    .filter((m) => m.length >= 6 && m.length <= 20)
    // Не считаем валидный 17-символьный VIN как OEM.
    .filter((m) => !(m.length === 17 && VIN_ALLOWED_17_REGEX.test(m)))
    // P0: не считаем телефоны OEM-ом (особенно на стадиях CONTACT/ADDRESS).
    // ВАЖНО: числовые OEM (BMW 11 цифр) остаются, потому что начинаются не с 7/8.
    .filter((m) => !looksLikeRuPhoneCandidate(m, text));
    // Фильтр служебных токенов и "номер заказа 123..." (частая ложная детекция).
    // При этом "голые" числовые OEM без контекста "номер заказа" сохраняем.
  const filtered = cleaned
    .filter((m) => !looksLikeServiceToken(m))
    .filter((m) => !looksLikeOrderNumberToken(m, safeText));

  // Убираем дубликаты
  return Array.from(new Set(filtered));
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
