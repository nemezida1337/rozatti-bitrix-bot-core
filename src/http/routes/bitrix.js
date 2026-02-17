// @ts-check

// src/http/routes/bitrix.js

import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../core/logger.js";
import { upsertPortal, getPortal } from "../../core/store.js";
import {
  handleOnImBotMessageAdd,
  ensureBotRegistered,
  handleOnImCommandAdd,
} from "../../modules/bot/register.js";

// --- P0: базовая защита входящих вебхуков Bitrix ---
// 1) Optional secret: /bitrix/events?secret=...  (или header x-hf-events-token)
// 2) Optional application_token check (сравнение с сохраненным в store)
const EVENTS_SECRET = process.env.BITRIX_EVENTS_SECRET || null;
const VALIDATE_APP_TOKEN = process.env.BITRIX_VALIDATE_APP_TOKEN === "1";

/** @typedef {Record<string, any>} AnyRecord */

/** @param {string} event */
function isInstallEvent(event) {
  if (!event) return false;
  const e = String(event).toLowerCase();
  return (
    e === "onappinstall" ||
    e === "onappinstalled" ||
    e === "onappinstalltest"
  );
}

/** @param {AnyRecord} [body] */
function extractDomain(body = {}) {
  // onappinstall — auth снаружи
  if (body?.auth?.domain) return body.auth.domain;
  if (body?.auth?.DOMAIN) return body.auth.DOMAIN;

  // обычные события — AUTH внутри data
  if (body?.data?.AUTH?.domain) return body.data.AUTH.domain;
  if (body?.data?.AUTH?.DOMAIN) return body.data.AUTH.DOMAIN;

  return null;
}

/** @param {AnyRecord} [body] */
function extractAuth(body = {}) {
  // onappinstall — auth снаружи
  if (body?.auth) return body.auth;
  // обычные события — AUTH внутри data
  if (body?.data?.AUTH) return body.data.AUTH;
  if (body?.data?.auth) return body.data.auth;
  return null;
}

/** @param {AnyRecord} [auth] */
function extractApplicationToken(auth = {}) {
  if (!auth) return null;
  return (
    auth.application_token ||
    auth.APPLICATION_TOKEN ||
    auth.applicationToken ||
    null
  );
}

/** @param {AnyRecord} [auth] */
function normalizeBitrixAuth(auth = {}) {
  // Bitrix обычно шлёт snake_case, мы храним camelCase для rest-клиента.
  const out = {};

  const accessToken = auth.access_token || auth.accessToken;
  const refreshToken = auth.refresh_token || auth.refreshToken;
  const baseUrl = auth.client_endpoint || auth.clientEndpoint || auth.baseUrl;
  const domain = auth.domain || auth.DOMAIN;
  const memberId = auth.member_id || auth.memberId;
  const appToken = extractApplicationToken(auth);
  const userId = auth.user_id || auth.userId || auth.USER_ID;

  if (accessToken) out.accessToken = accessToken;
  if (refreshToken) out.refreshToken = refreshToken;
  if (baseUrl) out.baseUrl = baseUrl;
  if (domain) out.domain = domain;
  if (memberId) out.memberId = memberId;
  if (appToken) out.applicationToken = appToken;
  if (userId != null) out.userId = String(userId);

  // expires_in (сек)
  const expires = auth.expires_in || auth.expires;
  if (expires) {
    const n = Number(expires);
    if (Number.isFinite(n) && n > 0) {
      out.expires = n;
      out.expiresAt = Date.now() + n * 1000;
    }
  }

  return out;
}

/**
 * @param {AnyRecord} req
 * @param {AnyRecord} reply
 * @param {string} event
 */
function validateEventsSecret(req, reply, event) {
  if (!EVENTS_SECRET) return true;

  // Не ломаем установку приложения, если URL onappinstall ещё не содержит secret.
  if (isInstallEvent(event)) return true;

  const q = req?.query || {};
  const fromQuery = q.secret || q.SECRET || null;
  const fromHeader = req?.headers?.["x-hf-events-token"] || null;

  if (fromQuery === EVENTS_SECRET || fromHeader === EVENTS_SECRET) {
    return true;
  }

  reply.code(401).send({ error: "INVALID_EVENTS_SECRET" });
  return false;
}

const EVENT_DUMP_ENABLED = process.env.EVENT_DUMP === "1";
const EVENT_DUMP_DIR = process.env.EVENT_DUMP_DIR || "./data/events";

// какие события дампим (по умолчанию только нужные для диагностики)
function shouldDumpEvent(event) {
  return (
    event === "onimbotmessageadd" ||
    event === "onimcommandadd" ||
    event === "onappinstall" ||
    event === "onappinstalled"
  );
}

/** @param {unknown} s */
function maskPhonesAndEmails(s) {
  if (typeof s !== "string") return s;
  let text = s;

  // emails
  text = text.replace(
    /([A-Z0-9._%+-]{1,3})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi,
    "$1***$2"
  );

  // phone-like sequences: +7 999 123-45-67 etc
  text = text.replace(/(\+?\d[\d\s().-]{6,}\d)/g, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 7) return m;
    const last2 = digits.slice(-2);
    return `+${"X".repeat(Math.max(0, digits.length - 2))}${last2}`;
  });

  return text;
}

/**
 * @param {unknown} value
 * @param {string} [key]
 * @returns {unknown}
 */
function sanitizeDeep(value, key = "") {
  // маскируем секреты по имени ключа
  const k = String(key || "").toLowerCase();
  const isSecretKey =
    k.includes("token") ||
    k.includes("secret") ||
    k.includes("password") ||
    k.includes("refresh") ||
    k.includes("access") ||
    k.includes("client_secret");

  if (isSecretKey) return "***";

  if (value == null) return value;

  if (typeof value === "string") {
    // подмаскируем возможные телефоны/почты в тексте
    let s = /** @type {string} */ (maskPhonesAndEmails(value));
    if (typeof s !== "string") s = String(s ?? "");

    // ограничим длину, чтобы не раздувать файлы
    if (s.length > 5000) s = s.slice(0, 5000) + "…(truncated)";
    return s;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDeep(v));
  }

  if (typeof value === "object") {
    /** @type {AnyRecord} */
    const out = {};
    for (const [kk, vv] of Object.entries(value)) {
      out[kk] = sanitizeDeep(vv, kk);
    }
    return out;
  }

  return value;
}

/**
 * @param {{event: string, domain: string|null, body: AnyRecord}} payload
 */
async function dumpBitrixEventToFile({ event, domain, body }) {
  if (!EVENT_DUMP_ENABLED) return;
  if (!shouldDumpEvent(event)) return;

  await fs.mkdir(EVENT_DUMP_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeDomain = String(domain || "no-domain").replace(/[^\w.-]/g, "_");
  const safeEvent = String(event || "no-event").replace(/[^\w.-]/g, "_");

  const filename = `${ts}__${safeEvent}__${safeDomain}.json`;
  const filepath = path.join(EVENT_DUMP_DIR, filename);

  const payload = {
    ts: new Date().toISOString(),
    event,
    domain: domain || null,
    body: sanitizeDeep(body),
  };

  await fs.writeFile(filepath, JSON.stringify(payload, null, 2), "utf-8");
}

/** @param {import("fastify").FastifyInstance} app */
export async function registerRoutes(app) {
  app.post("/bitrix/events", async (req, reply) => {
    const body = /** @type {AnyRecord} */ (req.body || {});
    const rawEvent = body?.event || "";
    const event = String(rawEvent || "").toLowerCase();

    // P0: optional secret check
    if (!validateEventsSecret(req, reply, event)) return;

    // базовый лог входящего события
    logger.info(
      { event, keys: Object.keys(body || {}) },
      "Incoming event"
    );

    const domain = extractDomain(body);
    await dumpBitrixEventToFile({ event, domain, body });

    try {
      // === УСТАНОВКА / ПЕРЕУСТАНОВКА ПРИЛОЖЕНИЯ ===
      if (isInstallEvent(event)) {
        if (!domain) {
          logger.error(
            { event, bodyKeys: Object.keys(body || {}) },
            "ONAPPINSTALL without domain",
          );
          return reply.code(400).send({ error: "DOMAIN_REQUIRED" });
        }

        // onappinstall: сохраняем токены/endpoint в нормализованном виде
        const norm = normalizeBitrixAuth(extractAuth(body) || {});
        await upsertPortal(domain, norm);
        logger.info({ domain }, "ONAPPINSTALL: tokens saved");

        try {
          await ensureBotRegistered(domain);
        } catch (e) {
          logger.error({ e, domain }, "Bot registration failed");
        }

        return reply.send({ result: "ok" });
      }

      // дальше — любые обычные события, без домена не работаем
      if (!domain) {
        logger.warn(
          { event, bodyKeys: Object.keys(body || {}) },
          "Event without domain",
        );
        return reply.code(400).send({ error: "DOMAIN_REQUIRED" });
      }

      let portal = await getPortal(domain);

      // Если приложение не установлено/не сохранило портал-токены —
      // не пытаемся работать с auth из обычных событий (он может быть от клиента/коннектора).
      if (!portal || !(portal.accessToken || portal.access_token)) {
        logger.error(
          { domain, hasPortal: !!portal },
          "Portal auth not found. Reinstall the app to trigger onappinstall."
        );
        return reply.code(412).send({ error: "PORTAL_AUTH_REQUIRED" });
      }

      // Если в store остались старые snake_case ключи — мигрируем в camelCase на лету.
      if (!portal.accessToken && portal.access_token) {
        const migrated = normalizeBitrixAuth(portal);
        portal = upsertPortal(domain, migrated);
      }

      // Диагностика: событие может прийти с auth другого user_id (например, клиента/коннектора).
      // Мы НЕ используем этот auth для REST и НЕ перезаписываем им store.
      const incomingAuth = extractAuth(body) || {};
      const normalizedIncoming = normalizeBitrixAuth(incomingAuth);
      if (normalizedIncoming.userId && portal.userId && normalizedIncoming.userId !== portal.userId) {
        logger.warn(
          { domain, portalUserId: portal.userId, incomingUserId: normalizedIncoming.userId, event },
          "Bitrix event auth user_id differs from portal install user_id. Using stored portal auth.",
        );
      }

      // Мягко обновляем только НЕ-секретные поля (например baseUrl/memberId) — без access/refresh токенов.
      const safeUpdate = {};
      if (normalizedIncoming.baseUrl && normalizedIncoming.baseUrl !== portal.baseUrl) {
        safeUpdate.baseUrl = normalizedIncoming.baseUrl;
      }
      if (normalizedIncoming.memberId && !portal.memberId) {
        safeUpdate.memberId = normalizedIncoming.memberId;
      }
      if (normalizedIncoming.domain && !portal.domain) {
        safeUpdate.domain = normalizedIncoming.domain;
      }
      if (Object.keys(safeUpdate).length > 0) {
        portal = upsertPortal(domain, safeUpdate);
      }

      // P0: (опционально) проверка application_token из события против сохраненного
      if (VALIDATE_APP_TOKEN) {
        const auth = extractAuth(body) || {};
        const incomingAppToken = extractApplicationToken(auth);
        const savedAppToken = portal?.applicationToken || portal?.application_token;

        if (!incomingAppToken || !savedAppToken || incomingAppToken !== savedAppToken) {
          logger.warn(
            { domain, hasIncoming: !!incomingAppToken, hasSaved: !!savedAppToken },
            "Bitrix event rejected: application_token mismatch",
          );
          return reply.code(401).send({ error: "INVALID_APPLICATION_TOKEN" });
        }
      }

      // === ДОП. ЛОГ ДЛЯ onImBotMessageAdd — ВИДИМ ТЕКСТ И DIALOG_ID ===
      if (event === "onimbotmessageadd") {
        const params = body?.data?.PARAMS || body?.data?.params || {};
        const logPayload = {
          domain,
          dialogId: params.DIALOG_ID || params.DIALOG || params.CHAT_ID,
          chatId: params.CHAT_ID,
          fromUserId: params.FROM_USER_ID,
          messageId: params.MESSAGE_ID,
          text: params.MESSAGE || body?.data?.TEXT || null,
        };

        logger.info(logPayload, "[LLM] Incoming bot message");
      }

      // === МАРШРУТИЗАЦИЯ СОБЫТИЙ ===

      if (event === "onimbotmessageadd") {
        await handleOnImBotMessageAdd({ portal, body, domain });
        return reply.send({ result: "ok" });
      }

      if (event === "onimcommandadd") {
        await handleOnImCommandAdd({ portal, body, domain });
        return reply.send({ result: "ok" });
      }

      // Прочие бот-события пока просто логируем
      if (
        event === "onimbotmessageupdate" ||
        event === "onimbotjoinchat" ||
        event === "onimbotdelete"
      ) {
        logger.info({ event, domain }, "Bot event (no-op for now)");
        return reply.send({ result: "noop" });
      }

      // Всё остальное — в no-op, но с логом
      logger.info({ event, domain }, "Event not explicitly handled");
      return reply.send({ result: "noop" });
    } catch (e) {
      logger.error(
        { e, event, domain, bodyKeys: Object.keys(body || {}) },
        "Error while handling Bitrix event"
      );
      return reply.code(500).send({ error: "INTERNAL_ERROR" });
    }
  });
}
