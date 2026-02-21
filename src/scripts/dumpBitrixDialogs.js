// src/scripts/dumpBitrixDialogs.js
//
// Снимает дамп диалогов менеджеров и клиентов из Bitrix24 за период.
// По умолчанию: последние 60 дней, только лиды.
//
// Примеры:
//   node src/scripts/dumpBitrixDialogs.js --days 60
//   node src/scripts/dumpBitrixDialogs.js --domain my.bitrix24.ru --entity both --days 60 --rps 1.5
//   node src/scripts/dumpBitrixDialogs.js --from 2025-12-01 --to 2026-01-31 --entity lead

import "../core/env.js";

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeBitrixClient } from "../core/bitrixClient.js";
import { logger } from "../core/logger.js";
import { getPortal, loadStore } from "../core/store.legacy.js";
import { resolveSmallTalk } from "../modules/bot/handler/shared/smallTalk.js";
import { detectOemsFromText } from "../modules/bot/oemDetector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;

    const eq = token.indexOf("=");
    if (eq > 2) {
      const k = token.slice(2, eq);
      const v = token.slice(eq + 1);
      out[k] = v;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function toIsoDay(dateObj) {
  const d = new Date(dateObj);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function resolveDateRange({ days = 60, from = null, to = null }) {
  const now = new Date();
  const toDate = to ? new Date(to) : now;
  if (Number.isNaN(toDate.getTime())) throw new Error(`Invalid --to date: ${to}`);

  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - Number(days) * 24 * 60 * 60 * 1000);
  if (Number.isNaN(fromDate.getTime())) throw new Error(`Invalid --from date: ${from}`);

  return {
    fromDate,
    toDate,
    fromBitrix: toIsoDay(fromDate),
    toBitrix: toIsoDay(toDate),
  };
}

function resolveTargetDomain(explicitDomain = null) {
  if (explicitDomain) return String(explicitDomain).trim().toLowerCase();

  const store = loadStore();
  const candidates = Object.entries(store || {})
    .map(([domainKey, portal]) => String(portal?.domain || domainKey || "").toLowerCase())
    .filter(Boolean)
    .filter((d) => !d.startsWith("audit-"));

  const found = candidates.find((d) => {
    const p = getPortal(d);
    return !!p?.baseUrl && !!p?.accessToken;
  });

  if (!found) {
    throw new Error(
      "Не найден портал в store. Передайте --domain <portal> или проверьте data/portals.json",
    );
  }
  return found;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRateLimiter(rps = 1.5) {
  const minDelay = Math.max(0, Math.floor(1000 / rps));
  let lastTs = 0;

  return async function throttle() {
    if (minDelay <= 0) return;
    const now = Date.now();
    const waitMs = lastTs + minDelay - now;
    if (waitMs > 0) await sleep(waitMs);
    lastTs = Date.now();
  };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function writeJsonlLine(stream, row) {
  const line = `${JSON.stringify(row)}\n`;
  if (stream.write(line)) return;
  await new Promise((resolve) => stream.once("drain", resolve));
}

function openJsonlWriter(filePath) {
  return createWriteStream(filePath, { flags: "a", encoding: "utf8" });
}

function normalizeObjectMap(value = {}) {
  if (!value || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    const map = {};
    for (const item of value) {
      const id = String(item?.id ?? item?.ID ?? "").trim();
      if (!id) continue;
      map[id] = item;
    }
    return map;
  }
  return value;
}

function normalizeMessageList(payload = {}) {
  if (!payload || typeof payload !== "object") return [];

  const list = payload.message || payload.messages || [];
  if (Array.isArray(list)) return list.slice();
  if (list && typeof list === "object") return Object.values(list);
  return [];
}

function normalizeUsersMap(payload = {}) {
  return normalizeObjectMap(payload.users || {});
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function classifyAuthor(authorId, user) {
  const id = String(authorId ?? "").trim();
  if (!id || id === "0") return "system";
  if (user?.bot === true) return "bot";

  const ext = String(user?.external_auth_id || user?.externalAuthId || "").toLowerCase();
  if (user?.connector === true || ext.includes("imconnector")) return "client";
  return "manager";
}

function redactText(text) {
  let t = String(text || "");
  if (!t) return t;
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL>");
  t = t.replace(/(\+?\d[\d()\-\s]{8,}\d)/g, "<PHONE>");
  return t;
}

function extractChatIds(chatRowsRaw) {
  let rows = [];
  if (Array.isArray(chatRowsRaw)) rows = chatRowsRaw;
  else if (chatRowsRaw && typeof chatRowsRaw === "object") rows = Object.values(chatRowsRaw);

  const ids = rows
    .map((x) => toInt(x?.CHAT_ID ?? x?.chat_id ?? x?.chatId ?? x?.ID ?? x?.id))
    .filter((x) => x && x > 0);

  return Array.from(new Set(ids));
}

async function callBitrixSafe({ api, limiter, method, params, errors, ctx = {} }) {
  await limiter();
  try {
    return await api.call(method, params);
  } catch (err) {
    const message = err?.message || String(err);
    const code = err?.code || err?.res?.error || null;
    const item = {
      ts: new Date().toISOString(),
      method,
      code,
      message,
      params,
      ...ctx,
    };
    errors.push(item);
    logger.warn({ method, code, message, ctx }, "Bitrix call failed");
    return null;
  }
}

async function listCrmEntities({
  api,
  limiter,
  errors,
  entityType,
  fromBitrix,
  toBitrix,
  maxEntities,
}) {
  const method = entityType === "deal" ? "crm.deal.list" : "crm.lead.list";
  const select =
    entityType === "deal"
      ? ["ID", "DATE_CREATE", "ASSIGNED_BY_ID", "TITLE", "STAGE_ID"]
      : ["ID", "DATE_CREATE", "ASSIGNED_BY_ID", "TITLE", "STATUS_ID"];

  const filter = {
    ">=DATE_CREATE": fromBitrix,
    "<=DATE_CREATE": toBitrix,
  };

  const rows = [];
  let start = 0;
  const pageSize = 50;
  while (true) {
    const chunk = await callBitrixSafe({
      api,
      limiter,
      method,
      params: {
        filter,
        order: { DATE_CREATE: "ASC", ID: "ASC" },
        select,
        start,
      },
      errors,
      ctx: { entityType, stage: "list_entities", start },
    });

    const list = Array.isArray(chunk) ? chunk : Array.isArray(chunk?.items) ? chunk.items : [];

    if (!list.length) break;
    rows.push(...list);

    if (maxEntities > 0 && rows.length >= maxEntities) {
      return rows.slice(0, maxEntities);
    }

    if (list.length < pageSize) break;
    start += list.length;
  }
  return rows;
}

async function fetchChatHistory({ api, limiter, errors, chatId, maxFallbackPages = 25 }) {
  const openlinesPayload = await callBitrixSafe({
    api,
    limiter,
    method: "imopenlines.session.history.get",
    params: { CHAT_ID: Number(chatId) },
    errors,
    ctx: { chatId, stage: "history_openlines" },
  });

  const openlinesMessages = normalizeMessageList(openlinesPayload);
  if (openlinesMessages.length > 0) {
    return {
      source: "imopenlines.session.history.get",
      payload: openlinesPayload,
      messages: openlinesMessages,
      usersMap: normalizeUsersMap(openlinesPayload),
    };
  }

  // Fallback: обычный IM-диалог.
  const allMessages = [];
  let usersMap = {};
  let prevOldest = null;
  let lastId = null;
  for (let page = 0; page < maxFallbackPages; page += 1) {
    const params = {
      DIALOG_ID: `chat${chatId}`,
      LIMIT: 200,
    };
    if (lastId) params.LAST_ID = lastId;

    const payload = await callBitrixSafe({
      api,
      limiter,
      method: "im.dialog.messages.get",
      params,
      errors,
      ctx: { chatId, stage: "history_fallback", page },
    });
    if (!payload) break;

    const messages = normalizeMessageList(payload);
    usersMap = { ...usersMap, ...normalizeUsersMap(payload) };
    if (!messages.length) break;

    allMessages.push(...messages);
    if (messages.length < 200) break;

    const ids = messages.map((m) => toInt(m?.id ?? m?.ID)).filter((x) => x && x > 0);
    if (!ids.length) break;
    const oldest = Math.min(...ids);
    if (!oldest || oldest === prevOldest) break;
    prevOldest = oldest;
    lastId = oldest;
  }

  if (!allMessages.length) return null;

  return {
    source: "im.dialog.messages.get",
    payload: null,
    messages: allMessages,
    usersMap,
  };
}

function normalizeTurn({
  domain,
  entityType,
  entityId,
  chatId,
  seq,
  managerId,
  message,
  usersMap,
}) {
  const messageId = String(message?.id ?? message?.ID ?? "").trim() || null;
  const authorId =
    String(
      message?.senderid ?? message?.senderId ?? message?.author_id ?? message?.AUTHOR_ID ?? "",
    ).trim() || null;

  const user = authorId ? usersMap[String(authorId)] || null : null;
  const authorType = classifyAuthor(authorId, user);

  const text = String(message?.text ?? message?.TEXT ?? "").trim();
  const textMasked = redactText(text);
  const date = String(message?.date ?? message?.DATE ?? "").trim() || null;

  const detectedOems = authorType === "client" ? detectOemsFromText(text) : [];
  const smallTalk = authorType === "client" && text ? resolveSmallTalk(text) : null;
  const isVinLike = /(?:\bVIN\b|\bВИН\b)/i.test(text) || /[A-HJ-NPR-Z0-9]{17}/i.test(text);

  return {
    domain,
    entity_type: entityType,
    entity_id: entityId,
    chat_id: chatId,
    dialog_key: `${entityType}:${entityId}:chat${chatId}`,
    seq,
    message_id: messageId,
    message_date: date,
    author_id: authorId,
    author_name: user?.name || user?.NAME || null,
    author_type: authorType,
    manager_id: managerId || null,
    text,
    text_masked: textMasked,
    detected_oems: detectedOems,
    is_vin_like: isVinLike,
    smalltalk: smallTalk
      ? {
          intent: smallTalk.intent,
          topic: smallTalk.topic || null,
        }
      : null,
    params: message?.params ?? message?.PARAMS ?? null,
  };
}

function sortMessages(messages = []) {
  return messages.slice().sort((a, b) => {
    const da = new Date(String(a?.date ?? a?.DATE ?? "")).getTime() || 0;
    const db = new Date(String(b?.date ?? b?.DATE ?? "")).getTime() || 0;
    if (da !== db) return da - db;
    const ia = toInt(a?.id ?? a?.ID) || 0;
    const ib = toInt(b?.id ?? b?.ID) || 0;
    return ia - ib;
  });
}

async function main() {
  const args = parseArgs();
  const days = toPositiveNumber(args.days, 60);
  const rps = toPositiveNumber(args.rps, 1.5);
  const maxEntities = toPositiveNumber(args.max_entities ?? args["max-entities"], 0);

  const entityOpt = String(args.entity || "lead").toLowerCase();
  const entities =
    entityOpt === "both" ? ["lead", "deal"] : entityOpt === "deal" ? ["deal"] : ["lead"];

  const targetDomain = resolveTargetDomain(args.domain || null);
  const portal = getPortal(targetDomain);
  if (!portal?.baseUrl || !portal?.accessToken) {
    throw new Error(
      `Портал ${targetDomain} не готов: отсутствует baseUrl/accessToken в data/portals.json`,
    );
  }

  const dateRange = resolveDateRange({
    days,
    from: args.from || null,
    to: args.to || null,
  });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = args.out_dir
    ? path.resolve(process.cwd(), String(args.out_dir))
    : path.join(ROOT, "data", "tmp", "bitrix-dialogs", ts);
  const rawDir = path.join(outRoot, "raw");
  const normalizedDir = path.join(outRoot, "normalized");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });

  const rawFile = path.join(rawDir, "dialogs_raw.jsonl");
  const turnsFile = path.join(normalizedDir, "dialog_turns.jsonl");
  const rawWriter = openJsonlWriter(rawFile);
  const turnsWriter = openJsonlWriter(turnsFile);

  const api = makeBitrixClient({
    domain: targetDomain,
    baseUrl: portal.baseUrl,
    accessToken: portal.accessToken,
  });
  const limiter = createRateLimiter(rps);
  const errors = [];

  const stats = {
    domain: targetDomain,
    from: dateRange.fromBitrix,
    to: dateRange.toBitrix,
    entities_requested: entities,
    entities_scanned: 0,
    chats_found: 0,
    chats_with_history: 0,
    messages_dumped: 0,
    api_errors: 0,
  };

  try {
    for (const entityType of entities) {
      const rows = await listCrmEntities({
        api,
        limiter,
        errors,
        entityType,
        fromBitrix: dateRange.fromBitrix,
        toBitrix: dateRange.toBitrix,
        maxEntities,
      });

      logger.info(
        { entityType, count: rows.length, from: dateRange.fromBitrix, to: dateRange.toBitrix },
        "CRM entities selected for dialog dump",
      );

      for (const row of rows) {
        const entityId = toInt(row?.ID);
        if (!entityId) continue;
        stats.entities_scanned += 1;

        const managerId = toInt(row?.ASSIGNED_BY_ID);
        const chatsRaw = await callBitrixSafe({
          api,
          limiter,
          method: "imopenlines.crm.chat.get",
          params: {
            CRM_ENTITY_TYPE: entityType,
            CRM_ENTITY: entityId,
            ACTIVE_ONLY: "N",
          },
          errors,
          ctx: { entityType, entityId, stage: "chat_map" },
        });

        const chatIds = extractChatIds(chatsRaw);
        if (!chatIds.length) continue;
        stats.chats_found += chatIds.length;

        for (const chatId of chatIds) {
          const history = await fetchChatHistory({
            api,
            limiter,
            errors,
            chatId,
          });
          if (!history || !history.messages?.length) continue;
          stats.chats_with_history += 1;

          await writeJsonlLine(rawWriter, {
            domain: targetDomain,
            entity_type: entityType,
            entity_id: entityId,
            manager_id: managerId || null,
            chat_id: chatId,
            source: history.source,
            fetched_at: new Date().toISOString(),
            history_payload: history.payload,
            messages_count: history.messages.length,
          });

          const ordered = sortMessages(history.messages);
          for (let i = 0; i < ordered.length; i += 1) {
            const turn = normalizeTurn({
              domain: targetDomain,
              entityType,
              entityId,
              chatId,
              seq: i + 1,
              managerId,
              message: ordered[i],
              usersMap: history.usersMap || {},
            });
            await writeJsonlLine(turnsWriter, turn);
            stats.messages_dumped += 1;
          }
        }
      }
    }
  } finally {
    await new Promise((resolve) => rawWriter.end(resolve));
    await new Promise((resolve) => turnsWriter.end(resolve));
  }

  stats.api_errors = errors.length;

  const manifest = {
    created_at: new Date().toISOString(),
    output_dir: outRoot,
    files: {
      raw_jsonl: path.relative(outRoot, rawFile).replaceAll("\\", "/"),
      turns_jsonl: path.relative(outRoot, turnsFile).replaceAll("\\", "/"),
    },
    options: {
      domain: targetDomain,
      from: dateRange.fromBitrix,
      to: dateRange.toBitrix,
      rps,
      max_entities: maxEntities || null,
      entity: entityOpt,
    },
    stats,
    errors_preview: errors.slice(0, 200),
  };
  await writeJson(path.join(outRoot, "manifest.json"), manifest);
  if (errors.length > 200) {
    await writeJson(path.join(outRoot, "errors_full.json"), errors);
  }

  const latestPointerDir = path.join(ROOT, "data", "tmp", "bitrix-dialogs");
  await fs.mkdir(latestPointerDir, { recursive: true });
  await fs.writeFile(path.join(latestPointerDir, "LATEST.txt"), outRoot, "utf8");

  logger.info(
    {
      output: outRoot,
      entities_scanned: stats.entities_scanned,
      chats_found: stats.chats_found,
      chats_with_history: stats.chats_with_history,
      messages_dumped: stats.messages_dumped,
      api_errors: stats.api_errors,
    },
    "Bitrix dialog dump finished",
  );

  process.stdout.write(
    `DIALOG_DUMP_READY ${outRoot} entities=${stats.entities_scanned} chats=${stats.chats_with_history} messages=${stats.messages_dumped}\n`,
  );
}

main().catch((err) => {
  logger.error({ err: String(err) }, "dumpBitrixDialogs failed");
  process.exitCode = 1;
});
