// src/modules/external/pricing/abcp.js (v3)
// Полностью переписанный ABCP-адаптер:
// — Только оригиналы
// — Fallback через /search/brands
// — Защита от ошибок
// — Батчинг нескольких OEM
// — Нормализованные данные для LLM

import axios from "axios";
import { logger } from "../../../core/logger.js";

const CTX = "ABCP";

// --- Конфиг ABCP ---
const ABCP_KEY = process.env.ABCP_KEY;
const ABCP_DOMAIN = process.env.ABCP_DOMAIN; // например: "example.abcp.ru"

if (!ABCP_KEY || !ABCP_DOMAIN) {
  logger.warn(CTX, "ABCP ключ или домен не заданы в .env");
}

// --- Axios instance ---
const api = axios.create({
  baseURL: `https://${ABCP_DOMAIN}/api`,
  timeout: 8000,
});

// --------- УТИЛИТЫ ---------

/**
 * Вытаскиваем OEM из текста (удаляем слова, телефоны, пробелы, символы).
 */
export function extractOEMsFromText(text) {
  if (!text) return [];

  // Убираем телефоны
  text = text.replace(/(\+?\d[\d\s\-\(\)]{7,}\d)/g, " ");

  // Оставляем только буквы+цифры в группах
  const oems = text
    .split(/[\s,;\n\r]+/)
    .map((x) => x.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter((x) => x.length >= 6 && x.length <= 20);

  // Уникальные
  return [...new Set(oems)];
}

/**
 * Ждём n мс (используем при 429)
 */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// --------- ЗАПРОСЫ ABCP ---------

/**
 * Запрос /search/articles?article=OEM
 */
async function queryArticle(oem) {
  try {
    const r = await api.get(`/search/articles`, {
      params: {
        userlogin: ABCP_KEY,
        article: oem,
        limit: 40,
      },
    });

    return r.data || [];
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn(CTX, `429 по OEM ${oem}, retry через 1.5 сек`);
      await sleep(1500);
      return queryArticle(oem);
    }

    logger.error(CTX, "Ошибка queryArticle", { oem, err });
    return [];
  }
}

/**
 * Запрос /search/brands?article=OEM — fallback
 */
async function queryBrands(oem) {
  try {
    const r = await api.get(`/search/brands`, {
      params: {
        userlogin: ABCP_KEY,
        article: oem,
        limit: 10,
      },
    });

    return r.data || [];
  } catch (err) {
    logger.error(CTX, "Ошибка queryBrands", { oem, err });
    return [];
  }
}

// --------- НОРМАЛИЗАЦИЯ ---------

/**
 * Нормализуем оригинальные предложения из ABCP для LLM.
 */
function normalizeAbcpResponse(oem, rows) {
  if (!rows || !Array.isArray(rows)) return [];

  const offers = [];

  for (const row of rows) {
    if (!row.isOriginal) continue;

    const price = row?.price ?? row?.cost;
    if (!price) continue;

    const minDays = row?.deliveryMin ?? row?.delivery ?? 0;
    const maxDays = row?.deliveryMax ?? row?.delivery ?? 0;

    offers.push({
      brand: row.brand || null,
      supplier: row.supplier || null,
      price,
      quantity: row.quantity || 0,
      minDays,
      maxDays,
    });
  }

  // Сортируем от дешёвых к дорогим
  offers.sort((a, b) => a.price - b.price);

  return offers;
}

// --------- ОСНОВНОЙ ПОИСК ПО НЕСКОЛЬКИМ OEM ---------

export async function searchManyOEMs(oems = []) {
  const result = {};

  for (const oem of oems) {
    logger.debug(CTX, `Поиск по OEM ${oem}`);

    // --- 1. Пробуем прямой поиск ---
    let rows = await queryArticle(oem);
    let offers = normalizeAbcpResponse(oem, rows);

    // --- 2. Fallback, если пусто ---
    if (!offers.length) {
      const brands = await queryBrands(oem);

      if (brands.length > 0) {
        const brand = brands[0].brand;

        // Повторяем поиск с brand
        rows = await queryArticle(`${brand} ${oem}`);
        offers = normalizeAbcpResponse(oem, rows);
      }
    }

    result[oem] = {
      offers,
    };
  }

  return result;
}

// --------- ВНЕШНИЙ ИНТЕРФЕЙС ДЛЯ БОТА ---------

/**
 * Главная функция для handler'а.
 */
export async function abcpLookupFromText(text) {
  const oems = extractOEMsFromText(text);
  if (!oems.length) return {};

  return await searchManyOEMs(oems);
}
