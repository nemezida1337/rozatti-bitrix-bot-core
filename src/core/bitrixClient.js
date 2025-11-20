import { logger } from "./logger.js";
import { getPortal } from "./store.js";
import { refreshTokens } from "./oauth.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// рекурсивная сборка form-urlencoded a[b][c]=...
function buildForm(params) {
  const form = new URLSearchParams();
  const append = (key, val) => {
    if (val === undefined || val === null) return;
    if (typeof val === "object" && !(val instanceof Date)) {
      if (Array.isArray(val)) {
        val.forEach((v, i) => append(`${key}[${i}]`, v));
      } else {
        for (const [k, v] of Object.entries(val)) append(`${key}[${k}]`, v);
      }
    } else {
      form.append(key, String(val));
    }
  };
  for (const [k, v] of Object.entries(params)) append(k, v);
  return form;
}

/**
 * makeBitrixClient:
 *  - domain: ключ портала в store (обязателен для refresh)
 *  - baseUrl: client_endpoint из Bitrix (может обновиться после refresh)
 *  - accessToken: начальный токен (актуализируется из store при каждом вызове)
 */
export function makeBitrixClient({ domain, baseUrl, accessToken }) {
  if (!domain) throw new Error("domain is required for Bitrix client");

  async function call(method, params = {}) {
    // всегда берём свежие данные из store (могли обновиться при refresh)
    const portal = getPortal(domain) || { baseUrl, accessToken };
    const root = String(portal.baseUrl || baseUrl || "").replace(/\/+$/, "");
    const apiBase = root.endsWith("/rest") ? root : `${root}/rest`;
    const url = new URL(`${apiBase}/${method}.json`);

    let token = portal.accessToken || accessToken;
    let attempt = 0;

    while (true) {
      attempt++;

      // Упреждающий refresh (за 2 минуты до истечения)
      if (portal.expiresAt && portal.expiresAt - Date.now() < 120000) {
        try { token = await refreshTokens(domain); } catch (e) { logger.warn({ e: String(e) }, "proactive refresh failed"); }
      }

      const body = buildForm({ ...params, auth: token });
      const t0 = Date.now();
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const duration = Date.now() - t0;

      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }

      if (json && json.error) {
        const code = json.error;
        logger.warn({ method, code, duration, attempt }, "Bitrix REST error");

        // если токен истёк — обновим и повторим запрос ровно один раз
        if (code === "expired_token" && attempt === 1) {
          try {
            token = await refreshTokens(domain);
            continue; // повторить вызов с новым токеном
          } catch (e) {
            throw Object.assign(new Error("refresh_token failed: " + (e.message || e)), { code, res: json });
          }
        }

        // ретраи на 5xx/429
        if ((res.status >= 500 || code === "TOO_MANY_REQUESTS") && attempt < 5) {
          await sleep(250 * attempt);
          continue;
        }
        throw Object.assign(new Error(json.error_description || code), { code, res: json });
      }

      logger.info({ method, duration }, "Bitrix REST ok");
      return json?.result;
    }
  }

  return { call };
}
