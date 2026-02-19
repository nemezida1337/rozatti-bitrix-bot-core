// src/modules/external/pricing/abcp.js (v10, deadlineReplace + строгие сроки)
// Адаптер ABCП:
// — Только оригиналы (но не рубим записи без флага isOriginal)
// — Fallback через /search/brands
// — Мягкая обработка 404/301 "No results"
// — Батчинг нескольких OEM
// — Нормализованные данные для LLM (цены + наличие + сроки)
// — Расширенный LOG (INFO показывает, что реально вернул ABCP)

import axios from "axios";

import { logger } from "../../../core/logger.js";

const CTX = "ABCP";

// --- Конфиг ABCP ---
const ABCP_DOMAIN =
  process.env.ABCP_DOMAIN || process.env.ABCP_HOST; // abcp75363.public.api.abcp.ru
const ABCP_LOGIN =
  process.env.ABCP_KEY || process.env.ABCP_USERLOGIN; // api@abcp75363
const ABCP_USERPSW_MD5 =
  process.env.ABCP_USERPSW_MD5 || process.env.ABCP_USERPSW;

if (!ABCP_DOMAIN || !ABCP_LOGIN || !ABCP_USERPSW_MD5) {
  logger.error(
    {
      ctx: CTX,
      ABCP_DOMAIN,
      hasLogin: Boolean(ABCP_LOGIN),
      hasPassword: Boolean(ABCP_USERPSW_MD5),
    },
    "ABCP не сконфигурирован. Проверь .env",
  );
} else {
  logger.info(
    { ctx: CTX, ABCP_DOMAIN, hasLogin: true, hasPassword: true },
    "ABCP конфиг загружен",
  );
}

// --- Axios instance ---
const api = axios.create({
  baseURL: `https://${ABCP_DOMAIN}`,
  timeout: 8000,
});

// --------- УТИЛИТЫ ---------

/**
 * Вытаскиваем OEM из текста (убираем телефоны, мусор и т.п.)
 */
export function extractOEMsFromText(text) {
  if (!text) return [];

  // Убираем телефоны, чтобы не путать с OEM
  text = text.replace(/(\+?\d[\d\s\-\(\)]{7,}\d)/g, " ");

  const oems = text
    .split(/[\s,;\n\r]+/) // разбиваем по пробелам, запятым, переводам строк
    .map((x) => x.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")) // чистим мусор
    .filter((x) => x.length >= 6 && x.length <= 20); // грубый фильтр длины

  // Убираем дубликаты
  return [...new Set(oems)];
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function redactParamsForLogs(params) {
  if (!params || typeof params !== "object") return params;
  const out = { ...params };
  if (Object.prototype.hasOwnProperty.call(out, "userpsw")) {
    out.userpsw = "***";
  }
  if (Object.prototype.hasOwnProperty.call(out, "userlogin")) {
    out.userlogin = "***";
  }
  return out;
}

/**
 * deadlineReplace / парсер сроков поставки
 * Вариант А — максимально как на Rozatti.ru:
 *  - "до 7 раб.дн."  → 7
 *  - "до 18 раб.дн." → 18
 *  - "до 18 дней"    → 18
 *  - "15 дней", "10 рабочих дней" и т.п. → 15, 10
 *  - если пришло число → возвращаем как есть
 *  - иначе 0 (срок неизвестен)
 */
function parseDeadline(raw) {
  if (raw == null) return 0;

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return 0;
    return raw > 0 ? raw : 0;
  }

  if (typeof raw !== "string") return 0;

  const s = raw.trim().toLowerCase();

  // Жёсткие мапы, как ты просил
  if (s === "до 7 раб.дн." || s === "до 7 раб. дн." || s === "до 7 раб дней") {
    return 7;
  }
  if (
    s === "до 18 раб.дн." ||
    s === "до 18 раб. дн." ||
    s === "до 18 раб дней"
  ) {
    return 18;
  }
  if (s === "до 18 дней") {
    return 18;
  }

  // Общий случай: берём первое число перед маркером "рабочих дней".
  // Важно: поддерживаем варианты "раб.дн.", "р.дн.", "дн.", "дней", "days".
  const m = s.match(
    /(\d+)\s*(?:р(?:аб)?\.\s*дн\.?|рабочих\s+дней|дней|дн\.?|day|days)/i,
  );
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 0;
}

// --------- ЗАПРОСЫ ABCP ---------

/**
 * /search/articles — поиск по артикулу + (опционально) бренду.
 */
async function queryArticle(oem, brand = "") {
  if (!ABCP_DOMAIN || !ABCP_LOGIN || !ABCP_USERPSW_MD5) return [];

  try {
    const params = {
      userlogin: ABCP_LOGIN,
      userpsw: ABCP_USERPSW_MD5,
      number: oem,
      limit: 40,
    };

    if (brand) params.brand = brand;

    logger.info(
      { ctx: CTX, oem, brand, params: redactParamsForLogs(params) },
      "HTTP GET /search/articles",
    );

    const r = await api.get(`/search/articles`, { params });
    const data = r.data;

    if (!Array.isArray(data)) {
      logger.warn(
        { ctx: CTX, oem, brand, data },
        "Неожиданный ответ search/articles",
      );
      console.warn("[ABCP WARN search/articles]", { oem, brand, data });
      return [];
    }

    logger.info(
      {
        ctx: CTX,
        oem,
        brand,
        rowsCount: data.length,
        sample: data.slice(0, 3),
      },
      "search/articles OK",
    );

    return data;
  } catch (err) {
    const status = err?.response?.status;
    const url = err?.config?.url;
    const params = err?.config?.params;
    const data = err?.response?.data;
    const message = err?.message;

    if (status === 429) {
      logger.warn(
        { ctx: CTX, oem, brand, url, params: redactParamsForLogs(params) },
        `429 по OEM ${oem}, retry через 1.5 сек`,
      );
      await sleep(1500);
      return queryArticle(oem, brand);
    }

    if (status === 404 && data?.errorCode === 301) {
      logger.info(
        { ctx: CTX, oem, brand, status, data },
        "По OEM+brand нет предложений (No results)",
      );
      console.info("[ABCP INFO NoResults]", { oem, brand, status, data });
      return [];
    }

    if (status === 400 && data?.errorCode === 2) {
      logger.warn(
        { ctx: CTX, oem, brand, data },
        "ABCP ожидает brand для search/articles",
      );
      console.warn("[ABCP WARN BrandExpected]", { oem, brand, data });
      return [];
    }

    logger.error(
      {
        ctx: CTX,
        oem,
        brand,
        status,
        url,
        params: redactParamsForLogs(params),
        data,
        message,
      },
      "Ошибка queryArticle",
    );

    console.error("[ABCP ERROR queryArticle]", {
      oem,
      brand,
      status,
      url,
      params: redactParamsForLogs(params),
      data,
      message,
    });

    return [];
  }
}

/**
 * /search/brands — получаем список брендов по номеру.
 */
async function queryBrands(oem) {
  if (!ABCP_DOMAIN || !ABCP_LOGIN || !ABCP_USERPSW_MD5) return [];

  try {
    const params = {
      userlogin: ABCP_LOGIN,
      userpsw: ABCP_USERPSW_MD5,
      number: oem,
      limit: 10,
    };

    logger.info(
      { ctx: CTX, oem, params: redactParamsForLogs(params) },
      "HTTP GET /search/brands",
    );

    const r = await api.get(`/search/brands`, { params });
    const data = r.data;

    let list = [];

    if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === "object") {
      list = Object.values(data);
    }

    logger.info(
      {
        ctx: CTX,
        oem,
        rawCount: Array.isArray(list) ? list.length : 0,
        sample: list.slice(0, 3),
      },
      "search/brands result",
    );

    if (!list.length) {
      logger.warn({ ctx: CTX, oem, raw: data }, "search/brands вернул пусто");
      console.warn("[ABCP WARN search/brands]", { oem, data });
    }

    return list;
  } catch (err) {
    const status = err?.response?.status;
    const url = err?.config?.url;
    const params = err?.config?.params;
    const data = err?.response?.data;
    const message = err?.message;

    logger.error(
      {
        ctx: CTX,
        oem,
        status,
        url,
        params: redactParamsForLogs(params),
        data,
        message,
      },
      "Ошибка queryBrands",
    );

    console.error("[ABCP ERROR queryBrands]", {
      oem,
      status,
      url,
      params: redactParamsForLogs(params),
      data,
      message,
    });

    return [];
  }
}

// --------- НОРМАЛИЗАЦИЯ ---------

function normalizeAbcpResponse(oem, rows) {
  if (!Array.isArray(rows)) return [];

  const offers = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    // Только оригиналы: отбрасываем только явные НЕ-оригиналы
    if (row.isOriginal === false) continue;

    const price = row?.price ?? row?.cost;
    if (!price) continue;

    // Наличие / количество
    let rawQty =
      row.quantity ??
      row.rest ??
      row.available_quantity ??
      row.availability ??
      row.qty ??
      null;

    if (typeof rawQty === "boolean") rawQty = rawQty ? 1 : 0;
    if (!rawQty || rawQty < 0) rawQty = 1;
    const quantity = rawQty;

    // === СРОКИ ===
    // 1) Строго используем текстовые поля для основного значения
    const deadlineRaw = row.deadlineReplace ?? row.deadline ?? null;

    let minDays = null;
    let maxDays = null;

    if (deadlineRaw) {
      const d = parseDeadline(deadlineRaw);
      if (d > 0) {
        minDays = d;
        maxDays = d;
      }
    }

    // 2) Если текста нет вообще — fallback в числовые поля
    if (minDays === null && maxDays === null) {
      const minNum =
        row.deliveryMin ??
        row.deliveryPeriodMin ??
        row.deliveryPeriod ??
        0;

      const maxNum =
        row.deliveryMax ??
        row.deliveryPeriodMax ??
        row.deliveryPeriod ??
        0;

      let tmpMin = parseDeadline(minNum);
      let tmpMax = parseDeadline(maxNum);

      if (tmpMin > 0 && tmpMax === 0) tmpMax = tmpMin;
      if (tmpMax > 0 && tmpMin === 0) tmpMin = tmpMax;

      if (tmpMin > 0 || tmpMax > 0) {
        minDays = tmpMin > 0 ? tmpMin : tmpMax;
        maxDays = tmpMax > 0 ? tmpMax : tmpMin;
      }
    }

    // OEM этой конкретной позиции — может отличаться от запрошенного
    const offerOem = row?.number || row?.article || row?.oem || oem;

    // Флаг аналога и оригинала — отдаём наверх, Cortex их использует
    const isAnalog = row?.isAnalog ?? null;
    const isOriginal = row?.isOriginal ?? null;

    offers.push({
      brand: row.brand || null,
      supplier: null,
      price,
      quantity,
      minDays,
      maxDays,
      availabilityRaw: rawQty,
      // в LLM уходит человекочитаемый срок, если есть
      deliveryRaw: deadlineRaw,
      // новенькое:
      oem: offerOem,
      isAnalog,
      isOriginal,
      // Поля для последующего заказа через basket/add
      itemKey: row.itemKey || row.item_key || null,
      supplierCode: row.supplierCode || row.supplier_code || null,
      code: row.code || null,
      numberFix: row.numberFix || row.number_fix || null,
    });
  }

  offers.sort((a, b) => a.price - b.price);

  if (offers.length) {
    const prices = offers.map((o) => o.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    const days = offers
      .flatMap((o) => [o.minDays || 0, o.maxDays || 0])
      .filter((d) => d > 0);

    const minDaysAll = days.length ? Math.min(...days) : null;
    const maxDaysAll = days.length ? Math.max(...days) : null;

    logger.info(
      {
        ctx: CTX,
        oem,
        offersCount: offers.length,
        minPrice,
        maxPrice,
        minDays: minDaysAll,
        maxDays: maxDaysAll,
        sample: offers.slice(0, 3),
      },
      "normalizeAbcpResponse summary",
    );
  } else {
    logger.info({ ctx: CTX, oem }, "normalizeAbcpResponse: нет офферов");
  }

  return offers;
}

// --------- ОСНОВНОЙ ПОИСК ПО НЕСКОЛЬКИМ OEM ---------

export async function searchManyOEMs(oems = []) {
  const result = {};

  for (const requestedOemRaw of oems) {
    const requestedOem = String(requestedOemRaw || "").trim().toUpperCase();
    if (!requestedOem) continue;

    logger.info({ ctx: CTX, oem: requestedOem }, "Поиск по OEM");

    const brands = await queryBrands(requestedOem);

    if (!brands.length) {
      logger.info(
        { ctx: CTX, oem: requestedOem },
        "Бренды не найдены, предложений нет",
      );
      result[requestedOem] = result[requestedOem] || { offers: [] };
      continue;
    }

    const brandObj = brands[0] || {};
    const brand = brandObj.brand || brandObj.Brand || brandObj.name || null;

    if (!brand) {
      logger.warn(
        { ctx: CTX, oem: requestedOem, brandObj },
        "Не удалось определить brand из search/brands",
      );
      result[requestedOem] = result[requestedOem] || { offers: [] };
      continue;
    }

    logger.info(
      { ctx: CTX, oem: requestedOem, brand },
      "Используем brand для поиска статей",
    );

    const rows = await queryArticle(requestedOem, brand);
    const offers = normalizeAbcpResponse(requestedOem, rows);

    // === КЛЮЧЕВАЯ ПРАВКА ===
    // ABCP может вернуть строки по "оригинальным заменам" (другой OEM),
    // поэтому раскладываем офферы по реальному offer.oem в отдельные ключи.
    const grouped = {};
    for (const off of offers) {
      const key = String(off?.oem || requestedOem).trim().toUpperCase();
      if (!key) continue;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(off);
    }

    // Сортируем каждую группу по цене (детерминированно)
    for (const [k, arr] of Object.entries(grouped)) {
      arr.sort((a, b) => (a.price || 0) - (b.price || 0));
      // мерджим в общий result
      if (!result[k]) result[k] = { offers: [] };
      result[k].offers = [...(result[k].offers || []), ...arr].sort(
        (a, b) => (a.price || 0) - (b.price || 0),
      );
    }

    // Если вдруг вообще ничего не пришло — оставим пусто хотя бы по запрошенному
    if (!Object.keys(grouped).length) {
      result[requestedOem] = result[requestedOem] || { offers: [] };
    }

    // Логируем: сколько OEM получилось из одного запроса
    const keys = Object.keys(grouped);
    logger.info(
      {
        ctx: CTX,
        requestedOem,
        groupedOems: keys,
        groupedCounts: keys.reduce((acc, k) => {
          acc[k] = grouped[k].length;
          return acc;
        }, {}),
      },
      "searchManyOEMs grouped result (requested + replacements)",
    );
  }

  logger.info(
    { ctx: CTX, oems: Object.keys(result) },
    "searchManyOEMs result (keys)",
  );
  return result;
}

// --------- ВНЕШНИЙ ИНТЕРФЕЙС ДЛЯ БОТА ---------

export async function abcpLookupFromText(text, oemsFromLlm = []) {
  let oems = [];

  if (Array.isArray(oemsFromLlm) && oemsFromLlm.length > 0) {
    oems = oemsFromLlm.map((x) => x.trim().toUpperCase());
    logger.info({ ctx: CTX, oems }, "abcpLookupFromText: OEM из LLM");
  } else {
    oems = extractOEMsFromText(text);
    logger.info({ ctx: CTX, oems }, "abcpLookupFromText: OEM из текста");
  }

  if (!oems.length) return {};

  const data = await searchManyOEMs(oems);

  logger.info({ ctx: CTX, data }, "abcpLookupFromText: итоговые данные");
  return data;
}
