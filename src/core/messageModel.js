// src/core/messageModel.js
// Тексты бота через YAML (config/bot.responses.yaml)

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь до YAML с шаблонами сообщений
const RESPONSES_FILE = path.resolve(__dirname, "../../config/bot.responses.yaml");

let cache = null;
let cacheMtimeMs = 0;

/**
 * Простая функция для подстановки {{placeholders}} в текст.
 */
function applyTemplate(template, vars = {}) {
  if (!template || typeof template !== "string") return "";
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp("{{\\s*" + key + "\\s*}}", "g");
    result = result.replace(re, String(value ?? ""));
  }
  return result;
}

/**
 * Загружает YAML-конфиг с кэшем по времени изменения файла.
 */
function loadConfig() {
  try {
    const stat = fs.statSync(RESPONSES_FILE);
    if (cache && cacheMtimeMs === stat.mtimeMs) {
      return cache;
    }
    const raw = fs.readFileSync(RESPONSES_FILE, "utf8");
    const parsed = yaml.load(raw);
    cache = parsed || {};
    cacheMtimeMs = stat.mtimeMs;
    return cache;
  } catch (err) {
    console.warn("[messageModel] Failed to load responses config:", err.message || err);
    cache = {};
    cacheMtimeMs = 0;
    return cache;
  }
}

/**
 * Универсальный getter: getMessage("contact.card.title")
 */
export function getMessage(pathKey, vars = {}) {
  const cfg = loadConfig();
  const parts = String(pathKey).split(".");
  let node = cfg;
  for (const p of parts) {
    if (node && typeof node === "object" && p in node) {
      node = node[p];
    } else {
      node = null;
      break;
    }
  }
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return applyTemplate(node, vars);
  }
  if (node && typeof node.reply === "string") {
    return applyTemplate(node.reply, vars);
  }
  console.warn("[messageModel] Unsupported message node format for key:", pathKey);
  return "";
}

/**
 * Карточка контактов: заголовок + Имя + Телефон + футер
 */
export function makeContactCardText({ name, phone }) {
  const title =
    getMessage("contact.card.title") ||
    "Проверьте контактные данные:";
  const footer =
    getMessage("contact.card.footer") ||
    "Всё верно? Если изменилось — напишите актуальные данные одним сообщением.";

  const lines = [
    title,
    `Имя: ${name || "—"}`,
    `Телефон: ${phone || "—"}`,
    footer,
  ];
  return lines.join("\n");
}

/**
 * Приветствие (если решим его использовать)
 */
export function makeGreetingText({ name, isFirst }) {
  const key = isFirst ? "bot.greeting.first" : "bot.greeting.repeat";
  const txt = getMessage(key, { name });
  if (txt && txt.trim()) return txt.trim();
  return isFirst
    ? "Здравствуйте! Я виртуальный помощник по подбору автозапчастей."
    : "Продолжаем диалог по подбору запчастей.";
}

/**
 * Ответ на случай, если LLM недоступен (нет ключа или жёсткий форс-мажор)
 */
export function makeLLMDownReply({ name, hasPhone }) {
  const base = getMessage("fallback.llm_down");
  if (base && base.trim()) {
    return base.trim();
  }

  const prefix = name ? `Спасибо, ${name}. ` : "Спасибо. ";
  if (hasPhone) {
    return (
      prefix +
      "Сейчас интеллектуальный модуль временно недоступен, но заявка принята и будет передана менеджеру. " +
      "Менеджер свяжется с вами для уточнения деталей."
    );
  }
  return (
    prefix +
    "Сейчас интеллектуальный модуль временно недоступен. Напишите, пожалуйста, телефон для связи, " +
    "и менеджер свяжется с вами для уточнения деталей."
  );
}
