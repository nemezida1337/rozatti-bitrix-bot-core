// @ts-check

import { logger } from "./logger.js";
import { getPortal, upsertPortal } from "./store.js";

/** @type {Map<string, Promise<string>>} */
const _pending = new Map(); // чтобы не было параллельных refresh по одному домену

/**
 * @param {string} domain
 * @returns {Promise<string>}
 */
export async function refreshTokens(domain) {
  const portal = getPortal(domain);
  if (!portal?.refreshToken) throw new Error("No refresh_token saved for domain " + domain);

  if (_pending.has(domain)) return _pending.get(domain);

  const job = (async () => {
    const clientId = process.env.BITRIX_CLIENT_ID;
    const clientSecret = process.env.BITRIX_CLIENT_SECRET;
    const oauthUrl = (process.env.BITRIX_OAUTH_URL || "https://oauth.bitrix.info/oauth/token/").replace(/\/+$/, "") + "/";

    if (!clientId || !clientSecret) throw new Error("BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET are required");

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: portal.refreshToken,
    });

    // по докам Bitrix24 refresh в облаке через oauth.bitrix.info/oauth/token/
    const url = oauthUrl + "?" + params.toString();
    const res = await fetch(url, { method: "GET" });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json || json.error) {
      const msg = json?.error_description || json?.error || "refresh failed";
      throw new Error(msg);
    }

    // Ответ содержит новую пару токенов и, при необходимости, обновлённый client_endpoint
    const next = {
      ...portal,
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      // expires_in — сек; сохраним timestamp для упреждающего обновления
      expires: json.expires_in,
      expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
      baseUrl: json.client_endpoint || portal.baseUrl,
    };
    upsertPortal(domain, next);
    logger.info({ domain }, "OAuth refresh ok");
    return next.accessToken;
  })().finally(() => _pending.delete(domain));

  _pending.set(domain, job);
  return job;
}
