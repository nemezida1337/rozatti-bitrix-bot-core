// src/modules/external/pricing/abcp.js
// ABCP: поиск по OEM через /search/articles + /search/brands + /search/batch
// ВАЖНО: модуль ТОЛЬКО ищет и возвращает данные для бота/LLM,
// сам не отвечает клиенту, кроме выбора позиций (цифры 1 3 / 2x2 и т.п.).

import { logger } from "../../../core/logger.js";
import crypto from "node:crypto";

/* ==== ENV ==== */

const ABCP_HOST        = process.env.ABCP_HOST;
const ABCP_USERLOGIN   = process.env.ABCP_USERLOGIN;
const ABCP_USERPSW_MD5 =
  process.env.ABCP_USERPSW_MD5 ||
  (process.env.ABCP_USERPSW_RAW
    ? crypto.createHash("md5").update(process.env.ABCP_USERPSW_RAW, "utf8").digest("hex")
    : null);
const ABCP_PROFILE_ID  = process.env.ABCP_PROFILE_ID || null;

const HTTP_TIMEOUT_MS  = Number(process.env.HTTP_TIMEOUT_MS || 9000);

/* ==== In-memory корзина выбора по диалогу ==== */

const SELECTION_TTL_MS = 30 * 60 * 1000; // 30 минут
// dialogId -> { items: { idx -> {oem, offer, days, daysText, brand, name, priceNum} }, expiresAt }
const selectionStore = new Map();

function putSelection(dialogId, items) {
  const expiresAt = Date.now() + SELECTION_TTL_MS;
  selectionStore.set(dialogId, { items, expiresAt });
}

function getSelection(dialogId) {
  const s = selectionStore.get(dialogId);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    selectionStore.delete(dialogId);
    return null;
  }
  return s;
}

/* ==== проверка ENV ==== */

function assertEnv() {
  if (!ABCP_HOST || !ABCP_USERLOGIN || !ABCP_USERPSW_MD5) {
    throw new Error("ABCP env missing (ABCP_HOST / ABCP_USERLOGIN / ABCP_USERPSW_MD5)");
  }
}

/* ==== нормализация номера ==== */

function normalizePartNo(raw) {
  if (!raw) return "";
  return String(raw).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

function normalizeNumberVariants(raw) {
  const base = normalizePartNo(raw);
  if (!base) return [];
  const out = new Set();
  out.add(base);
  out.add(base.replace(/^0+/, "")); // без лидирующих нулей
  out.add(base.replace(/O/g, "0"));
  out.add(base.replace(/0/g, "O"));
  return Array.from(out).filter(Boolean);
}

/* ==== эвристика брендов (VAG и т.п.) ==== */

function isVag(raw) {
  const num = normalizePartNo(raw);
  return /^[0-9A-Z]{9,12}$/.test(num);
}

function brandGuesses(rawNumber) {
  const variants = normalizeNumberVariants(rawNumber);
  const all = new Set();
  for (const num of variants) {
    if (isVag(num)) {
      ["VAG", "VOLKSWAGEN", "VW", "AUDI", "SKODA", "SEAT"].forEach((b) => all.add(b));
    }
  }
  return Array.from(all);
}

/* ==== HTTP/API ==== */

async function httpGetJson(url) {
  assertEnv();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    const txt = await res.text();
    if (!res.ok) {
      throw new Error("HTTP " + res.status + " " + res.statusText + " — " + txt);
    }
    return txt ? JSON.parse(txt) : null;
  } finally {
    clearTimeout(t);
  }
}

function makeUrl(path, params = {}) {
  const url = new URL("https://" + ABCP_HOST + path);
  url.searchParams.set("userlogin", ABCP_USERLOGIN);
  url.searchParams.set("userpsw", ABCP_USERPSW_MD5);
  if (ABCP_PROFILE_ID) url.searchParams.set("profileId", ABCP_PROFILE_ID);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function apiArticles(opts) {
  const url = makeUrl("/search/articles", {
    number: opts.number,
    brand: opts.brand || "",
    withOutAnalogs: opts.withOutAnalogs ?? 0,
    format: "json",
  });
  return httpGetJson(url);
}

async function apiBrands(number) {
  const url = makeUrl("/search/brands", { number, format: "json" });
  return httpGetJson(url);
}

async function apiSearchBatch(pairs) {
  assertEnv();
  const url = "https://" + ABCP_HOST + "/search/batch";

  const params = new URLSearchParams();
  params.set("userlogin", ABCP_USERLOGIN);
  params.set("userpsw", ABCP_USERPSW_MD5);
  if (ABCP_PROFILE_ID) params.set("profileId", ABCP_PROFILE_ID);

  let idx = 0;
  for (const p of pairs || []) {
    if (!p || !p.number || !p.brand) continue;
    params.set(`search[${idx}][number]`, String(p.number));
    params.set(`search[${idx}][brand]`, String(p.brand));
    idx += 1;
    if (idx >= 100) break;
  }
  if (!idx) return [];

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    if (!res.ok) {
      throw new Error("HTTP " + res.status + " " + res.statusText + " — " + txt);
    }
    const data = txt ? JSON.parse(txt) : null;
    if (!Array.isArray(data)) {
      throw new Error("Unexpected ABCP response (batch not array)");
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

/* ==== разбор брендов из /search/brands ==== */

function extractBrandsDeep(resp) {
  const out = new Set();
  function walk(x) {
    if (!x) return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (typeof x === "object") {
      if (x.brand) out.add(String(x.brand).toUpperCase());
      for (const v of Object.values(x)) walk(v);
    }
  }
  walk(resp);
  return Array.from(out);
}

/* ==== поиск по одному номеру ==== */

async function searchAuto(number) {
  const variants = normalizeNumberVariants(number);

  // 0) /search/articles без бренда
  for (const n of variants) {
    try {
      const t = await apiArticles({ number: n, withOutAnalogs: 0 });
      if (t && t.length) {
        logger.info({ number, variant: n, count: t.length }, "ABCP: direct articles ok");
        return t;
      }
    } catch (e) {
      const s = String(e);
      if (/Brand expected/i.test(s) || /"errorCode"\s*:\s*2/.test(s) || /\"errorCode\"\s*:\s*301/.test(s)) {
        logger.info({ number: n }, "ABCP: brand required");
      } else {
        logger.warn({ number: n, err: s }, "ABCP: direct articles error");
      }
    }
  }

  // 1) бренды
  const brands = new Set();
  for (const n of variants) {
    try {
      const resp = await apiBrands(n);
      extractBrandsDeep(resp).forEach((b) => brands.add(b));
    } catch (e) {
      logger.info({ number: n, err: String(e) }, "ABCP: brands fetch no-data");
    }
  }
  brandGuesses(variants[0] || "").forEach((b) => brands.add(b));
  const picked = Array.from(brands);
  if (!picked.length) return [];

  // 2) поиск по брендам: batch → /search/articles
  const pairs = [];
  for (const b of picked.slice(0, 10)) {
    for (const n of variants) {
      pairs.push({ brand: b, number: n });
    }
  }

  let all = [];

  if (pairs.length) {
    try {
      const batch = await apiSearchBatch(pairs);
      if (batch && batch.length) {
        logger.info({ number, count: batch.length }, "ABCP: batch search ok");
        all.push(...batch);
      } else {
        logger.info({ number }, "ABCP: batch search empty, fallback to articles");
      }
    } catch (e) {
      logger.warn({ number, err: String(e) }, "ABCP: batch search error, fallback to articles");
    }
  }

  if (!all.length) {
    for (const b of picked.slice(0, 10)) {
      for (const n of variants) {
        try {
          const part = await apiArticles({ number: n, brand: b, withOutAnalogs: 0 });
          if (part && part.length) Array.prototype.push.apply(all, part);
        } catch {
          // глушим единичные ошибки по бренду/номеру
        }
      }
    }
  }

  // 3) дедуп по (brand, number, supplierCode)
  const seen = new Set();
  const out = [];
  for (const o of all) {
    const key = [o.brand, o.number, o.supplierCode]
      .map((v) => String(v || "").toUpperCase())
      .join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(o);
    }
  }
  return out;
}

/* ==== утилиты форматирования ==== */

function toNum(v) {
  return v == null ? null : Number(String(v).replace(",", "."));
}

function ruPriceInt(v) {
  const n = Math.round(Number(String(v).replace(",", ".")));
  if (!isFinite(n)) return "—";
  return n.toLocaleString("ru-RU");
}

// В доке ABCP: deliveryPeriod / deliveryPeriodMax — в ЧАСАХ.
// Переводим в целое количество дней.
function daysFromHours(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  const d = Math.round(h / 24);
  return d < 1 ? 1 : d;
}

function declDays(n) {
  n = Math.round(Math.abs(Number(n)));
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "день";
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return "дня";
  return "дней";
}

function daysLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return "срок уточняется";
  if (n <= 1) return "1 день";
  if (n <= 3) return "1–3 дня";
  if (n <= 7) return "до 7 дней";
  if (n <= 14) return "до 14 дней";
  return `≈ ${n} ${declDays(n)}`;
}

/* ==== OEM-детектор в тексте ==== */

// простая эвристика, чтобы не путать телефоны с OEM
function looksLikePhoneNumber(raw) {
  if (!raw) return false;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length !== 11) return false;
  // типичный российский мобильный: 79XXXXXXXXX или 89XXXXXXXXX
  return digits.startsWith("79") || digits.startsWith("89");
}

function extractOemTokens(text, maxCount = 5) {
  if (!text) return [];

  const cleaned = String(text)
    .toUpperCase()
    .replace(/[^0-9A-Z\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return [];

  const words = cleaned.split(" ").filter(Boolean);
  const tokens = [];
  const seen = new Set();

  function pushToken(raw) {
    if (!raw) return true;

    const key = raw.replace(/[^0-9A-Z]/g, "");
    const len = key.length;

    if (len < 7 || len > 20) return true;
    if (!/\d/.test(key)) return true;

    // если это похоже на телефон — не считаем OEM
    if (looksLikePhoneNumber(key)) return true;

    if (seen.has(key)) return true;
    seen.add(key);

    tokens.push(raw);

    if (maxCount && tokens.length >= maxCount) return false;
    return true;
  }

  for (const w of words) {
    if (!pushToken(w)) break;
  }

  return tokens;
}

/* ==== ПУБЛИЧНЫЙ API: поиск без ответа в чат ==== */

export async function searchOemForText({
  dialogId,
  text,
  maxOems = 5,
  maxOffersPerOem = 5,
}) {
  const tokens = extractOemTokens(text, maxOems);
  if (!tokens.length) {
    logger.info({ text }, "ABCP: OEM skipped (нет номеров)");
    return { found: false, oems: [] };
  }

  let globalIndex = 0;
  const globalItems = {}; // idx -> {oem, offer, days, daysText, brand, name, priceNum}
  const oemsOut = [];

  for (const raw of tokens) {
    const oem = normalizePartNo(raw);
    logger.info({ oem }, "ABCP: search start");

    let offers = [];
    try {
      offers = await searchAuto(oem);
    } catch (e) {
      logger.error({ oem, err: String(e) }, "ABCP: search failed");
      oemsOut.push({ oem, offers: [] });
      continue;
    }

    logger.info({ oem, count: offers.length }, "ABCP: search done");

    if (!offers.length) {
      oemsOut.push({ oem, offers: [] });
      continue;
    }

    const offersOut = [];
    for (const off of offers.slice(0, maxOffersPerOem)) {
      globalIndex += 1;

      const brand =
        (off.brand ||
          off.maker ||
          off.manufacturer ||
          off.vendor ||
          "").toString();

      const name =
        (off.name ||
          off.detailName ||
          off.description ||
          off.displayName ||
          off.goodName ||
          "").toString();

      const days = daysFromHours(off.deliveryPeriod);
      const daysText = daysLabel(days);
      const priceNum = toNum(off.price);

      const idx = globalIndex;
      offersOut.push({
        idx,
        price: ruPriceInt(off.price),
        days,
        daysText,
        brand,
        name,
        raw: off,
      });

      globalItems[idx] = {
        oem,
        offer: off,
        days,
        daysText,
        brand,
        name,
        priceNum,
      };
    }

    oemsOut.push({ oem, offers: offersOut });
  }

  if (!globalIndex) {
    return { found: false, oems: oemsOut };
  }

  if (dialogId) {
    putSelection(dialogId, globalItems);
  }

  return { found: true, oems: oemsOut };
}

/* ==== Обработка выбора позиций (цифры 1 3 / 2x2 и т.п.) ==== */

export async function tryHandleSelectionMessage({ api, dialogId, text }) {
  const selection = getSelection(dialogId);
  if (!selection) return null;

  const cleaned = String(text || "")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!/^\d+([x\*]\d+)?(\s+\d+([x\*]\d+)?)*$/.test(cleaned)) {
    return null;
  }

  const tokens = cleaned.split(" ");
  const picks = [];
  for (const t of tokens) {
    const m = /^(\d+)(?:[x\*](\d+))?$/.exec(t);
    if (!m) continue;
    const idx = Number(m[1]);
    const qty = m[2] ? Number(m[2]) : 1;

    const item = selection.items?.[idx];
    if (!item) continue;
    picks.push({ idx, qty, item });
  }

  if (!picks.length) return null;

  const lines = ["Принято. Вы выбрали:"];
  let sum = 0;
  for (const p of picks) {
    const priceNum =
      typeof p.item.priceNum === "number" && Number.isFinite(p.item.priceNum)
        ? p.item.priceNum
        : Number(String(p.item.offer.price).replace(",", "."));
    const rowSum = Math.round(priceNum) * p.qty;
    sum += rowSum;
    const daysText = p.item.daysText || "срок уточняется";
    lines.push(
      `${p.idx}) ${p.item.oem} — ${ruPriceInt(
        p.item.offer.price
      )} × ${p.qty} = ${ruPriceInt(rowSum)} (${daysText})`
    );
  }
  lines.push(`Итого: ${ruPriceInt(sum)}`);
  lines.push(
    "Укажите ФИО/телефон и адрес доставки или напишите 'оформить' для создания заказа."
  );

  await api.call("imbot.message.add", {
    DIALOG_ID: dialogId,
    MESSAGE: lines.join("\n"),
  });

  // ВАЖНО: теперь возвращаем picks, чтобы handler мог положить их в сессию
  return { handled: true, picks };
}
