// Единый контракт Cortex -> Node -> CRM:
// - допустимые stage / intent / action
// - безопасная нормализация входящих значений

export const CORTEX_STAGES = Object.freeze([
  "NEW",
  "URGENT",
  "IN_WORK",
  "VIN_PICK",
  "PRICING",
  "CONTACT",
  "ADDRESS",
  "FINAL",
  "ABCP_CREATE",
  "HARD_PICK",
  "LOST",
  "BAD_LEAD",
  "REGULAR_CLIENT",
  "SUCCESS",
]);

export const CORTEX_INTENTS = Object.freeze([
  "OEM_QUERY",
  "VIN_HARD_PICK",
  "ORDER_STATUS",
  "SERVICE_NOTICE",
  "SMALL_TALK",
  "CLARIFY_NUMBER_TYPE",
  "LOST",
  "OUT_OF_SCOPE",
]);

export const CORTEX_ACTIONS = Object.freeze([
  "reply",
  "abcp_lookup",
  "handover_operator",
  "service_notice",
]);

const STAGE_SET = new Set(CORTEX_STAGES);
const INTENT_SET = new Set(CORTEX_INTENTS);
const ACTION_SET = new Set(CORTEX_ACTIONS);

function toUpperToken(raw) {
  const token = String(raw ?? "").trim().toUpperCase();
  return token || null;
}

function toLowerToken(raw) {
  const token = String(raw ?? "").trim().toLowerCase();
  return token || null;
}

/**
 * @param {any} raw
 * @param {{ fallback?: string }} [options]
 */
export function resolveCortexStage(raw, options = {}) {
  const token = toUpperToken(raw);
  const fallbackToken = toUpperToken(options?.fallback || "NEW") || "NEW";
  const safeFallback = STAGE_SET.has(fallbackToken) ? fallbackToken : "NEW";

  if (!token) {
    return { value: safeFallback, isKnown: true, isEmpty: true, input: null };
  }
  if (STAGE_SET.has(token)) {
    return { value: token, isKnown: true, isEmpty: false, input: token };
  }

  return { value: safeFallback, isKnown: false, isEmpty: false, input: token };
}

/**
 * @param {any} raw
 */
export function resolveCortexIntent(raw) {
  const token = toUpperToken(raw);
  if (!token) return { value: null, isKnown: true, isEmpty: true, input: null };
  if (INTENT_SET.has(token)) return { value: token, isKnown: true, isEmpty: false, input: token };
  return { value: null, isKnown: false, isEmpty: false, input: token };
}

/**
 * @param {any} raw
 * @param {{ fallback?: string, allowEmpty?: boolean }} [options]
 */
export function resolveCortexAction(raw, options = {}) {
  const token = toLowerToken(raw);
  const allowEmpty = options?.allowEmpty !== false;
  const fallbackToken = toLowerToken(options?.fallback || "reply") || "reply";
  const safeFallback = ACTION_SET.has(fallbackToken) ? fallbackToken : "reply";

  if (!token) {
    return {
      value: allowEmpty ? null : safeFallback,
      isKnown: true,
      isEmpty: true,
      input: null,
    };
  }
  if (ACTION_SET.has(token)) {
    return { value: token, isKnown: true, isEmpty: false, input: token };
  }

  return { value: safeFallback, isKnown: false, isEmpty: false, input: token };
}

export function isKnownCortexStage(raw) {
  const token = toUpperToken(raw);
  return !!token && STAGE_SET.has(token);
}

