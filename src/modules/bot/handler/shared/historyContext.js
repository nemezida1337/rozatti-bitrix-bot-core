// src/modules/bot/handler/shared/historyContext.js
//
// Лёгкий контекст истории диалога:
// - хранение последних turn'ов в session.history
// - детект повторных клиентских пингов по уже идущему запросу
// - генерация короткого контекстного ответа на повтор

import { detectOemsFromText } from "../../oemDetector.js";

const VIN_KEYWORD_REGEX = /(?:^|[^A-ZА-ЯЁ0-9_])(VIN|ВИН)(?=$|[^A-ZА-ЯЁ0-9_])/i;
const VIN_ALLOWED_17_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
const VIN_HAS_LETTER_REGEX = /[A-HJ-NPR-Z]/i;
const VIN_CONTIGUOUS_17_REGEX = /[A-HJ-NPR-Z0-9]{17}/gi;
const VIN_TOKEN_WITH_SEPARATORS_REGEX = /[A-HJ-NPR-Z0-9-]{17,30}/gi;
const VIN_AFTER_KEYWORD_REGEX =
  /(?:^|[^A-ZА-ЯЁ0-9_])(?:VIN|ВИН)\s*[:#]?\s*([A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9\s-]{14,60})/giu;
const FOLLOWUP_PROMPT_REGEX =
  /(ну что|что там|есть новости|какие новости|ап\b|up\b|подскажите|напом|когда будет|где заказ|статус|трек|накладн|жду ответ|когда ответ)/i;
const STATUS_QUESTION_REGEX =
  /(статус|где заказ|где мой заказ|трек|накладн|когда отправ|когда отправите|когда будет отправк|отслеж|отслеживать)/i;
const SERVICE_ACK_REGEX =
  /(приветствуем|добро пожаловать|уже работает над запросом|даст ответ|отправил запрос дилеру|передаю менеджеру|передал менеджеру|принял запрос|в работе)/i;
const SPACE_REGEX = /\s+/g;
const NON_ALNUM_SPACE_REGEX = /[^\p{L}\p{N}\s]/gu;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function resolveHistoryLimit() {
  return toPositiveInt(process.env.SESSION_HISTORY_MAX_TURNS, 40);
}

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

export function normalizeHistoryText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(NON_ALNUM_SPACE_REGEX, " ")
    .replace(SPACE_REGEX, " ")
    .trim();
}

export function inferMessageAuthorRole(message = {}) {
  const userFlags = message?.userFlags || {};
  const isBot = String(userFlags?.isBot || "").toUpperCase() === "Y";
  const isConnector = String(userFlags?.isConnector || "").toUpperCase() === "Y";
  const chatEntityType = String(message?.chatEntityType || "").toUpperCase();
  const isSystemLike = !!message?.isSystemLike;

  if (isBot || isSystemLike) return "system";
  if (chatEntityType === "LINES" && isConnector) return "client";
  if (chatEntityType === "LINES") return "manager";
  return "client";
}

function ensureSessionHistory(session) {
  if (!session || typeof session !== "object") return [];
  if (!Array.isArray(session.history)) session.history = [];
  return session.history;
}

function trimHistoryInPlace(history) {
  const max = resolveHistoryLimit();
  if (!Array.isArray(history)) return;
  if (history.length <= max) return;
  history.splice(0, history.length - max);
}

export function appendSessionHistoryTurn(
  session,
  { role = "client", text = "", messageId = null, kind = null, ts = Date.now() } = {},
) {
  if (!session || typeof session !== "object") return false;
  const history = ensureSessionHistory(session);

  const normalizedText = normalizeHistoryText(text);
  if (!normalizedText) return false;

  const turn = {
    role: String(role || "client"),
    text: String(text || "").trim(),
    text_normalized: normalizedText,
    message_id: messageId == null ? null : String(messageId),
    kind: kind ? String(kind) : null,
    ts: Number(ts) || Date.now(),
  };

  const last = history[history.length - 1];
  if (
    last &&
    last.role === turn.role &&
    last.text_normalized === turn.text_normalized &&
    String(last.message_id || "") === String(turn.message_id || "")
  ) {
    return false;
  }

  history.push(turn);
  trimHistoryInPlace(history);
  return true;
}

function isVinLike(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  const upper = t.toUpperCase();
  if (hasValidContiguousVin(upper)) return true;
  if (VIN_KEYWORD_REGEX.test(upper)) {
    if (hasValidVinAfterKeyword(upper)) return true;
    if (hasValidVinTokenWithSeparators(upper)) return true;
  }
  return false;
}

function isFollowupPrompt(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (raw.length > 100) return false;
  return FOLLOWUP_PROMPT_REGEX.test(raw);
}

function isSubstantiveClientRequest(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (detectOemsFromText(raw).length > 0) return true;
  if (isVinLike(raw)) return true;
  return raw.length >= 18;
}

function isServiceAckText(text) {
  return SERVICE_ACK_REGEX.test(String(text || ""));
}

function isStatusQuestion(text) {
  return STATUS_QUESTION_REGEX.test(String(text || ""));
}

function findLastByRole(history, role) {
  if (!Array.isArray(history) || !history.length) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === role) return { idx: i, turn: history[i] };
  }
  return null;
}

function findLastBotAfter(history, fromIndex) {
  if (!Array.isArray(history) || !history.length) return null;
  for (let i = history.length - 1; i > fromIndex; i -= 1) {
    const role = String(history[i]?.role || "");
    if (role === "bot" || role === "manager") return history[i];
  }
  return null;
}

export function detectRepeatFollowup({
  session,
  text,
  authorRole = "client",
  hasImage = false,
  detectedOems = [],
  now = Date.now(),
} = {}) {
  if (authorRole !== "client") return null;
  const raw = String(text || "").trim();
  if (!raw) return null;
  if (hasImage) return null;
  if (Array.isArray(detectedOems) && detectedOems.length > 0) return null;
  if (isVinLike(raw)) return null;
  if (!isFollowupPrompt(raw)) return null;

  const history = ensureSessionHistory(session);
  const prevClient = findLastByRole(history, "client");
  if (!prevClient?.turn?.text) return null;

  const maxAgeMs = 72 * 60 * 60 * 1000;
  const prevTs = Number(prevClient.turn.ts) || 0;
  if (prevTs > 0 && now - prevTs > maxAgeMs) return null;

  const prevClientText = String(prevClient.turn.text || "").trim();
  const prevClientNorm = String(prevClient.turn.text_normalized || "");
  const currentNorm = normalizeHistoryText(raw);
  const sameAsPrevClient = !!currentNorm && currentNorm === prevClientNorm;

  const prevBotTurn = findLastBotAfter(history, prevClient.idx);
  const prevBotText = String(prevBotTurn?.text || "").trim();
  const prevBotServiceAck = isServiceAckText(prevBotText);

  const prevSubstantive = isSubstantiveClientRequest(prevClientText);
  if (!prevSubstantive && !prevBotServiceAck && !sameAsPrevClient) return null;

  const promptType = isStatusQuestion(raw) ? "STATUS_CHECK" : "FOLLOWUP_PING";

  return {
    promptType,
    previous_client_text: prevClientText,
    previous_bot_text: prevBotText || null,
    previous_bot_service_ack: prevBotServiceAck,
    gap_turns: Math.max(0, history.length - prevClient.idx - 1),
    repeated_same_text: sameAsPrevClient,
  };
}

export function buildRepeatFollowupReply({ session, followup } = {}) {
  const stage = String(session?.state?.stage || "").toUpperCase();
  const inProgressStages = new Set([
    "IN_WORK",
    "VIN_PICK",
    "PRICING",
    "CONTACT",
    "FINAL",
    "ABCP_CREATE",
  ]);

  const promptType = String(followup?.promptType || "");
  const inProgress = inProgressStages.has(stage) || !!followup?.previous_bot_service_ack;

  if (promptType === "STATUS_CHECK" && inProgress) {
    return "Вижу ваше повторное сообщение. Запрос уже в работе, как только будет обновление по статусу, сразу напишу.";
  }

  if (inProgress) {
    return "Вижу ваше повторное сообщение. Предыдущий запрос уже в работе, как только будет обновление, сразу напишу.";
  }

  return "Вижу ваше повторное обращение. Проверяю историю диалога и вернусь с ответом.";
}

export default {
  appendSessionHistoryTurn,
  buildRepeatFollowupReply,
  detectRepeatFollowup,
  inferMessageAuthorRole,
  normalizeHistoryText,
};
