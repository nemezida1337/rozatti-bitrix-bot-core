import { makeBitrixClient } from "../../core/bitrixClient.js";
import { logger } from "../../core/logger.js";

// In-memory cache (per-process)
// key: `${domain}:${leadId}`
const _cache = new Map();

function cacheGet(domain, leadId, ttlMs) {
  const key = `${domain}:${leadId}`;
  const row = _cache.get(key);
  if (!row) return null;
  if (Date.now() - row.ts > ttlMs) {
    _cache.delete(key);
    return null;
  }
  return row.value;
}

function cacheSet(domain, leadId, value) {
  const key = `${domain}:${leadId}`;
  _cache.set(key, { ts: Date.now(), value });
}

/**
 * Читает лид из Bitrix24.
 * ВАЖНО: поддерживает оба формата ответа:
 *  - api.call() → { result: {...} }
 *  - api.call() → {...fields}   (у тебя именно так)
 */
export async function getLead({
  domain,
  baseUrl,
  accessToken,
  leadId,
  cacheTtlMs = 8000,
}) {
  if (!domain) throw new Error("getLead: domain is required");
  if (!leadId) throw new Error("getLead: leadId is required");

  const cached = cacheGet(domain, leadId, cacheTtlMs);
  if (cached) return cached;

  const api = makeBitrixClient({ domain, baseUrl, accessToken });

  try {
    const res = await api.call("crm.lead.get", { id: leadId });

    // ⚠️ КЛЮЧЕВОЙ ФИКС
    // bitrixClient.call() у тебя возвращает УЖЕ result
    const lead =
      res && typeof res === "object" && "result" in res ? res.result : res;

    if (!lead || typeof lead !== "object") {
      logger.warn(
        {
          ctx: "modules/crm/leadStateService.getLead",
          domain,
          leadId,
          resType: typeof res,
        },
        "crm.lead.get returned empty or invalid payload",
      );
      return {};
    }

    cacheSet(domain, leadId, lead);
    return lead;
  } catch (err) {
    logger.warn(
      {
        ctx: "modules/crm/leadStateService.getLead",
        domain,
        leadId,
        err: err?.message || String(err),
      },
      "Failed to read lead",
    );
    throw err;
  }
}

/**
 * Возвращает STATUS_ID лида
 */
export async function getLeadStatusId({
  domain,
  baseUrl,
  accessToken,
  leadId,
  cacheTtlMs = 8000,
}) {
  const lead = await getLead({
    domain,
    baseUrl,
    accessToken,
    leadId,
    cacheTtlMs,
  });

  return lead?.STATUS_ID || null;
}

/**
 * Очистка кеша (удобно для тестов)
 */
export function clearLeadCache(domain, leadId) {
  if (!domain) {
    _cache.clear();
    return;
  }
  if (!leadId) {
    for (const key of _cache.keys()) {
      if (key.startsWith(`${domain}:`)) _cache.delete(key);
    }
    return;
  }
  _cache.delete(`${domain}:${leadId}`);
}
